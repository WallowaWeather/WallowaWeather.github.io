// nowcast/lotcount.js - how many properties (Wallowa County tax lots) an app alert's zone covers. One count-only
// request to the county's public Taxlots_Public service per zone: no lot numbers, outlines or names come back, nothing is saved. Lots
// outside Wallowa County are not in that service, so a zone reaching beyond the county is counted only inside it.
// v014: the active county's service (counties.js); url null = no lot lines for that county yet: nothing is sent, the sentence says so.
'use strict';

import { PARCELS_URL } from './parcels.js';

export function createLotCounter({ bbox, url = PARCELS_URL, fetchFn = (...a) => fetch(...a) } = {}) {
  const cache = new Map();
  const pending = new Map();
  if (!url) return { count: () => Promise.resolve({ n: 0, outside: false, partial: false, none: true }) };

  function ringKey(ring) {
    const rounded = ring.map(([lon, lat]) => [Math.round(lon * 10000) / 10000, Math.round(lat * 10000) / 10000]);
    return JSON.stringify(rounded);
  }

  function count(ring) {
    let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
    for (const [lon, lat] of ring) {
      if (lon < w) w = lon;
      if (lat < s) s = lat;
      if (lon > e) e = lon;
      if (lat > n) n = lat;
    }

    const [bs, bw, bn, be] = bbox;
    if (e < bw || w > be || n < bs || s > bn) {
      return Promise.resolve({ n: 0, outside: true, partial: false });
    }

    const key = ringKey(ring);
    if (cache.has(key)) {
      return Promise.resolve(cache.get(key));
    }
    if (pending.has(key)) return pending.get(key);   // the card line and the tap sheet ask for the same zone at once: one request

    const body = new URLSearchParams();
    body.set('where', '1=1');
    body.set('geometry', JSON.stringify({ rings: [ring], spatialReference: { wkid: 4326 } }));
    body.set('geometryType', 'esriGeometryPolygon');
    body.set('inSR', '4326');
    body.set('spatialRel', 'esriSpatialRelIntersects');
    body.set('returnCountOnly', 'true');
    body.set('f', 'json');

    const partial = !(w >= bw && e <= be && s >= bs && n <= bn);

    const p = fetchFn(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    })
      .then((res) => res.json())
      .then((data) => {
        if (typeof data.count !== 'number') throw new Error('no count');
        const result = { n: data.count, outside: false, partial };
        cache.set(key, result);
        return result;
      })
      .catch(() => null);

    pending.set(key, p);
    p.then((val) => { pending.delete(key); if (val === null) cache.delete(key); });

    return p;
  }

  return { count };
}

/** v014: county = the counted county's short name (counties.js) */
export function lotsSentence(r, county = 'Wallowa County') {
  if (r === null) return 'Couldn’t count the properties in this zone right now.';
  if (r.none) return `${county}’s lot lines aren’t available in the app yet, so the properties in this zone aren’t counted.`;
  if (r.outside) return `This zone is outside ${county}, so its properties aren’t counted.`;
  if (r.n === 0) return `No ${county} properties (tax lots) are in this zone.`;
  const noun = r.n === 1 ? 'property' : 'properties';
  const verb = r.n === 1 ? 'is' : 'are';
  let s = `About ${r.n.toLocaleString('en-US')} ${noun} (${county} tax lots) ${verb} in this zone.`;
  if (r.partial) s += ' It also reaches beyond the county, where properties aren’t counted.';
  return s;
}
