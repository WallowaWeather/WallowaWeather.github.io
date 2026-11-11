// nowcast/affected.js - "Properties possibly affected".
// A round warning button for the map's right margin with a red count, and a panel that slides in from the right: how many Wallowa County
// tax lots touch the warning areas (app alerts, NWS warnings, BEAM hail areas), each area's lots in bold red, the disclaimer in gray.
// Source: the county's PUBLIC Taxlots_Public service (parcels.js): OBJECTID and Taxlot (the lot's number on its county tax map, digits
// only, NOT unique county-wide) and each lot's centre point. No owner names exist there and none are ever asked for, searched or kept.
// Zones outside the county send nothing. Results live in memory only (nothing is saved, nothing is exported; Share sends the count and
// the warning, never the list).
// v014: the active county's lot service and words (counties.js: url, idField, lotField, maxRecords, short); Wallowa's are the defaults.
'use strict';

import { PARCELS_URL } from './parcels.js';
import { icon } from './icons.js';

export const AFFECTED_CAP = 20000;   // stop paging there and say "more than" (the whole county is about 8,600 lots)
export const OUTLINE_MAX = 400;      // a zone with this many lots or fewer gets its lots outlined on the map (zoom 12+)
export const OUTLINE_MIN_Z = 12;
const PAGE = 2000;                   // the service's maxRecordCount
const ROW_H = 56, OVERSCAN = 8;      // the list draws only the rows on screen (+ a few): thousands scroll smoothly
const MAX_CACHE = 24, MAX_SHAPES = 3000;

/** v014: the disclaimer for a county (owners false: it publishes no owner names online) */
export const afDisclaimer = (county = 'Wallowa County', owners = false) => 'These are the tax lots that touch the warning area, so they may be affected. Not a damage report or an official '
  + `warning: follow the National Weather Service. Lot lines are from ${county}’s public map, not a survey. Owner names aren’t shown${owners === false ? ': the '
  + 'county doesn’t publish them online' : ''}.`;
export const AF_DISCLAIMER = afDisclaimer();
export const AF_ERROR = 'Couldn’t reach the county’s lot map. Try again.';

// ------------------------------------------------------------------------------------------------ pure helpers (tested in node)
const fmt = (n) => Number(n || 0).toLocaleString('en-US');
const isPt = (p) => Array.isArray(p) && p.length >= 2 && Number.isFinite(p[0]) && Number.isFinite(p[1]) && Math.abs(p[0]) <= 180 && Math.abs(p[1]) <= 90;
const str = (v, n) => String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, n);

