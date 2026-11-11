// nowcast/gauges.js - Wallowa Weather v008: live USGS stream gauges in and near Wallowa County for the Water (OWRD) preset: the
// latest flow (discharge, cfs) and gage height (ft) with a trend arrow, from the USGS Water Data OGC API (api.waterdata.usgs.gov, v1:
// the replacement of the legacy WaterServices, which shuts down on Feb 22, 2027). Public domain; recent values are provisional.
// No API key (an optional key only raises the rate limit; one request every 15 minutes from a phone is far under it). Browser access
// checked Nov-08-2026: "Access-Control-Allow-Origin: *". Asks only while the layer is on, at most every 15 minutes, never while the page
// is hidden; turning the layer off stops a request in flight. One request for the values (the last 4 hours of every gauge in the box,
// slimmed to the fields used), one for the names of gauges not seen before (once a session).
'use strict';
import { createPoller, getJSON, clean, num, clockOf, agoOf, pill } from './feeds.js';

export const GAUGES_API = 'https://api.waterdata.usgs.gov/ogcapi/v1/collections/';
export const GAUGES_HOST = 'https://api.waterdata.usgs.gov';
export const GAUGES_CREDIT = 'Stream gauges: USGS';
export const GAUGES_NOTE = 'Stream gauges from the US Geological Survey (USGS Water Data). Recent values are provisional: they have not been reviewed and may be revised. Gauges report every 15 minutes, often sent in batches, so the newest value can be an hour or more old.';
/** [w, s, e, n]: the county and about 10 km around it (Mill Creek's gauges by Walla Walla, the Snake at Anatone) */
export const GAUGE_BOX = [-118.15, 44.75, -116.35, 46.15];
export const PARAMS = { '00060': { key: 'q', label: 'Flow', unit: 'cfs' }, '00065': { key: 'h', label: 'Gage height', unit: 'ft' } };
const FIELDS = 'monitoring_location_id,time_series_id,parameter_code,time,value,unit_of_measure,approval_status,qualifier';
const ID_RE = /^USGS-\d{8,15}$/;

/** the values request: every 15-minute value of flow and gage height in the box over the last `hours` */
/** v014: limit = the most values one answer holds (Wallowa's 7 gauges fit in 1,000; Lane's and Douglas's ~100 series need 3,000) */
export function valuesUrl(box = GAUGE_BOX, hours = 4, limit = 1000) {
  return `${GAUGES_API}continuous/items?f=json&bbox=${box.join(',')}&parameter_code=00060,00065&time=PT${hours}H&limit=${limit}&properties=${FIELDS}`;
}
/** the names request for some gauges (ids "USGS-13331500") */
export function namesUrl(ids) {
  return `${GAUGES_API}monitoring-locations/items?f=json&id=${ids.filter((i) => ID_RE.test(i)).join(',')}&properties=monitoring_location_name,drainage_area&limit=${Math.max(10, ids.length)}`;
}
/** a page about the gauge on USGS's own site */
export const pageOf = (id) => `https://waterdata.usgs.gov/monitoring-location/${encodeURIComponent(id)}/`;

/** the values response -> Map id -> { id, lon, lat, series: { '00060': [{ t, v, approval, qual }] (oldest first), '00065': [...] } } */
export function parseValues(j) {
  const out = new Map();
  for (const f of (j && j.features) || []) {
    const p = f.properties || {}, id = clean(p.monitoring_location_id, 24), pc = String(p.parameter_code || '');
    if (!ID_RE.test(id) || !PARAMS[pc]) continue;
    const v = num(p.value), t = Date.parse(p.time);
    if (v == null || v <= -999 || !Number.isFinite(t)) continue;   // -999999: the USGS's "no value"
    const g = f.geometry && f.geometry.type === 'Point' ? f.geometry.coordinates : null;
    let s = out.get(id);
    if (!s) { if (!g || !Number.isFinite(+g[0]) || !Number.isFinite(+g[1])) continue; s = { id, lon: +g[0], lat: +g[1], series: {}, all: {} }; out.set(id, s); }
    const k = pc + '|' + clean(p.time_series_id, 64);   // a site can carry a second (non-primary) series of the same parameter
    (s.all[k] = s.all[k] || []).push({ t, v, approval: clean(p.approval_status, 20), qual: quals(p.qualifier) });
  }
  for (const s of out.values()) {   // per parameter, the series with the newest value
    for (const [k, ser] of Object.entries(s.all)) {
      ser.sort((a, b) => a.t - b.t); const pc = k.split('|')[0], cur = s.series[pc];
      if (!cur || ser[ser.length - 1].t > cur[cur.length - 1].t || (ser[ser.length - 1].t === cur[cur.length - 1].t && ser.length > cur.length)) s.series[pc] = ser;
    }
    delete s.all;
  }
  return out;
}
const quals = (q) => (Array.isArray(q) ? q : q == null || q === '' ? [] : String(q).split(/[,;\s]+/)).map((x) => clean(x, 16)).filter(Boolean);

