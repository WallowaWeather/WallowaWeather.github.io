// nowcast/beam_live.js - Wallowa Weather v009: BEAM live on this phone. The model's download (the pinned
// pack in config.js, kept in this site's private storage like StormScope's), one run at a time through the app's queue, and what the map
// shows of a run: BEAM's chance of hail, lightning, cloudbursts and strong cores for the next 0-30, 30-60 and 60-90 minutes, on the whole
// Inland Northwest frame BEAM runs on (304 x 304 HRRR 3 km Lambert pixels), placed on the map's lat / lon grid with lcc.js.
// The run itself is BEAM's own code (nowcast/beam/): the newest frame time whose inputs are all posted
// (t0 + 9 min), the four NOAA inputs read and decoded in a worker, the trained fallbacks and their flags, six members in 16-bit floats.
// Hail is shown through the backtest's frozen recalibration (data/beam_recal.json); the warning outlines stay at the raw frozen levels.
// Not here: the storm cones (they need each cell tracked from run to run; the example storms have them).
//   const m = beamModel({ packUrl });  await m.download({ onProgress });  const { frame, info } = await m.run({ onProgress, signal });
//   m.on('result', ({ frame, info }) => ...);  m.release();   // every GPU buffer and the input worker go
'use strict';
import { WeightStore } from '../engine/core/store.js';
import { hrrrIJ, hrrrLatLon } from './stormscope/lcc.js';
import { HEADS, warnAreas } from './beam.js';
import { tunedPicks } from './tune/tune.js';   // SPEED TUNE: BEAM's tuned conv tiles (BeamNet opts.tiles)

const MIN = 60e3;
export const BEAM_DIR = 'nowcast/beam';
/** BEAM's frame in the full HRRR grid (rows from the south) and its maps: map = 4 x bin + head (the pack's model.outputs) */
export const FRAME = { row0: 689, col0: 260, size: 304 };
export const HEAD_ORDER = ['hail', 'core', 'lightning', 'rain'];
export const BINS = [[0, 30], [30, 60], [60, 90]];
export const BIN_WORDS = ['next 30 min', '30–60 min', '60–90 min'];
/** a run for frame time t0 is shown from t0 + 10 min (its lightning input reaches that far): the bins count from there */
export const ISSUE_AFTER_MIN = 10;
/** what each warning area means on the property list ('rain' flags the drainages instead, as the example storms do) */
export const ZONE_WORDS = { hail: ['Hail possible (BEAM)', 'red'], core: ['Strong storm core possible (BEAM)', 'red'] };
/** the hazards whose live warnings count properties in the list (the damaging ones; lightning stays on the map and in the Fire
 *  weather preset, cloudbursts flag drainages) */
export const LIST_HEADS = ['hail', 'core'];
const N = FRAME.size * FRAME.size;
const err = (code, message) => Object.assign(new Error(message), { code });

// ------------------------------------------------------------------------------------------------ the map grid
/** the lat / lon grid the frame is drawn on (about 3 km, like the frame): its box holds the whole frame; idx[cell] = the frame pixel
 *  (row from the south * 304 + column) nearest the cell's centre, or -1 outside the frame. Made once. */
