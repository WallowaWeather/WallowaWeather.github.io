// nowcast/presets.js - Wallowa Weather v008 (presets for water resources, fire weather,
// agriculture and general use): four ready-made views of the map. A preset sets the map's
// switches, says which BEAM heads the card and the app's alerts lead with, and which NWS alerts to highlight. The people behind each:
//   water: the Oregon Water Resources Department's watermaster (which drainages may see high water or flash flooding);
//   fire:  the Oregon Department of Forestry and the US Forest Service (storm direction, lightning with a fan of accuracy, dry
//          lightning first, so crews get a head start where lightning may start fires);
//   farm:  farmers and ranchers (hail on their land, heavy rain, wind and frost).
// Radar, "My location" and "Keep the county map on this phone" are never changed by a preset: radar is always on, the location is the
// person's own choice, the saved map is a storage choice. "Rain or snow" (type) is a radar setting and is left alone too.
'use strict';

export const PRESET_IDS = ['general', 'water', 'fire', 'farm'];

/** the switches a preset sets: the view's own S.layers keys, then the v008 ones (drainages, gauges, fires, firewx = NWS fire weather
 *  zones, lightning = observed GOES lightning, beamHail / beamLightning / beamRain = BEAM's chance maps, fan = the storm-direction fan) */
export const PRESET_KEYS = ['nowcast', 'warnings', 'clouds', 'parcels', 'roads', 'lands', 'drainages', 'gauges', 'fires', 'firewx', 'lightning', 'beamHail', 'beamLightning', 'beamRain', 'fan'];

/** the BEAM heads a preset can lead with */
export const HAZARDS = ['core', 'hail', 'lightning', 'rain'];

const off = { nowcast: true, warnings: true, clouds: false, parcels: false, roads: true, lands: true, drainages: false, gauges: false, fires: false, firewx: false, lightning: false, beamHail: false, beamLightning: false, beamRain: false, fan: false };

// NWS event names exactly as api.weather.gov writes them. NWS's hazard table (weather.gov/help-map, checked Nov-08-2026) no longer
// lists Hard Freeze Watch / Warning (folded into Freeze); they stay on the farm list in case an office still issues one.
export const PRESETS = {
  general: {
    id: 'general', label: 'General', icon: 'general', color: '#8B7CFF',
    blurb: 'Storms, rain and NWS warnings, for everyone',
    layers: Object.assign({}, off),
    hazards: ['core', 'hail', 'lightning', 'rain'],
    allWarnings: true,
    alertEvents: [],
  },
  water: {
    id: 'water', label: 'Water (OWRD)', icon: 'water', color: '#2F8CFF',
    blurb: 'Drainages that may see high water, and live stream gauges',
    layers: Object.assign({}, off, { lands: false, drainages: true, gauges: true, beamRain: true }),
    hazards: ['rain', 'core'],
    allWarnings: false,
    alertEvents: ['Flash Flood Warning', 'Flash Flood Watch', 'Flood Warning', 'Flood Advisory', 'Flood Watch', 'Hydrologic Outlook', 'Flash Flood Statement', 'Flood Statement'],
  },
  fire: {
    id: 'fire', label: 'Fire weather', icon: 'fire', color: '#FF6A2B',
    blurb: 'Dry lightning, storm direction, red flags and current fires',
    layers: Object.assign({}, off, { clouds: true, fires: true, firewx: true, lightning: true, beamLightning: true, fan: true }),
    hazards: ['lightning', 'core'],
    allWarnings: false,
    alertEvents: ['Red Flag Warning', 'Fire Weather Watch', 'Severe Thunderstorm Warning', 'Extreme Fire Danger', 'Fire Warning'],
  },
  farm: {
    id: 'farm', label: 'Farm & ranch', icon: 'farm', color: '#34A853',
    blurb: 'Hail, heavy rain, wind and frost on your land',
    layers: Object.assign({}, off, { parcels: true, lands: false, beamHail: true, beamRain: true }),
    hazards: ['hail', 'rain', 'core'],
    allWarnings: false,
    alertEvents: ['Severe Thunderstorm Warning', 'Frost Advisory', 'Freeze Warning', 'Freeze Watch', 'Hard Freeze Warning', 'Hard Freeze Watch', 'Wind Advisory', 'High Wind Warning', 'High Wind Watch', 'Flash Flood Warning', 'Flood Warning'],
  },
};

