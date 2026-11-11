// Part of BEAM's phone code (kept identical to BEAM's own build).
// js/inputs/glm/glm.js - BEAM input channels 9-11: GOES-West GLM lightning flashes per pixel of BEAM's frame, built exactly the way
// the backtest built them (its GLM download and per-pixel count, then its training feed). Pure ES module
// (browser + Node 18+): fetch, DecompressionStream (through hdf5.js), typed arrays.
//
//   frames  ch 9 = the flashes of [t0-20, t0-10), ch 10 = [t0-10, t0), ch 11 = [t0, t0+10): the pull's frame at time t holds
//           [t, t+10 min), and the model reads frames k-2, k-1, k.
//   files   1 in 6: per frame only the 20-s files that start at second < 20 of an even minute (5 per 10 min). Bucket noaa-goes17
//           when the frame starts before 2023-01-04, else noaa-goes18 (GOES-West).
//   pixel   each FLASH (flash_lat / flash_lon, not events) with 41 <= lat <= 50 and -122 <= lon <= -110 goes to the nearest pixel of
//           the HRRR 3 km Lambert grid (spherical earth, R = 6371229 m; numpy's round half to even); BEAM's frame is HRRR rows
//           689..992 (from the south) and columns 260..563.
//   value   count per pixel per frame, capped at 255, then log1p(n) / 2 in float32 (identical to numpy's float32 log1p for 0..255).
//   live    the last file needed starts at t0 + 8:00 and is normally in the bucket about 30 s after it starts (over 360 files of
//           2026-11-07: median 29 s, p99 50 s, max 90 s). glmEarliestRun(t0) = t0 + 9:00. Until every needed file is posted,
//           buildGLM returns ok: false with a pending entry per file in `missing`.
//
// Reading a file: the flash arrays are a few KB inside a 0.15-0.4 MB netCDF-4 file. The writer puts their object headers, chunk
// indexes and attribute blocks at the same offsets in every file of one ground-system version, so a file is read in two rounds of
// HTTP Range requests: (1) those metadata blocks (3-5 ranges, from a known layout), (2) the data chunks (1-3 ranges). Each
// layout is checked on every file (both datasets must say they are the flash latitude / longitude, with equal lengths); if it
// does not fit, the file is read by name through the HDF5 group index (several more requests) and its layout is learned.
//
//   import { buildGLM, glmEarliestRun, glmLatestT0 } from './glm.js'
//   const r = await buildGLM(t0, { fetch, cache, signal })   // see BUILD.md: { ch: {9, 10, 11}, ok, missing, urls, bytes, ms }
import { H5File, H5Dataset, bytesSource } from '../../../stormscope/prep/hdf5.js';

const MIN = 60e3;
export const FRAME_MS = 10 * MIN;
export const GLM_CHANNELS = [9, 10, 11];
export const BEAM_FRAME = { row0: 689, col0: 260, size: 304 };
export const GLM_SLOT_MINUTES = [0, 2, 4, 6, 8];            // the sampled files of a frame start at these minutes (second < 20)
export const GLM_LAST_FILE_START_MS = 8 * MIN;              // the last needed file starts at t0 + 8:00
export const GLM_POSTED_AFTER_START_MS = 60e3;              // a file is expected in the bucket by 60 s after it starts
export const GLM_GAP_AFTER_START_MS = 5 * MIN;              // not there 5 min after it starts: a gap, as the backtest had them
const BOX = { lat0: 41, lat1: 50, lon0: -122, lon1: -110 }; // ww_pull.py BOX (42..49 N, 121..111 W) widened by 1 degree
const GOES17_BEFORE = Date.UTC(2023, 0, 4);
const S = BEAM_FRAME.size, NPIX = S * S;
const PRE_GAP = 4096, DATA_GAP = 16384, MISS_MIN = 4096;
const CACHE_TAG = '#beam-glm-flashes-v1';

