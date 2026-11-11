// Part of BEAM's phone code (kept identical to BEAM's own build).
// js/runner/stack.js - BEAM's 40-channel input stack, assembled exactly as the backtest's Python does it (ww_feed2.sample +
// ww_feed3.eval_inputs / build): channels 0-30 from the four input builders (already scaled, nan_to_num'd), 31-38 the static
// terrain + radar-coverage channels (the pack's beam.static, float16), 39 radar_valid; the whole stack rounded to float16
// (round to nearest even, as numpy's astype(float16)). Layout [ch][row][col], row 0 = the SOUTH edge, 304 x 304 - the layout of
// the golden fixtures (frames/<id>.f16.bin). Pure ES module (page, worker, Node).
//
//   condition 'visible': as built; ch 39 = 1.
//   condition 'hidden' (PLAN 2.1, MRMS unreachable or its grid changed): radar channels 0-8, 12, 13 = 0, coverage ch 35-38 =
//             [1, 1, 1, 0], ch 39 = 0 (ww_feed3.build with hide = everywhere, none = True).
'use strict';

export const S = 304, N = S * S, NCH = 40, NDYN = 31;
export const RADAR_CH = [0, 1, 2, 3, 4, 5, 6, 7, 8, 12, 13];          // ww_feed2.RADAR_CH
export const HRRR_STORM_CH = [14, 15, 16, 17, 29, 30];               // ww_feed2.HRRR_STORM_CH (hidden only in 'strict')
export const STATIC_FIRST = 31, STATIC_COUNT = 8;                    // terrain x 4, coverage x 4
const F16_ONE = 0x3c00;

// ------------------------------------------------------------------------------------------------ float16 bits
const _f = new Float32Array(1), _u = new Uint32Array(_f.buffer);
/** a number (first rounded to float32) -> float16 bits, round to nearest even; NaN -> 0x7e00, overflow -> inf */
export function f16bits(v) {
  _f[0] = v;
  const x = _u[0], sign = (x >>> 16) & 0x8000, exp = (x >>> 23) & 0xff, mant = x & 0x7fffff;
  if (exp === 0xff) return sign | 0x7c00 | (mant ? 0x200 : 0);
  const e = exp - 112;
  if (e >= 0x1f) return sign | 0x7c00;
  if (e <= 0) {
    if (e < -10) return sign;
    const M = mant | 0x800000, shift = 126 - exp, half = 1 << (shift - 1), rem = M & ((1 << shift) - 1);
    let m = M >>> shift;
    if (rem > half || (rem === half && (m & 1))) m++;
    return sign | m;
  }
  let h = sign | (e << 10) | (mant >>> 13);
  const rem = mant & 0x1fff;
  if (rem > 0x1000 || (rem === 0x1000 && (h & 1))) h++;
  return h;
}
let _tab = null;
/** float16 bits -> value (a 65536-entry table) */
export function f16value(h) {
  if (!_tab) {
    _tab = new Float32Array(65536);
    for (let k = 0; k < 65536; k++) {
      const s = k & 0x8000 ? -1 : 1, e = (k >>> 10) & 0x1f, m = k & 0x3ff;
      _tab[k] = e === 0 ? s * m * 2 ** -24 : e === 31 ? (m ? NaN : s * Infinity) : s * (1 + m / 1024) * 2 ** (e - 15);
    }
  }
  return _tab[h & 0xffff];
}

/** a Float32Array(N) -> float16 bits written into out at offset o (NaN -> 0, as nan_to_num) */
function putChannel(a, out, o) {
  const u = new Uint32Array(a.buffer, a.byteOffset, N);
  for (let p = 0; p < N; p++) {
    const x = u[p];
    out[o + p] = (x & 0x7f800000) === 0x7f800000 && (x & 0x7fffff) ? 0 : f16bits(a[p]);
  }
}

/** the pack's static channels (ArrayBuffer | Uint8Array | Uint16Array of 8 x N float16, little-endian) -> Uint16Array(8 * N) */
export function staticBits(st) {
  if (st instanceof Uint16Array) { if (st.length !== STATIC_COUNT * N) throw new Error('static: expected 8 x 304 x 304 float16'); return st; }
  const u8 = st instanceof Uint8Array ? st : new Uint8Array(st);
  if (u8.byteLength !== STATIC_COUNT * N * 2) throw new Error(`static: ${u8.byteLength} bytes, expected ${STATIC_COUNT * N * 2}`);
  const out = new Uint16Array(STATIC_COUNT * N);
  for (let i = 0; i < out.length; i++) out[i] = u8[2 * i] | (u8[2 * i + 1] << 8);   // little-endian on any host
  return out;
}

/**
 * ch: { [0..30]: Float32Array(N) } (the builders' channels after the model scaling; a missing channel is taken as 0 and listed)
 * stat: staticBits(...) (ch 31-38).  condition: 'visible' | 'hidden'.
 * -> { bits: Uint16Array(40 * N) float16 [ch][row][col], absent: [channel numbers that were not given] }
 */
export function assembleStack(ch, stat, { condition = 'visible', out = null } = {}) {
  if (condition !== 'visible' && condition !== 'hidden') throw new Error('condition must be visible or hidden');
  const bits = out || new Uint16Array(NCH * N), absent = [];
  if (bits.length !== NCH * N) throw new Error('stack: out size');
  const hide = condition === 'hidden' ? new Set(RADAR_CH) : null;
  for (let c = 0; c < NDYN; c++) {
    const o = c * N, a = ch[c];
    if (hide && hide.has(c)) { bits.fill(0, o, o + N); continue; }
    if (!a || a.length !== N) { absent.push(c); bits.fill(0, o, o + N); continue; }
    putChannel(a, bits, o);
  }
  bits.set(stat, STATIC_FIRST * N);
  if (hide) {   // coverage = [1, 1, 1, 0] (ww_feed3.coverage none=True); terrain (31-34) as stored
    for (let c = 35; c <= 37; c++) bits.fill(F16_ONE, c * N, (c + 1) * N);
    bits.fill(0, 38 * N, 39 * N);
    bits.fill(0, 39 * N, 40 * N);
  } else bits.fill(F16_ONE, 39 * N, 40 * N);
  return { bits, absent };
}

/** CHW float16 bits -> HWC float16 bits [N][40] (the engine's input layout) */
export function toHWC(bits, out = null) {
  if (bits.length !== NCH * N) throw new Error('toHWC: size');
  out = out || new Uint16Array(NCH * N);
  for (let c = 0; c < NCH; c++) for (let p = 0, o = c, s = c * N; p < N; p++, o += NCH) out[o] = bits[s + p];
  return out;
}

/** a short content hash of a stack (FNV-1a over the bits, hex), for logs and summaries */
export function stackHash(bits) {
  let h = 0x811c9dc5;
  for (let i = 0; i < bits.length; i++) { h ^= bits[i] & 0xff; h = Math.imul(h, 0x01000193); h ^= bits[i] >>> 8; h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(16).padStart(8, '0');
}
