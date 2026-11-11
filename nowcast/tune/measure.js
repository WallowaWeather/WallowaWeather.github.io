// nowcast/tune/measure.js - Wallowa Weather's speed tune on the GPU: its own graphics device, made-up inputs at each model's real
// layer sizes (made on the GPU from a fixed seed: nothing is downloaded and no model is loaded), the standard kernel's output as the
// reference, each candidate checked against it bit for bit (from an output buffer filled with NaN first, so a kernel that did not run,
// or ran wrong, cannot pass on old numbers), then timed by the wall clock (each sample one submit of a few ms of work, short enough for
// any GPU watchdog). The measuring interface core.js tuneUnit drives: prepare / gate / time / release.
'use strict';
import { gemmWGSL } from '../stormscope/kernels.js';
import { probeF16Rounding } from '../stormscope/ss.js';
import { convF } from '../dgmr/kernels_float.js';
import { convWGSL } from '../beam/engine/kernels.js';
import { LAYERS, DEFAULT_TILES } from '../beam/engine/beam.js';
import { ssGemmTiledWGSL, dgmrConvTiledWGSL, planStormScope, planDgmr, planBeam, SS_DEFAULT } from './variants.js';

const GU = () => GPUBufferUsage;
const POISON = 0xffffffff;   // NaN as f32, NaN halves as two f16
const ACT = { none: 0, relu: 1, sigmoid: 2 };

const FILL = `struct P { n: u32, seed: u32, mode: u32, scale: f32, row: u32, off: u32, p0: u32, p1: u32 };
@group(0) @binding(0) var<uniform> p: P;
@group(0) @binding(1) var<storage, read_write> D: array<u32>;
fn pcg(v: u32) -> u32 { let s = v * 747796405u + 2891336453u; let w = ((s >> ((s >> 28u) + 4u)) ^ s) * 277803737u; return (w >> 22u) ^ w; }
fn un(h: u32) -> f32 { return f32(h >> 8u) * (2.0 / 16777216.0) - 1.0; }
@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) g: vec3<u32>) {
  let i = g.y * p.row + g.x; if (i >= p.n) { return; }
  let h = pcg(i ^ pcg(p.seed));
  var v = p.seed;
  if (p.mode == 0u) { v = bitcast<u32>(un(h) * p.scale); }
  else if (p.mode == 1u) { v = h; }
  else if (p.mode == 2u) { v = pack2x16float(vec2<f32>(un(h), un(pcg(h))) * p.scale); }
  D[p.off + i] = v;
}`;
// R: [differing words, first differing index, the largest |difference| (f32 bits; inf for a NaN), 0]
const COMPARE = `struct P { n: u32, mode: u32, row: u32, p0: u32 };
@group(0) @binding(0) var<uniform> p: P;
@group(0) @binding(1) var<storage, read> A: array<u32>;
@group(0) @binding(2) var<storage, read> B: array<u32>;
@group(0) @binding(3) var<storage, read_write> R: array<atomic<u32>, 4>;
@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) g: vec3<u32>) {
  let i = g.y * p.row + g.x; if (i >= p.n) { return; }
  let a = A[i]; let b = B[i];
  if (a == b) { return; }
  if (p.mode == 1u && ((a | b) & 0x7fffffffu) == 0u) { return; }
  atomicAdd(&R[0], 1u); atomicMin(&R[1], i);
  if (p.mode == 1u) { let d = abs(bitcast<f32>(a) - bitcast<f32>(b)); atomicMax(&R[2], select(0x7f800000u, bitcast<u32>(d), d == d)); }
}`;

