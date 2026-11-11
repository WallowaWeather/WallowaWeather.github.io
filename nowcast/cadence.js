// nowcast/cadence.js - "Keep forecasts fresh" (Nov-08-2026, a data saver for field testers on cellular in a storm): how often BEAM runs
// again by itself while the map is open, the rain nowcast under it (DGMR) following each run, and how often StormScope's input layers
// are fetched ahead of a run (they fold in here: the old "Keep StormScope's layers fresh" switch migrates). One choice: Off, every 10 min, every
// 30 min, or 10 min on Wi-Fi and 30 on cellular - the default where the browser can tell the two apart (Android Chrome:
// navigator.connection.type); iPhone Safari can't, so there the default stays Off, as before. Data Saver on (navigator.connection.
// saveData): the Wi-Fi / cellular choice keeps to 30 min on any network, and Off / 30 min are marked suggested. Paused while the page is
// hidden or offline; back on screen or online, one run catches up when the last is stale. A run already going always finishes.
// Pure decisions (everyMin, nextRunAt, resolveChoice) + a small controller (createFreshness) + its controls (built with createElement only).
//   const fresh = createFreshness({ get: lsGet, set: lsSet, onChange: (why) => ... });   // why: choice | online | offline | connection
//   const at = fresh.nextAt(lastT0, { hidden, lagMs, running, failed });   // ms, or null for none
//   fresh.layersDue(layersT0, { hidden })   // StormScope's layers: refresh now? (Off: never by itself; a run fetches what it needs)
'use strict';

const MIN = 60e3;
/** the choices, in the order they are offered */
export const FRESH = {
  off: { label: 'Off', menu: 'Off', short: 'Off' },
  10: { label: 'Every 10 min', menu: 'Every 10 min', short: '10 min' },
  30: { label: 'Every 30 min', menu: 'Every 30 min', short: '30 min' },
  auto: { label: '10 min on Wi-Fi, 30 on cellular', menu: 'Wi-Fi 10 min, cellular 30', short: 'Wi-Fi 10, cell 30' },
};
export const FRESH_ORDER = ['off', '10', '30', 'auto'];
const valid = (v) => FRESH_ORDER.includes(v);
/** network types a refresh every 10 minutes is fine on (the rest - cellular, bluetooth tethering, other, unknown - count as cellular) */
const UNMETERED = new Set(['wifi', 'ethernet']);

// NOAA data, measured Nov-08-2026 with BEAM's own input builders in Node (a cold run at 00:00Z, then every 10 or every 30 min for an
// hour) and the MRMS bucket listings: [a quiet day, a big storm]. BEAM, every 10 min: 17.7 MB an hour (2.1-3.3 MB a run, 5.6 at the top of
// the hour with HRRR's new hour); every 30 min: 14.2 MB (5.6 and 8.7 a run: every run needs all six 10-minute radar frames of its
// window, so 30 min saves only the satellite scans); both + HRRR's environment, 7 MB every 3 h. The rain under BEAM (DGMR: 4 inputs 5 min
// apart = 6 MRMS rain-rate files + the newest rain/snow file): 1.5 MB a run every 10 min (3 files new), 2.9 every 30 (all 6 new). Storm
// days' MRMS files (Nov-2024 bomb cyclone, Feb-2025): composite reflectivity 1.9-2.4 MB vs 0.95, rain rate 0.75-0.87 vs 0.46.
export const MB_HOUR = { beam: { 10: [20, 30], 30: [17, 26] }, rain: { 10: [9, 16], 30: [6, 10] } };
/** one run with no recent one before it (the first today, or after an hour or more): [quiet, big storm] */
export const MB_FIRST = { beam: [20, 28], rain: [3, 5] };
// StormScope's layers (stormscope/prep/layers.js): a rolling window of the six 10-minute times t0-50 ... t0 for the place's tile; a
// refresh fetches every time missing (MRMS composite + base reflectivity, two national files; GOES-East's 8 bands under the tile by
// range; GLM) and HRRR's precipitation types (4 messages x 9 frames, KB). Measured Nov-04-2026: cold 75 MB, one new time 12.2 MB. So an
// hour of staying fresh is six new times at any cadence up to 50 min: ~75 MB at 10 or 30 min alike (30 min saves only the type
// messages); storm days' MRMS files about double (+~2 MB a time): ~90. Off: a run fetches its window when tapped.
export const MB_SS = { hour: [75, 90], first: [75, 90], perTime: 12 };
/** StormScope's newest time is never taken younger than 5 min (prep/cond.js newestT0): a refresh is due from the next time + 5 min */
export const SS_LAG_MS = 5 * MIN;

