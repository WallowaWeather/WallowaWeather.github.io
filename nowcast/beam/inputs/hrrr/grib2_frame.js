// Part of BEAM's phone code (kept identical to BEAM's own build).
// js/inputs/hrrr/grib2_frame.js - one GRIB2 message (grid template 3.30), decoded ONLY over a rectangle of grid rows / columns.
// Data templates: 5.0 (simple packing, including the constant field with 0 bits per value) and 5.3 (complex packing with spatial
// differencing; the unpacking follows the app's nowcast/stormscope/grib53.js, rewritten to stream: no whole-field arrays).
// Values are computed the way ecCodes (pygrib) computes them, in float64: (X * 2^E + R) * 10^-D, with 10^-D built by repeated
// division as ecCodes' codes_power does; a constant field (5.0, 0 bits) is R itself, as ecCodes returns it. The caller's
// Float32Array then rounds each value to float32, as numpy's astype(float32) does. Missing points are NaN.
//
//   const h = readHeader(bytes)                 // bytes: the message from byte 0 (sections 0-6 + the section-7 header at least)
//   const [lo, hi] = frameRange(h, frame)       // 5.0: the message bytes the frame needs (inclusive), so only they are fetched
//   decodeFrame(h, buf, bufOff, frame, out)     // buf = message bytes [bufOff, bufOff + buf.length); out = Float32Array(rows * cols)
//   frame = { r0, c0, rows, cols }: grid rows / columns counted in the message's own scan order (scan mode 64: row 0 = south)
'use strict';
const u16 = (b, p) => (b[p] << 8) | b[p + 1];
const u32 = (b, p) => ((b[p] << 24) >>> 0) + (b[p + 1] << 16) + (b[p + 2] << 8) + b[p + 3];
const s16 = (b, p) => { const v = u16(b, p); return v & 0x8000 ? -(v & 0x7fff) : v; };   // GRIB's sign-and-magnitude
const s32 = (b, p) => { const v = u32(b, p); return v >= 0x80000000 ? -(v - 0x80000000) : v; };
const sN = (b, p, n) => { let v = 0; for (let i = 0; i < n; i++) v = v * 256 + b[p + i]; const top = 2 ** (8 * n - 1); return v >= top ? -(v - top) : v; };
const f32 = (b, p) => new DataView(b.buffer, b.byteOffset + p, 4).getFloat32(0, false);
const gerr = (m) => Object.assign(new Error('GRIB2: ' + m), { code: 'GRIB' });
const pow = (s, n) => { let d = 1; if (s === 0) return 1; if (s === 1) return n; while (s < 0) { d /= n; s++; } while (s > 0) { d *= n; s--; } return d; };   // ecCodes codes_power

export function readHeader(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (b.length < 16 || b[0] !== 0x47 || b[1] !== 0x52 || b[2] !== 0x49 || b[3] !== 0x42) throw gerr('not a GRIB message');
  if (b[7] !== 2) throw gerr('edition ' + b[7]);
  const h = { total: u32(b, 8) * 4294967296 + u32(b, 12), nx: 0, ny: 0, scan: -1, tpl: -1, bitmap: null, s7: -1, s7len: 0 };
  let p = 16;
  while (p + 5 <= b.length) {
    if (b[p] === 0x37 && b[p + 1] === 0x37 && b[p + 2] === 0x37 && b[p + 3] === 0x37) break;   // '7777'
    const L = u32(b, p), n = b[p + 4];
    if (!L) throw gerr('zero-length section');
    if (n === 7) { h.s7 = p + 5; h.s7len = L - 5; break; }   // the data: nothing after it is needed here
    if (p + L > b.length) throw gerr('section ' + n + ' is cut off (' + (p + L) + ' > ' + b.length + ' bytes)');
    if (n === 3) {
      h.gridTpl = u16(b, p + 12); if (h.gridTpl !== 30) throw gerr('grid template 3.' + h.gridTpl + ' (only 3.30 is read)');
      h.npts3 = u32(b, p + 6); h.nx = u32(b, p + 30); h.ny = u32(b, p + 34); h.la1 = s32(b, p + 38); h.lo1 = u32(b, p + 42);
      h.lad = s32(b, p + 47); h.lov = u32(b, p + 51); h.dx = u32(b, p + 55); h.dy = u32(b, p + 59); h.scan = b[p + 64];
      h.latin1 = s32(b, p + 65); h.latin2 = s32(b, p + 69);
    } else if (n === 4) {
      h.cat = b[p + 9]; h.num = b[p + 10];
    } else if (n === 5) {
      h.npts = u32(b, p + 5); h.tpl = u16(b, p + 9);
      if (h.tpl !== 0 && h.tpl !== 3) throw gerr('data template 5.' + h.tpl + ' (5.0 and 5.3 are read)');
      h.R = f32(b, p + 11); h.E = s16(b, p + 15); h.D = s16(b, p + 17); h.nbits = b[p + 19];
      if (h.tpl === 3) Object.assign(h, { mm: b[p + 22], NG: u32(b, p + 31), wref: b[p + 35], wbits: b[p + 36], lref: u32(b, p + 37), linc: b[p + 41],
        llast: u32(b, p + 42), lbits: b[p + 46], order: b[p + 47], ndesc: b[p + 48] });
    } else if (n === 6) {
      const ind = b[p + 5];
      if (ind === 0) h.bitmap = b.slice(p + 6, p + L); else if (ind !== 255) throw gerr('bitmap indicator ' + ind);
    }
    p += L;
  }
  if (h.s7 < 0 || h.tpl < 0 || !h.nx) throw gerr('missing sections');
  if (h.npts3 !== h.nx * h.ny) throw gerr('grid points ' + h.npts3 + ' != ' + h.nx + ' x ' + h.ny);
  if (h.scan !== 64) throw gerr('scan mode ' + h.scan + ' (only 64: west to east, south to north)');
  if (h.tpl === 0 && h.nbits && h.s7len < Math.ceil(h.npts * h.nbits / 8)) throw gerr('data section too short');
  return h;
}

