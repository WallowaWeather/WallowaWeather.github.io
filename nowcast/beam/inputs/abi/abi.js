// Part of BEAM's phone code (kept identical to BEAM's own build).
// js/inputs/abi/abi.js - BEAM input channels 25-28 (cloud-top temperature, its 10 / 30-min cooling, overshooting top) from GOES-West
// ABI L2 CMIPC band 13 (10.3 um) files in NOAA's public bucket, built exactly as BEAM's Python does (ww_pull_updraft.py + ww_feed2.sample):
//   - scan rule: for each of t0, t0-10, t0-30 min, the newest band-13 CONUS scan whose start (to the second) lies in [t - 16, t - 6] min;
//   - nearest ABI pixel of each BEAM pixel by the GOES-R PUG fixed-grid formulas (no parallax correction), with the frame's lat / lon
//     rounded to float32 (as the training grid stored them);
//   - brightness temperature in float32 (raw * scale + offset), missing outside 150-350 K, stored as uint8 (K - 170) / 0.5
//     (round half to even, clipped 0-254), 255 = missing; the channels are computed from those stored steps.
// Reads only the HDF5 chunks under the frame (by HTTP Range); the chunk layout comes from each file's own metadata.
//
//   import { buildABI } from './abi.js';
//   const r = await buildABI(new Date('2025-07-22T00:10:00Z'), { fetch, cache, signal });
//   // -> { ch: {25, 26, 27, 28: Float32Array(304 * 304)}, ok, missing, urls, bytes, ms, scans, bt: {0, 10, 30: Uint8Array} }
import { H5File, httpSource } from '../../../stormscope/prep/hdf5.js';
import { hrrrLatLon } from '../../../stormscope/lcc.js';
import { s3List, makeCtx, objectUrl } from '../../../stormscope/prep/s3.js';

export const FRAME = { row0: 689, col0: 260, S: 304 };   // BEAM's frame in the full HRRR grid (rows from the south)
export const LAGS = [0, 10, 30];                          // minutes before t0: bt, bt 10 min ago, bt 30 min ago
const S = FRAME.S, N = S * S, MIN = 60000;
const BT0 = 170, BTSTEP = 0.5, MISSING = 255;
const VERSION = 'beam-abi13-v1';                          // the cached per-scan product (bump if the lookup or quantisation changes)
const HEAD = 81920, TAIL = 65536;                         // metadata reads: first 80 KB; the last 64 KB when the root group lives there

/** the bucket of the training pull: GOES-17 before 2023-01-04, GOES-18 after */
export const bucketFor = (ms) => (ms < Date.UTC(2023, 0, 4) ? 'noaa-goes17' : 'noaa-goes18');
const p2 = (v, n = 2) => String(v).padStart(n, '0');
const doy = (d) => Math.floor((Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - Date.UTC(d.getUTCFullYear(), 0, 1)) / 864e5) + 1;
const hourPrefix = (ms) => { const d = new Date(ms); return `ABI-L2-CMIPC/${d.getUTCFullYear()}/${p2(doy(d), 3)}/${p2(d.getUTCHours())}/`; };
const SCAN_RE = /C13_G1\d_s(\d{4})(\d{3})(\d{2})(\d{2})(\d{2})/;   // start time to the second (the tenths digit is ignored, as the pull did)
const MODES = ['M6', 'M3'];   // the CONUS modes that carry band 13 (listing them separately keeps a listing to ~5 KB instead of ~75 KB)

/** numpy's round (half to even) */
export function rint(x) { const r = Math.round(x); return r - x === 0.5 && r % 2 !== 0 ? r - 1 : r; }

// ------------------------------------------------------------------------------------------------------------ the frame's lat / lon
let LATLON = null;
function frameLatLon() {   // float32-rounded, as the training grid (grid.npz) stored them; then used as float64
  if (LATLON) return LATLON;
  const lat = new Float64Array(N), lon = new Float64Array(N);
  for (let r = 0; r < S; r++) for (let c = 0; c < S; c++) {
    const ll = hrrrLatLon(FRAME.col0 + c, FRAME.row0 + r);
    lat[r * S + c] = Math.fround(ll.lat); lon[r * S + c] = Math.fround(ll.lon);
  }
  return (LATLON = { lat, lon });
}

