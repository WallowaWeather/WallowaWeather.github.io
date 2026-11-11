// prep_js/glm.js - GOES-East GLM L2 LCFA events -> StormScope's glm_density channels, mirroring earth2studio/data/goes_glm.py
// Derived from NVIDIA Earth2Studio, earth2studio/data/goes_glm.py. Copyright (c) 2024-2026 NVIDIA CORPORATION & AFFILIATES, Apache License 2.0 (licenses/Apache-2.0.txt); re-implemented in JavaScript and changed for this app.
// (GOESGLMGrid(satellite="east") over GOESGLM with the CONUS bbox and tolerance (0, +5 min)) and the model's bilinear regrid
// (LatLonInterpolation, then nan_to_num):
//   - files: hour listings from (t - 20 s) to t + 5 min; keep those whose s-stamp (seconds, tenths dropped) is in [t - 20 s, t + 5 min]
//   - events: event_lat / event_lon / event_time_offset as netCDF4 decodes them (uint16 * scale + offset in float32), time =
//     time_coverage_start + offset (rounded to microseconds), kept when lat in [24.5, 49.5] and lon in [-125, -66], t <= time <= t+5min
//   - binning: [t, t + 5 min) into the 0.1-degree 350 x 700 grid with numpy histogram2d's edges (right-closed last bin), on the float32
//     lon round trip ((lon + 360) % 360, then + 180, % 360, - 180) the pandas / numpy code makes
//   - bilinear onto the tile with LatLonInterpolation's i/j maps (float32) and torch.lerp, NaN (outside the GLM grid) -> 0
// fetchGlm(ctx, t0, tile, tl, grid, {mode: 'range' | 'whole'}) -> { values: Float32Array [6][n] counts, hist, files, events }
import { H5File, httpSource, bytesSource } from './hdf5.js';
import { s3List, s3Get, objectUrl, doy, hourStart, parseYjHMS } from './s3.js';

const MIN = 6e4, fr = Math.fround, FILE_S = 20e3;
const SLOTS = [['G16', Date.UTC(2018, 1, 13), Date.UTC(2025, 3, 4)], ['G19', Date.UTC(2025, 3, 4), Infinity]];
const BUCKETS = { G16: 'noaa-goes16', G17: 'noaa-goes17', G18: 'noaa-goes18', G19: 'noaa-goes19' };
export const glmSatellite = (t) => { for (const [s, a, b] of SLOTS) if (t >= a && t < b) return s; throw new Error('no GOES-East GLM for ' + new Date(t).toISOString()); };
const hourPrefix = (t) => { const d = new Date(t); return `GLM-L2-LCFA/${d.getUTCFullYear()}/${String(doy(t)).padStart(3, '0')}/${String(d.getUTCHours()).padStart(2, '0')}/`; };
/** GOESGLM._parse_filename_start (13 digits after "_s": seconds; the tenths digit is dropped) */
export function glmFileStart(key) {
  const base = key.split('/').pop(), i = base.indexOf('_s'); if (i < 0) return null;
  const s = base.slice(i + 2, i + 15); return /^\d{13}$/.test(s) ? parseYjHMS(s) : null;
}
/** "2025-07-21T10:39:40.0Z" -> microseconds since the epoch (pd.Timestamp(...).to_pydatetime()) */
export function isoToUs(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?/.exec(String(s).trim());
  if (!m) throw new Error('GLM: bad time_coverage_start ' + s);
  const frac = (m[7] || '').padEnd(6, '0').slice(0, 6);
  return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) * 1000 + +frac;
}
/** datetime + timedelta(seconds=float(s)): microseconds rounded half to even (CPython's timedelta) */
function secToUs(s) {
  const whole = Math.trunc(s), frac = s - whole, us = frac * 1e6, r = Math.round(us);
  const even = Math.abs(us - Math.trunc(us)) === 0.5 ? (Math.trunc(us) % 2 === 0 ? Math.trunc(us) : Math.trunc(us) + Math.sign(us)) : r;
  return whole * 1e6 + even;
}
/** numpy searchsorted(edges, v, side='right') */
function ssRight(e, v) { let lo = 0, hi = e.length; while (lo < hi) { const m = (lo + hi) >> 1; if (e[m] <= v) lo = m + 1; else hi = m; } return lo; }
/** netCDF4 auto-scale of a uint16 / int16 variable: data * scale_factor + add_offset in float32 */
function decode16(u8, attrs, dtype) {
  const n = u8.length >> 1, out = new Float32Array(n), uns = String(attrs._Unsigned || '').toLowerCase() === 'true';
  const sf = attrs.scale_factor, ao = attrs.add_offset, le = dtype.le, scaled = sf !== undefined && ao !== undefined && (ao !== 0 || sf !== 1);
  for (let i = 0; i < n; i++) {
    let v = le ? u8[2 * i] | (u8[2 * i + 1] << 8) : (u8[2 * i] << 8) | u8[2 * i + 1];
    if (!uns && v & 0x8000) v -= 0x10000;
    out[i] = scaled ? fr(fr(v * fr(sf)) + fr(ao)) : v;
  }
  return out;
}

