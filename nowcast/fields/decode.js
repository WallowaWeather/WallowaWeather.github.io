// nowcast/fields/decode.js - HRRR GRIB2 messages -> the map's grid: decoded (the app's own HRRR decoder, nowcast/beam/inputs/hrrr/
// grib2_frame.js: grid template 3.30, data templates 5.0 and 5.3, values exactly as ecCodes gives them), cut to the HRRR rows / columns
// the view needs, and resampled (bilinear, at each cell's centre) onto a lat / lon grid the map draws like today's drawGrid:
//   grid = { top, left, dlat, dlon, rows, cols }: row r spans lat top - r * dlat .. top - (r + 1) * dlat (row 0 = north), column c
//   spans lon left + c * dlon .. (+ dlon); cells off HRRR's domain are NaN (transparent).
// A product per map (display units): wind { values: mph, u, v: east / north m/s }, temp { values: F }, rh { values: % },
// pressure { values: hPa (MSLMA, the MAPS mean-sea-level reduction NWS uses for HRRR) }, precip { values: mm/h, type: 0 none,
// 1 rain, 2 snow, 3 sleet, 4 freezing rain (the most hazardous wins where several are set, as the app's StormScope types), layers }.
// Pure (page, worker, Node).
'use strict';
import { readHeader, decodeFrame } from '../beam/inputs/hrrr/grib2_frame.js';
import { hrrrIJ } from '../stormscope/lcc.js';
import { msToMph, kToF, paToHpa, rotationDeg } from './units.js';

export const MAX_CELLS = 400000;
/** the HRRR domain's lat / lon envelope (its corners: 21.1-52.6 N, 134.1-60.9 W) */
export const DOMAIN = { w: -134.2, s: 21.1, e: -60.8, n: 53.0 };
/** grid steps offered (degrees of latitude, ~sqrt 2 apart). 0.025 is about HRRR's own 3 km; the finer steps (zoomed in) are bilinear
 *  between HRRR's points, so a map that draws cells as blocks (today's drawGrid) still looks smooth */
export const STEPS = [0.003, 0.0043, 0.006, 0.0085, 0.012, 0.017, 0.025, 0.035, 0.05, 0.07, 0.1, 0.14, 0.2, 0.28, 0.4];

const u32 = (b, p) => ((b[p] << 24) >>> 0) + (b[p + 1] << 16) + (b[p + 2] << 8) + b[p + 3];
/** HRRR's 3 km CONUS grid as its template 3.30 says it (micro-degrees, mm): frameFor and gridIJ assume it (BEAM's reader checks it too) */
export const HRRR_GRID = { nx: 1799, ny: 1059, la1: 21138123, lo1: 237280472, lad: 38500000, lov: 262500000, dx: 3000000, dy: 3000000, latin1: 38500000, latin2: 38500000 };
const bad = (m) => Object.assign(new Error('GRIB2: ' + m), { code: 'GRIB' });
/** sections 0-6 of a message (its first ~200-512 bytes are enough) -> the header readHeader() gives, checked (v018 review): HRRR's own
 *  grid (a NOAA grid change fails loudly, never the weather drawn in the wrong place), sections that add up to the message, and counts
 *  and bit widths its data section can hold - a corrupt header can neither walk billions of empty groups (minutes of a phone's CPU in
 *  the worker) nor wrap the decoder's 32-bit bit cursors round into the data again (garbage drawn as weather) */
export function header(bytes) {
  const h = readHeader(bytes);
  for (const k in HRRR_GRID) if (h[k] !== HRRR_GRID[k]) throw bad(`not HRRR's 3 km grid (${k} ${h[k]}, expected ${HRRR_GRID[k]})`);
  if (h.s7 + h.s7len + 4 !== h.total) throw bad('its sections do not add up to the message');
  if (!(h.npts >= 1 && h.npts <= h.npts3) || (!h.bitmap && h.npts !== h.npts3) || (h.bitmap && h.bitmap.length * 8 < h.npts3)) throw bad(`${h.npts} values for ${h.npts3} grid points`);
  if (h.nbits > 32) throw bad(`${h.nbits} bits a value`);
  if (h.tpl === 3) {
    if (h.order > 2 || h.ndesc > 4 || h.wbits > 25 || h.lbits > 32 || !(h.NG >= 1 && h.NG <= h.npts)) throw bad(`5.3: ${h.NG} groups, ${h.wbits}-bit widths, ${h.lbits}-bit lengths`);
    const desc = h.order > 0 ? h.ndesc * (h.order + 1) : 0;
    if (8 * desc + h.NG * (h.nbits + h.wbits + h.lbits) > 8 * h.s7len) throw bad(`5.3: ${h.NG} groups do not fit its ${h.s7len}-byte data section`);
  }
  return h;
}

