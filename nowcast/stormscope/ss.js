// nowcast/stormscope/ss.js - StormScope Flash MRMS expert chain on WebGPU (free() gives every buffer back). One 10-min step = 7 network evaluations (high, middle, low x5), each a
// Derived from NVIDIA Earth2Studio, earth2studio/models/nn/stormscope_flash.py (the network; the weights are under the NVIDIA Open Model License). Copyright (c) 2024-2026 NVIDIA CORPORATION & AFFILIATES, Apache License 2.0 (licenses/Apache-2.0.txt); re-implemented in JavaScript and changed for this app.
// 16-block DiT over the 51 x 51 token tile with 2D neighbourhood attention (49 x 49, windows clamped inside the tile).
'use strict';
import { gemmWGSL, SOFTMAX, LNMOD, QKROPE, PATCHIFY, HEAD, SCALE } from './kernels.js';
import { ssGemmTiledWGSL, tileId } from '../tune/variants.js';   // SPEED TUNE: another GEMM tile, measured on this phone (Settings > Speed tune)

const GU = () => GPUBufferUsage;

// v013: how this GPU's own f32 -> f16 conversion rounds (WGSL leaves it to the GPU), probed once per device with one 2-thread dispatch:
// the GEMM's own pattern (a vec4<f32> cast stored into a shared array<vec4<f16>>) and scalar f16() casts. 'native' only when all 16
// halves are numpy's (round to nearest, ties to even): then the shaders keep the plain casts; anything else (or a failed probe) = 'rne16'.
//   ties to even (1 + 2^-11 -> 1, 1 + 3 * 2^-11 -> 1 + 2^-9, 1.5 * 2^-24 -> 2^-23), values truncation rounds the other way, 65520 -> inf
const PROBE_X = [1.00048828125, 1.00146484375, 1.000732421875, -1.000732421875, 0.7, 1.5 * 2 ** -24, 65519, 65520];
const PROBE_H = [0x3c00, 0x3c02, 0x3c01, 0xbc01, 0x399a, 0x0002, 0x7bff, 0x7c00];
const PROBE_WGSL = `enable f16;
@group(0) @binding(0) var<storage, read> X: array<vec4<f32>, 2>;
@group(0) @binding(1) var<storage, read_write> Y: array<vec4<f16>, 4>;
var<workgroup> w: array<vec4<f16>, 2>;
@compute @workgroup_size(2) fn main(@builtin(local_invocation_index) i: u32) {
  let v = X[i];
  w[i] = vec4<f16>(v);
  Y[2u + i] = vec4<f16>(f16(v.x), f16(v.y), f16(v.z), f16(v.w));
  workgroupBarrier();
  Y[i] = w[i];
}`;
const probed = new WeakMap();
/** -> { mode: 'native' | 'rne16', got: [16 halves] | null, error? } (one per device; later calls get the same promise) */
export function probeF16Rounding(device) {
  if (!probed.has(device)) probed.set(device, (async () => {
    const bufs = [];
    try {
      const mk = (size, usage) => { const b = device.createBuffer({ size, usage }); bufs.push(b); return b; };
      const X = mk(32, GU().STORAGE | GU().COPY_DST), Y = mk(32, GU().STORAGE | GU().COPY_SRC), R = mk(32, GU().MAP_READ | GU().COPY_DST);
      device.queue.writeBuffer(X, 0, new Float32Array(PROBE_X));
      const p = device.createComputePipeline({ layout: 'auto', compute: { module: device.createShaderModule({ code: PROBE_WGSL, label: 'f16 probe' }), entryPoint: 'main' } });
      const enc = device.createCommandEncoder(), ps = enc.beginComputePass(); ps.setPipeline(p);
      ps.setBindGroup(0, device.createBindGroup({ layout: p.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: X } }, { binding: 1, resource: { buffer: Y } }] }));
      ps.dispatchWorkgroups(1); ps.end(); enc.copyBufferToBuffer(Y, 0, R, 0, 32); device.queue.submit([enc.finish()]);
      await R.mapAsync(GPUMapMode.READ); const got = Array.from(new Uint16Array(R.getMappedRange().slice(0))); R.unmap();
      return { mode: got.every((h, i) => h === PROBE_H[i % 8]) ? 'native' : 'rne16', got };
    } catch (e) { return { mode: 'rne16', got: null, error: String((e && e.message) || e).slice(0, 160) }; }
    finally { for (const b of bufs) { try { b.destroy(); } catch (e) { /* */ } } }
  })());
  return probed.get(device);
}