/** the tune's own graphics device (16-bit shaders when the chip has them, the bigger buffer limits the models ask for) */
export async function openTuneDevice({ powerPreference = 'high-performance', adapter = null } = {}) {
  if (!globalThis.navigator || !navigator.gpu) throw Object.assign(new Error('this browser has no WebGPU'), { code: 'UNSUPPORTED' });
  const ad = adapter || await navigator.gpu.requestAdapter({ powerPreference });
  if (!ad) throw Object.assign(new Error('no WebGPU adapter'), { code: 'UNSUPPORTED' });
  const f16 = ad.features.has('shader-f16'), L = ad.limits;
  const device = await ad.requestDevice({ requiredFeatures: f16 ? ['shader-f16'] : [], requiredLimits: {
    maxStorageBufferBindingSize: Math.min(L.maxStorageBufferBindingSize, 256 * 1048576), maxBufferSize: Math.min(L.maxBufferSize, 256 * 1048576),
    maxStorageBuffersPerShaderStage: L.maxStorageBuffersPerShaderStage } });
  const t = { adapter: ad, device, f16, info: ad.info || {}, lost: null, errors: [] };
  device.lost.then((i) => { t.lost = { reason: i && i.reason, message: i && i.message }; });
  device.addEventListener('uncapturederror', (e) => { if (t.errors.length < 10) t.errors.push(String((e.error && e.error.message) || e.error).slice(0, 200)); });
  return t;
}

/** buffers, the fill / compare kernels, compiles and the clock on one device */
export class Lab {
  constructor(t) { this.t = t; this.d = t.device; this.util = null; }
  _lost() { if (this.t.lost) throw Object.assign(new Error('the graphics chip was reset: ' + (this.t.lost.message || this.t.lost.reason || '')), { code: 'GPU_LOST' }); }
  buf(bytes, label = 'tune', usage = 0) {
    const size = Math.max(16, Math.ceil(bytes / 16) * 16);
    if (size > this.d.limits.maxBufferSize || ((usage & GU().STORAGE || !usage) && size > this.d.limits.maxStorageBufferBindingSize)) throw new Error(`tune buffer ${label}: ${size} B is more than this GPU binds`);
    return this.d.createBuffer({ size, label, usage: usage || (GU().STORAGE | GU().COPY_DST | GU().COPY_SRC) });
  }
  uniform(words, label = 'tune u') {
    const u32 = words instanceof Uint32Array ? words : new Uint32Array(words);
    const b = this.buf(Math.max(16, u32.byteLength), label, GU().UNIFORM | GU().COPY_DST); this.d.queue.writeBuffer(b, 0, u32); return b;
  }
  async _utils() {
    if (!this.util) {
      const mk = async (code, label) => this.d.createComputePipelineAsync({ layout: 'auto', compute: { module: this.d.createShaderModule({ code, label }), entryPoint: 'main' }, label });
      this.util = { fill: await mk(FILL, 'tune fill'), cmp: await mk(COMPARE, 'tune compare') };
    }
    return this.util;
  }
  static grid(n) { const wgs = Math.max(1, Math.ceil(n / 256)), x = Math.min(wgs, 65535); return { x, y: Math.ceil(wgs / x), row: x * 256 }; }
  /** fill words [off, off + n) of buf: mode 'f32' (uniform in +-scale), 'bits' (random words), 'f16' (two halves in +-scale), 'const' */
  async fill(buf, n, mode, { seed = 1, scale = 1, off = 0, value = POISON, enc = null } = {}) {
    const U = await this._utils(), gr = Lab.grid(n), m = { f32: 0, bits: 1, f16: 2, const: 3 }[mode];
    const ab = new ArrayBuffer(32), u = new Uint32Array(ab), f = new Float32Array(ab);
    u[0] = n; u[1] = mode === 'const' ? value >>> 0 : seed >>> 0; u[2] = m; f[3] = scale; u[4] = gr.row; u[5] = off;
    const ub = this.buf(32, 'tune fill u', GU().UNIFORM | GU().COPY_DST); this.d.queue.writeBuffer(ub, 0, ab);
    const own = !enc, e = enc || this.d.createCommandEncoder(), ps = e.beginComputePass();
    ps.setPipeline(U.fill); ps.setBindGroup(0, this.d.createBindGroup({ layout: U.fill.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: ub } }, { binding: 1, resource: { buffer: buf } }] }));
    ps.dispatchWorkgroups(gr.x, gr.y); ps.end();
    if (own) this.d.queue.submit([e.finish()]);
    (this._tmp = this._tmp || []).push(ub);
  }
  /** words of a and b -> { bad (count), first (index), maxDiff } ; mode 'f32' (+0 = -0) | 'bits' */
  async compare(a, b, n, mode) {
    this._lost();
    const U = await this._utils(), gr = Lab.grid(n);
    const ub = this.uniform([n, mode === 'f32' ? 1 : 0, gr.row, 0]);
    const R = this.buf(16, 'tune cmp'), RB = this.buf(16, 'tune cmp read', GU().MAP_READ | GU().COPY_DST);
    this.d.queue.writeBuffer(R, 0, new Uint32Array([0, POISON, 0, 0]));
    const e = this.d.createCommandEncoder(), ps = e.beginComputePass();
    ps.setPipeline(U.cmp);
    ps.setBindGroup(0, this.d.createBindGroup({ layout: U.cmp.getBindGroupLayout(0), entries: [ub, a, b, R].map((x, i) => ({ binding: i, resource: { buffer: x } })) }));
    ps.dispatchWorkgroups(gr.x, gr.y); ps.end(); e.copyBufferToBuffer(R, 0, RB, 0, 16);
    this.d.queue.submit([e.finish()]);
    await RB.mapAsync(GPUMapMode.READ); const r = new Uint32Array(RB.getMappedRange().slice(0)); RB.unmap();
    for (const x of [ub, R, RB]) x.destroy();
    this._lost();
    return { bad: r[0], first: r[0] ? r[1] : -1, maxDiff: new Float32Array(new Uint32Array([r[2]]).buffer)[0] };
  }
  /** code -> pipeline (entry), or throws with the compiler's words */
  async pipeline(code, entry = 'main', label = 'tune') {
    this._lost();
    this.d.pushErrorScope('validation');   // pushed and popped around the module alone: compiles run side by side
    const mod = this.d.createShaderModule({ code, label }), scoped = this.d.popErrorScope();
    let p = null, err = null;
    try { p = await this.d.createComputePipelineAsync({ layout: 'auto', compute: { module: mod, entryPoint: entry }, label }); } catch (e) { err = e; }
    const ve = await scoped;
    if (ve || err) {
      let why = String((ve && ve.message) || (err && err.message) || err).slice(0, 160);
      try { const ci = await mod.getCompilationInfo(), m = ci.messages.find((x) => x.type === 'error'); if (m) why = `${m.lineNum}:${m.linePos} ${m.message}`.slice(0, 160); } catch (e) { /* */ }
      throw new Error(why);
    }
    return p;
  }
  /** one timing sample: `reps` runs of encode(pass) in one submit; ms per run (the encoding is done before the clock starts) */
  async time(encode, reps = 1) {
    this._lost();
    const e = this.d.createCommandEncoder(), ps = e.beginComputePass();
    for (let r = 0; r < reps; r++) encode(ps);
    ps.end(); const cb = e.finish();
    await this.d.queue.onSubmittedWorkDone();
    const t0 = performance.now(); this.d.queue.submit([cb]); await this.d.queue.onSubmittedWorkDone();
    const ms = (performance.now() - t0) / reps;
    this._lost();
    return ms;
  }
  async settle() { await this.d.queue.onSubmittedWorkDone(); for (const b of this._tmp || []) b.destroy(); this._tmp = []; }
}

