// nowcast/report.js - Wallowa Weather's FIELD REPORT (the field-test kit, Nov-2026): a tester says what the weather is doing where they
// are (rain now: none / light / moderate / heavy; hail, thunder or lightning, flooding or water over a road, a landslide or debris, snow
// or ice, wind damage; a note), and the app adds what it showed for that spot at that moment: the model on the map, the radar there and
// its age, the nowcast's rain for now and +30 / +60 / +90 min, BEAM's chances, the app's own alert areas, the NWS alerts it last read,
// the app version and a few device facts (the GPU, StormScope's f16 rounding, the browser).
// NOTHING IS SENT BY THE APP: the tester shares the text through the phone's own share sheet (Android: Messages, email ...; with a
// picture of the map when the phone can share files), or copies it. Two lengths: the full report, and a short one of at most 160 plain
// characters (GSM-7, so it stays one SMS) for texting by satellite. The position is the phone's GPS only when the tester allows it,
// rounded to 0.001 degree (about 100 m); otherwise the place picked on the map. Kept on the phone: the tester's own past reports
// (localStorage, newest first, at most 60, clearable). No network calls, no analytics.
// view.js loads this file when a report is first opened (a lazy import: the map never depends on it) and gives it its state:
//   fillReport(el, { state() -> { model, place, run, beamFrame, radarNewest, radarFrame, radarErr, alerts, alertsAt, warnings, places,
//     gps, toScreen(lat, lon) }, place (a picked point, or null), snapshot() (the map without the GPS dot: map.js snapshot), toast, version,
//     device() -> { gpu, f16 }, models, heading })
// The texts are pure: buildReport(...) -> a plain object; shortText(rep) <= 160; fullText(rep).
//
// THE SHORT TEXT, in order (a group is left out when it is not known; when the text is too long, the least needed go first: f16, the
// app's alert areas, BEAM, the town, the version; then the note is cut):
//   WW 11/18 14:32          the report's time (the phone's clock, 24 h)
//   HR,FL                   what the tester sees: NR / LR / MR / HR = no / light / moderate / heavy rain, HA hail, TL thunder or
//                           lightning, FL flooding or water over a road, LS landslide or debris, SI snow or ice, WD wind damage
//   gps 44.064,-123.112     the phone's GPS (rounded to ~100 m), or "map ..." = the place picked on the map (no GPS)
//   1NE Eugene              miles and direction from the nearest town ("in Eugene" under half a mile)
//   SS                      the model on the map: SS StormScope, DG DGMR, BM BEAM
//   r4m=M                   the newest radar is 4 min old and shows M here (0 none, L light, M moderate, H heavy; s = snow)
//   f12m=L60/M80/H90/-      the rain nowcast (from radar 12 min old) for now / +30 / +60 / +90 min: rain category + chance of
//                           rain, nearest 10 % (DGMR's runs; StormScope is one run: no %); "-" past its end. (DG f.. when DGMR runs under BEAM)
//   BM f12m H2/5/1 L30!/..  BEAM's chance % of Hail, Lightning, cloudburst Rain, strong Cores for 0-30 / 30-60 / 60-90 min; "!" =
//                           at BEAM's warning level; "BM out" = outside BEAM's area
//   A:FL                    the app's own alert areas here (experimental): HA hail, TL lightning, FL heavy rain, IC ice, SN snow,
//                           ST storm on the way, DS damaging storm
//   NWS FLA,WIY             NWS alerts here (FLA flood watch, FLW flood warning, FLY flood advisory, FFW / FFA flash flood
//                           warning / watch, HWW high wind warning, WIY wind advisory, WSW winter storm warning, SPS special
//                           statement ...); "NWS 0" none in force; "NWS ?" not checked (no signal)
//   v013 f16r               the app's test build; StormScope's f16 rounding on this GPU (r rne16, n native, f f32)
//   n:...                   the tester's note
'use strict';
import { pixelOf, summaryAt } from './run.js';
import { pointStats } from './summary.js';
import { chanceAt, HEAD_ORDER } from './beam_live.js';
import { HEADS } from './beam.js';
import { inPolys } from './lands.js';
import { rateOf } from './colors.js';
import { modelById } from './models_info.js';
import { X_MAX, xPostUrl, fbShareUrl, publicUrl, postBox, pictureView, publicPicture } from './post.js';   // v020: public posts
export { X_MAX, xPostUrl, fbShareUrl };

export const SHORT_MAX = 160;
export const STORE_KEY = 'wallowa-weather:field-reports';
export const KEEP = 60;
/** rain now: [id, words, short code] (one choice) */
export const RAIN = [['none', 'No rain', 'NR'], ['light', 'Light rain', 'LR'], ['moderate', 'Moderate rain', 'MR'], ['heavy', 'Heavy rain', 'HR']];
/** also seen: [id, words, short code] (any of them) */
export const ALSO = [['hail', 'Hail', 'HA'], ['thunder', 'Thunder or lightning', 'TL'], ['flood', 'Flooding / water over road', 'FL'],
  ['slide', 'Landslide / debris', 'LS'], ['snow', 'Snow or ice', 'SI'], ['wind', 'Wind damage', 'WD']];
const SLOTS = [0, 30, 60, 90];
const MODEL_CODE = { stormscope: 'SS', dgmr: 'DG', beam: 'BM' };
const HEAD_CODE = { hail: 'H', lightning: 'L', rain: 'R', core: 'C' };
const HEAD_WORDS = { hail: 'hail', lightning: 'lightning', rain: 'cloudburst', core: 'strong cores' };
const ALERT_CODE = { hail: 'HA', lightning: 'TL', flood: 'FL', ice: 'IC', snow: 'SN', track: 'ST', damaging: 'DS' };
const NWS_CODE = {
  'tornado warning': 'TOR', 'severe thunderstorm warning': 'SVR', 'severe thunderstorm watch': 'SVA', 'flash flood warning': 'FFW', 'flash flood watch': 'FFA',
  'flood warning': 'FLW', 'flood watch': 'FLA', 'flood advisory': 'FLY', 'flood statement': 'FLS', 'hydrologic outlook': 'ESF', 'special weather statement': 'SPS',
  'high wind warning': 'HWW', 'high wind watch': 'HWA', 'wind advisory': 'WIY', 'extreme wind warning': 'EWW', 'winter storm warning': 'WSW', 'winter storm watch': 'WSA',
  'winter weather advisory': 'WWY', 'ice storm warning': 'ISW', 'blizzard warning': 'BZW', 'snow squall warning': 'SQW', 'coastal flood warning': 'CFW',
  'coastal flood watch': 'CFA', 'coastal flood advisory': 'CFY', 'high surf warning': 'SUW', 'high surf advisory': 'SUY', 'beach hazards statement': 'BHS',
  'dense fog advisory': 'FGY', 'avalanche warning': 'AVW', 'avalanche watch': 'AVA', 'red flag warning': 'RFW', 'gale warning': 'GLW', 'storm warning': 'SRW',
};
const DIRS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
const DIR_WORDS = ['north', 'northeast', 'east', 'southeast', 'south', 'southwest', 'west', 'northwest'];

// ------------------------------------------------------------------------------------------------ small pure pieces
const r3 = (v) => Math.round(v * 1000) / 1000;
/** the position kept in a report: 0.001 degree (about 100 m) */
export const roundPos = (lat, lon) => ({ lat: r3(lat), lon: r3(lon) });
/** a map place that is the phone's own position (view.js: Locate's place, and the one the app opens on when location is allowed, both
 *  labelled "Your location"): the person's location, so it goes in a report only through "Add my location", never as a place "not GPS" */
