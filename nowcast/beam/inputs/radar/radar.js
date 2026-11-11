// Part of BEAM's phone code (kept identical to BEAM's own build).
// js/inputs/radar/radar.js - BEAM's radar inputs, channels 0-8, 12 and 13, built from NOAA MRMS files (public bucket noaa-mrms-pds)
// exactly as the backtest made them: the backtest's download put each file on the HRRR
// 3 km grid and stored it as integers; its training feed scaled the stored integers into the model. Pure ES module (fetch,
// DecompressionStream, typed arrays): runs in a page, a worker and Node 22.
//
//   ch 0-5   MergedReflectivityQCComposite_00.50 at t0-50 .. t0 (the file nearest each time, +-4 min); nearest 0.01-deg pixel;
//            stored int8: < -50 dBZ = missing (-128), else round-half-even, clipped [-30, 90]; into the model (missing -> -10 + 10) / 70
//   ch 6-8   MESH_00.50 at t0-20, -10, t0 (+-4 min); max over the 3 x 3 MRMS pixels around the nearest one; < 0 -> 0; rounded, uint8; / 50
//   ch 12    RadarOnly_QPE_15M_00.00 of the newest :00 or :30 <= t0 (+-4 min); 3 x 3 max; < 0 -> 0; mm x 10 rounded (uint16); / 250
//   ch 13    RadarQualityIndex_00.00 nearest the top of t0's hour (+-6 min); nearest pixel; x 100 rounded, clipped [0, 100]; / 100
// A missing or broken file leaves the channel as the backtest left it (refc missing, MESH / rain / quality 0) and makes ok false.
//
// Decode (2026-11-08, for phones): each PNG is inflated synchronously into one reused window, only the rows and columns the frame
// reads are unfiltered, and the inflate stops at the frame's last MRMS row (shared/grib2.js decodePngRowsSync); the integers are the
// same as before, bit for bit. One file is decoded at a time per thread (buildRadar queues them), so `concurrency` overlaps the
// downloads with the decoding and costs little memory: a file waiting for its turn holds only its gz bytes.
//
// Cache: the raw objects are cached by their URL, the same URL the app's StormScope reads the composite with (s3.js objectUrl),
// as the bytes the bucket sent (gzip; MRMS files cannot be range-read), so both can share one store. The frame's decoded integers
// are cached as well, under 'beam-radar/v1/<kind>/<url>', so a warm run decodes only the newest files.
import { readGrib2, decodePngRowsSync, gunzip, codeAt, pngHeader } from '../../shared/grib2.js';
import { makeCtx, s3List, objectUrl, ymd, hms } from '../../../stormscope/prep/s3.js';
import { hrrrLatLon } from '../../../stormscope/lcc.js';

/** BEAM's frame: rows 689-992 and columns 260-563 of the full HRRR grid (rows from the south edge), 304 x 304 */
export const FRAME = { row0: 689, col0: 260, S: 304 };
const S = FRAME.S, N = S * S, MIN = 6e4, fr = Math.fround;
export const BUCKET = 'noaa-mrms-pds';
export const RADAR_CHANNELS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 12, 13];
/** the MRMS CONUS grid the backtest's lookup was made on (a different grid throws MRMS_GRID, as the app's mrms_ss.js does) */
export const MRMS_GRID = { ni: 7000, nj: 3500, la1: 54.995, lo1: 230.005, di: 0.01, dj: 0.01 };
/** per kind: the product, the time tolerance (min), nearest pixel or 3 x 3 max, how long after its time a file is usually posted */
export const KINDS = {
  refc: { product: 'MergedReflectivityQCComposite_00.50', tol: 4, how: 'nn', latencyMin: 3 },
  mesh: { product: 'MESH_00.50', tol: 4, how: 'max', latencyMin: 3 },
  qpe15: { product: 'RadarOnly_QPE_15M_00.00', tol: 4, how: 'max', latencyMin: 7 },
  rqi: { product: 'RadarQualityIndex_00.00', tol: 6, how: 'nn', latencyMin: 3 },
};
const DERIVED_VERSION = 'beam-radar/v1';