/** a whole message ('GRIB' ... '7777', its length as section 0 says) -> { h, values: Float32Array(nx * ny), scan order: row 0 = south } */
export function decodeMessage(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes), L = b.length;
  if (L < 16 || b[0] !== 0x47 || b[1] !== 0x52 || b[2] !== 0x49 || b[3] !== 0x42) throw new Error('GRIB2: not a GRIB message');
  const total = u32(b, 8) * 4294967296 + u32(b, 12);
  if (total !== L || b[L - 4] !== 0x37 || b[L - 3] !== 0x37 || b[L - 2] !== 0x37 || b[L - 1] !== 0x37) throw new Error('GRIB2: the message is cut off');
  const h = header(b), values = new Float32Array(h.nx * h.ny);
  decodeFrame(h, b, 0, { r0: 0, c0: 0, rows: h.ny, cols: h.nx }, values);
  return { h, values };
}
/** a frame's values from message bytes [bufOff, bufOff + buf.length) (5.0: only the frame's rows are needed; 5.3: the whole message) */
export function decodeRows(h, buf, bufOff, frame) {
  const out = new Float32Array(frame.rows * frame.cols);
  decodeFrame(h, buf, bufOff, frame, out);
  return out;
}

/** a lat / lon grid over a box at a step (cells about square on the ground; coarsened to stay under maxCells) */
export function makeGrid(box, { dlat = 0.05, maxCells = MAX_CELLS } = {}) {
  // finite numbers only (v018 review): NaN or Infinity never passes the cell test below, and the loop never ended (a hung page)
  if (![box && box.w, box && box.s, box && box.e, box && box.n, dlat, maxCells].every(Number.isFinite) || !(dlat > 0) || !(maxCells >= 1)) throw new TypeError('makeGrid: a box and a step of finite numbers');
  for (let k = 0; k < 200; k++) {
    const mid = ((box.s + box.n) / 2) * (Math.PI / 180), dlon = dlat / Math.max(0.2, Math.cos(mid));
    const top = Math.ceil(box.n / dlat - 1e-9) * dlat, bot = Math.floor(box.s / dlat + 1e-9) * dlat;
    const left = Math.floor(box.w / dlon + 1e-9) * dlon, right = Math.ceil(box.e / dlon - 1e-9) * dlon;
    const rows = Math.max(1, Math.round((top - bot) / dlat)), cols = Math.max(1, Math.round((right - left) / dlon));
    if (rows * cols <= maxCells) return { top, left, dlat, dlon, rows, cols };
    dlat *= Math.sqrt((rows * cols) / maxCells) * 1.01;
  }
  throw new RangeError('makeGrid: no grid under maxCells');
}
/** each cell centre's fractional HRRR (i, j) */
export function gridIJ(grid) {
  const n = grid.rows * grid.cols, I = new Float32Array(n), J = new Float32Array(n);
  for (let r = 0, q = 0; r < grid.rows; r++) {
    const lat = grid.top - (r + 0.5) * grid.dlat;
    for (let c = 0; c < grid.cols; c++, q++) { const p = hrrrIJ(lat, grid.left + (c + 0.5) * grid.dlon); I[q] = p.i; J[q] = p.j; }
  }
  return { I, J };
}
/** frame values (rows from the south) -> the grid (bilinear at cell centres; NaN off the frame) */
export function regrid(vals, frame, grid, ij = gridIJ(grid)) {
  const n = grid.rows * grid.cols, out = new Float32Array(n);
  if (!frame) { out.fill(NaN); return out; }
  const { I, J } = ij, W = frame.cols, Hh = frame.rows, c0 = frame.c0, r0 = frame.r0;
  for (let q = 0; q < n; q++) {
    const x = I[q] - c0, y = J[q] - r0;
    if (!(x >= 0 && x <= W - 1 && y >= 0 && y <= Hh - 1)) { out[q] = NaN; continue; }
    const i0 = Math.min(Math.floor(x), W - 2), j0 = Math.min(Math.floor(y), Hh - 2), fx = x - i0, fy = y - j0, k = j0 * W + i0;
    out[q] = (vals[k] * (1 - fx) + vals[k + 1] * fx) * (1 - fy) + (vals[k + W] * (1 - fx) + vals[k + W + 1] * fx) * fy;
  }
  return out;
}
/** categorical values -> the grid by the nearest point (never blended) */
function nearest(vals, frame, grid, ij) {
  const n = grid.rows * grid.cols, out = new Uint8Array(n), { I, J } = ij, W = frame.cols;
  for (let q = 0; q < n; q++) {
    const x = Math.round(I[q] - frame.c0), y = Math.round(J[q] - frame.r0);
    if (x >= 0 && x < W && y >= 0 && y < frame.rows) out[q] = vals[y * W + x] > 0.5 ? 1 : 0;
  }
  return out;
}
const statsOf = (v) => { let mn = Infinity, mx = -Infinity; for (const x of v) { if (x < mn) mn = x; if (x > mx) mx = x; } return { min: mn, max: mx }; };