export const ownPosition = (p) => !!p && p.label === 'Your location';
const pad = (n) => String(n).padStart(2, '0');
const clock = (t) => { try { return new Date(t).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }); } catch (e) { return new Date(t).toISOString().slice(11, 16); } };
const fullTime = (t) => { try { return new Date(t).toLocaleString('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' }); } catch (e) { return new Date(t).toString(); } };
const utc = (t) => `${new Date(t).toISOString().slice(0, 16).replace('T', ' ')} UTC`;
const shortTime = (t) => { const d = new Date(t); return `${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`; };
const mmh = (v) => `${v < 10 ? v.toFixed(1) : Math.round(v)} mm/h`;
const pct = (p) => `${Math.round(Math.min(1, Math.max(0, p)) * 100)}%`;
const fixed = (v, n = 3) => Number(v).toFixed(n);
/** rain rate -> 0 / L / M / H (the app's own words: light under 4 mm/h, moderate 4-8, heavy 8 and up; under 0.2 is none) */
export function rainCat(v) { return !(v >= 0.2) ? '0' : v >= 8 ? 'H' : v >= 4 ? 'M' : 'L'; }
const CAT_WORDS = { 0: 'no rain', L: 'light rain', M: 'moderate rain', H: 'heavy rain' };
/** an NWS event -> its short code (initials for one not in the list) */
export function nwsCode(event) {
  const e = String(event || '').trim().toLowerCase();
  if (NWS_CODE[e]) return NWS_CODE[e];
  return e.split(/\s+/).filter(Boolean).map((w) => w[0]).join('').toUpperCase().replace(/[^A-Z]/g, '').slice(0, 4) || 'X';
}
/** text kept to the GSM-7 basic set's plain part (one SMS holds 160 of them): accents dropped, curly quotes and dashes made plain,
 *  the extension characters ([ ] { } \ ^ ~ | and the euro sign count double) and everything else left out */
