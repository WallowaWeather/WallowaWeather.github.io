// nowcast/radar_worker.js - decodes MRMS frames off the page's thread (a module worker): one pass over a frame's rows gives the map's
// whole-CONUS picture (one byte a 4 km block: the block's MEAN rate, never its strongest pixel, which made a 1 km speck a 16 km² square),
// the native 1 km crop for close zooms, its quality marks (isolated speckle; low MRMS RadarQualityIndex), and each model box (regrid.js:
// the reference tool's exact arithmetic). Messages: { id, op: 'frame' | 'inputs', ... } -> { id, result } | { id, error }
import { gunzip, readGrib2, valueLut, pngHeader, decodePngRows } from './grib2.js';
import { boxIndex, makeWindow, windowRow, regrid, meanFrames, quantInputs } from './regrid.js';
import { levelOf } from './colors.js';
import { speckle, despeckle, lowQuality } from './qc.js';

const SNOW_VALUE = 3;   // MRMS PrecipFlag: snow
async function grid(gz) { const g = readGrib2(await gunzip(gz)); return { g, lut: valueLut(g.meta), H: pngHeader(g.png) }; }

/** rate (+ flag, + rqi) -> { meta, conus, cw, ch, step, crop, cropBox, qc: { speckle: [{lat, lon, n, max, med}], low (mask) }, boxes, snow } */
async function frame({ rate, flag = null, rqi = null, step = 4, crop = null, boxes = [] }) {
  const R = await grid(rate), m = R.g.meta, ni = m.ni, nj = m.nj, cw = Math.ceil(ni / step), ch = Math.ceil(nj / step);
  const cr = crop ? { r0: Math.max(0, crop.r0), r1: Math.min(nj - 1, crop.r1), c0: Math.max(0, crop.c0), c1: Math.min(ni - 1, crop.c1) } : null;
  const crw = cr ? cr.c1 - cr.c0 + 1 : 0, crh = cr ? cr.r1 - cr.r0 + 1 : 0;
  // the type first (8-bit, small): snow pixels per 4 km block, and per crop pixel
  let snowN = null, snowCrop = null;
  if (flag) {
    try {
      const F = await grid(flag); if (F.g.meta.ni !== ni || F.g.meta.nj !== nj) throw new Error('grids differ');
      const isSnow = new Uint8Array(F.lut.length); for (let x = 0; x < F.lut.length; x++) isSnow[x] = F.lut[x] === SNOW_VALUE ? 1 : 0;
      snowN = new Uint8Array(cw * ch); if (cr) snowCrop = new Uint8Array(crw * crh);
      await decodePngRows(F.g.png, { onRow: (y, row) => {
        const o = ((y / step) | 0) * cw;
        for (let x = 0; x < ni; x++) if (isSnow[row[x]]) snowN[o + ((x / step) | 0)]++;
        if (cr && y >= cr.r0 && y <= cr.r1) { const q = (y - cr.r0) * crw; for (let x = cr.c0; x <= cr.c1; x++) snowCrop[q + x - cr.c0] = isSnow[row[x]]; }
      } });
    } catch (e) { snowN = snowCrop = null; }
  }
  // radar quality over the crop (8-bit, 0..1)
  let rqiCrop = null;
  if (rqi && cr) {
    try {
      const Q = await grid(rqi); if (Q.g.meta.ni !== ni || Q.g.meta.nj !== nj) throw new Error('grids differ');
      rqiCrop = new Float32Array(crw * crh).fill(-1);
      await decodePngRows(Q.g.png, { from: cr.r0, to: cr.r1 + 1, onRow: (y, row) => { const q = (y - cr.r0) * crw; for (let x = cr.c0; x <= cr.c1; x++) rqiCrop[q + x - cr.c0] = Q.lut[row[x]]; } });
    } catch (e) { rqiCrop = null; }
  }
  const sum = new Float32Array(cw * ch), wet = new Uint8Array(cw * ch), cropV = cr ? new Float32Array(crw * crh) : null;
  const val = R.lut, wins = boxes.map((b) => makeWindow(boxIndex(m, b.lat, b.lon))), snowIn = boxes.map(() => [0, 0]);
  await decodePngRows(R.g.png, { onRow: (y, row) => {
    const o = ((y / step) | 0) * cw;
    for (let x = 0; x < ni; x++) { const v = val[(row[2 * x] << 8) | row[2 * x + 1]]; if (v > 0) { const b = o + ((x / step) | 0); sum[b] += v; if (v >= 0.1) wet[b]++; } }
    if (cr && y >= cr.r0 && y <= cr.r1) { const q = (y - cr.r0) * crw; for (let x = cr.c0; x <= cr.c1; x++) { const v = val[(row[2 * x] << 8) | row[2 * x + 1]]; cropV[q + x - cr.c0] = v > 0 ? v : 0; } }
    for (let k = 0; k < wins.length; k++) windowRow(wins[k], y, row, 2, val);
  } });
  // the 4 km picture: the block's mean rate; snow when at least half of its wet pixels are snow
  const conus = new Uint8Array(cw * ch);
  for (let b = 0; b < conus.length; b++) {
    const lv = levelOf(sum[b] / (step * step));
    conus[b] = lv && snowN && snowN[b] && snowN[b] * 2 >= wet[b] ? lv | 128 : lv;
  }
  // the 1 km crop and its quality marks
  let cropOut = null, qc = null;
  if (cr) {
    cropOut = new Uint8Array(crw * crh);
    for (let i = 0; i < cropOut.length; i++) { const lv = levelOf(cropV[i]); cropOut[i] = lv && snowCrop && snowCrop[i] ? lv | 128 : lv; }
    const sp = speckle(cropV, crw, crh).map((s) => ({ lat: +(m.la1 - (cr.r0 + s.i) * m.dj).toFixed(3), lon: +(m.lo1 - 360 + (cr.c0 + s.j) * m.di).toFixed(3), n: s.px.length, max: +s.max.toFixed(1), med: +s.med.toFixed(2) }));
    qc = { speckle: sp, low: rqiCrop ? lowQuality(cropV, rqiCrop) : null };
  }
  if (snowN) for (let k = 0; k < wins.length; k++) {   // the share of the box's rain flagged snow (for the note)
    const ix = wins[k].ix; let s = 0, n = 0;
    for (let r = Math.floor(ix.rmin / step); r <= Math.floor(ix.rmax / step); r++) for (let c = Math.floor(ix.cmin / step); c <= Math.floor(ix.cmax / step); c++) { const b = r * cw + c; if (wet[b]) { n += wet[b]; s += Math.min(wet[b], snowN[b]); } }
    snowIn[k] = [s, n];
  }
  return { meta: { ni, nj, la1: m.la1, lo1: m.lo1, la2: m.la2, lo2: m.lo2, di: m.di, dj: m.dj, ref: m.ref }, conus, cw, ch, step, crop: cropOut, cropBox: cr, qc,
    boxes: wins.map(regrid), snow: snowIn.map(([s, n]) => (n ? s / n : 0)), typed: !!snowN };
}
/** the model's inputs from the frames standing for each input time: per box, [frame, frame...] -> { inputs: [Int16Array], qc: [pixels set
 *  to their surroundings (the clearest isolated speckle)] } */
function inputs({ boxes }) {
  const qc = [];
  const out = boxes.map((list) => { let n = 0; const fr = list.map((f) => { const x = Float32Array.from(meanFrames(f)); n += despeckle(x, 256, 256); return x; }); qc.push(n); return quantInputs(fr); });
  return { inputs: out, qc };
}

const OPS = { frame, inputs };
self.onmessage = async (ev) => {
  const { id, op } = ev.data || {};
  try {
    const result = await OPS[op](ev.data);
    const tr = [];
    const add = (a) => { if (a && a.buffer instanceof ArrayBuffer && !tr.includes(a.buffer)) tr.push(a.buffer); };
    if (result && typeof result === 'object') { add(result.conus); add(result.crop); if (result.qc && result.qc.low) add(result.qc.low); (result.boxes || []).forEach(add); (result.inputs || []).forEach(add); }
    self.postMessage({ id, result }, tr);
  } catch (e) { self.postMessage({ id, error: { message: String((e && e.message) || e), code: (e && e.code) || null } }); }
};
