// prep_js/tile.js - a person's lat / lon -> the input tile Earth2Studio's StormScopeBase.set_domain(...) builds
// Derived from NVIDIA Earth2Studio, earth2studio/models/nn/stormscope_flash.py (resolve_region, _axis_context). Copyright (c) 2024-2026 NVIDIA CORPORATION & AFFILIATES, Apache License 2.0 (licenses/Apache-2.0.txt); re-implemented in JavaScript and changed for this app.
// (earth2studio/models/nn/stormscope_flash.py resolve_region + _axis_context, padding 25, 200-px floor, 4-px alignment).
// The request is the box lat +- halfDeg, lon +- halfDeg (0.05 deg by default: smaller than one 3-km pixel never contains a grid
// point, larger boxes only matter once the padded box passes 200 px). Pure ES module.
//   tileFor(45.571, -117.529) -> { y0: 732, y1: 932, x0: 276, x1: 480, h: 200, w: 204, roi: {...} }   (Wallowa, OR)
import { cropRC } from './app_link.js';
import { modelLatLon } from './grid.js';

const H_DEF = 1024, W_DEF = 1792;
const fr = Math.fround;

function axisContext(start, stop, size, padding) {   // _axis_context, line for line
  start = Math.max(0, start - padding); stop = Math.min(size, stop + padding);
  const missing = Math.max(0, 200 - (stop - start));
  start = Math.max(0, start - Math.floor(missing / 2));
  stop = Math.min(size, Math.max(stop, start + 200));
  start = Math.max(0, Math.min(start, stop - 200));
  return [Math.floor(start / 4) * 4, Math.min(size, Math.floor((stop + 3) / 4) * 4)];
}
const pyMod = (a, b) => ((a % b) + b) % b;
const signedOf = (lon) => pyMod(lon + 180, 360) - 180;   // (longitude.astype(float64) + 180) % 360 - 180

/** _inside_grid: ray casting on the native curvilinear perimeter (including its boundary) */
function insideGrid(corners, H, W, cropY, cropX) {
  const per = [];
  const ll = (r, c) => { const q = modelLatLon(r, c, cropY, cropX); return [signedOf(q.lon), q.lat]; };
  for (let c = 0; c < W; c++) per.push(ll(0, c));
  for (let r = 1; r < H; r++) per.push(ll(r, W - 1));
  for (let c = W - 2; c >= 0; c--) per.push(ll(H - 1, c));
  for (let r = H - 2; r > 0; r--) per.push(ll(r, 0));
  const n = per.length;
  for (const [x, y] of corners) {
    let on = false, cross = 0;
    for (let i = 0; i < n; i++) {
      const [x1, y1] = per[i], [x2, y2] = per[(i + 1) % n], dx = x2 - x1, dy = y2 - y1;
      const cr = (x - x1) * dy - (y - y1) * dx;
      if (Math.abs(cr) <= 1e-6 * Math.max(Math.hypot(dx, dy), 1e-6) && x >= Math.min(x1, x2) - 1e-6 && x <= Math.max(x1, x2) + 1e-6
        && y >= Math.min(y1, y2) - 1e-6 && y <= Math.max(y1, y2) + 1e-6) on = true;
      if ((y1 > y) !== (y2 > y) && x < (dx * (y - y1)) / dy + x1) cross++;
    }
    if (!on && cross % 2 === 0) return false;
  }
  return true;
}

/** the regional model's input bounds for the request box (south, north, west, east), as resolve_region computes them */
export function resolveRegion(south, north, rawWest, rawEast, { padding = 25, H = H_DEF, W = W_DEF, cropY = 17, cropX = 3, checkInside = true } = {}) {
  const west = pyMod(rawWest + 180, 360) - 180, east = pyMod(rawEast + 180, 360) - 180;
  if (![south, north, rawWest, rawEast].every(Number.isFinite) || !(-90 <= south && south < north && north <= 90) || !(west < east) || Math.abs(rawEast - rawWest) >= 360)
    throw Object.assign(new Error('Use finite increasing latitude and longitude bounds within the native CONUS domain'), { code: 'TILE_BOUNDS' });
  if (checkInside && !insideGrid([[west, south], [west, north], [east, south], [east, north]], H, W, cropY, cropX))
    throw Object.assign(new Error('Requested region extends outside the native model footprint'), { code: 'TILE_OUTSIDE' });
  // the mask's bounding box: scan a window that surely holds it (box edges sampled in pixel space, +-3 px)
  let rmin = Infinity, rmax = -Infinity, cmin = Infinity, cmax = -Infinity;
  for (let k = 0; k <= 32; k++) {
    const a = south + ((north - south) * k) / 32, o = rawWest + ((rawEast - rawWest) * k) / 32;
    for (const [la, lo] of [[a, rawWest], [a, rawEast], [south, o], [north, o]]) {
      const q = cropRC(la, lo); rmin = Math.min(rmin, q.r); rmax = Math.max(rmax, q.r); cmin = Math.min(cmin, q.c); cmax = Math.max(cmax, q.c);
    }
  }
  const r0 = Math.max(0, Math.floor(rmin) - 3), r1 = Math.min(H - 1, Math.ceil(rmax) + 3), c0 = Math.max(0, Math.floor(cmin) - 3), c1 = Math.min(W - 1, Math.ceil(cmax) + 3);
  const s32 = fr(south), n32 = fr(north);   // float32 latitude vs Python float: NumPy 2 casts the float to float32
  let y0 = Infinity, y1 = -Infinity, x0 = Infinity, x1 = -Infinity;
  for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) {
    const q = modelLatLon(r, c, cropY, cropX), s = signedOf(q.lon);
    if (q.lat >= s32 && q.lat <= n32 && s >= west && s <= east) { y0 = Math.min(y0, r); y1 = Math.max(y1, r + 1); x0 = Math.min(x0, c); x1 = Math.max(x1, c + 1); }
  }
  if (!Number.isFinite(y0)) throw Object.assign(new Error('Requested region contains no native grid points'), { code: 'TILE_EMPTY' });
  const [iy0, iy1] = axisContext(y0, y1, H, padding), [ix0, ix1] = axisContext(x0, x1, W, padding);
  return { y0: iy0, y1: iy1, x0: ix0, x1: ix1, h: iy1 - iy0, w: ix1 - ix0, roi: { y0, y1, x0, x1 } };
}

/** a person's position -> the tile (box lat +- halfDeg, lon +- halfDeg) */
export function tileFor(lat, lon, { halfDeg = 0.05, padding = 25, grid } = {}) {
  const o = grid ? { H: grid.H, W: grid.W, cropY: grid.cropY, cropX: grid.cropX } : {};
  return resolveRegion(lat - halfDeg, lat + halfDeg, lon - halfDeg, lon + halfDeg, { padding, ...o });
}
