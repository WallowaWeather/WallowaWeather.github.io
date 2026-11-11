// ww.js - Wallowa Weather: the standalone shell around the Nowcast. It is the whole app:
// the map screen opens at once on the town of Wallowa, Oregon (or the person's own spot in Wallowa County); the two forecast models (NVIDIA
// StormScope, the default, and DeepMind DGMR) download once and run on this device through WebGPU; StormScope's radar / satellite /
// lightning layers are kept fresh while the screen is up; the app's own alert areas are hatched, NWS warnings are lined boxes.
// Here: the job queue (one forecast at a time), the model downloads, the menu (install guide, models, about, diagnostics).
'use strict';
import { initNowcast } from './nowcast/nowcast_app.js';
import { creditsNode } from './nowcast/credits.js';
import { loadGeo } from './places/places.js';
import { createNowcastEngine } from './nowcast/engine.js';
import { createStormScopeEngine } from './nowcast/stormscope/engine.js';
import { renderGuide, isInstalled, deviceOf } from './install.js';
import { startScreen, offerBubble, showLanding, copyrightBar, KEYS } from './landing.js';   // LANDING: the first-run page, the copyright bar
import { createDownloadAll } from './dlall.js';   // LANDING: the three models in one go
import { BEAM_SIZE_MB } from './nowcast/models_info.js';   // v008
import { beamModel } from './nowcast/beam_live.js';   // v009: BEAM live on this phone
import { COUNTIES, countyAt } from './nowcast/counties.js';   // v014: the app's counties (Wallowa first; the others are simply there)
import { speedTuneHooks } from './nowcast/tune/ui.js';   // SPEED TUNE: Settings > Speed tune

export const VERSION = 'Wallowa Weather 1.0.1';
// the app's area: Wallowa County (its name, box and home: the town of Wallowa); v014: it forecasts, searches and runs nowcasts inside any of its counties
const AREA = { app: 'Wallowa Weather', name: COUNTIES[0].name, bbox: COUNTIES[0].bbox, home: COUNTIES[0].home, counties: COUNTIES, countyAt,
  contains(lat, lon) { return !!countyAt(lat, lon); } };
const PACKS = (window.P0_CONFIG && window.P0_CONFIG.packs) || {};
const $ = (id) => document.getElementById(id), mk = (t, c, x) => { const e = document.createElement(t); if (c) e.className = c; if (x != null) e.textContent = x; return e; };
const LS = { get: (k, d) => { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } }, set: (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* */ } } };

// Never run inside another site's page (a frame could lay its own buttons over the map): GitHub Pages sends no frame-ancestors or
// X-Frame-Options header and a <meta> CSP ignores frame-ancestors, so the app checks for itself. Framed, it shows only a link that opens
// it on its own, and stops here (nothing below runs: no map, no requests, no service worker).
if (window.top !== window.self) {
  const box = mk('div', 'ww-framed'), a = mk('a', 'btn', 'Open Wallowa Weather');
  a.href = location.origin + location.pathname; a.target = '_blank'; a.rel = 'noopener noreferrer';
  box.append(mk('p', null, 'Wallowa Weather does not run inside another page.'), a);
  document.body.replaceChildren(box);
  throw new Error('Wallowa Weather was opened inside a frame: not started');
}

// ---------------------------------------------------------------------------------------------- diagnostics + toast
const LOG = [];
function diag(name, data) { LOG.push({ t: new Date().toISOString(), name, data: data || null }); if (LOG.length > 300) LOG.shift(); try { console.info('[ww]', name, data || ''); } catch (e) { /* */ } }
addEventListener('error', (e) => diag('page error', { message: String(e.message || e.error || e).slice(0, 200), src: (e.filename || '').split('/').pop(), line: e.lineno }));
addEventListener('unhandledrejection', (e) => diag('page error', { message: String((e.reason && e.reason.message) || e.reason).slice(0, 200) }));
let toastT = 0;
function toast(text) { const t = $('ww-toast'); t.textContent = text; t.hidden = false; clearTimeout(toastT); toastT = setTimeout(() => { t.hidden = true; }, 4200); }

