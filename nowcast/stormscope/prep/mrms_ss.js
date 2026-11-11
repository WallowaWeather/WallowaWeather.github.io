// prep_js/mrms_ss.js - the MRMS state frames StormScope's MRMS model reads (refc = MergedReflectivityQCComposite_00.50, refc_base =
// Derived from NVIDIA Earth2Studio, earth2studio/data/mrms.py. Copyright (c) 2024-2026 NVIDIA CORPORATION & AFFILIATES, Apache License 2.0 (licenses/Apache-2.0.txt); re-implemented in JavaScript and changed for this app.
// MergedBaseReflectivityQC_00.50) for the 6 input times t0-50 .. t0, mirroring earth2studio/data/mrms.py:
//   - per (time, product): every bucket object within +-10 min (max_offset_minutes), nearest first, ties to the earlier one; a file
//     that does not decode is skipped for the next candidate (as the pygrib "End of resource" fallback), none -> missing
//   - values exactly as eccodes decodes PNG packing ((X * 2^E + R) * 10^-D, float64) then float32 (the .to(torch.float32))
//   - nearest neighbour <= 6 km onto the tile (nn.js), NaN where not valid
// fetchMrms(ctx, t0, tile, tl, grid) -> { values: Float32Array [6][2][n] (raw dBZ, NaN where the interpolator is invalid), nn, files }
import { readGrib2, decodePngRows, gunzip, codeAt, pngHeader } from './app_link.js';
import { s3List, s3Get, ymd, hms } from './s3.js';
import { mrmsNN } from './nn.js';

const BUCKET = 'noaa-mrms-pds', REGION = 'CONUS', MIN = 6e4;
const fr = Math.fround;

/** eccodes codes_power<double>(s, n) */
function codesPower(s, n) { let d = 1.0; if (s === 0) return 1.0; if (s === 1) return n; while (s < 0) { d /= n; s++; } while (s > 0) { d *= n; s--; } return d; }
/** code -> float32 value, as eccodes' PNG unpack then .to(float32) */
export function mrmsLut(meta) {
  const n = 1 << (meta.nbits || 16), lut = new Float32Array(n), b = codesPower(meta.E, 2), d = codesPower(-meta.D, 10), R = meta.R;
  for (let x = 0; x < n; x++) lut[x] = ((x * b) + R) * d;
  return lut;
}

/** candidate objects of one product for the whole window [t0 - 50 - tol, t0 + tol] (one list per UTC day touched) */
async function listProduct(ctx, product, tmin, tmax) {
  const out = [], re = new RegExp(`^MRMS_${product.replace(/\./g, '\\.')}_(\\d{8})-(\\d{6})\\.grib2\\.gz$`);
  for (let d = Date.UTC(new Date(tmin).getUTCFullYear(), new Date(tmin).getUTCMonth(), new Date(tmin).getUTCDate()); d <= tmax; d += 864e5) {
    const pre = `${REGION}/${product}/${ymd(d)}/`;
    const startAfter = d < tmin ? `${pre}MRMS_${product}_${ymd(tmin)}-${hms(tmin)}` : '';
    const stopAfter = `${pre}MRMS_${product}_${ymd(tmax)}-${hms(tmax)}.grib2.gz~`;
    for (const o of await s3List(ctx, 'mrms', BUCKET, pre, { startAfter, maxKeys: 100, stopAfter })) {
      const m = re.exec(o.key.slice(pre.length)); if (!m) continue;
      const s = m[1], h = m[2], t = Date.UTC(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8), +h.slice(0, 2), +h.slice(2, 4), +h.slice(4, 6));
      out.push({ t, key: o.key, size: o.size });
    }
  }
  return out;
}
/** _resolve_s3_time_candidates: within +-tol, sorted by (|dt|, t) */
export function candidatesFor(list, t, tolMin = 10) {
  return list.filter((o) => Math.abs(o.t - t) <= tolMin * MIN).sort((a, b) => Math.abs(a.t - t) - Math.abs(b.t - t) || a.t - b.t);
}

/** decode one gzipped GRIB2 frame, read only the rows the tile needs -> Float32Array [n] (NaN where nn invalid) */
async function sampleFrame(gz, nn, refGrid, n) {
  const g = readGrib2(await gunzip(gz)), m = g.meta;
  if (m.ni !== refGrid.Ni || m.nj !== refGrid.Nj || Math.abs(m.la1 - refGrid.lat0) > 1e-9 || Math.abs(m.lo1 - refGrid.lon0) > 1e-9
    || Math.abs(m.di - refGrid.dlon) > 1e-12 || Math.abs(m.dj - refGrid.dlat) > 1e-12)
    throw Object.assign(new Error('MRMS grid changed: ' + JSON.stringify(m)), { code: 'MRMS_GRID' });
  const lut = mrmsLut(m), out = new Float32Array(n).fill(NaN), byRow = new Map();
  for (let k = 0; k < n; k++) {
    if (!nn.valid[k]) continue;
    const r = Math.floor(nn.idx[k] / m.ni); let l = byRow.get(r); if (!l) byRow.set(r, (l = [])); l.push(k);
  }
  const [r0, r1] = nn.rows;
  if (r0 <= r1) {
    const { bpp, w } = pngHeader(g.png);
    if (w !== m.ni) throw Object.assign(new Error('MRMS PNG width ' + w), { code: 'BAD_RADAR' });
    await decodePngRows(g.png, { from: r0, to: r1 + 1, onRow(y, row) {
      const l = byRow.get(y); if (!l) return;
      for (const k of l) out[k] = lut[codeAt(row, nn.idx[k] % m.ni, bpp)];
    } });
  }
  return out;
}

export async function fetchMrms(ctx, t0, tile, tl, grid, { nIn = 6, stepMin = 10, nn: nnIn = null } = {}) {
  const J = grid.json.mrms, products = [J.products.refc, J.products.refc_base], tol = J.max_offset_minutes, n = tl.lat.length;
  const times = Array.from({ length: nIn }, (_, i) => t0 + (i - nIn + 1) * stepMin * MIN);
  const ms0 = Date.now();
  const nn = nnIn || mrmsNN(tile, tl, J.ref_grid, grid);   // v057: the layer cache passes its tile's map
  const lists = await Promise.all(products.map((p) => listProduct(ctx, p, times[0] - tol * MIN, times[nIn - 1] + tol * MIN)));
  const values = new Float32Array(nIn * 2 * n).fill(NaN), files = [];
  let done = 0;
  await Promise.all(times.flatMap((t, ti) => products.map(async (p, vi) => {
    const cands = candidatesFor(lists[vi], t, tol); let last = null, ok = false;
    for (const c of cands) {
      const gz = await s3Get(ctx, 'mrms', BUCKET, c.key);
      try {
        values.set(await sampleFrame(gz, nn, J.ref_grid, n), (ti * 2 + vi) * n);
        files.push({ t, product: p, key: c.key, actual: c.t, bytes: gz.length }); ok = true; break;
      } catch (e) { if (e.code === 'MRMS_GRID') throw e; last = e; }
    }
    if (!ok) files.push({ t, product: p, missing: true, error: last ? String(last.message || last) : 'no file within +-' + tol + ' min' });
    ctx.progress('mrms', ++done / (nIn * 2));
  })));
  return { values, nn, files, times, ms: Date.now() - ms0 };
}
