// Part of BEAM's phone code (kept identical to BEAM's own build).
// Wallowa Weather engine: BEAM forward pass (a specialised fork of the author's own WebGPU engine)
// gpu.js - the WebGPU device for BEAM: one adapter + device (16-bit float shaders when the chip offers them), counted buffers,
// a pipeline cache that refuses a kernel needing more workgroup memory than the device allows, shader compile reports, and one
// reusable read-back buffer. Plain ES module (browsers; Node only for syntax checks).
'use strict';

const U = () => GPUBufferUsage;
export class GpuError extends Error {}

/** workgroup bytes a WGSL module declares (arrays of scalars / vectors) */
export function wgBytesOf(code) {
  const SZ = { f16: 2, f32: 4, i32: 4, u32: 4, 'vec2<f16>': 4, 'vec4<f16>': 8, 'vec2<f32>': 8, 'vec2<u32>': 8, 'vec4<f32>': 16, 'vec4<u32>': 16 };
  const re = /var<workgroup>\s+\w+\s*:\s*(array<\s*([a-z0-9<>]+)\s*,\s*(\d+)\s*>|[a-z0-9<>]+)\s*;/g; let m, n = 0;
  while ((m = re.exec(code))) n += m[2] ? (SZ[m[2]] || 4) * Number(m[3]) : (SZ[m[1]] || 4);
  return n;
}

/** opts: { powerPreference = 'high-performance', f16 = 'auto' | 'off' (force the 32-bit maths path), adapter, onLost(info), onError(msg) } */
export async function createBeamGpu(opts = {}) {
  if (!globalThis.navigator || !navigator.gpu) throw new GpuError('WebGPU is not available in this browser');
  const g = new BeamGpu(opts);
  await g.init();
  return g;
}

export class BeamGpu {
  constructor(opts) {
    this.opts = Object.assign({ powerPreference: 'high-performance', f16: 'auto' }, opts);
    this.alive = 0; this.peak = 0; this.bufs = new Set(); this.pipes = new Map(); this.lostInfo = null; this.errors = [];
  }

  async init() {
    const ad = this.opts.adapter || await navigator.gpu.requestAdapter({ powerPreference: this.opts.powerPreference });
    if (!ad) throw new GpuError('no WebGPU adapter');
    this.adapter = ad;
    const i = ad.info || {};
    this.info = { vendor: i.vendor || '', architecture: i.architecture || '', device: i.device || '', description: i.description || '' };
    this.f16 = this.opts.f16 !== 'off' && ad.features.has('shader-f16');
    const L = ad.limits;
    const need = { maxStorageBufferBindingSize: Math.min(L.maxStorageBufferBindingSize, 256 * 1048576), maxBufferSize: Math.min(L.maxBufferSize, 256 * 1048576) };
    this.device = await ad.requestDevice({ requiredFeatures: this.f16 ? ['shader-f16'] : [], requiredLimits: need });
    this.limits = this.device.limits;
    this.device.lost.then((li) => {
      this.lostInfo = { reason: li && li.reason, message: li && li.message, t: Date.now() };
      if (this.opts.onLost) try { this.opts.onLost(this.lostInfo); } catch (e) { /* ignore */ }
    });
    this.device.addEventListener('uncapturederror', (ev) => {
      const m = (ev.error && ev.error.message) || String(ev.error);
      if (this.errors.length < 20) this.errors.push(m);
      if (this.opts.onError) this.opts.onError(m); else console.error('[beam gpu] ' + m);
    });
  }

  get lost() { return !!this.lostInfo; }
  describe() {
    return Object.assign({}, this.info, { f16: this.f16, maxBufferMB: Math.round(this.limits.maxBufferSize / 1048576),
      maxBindMB: Math.round(this.limits.maxStorageBufferBindingSize / 1048576), wgMem: this.limits.maxComputeWorkgroupStorageSize,
      wgInv: this.limits.maxComputeInvocationsPerWorkgroup, storageBuffers: this.limits.maxStorageBuffersPerShaderStage });
  }