// ---------------------------------------------------------------------------------------------- the three models: status + downloads
let DG = null, SS = null, BM = null;
const dgmr = async () => DG || (DG = await createNowcastEngine({ packUrl: PACKS['dgmr-nowcast'] }));
const storm = async () => SS || (SS = await createStormScopeEngine({ packUrl: PACKS['stormscope-mrms'] }).then((e) => { e.on('f16', (d) => { diag('stormscope: f16 rounding ' + d.mode, d); LS.set('ww:f16', { mode: d.mode, t: Date.now() }); }); return e; }));   // FIELD REPORT (fieldkit): the last f16 rounding kept for the report
const beam = async () => BM || (BM = beamModel({ packUrl: PACKS.beam }));   // v009 (the engine itself loads only for a run)
const ST = { dgmr: null, ss: null, beam: null }, DL = { dgmr: null, ss: null, beam: null };
const eng = (k) => (k === 'dgmr' ? dgmr() : k === 'beam' ? beam() : storm());
async function refresh(k) {
  try { ST[k] = await (await eng(k)).status(); } catch (e) { ST[k] = { complete: false, error: String((e && e.message) || e) }; diag('model status', { k, message: ST[k].error }); }
  if (NC) NC.refresh(); if (menuOpen === 'models') openMenu('models');
}
/** LANDING: can this phone run model k at all? -> { supported, reason } (the engine's own check: WebGPU, the graphics chip's limits) */
async function capOf(k) {
  try { const e = await eng(k), c = e.capabilities ? e.capabilities() : { supported: e.supported ? e.supported() : true }; return { supported: !!c.supported, reason: c.reason || '' }; }
  catch (e) { return { supported: true, reason: '' }; }   // the download says what is wrong
}
/** Android (Chrome) + iPhone: before a download, can this phone run the model at all, and is there room for the rest of it? -> '' | why not */
async function canDownload(k) {
  { const c = await capOf(k); if (!c.supported) return `This phone can't run this model: ${c.reason || 'no WebGPU'}.`; }
  try {
    if (!(navigator.storage && navigator.storage.estimate)) return '';
    const { usage = 0, quota = 0 } = await navigator.storage.estimate(), s = ST[k] || {};
    const need = Math.max(0, (s.totalBytes || SZ[k]) - (s.haveBytes || 0)), free = quota - usage;
    diag('storage before download', { k, needMB: Math.round(need / 1e6), freeMB: Math.round(free / 1e6), usageMB: Math.round(usage / 1e6) });
    if (quota && free < need + 50e6) return `Not enough room: this model needs ${Math.ceil(need / 1e6)} MB and this phone lets the app have about ${Math.max(0, Math.floor(free / 1e6))} MB more. Free some space, then try again.`;
  } catch (e) { /* no estimate: try */ }
  return '';
}
async function download(k, { signal } = {}) {   // LANDING: signal (Download all's Cancel)
  if (DL[k] && DL[k].running) return;
  const no = await canDownload(k); if (no) { toast(no); return; }
  DL[k] = { running: true, pct: 0 }; if (NC) NC.refresh();
  // Chrome on Android keeps a site's storage "best effort" (it can clear it when the phone runs short of space) unless this is granted;
  // Chrome decides by itself, no question asked (granted for an installed app as a rule). Cleared: the models show as not downloaded.
  try { diag('storage persist', { granted: await navigator.storage.persist() }); } catch (e) { /* */ }
  const t0 = performance.now(); let last = null;
  try {
    await (await eng(k)).download({ signal, onProgress: (p) => { last = p; DL[k] = { running: true, pct: p.totalBytes ? p.haveBytes / p.totalBytes : 0 }; if (NC) NC.refresh(); if (menuOpen === 'models') openMenu('models'); } });
    diag('download done', { k, seconds: Math.round((performance.now() - t0) / 1000), mb: last ? Math.round(last.totalBytes / 1e6) : null });
  } catch (e) {
    if (!(e && e.name === 'AbortError')) {
      const msg = String((e && e.message) || e); diag('download stopped', { k, message: msg.slice(0, 200), code: e && e.code });
      toast(/quota|space/i.test(msg) ? 'The download stopped: this phone is out of room for the app. Free some space, then tap Download again (it carries on).' : `The download stopped: ${msg.slice(0, 90)}`);
    }
  }
  DL[k] = { running: false, pct: 0 }; await refresh(k);
}
async function deleteModel(k) { try { await (await eng(k)).deleteModel(); diag('model deleted', { k }); } catch (e) { toast(String((e && e.message) || e)); } await refresh(k); }

