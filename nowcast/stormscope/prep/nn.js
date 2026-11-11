// prep_js/nn.js - Earth2Studio's NearestNeighborInterpolator (earth2studio/utils/interp.py, max_dist_km 6) for one tile, without a
// Derived from NVIDIA Earth2Studio, earth2studio/utils/interp.py. Copyright (c) 2024-2026 NVIDIA CORPORATION & AFFILIATES, Apache License 2.0 (licenses/Apache-2.0.txt); re-implemented in JavaScript and changed for this app.
// KD-tree: the nearest source pixel is searched in a 5 x 5 window around the analytic inverse projection, with the same float
// precisions the PyTorch code uses (targets and MRMS sources are float32 unit vectors; GOES sources are float64), and the squared
// chord distance compared in float64 as scipy's KDTree does. A tiny per-pixel fix table from the grid pack (build_fixes.mjs) then
// replaces the few pixels where PyTorch's float32 SLEEF sin/cos (1-ulp) tips a near-tie the other way. Pure ES module.
//   mrmsNN(tile, tl, mrmsGrid, grid) / goesNN(tile, tl, grid) -> { idx: Int32Array (source flat index), valid: Uint8Array, rows, cols }
const fr = Math.fround;
export const D2R32 = fr(0.017453292519943295769236907684886);   // torch.deg2rad on float32: x * (float)M_PI_180
export const D2R64 = 0.017453292519943295769236907684886;       // torch.deg2rad on float64
const R_KM = 6371.0, MAX_KM = 6.0;

/** float32 unit vector exactly as ang2vec(deg2rad(lon), deg2rad(lat)) on float32 tensors (up to libm ulps) */
export function vec32(lat32, lon32, out, o = 0) {
  const la = fr(lat32 * D2R32), lo = fr(lon32 * D2R32), cl = fr(Math.cos(la));
  out[o] = fr(cl * fr(Math.cos(lo))); out[o + 1] = fr(cl * fr(Math.sin(lo))); out[o + 2] = fr(Math.sin(la));
  return out;
}
/** float32 haversine (all operands float32), km */
function hav32km(lon1, lat1, lon2, lat2) {
  const dlon = fr(lon2 - lon1), dlat = fr(lat2 - lat1), s1 = fr(Math.sin(fr(dlat / 2))), s2 = fr(Math.sin(fr(dlon / 2)));
  const a = fr(fr(s1 * s1) + fr(fr(fr(Math.cos(lat1)) * fr(Math.cos(lat2))) * fr(s2 * s2)));
  const c = fr(2 * fr(Math.atan2(fr(Math.sqrt(a)), fr(Math.sqrt(fr(1 - a))))));
  return fr(c * fr(R_KM));
}
/** mixed haversine: target float32, source float64 (torch promotes to float64; cos(lat1) stays float32), km */
function havMixKm(lon1, lat1, lon2, lat2) {
  const dlon = lon2 - lon1, dlat = lat2 - lat1, s1 = Math.sin(dlat / 2), s2 = Math.sin(dlon / 2);
  const a = s1 * s1 + fr(Math.cos(lat1)) * Math.cos(lat2) * (s2 * s2);
  return 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)) * R_KM;
}
const d2 = (t, o, x, y, z) => { const dx = t[o] - x, dy = t[o + 1] - y, dz = t[o + 2] - z; return dx * dx + dy * dy + dz * dz; };

function applyFixes(res, tile, grid, kind) {
  const fix = grid && grid.fix && grid.fix[kind]; let n = 0;
  if (!fix || !fix.size) return n;
  const w = tile.x1 - tile.x0, W = grid.W;
  for (let y = tile.y0; y < tile.y1; y++) for (let x = tile.x0; x < tile.x1; x++) {
    const f = fix.get(y * W + x); if (!f) continue;
    const k = (y - tile.y0) * w + (x - tile.x0); res.idx[k] = f.idx; res.valid[k] = f.valid; n++;
  }
  return n;
}

