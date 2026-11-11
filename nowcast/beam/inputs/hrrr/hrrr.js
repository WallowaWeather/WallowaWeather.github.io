// Part of BEAM's phone code (kept identical to BEAM's own build).
// js/inputs/hrrr/hrrr.js - BEAM input channels 14-24, 29 and 30 from NOAA's HRRR (bucket noaa-hrrr-bdp-pds), the way the backtest
// built them (its HRRR download, then its training feed):
//   storm  14 REFC, 15 GUST, 16 MXUPHL 5000-2000 m, 17 LTNG, 29 MAXUVV 100-1000 mb, 30 HAIL: wrfsfcf03 of cycle H-2, H = t0's hour
//   env    18 CAPE 255-0 mb, 19 CIN, 20 PWAT, 21 HLCY 3000-0 m, 22 VUCSH, 23 VVCSH 0-6000 m, 24 HGT 0C isotherm: wrfsfcf02 of cycle E-2
// Each field: the .idx gives its byte range; the message is read by an HTTP Range GET and decoded only over BEAM's frame (grid rows
// 689-992 from the south, columns 260-563); for simple packing (5.0) only the frame's rows are fetched. Each value is rounded
// float64 -> float32 -> float16 (the pull stored float16), then divided by the channel scale in float32; NaN / Inf -> 0.
//
// E, the environment hour. The backtest took E = every 3rd hour from the pulled day's first hour (TE = TH[::3]); that first hour
// differs by day, so the trained fields were 0:00-2:59 old at every UTC phase. A live run has no day window: by default E is the
// newest of 00, 03, ..., 21 UTC at or before t0's hour (envStep 3; the phase of every whole-day window, which starts at 12 UTC).
// opts.envAnchor (a Date: the day window's first hour w0) reproduces the backtest exactly: E = w0 + 3 h * floor((H - w0) / 3 h);
// opts.envHour (a Date: E itself, e.g. a fixture's E_utc) overrides both; opts.envStep = 1 refreshes hourly (E = H, 0:00-0:59 old,
// inside the trained ages).
//
// Late or missing HRRR: each field falls back to the previous cycle with the same forecast hour (cycle H-3 f03 / E-3 f02, one hour
// older; never zeros while a previous cycle exists), up to opts.fallback cycles back (default 1). That is listed in `missing` and sets
// `degraded`. A field with no usable cycle is 0 (as the backtest's gaps were) and makes ok false.
//
// buildHRRR(t0, opts) -> { ch: {14..24, 29, 30: Float32Array(304 * 304)}, ok, degraded, missing, urls, bytes, ms, cycles, fields }
//   opts: { fetch, cache: { get(key), set(key, ArrayBuffer) }, signal, envHour, envAnchor, envStep = 3, fallback = 1, concurrency = 6 }
//   cache keys are the object URL, plus '#bytes=a-b' for a range read.
'use strict';
import { readHeader, frameRange, decodeFrame } from './grib2_frame.js';
import { f16 } from './f16.js';

export const HRRR_BASE = 'https://noaa-hrrr-bdp-pds.s3.amazonaws.com/';
export const FRAME = { r0: 689, c0: 260, rows: 304, cols: 304 };
export const STORM = [   // f03 of cycle H-2; `scale` divides the field (ww_feed2.sample)
  { ch: 14, v: 'REFC', lev: 'entire atmosphere', scale: 70 },
  { ch: 15, v: 'GUST', lev: 'surface', scale: 30 },
  { ch: 16, v: 'MXUPHL', lev: '5000-2000 m above ground', scale: 100 },
  { ch: 17, v: 'LTNG', lev: 'entire atmosphere', scale: 2 },
  { ch: 29, v: 'MAXUVV', lev: '100-1000 mb above ground', scale: 20 },
  { ch: 30, v: 'HAIL', lev: 'entire atmosphere', scale: 0.05 },
];
export const ENV = [   // f02 of cycle E-2. head: simple packing is expected, so read the header first and then only the frame's rows
  { ch: 18, v: 'CAPE', lev: '255-0 mb above ground', scale: 3000 },
  { ch: 19, v: 'CIN', lev: '255-0 mb above ground', scale: -200 },
  { ch: 20, v: 'PWAT', lev: 'entire atmosphere (considered as a single layer)', scale: 40 },
  { ch: 21, v: 'HLCY', lev: '3000-0 m above ground', scale: 300 },
  { ch: 22, v: 'VUCSH', lev: '0-6000 m above ground', scale: 30, head: true },
  { ch: 23, v: 'VVCSH', lev: '0-6000 m above ground', scale: 30, head: true },
  { ch: 24, v: 'HGT', lev: '0C isotherm', scale: 5000 },
];
export const CHANNELS = [...STORM, ...ENV].map((f) => f.ch).sort((a, b) => a - b);
const GRID = { nx: 1799, ny: 1059, la1: 21138123, lo1: 237280472, dx: 3000000, dy: 3000000, latin1: 38500000, lov: 262500000 };   // HRRR CONUS 3 km
const N = FRAME.rows * FRAME.cols, HOUR = 3600000, HEAD = 512;