const RAD = Math.PI / 180;   // numpy.radians / math.radians multiply by this constant
/** lat / lon (deg) -> ABI fixed-grid scan angles x, y (rad): GOES-R PUG, in the order ww_pull_updraft.scan_angles evaluates them */
export function scanAngles(lat, lon, p) {
  const a = p.a, b = p.b, h = p.H, l0 = p.lon0 * RAD, phi = lat * RAD, lam = lon * RAD;
  const pc = Math.atan((b * b) / (a * a) * Math.tan(phi)), cpc = Math.cos(pc);
  const rc = b / Math.sqrt(1 - (a * a - b * b) / (a * a) * (cpc * cpc));
  const sx = h - rc * cpc * Math.cos(lam - l0), sy = -rc * cpc * Math.sin(lam - l0), sz = rc * Math.sin(pc);
  return [Math.asin(-sy / Math.sqrt(sx * sx + sy * sy + sz * sz)), Math.atan(sz / sx)];
}

const GEO = new Map();   // geometry key -> pixel map (computed once per satellite / sector layout)
/** -> { chunks: ['row,col' keys], pc: Int32Array (chunk number per pixel, -1 = outside the scan), po: Int32Array (element in chunk) } */
function pixelMap(g) {
  const key = [g.bucket, g.x0, g.dx, g.y0, g.dy, g.NY, g.NX, g.cr, g.cc, g.p.a, g.p.b, g.p.H, g.p.lon0].join('|');
  let m = GEO.get(key);
  if (m) return m;
  const { lat, lon } = frameLatLon(), pc = new Int32Array(N).fill(-1), po = new Int32Array(N), chunks = [], at = new Map();
  for (let i = 0; i < N; i++) {
    const [gx, gy] = scanAngles(lat[i], lon[i], g.p);
    if (!Number.isFinite(gx) || !Number.isFinite(gy)) continue;
    const gc = rint((gx - g.x0) / g.dx), gr = rint((gy - g.y0) / g.dy);
    if (gr < 0 || gr >= g.NY || gc < 0 || gc >= g.NX) continue;
    const r0 = Math.floor(gr / g.cr) * g.cr, c0 = Math.floor(gc / g.cc) * g.cc, k = r0 + ',' + c0;
    let j = at.get(k);
    if (j === undefined) { j = chunks.length; chunks.push(k); at.set(k, j); }
    pc[i] = j; po[i] = (gr - r0) * g.cc + (gc - c0);
  }
  m = { chunks, pc, po };
  if (GEO.size > 8) GEO.delete(GEO.keys().next().value);
  GEO.set(key, m);
  return m;
}

// ------------------------------------------------------------------------------------------------------------ listing + scan rule
function listHour(ctx, bucket, hourMs, cache, now) {   // one listing per hour per build, even when several lags need it
  const id = `${objectUrl(bucket, '')}?list-type=2&prefix=${hourPrefix(hourMs)}#${VERSION}-list`;
  ctx.lists ||= new Map();
  if (!ctx.lists.has(id)) ctx.lists.set(id, listHour1(ctx, bucket, hourMs, cache, now, id));
  return ctx.lists.get(id);
}
async function listHour1(ctx, bucket, hourMs, cache, now, id) {
  const pre = hourPrefix(hourMs);
  const closed = now > hourMs - (hourMs % 3600000) + 3600000 + 20 * MIN;   // a finished hour's listing no longer changes
  if (closed && cache) {
    const hit = await cache.get(id);
    if (hit) return JSON.parse(new TextDecoder().decode(hit));
  }
  const parts = await Promise.all(MODES.map((m) => s3List(ctx, 'abi', bucket, `${pre}OR_ABI-L2-CMIPC-${m}C13_`)));
  ctx.urls.push(...MODES.map((m) => `${objectUrl(bucket, '')}?list-type=2&prefix=${pre}OR_ABI-L2-CMIPC-${m}C13_`));
  const out = [];
  for (const { key, size } of parts.flat()) {
    const m = SCAN_RE.exec(key);
    if (!m) continue;
    const start = Date.UTC(+m[1], 0, 1) + (+m[2] - 1) * 864e5 + +m[3] * 36e5 + +m[4] * MIN + +m[5] * 1000;
    out.push({ start, key, size });
  }
  if (closed && cache) await cache.set(id, new TextEncoder().encode(JSON.stringify(out)).buffer);
  return out;
}