// ------------------------------------------------------------------------------------------------ the decisions (pure)
/** the browser's network, as far as it says: { known, type, saveData, online } (known: Wi-Fi and cellular can be told apart) */
export function connectionOf(nav = globalThis.navigator) {
  const c = nav && nav.connection, type = c && typeof c.type === 'string' ? c.type : null;
  return { known: !!type && type !== 'unknown', type: type || 'unknown', saveData: !!(c && c.saveData), online: !(nav && nav.onLine === false) };
}
/** minutes between runs for a choice on a network, or null (Off). Data Saver turns the Wi-Fi / cellular choice to 30 min everywhere;
 *  an explicit 10 min stays 10 (the person picked it) */
export function everyMin(choice, conn = {}) {
  if (choice === '10') return 10;
  if (choice === '30') return 30;
  if (choice === 'auto') return !conn.saveData && UNMETERED.has(conn.type) ? 10 : 30;
  return null;
}
/**
 * when the next refresh should start (ms), or null for none.
 *   choice: 'off' | '10' | '30' | 'auto';  connection: connectionOf();  online: navigator.onLine;  hidden: document.hidden;
 *   lastRun: the data time (ms) of the newest run (BEAM: its frame t0), 0 / null when there is none;
 *   o.now; o.lagMs: how long after its data time a run can start (BEAM: t0 + 9 min for the lightning, + 20 s);
 *   o.running: a run is going (its end asks again: never two at once); o.failed: the last run failed (the next frame is tried, at most
 *   10 min on, whatever the cadence).
 * A run is due when the data `every` minutes after the last run's is posted; one already due (stale: after a gap, back on screen, back
 * online) is now - a single run for the newest data, never one per missed slot.
 */
export function nextRunAt(choice, connection, online, hidden, lastRun, o = {}) {
  const { now = Date.now(), lagMs = 0, running = false, failed = false } = o;
  let every = everyMin(choice, connection || {});
  if (!every || hidden || online === false || (connection && connection.type === 'none') || running) return null;
  if (failed) every = Math.min(every, 10);
  if (!lastRun) return now;
  return Math.max(now, lastRun + every * MIN + lagMs);
}
/** true when a run would start at once (nothing newer than the cadence allows has been run) */
export const isStale = (choice, connection, lastRun, o = {}) => { const now = o.now ?? Date.now(), at = nextRunAt(choice, connection, true, false, lastRun, { ...o, now, running: false }); return at != null && at <= now; };
/** the stored choice: { choice, migrated } - the saved one; else the old switches (migrated: written back): BEAM's "Refresh every 10 min"
 *  (beamAuto, v009-v013) on = every 10 min; it or StormScope's "Keep layers fresh" (ssFresh, saved false only when switched off) off =
 *  Off; else the default: the Wi-Fi / cellular choice where the browser can tell, Off where not */
export function resolveChoice(saved, conn = {}) {
  const s = saved || {};
  if (valid(s.fresh)) return { choice: s.fresh, migrated: false };
  if (s.beamAuto === true) return { choice: '10', migrated: true };
  if (s.beamAuto === false || s.ssFresh === false) return { choice: 'off', migrated: true };
  return { choice: conn.known ? 'auto' : 'off', migrated: false };
}
/** StormScope's layers: refresh them now? (layersT0: the newest time they hold, 0 = none). Off, hidden, offline: no; else when the time
 *  `every` minutes after theirs can be complete (+5 min), or at once when they hold nothing */
export function layersDue(choice, connection, online, hidden, layersT0, o = {}) {
  const now = o.now ?? Date.now(), at = nextRunAt(choice, connection, online, hidden, layersT0, { now, lagMs: o.lagMs ?? SS_LAG_MS });
  return at != null && at <= now;
}
/** the choices worth offering: the Wi-Fi / cellular one only where the browser can tell (or when it is the current one) */
export const choicesFor = (conn = {}, current = null) => FRESH_ORDER.filter((c) => c !== 'auto' || conn.known || current === 'auto');
/** Data Saver on: the choices to mark suggested */
export const suggested = (conn = {}) => (conn.saveData ? ['off', '30'] : []);

