// nowcast/gl/ramp.js - Wallowa Weather v018: colour ramps for the map's fields. A ramp is [[value, [r, g, b, a]], ...] (r g b 0..255, a
// 0..1; sorted here), straight (not premultiplied) linear between stops, clamped to the end colours outside them. A see-through stop
// (a = 0) borrows its neighbour's colour on the side being blended, so a fade-in never passes through black (no dark fringes). The GPU
// reads a ramp as a 256 x 1 RGBA texture over [first, last] with linear filtering. Pure.
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
function prep(stops) {
  if (!Array.isArray(stops) || !stops.length) throw new TypeError('a ramp needs at least one stop [[value, [r, g, b, a]], ...]');
  const S = [];
  for (const s of stops) {
    const v = +(s && s[0]), c = s && s[1]; if (!Number.isFinite(v) || !c) continue;
    S.push([v, [clamp(+c[0] || 0, 0, 255), clamp(+c[1] || 0, 0, 255), clamp(+c[2] || 0, 0, 255), clamp(c[3] == null ? 1 : +c[3] || 0, 0, 1)]]);
  }
  if (!S.length) throw new TypeError('a ramp needs at least one stop with a number and a colour');
  return S.sort((a, b) => a[0] - b[0]);
}
const bytes = (c) => [Math.round(c[0]), Math.round(c[1]), Math.round(c[2]), Math.round(c[3] * 255)];
/** blend stops a -> b by f; a see-through end takes the other end's colour */
function mix(a, b, f) {
  const ca = a[3] > 0 || !b ? a : [b[0], b[1], b[2], 0], cb = !b ? a : b[3] > 0 ? b : [a[0], a[1], a[2], 0];
  return [0, 1, 2, 3].map((k) => ca[k] + (cb[k] - ca[k]) * f);
}
function at(S, v) {
  if (S.length === 1) return S[0][1];
  if (v <= S[0][0]) return mix(S[0][1], S[1][1], 0);
  const n = S.length - 1; if (v >= S[n][0]) return mix(S[n][1], S[n - 1][1], 0);
  let i = n - 1; while (i > 0 && S[i][0] > v) i--;   // the last stop at or under v (equal stops: the later one: right-continuous)
  const a = S[i], b = S[i + 1], f = b[0] > a[0] ? (v - a[0]) / (b[0] - a[0]) : 1;
  return mix(a[1], b[1], f);
}
/** the colour at v as bytes [r, g, b, a 0..255]; NaN / nothing -> transparent */
export function rampAt(stops, v) {
  if (v == null || typeof v === 'boolean' || Number.isNaN(+v)) return [0, 0, 0, 0];
  return bytes(at(prep(stops), +v));
}
/** -> { data: Uint8Array(4n) RGBA, vmin, vmax, n }: n texels from the first stop's value to the last's (texel i at vmin + i/(n-1) span) */
export function rampTexture(stops, n = 256) {
  const S = prep(stops), vmin = S[0][0], vmax = S[S.length - 1][0], data = new Uint8Array(4 * n);
  for (let i = 0; i < n; i++) data.set(bytes(at(S, vmin + ((vmax - vmin) * i) / (n - 1))), 4 * i);
  return { data, vmin, vmax, n };
}
/** a 256-colour code table (Uint8ClampedArray(1024), colors.js) -> its ramp texture: unchanged, except that each see-through entry takes
 *  the colour of the nearest visible entry OF ITS OWN CLASS (2^levelBits entries a class), alpha still 0 */
export function lutTexture(lut, levelBits = 8) {
  const out = new Uint8Array(1024); out.set(lut.subarray ? lut.subarray(0, 1024) : lut);
  const size = 1 << levelBits;
  for (let c = 0; c < 256; c++) {
    if (lut[4 * c + 3] > 0) continue;
    const lo = Math.floor(c / size) * size, hi = lo + size; let k = -1;
    for (let d = 1; d < size && k < 0; d++) for (const j of [c + d, c - d]) if (k < 0 && j >= lo && j < hi && lut[4 * j + 3] > 0) k = j;
    if (k >= 0) { out[4 * c] = lut[4 * k]; out[4 * c + 1] = lut[4 * k + 1]; out[4 * c + 2] = lut[4 * k + 2]; out[4 * c + 3] = 0; }
  }
  return out;
}
/** a ramp texture read the way the GPU's linear filter reads it, at x in texels (0..255) -> [r, g, b, a] bytes as floats */
export function rampLerp(tex, x) {
  x = clamp(x, 0, 255); const i = Math.floor(x), j = Math.min(255, i + 1), f = x - i;
  return [0, 1, 2, 3].map((k) => tex[4 * i + k] + (tex[4 * j + k] - tex[4 * i + k]) * f);
}
