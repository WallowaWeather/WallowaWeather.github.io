// Part of BEAM's phone code (kept identical to BEAM's own build).
// Wallowa Weather engine: BEAM forward pass (a specialised fork of the author's own WebGPU engine)
// engine.js - the small API a runner calls.
//   const e = await createBeamEngine({ gpu, powerPreference, f16, acc, tiles, weights });
//   await e.load(src, { onProgress });  // src: the pack's address (a folder with manifest.json; every 16 MiB chunk's sha256 is checked)
//                                      //      | a store with readFile(shardName) (the app's WeightStore: already verified on download)
//                                      //      | { model, weights, static } (ArrayBuffers; model may be the parsed JSON)
//   const r = await e.run(stack, { members: false, statics: 'pack' });
//     stack: Uint16Array f16 bits [40][304][304] (CHW, as the Python stack; layout: 'hwc' for [304*304][40]),
//            Float32Array [40 or 31][304][304] (model values, rounded here to the nearest f16 as numpy does),
//            or { [channel]: Float32Array(304*304) } (the input builders' ch, channels 0-30)
//     statics 'pack' (default): channels 31-38 from the pack, 39 = 1 (radar visible); 'stack': the stack's own 31-39 (the
//            radar-hidden conditions change the coverage channels and channel 39)
//     -> { mean, odd, even: Float32Array [12][304*304] (6-member mean, each fold's 3-member mean),
//          members?: [6 x Float32Array] (members: true; runs each member alone), ms: {members: [..], compute, read, total} }
//   e.info(); e.staticChannels(); e.unload(); e.destroy();
'use strict';
import { createBeamGpu, h16 } from './gpu.js';
import { BeamNet, HW0, NMAP } from './beam.js';
import { buildInput, fromCHW16, NCH } from './input.js';
import { sha256hex } from './sha256.js';

export const BEAM_ENGINE_VERSION = 'beam-engine 1';
const SHARDS = ['beam.model', 'beam.weights', 'beam.static'];

export async function createBeamEngine(opts = {}) { return new BeamEngine(opts); }

/** read + check a BEAM pack over HTTP: manifest.json (optionally against a pinned sha256), then each shard, every 16 MiB chunk's sha256
 *  -> { model, weights, static: ArrayBuffer, packVersion } */
export async function readBeamPack(url, { onProgress, manifestSha256 } = {}) {
  const base = String(url).replace(/\/?$/, '/');
  const mr = await fetch(base + 'manifest.json', { cache: 'no-cache' });
  if (!mr.ok) throw new Error('BEAM pack: manifest.json HTTP ' + mr.status);
  const mab = await mr.arrayBuffer();
  if (manifestSha256 && (await sha256hex(new Uint8Array(mab))) !== manifestSha256) throw new Error('BEAM pack: the manifest does not match the pinned sha256');
  const man = JSON.parse(new TextDecoder().decode(mab));
  if (man.format !== 'pocketflux.pack' || man.format_version !== 1) throw new Error('BEAM pack: unsupported format');
  const total = man.shards.reduce((a, s) => a + s.bytes, 0), out = {}; let have = 0;
  for (const name of SHARDS) {
    const s = man.shards.find((x) => x.name === name); if (!s) throw new Error('BEAM pack: no shard ' + name);
    const r = await fetch(base + s.file, { cache: 'no-cache' }); if (!r.ok) throw new Error(`BEAM pack: ${s.file} HTTP ${r.status}`);
    const buf = new Uint8Array(await r.arrayBuffer());
    if (buf.byteLength !== s.bytes) throw new Error(`BEAM pack: ${s.file} is ${buf.byteLength} bytes, the manifest says ${s.bytes}`);
    for (let c = 0; c < s.chunk_sha256.length; c++) {
      const part = buf.subarray(c * s.chunk_bytes, Math.min(s.bytes, (c + 1) * s.chunk_bytes));
      if ((await sha256hex(part)) !== s.chunk_sha256[c]) throw new Error(`BEAM pack: ${s.file} chunk ${c} fails its sha256`);
      have += part.byteLength; if (onProgress) onProgress({ have, total, shard: name });
    }
    out[name] = buf.buffer;
  }
  return { model: out['beam.model'], weights: out['beam.weights'], static: out['beam.static'], packVersion: man.pack_version };
}

class BeamEngine {
  constructor(opts) { this.opts = Object.assign({ powerPreference: 'high-performance', f16: 'auto' }, opts); this.gpu = opts.gpu || null; this.net = null; }

  async _gpu() {
    if (!this.gpu || this.gpu.lost) { this.gpu = await createBeamGpu({ powerPreference: this.opts.powerPreference, f16: this.opts.f16, adapter: this.opts.adapter }); this._own = true; }
    return this.gpu;
  }

  /** -> { model, weights, static } ArrayBuffers from any source */
  async _read(src, onProgress) {
    if (src && typeof src.readFile === 'function') {
      const out = {}; let have = 0;
      for (const s of SHARDS) { out[s] = await src.readFile(s); have += out[s].byteLength; if (onProgress) onProgress({ have, total: null, shard: s }); }
      return { model: out['beam.model'], weights: out['beam.weights'], static: out['beam.static'] };
    }
    if (src && typeof src === 'object' && !(src instanceof URL)) return src;
    const r = await readBeamPack(src, { onProgress, manifestSha256: this.opts.manifestSha256 });
    this.packVersion = r.packVersion;
    return r;
  }

