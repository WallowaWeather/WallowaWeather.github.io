// nowcast/fields/worker.js - a module worker that decodes the forecast maps' GRIB2 messages and resamples them onto the map's grid
// (decode.js buildFromParts), off the page's thread: a CONUS complex-packed message is ~1.9 million values.
//   { id, op: 'build', field, parts: { NAME: { head, buf, off } }, frame, grid, gkey }  ->  { id, result: product } | { id, error }
// The grid's HRRR indices (the costly part of a new view) are kept for the last two grids. The parts are copied in (never transferred:
// the page's cache still holds them); the product's arrays are transferred back.
'use strict';
import { buildFromParts, gridIJ } from './decode.js';

const ijs = new Map();
self.onmessage = (ev) => {
  const m = ev.data || {};
  try {
    let ij = ijs.get(m.gkey);
    if (!ij) { ij = gridIJ(m.grid); ijs.set(m.gkey, ij); while (ijs.size > 2) ijs.delete(ijs.keys().next().value); }
    const p = buildFromParts(m.field, m.parts, m.frame, m.grid, ij), tr = [p.values.buffer];
    if (p.u) tr.push(p.u.buffer, p.v.buffer);
    if (p.type) tr.push(p.type.buffer);
    if (p.layers) for (const a of Object.values(p.layers)) if (a !== p.values && !tr.includes(a.buffer)) tr.push(a.buffer);
    self.postMessage({ id: m.id, result: p }, tr);
  } catch (e) {
    self.postMessage({ id: m.id, error: String((e && e.message) || e) });
  }
};
