// nowcast/stormscope/type.js - PILOT: what falls (rain, snow, sleet, freezing rain) for each StormScope frame, from NOAA's HRRR: its
// categorical precipitation type every 15 minutes (the sub-hourly files), on the same 3 km grid as StormScope (lcc.js), so each tile
// pixel reads its own HRRR point. Only the 4 small messages per time are fetched (HTTP ranges from the .idx; ~2-60 KB each; CORS is open).
// StormScope says where it falls and how hard; HRRR says what falls. -> codes 0 none, 1 rain, 2 snow, 3 sleet, 4 freezing rain
'use strict';
import { readGrib53 } from './grib53.js';
import { HRRR } from './lcc.js';

const BASE = 'https://noaa-hrrr-bdp-pds.s3.amazonaws.com/';
const HOUR = 3600e3, VARS = [['CFRZR', 4], ['CICEP', 3], ['CSNOW', 2], ['CRAIN', 1]];   // the most hazardous wins where several are set
const pad = (n, w = 2) => String(n).padStart(w, '0');
const day = (t) => { const d = new Date(t); return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}`; };
const fileOf = (c, f) => `hrrr.${day(c)}/conus/hrrr.t${pad(new Date(c).getUTCHours())}z.wrfsubhf${pad(f)}.grib2`;

/** t0 (ms), tile {y0, x0} (StormScope crop coords), frames: minutes after t0 ([10, 20, ... 90]) ->
 *  { codes: Uint8Array [frames][H][W], cycle, bytes, ms } (null when HRRR can't be reached: the frames stay rain/snow-free) */
export async function hrrrTypes({ t0, tile, H = 204, W = 204, frames = [10, 20, 30, 40, 50, 60, 70, 80, 90], signal, fetchFn = fetch } = {}) {
  const tStart = performance.now(); let bytes = 0;
  const get = async (url, range) => { const r = await fetchFn(url, { signal, headers: range ? { Range: `bytes=${range[0]}-${range[1]}` } : {} }); if (!r.ok) throw Object.assign(new Error(`HRRR ${r.status}`), { status: r.status }); const ab = await r.arrayBuffer(); bytes += ab.byteLength; return ab; };
  const last = t0 + frames[frames.length - 1] * 60e3;
  // the newest cycle whose sub-hourly file for the last frame is already posted (each ~50-80 min after its hour)
  let cycle = null; const idx = new Map();
  for (let k = 0; k <= 4 && cycle == null; k++) {
    const c = Math.floor(t0 / HOUR) * HOUR - k * HOUR, f = Math.ceil((last - c) / HOUR);
    try { idx.set(fileOf(c, f), new TextDecoder().decode(await get(BASE + fileOf(c, f) + '.idx'))); cycle = c; } catch (e) { if (e && e.name === 'AbortError') throw e; }
  }
  if (cycle == null) return null;
  const HW = H * W, codes = new Uint8Array(frames.length * HW), cache = new Map();
  for (let fi = 0; fi < frames.length; fi++) {
    const L = Math.max(15, Math.round((t0 + frames[fi] * 60e3 - cycle) / 900e3) * 15), f = Math.ceil(L / 60), file = fileOf(cycle, f);
    if (!idx.has(file)) idx.set(file, new TextDecoder().decode(await get(BASE + file + '.idx')));
    const lines = idx.get(file).trim().split('\n');
    let field = cache.get(L);
    if (!field) {
      field = new Uint8Array(HRRR.nx * HRRR.ny);
      for (const [v, code] of VARS.slice().reverse()) {   // rain first, freezing rain last: the most hazardous overwrites
        const i = lines.findIndex((l) => { const p = l.split(':'); return p[3] === v && p[4] === 'surface' && p[5] === `${L} min fcst`; });
        if (i < 0 || i + 1 >= lines.length) continue;
        const a = +lines[i].split(':')[1], b = +lines[i + 1].split(':')[1] - 1;
        const g = readGrib53(new Uint8Array(await get(BASE + file, [a, b]))), vals = g.values;
        for (let p = 0; p < vals.length; p++) if (vals[p] >= 0.5) field[p] = code;
      }
      cache.set(L, field);
    }
    const o = fi * HW;
    for (let r = 0; r < H; r++) {
      const j = tile.y0 + r + HRRR.crop.y, row = j * HRRR.nx + tile.x0 + HRRR.crop.x;
      for (let c = 0; c < W; c++) codes[o + r * W + c] = field[row + c];
    }
  }
  return { codes, cycle, bytes, ms: Math.round(performance.now() - tStart) };
}
