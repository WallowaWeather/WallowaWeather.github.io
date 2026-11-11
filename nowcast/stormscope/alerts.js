// nowcast/stormscope/alerts.js - PILOT (v057): the app's own alert areas from StormScope's 90 minutes (areas with a high
// chance of bad weather get a box like NWS warnings, filled with a pattern so the two never look alike). No extra model: rules on what StormScope already forecasts (storm-core strength, lightning,
// rain) and on HRRR's type, over all 9 frames. Each hazard's pixels are joined into areas (a 2 km grow, 8-neighbour), small specks are
// dropped, and each area becomes one polygon (its convex hull) with when it starts and how strong it gets. Thresholds are first guesses,
// to be checked against storm reports, MESH and GLM in the scoring run (Part B). Experimental: never an official warning.
'use strict';
import { boxProjection } from '../regrid.js';

export const HAZARDS = [
  { kind: 'hail', label: 'Possible hail', color: '#FF453A', note: 'a storm core of 55 dBZ or more' },
  { kind: 'lightning', label: 'Lightning', color: '#FFB020', note: 'lightning forecast here' },
  { kind: 'flood', label: 'Heavy rain', color: '#30B0C7', note: 'an inch (25 mm) or more of rain within 90 minutes' },
  { kind: 'ice', label: 'Freezing rain or sleet', color: '#FF5FA2', note: 'ice falling (type from NOAA HRRR)' },
  { kind: 'snow', label: 'Heavy snow', color: '#5E9CFF', note: 'snow at about an inch an hour or more (type from NOAA HRRR)' },
];
const MIN_PX = 8;   // 32 km² at 2 km: smaller specks are not an area

/** res = a StormScope result (run_ss.js) -> [{ kind, label, color, note, startMin, endMin, peak, rings: [[[lon, lat], ...]], centre: {lat, lon}, px }] */
export function computeAlerts(res) {
  const S = res.size, N = S * S, nF = res.ready || res.spec.frames, ss = res.ss; if (!ss || !nF) return [];
  const first = {}, peak = {};
  for (const h of HAZARDS) { first[h.kind] = new Uint8Array(N).fill(255); peak[h.kind] = new Float32Array(N); }
  const acc = new Float32Array(N);
  for (let k = 0; k < nF; k++) {
    const o = k * N;
    for (let p = 0; p < N; p++) {
      const rate = res.mean[o + p] / 64, dbz = ss.dbz[o + p] - 20, g = ss.light[o + p] / 16, t = ss.type ? ss.type[o + p] : 0;
      acc[p] += rate * 10 / 60;
      const hit = (kind, v) => { if (first[kind][p] === 255) first[kind][p] = k; if (v > peak[kind][p]) peak[kind][p] = v; };
      if (dbz >= 55) hit('hail', dbz);
      if (g >= 1) hit('lightning', g);
      if (acc[p] >= 25) hit('flood', acc[p]);
      if ((t === 4 || t === 3) && rate >= 0.25) hit('ice', rate);
      if (t === 2 && rate >= 1) hit('snow', rate);
    }
  }
  const P = boxProjection(res.lat, res.lon, S, res.km), out = [];
  for (const h of HAZARDS) {
    const f = first[h.kind], m = new Uint8Array(N);
    for (let i = 0; i < S; i++) for (let j = 0; j < S; j++) {   // grow by one pixel (2 km): neighbouring specks join one area
      if (f[i * S + j] === 255) continue;
      for (let di = -1; di <= 1; di++) for (let dj = -1; dj <= 1; dj++) { const y = i + di, x = j + dj; if (y >= 0 && y < S && x >= 0 && x < S) m[y * S + x] = 1; }
    }
    const lab = new Int32Array(N).fill(-1), stack = [];
    for (let s0 = 0; s0 < N; s0++) {
      if (!m[s0] || lab[s0] >= 0) continue;
      const pts = []; let k0 = 255, k1 = 0, pk = 0; lab[s0] = s0; stack.push(s0);
      while (stack.length) {
        const q = stack.pop(), i = (q / S) | 0, j = q % S; pts.push(q);
        if (f[q] !== 255) { k0 = Math.min(k0, f[q]); k1 = Math.max(k1, f[q]); pk = Math.max(pk, peak[h.kind][q]); }
        for (let di = -1; di <= 1; di++) for (let dj = -1; dj <= 1; dj++) {
          const y = i + di, x = j + dj; if (y < 0 || y >= S || x < 0 || x >= S) continue;
          const r = y * S + x; if (m[r] && lab[r] < 0) { lab[r] = s0; stack.push(r); }
        }
      }
      if (pts.length < MIN_PX || k0 === 255) continue;
      const corners = [];   // every pixel's 4 corners -> the convex hull (an NWS-style polygon)
      let ci = 0, cj = 0;
      for (const q of pts) { const i = (q / S) | 0, j = q % S; ci += i; cj += j; corners.push([j - 0.5, i - 0.5], [j + 0.5, i - 0.5], [j - 0.5, i + 0.5], [j + 0.5, i + 0.5]); }
      const ring = hull(corners).map(([x, y]) => { const ll = P.toLatLon(y, x); return [ll.lon, ll.lat]; });
      ring.push(ring[0]);
      const c = P.toLatLon(ci / pts.length, cj / pts.length);
      out.push({ kind: h.kind, label: h.label, color: h.color, note: h.note, startMin: (k0 + 1) * 10, endMin: (k1 + 1) * 10, peak: +pk.toFixed(1), rings: [ring], centre: { lat: c.lat, lon: c.lon }, px: pts.length });
    }
  }
  return out;
}

/** Andrew's monotone chain -> the convex hull, counter-clockwise */
function hull(pts) {
  const p = pts.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]), cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lo = [], up = [];
  for (const q of p) { while (lo.length >= 2 && cross(lo[lo.length - 2], lo[lo.length - 1], q) <= 0) lo.pop(); lo.push(q); }
  for (let i = p.length - 1; i >= 0; i--) { const q = p[i]; while (up.length >= 2 && cross(up[up.length - 2], up[up.length - 1], q) <= 0) up.pop(); up.push(q); }
  return lo.slice(0, -1).concat(up.slice(0, -1));
}
/** where an alert is from the place, in plain words ("12 km NW of here", "here") */
export function whereOf(a, lat, lon) {
  const dy = (a.centre.lat - lat) * 111.2, dx = (a.centre.lon - lon) * 111.2 * Math.cos(lat * Math.PI / 180), d = Math.hypot(dx, dy);
  if (d < 5) return 'here';
  const dirs = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'], b = (Math.atan2(dx, dy) * 180 / Math.PI + 360 + 22.5) % 360;
  return `${Math.round(d)} km ${dirs[Math.floor(b / 45)]} of here`;
}