/** the names response -> Map id -> { name (in normal case), area (sq mi) | null } */
export function parseNames(j) {
  const out = new Map();
  for (const f of (j && j.features) || []) {
    const id = clean(f.id || (f.properties || {}).id, 24); if (!ID_RE.test(id)) continue;
    const p = f.properties || {};
    out.set(id, { name: prettyName(p.monitoring_location_name) || id, area: num(p.drainage_area) });
  }
  return out;
}

const SMALL = new Set(['AT', 'NEAR', 'BELOW', 'ABOVE', 'OF', 'THE', 'AND', 'IN', 'ON', 'TO', 'BY', 'FROM']);
const ABBR = { NR: 'near', BLW: 'below', BL: 'below', ABV: 'above', AB: 'above', FK: 'Fork', CR: 'Creek', CK: 'Creek', R: 'River', RV: 'River', TRIB: 'Tributary', DIV: 'Diversion' };
/** "MILL CREEK AT FIVE MILE RD BR NR WALLA WALLA, WA" -> "Mill Creek at Five Mile Rd Br near Walla Walla, WA" */
export function prettyName(raw) {
  const s = clean(raw, 120); if (!s) return '';
  const cut = s.lastIndexOf(','), body = cut > 0 && /^\s*[A-Z]{2}\s*$/.test(s.slice(cut + 1)) ? s.slice(0, cut) : s, st = body === s ? '' : ', ' + s.slice(cut + 1).trim();
  const words = body.split(/\s+/).map((w, i) => {
    const u = w.toUpperCase().replace(/\.$/, '');
    if (ABBR[u] && i > 0) return ABBR[u];
    if (SMALL.has(u) && i > 0) return u.toLowerCase();
    if (/^MC[A-Z]/.test(u)) return 'Mc' + u.charAt(2) + u.slice(3).toLowerCase();
    if (/^(NF|SF|EF|WF|MF|N|S|E|W|US|OR|WA|ID)$/.test(u)) return u;
    return u.charAt(0) + u.slice(1).toLowerCase();
  });
  return words.join(' ') + st;
}

/** the trend of one series over about the last hour: { dir: 'up' | 'down' | 'steady', d (change), hours, perHour, fast } | null */
export function trendOf(series, pc) {
  if (!series || series.length < 2) return null;
  const L = series[series.length - 1], target = L.t - 3600e3;
  let P = null;
  for (const x of series) if (x.t <= L.t - 30 * 60e3 && (!P || Math.abs(x.t - target) < Math.abs(P.t - target))) P = x;
  if (!P) return null;
  const hours = (L.t - P.t) / 3600e3, d = L.v - P.v, perHour = d / hours;
  let dir = 'steady', fast = false;
  if (pc === '00065') {   // gage height, ft
    if (Math.abs(perHour) >= 0.03) dir = perHour > 0 ? 'up' : 'down';
    fast = perHour >= 0.5;
  } else {                // flow, cfs: relative
    const rel = perHour / Math.max(Math.abs(P.v), 0.01);
    if (Math.abs(rel) >= 0.03 && Math.abs(d) >= 0.05) dir = rel > 0 ? 'up' : 'down';
    fast = rel >= 0.25 && d >= 5;
  }
  return { dir, d, hours, perHour, fast };
}
/** a value as people write it: 13,600 cfs, 719 cfs, 60.7 cfs, 1.52 cfs; 4.04 ft */
export function valueText(v, unit) {
  if (unit === 'ft') return `${v.toFixed(2)} ft`;
  const a = Math.abs(v);
  return `${a >= 100 ? Math.round(v).toLocaleString('en-US') : a >= 10 ? v.toFixed(1) : v.toFixed(2)} cfs`;
}
export const ARROW = { up: '↑', down: '↓', steady: '→' };

