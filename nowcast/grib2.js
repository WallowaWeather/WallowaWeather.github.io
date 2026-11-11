// nowcast/grib2.js - a small GRIB2 reader for NOAA MRMS frames (public domain data): one message, grid template 3.0 (regular
// latitude / longitude), data template 5.41 (PNG packing), no bitmap. The PNG inside is 8-bit (PrecipFlag) or 16-bit (PrecipRate)
// greyscale; browsers' image decoders drop 16-bit to 8, so it is decoded here: zlib through DecompressionStream, our own unfilter.
// Pure (no DOM): runs in a page, a worker and Node 18+.
//   const g = readGrib2(await gunzip(bytes));            // { meta, png }
//   await decodePngRows(g.png, { from, to, onRow(y, row) })  // row = the unfiltered bytes of one image row
//   const lut = valueLut(g.meta)                          // code -> value (Float32Array), < 0 (missing) as given

/** gzip -> bytes (DecompressionStream) */
export async function gunzip(u8) { return collect(new Blob([u8]).stream().pipeThrough(new DecompressionStream('gzip'))); }
async function collect(stream) {
  const parts = []; let n = 0; const rd = stream.getReader();
  for (;;) { const { done, value } = await rd.read(); if (done) break; parts.push(value); n += value.length; }
  const out = new Uint8Array(n); let o = 0; for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

const u32 = (b, p) => ((b[p] << 24) | (b[p + 1] << 16) | (b[p + 2] << 8) | b[p + 3]) >>> 0;
const u16 = (b, p) => (b[p] << 8) | b[p + 1];
// GRIB2 signed integers are sign-and-magnitude: the top bit is the sign
const s32 = (b, p) => { const v = u32(b, p); return v & 0x80000000 ? -(v & 0x7fffffff) : v; };
const s16 = (b, p) => { const v = u16(b, p); return v & 0x8000 ? -(v & 0x7fff) : v; };

/** one GRIB2 message -> { meta: {ni, nj, la1, lo1, la2, lo2, di, dj, scan, R, E, D, nbits, ref, discipline, cat, num}, png } */
export function readGrib2(b) {
  if (!(b && b.length > 16 && b[0] === 0x47 && b[1] === 0x52 && b[2] === 0x49 && b[3] === 0x42)) throw gribErr('not a GRIB file');
  if (b[7] !== 2) throw gribErr('not GRIB edition 2');
  const meta = { discipline: b[6] }; let png = null, p = 16;
  while (p + 5 <= b.length) {
    if (b[p] === 0x37 && b[p + 1] === 0x37 && b[p + 2] === 0x37 && b[p + 3] === 0x37) break;   // '7777'
    const L = u32(b, p), n = b[p + 4];
    if (L < 5 || p + L > b.length) throw gribErr('a GRIB section runs past the end');
    if (n === 1) meta.ref = { y: u16(b, p + 12), mo: b[p + 14], d: b[p + 15], h: b[p + 16], mi: b[p + 17], s: b[p + 18] };
    else if (n === 3) {
      if (u16(b, p + 12) !== 0) throw gribErr('grid template ' + u16(b, p + 12) + ' (only 3.0 is read)');
      Object.assign(meta, { ni: u32(b, p + 30), nj: u32(b, p + 34), la1: s32(b, p + 46) / 1e6, lo1: s32(b, p + 50) / 1e6, la2: s32(b, p + 55) / 1e6,
        lo2: s32(b, p + 59) / 1e6, di: u32(b, p + 63) / 1e6, dj: u32(b, p + 67) / 1e6, scan: b[p + 71] });
    } else if (n === 4) { meta.cat = b[p + 9]; meta.num = b[p + 10]; }
    else if (n === 5) {
      if (u16(b, p + 9) !== 41) throw gribErr('data template 5.' + u16(b, p + 9) + ' (only 5.41, PNG, is read)');
      meta.npts = u32(b, p + 5);
      meta.R = new DataView(b.buffer, b.byteOffset + p + 11, 4).getFloat32(0, false); meta.E = s16(b, p + 15); meta.D = s16(b, p + 17); meta.nbits = b[p + 19];
    } else if (n === 6) { if (b[p + 5] !== 255) throw gribErr('a bitmap section (not read)'); }
    else if (n === 7) png = b.subarray(p + 5, p + L);
    p += L;
  }
  if (!png || meta.ni == null || meta.R == null) throw gribErr('missing GRIB sections');
  if (meta.scan !== 0) throw gribErr('scan mode ' + meta.scan + ' (only 0 is read)');
  return { meta, png };
}
const gribErr = (m) => Object.assign(new Error('MRMS file: ' + m), { code: 'BAD_RADAR' });

/** the value of every code: (R + X * 2^E) / 10^D in float64, then float32 (as numpy does with the same file) */
export function valueLut(meta) {
  const n = 1 << (meta.nbits || 16), lut = new Float32Array(n), e = 2 ** meta.E, d = 10 ** meta.D;
  for (let x = 0; x < n; x++) lut[x] = (meta.R + x * e) / d;
  return lut;
}

/** the PNG's header -> { w, h, depth, bpp } (greyscale, not interlaced) */
export function pngHeader(png) {
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  for (let i = 0; i < 8; i++) if (png[i] !== sig[i]) throw gribErr('the packed field is not a PNG');
  if (!(png[12] === 0x49 && png[13] === 0x48 && png[14] === 0x44 && png[15] === 0x52)) throw gribErr('PNG without IHDR');
  const w = u32(png, 16), h = u32(png, 20), depth = png[24], ct = png[25], il = png[28];
  if (ct !== 0 || il !== 0 || (depth !== 8 && depth !== 16)) throw gribErr(`PNG type ${ct}/${depth}/${il} (8- or 16-bit greyscale only)`);
  return { w, h, depth, bpp: depth / 8 };
}
/** the zlib stream of every IDAT chunk, in order (a stream of subarrays, no copy) */
function idatStream(png) {
  let p = 8; const parts = [];
  while (p + 12 <= png.length) {
    const L = u32(png, p), t = String.fromCharCode(png[p + 4], png[p + 5], png[p + 6], png[p + 7]);
    if (t === 'IDAT') parts.push(png.subarray(p + 8, p + 8 + L));
    if (t === 'IEND') break;
    p += 12 + L;
  }
  let i = 0;
  return new ReadableStream({ pull(c) { if (i < parts.length) c.enqueue(parts[i++]); else c.close(); } });
}

/** decode the PNG's rows [from, to) in order: onRow(y, row) gets each row's unfiltered bytes (the same array every call: copy what is
 *  kept). Rows before `from` are unfiltered too (each row needs the one above) but not handed out; the inflate stops after `to`.
 *  -> { w, h, depth, filters: [count of each filter type] } */
export async function decodePngRows(png, { from = 0, to = Infinity, onRow } = {}) {
  const H = pngHeader(png), { w, h, bpp } = H, stride = w * bpp, end = Math.min(h, to);
  let prev = new Uint8Array(stride), cur = new Uint8Array(stride), y = 0, k = -1, ftype = 0;   // k: bytes of the current row so far (-1 = the filter byte)
  const filters = [0, 0, 0, 0, 0];
  const rd = idatStream(png).pipeThrough(new DecompressionStream('deflate')).getReader();
  try {
    outer: for (;;) {
      const { done, value } = await rd.read(); if (done) break;
      let i = 0; const n = value.length;
      while (i < n) {
        if (k < 0) { ftype = value[i++]; if (ftype > 4) throw gribErr('bad PNG filter ' + ftype); filters[ftype]++; k = 0; continue; }
        const take = Math.min(stride - k, n - i);
        cur.set(value.subarray(i, i + take), k); i += take; k += take;
        if (k < stride) continue;
        unfilter(ftype, cur, prev, bpp, stride);
        if (y >= from && onRow) onRow(y, cur);
        const t = prev; prev = cur; cur = t; y++; k = -1;
        if (y >= end) break outer;
      }
    }
  } finally { try { await rd.cancel(); } catch (e) { /* already closed */ } }
  if (y < end) throw gribErr(`PNG ended at row ${y} of ${end}`);
  return { w, h, depth: H.depth, filters };
}
function unfilter(f, cur, prev, bpp, n) {
  if (f === 0) return;
  if (f === 1) { for (let i = bpp; i < n; i++) cur[i] = cur[i] + cur[i - bpp]; return; }
  if (f === 2) { for (let i = 0; i < n; i++) cur[i] = cur[i] + prev[i]; return; }
  if (f === 3) {
    for (let i = 0; i < bpp; i++) cur[i] = cur[i] + (prev[i] >> 1);
    for (let i = bpp; i < n; i++) cur[i] = cur[i] + ((cur[i - bpp] + prev[i]) >> 1);
    return;
  }
  for (let i = 0; i < n; i++) {   // Paeth
    const a = i >= bpp ? cur[i - bpp] : 0, b = prev[i], c = i >= bpp ? prev[i - bpp] : 0;
    const pp = a + b - c, pa = Math.abs(pp - a), pb = Math.abs(pp - b), pc = Math.abs(pp - c);
    cur[i] = cur[i] + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
  }
}
/** the code at column x of a row handed to onRow (16-bit big-endian, or 8-bit) */
export const codeAt = (row, x, bpp) => (bpp === 2 ? (row[2 * x] << 8) | row[2 * x + 1] : row[x]);
