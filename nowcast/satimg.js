// nowcast/satimg.js - the Satellite map's pure parts (v018; no DOM, no network): which GIBS level a view needs,
// which tiles cover it and where they land on screen, GIBS's list of image times, the image a radar frame gets and the one before it, the
// day / night weight from the sun's height and the GOES-West / GOES-East weight across the seam near 105 W, the night picture's colours
// (our own curve for GOES band 13, the clean infrared) and the per-pixel blends that put them together. clouds.js fetches, keeps and draws.

export const TILE = 256;
/** each picture's most detailed GIBS level (WMTS capabilities, Nov-09-2026): GeoColor GoogleMapsCompatible_Level7 (about 1 km a pixel),
 *  band 13 _Level6 (about 2 km). Past it the map stretches the picture, smoothly */
export const MAX_LEVEL = { geo: 7, ir: 6 };
/** GOES-West -> GOES-East: both see this band of longitudes well, and their pictures blend across it (satFor's -105 is its middle) */
export const SEAM = [-108, -102];
/** the sun's height (degrees) over which night turns into day: the night picture below DAY[0], GeoColor above DAY[1], blended between */
export const DAY = [0, 10];
/** a new image fades in over the one before it (ms) */
export const FADE_MS = 280;
const D2R = Math.PI / 180, MIN10 = 600e3;
const smooth = (a, b, x) => { const u = Math.max(0, Math.min(1, (x - a) / (b - a))); return u * u * (3 - 2 * u); };
/** sun height (deg) -> 0 (night) .. 1 (day), smooth */
export const dayWeight = (elev) => smooth(DAY[0], DAY[1], elev);
/** longitude -> 0 (GOES-West) .. 1 (GOES-East), smooth across the seam */
export const eastWeight = (lon) => smooth(SEAM[0], SEAM[1], lon);

/** the GIBS level for a map zoom: one to two screen (device) pixels for each picture pixel - a 2x screen gets one level more, and no level
 *  brings more pixels than the screen can show (GIBS's GOES tiles are PNG only: 50-150 KB each) - never past the picture's own most
 *  detailed level (the map stretches it smoothly); the data saver: one level less (a quarter of the tiles) */
export function levelFor(z, dpr, maxLevel, saver = false) {
  const L = Math.floor(z + Math.log2(Math.max(1, dpr || 1)) + 1e-9 - (saver ? 1 : 0));
  return Math.max(0, Math.min(maxLevel, L));
}