function checkFrame(h, f) {
  if (f.r0 < 0 || f.c0 < 0 || f.rows < 1 || f.cols < 1 || f.r0 + f.rows > h.ny || f.c0 + f.cols > h.nx) throw gerr('frame outside the grid');
}

// 5.0 without a bitmap: values are at fixed bit offsets, so the frame's rows are one contiguous byte range of section 7.
// -> [lo, hi] message byte offsets (inclusive), or null when the whole message is needed (5.3, a bitmap, or 0 bits per value).
export function frameRange(h, f) {
  checkFrame(h, f);
  if (h.tpl !== 0 || h.bitmap || !h.nbits) return null;
  const j0 = f.r0 * h.nx + f.c0, j1 = (f.r0 + f.rows - 1) * h.nx + f.c0 + f.cols;   // data values [j0, j1)
  return [h.s7 + Math.floor(j0 * h.nbits / 8), h.s7 + Math.ceil(j1 * h.nbits / 8) - 1];
}

export function decodeFrame(h, buf, bufOff, f, out) {
  checkFrame(h, f);
  if (out.length < f.rows * f.cols) throw gerr('output too small');
  out.fill(NaN);   // missing points (bitmap, 5.3 missing values) stay NaN
  if (h.tpl === 0) decode50(h, buf, bufOff, f, out); else decode53(h, buf, bufOff, f, out);
  return out;
}

// bits [p, p + n) of section 7's data (p in bits from its first byte), n <= 25; base = local index of that first byte in buf.
// Bytes past the end of buf read as 0 (typed-array reads out of range give undefined, which | turns into 0).
function bitsAt(buf, base, p, n) {
  if (n === 0) return 0;
  const i = (p >>> 3) + base, w = ((buf[i] << 24) | (buf[i + 1] << 16) | (buf[i + 2] << 8) | buf[i + 3]) >>> 0;
  return ((w << (p & 7)) >>> 0) >>> (32 - n);
}
const bitsN = (buf, base, p, n) => (n <= 25 ? bitsAt(buf, base, p, n) : bitsAt(buf, base, p, n - 16) * 65536 + bitsAt(buf, base, p + n - 16, 16));

// popcount of a bitmap's first g bits: the data index of grid point g
function onBefore(bm, g) {
  let c = 0, i = 0;
  for (; i + 8 <= g; i += 8) { let v = bm[i >> 3]; v = v - ((v >> 1) & 0x55); v = (v & 0x33) + ((v >> 2) & 0x33); c += (v + (v >> 4)) & 0x0f; }
  for (; i < g; i++) c += (bm[i >> 3] >> (7 - (i & 7))) & 1;
  return c;
}
const isOn = (bm, g) => (bm[g >> 3] >> (7 - (g & 7))) & 1;