  async load(src, o = {}) {
    const t0 = performance.now();
    const p = await this._read(src, o.onProgress);
    const model = p.model instanceof ArrayBuffer ? JSON.parse(new TextDecoder().decode(p.model)) : p.model;
    const g = await this._gpu();
    if (this.net) this.net.free();
    this.net = new BeamNet(g, model, { acc: this.opts.acc, tiles: this.opts.tiles, weights: this.opts.weights });
    this.loadInfo = await this.net.load(p.weights);
    this.stat = new Uint16Array(p.static instanceof ArrayBuffer ? p.static : p.static.buffer.slice(p.static.byteOffset, p.static.byteOffset + p.static.byteLength));
    if (this.stat.length !== 8 * HW0) throw new Error('BEAM pack: the static channels are not 8 x 304 x 304');
    this._x = new Uint16Array(HW0 * NCH);
    this.loadInfo.seconds = +((performance.now() - t0) / 1000).toFixed(2);
    return this.loadInfo;
  }
  get loaded() { return !!(this.net && this.net.loaded); }
  /** the pack's channels 31-38, f16 bits [8][304*304] */
  staticChannels() { return this.stat; }

  _input(stack, o) {
    const x = this._x, pack = (o.statics || 'pack') === 'pack';
    if (stack instanceof Uint16Array) {
      if (stack.length !== HW0 * NCH) throw new Error('run: a Uint16Array stack must be 40 x 304 x 304 halves');
      if (o.layout === 'hwc') x.set(stack); else fromCHW16(stack, x);
    } else if (stack instanceof Float32Array) {
      const C = stack.length / HW0;
      if (C !== 40 && C !== 31) throw new Error('run: a Float32Array stack must be 40 (or 31) x 304 x 304');
      if (!pack && C !== 40) throw new Error("run: statics 'stack' needs all 40 channels");
      buildInput(stack, this.stat, x);
      if (!pack) { const u = new Uint32Array(stack.buffer, stack.byteOffset, stack.length); for (let c = 31; c < 40; c++) for (let p = 0; p < HW0; p++) x[p * NCH + c] = h16(u[c * HW0 + p]); }
      return x;
    } else if (stack && typeof stack === 'object') {
      buildInput(stack.ch || stack, this.stat, x);
      return x;
    } else throw new Error('run: unknown stack type');
    if (pack) { for (let c = 0; c < 8; c++) for (let p = 0, s = c * HW0; p < HW0; p++) x[p * NCH + 31 + c] = this.stat[s + p]; for (let p = 0; p < HW0; p++) x[p * NCH + 39] = 0x3c00; }
    return x;
  }

  async run(stack, o = {}) {
    if (!this.loaded) throw Object.assign(new Error('Load BEAM first.'), { code: 'NOT_LOADED' });
    if (this.busy) throw Object.assign(new Error('A BEAM run is already going.'), { code: 'BUSY' });
    this.busy = true;
    try {
      const t0 = performance.now(), x = this._input(stack, o), tIn = performance.now() - t0;
      let r;
      if (o.members) {
        const n = NMAP * HW0, members = [], ms = [];
        for (let j = 0; j < this.net.nMembers; j++) { const q = await this.net.run(j === 0 ? x : null, { members: [j], timing: false }); members.push(q.mean); ms.push(q.ms.total); }
        const mean = new Float32Array(n), odd = new Float32Array(n), even = new Float32Array(n), F = this.net.fold;
        const nf = [F.filter((f) => f === 0).length, F.filter((f) => f === 1).length];
        for (let j = 0; j < members.length; j++) { const m = members[j], t = F[j] === 0 ? odd : even, sf = 1 / nf[F[j]], s6 = 1 / members.length; for (let i = 0; i < n; i++) { mean[i] += m[i] * s6; t[i] += m[i] * sf; } }
        r = { mean, odd, even, members, ms: { members: ms } };
      } else {
        const q = await this.net.run(x, { folds: true, timing: o.timing !== false });
        r = { mean: q.mean, odd: q.folds.odd, even: q.folds.even, ms: q.ms };
      }
      r.ms.input = +tIn.toFixed(1); r.ms.total = +(performance.now() - t0).toFixed(1);
      return r;
    } finally { this.busy = false; }
  }

  info() {
    const g = this.gpu;
    return { version: BEAM_ENGINE_VERSION, packVersion: this.packVersion || null, gpu: g ? g.describe() : null, f16: g ? g.f16 : null,
      gpuMB: g ? +(g.alive / 1e6).toFixed(1) : 0, load: this.loadInfo || null, acc: this.opts.acc || 'f32', errors: g ? g.errors.slice(0, 5) : [] };
  }
  /** give every GPU buffer back (the device stays for a later load) */
  unload() { if (this.net) this.net.free(); this.net = null; this._x = null; return true; }
  /** unload + end the device this engine made */
  destroy() { this.unload(); if (this._own && this.gpu) this.gpu.destroy(); this.gpu = null; }
}
