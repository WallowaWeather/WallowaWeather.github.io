// nowcast/stormscope/lcc.js - PILOT: the HRRR 3 km Lambert conformal grid StormScope runs on (NOAA HRRR GRIB2 template 3.30: 1799 x
// 1059 points, first point 21.138123 N 237.280472 E, LoV 262.5 E, both standard parallels 38.5 N, 3000 m spacing, sphere radius
// 6,371,229 m). StormScope uses the centre crop 1024 x 1792 (rows 17.., columns 3..); a tile is a 204 x 204 window of that crop.
// HRRR's own categorical precipitation type (snow / sleet / freezing rain / rain) is on the same grid, so it maps pixel for pixel.
'use strict';
const R = 6371229, D = Math.PI / 180, PHI1 = 38.5 * D, LON0 = 262.5 * D, DX = 3000;
const N = Math.sin(PHI1), F = Math.cos(PHI1) * Math.pow(Math.tan(Math.PI / 4 + PHI1 / 2), N) / N;
const rho = (phi) => R * F / Math.pow(Math.tan(Math.PI / 4 + phi / 2), N), RHO0 = rho(PHI1);
function xy(lat, lon) {
  let dl = ((lon < 0 ? lon + 360 : lon) * D) - LON0; while (dl > Math.PI) dl -= 2 * Math.PI; while (dl < -Math.PI) dl += 2 * Math.PI;
  const r = rho(lat * D), th = N * dl; return [r * Math.sin(th), RHO0 - r * Math.cos(th)];
}
const [X1, Y1] = xy(21.138123, 237.280472);
export const HRRR = { nx: 1799, ny: 1059, crop: { y: 17, x: 3, h: 1024, w: 1792 } };
/** lat / lon -> fractional HRRR grid (i = column, j = row from the south edge) */
export function hrrrIJ(lat, lon) { const [x, y] = xy(lat, lon); return { i: (x - X1) / DX, j: (y - Y1) / DX }; }
/** lat / lon -> fractional (row, col) in StormScope's centre crop */
export function cropRC(lat, lon) { const q = hrrrIJ(lat, lon); return { r: q.j - HRRR.crop.y, c: q.i - HRRR.crop.x }; }
/** the inverse: HRRR grid (i, j) -> lat / lon */
export function hrrrLatLon(i, j) {
  const x = X1 + i * DX, y = Y1 + j * DX, yy = RHO0 - y, r = Math.sign(N) * Math.hypot(x, yy), th = Math.atan2(Math.sign(N) * x, Math.sign(N) * yy);
  const phi = 2 * Math.atan(Math.pow(R * F / r, 1 / N)) - Math.PI / 2, lon = (LON0 + th / N) / D;
  return { lat: phi / D, lon: ((lon + 180) % 360 + 360) % 360 - 180 };
}
