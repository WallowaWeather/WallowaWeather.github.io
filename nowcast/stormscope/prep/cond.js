// prep_js/cond.js - StormScope MRMS-model condition for one tile, built on the phone from live public data. ONE entry point:
// Derived from NVIDIA Earth2Studio, earth2studio/models/px/stormscope.py (the condition and its normalisation). Copyright (c) 2024-2026 NVIDIA CORPORATION & AFFILIATES, Apache License 2.0 (licenses/Apache-2.0.txt); re-implemented in JavaScript and changed for this app.
// The solar-angle arithmetic follows climt's zenith code via NVIDIA PhysicsNeMo: Copyright (c) 2016, Rodrigo Caballero, BSD (licenses/BSD-3-Clause-climt.txt).
//   const grid = await loadGrid(arrayBuffer, json)      (re-exported from grid.js)
//   const r = await prepareStormScope({ lat, lon, t0, grid, signal, onProgress })
//   -> { cond: Float32Array [72*H*W], valid: Uint8Array [H*W], cz: Float32Array [9*2*H*W], mean: [2], std: [2], rope_cos, rope_sin,
//        tile: {y0, y1, x0, x1, h, w}, t0, bytes: {mrms, goes, glm}, ms: {mrms, goes, glm, cond}, files: {...} }
// The 72 channels are exactly StormScopeMRMS.build_condition's order (the first half of StormScopeBase._forward, as phone_pack.py's
// condition_of): [0..47] GOES (lead-major: t-50 abi01c .. abi13c, ..., t0) | [48..59] MRMS refc, refc_base per lead |
// [60..65] GLM log1p per lead | 66 lat | 67 lon | 68 cos-zenith(t0) | 69 cos-zenith(t0+10) | 70 nexrad_proximity | 71 topo.
// cz[s] = the two cos-zenith maps for forecast step s+1 (t0 + 10 s and t0 + 10 (s+1)). Pure ES module (browser + Node 18+).
import { loadGrid, tileLatLon, cutTile } from './grid.js';
import { tileFor } from './tile.js';
import { makeCtx, s3List, ymd, hms } from './s3.js';
import { fetchMrms } from './mrms_ss.js';
import { fetchGoes, satelliteFor, listGoesHours, pickGoesFile, scanStart } from './goes.js';
import { fetchGlm, discoverGlm } from './glm.js';

export { loadGrid, tileFor };
const fr = Math.fround, MIN = 6e4;

// ------------------------------------------------------------------------------------------------------------ cos zenith
// physicsnemo.utils.zenith_angle.cos_zenith_angle(time, lon, lat) on float32 numpy lon / lat (deg -> rad in float32), float64 solar
// position, np.sin / np.cos of the float32 latitude in float32, result float64 -> float32 (build_condition's .to(x.dtype)).
const DEG2RAD_F = fr(fr(Math.PI) / 180), DEG2RAD = Math.PI / 180;
const T2000_MS = Date.UTC(2000, 0, 1, 12, 0, 0);
function solar(tMs) {
  const jc = ((tMs - T2000_MS) / 864e5) / 36525.0;
  const theta = 67310.54841 + jc * (876600 * 3600 + 8640184.812866 + jc * (0.093104 - jc * 6.2e-6));
  const gmst = ((theta / 240.0) * DEG2RAD) % (2 * Math.PI);
  const eps = (23.0 + 26.0 / 60 + 21.406 / 3600.0 - (46.836769 * jc - 0.0001831 * (jc * jc) + 0.0020034 * jc ** 3 - 0.576e-6 * jc ** 4 - 4.34e-8 * jc ** 5) / 3600.0) * DEG2RAD;
  const ma = (357.5291 + 35999.0503 * jc - 0.0001559 * jc * jc - 0.00000048 * jc * jc * jc) * DEG2RAD;
  const ml = (280.46645 + 36000.76983 * jc + 0.0003032 * (jc * jc)) * DEG2RAD;
  const dl = ((1.9146 - 0.004817 * jc - 0.000014 * (jc * jc)) * Math.sin(ma) + (0.019993 - 0.000101 * jc) * Math.sin(2 * ma) + 0.00029 * Math.sin(3 * ma)) * DEG2RAD;
  const eclon = ml + dl, x = Math.cos(eclon), y = Math.cos(eps) * Math.sin(eclon), z = Math.sin(eps) * Math.sin(eclon), r = Math.sqrt(1.0 - z * z);
  return { gmst, dec: Math.atan2(z, r), ra: 2 * Math.atan2(y, x + r) };
}
/** cos zenith for every tile pixel at time tMs -> Float32Array (lat, lon float32 degrees, lon in [0, 360)) */
export function cosZenith(tMs, lat, lon, out = new Float32Array(lat.length), o = 0) {
  const { gmst, dec, ra } = solar(tMs), sd = Math.sin(dec), cd = Math.cos(dec);
  for (let k = 0; k < lat.length; k++) {
    const la = fr(lat[k] * DEG2RAD_F), lo = fr(lon[k] * DEG2RAD_F), h = gmst + lo - ra;
    out[o + k] = fr(fr(Math.sin(la)) * sd + fr(Math.cos(la)) * cd * Math.cos(h));
  }
  return out;
}

