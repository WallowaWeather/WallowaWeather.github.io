// nowcast/dgmr/dgmr.js - DeepMind's DGMR (the 256x256 TF-Hub snapshot, CC BY 4.0, modified) on WebGPU, in two precisions:
//   'float' (default): f32 activations and sums, 16-bit float weights - the most accurate;
//   'int8' (low memory): the reference integer model - int8 weights and activations, exact integer arithmetic, the same bytes
//                        on every GPU (it reproduces the reference run's output hashes for the same inputs, seed and member).
// One op list (455 ops) for both; tensors share GPU buffers when their lives do not overlap (plan.js), so a run holds about a quarter
// of what keeping every tensor would. A prebuilt dispatch plan: one uniform slot and one bind group per dispatch, made at load.
//   const d = new Dgmr(gpu, modelJson, 'float'); await d.load({ weights: GPUBuffer, host: ArrayBuffer });
//   const r = await d.run(inputs /* Int16Array [4][256][256], 1/32 mm/h */, { seed, member })  // -> { frames: Float32Array [18][256][256] mm/h, ms }
'use strict';
import { CONV, EW, ATTN } from './kernels_int8.js';
import { convF, EW_F, ATTN_F } from './kernels_float.js';
import { assignBuffers, elemsOf, opMacs, zLatent, s2d, d2s } from './plan.js';
import { dgmrConvTiledWGSL, dgmrConvShape, dgmrConvKey, tileId } from '../tune/variants.js';   // SPEED TUNE (Settings > Speed tune)

const SLOT = 256, KIND = { i8: 0, u8: 1, g8: 2, i16: 3 }, ACT = { none: 0, relu: 1, sigmoid: 2 };
const GU = () => GPUBufferUsage;
const hex = (ab) => Array.from(new Uint8Array(ab), (b) => b.toString(16).padStart(2, '0')).join('');

/** bytes of tensor t in a precision (int8: 1 a value, the int16 input / output 2; float: 4) */
export const tensorBytes = (m, t, precision) => elemsOf(m.tensors[t]) * (precision === 'float' ? 4 : m.tensors[t].kind === 'i16' ? 2 : 1);
/** what a run needs on the GPU beyond the weights: { buffers, bytes, largest } */
export function activationPlan(m, precision) {
  const a = assignBuffers(m, (t) => tensorBytes(m, t, precision));
  return { buffers: a.sizes.length, bytes: a.total, largest: Math.max(...m.tensors.map((_, t) => tensorBytes(m, t, precision))), peak: a.peak };
}

export class Dgmr {
  constructor(gpu, m, precision, { share = true, tiles = null } = {}) {
    if (precision !== 'float' && precision !== 'int8') throw new Error('precision ' + precision);
    if (m.precision !== precision) throw new Error(`the model file is ${m.precision}, not ${precision}`);
    this.g = gpu; this.d = gpu.device; this.m = m; this.p = precision; this.pipes = {}; this.share = share;
    this.tiles = precision === 'float' && tiles ? tiles : null;   // SPEED TUNE: { conv shape key: tile } (float only; null: the standard conv)
    this.totalMacs = m.ops.reduce((s, op) => s + opMacs(m, op), 0);
  }
  /** weights: a GPU buffer holding the pack's weights shard; host: the tables shard (latent conditioning, read on the CPU) */
  async load({ weights, host }) {
    this.W = weights; this.host = host;
    const bad = await this.checkShaders(); if (bad.length) throw Object.assign(new Error('nowcast shaders: ' + bad.join(' | ')), { code: 'UNSUPPORTED' });
    this._alloc(); this._plan();
    return this;
  }
  async checkShaders() {
    const list = this.p === 'float' ? [['conv', convF(this.m.wenc)], ['ew', EW_F], ['attn', ATTN_F]] : [['conv', CONV], ['ew', EW], ['attn', ATTN]];
    if (this.tiles) for (const t of Object.values(this.tiles)) { const n = 'conv~' + tileId(t); if (!list.some((x) => x[0] === n)) list.push([n, dgmrConvTiledWGSL(this.m.wenc, t)]); }   // SPEED TUNE
    const out = [];
    for (const [n, c] of list) {
      const mod = this.d.createShaderModule({ code: c, label: 'nowcast ' + n }); this.pipes['mod:' + n] = mod;
      const ci = await mod.getCompilationInfo();
      for (const x of ci.messages) if (x.type === 'error') { if (n.startsWith('conv~')) this.tiles = null; else out.push(`${n} ${x.lineNum}:${x.linePos} ${x.message}`); }   // SPEED TUNE: a tuned conv that does not compile here: the standard one
    }
    return out;
  }
  pipe(name, entry = 'main') {
    const k = name + ':' + entry;
    return this.pipes[k] || (this.pipes[k] = this.d.createComputePipeline({ layout: 'auto', compute: { module: this.pipes['mod:' + name], entryPoint: entry }, label: 'nowcast ' + k }));
  }