/** Map from parseValues + names -> sorted list of gauges: { id, name, area, lon, lat, q, h } (q / h: { v, t, unit, approval, qual, trend } | null) */
export function summarise(parsed, names = new Map()) {
  const out = [];
  for (const s of parsed.values()) {
    const g = { id: s.id, name: (names.get(s.id) || {}).name || s.id, area: (names.get(s.id) || {}).area ?? null, lon: s.lon, lat: s.lat, q: null, h: null };
    for (const [pc, P] of Object.entries(PARAMS)) {
      const ser = s.series[pc]; if (!ser || !ser.length) continue;
      const L = ser[ser.length - 1];
      g[P.key] = { v: L.v, t: L.t, unit: P.unit, approval: L.approval, qual: L.qual, trend: trendOf(ser, pc) };
    }
    if (g.q || g.h) out.push(g);
  }
  return out.sort((a, b) => b.lat - a.lat);
}
const QUALS = { ICE: 'ice affected', EQP: 'equipment problem', EQUIP: 'equipment problem', E: 'estimated', EST: 'estimated', BKW: 'backwater', ZFL: 'zero flow', MNT: 'maintenance', DRY: 'dry', FLD: 'flood damage', PRT: 'partial record', RVB: 'revised' };
function trendWords(x) {
  const tr = x.trend; if (!tr) return '';
  if (tr.dir === 'steady') return ', steady';
  const amt = x.unit === 'ft' ? `${Math.abs(tr.d).toFixed(2)} ft` : valueText(Math.abs(tr.d), 'cfs');
  const span = tr.hours > 1.4 ? `${tr.hours.toFixed(1)} hours` : 'the last hour';
  return `, ${tr.dir === 'up' ? 'rising' : 'falling'} ${amt} in ${span}${tr.fast ? ' (fast)' : ''}`;
}
/** the sheet text of a gauge */
export function gaugeInfo(g, now = Date.now()) {
  const lines = [];
  if (g.q) lines.push(`Flow ${valueText(g.q.v, 'cfs')}${trendWords(g.q)}`);
  if (g.h) lines.push(`Gage height ${valueText(g.h.v, 'ft')}${trendWords(g.h)}`);
  const t = Math.max(g.q ? g.q.t : 0, g.h ? g.h.t : 0);
  lines.push(`As of ${clockOf(t)} (${agoOf(t, now)})`);
  const qs = [...new Set([...(g.q ? g.q.qual : []), ...(g.h ? g.h.qual : [])])];
  if (qs.length) lines.push('Marked by the USGS: ' + qs.map((q) => QUALS[q.toUpperCase()] || q).join(', '));
  if (g.area) lines.push(`Drainage area ${g.area.toLocaleString('en-US')} sq mi`);
  const prov = [g.q, g.h].some((x) => x && /provisional/i.test(x.approval));
  return { kind: 'gauge', id: g.id, gauge: g, title: g.name, color: '#2F8CFF', badge: prov ? 'Provisional data' : '', lines,
    foot: GAUGES_NOTE, link: { label: 'This gauge on USGS Water Data', href: pageOf(g.id) } };
}
const fastOf = (g) => !!((g.q && g.q.trend && g.q.trend.fast) || (g.h && g.h.trend && g.h.trend.fast));
const dirOf = (g) => ((g.q || g.h).trend || {}).dir || null;