// ------------------------------------------------------------------------------------------------ numerics as numpy does them
/** np.round / np.rint: round half to even */
export function rint(x) {
  const f = Math.floor(x), d = x - f;
  return d < 0.5 ? f : d > 0.5 ? f + 1 : (f % 2 === 0 ? f : f + 1);
}
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
/** eccodes codes_power<double>(s, n) */
function codesPower(s, n) { let d = 1.0; if (s === 0) return 1.0; if (s === 1) return n; while (s < 0) { d /= n; s++; } while (s > 0) { d *= n; s--; } return d; }
/** code -> value as eccodes unpacks PNG packing ((X * 2^E + R) * 10^-D in float64) and the pull then cast to float32 */
export function valueLut(meta) {
  const n = 1 << (meta.nbits || 0), lut = new Float32Array(Math.max(n, 1)), b = codesPower(meta.E, 2), d = codesPower(-meta.D, 10), R = meta.R;
  for (let x = 0; x < lut.length; x++) lut[x] = ((x * b) + R) * d;
  return lut;
}
/** the pull's stored integer for one float32 value (ww_pull.py pull()) */
const STORE = {
  refc: (v) => (v < -50 ? -128 : clamp(rint(v), -30, 90)),
  mesh: (v) => clamp(rint(v < 0 ? 0 : v), 0, 255),
  qpe15: (v) => clamp(rint(fr((v < 0 ? 0 : v) * 10)), 0, 65535),
  rqi: (v) => clamp(rint(fr(v * 100)), 0, 100),
};
const STORED_TYPE = { refc: Int8Array, mesh: Uint8Array, qpe15: Uint16Array, rqi: Uint8Array };
const MISSING_FILL = { refc: -128, mesh: 0, qpe15: 0, rqi: 0 };

// ------------------------------------------------------------------------------------------------ the frame's MRMS pixels
let LOOKUP = null;
/** mrms_lut(): for each frame pixel (row-major, row 0 = south) the MRMS row / column round((lat - lat0) / dlat), round((lon - lon0) / dlon).
 *  The pixel lat / lon are the HRRR grid's (lcc.js) as float32 (the pull kept G["lat"], G["lon"] as float32; lon < 0 -> lon + 360 in
 *  float32). lat0 / dlat / lon0 / dlon are the first two grid points of the MRMS file (pygrib latlons), in float64; the division is in
 *  float64 (numpy 2 promotes the float32 array with a float64 scalar). mode 'f32' = numpy 1's float32 arithmetic (kept for the test). */
export function mrmsLookup(mode = 'f64') {
  if (LOOKUP && LOOKUP.mode === mode) return LOOKUP;
  const { la1, lo1, di, dj } = MRMS_GRID;
  const lat0 = la1, dlat = (la1 - dj) - la1, lon0 = lo1, dlon = (lo1 + di) - lo1;   // scan mode 0: rows run north -> south
  const mr = new Int32Array(N), mc = new Int32Array(N), lat = new Float32Array(N), lon = new Float32Array(N);
  for (let r = 0; r < S; r++) {
    for (let c = 0; c < S; c++) {
      const k = r * S + c, q = hrrrLatLon(FRAME.col0 + c, FRAME.row0 + r);
      const la = fr(q.lat), lo = fr(q.lon), lop = lo < 0 ? fr(lo + 360) : lo;
      lat[k] = la; lon[k] = lo;
      if (mode === 'f32') {
        mr[k] = rint(fr(fr(la - fr(lat0)) / fr(dlat))); mc[k] = rint(fr(fr(lop - fr(lon0)) / fr(dlon)));
      } else {
        mr[k] = rint((la - lat0) / dlat); mc[k] = rint((lop - lon0) / dlon);
      }
    }
  }
  // pixels grouped by MRMS row (CSR), so each decoded row is visited once
  let rmin = Infinity, rmax = -Infinity, cmin = Infinity, cmax = -Infinity;
  for (let k = 0; k < N; k++) {
    if (mr[k] < rmin) rmin = mr[k]; if (mr[k] > rmax) rmax = mr[k];
    if (mc[k] < cmin) cmin = mc[k]; if (mc[k] > cmax) cmax = mc[k];
  }
  const start = new Int32Array(rmax - rmin + 2), order = new Int32Array(N);
  for (let k = 0; k < N; k++) start[mr[k] - rmin + 1]++;
  for (let i = 1; i < start.length; i++) start[i] += start[i - 1];
  const fill = start.slice(0, -1);
  for (let k = 0; k < N; k++) order[fill[mr[k] - rmin]++] = k;
  LOOKUP = { mode, mr, mc, lat, lon, rmin, rmax, cmin, cmax, start, order };
  return LOOKUP;
}