  _alloc() {
    const m = this.m, T = m.tensors, p = this.p;
    const a = this.share ? assignBuffers(m, (t) => tensorBytes(m, t, p)) : { slot: T.map((_, t) => t), sizes: T.map((_, t) => tensorBytes(m, t, p)) };
    a.total = a.sizes.reduce((x, y) => x + y, 0);
    this.bufs = a.sizes.map((s, b) => this.g.buffer(s, `nowcast act ${b}`));
    this.tb = T.map((_, t) => (a.slot[t] >= 0 ? this.bufs[a.slot[t]] : null));
    this.actBytes = a.total;
    // the conditional batch-norm coefficients: per cbn op [18][C] scale then [18][C] offset (int8: i32, float: f32), made per latent
    let off = 0; this.coff = {};
    m.ops.forEach((op, i) => { if (op.op === 'cbn') { this.coff[i] = off; off += 2 * 18 * T[op.x.t].c; } });
    this.coefN = off; this.coef = this.g.buffer(off * 4, 'nowcast bn'); this.coefHost = p === 'float' ? new Float32Array(off) : new Int32Array(off);
    m.ops.forEach((op, i) => {   // the output BN does not depend on the latent: set once
      if (op.op !== 'cbn' || op.cond) return;
      const C = T[op.x.t].c, n = 18 * C, o = this.coff[i];
      if (p === 'float') { const H = new Float32Array(this.host); for (let q = 0; q < n; q++) { this.coefHost[o + q] = H[op.mul + q]; this.coefHost[o + n + q] = H[op.sub + q]; } }
      else { const dv = new DataView(this.host); for (let q = 0; q < n; q++) { this.coefHost[o + q] = dv.getInt32(op.aoff + 4 * q, true); this.coefHost[o + n + q] = dv.getInt32(op.boff + 4 * q, true); } }
    });
  }

