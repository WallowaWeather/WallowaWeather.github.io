// nowcast/gl/field.js - Wallowa Weather v018: a colour field on a lat / lon grid, described once for the GPU and the 2D path (normField),
// and the CPU twin of the fragment shader (sampleField: the tests hold the GPU to it). Pure.
// Sampling: the value is interpolated in VALUE space with a validity weight (a nodata texel never mixes in: no colour bleeds into a nodata
// cell and an edge next to one is never darkened), then looked up in the ramp. A nodata cell is cut crisply at its edge (nearest texel).
// Codes (one byte and a 256-colour table: the radar's level + class, chances, BEAM's tables): a code with no colour is "none" (dry): the
// outline of what has colour is the 0.5 contour of the coloured fraction, ON the cell boundary (nothing grows, shrinks or vanishes as it
// would blending toward an invisible value), softened over `aa`, its colour the coloured cells' own; the radar's classes (rain / snow,
// the four types) blend as colours, never as levels.
import { rampTexture, lutTexture, rampLerp } from './ramp.js';
import { CODES } from '../colors.js';

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const kindLuts = new Map(), lutKind = new WeakMap(), lutTex = new WeakMap();
const kindLut = (k) => { if (!kindLuts.has(k)) kindLuts.set(k, CODES[k].lut()); return kindLuts.get(k); };
function sameBytes(a, b) { if (!a || !b || a.length !== b.length) return false; for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false; return true; }
/** a code table that is one of colors.js's (same colours) -> its kind; else null (a plain 0..255 value table: BEAM chances, dBZ) */
function detect(lut) {
  if (lutKind.has(lut)) return lutKind.get(lut);
  let k = null; for (const name of Object.keys(CODES)) if (sameBytes(kindLut(name), lut)) { k = name; break; }
  lutKind.set(lut, k); return k;
}
/** "none" = level 0 when the table has no colour exactly at level 0 of every class (the radar's: the GPU skips a lookup), else = no colour */
const dryRule = new WeakMap();
function dryByOf(lut, bits) {
  const k = `${bits}`; let m = dryRule.get(lut); if (!m) dryRule.set(lut, (m = new Map()));
  if (!m.has(k)) { const size = 1 << bits; let lv = bits < 8; for (let c = 0; c < 256 && lv; c++) if ((lut[4 * c + 3] === 0) !== (c % size === 0)) lv = false; m.set(k, lv ? 'level' : 'table'); }
  return m.get(k);
}
function texOf(lut, bits) { let m = lutTex.get(lut); if (!m) lutTex.set(lut, (m = new Map())); if (!m.has(bits)) m.set(bits, lutTexture(lut, bits)); return m.get(bits); }

/** a field -> its description. Accepts setField's shape { grid, values, nodata?, scale?, offset?, ramp, smooth?, opacity?, z?, dry? } and
 *  the grid shape map.set('rain' | 'nowcast') and api.drawGrid use { top, left, dlat, dlon, rows, cols, codes, code? | lut? }.
 *  smooth: true (bilinear, the default) | false (nearest) | 'bspline' (quadratic B-spline: smoother, peaks slightly softened).
 *  dry (value fields, optional): values at or under it are "none" (outlined like the radar's). Bad input -> TypeError. */
export function normField(f) {
  if (!f || typeof f !== 'object') throw new TypeError('a field is an object');
  const g = f.grid || f, grid = { top: +g.top, left: +g.left, dlat: +g.dlat, dlon: +g.dlon, rows: g.rows | 0, cols: g.cols | 0 };
  if (!(grid.rows > 0 && grid.cols > 0 && grid.dlat > 0 && grid.dlon > 0 && Number.isFinite(grid.top) && Number.isFinite(grid.left)))
    throw new TypeError('field: a grid { top, left, dlat > 0, dlon > 0, rows > 0, cols > 0 }');
  const raw = f.values || f.codes, n = grid.rows * grid.cols;
  const fmt = raw instanceof Uint8Array || raw instanceof Uint8ClampedArray ? 'u8' : raw instanceof Uint16Array ? 'u16' : raw instanceof Float32Array ? 'f32' : null;
  if (!fmt) throw new TypeError('field: values are a Float32Array, Uint8Array or Uint16Array');
  if (raw.length !== n) throw new TypeError(`field: ${n} values expected (rows x cols), got ${raw.length}`);
  const base = { grid, raw, fmt, smooth: f.smooth === false ? 0 : f.smooth === 'bspline' ? 2 : 1, opacity: f.opacity == null ? 1 : clamp(+f.opacity || 0, 0, 1), z: +f.z || 0 };
  if (f.code || f.lut) {   // one-byte codes and a 256-colour table
    if (fmt !== 'u8') throw new TypeError('field: codes are one byte (Uint8Array)');
    if (f.code && !CODES[f.code]) throw new TypeError(`field: unknown code kind "${f.code}"`);
    const kind = f.code || detect(f.lut), spec = kind ? CODES[kind] : { levelBits: 8, dry: true }, lut = kind ? kindLut(kind) : f.lut;
    return { ...base, mode: 'code', kind, lb: 1 << spec.levelBits, dry: spec.dry, dryBy: dryByOf(lut, spec.levelBits), dryV: null, nodata: f.nodata == null ? null : +f.nodata, scale: 1, offset: 0, lut, ramp: texOf(lut, spec.levelBits), vmin: 0, vmax: 255 };
  }
  if (!f.ramp) throw new TypeError('field: a ramp [[value, [r, g, b, a]], ...]');
  const rt = rampTexture(f.ramp);
  return { ...base, mode: 'value', kind: null, lb: 256, dry: f.dry != null, dryBy: 'value', dryV: f.dry != null ? +f.dry : null, nodata: f.nodata == null ? null : +f.nodata,
    scale: f.scale == null ? 1 : +f.scale, offset: +f.offset || 0, lut: null, ramp: rt.data, vmin: rt.vmin, vmax: rt.vmax };
}