// ------------------------------------------------------------------------------------------------ one file -> the frame
const err = (code, m) => Object.assign(new Error(m), { code });
/** gzipped MRMS GRIB2 -> the pull's stored integers on the frame (Int8Array refc, Uint8Array mesh / rqi, Uint16Array qpe15).
 *  Throws code BAD_FILE for a file the pull would have counted as a gap (not gzip, not a whole GRIB2 message), MRMS_GRID for a
 *  grid change, BAD_RADAR for a format the reader does not know. */
export async function sampleMrms(gz, kind, { lookup = mrmsLookup() } = {}) {
  const K = KINDS[kind]; if (!K) throw err('BAD_KIND', 'unknown radar kind ' + kind);
  let b;
  try { b = await gunzip(gz instanceof Uint8Array ? gz : new Uint8Array(gz)); } catch (e) { throw err('BAD_FILE', 'not a gzip file'); }
  if (!(b.length > 16 && b[0] === 0x47 && b[1] === 0x52 && b[2] === 0x49 && b[3] === 0x42 && b[b.length - 4] === 0x37 && b[b.length - 3] === 0x37
    && b[b.length - 2] === 0x37 && b[b.length - 1] === 0x37)) throw err('BAD_FILE', 'not a whole GRIB2 message');
  const g = readGrib2(b), m = g.meta, G = MRMS_GRID;
  if (m.ni !== G.ni || m.nj !== G.nj || Math.abs(m.la1 - G.la1) > 1e-9 || Math.abs(m.lo1 - G.lo1) > 1e-9 || Math.abs(m.di - G.di) > 1e-12
    || Math.abs(m.dj - G.dj) > 1e-12) throw err('MRMS_GRID', 'MRMS grid changed: ' + JSON.stringify({ ni: m.ni, nj: m.nj, la1: m.la1, lo1: m.lo1, di: m.di, dj: m.dj }));
  const vl = valueLut(m), put = STORE[kind], out = new STORED_TYPE[kind](N), L = lookup;
  if (!m.nbits) { out.fill(put(fr(m.R))); return out; }   // a constant field: eccodes returns the reference value (bits_per_value 0)
  const { w, h, bpp } = pngHeader(g.png);
  if (w !== m.ni || h !== m.nj) throw err('BAD_RADAR', `MRMS PNG ${w} x ${h}`);
  const { mc, rmin, rmax, start, order } = L, cmax = L.cmax != null ? L.cmax : w - 1;
  // only the columns up to the frame's last one (+ 1 for the 3 x 3 max) are unfiltered: PNG filters read only bytes to the left / above
  if (K.how === 'nn') {
    decodePngRowsSync(g.png, { from: rmin, to: rmax + 1, cols: cmax + 1, onRow(y, row) {
      for (let i = start[y - rmin], e = start[y - rmin + 1]; i < e; i++) { const k = order[i]; out[k] = put(vl[codeAt(row, mc[k], bpp)]); }
    } });
  } else {   // the 3 x 3 max: rows y-1, y, y+1 kept in a ring; the pixels of row y are done when row y+1 arrives
    const nb = Math.min(w, cmax + 2) * bpp, ring = [new Uint8Array(nb), new Uint8Array(nb), new Uint8Array(nb)];
    decodePngRowsSync(g.png, { from: rmin - 1, to: rmax + 2, cols: cmax + 2, onRow(y, row) {
      ring[(y + 3) % 3].set(row);
      const yc = y - 1; if (yc < rmin) return;
      const a = ring[(yc + 2) % 3], bb = ring[(yc + 3) % 3], c = ring[(yc + 4) % 3];
      for (let i = start[yc - rmin], e = start[yc - rmin + 1]; i < e; i++) {
        const k = order[i], x = mc[k]; let best = 0;
        for (let dx = -1; dx <= 1; dx++) {
          const q = x + dx, v = Math.max(codeAt(a, q, bpp), codeAt(bb, q, bpp), codeAt(c, q, bpp));
          if (v > best) best = v;
        }
        out[k] = put(vl[best]);   // values rise with the code (positive scale), so the max code is the max value
      }
    } });
  }
  return out;
}