  // ------------------------------------------------------------------ dispatch records
  _split(cout, mcnt, ktot) {
    const blocks = Math.ceil(cout / 64) * Math.ceil(mcnt / 64);
    let split = 1;
    if (blocks < 32 && ktot >= 2048) split = Math.max(1, Math.min(Math.ceil(64 / blocks), Math.floor(ktot / 512)));
    let kper = Math.ceil(ktot / split / 16) * 16; split = Math.ceil(ktot / kper);
    if (split === 1) kper = Math.ceil(ktot / 16) * 16;
    return { split, kper };
  }
  _disp(i) {
    const m = this.m, T = m.tensors, op = m.ops[i], To = T[op.out.t], H = To.h, Wd = To.w, n = op.out.n, D = [], F = this.p === 'float';
    if (op.op === 'input' || op.op === 'zin') return D;
    if (op.op === 'conv') {
      const ins = op.ins, cin = ins.reduce((s, r) => s + T[r.t].c, 0), cout = To.c, mcnt = n * H * Wd, slots = [], bsel = [];
      for (const r of ins) { let s = slots.indexOf(r.t); if (s < 0) { slots.push(r.t); s = slots.length - 1; } bsel.push(s); }
      if (slots.length > 2) throw new Error('conv with more than 2 input tensors');
      const ktot = op.k * op.k * cin, { split, kper } = this._split(cout, mcnt, ktot), U = new Uint32Array(SLOT / 4), Ti = T[ins[0].t];
      if (F) {
        U.set([0, mcnt, H, Wd, cout, ktot, op.k, op.up, Ti.h, Ti.w, ins.length, cin, kper, op.out.i0, ACT[op.act], split > 1 ? 1 : 0, op.boff, op.woff, split, 0]);
        let cs = 0; ins.forEach((r, q) => { U.set([bsel[q], r.i0, T[r.t].c, cs, r.relu ? 1 : 0, 0, 0, 0], 20 + 8 * q); cs += T[r.t].c; });
        if (split > 1) this.scrNeed = Math.max(this.scrNeed || 0, split * mcnt * cout * 4);
      } else {   // the reference layout, field for field
        U.set([0, mcnt, H, Wd, cout, ktot, op.k, op.up, Ti.h, Ti.w, ins.length, cin, op.chunk / 16, kper, op.out.i0, KIND[To.kind],
          ACT[op.act], split > 1 ? 1 : 0, op.boff, op.moff, op.soff, Math.max(0, op.lut), op.woff, 0]);
        let cs = 0; ins.forEach((r, q) => { U.set([bsel[q], r.i0, T[r.t].c, cs, KIND[T[r.t].kind], r.relu, 0, 0], 24 + 8 * q); cs += T[r.t].c; });
        if (split > 1) this.scrNeed = Math.max(this.scrNeed || 0, mcnt * cout * 4);
      }
      const b0 = this.tb[slots[0]], b1 = this.tb[slots[1] != null ? slots[1] : slots[0]];
      const tt = F && this.tiles ? this.tiles[dgmrConvKey(dgmrConvShape(T, op))] : null;   // SPEED TUNE: this shape's tuned tile (the same sums, split across threads another way)
      D.push({ p: tt ? 'conv~' + tileId(tt) : 'conv', U, wg: [Math.ceil(cout / (tt ? tt.BN : 64)), Math.ceil(mcnt / (tt ? tt.BM : 64)), split], bind: [b0, b1, this.W, this.tb[op.out.t], 'scr'] });
      if (split > 1) {
        const nt = mcnt * cout / 4, x = Math.min(65535, Math.ceil(nt / 64)), y = Math.ceil(Math.ceil(nt / 64) / 65535);
        D.push({ p: 'fin', U, wg: [x, y, 1], bind: [null, null, this.W, this.tb[op.out.t], 'scr'] });
      }
      return D;
    }
    if (op.op === 'attn') {
      const U = new Uint32Array(SLOT / 4);
      if (F) U.set([op.q.i0, op.k.i0, op.v.i0, op.out.i0]);
      else { const I = new Int32Array(U.buffer); U.set([op.Es]); I[1] = op.Ed; I[2] = op.M; U.set([op.S, op.expoff, op.q.i0, op.k.i0, op.v.i0, op.out.i0], 3); }
      D.push({ p: 'attn', U, wg: [1, 1, 1], bind: F ? [this.tb[op.q.t], this.tb[op.k.t], this.tb[op.v.t], this.tb[op.out.t]] : [this.tb[op.q.t], this.tb[op.k.t], this.tb[op.v.t], this.W, this.tb[op.out.t]] });
      return D;
    }
    const C = To.c, nw = n * H * Wd * C / 4, U = new Uint32Array(SLOT / 4), I = new Int32Array(U.buffer);
    let A, B0, B1, P = F ? this.coef : this.W;
    if (F) {
      U[0] = 0; U[1] = nw; U[2] = H; U[3] = Wd; U[4] = C; U[6] = op.out.i0;
      if (op.op === 'add') {
        U[5] = 0; U[7] = op.a.i0; U[8] = op.pool; U[9] = op.up_b; U[10] = op.b.length;
        U.set([op.b[0].i0, T[op.b[0].t].c, 0, 0], 12); if (op.b.length > 1) U.set([op.b[1].i0, T[op.b[1].t].c, T[op.b[0].t].c, 0], 16);
        A = this.tb[op.a.t]; B0 = this.tb[op.b[0].t]; B1 = this.tb[(op.b[1] || op.b[0]).t];
      } else if (op.op === 'cbn') { U[5] = 1; U[7] = op.x.i0; U[11] = this.coff[i]; U[21] = op.x.i0; A = B0 = B1 = this.tb[op.x.t]; }
      else if (op.op === 'gmul') { U[5] = 2; U[7] = op.r.i0; U[12] = op.h.i0; A = this.tb[op.r.t]; B0 = B1 = this.tb[op.h.t]; }
      else if (op.op === 'gru') {
        U[5] = 3; U[7] = op.u.i0; U[12] = op.h.i0; U[16] = op.c.i0; const hout = op.h.t === op.out.t; U[20] = hout ? 1 : 0;
        A = this.tb[op.u.t]; B1 = this.tb[op.c.t]; B0 = hout ? this.tb[op.u.t] : this.tb[op.h.t];
      } else throw new Error('op ' + op.op);
    } else {   // the reference layout
      U[0] = 0; U[1] = nw; U[2] = H; U[3] = Wd; U[4] = C; U[7] = op.out.i0;
      if (op.op === 'add') {
        U[5] = 0; U[6] = op.S; U[8] = op.a.i0; U[9] = KIND[T[op.a.t].kind]; U[10] = op.pool; U[11] = op.up_b; I[12] = op.ma; U[13] = op.mboff; U[14] = op.b.length;
        U.set([op.b[0].i0, T[op.b[0].t].c, 0, KIND[T[op.b[0].t].kind]], 16);
        if (op.b.length > 1) U.set([op.b[1].i0, T[op.b[1].t].c, T[op.b[0].t].c, KIND[T[op.b[1].t].kind]], 20);
        A = this.tb[op.a.t]; B0 = this.tb[op.b[0].t]; B1 = this.tb[(op.b[1] || op.b[0]).t];
      } else if (op.op === 'cbn') { U[5] = 1; U[6] = op.S; U[8] = op.x.i0; U[9] = KIND[T[op.x.t].kind]; U[15] = this.coff[i] * 4; U[27] = op.x.i0; A = B0 = B1 = this.tb[op.x.t]; P = this.coef; }
      else if (op.op === 'gmul') { U[5] = 2; U[8] = op.r.i0; U[16] = op.h.i0; A = this.tb[op.r.t]; B0 = B1 = this.tb[op.h.t]; }
      else if (op.op === 'gru') {
        U[5] = 3; U[6] = op.S; U[8] = op.u.i0; U[16] = op.h.i0; U[20] = op.c.i0; I[24] = op.Ah; I[25] = op.Ac;
        const hout = op.h.t === op.out.t; U[26] = hout ? 1 : 0;
        A = this.tb[op.u.t]; B1 = this.tb[op.c.t]; B0 = hout ? this.tb[op.u.t] : this.tb[op.h.t];
      } else throw new Error('op ' + op.op);
    }
    const wgs = Math.ceil(nw / 256), x = Math.min(65535, wgs), y = Math.ceil(wgs / 65535);
    D.push({ p: 'ew', U, wg: [x, y, 1], bind: [A, B0, B1, P, this.tb[op.out.t]] });
    return D;
  }
  _bg(rec, ub, off) {
    const e = (b, buffer) => ({ binding: b, resource: { buffer } }), u0 = { binding: 0, resource: { buffer: ub, offset: off, size: SLOT } };
    const lay = this.pipe(rec.p === 'fin' ? 'conv' : rec.p, rec.p === 'fin' ? 'fin' : 'main').getBindGroupLayout(0);
    const B = rec.bind.map((b) => (b === 'scr' ? this.scr : b));
    if (rec.p === 'fin') return this.d.createBindGroup({ layout: lay, entries: [u0, e(3, B[2]), e(4, B[3]), e(5, B[4])] });
    return this.d.createBindGroup({ layout: lay, entries: [u0, ...B.map((b, k) => e(k + 1, b))] });
  }
  _plan() {
    const recs = [];
    this.m.ops.forEach((op, i) => { for (const r of this._disp(i)) recs.push(Object.assign(r, { op: i })); });
    this.scr = this.g.buffer(Math.max(this.scrNeed || 0, 64), 'nowcast split-k');
    this.ub = this.g.buffer(recs.length * SLOT, 'nowcast uniforms', GU().UNIFORM | GU().COPY_DST);
    const hostU = new Uint8Array(recs.length * SLOT);
    recs.forEach((r, k) => { hostU.set(new Uint8Array(r.U.buffer), k * SLOT); r.bg = this._bg(r, this.ub, k * SLOT); r.pl = this.pipe(r.p === 'fin' ? 'conv' : r.p, r.p === 'fin' ? 'fin' : 'main'); r.U = null; });
    this.d.queue.writeBuffer(this.ub, 0, hostU);
    this.plan = recs;
  }
  _encode() {
    let enc = this.d.createCommandEncoder(), pass = enc.beginComputePass(), n = 0;
    for (const r of this.plan) {
      pass.setPipeline(r.pl); pass.setBindGroup(0, r.bg); pass.dispatchWorkgroups(r.wg[0], r.wg[1], r.wg[2]);
      if (++n >= 160) { pass.end(); this.d.queue.submit([enc.finish()]); enc = this.d.createCommandEncoder(); pass = enc.beginComputePass(); n = 0; }
    }
    pass.end(); this.d.queue.submit([enc.finish()]);
  }

