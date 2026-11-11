// nowcast/fires.js - Wallowa Weather v008: current wildfires in and near Wallowa County for the Fire weather preset, from the National
// Interagency Fire Center's public WFIGS services (ArcGIS Online, org NIFC_Authoritative, refreshed from IRWIN every 5 minutes):
//   "Current Wildland Fire Incident Locations" (points: name, size, discovery, containment, cause) and
//   "WFIGS Current Interagency Fire Perimeters" (the best available perimeter, where there is one).
// Terms (each item's own licenseInfo, checked Nov-08-2026): NIFC is not liable, the data are not legal documents and may change; credit
// in the item's accessInformation. Browser access checked: "Access-Control-Allow-Origin: *". No key. Asks only while the layer is on,
// at most every 15 minutes (2 requests), never while the page is hidden; off stops a request in flight. Wildfires and complexes are
// shown; prescribed fires (RX) only with { rx: true }.
'use strict';
import { createPoller, getJSON, clean, num, dateOf, clockOf, agoOf, pill } from './feeds.js';
import { inRings } from './lands.js';

export const FIRES_HOST = 'https://services3.arcgis.com';
const NIFC = 'https://services3.arcgis.com/T4QMspbfLg3qTGWY/arcgis/rest/services/';
export const INCIDENTS_URL = NIFC + 'WFIGS_Incident_Locations_Current/FeatureServer/0/query';
export const PERIMETERS_URL = NIFC + 'WFIGS_Interagency_Perimeters_Current/FeatureServer/0/query';
export const FIRES_ITEM = 'https://www.arcgis.com/home/item.html?id=4181a117dc9e43db8598533e29972015';
export const FIRES_CREDIT = 'Fires: NIFC WFIGS';
export const FIRES_NOTE = 'Current fires from the National Interagency Fire Center’s WFIGS data (IRWIN), as the agencies report them: the point is where a fire started, sizes and containment can lag, and small fires may not show. Not legal documents. Not an evacuation notice: follow your county’s emergency managers and the agency on the fire.';
/** [w, s, e, n]: the county and about 30 km around it */
export const FIRE_BOX = [-118.45, 44.6, -116.1, 46.3];
const INC_FIELDS = 'IncidentName,IncidentSize,DiscoveryAcres,FireDiscoveryDateTime,PercentContained,FireCause,FireCauseGeneral,IncidentTypeCategory,POOCounty,POOState,UniqueFireIdentifier,IrwinID,ModifiedOnDateTime_dt,IncidentShortDescription';
const PER_FIELDS = 'poly_IncidentName,poly_GISAcres,poly_IRWINID,poly_PolygonDateTime,attr_IncidentTypeCategory,attr_PercentContained,attr_IncidentSize';

const env = (box) => box.join(',');
export function incidentsUrl(box = FIRE_BOX) {
  return `${INCIDENTS_URL}?where=1%3D1&geometry=${env(box)}&geometryType=esriGeometryEnvelope&inSR=4326&spatialRel=esriSpatialRelIntersects&outFields=${INC_FIELDS}&outSR=4326&resultRecordCount=200&f=geojson`;
}
/** perimeters generalised by the server to about 50 m (maxAllowableOffset 0.0005 degree) */
export function perimetersUrl(box = FIRE_BOX) {
  return `${PERIMETERS_URL}?where=1%3D1&geometry=${env(box)}&geometryType=esriGeometryEnvelope&inSR=4326&spatialRel=esriSpatialRelIntersects&outFields=${PER_FIELDS}&outSR=4326&maxAllowableOffset=0.0005&geometryPrecision=5&resultRecordCount=100&f=geojson`;
}
const irwin = (s) => clean(s, 60).replace(/[{}]/g, '').toUpperCase();
const TYPES = { WF: 'Wildfire', RX: 'Prescribed fire', CX: 'Fire complex' };

