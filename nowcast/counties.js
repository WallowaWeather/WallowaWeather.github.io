// nowcast/counties.js - Wallowa Weather v014: the counties the app covers (Lane and Douglas now, more
// later). The app stays Wallowa Weather, for Wallowa County: the other counties are simply there - a place in
// one gets its forecast, its lot lines, drainages, gauges, fires and fire weather, and Settings › Counties can keep its maps on the phone.
// COUNTIES[0] is the app's own county (Wallowa): the default place when the person is in none of them, the default active county, and its
// saved map keeps v007's switch (layers.offline) and cache name. Each entry:
//   { id, name, short, bbox [south, west, north, east], home { lat, lon, label } (the default place: the saved map's middle),
//     boundary: 'data/county_<id>.json' ({ name, rings: [[[lon, lat], ...]] }, even-odd) or null: once read, the outline decides what is in
//       the county; without one (or while it loads) the box does,
//     parcels: the county's public tax-lot service { url (an ArcGIS layer's /query), host (listed in index.html's CSP), idField, lotField,
//       maxRecords (the service's page), centroid (false: the service gives no centre points; the property list works them out from the
//       outlines), owners (false: the county publishes no owner names online; the app shows none either way), credit, note } or null
//       (no lot lines for that county: the layer and the lot counts say so),
//     drainages: 'data/huc12_<id>.json' (huc12_wallowa.json's format), lands: its public land (public_lands.json's format),
//     firewx: { zones (the NWS fire weather zones over it), forecastZones, office } or null, gaugeBox / fireBox [w, s, e, n] (the live
//     layers' areas), gaugeLimit (values per gauge answer), mapMb (its saved map's size, about: = offline.js's plan with the wilderness),
//     savedByDefault (none since v019: a county's map is saved only when the person chooses it - its switch; Wallowa's also in Download all) }.
// Paths are relative to this folder (countyUrl). Lane and Douglas: a registry made Nov-08-2026 (TIGER/Line boxes, county seats,
// outlines, HUC-12s, public land, fire and forecast zones, Douglas County's ORMAP lot layer; Lane County's lot lines are not used: their
// terms are unclear). sw.js keeps its own copy of the boxes, each grown ~10 km (counties_test checks they match).
'use strict';

export const COUNTIES = [
  {
    id: 'wallowa', name: 'Wallowa County, Oregon', short: 'Wallowa County',
    bbox: [44.85, -118.05, 46.05, -116.45], home: { lat: 45.5707, lon: -117.5288, label: 'Wallowa, OR' },
    // its box decides, as before v014 (no other county's box overlaps it). data/county_wallowa.json is there for when a neighbour joins:
    // wired, it narrows Wallowa to its outline (no longer Elgin or Halfway)
    boundary: null,
    parcels: {
      url: 'https://services8.arcgis.com/IMdJDKFYUN1k5T2P/arcgis/rest/services/Taxlots_Public/FeatureServer/0/query',
      host: 'https://services8.arcgis.com', idField: 'OBJECTID', lotField: 'Taxlot', maxRecords: 2000, centroid: true, owners: false,
      credit: 'Lot lines: Wallowa County',
      note: 'Tax lot lines from Wallowa County’s public map. Not a survey or a legal record; they may be out of date or incomplete. '
        + 'The official records are at the Wallowa County Assessor’s office. Not endorsed by Wallowa County.',
    },
    drainages: 'data/huc12_wallowa.json', lands: 'public_lands.json',
    firewx: { zones: ['ORZ692', 'ORZ693', 'ORZ695'], forecastZones: ['ORZ050', 'ORZ502'], office: 'Pendleton office' },
    gaugeBox: [-118.15, 44.75, -116.35, 46.15], fireBox: [-118.45, 44.6, -116.1, 46.3], gaugeLimit: 1000,
    mapMb: 152, savedByDefault: false,   // v019: was true (saved by itself 15 s after the app opened); a phone that kept it keeps it (view.js)
  },
  {
    id: 'lane', name: 'Lane County, Oregon', short: 'Lane County',
    bbox: [43.43739, -124.23018, 44.29054, -121.76802], home: { lat: 44.0568, lon: -123.119, label: 'Eugene, OR' },
    boundary: 'data/county_lane.json',
    parcels: null,   // Lane County's tax lots: terms unclear (the county sells the data, "not to be redistributed"): not used until it says yes
    drainages: 'data/huc12_lane.json', lands: 'data/lands_lane.json',
    firewx: { zones: ['ORZ683', 'ORZ690', 'ORZ687', 'ORZ689', 'ORZ685', 'ORZ617', 'ORZ681'], forecastZones: ['ORZ128', 'ORZ125', 'ORZ118', 'ORZ107', 'ORZ105', 'ORZ103'],
      office: 'Portland and Medford offices' },
    gaugeBox: [-124.33, 43.34, -121.67, 44.39], fireBox: [-124.63, 43.14, -121.37, 44.59], gaugeLimit: 3000,
    mapMb: 149, savedByDefault: false,
  },
  {
    id: 'douglas', name: 'Douglas County, Oregon', short: 'Douglas County',
    bbox: [42.6993, -124.29024, 43.94484, -121.9742], home: { lat: 43.2236, lon: -123.352, label: 'Roseburg, OR' },
    boundary: 'data/county_douglas.json',
    parcels: {
      url: 'https://gis.co.douglas.or.us/server/rest/services/Parcel/ORMAP_Parcels/MapServer/2/query',
      host: 'https://gis.co.douglas.or.us', idField: 'OBJECTID', lotField: 'Taxlot', maxRecords: 4000, centroid: false,   // its layer has no owner fields
      credit: 'Lot lines: Douglas County',
      note: 'Tax lot lines from Douglas County’s public map. Not a survey or a legal record; they may be out of date or incomplete. '
        + 'The official records are at the Douglas County Assessor’s office. Not endorsed by Douglas County.',
    },
    drainages: 'data/huc12_douglas.json', lands: 'data/lands_douglas.json',
    firewx: { zones: ['ORZ616', 'ORZ617', 'ORZ683', 'ORZ681', 'ORZ623', 'ORZ615', 'ORZ690'], forecastZones: ['ORZ023', 'ORZ025', 'ORZ027', 'ORZ021'],
      office: 'Medford and Portland offices' },
    gaugeBox: [-124.39, 42.6, -121.87, 44.04], fireBox: [-124.69, 42.4, -121.57, 44.24], gaugeLimit: 3000,
    mapMb: 190, savedByDefault: false,
  },
];