/** one texel's raw value -> { ok (not nodata), wet (not "none"), val (level or physical value), cls } */
export function decode(F, r) {
  const ok = F.fmt === 'f32' ? Number.isFinite(r) && (F.nodata == null || r !== F.nodata) : F.nodata == null || r !== F.nodata;
  if (F.mode === 'code') { const cls = Math.floor(r / F.lb), lv = r - cls * F.lb; return { ok, wet: !F.dry || F.ramp[4 * r + 3] > 0, val: lv, cls }; }
  const v = r * F.scale + F.offset;
  return { ok, wet: F.dryV == null || v > F.dryV, val: v, cls: 0 };
}
/** the quadratic B-spline's weights for the texels at -1, 0, +1 around the nearest centre, d = the offset from it (-0.5..0.5) */
export const bsplineWeights = (d) => [0.5 * (0.5 - d) ** 2, 0.75 - d * d, 0.5 * (0.5 + d) ** 2];
const smoothstep = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
/** premultiplied colour of a ramp-texture lookup (bytes -> 0..1) */
const pm = (c) => { const a = c[3] / 255; return [(c[0] / 255) * a, (c[1] / 255) * a, (c[2] / 255) * a, a]; };

/** the field's colour at texel coordinates (u, v) -> premultiplied [r, g, b, a] 0..1 (transparent: [0, 0, 0, 0]). aa: the half-width of
 *  the dry outline's softening, in wet-fraction units (the map: a texel's size on screen sets it). F.smooth 0 / 1 / 2 as normField. */
export function sampleField(F, u, v, { aa = 0.12 } = {}) {
  const { cols, rows } = F.grid, none = [0, 0, 0, 0];
  if (!(u >= 0 && v >= 0 && u <= cols && v <= rows)) return none;
  const at = (i, j) => decode(F, F.raw[clamp(j, 0, rows - 1) * cols + clamp(i, 0, cols - 1)]);
  const nx = clamp(Math.floor(u), 0, cols - 1), ny = clamp(Math.floor(v), 0, rows - 1), n = at(nx, ny);
  if (!n.ok) return none;   // a nodata cell: crisp, nothing bleeds in
  let taps;
  if (F.smooth === 0) { if (!n.wet) return none; taps = [[nx, ny, 1]]; }
  else if (F.smooth === 2) {
    const wx = bsplineWeights(u - 0.5 - nx), wy = bsplineWeights(v - 0.5 - ny); taps = [];
    for (let j = -1; j <= 1; j++) for (let i = -1; i <= 1; i++) taps.push([nx + i, ny + j, wx[i + 1] * wy[j + 1]]);
  } else {
    const px = u - 0.5, py = v - 0.5, x0 = Math.floor(px), y0 = Math.floor(py), fx = px - x0, fy = py - y0;
    taps = [[x0, y0, (1 - fx) * (1 - fy)], [x0 + 1, y0, fx * (1 - fy)], [x0, y0 + 1, (1 - fx) * fy], [x0 + 1, y0 + 1, fx * fy]];
  }
  let wv = 0, ww = 0, sv = 0; const cw = [0, 0, 0, 0];
  for (const [i, j, w] of taps) { const t = at(i, j); if (!t.ok) continue; wv += w; if (!t.wet) continue; ww += w; sv += w * t.val; cw[t.cls] += w; }
  if (!(ww > 0)) return none;
  const val = sv / ww, shape = F.dry && F.smooth !== 0 ? smoothstep(0.5 - aa, 0.5 + aa, ww / wv) : 1;
  let col = [0, 0, 0, 0];
  if (F.mode === 'code') {
    for (let c = 0; c < 4; c++) if (cw[c] > 0) { const p = pm(rampLerp(F.ramp, c * F.lb + val)); col = col.map((x, k) => x + (cw[c] / ww) * p[k]); }
  } else {
    const t = F.vmax > F.vmin ? clamp((val - F.vmin) / (F.vmax - F.vmin), 0, 1) : 0;
    col = pm(rampLerp(F.ramp, t * 255));
  }
  const k = shape * F.opacity;
  return col.map((x) => x * k);
}

/** the 2D path's picture of a field: one RGBA pixel a texel (straight alpha), today's look (nearest) -> Uint8ClampedArray(4 rows cols) */
export function colorize(F) {
  const n = F.raw.length, out = new Uint8ClampedArray(4 * n), span = F.vmax > F.vmin ? F.vmax - F.vmin : 0;
  for (let i = 0; i < n; i++) {
    const t = decode(F, F.raw[i]); if (!t.ok || !t.wet) continue;
    let c;
    if (F.mode === 'code') { const r = F.raw[i]; c = [F.lut[4 * r], F.lut[4 * r + 1], F.lut[4 * r + 2], F.lut[4 * r + 3]]; }
    else c = rampLerp(F.ramp, span ? clamp((t.val - F.vmin) / span, 0, 1) * 255 : 0);
    out[4 * i] = c[0]; out[4 * i + 1] = c[1]; out[4 * i + 2] = c[2]; out[4 * i + 3] = Math.round(c[3] * F.opacity);
  }
  return out;
}
