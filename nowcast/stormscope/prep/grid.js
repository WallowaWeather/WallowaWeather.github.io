// prep_js/grid.js - the static StormScope grid pack (export_static.py + build_fixes.mjs) -> typed arrays, and the model grid itself.
// Derived from NVIDIA Earth2Studio, earth2studio/models/px/stormscope.py (the model grid; the static fields come from the StormScope model package, NVIDIA Open Model License). Copyright (c) 2024-2026 NVIDIA CORPORATION & AFFILIATES, Apache License 2.0 (licenses/Apache-2.0.txt); re-implemented in JavaScript and changed for this app.
// Pure ES module (browser + Node 18+).
//   const grid = await loadGrid(arrayBuffer, json)
//   grid.topo / grid.nexrad (Float32Array H*W, the 1024 x 1792 crop), grid.coverage (Uint8Array, 1 = inside NEXRAD coverage),
//   grid.rope(h, w) -> { cos, sin } Float32Array [h, w, 128], grid.goesX / goesY, grid.glm{LatEdges, LonEdges, LatC, LonC},
//   grid.fix.goes / grid.fix.mrms (Map crop pixel -> {idx, valid}), grid.json (constants)
//   modelLatLon(r, c) -> { lat, lon } float32 values exactly as the model's buffers (lat; lon in [0, 360))
import { hrrrLatLon } from './app_link.js';
import { inflate } from './hdf5.js';

const CT = { float32: Float32Array, float64: Float64Array, int32: Int32Array, uint8: Uint8Array, uint32: Uint32Array, int16: Int16Array };
const fr = Math.fround;

async function section(buf, s) {
  const u = new Uint8Array(buf, s.offset, s.bytes), n = s.shape.reduce((a, b) => a * b, 1);
  if (s.codec === 'raw') { const C = CT[s.dtype], ab = u.slice().buffer; return new C(ab, 0, n); }
  if (s.codec === 'deflate') { const C = CT[s.dtype], z = await inflate(u); return new C(z.slice().buffer, 0, n); }
  if (s.codec === 'bits') {
    const z = await inflate(u), out = new Uint8Array(n);
    for (let i = 0; i < n; i++) out[i] = (z[i >> 3] >> (i & 7)) & 1;
    return out;
  }
  if (s.codec === 'f32d2s') {   // undo: zlib, byte planes, row delta, column delta (uint32, mod 2^32)
    const z = await inflate(u), [h, w] = s.shape, bits = new Uint32Array(n), b8 = new Uint8Array(bits.buffer);
    for (let p = 0; p < 4; p++) { const base = p * n; for (let i = 0; i < n; i++) b8[i * 4 + p] = z[base + i]; }
    for (let y = 1; y < h; y++) { const o = y * w, q = o - w; for (let x = 0; x < w; x++) bits[o + x] = (bits[o + x] + bits[q + x]) >>> 0; }
    for (let y = 0; y < h; y++) { const o = y * w; for (let x = 1; x < w; x++) bits[o + x] = (bits[o + x] + bits[o + x - 1]) >>> 0; }
    return new Float32Array(bits.buffer);
  }
  throw new Error('grid pack: unknown codec ' + s.codec);
}

/** parse the grid pack (ArrayBuffer of grid_pack.bin, and the parsed grid_pack.json) */
export async function loadGrid(arrayBuffer, json) {
  if (json.format !== 'stormscope-mrms-gridpack-v1') throw new Error('grid pack: unknown format ' + json.format);
  const buf = arrayBuffer instanceof ArrayBuffer ? arrayBuffer : arrayBuffer.buffer.slice(arrayBuffer.byteOffset, arrayBuffer.byteOffset + arrayBuffer.byteLength);
  const S = json.sections, get = (k) => section(buf, S[k]);
  const [topo, nexrad, coverage, crow, srow, ccol, scol, goesY, goesX, le, lo, lc, oc] = await Promise.all(
    ['topo', 'nexrad_proximity', 'mrms_coverage', 'rope_cos_row', 'rope_sin_row', 'rope_cos_col', 'rope_sin_col', 'goes_y', 'goes_x',
      'glm_lat_edges', 'glm_lon_edges', 'glm_lat_centres', 'glm_lon_centres'].map(get));
  const fix = { goes: new Map(), mrms: new Map() };
  for (const k of ['goes', 'mrms']) {
    const s = S['nn_fix_' + k]; if (!s) continue;
    const t = await section(buf, s);   // int32 [n, 3]: crop pixel, source flat index, valid
    for (let i = 0; i < s.shape[0]; i++) fix[k].set(t[3 * i], { idx: t[3 * i + 1], valid: t[3 * i + 2] });
  }
  const { H, W } = json.grid, half = json.rope.head_dim / 2, T = json.rope.tokens;
  return {
    json, H, W, cropY: json.grid.crop_y, cropX: json.grid.crop_x, topo, nexrad, coverage, goesX, goesY,
    glmLatEdges: le, glmLonEdges: lo, glmLatC: lc, glmLonC: oc, fix, hasFixes: !!(S.nn_fix_goes && S.nn_fix_mrms),
    /** exact axial RoPE tables for an h x w token grid (h, w <= 51): cos/sin [h, w, 128] = [row half | column half] */
    rope(h, w) {
      if (h > T || w > T) throw new Error('rope: token grid larger than the pack');
      const cos = new Float32Array(h * w * 2 * half), sin = new Float32Array(h * w * 2 * half);
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const o = (y * w + x) * 2 * half;
        cos.set(crow.subarray(y * half, (y + 1) * half), o); cos.set(ccol.subarray(x * half, (x + 1) * half), o + half);
        sin.set(srow.subarray(y * half, (y + 1) * half), o); sin.set(scol.subarray(x * half, (x + 1) * half), o + half);
      }
      return { cos, sin };
    },
  };
}

/** the model grid at crop pixel (r = row from the south, c = column): float32 lat, and lon in [0, 360) exactly as
 *  StormScopeBase builds it ((lon.npy + 360) % 360 in float32) */
export function modelLatLon(r, c, cropY = 17, cropX = 3) {
  const q = hrrrLatLon(c + cropX, r + cropY), lat = fr(q.lat), lon = fr(q.lon);
  return { lat, lon: fr(lon + 360) % 360 };
}

/** lat / lon (float32, lon in [0, 360)) of every pixel of a tile {y0, y1, x0, x1} */
export function tileLatLon(tile, grid) {
  const h = tile.y1 - tile.y0, w = tile.x1 - tile.x0, lat = new Float32Array(h * w), lon = new Float32Array(h * w);
  const cy = grid ? grid.cropY : 17, cx = grid ? grid.cropX : 3;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const q = modelLatLon(tile.y0 + y, tile.x0 + x, cy, cx); lat[y * w + x] = q.lat; lon[y * w + x] = q.lon; }
  return { lat, lon, h, w };
}

/** a full-grid field cut to a tile */
export function cutTile(field, W, tile) {
  const h = tile.y1 - tile.y0, w = tile.x1 - tile.x0, out = new (field.constructor)(h * w);
  for (let y = 0; y < h; y++) out.set(field.subarray((tile.y0 + y) * W + tile.x0, (tile.y0 + y) * W + tile.x1), y * w);
  return out;
}