// ------------------------------------------------------------------------------------------------ the HRRR Lambert grid (ww_pull)
const R_E = 6371229.0, DEG = Math.PI / 180, PHI1 = 38.5 * DEG, LON0 = 262.5 * DEG, DX = 3000.0, TWO_PI = 2 * Math.PI;
const NN = Math.sin(PHI1), FF = Math.cos(PHI1) * Math.tan(Math.PI / 4 + PHI1 / 2) ** NN / NN;
const rho = (phi) => R_E * FF / Math.tan(Math.PI / 4 + phi / 2) ** NN;
const RHO0 = rho(PHI1);
function lccXY(lat, lon) {
  if (lon < 0) lon += 360;
  let m = (lon * DEG - LON0 + Math.PI) % TWO_PI; if (m < 0) m += TWO_PI;   // Python's float %
  const r = rho(lat * DEG), th = NN * (m - Math.PI);
  return [r * Math.sin(th), RHO0 - r * Math.cos(th)];
}
const [X1, Y1] = lccXY(21.138123, 237.280472);   // the HRRR grid's first point
/** numpy's round (half to even) */
function rint(v) { const f = Math.floor(v), d = v - f; return d > 0.5 ? f + 1 : d < 0.5 ? f : (f % 2 === 0 ? f : f + 1); }
/** lat / lon -> index into BEAM's 304 x 304 frame (row from the south, row-major), or -1 outside it */
export function framePixel(lat, lon) {
  const [x, y] = lccXY(lat, lon), r = rint((y - Y1) / DX) - BEAM_FRAME.row0, c = rint((x - X1) / DX) - BEAM_FRAME.col0;
  return r >= 0 && r < S && c >= 0 && c < S ? r * S + c : -1;
}
const LUT = new Float32Array(256);
for (let n = 0; n < 256; n++) LUT[n] = Math.fround(Math.log1p(n)) / 2;

// ------------------------------------------------------------------------------------------------ time rules
/** the earliest time a run for frame time t0 can have all its GLM files */
export function glmEarliestRun(t0, { postedAfterStartMs = GLM_POSTED_AFTER_START_MS } = {}) {
  return new Date(+t0 + GLM_LAST_FILE_START_MS + postedAfterStartMs);
}
/** the newest frame time t0 whose GLM files should all be posted at `now` */
export function glmLatestT0(now = Date.now(), { postedAfterStartMs = GLM_POSTED_AFTER_START_MS } = {}) {
  return new Date(Math.floor((+now - GLM_LAST_FILE_START_MS - postedAfterStartMs) / FRAME_MS) * FRAME_MS);
}
/** the three frames [start, end) and their 15 sampled file slots for t0 */
export function glmFrames(t0) {
  return GLM_CHANNELS.map((ch, i) => {
    const a = +t0 + (i - 2) * FRAME_MS;
    return { ch, start: a, end: a + FRAME_MS, slots: GLM_SLOT_MINUTES.map((m) => a + m * MIN), ...goesWest(a) };
  });
}
function goesWest(t) { return t < GOES17_BEFORE ? { bucket: 'noaa-goes17', plat: 'G17' } : { bucket: 'noaa-goes18', plat: 'G18' }; }
const p2 = (v, n = 2) => String(v).padStart(n, '0');
const doy = (t) => { const d = new Date(t); return Math.floor((Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - Date.UTC(d.getUTCFullYear(), 0, 1)) / 864e5) + 1; };
const iso = (t) => new Date(t).toISOString().replace('.000Z', 'Z');
/** a GLM key's start time (ww_pull: key.split('_s')[1][:13] as %Y%j%H%M%S) -> ms, or NaN */
function keyStart(key) {
  const i = key.indexOf('_s'); if (i < 0) return NaN;
  const s = key.slice(i + 2, i + 15); if (!/^\d{13}$/.test(s)) return NaN;
  return Date.UTC(+s.slice(0, 4), 0, 1) + (+s.slice(4, 7) - 1) * 864e5 + +s.slice(7, 9) * 36e5 + +s.slice(9, 11) * MIN + +s.slice(11, 13) * 1e3;
}

