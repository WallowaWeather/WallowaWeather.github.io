// Part of BEAM's phone code (kept identical to BEAM's own build).
// js/inputs/hrrr/f16.js - float32 -> float16 rounding exactly as numpy's astype(np.float16): round half to even, overflow to
// +-Infinity, NaN kept, float16 subnormals kept. The input must already be a float32 value (Math.fround / a Float32Array element):
// the backtest rounds float64 -> float32 -> float16, and rounding a float64 straight to float16 can differ at the ties.
'use strict';
const F = new Float32Array(1), U = new Uint32Array(F.buffer);

export function f16round(x) {
  if (x !== x || x === 0 || x === Infinity || x === -Infinity) return x;
  F[0] = x;
  const e = ((U[0] >>> 23) & 0xff) - 127;   // floor(log2 |x|) (float32 subnormals give -127: they round to 0)
  const s = 2 ** (e < -14 ? -24 : e - 10);    // the float16 step at |x|
  const y = x / s, fl = Math.floor(y), d = y - fl;   // exact: s is a power of two
  const r = d > 0.5 ? fl + 1 : d < 0.5 ? fl : (fl % 2 === 0 ? fl : fl + 1);
  const out = r * s;
  return out > 65504 ? Infinity : out < -65504 ? -Infinity : out;
}

// the engine's own Math.f16round when there is one (the same result on float32 inputs, about 1.8x faster), else f16round
export const f16 = typeof Math.f16round === 'function' ? Math.f16round : f16round;