let GRID = null;
export function liveGrid() {
  if (GRID) return GRID;
  const S = FRAME.size, dlat = 0.025, dlon = 0.035;
  let s = 90, n = -90, w = 180, e = -180;
  for (let k = 0; k <= S; k++) for (const [i, j] of [[k, 0], [k, S], [0, k], [S, k]]) {
    const p = hrrrLatLon(FRAME.col0 - 0.5 + i, FRAME.row0 - 0.5 + j);
    s = Math.min(s, p.lat); n = Math.max(n, p.lat); w = Math.min(w, p.lon); e = Math.max(e, p.lon);
  }
  const top = Math.ceil(n / dlat) * dlat, left = Math.floor(w / dlon) * dlon;
  const rows = Math.ceil((top - s) / dlat), cols = Math.ceil((e - left) / dlon), idx = new Int32Array(rows * cols);
  for (let r = 0; r < rows; r++) {
    const lat = top - (r + 0.5) * dlat;
    for (let c = 0; c < cols; c++) {
      const q = hrrrIJ(lat, left + (c + 0.5) * dlon), fr = Math.round(q.j - FRAME.row0), fc = Math.round(q.i - FRAME.col0);
      idx[r * cols + c] = fr >= 0 && fr < S && fc >= 0 && fc < S ? fr * S + fc : -1;
    }
  }
  GRID = { top: +top.toFixed(6), left: +left.toFixed(6), dlat, dlon, rows, cols, idx };
  return GRID;
}
/** lat / lon -> the frame pixel (row from the south * 304 + column), or -1 outside */
export function framePixel(lat, lon) {
  const q = hrrrIJ(lat, lon), r = Math.round(q.j - FRAME.row0), c = Math.round(q.i - FRAME.col0);
  return r >= 0 && r < FRAME.size && c >= 0 && c < FRAME.size ? r * FRAME.size + c : -1;
}

/** the hail recalibration: raw chance -> the chance to show (100 bins of 1 %); null table = shown raw */
export function recalOf(tables, condition) {
  const t = tables && (condition === 'hidden' ? tables.hidden : tables.visible);
  return t && t.length === 100 ? (p) => t[Math.min(99, Math.max(0, Math.floor(p * 100)))] : null;
}

/**
 * a run's maps on the map grid. res: runBeam's result (mean: Float32Array 12 x 304 x 304, t0, condition, flags...); tables: beam_recal.json's.
 * -> { id, t0, issue, made, grid, condition, raw: { head: [Uint8Array x 3] } (round(255 x chance): the outlines and warning areas),
 *      show: { head: [Uint8Array x 3] } (what is coloured: hail recalibrated, the others = raw), recal (bool), max: { head: chance }, info }
 */
export function liveFrame(res, tables = null, info = null) {
  const g = liveGrid(), cells = g.rows * g.cols, mean = res.mean;
  if (!mean || mean.length !== 12 * N) throw new Error('BEAM: no maps in this run');
  const hailMap = recalOf(tables, res.condition), raw = {}, show = {}, max = {};
  HEAD_ORDER.forEach((h, hi) => {
    raw[h] = []; show[h] = []; let mx = 0;
    for (let b = 0; b < 3; b++) {
      const m = mean.subarray((4 * b + hi) * N, (4 * b + hi + 1) * N), a = new Uint8Array(cells), sh = h === 'hail' && hailMap ? new Uint8Array(cells) : a;
      for (let k = 0; k < cells; k++) {
        const p = g.idx[k]; if (p < 0) continue;
        const v = m[p]; a[k] = Math.round(255 * Math.min(1, Math.max(0, v)));
        if (sh !== a) sh[k] = Math.round(255 * hailMap(v));
      }
      for (let p = 0; p < N; p++) if (m[p] > mx) mx = m[p];
      raw[h].push(a); show[h].push(sh);
    }
    max[h] = h === 'hail' && hailMap ? hailMap(mx) : mx;
  });
  const t0 = +res.t0;
  return { id: res.id || 'beam-' + t0, t0, issue: t0 + ISSUE_AFTER_MIN * MIN, made: res.made || Date.now(), grid: g, condition: res.condition || 'visible',
    raw, show, recal: !!hailMap, max, info: info || null };
}

/** the chances at a place: { head: { bins: [shown chance x 3] (0-1), warned: [bool x 3] } } | null outside the frame */
export function chanceAt(frame, lat, lon) {
  const g = frame.grid, r = Math.floor((g.top - lat) / g.dlat), c = Math.floor((lon - g.left) / g.dlon);
  if (r < 0 || c < 0 || r >= g.rows || c >= g.cols || g.idx[r * g.cols + c] < 0) return null;
  const k = r * g.cols + c, out = {};
  for (const h of HEAD_ORDER) {
    const thr = Math.ceil(HEADS[h].warn * 255);
    out[h] = { bins: frame.show[h].map((a) => a[k] / 255), warned: frame.raw[h].map((a) => a[k] >= thr) };
  }
  return out;
}

