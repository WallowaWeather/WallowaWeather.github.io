// nowcast/fields/hrrr.js - where the forecast maps' data are: NOAA's HRRR (3 km, CONUS, hourly runs) on NOAA's open-data bucket
// noaa-hrrr-bdp-pds (CORS open for GET with a Range header; HEAD carries no CORS header, so a file's presence is checked by GET of its
// .idx). One wrfsfc file per run and forecast hour (~150 MB); each field is one GRIB2 message read by an HTTP Range from the .idx.
// Measured Nov-09-2026 (bucket listings of 15 runs): f00 posted 50-60 min after the run's hour, f06 58-73, f18 73-93 (median 85).
// The maps show ONE run: the newest whose last hour (f18) is posted, else the one before (fallback); hours from the one now is in to f18.
// Wind (UGRD / VGRD 10 m) is simple-packed (5.0): only the 64-row blocks of the grid a view needs are read (blocksFor / blockRange).
// Pure: no DOM, no fetch of its own (the caller's fetch is passed in).
'use strict';
import { frameRange } from '../beam/inputs/hrrr/grib2_frame.js';
import { hrrrIJ } from '../stormscope/lcc.js';

export const HRRR_BASE = 'https://noaa-hrrr-bdp-pds.s3.amazonaws.com/';
export const HOUR = 3600e3;
export const MAX_FHR = 18;
export const NX = 1799, NY = 1059;
/** measured posting lags (minutes after the run's hour) */
export const LAG_MIN = { first: 50, last: 73, typical: 85, late: 93 };
/** grid rows per cached block of a simple-packed message (64 rows = 192 km, 143,920 bytes at 10 bits) */
export const BLOCK = 64;

/** the GRIB messages of each map: [name, level as the .idx spells it, how it is read] (rows: only the view's rows of a 5.0 message) */
export const VARS = {
  wind: [['UGRD', '10 m above ground', 'rows'], ['VGRD', '10 m above ground', 'rows']],
  temp: [['TMP', '2 m above ground']],
  rh: [['RH', '2 m above ground']],
  pressure: [['MSLMA', 'mean sea level']],
  precip: [['PRATE', 'surface'], ['CRAIN', 'surface'], ['CSNOW', 'surface'], ['CICEP', 'surface'], ['CFRZR', 'surface']],
};

