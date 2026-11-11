// nowcast/run.js - one nowcast for a place: the newest radar (never older than 15 minutes), the model's box centred on the place (or a
// 3 x 3 "wider area" of boxes 128 km apart, blended by distance from each box's centre, so every point is in some box's middle), the
// ensemble's mean and its chances of rain over 1, 4 and 8 mm/h, and the place's summary. The queue's 'nowcast' job calls runNowcast.
import { boxProjection, tileCentres } from './regrid.js';
import { pointStats, summarize } from './summary.js';
import { pmm } from './ensemble.js';
import { DGMR } from './model.js';

export const THRESHOLDS = [0.2, 1, 4, 8];   // 0.2 = any rain at all (drizzle), for the words; the map's chance is over 1, 4 or 8
const MS = 60e3;

/** -> result { id, t0, made, lat, lon, label, size, km, members, precision, tiles, (Uint16 1/64 mm/h [18][S][S]:) mean (the plain average),
 *  pmm (the average's pattern with the members' intensities: what the map shows), one (member 0: one possible future), prob {1,4,8}
 *  (Uint8 0..255 [18][S][S]), now (Float32 mm/h at t0 [S][S]), snow, summary, ms, ageMin } */
export async function runNowcast({ engine, radar, lat, lon, label = '', wide = false, members = DGMR.ensemble.members, spec = DGMR, now = Date.now(), signal, onProgress = () => {} }) {
  const t0r = performance.now();
  const pts = wide ? tileCentres(lat, lon) : [{ lat, lon }];
  onProgress({ phase: 'radar', frac: 0 });
  const inp = await radar.inputsFor(pts, spec, { now, signal, onStep: (s) => onProgress({ phase: 'radar', frac: 0.15 * (s.step + 1) / s.steps }) });
  const nF = spec.outputs.frames, N = 256 * 256, S = wide ? 256 : 256, km = wide ? 2 : 1;
  const P = boxProjection(lat, lon, S, km);
  // each member's field on the result grid, blended by weight across boxes (members x 18 frames: 4.7 MB a member)
  const mem = Array.from({ length: members }, () => new Float32Array(nF * S * S)), wsum = new Float32Array(S * S);
  let precision = null; const msAll = [];
  for (let ti = 0; ti < pts.length; ti++) {
    const tp = boxProjection(pts[ti].lat, pts[ti].lon, 256, 1);
    // where each result pixel falls in this box, and its weight (1 at the box's centre, 0 at its edge)
    const map = new Int32Array(S * S).fill(-1), wt = new Float32Array(S * S);
    for (let i = 0; i < S; i++) for (let j = 0; j < S; j++) {
      const ll = P.toLatLon(i, j), q = tp.toIJ(ll.lat, ll.lon), y = Math.round(q.i), x = Math.round(q.j);
      if (y < 0 || y > 255 || x < 0 || x > 255) continue;
      const w = wide ? Math.max(0, 1 - Math.abs(q.i - 127.5) / 128) * Math.max(0, 1 - Math.abs(q.j - 127.5) / 128) : 1;
      if (w <= 0) continue;
      map[i * S + j] = y * 256 + x; wt[i * S + j] = w; wsum[i * S + j] += w;
    }
    const r = await engine.nowcast(inp.inputs[ti], { members, signal, keep: false, onFrames: (k, fr) => {
      const A = mem[k];
      for (let f = 0; f < nF; f++) {
        const o = f * S * S, src = fr.subarray(f * N, (f + 1) * N);
        for (let p = 0; p < S * S; p++) { const m = map[p]; if (m >= 0) A[o + p] += src[m] * wt[p]; }
      }
      onProgress({ phase: 'model', frac: 0.15 + 0.85 * ((ti * members + k + 1) / (pts.length * members)), member: k + 1, members, tile: ti + 1, tiles: pts.length });
    } });
    precision = r.precision; msAll.push(...r.ms);
  }
  // per frame: the members (weights divided out), their plain average, its PMM, member 0, and each threshold's chance
  const P2 = S * S, mean = new Uint16Array(nF * P2), pm = new Uint16Array(nF * P2), one = new Uint16Array(nF * P2), prob = {};
  THRESHOLDS.forEach((h) => { prob[h] = new Uint8Array(nF * P2); });
  const q64 = (v) => Math.min(65535, Math.round(Math.max(0, v) * 64));
  for (let f = 0; f < nF; f++) {
    const o = f * P2, fr = mem.map((A) => A.subarray(o, o + P2)), avg = new Float32Array(P2);
    for (let p = 0; p < P2; p++) {
      const w = wsum[p]; if (!(w > 0)) { for (const x of fr) x[p] = 0; continue; }
      let s = 0; for (const x of fr) { x[p] /= w; s += x[p]; } avg[p] = s / members;
      THRESHOLDS.forEach((h) => { let c = 0; for (const x of fr) if (x[p] >= h) c++; prob[h][o + p] = Math.round(c / members * 255); });
    }
    const pf = pmm(avg, fr);
    for (let p = 0; p < P2; p++) { mean[o + p] = q64(avg[p]); pm[o + p] = q64(pf[p]); one[o + p] = q64(fr[0][p]); }
  }
  // the radar at t0 on the result grid (the centre box's newest input frame), for "rain now"
  const nowF = new Float32Array(S * S), cp = boxProjection(lat, lon, 256, 1), last = inp.inputs[Math.floor(pts.length / 2)].subarray(3 * N);
  for (let i = 0; i < S; i++) for (let j = 0; j < S; j++) {
    const ll = P.toLatLon(i, j), q = cp.toIJ(ll.lat, ll.lon), y = Math.round(q.i), x = Math.round(q.j);
    if (y >= 0 && y < 256 && x >= 0 && x < 256) nowF[i * S + j] = last[y * 256 + x] / 32;
  }
  const res = { id: 'nc-' + inp.t0 + '-' + lat.toFixed(2) + ',' + lon.toFixed(2) + (wide ? '-w' : ''), t0: inp.t0, made: Date.now(), lat, lon, label, size: S, km, members, precision,
    tiles: pts.map((p) => ({ lat: p.lat, lon: p.lon })), wide, mean, pmm: pm, one, prob, now: nowF, qc: inp.qc || null, snow: Math.max(...inp.snow), ms: msAll, ageMin: inp.ageMin, totalMs: Math.round(performance.now() - t0r),
    spec: { firstMin: spec.outputs.firstMin, everyMin: spec.outputs.everyMin, frames: nF, model: spec.id } };
  res.summary = summaryAt(res, lat, lon);
  return res;
}
/** the result grid's pixel for a point (or null outside it) */
export function pixelOf(res, lat, lon) {
  const q = boxProjection(res.lat, res.lon, res.size, res.km).toIJ(lat, lon);
  return q.i < 0 || q.j < 0 || q.i > res.size - 1 || q.j > res.size - 1 ? null : q;
}
/** the summary for any point inside a result (null outside it) */
export function summaryAt(res, lat, lon, now = Date.now()) {
  const q = pixelOf(res, lat, lon); if (!q) return null;
  const st = pointStats({ size: res.size, mean: res.pmm || res.mean, prob: res.prob }, q.i, q.j, res.now, res.km === 1 ? 3 : 2);   // rates from the PMM (the members' own intensities)
  const s = summarize(st, { t0: res.t0, now, firstMin: res.spec.firstMin, stepMin: res.spec.everyMin });
  if (res.snow > 0.2) s.snowNote = 'The radar shows snow here; the nowcast shows it as rain.';
  return s;
}
/** the outline of each box (lat / lon corners) for the map */
/** the edge of the area a run forecasts (the map's dashed line: where the nowcast stops) - ONE ring around the whole area. Josh's v018
 *  review (a phone screenshot): a wider-area run is 9 overlapping boxes, and drawing each box's edge put lines right through the place */
export function outlines(res) {
  if (res.size && res.km) return [boxProjection(res.lat, res.lon, res.size, res.km).corners()];   // the run's own grid, as the map draws it
  const ts = res.tiles && res.tiles.length ? res.tiles : [{ lat: res.lat, lon: res.lon }];        // a run kept by an older version
  const cs = ts.flatMap((p) => boxProjection(p.lat, p.lon, 256, 1).corners());
  const n = Math.max(...cs.map((c) => c.lat)), s = Math.min(...cs.map((c) => c.lat)), e = Math.max(...cs.map((c) => c.lon)), w = Math.min(...cs.map((c) => c.lon));
  return [[{ lat: n, lon: w }, { lat: n, lon: e }, { lat: s, lon: e }, { lat: s, lon: w }]];
}
export { MS };