export class StormScope {
  /** opts.f16Rounding: 'auto' (probe the device, the default) | 'native' | 'rne16' (tests); opts.tiles: the speed tune's GEMM table (or null) */
  constructor(gpu, man, inp, opts = {}) {
    this.g = gpu; this.d = gpu.device; this.man = man; this.inp = inp; this.bytes = 0; this.pipes = {}; this.uni = []; this.all = [];
    this.f16Rounding = opts.f16Rounding || 'auto'; this.f16Mode = gpu.f16 ? null : 'f32';
    this.tiles = opts.tiles || null;   // SPEED TUNE: { 'b.epi.mode': tile } measured on this device (null: the standard GEMM everywhere)
    this.H = man.H; this.W = man.W; this.T = man.T; this.gw = man.W / 4; this.gh = man.H / 4;
    this.ldS = Math.ceil(this.T / 4) * 4;
    const perHead = this.T * this.ldS * 4;
    this.hg = Math.max(1, Math.min(6, Math.floor(Math.min(this.d.limits.maxStorageBufferBindingSize, 96 * 1048576) / perHead)));
    while (6 % this.hg) this.hg--;   // heads per attention group (divides 6)
  }
  buf(size, label, usage) {
    size = Math.max(16, Math.ceil(size / 16) * 16);
    const b = this.d.createBuffer({ size, label, usage: usage || (GU().STORAGE | GU().COPY_DST | GU().COPY_SRC) });
    this.bytes += size; this.all.push(b); return b;
  }
  /** every GPU buffer this model made goes back (pilot: the Nowcast lets the model go after each run) */
  free() { for (const b of this.all) { try { b.destroy(); } catch (e) { /* */ } } this.all = []; this.uni = []; this.pipes = {}; this.bytes = 0; }
  pipe(name, code) {
    if (!this.pipes[name]) this.pipes[name] = this.d.createComputePipeline({ layout: 'auto', compute: { module: this.d.createShaderModule({ code, label: name }), entryPoint: 'main' }, label: name });
    return this.pipes[name];
  }
  /** 'f32' (no shader-f16) | 'native' | 'rne16': how the f16 tiles are rounded on this device (the probe runs once per device) */
  async f16Choice() {
    if (!this.f16Mode) this.f16Mode = this.f16Rounding !== 'auto' ? this.f16Rounding : (await probeF16Rounding(this.d)).mode;
    return this.f16Mode;
  }
  gemmPipe(b, epi) {
    const rne = this.f16Mode !== 'native', name = `gemm.${b}.${epi}.${this.g.f16 ? (rne ? 'r' : 'h') : 'f'}`;
    const t = this.tileOf(b, epi);   // SPEED TUNE: the same sums with another tile (checked bit for bit against this GEMM on this phone)
    if (t) return this.pipe(`${name}.${tileId(t)}`, ssGemmTiledWGSL({ f16: this.g.f16, b, epi, rne, ...t }).code);
    return this.pipe(name, gemmWGSL({ f16: this.g.f16, b, epi, rne }).code);
  }
  /** SPEED TUNE: this device's tuned tile for a GEMM kind ({ BM, BN, KS, TM, TN }), or null (the standard 64 x 64) */
  tileOf(b, epi) { return (this.tiles && this.tiles[`${b}.${epi}.${this.g.f16 ? (this.f16Mode !== 'native' ? 'r' : 'h') : 'f'}`]) || null; }
  async checkShaders() {
    await this.f16Choice();
    const out = [], list = [['softmax', SOFTMAX], ['lnmod', LNMOD], ['qkrope', QKROPE], ['patchify', PATCHIFY], ['head', HEAD], ['scale', SCALE]];
    for (const [b, e] of [['i8', 'store'], ['i8', 'gelu'], ['i8', 'resgate'], ['i8', 'addbuf'], ['nt', 'mask'], ['nn', 'store']]) {
      list.push([`gemm.${b}.${e}`, gemmWGSL({ f16: this.g.f16, b, epi: e, rne: this.f16Mode !== 'native' }).code]);
      const t = this.tileOf(b, e);   // SPEED TUNE: a tuned GEMM is checked too
      if (t) list.push([`gemm.${b}.${e}.${tileId(t)}`, ssGemmTiledWGSL({ f16: this.g.f16, b, epi: e, rne: this.f16Mode !== 'native', ...t }).code]);
    }
    for (const [n, c] of list) {
      const ci = await this.d.createShaderModule({ code: c }).getCompilationInfo();
      for (const m of ci.messages) if (m.type === 'error') out.push(`${n} ${m.lineNum}:${m.linePos} ${m.message}`);
    }
    return out;
  }
  /** uniform from a list of [u32|f32 marker, value]; values: number = u32, {f: x} = f32 */
  u(vals) {
    const n = Math.max(8, Math.ceil(vals.length / 4) * 4), ab = new ArrayBuffer(n * 4), u = new Uint32Array(ab), f = new Float32Array(ab);
    vals.forEach((v, i) => { if (typeof v === 'object') f[i] = v.f; else u[i] = v >>> 0; });
    const b = this.buf(n * 4, 'u', GU().UNIFORM | GU().COPY_DST); this.d.queue.writeBuffer(b, 0, ab); this.uni.push(b); return b;
  }
  bg(pipe, bufs) { return this.d.createBindGroup({ layout: pipe.getBindGroupLayout(0), entries: bufs.map((b, i) => ({ binding: i, resource: { buffer: b } })) }); }

