// nowcast/county_layers.js - Wallowa Weather v014: the layers that belong to one county (counties.js), made for the active county and made
// again when it changes (view.js): lot lines, the lot counter, the properties-in-a-warning panel, drainages, stream gauges, current fires,
// fire weather and public land. A layer the county has no data for yet is null (lot lines, drainages, fire weather, public land); the lot
// counter is always there and says so. Nothing here fetches until a layer is switched on (or a zone is counted).
'use strict';
import { createParcels } from './parcels.js';
import { createLotCounter, lotsSentence } from './lotcount.js';
import { createAffected } from './affected.js';
import { createDrainages } from './drainages.js';
import { createGauges } from './gauges.js';
import { createFires } from './fires.js';
import { fireWx, firewxNote } from './firewx.js';
import { createLands } from './lands.js';
import { countyUrl } from './counties.js';

const LANDS = new Map();   // public land files read once a session (a county visited again keeps its areas)
const landsOf = (url, F) => { if (!LANDS.has(url)) LANDS.set(url, createLands(Object.assign({ url }, F))); return LANDS.get(url); };
/** a county's public land (createLands, one per file a session) or null: the layer, and the wilderness close-ups of its saved map */
export const landsFor = (c) => (c && c.lands ? landsOf(countyUrl(c.lands), {}) : null);

/** the county's own words for its lot lines (Wallowa's are v013's, word for word) */
export function lotWords(c) {
  const P = c && c.parcels, short = c ? c.short : 'the county';
  return {
    layer: P ? `${short} tax lots when zoomed in close. Tap a lot for its number. Lines only${P.owners === false ? ': the county doesn’t publish owner names online' : ', no owner names'}`
      : `${short}’s lot lines aren’t available in the app yet`,
    owner: P && P.owners === false ? `Owner not shown: ${short} doesn’t publish owner names online.` : 'Owner names aren’t shown in this app.',
    note: P ? P.note : '', credit: P ? P.credit : '',
    lots: (r) => lotsSentence(r, short),
  };
}

/** c: a county; o: { map, nws, basemap (false: the plain GIBS map, no map layers), onParcels(), places, onLot(lot), fetchFn } ->
 *  { county, parcels, lots, affected, drains, gauges, fires, fwx, lands, words, destroy() } */
export function countyLayers(c, { map = null, nws = null, basemap = true, onParcels = () => {}, places = null, onLot = () => {}, fetchFn } = {}) {
  const P = c.parcels, F = fetchFn ? { fetchFn } : {};
  const svc = P ? { url: P.url, idField: P.idField, lotField: P.lotField, page: P.maxRecords } : null;   // its lot service
  const L = {
    county: c, words: lotWords(c),
    parcels: basemap && svc ? createParcels(Object.assign({ bbox: c.bbox, onChange: onParcels }, svc, F)) : null,
    lots: createLotCounter(Object.assign({ bbox: c.bbox, url: svc ? svc.url : null }, F)),
    affected: svc ? createAffected(Object.assign({ bbox: c.bbox, map, places, onLot, county: c.short, owners: P.owners !== false, centroid: P.centroid !== false }, svc, F)) : null,
    drains: basemap && c.drainages ? createDrainages(Object.assign({ map, url: countyUrl(c.drainages), county: c.short }, F)) : null,
    gauges: basemap ? createGauges(Object.assign({ map, box: c.gaugeBox, limit: c.gaugeLimit || 1000 }, F)) : null,
    fires: basemap ? createFires(Object.assign({ map, box: c.fireBox }, F)) : null,
    fwx: basemap && c.firewx ? fireWx(nws, Object.assign({ map, zones: c.firewx.zones, note: firewxNote(c.firewx.office) }, F)) : null,
    lands: basemap && c.lands ? (fetchFn ? createLands(Object.assign({ url: countyUrl(c.lands) }, F)) : landsOf(countyUrl(c.lands), F)) : null,
  };
  /** the county's layers put away: their overlays off the map, their polls and requests stopped, the panel and its button gone */
  L.destroy = () => {
    if (L.drains) L.drains.on(false);
    for (const x of [L.gauges, L.fires, L.fwx]) if (x) x.destroy();
    if (L.affected) L.affected.destroy();
    if (L.parcels) L.parcels.clear();
  };
  return L;
}