const pad = (n) => String(n).padStart(2, '0');
const ymd = (t) => { const d = new Date(t); return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}`; };
export const fileUrl = (cycle, fhr) => `${HRRR_BASE}hrrr.${ymd(cycle)}/conus/hrrr.t${pad(new Date(cycle).getUTCHours())}z.wrfsfcf${pad(fhr)}.grib2`;
export const idxUrl = (cycle, fhr) => fileUrl(cycle, fhr) + '.idx';

/** an .idx text -> [{ n, a, b (last byte, inclusive; null = to the end of the file), v, lev, desc }] (broken lines are skipped) */
export function parseIdx(text) {
  const out = [];
  for (const line of String(text || '').split('\n')) {
    const p = line.trim().split(':');
    if (p.length < 6 || !/^\d+$/.test(p[0]) || !/^\d+$/.test(p[1])) continue;
    out.push({ n: +p[0], a: +p[1], b: null, v: p[3], lev: p[4], desc: p[5] });
  }
  for (let i = 0; i + 1 < out.length; i++) out[i].b = out[i + 1].a - 1;
  return out;
}
/** the first message of a name at a level -> { a, b, len } | null (len null when it runs to the end of the file) */
export function findMsg(lines, v, lev) {
  const m = lines.find((l) => l.v === v && l.lev === lev);
  return m ? { a: m.a, b: m.b, len: m.b === null ? null : m.b - m.a + 1 } : null;
}

/** the runs worth probing at `now`, newest first: the newest whose f18 could be posted (73 min, the earliest seen), then older */
export function cycleCandidates(now, { n = 4, lagMin = LAG_MIN.last } = {}) {
  const c0 = Math.floor((now - lagMin * 60e3) / HOUR) * HOUR, out = [];
  for (let k = 0; k < n; k++) out.push(c0 - k * HOUR);
  return out;
}
/**
 * the newest run with its last hour posted: probe(cycle, fhr) -> true when that file is there (a failure counts as not there; an
 * abort is passed on). newerThan: only runs after it (a refresh). -> { cycle, fallback (not the newest plausible run), tried } | null
 */
export async function pickRun({ now, probe, maxFhr = MAX_FHR, n = 4, newerThan = -Infinity }) {
  const cands = cycleCandidates(now, { n }).filter((c) => c > newerThan), tried = [];
  for (let k = 0; k < cands.length; k++) {
    let ok = false;
    try { ok = !!(await probe(cands[k], maxFhr)); } catch (e) { if (e && e.name === 'AbortError') throw e; ok = false; }
    tried.push({ cycle: cands[k], ok });
    if (ok) return { cycle: cands[k], fallback: k > 0, tried };
  }
  return null;
}
/** a probe that GETs the .idx (the bucket's HEAD has no CORS header): true on 200, false on 403 / 404, throws on other answers */
export const idxProbe = (fetchFn, signal) => async (cycle, fhr) => {
  const r = await fetchFn(idxUrl(cycle, fhr), { signal });
  if (r.status === 403 || r.status === 404) { try { await r.arrayBuffer(); } catch (e) { /* drained */ } return false; }
  if (!r.ok) throw new Error(`HRRR .idx: HTTP ${r.status}`);
  try { await r.arrayBuffer(); } catch (e) { /* drained */ }
  return true;
};

/** a run's hours from the one `now` is in to maxFhr (ascending, ms); a run newer than now starts at f00 */
export function validTimes(cycle, now, maxFhr = MAX_FHR) {
  const f0 = Math.max(0, Math.floor((now - cycle) / HOUR)), out = [];
  for (let f = f0; f <= maxFhr; f++) out.push(cycle + f * HOUR);
  return out;
}
export const fhrOf = (cycle, t) => Math.round((t - cycle) / HOUR);
/** the time of a list nearest to t (a tie: the earlier), null for an empty list */
export function nearestTime(times, t) {
  let best = null, bd = Infinity;
  for (const x of times || []) { const d = Math.abs(x - t); if (d < bd) { bd = d; best = x; } }
  return best;
}
/** t and the `ahead` hours after it that the run has (any list: v020 also the next 15-minute steps) */
export function hoursAround(times, t, ahead = 0) {
  const i = times.indexOf(t);
  return i < 0 ? [] : times.slice(i, i + 1 + Math.max(0, ahead));
}

// v020 (Josh: "15 min resolution on HRRR forecast would be nice ... The 1 hour feels jerky"): the maps every 15 minutes. Precipitation is
// read in true 15-minute steps from HRRR's sub-hourly file (wrfsubhFF: 4 steps an hour, "15 min fcst" ... "60 min fcst" counted from the
// run; its 60-min step holds the hourly file's values - ecCodes, Nov-09-2026); the other maps keep their hourly data (the sub-hourly file
// has no sea-level pressure and no humidity, and 15-minute wind / temperature would be ~4x the data) and are blended between the hours.
export const STEP_MIN = 15;
export const subUrl = (cycle, fhr) => `${HRRR_BASE}hrrr.${ymd(cycle)}/conus/hrrr.t${pad(new Date(cycle).getUTCHours())}z.wrfsubhf${pad(fhr)}.grib2`;
export const subIdxUrl = (cycle, fhr) => subUrl(cycle, fhr) + '.idx';
/** a run's 15-minute steps from the hour now is in to maxFhr (ascending, ms): every hour of validTimes and the three between */
export function stepTimes(cycle, now, maxFhr = MAX_FHR) {
  const hours = validTimes(cycle, now, maxFhr), out = [];
  for (const h of hours) { out.push(h); if (h < cycle + maxFhr * HOUR) for (let k = 1; k < 60 / STEP_MIN; k++) out.push(h + k * STEP_MIN * 60e3); }
  return out;
}
/** the step nearest t: its minutes after the run, its sub-hourly file (the hour it ends: a step on the hour is that file's last) and the
 *  .idx's words for it; the run's own hour (0 min) is the hourly file's (wrfsubhf00 holds only the analysis) */
export function stepOf(cycle, t) {
  const min = Math.max(0, Math.round((t - cycle) / (STEP_MIN * 60e3)) * STEP_MIN);
  return min === 0 ? { min, fhr: 0, desc: 'anl', hourly: true } : { min, fhr: Math.ceil(min / 60), desc: `${min} min fcst`, hourly: false };
}
/** a step's message in a sub-hourly .idx: name, level and its minutes ("330 min fcst"; never "325-330 min ave fcst") -> { a, b, len } | null */
export function findStep(lines, v, min, lev = 'surface') {
  const want = `${min} min fcst`, m = lines.find((l) => l.v === v && l.lev === lev && l.desc === want);
  return m ? { a: m.a, b: m.b, len: m.b === null ? null : m.b - m.a + 1 } : null;
}
/** the hourly grids a time falls between and how far along: { h0, h1, w } (on the hour: h1 = h0, w 0) */
export function hourPair(t) {
  const h0 = Math.floor(t / HOUR) * HOUR, w = (t - h0) / HOUR;
  return w === 0 ? { h0, h1: h0, w: 0 } : { h0, h1: h0 + HOUR, w };
}

/** the HRRR rows / columns a lat / lon box needs (its edges traced through the projection, + `margin` cells for the bilinear),
 *  clipped to the grid -> { r0, c0, rows, cols } (rows counted from the south, as the file scans) | null when the box misses the grid */
export function frameFor(box, { margin = 2 } = {}) {
  let i0 = Infinity, i1 = -Infinity, j0 = Infinity, j1 = -Infinity;
  const K = 48;
  for (let k = 0; k <= K; k++) {
    const la = box.s + ((box.n - box.s) * k) / K, lo = box.w + ((box.e - box.w) * k) / K;
    for (const [a, b] of [[la, box.w], [la, box.e], [box.s, lo], [box.n, lo]]) {
      const p = hrrrIJ(a, b);
      if (p.i < i0) i0 = p.i; if (p.i > i1) i1 = p.i; if (p.j < j0) j0 = p.j; if (p.j > j1) j1 = p.j;
    }
  }
  const c0 = Math.max(0, Math.floor(i0) - margin), c1 = Math.min(NX - 1, Math.ceil(i1) + margin);
  const r0 = Math.max(0, Math.floor(j0) - margin), r1 = Math.min(NY - 1, Math.ceil(j1) + margin);
  if (c1 < c0 || r1 < r0) return null;
  return { r0, c0, rows: r1 - r0 + 1, cols: c1 - c0 + 1 };
}
/** the 64-row blocks a frame's rows fall in */
export function blocksFor(frame, B = BLOCK) {
  const out = [];
  for (let k = Math.floor(frame.r0 / B); k <= Math.floor((frame.r0 + frame.rows - 1) / B); k++) out.push(k);
  return out;
}
/** block k's bytes in a simple-packed message (offsets from the message's first byte, inclusive): every column of its rows */
export function blockRange(h, k, B = BLOCK) {
  const r0 = k * B, rows = Math.min(B, h.ny - r0);
  const r = frameRange(h, { r0, c0: 0, rows, cols: h.nx });
  if (!r) throw new Error('not a simple-packed message');
  return r;
}
