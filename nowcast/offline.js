// nowcast/offline.js - Wallowa Weather's saved county map (so it loads quickly, and people in the
// wilderness with no service still see where they are). The county's map tiles are
// saved on this phone ahead of time and sw.js answers the map from them first. USGS and NASA tiles are public domain; Oregon's OSIP aerials
// are not saved ahead (no published terms): they load as you look, as before.
// v014 (the other counties are simply there): Settings › Counties keeps any of the app's counties (counties.js) the
// same way: each in its own cache (countyCache), saved one county at a time (createCountyMaps); sw.js answers every kept county's tiles.
// v019 (Josh, Nov-09-2026: "County map download should be lumped with model downloads"): a map is saved only once the person chooses it
// (its switch; Wallowa's also in Download all, dlall.js), never by itself; Download all's Cancel pauses it (pause / resume / settled).
'use strict';

import { BASEMAPS } from './basemaps.js';
import { ROADS_SOURCE, ROADS_MIN_Z } from './roads.js';
import { inPolys } from './lands.js';

export const COUNTY_CACHE = 'wallowa-weather:county';   // Wallowa's (v007); another county's: COUNTY_CACHE + ':' + its id
export const VIEWED_CACHE = 'wallowa-weather:viewed';   // sw.js's VIEWED: the tiles looked at inside a kept county
/** the cache a county's saved map lives in (the app's own county, COUNTIES[0], keeps v007's name) */
export const countyCache = (id, first = 'wallowa') => (id === first ? COUNTY_CACHE : `${COUNTY_CACHE}:${id}`);
export const KB = { 'usgs-img': 21, 'usgs-relief': 11, 'usgs-topo': 25, roads: 17, gibs: 15 };   // mean tile sizes measured Nov-05-2026