// ---------------------------------------------------------------------------------------------- the queue: one forecast at a time
const Q = (() => {
  const jobs = [], fns = {}; let busy = false, seq = 0, idleT = 0, held = false;   // SPEED TUNE: held = the speed tune has the GPU
  const emit = (ev, ...a) => { for (const f of fns[ev] || []) { try { f(...a); } catch (e) { console.error(e); } } };
  const on = (ev, f) => { (fns[ev] = fns[ev] || new Set()).add(f); return () => fns[ev].delete(f); };
  async function add(kind, params, opts = {}) { const j = { id: 'j' + (++seq), kind, params, status: 'queued', progress: null, title: opts.title || kind, ctl: new AbortController() }; jobs.push(j); setTimeout(pump, 0); return j; }
  async function cancel(id) { const j = jobs.find((x) => x.id === id); if (!j) return; j.ctl.abort(); if (j.status === 'queued') { j.status = 'cancelled'; emit('cancelled', j); } }
  async function pump() {
    if (busy || held) return; const j = jobs.find((x) => x.status === 'queued'); if (!j) return;
    busy = true; j.status = 'running'; clearTimeout(idleT);
    try {
      const ss = j.params.model === 'stormscope', bm = j.params.model === 'beam';
      const k = ss ? 'ss' : bm ? 'beam' : 'dgmr';
      if (!(ST[k] && ST[k].complete)) { j.status = 'cancelled'; emit('needs-download', j); return; }
      // v009: BEAM never runs beside StormScope (its peak is ~570 MB of graphics memory) or DGMR: the others let go of the GPU first
      // Android: one model in graphics memory at a time (StormScope ~0.55 GB, DGMR float ~0.45 GB): a 6 GB phone shares that with the system
      if (!ss) { try { if (SS) SS.unload(); } catch (e) { /* */ } } if (ss || bm) { try { if (DG) DG.unload(); } catch (e) { /* */ } } if (!bm && BM) { try { BM.unload(); } catch (e) { /* */ } }
      let engine;
      if (ss) engine = await storm(); else if (bm) engine = await beam(); else { engine = await dgmr(); await engine.load(); }
      const ctx = { job: j, params: j.params, engine, signal: j.ctl.signal, progress: (p) => { j.progress = p; emit('progress', j, p); } };
      const result = await NC.runner.run(ctx);
      j.status = 'done'; j.result = result; emit('done', j);
    } catch (e) {
      j.status = e && (e.name === 'AbortError' || e.code === 'ABORTED') ? 'cancelled' : 'failed'; j.error = { message: String((e && e.message) || e).slice(0, 200), code: (e && e.code) || null };
      diag('forecast ' + j.status, j.error); emit(j.status, j);
    } finally {
      busy = false; if (jobs.length > 30) jobs.splice(0, jobs.length - 30);
      idleT = setTimeout(() => { try { if (DG) DG.unload(); } catch (e) { /* */ } try { if (SS) SS.unload(); } catch (e) { /* */ } try { if (BM) BM.unload(); } catch (e) { /* */ } }, NC && NC.shown ? 120000 : 5000);   // the GPU memory goes back after a while
      setTimeout(pump, 0);
    }
  }
  /** SPEED TUNE: hold(true) waits for the running job, then every model lets go of its GPU memory; hold(false) lets the queue run again */
  async function hold(on) {
    held = !!on; if (!held) { setTimeout(pump, 0); return; }
    while (busy) await new Promise((r) => setTimeout(r, 250));
    clearTimeout(idleT); for (const f of [() => DG && DG.unload(), () => SS && SS.unload(), () => BM && BM.release()]) { try { f(); } catch (e) { /* */ } }
  }
  return { add, list: () => jobs.slice(), on, cancel, hold };
})();

