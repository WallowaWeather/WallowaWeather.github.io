// Part of BEAM's phone code (kept identical to BEAM's own build).
// Wallowa Weather engine: BEAM forward pass (a specialised fork of the author's own WebGPU engine)
// beam.js - the BEAM U-Net (40 inputs, 12 maps, base 32) on WebGPU for its six members and their mean.
//   const net = new BeamNet(gpu, modelJson, { tiles, acc, weights: 'resident' | 'stream' });
//   await net.load(weightsArrayBuffer);          // compiles the kernels, makes every buffer and bind group ONCE
//   const r = await net.run(inputHWC);           // Uint16Array [304 * 304][40] f16 bits (input.js) -> { mean: Float32Array [12][304 * 304], ms }
//   net.free();
// Per member: encoder 4 levels of [conv3x3 -> GroupNorm(8) -> SiLU] x 2 (32 / 64 / 128 / 256 channels, a 2x2 max-pool between),
// decoder 3 levels of conv-transpose 2x2/2 -> concat [up, skip] -> the same double conv, head 1x1 conv -> 12 -> sigmoid.
// The concat is never copied: an encoder level writes its output (the skip) straight into channels [C, 2C) of the decoder's input
// buffer and the conv-transpose writes channels [0, C). GroupNorm needs the whole tensor, so it is a statistics pass after each conv;
// its apply + SiLU then runs in place (for a skip, together with the 2x2 max-pool), so every stored tensor is the post-SiLU value
// PyTorch has. (Fusing the apply into the next conv's load would repeat it once per 3x3 tap per output tile: ~9x the work on BEAM's
// thin 304 x 304 layers, for a pass that costs one read and one write.)
// Runs allocate nothing: the same buffers and bind groups serve every member and every run (WebKit gives freed GPU memory back late).
'use strict';
import { convWGSL, gnPartWGSL, gnFinWGSL, gnApplyWGSL, gnApplyPoolWGSL, headWGSL, MEAN_WGSL } from './kernels.js';

export const S = 304, HW0 = S * S, NMAP = 12;
const CH = [32, 64, 128, 256], G = 8, EPS = 1e-5;
/** tile [BM, BN] per conv by output channels (and per transpose); measured, overridable with opts.tiles {name: [BM, BN]} */
export const DEFAULT_TILES = { c32: [128, 32], c64: [64, 64], c128: [64, 64], c256: [64, 128], u2: [64, 128], u1: [64, 64], u0: [64, 64] };

// activation buffers: name -> [channels, side]
const BUFS = { X0: [40, 304], T0: [32, 304], C0: [64, 304], P0: [32, 152], T1: [64, 152], C1: [128, 152], P1: [64, 76], T2: [128, 76],
  C2: [256, 76], P2: [128, 38], T3: [256, 38], Y3: [256, 38] };
const v = (buf, C, H, ld = C, c0 = 0) => ({ buf, C, H, ld, c0 });