// ------------------------------------------------------------------------------------------------ the words
const r5 = (x) => Math.max(5, Math.round(x / 5) * 5);
/** MB an hour for a cadence: [quiet, storm] (rain: the rain model is on this phone, so DGMR runs under each BEAM run) */
export function mbPerHour(every, { rain = true } = {}) {
  const b = MB_HOUR.beam[every], d = MB_HOUR.rain[every];
  return b ? [r5(b[0] + (rain ? d[0] : 0)), r5(b[1] + (rain ? d[1] : 0))] : [0, 0];
}
/** StormScope's layers for a choice, in plain words */
export function ssWords(choice) {
  const [q, s] = MB_SS.hour, [f, fs] = MB_SS.first;
  if (choice === 'off') return `No data by itself: a StormScope nowcast fetches its layers when you run it, about ${f} MB (up to ${fs} in a big storm; about ${MB_SS.perTime} MB within 10 min of the last).`;
  if (choice === '10') return `About ${q} MB an hour, up to ${s} in a big storm.`;
  if (choice === '30') return `About the same, ${q} MB an hour: a run needs every 10-minute time of the last 50 minutes, so 30 min saves little data.`;
  if (choice === 'auto') return `About ${q} MB an hour on Wi-Fi or cellular alike (up to ${s} in a big storm).`;
  return '';
}
/** a choice's data use in plain words (model: 'beam', with the rain under it; 'stormscope': its layers) */
export function dataWords(choice, { rain = true, model = 'beam' } = {}) {
  if (model === 'stormscope') return ssWords(choice);
  if (choice === 'off') {
    const f = [r5(MB_FIRST.beam[0] + (rain ? MB_FIRST.rain[0] : 0)), r5(MB_FIRST.beam[1] + (rain ? MB_FIRST.rain[1] : 0))];
    return `No data by itself. Run BEAM now reads about ${f[0]} MB the first time (up to ${f[1]} in a big storm), a few MB soon after another run.`;
  }
  const [q10, s10] = mbPerHour(10, { rain }), [q30, s30] = mbPerHour(30, { rain });
  if (choice === '10') return `About ${q10} MB an hour, up to ${s10} in a big storm.`;
  if (choice === '30') return `About ${q30} MB an hour, up to ${s30} in a big storm. A third of the runs: easier on the battery.`;
  if (choice === 'auto') return `On cellular about ${q30} MB an hour (up to ${s30} in a big storm); on Wi-Fi as every 10 min.`;
  return '';
}
const netWord = (t) => (t === 'wifi' ? 'Wi-Fi' : t === 'ethernet' ? 'a wired network' : t === 'cellular' ? 'cellular' : t === 'none' ? 'no network' : 'a network it can’t name');
/** what the refresh is doing, for the card: '' (Off), 'paused: no signal', 'next about 3:40', 'every 30 min on cellular' */
export function statusWords(choice, conn = {}, { next = null, clock = (t) => new Date(t).toISOString().slice(11, 16) } = {}) {
  const every = everyMin(choice, conn); if (!every) return '';
  if (conn.online === false || conn.type === 'none') return 'paused: no signal';
  const how = choice === 'auto' ? ` (${conn.saveData ? 'Data Saver' : netWord(conn.type)}: every ${every} min)` : '';
  return next ? `next about ${clock(next)}${how}` : how.trim().replace(/^\((.*)\)$/, '$1');
}

