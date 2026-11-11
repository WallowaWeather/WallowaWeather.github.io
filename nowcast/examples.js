// nowcast/examples.js - Wallowa Weather v011: the rain models' recorded example storms, including
// the Aug 11, 2022 Wallowa hailstorm. BEAM keeps its own player (beam.js); DGMR and StormScope play here: what the model forecast from
// the radar of that moment (+5 ... +90 min) next to what the radar saw then, the model's credit, and "Experimental". v018 examples: on
// the live map's own controls (the view's time bar and folding card draw what ui() describes; the top key explains the colours).
// The files (data/rain_examples, format 'ww-rain-example' v1, recorded ahead of time) hold one byte a pixel in 8-bit grey PNGs: rain = the app's own colour code (colors.js levelOf),
// chance = 0..255. DGMR's were recorded with the app's own engine and radar reader, the same steps as a run on the phone.
import { icon } from './icons.js';
import { codeLut, chanceLut, levelOf } from './colors.js';
import { modelById, EXPERIMENTAL, FOLLOW_NWS } from './models_info.js';

const BASE = new URL('./data/rain_examples/', import.meta.url).href;
export const FORMAT = 'ww-rain-example';
export const MODELS = ['dgmr', 'stormscope'];
const R_EARTH = 6371.0, DEG = 180 / Math.PI, RAD = Math.PI / 180;
const OUTLINE_LEVEL = levelOf(1);   // "what happened" outline: rain of 1 mm/h or more
const CHANCE_MIN = 26;              // as the map: no tint under 10 %
const mk = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
const btn = (cls, label, ic) => { const b = mk('button', cls); b.type = 'button'; if (ic) b.append(icon(ic, 'nc-ic sm', 18)); if (label) b.append(mk('span', null, label)); return b; };
const PNG = 'data:image/png;base64,';
/** Web Mercator CSS px of a point relative to the map centre at zoom z (map.js's own formula) */
function toScreenAt(st, lat, lon) {
  const wx = (lo) => ((lo + 180) / 360) * 256 * 2 ** st.z, wy = (la) => { const q = Math.sin(Math.max(-85, Math.min(85, la)) * RAD); return (0.5 - Math.log((1 + q) / (1 - q)) / (4 * Math.PI)) * 256 * 2 ** st.z; };
  return { x: wx(lon) - wx(st.lon), y: wy(lat) - wy(st.lat) };
}

/** a model's box (regrid.js boxProjection: n x n pixels km apart, centred on lat / lon) as the lat / lon grid the map draws */
export function exampleGrid({ lat, lon, size: n, km }) {
  const half = (n - 1) / 2, kx = R_EARTH * Math.cos(lat * RAD);
  const top = lat + ((half + 0.5) * km / R_EARTH) * DEG, left = lon + ((-0.5 - half) * km / kx) * DEG;
  const bot = lat + ((half - n + 0.5) * km / R_EARTH) * DEG, right = lon + ((n - 0.5 - half) * km / kx) * DEG;
  return { top, left, dlat: (top - bot) / n, dlon: (right - left) / n, rows: n, cols: n };
}