/** the preset (an unknown id gives General; own keys only: a saved 'toString' is no preset, and its missing lists stopped the view) */
export const presetOf = (id) => (typeof id === 'string' && Object.prototype.hasOwnProperty.call(PRESETS, id) ? PRESETS[id] : PRESETS.general);

/** a copy of `layers` with the preset's switches set (every other key, e.g. radar, gps, offline, type, kept as it was) */
export function presetLayers(layers, id) {
  return Object.assign({}, layers || {}, presetOf(id).layers);
}

/** which preset the switches match exactly, or null (the person changed a switch by hand) */
export function presetMatching(layers) {
  for (const id of PRESET_IDS) if (PRESET_KEYS.every((k) => !!(layers || {})[k] === !!PRESETS[id].layers[k])) return id;
  return null;
}

/** does the preset highlight this NWS event? (General: every warning, and nothing else is hidden by it) */
export function presetWants(id, event) {
  const p = presetOf(id), e = String(event || '');
  return p.alertEvents.includes(e) || (p.allWarnings && /warning/i.test(e));
}

/** sort key for alerts under a preset: the preset's own events first, in its order, then other warnings, then the rest. Official
 *  warnings are never hidden by a preset: this only changes the order and the highlight */
export function presetRank(id, event) {
  const p = presetOf(id), e = String(event || ''), i = p.alertEvents.indexOf(e);
  if (i >= 0) return i;
  return 100 + (/warning/i.test(e) ? 0 : /watch/i.test(e) ? 1 : 2);
}

/** the BEAM heads in the preset's order of emphasis, then the rest (for the card) */
export function presetHazards(id) {
  const p = presetOf(id);
  return p.hazards.concat(HAZARDS.filter((h) => !p.hazards.includes(h)));
}

