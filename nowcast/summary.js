// nowcast/summary.js - what a nowcast says about one place, in plain words with how sure it is: "Light rain likely starting in about 25
// minutes, heaviest around 10:15, ending by 10:50. 70% chance of heavy rain by 10:20." From the ensemble, never from one member: the
// chance at each lead time is the share of members x pixels within 3 km of the place over the rate. Pure (node-tested).
import { CAT } from './colors.js';

/** the place's numbers from a nowcast mosaic: fields { size, mean: Uint16Array (1/64 mm/h, [18][size][size]), prob: { 1, 4, 8: Uint8Array
 *  ([18][size][size], 0..255 = 0..100%) } }, the place's pixel (i, j), the radar at t0 near it (Float32 mm/h, [size][size]) ->
 *  { now, mean[18], p1[18], p4[18], p8[18] } (rates mm/h, chances 0..1) */
export function pointStats(f, i, j, nowField = null, r = 3) {
  const S = f.size, N = S * S, n = f.mean.length / N, out = { now: 0, mean: [], p02: f.prob[0.2] ? [] : null, p1: [], p4: [], p8: [] };
  const cells = [];
  for (let a = -r; a <= r; a++) for (let b = -r; b <= r; b++) {
    if (a * a + b * b > r * r) continue;
    const y = Math.round(i) + a, x = Math.round(j) + b; if (y >= 0 && y < S && x >= 0 && x < S) cells.push(y * S + x);
  }
  if (!cells.length) return null;
  const avg = (arr, k, sc) => { let s = 0; for (const c of cells) s += arr[k * N + c]; return s / cells.length * sc; };
  if (nowField) { let s = 0; for (const c of cells) s += nowField[c]; out.now = s / cells.length; }
  for (let k = 0; k < n; k++) {
    out.mean.push(avg(f.mean, k, 1 / 64)); out.p1.push(avg(f.prob[1], k, 1 / 255)); out.p4.push(avg(f.prob[4], k, 1 / 255)); out.p8.push(avg(f.prob[8], k, 1 / 255));
    if (out.p02) out.p02.push(avg(f.prob[0.2], k, 1 / 255));
  }
  return out;
}

const catOf = (v) => (v >= CAT.heavy ? 'heavy' : v >= CAT.moderate ? 'moderate' : 'light');
const sure = (p) => (p >= 0.7 ? 'likely' : p >= 0.45 ? 'possible' : 'a small chance');
const pct = (p) => `${Math.round(Math.min(1, p) * 10) * 10}%`;
/** "10:15" in the person's own clock (12 or 24 hours, no AM/PM: it is within the next 90 minutes) */
export function clockShort(ms, locale) {
  try { return new Date(ms).toLocaleTimeString(locale || [], { hour: 'numeric', minute: '2-digit' }).replace(/\s?[AP]\.?M\.?$/i, ''); } catch (e) { const d = new Date(ms); return `${d.getHours() % 12 || 12}:${String(d.getMinutes()).padStart(2, '0')}`; }
}
const aboutMin = (m) => (m <= 7 ? 'in a few minutes' : `in about ${Math.round(m / 5) * 5} minutes`);

/** the words -> { text, kind: 'none' | 'now' | 'start' | 'maybe', start, end, peak, heavy } (times in ms).
 *  st: pointStats; t0: the radar time (ms); now: the phone's time (ms); stepMin / firstMin: the model's output frames */
export function summarize(st, { t0, now = Date.now(), firstMin = 5, stepMin = 5, locale } = {}) {
  if (!st) return { text: 'This place is outside the nowcast area.', kind: 'outside' };
  const n = st.p1.length, at = (k) => t0 + (firstMin + k * stepMin) * 60e3, fromNow = (k) => Math.max(0, (at(k) - now) / 60e3), clk = (k) => clockShort(at(k), locale);
  const RAIN = 0.5, STOP = 0.3, pr = st.p02 || st.p1;   // rain at all: over 0.2 mm/h when the run has it (drizzle counts), else over 1
  const raining = st.now >= (st.p02 ? 0.2 : CAT.light);
  const maxP = Math.max(...pr), kStart = raining ? 0 : pr.findIndex((p) => p >= RAIN);
  let kEnd = -1;
  if (raining || kStart >= 0) { for (let k = Math.max(0, kStart) + 1; k < n; k++) if (pr.slice(k).every((p) => p < STOP)) { kEnd = k; break; } }
  let kPeak = 0; for (let k = 1; k < n; k++) if (st.mean[k] > st.mean[kPeak]) kPeak = k;
  const maxHeavy = Math.max(...st.p8), kHeavy = st.p8.findIndex((p) => p >= Math.max(0.3, maxHeavy * 0.8));
  const heavy = maxHeavy >= 0.3 ? ` ${pct(maxHeavy)} chance of heavy rain by ${clk(kHeavy)}.` : '';
  const parts = [];
  if (raining) {
    const c = catOf(st.now);
    parts.push(`${c[0].toUpperCase()}${c.slice(1)} rain now`);
    if (st.mean[kPeak] > st.now * 1.3 && st.mean[kPeak] >= CAT.light && kPeak > 0) parts.push(`heaviest around ${clk(kPeak)}`);
    parts.push(kEnd >= 0 ? `likely ending by ${clk(kEnd)}` : 'likely to go on for the next 90 minutes');
    return { text: parts.join(', ') + '.' + heavy, kind: 'now', end: kEnd >= 0 ? at(kEnd) : null, peak: at(kPeak), heavy: maxHeavy };
  }
  if (kStart >= 0) {
    const pS = Math.max(...pr.slice(kStart)), c = catOf(Math.max(...st.mean.slice(kStart)));
    parts.push(`${c[0].toUpperCase()}${c.slice(1)} rain ${sure(pS)} starting ${aboutMin(fromNow(kStart))}`);
    if (kPeak > kStart && st.mean[kPeak] >= CAT.light) parts.push(`heaviest around ${clk(kPeak)}`);
    if (kEnd > kStart) parts.push(`ending by ${clk(kEnd)}`);
    return { text: parts.join(', ') + '.' + heavy, kind: 'start', start: at(kStart), end: kEnd > kStart ? at(kEnd) : null, peak: at(kPeak), heavy: maxHeavy };
  }
  if (maxP >= 0.2) {
    const k = pr.indexOf(maxP);
    return { text: `A small chance of rain here, most likely around ${clk(k)} (${pct(maxP)}).` + heavy, kind: 'maybe', peak: at(k), heavy: maxHeavy };
  }
  return { text: 'Rain is unlikely here in the next 90 minutes.', kind: 'none', heavy: maxHeavy };
}
/** the radar's age in words: "radar 9:42 PM, 4 min old" */
export function radarLine(t0, now = Date.now(), locale) {
  const age = Math.max(0, Math.round((now - t0) / 60e3));
  let clock; try { clock = new Date(t0).toLocaleTimeString(locale || [], { hour: 'numeric', minute: '2-digit' }); } catch (e) { clock = new Date(t0).toISOString().slice(11, 16); }
  return `radar ${clock}, ${age <= 1 ? 'just now' : `${age} min old`}`;
}
/** the card's short form (the place, this and its "?" share one row on a phone): "radar 4 min old" */
export function radarAge(t0, now = Date.now()) { return `radar ${Math.max(1, Math.round((now - t0) / 60e3))} min old`; }