/** discover the files of every window (GOESGLM._discover_files) */
export async function discoverGlm(ctx, times, binMin = 5, listCache = new Map()) {
  const wins = times.map((t) => ({ t, tmin: t, tmax: t + binMin * MIN, sat: glmSatellite(t) })), jobs = new Map();
  for (const w of wins) for (let h = hourStart(w.tmin - FILE_S); h <= w.tmax; h += 36e5) jobs.set(`${w.sat}|${hourPrefix(h)}`, [w.sat, hourPrefix(h)]);
  await Promise.all([...jobs].filter(([k]) => !listCache.has(k)).map(async ([k, [sat, pre]]) => listCache.set(k, (await s3List(ctx, 'glm', BUCKETS[sat], pre)).filter((o) => o.key.endsWith('.nc')))));
  const out = [], seen = new Set();
  for (const k of jobs.keys()) for (const o of listCache.get(k)) {
    const fs = glmFileStart(o.key), sat = k.split('|')[0]; if (fs == null) continue;
    for (const w of wins) {
      if (w.sat !== sat) continue;
      if (w.tmin - FILE_S <= fs && fs <= w.tmax) { const id = BUCKETS[sat] + '/' + o.key; if (!seen.has(id)) { seen.add(id); out.push({ sat, bucket: BUCKETS[sat], key: o.key, size: o.size, start: fs }); } break; }
    }
  }
  return { files: out, wins };
}

/** one LCFA file -> { epochUs, lat, lon, off } (event level) or null when it has no events */
async function readEvents(ctx, file, mode, page) {
  let src;
  if (mode === 'whole') src = bytesSource(await s3Get(ctx, 'glm', file.bucket, file.key), { label: file.key });
  else { src = httpSource(objectUrl(file.bucket, file.key), { fetchFn: (u, o) => ctx.fetch('glm', u, o), onBytes: (b) => ctx.count('glm', b), page, prefetch: Math.min(file.size, 32768), prefetchTail: 65536, size: file.size }); ctx.stat('glm').files++; }
  const f = await H5File.open(src), links = await f.rootLinks();
  if (!links.has('event_lat')) return null;
  const dLat = await f.dataset('event_lat'); if (!dLat.shape[0]) return null;
  const [dLon, dOff, rootAttrs] = await Promise.all([f.dataset('event_lon'), f.dataset('event_time_offset'), f.attrs('/')]);
  const [aLat, aLon, aOff, bLat, bLon, bOff] = await Promise.all([dLat.attrs(), dLon.attrs(), dOff.attrs(), dLat.readAll({ gap: 8192 }), dLon.readAll({ gap: 8192 }), dOff.readAll({ gap: 8192 })]);
  return { epochUs: isoToUs(rootAttrs.time_coverage_start), lat: decode16(bLat, aLat, dLat.dtype), lon: decode16(bLon, aLon, dLon.dtype), off: decode16(bOff, aOff, dOff.dtype), bytes: src.bytes };
}

/** LatLonInterpolation's i/j maps for one target (float32 out), NaN outside the GLM grid's hull */
export function glmIJ(lat32, lon32, latC, lonC) {
  const fi = (c, v) => {
    const n = c.length; if (!(v >= c[0] && v <= c[n - 1])) return NaN;
    let k = ssRight(c, v) - 1; if (k >= n - 1) k = n - 2;
    return k + (v - c[k]) / (c[k + 1] - c[k]);
  };
  return [fr(fi(latC, lat32)), fr(fi(lonC, lon32))];
}
/** torch.lerp (CPU, vectorised fmadd form), float32 */
function lerp(a, b, w) { const d = fr(b - a); return Math.abs(w) < 0.5 ? fr(a + w * d) : fr(b + fr(w - 1) * d); }