/** the problems with an example file (an empty list = it can be played). Pure: the unit test and the player use it */
export function checkExample(ex) {
  const bad = [], need = (c, m) => { if (!c) bad.push(m); };
  if (!ex || typeof ex !== 'object') return ['not an object'];
  need(ex.format === FORMAT && ex.v === 1, 'format');
  need(MODELS.includes(ex.model), 'model');
  need(typeof ex.id === 'string' && ex.id.startsWith(ex.model + '-'), 'id');
  need(/^\d{4}-\d{2}-\d{2}$/.test(ex.date || ''), 'date');
  need(typeof ex.title === 'string' && ex.title.length > 0, 'title');
  need(Number.isFinite(ex.t0), 't0');
  need(ex.place && typeof ex.place.name === 'string' && Number.isFinite(ex.place.lat) && Number.isFinite(ex.place.lon), 'place');
  const b = ex.box || {};
  need(Number.isInteger(b.size) && b.size > 0 && b.km > 0 && Number.isFinite(b.lat) && Number.isFinite(b.lon), 'box');
  if (ex.box && ex.grid) {
    const g = exampleGrid(b), close = (x, y, tol) => Math.abs(x - y) <= tol;
    need(ex.grid.rows === b.size && ex.grid.cols === b.size && close(ex.grid.top, g.top, 1e-5) && close(ex.grid.left, g.left, 1e-5)
      && close(ex.grid.dlat, g.dlat, 1e-7) && close(ex.grid.dlon, g.dlon, 1e-7), 'grid (not the box)');
  } else bad.push('grid');
  need(Number.isFinite(ex.firstMin) && Number.isFinite(ex.everyMin) && ex.everyMin > 0, 'minutes');
  need(typeof ex.now === 'string' && ex.now.startsWith(PNG), 'now');
  need(Array.isArray(ex.frames) && ex.frames.length > 0 && (ex.firstMin + (ex.frames.length - 1) * ex.everyMin) === 90, 'frames (to +90 min)');
  (ex.frames || []).forEach((f, k) => {
    if (f.min !== ex.firstMin + k * ex.everyMin) bad.push(`frame ${k}: min`);
    if (f.t !== ex.t0 + f.min * 60e3) bad.push(`frame ${k}: t`);
    if (f.fc != null && !(typeof f.fc === 'string' && f.fc.startsWith(PNG))) bad.push(`frame ${k}: fc`);
    if (f.obs != null && !(typeof f.obs === 'string' && f.obs.startsWith(PNG))) bad.push(`frame ${k}: obs`);
    if (f.chance != null && (ex.model !== 'dgmr' || !(typeof f.chance === 'string' && f.chance.startsWith(PNG)))) bad.push(`frame ${k}: chance`);
  });
  need(typeof ex.credit === 'string' && ex.credit.length > 0, 'credit');
  return bad;
}
export const hasForecast = (ex) => !!(ex && ex.frames && ex.frames.some((f) => f.fc));

/** a PNG data URL (8-bit grey) -> Uint8Array of its values */
async function pngValues(url, rows, cols) {
  const img = new Image(); img.src = url; await img.decode();
  const c = Object.assign(document.createElement('canvas'), { width: cols, height: rows }), g = c.getContext('2d', { willReadFrequently: true });
  g.drawImage(img, 0, 0); const d = g.getImageData(0, 0, cols, rows).data, out = new Uint8Array(rows * cols);
  for (let i = 0; i < out.length; i++) out[i] = d[i * 4];
  return out;
}
function paint(vals, n, lut, into, min = 1) {
  const c = into && into.width === n ? into : Object.assign(document.createElement('canvas'), { width: n, height: n });
  const g = c.getContext('2d'), im = g.createImageData(n, n);
  for (let i = 0; i < vals.length; i++) { const v = vals[i]; if (v < min) continue; const o = v * 4; im.data[i * 4] = lut[o]; im.data[i * 4 + 1] = lut[o + 1]; im.data[i * 4 + 2] = lut[o + 2]; im.data[i * 4 + 3] = lut[o + 3]; }
  g.putImageData(im, 0, 0); return c;
}
const dateOf = (t) => new Date(t).toLocaleDateString('en-US', { timeZone: 'America/Los_Angeles', month: 'short', day: 'numeric', year: 'numeric' });
const clock = (t) => new Date(t).toLocaleTimeString('en-US', { timeZone: 'America/Los_Angeles', hour: 'numeric', minute: '2-digit' });
/** the example list of one model (forecast frames only: a file still waiting for its run is not listed) */
export async function rainIndex(model, fetchFn = (...a) => fetch(...a)) {
  const r = await fetchFn(BASE + 'index.json'); if (!r.ok) throw new Error('examples ' + r.status);
  return ((await r.json()).examples || []).filter((e) => e.model === model && e.forecast !== false);
}

/** the sheet's list (view.js openSheet's body): a heading, a line, one row per storm, the fine print */
export function fillExamplesSheet(b, model, list, onPick) {
  const m = modelById(model) || { name: model };
  b.append(mk('h2', 'nc-h', `${m.name} · example storms`));
  b.append(mk('p', null, list.length ? `What ${m.name} forecast on real storms near Wallowa County, next to what the radar saw: the next 90 minutes of rain, from the radar of that moment.`
    : `No recorded example storms for ${m.name} in this version.`));
  for (const e of list) {
    const r = btn('nc-res bm-ex', null); r.append(mk('b', null, e.title || e.date), mk('span', 'footnote', [e.when, e.place ? `around ${e.place}` : ''].filter(Boolean).join(' · ')));
    r.onclick = () => onPick(e.id); b.append(r);
  }
  if (list.length) b.append(mk('p', 'footnote', `Examples, not a measure of accuracy: none was chosen for how ${m.name} did. ${EXPERIMENTAL}.`));
}