// ------------------------------------------------------------------------------------------------------------ MRMS (regular lat/lon)
/** g = { lat0, lon0, dlat, dlon, Ni, Nj } as MRMS._decode_mrms_grib builds the axes (rows north -> south) */
export function mrmsNN(tile, tl, g, grid, { useFixes = true } = {}) {
  const n = tl.lat.length, idx = new Int32Array(n), valid = new Uint8Array(n), tv = new Float64Array(3);
  const latS = (r) => fr(g.lat0 + (-g.dlat) * r), lonS = (c) => fr(g.lon0 + g.dlon * c);
  const rowC = new Map(), colC = new Map();
  const rowTrig = (r) => { let v = rowC.get(r); if (!v) { const la = fr(latS(r) * D2R32); v = [fr(Math.cos(la)), fr(Math.sin(la)), la]; rowC.set(r, v); } return v; };
  const colTrig = (c) => { let v = colC.get(c); if (!v) { const lo = fr(lonS(c) * D2R32); v = [fr(Math.cos(lo)), fr(Math.sin(lo)), lo]; colC.set(c, v); } return v; };
  for (let k = 0; k < n; k++) {
    vec32(tl.lat[k], tl.lon[k], tv);
    const r0 = Math.min(g.Nj - 1, Math.max(0, Math.round((g.lat0 - tl.lat[k]) / g.dlat))), c0 = Math.min(g.Ni - 1, Math.max(0, Math.round((tl.lon[k] - g.lon0) / g.dlon)));
    let best = Infinity, br = -1, bc = -1;
    for (let r = Math.max(0, r0 - 2); r <= Math.min(g.Nj - 1, r0 + 2); r++) {
      const [clat, slat] = rowTrig(r);
      for (let c = Math.max(0, c0 - 2); c <= Math.min(g.Ni - 1, c0 + 2); c++) {
        const [clon, slon] = colTrig(c);
        const dd = d2(tv, 0, fr(clat * clon), fr(clat * slon), slat);
        if (dd < best) { best = dd; br = r; bc = c; }
      }
    }
    idx[k] = br * g.Ni + bc;
    const t1 = fr(tl.lon[k] * D2R32), t2 = fr(tl.lat[k] * D2R32);
    valid[k] = hav32km(t1, t2, colTrig(bc)[2], rowTrig(br)[2]) < MAX_KM ? 1 : 0;
  }
  const res = { idx, valid, fixed: 0 };
  if (useFixes) res.fixed = applyFixes(res, tile, grid, 'mrms');
  let rmin = Infinity, rmax = -Infinity, cmin = Infinity, cmax = -Infinity;
  for (let k = 0; k < n; k++) if (res.valid[k]) { const r = Math.floor(idx[k] / g.Ni), c = idx[k] % g.Ni; rmin = Math.min(rmin, r); rmax = Math.max(rmax, r); cmin = Math.min(cmin, c); cmax = Math.max(cmax, c); }
  res.rows = [rmin, rmax]; res.cols = [cmin, cmax];
  return res;
}

// ------------------------------------------------------------------------------------------------------------ GOES ABI fixed grid
/** GOES.grid for one pixel (float64, numpy's operation order) -> [lat, lon] degrees (NaN off the Earth disk) */
export function goesPixelLatLon(x, y, gc) {
  const rEq = gc.semi_major_axis, rPol = gc.semi_minor_axis, Hh = gc.perspective_point_height + gc.semi_major_axis;
  const lambda0 = (gc.lon_origin * Math.PI) / 180.0, k = (rEq * rEq) / (rPol * rPol);
  const sx_ = Math.sin(x), cx = Math.cos(x), cy = Math.cos(y), sy_ = Math.sin(y);
  const a = sx_ * sx_ + cx * cx * (cy * cy + k * (sy_ * sy_));
  const b = -2.0 * Hh * cx * cy, c = Hh * Hh - rEq * rEq;   // H**2.0 - r_eq**2.0 (pow(x, 2) is the rounded square)
  const rs = (-1.0 * b - Math.sqrt(b * b - 4.0 * a * c)) / (2.0 * a);
  const sx = rs * cx * cy, sy = -rs * sx_, sz = rs * cx * sy_;
  const lat = (180.0 / Math.PI) * Math.atan(k * (sz / Math.sqrt((Hh - sx) * (Hh - sx) + sy * sy)));
  const lon = (lambda0 - Math.atan(sy / (Hh - sx))) * (180.0 / Math.PI);
  return [lat, lon];
}
/** geodetic lat / lon (deg) -> GOES scan angles [x, y] (rad), or null when not visible (NOAA PUG inverse) */
export function goesScanAngles(lat, lon, gc) {
  const rEq = gc.semi_major_axis, rPol = gc.semi_minor_axis, Hh = gc.perspective_point_height + gc.semi_major_axis;
  const phi = (lat * Math.PI) / 180, lam = (lon * Math.PI) / 180, lam0 = (gc.lon_origin * Math.PI) / 180;
  const phic = Math.atan(((rPol * rPol) / (rEq * rEq)) * Math.tan(phi)), e2 = (rEq * rEq - rPol * rPol) / (rEq * rEq);
  const rc = rPol / Math.sqrt(1 - e2 * Math.cos(phic) ** 2);
  const sx = Hh - rc * Math.cos(phic) * Math.cos(lam - lam0), sy = -rc * Math.cos(phic) * Math.sin(lam - lam0), sz = rc * Math.sin(phic);
  if (Hh * (Hh - sx) < sy * sy + ((rEq * rEq) / (rPol * rPol)) * sz * sz) return null;
  return [Math.asin(-sy / Math.sqrt(sx * sx + sy * sy + sz * sz)), Math.atan(sz / sx)];
}