/** severity, 0 = most severe: red, orange, yellow (app alerts, BEAM), then NWS warnings, then anything else */
export function zoneRank(z) {
  const lv = { red: 0, orange: 1, yellow: 2 }[z && z.level];
  if (lv != null) return lv;
  return z && z.source === 'nws' ? 3 : 4;
}
/** rings -> [west, south, east, north] */
export function boxOf(rings) {
  let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
  for (const r of rings) for (const [lon, lat] of r) { if (lon < w) w = lon; if (lon > e) e = lon; if (lat < s) s = lat; if (lat > n) n = lat; }
  return [w, s, e, n];
}
/** a box [w, s, e, n] against the county's bbox [south, west, north, east] (the app's order) */
export function overlapsCounty(box, bbox) {
  const [bs, bw, bn, be] = bbox;
  return !(box[2] < bw || box[0] > be || box[3] < bs || box[1] > bn);
}
/** a short hash of the rings rounded to 4 decimals (about 10 m): a zone that moves gets a new key, a re-sent one keeps its key */
export function ringHash(rings) {
  const s = rings.map((r) => r.map(([lon, lat]) => `${Math.round(lon * 1e4)},${Math.round(lat * 1e4)}`).join(';')).join('|');
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(36);
}
const safeColor = (c) => (typeof c === 'string' && /^(#[0-9a-f]{3,8}|rgba?\([\d\s.,%]+\))$/i.test(c.trim()) ? c.trim() : '#FF3B30');
const untilMs = (u) => { if (u == null || u === '') return null; const t = typeof u === 'number' ? u : Date.parse(u); return Number.isFinite(t) ? t : null; };

/** a zone as given -> the module's own copy (or null: no usable rings). zones: { id, label, color, level, rings, until (ms), source } */
export function normZone(z, order = 0) {
  if (!z || !Array.isArray(z.rings) || !z.rings.length) return null;
  let rings = isPt(z.rings[0]) ? [z.rings] : z.rings;   // one ring passed bare: accept it
  rings = rings.filter((r) => Array.isArray(r) && r.length >= 3 && r.every(isPt)).map((r) => {
    const a = r[0], b = r[r.length - 1]; const out = r.map((p) => [p[0], p[1]]);
    if (a[0] !== b[0] || a[1] !== b[1]) out.push([a[0], a[1]]);   // Esri wants closed rings
    return out;
  });
  if (!rings.length) return null;
  const id = z.id == null ? '' : str(z.id, 200);
  return { key: `${id}|${ringHash(rings)}`, id, label: str(z.label || z.event, 80) || 'Warning area', color: safeColor(z.color), level: z.level || null,
    source: z.source || 'other', until: untilMs(z.until != null ? z.until : z.ends), rings, box: boxOf(rings), order, src: z };
}

/** the list query for one zone (one page): lot numbers and centre points, no outlines (v014: fields = the county's id and lot fields;
 *  centroid false = a service that gives no centre points (a MapServer that ignores returnCentroid): outlines simplified to ~10 m instead, whose
 *  middle stands in) */
export function listBody(rings, offset = 0, count = PAGE, { idField = 'OBJECTID', lotField = 'Taxlot', centroid = true } = {}) {
  const q = new URLSearchParams({
    where: '1=1',
    geometry: JSON.stringify({ rings: rings.map((r) => r.map(([lon, lat]) => [+lon.toFixed(6), +lat.toFixed(6)])), spatialReference: { wkid: 4326 } }),
    geometryType: 'esriGeometryPolygon', inSR: '4326', spatialRel: 'esriSpatialRelIntersects',
    outFields: `${idField},${lotField}`, returnGeometry: 'false', returnCentroid: 'true', outSR: '4326', geometryPrecision: '5',
    orderByFields: `${lotField},${idField}`,   // Taxlot repeats (one "100" per tax map): OBJECTID breaks ties so pages never skip or repeat a lot
    resultOffset: String(offset), resultRecordCount: String(count), f: 'json',
  });
  if (!centroid) { q.set('returnGeometry', 'true'); q.delete('returnCentroid'); q.set('maxAllowableOffset', '0.0001'); }
  return q;
}
/** the outline query: these lots' shapes, simplified to about 5 m */
export function shapesBody(ids, idField = 'OBJECTID') {
  return new URLSearchParams({ where: '1=1', objectIds: ids.join(','), outFields: idField, returnGeometry: 'true', outSR: '4326',
    maxAllowableOffset: '0.00005', geometryPrecision: '6', f: 'json' });
}
async function postForm(fetchFn, url, body, signal) {
  const r = await fetchFn(url, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: body.toString(), signal,
    credentials: 'omit', referrerPolicy: 'no-referrer' });
  if (!r || r.ok === false) throw new Error(`county lot map: HTTP ${r ? r.status : '?'}`);
  const d = await r.json();
  if (!d || d.error) throw new Error('county lot map: an error answer');
  return d;
}
/** the middle of an outline's box ({ x, y }), for a service with no centre points */
function middleOf(g) {
  const rs = g && Array.isArray(g.rings) ? g.rings : null; if (!rs) return null;
  let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
  for (const r of rs) for (const p of r) if (isPt(p)) { if (p[0] < w) w = p[0]; if (p[0] > e) e = p[0]; if (p[1] < s) s = p[1]; if (p[1] > n) n = p[1]; }
  return w <= e ? { x: (w + e) / 2, y: (s + n) / 2 } : null;
}
function lotOf(f, idField = 'OBJECTID', lotField = 'Taxlot') {
  const a = (f && (f.attributes || f.properties)) || {}, id = Number(a[idField] != null ? a[idField] : f && f.id);
  if (!Number.isFinite(id)) return null;
  const c = f.centroid || middleOf(f.geometry), ok = c && Number.isFinite(c.x) && Number.isFinite(c.y);
  return { objectid: id, lot: str(a[lotField], 24), lat: ok ? +c.y.toFixed(5) : null, lon: ok ? +c.x.toFixed(5) : null };
}
/** every lot that touches a zone (paged past 2,000; at most `cap`) -> { lots: [{ objectid, lot, lat, lon }], capped } */
export async function listZone(rings, { fetchFn = (...a) => fetch(...a), url = PARCELS_URL, signal, cap = AFFECTED_CAP, page = PAGE, idField = 'OBJECTID', lotField = 'Taxlot', centroid = true } = {}) {
  const lots = [], seen = new Set(); let off = 0, capped = false;
  for (let k = 0, kmax = Math.ceil(cap / page) + 2; ; k++) {
    if (k >= kmax) { capped = true; break; }
    const d = await postForm(fetchFn, url, listBody(rings, off, page, { idField, lotField, centroid }), signal);
    const fs = Array.isArray(d.features) ? d.features : [];
    for (const f of fs) { const l = lotOf(f, idField, lotField); if (!l || seen.has(l.objectid)) continue; seen.add(l.objectid); lots.push(l); }
    const more = fs.length > 0 && (!!d.exceededTransferLimit || !!(d.properties && d.properties.exceededTransferLimit) || fs.length >= page);
    if (lots.length >= cap) { capped = more || lots.length > cap; break; }
    if (!more) break;
    off += fs.length;
  }
  if (lots.length > cap) lots.length = cap;
  return { lots, capped };
}
/** shapes of lots by OBJECTID -> Map(id -> { rings, box }) */
export async function fetchShapes(ids, { fetchFn = (...a) => fetch(...a), url = PARCELS_URL, signal, idField = 'OBJECTID' } = {}) {
  const out = new Map(); if (!ids.length) return out;
  const d = await postForm(fetchFn, url, shapesBody(ids, idField), signal);
  for (const f of d.features || []) {
    const id = Number(f.attributes && f.attributes[idField]), g = f.geometry;
    if (!Number.isFinite(id) || !g || !Array.isArray(g.rings)) continue;
    const rings = g.rings.filter((r) => Array.isArray(r) && r.length >= 3 && r.every(isPt));
    if (rings.length) out.set(id, { rings, box: boxOf(rings) });
  }
  return out;
}

const numOf = (s) => { const m = /^\d+/.exec(s || ''); return m ? +m[0] : Infinity; };
/** lot number order (100, 101, 200 ... 1200, 10100), then north to south (the same number on different tax maps) */
export const byLot = (a, b) => (numOf(a.lot) - numOf(b.lot)) || (a.lot < b.lot ? -1 : a.lot > b.lot ? 1 : 0)
  || ((b.lat == null ? -999 : b.lat) - (a.lat == null ? -999 : a.lat)) || (a.objectid - b.objectid);

/** entries [{ zone (normZone), result: { lots, capped } | null, failed }] -> { groups: [{ zone, lots, raw, dup, failed, capped }], total, capped,
 *  failed, outline: Set of OBJECTIDs to outline }. A lot in two zones is listed once, under the most severe one. */
export function mergeZones(entries, { outlineMax = OUTLINE_MAX } = {}) {
  const sorted = entries.slice().sort((a, b) => zoneRank(a.zone) - zoneRank(b.zone) || (a.zone.order || 0) - (b.zone.order || 0));
  const seen = new Set(), groups = [], outline = new Set(); let capped = false, failed = 0;
  for (const { zone, result, failed: bad } of sorted) {
    if (!result) { if (bad) failed++; groups.push({ zone, lots: [], raw: 0, dup: 0, failed: !!bad, capped: false, pending: !bad }); continue; }
    const lots = [];
    for (const l of result.lots) { if (seen.has(l.objectid)) continue; seen.add(l.objectid); lots.push(l); }
    lots.sort(byLot);
    if (result.capped) capped = true;
    if (result.lots.length <= outlineMax) for (const l of result.lots) outline.add(l.objectid);
    groups.push({ zone, lots, raw: result.lots.length, dup: result.lots.length - lots.length, failed: false, capped: !!result.capped, pending: false });
  }
  return { groups, total: seen.size, capped, failed, outline, loading: false };
}

/** "Tax lot 1200" (+ " · map 2S4508" if a lot ever comes with its tax map) */
export function formatLot(l) {
  const n = str(l && l.lot, 24), m = str(l && l.map, 24);
  return `${n ? `Tax lot ${n}` : 'Tax lot (no number)'}${m ? ` · map ${m}` : ''}`;
}
export function headline(n, capped = false) {
  if (capped) return `More than ${fmt(n)} properties possibly affected`;
  if (!n) return 'No properties in the warning areas';
  return `${fmt(n)} ${n === 1 ? 'property' : 'properties'} possibly affected`;
}
/** the badge: 656, 1.3k, 13k (+ when capped) */
export function compactCount(n, capped = false) {
  const s = n < 1000 ? String(n) : n < 10000 ? `${(Math.round(n / 100) / 10).toFixed(1).replace(/\.0$/, '')}k` : `${Math.round(n / 1000)}k`;
  return capped ? `${s}+` : s;
}
export function clock(t) {
  try { return new Date(t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }).replace(/ /g, ' '); } catch (e) { return new Date(t).toISOString().slice(11, 16); }
}
export function untilText(until, now = Date.now()) {
  if (until == null) return '';
  if (until < now) return `ended ${clock(until)}`;
  const d = new Date(until), sameDay = d.toDateString() === new Date(now).toDateString();
  return `until ${sameDay ? '' : `${d.toLocaleDateString([], { weekday: 'short' })} `}${clock(until)}`;
}
const SOURCE = { app: 'App alert', beam: 'BEAM', nws: 'NWS' };
/** the text Share sends: the count and the warnings, never the list (v014: county = the county's short name) */
export function shareText(m, now = Date.now(), county = 'Wallowa County') {
  const zs = m.groups.filter((g) => g.raw > 0).map((g) => g.zone);   // every warning that covers a listed lot
  const what = zs.map((z) => [z.label, untilText(z.until, now)].filter(Boolean).join(' ')).join(' · ');
  const n = m.total, verb = n === 1 && !m.capped ? 'is' : 'are';
  const count = m.capped ? `More than ${fmt(n)} properties` : `${fmt(n)} ${n === 1 ? 'property' : 'properties'}`;
  return `Wallowa Weather: ${count} (${county} tax lots) ${verb} in the warning area and may be affected.${what ? ` ${what}.` : ''}`
    + ' Experimental, not an official warning: follow the National Weather Service.';
}
const DIRS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
/** "0.4 mi NW of Wallowa" from a list of { name, lat, lon } (the nearest within 25 mi), else '' */
export function nearWords(lat, lon, places) {
  if (lat == null || !places || !places.length) return '';
  const k = Math.cos(lat * Math.PI / 180); let best = null, bd = Infinity;
  for (const p of places) { const d = (p.lat - lat) ** 2 + ((p.lon - lon) * k) ** 2; if (d < bd) { bd = d; best = p; } }
  const mi = Math.sqrt(bd) * 69.09; if (!best || mi > 25) return '';
  const deg = (Math.atan2((lon - best.lon) * k, lat - best.lat) * 180 / Math.PI + 360) % 360;
  return `${mi < 0.1 ? '0.1' : mi.toFixed(1)} mi ${DIRS[Math.round(deg / 45) % 8]} of ${str(best.name, 40)}`;
}
export const coordsText = (lat, lon) => (lat == null ? '' : `${Math.abs(lat).toFixed(4)}° ${lat >= 0 ? 'N' : 'S'}, ${Math.abs(lon).toFixed(4)}° ${lon >= 0 ? 'E' : 'W'}`);

