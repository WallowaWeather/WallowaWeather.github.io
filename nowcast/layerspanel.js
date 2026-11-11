// nowcast/layerspanel.js - v018: the Layers sheet, grouped: Weather now, Forecasts and Map details (our own words and look).
// Weather now is switches that can be on together (Satellite under the Radar; Lightning only where a lightning layer exists).
// Forecast maps are one radio group - one at a time, or none: Precipitation (the model picked on the chip: BEAM, DGMR or StormScope, then
// the forecast field's hours) and every forecast field (fields/index.js FIELDS: Wind, Temperature, Humidity, Pressure ...). Map details
// (roads, public land, lot lines, water / fire / farm layers, the presets, the saved county map) are the view's own rows (o.details).
//   const p = buildLayersPanel(body, { live, liveOn, forecast, fmap, fmapOn, modelName, precipSub, satModes, satMode },
//     { onLive(id, on), onForecast(id | null), onModel(), onSatMode('overlay' | 'full'), details(sectionEl) });
'use strict';
import { icon } from './icons.js';

export const LIVE = {
  satellite: { id: 'satellite', name: 'Satellite', icon: 'satellite', sub: 'NOAA GOES: true colour by day, infrared at night, for the radar’s hour (about 3 MB a loop)' },
  radar: { id: 'radar', name: 'Radar', icon: 'radar', sub: 'NOAA MRMS, up to now' },
  lightning: { id: 'lightning', name: 'Lightning', icon: 'lightning', sub: 'Lightning the GOES satellite saw, the last hour' },
};
/** the live maps there are: Satellite, Radar, and Lightning only when the app has a lightning layer */
export function liveMaps({ lightning = false } = {}) { return [LIVE.satellite, LIVE.radar].concat(lightning ? [LIVE.lightning] : []); }
const FIELD_ICON = { precip: 'precip', wind: 'wind', temp: 'temp', rh: 'rh', pressure: 'pressure' };
/** Precipitation first (the model's nowcast and the forecast field's precipitation are one map), then every other forecast field */
export function forecastMaps(fields = []) {
  return [{ id: 'precip', name: 'Precipitation', icon: 'precip' }].concat((fields || []).filter((f) => f && f.id !== 'precip')
    .map((f) => ({ id: f.id, name: f.name, icon: FIELD_ICON[f.id] || 'cloud', unit: f.legendUnit || f.unit || '', sub: f.about || '' })));
}
export const mapIcon = (id) => FIELD_ICON[id] || 'cloud';

