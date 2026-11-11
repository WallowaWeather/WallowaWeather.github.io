// nowcast/firewx.js - Wallowa Weather v008: NWS fire weather over Wallowa County for the Fire weather preset: Red Flag Warnings and
// Fire Weather Watches (and Extreme Fire Danger, where an office issues it) for the county's NWS fire weather zones, drawn like the
// NWS warnings (lined, in the NWS's own hazard colours; a watch dashed) with a faint fill. These are zone-wide alerts with no polygon
// of their own, so the zones' outlines come from api.weather.gov/zones (US government, public domain; already in the app's CSP; the
// service caches them 30 days). nws.js fetches only the storm-polygon events (POLY_EVENTS), so this makes one request of its own for
// the county's zones, every 5 minutes while the layer is on; if nws has zoneAlerts(zones, { signal }) (a FeatureCollection), that is
// used instead. Zone ids verified Nov-08-2026: fire weather zones ORZ692 + ORZ693 + ORZ695 cover the county (all but 0.01 %);
// public forecast zones ORZ050 (84 %) + ORZ502 (16 %), for the same drawing of frost, freeze, wind or flood watches (createZoneAlerts).
// v014: the active county's zones and NWS office (counties.js firewx); Wallowa's are the defaults.
'use strict';
import { createPoller, getJSON, clean, clockOf, dateOf } from './feeds.js';
import { inRings } from './lands.js';

export const NWS_API = 'https://api.weather.gov/';
export const FIRE_EVENTS = ['Red Flag Warning', 'Fire Weather Watch', 'Extreme Fire Danger'];
export const COUNTY_FIRE_ZONES = ['ORZ692', 'ORZ693', 'ORZ695'];
export const COUNTY_FORECAST_ZONES = ['ORZ050', 'ORZ502'];
/** the NWS's hazard colours (weather.gov/help-map, checked Nov-08-2026) */
export const NWS_COLORS = {
  'Red Flag Warning': '#FF1493', 'Fire Weather Watch': '#FFDEAD', 'Extreme Fire Danger': '#E9967A', 'Fire Warning': '#A0522D',
  'Severe Thunderstorm Warning': '#FFA500', 'Severe Thunderstorm Watch': '#DB7093', 'Flash Flood Warning': '#8B0000', 'Flash Flood Watch': '#2E8B57',
  'Flood Warning': '#00FF00', 'Flood Watch': '#2E8B57', 'Flood Advisory': '#00FF7F', 'Hydrologic Outlook': '#90EE90', 'Flash Flood Statement': '#8B0000', 'Flood Statement': '#00FF00',
  'Frost Advisory': '#6495ED', 'Freeze Warning': '#483D8B', 'Freeze Watch': '#00FFFF', 'Wind Advisory': '#D2B48C', 'High Wind Warning': '#DAA520', 'High Wind Watch': '#B8860B',
  'Extreme Heat Warning': '#C71585', 'Heat Advisory': '#FF7F50', 'Dense Smoke Advisory': '#F0E68C', 'Air Quality Alert': '#808080',
};
export const firewxNote = (office = 'Pendleton office') => `Fire weather from the National Weather Service (${office}), for its fire weather zones. A Red Flag Warning means critical fire weather (strong wind with low humidity, or lightning on dry fuels) is happening or coming soon; a Fire Weather Watch means it could within a day or two.`;
export const FIREWX_NOTE = firewxNote();
const ZONE_RE = /^[A-Z]{2}Z\d{3}$/;

export const zoneAlertsUrl = (zones) => `${NWS_API}alerts/active?status=actual&message_type=alert,update&zone=${zones.filter((z) => ZONE_RE.test(z)).join(',')}`;
export const zoneUrl = (kind, id) => `${NWS_API}zones/${kind === 'forecast' ? 'forecast' : 'fire'}/${id}`;

/** an api.weather.gov alerts FeatureCollection -> the alerts of `events` that touch `zones`: [{ id, event, color, watch, headline,
 *  description, instruction, area, onset, ends, sender, zones (ours), rings (the alert's own polygon, if it has one) }] */