// ------------------------------------------------------------------------------------------------ the sites (one layer shape each)
const bg = (d, p, list) => d.createBindGroup({ layout: p.getBindGroupLayout(0), entries: list.map((b, i) => ({ binding: i, resource: { buffer: b } })) });

/** StormScope GEMM site. mode 'r' | 'h' | 'f' (the tile rounding the engine will use on this device) */
async function ssSite(lab, s, mode, seed) {
  const f16 = mode !== 'f', rne = mode !== 'h', own = [];
  const B = (bytes, l) => { const b = lab.buf(bytes, 'tune ss ' + l); own.push(b); return b; };
  const A = B(s.M * s.lda * 4, 'A'); await lab.fill(A, s.M * s.lda, 'f32', { seed: seed + 1 });
  const bWords = s.b === 'i8' ? s.N * s.ldb : s.b === 'nt' ? s.N * s.ldb : s.bRows * s.ldb;
  const Bm = B(bWords * 4, 'B'); await lab.fill(Bm, bWords, s.b === 'i8' ? 'bits' : 'f32', { seed: seed + 2 });
  const cWords = s.M * s.ldc, C = { ref: B(cWords * 4, 'Cref'), test: B(cWords * 4, 'Ctest') };
  const extra = [];
  if (s.b === 'i8') { const SB = B(2 * s.N * 4, 'SB'); await lab.fill(SB, 2 * s.N, 'f32', { seed: seed + 3, scale: 1 / (64 * Math.sqrt(s.K)) }); extra.push(SB); }
  if (s.epi === 'resgate') { const G = B(s.N * 4, 'G'); await lab.fill(G, s.N, 'f32', { seed: seed + 4 }); extra.push(G); }
  if (s.epi === 'addbuf') { const E = B(cWords * 4, 'E'); await lab.fill(E, cWords, 'f32', { seed: seed + 5 }); extra.push(E); }
  let C0 = null;
  if (s.epi === 'resgate') { C0 = B(cWords * 4, 'C0'); await lab.fill(C0, cWords, 'f32', { seed: seed + 6 }); }
  const ab = new ArrayBuffer(96), u = new Uint32Array(ab), f = new Float32Array(ab);
  u.set([s.M, s.N, s.K, s.lda, s.ldb, s.ldc, 0, 0, 0, 0, 0, 0, 0, 0, 0, s.gw, s.gh, s.kh, s.kw, s.bRows || 1]); f[20] = s.alpha ?? 1;
  const U = lab.uniform(new Uint32Array(ab)); own.push(U);
  return {
    words: cWords, mode: 'f32', out: C, own,
    code: (tile) => (tile ? ssGemmTiledWGSL({ f16, b: s.b, epi: s.epi, rne, ...tile }).code : gemmWGSL({ f16, b: s.b, epi: s.epi, rne }).code),
    binds: (p, which) => bg(lab.d, p, [U, A, Bm, C[which], ...extra]),
    wg: (tile) => { const t = tile || SS_DEFAULT; return [Math.ceil(s.N / t.BN), Math.ceil(s.M / t.BM), 1]; },
    prep: (enc, which) => (C0 ? enc.copyBufferToBuffer(C0, 0, C[which], 0, cWords * 4) : lab.fill(C[which], cWords, 'const', { enc })),
  };
}