/** the stored integers -> the model's channel values (ww_feed2.sample), float32 */
export function scaleStored(kind, st, out = new Float32Array(N)) {
  if (kind === 'refc') for (let k = 0; k < N; k++) { const v = st[k]; out[k] = ((v < -50 ? -10 : v) + 10) / 70; }
  else if (kind === 'mesh') for (let k = 0; k < N; k++) out[k] = st[k] / 50;
  else if (kind === 'qpe15') for (let k = 0; k < N; k++) out[k] = st[k] / 250;
  else if (kind === 'rqi') for (let k = 0; k < N; k++) out[k] = st[k] / 100;
  return out;
}

// ------------------------------------------------------------------------------------------------ which files
/** the inputs of frame t0 (ms): [{ ch, kind, t }] (the backtest's time rules) */
export function radarNeeds(t0) {
  const out = [];
  for (let i = 0; i < 6; i++) out.push({ ch: i, kind: 'refc', t: t0 - (5 - i) * 10 * MIN });
  for (let i = 0; i < 3; i++) out.push({ ch: 6 + i, kind: 'mesh', t: t0 - (2 - i) * 10 * MIN });
  out.push({ ch: 12, kind: 'qpe15', t: Math.floor(t0 / (30 * MIN)) * 30 * MIN });   // the pull stored rain only on :00 and :30 frames
  out.push({ ch: 13, kind: 'rqi', t: Math.floor(t0 / (60 * MIN)) * 60 * MIN });     // hourly, the top of t0's hour
  return out;
}
const keyTime = (key) => {
  const m = /_(\d{8})-(\d{6})\.grib2\.gz$/.exec(key); if (!m) return null;
  const s = m[1], h = m[2];
  return Date.UTC(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8), +h.slice(0, 2), +h.slice(2, 4), +h.slice(4, 6));
};
/** the product's objects stamped in [tmin, tmax], in listing (= time) order; one list request per UTC day touched */
async function listProduct(ctx, product, tmin, tmax) {
  const out = [], re = new RegExp(`/MRMS_${product.replace(/\./g, '\\.')}_\\d{8}-\\d{6}\\.grib2\\.gz$`);
  const maxKeys = Math.min(1000, Math.ceil((tmax - tmin) / MIN / 2) + 6);
  for (let d = Math.floor(tmin / 864e5) * 864e5; d <= tmax; d += 864e5) {
    const pre = `CONUS/${product}/${ymd(d)}/`;
    const startAfter = d < tmin ? `${pre}MRMS_${product}_${ymd(tmin)}-${hms(tmin)}` : '';
    const stopAfter = `${pre}MRMS_${product}_${ymd(tmax)}-${hms(tmax)}.grib2.gz~`;
    for (const o of await s3List(ctx, 'mrms', BUCKET, pre, { startAfter, maxKeys, stopAfter })) {
      if (!re.test(o.key)) continue;
      const t = keyTime(o.key); if (t == null || t < tmin || t > tmax) continue;
      out.push({ t, key: o.key, size: o.size });
    }
  }
  return out;
}
/** ww_pull.nearest: the object nearest t within +-tol min; ties go to the one listed first (the earlier) */
export function nearestObject(list, t, tolMin) {
  let best = null;
  for (const o of list) { const dt = Math.abs(o.t - t); if (dt <= tolMin * MIN && (best == null || dt < best.dt)) best = { ...o, dt }; }
  return best;
}
/** can a nearer object still be posted? (live runs) */
function settled(list, need, best, now) {
  if (best && best.dt === 0) return true;
  const horizon = need.t + (best ? best.dt : KINDS[need.kind].tol * MIN);
  if (list.some((o) => o.t > horizon)) return true;
  return now >= horizon + KINDS[need.kind].latencyMin * MIN;
}

