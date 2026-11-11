// nowcast/parcels.js - Wallowa Weather's "Lot lines" layer (lot lines, within the law).
// Source: Wallowa County's own public map service (ArcGIS Online "Taxlots_Public", open to browsers, 8,610 lots, fields OBJECTID and
// Taxlot only - research Nov-04-2026). The county publishes NO owner names online, so this layer has none: names come only if the
// Wallowa County Assessor agrees to publish them for this use. Lines only, Wallowa County only, the visible area only at zoom 12+,
// kept in memory only (nothing is saved, nothing is searchable, nothing is exported).
// v014: the service is the active county's (counties.js parcels: url, idField, lotField, maxRecords); Wallowa's is the default.
'use strict';
import { COUNTIES } from './counties.js';

const W = COUNTIES[0].parcels;   // Wallowa County's Taxlots_Public
export const PARCELS_URL = W.url;
export const PARCELS_HOST = W.host;
export const PARCELS_CREDIT = W.credit;
export const PARCELS_NOTE = W.note;
export const PARCELS_MIN_Z = 12;
const MAX_TILES = 48, PAGE = W.maxRecords;   // one request per tile (z14 ~1.7 km a side; z12 ~6.8 km a side - a town tile can need 2-3 pages)

const lon2x = (lon, tz) => ((lon + 180) / 360) * 2 ** tz;
const lat2y = (lat, tz) => { const r = (lat * Math.PI) / 180; return ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** tz; };
const x2lon = (x, tz) => (x / 2 ** tz) * 360 - 180;
const y2lat = (y, tz) => { const n = Math.PI - (2 * Math.PI * y) / 2 ** tz; return (180 / Math.PI) * Math.atan(Math.sinh(n)); };

/** bbox: [south, west, north, east] of the county; url / idField / lotField / page: its lot service (counties.js parcels); onChange(): new
 *  lots arrived -> { update(view, z), lots(), at(lat, lon), clear() } */