/** DGMR conv site (one op shape, inputs and outputs of its own; offsets 0) */
async function dgSite(lab, s, wenc, seed) {
  const own = [], B = (bytes, l) => { const b = lab.buf(bytes, 'tune dgmr ' + l); own.push(b); return b; };
  const nslot = Math.max(1, s.nslot), ins = [];
  for (let q = 0; q < nslot; q++) {
    const C = (s.refs.find((r) => r.slot === q) || s.refs[0]).C, w = s.n * s.Hin * s.Win * C;
    const b = B(w * 4, 'in' + q); await lab.fill(b, w, 'f32', { seed: seed + 10 + q }); ins.push(b);
  }
  const half = wenc === 'f16', wWords = (half ? s.ktot / 2 : s.ktot) * s.cout, boff = wWords;
  const W = B((wWords + s.cout) * 4, 'w');
  await lab.fill(W, wWords, half ? 'f16' : 'f32', { seed: seed + 20, scale: 1 / Math.sqrt(s.ktot) });
  await lab.fill(W, s.cout, 'f32', { seed: seed + 21, scale: 0.1, off: boff });
  const words = s.n * s.H * s.W * s.cout, out = { ref: B(words * 4, 'out ref'), test: B(words * 4, 'out test') };
  const scrW = s.split > 1 ? s.split * s.mcnt * s.cout : 4, scr = B(scrW * 4, 'scr');
  const U = new Uint32Array(64);
  U.set([0, s.mcnt, s.H, s.W, s.cout, s.ktot, s.k, s.up, s.Hin, s.Win, s.nref, s.cin, s.kper, 0, ACT[s.act] || 0, s.split > 1 ? 1 : 0, boff, 0, s.split, 0]);
  let cs = 0; s.refs.forEach((r, q) => { U.set([r.slot, 0, r.C, cs, r.relu, 0, 0, 0], 20 + 8 * q); cs += r.C; });
  const ub = lab.uniform(U); own.push(ub);
  const fin = s.split > 1 ? await lab.pipeline(convF(wenc), 'fin', 'tune dgmr fin') : null;
  const finBg = {}, nt = s.mcnt * s.cout / 4, fx = Math.min(65535, Math.ceil(nt / 64)), fy = Math.ceil(Math.ceil(nt / 64) / 65535);
  if (fin) for (const w of ['ref', 'test']) finBg[w] = lab.d.createBindGroup({ layout: fin.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: ub } }, { binding: 3, resource: { buffer: W } }, { binding: 4, resource: { buffer: out[w] } }, { binding: 5, resource: { buffer: scr } }] });
  return {
    words, mode: 'f32', out, own,
    code: (tile) => (tile ? dgmrConvTiledWGSL(wenc, tile) : convF(wenc)),
    binds: (p, which) => bg(lab.d, p, [ub, ins[0], ins[1] || ins[0], W, out[which], scr]),
    wg: (tile) => { const t = tile || { BM: 64, BN: 64 }; return [Math.ceil(s.cout / t.BN), Math.ceil(s.mcnt / t.BM), s.split]; },
    after: fin ? (ps, which) => { ps.setPipeline(fin); ps.setBindGroup(0, finBg[which]); ps.dispatchWorkgroups(fx, fy, 1); } : null,
    prep: async (enc, which) => { await lab.fill(out[which], words, 'const', { enc }); if (s.split > 1) await lab.fill(scr, scrW, 'const', { enc }); },
  };
}

