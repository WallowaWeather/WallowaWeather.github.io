// nowcast/regrid.js - a model's box from an MRMS frame: a square of n x n points `km` apart on a local projection centred on the
// place (the place sits in the middle of the box), bilinear from MRMS's 0.01 degree grid. The arithmetic is the reference tool's
// (mrms_fetch.py) step for step in float64, so the same file gives the same float32 values and the same model inputs.
// Pure: no DOM, no network.

export const R_EARTH = 6371.0;   // km
const DEG = 180 / Math.PI, RAD = Math.PI / 180;   // numpy's degrees() / radians() multiply by these

/** the box's points on the MRMS grid -> { r, c (Float64Array: fractional row and column of every point), rmin, rmax, cmin, cmax (the
 *  grid rows and columns the bilinear reads, clipped to the grid) } */
export function boxIndex(meta, lat0, lon0, n = 256, km = 1) {
  const half = (n - 1) / 2, r = new Float64Array(n * n), c = new Float64Array(n * n);
  const kx = R_EARTH * Math.cos(lat0 * RAD), lo1 = meta.lo1 - 360.0;
  let rmin = Infinity, rmax = -Infinity, cmin = Infinity, cmax = -Infinity;
  for (let i = 0; i < n; i++) {
    const lat = lat0 + ((half - i) * km / R_EARTH) * DEG, ri = (meta.la1 - lat) / meta.dj;
    for (let j = 0; j < n; j++) {
      const lon = lon0 + (((j - half) * km) / kx) * DEG, cj = (lon - lo1) / meta.di, q = i * n + j;
      r[q] = ri; c[q] = cj;
      if (ri < rmin) rmin = ri; if (ri > rmax) rmax = ri; if (cj < cmin) cmin = cj; if (cj > cmax) cmax = cj;
    }
  }
  const clipR = (v) => Math.max(0, Math.min(meta.nj - 1, v)), clipC = (v) => Math.max(0, Math.min(meta.ni - 1, v));
  return { n, r, c, rmin: clipR(Math.floor(rmin)), rmax: clipR(Math.floor(rmax) + 1), cmin: clipC(Math.floor(cmin)), cmax: clipC(Math.floor(cmax) + 1) };
}
/** a window of grid values (rows rmin..rmax, cols cmin..cmax; Float32Array, missing = 0) for boxIndex, filled row by row */
export function makeWindow(ix) {
  const w = ix.cmax - ix.cmin + 1, h = ix.rmax - ix.rmin + 1;
  return { ix, w, h, v: new Float32Array(w * h) };
}
/** one decoded grid row into the window (codes -> values through lut; a value below 0, "no data", counts as 0 as in the tool) */
export function windowRow(win, y, row, bpp, lut) {
  const ix = win.ix; if (y < ix.rmin || y > ix.rmax) return;
  const o = (y - ix.rmin) * win.w, v = win.v;
  for (let x = ix.cmin, k = o; x <= ix.cmax; x++, k++) {
    const code = bpp === 2 ? (row[2 * x] << 8) | row[2 * x + 1] : row[x], val = lut[code];
    v[k] = val > 0 ? val : 0;   // NaN-free: below 0 = missing -> 0
  }
}
/** the box (Float32Array n*n, mm/h) from a filled window: bilinear with the grid's edge clipped, float64 sums, float32 result */
export function regrid(win) {
  const { ix, w, v } = win, N = ix.n * ix.n, out = new Float32Array(N), nj1 = (ix.rmax), ni1 = (ix.cmax);
  const g = (a, b) => v[(Math.max(ix.rmin, Math.min(nj1, a)) - ix.rmin) * w + (Math.max(ix.cmin, Math.min(ni1, b)) - ix.cmin)];
  for (let q = 0; q < N; q++) {
    const r = ix.r[q], c = ix.c[q], r0 = Math.floor(r), c0 = Math.floor(c), fr = r - r0, fc = c - c0;
    out[q] = g(r0, c0) * (1 - fr) * (1 - fc) + g(r0, c0 + 1) * (1 - fr) * fc + g(r0 + 1, c0) * fr * (1 - fc) + g(r0 + 1, c0 + 1) * fr * fc;
  }
  return out;
}
/** frames that stand for one input time: one frame as it is, two (an odd minute between two 2-minute frames) as their float32 mean */
export function meanFrames(list) {
  if (list.length === 1) return list[0];
  const a = list[0], b = list[1], out = new Float32Array(a.length);
  for (let i = 0; i < a.length; i++) out[i] = Math.fround(a[i] + b[i]) / 2;
  return out;
}
/** round half to even (numpy's round) */
export function roundEven(x) { const f = Math.floor(x), d = x - f; return d > 0.5 ? f + 1 : d < 0.5 ? f : (f % 2 === 0 ? f : f + 1); }
/** the model's input frames: rain rate clipped to 0..128 mm/h, in 1/32 mm/h (0..4095) -> Int16Array (frames one after another) */
export function quantInputs(frames) {
  const n = frames[0].length, out = new Int16Array(frames.length * n);
  frames.forEach((f, k) => { for (let i = 0; i < n; i++) { const x = f[i] < 0 ? 0 : f[i] > 128 ? 128 : f[i]; out[k * n + i] = Math.min(4095, roundEven(x * 32)); } });
  return out;
}

/** the box's own projection: point (row i, col j) <-> lat / lon (the same formulas as boxIndex) */
export function boxProjection(lat0, lon0, n = 256, km = 1) {
  const half = (n - 1) / 2, kx = R_EARTH * Math.cos(lat0 * RAD);
  return { lat0, lon0, n, km,
    toLatLon: (i, j) => ({ lat: lat0 + ((half - i) * km / R_EARTH) * DEG, lon: lon0 + (((j - half) * km) / kx) * DEG }),
    toIJ: (lat, lon) => ({ i: half - (lat - lat0) * RAD * R_EARTH / km, j: half + (lon - lon0) * RAD * kx / km }),
    corners() { return [this.toLatLon(-0.5, -0.5), this.toLatLon(-0.5, n - 0.5), this.toLatLon(n - 0.5, n - 0.5), this.toLatLon(n - 0.5, -0.5)]; } };
}
/** the box centres of a "wider area" nowcast: 3 x 3 boxes 128 km apart around the place (each box on its own projection) */
export function tileCentres(lat0, lon0, stride = 128, k = 1) {
  const out = [], kx = R_EARTH * Math.cos(lat0 * RAD);
  for (let a = -k; a <= k; a++) for (let b = -k; b <= k; b++) out.push({ lat: lat0 - (a * stride / R_EARTH) * DEG, lon: lon0 + ((b * stride) / kx) * DEG, a, b });
  return out;
}
/** the contiguous US (lower 48) as MRMS covers it, roughly: a place outside gets "the nowcast covers the lower 48 states only" */
export function inConus(lat, lon) {
  if (!(lat >= 24.4 && lat <= 49.5 && lon >= -125 && lon <= -66.8)) return false;
  if (lat < 31.3 && lon < -106.6) return false;            // Mexico south of Arizona / New Mexico
  if (lat < 25.8 && lon < -97.5) return false;             // Mexico south of Texas
  if (lat > 45.3 && lon > -71.5 && lat > 47.5) return false;   // Quebec / New Brunswick above Maine
  return true;
}