// ------------------------------------------------------------------------------------------------ the data side (no DOM)
/** -> { setZones(zones), retry(), state(), destroy() }; onChange(state) after each change. state = mergeZones(...) + loading */
export function createAffectedData({ bbox, fetchFn = (...a) => fetch(...a), url = PARCELS_URL, cap = AFFECTED_CAP, outlineMax = OUTLINE_MAX,
  debounceMs = 350, concurrency = 2, onChange = () => {}, page = PAGE, idField = 'OBJECTID', lotField = 'Taxlot', centroid = true } = {}) {
  const cache = new Map();   // key -> { lots, capped } (the newest 24)
  const live = new Map();    // key -> AbortController (a request on its way)
  const failed = new Set();  // keys whose last try failed (tried again on retry() or when the zones change)
  const queue = [];
  let zones = [], sig = '', timer = 0, gone = false, running = 0;
  let state = Object.assign(mergeZones([]), { loading: false });
  const emit = () => { if (!gone) { try { onChange(state); } catch (e) { console.error('[affected]', e); } } };
  function remerge() {
    const loading = zones.some((z) => live.has(z.key) || (!cache.has(z.key) && !failed.has(z.key)));
    if (loading && zones.length) { if (!state.loading) { state = Object.assign({}, state, { loading: true }); emit(); } return; }   // keep the old list until all are in: no flicker
    state = Object.assign(mergeZones(zones.map((z) => ({ zone: z, result: cache.get(z.key) || null, failed: failed.has(z.key) })), { outlineMax }), { loading: false });
    emit();
  }
  function pump() {
    while (running < concurrency && queue.length) {
      const z = queue.shift(); if (!live.has(z.key)) continue;
      const ctrl = live.get(z.key); running++;
      listZone(z.rings, { fetchFn, url, signal: ctrl.signal, cap, page, idField, lotField, centroid })
        .then((res) => { if (live.get(z.key) !== ctrl) return; cache.delete(z.key); cache.set(z.key, res); failed.delete(z.key); while (cache.size > MAX_CACHE) cache.delete(cache.keys().next().value); })
        .catch(() => { if (live.get(z.key) === ctrl && !ctrl.signal.aborted) failed.add(z.key); })
        .finally(() => { running--; if (live.get(z.key) === ctrl) live.delete(z.key); if (!gone) { remerge(); pump(); } });
    }
  }
  function sync() {
    timer = 0; if (gone) return;
    for (const z of zones) {
      if (cache.has(z.key) || live.has(z.key) || failed.has(z.key)) continue;
      live.set(z.key, new AbortController()); queue.push(z);
    }
    pump(); remerge();
  }
  function setZones(list) {
    if (gone) return;
    const next = []; let order = 0;
    for (const z of list || []) { const n = normZone(z, order++); if (n && overlapsCounty(n.box, bbox)) next.push(n); }   // outside the county: nothing is sent
    const seenKey = new Set(), uniq = next.filter((z) => !seenKey.has(z.key) && seenKey.add(z.key));
    const s = uniq.map((z) => z.key).join(',');
    if (s === sig) {   // the same areas again (the app calls this on every render): nothing is fetched or rebuilt; words and times kept fresh
      let words = false, rank = false;
      uniq.forEach((n, i) => {
        const o = zones[i]; o.src = n.src;
        if (o.level !== n.level || o.source !== n.source) rank = true;
        for (const f of ['label', 'color', 'until', 'source', 'level']) if (o[f] !== n[f]) { o[f] = n[f]; words = true; }
      });
      if (rank && !timer) remerge();   // a new severity can move lots between areas
      else if (words) { state = Object.assign({}, state, { meta: (state.meta || 0) + 1 }); emit(); }
      return;
    }
    sig = s; zones = uniq;
    for (const [k, c] of live) if (!seenKey.has(k)) { c.abort(); live.delete(k); }   // areas gone: their requests stop
    for (const k of [...failed]) if (!seenKey.has(k)) failed.delete(k);
    clearTimeout(timer); timer = 0;
    if (!zones.length) { state = Object.assign(mergeZones([]), { loading: false }); emit(); return; }
    if (zones.every((z) => cache.has(z.key))) { remerge(); return; }
    remerge();
    timer = setTimeout(sync, debounceMs);   // the zones settle (a run's frames come in one by one): one round of requests
  }
  function retry() { failed.clear(); clearTimeout(timer); sync(); }
  function destroy() { gone = true; clearTimeout(timer); for (const c of live.values()) c.abort(); live.clear(); queue.length = 0; cache.clear(); }
  return { setZones, retry, destroy, state: () => state, zones: () => zones };
}