/** BEAM conv / transpose site: BEAM's own generator (kernels.js convWGSL) at this layer's sizes, with the candidate's tile */
async function beamSite(lab, s, seed) {
  const c = s.conv, own = [], B = (bytes, l) => { const b = lab.buf(bytes, 'tune beam ' + l); own.push(b); return b; };
  const xW = c.H * c.H * c.ldx / 2, X = B(xW * 4, 'x'); await lab.fill(X, xW, 'f16', { seed: seed + 1 });
  const wW = c.Kpad * c.N / 2, Wt = B(wW * 4, 'w'); await lab.fill(Wt, wW, 'f16', { seed: seed + 2, scale: 1 / Math.sqrt(c.Kreal) });
  const Bv = B(c.N * 4, 'b'); await lab.fill(Bv, c.N, 'f32', { seed: seed + 3, scale: 0.1 });
  const words = s.out / 2, Y = { ref: B(words * 4, 'y ref'), test: B(words * 4, 'y test') };
  return {
    words, mode: 'bits', out: Y, own,
    code: (tile) => convWGSL(Object.assign({}, c, { BM: tile[0], BN: tile[1] })),
    binds: (p, which) => bg(lab.d, p, [X, Wt, Bv, Y[which]]),
    wg: (tile) => [Math.ceil(s.M / tile[0]), c.N / tile[1], 1],
    prep: (enc, which) => lab.fill(Y[which], words, 'const', { enc }),
  };
}