export function tileXY(lat, lon, z) {
  const n = 2 ** z;
  let x = Math.floor((lon + 180) / 360 * n);
  const r = lat * Math.PI / 180;
  let y = Math.floor((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * n);
  x = Math.max(0, Math.min(n - 1, x));
  y = Math.max(0, Math.min(n - 1, y));
  return { x, y };
}

export function tileBox(z, x, y) {
  const n = 2 ** z;
  const w = x / n * 360 - 180;
  const e = (x + 1) / n * 360 - 180;
  const s = Math.atan(Math.sinh(Math.PI * (1 - 2 * (y + 1) / n))) * 180 / Math.PI;
  const nLat = Math.atan(Math.sinh(Math.PI * (1 - 2 * y / n))) * 180 / Math.PI;
  return { w, e, s, n: nLat };
}

export function tileUrl(src, z, x, y) {
  if (src.urlFor) return src.urlFor(z, x, y);
  return src.url.replace('{z}', z).replace('{x}', x).replace('{y}', y);
}

export function boxTiles(bbox, z) {
  const [s, w, n, e] = bbox;
  const tl = tileXY(n, w, z);
  const br = tileXY(s, e, z);
  const tiles = [];
  for (let x = tl.x; x <= br.x; x++) {
    for (let y = tl.y; y <= br.y; y++) {
      tiles.push([x, y]);
    }
  }
  return tiles;
}

export function wildTiles(polys, z, bbox) {
  const seen = new Set();
  const result = [];
  for (const poly of polys) {
    let minLon = Infinity, maxLon = -Infinity, minLat = Infinity, maxLat = -Infinity;
    for (const ring of poly) {
      for (const [lon, lat] of ring) {
        if (lon < minLon) minLon = lon;
        if (lon > maxLon) maxLon = lon;
        if (lat < minLat) minLat = lat;
        if (lat > maxLat) maxLat = lat;
      }
    }
    const [bs, bw, bn, be] = bbox;
    minLon = Math.max(minLon, bw);
    maxLon = Math.min(maxLon, be);
    minLat = Math.max(minLat, bs);
    maxLat = Math.min(maxLat, bn);
    if (minLon > maxLon || minLat > maxLat) continue;
    const tiles = boxTiles([minLat, minLon, maxLat, maxLon], z);
    for (const [x, y] of tiles) {
      const key = `${x},${y}`;
      if (seen.has(key)) continue;
      const box = tileBox(z, x, y);
      const cx = (box.w + box.e) / 2;
      const cy = (box.s + box.n) / 2;
      let keep = inPolys([poly], cx, cy);
      if (!keep) {
        const corners = [[box.w, box.s], [box.e, box.s], [box.w, box.n], [box.e, box.n]];
        for (const [clon, clat] of corners) {
          if (inPolys([poly], clon, clat)) { keep = true; break; }
        }
      }
      if (!keep) {
        for (const ring of poly) {
          for (let i = 0; i < ring.length; i += 5) {
            const [vlon, vlat] = ring[i];
            if (vlon >= box.w && vlon <= box.e && vlat >= box.s && vlat <= box.n) { keep = true; break; }
          }
          if (keep) break;
        }
      }
      if (keep) {
        seen.add(key);
        result.push([x, y]);
      }
    }
  }
  return result;
}

export function countyPlan({ bbox, home, wild = [] }) {
  const rawPlan = [];
  const seenUrls2 = new Set();

  function addGroup(src, z, tiles) {
    for (const [x, y] of tiles) {
      const url = tileUrl(src, z, x, y);
      if (seenUrls2.has(url)) continue;
      seenUrls2.add(url);
      const box = tileBox(z, x, y);
      const cx = (box.w + box.e) / 2;
      const cy = (box.s + box.n) / 2;
      const dLon = (cx - home.lon) * Math.cos(home.lat * Math.PI / 180);
      const dLat = cy - home.lat;
      const distSq = dLon * dLon + dLat * dLat;
      const kb = src.id === 'roads' ? KB.roads : (KB[src.id] || 20);
      rawPlan.push({ url, kb, distSq, srcId: src.id, z });
    }
  }

  // Stage 1
  for (let z = 8; z <= 13; z++) {
    const tiles = boxTiles(bbox, z);
    for (const src of BASEMAPS.satellite.sources) {
      if (src.id === 'osip-2022') continue;
      addGroup(src, z, tiles);
    }
  }
  for (let z = ROADS_MIN_Z; z <= 12; z++) {   // v011: from the zoom the map draws roads at (8: 13 more tiles, about 0.4 MB; KB.roads still 17)
    const tiles = boxTiles(bbox, z);
    addGroup(ROADS_SOURCE, z, tiles);
  }
  for (let z = 5; z <= 8; z++) {
    const tiles = boxTiles(bbox, z);
    for (const src of BASEMAPS.relief.sources) {
      if (src.id !== 'gibs') continue;
      addGroup(src, z, tiles);
    }
  }

  // Stage 2
  for (let z = 8; z <= 13; z++) {
    const tiles = boxTiles(bbox, z);
    for (const src of BASEMAPS.topo.sources) {
      addGroup(src, z, tiles);
    }
  }
  for (const src of BASEMAPS.topo.sources) {
    const wt = wildTiles(wild, 14, bbox);
    addGroup(src, 14, wt);
  }

  // Sort: stable sort by a key that groups by insertion order of (srcId, z) but sorts by distSq within.
  // We can assign a group index to each unique (srcId, z) in the order they first appear.
  const groupOrder = new Map();
  let gIdx = 0;
  for (const item of rawPlan) {
    const key = `${item.srcId}:${item.z}`;
    if (!groupOrder.has(key)) {
      groupOrder.set(key, gIdx++);
    }
  }

  rawPlan.sort((a, b) => {
    const ga = groupOrder.get(`${a.srcId}:${a.z}`);
    const gb = groupOrder.get(`${b.srcId}:${b.z}`);
    if (ga !== gb) return ga - gb;
    return a.distSq - b.distSq;
  });

  return rawPlan.map(({ url, kb }) => ({ url, kb }));
}

export function createOfflineMap({ plan, isBusy = () => false, onChange = () => {}, workers = 3, fetchFn = (...a) => fetch(...a),
  cachesApi = globalThis.caches, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), cacheName = COUNTY_CACHE }) {
  let running = false, gen = 0;   // gen: a stop or a clear ends the round in flight (a tile landing after it is not counted)
  let have = 0;
  let missing = 0;
  let waiting = null;
  const totalMb = Math.round(plan.reduce((a, p) => a + p.kb, 0) / 1024);

  function status() {
    return { total: plan.length, have, missing, running, waiting, totalMb, done: have + missing >= plan.length };
  }

  const hidden = () => typeof document !== 'undefined' && document.hidden;

  async function start() {
    if (running) return;
    running = true; const my = ++gen;
    try {
      try { navigator.storage.persist(); } catch (e) { /* */ }
      const cache = await cachesApi.open(cacheName);
      const saved = new Set((await cache.keys()).map((r) => r.url));
      have = plan.filter((p) => saved.has(p.url)).length;
      let todo = plan.filter((p) => !saved.has(p.url));
      onChange(status());
      for (let round = 0; round < 3 && running && todo.length > 0; round++) {
        const retry = [];
        let i = 0;
        let fails = 0;
        await Promise.all(Array.from({ length: workers }, async () => {
          while (running && my === gen && i < todo.length) {
            if (isBusy() || hidden()) {
              if (waiting !== 'busy') { waiting = 'busy'; onChange(status()); }
              await sleep(5000);
              continue;
            }
            if (fails >= 5) {
              waiting = 'signal';
              onChange(status());
              await sleep(30000);
              fails = 0;
              continue;
            }
            const p = todo[i++];
            try {
              const r = await fetchFn(p.url, { cache: 'no-cache', mode: 'cors', credentials: 'omit' });
              if (my !== gen) break;
              if (r.status === 404) { missing++; continue; }
              if (!r.ok) throw new Error('HTTP ' + r.status);
              const b = await r.blob();
              if (my !== gen) break;
              await cache.put(p.url, new Response(b, { status: 200, headers: { 'Content-Type': r.headers.get('Content-Type') || b.type || 'image/png',
                'X-WW-Saved': String(Date.now()) } }));
              have++;
              fails = 0;
              if (waiting) { waiting = null; onChange(status()); }
              if (have % 10 === 0) onChange(status());
            } catch (e) {
              fails++;
              retry.push(p);
            }
          }
        }));
        todo = retry;
      }
      if (my !== gen) return;   // stopped or cleared meanwhile: that call said so
      running = false;
      waiting = null;
      onChange(status());
    } catch (e) {
      if (my !== gen) return;
      running = false;
      onChange(status());
    }
  }

  function stop() {
    running = false; gen++; waiting = null;
  }

  async function clear() {   // -> true when a saved map was there to delete
    stop();
    const gone = await cachesApi.delete(cacheName);
    have = 0;
    missing = 0;
    onChange(status());
    return gone;
  }

  return { start, stop, clear, status };
}