/** decoded frames of a map's messages -> its product on the grid (see the header) */
export function buildProduct(id, vals, frame, grid, ij = gridIJ(grid)) {
  const n = grid.rows * grid.cols, p = { id, grid };
  if (id === 'wind') {
    const U = regrid(vals.UGRD, frame, grid, ij), V = regrid(vals.VGRD, frame, grid, ij), S = new Float32Array(n);
    const cs = new Float64Array(grid.cols), sn = new Float64Array(grid.cols);
    for (let c = 0; c < grid.cols; c++) { const a = (rotationDeg(grid.left + (c + 0.5) * grid.dlon) * Math.PI) / 180; cs[c] = Math.cos(a); sn[c] = Math.sin(a); }
    for (let q = 0, c = 0; q < n; q++, c = c + 1 === grid.cols ? 0 : c + 1) {
      const ug = U[q], vg = V[q], ue = ug * cs[c] + vg * sn[c], ve = -ug * sn[c] + vg * cs[c];
      U[q] = ue; V[q] = ve; S[q] = msToMph(Math.hypot(ue, ve));
    }
    Object.assign(p, { values: S, u: U, v: V });
  } else if (id === 'temp') {
    const t = regrid(vals.TMP, frame, grid, ij); for (let q = 0; q < n; q++) t[q] = kToF(t[q]); p.values = t;
  } else if (id === 'rh') {
    const t = regrid(vals.RH, frame, grid, ij); for (let q = 0; q < n; q++) t[q] = t[q] < 0 ? 0 : t[q] > 100 ? 100 : t[q]; p.values = t;
  } else if (id === 'pressure') {
    const t = regrid(vals.MSLMA, frame, grid, ij); for (let q = 0; q < n; q++) t[q] = paToHpa(t[q]); p.values = t;
  } else if (id === 'precip') {
    const rate = regrid(vals.PRATE, frame, grid, ij), type = new Uint8Array(n);
    for (let q = 0; q < n; q++) { const x = rate[q] * 3600; rate[q] = x > 0 ? x : x === x ? 0 : NaN; }
    const flags = [['CRAIN', 1], ['CSNOW', 2], ['CICEP', 3], ['CFRZR', 4]].map(([k, code]) => [vals[k] ? nearest(vals[k], frame, grid, ij) : null, code]);
    for (let q = 0; q < n; q++) {
      if (!(rate[q] > 0)) continue;
      let t = 1; for (const [f, code] of flags) if (f && f[q]) t = code;   // rain first, freezing rain last: the most hazardous wins
      type[q] = t;
    }
    const layers = {};
    for (const [name, code] of [['rain', 1], ['snow', 2], ['sleet', 3], ['frz', 4]]) {
      let any = false; const a = new Float32Array(n);
      for (let q = 0; q < n; q++) { const r = rate[q]; if (r !== r) { a[q] = NaN; continue; } if (type[q] === code) { a[q] = r; any = true; } }
      if (any || code === 1) layers[name] = a;
    }
    Object.assign(p, { values: rate, type, layers });
  } else throw new Error('no such map: ' + id);
  p.stats = statsOf(p.values.filter((x) => x === x));
  return p;
}
/** the worker's job: { [name]: { head, buf, off } } (head = the message's first bytes; buf = message bytes from `off`) -> the product */
export function buildFromParts(id, parts, frame, grid, ij) {
  const vals = {};
  for (const [name, pt] of Object.entries(parts)) vals[name] = decodeRows(header(pt.head), pt.buf, pt.off, frame);
  return buildProduct(id, vals, frame, grid, ij || gridIJ(grid));
}

