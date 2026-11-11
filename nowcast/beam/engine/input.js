// Part of BEAM's phone code (kept identical to BEAM's own build).
// Wallowa Weather engine: BEAM forward pass (a specialised fork of the author's own WebGPU engine)
// input.js - the 40-channel BEAM input as the engine reads it: HWC f16 [304 * 304][40], rounded to the nearest f16 (ties to even,
// as numpy's astype(float16) does for the backtest), channels 0-30 from the input builders, 31-38 from the pack (terrain, radar
// coverage), 39 = 1 (radar visible). Plain JS, runs in a page or a worker.
'use strict';
import { h16 } from './gpu.js';

export const HW = 304 * 304, NCH = 40, NDYN = 31;
const ONE = 0x3c00;

/**
 * dyn: the dynamic channels 0-30 after the model scaling, either a Float32Array [>= 31][HW] (CHW, row 0 = the south edge, as the
 *      Python stack) or an object { [index]: Float32Array(HW) } (the builders' `ch`); a missing channel is an error.
 *      NaN is taken as 0 (nan_to_num, as the Python does).
 * stat: Uint16Array [8][HW], the pack's beam.static (channels 31-38, f16 bits).  out: optional Uint16Array [HW][40].
 * -> Uint16Array [HW][40] (f16 bits)
 */
export function buildInput(dyn, stat, out = null) {
  out = out || new Uint16Array(HW * NCH);
  if (out.length !== HW * NCH) throw new Error('buildInput: out size');
  if (!stat || stat.length !== 8 * HW) throw new Error('buildInput: the static channels (8 x 304 x 304 f16) are needed');
  const get = (c) => {
    const a = dyn instanceof Float32Array ? dyn.subarray(c * HW, (c + 1) * HW) : dyn[c];
    if (!a || a.length !== HW) throw new Error('buildInput: channel ' + c + ' missing');
    return new Uint32Array(a.buffer, a.byteOffset, HW);
  };
  for (let c = 0; c < NDYN; c++) {
    const b = get(c);
    for (let p = 0, o = c; p < HW; p++, o += NCH) {
      const x = b[p];
      out[o] = (x & 0x7f800000) === 0x7f800000 && (x & 0x7fffff) ? 0 : h16(x);
    }
  }
  for (let c = 0; c < 8; c++) for (let p = 0, o = 31 + c, s = c * HW; p < HW; p++, o += NCH) out[o] = stat[s + p];
  for (let p = 0, o = 39; p < HW; p++, o += NCH) out[o] = ONE;
  return out;
}

/** a full 40-channel f16 CHW stack (the fixtures' frames) -> HWC f16 */
export function fromCHW16(u16, out = null) {
  if (u16.length !== HW * NCH) throw new Error('fromCHW16: size');
  out = out || new Uint16Array(HW * NCH);
  for (let c = 0; c < NCH; c++) for (let p = 0, o = c, s = c * HW; p < HW; p++, o += NCH) out[o] = u16[s + p];
  return out;
}