// ------------------------------------------------------------------------------------------------ network (accounted)
function makeNet(opts) {
  const fetchFn = opts.fetch || ((u, o) => globalThis.fetch(u, o)), urls = new Set(); let bytes = 0, requests = 0;
  return {
    urls, get bytes() { return bytes; }, get requests() { return requests; },
    /** GET (optionally a byte range [a, b)) -> { status, u8 }; retries network errors and 5xx twice */
    async get(url, range, extra = {}) {
      urls.add(url);
      for (let k = 0; ; k++) {
        let r;
        try {
          requests++;
          r = await fetchFn(url, { ...extra, signal: opts.signal, headers: range ? { Range: `bytes=${range[0]}-${range[1] - 1}` } : undefined });
          if (r.status >= 500 && k < 2) { try { await r.arrayBuffer(); } catch (e) { /* drop */ } await sleep(400 * (k + 1)); continue; }
          if (!r.ok) { try { await r.arrayBuffer(); } catch (e) { /* drop */ } return { status: r.status, u8: new Uint8Array(0) }; }
          const u8 = new Uint8Array(await r.arrayBuffer()); bytes += u8.length;
          return { status: r.status, u8 };
        } catch (e) {
          if ((opts.signal && opts.signal.aborted) || k >= 2) throw Object.assign(e instanceof Error ? e : new Error(String(e)), { net: true });
          await sleep(400 * (k + 1));
        }
      }
    },
  };
}
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

/** an S3 object read by byte ranges, with a small sparse cache; hdf5.js reads through it (read / readExact) */
function rangeSource(url, size, net) {
  const got = [], inflight = []; let requests = 0, bytes = 0, misses = 0, rec = null;
  const hit = (a, b) => { for (const g of got) if (g.a <= a && b <= g.b) return g.u8.subarray(a - g.a, b - g.a); return null; };
  async function fetchRange(a, b) {
    a = Math.max(0, a); b = Math.min(size, b); if (b <= a) return;
    const job = { a, b, p: null };
    job.p = (async () => {
      requests++;
      const r = await net.get(url, [a, b]);
      if (r.status !== 206 && r.status !== 200) throw Object.assign(new Error(`range read answered ${r.status}`), { status: r.status });
      bytes += r.u8.length;
      const u = r.status === 200 ? r.u8.subarray(a, b) : r.u8;
      if (u.length < b - a) throw new Error(`short range read ${u.length} < ${b - a}`);
      got.push({ a, b, u8: u });
    })();
    inflight.push(job);
    try { await job.p; } finally { inflight.splice(inflight.indexOf(job), 1); }
  }
  async function ensure(a, b, minLen) {
    for (let k = 0; k < 4 && !hit(a, b); k++) {
      const w = inflight.find((f) => f.a <= a && b <= f.b);
      if (w) { await w.p; continue; }
      misses++; await fetchRange(a, Math.max(b, a + minLen));
    }
    const u = hit(a, b); if (!u) throw new Error(`bytes ${a}-${b} not readable`);
    return u;
  }
  return {
    url, get bytes() { return bytes; }, get requests() { return requests; }, get misses() { return misses; },
    record(on) { const r = rec; rec = on ? [] : null; return r; },
    async init() {},
    /** fetch [off, len] ranges (negative off = from the end), neighbours closer than `gap` in one request, all at once */
    async prefetch(ranges, gap = PRE_GAP) {
      const rs = ranges.map(([o, n]) => { const a = Math.max(0, o < 0 ? size + o : o); return [a, Math.min(size, a + n)]; })
        .filter(([a, b]) => b > a && !hit(a, b)).sort((x, y) => x[0] - y[0]), groups = [];
      for (const [a, b] of rs) { const g = groups[groups.length - 1]; if (g && a <= g[1] + gap) g[1] = Math.max(g[1], b); else groups.push([a, b]); }
      await Promise.all(groups.map(([a, b]) => fetchRange(a, b)));
    },
    async read(off, len) { const b = Math.min(off + len, size); if (rec) rec.push([off, b - off]); return ensure(off, b, MISS_MIN); },
    async readExact(ranges, gap = DATA_GAP) {
      await this.prefetch(ranges.map((r) => [r.off, r.len]), gap);
      return Promise.all(ranges.map((r) => ensure(r.off, r.off + r.len, 0)));
    },
  };
}