/** the incidents response -> [{ id, uid, name, type, acres, discovered, contained, cause, causeGeneral, county, state, where, modified, lat, lon }] */
export function parseIncidents(j) {
  const out = [];
  for (const f of (j && j.features) || []) {
    const p = f.properties || {}, g = f.geometry;
    if (!g || g.type !== 'Point') continue;
    const lon = +g.coordinates[0], lat = +g.coordinates[1];
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) continue;
    const type = clean(p.IncidentTypeCategory, 4).toUpperCase();
    out.push({ id: irwin(p.IrwinID) || clean(p.UniqueFireIdentifier, 40), uid: clean(p.UniqueFireIdentifier, 40), name: clean(p.IncidentName, 80) || 'Unnamed fire', type,
      acres: num(p.IncidentSize) ?? num(p.DiscoveryAcres), discovered: num(p.FireDiscoveryDateTime), contained: num(p.PercentContained),
      cause: clean(p.FireCause, 30), causeGeneral: clean(p.FireCauseGeneral, 40), county: clean(p.POOCounty, 40), state: clean(p.POOState, 8).replace(/^US-/, ''),
      where: clean(p.IncidentShortDescription, 120), modified: num(p.ModifiedOnDateTime_dt), lat, lon });
  }
  return out.sort((a, b) => (b.acres || 0) - (a.acres || 0));
}
/** the perimeters response -> [{ id, name, acres, type, contained, polys: [[ring [[lon, lat]...]...]...], box }] */
export function parsePerimeters(j) {
  const out = [];
  for (const f of (j && j.features) || []) {
    const p = f.properties || {}, g = f.geometry; if (!g) continue;
    const polys = g.type === 'Polygon' ? [g.coordinates] : g.type === 'MultiPolygon' ? g.coordinates : null; if (!polys) continue;
    let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
    const clean2 = polys.map((poly) => poly.map((ring) => ring.filter((c) => Number.isFinite(+c[0]) && Number.isFinite(+c[1])).map((c) => { const x = +c[0], y = +c[1]; if (x < w) w = x; if (x > e) e = x; if (y < s) s = y; if (y > n) n = y; return [x, y]; })).filter((r) => r.length >= 3)).filter((p0) => p0.length);
    if (!clean2.length) continue;
    out.push({ id: irwin(p.poly_IRWINID), name: clean(p.poly_IncidentName, 80), acres: num(p.poly_GISAcres) ?? num(p.attr_IncidentSize), type: clean(p.attr_IncidentTypeCategory, 4).toUpperCase(),
      contained: num(p.attr_PercentContained), polys: clean2, box: [w, s, e, n] });
  }
  return out;
}
/** a fire mark's radius (CSS px) from its size */
export const fireRadius = (acres) => Math.round(6 + 2.4 * Math.log10(Math.max(1, acres || 1)));
/** the mark's colour: still growing (under half contained, or not reported) red, half contained orange, nearly out (90%+) brown */
export const fireColor = (f) => (f.type === 'RX' ? '#FF9F0A' : f.contained == null || f.contained < 50 ? '#FF3B30' : f.contained < 90 ? '#FF9500' : '#A2845E');
const fullName = (n) => (/\b(fire|complex|rx)\b/i.test(n) ? n : n + ' Fire');

/** the sheet text of a fire */
export function fireInfo(f, now = Date.now()) {
  const lines = [[TYPES[f.type] || 'Fire', f.acres != null ? `${f.acres >= 10 ? Math.round(f.acres).toLocaleString('en-US') : f.acres} acres` : 'size not reported',
    f.contained != null ? `${Math.round(f.contained)}% contained` : ''].filter(Boolean).join(' · ')];
  if (f.discovered) lines.push(`Discovered ${dateOf(f.discovered)}, ${clockOf(f.discovered)}`);
  const cause = f.causeGeneral || f.cause;
  if (cause && !/^(unknown|undetermined)$/i.test(cause)) lines.push(`Cause: ${cause.toLowerCase()}${f.causeGeneral && f.cause && f.cause.toLowerCase() !== f.causeGeneral.toLowerCase() ? ` (${f.cause.toLowerCase()})` : ''}`);
  else lines.push('Cause: not determined yet');
  const where = [f.where, [f.county && f.county + ' County', f.state].filter(Boolean).join(', ')].filter(Boolean).join(' · ');
  if (where) lines.push(where);
  if (f.modified) lines.push(`Updated ${agoOf(f.modified, now)}`);
  return { kind: 'fire', id: f.id, fire: f, title: fullName(f.name), color: fireColor(f), badge: '', lines, foot: FIRES_NOTE, link: { label: 'NIFC current fires data', href: FIRES_ITEM } };
}

