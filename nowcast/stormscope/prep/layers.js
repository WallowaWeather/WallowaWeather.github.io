// nowcast/stormscope/prep/layers.js - PILOT (v057): StormScope's input layers kept fresh in the background (downloading
// starts with the app, stale layers are fetched again, old ones purged). The model needs six 10-minute times (t0-50 ... t0) of radar (MRMS), satellite (GOES-East ABI) and
// lightning (GLM) for the place's tile. The cache keeps each time's tile-sized values (about 1.8 MB a time, ~11 MB in all, never the
// national files); a refresh fetches only the times it doesn't have, and every time older than the window is dropped as soon as a new
// one lands. A tap on Nowcast then only assembles (~0.05 s). The same fetchers as prepareStormScope (nIn = 1 per time): bit-exact.
//   const L = createLayers({ grid });  await L.ensure({ lat, lon });  const prep = L.assemble();  L.start({ lat, lon }) / L.stop()
'use strict';
import { tileLatLon } from './grid.js';
import { tileFor } from './tile.js';
import { makeCtx } from './s3.js';
import { fetchMrms } from './mrms_ss.js';
import { fetchGoes } from './goes.js';
import { fetchGlm } from './glm.js';
import { assembleCondition, newestT0 } from './cond.js';
import { hrrrTypes } from '../type.js';

const MIN = 6e4, STEP = 10 * MIN, NIN = 6;