export function parseZoneAlerts(j, { events = FIRE_EVENTS, zones = COUNTY_FIRE_ZONES } = {}) {
  const out = [], mine = new Set(zones);
  for (const f of (j && j.features) || []) {
    const p = f.properties || {}, event = clean(p.event, 80);
    if (!events.includes(event)) continue;
    const ugc = new Set(((p.geocode && p.geocode.UGC) || []).map((z) => clean(z, 8)));
    for (const u of p.affectedZones || []) { const m = /\/zones\/(?:fire|forecast|public)\/([A-Z]{2}Z\d{3})$/.exec(String(u)); if (m) ugc.add(m[1]); }
    const ours = [...ugc].filter((z) => mine.has(z));
    if (!ours.length) continue;
    const g = f.geometry, rings = [];
    if (g && g.type === 'Polygon') for (const r of g.coordinates) rings.push(r);
    else if (g && g.type === 'MultiPolygon') for (const poly of g.coordinates) for (const r of poly) rings.push(r);
    out.push({ id: clean(p.id || f.id, 200), event, color: NWS_COLORS[event] || '#AF52DE', watch: /watch/i.test(event), headline: clean(p.headline, 240),
      description: clean(p.description, 1200), instruction: clean(p.instruction, 600), area: clean(p.areaDesc, 300), onset: clean(p.onset || p.effective, 40),
      ends: clean(p.ends || p.expires, 40), sender: clean(p.senderName, 80), zones: ours.sort(), rings });
  }
  return out.sort((a, b) => a.watch - b.watch || events.indexOf(a.event) - events.indexOf(b.event));
}
/** a zone's Feature -> its rings ([[lon, lat]...]) */
export function zoneRings(j) {
  const g = j && j.geometry, out = [];
  if (g && g.type === 'Polygon') for (const r of g.coordinates) out.push(r);
  else if (g && g.type === 'MultiPolygon') for (const poly of g.coordinates) for (const r of poly) out.push(r);
  return out;
}
const boxOf = (rings) => { let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity; for (const r of rings) for (const [x, y] of r) { if (x < w) w = x; if (x > e) e = x; if (y < s) s = y; if (y > n) n = y; } return [w, s, e, n]; };
const when = (t) => { const d = new Date(t); if (!t || isNaN(d)) return ''; const today = new Date().toDateString() === d.toDateString(); return today ? clockOf(d) : `${dateOf(d).replace(/, \d{4}$/, '')}, ${clockOf(d)}`; };

/** the sheet text of a zone alert (v014: note = the county's fire weather note) */
export function zoneAlertInfo(a, note = FIREWX_NOTE) {
  const lines = [];
  if (a.headline) lines.push(a.headline);
  if (a.ends) lines.push(`Until ${when(a.ends)}`);
  if (a.instruction) lines.push(a.instruction);
  if (a.area) lines.push(a.area);
  return { kind: 'firewx', id: a.id, alert: a, title: a.event, color: a.color, badge: 'National Weather Service', lines,
    foot: (FIRE_EVENTS.includes(a.event) ? note + ' ' : '') + 'For warnings, follow the National Weather Service and your local officials.', link: { label: 'weather.gov', href: 'https://www.weather.gov/' } };
}

/** { nws, map, fetchFn, zones, kind ('fire' | 'forecast'), events, every, name, order, onChange(list, err), pollerOpts, note } ->
 *  { load(), alerts(), on(bool), isOn(), at(lat, lon), pick(list), refresh(force), error(), destroy(), overlay } */