// ------------------------------------------------------------------------------------------------ GLM file layouts
// Offsets of the flash_lat / flash_lon object headers and the blocks read after them (object header continuations, chunk B-tree
// nodes), [offset, length], negative offset = from the end of the file. Measured on NOAA's GOES-18 files; checked on every use.
const KNOWN_LAYOUTS = [
  // files from 2026-07-10 on (the switch came between the 12 UTC files of Jul-09 and Jul-10): shuffle + deflate, 2048-flash chunks
  { id: 'gs-a', since: Date.UTC(2026, 6, 10), gap: 4096, O: 8, L: 8, lat: 11452, lon: 12009,
    pre: [[11452, 1110], [62019, 170], [120761, 400], [139625, 400], [-6321, 169]] },
  // earlier GOES-18 files: plain 256-flash chunks. Two variants: more than 256 flashes (chunk index early, attributes at 71255) or
  // fewer (attributes at 50295, chunk index written at the end); both are read in the first round
  { id: 'gs-b', since: 0, gap: 12288, O: 8, L: 8, lat: 8531, lon: 8815,
    pre: [[8531, 564], [50295, 595], [58930, 400], [61026, 400], [71255, 595], [-26864, 400], [-24768, 400]] },
];
const LEARNED = new Map();   // bucket -> layouts learned by name in this session, newest first
const SEEN = new Map();      // layout -> [first, last] file start time it fitted in this session
const NEAR_MS = 14 * 864e5;
/** layouts to try for a file of `bucket` starting at t: those that fitted files within 2 weeks first, then the known ones by date */
function layoutsFor(bucket, t, KNOWN = KNOWN_LAYOUTS) {
  const known = KNOWN.filter((l) => t >= l.since).concat(KNOWN.filter((l) => t < l.since));
  const all = [...known, ...(LEARNED.get(bucket) || [])];
  const near = (l) => { const s = SEEN.get(l); return s && t >= s[0] - NEAR_MS && t <= s[1] + NEAR_MS ? 0 : 1; };
  return all.map((l, i) => [near(l), i, l]).sort((a, b) => a[0] - b[0] || a[1] - b[1]).map((x) => x[2]);
}
function remember(bucket, lay, t) {
  const s = SEEN.get(lay); SEEN.set(lay, s ? [Math.min(s[0], t), Math.max(s[1], t)] : [t, t]);
  if (KNOWN_LAYOUTS.includes(lay)) return;
  const a = (LEARNED.get(bucket) || []).filter((l) => l !== lay); a.unshift(lay); if (a.length > 3) a.length = 3; LEARNED.set(bucket, a);
}
const isFlash = (ds, a, sn) => ds.shape.length === 1 && (ds.dtype.kind === 'float' || ds.dtype.kind === 'int') &&
  a.standard_name === sn && /flash/i.test(String(a.long_name || ''));

async function openByLayout(src, lay) {
  const f = new H5File(src); f.O = lay.O; f.L = lay.L;
  const ds = await Promise.all([lay.lat, lay.lon].map(async (a, i) => new H5Dataset(f, a, i ? 'flash_lon' : 'flash_lat', await f.objectHeader(a))));
  const at = await Promise.all(ds.map((d) => d.attrs()));
  if (!isFlash(ds[0], at[0], 'latitude') || !isFlash(ds[1], at[1], 'longitude') || ds[0].shape[0] !== ds[1].shape[0]) throw new Error('layout does not fit');
  return { ds, at };
}
async function openByName(src, size, learn) {
  const f = await H5File.open(src);
  const addrs = await Promise.all(['flash_lat', 'flash_lon'].map((n) => f.resolve(n)));
  if (learn) src.record(true);
  const ds = await Promise.all(addrs.map(async (a, i) => new H5Dataset(f, a, i ? 'flash_lon' : 'flash_lat', await f.objectHeader(a))));
  const at = await Promise.all(ds.map((d) => d.attrs()));
  await Promise.all(ds.map((d) => d.chunks()));
  let lay = null;
  if (learn) {
    const pre = src.record(false).map(([o, n]) => [size - o <= 16384 ? o - size : o, Math.max(n, 400)]);
    lay = { id: 'learned', since: 0, O: f.O, L: f.L, lat: addrs[0], lon: addrs[1], pre };
  }
  return { ds, at, lay };
}
/** dataset values as ww_pull's var(): float64, _FillValue -> NaN, * scale_factor + add_offset (no _Unsigned, as h5py there) */
function values(ds, a, raw) {
  const n = ds.shape[0], t = ds.dtype, le = t.le, dv = new DataView(raw.buffer, raw.byteOffset, raw.byteLength), out = new Float64Array(n);
  const one = (v) => (Array.isArray(v) ? v[0] : v);
  const fill = a._FillValue !== undefined ? one(a._FillValue) : undefined;
  const sf = a.scale_factor !== undefined ? +one(a.scale_factor) : 1, ao = a.add_offset !== undefined ? +one(a.add_offset) : 0;
  for (let i = 0; i < n; i++) {
    let x;
    if (t.kind === 'float') x = t.size === 4 ? dv.getFloat32(4 * i, le) : dv.getFloat64(8 * i, le);
    else if (t.size === 1) x = t.signed ? dv.getInt8(i) : dv.getUint8(i);
    else if (t.size === 2) x = t.signed ? dv.getInt16(2 * i, le) : dv.getUint16(2 * i, le);
    else if (t.size === 4) x = t.signed ? dv.getInt32(4 * i, le) : dv.getUint32(4 * i, le);
    else x = Number(t.signed ? dv.getBigInt64(8 * i, le) : dv.getBigUint64(8 * i, le));
    out[i] = fill !== undefined && x === fill ? NaN : x * sf + ao;
  }
  return out;
}
/** the flashes inside the box, interleaved [lat, lon, ...] */
function inBox(la, lo) {
  const keep = [];
  for (let i = 0; i < la.length; i++) {
    const y = la[i], x = lo[i];
    if (Number.isFinite(y) && Number.isFinite(x) && y >= BOX.lat0 && y <= BOX.lat1 && x >= BOX.lon0 && x <= BOX.lon1) keep.push(y, x);
  }
  return { pts: Float64Array.from(keep), total: la.length };
}