/** the static layer list of one member: convs (with the GroupNorm that follows), transposes, head */
function layers() {
  const L = [];
  const conv = (name, Ci, Co, H, src, dst, post) => L.push({ kind: 'conv', name, Ci, Co, H, src, dst, post });
  const up = (name, Ci, Co, Hin, src, dst) => L.push({ kind: 'up', name, Ci, Co, Hin, src, dst });
  conv('e0c1', 40, 32, 304, v('X0', 40, 304), v('T0', 32, 304), { a: 'e0a1' });
  conv('e0c2', 32, 32, 304, v('T0', 32, 304), v('C0', 32, 304, 64, 32), { a: 'e0a2', pool: v('P0', 32, 152), p: 'p0' });
  conv('e1c1', 32, 64, 152, v('P0', 32, 152), v('T1', 64, 152), { a: 'e1a1' });
  conv('e1c2', 64, 64, 152, v('T1', 64, 152), v('C1', 64, 152, 128, 64), { a: 'e1a2', pool: v('P1', 64, 76), p: 'p1' });
  conv('e2c1', 64, 128, 76, v('P1', 64, 76), v('T2', 128, 76), { a: 'e2a1' });
  conv('e2c2', 128, 128, 76, v('T2', 128, 76), v('C2', 128, 76, 256, 128), { a: 'e2a2', pool: v('P2', 128, 38), p: 'p2' });
  conv('e3c1', 128, 256, 38, v('P2', 128, 38), v('T3', 256, 38), { a: 'e3a1' });
  conv('e3c2', 256, 256, 38, v('T3', 256, 38), v('Y3', 256, 38), { a: 'e3a2' });
  up('u2', 256, 128, 38, v('Y3', 256, 38), v('C2', 128, 76, 256, 0));
  conv('d2c1', 256, 128, 76, v('C2', 256, 76), v('T2', 128, 76), { a: 'd2a1' });
  conv('d2c2', 128, 128, 76, v('T2', 128, 76), v('C2', 128, 76), { a: 'd2a2' });     // C2's memory, now 128 channels
  up('u1', 128, 64, 76, v('C2', 128, 76), v('C1', 64, 152, 128, 0));
  conv('d1c1', 128, 64, 152, v('C1', 128, 152), v('T1', 64, 152), { a: 'd1a1' });
  conv('d1c2', 64, 64, 152, v('T1', 64, 152), v('C1', 64, 152), { a: 'd1a2' });
  up('u0', 64, 32, 152, v('C1', 64, 152), v('C0', 32, 304, 64, 0));
  conv('d0c1', 64, 32, 304, v('C0', 64, 304), v('T0', 32, 304), { a: 'd0a1' });
  conv('d0c2', 32, 32, 304, v('T0', 32, 304), v('C0', 32, 304), { a: 'd0a2' });
  L.push({ kind: 'head', name: 'out', src: v('C0', 32, 304) });
  return L;
}
export const LAYERS = layers();

export class BeamNet {
  constructor(gpu, model, opts = {}) {
    this.g = gpu; this.model = model;
    this.opts = Object.assign({ acc: 'f32', weights: 'resident' }, opts);
    this.tiles = Object.assign({}, DEFAULT_TILES, opts.tiles || {});
    if (model.arch !== 'beam-unet' || model.version !== 1) throw new Error('not a BEAM pack (beam-unet v1)');
    this.nMembers = model.members.length; this.memberBytes = model.member_bytes;
    this.fold = model.members.map((m) => (m.fold === 'odd' ? 0 : 1));
    this.views = {}; this.steps = null; this.loaded = false;
    this.L = LAYERS.map((l) => Object.assign({}, l));   // this net's own per-layer state (kernels, offsets)
  }
  tileOf(l) { return l.kind === 'up' ? this.tiles[l.name] : (this.tiles[l.name] || this.tiles['c' + l.Co]); }
  t(name) { const x = this.model.tensors[name]; if (!x) throw new Error('pack has no tensor ' + name); return x; }