/** -> { root, sections: { live, forecast, details }, setForecast(id, on), setLive(id, on) } */
export function buildLayersPanel(el, o = {}, h = {}) {
  const doc = h.doc || globalThis.document;
  const mk = (tag, cls, text) => { const e = doc.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  const sec = (key, title) => { const s = mk('section', 'nc-lp-sec'); s.dataset.sec = key; const hh = mk('h3', 'nc-lp-h', title); hh.id = `nc-lp-${key}`; s.setAttribute('aria-labelledby', hh.id); s.append(hh); el.append(s); return s; };
  const icWrap = (name) => { const w = mk('span', 'nc-lp-ic'); w.append(icon(name, 'nc-ic', 22)); return w; };
  // ---- Weather now: switches
  const live = sec('live', 'Weather now'), liveInputs = {};
  let satSeg = null;
  for (const m of o.live || liveMaps({})) {
    const l = mk('label', 'nc-sw nc-lp-sw'), t = mk('span', 'nc-sw-t'), i = mk('input'); i.type = 'checkbox'; i.checked = !!(o.liveOn || {})[m.id];
    t.append(mk('b', null, m.name)); if (m.sub) t.append(mk('span', 'footnote', m.sub));
    l.append(icWrap(m.icon), t, i); live.append(l); liveInputs[m.id] = i;
    i.addEventListener('change', () => { if (satSeg && m.id === 'satellite') satSeg.hidden = !i.checked; if (h.onLive) h.onLive(m.id, i.checked); });
    if (m.id === 'satellite' && o.satModes) {   // the satellite's two looks (clouds.js mode): see-through clouds over the map, or the picture itself
      satSeg = mk('div', 'nc-seg nc-lp-seg'); satSeg.setAttribute('role', 'group'); satSeg.setAttribute('aria-label', 'How the satellite shows');
      for (const [v, lab] of [['overlay', 'Clouds over the map'], ['full', 'The full picture']]) {
        const b = mk('button', 'nc-seg-b' + (v === (o.satMode || 'overlay') ? ' on' : ''), lab); b.type = 'button'; b.setAttribute('aria-pressed', String(v === (o.satMode || 'overlay')));
        b.addEventListener('click', () => { for (const x of satSeg.querySelectorAll('.nc-seg-b')) { x.classList.toggle('on', x === b); x.setAttribute('aria-pressed', String(x === b)); } if (h.onSatMode) h.onSatMode(v); });
        satSeg.append(b);
      }
      satSeg.hidden = !i.checked; live.append(satSeg);
    }
  }
  // ---- Forecasts: one radio group, one at a time or none
  const forecast = sec('forecast', 'Forecasts'), group = mk('div', 'nc-lp-maps'); group.setAttribute('role', 'radiogroup'); group.setAttribute('aria-labelledby', 'nc-lp-forecast');
  forecast.append(group);
  const radios = [];
  for (const m of o.forecast || forecastMaps([])) {
    const row = mk('div', 'nc-lp-row'), r = mk('button', 'nc-lp-map'); r.type = 'button'; r.setAttribute('role', 'radio'); r.dataset.map = m.id;
    const t = mk('span', 'nc-lp-t'); t.append(mk('b', null, m.name));
    const sub = m.id === 'precip' ? o.precipSub : [m.unit ? `In ${m.unit}` : '', m.sub].filter(Boolean).join(' · ');
    if (sub) t.append(mk('span', 'footnote', sub));
    const ck = mk('span', 'nc-lp-ck'); ck.append(icon('check', 'nc-ic sm', 18));
    r.append(icWrap(m.icon), t, ck); row.append(r);
    r.addEventListener('click', () => { const on = r.getAttribute('aria-checked') === 'true'; setForecast(on ? null : m.id, !on); if (h.onForecast) h.onForecast(on ? null : m.id); });
    if (m.id === 'precip' && o.modelName) {   // the model the Precipitation map comes from: its chip opens the picker
      const mb = mk('button', 'nc-lp-model'); mb.type = 'button'; mb.append(mk('span', null, o.modelName), icon('chevup', 'nc-ic sm', 14)); mb.setAttribute('aria-label', `Forecast model: ${o.modelName}. Change`);
      mb.addEventListener('click', () => { if (h.onModel) h.onModel(); }); row.append(mb);
    }
    group.append(row); radios.push(r);
  }
  group.addEventListener('keydown', (e) => {
    const d = e.key === 'ArrowDown' || e.key === 'ArrowRight' ? 1 : e.key === 'ArrowUp' || e.key === 'ArrowLeft' ? -1 : 0; if (!d) return;
    const cur = radios.indexOf(e.target && e.target.dataset && e.target.dataset.map ? e.target : doc.activeElement); if (cur < 0) return;
    if (e.preventDefault) e.preventDefault(); radios[(cur + d + radios.length) % radios.length].focus();
  });
  function setForecast(id, on = true) { for (const r of radios) { const yes = !!on && r.dataset.map === id; r.setAttribute('aria-checked', String(yes)); r.tabIndex = yes || (!radios.some((x) => x.dataset.map === id && on) && r === radios[0]) ? 0 : -1; } }
  setForecast(o.fmap || null, o.fmapOn !== false && !!o.fmap);
  // ---- Map details: the view's own rows
  const details = sec('details', 'Map details');
  if (h.details) h.details(details);
  return { root: el, sections: { live, forecast, details }, setForecast, setLive(id, on) { if (liveInputs[id]) liveInputs[id].checked = !!on; if (id === 'satellite' && satSeg) satSeg.hidden = !on; } };
}