const pad = (n) => String(n).padStart(2, '0');
const ymdh = (d) => `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}${pad(d.getUTCHours())}`;
export const fileUrl = (cycle, fhr) => `${HRRR_BASE}hrrr.${ymdh(cycle).slice(0, 8)}/conus/hrrr.t${pad(cycle.getUTCHours())}z.wrfsfcf${pad(fhr)}.grib2`;
const label = (cycle, fhr) => `${ymdh(cycle).slice(0, 8)} ${pad(cycle.getUTCHours())}z f${pad(fhr)}`;

// the time rules -> { H, E, storm: cycle Date, env: cycle Date }
export function hrrrTimes(t0, opts = {}) {
  const H = Math.floor(t0.getTime() / HOUR) * HOUR;
  let E;
  if (opts.envHour) {   // E given (a fixture's E_utc): floored to its hour
    E = Math.floor(new Date(opts.envHour).getTime() / HOUR) * HOUR;
  } else if (opts.envAnchor) {   // the backtest: TE = the day window's hours [::3]; ie = max(0, searchsorted(te, t0, 'right') - 1)
    const A = Math.floor(new Date(opts.envAnchor).getTime() / HOUR) * HOUR;
    E = A + 3 * HOUR * Math.max(0, Math.floor((H - A) / (3 * HOUR)));
  } else {
    const step = opts.envStep || 3;
    E = H - (new Date(H).getUTCHours() % step) * HOUR;
  }
  return { H: new Date(H), E: new Date(E), storm: new Date(H - 2 * HOUR), env: new Date(E - 2 * HOUR) };
}

class Ctx {
  constructor(opts) {
    this.fetch = opts.fetch || globalThis.fetch.bind(globalThis);
    this.cache = opts.cache; this.signal = opts.signal; this.raw = !!opts.raw;
    this.urls = []; this.bytes = 0; this.cached = 0; this.requests = 0;
    this.slots = opts.concurrency || 6; this.queue = [];
  }
  async slot(fn) {   // at most `concurrency` requests in flight
    if (this.slots <= 0) await new Promise((r) => this.queue.push(r)); else this.slots--;
    try { return await fn(); } finally { const n = this.queue.shift(); if (n) n(); else this.slots++; }
  }
  // GET url (bytes a..b inclusive; b = null: to the end; a = null: the whole object) -> Uint8Array | null when not posted (403 / 404)
  async get(url, a = null, b = null) {
    const key = a === null ? url : `${url}#bytes=${a}-${b === null ? '' : b}`;
    this.urls.push(key);
    if (this.cache) {   // best effort: a failing cache (quota, private mode) never fails the build
      let hit; try { hit = await this.cache.get(key); } catch (e) { hit = undefined; }
      if (hit) { this.cached += hit.byteLength; return new Uint8Array(hit); }
    }
    return this.slot(async () => {
      const headers = a === null ? {} : { Range: `bytes=${a}-${b === null ? '' : b}` };
      this.requests++;
      const r = await this.fetch(url, { headers, signal: this.signal });
      if (r.status === 403 || r.status === 404) { await r.arrayBuffer().catch(() => null); return null; }
      if (r.status !== 200 && r.status !== 206) throw new Error(`HTTP ${r.status}`);
      let u = new Uint8Array(await r.arrayBuffer());
      this.bytes += u.length;
      if (a !== null && r.status === 200) u = u.slice(a, b === null ? undefined : b + 1);   // the server ignored the range
      if (a !== null && b !== null && u.length !== b - a + 1) throw new Error(`short read: ${u.length} of ${b - a + 1} bytes`);
      if (this.cache) try { await this.cache.set(key, u.buffer.byteLength === u.length ? u.buffer : u.slice().buffer); } catch (e) { /* not cached */ }
      return u;
    });
  }
}

// the .idx of one file -> its lines, or null when the file is not posted
async function readIdx(ctx, cycle, fhr) {
  const u = await ctx.get(fileUrl(cycle, fhr) + '.idx');
  return u ? new TextDecoder().decode(u).trim().split('\n') : null;
}

function checkGrid(h) {
  for (const k in GRID) if (h[k] !== GRID[k]) throw new Error(`not the HRRR 3 km grid (${k} ${h[k]} != ${GRID[k]})`);
}