// ------------------------------------------------------------------------------------------------------------ assembly
/** the condition from the per-source raw values (Earth2Studio normalisation + fills) */
export function assembleCondition({ grid, tile, tl, goes, mrms, glm, t0 }) {
  const N = grid.json.norm, n = tl.lat.length, cond = new Float32Array(72 * n), nIn = 6;
  const cov = cutTile(grid.coverage, grid.W, tile), valid = new Uint8Array(n);
  for (let k = 0; k < n; k++) valid[k] = mrms.nn.valid[k] && cov[k] ? 1 : 0;   // input interpolator mask AND the NEXRAD coverage mask
  // GOES: conditioning_valid_mask = GOES interpolator mask; (x - mean) / std; NaN -> 0 (Flash MRMS); invalid -> 0
  for (let lt = 0; lt < nIn; lt++) for (let b = 0; b < 8; b++) {
    const m = fr(N.cond_means[b]), s = fr(N.cond_stds[b]), src = (lt * 8 + b) * n, dst = (lt * 8 + b) * n;
    for (let k = 0; k < n; k++) {
      if (!goes.nn.valid[k]) { cond[dst + k] = 0; continue; }
      const v = goes.values[src + k], a = fr(fr(v - m) / s);
      cond[dst + k] = Number.isNaN(a) ? 0 : a;
    }
  }
  // MRMS: prep_input (x <= -20 -> -10), (x - mean) / std, invalid -> _INPUT_INVALID_FILL_CONSTANT
  const missing = [];
  for (let lt = 0; lt < nIn; lt++) for (let v = 0; v < 2; v++) {
    const m = fr(N.state_means[v]), s = fr(N.state_stds[v]), src = (lt * 2 + v) * n, dst = (48 + lt * 2 + v) * n;
    for (let k = 0; k < n; k++) {
      if (!valid[k]) { cond[dst + k] = N.invalid_fill; continue; }
      let x = mrms.values[src + k];
      if (Number.isNaN(x)) { missing.push([lt, v]); break; }
      if (x <= N.mrms_low_dbz) x = N.mrms_low_fill;
      cond[dst + k] = fr(fr(x - m) / s);
    }
  }
  if (missing.length) throw Object.assign(new Error('MRMS frame missing for ' + JSON.stringify(missing.map(([lt, v]) => `t${(lt - 5) * 10} ${N.state_vars[v]}`))), { code: 'MRMS_MISSING' });
  // GLM: log1p, invalid -> 0
  for (let lt = 0; lt < nIn; lt++) {
    const dst = (60 + lt) * n;
    for (let k = 0; k < n; k++) cond[dst + k] = valid[k] ? fr(Math.log1p(glm.values[lt * n + k])) : 0;
  }
  // lat / lon features, cos zenith, statics
  for (let k = 0; k < n; k++) {
    cond[66 * n + k] = fr(fr(tl.lat[k] - N.lat_center) / N.lat_scale);
    const sl = fr(fr(fr(tl.lon[k] + 180.0) % 360.0) - 180.0);
    cond[67 * n + k] = fr(fr(sl - N.lon_center) / N.lon_scale);
  }
  cosZenith(t0, tl.lat, tl.lon, cond, 68 * n);
  cosZenith(t0 + 10 * MIN, tl.lat, tl.lon, cond, 69 * n);
  cond.set(cutTile(grid.nexrad, grid.W, tile), 70 * n);
  cond.set(cutTile(grid.topo, grid.W, tile), 71 * n);
  const nSteps = grid.json.times.n_cz_steps, cz = new Float32Array(nSteps * 2 * n);
  for (let s = 0; s < nSteps; s++) { cosZenith(t0 + 10 * s * MIN, tl.lat, tl.lon, cz, (2 * s) * n); cosZenith(t0 + 10 * (s + 1) * MIN, tl.lat, tl.lon, cz, (2 * s + 1) * n); }
  return { cond, valid, cz };
}

// ------------------------------------------------------------------------------------------------------------ newest complete t0
/** the newest 10-min t0 (at most `tries` back) whose inputs are all posted: the GOES scan GOES._get_s3_path picks starts after t0
 *  (GOES-East CONUS scans start ~1:18 after), a GLM file starting at or after t0 + 5 min exists (so the [t0, t0 + 5 min) bin is
 *  complete) and a MergedReflectivityQCComposite frame within [t0, t0 + 2 min] exists (no later file can be nearer to t0) */
