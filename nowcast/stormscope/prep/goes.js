// prep_js/goes.js - GOES-East ABI L2 MCMIPC (CONUS) for StormScope's 6 condition times, mirroring earth2studio/data/goes.py with
// Derived from NVIDIA Earth2Studio, earth2studio/data/goes.py. Copyright (c) 2024-2026 NVIDIA CORPORATION & AFFILIATES, Apache License 2.0 (licenses/Apache-2.0.txt); re-implemented in JavaScript and changed for this app.
// GOES(satellite, scan_mode="C") as prep_case.py builds it (goes19 for t0 >= 2025-04-07, goes16 before):
//   - file: list the hour directory of each time, keep OR_ABI-L2-MCMIPC objects, take the scan start (s... stamp, tenths dropped)
//     nearest to the time (first one on a tie), like GOES._get_s3_path
//   - values: CMI_Cxx as xarray decodes them (_Unsigned -> uint16, _FillValue -> NaN, float32 x * scale_factor + add_offset)
//   - only the HDF5 chunks under the tile's nearest-neighbour source pixels are read (Range GETs), plus the metadata pages
//   - nearest neighbour <= 6 km onto the tile (nn.js), NaN where not valid
// fetchGoes(ctx, t0, tile, tl, grid) -> { values: Float32Array [6][8][n], nn, files }
import { H5File, httpSource } from './hdf5.js';
import { s3List, objectUrl, doy, parseYjHMS } from './s3.js';
import { goesNN } from './nn.js';

const MIN = 6e4, fr = Math.fround;
export const GOES19_FROM = Date.UTC(2025, 3, 7);
export const satelliteFor = (t0) => (t0 >= GOES19_FROM ? 'goes19' : 'goes16');
const hourPrefix = (t) => { const d = new Date(t); return `ABI-L2-MCMIPC/${d.getUTCFullYear()}/${String(doy(t)).padStart(3, '0')}/${String(d.getUTCHours()).padStart(2, '0')}/`; };
export const scanStart = (key) => { const p = key.split('/').pop().split('_'); return parseYjHMS(p[p.length - 3].slice(1, -1)); };

/** the file GOES._get_s3_path picks for time t among the hour listing */
export function pickGoesFile(listing, t) {
  const files = listing.filter((o) => o.key.includes('OR_ABI-L2-MCMIPC'));
  if (!files.length) return null;
  let best = 0, bd = Infinity;
  files.forEach((o, i) => { const d = Math.abs(scanStart(o.key) - t); if (d < bd) { bd = d; best = i; } });
  return files[best];
}

export async function listGoesHours(ctx, sat, times, cache = new Map()) {
  const bucket = 'noaa-' + sat;
  await Promise.all([...new Set(times.map(hourPrefix))].filter((p) => !cache.has(p)).map(async (p) => cache.set(p, await s3List(ctx, 'goes', bucket, p))));
  return cache;
}

/** decode one band for the tile pixels from the chunks read */
function bandValues(ds, attrs, chunkMap, nn, n, NX, out, o) {
  const [cr, cc] = ds.chunkShape, es = ds.dtype.size, le = ds.dtype.le;
  const uns = String(attrs._Unsigned || '').toLowerCase() === 'true';
  const sf = attrs.scale_factor, ao = attrs.add_offset;
  const fills = [attrs._FillValue, attrs.missing_value].filter((v) => v !== undefined).map((v) => (uns ? v & 0xffff : v));
  for (let k = 0; k < n; k++) {
    if (!nn.valid[k]) { out[o + k] = NaN; continue; }
    const r = Math.floor(nn.idx[k] / NX), c = nn.idx[k] % NX, key = `${Math.floor(r / cr) * cr},${Math.floor(c / cc) * cc}`, u8 = chunkMap.get(key);
    if (!u8) { out[o + k] = NaN; continue; }   // unallocated chunk = fill
    const p = ((r % cr) * cc + (c % cc)) * es; let v;
    if (es === 2) { v = le ? u8[p] | (u8[p + 1] << 8) : (u8[p] << 8) | u8[p + 1]; if (!uns && v & 0x8000) v -= 0x10000; }
    else throw new Error('GOES: unexpected element size ' + es);
    if (fills.includes(v)) { out[o + k] = NaN; continue; }
    let x = v;   // xarray: astype(float32); x *= scale_factor; x += add_offset (float32 arithmetic)
    if (sf !== undefined) x = fr(fr(x) * fr(sf));
    if (ao !== undefined) x = fr(x + fr(ao));
    out[o + k] = fr(x);
  }
}

export async function fetchGoes(ctx, t0, tile, tl, grid, { nIn = 6, stepMin = 10, prefetch = 131072, prefetchTail = 262144, page = 32768, listCache, nn: nnIn = null } = {}) {
  const J = grid.json.goes, bands = J.bands, NX = J.dims[1], n = tl.lat.length, sat = satelliteFor(t0), bucket = 'noaa-' + sat;
  const times = Array.from({ length: nIn }, (_, i) => t0 + (i - nIn + 1) * stepMin * MIN), ms0 = Date.now();
  const nn = nnIn || goesNN(tile, tl, grid);   // v057: the layer cache passes its tile's map
  const lists = await listGoesHours(ctx, sat, times, listCache);
  const values = new Float32Array(nIn * bands.length * n).fill(NaN), files = []; let done = 0;
  await Promise.all(times.map(async (t, ti) => {
    const obj = pickGoesFile(lists.get(hourPrefix(t)) || [], t);
    if (!obj) throw Object.assign(new Error(`no GOES ${sat} CONUS file in ${hourPrefix(t)}`), { code: 'GOES_MISSING' });
    const st = ctx.stat('goes');
    const src = httpSource(objectUrl(bucket, obj.key), { fetchFn: (u, o) => ctx.fetch('goes', u, o), onBytes: (b) => ctx.count('goes', b), prefetch, prefetchTail, page, size: obj.size });
    const f = await H5File.open(src);
    await Promise.all(bands.map(async (b, bi) => {
      const ds = await f.dataset(b), [attrs, chunks] = await Promise.all([ds.attrs(), ds.chunks()]);
      const [cr, cc] = ds.chunkShape, want = new Set();
      for (let k = 0; k < n; k++) if (nn.valid[k]) { const r = Math.floor(nn.idx[k] / NX), c = nn.idx[k] % NX; want.add(`${Math.floor(r / cr) * cr},${Math.floor(c / cc) * cc}`); }
      const list = chunks.filter((ch) => want.has(ch.coord.join(',')));
      const cm = await ds.readChunks(list);
      bandValues(ds, attrs, cm, nn, n, NX, values, (ti * bands.length + bi) * n);
    }));
    st.files++;
    files.push({ t, key: obj.key, scan_start: scanStart(obj.key), size: obj.size, bytes: src.bytes, requests: src.requests });
    ctx.progress('goes', ++done / nIn);
  }));
  files.sort((a, b) => a.t - b.t);
  return { values, nn, files, times, satellite: sat, ms: Date.now() - ms0 };
}