/** the newest band-13 scan that started 6-16 min before t (ms) -> {start, key, size} | null (ww_pull_updraft.pick_scan) */
export async function pickScan(ctx, t, cache, now = Date.now()) {
  const lo = t - 16 * MIN, hi = t - 6 * MIN, seen = new Set(), cands = [];
  for (const h of [lo, hi]) {   // the hours of t - 16 and t - 6, each in the bucket of that time
    const id = bucketFor(h) + hourPrefix(h);
    if (seen.has(id)) continue;
    seen.add(id);
    for (const s of await listHour(ctx, bucketFor(h), h, cache, now)) if (s.start >= lo && s.start <= hi) cands.push(s);
  }
  let best = null;   // Python's max over (start, key, size) tuples
  for (const s of cands) if (!best || s.start > best.start || (s.start === best.start && (s.key > best.key || (s.key === best.key && s.size > best.size)))) best = s;
  return best;
}

// ------------------------------------------------------------------------------------------------------------ one scan -> uint8 frame
const one = (v) => (v != null && typeof v === 'object' && v.length !== undefined ? v[0] : v);
function intReader(dt, unsigned) {   // element decoder of a fixed-point dataset; _Unsigned reinterprets the same bytes as unsigned
  if (dt.kind !== 'int') throw new Error(`ABI: CMI is ${dt.kind}, expected integers`);
  const le = dt.le, sz = dt.size, sg = dt.signed && !unsigned;
  if (sz === 2) return (u8, k) => { const v = le ? u8[k] | (u8[k + 1] << 8) : (u8[k] << 8) | u8[k + 1]; return sg && v > 32767 ? v - 65536 : v; };
  if (sz === 1) return (u8, k) => (sg && u8[k] > 127 ? u8[k] - 256 : u8[k]);
  throw new Error(`ABI: CMI element size ${sz} not supported`);
}