  /** weights: ArrayBuffer | Uint8Array of beam.weights.bin (all members). Returns { compileMs, uploadMs, gpuMB } */
  async load(weights) {
    const g = this.g, f16 = g.f16, t0 = performance.now();
    const wb = weights instanceof ArrayBuffer ? new Uint8Array(weights) : weights;
    if (wb.byteLength !== this.nMembers * this.memberBytes) throw new Error(`weights: ${wb.byteLength} bytes, the model says ${this.nMembers * this.memberBytes}`);
    // ---- kernels (compiled in parallel)
    const P = {}, jobs = [];
    const want = (key, code) => { if (!P[key]) { P[key] = null; jobs.push(g.pipelineAsync(key, () => code()).then((p) => { P[key] = p; })); } return key; };
    for (const l of this.L) {
      if (l.kind === 'conv' || l.kind === 'up') {
        const [BM, BN] = this.tileOf(l), up = l.kind === 'up';
        const H = up ? l.Hin : l.H, ks = up ? 1 : 3, N = up ? 4 * l.Co : l.Co, Kreal = up ? l.Ci : 9 * l.Ci, Kpad = Math.ceil(Kreal / 32) * 32;
        const c = { f16, ks, H, W: H, Ci: l.Ci, ldx: l.src.ld, cx0: l.src.c0, N, Kpad, Kreal, ldy: l.dst.ld, cy0: l.dst.c0, BM, BN,
          epi: up ? 'up' : 'store', Cup: up ? l.Co : 0, acc: this.opts.acc };
        l._c = c; l._wg = [Math.ceil(H * H / BM), N / BN, 1];
        l._pk = want(`beam.${l.name}.${BM}x${BN}.${f16 ? 'h' : 'u'}.${c.acc}`, () => convWGSL(c));
        if (!up) {
          l._gp = want(`beam.gnp.${l.Co}.${f16 ? 'h' : 'u'}`, () => gnPartWGSL({ f16, C: l.Co, G }));
          l._gf = want(`beam.gnf.${l.Co}`, () => gnFinWGSL({ C: l.Co, G, eps: EPS }));
          l._ga = l.post.pool ? want(`beam.gnpool.${l.Co}.${l.H}.${f16 ? 'h' : 'u'}`, () => gnApplyPoolWGSL({ f16, C: l.Co, W: l.H }))
            : want(`beam.gna.${l.Co}.${f16 ? 'h' : 'u'}`, () => gnApplyWGSL({ f16, C: l.Co }));
        }
      } else {
        l._hs = want(`beam.head.store.${f16 ? 'h' : 'u'}`, () => headWGSL({ f16, HW: HW0, add: false }));
        l._ha = want(`beam.head.add.${f16 ? 'h' : 'u'}`, () => headWGSL({ f16, HW: HW0, add: true }));
      }
    }
    want('beam.mean', () => MEAN_WGSL);
    try { await Promise.all(jobs); } catch (e) { this.free(); throw e; }
    this.P = P; this.compileMs = performance.now() - t0;
    // ---- buffers (all made here, once)
    const t1 = performance.now();
    g.device.pushErrorScope('out-of-memory');
    const B = this.B = {};
    for (const [n, [C, H]] of Object.entries(BUFS)) B[n] = g.buffer(H * H * C * 2, 'beam ' + n);
    const stream = this.opts.weights === 'stream';
    B.W = g.buffer(stream ? this.memberBytes : wb.byteLength, 'beam weights');
    B.ACC = g.buffer(2 * NMAP * HW0 * 4, 'beam fold sums');
    B.OUT = g.buffer(NMAP * HW0 * 4, 'beam mean');
    let abOff = 0, maxJ = 0; const uni = [];
    for (const l of this.L) if (l.kind === 'conv') {
      l._ab = abOff; abOff += Math.ceil(2 * l.Co * 4 / 256) * 256;
      const HW = l.H * l.H, Sl = 256 / (l.Co / 4), Pc = Sl * 16, J = Math.ceil(HW / Pc); maxJ = Math.max(maxJ, J);
      l._J = J;
      l._u = uni.length; uni.push([HW, l.dst.ld / 4, l.dst.c0 / 4, Pc], [J, 0, 0, 0],
        l.post.pool ? [HW / 4, l.dst.ld / 4, l.dst.c0 / 4, 0] : [HW, l.dst.ld / 4, l.dst.c0 / 4, 0]);
    }
    this._meanSlot = uni.length; uni.push([0, 0, 0, 0]);
    B.AB = g.buffer(abOff, 'beam groupnorm a, b');
    B.PT = g.buffer(maxJ * G * 16, 'beam groupnorm partials');
    B.U = g.buffer(uni.length * 256, 'beam uniforms', GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST);
    const ua = new ArrayBuffer(uni.length * 256);
    uni.forEach((q, i) => new Uint32Array(ua, i * 256, 4).set(q));
    g.write(B.U, 0, ua);
    if (stream) { this._wcpu = wb; g.write(B.W, 0, wb.subarray(0, this.memberBytes)); this._wHas = 0; } else g.write(B.W, 0, wb);
    // ---- bind groups: per member (resident weights) or one set (streamed weights)
    const D = g.device;
    const bg = (key, list) => D.createBindGroup({ layout: P[key].getBindGroupLayout(0), entries: list.map((r, i) => ({ binding: i, resource: r })) });
    const whole = (n) => ({ buffer: B[n] });
    const uslot = (i) => ({ buffer: B.U, offset: i * 256, size: 16 });
    const nSets = stream ? 1 : this.nMembers;
    this.steps = [];
    for (let j = 0; j < nSets; j++) {
      const mo = stream ? 0 : j * this.memberBytes, steps = [];
      const wr = (name) => { const x = this.t(name); return { buffer: B.W, offset: mo + x.offset, size: Math.ceil(x.bytes / 16) * 16 }; };
      for (const l of this.L) {
        if (l.kind === 'conv' || l.kind === 'up') {
          steps.push({ p: l._pk, bg: bg(l._pk, [whole(l.src.buf), wr(l.name + '.w'), wr(l.name + '.b'), whole(l.dst.buf)]), wg: l._wg, start: l.name, done: [l.name] });
          if (l.kind === 'conv') {
            const ab = { buffer: B.AB, offset: l._ab, size: 2 * l.Co * 4 };
            steps.push({ p: l._gp, bg: bg(l._gp, [uslot(l._u), whole(l.dst.buf), { buffer: B.PT, offset: 0, size: l._J * G * 16 }]), wg: [l._J, 1, 1], start: l.post.a, done: [] });
            steps.push({ p: l._gf, bg: bg(l._gf, [uslot(l._u + 1), { buffer: B.PT, offset: 0, size: l._J * G * 16 }, wr(l.name + '.gn'), ab]), wg: [1, 1, 1], start: '', done: [] });
            const HW = l.H * l.H;
            if (l.post.pool) steps.push({ p: l._ga, bg: bg(l._ga, [uslot(l._u + 2), ab, whole(l.dst.buf), whole(l.post.pool.buf)]), wg: [Math.ceil(HW / 4 * l.Co / 4 / 256), 1, 1], start: '', done: [l.post.a, l.post.p] });
            else steps.push({ p: l._ga, bg: bg(l._ga, [uslot(l._u + 2), ab, whole(l.dst.buf)]), wg: [Math.ceil(HW * l.Co / 4 / 256), 1, 1], start: '', done: [l.post.a] });
          }
        } else {
          const fo = this.fold[j] * NMAP * HW0 * 4, acc = { buffer: B.ACC, offset: fo, size: NMAP * HW0 * 4 };
          const r = [whole(l.src.buf), wr('out.w'), wr('out.b'), acc];
          steps.push({ head: true, bgS: bg(l._hs, r), bgA: bg(l._ha, r), wg: [Math.ceil(HW0 / 256), 1, 1], start: 'probs', done: ['probs'] });
        }
      }
      this.steps.push(steps);
    }
    if (stream) for (let j = 1; j < this.nMembers; j++) this.steps.push(this.steps[0].map((s) => (s.head ? this._headFold(s, j) : s)));
    this.meanBg = bg('beam.mean', [uslot(this._meanSlot), whole('ACC'), whole('OUT')]);
    // tensor views (tests, read-back)
    this.views = {};
    for (const l of this.L) {
      if (l.kind === 'conv') { this.views[l.name] = l.dst; this.views[l.post.a] = l.dst; if (l.post.pool) this.views[l.post.p] = l.post.pool; }
      else if (l.kind === 'up') this.views[l.name] = l.dst;
    }
    this.views.x = v('X0', 40, 304);
    const oom = await g.device.popErrorScope();
    if (oom) { this.free(); throw Object.assign(new Error('the graphics chip ran out of memory loading BEAM'), { code: 'OUT_OF_MEMORY' }); }
    await g.done();
    this.uploadMs = performance.now() - t1; this.loaded = true;
    return { compileMs: Math.round(this.compileMs), uploadMs: Math.round(this.uploadMs), gpuMB: +(g.alive / 1e6).toFixed(1), pipelines: Object.keys(P).length };
  }
  _headFold(s, j) {   // streamed weights: the head of member j writes its own fold's sum
    const g = this.g, B = this.B, l = this.L[this.L.length - 1], x = this.t('out.w'), b = this.t('out.b');
    const fo = this.fold[j] * NMAP * HW0 * 4;
    const r = [{ buffer: B[l.src.buf] }, { buffer: B.W, offset: x.offset, size: Math.ceil(x.bytes / 16) * 16 }, { buffer: B.W, offset: b.offset, size: Math.ceil(b.bytes / 16) * 16 },
      { buffer: B.ACC, offset: fo, size: NMAP * HW0 * 4 }];
    const mk = (key) => g.device.createBindGroup({ layout: this.P[key].getBindGroupLayout(0), entries: r.map((q, i) => ({ binding: i, resource: q })) });
    return { head: true, bgS: mk(l._hs), bgA: mk(l._ha), wg: s.wg, start: s.start, done: s.done };
  }