/** the saved map's state in one line (the Layers switch's line, and Settings › Counties). st: a saver's status() or null (not started yet) */
export function savedLine(st, kept) {
  if (!kept) return 'Off: the map loads from the internet as you look.';
  if (!st) return 'Starts a few seconds after the app opens.';
  if (st.queued) return `Waiting its turn: about ${st.totalMb} MB, after the county being saved now.`;
  const pct = Math.floor(100 * (st.have + st.missing) / Math.max(1, st.total));
  if (st.done) return `Saved on this phone: the whole county (about ${st.totalMb} MB).`;
  // v019: paused by Download all's Cancel (until it is tapped again): how far, when this session knows
  if (st.paused) return `${st.total ? `Paused at ${pct} % of about ${st.totalMb} MB.` : 'Paused.'} Settings › Download all carries on from there.`;
  if (st.waiting === 'signal') return `Saved ${pct} %. Waiting for a signal to save the rest.`;
  if (st.waiting === 'busy') return `Saved ${pct} %. Paused while a forecast or a download runs.`;
  return `${st.running ? 'Saving' : 'Saved'} ${pct} % of about ${st.totalMb} MB.`;
}

/** v014: the saved maps of the app's counties. counties: counties.js entries; kept(id) -> bool (the switches); planOf(county) -> plan or
 *  Promise<plan> (countyPlan with its wilderness); the rest as createOfflineMap. Each kept county is saved in turn (list order: Wallowa
 *  first), one at a time; a county switched off stops and its cache is deleted. onChange(id, status) on every change.
 *  -> { sync() (after a switch, at start, back in service), status(id) (null before the first sync or when not kept), estimateMb(id), busy(),
 *  savedMb(id), idle(), pause(id), resume(id), settled(id) }
 *  v019 (Download all): pause(id) stops a county's save and keeps it from starting again (a sync: back in service, another switch) until
 *  resume(id); nothing is deleted; its status says paused. paused: the ids paused in an earlier session (the app keeps them). settled(id)
 *  -> Promise: resolves when that county's save next ends (done, out of tries, paused, or not kept); ask before the sync that starts it. */