/** one GLM file -> { pts, total, how, requests, bytes } (pts = in-box flashes) */
async function readFile(obj, ctx) {
  const url = `https://${obj.bucket}.s3.amazonaws.com/${obj.key.split('/').map(encodeURIComponent).join('/')}`;
  obj.url = url;
  if (ctx.cache) {
    try { const hit = await ctx.cache.get(url + CACHE_TAG); if (hit != null) { ctx.net.urls.add(url); return { pts: new Float64Array(hit), total: null, how: 'cache', requests: 0, bytes: 0 }; } } catch (e) { /* no cache */ }
  }
  let o, src, how;
  if (ctx.read === 'whole') {
    const r = await ctx.net.get(url);
    if (r.status !== 200) throw Object.assign(new Error(`GET answered ${r.status}`), { status: r.status });
    src = Object.assign(bytesSource(r.u8), { requests: 1, bytes: r.u8.length });
    o = await openByName(src, r.u8.length, false); how = 'whole file';
  } else {
    src = rangeSource(url, obj.size, ctx.net);
    for (const lay of ctx.read === 'by-name' ? [] : layoutsFor(obj.bucket, obj.start, ctx.layouts).slice(0, 2)) {
      try { await src.prefetch(lay.pre, lay.gap || PRE_GAP); o = await openByLayout(src, lay); how = 'layout ' + lay.id; remember(obj.bucket, lay, obj.start); break; } catch (e) { if (e.net || e.status) throw e; }
    }
    if (!o) { o = await openByName(src, obj.size, true); how = 'by name'; remember(obj.bucket, o.lay, obj.start); }
  }
  const ch = await Promise.all(o.ds.map((d) => d.chunks()));
  if (src.prefetch) await src.prefetch(ch.flat().map((k) => [k.addr, k.size]), DATA_GAP);
  const raw = await Promise.all(o.ds.map((d) => d.readAll({ gap: DATA_GAP })));
  const r = inBox(values(o.ds[0], o.at[0], raw[0]), values(o.ds[1], o.at[1], raw[1]));
  if (ctx.cache) { try { await ctx.cache.set(url + CACHE_TAG, r.pts.buffer.slice(0)); } catch (e) { /* no cache */ } }
  return { ...r, how, requests: src.requests, bytes: src.bytes, misses: src.misses || 0 };
}