  _encode(pass, j, first, stopAfter) {
    for (const s of this.steps[j]) {
      if (s.head) { pass.setPipeline(this.P[first ? this.L[this.L.length - 1]._hs : this.L[this.L.length - 1]._ha]); pass.setBindGroup(0, first ? s.bgS : s.bgA); }
      else { pass.setPipeline(this.P[s.p]); pass.setBindGroup(0, s.bg); }
      pass.dispatchWorkgroups(s.wg[0], s.wg[1], s.wg[2]);
      if (stopAfter && s.done.includes(stopAfter)) return true;
    }
    return false;
  }

  /** input: Uint16Array [304 * 304][40] (f16 bits, HWC; input.js) or null to keep the last one.
   *  o: { members (indices, default all), timing (default true: wait after each member), stopAfter (tests: a layer name),
   *       folds (also return each fold's mean), read (default true) }
   *  -> { mean: Float32Array [12][304 * 304] (the mean over the members run), folds: {odd, even}, ms: {members: [..], total, read} } */
  async run(input, o = {}) {
    if (!this.loaded) throw new Error('BEAM is not loaded');
    const g = this.g, D = g.device, members = o.members || Array.from({ length: this.nMembers }, (_, i) => i), timing = o.timing !== false;
    const t0 = performance.now();
    if (input) { if (input.length !== HW0 * 40) throw new Error('input: expected 304 * 304 * 40 halves'); g.write(this.B.X0, 0, input); }
    const firstOf = new Set(), seen = new Set();
    for (const j of members) if (!seen.has(this.fold[j])) { seen.add(this.fold[j]); firstOf.add(j); }
    const ms = [];
    let enc = D.createCommandEncoder(), pass = enc.beginComputePass(), stopped = false;
    for (const j of members) {
      const tm = performance.now();
      if (this.opts.weights === 'stream' && this._wHas !== j) {
        pass.end(); D.queue.submit([enc.finish()]);
        g.write(this.B.W, 0, this._wcpu.subarray(j * this.memberBytes, (j + 1) * this.memberBytes)); this._wHas = j;
        enc = D.createCommandEncoder(); pass = enc.beginComputePass();
      }
      stopped = this._encode(pass, j, firstOf.has(j), o.stopAfter);
      if (timing || stopped) { pass.end(); D.queue.submit([enc.finish()]); await g.done(); ms.push(performance.now() - tm); enc = D.createCommandEncoder(); pass = enc.beginComputePass(); }
      if (stopped) break;
    }
    if (!stopped) {
      const nf = seen.size, f0 = seen.has(0) ? 0 : 1, ua = new ArrayBuffer(16);
      new Uint32Array(ua, 0, 3).set([NMAP * HW0 / 4, nf, f0]); new Float32Array(ua, 12, 1)[0] = 1 / members.length;
      g.write(this.B.U, this._meanSlot * 256, ua);   // ordered before the submit below
      pass.setPipeline(this.P['beam.mean']); pass.setBindGroup(0, this.meanBg); pass.dispatchWorkgroups(Math.ceil(NMAP * HW0 / 4 / 256));
    }
    pass.end(); D.queue.submit([enc.finish()]);
    await g.done();
    const tc = performance.now();
    const r = { ms: { members: ms.map((x) => +x.toFixed(1)), compute: +(tc - t0).toFixed(1) } };
    if (!stopped && o.read !== false) {
      r.mean = new Float32Array(await g.read(this.B.OUT, 0, NMAP * HW0 * 4));
      if (o.folds) {
        const a = new Float32Array(await g.read(this.B.ACC, 0, 2 * NMAP * HW0 * 4)), n = NMAP * HW0, cnt = [0, 0];
        for (const j of members) cnt[this.fold[j]]++;
        r.folds = {};
        ['odd', 'even'].forEach((f, k) => { if (cnt[k]) { const m = a.subarray(k * n, (k + 1) * n), s = 1 / cnt[k]; for (let i = 0; i < n; i++) m[i] *= s; r.folds[f] = m; } });
      }
    }
    r.ms.read = +(performance.now() - tc).toFixed(1); r.ms.total = +(performance.now() - t0).toFixed(1);
    return r;
  }

