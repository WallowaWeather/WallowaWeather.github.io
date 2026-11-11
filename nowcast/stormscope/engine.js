// nowcast/stormscope/engine.js - PILOT (v056 test build): NVIDIA StormScope (MRMS model, int8, frozen GOES) as a second Nowcast model.
// Same conventions as nowcast/engine.js: status / download / deleteModel / load / unload / forecast; one job at a time; load() makes
// everything, unload() gives every GPU buffer back. The pack's manifest is pinned in config.js (every 16 MiB chunk's
// sha256 checked); the weights are read tensor by tensor from this site's private storage straight to the GPU.
//   const e = await createStormScopeEngine({ packUrl: <config.js's 'stormscope-mrms' pack> });
//   await e.download({ onProgress }); await e.load();
//   const r = await e.forecast(prep, { onStep(k, frame) }) -> { steps: 9, ms: [per step], evalMs: [[...7] per step] }
'use strict';
import { createGpu } from '../../engine/core/gpu.js';
import { WeightStore } from '../../engine/core/store.js';
import { StormScope, windowUpdate } from './ss.js';
import { tunedPicks } from '../tune/tune.js';   // SPEED TUNE

export const STORMSCOPE_VERSION = 'stormscope pilot 0.1';
const RUNNING = 'wallowa-weather:ss:running';
const err = (code, message) => Object.assign(new Error(message), { code });
const LS = (k, v) => { try { if (v === undefined) return localStorage.getItem(k); if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch (e) { return null; } return null; };

export async function createStormScopeEngine(opts = {}) { const e = new StormScopeEngine(opts); await e._init(); return e; }

class StormScopeEngine {
  constructor(opts) {
    this.opts = Object.assign({ packUrl: './pack/', powerPreference: 'high-performance' }, opts);
    if (!this.opts.packUrl.endsWith('/')) this.opts.packUrl += '/';
    this.state = 'idle'; this.gpu = null; this.model = null; this.man = null; this.listeners = new Map();
  }
  on(n, fn) { if (!this.listeners.has(n)) this.listeners.set(n, []); this.listeners.get(n).push(fn); }
  emit(n, d) { for (const f of this.listeners.get(n) || []) { try { f(d); } catch (e) { console.error(e); } } }
  async _init() {
    const c = { supported: false, reason: '', gpu: '' };
    try {
      if (!globalThis.navigator || !navigator.gpu) c.reason = 'needs a browser with WebGPU (Safari on iOS 26 or later, or Chrome on Android 12 or later)';
      else {
        const ad = await navigator.gpu.requestAdapter({ powerPreference: this.opts.powerPreference });
        if (!ad) c.reason = 'no WebGPU adapter';
        else {
          const i = ad.info || {}; c.gpu = [i.vendor, i.architecture, i.description].filter(Boolean).join(' ');
          c.maxBindMB = Math.round(ad.limits.maxStorageBufferBindingSize / 1048576); c.storageBuffers = ad.limits.maxStorageBuffersPerShaderStage;
          c.supported = c.storageBuffers >= 7 && c.maxBindMB >= 96;
          if (!c.supported) c.reason = 'this graphics chip\'s limits are too small for StormScope';
        }
      }
    } catch (e) { c.reason = String((e && e.message) || e); }
    this.caps = c;
    this.store = new WeightStore(null, { base: this.opts.packUrl, dir: 'nowcast/stormscope' });
    if (LS(RUNNING)) { LS(RUNNING, null); setTimeout(() => this.emit('warning', { code: 'KILLED_LAST_RUN', message: 'StormScope stopped last time (the phone ran out of memory or got hot).' }), 0); }
  }
  capabilities() { return Object.assign({}, this.caps); }
  /** the same gesture as the other engines' (every engine answers this) */
  requestPersistentStorage() { try { return navigator.storage.persist(); } catch (e) { return Promise.resolve(false); } }
  async _open() { if (!this.store.m) await this.store.open(); return this.store; }
  async status() { const s = await this._open(), st = s.status(); return { complete: st.complete, haveBytes: st.have, totalBytes: st.total, packVersion: s.m.pack_version }; }
  async download({ onProgress, signal } = {}) {
    if (this.state === 'downloading') throw err('BUSY', 'Already downloading.');
    this.state = 'downloading';
    try {
      const s = await this._open(); let last = 0;
      await s.download({ signal, onProgress: (p) => {
        const now = performance.now(); if (now - last < 250 && p.have < p.total) return; last = now;
        if (onProgress) onProgress({ haveBytes: p.have, totalBytes: p.total, bytesPerSec: p.bytesPerSec, etaSeconds: p.bytesPerSec > 0 ? Math.round((p.total - p.have) / p.bytesPerSec) : null, part: p.part });
      } });
      return await this.status();
    } catch (e) { if (e && e.name === 'AbortError') throw Object.assign(new Error('cancelled'), { name: 'AbortError', code: 'ABORTED' }); throw e; } finally { this.state = 'idle'; }
  }
  async deleteModel() {
    if (this.state === 'running') throw err('BUSY', 'A forecast is running.');
    this.unload(); const s = await this._open();
    await s.st.start(); await s.st.call('remove', { name: 'nowcast/stormscope' });
    s.state = { pack_version: s.m.pack_version, done: {} };
  }
  /** bytes [at, at + len) of a shard file, from storage */
  async _slice(shardName, at, len) {
    const s = this.store, sh = s.shards.get(shardName);
    const r = await s.st.call('read', { name: `nowcast/stormscope/${sh.file}`, at, len });
    return r.buf.byteLength === len ? r.buf : r.buf.slice(0, len);
  }
  /** the static grid pack (terrain, radar proximity, coverage, normalisation, RoPE: shards ss.grid + ss.grid.json), parsed once by
   *  prep's loadGrid and kept for the page's life (a few MB) */
  async grid(loadGrid) {
    if (this._grid) return this._grid;
    const s = await this._open(); if (!s.status().complete) throw err('NOT_DOWNLOADED', 'Download StormScope first.');
    await s.st.start();
    const bin = await s.readFile('ss.grid'), js = JSON.parse(new TextDecoder().decode(await s.readFile('ss.grid.json')));
    return (this._grid = await loadGrid(bin, js));
  }
  get loaded() { return !!this.model; }
  /** the GPU and the model for a tile of H x W pixels (200 or 204 a side: Earth2Studio's 4-px alignment). inp = the run's tables the
   *  model keeps (rope_cos, rope_sin: Float32Array [T][128], T = H/4 x W/4) */
  async load(inp, o = {}) {
    if (!this.caps.supported) throw err('UNSUPPORTED', this.caps.reason || 'This device cannot run StormScope.');
    const s = await this._open();
    if (!s.status().complete) throw err('NOT_DOWNLOADED', 'Download StormScope first.');
    const H = o.H || 204, W = o.W || 204;
    if (this.model && this.model.H === H && this.model.W === W && !(this.gpu && this.gpu.lost)) return this.loadInfo;   // a lost device loads afresh
    this.unload();
    const t0 = performance.now();
    LS(RUNNING, JSON.stringify({ phase: 'load', t: Date.now() }));
    try {
      await s.st.start();
      this.man = JSON.parse(new TextDecoder().decode(await s.readFile('ss.model')));
      if (this.man.c_cond !== 72 || this.man.patch !== 4) throw err('UNSUPPORTED', 'this pack is not the StormScope pilot model');
      if (!this.gpu || this.gpu.lost) this.gpu = o.gpu || await createGpu({ powerPreference: this.opts.powerPreference, needF16: false, onLost: () => this.emit('lost', {}) });
      const tiles = await tunedPicks('stormscope', { powerPreference: this.opts.powerPreference });   // SPEED TUNE: this phone's tuned GEMMs (null: the standard ones)
      this.gpu.device.pushErrorScope('out-of-memory');
      const m = new StormScope(this.gpu, Object.assign({}, this.man, { H, W, T: (H / 4) * (W / 4) }), inp, { f16Rounding: this.opts.f16Rounding, tiles });
      await m.load((name) => { const t = this.man.tensors[name]; return this._slice('ss.weights', t.offset, t.bytes); }, (f) => this.emit('loading', { frac: f }));
      const oom = await this.gpu.device.popErrorScope();
      if (oom) { m.free(); throw err('OUT_OF_MEMORY', 'the graphics chip ran out of memory loading StormScope'); }
      this.model = m;
      // v013: the f16 rounding chosen for this graphics device ('native' | 'rne16' | 'f32'), told once per device (the app's diagnostics)
      if (this._f16Dev !== this.gpu.device) { this._f16Dev = this.gpu.device; this.emit('f16', { mode: m.f16Mode, gpu: this.caps.gpu }); }
    } catch (e) { this.unload(); throw e; } finally { LS(RUNNING, null); }
    this.loadInfo = { seconds: (performance.now() - t0) / 1000, gpuMB: Math.round(this.model.bytes / 1e6), version: STORMSCOPE_VERSION, packVersion: s.m.pack_version, f16: this.model.f16Mode,
      tuned: this.model.tiles ? Object.keys(this.model.tiles).length : 0 };   // SPEED TUNE: how many GEMM kinds run a tuned tile
    return this.loadInfo;
  }
  unload() { if (this.model) { try { this.model.free(); } catch (e) { /* */ } } this.model = null; return true; }
  /** the 9 steps (+10 ... +90 min). prep = { cond: Float32 [72][H][W], latents: Float32 [9][3][H][W], valid: Uint8 [H][W],
   *  cz: Float32 [9][2][H][W], mean: [2], std: [2] } (nowcast/stormscope/prep.js). onStep(k, out) gets each step's normalised state
   *  [3][H][W] the moment it exists (the screen draws it while the next one runs). */
  async forecast(prep, { onStep, signal } = {}) {
    if (!this.model) throw err('NOT_LOADED', 'Load StormScope first.');
    if (this.state === 'running') throw err('BUSY', 'A forecast is already running.');
    this.state = 'running'; LS(RUNNING, JSON.stringify({ phase: 'run', t: Date.now() }));
    const H = this.model.H, W = this.model.W, HW = H * W, ms = [], evalMs = [];
    try {
      let cond = prep.cond;
      for (let k = 0; k < 9; k++) {
        if (signal && signal.aborted) throw Object.assign(new Error('cancelled'), { name: 'AbortError' });
        const r = await this.model.step(cond, prep.latents.subarray(k * 3 * HW, (k + 1) * 3 * HW));
        ms.push(r.stepMs); evalMs.push(r.evalMs);
        if (onStep) onStep(k, r.out, r.stepMs);
        if (k < 8) cond = windowUpdate(cond, r.out, prep.valid, prep.cz.subarray((k + 1) * 2 * HW, (k + 1) * 2 * HW + HW), prep.cz.subarray((k + 1) * 2 * HW + HW, (k + 2) * 2 * HW), prep.mean, prep.std, HW);
      }
      return { steps: 9, ms, evalMs };
    } finally { this.state = 'idle'; LS(RUNNING, null); }
  }
}