export function goesNN(tile, tl, grid, { useFixes = true } = {}) {
  const gc = grid.json.goes, [NY, NX] = gc.dims, gx = grid.goesX, gy = grid.goesY;
  const x0 = gx[0], dx = (gx[NX - 1] - gx[0]) / (NX - 1), y0 = gy[0], dy = (gy[0] - gy[NY - 1]) / (NY - 1);
  const n = tl.lat.length, idx = new Int32Array(n), valid = new Uint8Array(n), tv = new Float64Array(3);
  // pass 1: predicted source pixel of every target (inverse projection), and the source window they span
  const pr = new Int32Array(n), pc = new Int32Array(n); let wr0 = NY, wr1 = 0, wc0 = NX, wc1 = 0;
  for (let k = 0; k < n; k++) {
    const lonSigned = tl.lon[k] > 180 ? tl.lon[k] - 360 : tl.lon[k], sa = goesScanAngles(tl.lat[k], lonSigned, gc);
    let r0 = 0, c0 = 0; if (sa) { c0 = Math.round((sa[0] - x0) / dx); r0 = Math.round((y0 - sa[1]) / dy); }
    pr[k] = r0 = Math.min(NY - 1, Math.max(0, r0)); pc[k] = c0 = Math.min(NX - 1, Math.max(0, c0));
    wr0 = Math.min(wr0, r0); wr1 = Math.max(wr1, r0); wc0 = Math.min(wc0, c0); wc1 = Math.max(wc1, c0);
  }
  wr0 = Math.max(0, wr0 - 24); wr1 = Math.min(NY - 1, wr1 + 24); wc0 = Math.max(0, wc0 - 24); wc1 = Math.min(NX - 1, wc1 + 24);
  const WW = wc1 - wc0 + 1, state = new Uint8Array((wr1 - wr0 + 1) * WW), vec = new Float64Array(state.length * 5);   // 0 todo, 1 ok, 2 off disk
  const src = (r, c) => {
    if (r < wr0 || r > wr1 || c < wc0 || c > wc1) return -1;
    const q = (r - wr0) * WW + (c - wc0);
    if (state[q] === 0) {
      const [la, lo] = goesPixelLatLon(gx[c], gy[r], gc);
      if (Number.isNaN(la) || Number.isNaN(lo)) state[q] = 2;
      else { const a = la * D2R64, o = lo * D2R64, ca = Math.cos(a), p = q * 5; vec[p] = ca * Math.cos(o); vec[p + 1] = ca * Math.sin(o); vec[p + 2] = Math.sin(a); vec[p + 3] = a; vec[p + 4] = o; state[q] = 1; }
    }
    return state[q] === 1 ? q * 5 : -1;
  };
  for (let k = 0; k < n; k++) {
    vec32(tl.lat[k], tl.lon[k], tv);
    let r0 = pr[k], c0 = pc[k], best = Infinity, br = -1, bc = -1;
    for (let it = 0; it < 8; it++) {   // 5 x 5 window, re-centred while the best sits on its rim
      for (let r = Math.max(0, r0 - 2); r <= Math.min(NY - 1, r0 + 2); r++) for (let c = Math.max(0, c0 - 2); c <= Math.min(NX - 1, c0 + 2); c++) {
        const p = src(r, c); if (p < 0) continue;
        const dd = d2(tv, 0, vec[p], vec[p + 1], vec[p + 2]);
        if (dd < best) { best = dd; br = r; bc = c; }
      }
      if (br < 0 || (Math.abs(br - r0) < 2 && Math.abs(bc - c0) < 2)) break;
      r0 = br; c0 = bc;
    }
    if (br < 0) { idx[k] = 0; valid[k] = 0; continue; }
    idx[k] = br * NX + bc;
    const p = src(br, bc), t1 = fr(tl.lon[k] * D2R32), t2 = fr(tl.lat[k] * D2R32);
    valid[k] = havMixKm(t1, t2, vec[p + 4], vec[p + 3]) < MAX_KM ? 1 : 0;
  }
  const res = { idx, valid, fixed: 0 };
  if (useFixes) res.fixed = applyFixes(res, tile, grid, 'goes');
  let rmin = Infinity, rmax = -Infinity, cmin = Infinity, cmax = -Infinity;
  for (let k = 0; k < n; k++) if (res.valid[k]) { const r = Math.floor(res.idx[k] / NX), c = res.idx[k] % NX; rmin = Math.min(rmin, r); rmax = Math.max(rmax, r); cmin = Math.min(cmin, c); cmax = Math.max(cmax, c); }
  res.rows = [rmin, rmax]; res.cols = [cmin, cmax];
  return res;
}