export function gsm(s) {
  return String(s == null ? '' : s).normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[‘’‚′`]/g, "'").replace(/[“”„″]/g, '"').replace(/[‐-―−]/g, '-').replace(/…/g, '...')
    .replace(/[\r\n\t]+/g, ' ').replace(/[^A-Za-z0-9 !"#$%&'()*+,\-./:;<=>?@_]/g, '').replace(/ {2,}/g, ' ').trim();
}
/** the nearest town from the app's Census places ([{ name, st, lat, lon }]): { name, st, mi, dir } or null (none within 60 miles) */
export function nearestTown(places, lat, lon) {
  let best = null, bd = Infinity; const kx = Math.cos(lat * Math.PI / 180);
  for (const e of places || []) { const d = (e.lat - lat) ** 2 + ((e.lon - lon) * kx) ** 2; if (d < bd) { bd = d; best = e; } }
  if (!best) return null;
  const mi = Math.sqrt(bd) * 111.2 / 1.609; if (mi > 60) return null;
  const deg = (Math.atan2((lon - best.lon) * kx, lat - best.lat) * 180 / Math.PI + 360) % 360, k = Math.round(deg / 45) % 8;
  return { name: best.name, st: best.st || '', mi: Math.round(mi * 10) / 10, dir: DIRS[k], dirWords: DIR_WORDS[k] };
}
/** the radar's rain at a point, from a decoded MRMS frame (radar_worker.js: the 1 km crop when the point is in it, else the 4 km
 *  picture): { mmh, snow, km, t } or null */
export function radarHere(f, lat, lon) {
  if (!f || !f.meta) return null;
  const m = f.meta, r = Math.round((m.la1 - lat) / m.dj), c = Math.round((lon - (m.lo1 - 360)) / m.di);
  let code = null, km = 1;
  const b = f.cropBox;
  if (f.crop && b && r >= b.r0 && r <= b.r1 && c >= b.c0 && c <= b.c1) code = f.crop[(r - b.r0) * (b.c1 - b.c0 + 1) + (c - b.c0)];
  else if (f.conus && f.cw && f.step) {
    const rr = Math.floor(r / f.step), cc = Math.floor(c / f.step);
    if (rr >= 0 && cc >= 0 && rr < f.ch && cc < f.cw) { code = f.conus[rr * f.cw + cc]; km = 4; }
  }
  if (code == null) return null;
  return { mmh: rateOf(code & 127), snow: !!(code & 128), km, t: f.t || null };
}
/** a rain nowcast (DGMR or StormScope, run.js / run_ss.js) at a point, for the report's time and +30 / +60 / +90 min:
 *  { model, t0, ageMin, members, out } or { ..., slots: [{ m, mmh, chance, src: 'radar' | 'model' } | { m, past }], text } */
export function runHere(run, lat, lon, t = Date.now()) {
  if (!run || !run.spec || !run.size) return null;
  const sp = run.spec, base = { model: sp.model === 'stormscope' ? 'stormscope' : 'dgmr', t0: run.t0, ageMin: Math.max(0, Math.round((t - run.t0) / 60e3)), members: run.members || 1 };
  let st = null;
  try { const q = pixelOf(run, lat, lon); if (q) st = pointStats({ size: run.size, mean: run.pmm || run.mean, prob: run.prob }, q.i, q.j, run.now, run.km === 1 ? 3 : 2); } catch (e) { st = null; }
  if (!st) return Object.assign(base, { out: true });
  const n = run.ready != null ? Math.min(run.ready, sp.frames) : sp.frames, pr = st.p02 || st.p1;
  const slots = SLOTS.map((m) => {
    const lead = (t + m * 60e3 - run.t0) / 60e3, k = Math.round((lead - sp.firstMin) / sp.everyMin);
    if (lead < sp.firstMin / 2 || k < 0) return { m, mmh: st.now, chance: null, src: 'radar' };   // before the first frame: the radar the run started from
    if (k >= n) return { m, past: true };
    return { m, mmh: st.mean[k], chance: base.members > 1 ? pr[k] : null, src: 'model' };
  });
  let text = ''; try { const s = summaryAt(run, lat, lon, t); text = s && s.kind !== 'outside' ? s.text : ''; } catch (e) { text = ''; }
  return Object.assign(base, { slots, text });
}
/** BEAM's newest run at a point: { t0, issue, ageMin, fresh, out, heads: { hail: { bins: [3], warned: [3] }, ... } } or null */
export function beamHere(frame, lat, lon, t = Date.now()) {
  if (!frame || !frame.issue) return null;
  const base = { t0: frame.t0, issue: frame.issue, ageMin: Math.max(0, Math.round((t - frame.t0) / 60e3)), fresh: t < frame.issue + 90 * 60e3, recal: !!frame.recal };
  if (!base.fresh) return base;
  let c = null; try { c = frame.grid ? chanceAt(frame, lat, lon) : null; } catch (e) { c = null; }
  if (!c) return Object.assign(base, { out: true });
  const heads = {}; for (const h of HEAD_ORDER) if (c[h]) heads[h] = { bins: c[h].bins.map((v) => Math.round(v * 100)), warned: c[h].warned.slice() };
  return Object.assign(base, { heads });
}
/** the app's own alert areas (StormScope's, experimental) over a point: [{ code, label }] */
export function appAlertsHere(run, lat, lon) {
  const out = [], seen = new Set();
  for (const a of (run && run.ss && run.ss.alerts) || []) {
    if (!a.rings || !a.rings.length) continue;
    let inside = false; try { inside = inPolys([a.rings], lon, lat); } catch (e) { inside = false; }
    if (!inside) continue;
    const code = ALERT_CODE[a.kind] || gsm(a.label).replace(/[^A-Za-z]/g, '').slice(0, 2).toUpperCase() || 'AA';
    if (!seen.has(code)) { seen.add(code); out.push({ code, label: String(a.label || code) }); }
  }
  return out;
}
/** the NWS alerts the app last read for a point (no new request): the map place's own alerts (view.js keeps when it read them, and
 *  for where) when the point is within ~3 km of that place, plus the storm-based warnings whose outline holds the point ->
 *  { complete (the place's alerts were read and are for here), at, forPlace (they were read, for another place), events } */
export function nwsHere(s, lat, lon) {
  const at = s.alertsAt || null, place = s.place || null;
  const fresh = !!(at && place && Math.abs(at.lat - place.lat) < 1e-6 && Math.abs(at.lon - place.lon) < 1e-6);
  const near = !!(place && Math.abs(place.lat - lat) < 0.03 && Math.abs(place.lon - lon) < 0.04);
  const ev = new Map();
  if (fresh && near) for (const a of s.alerts || []) if (a && a.event) ev.set(a.event, a);
  for (const w of s.warnings || []) {
    if (!w || !w.event || !w.rings || !w.rings.length) continue;
    let inside = false; try { inside = inPolys([w.rings], lon, lat); } catch (e) { inside = false; }
    if (inside) ev.set(w.event, w);
  }
  const rank = (e) => (/warning/i.test(e) ? 0 : /watch/i.test(e) ? 1 : /advisory/i.test(e) ? 2 : 3);
  const events = [...ev.values()].sort((a, b) => rank(a.event) - rank(b.event)).map((a) => ({ event: String(a.event).slice(0, 80), ends: a.ends || null }));
  return { complete: fresh && near, at: fresh ? at.t : null, forPlace: fresh && !near ? String((place && place.label) || 'another place') : '', events };
}
/** the browser and system from the phone's own navigator (no request): { browser, os, installed } */
export function browserFacts(nav = globalThis.navigator, hi = null) {
  const ua = String((nav && nav.userAgent) || '');
  const uad = nav && nav.userAgentData, brands = (hi && hi.fullVersionList) || (uad && uad.brands) || [];
  const pick = (re) => brands.find((b) => re.test(b.brand));
  const br = pick(/Edge/) || pick(/Samsung/) || pick(/Opera/) || pick(/Google Chrome/) || pick(/^Chromium$/);
  let browser = br ? `${br.brand.replace('Google ', '')} ${String(br.version).split('.')[0]}` : '';
  if (!browser) { const m = ua.match(/(EdgA?|SamsungBrowser|Firefox|FxiOS|CriOS|Chrome|Version)\/(\d+)/); browser = m ? `${{ EdgA: 'Edge', Edg: 'Edge', SamsungBrowser: 'Samsung Internet', FxiOS: 'Firefox', CriOS: 'Chrome', Version: 'Safari' }[m[1]] || m[1]} ${m[2]}` : 'unknown browser'; }
  let os = '';
  if (hi && hi.platform) os = `${hi.platform}${hi.platform === 'Android' && hi.platformVersion ? ' ' + String(hi.platformVersion).split('.')[0] : ''}`;
  if (!os) { const a = ua.match(/Android (\d+(?:\.\d+)?)/), i = ua.match(/OS (\d+)_\d+.*like Mac/); os = a ? `Android ${a[1]}` : i ? `iOS ${i[1]}` : /Windows/.test(ua) ? 'Windows' : /Mac OS X/.test(ua) ? 'macOS' : /Linux/.test(ua) ? 'Linux' : ''; }
  let installed = false; try { installed = !!(globalThis.matchMedia && matchMedia('(display-mode: standalone)').matches) || (nav && nav.standalone === true); } catch (e) { installed = false; }
  return { browser, os, installed };
}

// ------------------------------------------------------------------------------------------------ the report
/** a report's name: FR-<month day hour minute>-<3 random letters> (the short text's time finds it again) */
export const newId = (now = Date.now()) => `FR-${shortTime(now).replace(/\D/g, '')}-${Math.random().toString(36).slice(2, 5)}`;
/**
 * state: the view's state (see the top); input: { rain: 'none'|'light'|'moderate'|'heavy'|null, also: [ids], note,
 *   where: { lat, lon, how: 'gps' | 'place', acc, alt, label } | null }; device: { gpu, gpuNote, f16: { mode, t } | null,
 *   browser, os, installed, models: [names] } -> a plain object (kept as JSON in the past-reports list)
 */
export function buildReport({ state = {}, input = {}, now = Date.now(), version = '', device = {}, id = null } = {}) {
  const s = state || {}, w = input.where && isFinite(input.where.lat) && isFinite(input.where.lon) ? input.where : null;
  const pos = w ? roundPos(w.lat, w.lon) : null;
  const rep = {
    v: 1, id: id || newId(now), t: now,
    rain: RAIN.some((x) => x[0] === input.rain) ? input.rain : null,
    also: ALSO.map((x) => x[0]).filter((k) => (input.also || []).includes(k)),
    note: String(input.note || '').replace(/\s+/g, ' ').trim().slice(0, 500),
    where: pos ? { lat: pos.lat, lon: pos.lon, how: w.how === 'gps' ? 'gps' : 'place', acc: w.how === 'gps' && w.acc != null && isFinite(w.acc) ? Math.max(10, Math.round(w.acc / 10) * 10) : null,
      alt: w.how === 'gps' && w.alt != null && isFinite(w.alt) ? Math.round(w.alt / 10) * 10 : null, label: w.how === 'gps' ? '' : String(w.label || '').slice(0, 60) } : null,
    town: pos ? nearestTown(s.places, pos.lat, pos.lon) : null,
    model: s.model || null,
    radar: null, run: null, beam: null, appAlerts: [], nws: null,
    version: String(version || ''),
    device: { gpu: String(device.gpu || ''), gpuNote: String(device.gpuNote || ''), f16: device.f16 && device.f16.mode ? { mode: String(device.f16.mode), t: device.f16.t || null } : null,
      browser: String(device.browser || ''), os: String(device.os || ''), installed: !!device.installed, models: (device.models || []).map(String) },
  };
  // what the app showed here (none of this asks the network: it is what the screen already had)
  rep.radar = s.radarNewest ? { t: s.radarNewest, ageMin: Math.max(0, Math.round((now - s.radarNewest) / 60e3)), here: pos ? radarHere(s.radarFrame, pos.lat, pos.lon) : null }
    : { t: null, err: String(s.radarErr || '').slice(0, 120) };
  if (rep.radar.here) rep.radar.here = { mmh: Math.round(rep.radar.here.mmh * 10) / 10, snow: rep.radar.here.snow, km: rep.radar.here.km };
  if (pos) {
    rep.run = runHere(s.run, pos.lat, pos.lon, now);
    if (rep.run && rep.run.slots) rep.run.slots = rep.run.slots.map((x) => (x.past ? x : { m: x.m, mmh: Math.round(x.mmh * 10) / 10, chance: x.chance == null ? null : Math.round(x.chance * 100), src: x.src }));
    rep.beam = beamHere(s.beamFrame, pos.lat, pos.lon, now);
    rep.appAlerts = appAlertsHere(s.run, pos.lat, pos.lon);
    rep.nws = nwsHere(s, pos.lat, pos.lon);
  }
  return rep;
}

const seenList = (rep) => [...(rep.rain ? [RAIN.find((x) => x[0] === rep.rain)] : []), ...rep.also.map((k) => ALSO.find((x) => x[0] === k))].filter(Boolean);
const verShort = (v) => { const m = String(v || '').match(/\bv(\d{2,4})\b/); return m ? `v${m[1]}` : ''; };
const F16_CODE = { rne16: 'r', native: 'n', f32: 'f' };
const slotShort = (x, chance) => (x.past ? '-' : `${rainCat(x.mmh)}${chance && x.chance != null ? Math.round(x.chance / 10) * 10 : ''}`);   // the chance to the nearest 10 %

/** the short report: at most 160 plain characters (one SMS, also by satellite) */
export function shortText(rep, max = SHORT_MAX) {
  const seen = seenList(rep).map((x) => x[2]).join(',') || '-';
  const w = rep.where, T = rep.town;
  const parts = [];   // [key, text] in reading order; the keys say which go first when it is too long
  parts.push(['head', `WW ${shortTime(rep.t)} ${seen}`]);
  if (w) parts.push(['where', `${w.how === 'gps' ? 'gps' : 'map'} ${fixed(w.lat)},${fixed(w.lon)}`]);
  if (T) parts.push(['town', T.mi < 0.5 ? `in ${gsm(T.name).slice(0, 14)}` : `${Math.round(T.mi)}${T.dir} ${gsm(T.name).slice(0, 14)}`]);
  // the app: its model, the radar here, the rain nowcast
  const app = [MODEL_CODE[rep.model] || '-'];
  const rd = rep.radar;
  if (rd && rd.t) app.push(`r${rd.ageMin}m${rd.here ? `=${rainCat(rd.here.mmh)}${rd.here.snow && rainCat(rd.here.mmh) !== '0' ? 's' : ''}` : ''}`); else app.push('r?');
  const run = rep.run;
  if (run) {
    const tag = rep.model === 'beam' || (rep.model && rep.model !== run.model) ? `${MODEL_CODE[run.model]} ` : '';
    app.push(run.out ? `${tag}f out` : `${tag}f${run.ageMin}m=${run.slots.map((x) => slotShort(x, run.members > 1)).join('/')}`);
  } else if (rep.model !== 'beam') app.push('f none');
  parts.push(['app', app.join(' ')]);
  const b = rep.beam;
  if (b && (rep.model === 'beam' || (b.fresh && !b.out))) {
    parts.push(['beam', !b.fresh ? 'BM old' : b.out ? 'BM out' : `BM f${b.ageMin}m ${HEAD_ORDER.filter((h) => b.heads[h]).map((h) => `${HEAD_CODE[h]}${b.heads[h].bins.map((v, k) => `${v}${b.heads[h].warned[k] ? '!' : ''}`).join('/')}`).join(' ')}`]);
  } else if (rep.model === 'beam') parts.push(['beam', 'BM none']);
  if (rep.appAlerts && rep.appAlerts.length) parts.push(['alerts', `A:${rep.appAlerts.map((a) => a.code).join(',')}`]);
  const nw = rep.nws, codes = nw ? [...new Set(nw.events.map((e) => nwsCode(e.event)))].slice(0, 4) : [];
  parts.push(['nws', `NWS ${codes.length ? codes.join(',') : nw && nw.complete ? '0' : '?'}`]);
  const ver = verShort(rep.version), f16 = rep.device && rep.device.f16 ? F16_CODE[rep.device.f16.mode] || '' : '';
  if (ver) parts.push(['ver', ver]);
  if (f16) parts.push(['f16', `f16${f16}`]);
  const note = gsm(rep.note);
  if (note) parts.push(['note', `n:${note}`]);
  // within a group the parts are joined by a space, the groups by "; "
  const GROUP = { head: 0, where: 0, town: 0, app: 1, beam: 2, alerts: 3, nws: 4, ver: 5, f16: 5, note: 6 };
  const join = (list) => list.map(([k, t], i) => (i ? (GROUP[list[i - 1][0]] === GROUP[k] ? ' ' : '; ') : '') + t).join('');
  let list = parts.slice();
  for (const k of ['f16', 'alerts', 'beam', 'town', 'ver']) { if (join(list).length <= max) break; list = list.filter((x) => x[0] !== k); }
  if (join(list).length > max) {   // the note is cut to what is left (".." marks the cut)
    const i = list.findIndex((x) => x[0] === 'note');
    if (i >= 0) {
      const room = max - (join(list).length - list[i][1].length);
      if (room >= 8) list[i] = ['note', list[i][1].slice(0, room - 2).trimEnd() + '..']; else list.splice(i, 1);
    }
  }
  for (const k of ['nws', 'app']) { if (join(list).length <= max) break; list = list.filter((x) => x[0] !== k); }
  return join(list).slice(0, max).trimEnd();
}

/** the full report (plain text, for the share sheet or a copy) */
export function fullText(rep) {
  const L = [], w = rep.where, T = rep.town;
  L.push('Wallowa Weather field report (test)');
  L.push(`Time: ${fullTime(rep.t)} (${utc(rep.t)})`);
  const seen = seenList(rep).map((x) => x[1]);
  L.push(`Seen: ${seen.length ? seen.join('; ') : 'not given'}`);
  if (rep.note) L.push(`Note: ${rep.note}`);
  if (w) {
    const extra = w.how === 'gps' ? ['my GPS, rounded to about 100 m', w.acc != null ? `GPS accurate to about ${w.acc} m` : '', w.alt != null ? `elevation about ${Math.round(w.alt * 3.281 / 10) * 10} ft` : ''].filter(Boolean).join('; ')
      : `the place picked on the map${w.label ? `, "${w.label}"` : ''}, not GPS`;
    L.push(`Where: ${fixed(w.lat)}, ${fixed(w.lon)} (${extra})`);
    if (T) L.push(`Near: ${T.mi < 0.5 ? `in ${T.name}${T.st ? ', ' + T.st : ''}` : `${T.mi} mi ${T.dirWords} of ${T.name}${T.st ? ', ' + T.st : ''}`}`);
    L.push(`Map: https://www.google.com/maps?q=${fixed(w.lat)},${fixed(w.lon)}`);
  } else L.push('Where: not given (no GPS and no place picked)');
  L.push('');
  L.push('What the app showed here:');
  const mName = (id) => (modelById(id) || {}).name || id || 'none';
  L.push(`- Model on the map: ${mName(rep.model)}`);
  const rd = rep.radar;
  if (rd && rd.t) L.push(`- Radar (NOAA MRMS): ${clock(rd.t)}, ${rd.ageMin <= 1 ? 'just now' : `${rd.ageMin} min old`}${w ? `. At this spot: ${rd.here ? `${rd.here.snow && rd.here.mmh >= 0.2 ? 'snow' : CAT_WORDS[rainCat(rd.here.mmh)]}${rd.here.mmh >= 0.1 ? `, ${mmh(rd.here.mmh)}` : ''}${rd.here.km > 1 ? ' (4 km average)' : ''}` : 'not in the radar picture loaded'}` : ''}`);
  else L.push(`- Radar: not loaded${rd && rd.err ? ` (${rd.err})` : ''}`);
  const run = rep.run;
  if (!w) { /* nothing more without a place */ }
  else if (!run) L.push('- Nowcast: none run here yet');
  else if (run.out) L.push(`- ${mName(run.model)} nowcast (radar ${clock(run.t0)}): does not reach this spot`);
  else {
    L.push(`- ${mName(run.model)} nowcast from the ${clock(run.t0)} radar (${run.ageMin} min before this report; ${run.members} run${run.members > 1 ? 's' : ''}):`);
    for (const x of run.slots) {
      const lab = x.m === 0 ? 'now' : `+${x.m} min`;
      if (x.past) { L.push(`    ${lab}: past the nowcast's end`); continue; }
      L.push(`    ${lab}: ${CAT_WORDS[rainCat(x.mmh)]}${x.mmh >= 0.1 ? ` (${mmh(x.mmh)})` : ''}${x.chance != null ? `, ${x.chance}% chance of rain` : ''}${x.src === 'radar' ? ' (the radar it started from)' : ''}`);
    }
    if (run.text) L.push(`    It said: "${run.text}"`);
  }
  const b = rep.beam;
  if (w && b) {
    if (!b.fresh) L.push(`- BEAM: its last run (radar ${clock(b.t0)}) is past its 90 minutes`);
    else if (b.out) L.push(`- BEAM (radar ${clock(b.t0)}): this spot is outside BEAM's area`);
    else {
      L.push(`- BEAM from the ${clock(b.t0)} radar (${b.ageMin} min before), chance for 0-30 / 30-60 / 60-90 min after ${clock(b.issue)}:`);
      for (const h of HEAD_ORDER) if (b.heads[h]) L.push(`    ${HEAD_WORDS[h]}: ${b.heads[h].bins.map((v) => `${v}%`).join(' / ')}${b.heads[h].warned.some(Boolean) ? ` (BEAM warning level in ${b.heads[h].warned.map((x, k) => (x ? ['0-30', '30-60', '60-90'][k] : '')).filter(Boolean).join(', ')} min)` : ''}${h === 'hail' && b.recal ? ' (recalibrated)' : ''}`);
    }
  } else if (w && rep.model === 'beam') L.push('- BEAM: no run yet');
  if (w) L.push(`- App alert areas here (experimental): ${rep.appAlerts.length ? rep.appAlerts.map((a) => a.label).join('; ') : 'none'}`);
  const nw = rep.nws;
  if (w && nw) {
    const until = (s) => { const t = Date.parse(s); if (!isFinite(t)) return ''; const day = new Date(t).toDateString() === new Date(rep.t).toDateString() ? '' : ` ${new Date(t).toLocaleDateString('en-US', { weekday: 'short' })}`; return ` until ${clock(t)}${day}`; };
    const list = nw.events.map((e) => `${e.event}${e.ends ? until(e.ends) : ''}`).join('; ');
    if (nw.complete) L.push(`- NWS alerts here: ${list || 'none in force'}${nw.at ? ` (checked ${clock(nw.at)})` : ''}`);
    else if (nw.forPlace) L.push(`- NWS alerts: ${list ? `storm-based warning here: ${list}` : 'no storm-based warning drawn here'}; the full list the app read (${nw.at ? clock(nw.at) : ''}) was for ${nw.forPlace}, not this spot`);
    else L.push(`- NWS alerts: ${list ? `storm-based warning here: ${list}; ` : ''}the alerts for this place were not read (no signal, or the NWS warnings layer is off)`);
  }
  L.push('');
  L.push(`App: ${rep.version || 'Wallowa Weather'}`);
  const d = rep.device || {};
  L.push(`Device: ${[d.browser, d.os].filter(Boolean).join(' on ') || 'unknown'}${d.installed ? ', installed app' : ', in a browser tab'}`);
  L.push(`GPU: ${d.gpu || d.gpuNote || 'not known'}; StormScope f16 rounding: ${d.f16 ? `${d.f16.mode}${d.f16.t ? ` (seen ${clock(d.f16.t)} ${new Date(d.f16.t).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })})` : ''}` : 'not seen yet (StormScope has not run on this phone)'}`);
  if (d.models && d.models.length) L.push(`Models on this phone: ${d.models.join(', ')}`);
  L.push(`Report ${rep.id}`);
  L.push('Experimental test report, not an official weather report or warning.');
  return L.join('\n');
}