// ------------------------------------------------------------------------------------------------ the controller
/** get() -> the saved settings object; set(patch) saves; onChange(why) after a new choice, back online, offline, a new network */
export function createFreshness({ get = () => ({}), set = () => {}, nav = globalThis.navigator, win = globalThis, onChange = () => {} } = {}) {
  const conn = () => connectionOf(nav);
  const r = resolveChoice(get(), conn());
  let choice = r.choice;
  if (r.migrated) set({ fresh: choice });
  const fire = (why) => { try { onChange(why); } catch (e) { /* the view's */ } };
  if (win && win.addEventListener) { win.addEventListener('online', () => fire('online')); win.addEventListener('offline', () => fire('offline')); }
  const nc = nav && nav.connection;
  if (nc && typeof nc.addEventListener === 'function') nc.addEventListener('change', () => fire('connection'));
  const ctl = {
    get choice() { return choice; },
    /** a new choice: saved (and the old switch kept in step, for an older build), then onChange('choice'); a run going is left alone */
    pick(v) { v = String(v); if (!valid(v) || v === choice) return false; choice = v; set({ fresh: v, beamAuto: v !== 'off' }); fire('choice'); return true; },
    conn, everyMin: () => everyMin(choice, conn()), offline: () => { const c = conn(); return !c.online || c.type === 'none'; },
    nextAt: (lastRun, o = {}) => { const c = conn(); return nextRunAt(choice, c, c.online, !!o.hidden, lastRun, o); },
    layersDue: (layersT0, o = {}) => { const c = conn(); return layersDue(choice, c, c.online, !!o.hidden, layersT0, o); },
    short: () => FRESH[choice].short, words: (o) => dataWords(choice, o), status: (o) => statusWords(choice, conn(), o),
    /** the <select> of the choices (the card and the Layers row) */
    select(doc = document) {
      const c = conn(), s = doc.createElement('select'); s.className = 'bm-fresh-sel'; s.setAttribute('aria-label', 'Keep forecasts fresh');
      const sug = suggested(c);
      for (const k of choicesFor(c, choice)) { const o = doc.createElement('option'); o.value = k; o.textContent = FRESH[k].menu + (sug.includes(k) ? ' · suggested' : ''); if (k === choice) o.selected = true; s.append(o); }
      s.value = choice;
      s.addEventListener('change', () => ctl.pick(s.value));
      return s;
    },
    /** the card's line: "Keep fresh [choice] · next about 3:40" */
    line(doc = document, { next = null, clock } = {}) {
      const l = doc.createElement('label'); l.className = 'bm-sw bm-auto bm-fresh';
      const t = doc.createElement('span'); t.textContent = 'Keep fresh'; l.append(t, ctl.select(doc));
      const st = ctl.status({ next, clock }); if (st) { const n = doc.createElement('span'); n.className = 'footnote'; n.textContent = st; l.append(n); }
      return l;
    },
    /** the Layers row: the title, what the choice reads, and the menu (in the place of the old "Keep BEAM fresh" and "Keep StormScope's
     *  layers fresh" switches; model: the one on the map) */
    row(doc = document, { rain = true, note = '', model = 'beam' } = {}) {
      const l = doc.createElement('label'); l.className = 'nc-sw';
      const t = doc.createElement('span'); t.className = 'nc-sw-t';
      const b = doc.createElement('b'); b.textContent = 'Keep forecasts fresh';
      const s = doc.createElement('span'), sel = ctl.select(doc); s.className = 'footnote';
      const what = model === 'stormscope' ? 'StormScope’s radar, satellite and lightning layers, fetched ahead of a run' : 'BEAM, and the rain under it';
      const say = () => { s.textContent = `${what}, while this screen is open. ${dataWords(choice, { rain, model })}${note ? ' ' + note : ''}`; };
      say(); sel.addEventListener('change', say);   // after pick (its listener came first)
      t.append(b, s); l.append(t, sel); return l;
    },
    /** the Settings page: each choice with its data use, the network, Data Saver, the pauses */
    fill(el, { doc = document, rain = true } = {}) {
      const c = conn(), sug = suggested(c), p = (text, cls = 'st-note') => { const e = doc.createElement('p'); e.className = cls; e.textContent = text; el.append(e); return e; };
      p('While the map is open: how often BEAM runs again by itself (the rain under it, DGMR, with each run), and how often StormScope’s layers are fetched ahead of a run. Each reads NOAA’s newest radar, satellite, lightning and HRRR data.');
      const g = doc.createElement('div'); g.className = 'st-fresh-list'; g.setAttribute('role', 'radiogroup'); g.setAttribute('aria-label', 'Keep forecasts fresh'); el.append(g);
      for (const k of choicesFor(c, choice)) {
        const l = doc.createElement('label'); l.className = 'nc-sw';
        const t = doc.createElement('span'); t.className = 'nc-sw-t';
        const b = doc.createElement('b'); b.textContent = FRESH[k].label + (sug.includes(k) ? ' · suggested' : '');
        const s = doc.createElement('span'); s.className = 'footnote'; s.textContent = `BEAM: ${dataWords(k, { rain })}`;
        const s2 = doc.createElement('span'); s2.className = 'footnote'; s2.textContent = `StormScope: ${ssWords(k)}`;
        const i = doc.createElement('input'); i.type = 'radio'; i.name = 'ww-fresh'; i.value = k; i.checked = k === choice;
        i.addEventListener('change', () => { if (i.checked) ctl.pick(k); });
        t.append(b, s, s2); l.append(t, i); g.append(l);
      }
      if (c.saveData) p('Data Saver is on: Off or every 30 min is suggested. The Wi-Fi / cellular choice keeps to every 30 min while it is on.');
      if (c.known) p(`This phone is on ${netWord(c.type)} now. A phone’s hotspot counts as Wi-Fi.`);
      else p('This browser doesn’t say whether it is on Wi-Fi or cellular, so pick the one that suits your data plan.');
      p('Paused while the app is in the background or there is no signal; when you come back, one run catches up if the last is old. A run already going always finishes. Rough figures (Nov 2026): a big storm’s radar files are about twice a quiet day’s.');
      p('Only the model on the map is kept fresh. StormScope at 30 min reads about as much as at 10: Off is what saves its data.');
    },
  };
  return ctl;
}