async function positionIfAllowed() {
  try { if (!navigator.permissions || !navigator.geolocation) return null; if ((await navigator.permissions.query({ name: 'geolocation' })).state !== 'granted') return null; } catch (e) { return null; }
  return new Promise((res) => navigator.geolocation.getCurrentPosition((p) => res({ lat: Math.round(p.coords.latitude * 100) / 100, lon: Math.round(p.coords.longitude * 100) / 100 }), () => res(null), { maximumAge: 10 * 60e3, timeout: 8000 }));
}
let GEO = null;

// ---------------------------------------------------------------------------------------------- the Nowcast screen (the whole app)
let NC = null;
// v008: what Settings (the gear) reads and does for each model
const SZ = { ss: 355616347, dgmr: 135786355, beam: BEAM_SIZE_MB * 1e6 };   // until the pack's own list is read (BEAM: 24,825,793 bytes)
const stOf = (k) => ({ ready: !!(ST[k] && ST[k].complete), downloading: !!(DL[k] && DL[k].running), pct: (DL[k] && DL[k].pct) || 0,
  bytes: (ST[k] && ST[k].totalBytes) || SZ[k], error: ST[k] && !ST[k].complete ? ST[k].error : undefined });
function diagInto(el) {
  const pre = mk('pre', 'ww-diag', [VERSION, navigator.userAgent, ...LOG.map((x) => `${x.t} ${x.name} ${x.data ? JSON.stringify(x.data) : ''}`)].join('\n')); el.append(pre);
  const c = mk('button', 'btn sm', 'Copy'); c.type = 'button'; c.onclick = async () => { try { await navigator.clipboard.writeText(pre.textContent); toast('Copied.'); } catch (e) { toast('Copy did not work: select the text instead.'); } }; el.append(c);
  if (navigator.share) { const s = mk('button', 'btn sm', 'Share'); s.type = 'button'; s.onclick = () => navigator.share({ title: 'Wallowa Weather diagnostics', text: pre.textContent }).catch(() => {}); el.append(s); }   // FIELD TEST: Settings › Diagnostics › Share
}
/** FIELD REPORT (fieldkit): the device facts a report carries, with no request: the GPU as StormScope's engine saw it, its last f16 rounding */
function fieldDevice() {
  let c = null; try { c = SS && SS.capabilities ? SS.capabilities() : null; } catch (e) { c = null; }
  return { gpu: (c && c.gpu) || '', gpuNote: c ? (c.gpu ? '' : c.reason || 'no WebGPU adapter') : 'not checked yet', f16: LS.get('ww:f16', null) };
}
const SETTINGS = {
  version: VERSION, installed: isInstalled,
  models: {
    beam: PACKS.beam ? { status: () => stOf('beam'), size: () => stOf('beam').bytes, download: () => download('beam'), del: () => deleteModel('beam') }   // v009
      : { status: () => ({ note: 'Examples' }), size: () => BEAM_SIZE_MB * 1e6 },
    stormscope: { status: () => stOf('ss'), size: () => stOf('ss').bytes, download: () => download('ss'), del: () => deleteModel('ss') },
    dgmr: { status: () => stOf('dgmr'), size: () => stOf('dgmr').bytes, download: () => download('dgmr'), del: () => deleteModel('dgmr') } },
  installGuide: (el) => renderGuide(el, { onDone: () => {} }),
  downloadAll: { sub: () => DLALL.sub(), build: (el) => DLALL.build(el) },   // LANDING: Settings › Download all (v019: the models and the county map)
  diagnostics: diagInto,
  device: fieldDevice,   // FIELD REPORT (fieldkit)
  about: ['Experimental. For warnings, follow the National Weather Service. The app\'s own alert areas (hatched) are not official warnings; NWS warnings are the lined boxes. Yellow: a strong storm on the radar is heading this way (where it could go in the next 90 minutes). Red: StormScope forecasts a damaging storm core within 30 minutes. Orange: possible hail later.',
    'A public-good project for Wallowa County: the forecasts run on this phone. No account, no tracking, no analytics.',
    // v018 privacy review: each sentence checked against what the code sends and keeps
    'What leaves this phone: like any website, each service the app asks sees your internet address. GitHub Pages serves the app itself. '
      + 'The place on the map, rounded to about 1 km, goes to the National Weather Service for its forecast and alerts. Map tiles and lot '
      + 'lines for the area on screen come from USGS, NASA, Oregon Explorer and the county\'s map service (Wallowa County\'s is hosted by '
      + 'Esri ArcGIS). Radar, satellite and forecast data come from NOAA\'s open data on Amazon Web Services, in whole files or pieces about '
      + '200 km across or more, never for one spot. River gauges (USGS) and fires (NIFC, on ArcGIS) come for the whole county. Each time it '
      + 'opens, the app checks its model files at Hugging Face.',
    'Your location: the app never sends or saves your exact GPS position. When you tap Locate, or the app opens on your location, that '
      + 'place is used like any place you pick: the Weather Service gets it rounded to about 1 km, and the map loads the tiles around it. '
      + 'Otherwise it leaves the phone only in a field report or a location you share.',
    'Kept on this phone: your settings and last place, your last 3 nowcasts, recent forecast-map hours, the county maps you keep (with '
      + 'the tiles you looked at), My layers and your field reports. Nothing is uploaded. Clearing this site\'s data in your browser '
      + 'removes it all.'] };
