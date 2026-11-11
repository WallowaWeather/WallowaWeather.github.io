// nowcast/lands.js - Wallowa Weather's "Public land" layer: National Forest and Wilderness in Forest Service
// brown, BLM land in BLM yellow. Data: public_lands.json next to this file, built from the BLM's Surface
// Management Agency data (who manages the land: private land inside a forest is NOT shaded) and the Forest Service's wilderness areas.
'use strict';

export const LANDS_CREDIT = 'Public land: BLM, USFS';

export const LANDS_NOTE = 'Public land from the BLM’s Surface Management Agency data (Forest Service and BLM land) and the Forest Service’s wilderness boundaries, simplified for the map. Not a survey or a legal record: private land, closures and recent changes may not show. Check before you cross a fence.';

export const LANDS_STYLE = {
  usfs: { label: 'National Forest', who: 'US Forest Service', fill: 'rgba(122,82,48,0.32)', edge: 'rgba(122,82,48,0.85)', width: 1 },
  wild: { label: 'Wilderness', who: 'US Forest Service', fill: 'rgba(84,52,26,0.40)', edge: 'rgba(70,42,20,0.95)', width: 1.6 },
  blm: { label: 'BLM land', who: 'Bureau of Land Management', fill: 'rgba(226,179,60,0.34)', edge: 'rgba(160,118,0,0.85)', width: 1 },
};

export function inRings(rings, lon, lat) {
  let inside = false;
  for (const ring of rings) {
    const n = ring.length;
    if (n < 3) continue;
    for (let i = 0, j = n - 1; i < n; j = i++) {
      const xi = ring[i][0];
      const yi = ring[i][1];
      const xj = ring[j][0];
      const yj = ring[j][1];
      if ((yi > lat) !== (yj > lat)) {
        const slope = (xj - xi) / (yj - yi);
        const xInt = xi + (lat - yi) * slope;
        if (lon < xInt) inside = !inside;
      }
    }
  }
  return inside;
}

export function inPolys(polys, lon, lat) {
  for (const poly of polys) {
    if (inRings(poly, lon, lat)) return true;
  }
  return false;
}

export function createLands({ url = new URL('./public_lands.json', import.meta.url).href, fetchFn = (...a) => fetch(...a) } = {}) {
  let promise = null;
  let loaded = [];

  function load() {
    if (promise) return promise;
    promise = fetchFn(url)
      .then((res) => res.json())
      .then((data) => {
        const areas = (data.areas || []).map((area) => {
          let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
          for (const poly of area.polys) {
            for (const ring of poly) {
              for (const [lon, lat] of ring) {
                if (lon < w) w = lon;
                if (lat < s) s = lat;
                if (lon > e) e = lon;
                if (lat > n) n = lat;
              }
            }
          }
          return { ...area, bbox: [w, s, e, n] };
        });
        const order = { usfs: 0, blm: 1, wild: 2 };
        areas.sort((a, b) => (order[a.kind] ?? 3) - (order[b.kind] ?? 3));
        loaded = areas;
        return areas;
      })
      .catch(() => {
        promise = null;
        return [];
      });
    return promise;
  }

  function areas() {
    return loaded;
  }

  function at(lat, lon) {
    const order = ['wild', 'blm', 'usfs'];
    for (const kind of order) {
      for (const area of loaded) {
        if (area.kind !== kind) continue;
        const [w, s, e, n] = area.bbox;
        if (lon < w || lon > e || lat < s || lat > n) continue;
        if (inPolys(area.polys, lon, lat)) {
          const style = LANDS_STYLE[kind];
          return { kind: area.kind, name: area.name, label: style.label, who: style.who };
        }
      }
    }
    return null;
  }

  return { load, areas, at };
}