/** the highest raw chance of the three half-hours, per cell (the warning areas for the next 90 minutes) */
export function unionBins(frame, head) {
  const [a, b, c] = frame.raw[head], out = new Uint8Array(a.length);
  for (let k = 0; k < a.length; k++) out[k] = Math.max(a[k], b[k], c[k]);
  return out;
}

/** the warning areas of a head (any of the three half-hours) inside `bbox` [s, w, n, e], for the property list:
 *  [{ id, label, color, level, rings, until, source: 'beam' }] (at most `max`, the biggest first) */
export function liveZones(frame, head, bbox, { max = 8 } = {}) {
  const words = ZONE_WORDS[head]; if (!frame || !words) return [];
  const [s, w, n, e] = bbox || [-90, -180, 90, 180];
  const areas = warnAreas(unionBins(frame, head), frame.grid, HEADS[head].warn).filter((a) => {
    let lo0 = 180, lo1 = -180, la0 = 90, la1 = -90; for (const [lo, la] of a.ring) { lo0 = Math.min(lo0, lo); lo1 = Math.max(lo1, lo); la0 = Math.min(la0, la); la1 = Math.max(la1, la); }
    return lo1 >= w && lo0 <= e && la1 >= s && la0 <= n;
  });
  return areas.slice(0, max).map((a, i) => ({ id: `beam-live-${head}-${frame.t0}-${i}`, label: words[0], color: HEADS[head].edge, level: words[1], rings: [a.ring],
    until: frame.issue + 90 * MIN, source: 'beam' }));
}

/** the run's flags in plain words, for the card: [{ kind, text }] (degraded / radar hidden / waiting for lightning, with a retry time) */
export function flagWords(info, { clock = (t) => new Date(t).toISOString().slice(11, 16) } = {}) {
  if (!info) return [];
  const out = [], flags = info.flags || [];
  const glmWait = (info.missing || []).find((m) => m.src === 'glm' && m.kind === 'pending');
  if (info.pending) {
    const at = info.retryAt ? clock(Date.parse(info.retryAt)) : null;
    out.push({ kind: 'pending', text: glmWait ? `Waiting for the newest lightning data (NOAA GOES-West)${at ? `: trying again at ${at}` : ''}.`
      : `Waiting for NOAA to post the newest inputs${at ? `: trying again at ${at}` : ''}.` });
  }
  if (info.degraded) out.push({ kind: 'degraded', text: 'Degraded run: BEAM used a fallback it was trained with, so this forecast is less sure.' });
  for (const f of flags) if (f.kind !== 'pending') out.push({ kind: f.kind, text: f.text });
  return out;
}

/** the small summary of a run kept for the card and Diagnostics (no maps) */
export function runInfo(res) {
  return { id: res.id, t0: res.t0, made: res.made, ok: !!res.ok, degraded: !!res.degraded, pending: !!res.pending, retryAt: res.retryAt || null,
    condition: res.condition || 'visible', flags: (res.flags || []).map((f) => ({ kind: f.kind, text: f.text })),
    missing: (res.missing || []).filter((m) => m.kind !== 'info').slice(0, 12).map((m) => ({ src: m.src, what: m.what, kind: m.kind, why: String(m.why || '').slice(0, 140), retryAt: m.retryAt || null })),
    bytes: res.bytes || 0, requests: res.requests || 0, ms: res.ms ? { total: res.ms.total, inputs: res.ms.inputs, wait: res.ms.wait, model: res.ms.model } : null,
    cache: res.cache ? { mode: res.cache.mode, persistent: res.cache.persistent, fallback: res.cache.fallback } : null, replay: !!res.replay };
}

// ------------------------------------------------------------------------------------------------ the model on this phone
const SRC_WORDS = { radar: 'the radar (NOAA MRMS)', glm: 'lightning (NOAA GOES-West)', abi: 'the satellite (NOAA GOES-West)', hrrr: 'NOAA’s HRRR model' };

