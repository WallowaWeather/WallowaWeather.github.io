// Part of BEAM's phone code (kept identical to BEAM's own build).
// js/shared/grib2.js - from the Wallowa Weather app's nowcast/grib2.js (BEAM phone port, used by the radar builder). Changed for phones
// (2026-11-08): the PNG rows are inflated here, synchronously, into one reused 1 MB window (no DecompressionStream chunks, no garbage
// per row), only the bytes of the columns asked for are unfiltered, rows before `from` that no later row reads are not unfiltered, and
// the inflate stops at the last row asked for. The bytes handed out are the same as before (fixtures: 100 % identical).
// Provenance: the inflate, unfilter and row code here were written from scratch for this project (2026-11-08) from RFC 1950/1951 and the PNG spec (the length/distance tables are the RFC's); no third-party code was copied or ported.
// nowcast/grib2.js - a small GRIB2 reader for NOAA MRMS frames (public domain data): one message, grid template 3.0 (regular
// latitude / longitude), data template 5.41 (PNG packing), no bitmap. The PNG inside is 8-bit (PrecipFlag) or 16-bit (PrecipRate)
// greyscale; browsers' image decoders drop 16-bit to 8, so it is decoded here: zlib inflated in JS (the outer gzip through
// DecompressionStream), our own unfilter. Pure (no DOM): runs in a page, a worker and Node 18+.
//   const g = readGrib2(await gunzip(bytes));            // { meta, png }
//   decodePngRowsSync(g.png, { from, to, cols, onRow(y, row) })   // row = the unfiltered bytes of one image row (its first `cols` pixels)
//   await decodePngRows(g.png, { ... })                   // the same, as a promise (the old interface)
//   const lut = valueLut(g.meta)                          // code -> value (Float32Array), < 0 (missing) as given

/** gzip -> bytes (DecompressionStream; the bytes are written to it directly, and collected into one buffer of the size the gzip
 *  trailer states, so the file is not copied on the way in and the output not twice on the way out) */
