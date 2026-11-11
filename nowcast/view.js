// nowcast/view.js - the Nowcast screen: a full-screen map with two layers on one timeline - the NOAA radar up to now (left of Now) and
// the nowcast from the model on this phone (right of Now, marked "Nowcast · Experimental") - and, v018, a forecast map's hours after
// them (wind, temperature, humidity, pressure, precipitation's later hours: fields/). On top, the key across the screen (legend.js); at
// the bottom, the time bar in its own pill (timebar.js: play, "Now 8:00 AM", ticks, back to now) with the card folded above it to one line
// (cardfold.js), the model chip and the forecast map's quick button above that; Layers grouped as Weather now / Forecasts / Map details
// (layerspanel.js) and Settings on the left, Search and Locate on the right, NWS warnings drawn on the map and in a banner, and a place's
// forecast sheet (a tap on a city, or a long press anywhere).
// The fine print (follow the NWS, Experimental, how accurate, credits) is behind the card's "?"; city names keep out from under the controls.
// Nothing runs by itself: the radar loads when the screen opens, a nowcast runs when the person asks (through the app's job queue).
import { createMap, paint, paintHatchSwatch } from './map.js';
import { decodeLines } from './lines.js';
import { createRadar } from './radar.js';
import { createNws, NWS_LINE, OFFICIAL } from './nws.js';
import { codeLut, chanceLut, levelOf, typeCode, typeLut } from './colors.js';   // v018: the key's colours come through legend.js
import { whereOf } from './stormscope/alerts.js';
import { creditsNode } from './credits.js';   // licences and credits (Nov-05)
import { BASEMAPS } from './basemaps.js';   // Wallowa Weather
import { PARCELS_MIN_Z } from './parcels.js';   // Wallowa Weather: lot lines
import { inPolys, LANDS_CREDIT, LANDS_NOTE } from './lands.js';   // v006: public land
import { ROADS_SOURCE, ROADS_CREDIT, ROADS_NOTE, ROADS_MIN_Z } from './roads.js';   // v006: roads
import { lotsSentence } from './lotcount.js';   // v006: the properties in an alert's zone
import { createGps } from './gps.js';   // v006: my location and the compass
import { countyPlan, createCountyMaps, savedLine, countyCache } from './offline.js';   // v007: the county map saved on this phone; v014: each kept county's
import { COUNTIES, countyAt, loadBoundaries } from './counties.js';   // v014: the app's counties (Wallowa first)
import { countyLayers, landsFor } from './county_layers.js';   // v014: the active county's own layers
import { boxProjection, inConus } from './regrid.js';
import { summaryAt, pixelOf, outlines, THRESHOLDS } from './run.js';
import { radarLine, radarAge, clockShort } from './summary.js';
import { recentRun, getRun } from './store.js';
import { icon, weatherIcon } from './icons.js';
import { DGMR } from './model.js';
import { SKILL } from './skill.js';
import { createClouds, shownWords, CLOUD_CREDIT, SAT_CREDIT } from './clouds.js';
import { postBox, ringsView, nwsWords, appWarningWords, publicPicture } from './post.js';   // v020: warnings shared as public posts
import { createBeamPlayer, HEADS, warnAreas } from './beam.js';   // v008: BEAM's example storms; v009: the same look live
import { createRainPlayer, fillExamplesSheet } from './examples.js';   // v012: DGMR / StormScope example storms
import { BIN_WORDS, HEAD_ORDER, LIST_HEADS, chanceAt, liveZones, unionBins, flagWords, liveGrid } from './beam_live.js';   // v009: BEAM live on this phone
import { MODELS } from './models_info.js';   // v008: the three models (what each does, strengths, weaknesses)
import { createModelPicker } from './modelpick.js';   // v008: the model chip above the card
import { createGearButton, buildSettings } from './settings.js';   // v008: Settings under a gear, apart from Layers
import { createFreshness } from './cadence.js';   // Nov-08: "Keep forecasts fresh" (Off / 10 / 30 / Wi-Fi 10, cellular 30), BEAM + the rain under it
import { createMine } from './mine.js';
import { presetLayers, presetMatching, presetHazards, presetRank, infoNode, createPresetPicker } from './presets.js';   // v008: General / Water / Fire / Farm
import { DRAINAGES_CREDIT } from './drainages.js';   // v008: HUC-12 drainages (water)
import { GAUGES_CREDIT, GAUGES_NOTE } from './gauges.js';   // v008: USGS stream gauges (water)
import { FIRES_CREDIT, FIRES_NOTE } from './fires.js';   // v008: current fires (fire)   // v008: My layers - shapes and highlighted lots the person draws, on this phone only   // v008: the properties in a warning, a list that slides in from the right
import { createLegend, rainSpec, snowSpec, chanceSpec, beamSpec, fieldSpec } from './legend.js';   // v018: the key across the top (full-width bars, units first)
import { createTimeBar, mergeField, whenWords } from './timebar.js';   // v018: the time bar, a pill of its own
import { buildLayersPanel, liveMaps, forecastMaps, mapIcon } from './layerspanel.js';   // v018: Layers: Weather now, Forecasts, Map details
import { createFold } from './cardfold.js';   // v018: the card folds to one line above the time bar
import { createExampleBody, exampleTime } from './exampleui.js';   // v018 examples: an example storm on the live map's own time bar and card
import { FIELDS, createFields } from './fields/index.js';
import { hourBytes, mb } from './fields/budget.js';   // v018 merge: each forecast map's data, for its Layers line

