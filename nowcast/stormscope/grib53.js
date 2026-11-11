// nowcast/stormscope/grib53.js - PILOT: one GRIB2 message packed with data template 5.3 (complex packing + spatial differencing), the
// way NOAA's HRRR stores its fields (e.g. its categorical precipitation type). -> { nx, ny, values: Float32Array (NaN = missing), meta }
// Grid template 3.30 (Lambert conformal) is read for its size and scan mode only; the grid itself is lcc.js. Checked against pygrib.
'use strict';
const u16 = (b, p) => (b[p] << 8) | b[p + 1], u32 = (b, p) => ((b[p] << 24) >>> 0) + (b[p + 1] << 16) + (b[p + 2] << 8) + b[p + 3];
const s16 = (b, p) => { const v = u16(b, p); return v & 0x8000 ? -(v & 0x7fff) : v; };   // GRIB's sign-and-magnitude
const sN = (b, p, n) => { let v = 0; for (let i = 0; i < n; i++) v = v * 256 + b[p + i]; const top = 2 ** (8 * n - 1); return v >= top ? -(v - top) : v; };
const f32 = (b, p) => new DataView(b.buffer, b.byteOffset + p, 4).getFloat32(0, false);
const gerr = (m) => Object.assign(new Error('GRIB2: ' + m), { code: 'GRIB' });

class Bits {
  constructor(b, p) { this.b = b; this.pos = p * 8; }
  read(n) { let v = 0; for (let i = 0; i < n; i++) { const p = this.pos++; v = v * 2 + ((this.b[p >> 3] >> (7 - (p & 7))) & 1); } return v; }
  align() { this.pos = Math.ceil(this.pos / 8) * 8; }
}

export function readGrib53(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (b[0] !== 0x47 || b[1] !== 0x52 || b[2] !== 0x49 || b[3] !== 0x42) throw gerr('not a GRIB message');
  let p = 16, nx = 0, ny = 0, scan = 0, npts = 0, s5 = null, bitmap = null, data = null;
  while (p + 5 <= b.length) {
    if (b[p] === 0x37 && b[p + 1] === 0x37 && b[p + 2] === 0x37 && b[p + 3] === 0x37) break;   // '7777'
    const L = u32(b, p), n = b[p + 4]; if (!L) break;
    if (n === 3) {
      const tpl = u16(b, p + 12); if (tpl !== 30) throw gerr('grid template 3.' + tpl + ' (only 3.30 is read)');
      nx = u32(b, p + 30); ny = u32(b, p + 34); scan = b[p + 64];
    } else if (n === 5) {
      npts = u32(b, p + 5); const tpl = u16(b, p + 9); if (tpl !== 3) throw gerr('data template 5.' + tpl + ' (only 5.3 is read)');
      s5 = { R: f32(b, p + 11), E: s16(b, p + 15), D: s16(b, p + 17), nbits: b[p + 19], mm: b[p + 22], NG: u32(b, p + 31), wref: b[p + 35], wbits: b[p + 36],
             lref: u32(b, p + 37), linc: b[p + 41], llast: u32(b, p + 42), lbits: b[p + 46], order: b[p + 47], ndesc: b[p + 48] };
    } else if (n === 6) {
      const ind = b[p + 5]; if (ind === 0) bitmap = b.subarray(p + 6, p + L); else if (ind !== 255) throw gerr('bitmap indicator ' + ind);
    } else if (n === 7) data = b.subarray(p + 5, p + L);
    p += L;
  }
  if (!s5 || !data || !nx) throw gerr('missing sections');
  const { R, E, D, nbits, NG, order, ndesc } = s5, scale = 2 ** E, dscale = 10 ** -D, nvals = npts;
  const vals = new Float64Array(nvals), miss = new Uint8Array(nvals);
  let iv1 = 0, iv2 = 0, minsd = 0, q = 0;
  if (order > 0) { iv1 = sN(data, 0, ndesc); q = ndesc; if (order === 2) { iv2 = sN(data, q, ndesc); q += ndesc; } minsd = sN(data, q, ndesc); q += ndesc; }
  const bs = new Bits(data, q), gref = new Uint32Array(NG), gw = new Uint8Array(NG), gl = new Uint32Array(NG);
  for (let g = 0; g < NG; g++) gref[g] = bs.read(nbits); bs.align();
  for (let g = 0; g < NG; g++) gw[g] = bs.read(s5.wbits) + s5.wref; bs.align();
  for (let g = 0; g < NG; g++) gl[g] = s5.lref + bs.read(s5.lbits) * s5.linc; bs.align();
  gl[NG - 1] = s5.llast;
  let k = 0;
  for (let g = 0; g < NG; g++) {
    const w = gw[g], r = gref[g], n = gl[g], allOnes = w ? 2 ** w - 1 : 0, allOnesM2 = w ? 2 ** w - 2 : 0;
    for (let i = 0; i < n; i++, k++) {
      if (w === 0) { if (s5.mm === 1 && r === 2 ** nbits - 1) miss[k] = 1; vals[k] = r; continue; }
      const x = bs.read(w);
      if (s5.mm >= 1 && x === allOnes) { miss[k] = 1; continue; }
      if (s5.mm === 2 && x === allOnesM2) { miss[k] = 1; continue; }
      vals[k] = r + x;
    }
  }
  if (k !== nvals) throw gerr(`unpacked ${k} values, expected ${nvals}`);
  if (order > 0) {   // undo the spatial differencing over the non-missing values, in order
    let i0 = -1, i1 = -1, c = 0;
    for (let i = 0; i < nvals; i++) {
      if (miss[i]) continue;
      if (c === 0) { vals[i] = iv1; i0 = i; }
      else if (c === 1 && order === 2) { vals[i] = iv2; i1 = i; }
      else if (order === 1) { vals[i] = vals[i] + minsd + vals[i0]; i0 = i; }
      else { const v = vals[i] + minsd + 2 * vals[i1] - vals[i0]; vals[i] = v; i0 = i1; i1 = i; }
      c++;
    }
  }
  const out = new Float32Array(nx * ny);
  if (bitmap) {
    let j = 0; for (let i = 0; i < nx * ny; i++) { const on = (bitmap[i >> 3] >> (7 - (i & 7))) & 1; out[i] = on ? (miss[j] ? NaN : (R + vals[j] * scale) * dscale) : NaN; if (on) j++; }
  } else for (let i = 0; i < nx * ny; i++) out[i] = miss[i] ? NaN : (R + vals[i] * scale) * dscale;
  return { nx, ny, values: out, meta: { scan, ...s5 } };
}