// SPEED TUNE (nowcast/tune): Settings > Speed tune, for the models on this phone; the queue waits while it runs
SETTINGS.tune = speedTuneHooks({ version: VERSION, diag,
  ready: { beam: () => !!(PACKS.beam && ST.beam && ST.beam.complete), stormscope: () => !!(ST.ss && ST.ss.complete), dgmr: () => !!(ST.dgmr && ST.dgmr.complete) },
  dgmrPrecision: () => (ST.dgmr && ST.dgmr.precision) || 'float', dgmrSpec: async () => (await dgmr()).modelSpec('float'),
  quiet: () => Q.hold(true), resume: () => Q.hold(false) });
NC = initNowcast({ Q: () => Q, section: $('v-nowcast'),
  ready: () => !!(ST.dgmr && ST.dgmr.complete), dl: () => DL.dgmr, sizeOf: () => (ST.dgmr && ST.dgmr.totalBytes) || 135786355,
  precision: () => (ST.dgmr && ST.dgmr.precision) || 'float', download: () => download('dgmr'), geo: () => GEO || (GEO = loadGeo()),
  position: positionIfAllowed, toast, diag, home: () => NC.view.openSettings(), settings: SETTINGS,
  ssReady: () => !!(ST.ss && ST.ss.complete), ssDl: () => DL.ss, ssSize: () => (ST.ss && ST.ss.totalBytes) || 355616347, ssDownload: () => download('ss'),
  ssListed: () => !!PACKS['stormscope-mrms'], ssEngine: storm,
  // v009: BEAM live (the view runs it through the queue, shows its maps, keeps it fresh every 10 min if asked)
  beam: PACKS.beam ? { listed: () => true, ready: () => !!(ST.beam && ST.beam.complete), dl: () => DL.beam, size: () => stOf('beam').bytes, download: () => download('beam'),
    model: () => BM || (BM = beamModel({ packUrl: PACKS.beam })), release: () => { if (BM) BM.release(); } } : null,
  area: AREA, defaultModel: 'stormscope', defaultBasemap: 'satellite' });