// ------------------------------------------------------------------------------------------------ listing
async function listFrame(fr, ctx) {
  const d = new Date(fr.start), Y = d.getUTCFullYear(), J = p2(doy(fr.start), 3), H = p2(d.getUTCHours()), M = Math.floor(d.getUTCMinutes() / 10);
  const prefix = `GLM-L2-LCFA/${Y}/${J}/${H}/OR_GLM-L2-LCFA_${fr.plat}_s${Y}${J}${H}${M}`;   // the 30 files of this 10 minutes
  const url0 = `https://${fr.bucket}.s3.amazonaws.com/?list-type=2&prefix=${encodeURIComponent(prefix)}`;
  let xml = null;
  if (ctx.cache) { try { const hit = await ctx.cache.get(url0); if (hit != null) { xml = new TextDecoder().decode(hit); ctx.net.urls.add(url0); } } catch (e) { /* no cache */ } }
  let fromNet = false;
  if (xml == null) {
    xml = ''; let token = null; fromNet = true;
    for (let page = 0; page < 10; page++) {
      const u = url0 + (token ? `&continuation-token=${encodeURIComponent(token)}` : '');
      const r = await ctx.net.get(u, null, { cache: 'no-store' });
      if (r.status !== 200) throw Object.assign(new Error(`${fr.bucket} list answered ${r.status}`), { status: r.status });
      const x = new TextDecoder().decode(r.u8); xml += x;
      const nt = /<NextContinuationToken>([^<]+)<\/NextContinuationToken>/.exec(x);
      if (!/<IsTruncated>true<\/IsTruncated>/.test(x) || !nt) break;
      token = nt[1];
    }
  }
  const items = [], re = /<Contents>([\s\S]*?)<\/Contents>/g; let m;
  while ((m = re.exec(xml))) {
    const k = /<Key>([^<]+)<\/Key>/.exec(m[1]), z = /<Size>(\d+)<\/Size>/.exec(m[1]), lm = /<LastModified>([^<]+)<\/LastModified>/.exec(m[1]);
    if (k) items.push({ key: k[1].replace(/&amp;/g, '&'), size: z ? +z[1] : 0, posted: lm ? Date.parse(lm[1]) : NaN });
  }
  const sel = [];
  for (const it of items) {
    const s = keyStart(it.key); if (!Number.isFinite(s)) continue;
    const t = new Date(s);
    if (s >= fr.start && s < fr.end && t.getUTCMinutes() % 2 === 0 && t.getUTCSeconds() < 20) sel.push({ ...it, start: s, bucket: fr.bucket });
  }
  // keep the listing once it can no longer change what is picked: every slot has a file, or the frame is long over
  const full = fr.slots.every((s) => sel.some((o) => o.start >= s && o.start < s + 20e3));
  if (fromNet && ctx.cache && (full || Date.now() > fr.end + GLM_GAP_AFTER_START_MS)) {
    try { await ctx.cache.set(url0, new TextEncoder().encode(xml).buffer); } catch (e) { /* no cache */ }
  }
  return sel;
}

// ------------------------------------------------------------------------------------------------ the builder
/**
 * BEAM channels 9-11 for frame time t0 (a 10-minute mark, UTC).
 * opts: { fetch, cache, signal, now = Date.now(), read: 'ranges' (default) | 'whole' (one GET per file) | 'by-name' (ranges, no layouts),
 *         asOf: replay only - treat files posted after this time as not posted yet (and now = asOf), layouts: test hook - the known layouts to try }
 * -> { ch: {9, 10, 11: Float32Array(304 * 304)}, ok, missing: [{ ch, what, t, why, pending, kind }], urls, bytes, ms,
 *      requests, ready_at, frames: [{ ch, start, files, used, flashes }], files: [{ ch, key, start, how, requests, bytes, flashes_in_box }] }
 */