function decode50(h, buf, bufOff, f, out) {
  const { nx, nbits, R, bitmap: bm } = h, bs = pow(h.E, 2), ds = pow(-h.D, 10), base = h.s7 - bufOff, W = f.cols;
  if (base < 0 && nbits) {   // the buffer starts inside section 7: check it holds the frame's bytes
    const r = frameRange(h, f); if (!r || r[0] < bufOff) throw gerr('buffer does not hold the frame');
  }
  for (let r = 0; r < f.rows; r++) {
    const g0 = (f.r0 + r) * nx + f.c0, o = r * W;
    if (!bm) {
      if (!nbits) { for (let c = 0; c < W; c++) out[o + c] = R; continue; }   // ecCodes: a constant field is the reference value
      let p = g0 * nbits;
      if (nbits <= 25) for (let c = 0; c < W; c++, p += nbits) out[o + c] = (bitsAt(buf, base, p, nbits) * bs + R) * ds;
      else for (let c = 0; c < W; c++, p += nbits) out[o + c] = (bitsN(buf, base, p, nbits) * bs + R) * ds;
    } else {
      let j = onBefore(bm, g0);
      for (let c = 0; c < W; c++) {
        if (!isOn(bm, g0 + c)) continue;   // stays NaN
        out[o + c] = nbits ? (bitsN(buf, base, j * nbits, nbits) * bs + R) * ds : R;
        j++;
      }
    }
  }
}

// 5.3: the group references, widths and lengths are read in step with the packed values (four bit cursors, no arrays); spatial
// differencing is undone on the fly, keeping only the last two values; values are written only inside the frame, and decoding stops
// after the frame's last point (rows north of the frame are never unpacked).
function decode53(h, buf, bufOff, f, out) {
  const { nx, nbits, R, NG, order, ndesc, mm, wref, wbits, lref, linc, llast, lbits, bitmap: bm } = h;
  const bs = pow(h.E, 2), ds = pow(-h.D, 10), base = h.s7 - bufOff;
  if (base < 0 || base + h.s7len > buf.length) throw gerr('5.3 needs the whole data section');
  let iv1 = 0, iv2 = 0, minsd = 0, q = 0;
  if (order > 0) {
    iv1 = sN(buf, base, ndesc); q = ndesc;
    if (order === 2) { iv2 = sN(buf, base + q, ndesc); q += ndesc; }
    minsd = sN(buf, base + q, ndesc); q += ndesc;
  }
  const al = (p) => Math.ceil(p / 8) * 8;
  let pr = q * 8, pw = al(pr + NG * nbits), pl = al(pw + NG * wbits), pv = al(pl + NG * lbits);
  const r0 = f.r0, c0 = f.c0, c1 = f.c0 + f.cols, W = f.cols;
  const gEnd = (f.r0 + f.rows - 1) * nx + c1;   // grid points [0, gEnd) are all that can reach the frame
  const refMiss1 = 2 ** nbits - 1, refMiss2 = 2 ** nbits - 2;
  let p0 = 0, p1 = 0, cnt = 0;   // the last two non-missing values; non-missing values seen
  let g = -1, row = 0, col = -1;   // grid point of the current data value (row / column in scan order)
  let k = 0, done = false;
  groups: for (let gi = 0; gi < NG; gi++) {
    const ref = bitsN(buf, base, pr, nbits); pr += nbits;
    const w = bitsAt(buf, base, pw, wbits) + wref; pw += wbits;
    const len = gi === NG - 1 ? llast : lref + bitsN(buf, base, pl, lbits) * linc; pl += lbits;
    const ones = w ? 2 ** w - 1 : 0, ones2 = w ? 2 ** w - 2 : 0;
    for (let i = 0; i < len; i++, k++) {
      // the grid point of data value k: the next point (or, with a bitmap, the next point whose bit is set)
      g++; col++; if (col === nx) { col = 0; row++; }
      if (bm) while (g < h.npts3 && !isOn(bm, g)) { g++; col++; if (col === nx) { col = 0; row++; } }
      if (g >= gEnd) { done = true; break groups; }
      let x, miss = false;
      if (w === 0) {
        x = ref;
        if (mm === 1 && ref === refMiss1) miss = true;
        else if (mm === 2 && (ref === refMiss1 || ref === refMiss2)) miss = true;
      } else {
        x = w <= 25 ? bitsAt(buf, base, pv, w) : bitsN(buf, base, pv, w); pv += w;
        if (mm >= 1 && x === ones) miss = true;
        else if (mm === 2 && x === ones2) miss = true;
        else x += ref;
      }
      if (miss) continue;   // stays NaN
      let v;
      if (order === 0) v = x;
      else if (cnt === 0) { v = iv1; p1 = v; }
      else if (cnt === 1 && order === 2) { v = iv2; p0 = p1; p1 = v; }
      else if (order === 1) { v = x + minsd + p1; p1 = v; }
      else { v = x + minsd + 2 * p1 - p0; p0 = p1; p1 = v; }
      cnt++;
      if (row >= r0 && col >= c0 && col < c1) out[(row - r0) * W + (col - c0)] = (v * bs + R) * ds;
    }
  }
  if (!done && k !== h.npts) throw gerr(`unpacked ${k} values, expected ${h.npts}`);
}