export function createLayers({ grid, fetchFn, glmMode = 'range', checkEveryMs = 60e3, onChange = () => {} } = {}) {
  const S = { tile: null, key: '', tl: null, t0: 0, slices: new Map(), nn: { mrms: null, goes: null }, busy: null, timer: 0, running: false,
    place: null, err: null, lastMs: 0, lastBytes: 0, totalBytes: 0, refreshes: 0, history: [] };
  const sk = (src, t) => `${src}|${t}`;
  const windowOf = (t0) => Array.from({ length: NIN }, (_, i) => t0 + (i - NIN + 1) * STEP);
  function purge(keep) {
    const want = new Set(keep.flatMap((t) => ['mrms', 'goes', 'glm'].map((s) => sk(s, t))));
    for (const k of [...S.slices.keys()]) if (!want.has(k)) S.slices.delete(k);
  }
  /** the six times for t0 (the newest complete one when omitted) at the place's tile: fetches only what is missing, then purges */
  async function ensure({ lat, lon, t0, signal, onProgress } = {}) {
    if (S.busy) return S.busy;   // one refresh at a time; a second caller waits for it
    S.busy = (async () => {
      const ms0 = Date.now(), ctx = makeCtx({ fetchFn, signal, onProgress }), lc = new Map(), glc = new Map();   // listings: this refresh only (the newest hour keeps growing)
      const tile = tileFor(lat, lon, { grid }), key = `${tile.y0},${tile.x0},${tile.h},${tile.w}`;
      if (key !== S.key) { S.slices.clear(); S.nn = { mrms: null, goes: null }; S.key = key; S.tile = tile; S.tl = tileLatLon(tile, grid); }   // a new place's tile: start over
      if (t0 == null) t0 = await newestT0(ctx);
      const times = windowOf(t0), jobs = [];
      for (const t of times) {
        if (!S.slices.has(sk('mrms', t))) jobs.push(fetchMrms(ctx, t, S.tile, S.tl, grid, { nIn: 1, nn: S.nn.mrms }).then((r) => { S.nn.mrms = S.nn.mrms || r.nn; S.slices.set(sk('mrms', t), r.values); }));
        if (!S.slices.has(sk('goes', t))) jobs.push(fetchGoes(ctx, t, S.tile, S.tl, grid, { nIn: 1, listCache: lc, nn: S.nn.goes }).then((r) => { S.nn.goes = S.nn.goes || r.nn; S.goesSat = r.satellite; S.slices.set(sk('goes', t), r.values); }));
        if (!S.slices.has(sk('glm', t))) jobs.push(fetchGlm(ctx, t, S.tile, S.tl, grid, { nIn: 1, mode: glmMode, listCache: glc }).then((r) => { S.slices.set(sk('glm', t), r.values); }));
      }
      // HRRR's rain / snow / sleet / freezing rain for this window's 9 frames: once per t0 and tile, alongside the layers
      if (!S.types || S.types.t0 !== t0 || S.types.key !== key) jobs.push(hrrrTypes({ t0, tile: S.tile, H: S.tile.h, W: S.tile.w, signal }).then((r) => { S.types = { t0, key, r }; S.typeBytes = r ? r.bytes : 0; }, () => { S.types = { t0, key, r: null }; }));
      await Promise.all(jobs);
      S.t0 = t0; purge(times);
      const bytes = ['mrms', 'goes', 'glm'].reduce((a, s) => a + ctx.stat(s).bytes, 0) + (S.typeBytes || 0); S.typeBytes = 0;
      S.lastMs = Date.now() - ms0; S.lastBytes = bytes; S.totalBytes += bytes; S.refreshes++; S.err = null;
      S.history.push({ at: Date.now(), t0, fetched: jobs.length, bytes, ms: S.lastMs }); if (S.history.length > 20) S.history.shift();
      onChange(status());
      return { t0, fetched: jobs.length, bytes, ms: S.lastMs };
    })();
    try { return await S.busy; } catch (e) { S.err = e; onChange(status()); throw e; } finally { S.busy = null; }
  }
  /** the model's inputs from the cache (prepareStormScope's shape) -> null when the window isn't complete */
  function assemble(t0 = S.t0) {
    const times = windowOf(t0), n = S.tl ? S.tl.lat.length : 0;
    if (!n || !times.every((t) => ['mrms', 'goes', 'glm'].every((s) => S.slices.has(sk(s, t))))) return null;
    const cat = (src, per) => { const v = new Float32Array(NIN * per * n); times.forEach((t, i) => v.set(S.slices.get(sk(src, t)), i * per * n)); return v; };
    const tc = Date.now();
    const { cond, valid, cz } = assembleCondition({ grid, tile: S.tile, tl: S.tl, t0, goes: { values: cat('goes', 8), nn: S.nn.goes }, mrms: { values: cat('mrms', 2), nn: S.nn.mrms }, glm: { values: cat('glm', 1) } });
    const rope = grid.rope(S.tile.h / 4, S.tile.w / 4), N = grid.json.norm, t = S.tile;
    return { cond, valid, cz, mean: N.state_means.slice(0, 2), std: N.state_stds.slice(0, 2), rope_cos: rope.cos, rope_sin: rope.sin,
      tile: { y0: t.y0, y1: t.y1, x0: t.x0, x1: t.x1, h: t.h, w: t.w }, H: t.h, W: t.w, t0,
      bytes: { mrms: 0, goes: 0, glm: 0, cached: true }, ms: { mrms: 0, goes: 0, glm: 0, cond: Date.now() - tc, total: Date.now() - tc } };
  }
  /** keep the place's layers fresh while the screen is up: now, then a look every minute for a newer complete time. o.due(t0) -> bool
   *  (Wallowa Weather, Nov-08: the app's "Keep forecasts fresh" cadence): a look refreshes only when it says so; a new place always does */
  function start({ lat, lon }, o = {}) {
    const same = S.place && Math.abs(S.place.lat - lat) < 1e-4 && Math.abs(S.place.lon - lon) < 1e-4;
    S.place = { lat, lon }; S.running = true; S.due = typeof o.due === 'function' ? o.due : null; if (!same) S.force = true;
    if (!same && S.ticking) S.again = true;   // a new place while a refresh runs: the new tile right after it
    if (!same || !S.timer) tick();
  }
  async function tick() {
    if (S.ticking) return;   // one loop: start() again while a refresh runs does not start a second one
    clearTimeout(S.timer); S.timer = 0;
    if (!S.running || !S.place) return;
    S.ticking = true;
    if (globalThis.document && document.hidden) { S.ticking = false; S.timer = setTimeout(tick, checkEveryMs); return; }   // not on screen: no data
    let due = true; try { due = !S.due || !S.t0 || S.force || S.due(S.t0); } catch (e) { /* the app's: refresh as before */ }
    if (!due) { S.ticking = false; S.timer = setTimeout(tick, checkEveryMs); return; }   // Nov-08: not due at the app's cadence: no data
    S.force = false;
    try { await ensure(S.place); } catch (e) { /* a missing frame or no network: the next look tries again */ } finally { S.ticking = false; }
    if (S.running && !S.timer) S.timer = setTimeout(tick, S.again ? 0 : checkEveryMs);
    S.again = false;
  }
  function stop() { S.running = false; clearTimeout(S.timer); S.timer = 0; }
  function status() {
    const per = S.history.length > 1 ? S.history.slice(1) : [];   // after the cold fetch: the cost of staying fresh
    const span = per.length ? (per[per.length - 1].at - S.history[0].at) / 3600e3 : 0, mbh = span > 0 ? per.reduce((a, h) => a + h.bytes, 0) / 1e6 / span : null;
    return { ready: !!(S.t0 && S.tl && windowOf(S.t0).every((t) => ['mrms', 'goes', 'glm'].every((s) => S.slices.has(sk(s, t))))), t0: S.t0, tile: S.tile,
      busy: !!S.busy, running: S.running, err: S.err ? String(S.err.message || S.err) : null, lastBytes: S.lastBytes, lastMs: S.lastMs, totalBytes: S.totalBytes,
      refreshes: S.refreshes, lastAt: S.history.length ? S.history[S.history.length - 1].at : 0, mbPerHour: mbh, cachedMB: [...S.slices.values()].reduce((a, v) => a + v.byteLength, 0) / 1e6 };
  }
  // back on screen or back online: look at once (a page that was hidden skipped its looks)
  if (globalThis.document) document.addEventListener('visibilitychange', () => { if (!document.hidden && S.running) { clearTimeout(S.timer); S.timer = 0; tick(); } });
  if (globalThis.addEventListener) addEventListener('online', () => { if (S.running) { clearTimeout(S.timer); S.timer = 0; tick(); } });
  /** HRRR's types for t0 at the current tile, when the last refresh got them (else null: the run fetches them itself) */
  const types = (t0 = S.t0) => (S.types && S.types.t0 === t0 && S.types.key === S.key ? S.types.r : null);
  return { ensure, assemble, start, stop, status, types, get tileKey() { return S.key; } };
}
