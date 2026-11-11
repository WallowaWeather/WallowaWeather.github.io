// nowcast/fields/budget.js - what the forecast maps read under "Keep forecasts fresh" (nowcast/cadence.js), for cellular users in a
// storm. Measured Nov-09-2026 on NOAA's bucket (the .idx of a quiet hour and three storm days: the Nov-2024 bomb cyclone, Feb-2025,
// a July-2025 afternoon), bytes for ONE forecast hour of a map:
//   wind      U + V 10 m, simple-packed at 10 bits: only the view's rows are read, 4,497.5 bytes a grid row for both
//             (CONUS 1059 rows 4.76 MB; the Pacific Northwest ~458 rows 2.06 MB; a county, one 64-row block, 0.29 MB)
//   temp      TMP 2 m 1.18-1.26 MB · rh  RH 2 m 1.54-1.57 MB · pressure  MSLMA 0.61-0.63 MB   (complex-packed: the whole message)
//   precip    v020: in 15-minute steps from the sub-hourly file (wrfsubh): an hour is its 4 steps of PRATE + CRAIN / CSNOW / CICEP /
//             CFRZR, 0.40 MB quiet (Nov-09-2026: 97,722 + 98,160 + 98,960 + 100,822), 0.73-0.80 MB in a storm (Nov-20-2024, Feb-16-2025)
//   + the hour's .idx, 10.4 KB (the sub-hourly file's 12.0 KB); a check for a newer run is one GET of its f18 .idx: ~0.3 KB while it is
//   not there (404). The hourly maps are drawn every 15 minutes from these same hours (blended on the phone): no more data.
// The plan: Off = only the hours looked at (no checks, no read-ahead). 10 / 30 min = a check that often; HRRR runs once an hour, so a
// map kept fresh re-reads the hour shown once an hour. Read-ahead of the next 3 hours only on Wi-Fi / wired and without Data Saver.
'use strict';
import { everyMin } from '../cadence.js';

export const ROW_BYTES = (2 * 1799 * 10) / 8;   // U + V, one grid row
export const ROWS = 1059;
export const IDX_BYTES = 10354, SUBH_IDX_BYTES = 11966;
export const STEPS_PER_HOUR = 4;
export const PROBE_BYTES = 300;
export const PREFETCH_HOURS = 3;
const MSG = { temp: 1181549, rh: 1572526, pressure: 605136, precip: 395664 };
const STORM = { temp: 1258000, rh: 1573000, pressure: 633000, precip: 803786 };
const UNMETERED = new Set(['wifi', 'ethernet']);

/** { refreshMin: null | 10 | 30, prefetch: hours read ahead } for a choice ('off' | '10' | '30' | 'auto') on a network */
export function planFor(choice, conn = {}) {
  const refreshMin = everyMin(choice, conn);
  if (!refreshMin) return { refreshMin: null, prefetch: 0 };
  return { refreshMin, prefetch: UNMETERED.has(conn.type) && !conn.saveData ? PREFETCH_HOURS : 0 };
}
/** bytes of one forecast hour of a map (wind: `rows` grid rows of the view; storm: a stormy day's sizes) */
export function hourBytes(id, { rows = ROWS, storm = false } = {}) {
  if (id === 'wind') return Math.round(Math.min(ROWS, rows) * ROW_BYTES);
  return (storm ? STORM : MSG)[id] || 0;
}
/** v020: one 15-minute step: precipitation's own (a quarter of its hour); an hourly map's step is drawn from its hours (counted by the hour) */
export const stepBytes = (id, o = {}) => (id === 'precip' ? Math.round(hourBytes(id, o) / STEPS_PER_HOUR) : hourBytes(id, o));
/** the .idx a map reads for each hour: precipitation the sub-hourly file's, the others the hourly file's */
export const idxBytes = (id) => (id === 'precip' ? SUBH_IDX_BYTES : IDX_BYTES);
/** { open: the first look, hour: an hour kept fresh, all18: every hour of a run } in bytes */
export function budget(id, choice, conn = {}, o = {}) {
  const p = planFor(choice, conn), one = hourBytes(id, o) + idxBytes(id), hours = 1 + p.prefetch;
  const open = hours * one + IDX_BYTES;   // + the run's f18 .idx (the probe that finds it)
  const hour = p.refreshMin ? hours * one + IDX_BYTES + Math.round(60 / p.refreshMin) * PROBE_BYTES : 0;
  return { open, hour, all18: 18 * one, plan: p };
}
export const mb = (b) => (b / 1e6).toFixed(1);
/** the data words for a Settings / Layers row */
export function budgetWords(id, choice, conn = {}, o = {}) {
  const b = budget(id, choice, conn, o), one = mb(hourBytes(id, o));
  const look = `About ${one} MB for each forecast hour you look at (${id === 'precip' ? 'its four 15-minute steps' : 'hourly data, shown every 15 min'})`;
  if (!b.plan.refreshMin) return `${look}. No data by itself.`;
  const ahead = b.plan.prefetch ? ` On Wi-Fi the next ${b.plan.prefetch} hours are read ahead (about ${mb(b.open)} MB the first time).` : '';
  return `${look}; kept fresh, about ${mb(b.hour)} MB an hour (HRRR runs hourly).${ahead}`;
}