/** the player. v018 examples (Josh: the app must not switch look for the example storms): no panel of its own - the view draws what ui()
 *  describes in its own time bar and folding card (exampleui.js); the forecast or what happened on the map, the box framed in the room
 *  between the key and the card.
 *  createRainPlayer({ map, space: () => ({ w, h, top, bottom }), onChange, onExit, toast, fetchFn }) */
export function createRainPlayer({ map, root = null, space = null, onExit = () => {}, onChange = () => {}, toast = () => {}, fetchFn = (...a) => fetch(...a) }) {
  const LUT = codeLut(), CLUT = chanceLut();
  const P = { ex: null, i: 0, view: 'fc', outline: true, cache: new Map(), cv: null, vals: null, edge: null };
  // frame i: 0 = the radar the forecast started from, 1.. = +firstMin ... +90 min
  const frameAt = (i) => (i === 0 ? null : P.ex.frames[i - 1]);
  const tOf = (i) => (i === 0 ? P.ex.t0 : frameAt(i).t);
  async function vals(key, url) {
    if (!url) return null;
    if (!P.cache.has(key)) P.cache.set(key, pngValues(url, P.ex.box.size, P.ex.box.size));
    return P.cache.get(key);
  }
  map.addOverlay({ name: 'rain-example', level: 0, order: 11, draw(ctx, api) {
    const ex = P.ex; if (!ex || !P.cv) return;
    api.drawGrid(Object.assign({ canvas: P.cv, codes: P.vals, lut: P.lut }, ex.grid), 1);   // v018: the codes go along: drawn smooth on the GPU
  } });
  map.addOverlay({ name: 'rain-example-top', level: 1, order: 11, draw(ctx, api) {
    const ex = P.ex; if (!ex) return;
    const g = ex.grid, n = g.rows;
    if (P.edge && P.edge.length) {   // what happened, as an outline over the forecast: the pixel edges where 1 mm/h starts
      const xs = new Float64Array(n + 1), ys = new Float64Array(n + 1);
      for (let k = 0; k <= n; k++) { xs[k] = api.toScreen(g.top, g.left + k * g.dlon).x; ys[k] = api.toScreen(g.top - k * g.dlat, g.left).y; }
      ctx.beginPath();
      for (let s = 0; s < P.edge.length; s += 4) { const [r0, c0, r1, c1] = [P.edge[s], P.edge[s + 1], P.edge[s + 2], P.edge[s + 3]]; ctx.moveTo(xs[c0], ys[r0]); ctx.lineTo(xs[c1], ys[r1]); }
      ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(0,0,0,0.55)'; ctx.stroke(); ctx.lineWidth = 1.5; ctx.strokeStyle = '#FFFFFF'; ctx.stroke();
    }
    // the box's edge (dashed) and the place the forecast is centred on
    const a = api.toScreen(g.top, g.left), b = api.toScreen(g.top - n * g.dlat, g.left + n * g.dlon);
    ctx.setLineDash([6, 5]); ctx.lineWidth = 1.2; ctx.strokeStyle = 'rgba(255,255,255,0.7)'; ctx.strokeRect(a.x, a.y, b.x - a.x, b.y - a.y); ctx.setLineDash([]);
    const p = api.toScreen(ex.place.lat, ex.place.lon);
    ctx.beginPath(); ctx.arc(p.x, p.y, 5.5, 0, 2 * Math.PI); ctx.fillStyle = '#FFC93C'; ctx.fill(); ctx.lineWidth = 2; ctx.strokeStyle = '#151A33'; ctx.stroke();
    ctx.font = '600 12px -apple-system, BlinkMacSystemFont, system-ui, sans-serif'; ctx.textBaseline = 'middle'; ctx.textAlign = 'left';
    ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(0,0,0,0.8)'; ctx.strokeText(ex.place.name, p.x + 9, p.y); ctx.fillStyle = '#FFE08A'; ctx.fillText(ex.place.name, p.x + 9, p.y);
  } });
  function edges(v, n, lv) {   // [r0, c0, r1, c1, ...] grid corners of the edges between >= lv and < lv
    const out = [];
    for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) {
      if (v[r * n + c] < lv) continue;
      if (r === 0 || v[(r - 1) * n + c] < lv) out.push(r, c, r, c + 1);
      if (r === n - 1 || v[(r + 1) * n + c] < lv) out.push(r + 1, c, r + 1, c + 1);
      if (c === 0 || v[r * n + c - 1] < lv) out.push(r, c, r + 1, c);
      if (c === n - 1 || v[r * n + c + 1] < lv) out.push(r, c + 1, r + 1, c + 1);
    }
    return out;
  }
  let tok = 0;
  async function show(i) {
    const ex = P.ex; if (!ex) return; P.i = Math.max(0, Math.min(ex.frames.length, i)); const my = ++tok, n = ex.box.size, f = frameAt(P.i);
    let fill = null, lut = LUT, min = 1, edge = null;
    if (!f) fill = await vals('now', ex.now);
    else if (P.view === 'obs') fill = await vals(`o${P.i}`, f.obs);
    else {
      fill = P.view === 'chance' ? await vals(`c${P.i}`, f.chance) : await vals(`f${P.i}`, f.fc);
      if (P.view === 'chance') { lut = CLUT; min = CHANCE_MIN; }
      if (P.outline) { const o = await vals(`o${P.i}`, f.obs); edge = o ? edges(o, n, OUTLINE_LEVEL) : null; }
    }
    if (my !== tok || !P.ex) return;
    P.cv = fill ? paint(fill, n, lut, P.cv, min) : null; P.edge = edge; P.vals = fill; P.lut = lut;
    P.wet = 0; if (fill) for (let q = 0; q < fill.length; q++) if (fill[q] >= min) P.wet++;   // pixels coloured (Diagnostics, tests)
    map.draw(); onChange();
  }
  /** -> true when it opened (false: it could not be loaded or read; nothing changed) */
  async function open(id, o = {}) {
    let ex = o.example || null;
    if (!ex) { const r = await fetchFn(BASE + id + '.json').catch(() => null); if (!r || !r.ok) { toast('That example storm could not be loaded.'); return false; } ex = await r.json(); }
    const bad = checkExample(ex); if (bad.length) { toast('That example storm could not be read.'); console.warn('example', ex && ex.id, bad); return false; }
    P.ex = ex; P.cache = new Map(); P.cv = null; P.edge = null;
    P.view = hasForecast(ex) ? (o.view || 'fc') : 'obs';
    await show(o.frame != null ? o.frame : Math.min(ex.frames.length, Math.round(30 / ex.everyMin)));   // opens at +30 min
    frame();
    return true;
  }
  /** a chip (a view: fc, obs, chance) or the switch (outline) */
  function set(id, on) {
    const ex = P.ex; if (!ex) return Promise.resolve();
    if (id === 'outline') P.outline = !!on;
    else if (['fc', 'obs', 'chance'].includes(id) && (id === 'obs' || hasForecast(ex)) && (id !== 'chance' || ex.frames.some((q) => q.chance))) P.view = id;
    else return Promise.resolve();
    return show(P.i);
  }
  /** the box fills the map's free room (between the key and the card) */
  function frame() {
    const g = P.ex.grid, s = g.top - g.rows * g.dlat, w = g.left, nn = g.top, e = g.left + g.cols * g.dlon;
    const box = root ? root.getBoundingClientRect() : { width: 390, height: 844 }, sp = Object.assign({ w: box.width, h: box.height, top: 64, bottom: 220 }, space ? space() : {});
    map.fit(s, w, nn, e, 16); const st = map.state;
    const p0 = toScreenAt(st, nn, w), p1 = toScreenAt(st, s, e), bw = Math.abs(p1.x - p0.x), bh = Math.abs(p1.y - p0.y);
    const k = Math.min((sp.w - 24) / Math.max(1, bw), Math.max(120, sp.h - sp.top - sp.bottom) / Math.max(1, bh));
    const z = st.z + Math.log2(k); map.center((s + nn) / 2, (w + e) / 2, z);
    const mid = map.toLatLon(sp.w / 2, sp.h / 2 + (sp.bottom - sp.top) / 2); map.center(mid.lat, mid.lon, z);
  }
  /** what the view draws for this frame: the time bar's frames and words, the card's words, chips, switch, credits and fine print */
  function ui() {
    const ex = P.ex; if (!ex) return null;
    const f = frameAt(P.i), m = modelById(ex.model) || { name: ex.model }, fcOk = hasForecast(ex), t = tOf(P.i);
    const words = !f ? `The radar at ${clock(ex.t0)}: what ${m.name} started from.`
      : P.view === 'obs' ? `What the radar saw at ${clock(f.t)}, ${f.min} min after the forecast.${f.obs ? '' : ' (No radar in the NOAA archive for this time.)'}`
        : P.view === 'chance' ? `Chance of more than 1 mm/h at ${clock(f.t)}, from ${m.name}’s ${(ex.run && ex.run.members) || 4} runs: ${f.min} min ahead.`
          : `${m.name}’s forecast for ${clock(f.t)}, made from the ${clock(ex.t0)} radar: ${f.min} min ahead.`;
    const what = !f ? 'the radar it started from' : P.view === 'obs' ? `what happened, +${f.min} min` : P.view === 'chance' ? `chance of rain, +${f.min} min` : `+${f.min} min`;
    const views = [['fc', 'Forecast'], ['obs', 'What happened']].concat(ex.model === 'dgmr' && ex.frames.some((q) => q.chance) ? [['chance', 'Chance of rain']] : []);
    const lic = m.licence || {};
    return {
      kind: 'rain', model: m.name, pill: `Example · ${m.name}`, title: ex.title || dateOf(ex.t0),
      frames: [{ t: ex.t0, kind: 'radar' }].concat(ex.frames.map((q) => ({ t: q.t, kind: 'nowcast' }))), i: P.i, moment: 0,
      date: dateOf(t), time: clock(t), tag: `Example · ${m.name} · ${what} · Experimental`,
      valuetext: `${dateOf(t)} ${clock(t)}, ${m.name} example storm, ${what}`, momentWords: 'Back to the radar it started from',
      sentence: fcOk ? words : `${words} This example has no ${m.name} forecast yet: only what the radar saw.`,
      chipsLabel: 'View', chips: views.map(([k, label]) => ({ id: k, label, on: k === P.view, disabled: k !== 'obs' && !fcOk })),
      switches: fcOk && f && P.view !== 'obs' ? [{ id: 'outline', label: 'Outline: what happened (1 mm/h+)', on: P.outline }] : [],
      dots: null, chance: !!f && P.view === 'chance',
      credit: `${ex.credit} · Radar: NOAA MRMS · ${EXPERIMENTAL}`,
      about: [ex.story || '',
        ex.chosen === 'reported' ? `Chosen for what happened on the ground, not for how ${m.name} did: an example, not a measure of accuracy.`
          : `The same storm as one of BEAM’s example storms (chosen for BEAM, not for how ${m.name} did): an example, not a measure of accuracy.`,
        ex.model === 'dgmr' ? `${m.name} ran ${(ex.run && ex.run.members) || 4} times on the radar of ${clock(ex.t0)} (each run one possible future); the map shows their average as the app does, the chance view the share of the runs over 1 mm/h. Recorded with the app’s own engine, the same steps as a run on this phone, on a ${ex.box.size * ex.box.km} km box around ${ex.place.name}.`
          : `${m.name} ran once on the radar, satellite and lightning of ${clock(ex.t0)} (the satellite held at its newest image, as on this phone), on a ${ex.box.size * ex.box.km} km box around ${ex.place.name}. Recorded on a computer with the full-precision model and the noise this phone would draw for that radar time; this phone runs an 8-bit copy, so its maps differ a little.`,
        ex.obsNote ? `What happened: ${ex.obsNote}.` : '', ex.source || '',
        [lic.notice || '', lic.changes || '', lic.name ? `Licence: ${lic.name}${lic.url ? ` (${lic.url})` : ''}.` : ''].filter(Boolean).join(' '),
        `${EXPERIMENTAL}. ${FOLLOW_NWS}`].filter(Boolean),
      delay: P.i >= ex.frames.length || P.i === 0 ? 1600 : 650,
    };
  }
  function close() { tok++; P.ex = null; P.cv = null; P.edge = null; P.cache = new Map(); map.draw(); onExit(); }
  return {
    index: (model) => rainIndex(model, fetchFn), open, close, show, set, ui, get active() { return !!P.ex; }, get example() { return P.ex; },
    get state() { return { i: P.i, view: P.view, outline: P.outline, wet: P.wet || 0, edges: P.edge ? P.edge.length / 4 : 0 }; },
    destroy() { if (P.ex) close(); map.removeOverlay('rain-example'); map.removeOverlay('rain-example-top'); },
  };
}