export function createZoneAlerts({ nws = null, map = null, fetchFn = (...a) => fetch(...a), zones = COUNTY_FIRE_ZONES, kind = 'fire', events = FIRE_EVENTS,
  every = 5 * 60e3, name = 'ww-firewx', order = 20, onChange = () => {}, pollerOpts = {}, note = FIREWX_NOTE } = {}) {
  let list = [], err = null, active = false;
  const shapes = new Map();   // zone id -> rings (kept for the session)
  const overlay = { name, level: 0, order, draw: (ctx, api) => draw(ctx, api) };
  const opts = { fetchFn, accept: 'application/geo+json' };
  async function ringsOf(id, signal) {
    if (shapes.has(id)) return shapes.get(id);
    const r = zoneRings(await getJSON(zoneUrl(kind, id), Object.assign({ signal }, opts)));
    shapes.set(id, r); return r;
  }
  async function load(signal = null) {
    const j = nws && typeof nws.zoneAlerts === 'function' ? await nws.zoneAlerts(zones, { signal }) : await getJSON(zoneAlertsUrl(zones), Object.assign({ signal }, opts));
    const got = parseZoneAlerts(j, { events, zones });
    for (const a of got) {
      if (a.rings.length) { a.box = boxOf(a.rings); continue; }
      const rs = [];
      for (const z of a.zones) { try { rs.push(...(await ringsOf(z, signal))); } catch (e) { if (signal && signal.aborted) throw e; } }
      a.rings = rs; a.box = rs.length ? boxOf(rs) : null;
    }
    if (signal && signal.aborted) return list;
    list = got; err = null; onChange(list, null); if (map && active) map.draw();
    return list;
  }
  const poller = createPoller(Object.assign({ run: (signal) => load(signal), every, retry: 60e3, onError: (e) => { err = e; onChange(list, e); } }, pollerOpts));
  function on(v) {
    active = !!v;
    if (active) { if (map) map.addOverlay(overlay); poller.start(); } else { poller.stop(); if (map) map.removeOverlay(overlay.name); }
  }
  /** the alert under a tap (inside its zone) -> its sheet text, or null; warnings before watches */
  function at(lat, lon) {
    if (!active) return null;
    for (const a of list) {
      const b = a.box; if (!b || lon < b[0] || lon > b[2] || lat < b[1] || lat > b[3]) continue;
      if (inRings(a.rings, lon, lat)) return zoneAlertInfo(a, note);
    }
    return null;
  }
  /** "filters the existing NWS alerts": keep the alerts of these events from any list of alerts with .event (e.g. nws.at(lat, lon)) */
  const pick = (alerts) => (alerts || []).filter((a) => a && events.includes(a.event));
  function draw(ctx, api) {
    if (!list.length) return;
    const [vw, vs, ve, vn] = api.view;
    for (const a of [...list].reverse()) {   // watches first, warnings on top
      const b = a.box; if (!b || b[0] > ve || b[2] < vw || b[1] > vn || b[3] < vs) continue;
      ctx.beginPath();
      for (const ring of a.rings) { ring.forEach(([lon, lat], i) => { const p = api.toScreen(lat, lon); if (i) ctx.lineTo(p.x, p.y); else ctx.moveTo(p.x, p.y); }); ctx.closePath(); }
      // no fill (a zone is a big area: a tint would hide what is under it): a soft band just inside the edge shows which side is in it
      ctx.save(); ctx.clip('evenodd'); ctx.strokeStyle = a.color + (a.watch ? '38' : '59'); ctx.lineWidth = 14; ctx.stroke(); ctx.restore();
      ctx.lineJoin = 'round';
      if (a.watch) ctx.setLineDash([8, 5]);
      ctx.strokeStyle = 'rgba(0,0,0,0.5)'; ctx.lineWidth = 4.5; ctx.stroke();
      ctx.strokeStyle = a.color; ctx.lineWidth = 2.5; ctx.stroke(); ctx.setLineDash([]);
    }
  }
  return { load: () => load(null), alerts: () => list.slice(), on, isOn: () => active, at, pick, note, zones: () => zones.slice(), refresh: (force) => (active ? poller.refresh(force) : Promise.resolve(false)),
    error: () => err, destroy() { on(false); poller.destroy(); }, overlay, get poller() { return poller.state; } };
}

/** the county's NWS fire weather (Red Flag Warning, Fire Weather Watch, Extreme Fire Danger) over its fire weather zones */
export function fireWx(nws, opts = {}) {
  return createZoneAlerts(Object.assign({ nws, zones: COUNTY_FIRE_ZONES, kind: 'fire', events: FIRE_EVENTS, name: 'ww-firewx' }, opts));
}