/** a county's data file (a path in its entry) -> its URL, or null */
export const countyUrl = (p) => (p ? new URL(p, import.meta.url).href : null);
export const countyById = (id, list = COUNTIES) => list.find((c) => c.id === id) || null;
export const inBbox = (b, lat, lon) => lat >= b[0] && lat <= b[2] && lon >= b[1] && lon <= b[3];

const RINGS = new Map();   // county id -> its outline's rings (loadBoundaries / setBoundary)
function inRings(rings, lon, lat) {
  let inside = false;
  for (const r of rings) for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
    const [xi, yi] = r[i], [xj, yj] = r[j];
    if ((yi > lat) !== (yj > lat) && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
/** a county's outline (rings of [lon, lat]), or null to fall back to its box */
export function setBoundary(id, rings) {
  const ok = Array.isArray(rings) ? rings.filter((r) => Array.isArray(r) && r.length >= 3 && r.every((p) => Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1]))) : [];
  if (ok.length) RINGS.set(id, ok); else RINGS.delete(id);
}
export const hasBoundary = (id) => RINGS.has(id);

/** the county a point is in: inside its outline once that is read, else inside its box; in two boxes with no outline read, the one whose
 *  seat is nearer -> county | null */
export function countyAt(lat, lon, list = COUNTIES) {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  const hit = [], loose = [];
  for (const c of list) {
    if (!inBbox(c.bbox, lat, lon)) continue;
    const r = RINGS.get(c.id);
    if (!r) loose.push(c); else if (inRings(r, lon, lat)) hit.push(c);
  }
  if (hit.length) return hit[0];
  if (loose.length < 2) return loose[0] || null;
  const k = Math.cos(lat * Math.PI / 180), d = (c) => (c.home.lat - lat) ** 2 + ((c.home.lon - lon) * k) ** 2;
  return loose.reduce((a, b) => (d(b) < d(a) ? b : a));
}
/** inside any of the app's counties (where it forecasts, searches and runs its nowcasts) */
export const inCounties = (lat, lon, list = COUNTIES) => !!countyAt(lat, lon, list);

let loading = null;
/** reads the outlines the entries name (once each; a missing file leaves that county on its box) -> Promise<number of outlines read> */
export function loadBoundaries({ fetchFn = (...a) => fetch(...a), list = COUNTIES } = {}) {
  if (loading) return loading;
  loading = Promise.all(list.filter((c) => c.boundary && !RINGS.has(c.id)).map(async (c) => {
    try {
      const r = await fetchFn(countyUrl(c.boundary)); if (!r || r.ok === false) return;
      const j = await r.json(); setBoundary(c.id, j && j.rings);
    } catch (e) { /* offline or not there: the box stands in */ }
  })).then(() => list.filter((c) => RINGS.has(c.id)).length);
  loading.then(() => { loading = null; });
  return loading;
}