/** { map, fetchFn, every, box, perimeters (bool), rx (bool: prescribed fires too), labelZ, onChange(list, err), now, pollerOpts } ->
 *  { on(bool), isOn(), refresh(force), list(), perimeters(), at(lat, lon, { pins, areas }), error(), destroy(), overlays: [areas, marks] } */
export function createFires({ map = null, fetchFn = (...a) => fetch(...a), every = 15 * 60e3, box = FIRE_BOX, perimeters = true, rx = false, labelZ = 9.5,
  onChange = () => {}, now = () => Date.now(), pollerOpts = {} } = {}) {
  let fires = [], perims = [], err = null, active = false, flame = null;
  const marks = { name: 'ww-fires', level: 1, order: 30, draw: (ctx, api) => drawMarks(ctx, api) };
  const areas = { name: 'ww-fire-perimeters', level: 0, order: 30, draw: (ctx, api) => drawAreas(ctx, api) };
  const keep = (f) => f.type === 'WF' || f.type === 'CX' || (rx && f.type === 'RX');
  async function run(signal) {
    const [inc, per] = await Promise.all([
      getJSON(incidentsUrl(box), { signal, fetchFn, accept: 'application/geo+json, application/json' }),
      perimeters ? getJSON(perimetersUrl(box), { signal, fetchFn, accept: 'application/geo+json, application/json' }).catch((e) => { if (signal.aborted) throw e; return null; }) : null,
    ]);
    if (inc && inc.error) throw new Error('NIFC: ' + clean(inc.error.message, 80));
    if (signal.aborted) return;
    fires = parseIncidents(inc).filter(keep);
    perims = per && !per.error ? parsePerimeters(per).filter(keep) : perims;
    err = null; onChange(fires, null); if (map && active) map.draw();
  }
  const poller = createPoller(Object.assign({ run, every, now, onError: (e) => { err = e; onChange(fires, e); } }, pollerOpts));
  function on(v) {
    active = !!v;
    if (active) { if (map) { map.addOverlay(areas); map.addOverlay(marks); } poller.start(); }
    else { poller.stop(); if (map) { map.removeOverlay(marks.name); map.removeOverlay(areas.name); } }
  }
  /** the fire under a tap: a mark first (pins), then a perimeter (areas) -> its sheet text, or null */
  function at(lat, lon, { pins = true, areas: inAreas = true } = {}) {
    if (!active) return null;
    if (pins) {
      let best = null, bd = Infinity;
      for (const f of fires) {
        let d;
        if (map) { const a = map.toScreen(lat, lon), b = map.toScreen(f.lat, f.lon); d = Math.hypot(a.x - b.x, a.y - b.y) / (fireRadius(f.acres) + 12); }
        else d = Math.hypot(lat - f.lat, (lon - f.lon) * Math.cos(lat * Math.PI / 180)) / 0.02;
        if (d < 1 && d < bd) { bd = d; best = f; }
      }
      if (best) return fireInfo(best, now());
    }
    if (inAreas) for (const p of perims) {
      const b = p.box; if (lon < b[0] || lon > b[2] || lat < b[1] || lat > b[3]) continue;
      if (p.polys.some((poly) => inRings(poly, lon, lat))) {
        const f = fires.find((x) => x.id && x.id === p.id);
        if (f) return fireInfo(f, now());
        return { kind: 'fire', id: p.id, title: fullName(p.name || 'Fire'), color: fireColor(p), badge: '', lines: [[TYPES[p.type] || 'Fire', p.acres != null ? `${Math.round(p.acres).toLocaleString('en-US')} acres (perimeter)` : '', p.contained != null ? `${Math.round(p.contained)}% contained` : ''].filter(Boolean).join(' · ')], foot: FIRES_NOTE, link: { label: 'NIFC current fires data', href: FIRES_ITEM } };
      }
    }
    return null;
  }
  function drawAreas(ctx, api) {
    if (!perims.length) return;
    const [vw, vs, ve, vn] = api.view;
    for (const p of perims) {
      const b = p.box; if (b[0] > ve || b[2] < vw || b[1] > vn || b[3] < vs) continue;
      ctx.beginPath();
      for (const poly of p.polys) for (const ring of poly) { ring.forEach(([x, y], i) => { const q = api.toScreen(y, x); if (i) ctx.lineTo(q.x, q.y); else ctx.moveTo(q.x, q.y); }); ctx.closePath(); }
      const c = fireColor(p);
      ctx.fillStyle = c + '30'; ctx.fill('evenodd');
      if (p.type === 'RX') ctx.setLineDash([5, 4]);
      ctx.lineJoin = 'round'; ctx.strokeStyle = 'rgba(0,0,0,0.45)'; ctx.lineWidth = 3.2; ctx.stroke();
      ctx.strokeStyle = c; ctx.lineWidth = 1.6; ctx.stroke(); ctx.setLineDash([]);
    }
  }
  function drawMarks(ctx, api) {
    if (!fires.length) return;
    if (!flame && typeof Path2D !== 'undefined') flame = new Path2D('M12 21a6 6 0 0 0 6-6c0-3.2-2-5.3-3.4-7.2-.4 1.6-1.2 2.6-2.3 3.1.3-2.9-.6-5.4-2.8-7.4.2 3.3-1.6 5-3 6.9A7.4 7.4 0 0 0 6 15a6 6 0 0 0 6 6Z');
    const [vw, vs, ve, vn] = api.view, placed = api.placed || (api.placed = []), vis = [];   // api.placed: shared by the level's overlays this frame
    for (const f of fires) {   // biggest first, so small ones are drawn on top
      if (f.lon < vw - 0.05 || f.lon > ve + 0.05 || f.lat < vs - 0.05 || f.lat > vn + 0.05) continue;
      const p = api.toScreen(f.lat, f.lon), r = fireRadius(f.acres), c = fireColor(f);
      ctx.beginPath(); ctx.arc(p.x, p.y, r, 0, 2 * Math.PI);
      if (f.type === 'RX') { ctx.fillStyle = 'rgba(20,20,20,0.55)'; ctx.fill(); ctx.setLineDash([3, 2]); ctx.strokeStyle = c; ctx.lineWidth = 2; ctx.stroke(); ctx.setLineDash([]); }
      else { ctx.fillStyle = c; ctx.fill(); ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.8; ctx.stroke(); }
      if (flame) { const s = (r * 1.25) / 24; ctx.save(); ctx.translate(p.x - 12 * s, p.y - 12.6 * s); ctx.scale(s, s); ctx.fillStyle = f.type === 'RX' ? c : '#fff'; ctx.fill(flame); ctx.restore(); }
      placed.push({ x: p.x - r, y: p.y - r, w: 2 * r, h: 2 * r }); vis.push([f, p, r]);
    }
    for (const [f, p, r] of vis) {   // names: the big fires from zoom 7.5, every fire from labelZ
      if (!(api.z >= labelZ || (api.z >= 7.5 && (f.acres || 0) >= 1000))) continue;
      const ac = f.acres != null ? ` · ${f.acres >= 10 ? Math.round(f.acres).toLocaleString('en-US') : f.acres} ac` : '';
      pill(ctx, api, p.x, p.y, `${f.name}${ac}`, placed, { dx: r + 4 });
    }
  }
  return { on, isOn: () => active, refresh: (force) => (active ? poller.refresh(force) : Promise.resolve(false)), list: () => fires.slice(), perimeters: () => perims.slice(),
    at, error: () => err, destroy() { on(false); poller.destroy(); }, overlays: [areas, marks], get poller() { return poller.state; } };
}
