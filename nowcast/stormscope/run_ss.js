// nowcast/stormscope/run_ss.js - PILOT (v056): one StormScope nowcast for a place, in the same result shape as run.js (so the map,
// the timeline, the summary and the store take it unchanged), plus what only StormScope has: lightning, storm-core strength and the
// timing of each part. Each 10-minute frame is converted and published the moment the model has it (onFrame): the screen's loop grows
// while the rest runs. One member (StormScope is 7 model passes a frame).
'use strict';
import { prepareStormScope, loadGrid } from './prep/index.js';
import { tileFor } from './prep/tile.js';
import { cropRC } from './lcc.js';
import { hrrrTypes } from './type.js';
import { computeAlerts } from './alerts.js';
import { trackAlerts, ladderAlerts } from './ladder.js';   // v003: the yellow -> red ladder
import { boxProjection } from '../regrid.js';
import { summaryAt, THRESHOLDS } from '../run.js';

export const STORMSCOPE = {
  id: 'stormscope', name: 'StormScope', label: 'Pilot · NVIDIA StormScope, not retrained',
  outputs: { frames: 9, firstMin: 10, everyMin: 10 },
  credit: 'Nowcast: NVIDIA StormScope (NVIDIA Open Model License), modified',
  licence: { id: 'NVIDIA Open Model License', url: 'https://www.nvidia.com/en-us/agreements/enterprise-software/nvidia-open-model-license/',
    notice: 'Licensed by NVIDIA Corporation under the NVIDIA Open Model License', source: 'https://huggingface.co/nvidia/stormscope-goes-mrms',
    changes: 'Modified for this app: quantised to 8-bit integers and run as WebGPU kernels; the satellite input is held at its newest image.',
    limits: 'Experimental. Trained on the central and eastern US; radar gaps (mountains, far from a radar) make it less sure. For warnings, follow the National Weather Service.' },
};
const S = 256, KM = 2, CORE_DBZ = 55, LIGHT = 1, NEAR_KM = 10;
const rateOf = (dbz) => (dbz < 10 ? 0 : Math.min(128, Math.pow(Math.pow(10, dbz / 10) / 200, 1 / 1.6)));   // Marshall-Palmer Z = 200 R^1.6
/** a seeded standard normal stream (Box-Muller on mulberry32): the run's noise, the same for the same radar time */
function normals(n, seed) {
  let a = seed >>> 0; const u = () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const out = new Float32Array(n);
  for (let i = 0; i < n; i += 2) { const r = Math.sqrt(-2 * Math.log(u() || 1e-12)), th = 2 * Math.PI * u(); out[i] = r * Math.cos(th); if (i + 1 < n) out[i + 1] = r * Math.sin(th); }
  return out;
}