  /** weights: rd(name) -> Promise<ArrayBuffer> for one pack tensor */
  async load(rd, onProgress = () => {}) {
    const t0 = performance.now(), M = this.man, W = {};
    await this.f16Choice();   // before any pipeline is made
    const names = Object.keys(M.tensors); let done = 0;
    const up = async (name) => { const t = M.tensors[name]; const ab = await rd(name); const b = this.buf(t.bytes, name); this.d.queue.writeBuffer(b, 0, ab); done += t.bytes; onProgress(done / M.bytes); return b; };
    // per expert: int8 matrices as u32 buffers, scale|bias merged into one f32 buffer per layer
    for (const e of M.experts) {
      W[e] = { blocks: [] };
      const sb = async (pre, n, hasBias) => {
        const s = new Float32Array(await rd(`${pre}.s`)), out = new Float32Array(2 * n); out.set(s, 0);
        if (hasBias) out.set(new Float32Array(await rd(`${pre}.b`)), n);
        const b = this.buf(out.byteLength, pre + '.sb'); this.d.queue.writeBuffer(b, 0, out); return b;
      };
      W[e].tok_s = { q: await up(`${e}.tok_s.q`), sb: await sb(`${e}.tok_s`, 768, true) };
      W[e].tok_c = { q: await up(`${e}.tok_c.q`), sb: await sb(`${e}.tok_c`, 768, false) };
      for (let bi = 0; bi < M.depth; bi++) {
        const blk = {};
        for (const [l, n] of [['qkv', 2304], ['proj', 768], ['fc1', 3072], ['fc2', 768]]) blk[l] = { q: await up(`${e}.b${bi}.${l}.q`), sb: await sb(`${e}.b${bi}.${l}`, n, true) };
        const nrm = new Float32Array(512); nrm.set(new Float32Array(await rd(`${e}.b${bi}.qn`)), 0); nrm.set(new Float32Array(await rd(`${e}.b${bi}.kn`)), 256);
        blk.nrm = this.buf(2048, 'nrm'); this.d.queue.writeBuffer(blk.nrm, 0, nrm);
        W[e].blocks.push(blk);
      }
      await this.d.queue.onSubmittedWorkDone();
    }
    // per call: adaLN (16 x 4608), final (1536), fused head (48 x 768 + 48)
    const C = M.calls.length, ada = new Float32Array(C * 16 * 4608), fin = new Float32Array(C * 1536), hw = new Float32Array(C * 48 * 768), hb = new Float32Array(C * 48);
    for (let i = 0; i < C; i++) {
      ada.set(new Float32Array(await rd(`call${i}.ada`)), i * 16 * 4608); fin.set(new Float32Array(await rd(`call${i}.fin`)), i * 1536);
      hw.set(new Float32Array(await rd(`call${i}.hw`)), i * 48 * 768); hb.set(new Float32Array(await rd(`call${i}.hb`)), i * 48);
    }
    const put = (arr, label) => { const b = this.buf(arr.byteLength, label); this.d.queue.writeBuffer(b, 0, arr); return b; };
    this.ADA = put(ada, 'ada'); this.FIN = put(fin, 'fin'); this.HW = put(hw, 'hw'); this.HB = put(hb, 'hb');
    this.WT = W;
    // activations
    const T = this.T, HW = this.H * this.W;
    const ropeAll = new Float32Array(2 * T * 128); ropeAll.set(this.inp.rope_cos, 0); ropeAll.set(this.inp.rope_sin, T * 128);
    this.ROPE = put(ropeAll, 'rope');
    this.COND = this.buf(72 * HW * 4, 'cond'); this.STATE = this.buf(3 * HW * 4, 'state');
    this.XC = this.buf(T * 1152 * 4, 'xc'); this.XS = this.buf(T * 64 * 4, 'xs'); this.CP = this.buf(T * 768 * 4, 'condpatch');
    this.X = this.buf(T * 768 * 4, 'x'); this.Hb = this.buf(T * 768 * 4, 'h'); this.QKV = this.buf(T * 2304 * 4, 'qkv');
    this.QH = this.buf(6 * T * 128 * 4, 'qh'); this.KH = this.buf(6 * T * 128 * 4, 'kh'); this.VH = this.buf(6 * T * 128 * 4, 'vh');
    this.O = this.buf(T * 768 * 4, 'o'); this.HID = this.buf(T * 3072 * 4, 'hid'); this.S = this.buf(this.hg * T * this.ldS * 4, 'scores');
    this.READ = this.buf(3 * HW * 4, 'read', GU().MAP_READ | GU().COPY_DST);
    await this.d.queue.onSubmittedWorkDone();
    this.loadMs = Math.round(performance.now() - t0);
    this._plan();
    return this;
  }