export function createParcels({ bbox, url = PARCELS_URL, idField = W.idField, lotField = W.lotField, page = PAGE, fetchFn = (...a) => fetch(...a), onChange = () => {} } = {}) {
  const tiles = new Map();   // 'tz/x/y' -> { lots: [lot], at } (held) | { wait } (queued) | { loading } | { failed: time } (tried again after 30 s)
  let busy = 0;
  const queue = [];
  let curTZ = null;          // the tile level of the last update() that kept tiles on screen
  function tileBox(x, y, tz) { return [x2lon(x, tz), y2lat(y + 1, tz), x2lon(x + 1, tz), y2lat(y, tz)]; }   // [w, s, e, n]
  async function load(key, x, y, tz) {
    const [w, s, e, n] = tileBox(x, y, tz), lots = [];
    const simplified = tz < 14;
    for (let off = 0; off < page * 10; off += page) {
      const q = new URLSearchParams({ where: '1=1', geometry: `${w},${s},${e},${n}`, geometryType: 'esriGeometryEnvelope', inSR: '4326',
        spatialRel: 'esriSpatialRelIntersects', outFields: `${idField},${lotField}`, returnGeometry: 'true', outSR: '4326',
        geometryPrecision: simplified ? '5' : '6', resultOffset: String(off), resultRecordCount: String(page), f: 'geojson' });
      if (simplified) q.set('maxAllowableOffset', '0.0001');
      const r = await fetchFn(`${url}?${q}`, { credentials: 'omit', referrerPolicy: 'no-referrer' });
      if (!r.ok) throw new Error(`lot lines: HTTP ${r.status}`);
      const d = await r.json();
      for (const f of d.features || []) {
        const g = f.geometry; if (!g) continue;
        const polys = g.type === 'Polygon' ? [g.coordinates] : g.type === 'MultiPolygon' ? g.coordinates : [];
        let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
        for (const p of polys) for (const ring of p) for (const [lo, la] of ring) { x0 = Math.min(x0, lo); x1 = Math.max(x1, lo); y0 = Math.min(y0, la); y1 = Math.max(y1, la); }
        const id = f.id != null ? f.id : f.properties && f.properties[idField];
        lots.push({ id, lot: String((f.properties && f.properties[lotField]) || ''), polys, box: [x0, y0, x1, y1] });
      }
      if (!(d.properties && d.properties.exceededTransferLimit) && !d.exceededTransferLimit && (d.features || []).length < page) break;
    }
    return lots;
  }
  function pump() {
    while (busy < 3 && queue.length) {
      const { key, x, y, tz } = queue.shift(), t = tiles.get(key); if (!t || !t.wait) continue;
      busy++; t.wait = false; t.loading = true;
      load(key, x, y, tz).then((lots) => { tiles.set(key, { lots, at: performance.now() }); onChange(); })
        .catch(() => { tiles.set(key, { failed: performance.now() }); })
        .finally(() => { busy--; pump(); });
    }
  }
  /** view = [west, south, east, north] (the map's), z = its zoom: fetch what is on screen and in the county, drop the far tiles */
  function update(view, z) {
    if (z < PARCELS_MIN_Z) { queue.length = 0; curTZ = null; return; }
    const tz = z >= 14 ? 14 : 12;
    const [w, s, e, n] = view, W = Math.max(w, bbox[1]), E = Math.min(e, bbox[3]), S = Math.max(s, bbox[0]), N = Math.min(n, bbox[2]);
    if (W >= E || S >= N) { curTZ = null; return; }
    const xa = Math.floor(lon2x(W, tz)), xb = Math.floor(lon2x(E, tz)), ya = Math.floor(lat2y(N, tz)), yb = Math.floor(lat2y(S, tz)), now = performance.now();
    queue.length = 0;
    const want = new Set();
    for (let x = xa; x <= xb; x++) for (let y = ya; y <= yb; y++) {
      const key = `${tz}/${x}/${y}`, t = tiles.get(key); want.add(key);
      if (t && (t.lots || t.loading)) { if (t.lots) t.at = now; continue; }
      if (t && t.failed && now - t.failed < 30000) continue;
      tiles.set(key, { wait: true }); queue.push({ key, x, y, tz });
    }
    curTZ = tz;
    for (const [k, t] of tiles) if (t.wait && !want.has(k)) tiles.delete(k);   // queued but scrolled away: not needed now
    if (tiles.size > MAX_TILES) {   // the oldest tiles go first (never one on screen: those were just touched)
      const old = [...tiles.entries()].filter(([, t]) => t.lots).sort((a, b) => a[1].at - b[1].at);
      for (const [k] of old.slice(0, tiles.size - MAX_TILES)) tiles.delete(k);
    }
    pump();
  }
  /** every lot held now at the current tile level, each once (a lot on two tiles comes back from both) */
  function lots() {
    if (curTZ == null) return [];
    const seen = new Set(), out = [];
    for (const [k, t] of tiles) {
      if (!t.lots || !k.startsWith(`${curTZ}/`)) continue;
      for (const l of t.lots) { const id = l.id != null ? l.id : l; if (seen.has(id)) continue; seen.add(id); out.push(l); }
    }
    return out;
  }
  /** the lot under a point (lat, lon), or null */
  function at(lat, lon) {
    for (const l of lots()) {
      const b = l.box; if (lon < b[0] || lon > b[2] || lat < b[1] || lat > b[3]) continue;
      for (const p of l.polys) if (inPoly(p, lon, lat)) return l;
    }
    return null;
  }
  return { update, lots, at, clear() { tiles.clear(); queue.length = 0; curTZ = null; } };
}

/** even-odd test over a polygon's rings (the outer ring and its holes) */
function inPoly(rings, x, y) {
  let inside = false;
  for (const r of rings) for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
    const [xi, yi] = r[i], [xj, yj] = r[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