/** read one scan file -> Uint8Array(N) of (K - 170) / 0.5 steps, 255 = missing (ww_pull_updraft.abi_bt + its quantisation) */
export async function readScan(url, size, bucket, { fetchFn, signal, onBytes } = {}) {
  const src = httpSource(url, { fetchFn, signal, page: 8192, prefetch: HEAD, size, onBytes });
  const f = await H5File.open(src);
  if (f.root >= HEAD && size > HEAD) await src.read(Math.max(HEAD, size - TAIL), size - Math.max(HEAD, size - TAIL));   // older layout
  const [cmi, dx_, dy_, gp] = await Promise.all(['CMI', 'x', 'y', 'goes_imager_projection'].map((n) => f.dataset(n)));
  const [ca, xa, ya, pa] = await Promise.all([cmi.attrs(), dx_.attrs(), dy_.attrs(), gp.attrs()]);
  const first2 = async (ds) => {   // the first two raw elements of a 1-D coordinate, as float64
    const es = ds.dtype.size;
    const u8 = ds.layout.cls === 1 ? await src.read(ds.layout.addr, 2 * es) : (await ds.readAll()).subarray(0, 2 * es);
    const dv = new DataView(u8.buffer, u8.byteOffset, 2 * es), le = ds.dtype.le;
    const rd = (o) => (ds.dtype.kind === 'float' ? (es === 4 ? dv.getFloat32(o, le) : dv.getFloat64(o, le))
      : es === 2 ? (ds.dtype.signed ? dv.getInt16(o, le) : dv.getUint16(o, le)) : es === 4 ? (ds.dtype.signed ? dv.getInt32(o, le) : dv.getUint32(o, le)) : dv.getInt8(o));
    return [rd(0), rd(es)];
  };
  const [xr, yr] = await Promise.all([first2(dx_), first2(dy_)]);
  const xs0 = one(xa.add_offset), xsc = one(xa.scale_factor), ys0 = one(ya.add_offset), ysc = one(ya.scale_factor);
  const a = one(pa.semi_major_axis), es = cmi.dtype.size, contiguous = cmi.layout.cls === 1;
  if (cmi.shape.length !== 2 || cmi.layout.cls === 0) throw new Error('ABI: CMI layout not supported');
  const g = {   // a contiguous CMI is read as row "chunks" (1 x NX)
    bucket, NY: cmi.shape[0], NX: cmi.shape[1], cr: contiguous ? 1 : cmi.chunkShape[0], cc: contiguous ? cmi.shape[1] : cmi.chunkShape[1],
    x0: xr[0] * xsc + xs0, dx: (xr[1] - xr[0]) * xsc, y0: yr[0] * ysc + ys0, dy: (yr[1] - yr[0]) * ysc,
    p: { a, b: one(pa.semi_minor_axis), H: one(pa.perspective_point_height) + a, lon0: one(pa.longitude_of_projection_origin) },
  };
  if (![g.x0, g.dx, g.y0, g.dy, g.p.a, g.p.b, g.p.H, g.p.lon0].every(Number.isFinite)) throw new Error('ABI: fixed-grid metadata missing');
  const map = pixelMap(g);
  let list, blobs;
  if (contiguous) {
    if (cmi.layout.addr < 0) throw new Error('ABI: CMI has no data');
    list = map.chunks.map((k) => ({ off: cmi.layout.addr + +k.split(',')[0] * g.NX * es, len: g.NX * es }));
    blobs = await src.readExact(list);
  } else {
    const all = await cmi.chunks(), byKey = new Map(all.map((c) => [c.coord.join(','), c]));
    list = map.chunks.map((k) => byKey.get(k));
    if (list.some((c) => !c)) throw new Error('ABI: a chunk under the frame is not stored');
    const got = await cmi.readChunks(list);
    blobs = map.chunks.map((k) => got.get(k));
  }
  const unsigned = String(one(ca._Unsigned) ?? 'false').toLowerCase() === 'true', rd = intReader(cmi.dtype, unsigned);
  const sf = Math.fround(one(ca.scale_factor)), ao = Math.fround(one(ca.add_offset)), fill = one(ca._FillValue);
  if (!Number.isFinite(sf) || !Number.isFinite(ao)) throw new Error('ABI: CMI scale / offset missing');
  const q = new Uint8Array(N).fill(MISSING);
  for (let i = 0; i < N; i++) {
    const j = map.pc[i];
    if (j < 0) continue;
    const raw = rd(blobs[j], map.po[i] * es);
    if (fill != null && raw === fill) continue;
    const bt = Math.fround(Math.fround(raw * sf) + ao);   // float32, as numpy computed it
    if (!(bt >= 150 && bt <= 350)) continue;
    const s = rint((bt - BT0) / BTSTEP);
    q[i] = s < 0 ? 0 : s > 254 ? 254 : s;
  }
  return { q, bytes: src.bytes, requests: src.requests, chunks: list.length, layout: { chunk: [g.cr, g.cc], shape: [g.NY, g.NX] } };
}

// ------------------------------------------------------------------------------------------------------------ the channels
/** three uint8 frames (t0, t0-10, t0-30) -> channels 25-28 after the model scaling (ww_feed2.sample), NaN -> 0 */
export function channels(q0, q1, q3) {
  const c25 = new Float32Array(N), c26 = new Float32Array(N), c27 = new Float32Array(N), c28 = new Float32Array(N);
  const bt = (v) => (v < MISSING ? BT0 + BTSTEP * v : NaN);
  const W = S + 1, sum = new Float64Array(W * W), cnt = new Float64Array(W * W);   // integral images (exact: sums of 0.5 steps)
  for (let r = 0; r < S; r++) for (let c = 0; c < S; c++) {
    const i = r * S + c, b0 = bt(q0[i]), b1 = bt(q1[i]), b3 = bt(q3[i]);
    if (b0 === b0) {
      c25[i] = (b0 - 250) / 40;
      if (b1 === b1) c26[i] = (b0 - b1) / 10;
      if (b3 === b3) c27[i] = (b0 - b3) / 20;
    }
    const cold = b0 < 235, k = (r + 1) * W + c + 1;
    sum[k] = (cold ? b0 : 0) + sum[k - 1] + sum[k - W] - sum[k - W - 1];
    cnt[k] = (cold ? 1 : 0) + cnt[k - 1] + cnt[k - W] - cnt[k - W - 1];
  }
  const R = 5;   // the 11 x 11 box (edges: the part inside the frame)
  for (let r = 0; r < S; r++) {
    const ra = Math.max(0, r - R), rb = Math.min(S, r + R + 1);
    for (let c = 0; c < S; c++) {
      const i = r * S + c, b0 = bt(q0[i]);
      if (!(b0 < 235)) continue;
      const ca = Math.max(0, c - R), cb = Math.min(S, c + R + 1);
      const n = cnt[rb * W + cb] - cnt[ra * W + cb] - cnt[rb * W + ca] + cnt[ra * W + ca];
      if (n < 12) continue;
      const m = (sum[rb * W + cb] - sum[ra * W + cb] - sum[rb * W + ca] + sum[ra * W + ca]) / n;
      c28[i] = (b0 - m) / 10;   // float64, then stored as float32
    }
  }
  return { 25: c25, 26: c26, 27: c27, 28: c28 };
}