/** -> the result (run.js shape + .ready, .ss); onFrame(res, k) after each frame; onProgress({ phase, frac, text }) */
export async function runStormScope({ engine, lat, lon, label = '', now = Date.now(), signal, onProgress = () => {}, onFrame = () => {}, layers = null, area = null }) {
  const t0r = performance.now();
  onProgress({ phase: 'grid', frac: 0, text: 'Opening StormScope…' });
  const grid = await engine.grid(loadGrid);
  const dataP = (p) => onProgress({ phase: 'data', frac: 0.25 * (p.frac || 0), text: `Getting radar, satellite and lightning · ${(p.bytes / 1e6 || 0).toFixed(1)} MB`, source: p.source });
  // v057: the layers kept fresh while the screen is up: only what is missing is fetched (usually nothing), then a 0.05 s assembly
  let prep = null, fetched = null;
  if (layers) { try {
    const st = layers.status(), tt = tileFor(lat, lon, { grid }), sameTile = layers.tileKey === `${tt.y0},${tt.x0},${tt.h},${tt.w}`;
    const fresh = st && st.ready && sameTile && Date.now() - st.lastAt < 60e3;   // this place's tile, refreshed under a minute ago: as is
    if (!fresh) fetched = await layers.ensure({ lat, lon, signal, onProgress: dataP });
    prep = layers.assemble(); } catch (e) { if (e && e.name === 'AbortError') throw e; prep = null; } }
  if (!prep) prep = await prepareStormScope({ lat, lon, grid, signal, onProgress: dataP });
  else prep.bytes = { mrms: 0, goes: 0, glm: 0, cached: true, fetchedNow: fetched ? fetched.bytes : 0 }, prep.ms = Object.assign(prep.ms, { layers: fetched ? fetched.ms : 0 });
  const tile = prep.tile, H = tile.y1 - tile.y0, W = tile.x1 - tile.x0, HW = H * W, nF = STORMSCOPE.outputs.frames;   // 200 or 204 a side
  // the result grid (512 km at 2 km, centred on the place) -> the tile's pixel (nearest)
  const P = boxProjection(lat, lon, S, KM), map = new Int32Array(S * S).fill(-1);
  for (let i = 0; i < S; i++) for (let j = 0; j < S; j++) {
    const ll = P.toLatLon(i, j), q = cropRC(ll.lat, ll.lon), r = Math.round(q.r) - tile.y0, c = Math.round(q.c) - tile.x0;
    if (r >= 0 && r < H && c >= 0 && c < W) map[i * S + j] = r * W + c;
  }
  const near = [];   // result pixels within NEAR_KM of the place
  for (let i = 0; i < S; i++) for (let j = 0; j < S; j++) if (Math.hypot(i - (S - 1) / 2, j - (S - 1) / 2) * KM <= NEAR_KM) near.push(i * S + j);
  const P2 = S * S, mean = new Uint16Array(nF * P2), prob = {}, dbz = new Uint8Array(nF * P2), light = new Uint8Array(nF * P2);
  THRESHOLDS.forEach((h) => { prob[h] = new Uint8Array(nF * P2); });
  // rain now: the newest radar input (channel 58 = refc at t0), the same conversion
  const nowF = new Float32Array(P2);
  for (let p = 0; p < P2; p++) { const m = map[p]; if (m >= 0 && prep.valid[m]) nowF[p] = rateOf(prep.cond[58 * HW + m] * prep.std[0] + prep.mean[0]); }
  const res = { id: 'ss-' + prep.t0 + '-' + lat.toFixed(2) + ',' + lon.toFixed(2), t0: prep.t0, made: Date.now(), lat, lon, label, size: S, km: KM, members: 1, precision: 'int8',
    tiles: [], wide: false, mean, pmm: mean, one: mean, prob, now: nowF, qc: null, snow: 0, ms: [], ageMin: (now - prep.t0) / 60e3, ready: 0,
    spec: { firstMin: STORMSCOPE.outputs.firstMin, everyMin: STORMSCOPE.outputs.everyMin, frames: nF, model: 'stormscope' },
    ss: { dbz, light, tile, bytes: prep.bytes, prepMs: prep.ms, loadMs: 0, stepMs: [], flags: [] } };
    let tracks = []; try { tracks = trackAlerts(prep, { lat, lon }, area); } catch (e) { tracks = []; } res.ss.tracks = tracks; res.ss.alerts = ladderAlerts([], tracks); // v003: yellow alerts from radar before model runs
  // what falls (HRRR's rain / snow / sleet / freezing rain), fetched while the model loads; without it the frames are rain-or-nothing
  const kept = layers && prep.bytes && prep.bytes.cached ? layers.types(prep.t0) : null;   // v057: fetched with the layers
  const typeP = kept ? Promise.resolve(kept) : hrrrTypes({ t0: prep.t0, tile, H, W, signal }).catch(() => null);
  const type = new Uint8Array(nF * P2); res.ss.type = type;
  onProgress({ phase: 'load', frac: 0.27, text: 'Loading StormScope…' });
  const li = await engine.load({ rope_cos: prep.rope_cos, rope_sin: prep.rope_sin }, { H, W }); res.ss.loadMs = Math.round(li.seconds * 1000);
  const ty = await typeP; res.ss.typeInfo = ty ? { cycle: ty.cycle, bytes: ty.bytes, ms: ty.ms } : null;
  const lat0 = normals(9 * 3 * HW, (prep.t0 / 60e3) | 0);
  const firstType = { 2: -1, 3: -1, 4: -1 };
  const q64 = (v) => Math.min(65535, Math.round(Math.max(0, v) * 64));
  let firstLight = -1, firstCore = -1, coreMax = 0;
  await engine.forecast({ cond: prep.cond, latents: lat0, valid: prep.valid, cz: prep.cz, mean: prep.mean, std: prep.std }, { signal, onStep: (k, out, ms) => {
    const o = k * P2;
    for (let p = 0; p < P2; p++) {
      const m = map[p]; if (m < 0 || !prep.valid[m]) continue;
      const d = out[m] * prep.std[0] + prep.mean[0], r = rateOf(d), g = Math.max(0, Math.expm1(out[2 * HW + m]));
      mean[o + p] = q64(r); dbz[o + p] = Math.max(0, Math.min(255, Math.round(d + 20)));   // dBZ + 20 (so -20 ... 235 fits a byte)
      light[o + p] = Math.min(255, Math.round(g * 16));
      THRESHOLDS.forEach((h) => { prob[h][o + p] = r >= h ? 255 : 0; });
      if (ty && r >= 0.1) type[o + p] = ty.codes[k * HW + m] || 1;
    }
    for (const p of near) { const t = type[o + p]; if (t >= 2 && firstType[t] < 0 && mean[o + p] >= 0.2 * 64) firstType[t] = k; }
    let dMax = 0, gMax = 0; for (const p of near) { dMax = Math.max(dMax, dbz[o + p] - 20); gMax = Math.max(gMax, light[o + p] / 16); }
    if (firstLight < 0 && gMax >= LIGHT) firstLight = k; if (firstCore < 0 && dMax >= CORE_DBZ) firstCore = k; coreMax = Math.max(coreMax, dMax);
    res.ms.push(ms); res.ss.stepMs.push(ms); res.ready = k + 1;
    res.ss.alerts = ladderAlerts(computeAlerts(res), tracks);   // v003: the ladder: yellow (radar), StormScope's areas, red (damaging within 30 min)
    onProgress({ phase: 'model', frac: 0.3 + 0.7 * (k + 1) / nF, text: k + 1 < nF ? `StormScope · +${(k + 2) * 10} min working…` : 'StormScope · done', frame: k + 1, frames: nF });
    onFrame(res, k);
  } });
  const flags = [];
  if (firstLight >= 0) flags.push({ kind: 'lightning', min: (firstLight + 1) * 10, text: firstLight === 0 ? 'Lightning likely here within 10 minutes' : `Lightning likely here in about ${(firstLight + 1) * 10} minutes` });
  if (firstCore >= 0) flags.push({ kind: 'core', min: (firstCore + 1) * 10, dbz: coreMax, text: `Strong storm core near here (${Math.round(coreMax)} dBZ) in about ${(firstCore + 1) * 10} minutes: possible hail` });
  const word = { 4: 'Freezing rain', 3: 'Sleet', 2: 'Snow' };
  for (const t of [4, 3, 2]) if (firstType[t] >= 0) flags.push({ kind: t === 2 ? 'snow' : 'ice', min: (firstType[t] + 1) * 10, text: `${word[t]} likely here in about ${(firstType[t] + 1) * 10} minutes (type from NOAA's HRRR)` });
  res.ss.flags = flags; res.totalMs = Math.round(performance.now() - t0r);
  res.ss.timing = { totalMs: res.totalMs, dataMs: prep.bytes.cached ? (prep.ms.layers || 0) : Math.max(prep.ms.mrms || 0, prep.ms.goes || 0, prep.ms.glm || 0), prepMs: prep.ms.cond || 0, loadMs: res.ss.loadMs,
    modelMs: res.ss.stepMs.reduce((a, b) => a + b, 0), cached: !!prep.bytes.cached,
    mb: prep.bytes.cached ? (prep.bytes.fetchedNow || 0) / 1e6 : ((prep.bytes.mrms || 0) + (prep.bytes.goes || 0) + (prep.bytes.glm || 0)) / 1e6 };
  res.summary = summaryAt(res, lat, lon);
  return res;
}