  // ------------------------------------------------------------------ prebuilt dispatch plans
  gemm(list, b, epi, B, o) {   // o: {M,N,K,lda,ldb,ldc,aOff,bOff,cOff,aZ,bZ,cZ,sOff,gOff,eOff,alpha,z,bRows}
    const p = this.gemmPipe(b, epi);
    const u = this.u([o.M, o.N, o.K, o.lda, o.ldb, o.ldc, o.aOff || 0, o.bOff || 0, o.cOff || 0, o.aZ || 0, o.bZ || 0, o.cZ || 0,
      o.sOff || 0, o.gOff || 0, o.eOff || 0, this.gw, this.gh, Math.min(this.man.kernel, this.gh), Math.min(this.man.kernel, this.gw), o.bRows || 1, { f: o.alpha ?? 1 }, 0, 0, 0]);
    const t = this.tileOf(b, epi) || { BM: 64, BN: 64 };   // SPEED TUNE: the grid of the tile in use
    list.push({ p, g: this.bg(p, [u, ...B]), x: Math.ceil(o.N / t.BN), y: Math.ceil(o.M / t.BM), z: o.z || 1 });
  }
  lin(list, layer, A, C, epi, K, N, extra = {}) {
    const B = [A, layer.q, C, layer.sb];
    if (epi === 'resgate') B.push(this.ADA); if (epi === 'addbuf') B.push(this.CP);
    this.gemm(list, 'i8', epi, B, { M: this.T, N, K, lda: K, ldb: K / 4, ldc: N, ...extra });
  }
  _plan() {
    const T = this.T, HW = this.H * this.W, man = this.man, pr = (n, c) => this.pipe(n, c);
    // condition patch per expert (once per step per expert): im2col of the 72 condition channels, then GEMM without bias
    const pc = pr('patchify', PATCHIFY);
    this.planCondIm2col = [{ p: pc, g: this.bg(pc, [this.u([72, this.H, this.W, 1152, { f: 1 }, T * 1152, 0, 0]), this.COND, this.XC]), x: Math.ceil(T * 1152 / 256), y: 1, z: 1 }];
    this.planCondPatch = {};
    for (const e of man.experts) { const L = []; this.lin(L, this.WT[e].tok_c, this.XC, this.CP, 'store', 1152, 768); this.planCondPatch[e] = L; }
    const ps = pr('scale', SCALE);
    this.planInit = [{ p: ps, g: this.bg(ps, [this.u([3 * HW, { f: man.first_scale }, 0, 0]), this.STATE]), x: Math.ceil(3 * HW / 256), y: 1, z: 1 }];
    // the 7 calls
    const ln = pr('lnmod', LNMOD), qk = pr('qkrope', QKROPE), sm = pr('softmax', SOFTMAX), hd = pr('head', HEAD);
    this.planCall = man.calls.map((c, ci) => {
      const L = [], W = this.WT[c.expert];
      L.push({ p: pc, g: this.bg(pc, [this.u([3, this.H, this.W, 64, { f: c.rs }, T * 64, 0, 0]), this.STATE, this.XS]), x: Math.ceil(T * 64 / 256), y: 1, z: 1 });
      this.lin(L, W.tok_s, this.XS, this.X, 'addbuf', 64, 768);
      for (let bi = 0; bi < man.depth; bi++) {
        const blk = W.blocks[bi], base = (ci * 16 + bi) * 4608;
        L.push({ p: ln, g: this.bg(ln, [this.u([768, base, { f: 1e-6 }, 0]), this.X, this.Hb, this.ADA]), x: T, y: 1, z: 1 });
        this.lin(L, blk.qkv, this.Hb, this.QKV, 'store', 768, 2304);
        L.push({ p: qk, g: this.bg(qk, [this.u([T, { f: 1e-5 }, 0, 0]), this.QKV, blk.nrm, this.ROPE, this.QH, this.KH, this.VH]), x: T, y: 6, z: 1 });
        for (let h0 = 0; h0 < 6; h0 += this.hg) {
          this.gemm(L, 'nt', 'mask', [this.QH, this.KH, this.S], { M: T, N: T, K: 128, lda: 128, ldb: 128, ldc: this.ldS, aOff: h0 * T * 128, bOff: h0 * T * 128,
            aZ: T * 128, bZ: T * 128, cZ: T * this.ldS, alpha: 1 / Math.sqrt(128), z: this.hg });
          const rows = this.hg * T;
          L.push({ p: sm, g: this.bg(sm, [this.u([T, this.ldS, 0, 0]), this.S]), x: Math.min(rows, 65535), y: Math.ceil(rows / 65535), z: 1 });
          this.gemm(L, 'nn', 'store', [this.S, this.VH, this.O], { M: T, N: 128, K: this.ldS, lda: this.ldS, ldb: 128, ldc: 768, aZ: T * this.ldS,
            bOff: h0 * T * 128, bZ: T * 128, cOff: h0 * 128, cZ: 128, z: this.hg, bRows: T });
        }
        this.lin(L, blk.proj, this.O, this.X, 'resgate', 768, 768, { gOff: base + 1536 });
        L.push({ p: ln, g: this.bg(ln, [this.u([768, base + 2304, { f: 1e-6 }, 0]), this.X, this.Hb, this.ADA]), x: T, y: 1, z: 1 });
        this.lin(L, blk.fc1, this.Hb, this.HID, 'gelu', 768, 3072);
        this.lin(L, blk.fc2, this.HID, this.X, 'resgate', 3072, 768, { gOff: base + 3840 });
      }
      L.push({ p: ln, g: this.bg(ln, [this.u([768, ci * 1536, { f: 1e-6 }, 0]), this.X, this.Hb, this.FIN]), x: T, y: 1, z: 1 });
      L.push({ p: hd, g: this.bg(hd, [this.u([T, this.H, this.W, ci * 48 * 768, ci * 48, { f: c.vskip }, { f: c.vout }, { f: c.delta }]), this.Hb, this.HW, this.HB, this.STATE]),
               x: Math.ceil(T * 48 / 64), y: 1, z: 1 });
      return L;
    });
    this.dispatchesPerCall = this.planCall[0].length;
  }
  run(list) {
    const enc = this.d.createCommandEncoder();
    const pass = enc.beginComputePass();
    for (const s of list) { pass.setPipeline(s.p); pass.setBindGroup(0, s.g); pass.dispatchWorkgroups(s.x, s.y, s.z); }
    pass.end(); this.d.queue.submit([enc.finish()]);
  }
  /** one 10-min step from condition (Float32 [72][H][W]) and latents (Float32 [3][H][W]); returns {out: Float32 [3][H][W] normalised, evalMs[], stepMs} */
  async step(cond, lat) {
    const t0 = performance.now();
    this.d.queue.writeBuffer(this.COND, 0, cond); this.d.queue.writeBuffer(this.STATE, 0, lat);
    this.run([...this.planInit, ...this.planCondIm2col]);
    await this.d.queue.onSubmittedWorkDone();
    const evalMs = []; let prev = null;
    for (let ci = 0; ci < this.man.calls.length; ci++) {
      const e = this.man.calls[ci].expert, t = performance.now();
      this.run([...(e !== prev ? this.planCondPatch[e] : []), ...this.planCall[ci]]);
      await this.d.queue.onSubmittedWorkDone();
      evalMs.push(+(performance.now() - t).toFixed(1)); prev = e;
    }
    const enc = this.d.createCommandEncoder(); enc.copyBufferToBuffer(this.STATE, 0, this.READ, 0, 3 * this.H * this.W * 4); this.d.queue.submit([enc.finish()]);
    await this.READ.mapAsync(GPUMapMode.READ); const out = new Float32Array(this.READ.getMappedRange().slice(0)); this.READ.unmap();
    return { out, evalMs, stepMs: +(performance.now() - t0).toFixed(1) };
  }
  /** analytic matmul FLOPs of one evaluation (dense masked attention as implemented) */
  flopsPerEval() {
    const T = this.T, lin = 768 * 2304 + 768 * 768 + 2 * 768 * 3072, att = 2 * T * 768;
    return 2 * (T * 16 * (lin + att) + T * 64 * 768 + T * 768 * 48);
  }
}

/** THE window rule (twin of phone_pack.py window_update): shift the MRMS/GLM obs, insert the new prediction, this step's cos-zenith */
export function windowUpdate(cond, out, valid, cz0, cz1, mean, std, HW) {
  const c = new Float32Array(cond);
  for (let lt = 0; lt < 5; lt++) {
    c.set(cond.subarray((50 + 2 * lt) * HW, (52 + 2 * lt) * HW), (48 + 2 * lt) * HW);
    c.set(cond.subarray((61 + lt) * HW, (62 + lt) * HW), (60 + lt) * HW);
  }
  for (let v = 0; v < 2; v++) for (let i = 0; i < HW; i++) {
    let d = out[v * HW + i] * std[v] + mean[v]; if (d <= -20) d = -10;
    c[(58 + v) * HW + i] = valid[i] ? (d - mean[v]) / std[v] : 0;
  }
  for (let i = 0; i < HW; i++) c[65 * HW + i] = valid[i] ? Math.log1p(Math.max(Math.expm1(out[2 * HW + i]), 0)) : 0;
  c.set(cz0, 68 * HW); c.set(cz1, 69 * HW);
  return c;
}