const sameGrid = (a, b) => a === b || (a && b && a.top === b.top && a.left === b.left && a.dlat === b.dlat && a.dlon === b.dlon && a.rows === b.rows && a.cols === b.cols);
/** v020: an hourly map between two of its hours (Wind, Temperature, Humidity and Pressure keep HRRR's hourly data and are drawn every 15
 *  minutes): every cell (1 - w) a + w b, so w 0 and 1 are the hours exactly; no data where either hour has none. Wind is blended as its U
 *  and V (a wind turning round passes through calm, as the flow does), its speed worked out from them. Never two maps or two areas. */
export function blendProducts(a, b, w) {
  if (!a || !b || a.id !== b.id || !sameGrid(a.grid, b.grid)) throw new Error('blend: two hours of one map and one area');
  const n = a.values.length, p = { id: a.id, grid: a.grid, blend: { w } };
  // at every step of a playing loop on the phone: plain loops (a wind grid of 400,000 cells in a few ms)
  const mix = (x, y) => { const o = new Float32Array(n); if (w === 0) o.set(x); else if (w === 1) o.set(y); else for (let i = 0; i < n; i++) o[i] = x[i] + (y[i] - x[i]) * w; return o; };
  if (a.id === 'wind') {
    const u = mix(a.u, b.u), v = mix(a.v, b.v), s = new Float32Array(n), k = msToMph(1);
    if (w === 0 || w === 1) s.set((w === 0 ? a : b).values);   // the hours exactly
    else for (let i = 0; i < n; i++) { const x = u[i], y = v[i]; s[i] = Math.sqrt(x * x + y * y) * k; }
    Object.assign(p, { u, v, values: s });
  } else p.values = mix(a.values, b.values);
  p.stats = statsOf(p.values.filter((x) => x === x));
  return p;
}

/** the area to load for a view [w, s, e, n] shown `px` CSS px tall: the view + 15 % each side, snapped (small pans keep the same
 *  area), clipped to HRRR's domain, and a grid step of about one cell per CSS px (coarser when the area would pass MAX_CELLS)
 *  -> { box, dlat, key } | null off the domain */
export function regionFor(view, { px = 800 } = {}) {
  const [w, s, e, n] = view || [];
  if (![w, s, e, n].every(Number.isFinite)) return null;   // v018 review: a broken view (NaN, Infinity) has nothing to load
  const mx = (e - w) * 0.15, my = (n - s) * 0.15;
  const target = (n - s) / Math.max(200, Number.isFinite(px) ? px : 800);
  let dlat = STEPS.find((x) => x >= target * 0.85) || STEPS[STEPS.length - 1];
  const mid = Math.cos((((s + n) / 2) * Math.PI) / 180), cells = (x) => (((n - s) + 2 * my) / x) * (((e - w) + 2 * mx) / (x / Math.max(0.2, mid)));
  while (cells(dlat) > MAX_CELLS * 0.95 && dlat < STEPS[STEPS.length - 1]) dlat = STEPS[STEPS.indexOf(dlat) + 1];
  const sl = 4 * dlat, so = 6 * dlat;
  const box = { w: Math.floor((w - mx) / so) * so, s: Math.floor((s - my) / sl) * sl, e: Math.ceil((e + mx) / so) * so, n: Math.ceil((n + my) / sl) * sl };
  box.w = Math.max(box.w, DOMAIN.w); box.e = Math.min(box.e, DOMAIN.e); box.s = Math.max(box.s, DOMAIN.s); box.n = Math.min(box.n, DOMAIN.n);
  if (box.e <= box.w || box.n <= box.s) return null;
  const r = (x) => +x.toFixed(4);
  return { box, dlat, key: `${r(box.w)},${r(box.s)},${r(box.e)},${r(box.n)}@${dlat}` };
}
/** does a loaded region still serve a view (inside it, at the same step)? */
export function regionServes(region, view, o = {}) {
  if (!region) return false;
  const nr = regionFor(view, o); if (!nr) return true;   // off the domain: nothing better to load
  const b = region.box, [w, s, e, n] = view;
  const inside = (w >= b.w || b.w <= DOMAIN.w + 1e-9) && (e <= b.e || b.e >= DOMAIN.e - 1e-9) && (s >= b.s || b.s <= DOMAIN.s + 1e-9) && (n <= b.n || b.n >= DOMAIN.n - 1e-9);
  return inside && nr.dlat === region.dlat;
}