// ------------------------------------------------------------------------------------------------ the measuring interface
/** -> { prepare, gate, time, release } for core.js tuneUnit, on this device. mode: StormScope's tile rounding here */
export function makeApi(t, { ssMode = 'r', seed = 20261108 } = {}) {
  const lab = new Lab(t);
  let n = 0;
  async function prepare(unit) {
    const sites = [];
    for (const s of unit.sites) {
      const sd = seed + 100 * (n++);
      sites.push(unit.model === 'stormscope' ? await ssSite(lab, s, ssMode, sd) : unit.model === 'dgmr' ? await dgSite(lab, s, unit.wenc, sd) : await beamSite(lab, s, sd));
    }
    await lab.settle();
    const ctx = { unit, sites, run: {}, ok: {}, self: true };
    // every candidate compiled for every site (a site's code can differ: BEAM writes its sizes into the code); one pipeline per code text
    const byCode = new Map();
    await Promise.all(unit.cands.map(async (c) => {
      try {
        const per = [];
        for (const st of sites) {
          const code = st.code(c.tile);
          if (!byCode.has(code)) byCode.set(code, lab.pipeline(code, 'main', `tune ${unit.model} ${unit.key} ${c.id}`));
          const p = await byCode.get(code);
          per.push({ p, bg: { ref: st.binds(p, 'ref'), test: st.binds(p, 'test') }, wg: st.wg(c.tile) });
        }
        ctx.run[c.id] = per; ctx.ok[c.id] = true;
      } catch (e) { ctx.ok[c.id] = String((e && e.message) || e).slice(0, 160); }
    }));
    if (ctx.ok.standard !== true) { ctx.self = 'did not compile: ' + ctx.ok.standard; return ctx; }
    // the reference: the standard kernel, from a poisoned output; then once more into the test buffer: it must repeat itself exactly
    for (const which of ['ref', 'test']) await runOnce(ctx, 'standard', which);
    for (let i = 0; i < sites.length; i++) {
      const r = await lab.compare(sites[i].out.ref, sites[i].out.test, sites[i].words, sites[i].mode);
      if (r.bad) { ctx.self = `gave different numbers twice (${r.bad} values)`; break; }
    }
    return ctx;
  }
  async function runOnce(ctx, id, which) {
    const e = lab.d.createCommandEncoder();
    for (const st of ctx.sites) await st.prep(e, which);
    const ps = e.beginComputePass();
    ctx.run[id].forEach((r, i) => { ps.setPipeline(r.p); ps.setBindGroup(0, r.bg[which]); ps.dispatchWorkgroups(...r.wg); if (ctx.sites[i].after) ctx.sites[i].after(ps, which); });
    ps.end(); lab.d.queue.submit([e.finish()]);
    await lab.settle();
  }
  async function gate(ctx, id) {
    await runOnce(ctx, id, 'test');
    for (const st of ctx.sites) {
      const r = await lab.compare(st.out.ref, st.out.test, st.words, st.mode);
      if (r.bad) return `${r.bad} of ${st.words} values${st.mode === 'f32' && Number.isFinite(r.maxDiff) ? ` (largest difference ${r.maxDiff.toPrecision(2)})` : ''}`;
    }
    return true;
  }
  async function time(ctx, id, s, reps) {
    const r = ctx.run[id][s], st = ctx.sites[s];
    return lab.time((ps) => { ps.setPipeline(r.p); ps.setBindGroup(0, r.bg.test); ps.dispatchWorkgroups(...r.wg); if (st.after) st.after(ps, 'test'); }, reps);
  }
  async function release(ctx) {
    try { await lab.d.queue.onSubmittedWorkDone(); } catch (e) { /* lost */ }
    for (const st of ctx.sites) for (const b of st.own) { try { b.destroy(); } catch (e) { /* */ } }
    for (const st of ctx.sites) for (const w of ['ref', 'test']) { try { st.out[w].destroy(); } catch (e) { /* */ } }
    ctx.sites = []; ctx.run = {};
  }
  return { prepare, gate, time, release, lab };
}

/** the plans for the models asked for, on this device: { plans, ssMode, skipped } (models: { beam, stormscope, dgmr: model JSON | null }) */
export async function planFor(t, models, { caps = {} } = {}) {
  const plans = [], skipped = {};
  let ssMode = 'f';
  if (models.beam) plans.push({ model: 'beam', units: planBeam({ layers: LAYERS, defaults: DEFAULT_TILES, f16: t.f16, cap: caps.beam ?? 3 }).units });
  if (models.stormscope) {
    ssMode = t.f16 ? ((await probeF16Rounding(t.device)).mode === 'native' ? 'h' : 'r') : 'f';
    plans.push({ model: 'stormscope', units: planStormScope({ mode: ssMode, cap: caps.stormscope ?? 5 }) });
  }
  if (models.dgmr) {
    const p = planDgmr(models.dgmr, { cap: caps.dgmr ?? 5 });
    if (!p.units.length) skipped.dgmr = 'its model file could not be read';
    else plans.push({ model: 'dgmr', units: p.units, rest: (rs) => {   // the convs not timed, at the timed ones' standard rate
      let macs = 0, ms = 0;
      for (const r of rs) { const u = p.units.find((x) => x.key === r.key); if (u && r.ms && Number.isFinite(r.ms.standard)) { macs += u.macs; ms += r.ms.standard; } }
      return macs > 0 && ms > 0 ? (p.macsAll - macs) * ms / macs : 0;
    } });
  }
  return { plans, ssMode, skipped };
}