class BeamModel {
  constructor(opts) {
    this.opts = Object.assign({ packUrl: './pack/', powerPreference: 'high-performance', workers: 1 }, opts);
    if (!this.opts.packUrl.endsWith('/')) this.opts.packUrl += '/';
    this.store = new WeightStore(null, { base: this.opts.packUrl, dir: BEAM_DIR });
    this.engine = null; this.pool = null; this.busy = false; this.last = null; this.lastInfo = null; this.fns = new Map(); this.tables = undefined;
    this.state = 'idle';
  }
  on(n, f) { (this.fns.get(n) || this.fns.set(n, new Set()).get(n)).add(f); return () => this.fns.get(n).delete(f); }
  emit(n, d) { for (const f of this.fns.get(n) || []) { try { f(d); } catch (e) { console.error(e); } } }
  /** WebGPU at all (BEAM's engine has a 32-bit path for chips without 16-bit shaders) */
  supported() { return !!(globalThis.navigator && navigator.gpu); }
  async _open() { if (!this.store.m) await this.store.open(); return this.store; }
  async status() { const s = await this._open(), st = s.status(); return { complete: st.complete, haveBytes: st.have, totalBytes: st.total, packVersion: s.m.pack_version }; }
  async download({ onProgress, signal } = {}) {
    if (this.state === 'downloading') throw err('BUSY', 'Already downloading.');
    this.state = 'downloading';
    try {
      const s = await this._open(); let last = 0;
      await s.download({ signal, onProgress: (p) => {
        const now = performance.now(); if (now - last < 250 && p.have < p.total) return; last = now;
        if (onProgress) onProgress({ haveBytes: p.have, totalBytes: p.total, bytesPerSec: p.bytesPerSec });
      } });
      return await this.status();
    } catch (e) { if (e && e.name === 'AbortError') throw Object.assign(new Error('cancelled'), { name: 'AbortError', code: 'ABORTED' }); throw e; } finally { this.state = 'idle'; }
  }
  async deleteModel() {
    if (this.busy) throw err('BUSY', 'BEAM is running.');
    this.release(); const s = await this._open();
    await s.st.start(); await s.st.call('remove', { name: BEAM_DIR });
    s.state = { pack_version: s.m.pack_version, done: {} };
    this.last = null; this.lastInfo = null;
  }
  async _engine() {
    if (this.engine && this.engine.gpu && this.engine.gpu.lost) this.release();   // the graphics device was lost (Android: the app in the background): a fresh one
    if (!this.engine) {
      const { createBeamEngine } = await import('./beam/engine/engine.js'), tiles = await tunedPicks('beam', { powerPreference: this.opts.powerPreference });   // SPEED TUNE
      this.engine = await createBeamEngine({ powerPreference: this.opts.powerPreference, tiles: tiles || undefined });
    }
    return this.engine;
  }
  get loaded() { return !!(this.engine && this.engine.loaded); }
  async load() {
    const s = await this._open(); if (!s.status().complete) throw err('NOT_DOWNLOADED', 'Download BEAM first.');
    const e = await this._engine(); if (!e.loaded) await e.load(s); return e;
  }
  /** the GPU buffers go back (the device stays for the next load) */
  unload() { if (this.engine) { try { this.engine.unload(); } catch (e) { /* */ } } return true; }
  /** everything goes: the engine's device and the input worker (its cache stays in this site's storage for the next time) */
  release() {
    if (this.engine) { try { this.engine.destroy(); } catch (e) { /* */ } this.engine = null; }
    if (this.pool) { try { this.pool.close(); } catch (e) { /* */ } this.pool = null; }
    return true;
  }
  info() { return this.engine && this.engine.info ? this.engine.info() : null; }
  async newestT0(now = Date.now()) { const R = await import('./beam/runner/run_beam.js'); return +R.newestRunnableT0(now); }
  async runnableAt(t0) { const R = await import('./beam/runner/run_beam.js'); return +R.runnableAt(new Date(+t0)); }
  async _tables() {
    if (this.tables !== undefined) return this.tables;
    try { const r = await fetch(new URL('./data/beam_recal.json', import.meta.url)); this.tables = r.ok ? (await r.json()).tables || null : null; } catch (e) { this.tables = null; }
    return this.tables;
  }
  /**
   * one BEAM run -> { frame (liveFrame, or null when its inputs are not all posted yet: the last maps stay), info (runInfo) }; also emitted as 'result'.
   * o: { signal, onProgress({ phase, frac, text }), t0 (a frame time; default the newest runnable), stack (a saved 40 x 304 x 304 float16
   * input stack, [ch][row][col]: the model only, nothing is downloaded), now }
   */
  async run(o = {}) {
    if (this.busy) throw err('BUSY', 'BEAM is already running.');
    this.busy = true;
    const prog = (p) => { try { if (o.onProgress) o.onProgress(p); } catch (e) { /* the caller's */ } };
    try {
      const s = await this._open(); if (!s.status().complete) throw err('NOT_DOWNLOADED', 'Download BEAM first.');
      const engine = await this._engine(), tables = await this._tables();
      let res;
      if (o.stack) {
        prog({ phase: 'model', frac: 0.6, text: 'BEAM: working it out on this phone…' });
        if (!engine.loaded) await engine.load(s);
        const t = performance.now(), r = await engine.run(o.stack, { statics: 'stack', layout: 'chw' });
        const t0 = o.t0 != null ? +o.t0 : Date.now() - 10 * MIN, visible = o.stack[39 * N] === 0x3c00;
        res = { id: 'beam-' + t0, t0, made: Date.now(), mean: r.mean, ok: true, degraded: !visible, pending: false, retryAt: null, condition: visible ? 'visible' : 'hidden',
          flags: visible ? [] : [{ kind: 'radar-hidden', text: 'Radar unavailable: BEAM ran from satellite, lightning and HRRR only.' }], missing: [], bytes: 0, requests: 0,
          ms: { total: Math.round(performance.now() - t), inputs: 0, wait: 0, model: Math.round(performance.now() - t) }, replay: true };
      } else {
        const R = await import('./beam/runner/run_beam.js');
        if (!this.pool) this.pool = await R.makeInputPool({ workers: this.opts.workers });
        const done = new Set();
        res = await R.runBeam({ pool: this.pool, engine, pack: s, signal: o.signal, t0: o.t0, now: o.now, onProgress: (p) => {
          if (p.phase === 'inputs') {
            if (/: (ok|incomplete)/.test(p.text || '')) done.add(p.src);
            const left = ['radar', 'glm', 'abi', 'hrrr'].filter((k) => !done.has(k)).map((k) => SRC_WORDS[k]);
            prog({ phase: 'inputs', frac: 0.05 + 0.6 * done.size / 4, text: left.length ? `Reading ${left.slice(0, 2).join(' and ')}${left.length > 2 ? '…' : ''}` : 'Putting the inputs together…' });
          } else if (p.phase === 'retry') prog({ phase: 'inputs', frac: 0.66, text: 'Reading a file again…' });
          else if (p.phase === 'wait') prog({ phase: 'wait', frac: 0.7, text: `Waiting for the newest lightning file (${String(p.text || '').replace(/^.*waiting /, '').replace(/ for.*$/, '')})…` });
          else if (p.phase === 'model') prog({ phase: 'model', frac: 0.82, text: 'BEAM: working it out on this phone…' });
        } });
      }
      const info = runInfo(res);
      const frame = res.mean ? liveFrame(res, tables, info) : null;
      if (frame) this.last = frame;
      this.lastInfo = info;
      prog({ phase: 'done', frac: 1, text: 'BEAM: done' });
      const out = { frame, info };
      this.emit('result', out);
      return out;
    } finally { this.busy = false; }
  }
}

let ONE = null;
/** the one BEAM on this page (the queue, Settings and the map share it) */
export function beamModel(opts) { return ONE || (ONE = new BeamModel(opts || {})); }