export async function gunzip(u8) {
  if (!(u8 instanceof Uint8Array)) u8 = new Uint8Array(u8);
  const ds = new DecompressionStream('gzip'), w = ds.writable.getWriter(), n = u8.length;
  w.write(u8).catch(() => {}); w.close().catch(() => {});   // a bad file rejects the reads below
  const isize = n >= 18 ? ((u8[n - 4] | (u8[n - 3] << 8) | (u8[n - 2] << 16) | (u8[n - 1] << 24)) >>> 0) : 0;
  return collect(ds.readable, isize <= Math.min(8 * n + 65536, 1 << 26) ? isize : 0);   // a hint only (a cut file's trailer is noise)
}
async function collect(stream, hint = 0) {
  const rd = stream.getReader(); let buf = hint > 0 ? new Uint8Array(hint) : null, o = 0, parts = null;
  for (;;) {
    const { done, value } = await rd.read(); if (done) break;
    if (buf && o + value.length <= buf.length) { buf.set(value, o); o += value.length; continue; }
    if (!parts) { parts = buf ? [buf.subarray(0, o)] : []; buf = null; }   // longer than the hint said
    parts.push(value); o += value.length;
  }
  if (!parts) return buf ? (o === buf.length ? buf : buf.subarray(0, o)) : new Uint8Array(0);
  if (parts.length === 1) return parts[0];
  const out = new Uint8Array(o); let p = 0; for (const x of parts) { out.set(x, p); p += x.length; }
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

// ------------------------------------------------------------------------------------------------ inflate (RFC 1950 / 1951)
// Synchronous and resumable: run(out, op, limit) writes from out[op] until op reaches `limit` (a match may run up to 258 bytes past it)
// or the stream ends. Errors carry no code (a broken file is a gap, as a DecompressionStream error was).
const LBASE = Uint16Array.of(3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258);
const LEXT = Uint8Array.of(0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0);
const DBASE = Uint16Array.of(1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577);
const DEXT = Uint8Array.of(0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13);
const CLORD = Uint8Array.of(16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15);
const REV = new Uint16Array(32768);   // 15-bit bit reversal (Huffman codes are sent most significant bit first)
{ const r8 = new Uint8Array(256); for (let i = 0; i < 256; i++) { let x = i, r = 0; for (let b = 0; b < 8; b++) { r = (r << 1) | (x & 1); x >>= 1; } r8[i] = r; }
  for (let i = 0; i < 32768; i++) REV[i] = ((r8[i & 255] << 8) | r8[i >> 8]) >> 1; }
const inflErr = (m) => new Error('MRMS file: bad zlib data (' + m + ')');
const COUNT = new Uint16Array(16), NEXT = new Uint16Array(16);
/** canonical code lengths L[off .. off + n) -> decode table t indexed by the next `bits` input bits: entry = symbol << 4 | length (0: no
 *  code). -> bits */
function huffTable(L, off, n, t) {
  let mb = 0; COUNT.fill(0);
  for (let i = 0; i < n; i++) { const l = L[off + i]; COUNT[l]++; if (l > mb) mb = l; }
  if (mb === 0) { t[0] = 0; t[1] = 0; return 1; }   // no codes: any use is an error
  COUNT[0] = 0; let code = 0;
  for (let l = 1; l <= mb; l++) { code = (code + COUNT[l - 1]) << 1; NEXT[l] = code; }
  const size = 1 << mb; t.fill(0, 0, size);
  for (let s = 0; s < n; s++) {
    const l = L[off + s]; if (!l) continue;
    const c = NEXT[l]++; if (c >= 1 << l) throw inflErr('over-subscribed code');
    const e = (s << 4) | l, step = 1 << l;
    for (let r = REV[c] >> (15 - l); r < size; r += step) t[r] = e;
  }
  return mb;
}
const LT = new Uint16Array(32768), DT = new Uint16Array(32768), CT = new Uint16Array(128), LENS = new Uint8Array(320), CLL = new Uint8Array(19);
let FLT = null, FDT = null;
function fixedTables() {
  if (FLT) return;
  const L = new Uint8Array(320);
  for (let i = 0; i < 288; i++) L[i] = i < 144 ? 8 : i < 256 ? 9 : i < 280 ? 7 : 8;
  for (let i = 288; i < 320; i++) L[i] = 5;
  FLT = new Uint16Array(512); huffTable(L, 0, 288, FLT);
  FDT = new Uint16Array(32); huffTable(L, 288, 32, FDT);
}

class Inflate {
  /** d: the deflate data from byte `start`, with at least 4 zero bytes after `len` (the bit reader reads 3 bytes at a time) */
  constructor(d, start, len) { this.d = d; this.pos = start * 8; this.end = (start + len) * 8; this.state = 0; this.final = 0; this.left = 0; this.lt = LT; this.lb = 1; this.dt = DT; this.db = 1; }
  get done() { return this.state === 3; }
  run(out, op, limit) {
    const d = this.d; let pos = this.pos;
    while (op < limit) {
      if (this.state === 0) {                                   // a block header
        if (this.final) { this.state = 3; break; }
        if (pos + 3 > this.end) throw inflErr('the data ends early');
        let p = pos >> 3; const hb = (d[p] | (d[p + 1] << 8)) >> (pos & 7), t = (hb >> 1) & 3;
        this.final = hb & 1; pos += 3;
        if (t === 0) {
          p = (pos + 7) >> 3; const len = d[p] | (d[p + 1] << 8), nlen = d[p + 2] | (d[p + 3] << 8);
          if ((len ^ 0xffff) !== nlen) throw inflErr('stored block length');
          pos = (p + 4) * 8; this.left = len; this.state = len ? 1 : 0;
        } else if (t === 1) { fixedTables(); this.lt = FLT; this.lb = 9; this.dt = FDT; this.db = 5; this.state = 2; }
        else if (t === 2) { pos = this.dynamic(pos); this.state = 2; }
        else throw inflErr('block type 3');
        continue;
      }
      if (this.state === 1) {                                   // stored bytes
        const n = Math.min(this.left, limit - op), p = pos >> 3;
        if ((p + n) * 8 > this.end) throw inflErr('the data ends early');
        out.set(d.subarray(p, p + n), op); op += n; pos += n * 8; this.left -= n;
        if (!this.left) this.state = 0;
        continue;
      }
      const lt = this.lt, lm = (1 << this.lb) - 1, dt = this.dt, dm = (1 << this.db) - 1;
      while (op < limit) {                                      // Huffman codes
        let p = pos >> 3, e = lt[((d[p] | (d[p + 1] << 8) | (d[p + 2] << 16)) >> (pos & 7)) & lm];
        const s = e >> 4;
        if (s < 256) { if (e === 0) throw inflErr('bad literal/length code'); pos += e & 15; out[op++] = s; continue; }
        pos += e & 15;
        if (s === 256) { this.state = 0; break; }
        const li = s - 257; if (li > 28) throw inflErr('bad length code');
        let len = LBASE[li]; const le = LEXT[li];
        if (le) { p = pos >> 3; len += ((d[p] | (d[p + 1] << 8)) >> (pos & 7)) & ((1 << le) - 1); pos += le; }
        p = pos >> 3; e = dt[((d[p] | (d[p + 1] << 8) | (d[p + 2] << 16)) >> (pos & 7)) & dm];
        const ds = e >> 4; if (e === 0 || ds > 29) throw inflErr('bad distance code');
        pos += e & 15;
        let dist = DBASE[ds]; const de = DEXT[ds];
        if (de) { p = pos >> 3; dist += ((d[p] | (d[p + 1] << 8) | (d[p + 2] << 16)) >> (pos & 7)) & ((1 << de) - 1); pos += de; }
        if (dist > op) throw inflErr('distance too far back');
        let f = op - dist; const stop = op + len;
        if (dist === 1) { out.fill(out[f], op, stop); op = stop; }
        else if (dist >= len && len > 24) { out.copyWithin(op, f, f + len); op = stop; }
        else while (op < stop) out[op++] = out[f++];
      }
      if (pos > this.end) throw inflErr('the data ends early');
    }
    if (pos > this.end) throw inflErr('the data ends early');
    this.pos = pos;
    return op;
  }
  dynamic(pos) {
    const d = this.d; let p = pos >> 3;
    const v = (d[p] | (d[p + 1] << 8) | (d[p + 2] << 16)) >> (pos & 7);
    const hlit = (v & 31) + 257, hdist = ((v >> 5) & 31) + 1, hclen = ((v >> 10) & 15) + 4; pos += 14;
    if (hlit > 286 || hdist > 30) throw inflErr('dynamic block header');
    CLL.fill(0);
    for (let i = 0; i < hclen; i++) { p = pos >> 3; CLL[CLORD[i]] = ((d[p] | (d[p + 1] << 8)) >> (pos & 7)) & 7; pos += 3; }
    const cm = (1 << huffTable(CLL, 0, 19, CT)) - 1, n = hlit + hdist, L = LENS;
    for (let i = 0; i < n;) {
      p = pos >> 3; const e = CT[((d[p] | (d[p + 1] << 8) | (d[p + 2] << 16)) >> (pos & 7)) & cm];
      if (e === 0) throw inflErr('bad code length code');
      pos += e & 15; const s = e >> 4;
      if (s < 16) { L[i++] = s; continue; }
      p = pos >> 3; const x = (d[p] | (d[p + 1] << 8)) >> (pos & 7);
      let rep, val = 0;
      if (s === 16) { if (i === 0) throw inflErr('repeat with no length'); val = L[i - 1]; rep = 3 + (x & 3); pos += 2; }
      else if (s === 17) { rep = 3 + (x & 7); pos += 3; }
      else { rep = 11 + (x & 127); pos += 7; }
      if (i + rep > n) throw inflErr('too many code lengths');
      while (rep-- > 0) L[i++] = val;
    }
    if (pos > this.end) throw inflErr('the data ends early');
    if (L[256] === 0) throw inflErr('no end-of-block code');
    this.lb = huffTable(L, 0, hlit, LT); this.lt = LT;
    this.db = huffTable(L, hlit, hdist, DT); this.dt = DT;
    return pos;
  }
}

// ------------------------------------------------------------------------------------------------ PNG rows
let INB = null, BUF = null;   // reused from file to file (the decode is synchronous: one at a time per thread)
const WIN = 32768;
/** the zlib stream of every IDAT chunk, in order, in one buffer (+ 4 zero bytes) -> { d, start, len } of the deflate data */
function zlibData(png) {
  let p = 8, n = 0;
  for (let q = 8; q + 12 <= png.length;) {
    const L = u32(png, q), t = u32(png, q + 4);
    if (t === 0x49444154) n += L; else if (t === 0x49454e44) break;   // IDAT, IEND
    q += 12 + L;
  }
  if (!INB || INB.length < n + 4) INB = new Uint8Array(Math.max(n + 4, 1 << 20));
  let o = 0;
  while (p + 12 <= png.length) {
    const L = u32(png, p), t = u32(png, p + 4);
    if (t === 0x49444154) { const e = Math.min(p + 8 + L, png.length); INB.set(png.subarray(p + 8, e), o); o += e - (p + 8); }
    else if (t === 0x49454e44) break;
    p += 12 + L;
  }
  INB.fill(0, o, o + 4);
  if (o < 2) throw inflErr('no image data');
  const cmf = INB[0], flg = INB[1];
  if ((cmf & 15) !== 8 || (cmf >> 4) > 7 || ((cmf << 8) | flg) % 31 !== 0 || (flg & 32)) throw inflErr('zlib header');
  return { d: INB, start: 2, len: o - 2 };
}

/** decode the PNG's rows [from, to) in order: onRow(y, row) gets each row's unfiltered bytes (the same array every call: copy what is
 *  kept; do not start another decode from inside onRow). cols: only the first `cols` pixels of each row are unfiltered and handed out
 *  (PNG filters read only bytes to the left and above, so these are exact). Rows before `from` are unfiltered only when the row below
 *  reads them (filter Up, Average or Paeth); the inflate stops after row `to - 1`.
 *  -> { w, h, depth, filters: [count of each filter type over rows 0 .. to - 1], skipped: rows not unfiltered } */
export function decodePngRowsSync(png, { from = 0, to = Infinity, cols = Infinity, onRow } = {}) {
  const H = pngHeader(png), { w, h, bpp } = H, stride = w * bpp, rowLen = stride + 1, end = Math.min(h, to);
  const need = Math.min(w, Math.max(1, Math.ceil(cols))) * bpp;
  const z = zlibData(png), inf = new Inflate(z.d, z.start, z.len);
  const size = Math.max(1 << 20, 2 * (WIN + rowLen + 1024));
  if (!BUF || BUF.length < size) BUF = new Uint8Array(size);
  const out = BUF, limit = out.length - 1024, stopAbs = end * rowLen + 1;   // + 1: the filter byte of the row after the last
  let prev = new Uint8Array(need), cur = new Uint8Array(need);
  let op = 0, base = 0, rp = 0, y = 0, skipped = 0;   // base: stream offset of out[0]; rp: row y's filter byte in out
  const filters = [0, 0, 0, 0, 0];
  while (y < end) {
    const peek = y < from && y + 1 < h, more = rowLen + (peek ? 1 : 0);   // bytes wanted from rp on
    while (op < rp + more && !inf.done) {
      if (op >= limit) { const k = Math.min(rp, op - WIN); out.copyWithin(0, k, op); op -= k; rp -= k; base += k; }
      op = inf.run(out, op, Math.min(limit, stopAbs - base));
    }
    if (op < rp + rowLen) throw gribErr(`PNG ended at row ${y} of ${end}`);
    const f = out[rp]; if (f > 4) throw gribErr('bad PNG filter ' + f);
    filters[f]++;
    if (peek && op > rp + rowLen && out[rp + rowLen] <= 1) skipped++;   // the next row is None or Sub: it never reads this one
    else {
      unfilter(f, out, rp + 1, cur, prev, bpp, need);
      if (y >= from && onRow) onRow(y, cur);
      const t = prev; prev = cur; cur = t;
    }
    rp += rowLen; y++;
  }
  return { w, h, depth: H.depth, filters, skipped };
}
/** decodePngRowsSync as a promise (the old interface) */
export async function decodePngRows(png, opts) { return decodePngRowsSync(png, opts); }

/** cur[0 .. n) = PNG filter f undone on src[s .. s + n), prev = the row above (unfiltered) */
function unfilter(f, src, s, cur, prev, bpp, n) {
  if (f === 0) { cur.set(src.subarray(s, s + n)); return; }
  if (f === 2) { for (let i = 0; i < n; i++) cur[i] = src[s + i] + prev[i]; return; }
  if (bpp === 2) { unfilter2(f, src, s, cur, prev, n); return; }
  if (f === 1) { let a = cur[0] = src[s]; for (let i = 1; i < n; i++) cur[i] = a = (src[s + i] + a) & 255; return; }
  if (f === 3) { let a = cur[0] = (src[s] + (prev[0] >> 1)) & 255; for (let i = 1; i < n; i++) cur[i] = a = (src[s + i] + ((a + prev[i]) >> 1)) & 255; return; }
  let a = cur[0] = (src[s] + prev[0]) & 255, c = prev[0];   // Paeth with a = c = 0 picks b
  for (let i = 1; i < n; i++) {
    const b = prev[i]; let pa = b - c, pb = a - c, pc = pa + pb;
    if (pa < 0) pa = -pa;
    if (pb < 0) pb = -pb;
    if (pc < 0) pc = -pc;
    cur[i] = a = (src[s + i] + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 255; c = b;
  }
}
/** the same for 2 bytes per pixel: the two byte lanes carried in locals */
function unfilter2(f, src, s, cur, prev, n) {
  if (f === 1) {
    let a0 = cur[0] = src[s], a1 = cur[1] = src[s + 1];
    for (let i = 2; i < n; i += 2) { cur[i] = a0 = (src[s + i] + a0) & 255; cur[i + 1] = a1 = (src[s + i + 1] + a1) & 255; }
    return;
  }
  if (f === 3) {
    let a0 = cur[0] = (src[s] + (prev[0] >> 1)) & 255, a1 = cur[1] = (src[s + 1] + (prev[1] >> 1)) & 255;
    for (let i = 2; i < n; i += 2) { cur[i] = a0 = (src[s + i] + ((a0 + prev[i]) >> 1)) & 255; cur[i + 1] = a1 = (src[s + i + 1] + ((a1 + prev[i + 1]) >> 1)) & 255; }
    return;
  }
  let a0 = cur[0] = (src[s] + prev[0]) & 255, a1 = cur[1] = (src[s + 1] + prev[1]) & 255, c0 = prev[0], c1 = prev[1];
  for (let i = 2; i < n; i += 2) {
    const b0 = prev[i], b1 = prev[i + 1];
    let pa = b0 - c0, pb = a0 - c0, pc = pa + pb;
    if (pa < 0) pa = -pa;
    if (pb < 0) pb = -pb;
    if (pc < 0) pc = -pc;
    cur[i] = a0 = (src[s + i] + (pa <= pb && pa <= pc ? a0 : pb <= pc ? b0 : c0)) & 255; c0 = b0;
    pa = b1 - c1; pb = a1 - c1; pc = pa + pb;
    if (pa < 0) pa = -pa;
    if (pb < 0) pb = -pb;
    if (pc < 0) pc = -pc;
    cur[i + 1] = a1 = (src[s + i + 1] + (pa <= pb && pa <= pc ? a1 : pb <= pc ? b1 : c1)) & 255; c1 = b1;
  }
}
/** the code at column x of a row handed to onRow (16-bit big-endian, or 8-bit) */
export const codeAt = (row, x, bpp) => (bpp === 2 ? (row[2 * x] << 8) | row[2 * x + 1] : row[x]);