  // ------------------------------------------------------------------ buffers (every live byte is counted)
  buffer(size, label = '', usage = 0) {
    size = Math.max(16, Math.ceil(size / 16) * 16);
    if (size > this.limits.maxBufferSize) throw new GpuError(`buffer ${label}: ${size} B is more than this GPU allows`);
    const b = this.device.createBuffer({ size, label, usage: usage || (U().STORAGE | U().COPY_DST | U().COPY_SRC) });
    b._sz = size; this.bufs.add(b); this.alive += size;
    if (this.alive > this.peak) this.peak = this.alive;
    return b;
  }
  free(b) {
    if (!b || !this.bufs.has(b)) return;
    this.bufs.delete(b); this.alive -= b._sz; b.destroy();
  }
  freeAll() {
    for (const b of Array.from(this.bufs)) this.free(b);
    if (this._rb) { this._rb.destroy(); this._rb = null; }
  }
  /** write a TypedArray / ArrayBuffer into dst at dstOff (bytes; a tail that is not a multiple of 4 is padded) */
  write(dst, dstOff, data) {
    const ab = data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    const n = ab.byteLength - (ab.byteLength % 4);
    if (n) this.device.queue.writeBuffer(dst, dstOff, ab.buffer, ab.byteOffset, n);
    if (n < ab.byteLength) { const t = new Uint8Array(4); t.set(ab.subarray(n)); this.device.queue.writeBuffer(dst, dstOff + n, t); }
  }
  /** read [off, off + size) of a buffer -> ArrayBuffer. One MAP_READ buffer is kept and reused (WebKit gives destroyed buffers back
   *  late, so a new one per read would pile up); reads are serialised. */
  read(buf, off = 0, size = null) {
    size = size == null ? buf._sz - off : size;
    const n = Math.ceil(size / 4) * 4;
    const go = async () => {
      if (!this._rb || this._rb.size < n) {
        if (this._rb) this._rb.destroy();
        let s = 1 << 20; while (s < n) s *= 2;
        this._rb = this.device.createBuffer({ size: s, usage: U().MAP_READ | U().COPY_DST, label: 'beam readback' });
      }
      const rb = this._rb, enc = this.device.createCommandEncoder();
      enc.copyBufferToBuffer(buf, off, rb, 0, n);
      this.device.queue.submit([enc.finish()]);
      await rb.mapAsync(GPUMapMode.READ, 0, n);
      try { return rb.getMappedRange(0, n).slice(0, size); } finally { rb.unmap(); }
    };
    const p = (this._rq || Promise.resolve()).then(go, go);
    this._rq = p.catch(() => {});
    return p;
  }
  async done() {
    if (this.lost) throw new GpuError('GPU device lost: ' + JSON.stringify(this.lostInfo));
    await this.device.queue.onSubmittedWorkDone();
    if (this.lost) throw new GpuError('GPU device lost: ' + JSON.stringify(this.lostInfo));
  }

  // ------------------------------------------------------------------ pipelines
  _module(key, code) {
    const wl = this.limits.maxComputeWorkgroupStorageSize, wb = wgBytesOf(code);
    if (wb > wl) throw new GpuError(`This GPU allows ${wl} bytes of workgroup memory; the kernel ${key} needs ${wb}`);
    return this.device.createShaderModule({ code, label: key });
  }
  /** cached compute pipeline (entry point main); codeFn is only called on a miss */
  pipeline(key, codeFn) {
    let p = this.pipes.get(key);
    if (p) return p;
    const code = codeFn(), mod = this._module(key, code);
    p = this.device.createComputePipeline({ layout: 'auto', compute: { module: mod, entryPoint: 'main' }, label: key });
    p._key = key; p._mod = mod; p._code = code;
    this.pipes.set(key, p);
    return p;
  }
  /** the same, compiled asynchronously (many at once at load) */
  pipelineAsync(key, codeFn) {
    let p = this.pipes.get(key);
    if (p) return Promise.resolve(p);
    const code = codeFn(), mod = this._module(key, code);
    const pr = this.device.createComputePipelineAsync({ layout: 'auto', compute: { module: mod, entryPoint: 'main' }, label: key }).then((q) => {
      q._key = key; q._mod = mod; q._code = code; this.pipes.set(key, q); return q;
    });
    this.pipes.set(key, pr);
    return pr.then((q) => q, async (e) => { this.pipes.delete(key); throw await this._why(key, mod, e); });
  }
  async _why(key, mod, e) {
    try {
      const ci = await mod.getCompilationInfo(), errs = ci.messages.filter((m) => m.type === 'error');
      if (errs.length) return new GpuError(`WGSL ${key}: ` + errs.map((m) => `${m.lineNum}:${m.linePos} ${m.message}`).join(' | '));
    } catch (x) { /* fall through */ }
    return e;
  }
  destroy() {
    this.freeAll(); this.pipes.clear();
    try { this.device.destroy(); } catch (e) { /* already gone */ }
  }
}

// ------------------------------------------------------------------ fp16 on the CPU (round to nearest, ties to even, as numpy)
/** f32 bit pattern -> f16 bit pattern */
export function h16(x) {
  const s = (x >>> 16) & 0x8000, e = (x >>> 23) & 0xff, m = x & 0x7fffff;
  if (e === 0xff) return s | 0x7c00 | (m ? 0x200 : 0);
  const ne = e - 112;
  if (ne >= 0x1f) return s | 0x7c00;
  if (ne <= 0) {
    if (ne < -10) return s;
    const mm = m | 0x800000, sh = 14 - ne; let hm = mm >>> sh; const rem = mm & ((1 << sh) - 1), half = 1 << (sh - 1);
    if (rem > half || (rem === half && (hm & 1))) hm++;
    return s | hm;
  }
  let r = s | (ne << 10) | (m >>> 13); const rem = m & 0x1fff;
  if (rem > 0x1000 || (rem === 0x1000 && (r & 1))) r++;
  return r;
}
const _f = new Float32Array(1), _u = new Uint32Array(_f.buffer);
export function f2h(v) { _f[0] = v; return h16(_u[0]); }
export function h2f(h) {
  const s = (h & 0x8000) ? -1 : 1, e = (h >>> 10) & 0x1f, m = h & 0x3ff;
  if (e === 0) return s * m * 5.960464477539063e-8;
  if (e === 31) return m ? NaN : s * Infinity;
  return s * (1 + m / 1024) * Math.pow(2, e - 15);
}