// ------------------------------------------------------------------------------------------------ the builder
async function cacheGet(cache, key) { if (!cache) return undefined; try { return await cache.get(key); } catch (e) { return undefined; } }
async function cacheSet(cache, key, ab) { if (!cache) return; try { await cache.set(key, ab); } catch (e) { /* a full or closed store is not fatal */ } }
const toAB = (u8) => (u8.byteOffset === 0 && u8.byteLength === u8.buffer.byteLength ? u8.buffer : u8.slice().buffer);
let decodeQueue = Promise.resolve();
/** fn run after every decode queued before it (one decode at a time on this thread: bounded memory, clean timing) */
function oneAtATime(fn) { const p = decodeQueue.then(fn, fn); decodeQueue = p.catch(() => {}); return p; }
async function pool(items, n, fn) { let i = 0; await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (i < items.length) { const j = i++; await fn(items[j], j); } })); }

/**
 * t0: Date (UTC), a 10-minute frame time.  opts: { fetch, cache, signal, now = Date.now(), concurrency = 3, cacheRaw = true, cacheDerived = true,
 *   keepStored = false (also return the stored integers per channel, as `stored`) }
 * -> { ch: { [index]: Float32Array(304 * 304) }, ok, missing: [{ ch, what, t, why, pending }], urls: [every object read], bytes, ms,
 *      files: [{ ch, kind, t, key, actual, dtSec, bytes, from: 'net' | 'cache' | 'decoded-cache' }],
 *      stats: { listBytes, objectBytes, cachedRawBytes, decodedHits, rawHits, downloads, decodes,
 *               listMs (the listings, wall), netMs (each download from request to body, incl. waiting for a fetch slot, summed),
 *               decodeMs (gunzip + PNG + sampling, one file at a time, summed) } }
 */