// ------------------------------------------------------------------------------------------------ the button, the panel, the outlines
const NS = 'http://www.w3.org/2000/svg';
function shareIcon() {
  const s = document.createElementNS(NS, 'svg'); s.setAttribute('viewBox', '0 0 24 24'); s.setAttribute('width', '20'); s.setAttribute('height', '20');
  s.setAttribute('aria-hidden', 'true'); s.setAttribute('class', 'af-ic'); s.setAttribute('fill', 'none'); s.setAttribute('stroke', 'currentColor');
  s.setAttribute('stroke-width', '1.8'); s.setAttribute('stroke-linecap', 'round'); s.setAttribute('stroke-linejoin', 'round');
  for (const d of ['M12 3.5v11', 'M8 7.5l4-4 4 4', 'M8.5 10.5H6v10h12v-10h-2.5']) { const p = document.createElementNS(NS, 'path'); p.setAttribute('d', d); s.append(p); }
  return s;
}
const reduced = () => { try { return matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (e) { return false; } };

/** bbox: the county [south, west, north, east]; onLot({ objectid, lot, label, lat, lon, zone }): a row was tapped (centre the map there);
 *  map: the nowcast map (optional: outlines at zoom 12+); places: [{ name, lat, lon }] or a function giving them (rows say "0.4 mi NW of
 *  Wallowa"); placeOf(lat, lon) -> string overrides that. v014: url, idField, lotField, page = the county's lot service, county = its short
 *  name, owners (false: it publishes no owner names online), centroid (false: its service gives no centre points). -> { button, panel, setZones(zones), open(), close(), destroy(), setOutline(on),
 *  retry(), state } */
export function createAffected({ bbox, onLot = () => {}, fetchFn = (...a) => fetch(...a), map = null, url = PARCELS_URL, places = null, placeOf = null,
  closeOnLot = true, outline: outlineOn = false, debounceMs = 350, cap = AFFECTED_CAP, outlineMax = OUTLINE_MAX,
  page = PAGE, idField = 'OBJECTID', lotField = 'Taxlot', county = 'Wallowa County', owners = false, centroid = true } = {}) {
  const mk = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  let isOpen = false, outline = !!outlineOn, selected = null, gone = false, lastGroups = null, popped = false, closeT = 0, raf = 0, lastFocus = null;

  // the button (the lead puts it under Locate)
  const button = mk('button', 'nc-round af-btn'); button.type = 'button'; button.hidden = true;
  const badge = mk('span', 'af-badge'); button.append(icon('alert'), badge);
  button.setAttribute('aria-label', 'Properties possibly affected by the warning'); button.setAttribute('aria-haspopup', 'dialog');
  button.addEventListener('click', () => open());

  // the panel: a scrim and a side sheet from the right
  const panel = mk('div', 'af-layer'); panel.hidden = true;
  const scrim = mk('div', 'af-scrim');
  const box = mk('section', 'af-panel'); box.setAttribute('role', 'dialog'); box.setAttribute('aria-modal', 'true'); box.setAttribute('aria-labelledby', 'af-count');
  const head = mk('header', 'af-head'), bar = mk('div', 'af-bar');
  const kicker = mk('p', 'af-kicker'); kicker.append(icon('alert', 'af-ic sm', 16), mk('span', null, 'Storm warning · properties'));
  const shareB = mk('button', 'af-share'); shareB.type = 'button'; const shareT = mk('span', null, 'Share'); shareB.append(shareIcon(), shareT);
  shareB.setAttribute('aria-label', 'Share the count and the warning (not the list)');
  const xB = mk('button', 'af-x'); xB.type = 'button'; xB.setAttribute('aria-label', 'Close'); const xDisc = mk('span', 'af-x-disc'); xDisc.append(icon('close', 'af-ic', 18)); xB.append(xDisc);
  bar.append(kicker, shareB, xB);
  const count = mk('h2', 'af-count'); count.id = 'af-count'; count.setAttribute('aria-live', 'polite');
  const sub = mk('p', 'af-sub', `${county} tax lots that touch the warning areas`);
  const note = mk('p', 'af-note'); note.hidden = true; const noteT = mk('span', null, AF_ERROR.replace(/ Try again\.$/, '')), againB = mk('button', 'af-again', 'Try again'); againB.type = 'button'; note.append(noteT, againB);
  head.append(bar, count, sub, note);
  let tog = null, togIn = null;
  if (map) {
    tog = mk('label', 'af-tog'); togIn = mk('input'); togIn.type = 'checkbox'; togIn.checked = outline;
    const tt = mk('span', 'af-tog-t'); tt.append(mk('b', null, 'Outline them on the map'), mk('span', null, `Zoomed in close · areas with ${OUTLINE_MAX} lots or fewer`));
    tog.append(tt, togIn); head.append(tog);
    togIn.addEventListener('change', () => setOutline(togIn.checked));
  }
  const scroll = mk('div', 'af-scroll'); scroll.tabIndex = -1;
  const foot = mk('footer', 'af-foot', afDisclaimer(county, owners));
  box.append(head, scroll, foot); panel.append(scrim, box);

  // ---- data
  const data = createAffectedData({ bbox, fetchFn, url, cap, outlineMax, debounceMs, page, idField, lotField, centroid, onChange: () => update() });
  const st = () => data.state();

  // ---- where a lot is, in words (worked out only for the rows on screen, then kept on the lot)
  let placeList = null, placeSrc = null;
  function nearPlaces() {
    const src = typeof places === 'function' ? places() : places;
    if (src !== placeSrc) {
      placeSrc = src; const [s, w, n, e] = bbox, m = 0.4;
      placeList = Array.isArray(src) ? src.filter((p) => p && Number.isFinite(p.lat) && Number.isFinite(p.lon) && p.lat > s - m && p.lat < n + m && p.lon > w - m && p.lon < e + m) : [];
    }
    return placeList;
  }
  function whereOf(l) {
    if (l.w != null) return l.w;
    if (l.lat == null) return '';
    let s = '';
    if (placeOf) { try { s = str(placeOf(l.lat, l.lon), 60); } catch (e) { s = ''; } if (s) return (l.w = s); }
    const P = nearPlaces(); s = nearWords(l.lat, l.lon, P);
    if (s) return (l.w = s);
    return P.length ? (l.w = coordsText(l.lat, l.lon)) : coordsText(l.lat, l.lon);   // no places yet: try them again next time
  }

  // ---- the button
  function update() {
    if (gone) return;
    const m = st(), hasZones = data.zones().length > 0;
    const show = hasZones && (m.total > 0 || (m.failed > 0 && !m.loading));
    button.hidden = !show;
    if (m.total > 0) {
      const t = compactCount(m.total, m.capped); if (badge.textContent !== t) { badge.textContent = t; if (!popped && !reduced()) { badge.classList.remove('af-popin'); void badge.offsetWidth; badge.classList.add('af-popin'); } popped = true; }
      button.setAttribute('aria-label', `${headline(m.total, m.capped)} by the warning. Show the list`);
    } else { badge.textContent = ''; popped = false; button.setAttribute('aria-label', m.failed ? 'Properties in the warning area: couldn’t count them. Show' : 'Properties possibly affected by the warning'); }
    if (selected && !m.loading && !m.groups.some((g) => g.lots.some((l) => l.objectid === selected.objectid))) selected = null;
    if (isOpen) renderPanel();
    ensureShapes();
    if (map) map.draw();
  }

  // ---- the panel
  let secs = []; const pool = [];
  function metaLine(g) {
    const z = g.zone, parts = [SOURCE[z.source] || '', untilText(z.until)];
    if (g.failed) parts.push('couldn’t count');
    else if (!g.pending) parts.push(`${g.capped ? 'more than ' : ''}${fmt(g.lots.length)} ${g.lots.length === 1 ? 'lot' : 'lots'}`);
    if (g.dup) parts.push(`${fmt(g.dup)} more above`);
    return parts.filter(Boolean).join(' · ');
  }
  function emptyLine(g) {
    if (g.failed) return 'Not counted: the county’s lot map didn’t answer.';
    if (g.pending) return 'Counting…';
    if (g.dup) return 'All its lots are listed above.';
    return 'No tax lots in this area.';
  }
  let lastMeta = 0;
  function renderPanel() {
    const m = st(), counting = m.loading && !m.groups.length, unknown = !m.total && m.failed > 0;
    count.textContent = counting ? 'Counting the properties…' : unknown ? 'Properties in the warning areas' : headline(m.total, m.capped);
    count.classList.toggle('wait', counting || !m.total);
    shareB.hidden = !m.total;
    note.hidden = !(m.failed > 0 && !m.loading);
    if (tog) tog.hidden = !m.total;
    if (m.groups !== lastGroups) { lastGroups = m.groups; lastMeta = m.meta || 0; buildSections(m); }
    else if ((m.meta || 0) !== lastMeta) {   // same lots, new words (a label, an end time): the headings only
      lastMeta = m.meta || 0;
      for (const s of secs) { s.title.textContent = s.g.zone.label; s.meta.textContent = metaLine(s.g); s.mark.style.setProperty('--zc', s.g.zone.color); }
    }
    paintRows();
  }
  function buildSections(m) {
    const keep = scroll.scrollTop;   // new results while reading: stay where you were
    for (const s of secs) for (const el of s.live.values()) { el.remove(); pool.push(el); }
    scroll.textContent = ''; secs = [];
    m.groups.forEach((g, si) => {
      const sec = mk('section', 'af-sec'), h = mk('div', 'af-sec-h'), mark = mk('i', 'af-mark'); mark.style.setProperty('--zc', g.zone.color);
      const title = mk('b', 'af-sec-t', g.zone.label), meta = mk('span', 'af-sec-m', metaLine(g)), t = mk('div', 'af-sec-tx'); t.append(title, meta);
      h.append(mark, t); sec.append(h);
      const rows = mk('div', 'af-rows'); rows.style.height = `${g.lots.length * ROW_H}px`; sec.append(rows);
      if (!g.lots.length && !g.failed) sec.append(mk('p', 'af-sec-empty', emptyLine(g)));   // failed: the heading says so, the top line offers Try again
      scroll.append(sec); secs.push({ g, si, rows, title, meta, mark, live: new Map() });
    });
    if (!m.groups.length && !m.loading) scroll.append(mk('p', 'af-sec-empty', `No warning areas in ${county} right now.`));
    if (keep) scroll.scrollTop = keep;
  }
  function makeRow() {
    const el = mk('button', 'af-row'); el.type = 'button';
    el.append(mk('b', 'af-lot'), mk('span', 'af-where'));
    return el;
  }
  function paintRows() {
    raf = 0; if (!isOpen) return;
    const top = scroll.scrollTop, h = scroll.clientHeight || 640;
    for (const s of secs) {
      const n = s.g.lots.length; if (!n) continue;
      const y0 = s.rows.offsetTop, a = Math.max(0, Math.floor((top - y0) / ROW_H) - OVERSCAN), b = Math.min(n, Math.ceil((top + h - y0) / ROW_H) + OVERSCAN);
      for (const [i, el] of s.live) if (i < a || i >= b) { el.remove(); s.live.delete(i); pool.push(el); }
      for (let i = a; i < b; i++) {
        if (s.live.has(i)) continue;
        const el = pool.pop() || makeRow(), l = s.g.lots[i];
        el.firstChild.textContent = formatLot(l); el.lastChild.textContent = whereOf(l);
        el.dataset.s = String(s.si); el.dataset.i = String(i); el.style.transform = `translateY(${i * ROW_H}px)`;
        el.classList.toggle('sel', !!selected && selected.objectid === l.objectid);
        s.rows.append(el); s.live.set(i, el);
      }
    }
  }
  scroll.addEventListener('scroll', () => { if (!raf) raf = requestAnimationFrame(paintRows); }, { passive: true });
  const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => { if (isOpen && !raf) raf = requestAnimationFrame(paintRows); }) : null;
  if (ro) ro.observe(scroll);

  scroll.addEventListener('click', (e) => {
    const el = e.target.closest && e.target.closest('.af-row'); if (!el) return;
    const s = secs[+el.dataset.s], l = s && s.g.lots[+el.dataset.i]; if (!l) return;
    selected = l; for (const x of scroll.querySelectorAll('.af-row.sel')) x.classList.remove('sel'); el.classList.add('sel');
    loadSelected();
    try { onLot({ objectid: l.objectid, lot: l.lot, label: formatLot(l), lat: l.lat, lon: l.lon, zone: s.g.zone.src }); } catch (err) { console.error('[affected] onLot', err); }
    if (closeOnLot) close('lot');
  });

  // ---- open / close (slides in from the right; reduced motion: no slide)
  function open() {
    if (gone) return;
    if (!panel.isConnected) (button.closest('.nc') || document.body).append(panel);   // the lead normally appends it to the nowcast root
    clearTimeout(closeT); lastFocus = document.activeElement;
    isOpen = true; panel.hidden = false; lastGroups = null; scroll.scrollTop = 0; renderPanel();
    void panel.offsetWidth; panel.classList.add('on');
    requestAnimationFrame(() => { paintRows(); try { xB.focus({ preventScroll: true }); } catch (e) { /* old Safari */ } });
    document.addEventListener('keydown', onKey);
    ensureShapes(); if (map) map.draw();
  }
  /** how = 'lot': a row was tapped (the map takes over; focus stays off the button) */
  function close(how) {
    if (!isOpen) return;
    isOpen = false; panel.classList.remove('on'); box.style.transform = ''; scrim.style.opacity = '';
    document.removeEventListener('keydown', onKey);
    clearTimeout(closeT); closeT = setTimeout(() => { if (!isOpen) panel.hidden = true; }, reduced() ? 160 : 300);
    if (how !== 'lot' && lastFocus && lastFocus.focus && lastFocus.isConnected) try { lastFocus.focus({ preventScroll: true }); } catch (e) { /* gone */ }
    if (map) map.draw();
  }
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  scrim.addEventListener('click', () => close()); xB.addEventListener('click', () => close());
  againB.addEventListener('click', () => data.retry());

  // swipe right to close (vertical moves stay the list's)
  let drag = null;
  box.addEventListener('pointerdown', (e) => { if (e.pointerType === 'mouse' && e.button !== 0) return; drag = { id: e.pointerId, x: e.clientX, y: e.clientY, t: performance.now(), on: false, dx: 0 }; });
  box.addEventListener('pointermove', (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
    if (!drag.on) {
      if (Math.abs(dy) > 10 && Math.abs(dy) >= Math.abs(dx)) { drag = null; return; }
      if (!(dx > 12 && dx > Math.abs(dy) * 1.4)) return;
      drag.on = true; box.classList.add('drag'); try { box.setPointerCapture(e.pointerId); } catch (err) { /* fine */ }
    }
    drag.dx = Math.max(0, dx); box.style.transform = `translateX(${drag.dx}px)`; scrim.style.opacity = String(Math.max(0, 1 - drag.dx / (box.offsetWidth || 360)));
  });
  const dragEnd = (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    const d = drag; drag = null; if (!d.on) return;
    const v = d.dx / Math.max(1, performance.now() - d.t);
    const swallow = (ev) => { ev.stopPropagation(); ev.preventDefault(); };   // the finger lifted over a row: that is not a tap
    box.addEventListener('click', swallow, true); setTimeout(() => box.removeEventListener('click', swallow, true), 400);
    box.classList.remove('drag');
    if (d.dx > 90 || v > 0.6) close(); else { box.style.transform = ''; scrim.style.opacity = ''; }
  };
  box.addEventListener('pointerup', dragEnd); box.addEventListener('pointercancel', dragEnd);

  // Share: the count and the warnings, no list
  shareB.addEventListener('click', () => {
    const text = shareText(st(), Date.now(), county);
    const copied = () => { shareT.textContent = 'Copied'; setTimeout(() => { shareT.textContent = 'Share'; }, 2000); };
    if (navigator.share) navigator.share({ title: 'Wallowa Weather', text }).catch(() => {});
    else if (navigator.clipboard) navigator.clipboard.writeText(text).then(copied).catch(() => {});
  });

  // ---- the outlines on the map (zoom 12+, while the panel is open or the switch is on; the tapped lot always)
  const shapes = new Map(), shapeWait = new Set(); let shapeCtrl = new AbortController();
  const outlinesOn = () => !!map && (isOpen || outline);
  function loadShapes(ids) {
    for (const id of ids) shapeWait.add(id);
    fetchShapes(ids, { fetchFn, url, signal: shapeCtrl.signal, idField })
      .then((got) => { for (const [id, g] of got) shapes.set(id, g); trimShapes(); if (map && !gone) map.draw(); })
      .catch(() => { /* quiet: the list still works */ })
      .finally(() => { for (const id of ids) shapeWait.delete(id); });
  }
  function ensureShapes() {
    if (!outlinesOn() || gone) return;
    const need = [...st().outline].filter((id) => !shapes.has(id) && !shapeWait.has(id));
    for (let i = 0; i < need.length; i += OUTLINE_MAX) loadShapes(need.slice(i, i + OUTLINE_MAX));
  }
  function loadSelected() { if (map && selected && !shapes.has(selected.objectid) && !shapeWait.has(selected.objectid)) loadShapes([selected.objectid]); if (map) map.draw(); }
  function trimShapes() {
    if (shapes.size <= MAX_SHAPES) return;
    const keep = st().outline;
    for (const id of shapes.keys()) { if (shapes.size <= MAX_SHAPES) break; if (!keep.has(id) && !(selected && selected.objectid === id)) shapes.delete(id); }
  }
  function drawOverlay(ctx, api) {
    if (api.z < OUTLINE_MIN_Z) return;
    const sel = selected ? shapes.get(selected.objectid) : null, on = outlinesOn();
    if (!on && !sel) return;
    const [w, s, e, n] = api.view, vis = (b) => !(b[2] < w || b[0] > e || b[3] < s || b[1] > n);
    const trace = (rings) => { for (const r of rings) { r.forEach(([lo, la], i) => { const p = api.toScreen(la, lo); if (i) ctx.lineTo(p.x, p.y); else ctx.moveTo(p.x, p.y); }); ctx.closePath(); } };
    ctx.lineJoin = 'round';
    if (on) {
      ctx.beginPath(); let k = 0;
      for (const id of st().outline) { const g = shapes.get(id); if (g && vis(g.box)) { trace(g.rings); k++; } }
      if (k) { ctx.fillStyle = 'rgba(255,59,48,0.16)'; ctx.fill('evenodd'); ctx.strokeStyle = 'rgba(0,0,0,0.5)'; ctx.lineWidth = 3.2; ctx.stroke(); ctx.strokeStyle = '#FF3B30'; ctx.lineWidth = 1.5; ctx.stroke(); }
    }
    if (sel && vis(sel.box) && !api.public) {   // v020: the lot the person picked: never in a public picture (the warned lots' outline is public)
      ctx.beginPath(); trace(sel.rings);
      ctx.fillStyle = 'rgba(255,59,48,0.3)'; ctx.fill('evenodd'); ctx.strokeStyle = '#fff'; ctx.lineWidth = 5; ctx.stroke(); ctx.strokeStyle = '#FF3B30'; ctx.lineWidth = 2.6; ctx.stroke();
    }
  }
  if (map && map.addOverlay) map.addOverlay({ name: 'affected-lots', level: 1, order: 30, draw: drawOverlay });

  function setOutline(on) { outline = !!on; if (togIn) togIn.checked = outline; ensureShapes(); if (map) map.draw(); }
  function destroy() {
    if (gone) return;
    gone = true; isOpen = false; data.destroy(); shapeCtrl.abort(); clearTimeout(closeT); if (raf) cancelAnimationFrame(raf); if (ro) ro.disconnect();
    document.removeEventListener('keydown', onKey);
    if (map && map.removeOverlay) map.removeOverlay('affected-lots');
    button.remove(); panel.remove(); shapes.clear(); selected = null;
  }
  return {
    button, panel,
    /** zones: [{ id, label, color, level, rings: [[[lon, lat] ...]], until (ms), source: 'app' | 'nws' | 'beam' }]: call it as often as you like */
    setZones: (zones) => data.setZones(zones),
    open, close: () => close(), destroy, setOutline, retry: () => data.retry(),
    get state() { return st(); },
    get isOpen() { return isOpen; },
  };
}