// ---------------------------------------------------------------------------------------------- LANDING: Download all + the copyright bar
// Download all (dlall.js): the three models one after another, smallest first, through the same download() as Settings' buttons; v019
// (Josh, Nov-09-2026: "County map download should be lumped with model downloads"): then the county map, the view's (its line and size;
// its download = its switch on, then its save). It no longer downloads by itself.
const DL_KEY = { beam: 'beam', dgmr: 'dgmr', stormscope: 'ss' };
const countyMap = () => (NC && NC.view && NC.view.countyMap) || null;   // null where maps can't be saved (no Cache API)
const DLALL = createDownloadAll({
  models: () => Object.entries(DL_KEY).filter(([id]) => id !== 'beam' || PACKS.beam).map(([id, k]) => Object.assign({ id, have: (ST[k] && ST[k].haveBytes) || 0, precision: (ST[k] && ST[k].precision) || null }, stOf(k)))
    .concat(countyMap() ? [countyMap().item()] : []),
  caps: async () => { const out = {}; for (const [id, k] of Object.entries(DL_KEY)) if (id !== 'beam' || PACKS.beam) out[id] = await capOf(k); return out; },   // the models' (the map needs no WebGPU)
  download: (id, o) => (id === 'map' ? (countyMap() ? countyMap().download(o) : undefined) : download(DL_KEY[id], o)),
  estimate: () => (navigator.storage && navigator.storage.estimate ? navigator.storage.estimate() : null),
  connection: () => navigator.connection || null,
  device: () => { const d = deviceOf(); return { ios: d.os === 'ios', android: d.os === 'android', installed: isInstalled() }; } });
/** the copyright bar under the map (a tap: Settings › About, where the licence is); the map's bottom controls sit above it (landing.css) */
function footBar() {
  const sec = $('v-nowcast'); if (!sec || sec.querySelector('.ww-foot')) return;
  sec.append(copyrightBar({ onOpen: () => NC.view.openSettings('about') })); document.body.classList.add('ww-has-foot');
}

// ---------------------------------------------------------------------------------------------- the menu (the screen's top-left button)
let menuOpen = null;
function openMenu(which = 'main') {
  menuOpen = which; const sh = $('ww-sheet'), box = $('ww-sheet-box'); box.textContent = ''; sh.hidden = false;
  const close = mk('button', 'btn sm ghost ww-close', 'Close'); close.type = 'button'; close.onclick = closeMenu; box.append(close);
  if (which === 'main') {
    box.append(mk('h2', 'ww-h', 'Wallowa Weather'), mk('p', 'footnote dim', `${VERSION} · ${AREA.name}`));
    for (const [k, label, sub] of [['install', isInstalled() ? 'Installed' : 'Install this app', 'Phone, tablet or computer: the steps for this one'], ['models', 'Forecast models', 'Download, check or delete them'],
      ['about', 'About and credits', 'Where the data and the models come from'], ['diag', 'Diagnostics', 'What happened, to send when something goes wrong']]) {
      const b = mk('button', 'ww-item'); b.type = 'button'; b.append(mk('b', null, label), mk('span', 'footnote dim', sub)); b.onclick = () => openMenu(k); box.append(b);
    }
  } else if (which === 'install') {
    const g = mk('div'); box.append(g); renderGuide(g, { onDone: closeMenu });
  } else if (which === 'models') {
    box.append(mk('h2', 'ww-h', 'Forecast models'), mk('p', 'footnote dim', 'They run on this device. Each downloads once and stays in this app\'s own storage.'));
    for (const [k, name, what] of [['ss', 'NVIDIA StormScope (default)', 'Storms for the next 90 minutes from radar, the GOES satellite and lightning'], ['dgmr', 'DeepMind DGMR', 'Rain for the next 90 minutes from radar']]) {
      const s = ST[k], d = DL[k], row = mk('div', 'ww-model');
      row.append(mk('b', null, name), mk('span', 'footnote', what));
      const state = d && d.running ? `Downloading · ${Math.floor(100 * d.pct)}%` : s && s.complete ? `On this device · ${Math.round((s.totalBytes || 0) / 1e6)} MB` : s && s.error ? `Not reachable: ${s.error.slice(0, 80)}` : `Not downloaded · ${Math.round(((s && s.totalBytes) || (k === 'ss' ? 355616347 : 135786355)) / 1e6)} MB`;
      row.append(mk('span', 'footnote dim', state));
      const b = mk('button', 'btn sm', s && s.complete ? 'Delete' : 'Download'); b.type = 'button'; b.disabled = !!(d && d.running);
      b.onclick = () => (s && s.complete ? deleteModel(k) : download(k)); row.append(b); box.append(row);
    }
  } else if (which === 'about') {
    box.append(mk('h2', 'ww-h', 'About and credits'));
    for (const t of ['Experimental. For warnings, follow the National Weather Service. The app\'s own alert areas (hatched) are not official warnings; NWS warnings are the lined boxes. Yellow: a strong storm on the radar is heading this way (where it could go in the next 90 minutes). Red: StormScope forecasts a damaging storm core within 30 minutes. Orange: possible hail later.']) box.append(mk('p', 'footnote', t));
    box.append(creditsNode());
  } else if (which === 'diag') {
    box.append(mk('h2', 'ww-h', 'Diagnostics'));
    const pre = mk('pre', 'ww-diag', [VERSION, navigator.userAgent, ...LOG.map((x) => `${x.t} ${x.name} ${x.data ? JSON.stringify(x.data) : ''}`)].join('\n')); box.append(pre);
    const c = mk('button', 'btn sm', 'Copy'); c.type = 'button'; c.onclick = async () => { try { await navigator.clipboard.writeText(pre.textContent); toast('Copied.'); } catch (e) { toast('Copy did not work: select the text instead.'); } }; box.append(c);
  }
  if (which !== 'main') { const back = mk('button', 'btn sm ghost', '‹ Menu'); back.type = 'button'; back.onclick = () => openMenu('main'); box.prepend(back); }
}
function closeMenu() { menuOpen = null; $('ww-sheet').hidden = true; }
$('ww-sheet').addEventListener('click', (e) => { if (e.target.id === 'ww-sheet') closeMenu(); });