export async function buildRadar(t0, opts = {}) {
  const ms0 = (globalThis.performance || Date).now();
  const T0 = +t0;
  if (!Number.isFinite(T0) || T0 % (10 * MIN) !== 0) throw new RangeError('t0 must be a 10-minute UTC time');
  const { cache = null, signal, now = Date.now(), concurrency = 3, cacheRaw = true, cacheDerived = true, keepStored = false, lookup = mrmsLookup() } = opts;
  const fetchFn = opts.fetch || ((u, o) => globalThis.fetch(u, o));
  const ctx = makeCtx({ fetchFn, signal });
  const needs = radarNeeds(T0), ch = {}, missing = [], files = [], urls = [];
  const stats = { listBytes: 0, objectBytes: 0, cachedRawBytes: 0, decodedHits: 0, rawHits: 0, downloads: 0, decodes: 0, listMs: 0, netMs: 0, decodeMs: 0 };
  const clock = () => (globalThis.performance || Date).now();

  // 1. the listings (one window per product)
  const span = {};
  for (const n of needs) { const s = (span[n.kind] ||= [Infinity, -Infinity]); s[0] = Math.min(s[0], n.t); s[1] = Math.max(s[1], n.t); }
  const lists = {}, listErr = {}, tList = clock();
  await Promise.all(Object.entries(span).map(async ([kind, [a, b]]) => {
    const tol = KINDS[kind].tol * MIN;
    try { lists[kind] = await listProduct(ctx, KINDS[kind].product, a - tol, b + tol); } catch (e) {
      if (e && e.name === 'AbortError') throw e;
      lists[kind] = null; listErr[kind] = String((e && e.message) || e);   // offline or the bucket refused: ok false, the runner decides
    }
  }));
  stats.listBytes = ctx.stat('mrms').bytes; stats.listMs = clock() - tList;

  // 2. nearest object per need
  const jobs = new Map();   // key -> { kind, key, needs: [] }
  for (const n of needs) {
    const K = KINDS[n.kind];
    if (!lists[n.kind]) { missing.push({ ch: n.ch, what: K.product, t: new Date(n.t).toISOString(), pending: false, why: 'listing failed: ' + listErr[n.kind] }); continue; }
    const best = nearestObject(lists[n.kind], n.t, K.tol), fin = settled(lists[n.kind], n, best, now);
    if (!best) {
      missing.push({ ch: n.ch, what: K.product, t: new Date(n.t).toISOString(), pending: !fin,
        why: fin ? `no file within +-${K.tol} min (a gap: filled as the backtest did)` : 'not posted yet' });
      continue;
    }
    if (!fin) missing.push({ ch: n.ch, what: K.product, t: new Date(n.t).toISOString(), pending: true, why: 'provisional: a nearer file may still be posted' });
    n.obj = best;
    if (!jobs.has(best.key)) jobs.set(best.key, { kind: n.kind, key: best.key, needs: [] });
    jobs.get(best.key).needs.push(n);
  }

  // 3. fetch + decode each distinct object (decoded integers from the cache when there)
  const stored = new Map();
  let fatal = null;
  await pool([...jobs.values()], concurrency, async (job) => {
    if (fatal) return;
    const url = objectUrl(BUCKET, job.key), dkey = `${DERIVED_VERSION}/${job.kind}/${lookup.mode}/${url}`;
    let st = null, from = 'net', bytes = 0;
    urls.push(url);
    if (cacheDerived) {
      const ab = await cacheGet(cache, dkey);
      if (ab && ab.byteLength === N * STORED_TYPE[job.kind].BYTES_PER_ELEMENT) { st = new STORED_TYPE[job.kind](ab); from = 'decoded-cache'; stats.decodedHits++; }
    }
    if (!st) {
      let gz = null;
      if (cacheRaw) { const ab = await cacheGet(cache, url); if (ab && ab.byteLength) { gz = new Uint8Array(ab); from = 'cache'; stats.rawHits++; stats.cachedRawBytes += ab.byteLength; } }
      if (!gz) {
        const tNet = clock();
        try {
          const r = await ctx.fetch('mrms', url);
          if (!r.ok) throw err('HTTP', `answered ${r.status}`);
          gz = new Uint8Array(await r.arrayBuffer()); bytes = gz.length; ctx.count('mrms', gz.length); stats.objectBytes += gz.length; stats.downloads++;
          stats.netMs += clock() - tNet;
          if (cacheRaw) await cacheSet(cache, url, toAB(gz));
        } catch (e) {
          stats.netMs += clock() - tNet;
          if (e && e.name === 'AbortError') throw e;
          for (const n of job.needs) missing.push({ ch: n.ch, what: KINDS[n.kind].product, t: new Date(n.t).toISOString(), pending: false, why: `download failed: ${e.message || e}` });
          return;
        }
      }
      try {
        st = await oneAtATime(async () => { const t = clock(); try { return await sampleMrms(gz, job.kind, { lookup }); } finally { stats.decodeMs += clock() - t; } });
        stats.decodes++;
        if (cacheDerived) await cacheSet(cache, dkey, st.buffer);
      } catch (e) {
        if (e.code === 'MRMS_GRID' || e.code === 'BAD_RADAR') { fatal = e; return; }
        for (const n of job.needs) missing.push({ ch: n.ch, what: KINDS[n.kind].product, t: new Date(n.t).toISOString(), pending: false, why: `${e.message} (a gap, as the backtest)` });
        return;
      }
    }
    stored.set(job.key, st);
    for (const n of job.needs) files.push({ ch: n.ch, kind: n.kind, t: new Date(n.t).toISOString(), key: job.key, actual: new Date(n.obj.t).toISOString(), dtSec: n.obj.dt / 1e3, bytes, from });
  });
  if (fatal) {
    for (const n of needs) missing.push({ ch: n.ch, what: KINDS[n.kind].product, t: new Date(n.t).toISOString(), pending: false, why: fatal.message });
  }

  // 4. the channels
  const kept = keepStored ? {} : null;
  for (const n of needs) {
    let st = !fatal && n.obj ? stored.get(n.obj.key) : null;
    if (!st) st = new STORED_TYPE[n.kind](N).fill(MISSING_FILL[n.kind]);
    ch[n.ch] = scaleStored(n.kind, st);
    if (kept) kept[n.ch] = st;
  }
  missing.sort((a, b) => a.ch - b.ch);
  files.sort((a, b) => a.ch - b.ch);
  const ms = (globalThis.performance || Date).now() - ms0;
  for (const k of ['listMs', 'netMs', 'decodeMs']) stats[k] = Math.round(stats[k]);
  const res = { ch, ok: missing.length === 0, missing, urls, bytes: ctx.stat('mrms').bytes, ms, files, stats };
  if (kept) res.stored = kept;
  return res;
}