/** { map, fetchFn, every, box, hours, labelZ, onChange(list, err), now, poller options } -> { on(bool), isOn(), refresh(force), list(),
 *  at(lat, lon), error(), destroy(), overlay } */
export function createGauges({ map = null, fetchFn = (...a) => fetch(...a), every = 15 * 60e3, box = GAUGE_BOX, hours = 4, labelZ = 8, limit = 1000,
  onChange = () => {}, now = () => Date.now(), pollerOpts = {} } = {}) {
  let sites = [], err = null, active = false;
  const names = new Map();
  const overlay = { name: 'ww-gauges', level: 1, order: 40, draw: (ctx, api) => draw(ctx, api) };
  async function run(signal) {
    const parsed = parseValues(await getJSON(valuesUrl(box, hours, limit), { signal, fetchFn, accept: 'application/geo+json, application/json' }));
    const need = [...parsed.keys()].filter((id) => !names.has(id));
    if (need.length) {
      try { for (const [k, v] of parseNames(await getJSON(namesUrl(need), { signal, fetchFn, accept: 'application/geo+json, application/json' }))) names.set(k, v); }
      catch (e) { if (signal.aborted) throw e; }   // no names: the gauges still show, by number
    }
    if (signal.aborted) return;
    sites = summarise(parsed, names); err = null;
    onChange(sites, null); if (map && active) map.draw();
  }
  const poller = createPoller(Object.assign({ run, every, now, onError: (e) => { err = e; onChange(sites, e); } }, pollerOpts));
  function on(v) {
    active = !!v;
    if (active) { if (map) map.addOverlay(overlay); poller.start(); } else { poller.stop(); if (map) map.removeOverlay(overlay.name); }
  }
  /** the gauge under a tap (within 24 px of its mark; without a map, 0.02 degree) -> its sheet text, or null */
  function at(lat, lon) {
    if (!active || !sites.length) return null;
    let best = null, bd = Infinity;
    for (const g of sites) {
      let d;
      if (map) { const a = map.toScreen(lat, lon), b = map.toScreen(g.lat, g.lon); d = Math.hypot(a.x - b.x, a.y - b.y) / 24; }
      else d = Math.hypot(lat - g.lat, (lon - g.lon) * Math.cos(lat * Math.PI / 180)) / 0.02;
      if (d < 1 && d < bd) { bd = d; best = g; }
    }
    return best ? gaugeInfo(best, now()) : null;
  }
  function draw(ctx, api) {
    if (!sites.length) return;
    const [vw, vs, ve, vn] = api.view, placed = api.placed || (api.placed = []), showText = api.z >= labelZ;   // api.placed: shared by the level's overlays this frame
    for (const g of sites) {
      if (g.lon < vw || g.lon > ve || g.lat < vs || g.lat > vn) continue;
      const p = api.toScreen(g.lat, g.lon), fast = fastOf(g), r = 6;
      ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(Math.PI / 4);   // a diamond: not a town's dot, not a fire's circle
      ctx.fillStyle = fast ? '#FFB020' : '#2F8CFF'; ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.8;
      ctx.beginPath(); ctx.rect(-r * 0.75, -r * 0.75, r * 1.5, r * 1.5); ctx.fill(); ctx.stroke(); ctx.restore();
      placed.push({ x: p.x - r, y: p.y - r, w: 2 * r, h: 2 * r });
    }
    if (!showText) return;
    for (const g of sites) {
      if (g.lon < vw || g.lon > ve || g.lat < vs || g.lat > vn) continue;
      const p = api.toScreen(g.lat, g.lon), x = g.q || g.h, dir = dirOf(g);
      pill(ctx, api, p.x, p.y, `${valueText(x.v, x.unit)}${dir ? ' ' + ARROW[dir] : ''}`, placed, { color: fastOf(g) ? '#FFD27A' : '#fff' });
    }
  }
  return { on, isOn: () => active, refresh: (force) => (active ? poller.refresh(force) : Promise.resolve(false)), list: () => sites.slice(), at, error: () => err,
    destroy() { on(false); poller.destroy(); }, overlay, get poller() { return poller.state; } };
}