  // ------------------------------------------------------------------ a job
  /** the latent's batch-norm coefficients. int8: the reference integer maths (every value < 2^53 in doubles); float: f64 sums -> f32 */
  _bnCoef(zq) {
    const m = this.m, T = m.tensors;
    if (this.p === 'float') {
      const H = new Float32Array(this.host), zs = new Float64Array(256);
      for (let k = 0; k < 256; k++) zs[k] = Math.fround(zq[m.zslice + k] * m.z_scale);
      m.ops.forEach((op, i) => {
        if (op.op !== 'cbn' || !op.cond) return;
        const C = T[op.x.t].c, o = this.coff[i];
        for (let c = 0; c < C; c++) {
          let gs = 0, go = 0;
          for (let k = 0; k < 256; k++) { gs += zs[k] * H[op.ws + k * C + c]; go += zs[k] * H[op.wo + k * C + c]; }
          for (let t = 0; t < 18; t++) { const q = t * C + c, mul = H[op.rs + q] * (gs + op.c0); this.coefHost[o + q] = mul; this.coefHost[o + 18 * C + q] = go - H[op.mean + q] * mul; }
        }
      });
      return;
    }
    const dv = new DataView(this.host), zs = zq.subarray(m.zslice, m.zslice + 256);
    m.ops.forEach((op, i) => {
      if (op.op !== 'cbn' || !op.cond) return;
      const C = T[op.x.t].c, o = this.coff[i], P2 = (r) => Math.pow(2, r);
      const hR = P2(op.R - 1), dR = P2(op.R), hRg = P2(op.Rg - 1), dRg = P2(op.Rg), hR2 = P2(op.R2 - 1), dR2 = P2(op.R2);
      const ws = new Int8Array(this.host, op.wsoff, C * 256), wo = new Int8Array(this.host, op.wooff, C * 256);
      for (let c = 0; c < C; c++) {
        let gs = 0, go = 0;
        for (let k = 0; k < 256; k++) { gs += zs[k] * ws[c * 256 + k]; go += zs[k] * wo[c * 256 + k]; }
        const gTerm = Math.floor((go * dv.getInt32(op.gammaoff + 4 * c, true) + hRg) / dRg);
        for (let t = 0; t < 18; t++) {
          const q = t * C + c;
          let A = Math.floor((gs * dv.getInt32(op.alphaoff + 4 * q, true) + hR) / dR) + dv.getInt32(op.betaoff + 4 * q, true);
          A = Math.max(-(2 ** 21 - 1), Math.min(2 ** 21 - 1, A));
          let B = gTerm - Math.floor((A * dv.getInt32(op.muoff + 4 * q, true) + hR2) / dR2);
          B = Math.max(-(2 ** 30), Math.min(2 ** 30, B));
          this.coefHost[o + q] = A; this.coefHost[o + 18 * C + q] = B;
        }
      }
    });
  }
  _setJob(inputs, seed, member) {
    const m = this.m, zq = zLatent(m.z_thresholds, seed, member);
    this._bnCoef(zq);
    const inT = m.ops.find((o) => o.op === 'input').out.t, zT = m.ops.find((o) => o.op === 'zin').out.t;
    if (this.p === 'float') {
      const f = new Float32Array(inputs.length); for (let i = 0; i < f.length; i++) f[i] = inputs[i] / 32;
      this.d.queue.writeBuffer(this.tb[inT], 0, s2d(f));
      const z = new Float32Array(512); for (let i = 0; i < 512; i++) z[i] = zq[i] * m.z_scale;
      this.d.queue.writeBuffer(this.tb[zT], 0, z);
    } else {
      this.d.queue.writeBuffer(this.tb[inT], 0, s2d(inputs));
      const z4 = new Uint8Array(Math.ceil(512 / 4) * 4); z4.set(new Uint8Array(zq.buffer)); this.d.queue.writeBuffer(this.tb[zT], 0, z4);
    }
    this.d.queue.writeBuffer(this.coef, 0, this.coefHost);
    return zq;
  }
  /** one nowcast member -> { frames: Float32Array [18][256][256] mm/h, ms, outSha (int8: sha256 of the raw int16 output, as the reference run) } */
  async run(inputs, { seed = 1, member = 0, hash = false } = {}) {
    if (!(inputs instanceof Int16Array) || inputs.length !== 4 * 256 * 256) throw new Error('inputs: Int16Array [4][256][256] in 1/32 mm/h');
    this._setJob(inputs, seed, member);
    await this.d.queue.onSubmittedWorkDone();
    const t0 = performance.now();
    this._encode();
    await this.d.queue.onSubmittedWorkDone();
    const ms = performance.now() - t0;
    if (this.g.lost) throw Object.assign(new Error('the graphics chip was reset during the nowcast'), { code: 'GPU_LOST' });
    const outT = this.m.output, bytes = tensorBytes(this.m, outT, this.p);
    const ab = await this.g.read(this.tb[outT], 0, bytes);
    const res = { ms: Math.round(ms), seed, member, precision: this.p };
    if (hash && crypto.subtle) res.outSha = hex(await crypto.subtle.digest('SHA-256', ab));
    res.frames = this.p === 'float' ? d2s(new Float32Array(ab), 1) : d2s(new Int16Array(ab), 1 / 64);
    return res;
  }
  /** GPU bytes this model holds (weights + activations + tables) */
  get gpuBytes() { return (this.W ? this.W.size : 0) + this.actBytes + this.coefN * 4 + (this.scr ? this.scr.size : 0) + (this.ub ? this.ub.size : 0); }
  /** let every buffer go (the device stays with its owner) */
  free() {
    for (const b of this.bufs || []) this.g.free(b);
    for (const b of [this.coef, this.scr, this.ub]) if (b) this.g.free(b);
    this.bufs = []; this.tb = []; this.plan = null; this.coef = this.scr = this.ub = null; this.host = null; this.coefHost = null;
  }
}