export async function newestT0(ctx, now = Date.now(), { tries = 4 } = {}) {
  let t0 = Math.floor((now - 5 * MIN) / (10 * MIN)) * 10 * MIN;
  for (let i = 0; i < tries; i++, t0 -= 10 * MIN) {
    const sat = satelliteFor(t0), gl = await listGoesHours(ctx, sat, [t0], new Map());
    const g = pickGoesFile([...gl.values()].flat(), t0);
    if (!g || !(scanStart(g.key) > t0 && scanStart(g.key) < t0 + 5 * MIN)) continue;
    const { files } = await discoverGlm(ctx, [t0 + 5 * MIN], 0, new Map());
    if (!files.some((f) => f.start >= t0 + 5 * MIN)) continue;
    const day = ymd(t0), P = 'MergedReflectivityQCComposite_00.50', pre = `CONUS/${P}/${day}/`;
    const m = await s3List(ctx, 'mrms', 'noaa-mrms-pds', pre, { startAfter: `${pre}MRMS_${P}_${day}-${hms(t0)}`, maxKeys: 3, limit: 3 });
    const tm = m.map((o) => /-(\d{2})(\d{2})(\d{2})\.grib2\.gz$/.exec(o.key)).filter(Boolean).map((x) => t0 - (t0 % 864e5) + (+x[1]) * 36e5 + (+x[2]) * 6e4 + (+x[3]) * 1e3);
    if (!tm.some((t) => t >= t0 && t <= t0 + 2 * MIN)) continue;
    return t0;
  }
  throw Object.assign(new Error('no complete StormScope input time in the last ' + tries * 10 + ' minutes'), { code: 'NO_T0' });
}

// ------------------------------------------------------------------------------------------------------------ the entry point
export async function prepareStormScope({ lat, lon, t0, grid, signal, onProgress, fetchFn, glmMode = 'range', tile, debug = false, serial = false } = {}) {
  if (!grid) throw new Error('prepareStormScope: grid pack not loaded (loadGrid)');
  const ctx = makeCtx({ fetchFn, signal, onProgress });
  if (t0 == null) t0 = await newestT0(ctx);
  if (t0 % (10 * MIN)) throw Object.assign(new Error('t0 must be on a 10-minute boundary'), { code: 'T0_ALIGN' });
  tile = tile || tileFor(lat, lon, { grid });
  const tl = tileLatLon(tile, grid), ms = {}, T = Date.now();
  const jobs = [
    () => fetchMrms(ctx, t0, tile, tl, grid).then((r) => { ms.mrms = r.ms; return r; }),
    () => fetchGoes(ctx, t0, tile, tl, grid).then((r) => { ms.goes = r.ms; return r; }),
    () => fetchGlm(ctx, t0, tile, tl, grid, { mode: glmMode }).then((r) => { ms.glm = r.ms; return r; }),
  ];
  let mrms, goes, glm;   // the three sources run concurrently (serial: one after another, for clean per-source timings)
  if (serial) { mrms = await jobs[0](); goes = await jobs[1](); glm = await jobs[2](); } else [mrms, goes, glm] = await Promise.all(jobs.map((j) => j()));
  const tc = Date.now(), { cond, valid, cz } = assembleCondition({ grid, tile, tl, goes, mrms, glm, t0 });
  ms.cond = Date.now() - tc; ms.total = Date.now() - T;
  const rope = grid.rope(tile.h / 4, tile.w / 4), N = grid.json.norm;
  const bytes = { mrms: ctx.stat('mrms').bytes, goes: ctx.stat('goes').bytes, glm: ctx.stat('glm').bytes };
  return {
    cond, valid, cz, mean: N.state_means.slice(0, 2), std: N.state_stds.slice(0, 2), rope_cos: rope.cos, rope_sin: rope.sin,
    tile: { y0: tile.y0, y1: tile.y1, x0: tile.x0, x1: tile.x1, h: tile.h, w: tile.w }, H: tile.h, W: tile.w, t0, bytes, ms,
    requests: { mrms: ctx.stat('mrms').requests, goes: ctx.stat('goes').requests, glm: ctx.stat('glm').requests },
    files: { mrms: mrms.files, goes: goes.files, goes_satellite: goes.satellite, glm: { files: glm.files, with_events: glm.filesWithEvents, events: glm.events, kept: glm.kept, mode: glm.mode } },
    nn_fixed: { mrms: mrms.nn.fixed, goes: goes.nn.fixed },
    ...(debug ? { _debug: { goes, mrms, glm, tl } } : {}),
  };
}