  /** tests: read a named tensor (layer output) as Float32Array [H * W][C] (f16 -> f32) */
  async readTensor(name) {
    const x = this.views[name]; if (!x) throw new Error('no tensor ' + name);
    const n = x.H * x.H, u16 = new Uint16Array(await this.g.read(this.B[x.buf], 0, n * x.ld * 2));
    return { data: deinterleave(u16, n, x.C, x.ld, x.c0), H: x.H, C: x.C };
  }
  /** tests: write f16 bits [H * W][C] into a named tensor's place (an interleaved place is read, filled and written back) */
  async writeTensor(name, u16) {
    const x = this.views[name], n = x.H * x.H;
    if (u16.length !== n * x.C) throw new Error('writeTensor ' + name + ': size');
    if (x.ld === x.C && x.c0 === 0) { this.g.write(this.B[x.buf], 0, u16); return; }
    const cur = new Uint16Array(await this.g.read(this.B[x.buf], 0, n * x.ld * 2));
    for (let p = 0; p < n; p++) cur.set(u16.subarray(p * x.C, (p + 1) * x.C), p * x.ld + x.c0);
    this.g.write(this.B[x.buf], 0, cur);
  }
  /** tests: run the steps of member j from the one that starts layer `from` through the one that completes `to` */
  async runSteps(j, from, to, first = true) {
    const D = this.g.device, enc = D.createCommandEncoder(), pass = enc.beginComputePass(), st = this.steps[j];
    let on = false;
    for (const s of st) {
      if (!on && s.start === from) on = true;
      if (!on) continue;
      if (s.head) { const l = this.L[this.L.length - 1]; pass.setPipeline(this.P[first ? l._hs : l._ha]); pass.setBindGroup(0, first ? s.bgS : s.bgA); }
      else { pass.setPipeline(this.P[s.p]); pass.setBindGroup(0, s.bg); }
      pass.dispatchWorkgroups(s.wg[0], s.wg[1], s.wg[2]);
      if (s.done.includes(to)) break;
    }
    pass.end(); D.queue.submit([enc.finish()]); await this.g.done();
  }
  get gpuBytes() { return this.g.alive; }
  free() {
    for (const b of Object.values(this.B || {})) this.g.free(b);
    this.B = {}; this.steps = null; this.loaded = false; this._wcpu = null;
  }
}

function deinterleave(u16, n, C, ld, c0) {
  const o = new Float32Array(n * C), t = H2F();
  for (let p = 0; p < n; p++) for (let c = 0; c < C; c++) o[p * C + c] = t[u16[p * ld + c0 + c]];
  return o;
}
let _h2f = null;
/** a 65536-entry f16 -> f32 table */
export function H2F() {
  if (_h2f) return _h2f;
  _h2f = new Float32Array(65536);
  for (let h = 0; h < 65536; h++) {
    const s = (h & 0x8000) ? -1 : 1, e = (h >>> 10) & 0x1f, m = h & 0x3ff;
    _h2f[h] = e === 0 ? s * m * 5.960464477539063e-8 : e === 31 ? (m ? NaN : s * Infinity) : s * (1 + m / 1024) * Math.pow(2, e - 15);
  }
  return _h2f;
}