// line icons (24 x 24, stroke currentColor), drawn for this file
const ICONS = {
  general: ['M8.5 3v1.5M3 8.5h1.5M4.6 4.6l1 1M12.4 4.6l-1 1', 'M6 10.6a3 3 0 0 1 5.4-2.4', 'M8 20h9.5a3.5 3.5 0 0 0 .3-7 4.8 4.8 0 0 0-9.3 1A3 3 0 0 0 8 20Z'],
  water: ['M12 3.2c-2.9 3.7-5.7 7-5.7 10.2a5.7 5.7 0 0 0 11.4 0c0-3.2-2.8-6.5-5.7-10.2Z', 'M9.1 14.6c1 .8 1.9.8 2.9 0s1.9-.8 2.9 0'],
  fire: ['M12 21a6 6 0 0 0 6-6c0-3.2-2-5.3-3.4-7.2-.4 1.6-1.2 2.6-2.3 3.1.3-2.9-.6-5.4-2.8-7.4.2 3.3-1.6 5-3 6.9A7.4 7.4 0 0 0 6 15a6 6 0 0 0 6 6Z', 'M12 21a2.4 2.4 0 0 1-2.4-2.4c0-1.6 1.2-2.5 2.4-4 1.2 1.5 2.4 2.4 2.4 4A2.4 2.4 0 0 1 12 21Z'],
  farm: ['M3.5 20.5V10.2L12 4l8.5 6.2v10.3Z', 'M8.8 20.5v-6.3h6.4v6.3', 'M8.8 14.2l6.4 6.3M15.2 14.2l-6.4 6.3', 'M10.2 9.8h3.6'],
  check: ['M6.5 12.5l3.5 3.5 7.5-8'],
};
const NS = 'http://www.w3.org/2000/svg';
function svgIcon(doc, name, size) {
  const s = doc.createElementNS(NS, 'svg');
  for (const [k, v] of [['viewBox', '0 0 24 24'], ['width', size], ['height', size], ['aria-hidden', 'true'], ['fill', 'none'], ['stroke', 'currentColor'], ['stroke-width', '1.8'], ['stroke-linecap', 'round'], ['stroke-linejoin', 'round']]) s.setAttribute(k, v);
  for (const d of ICONS[name] || ICONS.general) { const p = doc.createElementNS(NS, 'path'); p.setAttribute('d', d); s.append(p); }
  return s;
}
const soft = (hex, a) => { const n = parseInt(hex.slice(1), 16); return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`; };

/** the sheet text of a tap on one of the v008 layers (drainages / gauges / fires / firewx .at(lat, lon) all return
 *  { kind, title, color, badge, lines: [], foot, link: { label, href } }) -> a fragment for the sheet's body (text only: textContent) */
export function infoNode(info, doc = globalThis.document) {
  const frag = doc.createDocumentFragment(), mk = (tag, cls, text) => { const e = doc.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  const h = mk('h2', 'nc-h ps-h', info.title); h.style.setProperty('--ps-c', info.color || ''); frag.append(h);
  if (info.badge) { const b = mk('p', 'ps-flag', info.badge); b.style.setProperty('--ps-c', info.color || ''); frag.append(b); }
  for (const t of info.lines || []) if (t) frag.append(mk('p', null, t));
  if (info.link && /^https:\/\//.test(info.link.href)) { const a = mk('a', 'nc-link', info.link.label); a.href = info.link.href; a.target = '_blank'; a.rel = 'noopener'; frag.append(a); }
  if (info.foot) frag.append(mk('p', 'footnote dim', info.foot));
  return frag;
}

/** the preset picker for the TOP of the Layers sheet: 4 big cards (icon, label, one-line blurb), the current one highlighted; two by two
 *  on a phone, one row of four on a wide screen (presets.css). onPick(preset) runs on a tap of another card. -> the element, with
 *  .setCurrent(id) (e.g. null when the person has changed a switch by hand) */
export function createPresetPicker({ current = null, onPick = () => {}, title = 'Set the map up for', doc = globalThis.document } = {}) {
  const wrap = doc.createElement('div'); wrap.className = 'ps-pick';
  const h = doc.createElement('p'); h.className = 'ps-title'; h.id = 'ps-title-' + Math.random().toString(36).slice(2, 8); h.textContent = title;
  const row = doc.createElement('div'); row.className = 'ps-row'; row.setAttribute('role', 'radiogroup'); row.setAttribute('aria-labelledby', h.id);
  const cards = new Map();
  for (const id of PRESET_IDS) {
    const p = PRESETS[id], b = doc.createElement('button');
    b.type = 'button'; b.className = 'ps-card'; b.dataset.preset = id; b.setAttribute('role', 'radio');
    b.style.setProperty('--pc', p.color); b.style.setProperty('--pc-soft', soft(p.color, 0.16)); b.style.setProperty('--pc-ring', soft(p.color, 0.9));
    const ic = doc.createElement('span'); ic.className = 'ps-ic'; ic.append(svgIcon(doc, p.icon, 22));
    const lb = doc.createElement('b'); lb.className = 'ps-label'; lb.textContent = p.label;
    const bl = doc.createElement('span'); bl.className = 'ps-blurb'; bl.textContent = p.blurb;
    const ck = doc.createElement('span'); ck.className = 'ps-check'; ck.append(svgIcon(doc, 'check', 14));
    b.append(ic, lb, bl, ck);
    b.addEventListener('click', () => { if (wrap.current === id) return; set(id); onPick(p); });
    cards.set(id, b); row.append(b);
  }
  function set(id) {
    wrap.current = PRESETS[id] ? id : null;
    for (const [k, b] of cards) { const on = k === wrap.current; b.classList.toggle('on', on); b.setAttribute('aria-checked', on ? 'true' : 'false'); b.tabIndex = on || (!wrap.current && k === 'general') ? 0 : -1; }
  }
  // arrow keys move between the cards (a radio group)
  row.addEventListener('keydown', (e) => {
    const ids = PRESET_IDS, i = ids.indexOf(doc.activeElement && doc.activeElement.dataset ? doc.activeElement.dataset.preset : '');
    if (i < 0) return;
    const d = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
    if (!d) return;
    e.preventDefault(); const n = ids[(i + d + ids.length) % ids.length]; cards.get(n).focus(); cards.get(n).click();
  });
  wrap.append(h, row); set(current);
  wrap.setCurrent = set;
  return wrap;
}