// one field of one file -> { values: Float32Array(N) as decoded (float32), info }. Throws on a bad message; returns null when the
// field is not in the .idx.
async function readField(ctx, url, lines, f) {
  const i = lines.findIndex((l) => { const p = l.split(':'); return p[3] === f.v && p[4] === f.lev; });   // the first match, as the pull
  if (i < 0) return null;
  const a = +lines[i].split(':')[1], b = i + 1 < lines.length ? +lines[i + 1].split(':')[1] - 1 : null;
  const out = new Float32Array(N), info = { range: [a, b], fetched: 0 };
  let h, msg = null;
  if (f.head && b !== null && b - a + 1 > 4 * HEAD) {
    const head = await ctx.get(url, a, a + HEAD - 1);
    if (!head) throw new Error('message not readable');
    h = readHeader(head); info.fetched += head.length;
    const rng = frameRange(h, FRAME);
    if (rng && h.total === b - a + 1 && h.s7 + h.s7len + 4 === h.total) {   // 5.0, no bitmap: only the frame's rows
      const body = await ctx.get(url, a + rng[0], a + rng[1]);
      if (!body) throw new Error('message not readable');
      info.fetched += body.length;
      checkGrid(h); decodeFrame(h, body, rng[0], FRAME, out);
      Object.assign(info, { tpl: h.tpl, nbits: h.nbits, partial: true });
      return { values: out, info };
    }
    const rest = await ctx.get(url, a + HEAD, b);   // not simple packing after all: the rest of the message
    if (!rest) throw new Error('message not readable');
    msg = new Uint8Array(b - a + 1); msg.set(head); msg.set(rest, HEAD); info.fetched += rest.length;
  } else {
    msg = await ctx.get(url, a, b);
    if (!msg) throw new Error('message not readable');
    info.fetched += msg.length;
  }
  // a whole message ('GRIB' ... '7777'), as the pull's grib_ok(): a cut-off one is never decoded
  const L = msg.length;
  if (L < 16 || msg[0] !== 0x47 || msg[1] !== 0x52 || msg[2] !== 0x49 || msg[3] !== 0x42 || msg[L - 4] !== 0x37 || msg[L - 3] !== 0x37 || msg[L - 2] !== 0x37 || msg[L - 1] !== 0x37) throw new Error('incomplete GRIB message');
  h = readHeader(msg); checkGrid(h);
  decodeFrame(h, msg, 0, FRAME, out);
  Object.assign(info, { tpl: h.tpl, nbits: h.nbits, partial: false });
  if (h.tpl === 0 && !h.nbits) info.constant = h.R;
  return { values: out, info };
}

// decoded float32 values -> the model channel, in place: float16, / scale in float32, NaN / Inf -> 0
function toChannel(v, scale) {
  const s = Math.fround(scale);
  for (let i = 0; i < v.length; i++) { const x = Math.fround(f16(v[i]) / s); v[i] = x === x && x !== Infinity && x !== -Infinity ? x : 0; }
  return v;
}

// one group (storm or env): every field from `cycle`, or field by field from the previous cycles
async function readGroup(ctx, fields, cycle, fhr, back, res) {
  let todo = fields.slice();
  for (let k = 0; k <= back && todo.length; k++) {
    const cyc = new Date(cycle.getTime() - k * HOUR), url = fileUrl(cyc, fhr), lab = label(cyc, fhr);
    let lines;
    try { lines = await readIdx(ctx, cyc, fhr); } catch (e) {
      if (e && e.name === 'AbortError') throw e;
      res.missing.push(`HRRR ${lab}: .idx not read (${e && e.message ? e.message : e})`); continue;
    }
    if (!lines) { res.missing.push(`HRRR ${lab}: not posted (.idx not found)`); continue; }
    const got = await Promise.all(todo.map(async (f) => {
      const t = performance.now();
      try {
        const r = await readField(ctx, url, lines, f);
        if (!r) { res.missing.push(`HRRR ${lab} ${f.v} ${f.lev}: not in the .idx`); return false; }
        if (ctx.raw) (res.raw || (res.raw = {}))[f.ch] = Float32Array.from(r.values, (x) => f16(x));   // tests: the field before scaling
        res.ch[f.ch] = toChannel(r.values, f.scale);
        res.fields[f.ch] = { v: f.v, file: lab, ...r.info, ms: Math.round(performance.now() - t) };
        if (k > 0) { res.degraded = true; res.missing.push(`HRRR ${f.v}: from ${lab}, the previous cycle (${k} h older): degraded`); }
        return true;
      } catch (e) {
        if (e && e.name === 'AbortError') throw e;
        res.missing.push(`HRRR ${lab} ${f.v}: ${e && e.message ? e.message : e}`);
        return false;
      }
    }));
    todo = todo.filter((_, j) => !got[j]);
  }
  for (const f of todo) { res.ch[f.ch] = new Float32Array(N); res.ok = false; res.missing.push(`HRRR ${f.v}: no usable cycle, channel ${f.ch} = 0`); }
}

export async function buildHRRR(t0, opts = {}) {
  const t = performance.now(), ctx = new Ctx(opts), tm = hrrrTimes(t0, opts), back = opts.fallback ?? 1;
  const res = { ch: {}, ok: true, degraded: false, missing: [], fields: {},
    cycles: { storm: label(tm.storm, 3), env: label(tm.env, 2), H: tm.H.toISOString(), E: tm.E.toISOString() } };
  await Promise.all([readGroup(ctx, STORM, tm.storm, 3, back, res), readGroup(ctx, ENV, tm.env, 2, back, res)]);
  const ch = {};
  for (const c of CHANNELS) ch[c] = res.ch[c];
  return { ...res, ch, urls: ctx.urls, bytes: ctx.bytes, cachedBytes: ctx.cached, requests: ctx.requests, ms: Math.round(performance.now() - t) };
}