export function createCountyMaps({ counties, kept, planOf, isBusy = () => false, onChange = () => {}, workers = 3, fetchFn = (...a) => fetch(...a),
  cachesApi = globalThis.caches, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), paused = [] }) {
  const first = counties[0] && counties[0].id;
  const savers = new Map(), plans = new Map(), est = new Map();
  const held = new Set(paused), waits = new Map();   // v019: held = paused by Download all's Cancel; waits = settled() callers per county
  let synced = false, loop = null, again = false, now = null;
  const ended = (id) => { const w = waits.get(id); waits.delete(id); for (const f of w || []) f(); };
  const byId = (id) => counties.find((c) => c.id === id);
  const tell = (id) => { try { onChange(id, status(id)); } catch (e) { /* */ } };
  function estimateMb(id) {   // before its plan is made: the county's own figure (mapMb), else the plan without the wilderness close-ups
    const c = byId(id); if (!c) return 0;
    if (!est.has(id)) est.set(id, c.mapMb || Math.round(countyPlan({ bbox: c.bbox, home: c.home }).reduce((a, p) => a + p.kb, 0) / 1024));
    return est.get(id);
  }
  async function saverOf(c) {
    if (savers.has(c.id)) return savers.get(c.id);
    if (!plans.has(c.id)) plans.set(c.id, Promise.resolve().then(() => planOf(c)).catch((e) => { plans.delete(c.id); throw e; }));
    const plan = await plans.get(c.id);
    if (!savers.has(c.id)) savers.set(c.id, createOfflineMap({ plan, isBusy, workers, fetchFn, cachesApi, sleep, cacheName: countyCache(c.id, first), onChange: () => tell(c.id) }));
    return savers.get(c.id);
  }
  async function pass() {
    for (const c of counties) {
      const skip = () => !kept(c.id) || held.has(c.id);
      if (skip()) { ended(c.id); continue; }
      let s = null; try { s = await saverOf(c); } catch (e) { ended(c.id); continue; }
      if (skip()) { ended(c.id); continue; }
      now = c.id;   // start() says how it goes (onChange)
      try { await s.start(); } catch (e) { /* the saver says how far it got */ }
      now = null; tell(c.id); ended(c.id);
    }
  }
  /** v019: Download all's Cancel - the save stops where it is (what came in stays) and waits for resume() */
  function pause(id) { held.add(id); const s = savers.get(id); if (s) s.stop(); tell(id); }
  function resume(id) { held.delete(id); }
  function settled(id) { return new Promise((r) => { if (!waits.has(id)) waits.set(id, []); waits.get(id).push(r); }); }
  function sync() {
    synced = true;
    for (const c of counties) {
      if (kept(c.id)) {   // its cache made now: sw.js keeps the tiles looked at in a kept county even before its turn to be saved
        if (cachesApi) Promise.resolve().then(() => cachesApi.open(countyCache(c.id, first))).catch(() => {});
        tell(c.id); continue;
      }
      const s = savers.get(c.id);
      // a saved map deleted (switched off now or in an earlier session): sw.js's tiles looked at go with it - they show where the map was
      // looked at (one cache for every county: a kept county's refill as they are looked at again)
      (s ? s.clear() : Promise.resolve(cachesApi && cachesApi.delete(countyCache(c.id, first))))
        .then((gone) => (gone && cachesApi ? cachesApi.delete(VIEWED_CACHE) : null)).catch(() => {}).then(() => tell(c.id));
    }
    if (loop) { again = true; return; }
    loop = pass().finally(() => { loop = null; if (again) { again = false; sync(); } });
  }
  function status(id) {
    if (!kept(id)) return null;
    const s = savers.get(id);
    // v019: paused - said even before the first sync (a paused map never starts by itself)
    if (held.has(id)) return Object.assign(s ? s.status() : { total: 0, have: 0, missing: 0, running: false, waiting: null, totalMb: estimateMb(id), done: false }, { paused: true });
    if (!synced) return null;
    if (s) return s.status();
    return { queued: true, total: 0, have: 0, missing: 0, running: false, waiting: null, totalMb: estimateMb(id), done: false };
  }
  /** about how much of a county is on the phone now, in MB (for "It frees about ...") */
  function savedMb(id) {
    const s = savers.get(id), st = s && s.status();
    return st && st.total ? Math.round(st.totalMb * st.have / st.total) : 0;
  }
  /** resolves when no county is being saved (the pass under way, and the one a switch asked for meanwhile) */
  async function idle() { while (loop) await loop.catch(() => {}); }
  return { sync, status, estimateMb, savedMb, idle, pause, resume, settled, busy: () => !!now, get saving() { return now; } };
}