export async function fetchGlm(ctx, t0, tile, tl, grid, { nIn = 6, stepMin = 10, mode = 'range', page = 8192, concurrency = 12, listCache } = {}) {
  const J = grid.json.glm, n = tl.lat.length, ms0 = Date.now(), binUs = J.bin_minutes * 60e6, [bLatMin, bLonMin, bLatMax, bLonMax] = J.bbox;
  const times = Array.from({ length: nIn }, (_, i) => t0 + (i - nIn + 1) * stepMin * MIN);
  const { files, wins } = await discoverGlm(ctx, times, J.bin_minutes, listCache || new Map());
  const NY = grid.glmLatC.length, NXg = grid.glmLonC.length, hist = new Float32Array(nIn * NY * NXg), le = grid.glmLatEdges, lo = grid.glmLonEdges;
  const nE = le.length, nO = lo.length; let events = 0, kept = 0, done = 0, withEvents = 0;
  const queue = files.slice(), workers = [];
  for (let w = 0; w < Math.min(concurrency, queue.length); w++) workers.push((async () => {
    for (;;) {
      const file = queue.shift(); if (!file) break;
      let ev;
      try { ev = await readEvents(ctx, file, mode, page); } catch (e) {   // GOESGLM._fetch_remote_file: a missing file warns and is skipped
        if (e.code === 'S3_MISSING' || e.code === 'HTTP_404') ev = null; else throw e;
      }
      ctx.progress('glm', ++done / files.length);
      if (!ev) continue;
      withEvents++; events += ev.lat.length;
      for (let i = 0; i < ev.lat.length; i++) {
        const la = ev.lat[i], lon = ev.lon[i];
        if (!(la >= bLatMin && la <= bLatMax && lon >= bLonMin && lon <= bLonMax)) continue;
        const tus = ev.epochUs + secToUs(ev.off[i]);
        for (let ti = 0; ti < nIn; ti++) {
          const w0 = wins[ti].tmin * 1000;
          if (wins[ti].sat !== file.sat || tus < w0 || tus >= w0 + binUs) continue;   // [t, t + 5 min)
          const e360 = fr(fr(lon + 360) % 360), ex = fr(fr(fr(e360 + 180) % 360) - 180);
          let yi = ssRight(le, la), xi = ssRight(lo, ex);
          if (la === le[nE - 1]) yi--; if (ex === lo[nO - 1]) xi--;
          if (yi >= 1 && yi <= nE - 1 && xi >= 1 && xi <= nO - 1) { hist[(ti * NY + yi - 1) * NXg + xi - 1] += 1; kept++; }
          break;
        }
      }
    }
  })());
  await Promise.all(workers);
  const values = glmBilinear(hist, tl, grid, nIn);
  return { values, hist, files: files.length, filesWithEvents: withEvents, events, kept, times, mode, ms: Date.now() - ms0 };
}

/** LatLonInterpolation.forward (bilinear, torch.lerp in float32) + nan_to_num: hist [nIn][350][700] -> values [nIn][n] */
export function glmBilinear(hist, tl, grid, nIn = 6) {
  const n = tl.lat.length, NY = grid.glmLatC.length, NXg = grid.glmLonC.length, values = new Float32Array(nIn * n);
  for (let k = 0; k < n; k++) {
    const [i, j] = glmIJ(tl.lat[k], tl.lon[k], grid.glmLatC, grid.glmLonC);
    if (Number.isNaN(i) || Number.isNaN(j)) continue;   // NaN -> 0
    const i0 = Math.min(NY - 2, Math.max(0, Math.floor(i))), j0 = Math.min(NXg - 2, Math.max(0, Math.floor(j))), di = fr(i - i0), dj = fr(j - j0);
    for (let ti = 0; ti < nIn; ti++) {
      const b = ti * NY * NXg, f00 = hist[b + i0 * NXg + j0], f01 = hist[b + i0 * NXg + j0 + 1], f10 = hist[b + (i0 + 1) * NXg + j0], f11 = hist[b + (i0 + 1) * NXg + j0 + 1];
      values[ti * n + k] = lerp(lerp(f00, f01, dj), lerp(f10, f11, dj), di);
    }
  }
  return values;
}