// iPhone Home Screen app (iOS 27, black-translucent status bar): the page can end short of the screen's bottom, a light strip under
// the map (a WebKit bug). Only then: make the page as tall as the screen; if iOS does not grow it within 300 ms, put it back.
function fitViewport() {
  try {
    const gap = screen.height - innerHeight;
    if (!/iPhone/.test(navigator.userAgent) || navigator.standalone !== true || gap < 20 || gap > 90) return;
    const before = innerHeight, el = document.documentElement;
    el.style.minHeight = screen.height + 'px';
    setTimeout(() => { if (innerHeight <= before) el.style.minHeight = ''; diag('fit viewport', { gap, before, after: innerHeight }); }, 300);
  } catch (e) { /* */ }
}
// ---------------------------------------------------------------------------------------------- start
(async () => {
  diag('start', { version: VERSION, installed: isInstalled() });
  fitViewport();
  // Android: the installed app asks to keep its storage (Chrome grants it to installed apps without asking); the answer goes in Diagnostics
  try { if (navigator.storage && navigator.storage.persisted) (isInstalled() ? navigator.storage.persist() : navigator.storage.persisted()).then((p) => diag('storage kept', { persisted: p }), () => {}); } catch (e) { /* */ }
  // v007: the offline store (sw.js): the app's own files and the county map stay on this phone, so it opens with no signal
  if ('serviceWorker' in navigator && isSecureContext) setTimeout(() => navigator.serviceWorker.register('./sw.js').then(() => diag('offline store ready'),
    (e) => diag('offline store failed', { message: String((e && e.message) || e).slice(0, 120) })), 3000);
  // LANDING: a browser tab's first visit opens on the install page (it replaces v008's install guide); the map and its requests wait
  if (startScreen({ installed: isInstalled(), seen: (k) => LS.get(k, false) }) === 'landing') { diag('landing'); await showLanding({ diag }); LS.set(KEYS.landing, true); diag('landing: continue in the browser'); }
  NC.open({});   // the map at once (the town of Wallowa, or the person's own place in the county)
  footBar();   // LANDING
  await Promise.all([refresh('ss'), refresh('dgmr'), PACKS.beam ? refresh('beam') : null]);
  // LANDING: then, once, the download-all bubble (an installed app's first launch, or just after the install page)
  try {
    const caps = await DLALL.caps(), plan = DLALL.plan(), noGpu = !plan.anyRuns;
    if (offerBubble({ seen: LS.get(KEYS.bubble, false), plan, noGpu, online: navigator.onLine !== false })) { LS.set(KEYS.bubble, true); diag('download-all bubble', { needMb: plan.needMb, noGpu, caps }); DLALL.open(); }
  } catch (e) { diag('download-all bubble', { message: String((e && e.message) || e).slice(0, 160) }); }
})();
