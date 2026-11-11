// Wallowa Weather's WebGPU engine core: the device for the DGMR and StormScope models (nowcast/engine.js, nowcast/stormscope/engine.js),
// buffer accounting and reading results back. The models build their own pipelines and bind groups. Pure JS (ES module), no dependencies.
'use strict';

const U = () => GPUBufferUsage;

export class GpuError extends Error {}

/** Create the GPU context.  opts: {powerPreference, needF16 (false: runs without shader-f16), onLost(info)} */
export async function createGpu(opts = {}) {
  if (!globalThis.navigator || !navigator.gpu) throw new GpuError('WebGPU is not available (navigator.gpu missing)');
  const g = new Gpu(opts);
  await g.init();
  return g;
}

export class Gpu {
  constructor(opts) {
    this.opts = Object.assign({ powerPreference: 'high-performance' }, opts);
    this.alive = 0; this.bufs = new Set();
    this.lostInfo = null;
  }

  async init() {
    const ad = await navigator.gpu.requestAdapter({ powerPreference: this.opts.powerPreference });
    if (!ad) throw new GpuError('no WebGPU adapter');
    const feats = [];
    this.f16 = ad.features.has('shader-f16');
    if (!this.f16 && this.opts.needF16 !== false) throw new GpuError('shader-f16 is required (16-bit floats in shaders; this graphics chip or browser does not offer them)');
    if (this.f16) feats.push('shader-f16');   // needF16: false runs without it
    const L = ad.limits;
    const want = {
      maxBufferSize: L.maxBufferSize,
      maxStorageBufferBindingSize: L.maxStorageBufferBindingSize,
      maxComputeWorkgroupStorageSize: L.maxComputeWorkgroupStorageSize,
      maxComputeInvocationsPerWorkgroup: L.maxComputeInvocationsPerWorkgroup,
      maxComputeWorkgroupSizeX: L.maxComputeWorkgroupSizeX,
      maxStorageBuffersPerShaderStage: L.maxStorageBuffersPerShaderStage,
    };
    this.device = await ad.requestDevice({ requiredFeatures: feats, requiredLimits: want });
    this.limits = this.device.limits;
    this.device.lost.then((li) => {
      this.lostInfo = { reason: li && li.reason, message: li && li.message, t: Date.now() };
      if (this.opts.onLost) try { this.opts.onLost(this.lostInfo); } catch (e) { /* ignore */ }
    });
    this.device.addEventListener('uncapturederror', (ev) => {
      this.lastError = (ev.error && ev.error.message) || String(ev.error);
      console.error('[gpu] ' + this.lastError);
    });
  }

  get lost() { return !!this.lostInfo; }

  // ------------------------------------------------------------------ buffers (every live byte is counted; iOS kills the page ~1.5 GB)
  buffer(size, label = '', usage = 0) {
    size = Math.max(16, Math.ceil(size / 16) * 16);
    if (size > this.limits.maxBufferSize) throw new GpuError(`buffer ${label} ${size} B exceeds maxBufferSize`);
    const b = this.device.createBuffer({ size, label, usage: usage || (U().STORAGE | U().COPY_DST | U().COPY_SRC) });
    b._pf = size; this.bufs.add(b); this.alive += size;
    return b;
  }
  free(b) {
    if (!b || !this.bufs.has(b)) return;
    this.bufs.delete(b); this.alive -= b._pf;
    b.destroy();
  }
  freeAll() { for (const b of Array.from(this.bufs)) this.free(b); }
  /** read back [off, off+size) of a buffer as an ArrayBuffer */
  async read(buf, off = 0, size = null) {
    size = size == null ? buf._pf - off : size;
    return this._readback(buf, off, size, (m) => m.slice(0, size));
  }
  /** ONE reusable MAP_READ staging buffer (grows to the largest read up to 16 MB; bigger reads get their own), mapped, copied out and
   *  unmapped every time: WebKit gives destroyed buffers back late, so a new staging buffer per read piles up. Reads are serialised
   *  (one mapping at a time). */
  _readback(buf, off, size, take) {
    const n = Math.ceil(size / 4) * 4;
    const go = async () => {
      let rb = null, own = false;
      if (n <= 16e6) {
        if (!this._rb || this._rb.size < n) {
          if (this._rb) this._rb.destroy();
          let s = 1 << 20; while (s < n) s *= 2;
          this._rb = this.device.createBuffer({ size: s, usage: U().MAP_READ | U().COPY_DST, label: 'readback' });
        }
        rb = this._rb;
      } else { rb = this.device.createBuffer({ size: n, usage: U().MAP_READ | U().COPY_DST }); own = true; }
      const enc = this.device.createCommandEncoder();
      enc.copyBufferToBuffer(buf, off, rb, 0, n);
      this.device.queue.submit([enc.finish()]);
      await rb.mapAsync(GPUMapMode.READ, 0, n);
      try { return take(rb.getMappedRange(0, n)); } finally { rb.unmap(); if (own) rb.destroy(); }
    };
    const p = (this._rq || Promise.resolve()).then(go, go);
    this._rq = p.catch(() => {});
    return p;
  }
}
