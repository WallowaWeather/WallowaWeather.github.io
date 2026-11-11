// nowcast/engine.js - the Nowcast's engine: the model packs (downloaded once, kept in this site's private storage, every chunk's
// sha256 checked against a manifest config.js pins), the GPU, and runs of the model. The same conventions as StormScope's and BEAM's:
// status / download / deleteModel / load / unload; one job at a time (the app's queue runs it); load() makes everything, unload()
// gives every GPU buffer back. Two packs: the floating-point model (the default, most accurate: <pack>f16/) and the 8-bit integer
// model (less memory: <pack>), used by itself when this device cannot fit the float one.
//   const e = await createNowcastEngine({ packUrl: <config.js's 'dgmr-nowcast' pack> });
//   await e.download({ onProgress }); await e.load();
//   const r = await e.nowcast(inputs, { members: 4, onMember }) -> { frames: [Float32Array [18][256][256] mm/h], precision, ms }
'use strict';
import { createGpu } from '../engine/core/gpu.js';
import { WeightStore } from '../engine/core/store.js';
import { Dgmr, activationPlan } from './dgmr/dgmr.js';
import { DGMR } from './model.js';
import { tunedPicks } from './tune/tune.js';   // SPEED TUNE

export const NOWCAST_VERSION = 'nowcast 1.0';
const VAR = { float: { sub: 'f16/', dir: 'nowcast/dgmr_f16', name: 'f16', arch: 'dgmr-f16' }, int8: { sub: '', dir: 'nowcast/dgmr_int8', name: 'int8', arch: 'dgmr-int8' } };
const RUNNING = 'wallowa-weather:dgmr:running';
const err = (code, message) => Object.assign(new Error(message), { code });
const LS = (k, v) => { try { if (v === undefined) return localStorage.getItem(k); if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch (e) { return null; } return null; };
const isOOM = (e) => /out of memory|OutOfMemory|allocation/i.test(String(e && (e.message || e)));

export async function createNowcastEngine(opts = {}) { const e = new NowcastEngine(opts); await e._init(); return e; }

class NowcastEngine {
  constructor(opts) {
    this.opts = Object.assign({ packUrl: './pack/', precision: 'auto', powerPreference: 'high-performance' }, opts);
    if (!this.opts.packUrl.endsWith('/')) this.opts.packUrl += '/';
    this.spec = DGMR; this.state = 'idle'; this.gpu = null; this.model = null; this.listeners = new Map(); this.stores = {};
  }
  on(n, fn) { if (!this.listeners.has(n)) this.listeners.set(n, []); this.listeners.get(n).push(fn); }
  off(n, fn) { this.listeners.set(n, (this.listeners.get(n) || []).filter((f) => f !== fn)); }
  emit(n, d) { for (const f of this.listeners.get(n) || []) { try { f(d); } catch (e) { console.error(e); } } }
  async _init() {
    const c = { supported: false, reason: '', gpu: '', maxBufferMB: 0, maxBindMB: 0 };
    try {
      if (!globalThis.navigator || !navigator.gpu) c.reason = 'needs a browser with WebGPU (Safari on iOS 26 or later, or Chrome on Android 12 or later)';
      else {
        const ad = await navigator.gpu.requestAdapter({ powerPreference: this.opts.powerPreference });
        if (!ad) c.reason = 'no WebGPU adapter';
        else {
          const i = ad.info || {}; c.gpu = [i.vendor, i.architecture, i.description].filter(Boolean).join(' ');
          c.maxBufferMB = Math.round(ad.limits.maxBufferSize / 1048576); c.maxBindMB = Math.round(ad.limits.maxStorageBufferBindingSize / 1048576);
          c.storageBuffers = ad.limits.maxStorageBuffersPerShaderStage;
          c.supported = c.storageBuffers >= 5 && c.maxBindMB >= 72;
          if (!c.supported) c.reason = 'this graphics chip\'s limits are too small for the nowcast';
        }
      }
    } catch (e) { c.reason = String((e && e.message) || e); }
    this.caps = c;
    for (const [k, v] of Object.entries(VAR)) this.stores[k] = new WeightStore(null, { base: this.opts.packUrl + v.sub, dir: v.dir });
    if (LS(RUNNING)) { LS(RUNNING, null); setTimeout(() => this.emit('warning', { code: 'KILLED_LAST_RUN', message: 'The nowcast stopped last time (the phone ran out of memory or got hot).' }), 0); }
  }
  capabilities() { return Object.assign({}, this.caps); }
  /** the model this device should download and use: the float one unless its largest buffer cannot be bound here (or the person or a
   *  memory failure chose the small one; the localStorage key keeps its older name, so a choice already made on this site stays) */
  precision() {
    const want = this.opts.precision !== 'auto' ? this.opts.precision : LS('wallowa-weather:nowcast:precision');
    if (want === 'float' || want === 'int8') return want;
    return this.caps.maxBindMB >= 130 ? 'float' : 'int8';   // the float weights bind as one 123 MB buffer, its largest activation 113 MB
  }
  async _open(p) { const s = this.stores[p]; if (!s.m) await s.open(); return s; }
  /** -> { complete, haveBytes, totalBytes, packVersion, precision, other: { precision, complete } } */
  async status(p = this.precision()) {
    const s = await this._open(p), st = s.status(), o = p === 'float' ? 'int8' : 'float';
    let other = null; try { const so = await this._open(o); other = { precision: o, complete: so.status().complete, totalBytes: so.status().total }; } catch (e) { other = null; }
    return { complete: st.complete, haveBytes: st.have, totalBytes: st.total, packVersion: s.m.pack_version, precision: p, other };
  }
  async download({ onProgress, signal, precision = this.precision() } = {}) {
    if (this.state === 'downloading') throw err('BUSY', 'Already downloading.');
    this.state = 'downloading';
    try {
      const s = await this._open(precision); let last = 0;
      await s.download({ signal, onProgress: (p) => {
        const now = performance.now(); if (now - last < 250 && p.have < p.total) return; last = now;
        if (onProgress) onProgress({ haveBytes: p.have, totalBytes: p.total, bytesPerSec: p.bytesPerSec, etaSeconds: p.bytesPerSec > 0 ? Math.round((p.total - p.have) / p.bytesPerSec) : null, part: p.shard });
      } });
      return await this.status(precision);
    } catch (e) { if (e && e.name === 'AbortError') throw Object.assign(new Error('cancelled'), { name: 'AbortError', code: 'ABORTED' }); throw e; } finally { this.state = 'idle'; }
  }
  async deleteModel() {
    if (this.state === 'running') throw err('BUSY', 'A nowcast is running.');
    this.unload();
    for (const [k, s] of Object.entries(this.stores)) { try { await this._open(k); await s.st.start(); await s.st.call('remove', { name: VAR[k].dir }); s.state = { pack_version: s.m.pack_version, done: {} }; } catch (e) { /* not there */ } }
  }
  get loaded() { return !!this.model; }
  get loadedPrecision() { return this.model ? this.model.p : null; }
  /** SPEED TUNE: a downloaded model's own file (its op list: the tune times its convolutions at their real sizes) -> JSON | null */
  async modelSpec(p = this.precision()) {
    const s = await this._open(p); if (!s.status().complete) return null;
    await s.st.start(); return JSON.parse(new TextDecoder().decode(await s.readFile(`${VAR[p].name}.model`)));
  }
  /** the GPU and the model (o.precision, else this device's): the weights stream from storage straight to the GPU, the small files are read */
  async load(o = {}) {
    if (!this.caps.supported) throw err('UNSUPPORTED', this.caps.reason || 'This device cannot run the nowcast.');
    let p = o.precision || this.precision();
    const s0 = await this._open(p);
    if (!s0.status().complete) {   // the other model is here: use it rather than asking for a download
      const q = p === 'float' ? 'int8' : 'float', s1 = await this._open(q);
      if (s1.status().complete) p = q; else throw err('NOT_DOWNLOADED', 'Download the nowcast model first.');
    }
    if (this.model && this.model.p === p && !(this.gpu && this.gpu.lost)) return this.loadInfo;   // a lost device (Android: the app in the background) loads afresh
    this.unload();
    const t0 = performance.now(), s = this.stores[p], v = VAR[p];
    if ((s.m.model && s.m.model.arch) !== v.arch) throw err('UNSUPPORTED', 'this pack is not the nowcast model');
    LS(RUNNING, JSON.stringify({ phase: 'load', p, t: Date.now() }));
    try {
      if (!this.gpu || this.gpu.lost) { this.gpu = o.gpu || await createGpu({ powerPreference: this.opts.powerPreference, needF16: false, onLost: () => this.emit('gpu-lost', {}) }); }
      s.gpu = this.gpu;
      await s.st.start();
      const m = JSON.parse(new TextDecoder().decode(await s.readFile(`${v.name}.model`)));
      const host = await s.readFile(`${v.name}.tables`);
      const plan = activationPlan(m, p);
      if (plan.largest > this.gpu.limits.maxStorageBufferBindingSize) throw err('OUT_OF_MEMORY', 'a nowcast buffer is larger than this graphics chip binds');
      const tiles = p === 'float' ? await tunedPicks('dgmr', { powerPreference: this.opts.powerPreference }) : null;   // SPEED TUNE: this phone's tuned convs (null: standard)
      this.gpu.device.pushErrorScope('out-of-memory');
      const wh = await s.upload(`${v.name}.weights`);
      const model = new Dgmr(this.gpu, m, p, { share: o.share !== false, tiles });
      await model.load({ weights: wh.buf, host });
      const oom = await this.gpu.device.popErrorScope();
      if (oom) { model.free(); this.gpu.free(wh.buf); throw err('OUT_OF_MEMORY', 'the graphics chip ran out of memory loading the nowcast'); }
      this.model = model; this.wh = wh;
    } catch (e) {
      this.unload();
      if (e && !e.code && isOOM(e)) e.code = 'OUT_OF_MEMORY';
      throw e;
    } finally { LS(RUNNING, null); }
    this.loadInfo = { precision: p, seconds: (performance.now() - t0) / 1000, gpuMB: Math.round(this.gpu.alive / 1e6), gmac: +(this.model.totalMacs / 1e9).toFixed(1), version: NOWCAST_VERSION, packVersion: s.m.pack_version };
    return this.loadInfo;
  }
  /** every GPU buffer goes back; the device stays (like the other engines: destroying devices again and again ends in a GPU reset) */
  unload() {
    if (this.model) { try { this.model.free(); } catch (e) { /* */ } }
    if (this.gpu) { try { this.gpu.freeAll(); } catch (e) { /* */ } }
    this.model = null; this.wh = null; return true;
  }
  /** a nowcast: `members` runs of the model on the same inputs (members 0, 1, ... of `seed`) ->
   *  { frames: [Float32Array per member], precision, ms: [per member], seed } */
  async nowcast(inputs, { members = this.spec.ensemble.members, seed = this.spec.ensemble.seed, onMember, onFrames, keep = true, signal, hash = false } = {}) {
    if (!this.model) throw err('NOT_LOADED', 'Load the nowcast model first.');
    if (this.state === 'running') throw err('BUSY', 'A nowcast is already running.');
    this.state = 'running'; LS(RUNNING, JSON.stringify({ phase: 'run', t: Date.now() }));
    try {
      const out = [], ms = [], shas = [];
      for (let k = 0; k < members; k++) {
        if (signal && signal.aborted) throw Object.assign(new Error('cancelled'), { name: 'AbortError' });
        const r = await this.model.run(inputs, { seed, member: k, hash });
        if (onFrames) onFrames(k, r.frames);   // keep: false = each member's frames are let go once onFrames has them (a run of 4 holds one)
        if (keep) out.push(r.frames); ms.push(r.ms); if (r.outSha) shas.push(r.outSha);
        if (onMember) onMember({ member: k, of: members, ms: r.ms });
      }
      return { frames: out, precision: this.model.p, ms, seed, shas };
    } finally { this.state = 'idle'; LS(RUNNING, null); }
  }
  cancel() { /* a member runs in ~1-4 s; the signal stops between members */ }
}