// ------------------------------------------------------------------------------------------------ the tester's own past reports (this phone)
// ------------------------------------------------------------------------------------------------ v019: public posts (X, Facebook)
/** Josh, v019: "a share to X and share to Facebook hook for the field report ... sanitized for privacy". A public post carries what was
 *  seen, roughly where (the nearest town within 20 miles, else the county; NEVER coordinates), when, the person's note with anything that
 *  pins a place or a person taken out, the app's tag and that it is Experimental. Never: coordinates, GPS accuracy or height, the device,
 *  the app version, what the models said, the map picture, or the address the app is served from (only a public one given to it). */
const X_LINK = 23;   // X counts any link as 23 characters
const NEAR_MI = 20;
/** a note made fit for a public post: coordinates (decimal or degrees-minutes), links, emails and phone numbers taken out */
export function cleanNote(s) {
  return String(s || '')
    .replace(/\b\d{1,3}\s*°\s*\d{1,2}\s*['’′]\s*(\d{1,2}(\.\d+)?\s*["”″])?\s*[NSEW]?/gi, ' ')   // 45°33'40"N
    .replace(/[-+]?\d{1,3}\.\d{2,}\s*[,;/ ]\s*[-+]?\d{1,3}\.\d{2,}/g, ' ')                       // 45.561, -117.523
    .replace(/[-+]?\b\d{1,3}\.\d{3,}\b/g, ' ')                                                    // a lone 45.5612
    .replace(/\b(https?:\/\/|www\.)\S+/gi, ' ')                                                    // links
    .replace(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g, ' ')                                                   // emails
    .replace(/(\+?1[\s.-]?)?\(?\b\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}\b/g, ' ')                       // phone numbers
    .replace(/\s+([,.;:!?])/g, '$1').replace(/([,;])\1+/g, '$1').replace(/\s{2,}/g, ' ').replace(/^[\s,;.-]+|[\s,;-]+$/g, '').trim();
}
const postTime = (t) => { try { return new Date(t).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' }); } catch (e) { return utc(t); } };
/** -> the public post's words; opts: url (the app's public address, or ''), max, countyOf(lat, lon) -> a county's name or '' */
export function socialText(rep, { url = '', max = X_MAX, countyOf = null } = {}) {
  const seen = seenList(rep).map((x) => x[1]);
  const what = seen.length ? seen.map((w, i) => (i ? w.toLowerCase() : w)).join(seen.length > 2 ? ', ' : ' and ').replace(/, ([^,]*)$/, ' and $1') : 'Weather';
  let where = '';
  const T = rep.town, w = rep.where;
  if (T && T.mi <= NEAR_MI) where = ` near ${T.name}${T.st ? `, ${T.st}` : ''}`;
  else if (w && typeof countyOf === 'function') { let c = ''; try { c = String(countyOf(w.lat, w.lon) || ''); } catch (e) { c = ''; } if (c) where = ` in ${c}`; }
  // v020 (Josh: warnings shared too): an NWS warning in force at the place (its outline holds it), first in the words after the time
  const warns = ((rep.nws && rep.nws.events) || []).filter((e) => /warning/i.test(e.event)).slice(0, 2).map((e) => e.event);
  const head = `Field report: ${what}${where} · ${postTime(rep.t)}${warns.length ? ` · In force: ${warns.join(', ')} (NWS)` : ''}`;
  const tail = ` · #WallowaWeather · Experimental, not an official report${url ? ` ${url}` : ''}`;
  const room = max - head.length - (tail.length - (url ? url.length - X_LINK : 0)) - 3;
  let note = cleanNote(rep.note);
  if (note && room < 12) note = '';
  else if (note.length > room) note = note.slice(0, Math.max(0, room - 1)).replace(/\s+\S*$/, '') + '…';
  return `${head}${note ? ` · ${note}` : ''}${tail}`;
}

const lsOf = (st) => { if (st) return st; try { return globalThis.localStorage || null; } catch (e) { return null; } };
export function loadReports(storage) { const st = lsOf(storage); try { const a = JSON.parse((st && st.getItem(STORE_KEY)) || '[]'); return Array.isArray(a) ? a : []; } catch (e) { return []; } }
/** keeps (or updates) one report: { id, t, seen, short, full, status: 'shared' | 'copied' | 'saved' } -> the list, newest first */
export function saveReport(entry, storage) {
  const st = lsOf(storage); const list = loadReports(st).filter((x) => x.id !== entry.id);
  list.unshift(entry); list.sort((a, b) => b.t - a.t);
  try { if (st) st.setItem(STORE_KEY, JSON.stringify(list.slice(0, KEEP))); } catch (e) { return null; }
  return list.slice(0, KEEP);
}
export function clearReports(storage) { const st = lsOf(storage); try { if (st) st.removeItem(STORE_KEY); } catch (e) { /* */ } }

// ------------------------------------------------------------------------------------------------ the page (Settings › Field report, or a sheet)
let cssOn = false;
function loadCss(doc) {
  if (cssOn || !doc || !doc.head) return; cssOn = true;
  const l = doc.createElement('link'); l.rel = 'stylesheet'; l.href = new URL('./report.css', import.meta.url).href; doc.head.append(l);
}
const call = (f, ...a) => { try { return typeof f === 'function' ? f(...a) : undefined; } catch (e) { return undefined; } };

/** the spot's mark on the picture: the report's position is rounded to 0.001 degree, so its ring is at least SPOT_M across the ground */
export const SPOT_M = 100;
/** the mark's radius in picture px: SPOT_M at the map's scale, never smaller than `min` (zoomed out it covers more ground, never less) */
export function spotRadius(toScreen, lat, lon, scale, min) {
  const a = call(toScreen, lat, lon), b = call(toScreen, lat + SPOT_M / 111320, lon);
  const r = a && b ? Math.abs(b.y - a.y) * scale : 0;
  return Math.max(min, isFinite(r) ? r : 0);
}
/** the map as a picture: the map without the person's GPS dot, accuracy ring or heading (shot = map.js snapshot(): its middle rounded to
 *  ~100 m too; never the live canvas), longest side at most 1280 px, a ~100 m ring at the report's rounded spot, and a caption line */
export async function mapPicture(shot, rep) {
  const canvas = shot && shot.canvas;
  if (!canvas || !canvas.width || !canvas.height || typeof document === 'undefined') return null;
  const k = Math.min(1, 1280 / Math.max(canvas.width, canvas.height)), W = Math.round(canvas.width * k), H0 = Math.round(canvas.height * k);
  const dpr = shot.dpr || canvas.width / Math.max(1, shot.w || canvas.width), cap = Math.round(Math.max(44, W * 0.075));
  const c = Object.assign(document.createElement('canvas'), { width: W, height: H0 + cap }), g = c.getContext('2d');
  g.fillStyle = '#0B1620'; g.fillRect(0, 0, W, H0 + cap);
  g.drawImage(canvas, 0, 0, W, H0);
  if (rep.where && typeof shot.toScreen === 'function') {
    const p = call(shot.toScreen, rep.where.lat, rep.where.lon);
    if (p && isFinite(p.x) && isFinite(p.y)) {
      const x = p.x * dpr * k, y = p.y * dpr * k, r = spotRadius(shot.toScreen, rep.where.lat, rep.where.lon, dpr * k, Math.max(10, W * 0.025));
      if (x > -r && y > -r && x < W + r && y < H0 + r) {
        const lw = Math.min(r, 36);   // a wide ring (zoomed in) keeps a thin line
        g.lineWidth = Math.max(3, lw / 3.5); g.strokeStyle = '#FFFFFF'; g.beginPath(); g.arc(x, y, r, 0, 2 * Math.PI); g.stroke();
        g.lineWidth = Math.max(1.5, lw / 7); g.strokeStyle = '#E5332A'; g.beginPath(); g.arc(x, y, r, 0, 2 * Math.PI); g.stroke();
      }
    }
  }
  const fs = Math.round(cap * 0.32); g.fillStyle = '#F5F5F7'; g.font = `600 ${fs}px system-ui, sans-serif`; g.textBaseline = 'middle';
  const mName = (modelById(rep.model) || {}).name || '';
  g.fillText(`Field report · ${fullTime(rep.t)}${mName ? ` · ${mName}` : ''}`, Math.round(cap * 0.3), H0 + cap * 0.32, W - cap * 0.6);
  g.font = `400 ${Math.round(fs * 0.85)}px system-ui, sans-serif`; g.fillStyle = 'rgba(235,235,245,0.75)';
  g.fillText(`${rep.version || 'Wallowa Weather'} · Experimental, not an official report`, Math.round(cap * 0.3), H0 + cap * 0.7, W - cap * 0.6);
  const blob = await new Promise((res) => { try { c.toBlob((b) => res(b), 'image/png'); } catch (e) { res(null); } });   // a map from another site's tiles could not be read: no picture
  if (!blob) return null;
  const d = new Date(rep.t), name = `field-report-${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}.png`;
  try { return new File([blob], name, { type: 'image/png' }); } catch (e) { return null; }
}


/** builds the field report page into `el` -> { root, report(), short(), full() } */
export function fillReport(el, ctx = {}, { doc = document } = {}) {
  loadCss(doc);
  const mk = (tag, cls, text) => { const e = doc.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  const btn = (cls, text) => { const b = mk('button', cls, text); b.type = 'button'; return b; };
  const toast = (t) => call(ctx.toast, t);
  const S0 = () => call(ctx.state) || {};
  const input = { rain: null, also: [], note: '' };
  const loc = { want: false, state: 'off', fix: null };
  let rid = newId(), sent = false, rep = null, pic = null, picKey = '', dev = null, hi = null, confirming = false, live = false;

  const root = mk('div', 'fr'); el.append(root);
  if (ctx.heading !== false) root.append(mk('h2', 'nc-h', 'Field report'));
  root.append(mk('p', 'fr-p', 'What is the weather doing where you are? The app adds what it showed for this spot. Nothing leaves this phone until you share it.'));
  root.append(mk('p', 'fr-safe', 'Stay safe: never go near floodwater, slides or downed lines to report. In an emergency, call 911.'));
  // rain now: one choice (a second tap clears it)
  root.append(mk('p', 'nc-sub', 'Rain right now'));
  const seg = mk('div', 'nc-seg fr-seg'); root.append(seg);
  for (const [id, words] of RAIN) {
    const b = btn('nc-seg-b', words.replace(' rain', '')); b.setAttribute('aria-pressed', 'false'); b.dataset.id = id;
    b.addEventListener('click', () => { input.rain = input.rain === id ? null : id; for (const x of seg.children) { const on = x.dataset.id === input.rain; x.classList.toggle('on', on); x.setAttribute('aria-pressed', String(on)); } changed({ user: true }); });
    seg.append(b);
  }
  root.append(mk('p', 'nc-sub', 'Also seeing (tap all that apply)'));
  const chips = mk('div', 'fr-chips'); root.append(chips);
  for (const [id, words] of ALSO) {
    const b = btn('fr-chip', words); b.setAttribute('aria-pressed', 'false');
    b.addEventListener('click', () => { const on = !input.also.includes(id); input.also = on ? input.also.concat(id) : input.also.filter((x) => x !== id); b.classList.toggle('on', on); b.setAttribute('aria-pressed', String(on)); changed({ user: true }); });
    chips.append(b);
  }
  root.append(mk('p', 'nc-sub', 'Note (optional)'));
  const note = mk('textarea', 'fr-note'); note.rows = 2; note.maxLength = 500; note.placeholder = 'For example: water over the road at mile 12'; note.setAttribute('aria-label', 'Note');
  note.addEventListener('input', () => { input.note = note.value; changed({ user: true }); }); root.append(note);

  // where: the GPS (only when the tester allows it; rounded), else the place picked on the map
  root.append(mk('p', 'nc-sub', 'Where'));
  const whereBox = mk('div', 'fr-card'), whereTxt = mk('p', 'fr-where'), locL = mk('label', 'nc-sw fr-sw'), locT = mk('span', 'nc-sw-t'), locI = mk('input');
  locI.type = 'checkbox'; locT.append(mk('b', null, 'Add my location'), mk('span', 'footnote', 'From GPS, rounded to about 100 m. Works with no cell service. It is only in the report you share.'));
  locL.append(locT, locI); whereBox.append(whereTxt, locL); root.append(whereBox);
  // the map picture
  const canFiles = (() => { try { return !!(globalThis.navigator && navigator.canShare && typeof File !== 'undefined' && navigator.canShare({ files: [new File([new Uint8Array(8)], 'x.png', { type: 'image/png' })] })); } catch (e) { return false; } })();
  const canPic = typeof ctx.snapshot === 'function';   // the picture is only ever made from map.js snapshot() (no GPS dot), never the live canvas
  const picL = mk('label', 'nc-sw fr-sw'), picT = mk('span', 'nc-sw-t'), picI = mk('input'); picI.type = 'checkbox'; picI.checked = canFiles && canPic; picI.disabled = !canFiles || !canPic;
  picT.append(mk('b', null, 'Add a picture of the map'), mk('span', 'footnote', picI.disabled ? 'This phone can’t share a picture from here: the text goes on its own.' : 'The map as it is now, with a ring around the spot (to about 100 m; your GPS dot is left out). Goes with the full report.'));
  picL.append(picT, picI); root.append(picL);
  // send
  const hint = mk('p', 'fr-hint', 'Pick what you see first.');
  const shareB = btn('nc-btn fr-main', 'Share report'), shortB = btn('nc-btn ghost fr-main', 'Short text for satellite');
  const links = mk('div', 'fr-links'), copyB = btn('nc-link', 'Copy report'), copyS = btn('nc-link', 'Copy short text'), saveB = btn('nc-link', 'Save for later');
  links.append(copyB, copyS, saveB); root.append(hint, shareB, shortB, links);
  // v019: post it publicly (X, Facebook) - the exact words first; the town only, never the place's coordinates, the phone or the app
  // v020: the post box (post.js) - the exact words, the picture with no GPS dot or place mark (its middle snapped, a region at least)
  const pubWords = () => (rep ? socialText(rep, { url: publicUrl(), countyOf: ctx.countyOf }) : '');   // rep: made by changed() once the screen is up
  async function pubPicture() {
    const r = rep, c = call(ctx.center), at = (r && r.where) || c; if (!r || !at || typeof ctx.snapshotAt !== 'function') return null;
    const shot = await ctx.snapshotAt(pictureView(at, call(ctx.zoom) || 9), { here: false });
    return publicPicture(shot, { title: `Field report · ${fullTime(r.t)}`, name: 'field-report' });
  }
  const post = postBox({ doc, toast, words: pubWords, picture: pubPicture, onPosted: () => { if (rep) remember(rep, 'shared'); } });
  root.append(post.el);
  const det = mk('details', 'fr-prev'), sum = mk('summary', null, 'See what is sent'), shortP = mk('pre', 'fr-pre fr-short'), shortN = mk('p', 'footnote'), fullP = mk('pre', 'fr-pre');
  det.append(sum, mk('p', 'nc-sub', 'Short text'), shortP, shortN, mk('p', 'nc-sub', 'Full report'), fullP); root.append(det);
  // the tester's own past reports, on this phone only
  const past = mk('div', 'fr-past'); root.append(mk('p', 'nc-sub', 'Your reports (kept on this phone only)'), past);
  root.append(mk('p', 'footnote fr-foot', 'Experimental test: a report is not an official weather report, and the app is never an official warning. For warnings, follow the National Weather Service and your local officials.'));

  const fixOf = (f) => (f.coords ? { lat: f.coords.latitude, lon: f.coords.longitude, acc: f.coords.accuracy, alt: f.coords.altitude } : { lat: f.lat, lon: f.lon, acc: f.acc, alt: f.alt });
  function getFix() {
    if (!globalThis.navigator || !navigator.geolocation) { loc.state = 'none'; changed({ moved: true }); return; }
    loc.state = 'asking'; changed({ moved: true });
    navigator.geolocation.getCurrentPosition((p) => { if (!loc.want) return; loc.fix = fixOf(p); loc.state = 'on'; changed({ moved: true }); },
      (e) => { if (!loc.want) return; loc.state = e && e.code === 1 ? 'denied' : 'error'; if (e && e.code === 1) { loc.want = false; locI.checked = false; } changed({ moved: true }); },
      { enableHighAccuracy: true, maximumAge: 60e3, timeout: 60e3 });
  }
  function useLocation(on) {
    loc.want = on; locI.checked = on;
    if (!on) { loc.state = 'off'; loc.fix = null; changed({ moved: true }); return; }
    const g = S0().gps; if (g) { loc.fix = fixOf(g); loc.state = 'on'; changed({ moved: true }); } else getFix();
  }
  locI.addEventListener('change', () => useLocation(locI.checked));
  function where() {
    if (loc.want && loc.fix) return { lat: loc.fix.lat, lon: loc.fix.lon, acc: loc.fix.acc, alt: loc.fix.alt, how: 'gps' };
    const p = ctx.place || S0().place || null; return p && !ownPosition(p) ? { lat: p.lat, lon: p.lon, how: 'place', label: p.label || '' } : null;
  }
  function paintWhere(r) {
    const w = r.where, T = r.town;
    const town = T ? (T.mi < 0.5 ? `in ${T.name}, ${T.st}` : `${T.mi} mi ${T.dirWords} of ${T.name}, ${T.st}`) : '';
    const lead = loc.want && loc.state === 'asking' ? 'Finding your location… (with no cell service the first fix can take a minute or two)' : loc.state === 'denied' ? 'Location is off for this app (your phone’s settings).'
      : loc.want && loc.state === 'error' ? 'Your location could not be found just now.' : loc.state === 'none' ? 'This browser can’t share your location.' : '';
    whereTxt.textContent = '';
    if (lead) whereTxt.append(mk('span', 'fr-dim', lead + ' '));
    if (!w) { whereTxt.append(mk('span', null, 'No place yet: turn on your location, or press and hold your spot on the map, then open the report.')); return; }
    whereTxt.append(mk('b', null, w.how === 'gps' ? 'Your location' : `The place on the map${w.label ? `: ${w.label}` : ''}`),
      mk('span', null, ` · ${[town, `${fixed(w.lat)}, ${fixed(w.lon)}`].filter(Boolean).join(' · ')}${w.how === 'gps' ? '' : ' (not your GPS)'}`));
    if (w.how === 'gps' && ctx.place && !ownPosition(ctx.place)) whereTxt.append(mk('span', 'fr-dim', ` Switch it off to report the place you picked${ctx.place.label ? ` (${ctx.place.label})` : ''} instead.`));
  }
  function device() {
    if (dev) return dev;
    const d = call(ctx.device) || {}, b = browserFacts(globalThis.navigator, hi);
    const ms = ctx.models || {}, names = { stormscope: 'StormScope', dgmr: 'DGMR', beam: 'BEAM' };
    const models = Object.keys(names).filter((k) => !!(call(ms[k] && ms[k].status) || {}).ready).map((k) => names[k]);
    dev = { gpu: d.gpu || '', gpuNote: d.gpuNote || '', f16: d.f16 || null, browser: b.browser, os: b.os, installed: b.installed, models };
    return dev;
  }
  const ready = () => !!(input.rain || input.also.length || input.note.trim());
  const make = () => buildReport({ state: S0(), input: { rain: input.rain, also: input.also, note: input.note, where: where() }, now: Date.now(), version: ctx.version || '', device: device(), id: rid });
  // the picture is made ahead (a share needs the tap's moment): at open, and again when the spot moves
  function preparePic(r) {
    if (!picI.checked || !canPic) { pic = null; picKey = ''; return; }
    const key0 = r.where ? `${r.where.lat},${r.where.lon}` : '-', key = key0 + (ownPosition(ctx.place || S0().place || null) && !(loc.want && loc.fix) ? '|nohere' : ''); if (key === picKey && pic) return;
    // v018 privacy review: the phone's own position as the place, with "Add my location" off: its dot stays off the picture too
    const p0 = ctx.place || S0().place || null, here = !(ownPosition(p0) && !(loc.want && loc.fix));
    picKey = key + (here ? '' : '|nohere'); pic = mapPicture(call(ctx.snapshot, { here }), r).catch(() => null);
  }
  picI.addEventListener('change', () => { if (rep) preparePic(rep); });
  function changed({ user = false, moved = false } = {}) {
    if (!live) return;
    if (user && sent) { rid = newId(); sent = false; }   // a change after a report went out: a new report
    rep = make(); paintWhere(rep);
    const ok = ready(); hint.hidden = ok; for (const b of [shareB, shortB, copyB, copyS, saveB]) b.disabled = !ok;
    const s = shortText(rep); shortP.textContent = s; shortN.textContent = `${s.length} of ${SHORT_MAX} characters, plain letters only: fits one text message, also by satellite.`;
    fullP.textContent = fullText(rep);
    post.setEnabled(ok); if (moved) post.repicture();
    if (moved || !pic) preparePic(rep);
  }
  const seenWords = (r) => seenList(r).map((x) => x[1]).join(', ') || 'Note';
  function remember(r, status) {
    sent = true;
    const prev = loadReports().find((x) => x.id === r.id); if (status === 'saved' && prev && prev.status !== 'saved') status = prev.status;   // never "not sent" after a share
    const list = saveReport({ id: r.id, t: r.t, seen: seenWords(r), short: shortText(r), full: fullText(r), status });
    if (!list) toast('This report could not be kept on the phone (storage is full or off).');
    paintPast();
  }
  async function copyText(text, r, what) {
    try { await navigator.clipboard.writeText(text); remember(r, 'copied'); toast(`${what} copied. Paste it into a text or an email.`); return true; }
    catch (e) {
      det.open = true; const p = what === 'Short text' ? shortP : fullP;
      try { const sel = getSelection(), rg = doc.createRange(); rg.selectNodeContents(p); sel.removeAllRanges(); sel.addRange(rg); } catch (x) { /* */ }
      toast('Copy did not work: the text is selected below, copy it from there.'); return false;
    }
  }
  const TITLE = 'Wallowa Weather field report';
  async function share(short) {
    if (!ready()) return;
    const r = make(); rep = r;
    const text = short ? shortText(r) : fullText(r);
    if (globalThis.navigator && navigator.share) {
      let files = null;
      if (!short && picI.checked && pic) { const f = await Promise.race([pic, new Promise((res) => setTimeout(() => res(null), 2500))]); try { if (f && navigator.canShare({ files: [f] })) files = [f]; } catch (e) { files = null; } }
      try { await navigator.share(short ? { text } : files ? { title: TITLE, text, files } : { title: TITLE, text }); remember(r, 'shared'); toast('Thank you: the report went to the share sheet.'); return; }
      catch (e) {
        if (e && e.name === 'AbortError') return;
        if (files) { try { await navigator.share({ title: TITLE, text }); remember(r, 'shared'); toast('Shared without the picture.'); return; } catch (x) { if (x && x.name === 'AbortError') return; } }
      }
    }
    await copyText(text, r, short ? 'Short text' : 'Report');   // no share sheet here (or it failed): a copy
  }
  shareB.addEventListener('click', () => share(false));
  shortB.addEventListener('click', () => share(true));
  copyB.addEventListener('click', () => { if (ready()) { rep = make(); copyText(fullText(rep), rep, 'Report'); } });
  copyS.addEventListener('click', () => { if (ready()) { rep = make(); copyText(shortText(rep), rep, 'Short text'); } });
  saveB.addEventListener('click', () => { if (!ready()) return; rep = make(); remember(rep, 'saved'); toast('Kept on this phone. Send it from “Your reports” below when you have signal.'); });
  function paintPast() {
    past.textContent = ''; const list = loadReports();
    if (!list.length) { past.append(mk('p', 'footnote', 'None yet.')); return; }
    const W = { shared: 'Shared', copied: 'Copied', saved: 'Not sent yet' };
    for (const x of list.slice(0, 20)) {
      const row = mk('div', 'fr-row' + (x.status === 'saved' ? ' unsent' : '')), t = mk('div', 'fr-row-t');
      t.append(mk('b', null, fullTime(x.t)), mk('span', 'footnote', `${x.seen} · ${W[x.status] || ''}`)); row.append(t);
      const bb = mk('div', 'fr-row-b'), s1 = btn('nc-btn ghost sm', 'Share'), s2 = btn('nc-btn ghost sm', 'Short');
      const again = async (text, short) => {
        if (navigator.share) { try { await navigator.share(short ? { text } : { title: TITLE, text }); saveReport(Object.assign({}, x, { status: 'shared' })); paintPast(); return; } catch (e) { if (e && e.name === 'AbortError') return; } }
        try { await navigator.clipboard.writeText(text); saveReport(Object.assign({}, x, { status: x.status === 'saved' ? 'copied' : x.status })); paintPast(); toast('Copied. Paste it into a text or an email.'); } catch (e) { toast('Copy did not work on this phone.'); }
      };
      s1.addEventListener('click', () => again(x.full, false)); s2.addEventListener('click', () => again(x.short, true));
      bb.append(s1, s2); row.append(bb); past.append(row);
    }
    if (list.length > 20) past.append(mk('p', 'footnote', `And ${list.length - 20} older.`));
    const cl = btn('nc-link fr-clear', confirming ? 'Tap again to delete all your reports from this phone' : 'Delete all my reports from this phone');
    cl.addEventListener('click', () => {
      if (!confirming) { confirming = true; paintPast(); setTimeout(() => { if (confirming) { confirming = false; if (past.isConnected) paintPast(); } }, 5000); return; }
      confirming = false; clearReports(); paintPast(); toast('Your reports were deleted from this phone.');
    });
    past.append(cl);
  }

  // start: everything is in place now
  live = true; paintPast(); changed({ moved: true });
  if (S0().gps) useLocation(true);   // "My location" is on: its fix at once
  else (async () => {   // already allowed: on at once, with no prompt; otherwise the switch asks
    let perm = 'prompt'; try { if (navigator.permissions) perm = (await navigator.permissions.query({ name: 'geolocation' })).state; } catch (e) { perm = 'prompt'; }
    if (perm === 'granted') useLocation(true); else if (perm === 'denied') { loc.state = 'denied'; changed(); }
  })();
  (async () => {   // the real Android version and browser build (Chrome hides them from the user-agent string); on the phone, no request
    try { if (navigator.userAgentData && navigator.userAgentData.getHighEntropyValues) hi = await navigator.userAgentData.getHighEntropyValues(['platformVersion', 'fullVersionList']); } catch (e) { hi = null; }
    dev = null; changed();
  })();
  return { root, report: () => make(), short: () => shortText(make()), full: () => fullText(make()) };
}