// Web Mercator in tile pixels (the map's own CSS px at zoom z)
export const worldX = (lon, z) => ((lon + 180) / 360) * TILE * 2 ** z;
export const worldY = (lat, z) => { const s = Math.sin(Math.max(-85.0511, Math.min(85.0511, lat)) * D2R); return (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * TILE * 2 ** z; };
export const lonAt = (x, z) => (x / (TILE * 2 ** z)) * 360 - 180;
export const latAt = (y, z) => Math.atan(Math.sinh(Math.PI - (2 * Math.PI * y) / (TILE * 2 ** z))) / D2R;

/** the level-L tiles under a view ([w, s, e, n] at map zoom z, w x h CSS px) -> { L, n, s (a tile's CSS px), ox, oy (the view's corner),
 *  x0, x1, y0, y1 }; x may run past the world's edge (wrap it to fetch), rows stay inside it */
export function tilesFor(view, z, L, w, h) {
  const ox = worldX(view[0], z), oy = worldY(view[3], z), s = TILE * 2 ** (z - L), n = 2 ** L;
  return { L, n, s, ox, oy, x0: Math.floor(ox / s), x1: Math.floor((ox + w) / s - 1e-9), y0: Math.max(0, Math.floor(oy / s)), y1: Math.min(n - 1, Math.floor((oy + h) / s - 1e-9)) };
}
/** a CSS-px coordinate on a whole device pixel: tiles drawn edge to edge meet exactly (no gap, no edge drawn twice) */
export const snap = (v, dpr) => Math.round(v * dpr) / dpr;

// GIBS's image times: DescribeDomains answers "start/end/PT10M,..." (a date alone means its midnight, UTC)
const durMs = (p) => { const m = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(p || ''); return m ? (((+m[1] || 0) * 24 + (+m[2] || 0)) * 3600 + (+m[3] || 0) * 60 + (+m[4] || 0)) * 1000 : 0; };
const when = (s) => Date.parse(/^\d{4}-\d\d-\d\d$/.test(s) ? s + 'T00:00:00Z' : s);
/** GIBS DescribeDomains XML -> the layer's image times (ms), ascending */
export function parseDomains(xml) {
  const m = /<Domain>([^<]*)<\/Domain>/.exec(String(xml || '')), out = new Set();
  if (!m) return [];
  for (const part of m[1].split(',')) {
    const [a, b, p] = part.trim().split('/'), t0 = when(a || ''), t1 = b ? when(b) : t0, step = durMs(p);
    if (!Number.isFinite(t0) || !Number.isFinite(t1)) continue;
    if (!(step > 0)) { out.add(t0); continue; }
    for (let t = t0; t <= t1 && out.size < 20000; t += step) out.add(t);
  }
  return [...out].sort((x, y) => x - y);
}
/** the image a radar frame at t gets: the newest at or before it in the layer's list (its gaps respected); with no list, t rounded down
 *  to 10 minutes and never past the newest image known (the v011 rule); null: none */
export function pickTime(t, times, newest = null) {
  if (times && times.length) {
    let lo = 0, hi = times.length - 1, best = null;
    while (lo <= hi) { const mid = (lo + hi) >> 1; if (times[mid] <= t) { best = times[mid]; lo = mid + 1; } else hi = mid - 1; }
    return best;
  }
  return newest == null || !Number.isFinite(newest) ? null : Math.floor(Math.min(t, newest) / MIN10) * MIN10;
}
/** the image before t in the layer's list (v018 fix: GIBS's own, so a gap is never asked for); with no list, 10 minutes earlier (the
 *  v011 rule); null: none */
export function timeBefore(t, times) {
  if (!times || !times.length) return t - MIN10;
  let lo = 0, hi = times.length - 1, best = null;
  while (lo <= hi) { const mid = (lo + hi) >> 1; if (times[mid] < t) { best = times[mid]; lo = mid + 1; } else hi = mid - 1; }
  return best;
}

/** the sun at time t, so that sin(height) = sin(lat) sd + cos(lat) cd cos((lon + h) deg): clouds.js sunElevation (a short form of NOAA's
 *  solar position formulas) split up, so a tile works out its rows and its columns once */
export function solarAt(t) {
  const d = new Date(t);
  const day = (Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - Date.UTC(d.getUTCFullYear(), 0, 0)) / 864e5;
  const hr = d.getUTCHours() + d.getUTCMinutes() / 60, g = (2 * Math.PI / 365) * (day - 1 + (hr - 12) / 24);
  const decl = 0.006918 - 0.399912 * Math.cos(g) + 0.070257 * Math.sin(g) - 0.006758 * Math.cos(2 * g) + 0.000907 * Math.sin(2 * g) - 0.002697 * Math.cos(3 * g) + 0.00148 * Math.sin(3 * g);
  const eqt = 229.18 * (0.000075 + 0.001868 * Math.cos(g) - 0.032077 * Math.sin(g) - 0.014615 * Math.cos(2 * g) - 0.040849 * Math.sin(2 * g));
  return { sd: Math.sin(decl), cd: Math.cos(decl), h: hr * 15 + eqt / 4 - 180 };
}
/** the sun's height (deg) over (lat, lon) */
export const elevationAt = (s, lat, lon) => Math.asin(Math.max(-1, Math.min(1, Math.sin(lat * D2R) * s.sd + Math.cos(lat * D2R) * s.cd * Math.cos((lon + s.h) * D2R)))) / D2R;
/** a tile's day weight, pixel by pixel (at pixel centres) -> Float32Array(256 * 256) */
export function dayGrid(s, z, x, y, out = new Float32Array(TILE * TILE)) {
  const A = new Float64Array(TILE), B = new Float64Array(TILE), K = new Float64Array(TILE);
  for (let r = 0; r < TILE; r++) { const la = latAt(y * TILE + r + 0.5, z) * D2R; A[r] = Math.sin(la) * s.sd; B[r] = Math.cos(la) * s.cd; }
  for (let c = 0; c < TILE; c++) K[c] = Math.cos((lonAt(x * TILE + c + 0.5, z) + s.h) * D2R);
  const s0 = Math.sin(DAY[0] * D2R), s1 = Math.sin(DAY[1] * D2R);
  for (let r = 0; r < TILE; r++) {
    const a = A[r], b = B[r], o = r * TILE;
    for (let c = 0; c < TILE; c++) { const v = a + b * K[c]; out[o + c] = v <= s0 ? 0 : v >= s1 ? 1 : smooth(DAY[0], DAY[1], Math.asin(v) / D2R); }
  }
  return out;
}
/** a tile's GOES-East weight, column by column -> Float32Array(256) */
export function eastColumns(z, x, out = new Float32Array(TILE)) { for (let c = 0; c < TILE; c++) out[c] = eastWeight(lonAt(x * TILE + c + 0.5, z)); return out; }
/** what a tile needs with the sun at s: { day (some of it is lit), night (some is not fully), lo, hi (its lowest and highest sun) },
 *  from a 9 x 9 grid of its points (the sun's height changes slowly across a tile: half a degree to spare) */
export function tileNeeds(s, z, x, y) {
  let lo = 90, hi = -90;
  for (let j = 0; j <= 8; j++) { const la = latAt((y + j / 8) * TILE, z); for (let i = 0; i <= 8; i++) { const e = elevationAt(s, la, lonAt((x + i / 8) * TILE, z)); if (e < lo) lo = e; if (e > hi) hi = e; } }
  return { day: hi > DAY[0] - 0.5, night: lo < DAY[1] + 0.5, lo, hi };
}
/** which satellites a tile needs: GOES-West where some of it is west of the seam's east edge, GOES-East where some is east of its west edge */
export function satsFor(z, x) {
  const n = 2 ** z, xx = ((x % n) + n) % n, w = lonAt(xx * TILE, z), e = lonAt((xx + 1) * TILE, z);
  return { west: w < SEAM[1], east: e > SEAM[0] };
}

/** the night picture's colours - our own curve for band 13's cloud-top temperature (C), warm to cold, linear between the stops:
 *  [C, r, g, b, alpha]. The ground and the warmest low cloud are a dark slate, a little see-through (the map under it shows faintly, so
 *  ocean and land stay apart); cloud gets lighter (greys, a touch cool) as its top gets colder (higher), white by -54 C; the coldest storm
 *  tops then take pale cream, peach, rose and orchid - light and low in colour, darker step by step, never the rain's colours */
export const IR_CURVE = [
  [40, 10, 13, 24, 0.8], [15, 24, 28, 38, 0.82], [0, 54, 59, 68, 0.88], [-12, 102, 106, 114, 0.95], [-24, 150, 154, 160, 1],
  [-36, 198, 200, 204, 1], [-46, 232, 233, 235, 1], [-54, 248, 248, 248, 1], [-64, 255, 241, 214, 1], [-74, 255, 216, 188, 1],
  [-84, 242, 188, 196, 1], [-95, 226, 172, 214, 1]];
/** temperature (C) -> [r, g, b, alpha 0..1] */
export function irColor(c) {
  const K = IR_CURVE;
  if (!(c < K[0][0])) return K[0].slice(1);
  for (let i = 1; i < K.length; i++) if (c >= K[i][0]) { const a = K[i - 1], b = K[i], f = (a[0] - c) / (a[0] - b[0]); return [a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f, a[3] + (b[3] - a[3]) * f, a[4] + (b[4] - a[4]) * f]; }
  return K[K.length - 1].slice(1);
}
// our curve every half degree, +60 .. -140 C, packed 0xAABBGGRR
const NIGHT = (() => { const L = new Uint32Array(401); for (let i = 0; i <= 400; i++) { const c = irColor(60 - i / 2); L[i] = ((Math.round(c[3] * 255) << 24) | (Math.round(c[2]) << 16) | (Math.round(c[1]) << 8) | Math.round(c[0])) >>> 0; } return L; })();
/** temperatures (C, NaN = no data) -> the night picture's pixels, in place (RGBA bytes) */
export function irNightT(d, T) {
  for (let i = 0, o = 0; i < T.length; i++, o += 4) {
    const t = T[i]; if (!(t === t)) { d[o] = d[o + 1] = d[o + 2] = d[o + 3] = 0; continue; }
    const v = NIGHT[Math.max(0, Math.min(400, Math.round((60 - t) * 2)))];
    d[o] = v & 255; d[o + 1] = (v >>> 8) & 255; d[o + 2] = (v >>> 16) & 255; d[o + 3] = v >>> 24;
  }
  return d;
}

/** NASA's band-13 colour table (clouds.js parseColormap: 0xRRGGBB -> C) made ready to read tiles back: its warm grey ramp (-17.6 .. +57 C,
 *  one grey a half degree) and its very cold grey band (-71 .. -80 C, and -92 white) as grey -> C (NaN off the ramp), its coloured entries
 *  as exact colour -> C, and a list for the nearest coloured entry */
export function irTable(cm) {
  const warm = [], cold = [], exact = new Map(), list = [];
  for (const [k, t] of cm) {
    const r = k >> 16, g = (k >> 8) & 255, b = k & 255;
    if (r === g && g === b) (t > -50 ? warm : cold).push([r, t]);
    else { exact.set(k, t); list.push([r, g, b, t]); }
  }
  const ramp = (pts, below) => {
    const out = new Float32Array(256).fill(NaN); pts.sort((a, b) => a[0] - b[0]); if (!pts.length) return out;
    for (let g = 0; g < 256; g++) {
      if (g < pts[0][0]) { if (below) out[g] = pts[0][1]; continue; }
      for (let i = 0; i < pts.length; i++) {
        if (pts[i][0] === g) { out[g] = pts[i][1]; break; }
        if (pts[i][0] > g && i) { const a = pts[i - 1], b = pts[i]; out[g] = a[1] + (b[1] - a[1]) * (g - a[0]) / (b[0] - a[0]); break; }
      }
    }
    return out;
  };
  return { warm: ramp(warm, true), cold: ramp(cold, true), exact, list, near: new Map() };
}
/** the nearest table colour - a coloured entry or a warm grey - for a blend no entry matches (used only where no neighbour is read) */
function nearestEntry(tab, k) {
  let t = tab.near.get(k); if (t !== undefined) return t;
  const r = k >> 16, g = (k >> 8) & 255, b = k & 255, v = Math.max(1, Math.min(193, Math.round((r + g + b) / 3)));
  let best = (r - v) ** 2 + (g - v) ** 2 + (b - v) ** 2; t = tab.warm[v];
  for (const e of tab.list) { const dd = (r - e[0]) ** 2 + (g - e[1]) ** 2 + (b - e[2]) ** 2; if (dd < best) { best = dd; t = e[3]; } }
  if (tab.near.size > 50000) tab.near.clear();
  tab.near.set(k, t); return t;
}
/** a band-13 tile (NASA's colours, RGBA bytes) -> its temperatures (C; NaN = no data), read robustly (v018). Two traps in the table: its
 *  very cold band (-71 .. -80 C) is drawn in greys that look just like the warm greys of the ground and low cloud, and GIBS resamples
 *  the coloured tiles, so the pixels along an edge are blends no table colour matches (read as the nearest colour they made specks of
 *  false storm tops and dark rings round clouds). So: a table colour is read as it is; greys (and near-greys: a grey with a touch of an
 *  edge's colour) form regions, and a region is the cold band only when the table colours around it (next to it, or past one blended
 *  pixel) are mostly storm-top cold (-60 C or colder: the dark reds and pinks either side of that band), else the warm ramp; a blend
 *  takes the median of its read neighbours (3 x 3, else 5 x 5, else 7 x 7), so an edge stays sharp: ground or cloud, never a ring.
 *  tab: irTable() */
export function irTemps(d, tab, out = new Float32Array(d.length >> 2)) {
  const n = d.length >> 2, H = n / TILE, cls = new Uint8Array(n), gv = new Uint8Array(n);   // cls: 0 no data, 1 a table colour, 2 grey, 3 blend, 4 grey read
  for (let i = 0; i < n; i++) {
    const o = i << 2;
    if (!d[o + 3]) { out[i] = NaN; continue; }
    const r = d[o], g = d[o + 1], b = d[o + 2];
    if (Math.max(r, g, b) - Math.min(r, g, b) <= 8) { cls[i] = 2; gv[i] = Math.round((r + g + b) / 3); continue; }
    const k = (r << 16) | (g << 8) | b, t = tab.exact.get(k);
    if (t !== undefined) { out[i] = t; cls[i] = 1; } else { out[i] = nearestEntry(tab, k); cls[i] = 3; }   // a blend: for now, the nearest entry
  }
  const stack = new Int32Array(n), members = new Int32Array(n);
  for (let s = 0; s < n; s++) {
    if (cls[s] !== 2) continue;
    let top = 0, m = 0, cold = 0, warm = 0; stack[top++] = s; cls[s] = 5;   // 5: in the region being walked
    while (top) {
      const i = stack[--top], x = i % TILE, y = (i - x) / TILE; members[m++] = i;
      for (let q = 0; q < 4; q++) {
        const dx = q === 0 ? -1 : q === 1 ? 1 : 0, dy = q === 2 ? -1 : q === 3 ? 1 : 0, xx = x + dx, yy = y + dy;
        if (xx < 0 || xx >= TILE || yy < 0 || yy >= H) continue;
        let j = yy * TILE + xx, c = cls[j], w = 2;
        if (c === 2) { cls[j] = 5; stack[top++] = j; continue; }
        if (c === 3) { const x2 = xx + dx, y2 = yy + dy; if (x2 < 0 || x2 >= TILE || y2 < 0 || y2 >= H) continue; j = y2 * TILE + x2; c = cls[j]; w = 1; }   // past one blend
        if (c === 1) { if (out[j] <= -60) cold += w; else warm += w; }
      }
    }
    const useCold = cold > warm;
    for (let k = 0; k < m; k++) {
      const i = members[k], g = gv[i]; let t = useCold ? tab.cold[g] : tab.warm[g];
      if (!(t === t)) t = useCold ? tab.warm[g] : tab.cold[g];
      out[i] = t; cls[i] = 4;
    }
  }
  const v = new Float32Array(49);
  for (let i = 0; i < n; i++) {
    if (cls[i] !== 3) continue;
    const x = i % TILE, y = (i - x) / TILE;
    for (let R = 1; R <= 3; R++) {
      let k = 0;
      for (let yy = Math.max(0, y - R); yy <= Math.min(H - 1, y + R); yy++) for (let xx = Math.max(0, x - R); xx <= Math.min(TILE - 1, x + R); xx++) {
        const j = yy * TILE + xx; if (cls[j] === 1 || cls[j] === 4) { let p = k++; const t = out[j]; while (p > 0 && v[p - 1] > t) { v[p] = v[p - 1]; p--; } v[p] = t; }
      }
      if (k) { out[i] = v[(k - 1) >> 1]; break; }
    }
  }
  return out;
}
/** where a tile has data (alpha > 0) -> Uint8Array(pixels) of 0 / 1 (kept before a conversion makes clear sky see-through) */
export function validOf(d) { const v = new Uint8Array(d.length >> 2); for (let i = 0, j = 3; i < v.length; i++, j += 4) v[i] = d[j] ? 1 : 0; return v; }

/** one tile from up to four pictures, blended pixel by pixel on premultiplied colour: day = [GOES-West, GOES-East] (GeoColor), night =
 *  [West, East] (the night picture), dayW: one weight a pixel (1 = day; null = all day when there is a day pair, else all night), east:
 *  one weight a column across the seam. A picture counts only where it has data (its alpha, or its own `valid` mask: in the see-through
 *  clouds a clear sky is data too), and the weights of those that do are scaled up to 1 - so the seam blends only where both satellites
 *  have data, and a picture that is missing leaves the other one whole. cap: the most the result covers (the see-through clouds) */
export function composeTile({ out, day = null, night = null, dayW = null, east, cap = 1 }) {
  const P = TILE * TILE, Ls = [day && day[0], day && day[1], night && night[0], night && night[1]];
  const D = Ls.map((l) => (l ? l.data : null)), V = Ls.map((l) => (l && l.valid) || null), dflt = Ls[0] || Ls[1] ? 1 : 0, w = new Float64Array(4);
  for (let i = 0; i < P; i++) {
    const e = east[i & 255], dw = dayW ? dayW[i] : dflt, o = i << 2;
    w[0] = dw * (1 - e); w[1] = dw * e; w[2] = (1 - dw) * (1 - e); w[3] = (1 - dw) * e;
    let W = 0, r = 0, g = 0, b = 0, a = 0;
    for (let pass = 0; pass < 2 && !(W > 0); pass++) {
      if (pass) w.fill(1);   // none of the weighted pictures has data here (GOES-East's edge, GeoColor missing): any picture that has
      for (let k = 0; k < 4; k++) {
        const d = D[k]; if (!d || !(w[k] > 0)) continue;
        const al = d[o + 3]; if (V[k] ? !V[k][i] : !al) continue;
        const wa = w[k] * al; W += w[k]; r += wa * d[o]; g += wa * d[o + 1]; b += wa * d[o + 2]; a += wa;
      }
    }
    if (!(W > 0) || !(a > 0)) { out[o] = out[o + 1] = out[o + 2] = out[o + 3] = 0; continue; }
    out[o] = r / a; out[o + 1] = g / a; out[o + 2] = b / a; out[o + 3] = (a / W) * cap;
  }
  return out;
}
/** a picture of a coarser level stretched into one tile: f = 2^(levels between), (qx, qy) the part of the coarse tile (0 .. f-1);
 *  bilinear on premultiplied colour, the data mask from the nearest pixel -> { data, valid } */
export function upsample(src, f, qx, qy) {
  const d = src.data, sv = src.valid || null, out = new Uint8ClampedArray(TILE * TILE * 4), valid = new Uint8Array(TILE * TILE);
  const at = (q, k) => { const u = Math.max(0, Math.min(TILE - 1, (q * TILE + k + 0.5) / f - 0.5)), i0 = Math.floor(u); return [i0, Math.min(TILE - 1, i0 + 1), u - i0, Math.min(TILE - 1, Math.floor((q * TILE + k) / f))]; };
  const cx = Array.from({ length: TILE }, (_, c) => at(qx, c)), ry = Array.from({ length: TILE }, (_, r) => at(qy, r));
  for (let r = 0; r < TILE; r++) {
    const [y0, y1, fy, yn] = ry[r];
    for (let c = 0; c < TILE; c++) {
      const [x0, x1, fx, xn] = cx[c], o = 4 * (r * TILE + c);
      const p00 = 4 * (y0 * TILE + x0), p10 = 4 * (y0 * TILE + x1), p01 = 4 * (y1 * TILE + x0), p11 = 4 * (y1 * TILE + x1);
      const w00 = (1 - fx) * (1 - fy) * d[p00 + 3], w10 = fx * (1 - fy) * d[p10 + 3], w01 = (1 - fx) * fy * d[p01 + 3], w11 = fx * fy * d[p11 + 3], a = w00 + w10 + w01 + w11;
      if (a > 0) for (let k = 0; k < 3; k++) out[o + k] = (w00 * d[p00 + k] + w10 * d[p10 + k] + w01 * d[p01 + k] + w11 * d[p11 + k]) / a;
      out[o + 3] = a;
      const pn = yn * TILE + xn; valid[r * TILE + c] = sv ? sv[pn] : d[4 * pn + 3] ? 1 : 0;
    }
  }
  return { data: out, valid };
}
