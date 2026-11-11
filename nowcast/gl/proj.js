// nowcast/gl/proj.js - Wallowa Weather v018: the map's Web Mercator (256 px tiles; a latitude is clamped to +-85 on its way to the screen)
// and the field shader's own arithmetic: a CSS pixel -> a lat / lon grid's texel coordinates, the way the GPU works it out. Pure.
// A grid { top, left, dlat, dlon, rows, cols }: texel (c, r) covers lon left + [c, c + 1) dlon, lat top - [r, r + 1) dlat (row 0 = north).
// Texel coordinates u, v: 0 at the grid's west / north edge, cols / rows at the east / south edge; texel centres at c + 0.5.
export const TILE = 256;
const D2R = Math.PI / 180;
export const wx = (lon, z) => ((lon + 180) / 360) * TILE * 2 ** z;
export const wy = (lat, z) => { const s = Math.sin(Math.max(-85, Math.min(85, lat)) * D2R); return (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * TILE * 2 ** z; };
export const lonOf = (x, z) => (x / (TILE * 2 ** z)) * 360 - 180;
export const latOf = (y, z) => { const n = Math.PI - (2 * Math.PI * y) / (TILE * 2 ** z); return (180 / Math.PI) * Math.atan(Math.sinh(n)); };

/** a view st = { lat, lon, z, w, h } (CSS px) -> the map's screen <-> lat / lon */
export function viewOf(st) {
  const ox = wx(st.lon, st.z) - st.w / 2, oy = wy(st.lat, st.z) - st.h / 2;
  const toScreen = (lat, lon) => ({ x: wx(lon, st.z) - ox, y: wy(lat, st.z) - oy });
  const toLatLon = (x, y) => ({ lat: latOf(oy + y, st.z), lon: lonOf(ox + x, st.z) });
  return { origin: { x: ox, y: oy }, toScreen, toLatLon, bounds: () => { const a = toLatLon(0, 0), b = toLatLon(st.w, st.h); return [a.lon, b.lat, b.lon, a.lat]; } };
}
/** a point's texel coordinates on a grid */
export const gridUV = (g, lat, lon) => ({ u: (lon - g.left) / g.dlon, v: (g.top - lat) / g.dlat });

/** the shader's numbers for a view and a grid, worked out in doubles on the CPU. Columns are linear in x: u = A + B x. Rows follow the
 *  Mercator DIFFERENCE from the screen's middle row: lat(y) - lat(yc) = gd(mc - d) - gd(mc) = 2 atan(sinh(-d / 2) / cosh(mc - d / 2)),
 *  d = k (y - yc) - exact, and with no cancellation at any zoom. A and the middle row's v are split into a whole part (iu, iv: exact in
 *  a float) and a fraction, so the GPU's 32-bit floats only ever hold small numbers: the error stays far under a pixel even at zoom 19
 *  on the 4 km CONUS grid. tpp: texels per DEVICE px at the view's middle (the larger of the two directions; edge softening uses it). */
export function fieldUniforms(st, g) {
  const W = TILE * 2 ** st.z, ox = wx(st.lon, st.z) - st.w / 2, oy = wy(st.lat, st.z) - st.h / 2;
  const A = ((ox / W) * 360 - 180 - g.left) / g.dlon, B = (360 / W) / g.dlon;
  const yc = st.h / 2, k = (2 * Math.PI) / W, mc = Math.PI - k * (oy + yc), latc = Math.atan(Math.sinh(mc)) / D2R;
  const Rc = (g.top - latc) / g.dlat, S = 180 / Math.PI / g.dlat;
  const iu = Math.floor(A), iv = Math.floor(Rc);
  const tpp = Math.max(Math.abs(B), S * k * Math.cos(latc * D2R)) / (st.dpr || 1);
  return { iu, fu: A - iu, B, iv, fv: Rc - iv, S, yc, mc, k, tpp };
}
/** the fragment shader's arithmetic in JS (its twin, for the tests): CSS px (x, y) -> { u, v }. f32 = true rounds every step to a 32-bit
 *  float as a GPU's highp does (the uniforms too); the whole parts stay apart, as in the shader */
export function shaderUV(U, x, y, f32 = false) {
  const F = f32 ? Math.fround : (v) => v;
  const sinh = (h) => { if (Math.abs(h) < 0.05) { const h2 = F(h * h); return F(h * F(1 + F(F(h2 / 6) * F(1 + F(h2 / 20))))); } const e = F(Math.exp(h)); return F(0.5 * F(e - F(1 / e))); };
  const cosh = (h) => { const e = F(Math.exp(h)); return F(0.5 * F(e + F(1 / e))); };
  const xf = F(x), yf = F(y), d = F(F(U.k) * F(yf - F(U.yc)));
  const D = F(2 * F(Math.atan(F(sinh(F(-0.5 * d)) / cosh(F(F(U.mc) - F(0.5 * d)))))));
  const gu = F(F(U.fu) + F(F(U.B) * xf)), gv = F(F(U.fv) - F(F(U.S) * D));
  return { u: U.iu + gu, v: U.iv + gv };
}