// ------------------------------------------------------------------------------------------------------------ the builder
/**
 * @param {Date} t0  the frame time (UTC, a 10-minute mark)
 * @param {{fetch?, cache?: {get(url), set(url, ArrayBuffer)}, signal?, now?: number}} opts
 * ok is false when any of the three scans is missing; ch is then still exactly what BEAM was trained on for that case (zeros where a
 * scan is missing). Each missing entry says which and why: kind 'gap' (no scan in the window: a satellite gap, as in training),
 * 'not-posted' (t0 is too recent for that window), 'error' (a read failed).
 */
export async function buildABI(t0, opts = {}) {
  const fetchFn = opts.fetch || ((u, o) => globalThis.fetch(u, o)), cache = opts.cache, signal = opts.signal;
  const clock = () => (globalThis.performance ? performance.now() : Date.now()), tStart = clock();
  const now = opts.now ?? Date.now(), T0 = t0.getTime();
  const ctx = makeCtx({ fetchFn, signal });
  ctx.urls = [];
  const missing = [], scans = [], urls = ctx.urls;
  let bytes = 0;
  const frames = await Promise.all(LAGS.map(async (lag) => {
    const t = T0 - lag * MIN, info = { lag };
    scans.push(info);
    try {
      if (now < t - MIN) { missing.push({ what: `ABI t0-${lag}`, why: 'not posted yet (scan window ends after now)', kind: 'not-posted' }); return null; }
      const s = await pickScan(ctx, t, cache, now);
      if (!s) { missing.push({ what: `ABI t0-${lag}`, why: 'no band-13 scan started 6-16 min before', kind: 'gap' }); return null; }
      const url = objectUrl(bucketFor(t), s.key), id = `${url}#${VERSION}`;
      Object.assign(info, { key: s.key.split('/').pop(), start: new Date(s.start).toISOString() });
      if (cache) {
        const hit = await cache.get(id);
        if (hit && hit.byteLength === N) { info.from = 'cache'; return new Uint8Array(hit); }
      }
      urls.push(url);
      const r = await readScan(url, s.size, bucketFor(t), { fetchFn, signal, onBytes: (n) => { bytes += n; } });
      Object.assign(info, { from: 'net', bytes: r.bytes, requests: r.requests, chunks: r.chunks, layout: r.layout });
      if (cache) await cache.set(id, r.q.slice().buffer);
      return r.q;
    } catch (e) {
      if (e && e.name === 'AbortError') throw e;
      missing.push({ what: `ABI t0-${lag}`, why: String((e && e.message) || e).slice(0, 200), kind: 'error' });
      return null;
    }
  }));
  bytes += ctx.stats.abi ? ctx.stats.abi.bytes : 0;
  const gap = new Uint8Array(N).fill(MISSING), [q0, q1, q3] = frames.map((q) => q || gap);
  scans.sort((x, y) => x.lag - y.lag);
  return { ch: channels(q0, q1, q3), ok: missing.length === 0, missing, urls, bytes, ms: Math.round(clock() - tStart), scans, bt: { 0: q0, 10: q1, 30: q3 } };
}