// its own settings key (a test server shares one web origin between apps)
const LS_KEY = 'wallowa-weather:view';
const lsGet = () => { try { return JSON.parse(localStorage.getItem(LS_KEY) || '{}') || {}; } catch (e) { return {}; } };
const lsSet = (v) => { try { localStorage.setItem(LS_KEY, JSON.stringify(Object.assign(lsGet(), v))); } catch (e) { /* private mode */ } };
// a saved name counts only as a table's own key: a plain object answers 'toString', '__proto__' ... from Object.prototype (a tampered or
// shared-origin value then stopped the view at its first render)
const own = (o, k) => typeof k === 'string' && Object.prototype.hasOwnProperty.call(o, k);
const mk = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
const btn = (cls, label, ic) => { const b = mk('button', cls); b.type = 'button'; if (ic) b.append(icon(ic)); if (label) b.append(mk('span', null, label)); return b; };
const MB = (b) => `${(b / 1e6).toFixed(b >= 1e7 ? 0 : 1)} MB`;
const clock = (t) => { try { return new Date(t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }); } catch (e) { return new Date(t).toISOString().slice(11, 16); } };
const dark = () => { try { return matchMedia('(prefers-color-scheme: dark)').matches; } catch (e) { return true; } };
const reduced = () => { try { return matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (e) { return false; } };
const DATA_LINES = new URL('./data/us_lines.bin', import.meta.url).href;
export const ATTRIB = 'Radar: NOAA MRMS · Basemap: NASA GIBS · Places: US Census · Nowcast: DeepMind DGMR (CC BY 4.0), modified';
const attribOf = (on) => (on ? ATTRIB.replace(' · Places', ` · ${CLOUD_CREDIT} · Places`) : ATTRIB);

/** app: { root, ready(), sizeOf(), download(), dl(), run({lat, lon, label, wide, members}, onProgress) -> Promise<run id>, geo(),
 *  position(), searchPlaces(geo, q, n), toast, diag, home() } -> { open(o), close(), shown } */
export function createNowcastView(app) {
  const root = app.root; root.classList.add('nc'); root.textContent = '';
  const radar = app.radar || createRadar({ diag: app.diag }), nws = createNws();
  const S = { place: null, av: null, plan: null, frames: new Map(), idx: -1, items: [], playing: false, timer: 0, run: null, running: null, open: false,
    // v019: offline (Wallowa's saved map) starts off - saved only when chosen; an older phone's is kept (keptKnown, below)
    layers: Object.assign({ radar: true, nowcast: true, type: true, warnings: true, clouds: false, parcels: false, roads: true, lands: true, gps: false, offline: false, drainages: false, gauges: false, fires: false, firewx: false, lightning: false, beamHail: false, beamLightning: false, beamRain: false, fan: false }, lsGet().layers || {}, { radar: true }), mode: lsGet().mode || 'rate', thr: lsGet().thr || 4,
    // v018 review: a saved choice that is not one of the app's (tampered, or another app on the same origin) falls back to the default
    members: [1, 4, DGMR.ensemble.members].includes(lsGet().members) ? lsGet().members : DGMR.ensemble.members, wide: !!lsGet().wide,
    loopMin: [30, 60, 90].includes(lsGet().loopMin) ? lsGet().loopMin : 60, model: lsGet().model || app.defaultModel || 'dgmr', basemap: (own(BASEMAPS, lsGet().basemap) && lsGet().basemap) || app.defaultBasemap || null, ssFresh: lsGet().ssFresh !== false, ssStat: null, warnings: [], alerts: [], places: null, loadedAt: 0, err: null };
  S.preset = lsGet().preset || null;   // v008: the last preset picked (Water, Fire, Farm, General)
  S.keep = lsGet().keep || {};   // v014: the other counties whose maps are kept on this phone ({ lane: true }); Wallowa's is layers.offline
  let keptAsking = false;   // v019: true while the view looks for an older phone's saved map (keptKnown, with the county maps below)
  // v018: the forecast map, one at a time ('precip' = the model's nowcast, then the field's hours; or a FIELDS id) and whether it is on
  // (the quick button); a v017 phone keeps what it had (Precipitation, on as its Nowcast switch was). The card folded or not, the
  // satellite's look, the radar loop's quality marks (the key explains the hatching while the loop has any), an example storm open
  { const v = lsGet(), known = (id) => id === 'precip' || FIELDS.some((f) => f.id === id);
    S.fmap = known(v.fmap) ? v.fmap : 'precip'; S.fmapOn = S.fmap === 'precip' ? !!S.layers.nowcast : v.fmapOn !== false;
    if (S.fmap !== 'precip' && S.fmapOn) S.layers.nowcast = false;
    S.cardOpen = !!v.cardOpen; S.satMode = v.satMode === 'full' ? 'full' : 'overlay'; S.qcSeen = { low: false, speck: false }; S.example = null; }
  // v009: BEAM live: the newest run's maps (beam_live.js liveFrame) and its flags, the hazard shown, keep it fresh, the run going
  const B = app.beam || null;
  const BL = { frame: null, info: null, head: own(HEADS, lsGet().beamHead) ? lsGet().beamHead : presetHazards(S.preset || 'general')[0], run: null, err: null,
    timer: 0, seq: 0, tries: 0, next: null, manual: false, zkey: '', zones: [], rainDue: false };
  // Nov-08: how often BEAM refreshes by itself (the old beamAuto switch migrates: on = every 10 min); onFresh is below with scheduleBeam
  const fresh = createFreshness({ get: lsGet, set: lsSet, onChange: (why) => onFresh(why) });
  const LUT = codeLut(), CLUT = chanceLut(), TLUT = typeLut();   // TLUT: PILOT, StormScope frames with what falls
  // v018 fix: the satellite picture on screen can lag its frame (the next one still coming, or an earlier image GIBS has whole): the
  // time bar says the picture drawn, again whenever it changes
  const clouds = createClouds({ onTile: () => map.draw(), onShown: () => { if (S.cloud) renderTl(); } });
  let leaving = false; addEventListener('pagehide', () => { leaving = true; if (radar.abort) radar.abort(); });   // a reload or a closed page: its fetches stop, and are not failures
  // ---------------------------------------------------------------------------------------------- the DOM
  const canvas = mk('canvas', 'nc-map'); canvas.setAttribute('aria-label', 'Rain map');
  const top = mk('div', 'nc-top'), back = btn('nc-round nc-back', null, 'back'); back.setAttribute('aria-label', 'Home Screen');
  // v018: the key across the top, gutter to gutter (legend.js): Rain and Snow always, the active model's key under them (v010), the forecast map's bar
  const LG = createLegend({ dark }), legend = LG.el;
  top.append(legend);
  const left = mk('div', 'nc-side nc-left'), layersB = btn('nc-round', null, 'layers'); layersB.setAttribute('aria-label', 'Layers'); left.append(back, layersB);
  const gearB = createGearButton({ onClick: () => openSettings() }); left.append(gearB);   // v008: settings are not layers
  const right = mk('div', 'nc-side nc-right'), searchB = btn('nc-round', null, 'search'), locB = btn('nc-round', null, 'locate');
  searchB.setAttribute('aria-label', 'Search for a place'); locB.setAttribute('aria-label', 'Show my location'); right.append(searchB, locB);
  const card = mk('div', 'nc-card'), warn = mk('button', 'nc-warn'); warn.type = 'button'; warn.hidden = true;
  const head = mk('div', 'nc-head'), placeEl = mk('span', 'nc-place'), radarEl = mk('button', 'nc-radar'); radarEl.type = 'button';
  const infoB = mk('button', 'nc-info', '?'); infoB.type = 'button'; infoB.setAttribute('aria-label', 'About this map: warnings, accuracy and credits');
  // v018 examples: an example storm's own close button (its card is the live card, holding the example)
  const exX = btn('nc-round nc-ex-x', null, 'close'); exX.setAttribute('aria-label', 'Close the example'); exX.hidden = true;
  head.append(radarEl, infoB, exX);
  const body = mk('div', 'nc-body'), sumEl = mk('p', 'nc-sum'), noteEl = mk('p', 'nc-note footnote'), action = mk('div', 'nc-action'), cardProg = mk('i', 'nc-card-prog');
  body.append(sumEl, noteEl, action); cardProg.hidden = true;
  card.append(warn, head, body, cardProg);   // the NWS warning stays above the fold: it never folds away
  const fold = createFold({ card, head, body, place: placeEl, open: S.cardOpen, onToggle: (o) => { if (!S.example) { S.cardOpen = o; lsSet({ cardOpen: o }); } placeDock(); } });
  // v018: the time bar (timebar.js): play, the time and what the frame is, the ticks, back to now
  // v018 examples: while an example storm is open, the same bar runs the example's frames (its "now": the forecast's moment)
  const TB = createTimeBar({ onSeek: (i, drag) => { stop(); if (S.example) exSeek(i); else show(i, { lazy: !!drag }); },
    onStep: (d) => { stop(); if (S.example) { const u = exUi(); if (u) exSeek(u.i + d); } else show(S.idx + d); }, onPlay: () => togglePlay(),
    onNow: () => { stop(); if (S.example) { const u = exUi(); if (u) exSeek(u.moment); return; } const ni = nowIndex(); if (ni >= 0) show(ni); } });
  const track = TB.track;
  // v018: the forecast map's quick button (its icon, on / off), across from the model chip above the card
  const fab = btn('nc-round nc-fab', null, 'precip'); fab.addEventListener('click', () => quickMap());
  const sheet = mk('div', 'nc-sheet'), sheetBox = mk('div', 'nc-sheet-box'), sheetBody = mk('div', 'nc-sheet-body'), sheetX = btn('nc-round nc-sheet-x', null, 'close');
  sheetX.setAttribute('aria-label', 'Close'); sheet.hidden = true; sheetBox.append(sheetX, sheetBody); sheet.append(sheetBox);
  // v008: the model picker, bottom-left just above the card; the sheet (z 3) covers it
  const picker = createModelPicker({ models: MODELS, current: lsGet().model || app.defaultModel || 'dgmr',
    statusOf: (id) => (app.settings && app.settings.models[id] ? app.settings.models[id].status() : {}),
    onPick: (id) => { pickModel(id); }, onAbout: (id) => openSettings('model:' + id) });
  const mpDock = mk('div', 'mp-dock'); mpDock.append(picker.el);
  root.append(canvas, top, left, right, mpDock, fab, card, TB.el, sheet);

  const BM = () => (S.basemap && BASEMAPS[S.basemap]) || null;   // Wallowa Weather: a basemap stack (null = the NASA GIBS map)
  let parcels = null;   // Wallowa Weather: the county's lot lines (made just below, once the map is)
  const map = createMap(canvas, { sources: BM() ? BM().sources : null, maxZoom: BM() ? 19 : 11, dark, onTap: (e) => openForecast({ lat: e.lat, lon: e.lon, label: `${e.name}, ${e.st}` }), onTapEmpty: lotTap, onLongPress: (lat, lon) => openForecast({ lat, lon, label: null }), onMove: (m) => { moved(m); creditLine(); if (parcels && S.layers.parcels) parcels.update(m.view, m.z); }, avoid: controlBoxes });
  const mine = createMine({ map, root, canvas, toast: app.toast, closeHost: () => closeSheet() });   // v008
  // v014: the active county (counties.js): the one the place shown is in, else the one my location is in, else Wallowa. Its own layers
  // (county_layers.js) follow it: lot lines, lot counts, the property list, drainages, gauges, fires, fire weather, public land
  const CTY = app.area ? app.area.counties || COUNTIES : null;
  const cAt = (lat, lon) => (!CTY ? null : app.area.countyAt ? app.area.countyAt(lat, lon) : countyAt(lat, lon, CTY));
  let county = null, CL = null, lotCounter = null, affected = null;
  // v008: the water / fire / farm layers (each fetches only while its switch is on); v014: the active county's
  let drains = null, gaugesL = null, firesL = null, fwx = null, lands = null;
  function activeCounty() {
    if (!CTY) return null;
    const p = S.place || lsGet().place, f = S.fix || S.pos;
    return (p && cAt(p.lat, p.lon)) || (f && cAt(f.lat, f.lon)) || CTY[0];
  }
  function pointAt(c) {   // the county's layers: at start, and again when the active county changes
    if (CL) { CL.destroy(); map.set('parcels', []); map.set('lot', null); map.set('lands', []); }
    county = c; BL.zkey = '';
    CL = countyLayers(c, { map, nws, basemap: !!BM(), places: () => S.places, onParcels: () => { if (parcels && S.layers.parcels) map.set('parcels', parcels.lots()); },
      onLot: (l) => { if (l.lat != null) map.center(l.lat, l.lon, Math.max(map.state.z, 16)); } });
    ({ parcels, drains, gauges: gaugesL, fires: firesL, fwx, lands, lots: lotCounter, affected } = CL);
    if (affected) { right.append(affected.button); root.append(affected.panel); }   // v008: under Locate; the panel slides in from the right
  }
  if (CTY) pointAt(activeCounty());
  /** v014: the place (or my location) is in another county: its layers replace the last one's -> true if it changed */
  function syncCounty() {
    const c = activeCounty(); if (!c || c === county) return false;
    pointAt(c); v008On(); parcelsOn(); landsOn(); beamDrains(); syncAffected();
    if (app.diag) app.diag('county', { id: c.id });
    return true;
  }
  if (CTY) loadBoundaries({ list: CTY }).then(() => { if (syncCounty() && S.open) render(); });   // the outlines tell apart counties whose boxes overlap
  const lotsText = (r) => (CL ? CL.words.lots(r) : lotsSentence(r));
  function v008On() { if (drains) drains.on(!!S.layers.drainages); if (gaugesL) gaugesL.on(!!S.layers.gauges); if (firesL) firesL.on(!!S.layers.fires); if (fwx) fwx.on(!!S.layers.firewx); }
  setTimeout(v008On, 0);
  function parcelsOn() { if (!parcels) return; if (S.layers.parcels) { const m = map.state; parcels.update(map.view(), m.z); map.set('parcels', parcels.lots()); } else { map.set('parcels', []); map.set('lot', null); } creditLine(); }
  // v006: public land, roads, my location, and the properties in an alert's zone (v014: the county's, above)
  function landsOn() { if (!lands) return; if (S.layers.lands) lands.load().then((a) => { if (S.layers.lands) { map.set('lands', a); creditLine(); } }); else { map.set('lands', []); creditLine(); } }
  function roadsOn() { if (!BM()) return; map.set('roads', S.layers.roads ? ROADS_SOURCE : null); creditLine(); }
  let gpsCentred = false;
  const gps = createGps({ onError: (t) => app.toast(t), onChange: (m) => {
    map.set('me', m); locB.classList.toggle('on', gps.on);
    S.fix = m ? { lat: m.lat, lon: m.lon } : null; if (m && CTY && !(S.place && cAt(S.place.lat, S.place.lon))) syncCounty();   // v014
    if (!m && !gps.on && S.layers.gps) { S.layers.gps = false; saveLayers(); }   // location refused: the switch goes back off
    if (m && !gpsCentred) { gpsCentred = true; map.center(m.lat, m.lon, Math.max(map.state.z, 12)); }
  } });
  function gpsOn(fromTap) { if (S.layers.gps) { gpsCentred = false; gps.start(); if (fromTap) gps.askCompass(); } else gps.stop(); locB.classList.toggle('on', !!S.layers.gps); }
  // v007: the county map saved on this phone (it loads quickly)
  const busyNow = () => !!S.running || !!BL.run || !!(app.dl && app.dl() && app.dl().running) || !!(app.ssDl && app.ssDl() && app.ssDl().running) || !!(B && B.dl() && B.dl().running);
  // v014: every county kept (Settings › Counties; the Layers switch is the active county's), saved one at a time, Wallowa first
  let sheetOffline = null, mapsOn = false;   // sheetOffline: the Layers sheet's status line while it is open
  const keptOf = (id) => { const c = CTY && CTY.find((x) => x.id === id); return !!c && (c === CTY[0] ? !!S.layers.offline : S.keep[id] != null ? !!S.keep[id] : !!c.savedByDefault); };
  const maps = CTY && BM() && globalThis.caches ? createCountyMaps({ counties: CTY, kept: keptOf, isBusy: busyNow,
    paused: lsGet().mapPaused === true ? [CTY[0].id] : [],   // v019: Download all's Cancel holds across opens, until the person asks again
    planOf: async (c) => {   // the county's tiles, with topo close-ups of its wilderness (its public land file)
      const L = landsFor(c);
      const wild = L ? (await L.load()).filter((a) => a.kind === 'wild').flatMap((a) => a.polys) : [];
      return countyPlan({ bbox: c.bbox, home: c.home, wild });
    },
    onChange: (id) => { if (sheetOffline && county && id === county.id) sheetOffline.textContent = offlineLine(); if (settingsCtl) settingsCtl.refresh(); } }) : null;
  // v019 (Josh, Nov-09-2026: "County map download should be lumped with model downloads"): a new phone saves Wallowa's map only when the
  // person chooses it (its switch, or Download all). A phone that keeps it keeps it: its saved switch, else the saved map v007-v018 made
  // by themselves - looked for before any sync, since a sync deletes the map of a county not kept
  keptAsking = !!maps && !(lsGet().layers && typeof lsGet().layers.offline === 'boolean');
  S.layers.offline = S.layers.offline === true;   // a saved value that is not true or false counts as no choice
  const keptKnown = !keptAsking ? Promise.resolve() : Promise.resolve().then(() => globalThis.caches.has(countyCache(CTY[0].id, CTY[0].id))).catch(() => false)
    .then((had) => { if (!keptAsking) return; keptAsking = false; if (had) { S.layers.offline = true; saveLayers(); } });   // a choice made meanwhile wins
  const syncMaps = () => keptKnown.then(() => maps.sync());
  const offlineLine = () => savedLine(maps && county ? maps.status(county.id) : null, !!county && keptOf(county.id));
  function offlineOn() { if (maps) { mapsOn = true; syncMaps(); } }
  function setKept(id, v) {
    if (!CTY) return;
    if (id === CTY[0].id) { keptAsking = false; S.layers.offline = !!v; if (lsGet().mapPaused) lsSet({ mapPaused: false }); } else S.keep = Object.assign({}, S.keep, { [id]: !!v });
    if (maps) maps.resume(id);   // v019: a choice ends a pause (Download all's Cancel)
    saveLayers(); offlineOn();
    if (sheetOffline) sheetOffline.textContent = offlineLine();
  }
  /** v019: a county's saved map's size, MB: its plan's once made, else offline.js's estimate (= the plan with the wilderness) */
  const mapMb = (id) => { const st = maps.status(id); return st ? st.totalMb : maps.estimateMb(id); };
  /** v019: the app's own county's map as Download all lists it (dlall.js models() shape) */
  function mapItem() {
    const c = CTY[0], st = keptOf(c.id) ? maps.status(c.id) : null;
    return { id: 'map', name: `${c.short} map`, short: 'Satellite, roads and topo, for when there’s no signal', bytes: mapMb(c.id) * 1e6,
      have: st ? maps.savedMb(c.id) * 1e6 : 0, ready: !!(st && st.done), downloading: !!(st && st.running && !st.paused), pct: st && st.total ? (st.have + st.missing) / st.total : 0 };
  }
  /** v019: Download all's turn for the map: its switch on, then its save -> resolves when that save ends (done, or out of tries), or at
   *  Cancel: the save pauses there - what came in stays, the switch stays on, nothing starts it again (this session or the next open)
   *  until the person does: Download all again, or its switch */
  function downloadMap({ signal } = {}) {
    const id = CTY[0].id;
    if (signal && signal.aborted) return Promise.resolve();
    const end = maps.settled(id);   // asked before the sync that starts it
    setKept(id, true);
    return new Promise((res) => {
      end.then(res);
      if (signal) signal.addEventListener('abort', () => { maps.pause(id); lsSet({ mapPaused: true }); res(); }, { once: true });
    });
  }
  /** v014: Settings › Counties: each county, its saved map's state, its switch */
  const countyHooks = () => (!maps ? null : {
    list: () => CTY.map((c) => {
      const kept = keptOf(c.id), st = maps.status(c.id);
      return { id: c.id, name: c.name, short: c.short, kept, done: !!(st && st.done), savedMb: maps.savedMb(c.id),
        line: kept ? savedLine(st, true) : `Not on this phone. Keeping it saves about ${maps.estimateMb(c.id)} MB.`,
        frac: st && st.running && !st.paused && st.total ? (st.have + st.missing) / st.total : null };
    }),
    set: (id, v) => setKept(id, v), busy: () => maps.busy() });
  /** v007: how far (screen px) a point is from my location's dot at zoom z */
  const pxFromMe = (f, lat, lon, z) => {
    const k = Math.cos(f.lat * Math.PI / 180), mpp = 156543.03 * k / 2 ** z;
    return Math.hypot((lon - f.lon) * 111320 * k, (lat - f.lat) * 110540) / mpp;
  };
  const compass8 = (deg) => ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'][Math.round((((deg % 360) + 360) % 360) / 45) % 8];
  const dm = (v, pos, neg) => { const a = Math.abs(v), d = Math.floor(a); return `${d}° ${((a - d) * 60).toFixed(3)}′ ${v >= 0 ? pos : neg}`; };
  const ft = (m) => Math.round(m * 3.281).toLocaleString();
  /** v007: where you are, in words (people in the wilderness with no service still see where exactly they are) */
  function whereWords(f) {
    const g = lands ? lands.at(f.lat, f.lon) : null;
    let town = '', bd = Infinity, best = null; const k = Math.cos(f.lat * Math.PI / 180);
    for (const e of S.places || []) { const d = (e.lat - f.lat) ** 2 + ((e.lon - f.lon) * k) ** 2; if (d < bd) { bd = d; best = e; } }
    if (best && Math.sqrt(bd) * 111.2 < 80) {
      const deg = Math.atan2((f.lon - best.lon) * k, f.lat - best.lat) * 180 / Math.PI;
      town = `${(Math.sqrt(bd) * 111.2 / 1.609).toFixed(1)} mi ${compass8(deg)} of ${best.name}, ${best.st}`;
    }
    return {
      coords: `${f.lat.toFixed(5)}, ${f.lon.toFixed(5)}`,
      dmLine: `${dm(f.lat, 'N', 'S')}, ${dm(f.lon, 'E', 'W')}`,
      acc: f.acc != null ? `Accurate to about ${ft(f.acc)} ft (${Math.round(f.acc)} m)` : '',
      elev: f.alt != null && isFinite(f.alt) ? `Elevation about ${ft(f.alt)} ft${f.altAcc ? ` (±${ft(f.altAcc)} ft)` : ''}` : '',
      land: g ? `${g.kind === 'wild' && g.name ? `In the ${g.name}` : `On ${g.label}`} (${g.who})` : '',
      town,
      heading: f.heading != null ? `Phone pointing ${compass8(f.heading)} (${Math.round(f.heading)}°)` : '',
      time: f.t ? `As of ${clock(f.t)}` : '',
    };
  }
  function openWhere() {
    const f = gps.fix; if (!f) return;
    const w = whereWords(f);
    const text = [`My location: ${w.coords}`, w.acc, w.elev, w.land, w.town, w.time].filter(Boolean).join('. ') +
      `. Map: https://maps.google.com/?q=${f.lat.toFixed(5)},${f.lon.toFixed(5)}`;
    openSheet((b) => {
      b.append(mk('h2', 'nc-h', 'Where you are'));
      b.append(mk('p', 'nc-where', w.coords));
      b.append(mk('p', 'footnote', w.dmLine));
      for (const t of [w.acc, w.elev, w.land, w.town, w.heading, w.time]) if (t) b.append(mk('p', null, t));
      const row = mk('div', 'nc-where-btns'), sb = btn('nc-btn', 'Share my location'), cb = btn('nc-btn ghost', 'Copy');
      const copy = (el) => navigator.clipboard.writeText(text).then(() => { el.textContent = 'Copied'; }).catch(() => {});
      sb.addEventListener('click', () => { if (navigator.share) navigator.share({ title: 'My location', text }).catch(() => {}); else copy(sb); });
      cb.addEventListener('click', () => copy(cb));
      row.append(sb, cb); b.append(row);
      b.append(mk('p', 'footnote', 'Your position comes straight from GPS satellites, so it works with no cell service. Away from service the first fix can take a minute or two; open sky helps. Nothing is sent unless you share it.'));
      b.append(mk('p', 'footnote', 'With no service, Share works only where your phone can text by satellite. In an emergency, call or text 911: many newer phones can reach 911 by satellite where there’s no service.'));
    });
  }
  /** v006: a tap on the map: an app alert's zone first (a tap inside a warning
   *  says what the warning is), then a lot (lines on, zoom 12+), then public land */
  function lotTap(lat, lon, z) {
    if (gps.fix && pxFromMe(gps.fix, lat, lon, z) < 28) { openWhere(); return; }   // v007: a tap on my location's dot
    const info = (i) => { if (!i) return false; openSheet((b) => b.append(infoNode(i))); return true; };   // v008: the water / fire sheets
    if (gaugesL && info(gaugesL.at(lat, lon))) return;
    if (firesL && info(firesL.at(lat, lon, { areas: false }))) return;
    const hits = S.layers.nowcast && S.run && S.run.ss ? (S.run.ss.alerts || []).filter((a) => a.rings && inPolys([a.rings], lon, lat)) : [];
    if (hits.length) { openAlerts(hits); return; }
    const bt = beamTapArea(lat, lon); if (bt) { openBeamWarning(bt, lat, lon); return; }   // v013: a live BEAM warning outline
    if (mine.tap(lat, lon, z)) return;   // v008: one of my own shapes or pins (alerts win over a big drawn area)
    const dr = drains && S.layers.drainages ? drains.at(lat, lon) : null;
    if (dr && dr.flag && info(dr)) return;
    if (fwx && info(fwx.at(lat, lon))) return;
    if (firesL && info(firesL.at(lat, lon, { pins: false }))) return;
    if (parcels && S.layers.parcels && z >= PARCELS_MIN_Z) {
      const l = parcels.at(lat, lon); map.set('lot', l || null);
      if (l) {
        openSheet((b) => {
          b.append(mk('h2', 'nc-h', l.lot ? `Tax lot ${l.lot}` : 'Tax lot'));
          b.append(mk('p', null, CL.words.owner));
          if (l.lot) b.append(mk('p', 'footnote', 'The lot’s number on its county tax map.'));
          if (z >= 14) { const hb = btn('nc-btn', 'Highlight this lot'); hb.onclick = () => { closeSheet(); mine.highlightLot(l); }; b.append(hb); }   // v008: name it, pick a colour (close in: the outline is full detail)
          b.append(mk('p', 'footnote dim', CL.words.note));
        });
        return;
      }
    }
    if (dr && info(dr)) return;   // v008: a drainage (layer on), before public land
    if (lands && S.layers.lands) {
      const g = lands.at(lat, lon); if (!g) return;
      openSheet((b) => {
        b.append(mk('h2', 'nc-h', g.kind === 'wild' && g.name ? g.name : g.label));
        b.append(mk('p', null, `Public land · managed by the ${g.who}`));
        b.append(mk('p', 'footnote dim', LANDS_NOTE));
      });
    }
  }
  /** v006: an app alert in words, as on the card: what, where from here, when */
  function alertText(a, p) {
    const where = whereOf(a, p.lat, p.lon);
    if (a.level === 'red') return `Damaging storm · ${where} · within ${a.startMin} min`;
    if (a.level === 'yellow' && a.startMin != null) return `Storm on the way · ${where} · could reach here in about ${a.startMin} min (around ${clock(S.run.t0 + a.startMin * 60e3)})`;
    if (a.level === 'yellow') { const dirs = ['N','NE','E','SE','S','SW','W','NW']; return `Storm on the way · ${where} · moving ${dirs[Math.round(a.bearing / 45) % 8]} at ${a.speedKmh} km/h`; }
    return `${a.label} · ${where} · ${a.startMin === a.endMin ? `in about ${a.startMin} min` : `${a.startMin}–${a.endMin} min`}`;
  }
  const sentence = (t) => { t = String(t || '').trim(); return t ? t.charAt(0).toUpperCase() + t.slice(1) + (/[.!?]$/.test(t) ? '' : '.') : ''; };
  /** v020: a warning as a public post (post.js): its words, and a picture framing the warning's area - no GPS dot, no place mark */
  function warnPost({ words, rings, title, sub, name }) {
    const r = canvas.getBoundingClientRect();
    const box = postBox({ words, toast: app.toast, title: 'Share this warning',
      note: 'Anyone can read a public post. The picture shows the warning\u2019s area, with no GPS dot and no place mark. Facebook takes no words from apps: they are copied for you to paste.',
      picture: async () => publicPicture(await map.snapshotAt(ringsView(rings, { w: r.width || 390, h: r.height || 844 }), { here: false }), { title, sub, name }) });
    return box.el;
  }
  function shareAlert(sb, text) {
    const t = `${text} App alert from Wallowa Weather (experimental, not an NWS warning).`;
    if (navigator.share) navigator.share({ title: 'Wallowa Weather', text: t }).catch(() => {}); else navigator.clipboard.writeText(t).then(() => { sb.textContent = 'Copied'; }).catch(() => {});
  }
  // v013 (a tap on a live BEAM warning outline opened nothing): the area under the tap, for the half-hour and hazard shown, and its sheet
  const BEAM_WARN_WORDS = { hail: 'Hail possible', core: 'Strong storm core possible', lightning: 'Lightning likely', rain: 'Cloudburst possible' };
  /** "about 9 mi east of Imnaha" (the nearest town, however far), or the coordinates when no towns are loaded */
  function fromTown(lat, lon) {
    let best = null, bd = Infinity; const kx = Math.cos(lat * Math.PI / 180);
    for (const e of S.places || []) { const d = (e.lat - lat) ** 2 + ((e.lon - lon) * kx) ** 2; if (d < bd) { bd = d; best = e; } }
    if (!best) return `at ${lat.toFixed(2)}, ${lon.toFixed(2)}`;
    const mi = Math.sqrt(bd) * 111.2 / 1.609, dirs = ['north', 'northeast', 'east', 'southeast', 'south', 'southwest', 'west', 'northwest'];
    if (mi < 2) return `at ${best.name}, ${best.st}`;
    const deg = (Math.atan2((lon - best.lon) * kx, lat - best.lat) * 180 / Math.PI + 360) % 360;
    return `about ${Math.round(mi)} mi ${dirs[Math.round(deg / 45) % 8]} of ${best.name}, ${best.st}`;
  }
  function beamTapArea(lat, lon) {
    const k = beamK(S.items[S.idx]), f = BL.frame;
    if (k == null || !f || beam.active || !beam.layers.live || !beamFresh()) return null;
    const a = beam.layers.areas().find((x) => x.ring && inPolys([[x.ring]], lon, lat));
    return a ? { area: a, k, head: BL.head, frame: f } : null;
  }
  function openBeamWarning({ area, k, head, frame }, lat, lon) {
    const H = HEADS[head], label = `${BEAM_WARN_WORDS[head] || H.label} (BEAM)`, c = chanceAt(frame, lat, lon), pct = (v) => `${Math.round(v * 100)} %`;
    const to = frame.issue + (k + 1) * 30 * 60e3, ctr = area.ring.reduce((m, q) => [m[0] + q[0] / area.ring.length, m[1] + q[1] / area.ring.length], [0, 0]);
    const recal = head === 'hail' && frame.recal;
    const what = `Inside this line BEAM’s chance of ${headWord(head)} reached its warning level${recal ? '' : ` (${pct(H.warn)})`} for ${BIN_WORDS[k]}, until about ${clock(to)}.`;
    const here = c ? `Here: ${pct(c[head].bins[k])} chance${recal ? ' (the chance hail really came, from BEAM’s blind tests)' : ''}.` : '';
    const where = `The area’s middle is ${fromTown(ctr[1], ctr[0])}; BEAM ran on the ${clock(frame.t0)} radar.`;
    openSheet((b) => {
      b.append(mk('p', 'nc-sub', 'BEAM warning · experimental, not from the NWS'));
      const h = mk('h2', 'nc-h nc-alert-h', label); h.style.setProperty('--wc', H.edge); b.append(h);
      for (const t of [what, here, where]) if (t) b.append(mk('p', null, t));
      const lots = mk('p', null, 'Counting the properties in this area…'); let lotsTxt = '';
      if (lotCounter) { b.append(lots); lotCounter.count(area.ring).then((r) => { lotsTxt = lotsText(r); lots.textContent = lotsTxt; }); }
      b.append(warnPost({ words: () => appWarningWords({ label, what, where }), rings: [area.ring], title: `${label} · until about ${clock(to)}`, sub: 'BEAM, Wallowa Weather · Experimental, not an official warning', name: 'beam-warning' }));
      b.append(mk('p', 'footnote', `BEAM, made for this app, worked this out on this phone. ${OFFICIAL}`));
    });
  }
  /** v006: the text block for app alerts: what it is, what it means, where and when, how many properties are in its zone, Share */
  function openAlerts(list) {
    const p = S.place;
    openSheet((b) => {
      b.append(mk('p', 'nc-sub', 'App alert · experimental, not from the NWS'));
      for (const a of list) {
        const h = mk('h2', 'nc-h nc-alert-h', a.label); h.style.setProperty('--wc', a.color); b.append(h);
        const what = sentence(a.note); if (what) b.append(mk('p', null, what));
        const when = p ? sentence(alertText(a, p).split(' · ').slice(1).join(' · ')) : '';
        if (when) b.append(mk('p', null, when));
        const lots = mk('p', null, 'Counting the properties in this zone…'); let lotsTxt = '';
        if (lotCounter && a.rings) { b.append(lots); lotCounter.count(a.rings[0]).then((r) => { lotsTxt = lotsText(r); lots.textContent = lotsTxt; }); }
        if (a.rings) b.append(warnPost({ words: () => appWarningWords({ label: a.label, what }), rings: a.rings, title: a.label, sub: 'Wallowa Weather · Experimental, not an official warning', name: 'app-alert' }));
      }
      b.append(mk('p', 'footnote', OFFICIAL));
    });
  }
  // the credits of what is on screen, always visible (the sources' terms ask for it)
  // v008: the credits moved from the map's corner to the card's "?" (the credits live behind the ?;
  // no source's terms ask for an on-map credit). Kept as a no-op
  // so its callers stay; what is on screen is still listed, first, behind the "?".
  function creditLine() { /* v008: behind the ? */ }
  const onScreenCredits = () => { if (!BM()) return ''; const c = map.visibleSources().map((x) => x.credit).filter(Boolean); if (parcels && S.layers.parcels && map.state.z >= PARCELS_MIN_Z) c.push(CL.words.credit); if (S.layers.roads && map.state.z >= ROADS_MIN_Z) c.push(ROADS_CREDIT); if (lands && S.layers.lands) c.push(LANDS_CREDIT); if (S.layers.drainages) c.push(DRAINAGES_CREDIT); if (S.layers.gauges) c.push(GAUGES_CREDIT); if (S.layers.fires) c.push(FIRES_CREDIT);
    // v018 review: the satellite, the forecast map and the radar named only when they are on the map
    if (S.layers.clouds) c.push(S.satMode === 'full' ? SAT_CREDIT : CLOUD_CREDIT);
    { const fid = fieldId(), F = fid ? FIELDS.find((f) => f.id === fid) : null; if (F && F.credit) c.push(`Forecast: ${F.credit}`); }
    return [...new Set(c)].concat(S.layers.radar ? ['Radar: NOAA MRMS'] : []).join(' · '); };
  landsOn(); roadsOn();   // v006
  // v008: BEAM's recorded example storms: the player takes the card's place while one is open
  let beamZones = [];   // v008: an example storm's hail warning areas (BEAM), for the property list
  const beam = createBeamPlayer({ map, root, toast: app.toast, space: () => exSpace(), onChange: () => exChanged(), onExit: () => exampleOff(),   // v009: the live layer comes back; v018: and today's radar
    onAreas: (areas, head, frame) => {
      paintLegend();   // v010: the example's hazard in the top bar
      beamZones = head && head.label === 'Hail' && frame ? areas.slice(0, 6).map((a, i) => ({ id: `beam-hail-${frame.t}-${i}`, label: 'Hail possible (BEAM example)', color: '#C04CFF', level: 'red', rings: [a.ring], until: frame.issue + 90 * 60e3, source: 'beam' })) : [];
      if (drains) {   // Cloudburst: the drainages its warning areas reach (sampled: the outline's corners and middle)
        const flags = {};
        if (head && head.label === 'Cloudburst' && frame) for (const a of areas.slice(0, 12)) {
          const r = a.ring, mid = r.reduce((m, p) => [m[0] + p[0] / r.length, m[1] + p[1] / r.length], [0, 0]);
          for (const [lo, la] of r.concat([mid])) { const d = drains.at(la, lo); if (d && d.huc12) flags[d.huc12] = { level: 'warning', why: 'Cloudburst possible (BEAM example storm)', until: frame.issue + 90 * 60e3 }; }
        }
        drains.setFlags(flags);
      }
      syncAffected();
    } });
  // v012: DGMR / StormScope recorded example storms (examples.js); v018 examples: on the live map's own time bar and card, like BEAM's
  const rainEx = createRainPlayer({ map, root, toast: app.toast, space: () => exSpace(), onChange: () => exChanged(), onExit: () => exampleOff() });
  // v018 examples (Josh: the app must not switch look when people look at the example storms): the example's chips, switches, dots,
  // credits and fine print in the folding card (exampleui.js), its frames on the time bar; the top key explains its colours
  const exBody = createExampleBody({ onChip: (id) => { const P = exPlayer(); if (P) P.set(id); }, onSwitch: (id, on) => { const P = exPlayer(); if (P) P.set(id, on); } });
  const exPlayer = () => (S.example === 'beam' ? beam : S.example === 'rain' ? rainEx : null);
  const exUi = () => { const P = exPlayer(); return P && P.active ? P.ui() : null; };
  function exSeek(i) { const P = exPlayer(), u = exUi(); if (P && u) P.show(Math.max(0, Math.min(u.frames.length - 1, i))); }
  /** the map's free room for framing the example's storm: between the key and the card (folded, as it opens) */
  function exSpace() { const r = root.getBoundingClientRect(), lg = legend.getBoundingClientRect(), c = card.getBoundingClientRect(); return { w: r.width, h: r.height, top: Math.max(56, lg.bottom - r.top + 8), bottom: c.height ? r.bottom - c.top + 8 : 160 }; }
  /** the example's frame on the controls: the card's line and body, the time bar, the key */
  function exChanged() {
    const u = exUi(); if (!u) return;
    // the folded line: "Example" in bold (it always fits the place's 45 %), the model leading the sentence ("StormScope · Jul 31, 2025 · ...")
    placeEl.textContent = 'Example'; fold.setKey(u.model ? `${u.model} · ${u.title}` : u.title); exBody.update(u);
    TB.render(exampleTime(u)); TB.nowB.setAttribute('aria-label', u.momentWords || 'Back to the forecast’s moment');
    paintLegend();
  }
  /** the controls in the example's hands, or back in the live map's: the model chip, the quick map, the radar's age and "?" step aside;
   *  the card folds to one line as an example opens, and goes back to how it was when it closes */
  function exMode(on) {
    mpDock.hidden = on; fab.hidden = on; radarEl.hidden = on; infoB.hidden = on; exX.hidden = !on; card.classList.toggle('nc-ex', on);
    if (on) {
      exBody.reset(); body.replaceChildren(exBody.el); fold.set(false, false); placeEl.textContent = 'Example storm'; fold.setKey('Loading the example storm…');
      TB.render({ items: [], idx: -1, nowIdx: -1, day: '', time: '', tag: 'Loading the example storm…', tagClass: 'past' });
    } else { body.replaceChildren(sumEl, noteEl, action); fold.set(S.cardOpen, false); TB.nowB.setAttribute('aria-label', 'Back to now'); }
    placeDock();
  }
  exX.addEventListener('click', () => { const P = exPlayer(); if (P && P.active) P.close(); else exampleOff(); });
  /** v018 (BEAM's example storms drew over today's radar, nowcast, quality marks and clouds; the rain examples already cleared them): an
   *  example storm is the map's alone while it is open - today's layers and the forecast map go, nothing redraws them (show() waits, a moved
   *  map fetches no radar); v018 examples: the time bar and the card hold the example (exMode) - and all come back when it closes or cannot
   *  load */
  function exampleOn(kind) {
    closeSheet(); stop(); S.example = kind; beamLayerOff(); fields.show(null);
    map.set('rain', null); map.set('nowcast', null); map.set('clouds', null); map.set('qc', null); S.cloud = null;
    exMode(true);
  }
  function exampleOff() {
    if (!S.example) return;
    stop(); S.example = null; exMode(false); beamDrains();
    if (S.items[S.idx]) show(S.idx); else renderTl();
    render(); paintLegend();
    const m = map.state; moved({ lat: m.lat, lon: m.lon, z: m.z });   // the 1 km radar cut follows where the example left the map
  }
  /** an example's player opened: when it could not load (nothing open), today's map comes back at once */
  const exampleOpened = (pr, player) => Promise.resolve(pr).then((r) => { if (!player.active) exampleOff(); return r; }, (e) => { exampleOff(); throw e; });
  async function openModelExamples(model = S.model) {   // "See example storms": the examples of the model picked
    if (model === 'beam') return openBeamExamples();
    let list = []; try { list = await rainEx.index(model); } catch (e) { app.toast('The example storms could not be loaded.'); return; }
    openSheet((b) => fillExamplesSheet(b, model, list, (id) => { exampleOn('rain'); exampleOpened(rainEx.open(id), rainEx); }), 'beam');
  }
  const rainExBtn = () => { const e = btn('nc-btn ghost', 'See example storms'); e.onclick = () => openModelExamples(S.model); return e; };
  async function openBeamExamples() {
    let list = []; try { list = await beam.index(); } catch (e) { app.toast('The example storms could not be loaded.'); return; }
    openSheet((b) => {
      b.append(mk('h2', 'nc-h', 'BEAM · example storms'));
      b.append(mk('p', null, B ? 'What BEAM showed on real storms near Wallowa County: its chance of lightning, hail, cloudbursts and strong cores, and each storm’s cone - where its lightning was headed in the next 30, 60 and 90 minutes. (Live runs have no cones yet: a cone needs each storm tracked from run to run.)'
        : 'BEAM will run on this phone; until then, see what it showed on real storms near Wallowa County: its chance of lightning, hail, cloudbursts and strong cores, and each storm’s cone - where its lightning was headed in the next 30, 60 and 90 minutes.'));
      for (const e of list) { const r = btn('nc-res bm-ex', null); r.append(mk('b', null, e.title || e.date), mk('span', 'footnote', [e.when, e.motion].filter(Boolean).join(' · '))); r.onclick = () => { exampleOn('beam'); exampleOpened(beam.open(e.id, { head: presetHazards(S.preset || 'general')[0] }), beam); }; b.append(r); }
      b.append(mk('p', 'footnote', 'Examples, not a measure of accuracy: the Wallowa hailstorm for what happened on the ground, the others because the cone verified. Experimental, not a National Weather Service warning.'));   // v012: Bear Creek joined
    }, 'beam');
  }
  // v007: the county maps, after the first radar has come in; v019: only the ones kept carry on (none on a new phone), unless a switch or
  // Download all has synced them already
  setTimeout(() => { if (!mapsOn) offlineOn(); }, 15000);
  addEventListener('online', () => { if (mapsOn) syncMaps(); });   // back in service: save the rest (a paused one stays paused)
  if (S.layers.gps) { gpsOn(false); canvas.addEventListener('pointerdown', () => gps.askCompass(), { once: true }); }   // v006: the iPhone's compass needs a tap
  // city names and dots stay out from under the buttons, the legend and the card (their boxes in the map's own pixels, read each frame)
  function controlBoxes() {
    const c = canvas.getBoundingClientRect(), out = [];
    // v018 merge: the strip above the key is the phone's status bar (the clock, the notch): no city names under it
    { const lg = legend.getBoundingClientRect(); if (lg.height && lg.top > c.top) out.push({ x: 0, y: 0, w: c.width, h: lg.top - c.top }); }
    for (const el of [back, legend, layersB, gearB, searchB, locB, card, TB.el, fab, picker.chip, affected && affected.button, root.querySelector('.ww-foot'), ...root.querySelectorAll('.mn-bar')].filter(Boolean)) { const r = el.getBoundingClientRect(); if (r.width && r.height) out.push({ x: r.left - c.left, y: r.top - c.top, w: r.width, h: r.height }); }
    return out;
  }
  /** v018: the bottom stack, from the copyright bar up - the time bar, the card, the chip and the quick button - and the buttons under the
   *  key: each placed from the one below it (CSS vars), the unfolded card never taller than the room between the time bar and the buttons */
  const placeDock = () => {
    const r = root.getBoundingClientRect(), lg = legend.getBoundingClientRect(), tb = TB.el.getBoundingClientRect();
    if (lg.height) root.style.setProperty('--nc-lg-bottom', `${Math.round(lg.bottom - r.top + 10)}px`);   // v010: the round buttons sit under the key
    if (tb.height && !TB.el.hidden) {
      root.style.setProperty('--nc-tb-h', `${Math.round(tb.height)}px`);
      const side = Math.max(left.getBoundingClientRect().bottom, right.getBoundingClientRect().bottom) - r.top;
      root.style.setProperty('--nc-card-max', `${Math.max(96, Math.floor(tb.top - r.top - 8 - side - 10 - 44 - 8))}px`);   // the chip row's 44 px between
    }
    const c = card.getBoundingClientRect();
    if (c.height && !card.hidden) root.style.setProperty('--mp-bottom', `${Math.round(r.bottom - c.top + 8)}px`);
  };
  if (typeof ResizeObserver !== 'undefined') { const ro = new ResizeObserver(() => { placeDock(); LG.layout(); map.draw(); }); ro.observe(card); ro.observe(legend); ro.observe(TB.el); }
  // close in, away from the place: the 1 km crop follows the map's centre (the frames are read again from this page's copies)
  let moveT = 0;
  function moved(m) {
    if (!S.open || S.example || m.z < 6.8 || !S.cropBox) return;   // v018: an example storm open: today's radar is not fetched
    const b = S.cropBox, la1 = 54.995, lo1 = -129.995, r = (la1 - m.lat) / 0.01, c = (m.lon - lo1) / 0.01;
    if (r > b.r0 + 120 && r < b.r1 - 120 && c > b.c0 + 150 && c < b.c1 - 150) return;
    clearTimeout(moveT); moveT = setTimeout(() => { S.cropAt = { lat: map.state.lat, lon: map.state.lon }; loadRadar(false, true); }, 700);
  }
  /** v010 + v018: the key across the top - Rain (and Snow, with "Rain or snow" on) always, the active model's key under them, and the
   *  forecast map's own bar (a field other than precipitation: precipitation's hours are drawn in the rain's colours) */
  function paintLegend() {
    // v018 review: the key is what is on the map - no forecast bar while an example storm is open (its field is off); on a forecast
    // hour the model's bar is dimmed (its colours are not drawn there), not removed, so the key keeps one height while the loop plays
    const ex = !!(S.example || rainEx.active || beam.active), cur = S.items[S.idx], onField = !ex && !!cur && cur.kind === 'field';
    const f = ex ? null : fieldOn(), F = f ? fields.legend() || FIELDS.find((x) => x.id === f) : null;
    const mk0 = modelKey(), mkey = mk0 && onField ? Object.assign({}, mk0, { dim: true }) : mk0;
    LG.set([rainSpec(), S.layers.type ? snowSpec() : null, mkey, F ? fieldSpec(F) : null]);
    LG.qc(S.layers.radar ? S.qcSeen : {});
  }
  /** the active model's key: BEAM's hazard (live, or the example storm open), DGMR / StormScope's chance of rain; their average and
   *  one-future maps use the radar's own colours (Rain + Snow explain them), so they add no bar */
  function modelKey() {
    if (rainEx.active) { const u = rainEx.ui(); return u && u.chance ? chanceSpec(1, u.model) : null; }   // v018 examples: its chance view's key
    if (beam.active) { const h = beam.layers.state.head; return HEADS[h] ? beamSpec(h, { recal: false }) : null; }
    if (!S.layers.nowcast) return null;
    if (S.model === 'beam') return B ? beamSpec(BL.head, { recal: !!(BL.frame && BL.frame.recal) }) : null;
    if (S.mode !== 'chance') return null;
    return chanceSpec(S.thr, (MODELS.find((x) => x.id === S.model) || {}).name || 'Nowcast');
  }
  /** v018: the radar loop's quality marks, for the key: whether any frame of the loop has low-confidence radar or a lone speck (one answer
   *  for the whole loop, so the key never changes while it plays) */
  function qcOfLoop() {
    let low = false, speck = false;
    for (const f of S.frames.values()) {
      if (!f.qc) continue;
      if (f.qc.low && f.qc.lowN == null) { let n = 0; for (const v of f.qc.low) n += v; f.qc.lowN = n; }
      low = low || !!f.qc.lowN; speck = speck || !!(f.qc.speckle && f.qc.speckle.length);
    }
    S.qcSeen = { low, speck }; LG.qc(S.layers.radar ? S.qcSeen : {});
    if (low && LG.hatch.dataset.dk !== String(dark())) { paintHatchSwatch(LG.hatch, dark()); LG.hatch.dataset.dk = String(dark()); }
  }
  try { matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { LG.hatch.dataset.dk = ''; LG.refresh(); qcOfLoop(); map.draw(); }); } catch (e) { /* an old browser: the key keeps its first colours */ }

  // ---------------------------------------------------------------------------------------------- data
  async function loadStatic() {
    if (!map.get('lines')) { try { map.set('lines', decodeLines(await (await fetch(DATA_LINES)).arrayBuffer())); } catch (e) { app.diag('nowcast: lines', { message: String(e.message || e).slice(0, 80) }); } }
    if (!S.places) {
      try {
        const geo = await app.geo(); const all = [];
        for (const l of geo.places.values()) for (const e of l) if (e.st !== 'AK' && e.st !== 'HI' && e.st !== 'PR') all.push(e);
        S.places = all.sort((a, b) => b.w - a.w); S.geo = geo; map.set('places', S.places);
      } catch (e) { S.places = []; }
    }
  }
  async function where(o) {
    if (o && o.lat != null) return { lat: o.lat, lon: o.lon, label: o.label || 'This place' };
    const v = lsGet(); if (v.place && (!app.area || app.area.contains(v.place.lat, v.place.lon))) return v.place;
    if (app.area) {   // Wallowa Weather: the person's own location when it is in the county, else the town of Wallowa
      try { const p = await app.position(); if (p) S.pos = { lat: p.lat, lon: p.lon }; if (p && app.area.contains(p.lat, p.lon)) return { lat: p.lat, lon: p.lon, label: 'Your location' }; } catch (e) { /* */ }
      return app.area.home;
    }
    try { const p = await app.position(); if (p) return { lat: p.lat, lon: p.lon, label: 'Your location' }; } catch (e) { /* */ }
    return null;
  }
  const nearest = (lat, lon) => {
    let best = null, bd = Infinity; const kx = Math.cos(lat * Math.PI / 180);
    for (const e of S.places || []) { const d = (e.lat - lat) ** 2 + ((e.lon - lon) * kx) ** 2; if (d < bd) { bd = d; best = e; } }
    return best && Math.sqrt(bd) * 111 < 15 ? `near ${best.name}, ${best.st}` : `${lat.toFixed(2)}, ${lon.toFixed(2)}`;
  };
  async function loadRadar(fresh = false, recrop = false) {
    const now = Date.now();
    try {
      S.av = await radar.available(now, 110, { fresh: fresh || !S.av || now - (S.av.newest || 0) > 4 * 60e3 });
      S.err = null;
    } catch (e) {   // v007: with no signal, say so (the map and your location still work)
      S.err = navigator.onLine === false ? 'No signal: the radar comes back with one. The map and your location still work.' : 'NOAA radar could not be reached. Check the connection and try again.';
      render(); renderTl(); return;
    }
    S.plan = radar.loopPlan(S.av, { minutes: S.loopMin, step: 10, typed: S.layers.type });
    S.loadedAt = now; buildItems(); render();
    const crop = cropFor(S.cropAt || S.place); S.cropBox = crop;
    // v011 (the rain never blanks): frames from another crop stay until their replacement comes in (no blank map meanwhile)
    for (const t of S.plan.times.slice().reverse()) {   // the newest first: it shows at once
      if (S.frames.has(t) && S.frames.get(t).cropKey === (crop && crop.key)) continue;
      try { const f = await radar.frame(t, { typed: S.layers.type, flags: S.av.flag, crop, rqi: S.plan.rqi }); f.cropKey = crop && crop.key; S.frames.set(t, f); qcOfLoop(); }
      catch (e) { if (!leaving && !(e && (e.name === 'AbortError' || e.code === 'ABORTED'))) app.diag('nowcast: radar frame', { message: String(e.message || e).slice(0, 80) }); }
      if (!S.open) return;
      if (S.idx < 0 || S.items[S.idx] && S.items[S.idx].t === t) show(S.idx < 0 ? nowIndex() : S.idx); else renderTl();
    }
    for (const t of [...S.frames.keys()]) if (!S.plan.times.includes(t)) S.frames.delete(t);
    qcOfLoop();
  }
  /** the native 1 km crop around the place (about 600 x 700 km), for close zooms */
  function cropFor(p) {
    if (!p || !S.frames || !inConus(p.lat, p.lon)) return null;
    const la1 = 54.995, lo1 = -129.995, d = 0.01, r = Math.round((la1 - p.lat) / d), c = Math.round((p.lon - lo1) / d);
    return { r0: r - 300, r1: r + 300, c0: c - 360, c1: c + 360, key: `${r},${c}` };
  }
  /** a frame's quality marks for the map: rings around isolated specks, and the low-quality radar's area (v011: a mask, opaque on every
   *  low-quality pixel; map.js hatches it at the screen's resolution - at the radar's own 1 km the hatching read as a checkerboard) */
  function qcLayer(f) {
    if (!f.qc || !f.cropBox) return null;
    const b = f.cropBox, m = f.meta, w = b.c1 - b.c0 + 1, h = b.r1 - b.r0 + 1;
    let mask = null;
    if (f.qc.low) {
      if (f.qc.lowN == null) { let n = 0; for (const v of f.qc.low) n += v; f.qc.lowN = n; }
      if (f.qc.lowN) {
        if (!f.maskCanvas) {
          const c = Object.assign(document.createElement('canvas'), { width: w, height: h }), g = c.getContext('2d'), im = g.createImageData(w, h), d = new Uint32Array(im.data.buffer);
          for (let k = 0; k < w * h; k++) if (f.qc.low[k]) d[k] = 0xff000000;
          g.putImageData(im, 0, 0); f.maskCanvas = c;
        }
        mask = { canvas: f.maskCanvas, top: m.la1 + m.dj / 2 - b.r0 * m.dj, left: m.lo1 - 360 - m.di / 2 + b.c0 * m.di, dlat: m.dj, dlon: m.di, rows: h, cols: w };
      }
    }
    return { rings: f.qc.speckle, mask };
  }
  async function cloudsOn() {
    if (typeof clouds.mode === 'function') clouds.mode(S.satMode);   // v018: the satellite's look (sat build: 'overlay' see-through clouds, or 'full')
    try { await clouds.prepare(map.state.lat, map.state.lon); } catch (e) { app.toast('The satellite clouds could not be reached.'); return; }
    if (S.items[S.idx] && S.items[S.idx].kind === 'radar') show(S.idx);
  }
  async function loadWarnings() {
    if (!S.layers.warnings) { map.set('warnings', []); return; }
    try { S.warnings = await nws.warnings(); map.set('warnings', S.warnings); } catch (e) { S.warnings = []; }
    // FIELD REPORT (fieldkit): S.alertsAt = when, and for where, the place's NWS alerts were last read (null: not read, e.g. no signal)
    if (S.place) { try { S.alerts = await nws.at(S.place.lat, S.place.lon); S.alertsAt = { t: Date.now(), lat: S.place.lat, lon: S.place.lon }; } catch (e) { S.alerts = []; S.alertsAt = null; } }
    render();
  }
  async function loadRun() {
    if (!S.place) return;
    const r = (S.run && pixelOf(S.run, S.place.lat, S.place.lon) && Date.now() - S.run.t0 < 25 * 60e3) ? S.run
      : await recentRun(S.place.lat, S.place.lon, { covers: (x, la, lo) => !!pixelOf(x, la, lo) });
    setRun(r);
  }
  function setRun(r) {
    S.run = r || null;
    map.set('alerts', r && r.ss && r.ss.alerts && S.layers.nowcast ? r.ss.alerts : []);   // v057: the app's own alert areas (StormScope)
    map.set('outlines', r ? outlines(r).map((c) => ({ corners: c })) : []);
    buildItems(); if (S.open) show(S.idx >= 0 && S.items[S.idx] ? S.idx : nowIndex()); render();
  }

  // ---------------------------------------------------------------------------------------------- the timeline
  function buildItems() {
    const it = [];
    if (S.layers.radar && S.plan) for (const t of S.plan.times) it.push({ t, kind: 'radar' });
    const newest = S.plan && S.plan.times.length ? S.plan.times[S.plan.times.length - 1] : 0;
    if (!S.layers.radar && newest) it.push({ t: newest, kind: 'radar', hidden: true });
    const runFrames = (bk) => Array.from({ length: S.run.ready != null ? S.run.ready : S.run.spec.frames }, (_, k) => k).forEach((k) => {
      const t = S.run.t0 + (S.run.spec.firstMin + k * S.run.spec.everyMin) * 60e3; if (t > newest) it.push(bk ? { t, kind: 'nowcast', k, bk: beamBinAt(t) } : { t, kind: 'nowcast', k });
    });
    if (S.model === 'beam') {
      // v011 (DGMR rain under BEAM): the rain nowcast's frames (the rain moves), BEAM's half-hour for each frame's time on top;
      // with no rain run here, BEAM's three half-hours over the newest radar (v009)
      const n0 = it.length;
      if (S.layers.nowcast && rainUnderBeamRun()) runFrames(true);
      if (it.length === n0 && S.layers.nowcast && BL.frame) for (let k = 0; k < 3; k++) { const t = BL.frame.issue + (k + 1) * 30 * 60e3; if (t > newest) it.push({ t, kind: 'beam', k }); }
    } else if (S.layers.nowcast && S.run && S.run.mean) runFrames(false);
    // v018: the forecast map's hours (kind 'field'): a field's after now; Precipitation's after the nowcast's last frame
    const fid = fieldId(), all = fid ? mergeField(it, fields.times(), { after: fid === 'precip' ? Math.max(newest, it.length ? it[it.length - 1].t : 0) : newest, id: fid }) : it;
    const cur = S.items[S.idx]; S.items = all;
    // the frame shown stays; gone (its layer switched off), the nearest in time takes its place (v018: not the loop's first)
    let at = cur ? all.findIndex((x) => x.t === cur.t && x.kind === cur.kind) : -1;
    if (cur && at < 0 && all.length) { at = 0; all.forEach((x, i) => { if (Math.abs(x.t - cur.t) < Math.abs(all[at].t - cur.t)) at = i; }); }
    S.idx = cur ? Math.max(0, at) : -1;
  }
  const nowIndex = () => { let k = -1; S.items.forEach((x, i) => { if (x.kind === 'radar') k = i; }); return k; };
  const codesBuf = { a: null, n: 0 };
  let rainOn = null;   // v018 review: the radar frame last put on the map and its grids
  /** a radar frame on the map (or none) */
  function radarLayer(f) {
    if (f) {
      // v018: the codes themselves (map.js draws them smooth on the GPU, today's colours at every level; its 2D path paints them as before).
      // v018 review: the same frame again (a finger resting on the time bar seeks on every move; the view's news) gets the same grids - a
      // new grid object is new data to the map (a texture upload, or a 2D picture of ~1.9 million cells); only the last frame's are kept
      if (!rainOn || rainOn.f !== f) {
        const m = f.meta, coarse = { codes: f.conus, code: 'rate', top: m.la1 + m.dj / 2, left: m.lo1 - 360 - m.di / 2, dlat: m.dj * f.step, dlon: m.di * f.step, rows: f.ch, cols: f.cw };
        let fine = null;
        if (f.crop) { const b = f.cropBox, w = b.c1 - b.c0 + 1, h = b.r1 - b.r0 + 1; fine = { codes: f.crop, code: 'rate', top: m.la1 + m.dj / 2 - b.r0 * m.dj, left: m.lo1 - 360 - m.di / 2 + b.c0 * m.di, dlat: m.dj, dlon: m.di, rows: h, cols: w }; }
        rainOn = { f, g: { coarse, fine } };
      }
      map.set('rain', rainOn.g);
      map.set('qc', qcLayer(f));   // v018: the key's low-confidence note follows the whole loop (qcOfLoop), never a frame
    } else { map.set('rain', null); map.set('qc', null); }
  }
  /** v011: the radar frame for time t, or while it is still coming in (or being re-cut for a moved map) the nearest one there is, so the
   *  rain never blinks out: { f, exact } */
  function radarAt(t) {
    const f = S.frames.get(t); if (f) return { f, exact: true };
    let best = null, bd = Infinity;
    for (const [u, g] of S.frames) { const d = Math.abs(u - t) + (u > t ? 1 : 0); if (d < bd) { bd = d; best = g; } }   // ties: the earlier frame
    return { f: best, exact: false };
  }
  // ---------------------------------------------------------------------------------------------- v009: BEAM live on the map
  const headWord = (h) => (h === 'core' ? 'strong cores' : HEADS[h].label.toLowerCase());
  /** half-hour k of the newest run, the hazard picked (the example player's layers, the same look; an open example keeps them) */
  function beamLayerOn(k) {
    const f = BL.frame; if (!f || beam.active) return;
    beam.layers.setLive(f.grid, { vals: f.raw[BL.head][k], show: f.show[BL.head][k], head: BL.head });
    canvas.setAttribute('aria-label', `Map: BEAM, chance of ${headWord(BL.head)}, ${BIN_WORDS[k]}`);
  }
  function beamLayerOff() { if (!beam.active && beam.layers.live) beam.layers.clear(); canvas.setAttribute('aria-label', 'Rain map'); }
  /** what BEAM says at a place, in one sentence */
  function beamHere(f, p) {
    const c = chanceAt(f, p.lat, p.lon); if (!c) return 'This place is outside BEAM’s area.';
    const order = presetHazards(S.preset || 'general').filter((h) => HEADS[h]);
    for (const h of order) { const k = c[h].warned.findIndex(Boolean); if (k >= 0) return `BEAM warning here: ${headWord(h)}, ${BIN_WORDS[k]}.`; }
    const v = order.map((h) => [h, Math.max(...c[h].bins)]), hi = v.filter(([, x]) => x >= 0.005), lo = v.filter(([, x]) => x < 0.005);
    const list = (a) => a.map(([h]) => headWord(h)).join(', ');
    return `Next 90 min here: ${hi.map(([h, x]) => `${headWord(h)} ${Math.round(x * 100)} %`).join(', ')}${hi.length && lo.length ? '; ' : ''}${lo.length ? `${list(lo)} under 1 %` : ''}.`;
  }
  const beamFresh = () => !!(BL.frame && Date.now() < BL.frame.issue + 90 * 60e3);
  /** v011: BEAM's half-hour (0-2) for a time on the timeline - half-hour k is (issue + 30k, issue + 30(k+1)] min - or null (no fresh run,
   *  or past its 90 minutes) */
  function beamBinAt(t) {
    const f = BL.frame; if (!f || !beamFresh() || t > f.issue + 90 * 60e3) return null;
    return Math.min(2, Math.max(0, Math.ceil((t - f.issue) / (30 * 60e3)) - 1));
  }
  /** v011: the rain drawn under BEAM: the newest rain nowcast covering the place (DGMR's, or StormScope's when that was run here) */
  function rainUnderBeamRun() {
    const r = S.run; if (!r || !r.mean || !S.place || !pixelOf(r, S.place.lat, S.place.lon)) return null;
    return Date.now() - r.t0 < 100 * 60e3 ? r : null;
  }
  /** the BEAM half-hour a timeline item shows (its own, or the one under a rain frame), or null */
  const beamK = (it) => (!it ? null : it.kind === 'beam' ? it.k : it.kind === 'nowcast' && it.bk != null ? it.bk : null);
  /** v011: true when BEAM's half-hour k has nothing at or above the hazard's first colour (the map shows no BEAM colour there) */
  const beamEmptyMemo = new Map();
  function beamEmpty(h, k) {
    const f = BL.frame; if (!f) return false;
    const key = `${f.id}|${h}|${k}`; if (beamEmptyMemo.has(key)) return beamEmptyMemo.get(key);
    const a = f.show[h][k], thr = Math.ceil(HEADS[h].ramp[0][0] * 255); let empty = true;
    for (let q = 0; q < a.length; q++) if (a[q] >= thr) { empty = false; break; }
    if (beamEmptyMemo.size > 40) beamEmptyMemo.clear();
    beamEmptyMemo.set(key, empty); return empty;
  }
  // v011 (BEAM's colours come back when the app is reopened): the newest BEAM run is kept on this phone and comes back while it
  // is still within its 90 minutes (the maps, not the grid: liveGrid() rebuilds that)
  const BEAM_DB = 'wallowa-weather-beam-last';
  function beamIdb(mode, fn) {
    return new Promise((res, rej) => {
      let rq; try { rq = indexedDB.open(BEAM_DB, 1); } catch (e) { rej(e); return; }
      rq.onupgradeneeded = () => rq.result.createObjectStore('f');
      rq.onerror = () => rej(rq.error);
      rq.onsuccess = () => {
        const db = rq.result; let r = null;
        try { const tx = db.transaction('f', mode); r = fn(tx.objectStore('f')); tx.oncomplete = () => { db.close(); res(r && r.result); }; tx.onerror = tx.onabort = () => { db.close(); rej(tx.error); }; }
        catch (e) { db.close(); rej(e); }
      };
    });
  }
  function beamSave(f) { if (typeof indexedDB === 'undefined') return; beamIdb('readwrite', (st) => st.put(Object.assign({}, f, { grid: null }), 'last')).catch((e) => app.diag('beam: keep run', { message: String((e && e.message) || e).slice(0, 80) })); }
  async function beamRestore() {
    if (!B || typeof indexedDB === 'undefined') return;
    let f = null; try { f = await beamIdb('readonly', (st) => st.get('last')); } catch (e) { return; }
    if (!f || !f.raw || Date.now() >= f.issue + 90 * 60e3 || (BL.frame && BL.frame.t0 >= f.t0)) return;
    f.grid = liveGrid(); BL.frame = f; BL.info = f.info || null; BL.zkey = '';
    buildItems(); beamDrains(); if (S.open) { renderTl(); render(); }
  }
  /** the live warning areas for the property list: hail and strong cores (LIST_HEADS), any of the three half-hours, whichever hazard is shown */
  function beamLiveZones() {
    if (!B || !BL.frame || S.model !== 'beam' || !S.layers.nowcast || beam.active || !beamFresh() || !county) return [];
    const key = `${BL.frame.id}|${county.id}`;   // v014: the active county's
    if (BL.zkey !== key) { BL.zkey = key; BL.zones = LIST_HEADS.flatMap((h) => liveZones(BL.frame, h, county.bbox)); }
    return BL.zones;
  }
  /** Cloudburst shown: the drainages its live warning areas reach (as the example storms flag them); an open example sets its own */
  function beamDrains() {
    if (!drains || beam.active) return;
    const flags = {}, f = BL.frame;
    if (f && B && S.model === 'beam' && S.layers.nowcast && BL.head === 'rain' && beamFresh() && county) {
      const [s0, w0, n0, e0] = county.bbox, until = f.issue + 90 * 60e3;   // v014: the active county's
      const areas = warnAreas(unionBins(f, 'rain'), f.grid, HEADS.rain.warn).filter((a) => a.ring.some(([lo, la]) => la >= s0 && la <= n0 && lo >= w0 && lo <= e0));
      for (const a of areas.slice(0, 12)) {
        const r = a.ring, mid = r.reduce((m, q) => [m[0] + q[0] / r.length, m[1] + q[1] / r.length], [0, 0]);
        for (const [lo, la] of r.concat([mid])) { const d = drains.at(la, lo); if (d && d.huc12) flags[d.huc12] = { level: 'warning', why: 'Cloudburst possible (BEAM)', until }; }
      }
    }
    drains.setFlags(flags);
  }
  /** a BEAM run came back (beam_live.js 'result'): its maps replace the last ones; a run still waiting for inputs keeps them */
  function onBeamResult({ frame, info }) {
    BL.info = info;
    if (frame) {
      BL.frame = frame; BL.tries = 0; BL.err = null; BL.zkey = ''; beamSave(frame);   // v011: kept for a reopened app
      const cur = S.items[S.idx]; buildItems();
      if (S.open && S.model === 'beam') {
        const ck = beamK(cur), k = ck != null ? ck : BL.manual ? 0 : -1, fi = k >= 0 ? S.items.findIndex((x) => beamK(x) === k) : -1;
        if (fi >= 0) show(fi); else renderTl();
      }
      beamDrains();
    }
    if (S.open) render();
  }
  if (B) B.model().on('result', onBeamResult);
  /** one BEAM run through the queue (manual: the button; else the 10-minute refresh or a retry for inputs not posted yet) */
  async function beamRun(manual = false) {
    if (!B || BL.run || S.model !== 'beam' || !S.open) return;
    if (!B.ready()) { if (manual) offerBeamDownload(); return; }
    const m = B.model(), t0 = await m.newestT0();
    const have = BL.frame && BL.frame.t0 >= t0 && !(BL.info && BL.info.pending) && !BL.err;
    if (have) {
      if (manual && rainUnderBeamNeeded()) { rainUnderBeam(); return; }   // v011: BEAM is current; the rain under it was not run yet
      if (manual) app.toast(`This is BEAM’s newest run (radar ${clock(BL.frame.t0)}). The next can run at ${clock(await m.runnableAt(t0 + 10 * 60e3))}.`);
      else scheduleBeam();
      return;
    }
    clearTimeout(BL.timer); BL.timer = 0; BL.next = null; BL.manual = manual;
    BL.run = { frac: 0, text: 'Waiting its turn…' }; BL.err = null; render();
    let ok = false;
    try { await B.run((pr) => { BL.run = { frac: pr.frac || 0, text: pr.text || 'BEAM…' }; if (S.open) render(); }); ok = true; }
    catch (e) {
      const code = e && e.code;
      BL.err = code === 'ABORTED' || (e && e.name === 'AbortError') ? null : code === 'NOT_DOWNLOADED' ? 'Download BEAM first (Settings › BEAM).'
        : code === 'OUT_OF_MEMORY' || code === 'GPU_LOST' ? 'The graphics chip ran out of memory for BEAM. Close other apps and try again.' : `BEAM stopped: ${String((e && e.message) || e).slice(0, 120)}`;
    } finally { BL.run = null; BL.manual = false; if (S.open) render(); scheduleBeam(); }
    if (ok) rainAfterBeam(manual);   // v011: then the rain nowcast for under it (Nov-08: an automatic run's waits for the screen and a signal)
  }
  /** v011: is a rain nowcast (DGMR) for under BEAM wanted: the rain model on this phone, a place in the county, and no rain run here as new
   *  as BEAM's radar */
  function rainUnderBeamNeeded() {
    const p = S.place;
    if (!p || !BL.frame || S.rainRun || S.running || S.model !== 'beam' || !S.layers.nowcast || !app.ready()) return false;
    if ((app.area && !app.area.contains(p.lat, p.lon)) || !inConus(p.lat, p.lon)) return false;
    const r = rainUnderBeamRun(); return !(r && r.t0 >= BL.frame.t0);
  }
  /** v011 (DGMR rain under BEAM): BEAM's run is followed by the DGMR rain nowcast, so the rain moves
   *  under BEAM's half-hours; its progress shows under BEAM's in the card */
  async function rainUnderBeam() {
    if (!rainUnderBeamNeeded()) return;
    const p = S.place; S.rainRun = { frac: 0, text: 'Rain under BEAM (DGMR) · waiting its turn…' }; S.rainErr = null; if (S.open) render();
    try {
      const id = await app.run({ lat: p.lat, lon: p.lon, label: p.label, wide: S.wide, members: S.members }, (pr) => {
        S.rainRun = { frac: pr.frac || 0, text: `Rain under BEAM (DGMR)${pr.phase === 'radar' ? ' · getting the radar' : pr.phase === 'model' ? ` · run ${pr.member || 1} of ${pr.members || S.members}` : ''}…` };
        if (S.open) render();
      });
      const r = await getRun(id); S.rainRun = null;
      if (r) { setRun(r); const fi = S.items.findIndex((x) => x.kind === 'nowcast' && x.bk === 0); if (S.open && S.model === 'beam' && fi >= 0 && beamK(S.items[S.idx]) != null) show(fi); }
    } catch (e) {
      S.rainRun = null; const code = e && e.code;
      S.rainErr = code === 'ABORTED' || (e && e.name === 'AbortError') ? null : code === 'STALE' ? 'The rain under BEAM waits for newer NOAA radar.' : code === 'OUT_OF_MEMORY' ? 'The rain under BEAM ran out of graphics memory: close other apps and run again.' : `The rain under BEAM stopped: ${String((e && e.message) || e).slice(0, 100)}`;
    }
    if (S.open) render();
  }
  const hiddenNow = () => typeof document !== 'undefined' && document.hidden;
  /** the next run: a retry when inputs were not posted yet (at most 3), else, with "Keep forecasts fresh" on, the frame time the cadence
   *  picked (cadence.js nextRunAt: the last run's t0 + 10 or 30 min, at once when that is already posted), from its t0 + 9 min; nothing
   *  while hidden, offline, or a run is going (its end asks again) */
  async function scheduleBeam() {
    clearTimeout(BL.timer); BL.timer = 0; BL.next = null; const my = ++BL.seq;
    if (!B || !S.open || S.model !== 'beam' || !B.ready() || BL.run || hiddenNow() || fresh.offline()) return;
    const m = B.model(); let at = null;
    if (BL.info && BL.info.pending && BL.info.retryAt && BL.tries < 3) { at = Date.parse(BL.info.retryAt) + 3e3; BL.tries++; }
    else if (fresh.everyMin()) {
      const last = BL.frame ? BL.frame.t0 : 0, t0 = await m.newestT0(), lag = (await m.runnableAt(t0)) - t0 + 20e3;
      at = fresh.nextAt(BL.err ? Math.max(last, t0) : last, { hidden: hiddenNow(), lagMs: lag, failed: !!BL.err, running: !!BL.run });
    }
    if (my !== BL.seq || at == null) return;
    BL.next = at; BL.timer = setTimeout(() => { BL.timer = 0; if (!hiddenNow() && !fresh.offline()) beamRun(false); }, Math.max(2000, at - Date.now()));
    if (S.open && !BL.run) render();
  }
  /** Nov-08: a new choice, back online, a new network: the schedule again (BEAM's, StormScope's layers); offline: nothing waits (the
   *  'online' event brings it back) */
  function onFresh(why) {
    if (why === 'offline') { clearTimeout(BL.timer); BL.timer = 0; BL.next = null; BL.seq++; } else freshResume();
    ssKeepFresh();
    fields.replan();   // v018 review: the forecast maps use a new choice at once (fresh's news comes after the view is built)
    if (S.open) render();
  }
  /** back on screen or online (or a new choice): the next BEAM run - one at once when the last is stale - then the rain under BEAM that
   *  waited while the page was hidden or offline, unless a BEAM run about to start brings its own */
  async function freshResume() {
    await scheduleBeam();
    if (!fresh.everyMin()) BL.rainDue = false;   // switched Off: nothing more by itself
    if (BL.rainDue && !BL.run && !(BL.next && BL.next - Date.now() < 60e3) && !hiddenNow() && !fresh.offline()) { BL.rainDue = false; rainUnderBeam(); }
  }
  /** after a BEAM run: the rain under it now (a run asked for, or the screen up with a signal), else when the screen and signal are back */
  function rainAfterBeam(manual) { if (!manual && (hiddenNow() || fresh.offline())) { BL.rainDue = true; return; } BL.rainDue = false; rainUnderBeam(); }
  /** BEAM put away: its timer, its job, its GPU memory and its input worker (the map closed, the page went away, another model picked) */
  function beamRelease() {
    clearTimeout(BL.timer); BL.timer = 0; BL.next = null; BL.seq++;
    if (!B) return;
    if (BL.run && B.cancel) B.cancel();
    try { B.release(); } catch (e) { /* */ }
  }
  addEventListener('pagehide', () => beamRelease());
  if (typeof document !== 'undefined') document.addEventListener('visibilitychange', () => { if (document.hidden) { clearTimeout(BL.timer); BL.timer = 0; BL.next = null; BL.seq++; if (!BL.run && B) { try { B.release(); } catch (e) { /* */ } } } else freshResume(); });
  function offerBeamDownload() {
    if (!B) return;
    openSheet((b) => {
      b.append(mk('h2', 'nc-h', 'BEAM'));
      b.append(mk('p', null, `BEAM, the Blended Early-warning Alert Model, was made for this app: the chance of lightning, hail, cloudbursts and strong storm cores for the next 90 minutes, from NOAA's radar, the GOES-West satellite and lightning mapper, and the HRRR model, worked out on this phone: ${MB(B.size())}, downloaded once.`));
      b.append(mk('p', 'footnote', 'Each run reads a few MB of NOAA data. Made for this app as a public-good project, to be released under the Apache License 2.0. Experimental, not a National Weather Service warning.'));
      const d = B.dl(), go = btn('nc-btn', d && d.running ? `Downloading · ${Math.floor(100 * (d.pct || 0))}%` : `Download · ${MB(B.size())}`);
      go.disabled = !!(d && d.running); go.onclick = () => { B.download(); closeSheet(); render(); }; b.append(go);
    }, 'download');
  }
  /** the card while BEAM is picked: what it says here, its flags, the hazard, Run BEAM now, the 10-minute refresh, the example storms */
  function renderBeam(p, wl) {
    const ex = btn('nc-btn ghost', 'See example storms'); ex.onclick = () => openBeamExamples();
    noteEl.textContent = 'BEAM · lightning, hail, cloudbursts and strong cores, 90 minutes ahead · Experimental';
    if (!B) { sumEl.textContent = 'BEAM will run on this phone. Until then: see what it showed on real storms near Wallowa County.'; action.append(ex); return; }
    const col = mk('div', 'bm-live'), row = mk('div', 'bm-live-btns'); action.append(col);
    if (!B.ready()) {
      const d = B.dl(), g = btn('nc-btn', d && d.running ? `Downloading · ${Math.floor(100 * (d.pct || 0))}%` : `Get BEAM · ${MB(B.size()).replace(' ', ' ')}`);
      g.disabled = !!(d && d.running); g.onclick = () => offerBeamDownload(); row.append(g, ex); col.append(row);
      sumEl.textContent = 'BEAM runs on this phone: a one-time model download first. Or see what it showed on real storms near Wallowa County.'; return;
    }
    if (!(globalThis.navigator && navigator.gpu)) { sumEl.textContent = 'BEAM needs a browser with WebGPU (Safari on iOS 26 or later, or Chrome on Android 12 or later).'; row.append(ex); col.append(row); return; }
    const f = beamFresh() ? BL.frame : null;
    card.classList.toggle('bm-card', !!f);   // the time control first, BEAM's controls under it
    sumEl.textContent = f ? beamHere(f, p) : 'BEAM forecasts lightning, hail, cloudbursts and strong cores for the next 90 minutes over the Inland Northwest, worked out on this phone.';
    if (wl.length) sumEl.textContent += ' Follow the warning above.';
    if (BL.frame) { const age = Math.round((Date.now() - BL.frame.issue) / 60e3); noteEl.textContent = `BEAM · ${clock(BL.frame.t0)} radar · ${age > 1 ? `${age} min old` : 'just now'}${f ? '' : ': too old, run it again'} · Experimental`; }
    for (const x of flagWords(BL.info, { clock })) col.append(mk('p', 'nc-flag bm-flag ' + x.kind, x.text));
    if (BL.err) col.append(mk('p', 'nc-flag bm-flag error', BL.err));
    if (f) {   // the hazard on the map (the time control picks the half-hour)
      const chips = mk('div', 'bm-chips');
      for (const [k, h] of Object.entries(HEADS)) {
        const c = btn('bm-chip' + (k === BL.head ? ' on' : ''), h.label); c.setAttribute('aria-pressed', String(k === BL.head));
        c.onclick = () => { BL.head = k; lsSet({ beamHead: k }); beamDrains(); const it = S.items[S.idx]; if (it && it.kind === 'beam') show(S.idx); else paintLegend(); render(); };
        chips.append(c);
      }
      col.append(chips);
      const it = S.items[S.idx];
      if (beamK(it) == null) { const go = btn('nc-btn ghost sm', 'Show BEAM on the map'); go.onclick = () => { const fi = S.items.findIndex((x) => beamK(x) != null); if (fi >= 0) { stop(); show(fi); render(); } }; col.append(go); }
    }
    // v011: the rain under BEAM (DGMR): its run's progress, a stop, or why it can't run
    if (S.rainRun) {
      col.append(mk('p', 'footnote bm-run', S.rainRun.text));
      const bar = mk('div', 'nc-bar'), i = mk('i'); i.style.transform = `scaleX(${(S.rainRun.frac || 0).toFixed(3)})`; bar.append(i); col.append(bar);
    } else if (S.rainErr) col.append(mk('p', 'nc-flag bm-flag error', S.rainErr));
    else if (f && !app.ready()) col.append(mk('p', 'footnote', 'For moving rain under BEAM, get the rain model (Settings › DGMR).'));
    if (BL.run) {
      col.append(mk('p', 'footnote bm-run', BL.run.text || 'BEAM…'));
      const bar = mk('div', 'nc-bar'), i = mk('i'); i.style.transform = `scaleX(${(BL.run.frac || 0).toFixed(3)})`; bar.append(i); col.append(bar);
      row.append(ex);
    } else { const rb = btn('nc-btn', 'Run BEAM now'); rb.onclick = () => beamRun(true); row.append(rb, ex); }
    col.append(row);
    col.append(fresh.line(document, { next: BL.run ? null : BL.next, clock }));   // Nov-08: Keep fresh [Off / 10 / 30 / Wi-Fi 10, cellular 30] · next about ...
  }
  /** v009: BEAM's refresh while the map is open (Nov-08: the choice in cadence.js; the card, Layers and Settings) */
  const beamFreshNote = () => `${BL.info && BL.info.bytes ? `The last run read ${MB(BL.info.bytes)}. ` : ''}Storm cones are in the example storms only: a live cone needs each storm tracked from run to run.`;
  let lazyT = 0;   // v018 review: a forecast hour asked for by a drag on the time bar, read once the finger rests
  function show(i, { lazy = false } = {}) {
    if (lazyT) { clearTimeout(lazyT); lazyT = 0; }
    if (i < 0 || !S.items.length) { map.set('rain', null); map.set('nowcast', null); renderTl(); return; }
    // v012: a DGMR / StormScope example open; v018: a BEAM example too (it drew over today's radar): today's layers stay off
    if (S.example || rainEx.active || beam.active) { S.idx = Math.max(0, Math.min(S.items.length - 1, i)); return; }
    S.idx = Math.max(0, Math.min(S.items.length - 1, i)); const it = S.items[S.idx], bk = beamK(it);
    if (bk == null) beamLayerOff();   // v009; v011: a rain frame under BEAM keeps BEAM's half-hour
    S.stand = false;
    if (it.kind === 'field') {   // v018: a forecast map's hour (fields/): the field alone, under the labels
      map.set('rain', null); map.set('nowcast', null); map.set('qc', null); map.set('clouds', null); S.cloud = null;
      // v018 review: a drag passing over the forecast hours reads only the hour the finger rests on (each is 0.1-1.6 MB)
      if (lazy) { lazyT = setTimeout(() => { lazyT = 0; if (S.items[S.idx] === it) fields.show(it.t); }, 220); paintLegend(); renderTl(); return undefined; }
      const drawn = fields.show(it.t); paintLegend(); renderTl(); return drawn;   // v018 review: play waits for it (tick)
    }
    fieldUnder(it.t);
    if (it.kind === 'beam') {   // v009: BEAM's half-hour k over the newest radar
      const nt = S.plan && S.plan.times.length ? S.plan.times[S.plan.times.length - 1] : 0;
      map.set('nowcast', null); map.set('clouds', null); S.cloud = null;
      radarLayer(S.layers.radar ? radarAt(nt).f : null);
      beamLayerOn(it.k); paintLegend();
    } else if (it.kind === 'radar') {
      const { f, exact } = radarAt(it.t); S.stand = !!f && !exact && !it.hidden;   // v011: a frame still coming in: the nearest stands in
      map.set('nowcast', null);
      radarLayer(f && !it.hidden ? f : null);
      S.cloud = null;
      if (S.layers.clouds && S.place) { S.cloud = clouds.at(it.t, map.state.lat, map.state.lon); map.set('clouds', S.cloud); } else map.set('clouds', null);
      paintLegend();
    } else {
      const r = S.run, n = r.size * r.size, k = it.k;
      if (codesBuf.n !== n) { codesBuf.a = new Uint8Array(n); codesBuf.n = n; }
      const c = codesBuf.a, chance = S.mode === 'chance' && S.model !== 'beam';   // v011: under BEAM the rain is the rain (BEAM's key is the chance)
      // the same colours and opacity as the radar; "Average" is the PMM (the average's pattern, the runs' own intensities: a plain
      // average of misplaced showers is a faint smear), "One possible future" one run as it came
      if (chance) { const p = r.prob[S.thr] || r.prob[THRESHOLDS[1]]; for (let q = 0; q < n; q++) c[q] = p[k * n + q] >= 26 ? p[k * n + q] : 0; }
      const typed = !chance && r.ss && r.ss.type && r.ss.typeInfo;   // PILOT: rain / snow / sleet / freezing rain from HRRR
      if (typed) { const f = r.pmm || r.mean, T = r.ss.type; for (let q = 0; q < n; q++) c[q] = typeCode(T[k * n + q], f[k * n + q] / 64); }
      else if (!chance) { const f = (S.mode === 'one' && r.one) || r.pmm || r.mean; for (let q = 0; q < n; q++) c[q] = levelOf(f[k * n + q] / 64); }
      map.set('clouds', null); S.cloud = null; map.set('qc', null);   // the future's clouds are not known
      const P = boxProjection(r.lat, r.lon, r.size, r.km), tl0 = P.toLatLon(-0.5, -0.5), br = P.toLatLon(r.size - 0.5, r.size - 0.5);
      const g = { codes: c, code: chance ? 'chance' : typed ? 'type' : 'rate', top: tl0.lat, left: tl0.lon, dlat: (tl0.lat - br.lat) / r.size, dlon: (br.lon - tl0.lon) / r.size, rows: r.size, cols: r.size };
      map.set('rain', null); map.set('nowcast', g);   // v018: a new object each frame = new codes (the buffer is reused): uploaded once
      if (bk != null) beamLayerOn(bk);   // v011: BEAM's half-hour over the moving rain
      paintLegend();
    }
    renderTl();
  }
  /** v018: under a radar or nowcast frame, a field map (wind, temperature, ...) stays at its nearest hour; Precipitation's hours are only
   *  drawn on their own frames (the radar and the nowcast are the precipitation before them) */
  function fieldUnder(t) {
    const id = fieldId(); if (!id) return;
    if (id === 'precip') { fields.show(null); return; }
    const ts = fields.times(); if (!ts.length) return;
    let best = ts[0]; for (const x of ts) if (Math.abs(x - t) < Math.abs(best - t)) best = x;
    fields.show(best);
  }
  /** v018: the time bar's words (timebar.js draws it): "Now 8:00 AM" / "Today 4:10 PM" / "Next 30 min to 8:40 AM", and what the frame is */
  function renderTl() {
    if (S.example) { const u = exUi(); if (u) TB.render(exampleTime(u)); return; }   // v018 examples: the example's frames
    const n = S.items.length;
    if (!n) { TB.render({ items: [], idx: -1, nowIdx: -1, day: '', time: '', tag: S.err || 'Loading the radar…', tagClass: 'past' }); return; }
    const ni = nowIndex(), idx = Math.max(0, S.idx < 0 ? ni : S.idx), it = S.items[idx], nowT = ni >= 0 ? S.items[ni].t : Date.now(), isNow = idx === ni;
    const none = (k) => (beamEmpty(BL.head, k) ? ` · none above ${Math.round(HEADS[BL.head].ramp[0][0] * 100)} %` : '');   // v011: say why no BEAM colour shows
    let { day, time } = whenWords(it.t, { now: Date.now(), isNow, clock }), tag = '', cls = '', vt = '';
    if (it.kind === 'beam') {   // v009
      const w = BIN_WORDS[it.k]; day = w.charAt(0).toUpperCase() + w.slice(1); time = `to ${clock(it.t)}`;
      tag = `BEAM · chance of ${headWord(BL.head)}${none(it.k)} · Experimental`; vt = `${clock(it.t)}, BEAM ${w}`;
    } else if (it.kind === 'nowcast' && S.model === 'beam') {   // v011: the rain nowcast under BEAM's half-hour
      const rn = S.run.spec && S.run.spec.model === 'stormscope' ? 'StormScope' : 'DGMR';
      tag = it.bk != null ? `${rn} rain · BEAM ${headWord(BL.head)}, ${BIN_WORDS[it.bk]}${none(it.bk)} · Experimental` : `${rn} rain · past BEAM’s 90 min · Experimental`;
      vt = `${clock(it.t)}, nowcast${it.bk != null ? `, BEAM ${BIN_WORDS[it.bk]}` : ''}`;
    } else if (it.kind === 'nowcast') {
      tag = S.mode === 'chance' ? `Nowcast · chance over ${S.thr} mm/h · Experimental` : S.mode === 'one' || S.run.members < 2 ? 'Nowcast · one possible future · Experimental' : `Nowcast · average of ${S.run.members} runs · Experimental`;
      vt = `${clock(it.t)}, nowcast`;
    } else if (it.kind === 'field') {   // v018
      const F = it.id === 'precip' ? { name: 'Precipitation' } : FIELDS.find((f) => f.id === it.id) || { name: 'Forecast' }, st = fields.status() || {};
      // v018 review: an hour not on the map yet says so, like the radar's "loading this frame"
      // v020: Precipitation's 15-minute steps are steps of their own ("this time"); the hourly maps' steps between the hours wait for an hour
      // and are those hours blended ("hourly, smoothed")
      const own = it.id === 'precip', what = own ? 'this time' : 'this hour', here = st.valid === it.t;
      const state = here ? '' : st.loading || !st.err ? `loading ${what}` : `${what} could not load`;
      const kind = !own && it.t % 3600e3 ? `${st.model || 'NOAA'} hourly, smoothed` : st.model ? `${st.model} forecast` : 'NOAA forecast';
      tag = `${F.name} · ${state || kind} · Experimental`; vt = `${day} ${clock(it.t)}, ${F.name.toLowerCase()} forecast${state ? `, ${state}` : ''}`;
    } else {
      cls = 'past';
      tag = it.hidden ? 'Radar layer off' : S.stand ? 'Radar · loading this frame' : isNow ? 'Radar' : `Radar · ${Math.round((nowT - it.t) / 60e3)} min ago`;
      if (S.cloud) tag += ` · ${shownWords(clouds.shown(), clock)}`;   // v018 fix: the time drawn ("clouds loading" before any is)
      vt = `${clock(it.t)}, radar`;
    }
    TB.render({ items: S.items, idx, nowIdx: ni, nowT, day, time, tag, tagClass: cls, valuetext: vt });
  }
  let playTok = 0;
  function stop() { S.playing = false; playTok++; clearTimeout(S.timer); TB.setPlaying(false); }
  // v018 review: a forecast map's hour is waited for before the next (on cellular an hour takes seconds: the bar ran on every 750 ms and each
  // hour's read was dropped for the next - the hour play started from stayed on the map under every later hour's label); at most PLAY_WAIT,
  // then on (a stalled read never stops the loop)
  const PLAY_WAIT = 8000;
  // v020: the forecast maps' items are 15 minutes apart: 250 ms a step plays the 18 hours (72 steps) in ~18 s, as the hourly loop took
  // ~14 s at 750 ms an hour. Measured in Edge (software rendering, tests/v020_subh_edge_test.mjs): steps already on the phone play at a
  // median 257 ms (p90 260); a step still loading is waited for (PLAY_WAIT)
  const FIELD_STEP_MS = 250;
  function tick() {
    if (!S.playing) return;
    const my = playTok, drawn = show(S.idx + 1 >= S.items.length ? 0 : S.idx + 1), k = S.items[S.idx].kind, t0 = Date.now();
    const ms = S.idx === S.items.length - 1 ? 1400 : k === 'beam' ? 1100 : k === 'field' ? FIELD_STEP_MS : k === 'nowcast' ? 420 : 650;
    const next = () => { if (S.playing && my === playTok) S.timer = setTimeout(tick, Math.max(0, ms - (Date.now() - t0))); };
    if (k === 'field' && drawn && typeof drawn.then === 'function') Promise.race([drawn, new Promise((r) => setTimeout(r, PLAY_WAIT))]).then(next, next); else next();
  }
  function togglePlay() {
    if (S.playing) return stop();
    if (S.example) { if (!exUi()) return; S.playing = true; TB.setPlaying(true); exTick(); return; }   // v018 examples
    if (!S.items.length) return; S.playing = true; TB.setPlaying(true); tick();
  }
  /** v018 examples: the next frame of the example once this one is drawn, at the player's pace (the cone's moment held longer) */
  function exTick() {
    const P = exPlayer(), u = exUi(); if (!S.playing || !u) return;
    const my = playTok;
    Promise.resolve(P.show(u.i + 1 >= u.frames.length ? 0 : u.i + 1)).then(() => { const v = exUi(); if (S.playing && my === playTok && v) S.timer = setTimeout(exTick, v.delay || 900); });
  }

  // ---------------------------------------------------------------------------------------------- the card
  /** v008: the warning areas whose properties are listed (the app's alerts, NWS warnings, an example storm's BEAM hail) */
  function affectedZones() {
    const z = [];
    if (S.layers.nowcast && S.run && S.run.ss) (S.run.ss.alerts || []).forEach((a, i) => { if (a.rings && ['red', 'orange', 'yellow'].includes(a.level))
      z.push({ id: `app-${a.kind || a.level}-${i}`, label: a.label, color: a.color, level: a.level, rings: a.rings, until: S.run.t0 + (a.endMin || 90) * 60e3, source: 'app' }); });
    if (S.layers.warnings) for (const w of S.warnings || []) if (/warning/i.test(w.event) && w.rings)   // official warnings rank with the red ones
      z.push({ id: w.id || `nws-${w.event}-${w.ends}`, label: w.label || w.event, color: w.color, level: 'red', rings: w.rings, until: Date.parse(w.ends) || null, source: 'nws' });
    return z.concat(beam.active ? beamZones : beamLiveZones());   // v009
  }
  function syncAffected() { if (affected) affected.setZones(affectedZones()); }
  /** the card and what follows it: the folded line's key sentence, a run's progress along the card's foot, the key, the quick button */
  function render() {
    if (!S.open) return;
    if (S.example) { exChanged(); return; }   // v018 examples: the card holds the example
    renderCard();
    fold.setKey(sumEl.textContent || noteEl.textContent || '');
    const pr = S.running || BL.run || S.rainRun; cardProg.hidden = !pr; if (pr) cardProg.style.transform = `scaleX(${Math.max(0.02, pr.frac || 0).toFixed(3)})`;
    paintFab(); paintLegend();
  }
  function renderCard() {
    syncAffected(); placeDock();
    const p = S.place;
    placeEl.textContent = p ? p.label : 'Pick a place: search, locate, or press and hold on the map';
    const newest = S.av && S.av.newest;
    radarEl.replaceChildren(icon('refresh', 'nc-ic sm', 16), mk('span', null, newest ? radarAge(newest) : S.err ? 'radar not reached' : 'radar…'));
    radarEl.setAttribute('aria-label', `${newest ? radarLine(newest) : 'Radar'}. Load the newest radar`);
    radarEl.classList.toggle('stale', !!newest && Date.now() - newest > 15 * 60e3);
    // official warnings first
    const pr = S.preset || 'general', wl = (S.alerts || []).filter((a) => /warning/i.test(a.event)).sort((a, b) => presetRank(pr, a.event) - presetRank(pr, b.event));   // v008: the preset's warnings first
    warn.hidden = !wl.length;
    if (wl.length) { warn.replaceChildren(icon('alert', 'nc-ic sm', 18), mk('b', null, wl[0].event), mk('span', null, wl[0].ends ? ` until ${clock(Date.parse(wl[0].ends))}` : ''), mk('span', 'nc-more', wl.length > 1 ? ` · +${wl.length - 1} more` : '')); warn.style.setProperty('--wc', wl[0].color); }
    action.textContent = ''; noteEl.textContent = ''; sumEl.textContent = '';
    if (!p) return;
    if (app.area && !app.area.contains(p.lat, p.lon)) { sumEl.textContent = `${app.area.app} forecasts ${app.area.name}. Pick a place inside the county.`; return; }
    if (!inConus(p.lat, p.lon)) { sumEl.textContent = 'The nowcast covers the lower 48 states only.'; return; }
    if (S.running) {
      const r = S.running; sumEl.textContent = r.text || 'Nowcasting…';
      const bar = mk('div', 'nc-bar'), i = mk('i'); i.style.transform = `scaleX(${(r.frac || 0).toFixed(3)})`; bar.append(i); action.append(bar); return;
    }
    if (S.model === 'beam') { renderBeam(p, wl); return; }   // v008: the examples; v009: BEAM live
    card.classList.remove('bm-card');
    if (newest && Date.now() - newest > 15 * 60e3) { sumEl.textContent = `The newest NOAA radar is ${Math.round((Date.now() - newest) / 60e3)} minutes old, so no nowcast runs now. Try again in a few minutes.`; return; }
    const s = S.run ? summaryAt(S.run, p.lat, p.lon) : null;
    if (s) {
      sumEl.textContent = s.text;
      const age = Math.round((Date.now() - S.run.t0) / 60e3);
      noteEl.textContent = [`Nowcast from radar ${clock(S.run.t0)}${age > 10 ? ` (${age} min ago)` : ''} · ${S.run.members} run${S.run.members > 1 ? 's' : ''}${S.run.precision === 'int8' ? ' · low-memory model' : ''}`, s.snowNote || ''].filter(Boolean).join(' · ');
      if (wl.length) sumEl.textContent += ' Follow the warning above.';
      if (S.run.ss && S.run.ss.timing) {   // PILOT: how long it took, and what only StormScope sees
        const T = S.run.ss.timing, sec = (ms) => `${(ms / 1000).toFixed(ms < 10000 ? 1 : 0)} s`;
        const data = T.cached ? `layers kept fresh${T.mb ? ` (+${T.mb.toFixed(1)} MB new, ${sec(T.dataMs)})` : ''}` : `data ${T.mb.toFixed(1)} MB in ${sec(T.dataMs)}`;
        noteEl.textContent = app.area ? `StormScope from radar ${clock(S.run.t0)}` : `StormScope (pilot) from radar ${clock(S.run.t0)} · total ${sec(T.totalMs)}: ${data}, prepare ${sec(T.prepMs)}, load ${sec(T.loadMs)}, model ${sec(T.modelMs)} (${S.run.ss.stepMs.length} frames)`; // Wallowa Weather: short; the timings are in Diagnostics
        for (const f of S.run.ss.flags || []) action.append(mk('p', 'nc-flag ' + f.kind, f.text));
        if (S.run.ss.typeInfo) noteEl.textContent += ' · Colours: blue-white snow, purple sleet, pink freezing rain (type from NOAA HRRR)';
        const levelOrder = { red: 0, yellow: 1, orange: 2 };
        const al = (S.run.ss.alerts || []).slice().sort((a, b) => (levelOrder[a.level] ?? 3) - (levelOrder[b.level] ?? 3) || ((a.startMin == null ? Infinity : a.startMin) - (b.startMin == null ? Infinity : b.startMin))).slice(0, 4);
        if (al.length) {   // v057: the app's own alerts (hatched on the map), never official: the NWS's are the lined boxes
          action.append(mk('p', 'nc-sub', 'App alerts · experimental, not from the NWS'));
          for (const a of al) {
            const txt = alertText(a, p);   // v006: the same words as the tap sheet
            const e = mk('p', 'nc-flag app'); e.style.borderLeftColor = a.color;
            const cnt = mk('span', 'nc-lots', '');
            e.append(mk('span', '', txt), cnt);
            let lotsTxt = '';
            if (lotCounter && a.rings) lotCounter.count(a.rings[0]).then((r) => { lotsTxt = lotsText(r); if (r && !r.outside && !r.none) cnt.textContent = ` · ${r.n.toLocaleString('en-US')} ${r.n === 1 ? 'property' : 'properties'}`; });
            const sb = btn('nc-btn ghost', 'Share');
            sb.addEventListener('click', (ev) => { ev.stopPropagation(); shareAlert(sb, [`${txt}.`, lotsTxt].filter(Boolean).join(' ')); });
            e.addEventListener('click', () => openAlerts([a]));   // v006: the line opens the same text block as a tap on its zone
            e.append(sb); action.append(e);
          }
        }
      } else if (S.run.ss && S.run.ready < S.run.spec.frames) noteEl.textContent = `StormScope (pilot) · ${S.run.ready} of ${S.run.spec.frames} frames so far`;
      const again = btn('nc-btn ghost', 'Nowcast again'); again.onclick = () => nowcast(); if (age > 6) action.append(again);
      return;
    }
    if (S.model === 'stormscope' && app.ssListed && app.ssListed() && !app.ssReady()) {   // v008: the card follows the model picked (it offered DGMR's download)
      const d = app.ssDl(), b = btn('nc-btn', d && d.running ? `Downloading · ${Math.floor(100 * (d.pct || 0))}%` : `Get StormScope · ${MB(app.ssSize())}`);
      b.disabled = !!(d && d.running); b.onclick = () => offerSsDownload(); action.append(b, rainExBtn());   // v012: + the example storms
      sumEl.textContent = 'StormScope runs on this phone: a one-time model download first.'; return;
    }
    if (S.model !== 'stormscope' && !app.ready()) {
      const d = app.dl(), b = btn('nc-btn', d && d.running ? `Downloading · ${Math.floor(100 * (d.pct || 0))}%` : `Get the nowcast model · ${MB(app.sizeOf())}`);
      b.disabled = !!(d && d.running); b.onclick = () => offerDownload(); action.append(b, rainExBtn());   // v012: + the example storms
      sumEl.textContent = 'The nowcast runs on this phone: a one-time model download first.'; return;
    }
    const b = btn('nc-btn', 'Nowcast here'); b.onclick = () => nowcast(); action.append(b, rainExBtn());   // v012: + the example storms
    sumEl.textContent = wl.length ? 'Follow the warning above.' : 'The next 90 minutes of rain here, worked out on this phone.';
    if (S.model === 'stormscope' && S.ssStat) noteEl.textContent = layersLine(S.ssStat);
  }
  radarEl.onclick = () => loadRadar(true);
  warn.onclick = () => openAlert();
  infoB.onclick = () => openInfo();
  back.onclick = () => app.home();

  async function nowcast(p = S.place) {
    if (!p || S.running) return;
    if (S.model === 'beam') { if (B) { closeSheet(); beamRun(true); } else openBeamExamples(); return; }   // v008: the examples; v009: BEAM live
    if (app.area && !app.area.contains(p.lat, p.lon)) { app.toast(`${app.area.app} forecasts ${app.area.name} only.`); return; }
    const ss = S.model === 'stormscope' && app.ssListed && app.ssListed();
    if (ss && !app.ssReady()) return offerSsDownload();
    if (!ss && !app.ready()) return offerDownload();
    const fresh = S.run && (S.run.spec.model === 'stormscope') === !!ss && S.av && S.av.newest && pixelOf(S.run, p.lat, p.lon) && Math.abs(S.run.lat - p.lat) < 0.05 && Math.abs(S.run.lon - p.lon) < 0.05 && S.av.newest - S.run.t0 < 3 * 60e3;
    if (fresh) { closeSheet(); const fi = S.items.findIndex((x) => x.kind === 'nowcast'); if (fi >= 0) show(fi); app.toast('This nowcast is from the newest radar.'); return; }
    S.running = { frac: 0, text: 'Getting the newest radar…' }; render(); closeSheet();
    try {
      const id = await app.run(Object.assign({ lat: p.lat, lon: p.lon, label: p.label, wide: S.wide, members: S.members }, ss ? { model: 'stormscope', wide: false, members: 1 } : {}), onRunProgress);
      S.running = null; const r = await getRun(id); setRun(r);
      const fi = S.items.findIndex((x) => x.kind === 'nowcast'); if (fi >= 0) show(fi);
    } catch (e) { runFailed(e); }
  }
  function onRunProgress(pr) {
        S.running = { frac: pr.frac || 0, text: pr.text ? pr.text : pr.phase === 'radar' ? 'Getting the newest radar…' : pr.phase === 'model' ? `Nowcasting on this phone · run ${pr.member || 1} of ${pr.members || S.members}${pr.tiles > 1 ? ` · area ${pr.tile} of ${pr.tiles}` : ''}` : pr.phase === 'queue' ? 'Waiting its turn…' : 'Nowcasting…' };
        render();
  }
  /** a nowcast job that is already queued or running (after a fresh page): the card follows it */
  async function follow() {
    if (S.running || !app.inflight) return;
    const w = app.inflight(onRunProgress); if (!w) return;
    S.running = { frac: 0, text: 'Nowcasting…' }; render();
    try { const id = await w; S.running = null; const r = await getRun(id); if (r) { setRun(r); const fi = S.items.findIndex((x) => x.kind === 'nowcast'); if (fi >= 0) show(fi); } else render(); }
    catch (e) { runFailed(e); }
  }
  function runFailed(e) {
      S.running = null; render();
      const code = e && e.code;
      sumEl.textContent = code === 'STALE' ? `The newest NOAA radar is ${Math.round(e.ageMin || 16)} minutes old, so no nowcast runs now. Try again in a few minutes.`
        : code === 'RADAR_MISSING' ? 'NOAA has no recent radar right now, so no nowcast runs.' : code === 'OUT_OF_MEMORY' ? 'This phone ran out of graphics memory for the nowcast. The smaller model (Settings › Models) needs less.'
        : code === 'ABORTED' || (e && e.name === 'AbortError') ? 'Stopped.' : `The nowcast stopped: ${String((e && e.message) || e).slice(0, 120)}`;
      fold.setKey(sumEl.textContent);
  }

  // ---------------------------------------------------------------------------------------------- sheets
  function openSheet(build, cls = '') {
    sheetBody.textContent = ''; sheetBox.className = 'nc-sheet-box ' + cls; build(sheetBody); sheet.hidden = false; requestAnimationFrame(() => sheet.classList.add('on'));
  }
  function closeSheet() { sheet.classList.remove('on'); sheet.hidden = true; sheetBody.textContent = ''; map.set('pick', null); map.set('lot', null); }
  sheetX.onclick = closeSheet; sheet.addEventListener('click', (e) => { if (e.target === sheet) closeSheet(); });
  const sw = (label, on, set, sub) => { const l = mk('label', 'nc-sw'), t = mk('span', 'nc-sw-t'), i = mk('input'); i.type = 'checkbox'; i.checked = !!on; i.onchange = () => set(i.checked); t.append(mk('b', null, label)); if (sub) t.append(mk('span', 'footnote', sub)); l.append(t, i); return l; };
  const seg = (opts, cur, set) => { const r = mk('div', 'nc-seg'); for (const [v, lab] of opts) { const b = btn('nc-seg-b' + (v === cur ? ' on' : ''), lab); b.onclick = () => { set(v); r.querySelectorAll('.nc-seg-b').forEach((x) => x.classList.remove('on')); b.classList.add('on'); }; r.append(b); } return r; };
  // v019: while keptKnown looks for an older phone's saved map, Wallowa's switch is not written (an "off" written then would hide that map)
  function saveLayers() { lsSet({ preset: S.preset, layers: keptAsking ? Object.assign({}, S.layers, { offline: undefined }) : S.layers, mode: S.mode, thr: S.thr, members: S.members, wide: S.wide, loopMin: S.loopMin, model: S.model, ssFresh: S.ssFresh, basemap: S.basemap, keep: S.keep, fmap: S.fmap, fmapOn: S.fmapOn, satMode: S.satMode }); }
  /** v014: a layer the active county has no data for yet: its switch, off, saying so */
  function notYet(label, sub = `Not in the app yet for ${county.short}`) { const l = sw(label, false, () => {}, sub); const i = l.querySelector('input'); i.disabled = true; l.classList.add('nc-sw-na'); return l; }
  /** v008: a model picked (the chip, or Settings' "Use on the map") */
  function pickModel(id) {
    if (!(S.fmap === 'precip' && S.fmapOn)) { S.fmap = 'precip'; S.fmapOn = true; S.layers.nowcast = true; syncFields(); }   // v018: a model picked = its Precipitation map back on
    const was = S.model; S.model = id; saveLayers(); ssKeepFresh(); picker.setCurrent(id);
    if (was === 'beam' && id !== 'beam') beamRelease();   // v009
    buildItems(); show(S.idx >= 0 && S.items[S.idx] ? S.idx : nowIndex()); beamDrains(); render();
    if (id === 'beam') { beamRestore(); scheduleBeam(); }   // v011: the last BEAM run comes back
  }
  let settingsCtl = null;
  /** v008: Settings (the gear): the models (what each does, strengths, weaknesses, download / delete), map data and credits, install, about, diagnostics */
  function openSettings(start) {
    if (!app.settings) return; picker.close();
    openSheet((b) => { settingsCtl = buildSettings(b, Object.assign({}, app.settings, { start, current: () => S.model, onUse: (id) => pickModel(id),
      fieldReport: (el) => fieldReport(el, null, false),   // FIELD REPORT (fieldkit): Settings › Field report
      bench: app.benchStep ? (el) => benchPage(el) : undefined,   // BENCH TEST: Settings › Bench test
      credits: () => creditsNode(), notes: [parcels ? CL.words.note : '', lands ? LANDS_NOTE : '', BM() ? ROADS_NOTE : ''].filter(Boolean), counties: countyHooks(),
      fresh: B || (app.ssListed && app.ssListed()) ? { value: () => fresh.short(), sub: 'BEAM, the rain under it, StormScope’s layers', build: (el) => fresh.fill(el, { rain: !!app.ready() }) } : undefined })); }, 'settings');   // Nov-08
  }
  /** v008: a preset sets a group of layers at once (radar, location and offline stay as they are) */
  function applyPreset(id) {
    S.layers = presetLayers(S.layers, id); S.preset = id;
    if (S.layers.nowcast) { S.fmap = 'precip'; S.fmapOn = true; syncFields(); }   // v018: one forecast map at a time
    saveLayers();
    BL.head = presetHazards(id)[0]; lsSet({ beamHead: BL.head }); beamDrains();   // v009
    parcelsOn(); landsOn(); roadsOn(); loadWarnings(); v008On();
    if (S.layers.clouds) cloudsOn(); else { map.set('clouds', null); S.cloud = null; }
    map.set('alerts', S.layers.nowcast && S.run && S.run.ss ? S.run.ss.alerts || [] : []); buildItems(); show(S.idx); render(); openLayers();
  }
  /** v018: the Layers sheet in three groups (layerspanel.js) - Weather now
   *  (switches), Forecasts (one at a time), Map details (the view's own rows below) - and v017's radar and nowcast settings folded under them */
  function openLayers() {
    openSheet((b) => {
      b.append(mk('h2', 'nc-h', 'Layers'));
      const modelName = (MODELS.find((x) => x.id === S.model) || {}).name || 'the model';
      buildLayersPanel(b, { live: liveMaps({ lightning: !!app.lightning }), liveOn: { satellite: !!S.layers.clouds, radar: !!S.layers.radar, lightning: !!S.layers.lightning },
        forecast: forecastMaps(FIELDS.map((f) => ({ ...f, about: fieldLine(f.id) }))), fmap: S.fmap, fmapOn: S.fmapOn, modelName,
        precipSub: `${modelName} on this phone, the next 90 minutes; then NOAA’s 15-minute steps (about ${mb(hourBytes('precip'))} MB an hour) · Experimental`,
        satModes: typeof clouds.mode === 'function', satMode: S.satMode },
      { onLive: (id, v) => liveMap(id, v), onForecast: (id) => setForecastMap(id, !!id), onModel: () => { closeSheet(); picker.open(); },
        onSatMode: (m) => { S.satMode = m; saveLayers(); if (clouds.mode) clouds.mode(m); if (S.layers.clouds) cloudsOn(); }, details: (sec) => mapDetails(sec) });
      // v017's radar and nowcast settings, folded under the groups
      const more = mk('details', 'nc-lp-more'); more.append(mk('summary', null, 'Radar and nowcast settings')); b.append(more);
      if (app.ssListed && app.ssListed()) {   // PILOT (v056): the second model
        if (S.model === 'stormscope') {   // v057: the layers it needs, kept fresh while this screen is open
          const st = S.ssStat, mbh = st && st.mbPerHour ? Math.round(st.mbPerHour) : 0;   // Nov-08: its switch folded into "Keep forecasts fresh"
          more.append(fresh.row(document, { model: 'stormscope', note: `${mbh ? `This session: about ${mbh} MB an hour. ` : ''}Old layers are dropped as new ones land.` }));
        }
      }
      if (B && S.model === 'beam' && B.ready()) more.append(fresh.row(document, { rain: !!app.ready(), note: beamFreshNote() }));   // v009; Nov-08: the choice (cadence.js)
      more.append(sw('Rain or snow', S.layers.type, (v) => { S.layers.type = v; saveLayers(); S.frames.clear(); loadRadar(true); fields.repaint(); paintLegend(); }, 'On the radar and NOAA\'s forecast hours, from NOAA\'s precipitation type'));
      more.append(mk('p', 'nc-sub', 'The nowcast shows'));
      more.append(seg([['rate', 'Average of runs'], ['one', 'One possible future'], ['chance', 'Chance of rain']], S.mode, (v) => { S.mode = v; saveLayers(); show(S.idx); }));
      more.append(mk('p', 'nc-sub', 'Chance of rain over'));
      more.append(seg([[1, '1 mm/h · light'], [4, '4 · moderate'], [8, '8 · heavy']], S.thr, (v) => { S.thr = v; saveLayers(); show(S.idx); }));
      more.append(mk('p', 'nc-sub', 'Runs per nowcast'));
      more.append(seg([[4, '4 · more reliable'], [1, '1 · quicker']], S.members, (v) => { S.members = v; saveLayers(); }));
      more.append(sw('Nowcast a wider area', S.wide, (v) => { S.wide = v; saveLayers(); }, `3 × 3 areas, 512 km across at 2 km${lsGet().msPerRun ? ` · about ${Math.round(S.members * 9 * lsGet().msPerRun / 10) * 10} s on this device` : ' · nine times as long as one area'}`));
      more.append(mk('p', 'nc-sub', 'Radar loop'));
      const sizes = (m) => { if (!S.av) return ''; const pl = radar.loopPlan(S.av, { minutes: m, step: 10, typed: S.layers.type }); return ` · ${MB(pl.bytes)}`; };
      more.append(seg([[30, '30 min' + sizes(30)], [60, '1 h' + sizes(60)], [90, '90 min' + sizes(90)]], S.loopMin, (v) => { S.loopMin = v; saveLayers(); loadRadar(true); }));
      more.append(mk('p', 'footnote nc-fine', 'Each radar frame is NOAA\'s whole-US file (about 1.1 MB, + 0.25 MB for rain or snow), downloaded when this screen opens and kept only while the app is open. A nowcast needs 6 frames (about 7 MB), most of them shared with the loop.'));
    }, 'layers');
  }
  /** a live map switched (Layers): the radar loop, the satellite (v017's Clouds), lightning where the app has it */
  function liveMap(id, v) {
    if (id === 'radar') { S.layers.radar = v; saveLayers(); buildItems(); show(nowIndex() >= 0 ? nowIndex() : 0); }
    else if (id === 'satellite') { S.layers.clouds = v; saveLayers(); if (v) { if (clouds.mode) clouds.mode(S.satMode); cloudsOn(); } else { map.set('clouds', null); S.cloud = null; renderTl(); } }
    else if (id === 'lightning') { S.layers.lightning = v; saveLayers(); if (app.lightning && app.lightning.on) app.lightning.on(v); }
    paintLegend();
  }
  /** Layers › Map details: the presets, the basemap, roads, public land, lot lines, My layers, water / fire / farm, NWS warnings, my
   *  location, the county map saved on this phone (Settings › Counties for the others) */
  function mapDetails(b) {
    let pp = null;
    const v8sw = (k, label, sub) => sw(label, S.layers[k], (v) => { S.layers[k] = v; S.preset = presetMatching(S.layers); saveLayers(); v008On(); if (pp) pp.setCurrent(S.preset); render(); }, sub);
    if (BM()) {
      pp = createPresetPicker({ current: presetMatching(S.layers), onPick: (p) => applyPreset(p.id) }); b.append(pp);   // v008: the presets
      b.append(mk('p', 'nc-sub', 'Map'));
      b.append(seg(Object.entries(BASEMAPS).map(([k, v]) => [k, v.label]), S.basemap, (v) => { S.basemap = v; saveLayers(); map.setSources(BASEMAPS[v].sources); creditLine(); }));
      b.append(sw('Roads', S.layers.roads, (v) => { S.layers.roads = v; saveLayers(); roadsOn(); },
        'Highways from county-wide zoom; county and numbered Forest Service roads closer in (USGS)'));   // v011: roads from zoom 8
      if (lands) b.append(sw('Public land', S.layers.lands, (v) => { S.layers.lands = v; saveLayers(); landsOn(); },
        'National Forest and Wilderness in Forest Service brown, BLM land in yellow. Tap an area for its name. Not a survey'));
      else if (county) b.append(notYet('Public land'));
      if (parcels) b.append(sw('Lot lines', S.layers.parcels, (v) => { S.layers.parcels = v; saveLayers(); parcelsOn(); }, CL.words.layer));
      else if (county) b.append(notYet('Lot lines', CL.words.layer));   // v014: a county whose lot lines aren't in the app (terms unclear)
      { const mySec = mk('div'); b.append(mySec); mine.listInto(mySec); }   // v008: My layers
      b.append(mk('p', 'nc-sub', 'Water, fire and farm'));
      if (drains) b.append(v8sw('drainages', 'Drainages', 'The HUC-12 drainages that reach into the county (USGS). A storm’s heavy rain flags the ones that may see high water'));
      else if (county) b.append(notYet('Drainages'));
      if (gaugesL) b.append(v8sw('gauges', 'Stream gauges', 'USGS gauges near the county: flow and its trend, every 15 minutes while on. Provisional data'));
      if (firesL) b.append(v8sw('fires', 'Current fires', 'Wildfires the agencies report (NIFC), with perimeters. Not an evacuation notice'));
      if (fwx) b.append(v8sw('firewx', 'Fire weather', 'National Weather Service Red Flag Warnings and Fire Weather Watches for the county’s fire zones'));
      else if (county) b.append(notYet('Fire weather'));
    }
    b.append(sw('NWS warnings', S.layers.warnings, (v) => { S.layers.warnings = v; saveLayers(); loadWarnings(); }, 'Tornado, severe thunderstorm and flash flood outlines'));
    if (BM()) {
      b.append(sw('My location (GPS)', S.layers.gps, (v) => { S.layers.gps = v; saveLayers(); gpsOn(true); },
        'A blue dot where you are and a cone the way your phone points. Works with no cell service. Tap the dot for your coordinates. Your exact position stays on this phone; the map around it loads like any map.'));
      if (county) {   // v014: the active county's saved map (Settings › Counties lists them all)
        const c = county;
        // v019: its size, and that it never downloads by itself (Download all holds the app's own county's)
        b.append(sw('Keep the county map on this phone', keptOf(c.id), (v) => setKept(c.id, v),
          `Satellite, roads and topo maps of ${c.short}${c.lands ? ', with topo close-ups of the wilderness' : ''}, so the map opens fast and works with no signal`
          + (maps ? `. About ${mapMb(c.id)} MB. It downloads only when you switch it on${c === CTY[0] ? ' or use Download all' : ''}.` : '')));
        sheetOffline = mk('p', 'footnote', offlineLine()); b.append(sheetOffline);
        if (maps) { const cl = btn('nc-link', 'Counties kept on this phone: Settings › Counties'); cl.onclick = () => openSettings('counties'); b.append(cl); }
      }
    }
  }
  // ---------------------------------------------------------------------------------------------- v018: the forecast maps (one at a time)
  // v018 review: typed - Precipitation's hours follow "Rain or snow" like the radar
  const fields = createFields({ map, fetchFn: (...a) => fetch(...a), onChange: (why) => fieldsChanged(why), cadence: fresh, typed: () => !!S.layers.type });
  /** v018 merge: a forecast map's line in Layers (its full words are in FIELDS' about): where it comes from, how far ahead, and its data
   *  for an hour of this view (fields/budget.js; the wind reads only the view's rows of 64-row blocks, HRRR's grid about 0.027 degree) */
  function fieldLine(id) {
    let rows = 1059;
    try { const v = map.view(); if (v) rows = Math.min(1059, (Math.ceil((v[3] - v[1]) / 0.027 / 64) + 1) * 64); } catch (e) { /* the whole grid */ }
    // v020: their data is hourly; the map shows it every 15 minutes, blended between the hours on the phone (no more data)
    return `NOAA HRRR hourly, shown every 15 min · about ${mb(hourBytes(id, { rows }))} MB an hour you look at · Experimental`;
  }
  /** the field the fields module draws: the forecast map on ('precip' = precipitation's hours after the nowcast), else none */
  const fieldId = () => (S.fmapOn && S.fmap ? S.fmap : null);
  /** a field map other than precipitation (its own bar in the key; drawn under the radar's frames too) */
  const fieldOn = () => { const f = fieldId(); return f && f !== 'precip' ? f : null; };
  // v018 review: Precipitation is picked hidden - drawn only on its own hours (show(t)), never at the hour nearest now by set() before the
  // radar's first frame (HRRR's rain in the radar's colours, read as radar) and its messages not read until then
  function syncFields() { const want = fieldId(); if (fields.active() !== want) { if (want === 'precip') fields.show(null); fields.set(want); } }
  /** the fields module's news. v018 merge: it tells us synchronously, from inside fields.show() ('loading', 'shown', 'error'): those only
   *  repaint the time bar's words and the key - showing the frame from here would call fields.show() inside itself, round and round.
   *  New hours ('times', a newer run) rebuild the time bar and show the frame. */
  function fieldsChanged(why) {
    if (!S.open) return;
    if (why === 'times' || why === 'run') { buildItems(); if (S.items[S.idx] && !S.example) show(S.idx); else renderTl(); }
    else renderTl();
    paintLegend();
  }
  /** a forecast map picked (Layers, the quick button): one at a time - Precipitation is the model's nowcast (the Nowcast switch of v017),
   *  a field replaces it; id null = none (the map picked last stays, for the quick button) */
  function setForecastMap(id, on = true) {
    if (id) S.fmap = id;
    S.fmapOn = !!id && !!on; S.layers.nowcast = S.fmapOn && S.fmap === 'precip';
    saveLayers(); syncFields();
    map.set('alerts', S.layers.nowcast && S.run && S.run.ss ? S.run.ss.alerts || [] : []);
    buildItems(); if (S.open && !S.example) show(S.idx >= 0 && S.items[S.idx] ? S.idx : nowIndex());
    beamDrains(); render();
  }
  function quickMap() { setForecastMap(S.fmap || 'precip', !S.fmapOn); }
  function paintFab() {
    const id = S.fmap || 'precip', F = id === 'precip' ? { name: 'Precipitation' } : FIELDS.find((f) => f.id === id) || { name: 'Forecast' };
    if (fab.dataset.map !== id) { fab.replaceChildren(icon(mapIcon(id))); fab.dataset.map = id; }
    fab.setAttribute('aria-pressed', String(!!S.fmapOn)); fab.classList.toggle('on', !!S.fmapOn);
    fab.setAttribute('aria-label', `${F.name} map, ${S.fmapOn ? 'on' : 'off'}`);
  }
  layersB.onclick = openLayers;
  function openSearch() {
    openSheet((b) => {
      b.append(mk('h2', 'nc-h', 'Find a place'));
      const inp = mk('input', 'nc-input'); inp.type = 'search'; inp.placeholder = 'A US town or a ZIP code'; inp.setAttribute('aria-label', 'A US town or a ZIP code'); inp.autocomplete = 'off';
      const list = mk('div', 'nc-results'), note = mk('p', 'footnote nc-fine', 'Searched on this phone, in the US Census Bureau\'s list of towns and ZIP codes: nothing you type is sent anywhere.');
      b.append(inp, list, note);
      const go = async () => {
        list.textContent = ''; const q = inp.value.trim(); if (q.length < 2) return;
        const geo = S.geo || (await app.geo()); let res = [];
        if (/^\d{5}$/.test(q)) { const z = geo.zcta.find(q); if (z) res = [{ name: `ZIP ${z.zip}`, region: '', lat: z.lat, lon: z.lon }]; }
        else res = app.searchPlaces(geo, q, 8);
        if (!res.length) { list.append(mk('p', 'footnote', 'US towns and ZIP codes only for now.')); return; }
        for (const e of res) { const r = btn('nc-res', `${e.name}${e.region ? ', ' + e.region : ''}`); r.onclick = () => { closeSheet(); setPlace({ lat: e.lat, lon: e.lon, label: `${e.name}${e.region ? ', ' + e.region : ''}` }, 7.6); }; list.append(r); }
      };
      inp.oninput = () => { clearTimeout(inp.t); inp.t = setTimeout(go, 160); };
      setTimeout(() => inp.focus(), 60);
    }, 'search');
  }
  searchB.onclick = openSearch;
  locB.onclick = () => {   // the person asked: the location prompt is fine here. v006: it also turns on "My location" (the dot and the
    // compass cone); once that has a fix, a tap centres the map on it
    if (!navigator.geolocation) return app.toast('This browser can’t share your location.');
    gps.askCompass();
    if (S.layers.gps && gps.fix) {   // v007: centred already -> "Where you are"
      if (pxFromMe(gps.fix, map.state.lat, map.state.lon, map.state.z) < 30) openWhere(); else map.center(gps.fix.lat, gps.fix.lon, Math.max(map.state.z, 12));
      return;
    }
    if (!S.layers.gps) { S.layers.gps = true; saveLayers(); gpsOn(false); gpsCentred = true; }
    navigator.geolocation.getCurrentPosition((pos) => { const lat = Math.round(pos.coords.latitude * 100) / 100, lon = Math.round(pos.coords.longitude * 100) / 100; map.set('here', { lat, lon }); setPlace({ lat, lon, label: 'Your location' }, Math.max(map.state.z, 12)); },
      (err) => { if (err && err.code === 1) app.toast('Your location is off for this app (your phone’s settings).'); }, { maximumAge: 120e3, timeout: 60e3 });
  };
  // PILOT: each StormScope frame shows the moment it exists; the loop grows (buildItems counts run.ready)
  if (app.onPartial) app.onPartial((r) => {
    if (!S.place || Math.abs(r.lat - S.place.lat) > 0.05 || Math.abs(r.lon - S.place.lon) > 0.05) return;
    const first = r.ready === 1; setRun(r);
    if (first && S.open) { const fi = S.items.findIndex((x) => x.kind === 'nowcast'); if (fi >= 0) show(fi); }
  });
  function offerSsDownload() {
    openSheet((b) => {
      b.append(mk('h2', 'nc-h', 'StormScope (pilot)'));
      b.append(mk('p', null, `NVIDIA's StormScope reads the radar, the GOES satellite and its lightning mapper, and shows storms for the next 90 minutes, worked out on this phone: ${MB(app.ssSize())}, downloaded once. A pilot: not retrained, and less sure where radar can't see.`));
      b.append(mk('p', 'footnote', 'Licensed by NVIDIA Corporation under the NVIDIA Open Model License. Modified for this app: quantised to 8-bit integers and run as WebGPU kernels.'));
      const d = app.ssDl(), go = btn('nc-btn', d && d.running ? `Downloading · ${Math.floor(100 * (d.pct || 0))}%` : `Download · ${MB(app.ssSize())}`);
      go.disabled = !!(d && d.running); go.onclick = () => { app.ssDownload(); closeSheet(); render(); }; b.append(go);
    }, 'download');
  }
  function offerDownload() {
    openSheet((b) => {
      const sz = app.sizeOf(), prec = app.precision ? app.precision() : 'float';
      b.append(mk('h2', 'nc-h', 'The nowcast model'));
      b.append(mk('p', null, `DeepMind's DGMR, a model for the next 90 minutes of rain, runs on this phone: ${MB(sz)}, downloaded once.${prec === 'int8' ? ' This device gets the smaller 8-bit model, which needs less memory.' : ''}`));
      b.append(mk('p', null, 'It was trained on UK radar, so on US radar it is an experiment: it can be wrong, and it is no substitute for National Weather Service warnings.'));
      const lic = mk('p', 'footnote'), a = mk('a', null, 'CC BY 4.0'); a.href = DGMR.licence.url; a.target = '_blank'; a.rel = 'noopener';
      const s = mk('a', null, 'DeepMind'); s.href = DGMR.licence.source; s.target = '_blank'; s.rel = 'noopener';
      lic.append(`${DGMR.licence.holder}. The model is licensed under `, a, ` by `, s, `. ${DGMR.licence.changes}`); b.append(lic);
      b.append(mk('p', 'footnote', 'Keep the app open while it downloads. Each nowcast also downloads about 7 MB of NOAA radar.'));
      const go = btn('nc-btn', `Download · ${MB(sz)}`); go.onclick = () => { app.download(); closeSheet(); render(); }; b.append(go);
    }, 'dl');
  }
  async function openForecast(p) {
    if (!p.label) p.label = nearest(p.lat, p.lon);
    map.set('pick', { lat: p.lat, lon: p.lon });
    openSheet((b) => {
      const h = mk('div', 'nc-fc-head'), t = mk('h2', 'nc-h', p.label), nb = btn('nc-btn sm', 'Nowcast here');
      nb.onclick = () => { closeSheet(); setPlace(p); nowcast(p); };
      h.append(t, nb); b.append(h);
      const nx = mk('div', 'nc-fc-now');
      const s = S.model !== 'beam' && S.run ? summaryAt(S.run, p.lat, p.lon) : null, bh = S.model === 'beam' && beamFresh() ? beamHere(BL.frame, p) : '';   // v009
      nx.append(mk('p', 'nc-sub', bh ? 'Next 90 minutes · BEAM · Experimental' : 'Next 90 minutes · Nowcast · Experimental'), mk('p', null, bh || (s ? s.text : inConus(p.lat, p.lon) ? 'Outside the nowcast area. "Nowcast here" works it out on this phone.' : 'The nowcast covers the lower 48 states only.')));
      if (s && s.snowNote) nx.append(mk('p', 'footnote', s.snowNote));
      const al = mk('div', 'nc-fc-alerts'), list = mk('div', 'nc-fc-list');
      list.append(mk('p', 'footnote', 'Getting the forecast…'));
      b.append(al, nx, list, Object.assign(mk('p', 'footnote nc-credit'), { textContent: NWS_LINE }));
      { const frl = btn('nc-link', 'What do you see here? Send a field report'); frl.onclick = () => openFieldReport(p); b.insertBefore(frl, list); }   // FIELD REPORT (fieldkit)
      nws.at(p.lat, p.lon).then((A) => { for (const a of A.slice(0, 4)) { const x = btn('nc-alert', null); x.style.setProperty('--wc', a.color); x.append(icon('alert', 'nc-ic sm', 18), mk('b', null, a.event), mk('span', 'footnote', a.headline || '')); x.onclick = () => openAlert(a); al.append(x); } }, () => {});
      nws.forecast(p.lat, p.lon).then((fc) => {
        list.textContent = '';
        if (fc.outside) { list.append(mk('p', null, 'The National Weather Service has no forecast for this place.')); return; }
        for (const per of fc.periods) {
          const row = btn('nc-per' + (per.day ? '' : ' night'), null);
          const ic = icon(weatherIcon(per.short, per.day), 'nc-wic', 28), tx = mk('span', 'nc-per-t'), tp = mk('b', 'nc-per-temp', `${per.temp}°${per.unit || 'F'}`);
          tx.append(mk('b', null, per.name), mk('span', null, per.short), mk('span', 'footnote', [per.pop != null ? `${per.pop}% chance of rain or snow` : '', per.wind ? `wind ${per.wind}` : ''].filter(Boolean).join(' · ')));
          row.append(ic, tx, tp);
          const det = mk('p', 'nc-per-d footnote', per.detail || per.short); det.hidden = true;
          row.onclick = () => { det.hidden = !det.hidden; row.classList.toggle('open', !det.hidden); };
          list.append(row, det);
        }
      }, () => { list.textContent = ''; list.append(mk('p', null, 'The National Weather Service could not be reached just now.')); });
    }, 'fc');
  }
  function openAlert(a) {
    const A = a || (S.alerts || []).find((x) => /warning/i.test(x.event)); if (!A) return;
    openSheet((b) => {
      const h = mk('h2', 'nc-h nc-alert-h', A.event); h.style.setProperty('--wc', A.color); b.append(h);
      if (A.headline) b.append(mk('p', null, A.headline));
      if (A.instruction) b.append(mk('p', null, A.instruction));
      if (A.area) b.append(mk('p', 'footnote', A.area));
      if (A.rings && A.rings.length) b.append(warnPost({ words: () => nwsWords(A), rings: A.rings, title: A.event, sub: 'National Weather Service · shared with Wallowa Weather', name: 'nws-warning' }));   // v020
      b.append(mk('p', 'footnote', OFFICIAL));
      const l = mk('a', 'nc-link', 'weather.gov'); l.href = 'https://www.weather.gov/'; l.target = '_blank'; l.rel = 'noopener'; b.append(l);
    }, 'alert');
  }
  /** the fine print, behind the card's "?": the warnings line, the label, how accurate it is, and every credit */
  function openInfo() {
    openSheet((b) => {
      b.append(mk('h2', 'nc-h', 'About this map'));
      b.append(mk('p', 'nc-exp', (S.model === 'beam' ? (B ? 'Experimental · BEAM, made for this app, runs on this phone (hail shown recalibrated; storm cones in the example storms only)' : 'Experimental · BEAM, made for this app (example storms until it runs on this phone)') : S.model === 'stormscope' ? 'Experimental · NVIDIA StormScope, trained on the central and eastern US' : DGMR.label)), mk('p', null, OFFICIAL));
      if (S.model === 'beam' && B) b.append(mk('p', 'footnote', 'BEAM live: the chance of each hazard in the next 0–30, 30–60 and 60–90 minutes (the time control), over the newest radar; the line is BEAM’s frozen warning level. Hail is shown recalibrated (the chance it really came, from the blind tests); the others as the model gives them. Storm cones are in the example storms only: a live cone needs each storm tracked from run to run.'));   // v009
      const how = btn('nc-link', 'How accurate is this?'); how.onclick = () => openAccuracy(); b.append(how);
      const frl = btn('nc-link', 'Send a field report: what you see here'); frl.onclick = () => openFieldReport(); b.append(frl);   // FIELD REPORT (fieldkit)
      const now = onScreenCredits(); if (now) b.append(mk('p', 'nc-sub', 'On the map now'), mk('p', 'footnote', now));   // v008: was the map's corner line
      b.append(mk('p', 'nc-sub', 'Licenses and credits'), creditsNode());
      if (parcels) b.append(mk('p', 'footnote', CL.words.note));
      if (lands) b.append(mk('p', 'footnote', LANDS_NOTE));
      if (BM()) b.append(mk('p', 'footnote', ROADS_NOTE));
      if (BM()) for (const n of [drains && drains.note, GAUGES_NOTE, FIRES_NOTE, fwx && fwx.note]) if (n) b.append(mk('p', 'footnote', n));   // v008; v014: the county's
    }, 'info');
  }
  function openAccuracy() {
    openSheet((b) => {
      b.append(mk('h2', 'nc-h', 'How accurate is this?'));
      for (const p of SKILL.intro) b.append(mk('p', null, p));
      for (const tb of SKILL.tables) {
        b.append(mk('p', 'nc-sub', tb.title));
        const t = mk('table', 'nc-skill'), hr = mk('tr'); for (const c of tb.head) hr.append(mk('th', null, c)); t.append(hr);
        for (const r of tb.rows) { const tr = mk('tr'); r.forEach((c, i) => tr.append(mk(i ? 'td' : 'th', null, c))); t.append(tr); }
        b.append(t); if (tb.note) b.append(mk('p', 'footnote', tb.note));
      }
      for (const p of SKILL.outro) b.append(mk('p', 'footnote', p));
    }, 'acc');
  }

  // ---------------------------------------------------------------------------------------------- FIELD REPORT (fieldkit, Nov-2026)
  // A tester's report of what they see (nowcast/report.js, loaded the first time one opens: the map never waits for it), from Settings ›
  // Field report, the "?" sheet or a place's sheet. It reads only what the screen already has (no request) and sends nothing itself.
  const fieldState = () => ({ model: S.model, place: S.place, run: S.run, beamFrame: BL.frame, radarNewest: (S.av && S.av.newest) || null, radarErr: S.err,
    radarFrame: S.plan && S.plan.times.length ? S.frames.get(S.plan.times[S.plan.times.length - 1]) || null : null,
    alerts: S.alerts, alertsAt: S.alertsAt || null, warnings: S.layers.warnings ? S.warnings : [], places: S.places, gps: gps.fix, toScreen: (la, lo) => map.toScreen(la, lo) });
  function fieldReport(el, place = null, heading = true) {
    const st = app.settings || {};
    // v019: countyOf - a public post names the county where no town is within 20 miles (never coordinates)
    import('./report.js').then((m) => m.fillReport(el, { state: fieldState, place, snapshot: (o) => map.snapshot(o), snapshotAt: (v, o) => map.snapshotAt(v, o), zoom: () => map.state.z, center: () => ({ lat: map.state.lat, lon: map.state.lon }), countyOf: (la, lo) => { const c = cAt(la, lo); return c ? c.name : ''; }, toast: app.toast, heading, version: st.version, device: st.device, models: st.models }))
      .catch((e) => { app.diag('field report', { message: String((e && e.message) || e).slice(0, 160) }); el.append(mk('p', 'footnote', 'The field report could not open. Settings › Diagnostics has the details.')); });
  }
  function openFieldReport(place = null) { openSheet((b) => fieldReport(b, place, true), 'report'); }

  // ---------------------------------------------------------------------------------------------- BENCH TEST (Nov-08-2026)
  // Settings › Bench test (nowcast/bench.js, loaded the first time it opens: the map never waits for it): each model on this phone
  // through the app's queue (nowcast_app.js benchStep), the device's checks, a card to copy or share. Nothing is downloaded or sent.
  function benchPage(el) {
    const st = app.settings || {};
    import('./bench.js').then((m) => m.fillBench(el, { version: st.version, installed: st.installed, models: st.models || {}, step: app.benchStep, toast: app.toast, diag: app.diag }))
      .catch((e) => { app.diag('bench test', { message: String((e && e.message) || e).slice(0, 160) }); el.append(mk('p', 'footnote', 'The bench test could not open. Settings › Diagnostics has the details.')); });
  }

  // ---------------------------------------------------------------------------------------------- v057: StormScope's layers kept fresh
  // Nov-08: on when "Keep forecasts fresh" is (S.ssFresh, the old switch, migrated into it); refreshed only when its cadence says so
  // (cadence.js layersDue: 10 min on Wi-Fi as before, at most every 30 on cellular / Data Saver / "Every 30 min"); Off: a run fetches them
  const ssOn = () => S.open && S.place && S.model === 'stormscope' && !!fresh.everyMin() && app.ssLayers && app.ssListed && app.ssListed() && app.ssReady();
  function ssKeepFresh() { if (!app.ssLayers) return; if (ssOn() && inConus(S.place.lat, S.place.lon) && (!app.area || app.area.contains(S.place.lat, S.place.lon))) app.ssLayers.start(S.place, { due: (t0) => fresh.layersDue(t0, { hidden: hiddenNow() }) }); else app.ssLayers.stop(); }
  if (app.ssLayers) app.ssLayers.onChange((st) => { S.ssStat = st; if (S.open && !S.running) render(); });
  function layersLine(st) {
    if (st.err && !st.ready) return `StormScope's layers couldn't be fetched: ${st.err}`;
    if (!st.ready) return st.busy ? 'Getting StormScope’s layers (radar, satellite, lightning)…' : '';
    return `StormScope's layers are ready · radar ${clock(st.t0)}${st.lastBytes ? ` · last refresh ${(st.lastBytes / 1e6).toFixed(1)} MB in ${(st.lastMs / 1000).toFixed(1)} s` : ''}${st.busy ? ' · refreshing…' : ''}`;
  }
  // ---------------------------------------------------------------------------------------------- place + open / close
  function setPlace(p, z) {
    const moved = !S.place || Math.abs(S.place.lat - p.lat) > 0.5 || Math.abs(S.place.lon - p.lon) > 0.5;
    S.place = { lat: p.lat, lon: p.lon, label: p.label }; lsSet({ place: S.place });
    if (z) map.center(p.lat, p.lon, z);
    map.set('pick', null);
    if (!map.get('here') || map.get('here').lat !== p.lat) map.set('here', { lat: p.lat, lon: p.lon });
    syncCounty();   // v014: a place in another county: its layers come with it
    loadRun(); loadWarnings(); if (moved) loadRadar(); ssKeepFresh(); render();   // v011: the old frames stay until the new place's come in
  }
  return {
    get shown() { return S.open; },
    /** open the screen; o: { lat, lon, label, run (id), sheet: 'forecast' } */
    async open(o = {}) {
      S.open = true; syncFields(); render();
      await loadStatic();
      const p = await where(o);
      if (p) { S.place = { lat: p.lat, lon: p.lon, label: p.label }; lsSet({ place: S.place }); map.set('here', { lat: p.lat, lon: p.lon }); map.center(p.lat, p.lon, 7.4); }
      else map.fit(24.5, -125, 49.5, -66.9);
      syncCounty();   // v014
      ssKeepFresh();   // v057: the layers start the moment the screen opens
      if (o.run) { const r = await getRun(o.run); if (r) setRun(r); } else await loadRun();
      if (S.model === 'beam') await beamRestore();   // v011: the last BEAM run, while it is still within its 90 minutes
      render(); loadWarnings(); follow();
      if (S.layers.clouds) cloudsOn();
      await loadRadar(Date.now() - S.loadedAt > 4 * 60e3);
      if (o.sheet === 'forecast' && p) openForecast(p);
      scheduleBeam();   // v009
    },
    close() { S.open = false; stop(); closeSheet(); if (beam.active) beam.close(); if (rainEx.active) rainEx.close(); if (radar.abort) radar.abort(); if (app.ssLayers) app.ssLayers.stop(); beamRelease(); },
    /** v008: open BEAM's example storms (the picker / a link) */
    beamExamples: () => openBeamExamples(), examples: (model) => openModelExamples(model), beamOpen: (id) => { exampleOn('beam'); return exampleOpened(beam.open(id), beam); },
    /** the app's download moved on: the card shows it */
    refresh() { ssKeepFresh(); render(); picker.refresh(); if (settingsCtl) settingsCtl.refresh(); if (S.model === 'beam' && !BL.timer && !BL.run) scheduleBeam(); },   // v057: a finished StormScope download starts its layers; v008: the picker and Settings follow; v009: BEAM's refresh
    openSettings: (start) => openSettings(start),
    /** v019: the app's own county's saved map for Download all (ww.js): item() its line, download({ signal }); null where maps can't be saved */
    countyMap: maps ? { item: () => mapItem(), download: (o) => downloadMap(o) } : null,
    /** a run finished outside the view (the queue's): show it if it is for this place */
    showRun: setRun,
    /** v018: the forecast maps (fields/), for the app and its tests */
    get fields() { return fields; },
    destroy() { stop(); fields.destroy(); mine.destroy(); map.destroy(); radar.drop(); },
  };
}