export async function buildGLM(t0, opts = {}) {
  const T0 = +(t0 instanceof Date ? t0 : new Date(t0));
  if (!Number.isFinite(T0) || T0 % FRAME_MS !== 0) throw new Error('buildGLM: t0 must be a 10-minute mark (UTC)');
  const tick = () => (globalThis.performance ? globalThis.performance.now() : Date.now()), t1 = tick();
  const asOf = opts.asOf != null ? +new Date(opts.asOf) : null, now = asOf != null ? asOf : opts.now != null ? +new Date(opts.now) : Date.now();
  const ctx = { net: makeNet(opts), cache: opts.cache, read: opts.read || 'ranges', layouts: opts.layouts || KNOWN_LAYOUTS };
  const frames = glmFrames(T0), missing = [], fileRows = [], ch = {};
  const lists = await Promise.all(frames.map((fr) => listFrame(fr, ctx).then((sel) => ({ sel }), (e) => ({ err: e }))));
  const jobs = [];
  frames.forEach((fr, i) => {
    const L = lists[i];
    fr.files = []; fr.used = 0; fr.flashes = 0;
    if (L.err) {
      for (const s of fr.slots) missing.push({ ch: fr.ch, what: 'GLM file', t: iso(s), why: `listing failed: ${L.err.message || L.err}`, pending: true, kind: 'error' });
      return;
    }
    for (const s of fr.slots) {
      const here = L.sel.filter((o) => o.start >= s && o.start < s + 20e3 && (asOf == null || !(o.posted > asOf)));
      if (!here.length) {
        const ent = { ch: fr.ch, what: 'GLM file', t: iso(s) };
        if (now < s + GLM_POSTED_AFTER_START_MS) missing.push({ ...ent, why: `not posted yet (expected by ${iso(s + GLM_POSTED_AFTER_START_MS)})`, pending: true, kind: 'not-posted', retry_at: iso(s + GLM_POSTED_AFTER_START_MS) });
        else if (now < s + GLM_GAP_AFTER_START_MS) missing.push({ ...ent, why: 'late: not in the bucket yet (normally about 30 s after it starts)', pending: true, kind: 'late', retry_at: iso(now + 30e3) });
        else missing.push({ ...ent, why: 'not in the bucket: a gap (the frame is counted from its other files, as the backtest did)', pending: false, kind: 'gap' });
      }
      for (const o of here) { fr.files.push(o); jobs.push({ fr, o }); }
    }
  });
  const res = await Promise.all(jobs.map(({ o }) => readFile(o, ctx).then((r) => ({ r }), (e) => ({ err: e }))));
  const cnt = frames.map(() => new Uint16Array(NPIX));
  jobs.forEach(({ fr, o }, j) => {
    const { r, err } = res[j], fi = frames.indexOf(fr);
    if (err) {
      const gone = err.status === 404 || err.status === 403;
      missing.push({ ch: fr.ch, what: 'GLM file', t: iso(o.start), why: gone ? `listed but not readable (${err.status}): a gap` : `read failed: ${err.message || err}`, pending: !gone, kind: gone ? 'gap' : 'error' });
      fileRows.push({ ch: fr.ch, key: o.key, start: iso(o.start), how: 'failed', requests: 0, bytes: 0, flashes_in_box: null });
      return;
    }
    fr.used++;
    let nIn = 0;
    for (let i = 0; i < r.pts.length; i += 2) { const p = framePixel(r.pts[i], r.pts[i + 1]); if (p >= 0) { cnt[fi][p]++; nIn++; } }
    fr.flashes += nIn;
    fileRows.push({ ch: fr.ch, key: o.key, start: iso(o.start), how: r.how, requests: r.requests, bytes: r.bytes, flashes_in_box: r.pts.length / 2, flashes_in_frame: nIn, flashes_total: r.total, misses: r.misses || 0 });
  });
  frames.forEach((fr, i) => {
    const c = cnt[i], v = new Float32Array(NPIX);
    for (let p = 0; p < NPIX; p++) v[p] = LUT[c[p] > 255 ? 255 : c[p]];
    ch[fr.ch] = v;
    if (fr.used < 4) { const pend = missing.some((m) => m.ch === fr.ch && m.pending); missing.push({ ch: fr.ch, what: 'GLM frame', t: iso(fr.start), why: `only ${fr.used} of 5 sampled files ${pend ? 'so far' : '(the backtest counted fewer than 4 as a GLM gap; no lightning here may be missing data)'}`, pending: pend, kind: pend ? 'incomplete' : 'gap' }); }
  });
  const ok = !missing.some((m) => m.pending || m.kind === 'error') && frames.every((fr) => fr.used >= 4);
  return {
    ch, ok, missing, urls: [...ctx.net.urls], bytes: ctx.net.bytes, ms: Math.round(tick() - t1), requests: ctx.net.requests,
    ready_at: glmEarliestRun(T0).toISOString(),
    frames: frames.map((fr) => ({ ch: fr.ch, start: iso(fr.start), end: iso(fr.end), bucket: fr.bucket, files: fr.files.length, used: fr.used, flashes: fr.flashes })),
    files: fileRows,
  };
}
