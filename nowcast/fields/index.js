// nowcast/fields/index.js - the forecast maps (v018): Precipitation, Wind, Temperature, Humidity and Pressure from NOAA's HRRR model
// (3 km, the next 18 hours; v020: every 15 minutes - Precipitation in true 15-minute steps from HRRR's sub-hourly file, the others from
// their hourly data blended on the phone between the hours), drawn as smooth colour fields under the map's names, wind with moving streaks, and small value
// pills for the cities. Data: one GRIB2 message per map and hour, read from NOAA's open-data bucket by HTTP Range (hrrr.js), only the
// view's rows for the wind; kept on the phone by run + hour + variable (cache.js); decoded in a worker (worker.js, decode.js). "Keep
// forecasts fresh" (cadence.js) decides how often a newer run is looked for and whether the next hours are read ahead (budget.js).
// Experimental: a model forecast, not an official one.
//
//   const fields = createFields({ map, fetchFn, onChange, cadence });
//   await fields.set('wind'); fields.times(); await fields.show(t); fields.legend(); fields.status(); fields.pillsFor(places, t)
//
// The map: the v018 API (map.setField, map.requestFrame / cancelFrame, map.set('pills')) when it is there; otherwise today's
// (addOverlay + api.drawGrid): the field is painted into a canvas on its lat / lon grid, the streaks and pills are overlays, and an
// animation loop of its own asks the map to draw each frame. Reduced motion: still arrows instead of streaks. A hidden page pauses.
'use strict';
import { RAMPS, TICKS, SCALE, tintAt, colorAt } from './ramps.js';
import * as H from './hrrr.js';
import { buildFromParts, header, regionFor, regionServes, makeGrid, gridIJ, blendProducts } from './decode.js';
import { keyOf, openFieldCache, safeCache } from './cache.js';
import { planFor } from './budget.js';
import { connectionOf } from '../cadence.js';
import { createParticles, particleCount, affineFrom, sampler, arrowGrid, drawArrows } from './particles.js';
import { msToMph, windTo, mmhToInH } from './units.js';

export const MODEL = 'HRRR';
const EXP = 'Experimental: a model forecast, not an official forecast or warning.';
const CREDIT = 'NOAA HRRR (High-Resolution Rapid Refresh) on NOAA Open Data Dissemination';
export const FIELDS = [
  { id: 'precip', name: 'Precipitation', unit: 'in/h', kind: 'scalar', ramp: RAMPS.rain, ramps: { rain: RAMPS.rain, snow: RAMPS.snow, sleet: RAMPS.sleet, frz: RAMPS.frz },
    ticks: TICKS.precip, scale: SCALE.precip, legendUnit: 'in/h', credit: CREDIT,
    about: `How hard it rains or snows (inches an hour) and what falls - rain, snow, sleet or freezing rain - from NOAA's HRRR model (3 km), every 15 minutes for the next 18 hours, in the radar's colours. ${EXP}` },
  { id: 'wind', name: 'Wind', unit: 'mph', kind: 'vector', ramp: RAMPS.wind, ticks: TICKS.wind, scale: SCALE.wind, legendUnit: 'mph', credit: CREDIT,
    about: `Wind 10 m (33 ft) above the ground from NOAA's HRRR model (3 km), each hour for the next 18 hours, shown smoothly every 15 minutes (blended between the hours on this phone); the streaks move the way it blows and the arrows on the city chips point where it blows to. ${EXP}` },
  { id: 'temp', name: 'Temperature', unit: '°F', kind: 'scalar', ramp: RAMPS.temp, ticks: TICKS.temp, scale: SCALE.temp, legendUnit: '°F', credit: CREDIT,
    about: `Air temperature 2 m (6.5 ft) above the ground from NOAA's HRRR model (3 km), each hour for the next 18 hours, shown smoothly every 15 minutes (blended between the hours on this phone). ${EXP}` },
  { id: 'rh', name: 'Humidity', unit: '%', kind: 'scalar', ramp: RAMPS.rh, ticks: TICKS.rh, scale: SCALE.rh, legendUnit: '%', credit: CREDIT,
    about: `Relative humidity 2 m above the ground from NOAA's HRRR model (3 km), each hour for the next 18 hours, shown smoothly every 15 minutes (blended between the hours on this phone); brown is dry air (fire weather), blue is moist. ${EXP}` },
  { id: 'pressure', name: 'Pressure', unit: 'hPa', kind: 'scalar', ramp: RAMPS.pressure, ticks: TICKS.pressure, scale: SCALE.pressure, legendUnit: 'hPa', credit: CREDIT,
    about: `Air pressure at sea level in hectopascals (the same as millibars; 1013 is average) from NOAA's HRRR model (3 km), each hour for the next 18 hours, shown smoothly every 15 minutes (blended between the hours on this phone): lows bring storms, highs fair weather. ${EXP}` },
];
const FIELD = (id) => FIELDS.find((f) => f.id === id) || null;
const notPosted = () => Object.assign(new Error('HRRR: not posted'), { code: 'NOT_POSTED' });
// the most one range read may ask for: the biggest a map needs is all of CONUS's wind rows (~5 MB); a wrfsfc file is ~150 MB
const MAX_READ = 32e6;
const KIND = { 1: 'rain', 2: 'snow', 3: 'sleet', 4: 'frz' };
const IDX_MAX = 1 << 20;   // v018 review: an hour's .idx is ~10 KB: an answer past 1 MB is not one (never read)
const MSG_MAX = 8 << 20;   // a message of HRRR's 1.9 million points is under 8 MB even at 32 bits a value: a longer .idx entry is broken
const IDLE_MS = 30e3;      // a read that brings nothing for 30 s is given up (a stalled connection; the next look reads again)
const isGrib = (u) => u.length >= 16 && u[0] === 0x47 && u[1] === 0x52 && u[2] === 0x49 && u[3] === 0x42;
/** a whole message at the start of an .idx entry's len bytes: 'GRIB', section 0's length inside them, '7777' where it ends (an entry
 *  may run past its message, as before: a line the .idx parser skips) */
const wholeMsg = (len) => (u) => {
  if (u.length !== len || !isGrib(u) || (u[8] | u[9] | u[10] | u[11])) return false;
  const t = ((u[12] << 24) >>> 0) + (u[13] << 16) + (u[14] << 8) + u[15];
  return t >= 16 && t <= len && u[t - 4] === 0x37 && u[t - 3] === 0x37 && u[t - 2] === 0x37 && u[t - 1] === 0x37;
};
/** an answer with no .idx line in it is not an .idx (a filtering proxy's page, an empty body) */
const isIdx = (u) => H.parseIdx(new TextDecoder().decode(u)).length > 0;

/** a worker for the decoding (null: decode on this thread) */
function startWorker(opt) {
  if (opt === false) return null;
  let w = opt && typeof opt.postMessage === 'function' ? opt : null;
  if (!w) { try { if (typeof Worker === 'undefined') return null; w = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' }); } catch (e) { return null; } }
  let id = 0; const pend = new Map();
  const api = {
    broken: false,
    call(msg) { return new Promise((res, rej) => { const i = ++id; pend.set(i, { res, rej }); w.postMessage({ ...msg, id: i }); }); },
    stop() { try { w.terminate(); } catch (e) { /* */ } for (const p of pend.values()) p.rej(new Error('stopped')); pend.clear(); },
  };
  w.onmessage = (ev) => { const m = ev.data || {}, p = pend.get(m.id); if (!p) return; pend.delete(m.id); if (m.error) p.rej(new Error(m.error)); else p.res(m.result); };
  w.onerror = (ev) => { api.broken = true; if (ev && ev.preventDefault) ev.preventDefault(); for (const p of pend.values()) p.rej(Object.assign(new Error('worker failed'), { code: 'WORKER' })); pend.clear(); };
  return api;
}

export function createFields({ map, fetchFn = (u, o) => fetch(u, o), onChange = () => {}, cadence = null, now = () => Date.now(), timers = globalThis,
  cache = null, worker = 'auto', doc = globalThis.document, motion = null, newCanvas = null, places = null, raf = null, maxPills = 40,
  typed = () => true } = {}) {   // v018 review: typed() false = the view's "Rain or snow" is off (Precipitation all in the rain colours)
  const NEW = typeof map.setField === 'function', FRAMES = NEW && typeof map.requestFrame === 'function' && typeof map.cancelFrame === 'function';
  const LABELS = NEW && typeof map.labels === 'function';
  const isTyped = () => { try { return typed() !== false; } catch (e) { return true; } };   // v018 merge: the labels build's names choose where the pills go
  const S = { id: null, run: null, times: [], shownT: null, wantT: null, err: null, loading: 0, bytes: 0, cached: 0, requests: 0, region: null, product: null,
    seq: 0, setSeq: 0, ready: null, plan: { refreshMin: null, prefetch: 0 }, refreshTimer: 0, viewTimer: 0, prefetchSeq: 0, painted: null, gone: false, lastCheck: 0,
    sys: null, sysReady: false, lastT: 0, field: null, framing: false, rafId: 0, arrows: false, px: 800, pillView: null, pillKey: '', pillList: null,
    off: false, memoKey: '', memo: null,   // v018 merge: off = hidden by show(null) (the map stays picked); memo: the pills by place for the hour shown
    askT: null, looking: 0, retryTimer: 0, retryMs: 0,   // v018 review: the time last drawn for, looks for a run on their way, the next try after a failure
    written: 0, later: null };   // v018 review: bytes kept since the cache's last eviction; the hour asked for while the page was hidden
  const products = new Map(), idxMem = new Map(), ijMem = new Map(), blends = new Map();   // v020: blends - an hourly map between its hours (the last 2)
  // v018 review: a read or a build on its way, by what it makes - asked again meanwhile (the view asks for the hour on the map for every
  // radar frame, a finger resting on the time bar asks on every move, read-ahead reads the next hours), the same promise: one download
  const flying = new Map();
  const once = (key, make) => {
    let p = flying.get(key);
    if (!p) { p = make(); flying.set(key, p); const done = () => { if (flying.get(key) === p) flying.delete(key); }; p.then(done, done); }
    return p;
  };
  let W = startWorker(worker);
  let store = cache ? safeCache(cache) : null;
  const storeP = store ? Promise.resolve(store) : openFieldCache().then((c) => (store = c), () => (store = safeCache({ get: async () => undefined, set: async () => {} })));
  const emit = (why) => { try { onChange(why); } catch (e) { /* the view's */ } };
  const hidden = () => !!(doc && doc.hidden);
  const conn = () => { try { return cadence && typeof cadence.conn === 'function' ? cadence.conn() : connectionOf(); } catch (e) { return connectionOf(); } };
  const choice = () => (cadence && cadence.choice != null ? String(cadence.choice) : 'off');
  const offline = () => { const c = conn(); return c.online === false || c.type === 'none'; };
  const mq = motion || (() => { try { return globalThis.matchMedia ? globalThis.matchMedia('(prefers-reduced-motion: reduce)') : null; } catch (e) { return null; } })();
  const reduced = () => !!(mq && mq.matches);
  const rafReq = raf ? raf.request : (fn) => (globalThis.requestAnimationFrame ? globalThis.requestAnimationFrame(fn) : timers.setTimeout(() => fn(now()), 16));
  const rafCancel = raf ? raf.cancel : (i) => (globalThis.cancelAnimationFrame ? globalThis.cancelAnimationFrame(i) : timers.clearTimeout(i));
  const clock = () => (globalThis.performance && performance.now ? performance.now() : Date.now());   // animation time (not the data clock `now`)
  const canvasOf = newCanvas || ((w, h) => (typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(w, h) : Object.assign(globalThis.document.createElement('canvas'), { width: w, height: h })));

  // ---------------------------------------------------------------------------------------------- reading bytes
  // v018 review: every read is checked before it is kept or drawn. A byte range comes back as 206 and exactly its bytes (a 200 is the
  // whole ~150 MB file: a proxy dropped the Range header, or it was malformed - cancelled unread); no answer is read past what was asked
  // for; what is kept is what NOAA's files hold (an answer that is not, or a broken record, is read again: never kept, never drawn); and a
  // key asked for again while it loads (a timeline playing on a slow line) is read once.
  const live = new Set();   // live: the reads under way (destroy() lets them go); once() above shares a key asked for again
  const drop = (r) => { try { const p = r && r.body && typeof r.body.cancel === 'function' ? r.body.cancel() : null; if (p && p.catch) p.catch(() => {}); } catch (e) { /* gone */ } };
  /** a body of at most max bytes: a longer one is cancelled - unread when its Content-Length says so, else as soon as it passes max;
   *  tick() after each piece that arrives */
  async function readBody(r, max, tick = () => {}) {
    const len = r.headers && typeof r.headers.get === 'function' ? Number(r.headers.get('content-length')) : NaN;
    if (len > max) { drop(r); throw new Error(`HRRR: ${len} bytes sent, at most ${max} asked for`); }
    const rd = r.body && typeof r.body.getReader === 'function' ? r.body.getReader() : null;
    if (!rd) { const u = new Uint8Array(await r.arrayBuffer()); if (u.length > max) throw new Error(`HRRR: ${u.length} bytes sent, at most ${max} asked for`); return u; }
    const parts = []; let n = 0;
    for (;;) {
      const { done, value } = await rd.read();
      if (done) break;
      n += value.length; tick();
      if (n > max) { try { const p = rd.cancel(); if (p && p.catch) p.catch(() => {}); } catch (e) { /* gone */ } throw new Error(`HRRR: more than the ${max} bytes asked for`); }
      parts.push(value);
    }
    if (parts.length === 1) return parts[0];
    const u = new Uint8Array(n); let o = 0;
    for (const p of parts) { u.set(p, o); o += p.length; }
    return u;
  }
  async function netGet(url, a = null, b = null) {
    const ranged = a !== null, want = ranged ? b - a + 1 : 0;
    // a range out of order is never sent: S3 answers a Range it cannot parse (b < a) with the whole file (measured Nov-09-2026)
    if (ranged && !(Number.isSafeInteger(a) && Number.isSafeInteger(b) && a >= 0 && b >= a && want <= MAX_READ)) throw new Error(`HRRR: a bad byte range (${a}-${b})`);
    const headers = ranged ? { Range: `bytes=${a}-${b}` } : {};
    // a read that brings nothing for IDLE_MS is given up: a stalled connection would otherwise hold the hour (and every look at it) for good
    const ac = typeof AbortController === 'function' ? new AbortController() : null;
    let timer = 0, idle = false;
    const arm = () => { if (timer) timers.clearTimeout(timer); if (ac) timer = timers.setTimeout(() => { idle = true; ac.abort(); }, IDLE_MS); };
    S.requests++; arm(); if (ac) live.add(ac);
    try {
      const r = await fetchFn(url, ac ? { headers, signal: ac.signal } : { headers });
      if (r.status === 403 || r.status === 404) { try { await readBody(r, 65536); } catch (e) { /* drained, or let go */ } throw notPosted(); }
      if (ranged ? r.status !== 206 : r.status !== 200 && r.status !== 206) { drop(r); throw new Error(`HRRR: HTTP ${r.status}${ranged && r.status === 200 ? ' (the whole file for a byte range: not read)' : ''}`); }
      const u = await readBody(r, ranged ? want : IDX_MAX, arm);
      S.bytes += u.length;
      if (ranged && u.length !== want) throw new Error(`HRRR: short read (${u.length} of ${want} bytes)`);
      return u;
    } catch (e) {
      throw idle ? new Error(`HRRR: no answer from NOAA for ${IDLE_MS / 1e3} s`) : e;
    } finally { if (timer) timers.clearTimeout(timer); if (ac) live.delete(ac); }
  }
  /** the bytes of a key: the cache's when they pass ok(u) (else read again), or NOAA's (kept only when they pass) */
  function getBytes(key, url, a = null, b = null, ok = () => true) {
    return once(key, async () => {
      const c = await storeP, hit = await c.get(key);
      if (hit) { const u = new Uint8Array(hit); if (ok(u)) { S.cached += u.byteLength; return u; } }
      const u = await netGet(url, a, b);
      if (!ok(u)) throw new Error(`HRRR: ${key.slice(key.lastIndexOf('/') + 1)} is not NOAA's data`);
      await keep(c, key, u);
      return u;
    });
  }
  /** keep bytes; each quarter of the cache's budget written (16 MB at most), its eviction runs - a long session keeps to the budget
   *  too, not only the moment a run is picked */
  async function keep(c, key, u) {
    await c.set(key, u.byteLength === u.buffer.byteLength ? u.buffer : u.slice().buffer);
    S.written += u.byteLength;
    if (S.run && S.written >= Math.max(1e6, Math.min(16e6, (c.budget || 80e6) / 4))) { S.written = 0; c.evict(S.run.cycle); }
  }
  async function getIdx(cycle, fhr) {
    const k = cycle + '/' + fhr;
    if (idxMem.has(k)) return idxMem.get(k);
    return once('idx:' + k, async () => {
      const lines = H.parseIdx(new TextDecoder().decode(await getBytes(keyOf(cycle, fhr, 'idx'), H.idxUrl(cycle, fhr), null, null, isIdx)));
      if (!lines.length) throw new Error('HRRR: an empty .idx');
      idxMem.set(k, lines); if (idxMem.size > 60) idxMem.delete(idxMem.keys().next().value);
      return lines;
    });
  }
  const probe = async (cycle, fhr) => { try { await getIdx(cycle, fhr); return true; } catch (e) { if (e && e.code === 'NOT_POSTED') return false; throw e; } };
  /** a map's messages for one hour: { NAME: { head, buf, off } } (wind: the header and the frame's 64-row blocks only) */
  const getParts = (id, cycle, fhr, frame, lines) => once(`parts:${id}/${cycle}/${fhr}/${frame ? [frame.r0, frame.c0, frame.rows, frame.cols].join(',') : ''}`, () => readParts(id, cycle, fhr, frame, lines));
  async function readParts(id, cycle, fhr, frame, lines) {
    const parts = {}, url = H.fileUrl(cycle, fhr), c = await storeP;
    for (const [v, lev, how] of H.VARS[id]) {
      const m = H.findMsg(lines, v, lev);
      if (!m || m.len === null) throw new Error(`HRRR: ${v} is not in this hour's file`);
      if (!(m.len >= 16 && m.len <= MSG_MAX)) throw new Error(`HRRR: ${v}'s line in the .idx is broken (${m.len} bytes)`);   // never asked for
      if (how === 'rows' && frame) {
        const hl = Math.min(m.len, 512), head = await getBytes(keyOf(cycle, fhr, v, 'head'), url, m.a, m.a + hl - 1, (u) => u.length === hl && isGrib(u)), h = header(head);
        if (h.total > m.len) throw new Error(`HRRR: ${v}: the message is longer than its .idx entry`);
        if (h.tpl === 0 && !h.bitmap && h.nbits) {
          const ks = H.blocksFor(frame), got = new Map(), rng = new Map(ks.map((k) => [k, H.blockRange(h, k)]));
          for (const k of ks) {   // a kept block of another length than its rows need is broken: read again (its rows decoded as zeros before)
            const hit = await c.get(keyOf(cycle, fhr, v, 'b' + k)), [a, b] = rng.get(k);
            if (hit && hit.byteLength === b - a + 1) { got.set(k, new Uint8Array(hit)); S.cached += hit.byteLength; }
          }
          for (let i = 0; i < ks.length;) {
            if (got.has(ks[i])) { i++; continue; }
            let j = i; while (j + 1 < ks.length && !got.has(ks[j + 1])) j++;
            const lo = rng.get(ks[i])[0], hi = rng.get(ks[j])[1], first = i, last = j;
            const bytes = await once(`${url}#${m.a + lo}-${m.a + hi}`, async () => {
              const u = await netGet(url, m.a + lo, m.a + hi);
              for (let q = first; q <= last; q++) { const [a, b] = rng.get(ks[q]); await keep(c, keyOf(cycle, fhr, v, 'b' + ks[q]), u.slice(a - lo, b - lo + 1)); }
              return u;
            });
            for (let q = i; q <= j; q++) { const [a, b] = rng.get(ks[q]); got.set(ks[q], bytes.subarray(a - lo, b - lo + 1)); }
            i = j + 1;
          }
          const lo = rng.get(ks[0])[0], hi = rng.get(ks[ks.length - 1])[1], buf = new Uint8Array(hi - lo + 1);
          for (const k of ks) buf.set(got.get(k), rng.get(k)[0] - lo);
          parts[v] = { head, buf, off: lo };
          continue;
        }
      }
      const msg = await getBytes(keyOf(cycle, fhr, v), url, m.a, m.b, wholeMsg(m.len));
      parts[v] = { head: msg, buf: msg, off: 0 };
    }
    return parts;
  }
  /** v020: an hour's sub-hourly .idx (Precipitation's 15-minute steps) */
  async function getSubIdx(cycle, fhr) {
    const k = 's' + cycle + '/' + fhr;
    if (idxMem.has(k)) return idxMem.get(k);
    return once('idx:' + k, async () => {
      const lines = H.parseIdx(new TextDecoder().decode(await getBytes(keyOf(cycle, fhr, 'subidx'), H.subIdxUrl(cycle, fhr), null, null, isIdx)));
      if (!lines.length) throw new Error('HRRR: an empty sub-hourly .idx');
      idxMem.set(k, lines); if (idxMem.size > 60) idxMem.delete(idxMem.keys().next().value);
      return lines;
    });
  }
  /** v020: Precipitation's messages for one 15-minute step (PRATE + the 4 types: whole messages by Range), kept by run + step */
  const getStepParts = (cycle, st, lines) => once(`step:${cycle}/${st.min}`, async () => {
    const parts = {}, url = H.subUrl(cycle, st.fhr);
    for (const [v] of H.VARS.precip) {
      const m = H.findStep(lines, v, st.min);
      if (!m || m.len === null) throw new Error(`HRRR: ${v} at ${st.min} min is not in its sub-hourly file`);
      if (!(m.len >= 16 && m.len <= MSG_MAX)) throw new Error(`HRRR: ${v}'s line in the sub-hourly .idx is broken (${m.len} bytes)`);
      const msg = await getBytes(keyOf(cycle, st.fhr, v, 'm' + st.min), url, m.a, m.b, wholeMsg(m.len));
      parts[v] = { head: msg, buf: msg, off: 0 };
    }
    return parts;
  });
  const ijFor = (grid, gkey) => { let ij = ijMem.get(gkey); if (!ij) { ij = gridIJ(grid); ijMem.set(gkey, ij); while (ijMem.size > 2) ijMem.delete(ijMem.keys().next().value); } return ij; };
  async function build(id, parts, frame, grid, gkey) {
    if (W && !W.broken) {
      try { return await W.call({ op: 'build', field: id, parts, frame, grid, gkey }); }
      catch (e) { if (!(e && e.code === 'WORKER')) throw e; W = null; }   // the worker could not start: decode here
    }
    return buildFromParts(id, parts, frame, grid, ijFor(grid, gkey));
  }
  /** v020: the product of a map at a step: Precipitation's own 15-minute step (sub-hourly file; the run's own hour from the hourly file);
   *  the hourly maps on the hour as before, between the hours their two hours blended (no more data: the hours are what is read) */
  async function product(id, cycle, vt, region) {
    if (id === 'precip') { const st = H.stepOf(cycle, vt); return st.hourly ? hourProduct(id, cycle, vt, region) : stepProduct(cycle, st, vt, region); }
    const { h0, h1, w } = H.hourPair(vt);
    if (!w) return hourProduct(id, cycle, h0, region);
    const key = `${id}/${cycle}/${vt}/${region.key}`, have = blends.get(key);
    if (have) { blends.delete(key); blends.set(key, have); return have; }
    return once('blend:' + key, async () => {
      const [a, b] = await Promise.all([hourProduct(id, cycle, h0, region), hourProduct(id, cycle, h1, region)]);
      const p = Object.assign(blendProducts(a, b, w), { valid: vt, cycle, key, srcBytes: 0 });
      blends.set(key, p); while (blends.size > 2) blends.delete(blends.keys().next().value);
      return p;
    });
  }
  async function stepProduct(cycle, st, vt, region) {
    const key = `precip/${cycle}/${vt}/${region.key}`, have = products.get(key);
    if (have) { products.delete(key); products.set(key, have); S.cached += have.srcBytes || 0; return have; }
    return once('product:' + key, async () => {
      const lines = await getSubIdx(cycle, st.fhr), frame = H.frameFor(region.box), grid = makeGrid(region.box, { dlat: region.dlat });
      if (!frame) throw new Error('HRRR: this area is outside the model');
      const parts = await getStepParts(cycle, st, lines);
      const p = await build('precip', parts, frame, grid, region.key);
      Object.assign(p, { valid: vt, cycle, key, srcBytes: Object.values(parts).reduce((s0, x) => s0 + x.buf.length, 0) });
      products.set(key, p); while (products.size > 6) products.delete(products.keys().next().value);
      return p;
    });
  }
  /** the product of a map for one hour over a region (kept: the last 6 hours and steps; asked for again while it is being made: made once) */
  async function hourProduct(id, cycle, vt, region) {
    const key = `${id}/${cycle}/${vt}/${region.key}`, have = products.get(key);
    if (have) { products.delete(key); products.set(key, have); S.cached += have.srcBytes || 0; return have; }
    return once('product:' + key, async () => {
      const fhr = H.fhrOf(cycle, vt), lines = await getIdx(cycle, fhr), frame = H.frameFor(region.box), grid = makeGrid(region.box, { dlat: region.dlat });
      if (!frame) throw new Error('HRRR: this area is outside the model');
      const parts = await getParts(id, cycle, fhr, frame, lines);
      const p = await build(id, parts, frame, grid, region.key);
      Object.assign(p, { valid: vt, cycle, key, srcBytes: Object.values(parts).reduce((s, x) => s + x.buf.length, 0) });
      products.set(key, p); while (products.size > 6) products.delete(products.keys().next().value);
      return p;
    });
  }

  // ---------------------------------------------------------------------------------------------- the run and its hours
  async function ensureRun() {
    if (S.run && now() - S.lastCheck >= 60 * 60e3) {   // opened again after an hour (whatever the choice): a newer run, if posted
      S.lastCheck = now();
      try {
        const r = await H.pickRun({ now: now(), probe, newerThan: S.run.cycle });
        if (r) { S.run = { cycle: r.cycle, fallback: r.fallback }; if (store) store.evict(r.cycle); }   // v018 review: the old runs go here too
      } catch (e) { /* keep the run */ }
    }
    if (S.run) { S.times = H.stepTimes(S.run.cycle, now()); if (S.times.length) { emit('times'); return true; } S.run = null; }
    let r = null;
    try { r = await H.pickRun({ now: now(), probe }); } catch (e) { r = null; }
    if (!r) { S.err = 'No HRRR run could be read from NOAA just now (no signal, or the bucket is late).'; S.times = []; emit('error'); return false; }
    S.run = { cycle: r.cycle, fallback: r.fallback };
    S.times = H.stepTimes(r.cycle, now()); S.lastCheck = now();   // v020: every 15 minutes
    emit('times');
    if (store) store.evict(r.cycle);
    return S.times.length > 0;
  }
  async function refresh() {
    if (!S.id || !S.run) return false;
    let r = null;
    try { r = await H.pickRun({ now: now(), probe, newerThan: S.run.cycle }); } catch (e) { r = null; }
    if (!r || !S.id) return false;
    S.run = { cycle: r.cycle, fallback: r.fallback }; S.times = H.stepTimes(r.cycle, now());
    emit('times'); emit('run');
    if (store) store.evict(r.cycle);
    if (!S.off) await draw(S.askT != null ? S.askT : S.shownT != null ? S.shownT : now());   // hidden: the newer run's hours wait for show(t); v018 review: the hour asked for
    return true;
  }
  // "Keep forecasts fresh": a look for a newer run every refreshMin minutes while a map is on and the page is seen
  function armRefresh(inMs = null) {
    if (S.refreshTimer) { timers.clearTimeout(S.refreshTimer); S.refreshTimer = 0; }
    if (!S.id || S.gone || !S.plan.refreshMin || hidden()) return;
    S.refreshTimer = timers.setTimeout(onRefreshTimer, inMs != null ? inMs : S.plan.refreshMin * 60e3);
  }
  async function onRefreshTimer() {
    S.refreshTimer = 0; S.plan = planFor(choice(), conn()); S.lastCheck = now();
    if (S.id && S.plan.refreshMin && !hidden() && !offline()) { try { await refresh(); } catch (e) { /* the next one */ } }
    armRefresh();
  }
  /** the choice may have changed (the person's, or the network's): re-arm only then, so a playing timeline never postpones the look */
  function replan() {
    const p = planFor(choice(), conn()), changed = p.refreshMin !== S.plan.refreshMin;
    S.plan = p;
    if (changed || !S.refreshTimer) { if (!S.lastCheck) S.lastCheck = now(); armRefresh(); }
  }
  /** read-ahead (Wi-Fi, a Keep-fresh choice): the next plan.prefetch hours - v020: Precipitation's next 4 steps an hour, an hourly map's
   *  next hours after the one its step ends at */
  async function prefetch(vt) {
    const seq = ++S.prefetchSeq, id = S.id, run = S.run, region = S.region;
    if (!S.plan.prefetch || !run || !region || hidden() || offline()) return;
    const frame = H.frameFor(region.box), stale = () => seq !== S.prefetchSeq || id !== S.id || S.gone || hidden();
    if (id === 'precip') {
      for (const t of H.hoursAround(S.times, vt, S.plan.prefetch * (60 / H.STEP_MIN)).slice(1)) {
        if (stale()) return;
        try { const st = H.stepOf(run.cycle, t); if (!st.hourly) await getStepParts(run.cycle, st, await getSubIdx(run.cycle, st.fhr)); } catch (e) { return; }
      }
      return;
    }
    for (const t of H.hoursAround(H.validTimes(run.cycle, now()), H.hourPair(vt).h1, S.plan.prefetch).slice(1)) {
      if (stale()) return;
      try { const fhr = H.fhrOf(run.cycle, t); await getParts(id, run.cycle, fhr, frame, await getIdx(run.cycle, fhr)); } catch (e) { return; }
    }
  }

  // ---------------------------------------------------------------------------------------------- drawing
  function viewNow() { try { return map.view(); } catch (e) { return null; } }
  async function draw(t, view = null) {
    const id = S.id, run = S.run;
    if (!id || !run) return false;
    // v018 review: a hidden page reads and decodes nothing (the view's timeline keeps ticking in the background): the hour waits for it
    if (hidden()) { S.later = t; return false; }
    const vt = H.nearestTime(S.times, t);
    if (vt == null) return false;
    S.askT = t;
    const seq = ++S.seq, v = view || viewNow();
    replan();
    const o = { px: S.px }, region = S.region && v && regionServes(S.region, v, o) ? S.region : v ? regionFor(v, o) : S.region;
    if (!region) { S.err = 'This place is outside the HRRR model (the lower 48 states and around).'; emit('error'); return false; }
    // v018 merge: the hour already on the map (the view asks again for every radar frame under it): nothing to send again
    if (S.product && S.shownT === vt && S.product.key === `${id}/${run.cycle}/${vt}/${region.key}`) return true;
    S.region = region; S.loading++; emit('loading');
    try {
      const p = await product(id, run.cycle, vt, region);
      if (seq !== S.seq || id !== S.id || S.gone) return false;
      S.product = p; S.shownT = vt; S.err = null; S.painted = null; S.retryMs = 0;
      paint(p);
      emit('shown');
      prefetch(vt);
      return true;
    } catch (e) {
      if (seq === S.seq && id === S.id && !S.gone) {
        S.err = String((e && e.message) || e);
        // v018 review: another hour's field (and its pills) never stays on the map under this hour's label; a new area that did not load
        // keeps the same hour (still true where it is drawn). Either way it is tried again by itself (retryLater)
        if (S.shownT !== vt) hideMap();
        emit('error'); retryLater();
      }
      return false;
    } finally { S.loading--; emit('loading'); }
  }
  // v018 review: a map picked with no signal (or while NOAA's bucket did not answer) and an hour or an area that did not load are tried
  // again by themselves - after a wait (30 s, doubling to 5 min), back on screen, back online - not only when another map or hour is picked
  function retryLater() {
    if (S.retryTimer) { timers.clearTimeout(S.retryTimer); S.retryTimer = 0; }
    if (!S.id || S.gone) return;
    S.retryMs = Math.min(300e3, S.retryMs ? S.retryMs * 2 : 30e3);
    S.retryTimer = timers.setTimeout(() => { S.retryTimer = 0; retryNow(); }, S.retryMs);
  }
  /** what failed, again: the run (no hours yet), else the hour (and area) last asked for when another is on the map. Nothing missing (or a
   *  look on its way): nothing. Hidden: the next look is when the page is seen again; offline: after the wait, or back online */
  function retryNow() {
    if (S.retryTimer) { timers.clearTimeout(S.retryTimer); S.retryTimer = 0; }
    if (!S.id || S.gone || hidden()) return;
    const noRun = !S.run, want = !noRun && !S.off && S.askT != null ? H.nearestTime(S.times, S.askT) : null;
    const missing = noRun ? !S.looking : want != null && !S.loading && !(S.product && S.region && S.product.key === `${S.id}/${S.run.cycle}/${want}/${S.region.key}`);
    if (!missing) return;
    if (offline()) { retryLater(); return; }
    if (noRun) S.ready = open(S.setSeq); else draw(S.askT);
  }
  function paint(p) {
    const f = FIELD(p.id);
    if (NEW) {
      if (p.id === 'precip') {
        const ty = isTyped();   // v018 review: "Rain or snow" off - all of it in the rain colours, as the radar is then
        map.setField('fields', { grid: p.grid, values: ty ? p.layers.rain : p.values, ramp: RAMPS.rain, smooth: true, opacity: 1, z: 1 });
        for (const k of ['snow', 'sleet', 'frz']) map.setField('fields:' + k, ty && p.layers[k] ? { grid: p.grid, values: p.layers[k], ramp: RAMPS[k], smooth: true, opacity: 1, z: 2 } : null);
      } else map.setField('fields', { grid: p.grid, values: p.values, ramp: f.ramp, smooth: true, opacity: 1, z: 1 });
      refreshPills(viewNow());
    } else {
      overlay('fields', 0, -20, (ctx, api) => { watch(api); if (!S.product) return; if (!S.painted) S.painted = paintCanvas(S.product); api.drawGrid(S.painted, 1); });
      overlay('fields-pills', 1, 60, (ctx, api) => drawPills(ctx, api));
      if (typeof map.draw === 'function') map.draw();
    }
    if (p.id === 'wind') { S.field = sampler(p); startMotion(); } else stopMotion();
  }
  function overlay(name, level, order, drawFn) { if (typeof map.addOverlay === 'function') map.addOverlay({ name, level, order, draw: drawFn }); }
  function unoverlay(name) { if (typeof map.removeOverlay === 'function') map.removeOverlay(name); }
  /** today's map: the product as a picture on its grid (drawGrid's { top, left, dlat, dlon, rows, cols, canvas }) */
  function paintCanvas(p) {
    const ty = isTyped();
    const { rows, cols } = p.grid, c = canvasOf(cols, rows), g = c.getContext('2d'), im = g.createImageData(cols, rows), d = im.data, f = FIELD(p.id);
    for (let q = 0, o = 0; q < rows * cols; q++, o += 4) {
      const v = p.values[q];
      const ramp = p.id === 'precip' ? RAMPS[(ty && KIND[p.type[q]]) || 'rain'] : f.ramp, col = colorAt(ramp, v);
      if (!col) continue;
      d[o] = col[0]; d[o + 1] = col[1]; d[o + 2] = col[2]; d[o + 3] = Math.round(col[3] * 255);
    }
    g.putImageData(im, 0, 0);
    return { ...p.grid, canvas: c };
  }
  function clearMap() {
    if (NEW) { for (const k of ['fields', 'fields:snow', 'fields:sleet', 'fields:frz']) map.setField(k, null); if (typeof map.set === 'function') map.set('pills', null); unoverlay('fields-watch'); }
    else { unoverlay('fields'); unoverlay('fields-pills'); }
    S.painted = null; S.pillView = null; S.pillKey = ''; S.pillList = null; S.memoKey = ''; S.memo = null;
  }
  /** v018 merge: show(null) - the field, its streaks and its pills off the map; the map stays picked (its run and hours kept) and any
   *  draw on its way is dropped. Again while hidden: nothing to do. */
  function hideMap() {
    if (S.off && !S.product && !S.framing && !S.arrows && !S.rafId) return;
    S.seq++; S.prefetchSeq++;
    if (S.viewTimer) { timers.clearTimeout(S.viewTimer); S.viewTimer = 0; }
    stopMotion();
    if (NEW) { for (const k of ['fields', 'fields:snow', 'fields:sleet', 'fields:frz']) map.setField(k, null); if (typeof map.set === 'function') map.set('pills', null); }
    else { unoverlay('fields'); unoverlay('fields-pills'); if (typeof map.draw === 'function') map.draw(); }
    S.product = null; S.shownT = null; S.field = null; S.painted = null; S.pillView = null; S.pillKey = ''; S.pillList = null; S.memoKey = ''; S.memo = null;
  }

  // the view: a pan or zoom past the loaded area loads the new one (a moment after the map stops)
  function watch(api) {
    if (api && api.h > 0) S.px = api.h;
    if (!S.id || S.gone) return;
    const v = api && (api.view || (typeof api.bounds === 'function' ? api.bounds() : null));
    if (!S.region) {   // v018 review: picked while the map showed a place outside HRRR (no area loaded): the first view inside it loads
      if (v && S.run && !S.off && S.askT != null && !S.loading && !S.viewTimer && regionFor(v, { px: S.px })) S.viewTimer = timers.setTimeout(() => { S.viewTimer = 0; if (!S.region && !S.off) draw(S.askT, v); }, 350);
      return;
    }
    if (v && NEW && S.product && !LABELS && moved(S.pillView, v)) refreshPills(v);   // cities that came into view get their chips (a labels map asks itself)
    if (!v || regionServes(S.region, v, { px: S.px })) return;
    if (S.viewTimer) timers.clearTimeout(S.viewTimer);
    S.viewTimer = timers.setTimeout(() => { S.viewTimer = 0; viewChanged({ view: v }); }, 350);
  }
  /** a view moved by a quarter of its size, or zoomed (the pills' list is worked out again) */
  const moved = (a, b) => { if (!a) return true; const sw = a[2] - a[0], sh = a[3] - a[1], r = (b[2] - b[0]) / sw;
    return r > 1.25 || r < 0.8 || Math.abs(b[0] - a[0]) > sw / 4 || Math.abs(b[1] - a[1]) > sh / 4; };
  function refreshPills(v) {
    S.pillView = v ? v.slice() : null;
    if (typeof map.set !== 'function') return;
    // v018 merge: a map with the labels build's names (map.labels) takes a function and asks it, each frame, for the places it may name -
    // so a chip only ever sits under a name (never alone, never for a place the names left out)
    if (LABELS) { map.set('pills', S.product && S.shownT != null ? pillFn : null); return; }
    map.set('pills', S.product && S.shownT != null ? pillsFor(candidates(v || viewNow()), S.shownT) : null);
  }
  /** the labels' pills function: the hour shown's values at those places, kept by place for that hour (the map asks every frame) */
  function pillFn(list) {
    const p = S.product;
    if (!p || S.shownT == null || !Array.isArray(list)) return [];
    if (S.memoKey !== p.key || !S.memo || S.memo.size > 4000) { S.memo = new Map(); S.memoKey = p.key; }
    const key = (e) => (+e.lat).toFixed(4) + ',' + (+e.lon).toFixed(4), miss = [];
    for (const e of list) if (!S.memo.has(key(e))) miss.push(e);
    if (miss.length) {
      const got = new Map(pillsFor(miss, S.shownT).map((q) => [key(q), q]));
      for (const e of miss) S.memo.set(key(e), got.get(key(e)) || null);
    }
    const out = [];
    for (const e of list) { const q = S.memo.get(key(e)); if (q) out.push(q); }
    return out;
  }
  /** the map moved to `view` [w, s, e, n]: reload when the loaded area no longer serves it -> true when it redrew */
  async function viewChanged({ view } = {}) {
    if (!S.id || !S.run || S.shownT == null || !view || regionServes(S.region, view, { px: S.px })) return false;
    S.region = null;
    return draw(S.askT != null ? S.askT : S.shownT, view);   // v018 review: the hour asked for (one may be loading), not the one on the map
  }

  // streaks / arrows
  /** the screen as the streaks need it (CSS px; the size from the context's canvas where the api does not say) */
  const viewOf = (api, ctx = null) => {
    const dpr = api.dpr || 1, cv = ctx && ctx.canvas;
    return { ...affineFrom(api.project || api.toScreen), w: api.w || (cv ? cv.width / dpr : 390), h: api.h || (cv ? cv.height / dpr : 844) };
  };
  function frameDraw(ctx, api, tMs) {
    if (!S.field || S.id !== 'wind') return;
    watch(api);
    const view = viewOf(api, ctx), z = api.zoom != null ? api.zoom : api.z != null ? api.z : 6, n = particleCount(view.w, view.h, z);
    if (!S.sys) { S.sys = createParticles({ count: n }); S.sysReady = false; }
    if (Math.abs(S.sys.count - n) > n * 0.1) S.sys.resize(n, view);
    if (!S.sysReady) { S.sys.reset(view); S.sysReady = true; S.lastT = tMs; }
    const dt = S.lastT ? Math.max(0.25, Math.min(3, (tMs - S.lastT) / 16.67)) : 1;
    S.lastT = tMs;
    S.sys.step(S.field, view, dt || 1);
    S.sys.draw(ctx, S.sys.build(view), { width: api.dpr > 1.5 ? 1.25 : 1.4 });
  }
  const frameFn = (ctx, api, tMs) => frameDraw(ctx, api, tMs);
  function startMotion() {
    stopMotion();
    if (!S.field || hidden() || S.gone) return;
    if (reduced()) {
      S.arrows = true;
      overlay('fields-arrows', 1, 40, (ctx, api) => { if (S.field) drawArrows(ctx, arrowGrid(viewOf(api, ctx), S.field, 44)); });
      return;
    }
    if (FRAMES) { map.requestFrame(frameFn); S.framing = true; return; }
    overlay('fields-wind', 1, 40, (ctx, api) => frameDraw(ctx, api, clock()));
    const loop = () => { S.rafId = rafReq(loop); if (typeof map.draw === 'function') map.draw(); };   // today's map repaints, the overlay steps
    S.rafId = rafReq(loop);
  }
  function stopMotion() {
    if (S.framing) { map.cancelFrame(frameFn); S.framing = false; }
    if (S.rafId) { rafCancel(S.rafId); S.rafId = 0; }
    if (S.arrows) { unoverlay('fields-arrows'); S.arrows = false; }
    if (!NEW || !FRAMES) unoverlay('fields-wind');
    S.lastT = 0;
  }

  // pills
  function candidates(v = viewNow()) {
    let list = typeof places === 'function' ? places() : places;
    if (!list && typeof map.get === 'function') list = map.get('places');
    if (!list || !v) return [];
    const out = [];
    for (const e of list) { if (e.lat >= v[1] && e.lat <= v[3] && e.lon >= v[0] && e.lon <= v[2]) { out.push(e); if (out.length >= maxPills) break; } }
    return out;
  }
  /** a product's value(s) at a place: bilinear between cell centres (nearest where a neighbour has no data) */
  function sampleAt(p, lat, lon, arr) {
    const g = p.grid, r = (g.top - lat) / g.dlat - 0.5, c = (lon - g.left) / g.dlon - 0.5;
    if (!(r >= -0.5 && c >= -0.5 && r <= g.rows - 0.5 && c <= g.cols - 0.5)) return NaN;
    const r0 = Math.max(0, Math.min(g.rows - 2, Math.floor(r))), c0 = Math.max(0, Math.min(g.cols - 2, Math.floor(c)));
    const fr = Math.max(0, Math.min(1, r - r0)), fc = Math.max(0, Math.min(1, c - c0)), k = r0 * g.cols + c0, W = g.cols;
    const a = arr[k], b = arr[k + 1], d = arr[k + W], e = arr[k + W + 1];
    if (a === a && b === b && d === d && e === e) return (a * (1 - fc) + b * fc) * (1 - fr) + (d * (1 - fc) + e * fc) * fr;
    return arr[Math.round(r) * W + Math.round(c)];
  }
  function productAt(vt) {
    if (S.product && S.product.valid === vt && S.product.id === S.id) return S.product;
    for (const m of [products, blends]) for (const p of m.values()) if (p.id === S.id && S.run && p.cycle === S.run.cycle && p.valid === vt && S.region && p.key.endsWith(S.region.key)) return p;
    return null;
  }
  function pillsFor(list, t) {
    if (!S.id || !S.run || !Array.isArray(list)) return [];
    const vt = H.nearestTime(S.times, t), p = vt == null ? null : productAt(vt);
    if (!p) return [];
    const out = [];
    for (const e of list) {
      const lat = +e.lat, lon = +e.lon, base = { lat: e.lat, lon: e.lon, name: e.name };
      if (p.id === 'wind') {
        const u = sampleAt(p, lat, lon, p.u), v = sampleAt(p, lat, lon, p.v); if (!(u === u && v === v)) continue;
        const mph = Math.round(msToMph(Math.hypot(u, v)));
        out.push({ ...base, text: String(mph), arrowDeg: mph >= 1 ? windTo(u, v) : undefined, tone: tintAt(RAMPS.wind, mph) });
      } else if (p.id === 'precip') {
        const rate = sampleAt(p, lat, lon, p.values); if (!(rate >= 0.254)) continue;
        const g = p.grid, q = Math.round((g.top - lat) / g.dlat - 0.5) * g.cols + Math.round((lon - g.left) / g.dlon - 0.5), kind = (isTyped() && KIND[p.type[q]]) || 'rain', inh = mmhToInH(rate);
        out.push({ ...base, text: inh < 0.1 ? inh.toFixed(2) : inh.toFixed(1), arrowDeg: undefined, tone: tintAt(RAMPS[kind], rate), kind });
      } else {
        const x = sampleAt(p, lat, lon, p.values); if (x !== x) continue;
        const r = Math.round(x), text = p.id === 'temp' ? `${r}°` : p.id === 'rh' ? `${r}%` : String(r);
        out.push({ ...base, text, arrowDeg: undefined, tone: tintAt(FIELD(p.id).ramp, r) });
      }
    }
    return out;
  }
  /** today's map names a place from zoom-dependent sizes (map.js minW): its chips follow the same rule */
  const minW = (z) => (z < 4.6 ? 300 : z < 5.6 ? 100 : z < 6.6 ? 30 : z < 7.6 ? 8 : z < 8.6 ? 2 : 0);
  /** today's map: the pills drawn as chips under the city names, biggest places first, never on each other (the v018 map draws them
   *  itself from map.set('pills')) */
  function drawPills(ctx, api) {
    if (!S.product || S.shownT == null) return;
    const v = api.view || viewNow(), z = api.z != null ? api.z : api.zoom, key = S.product.key + '|' + z + '|' + (v ? v.map((x) => x.toFixed(3)).join(',') : '');
    if (S.pillKey !== key) { S.pillKey = key; S.pillList = pillsFor(candidates(v).filter((e) => !(e.w < minW(z))), S.shownT); }
    const list = S.pillList || [], dk = !!api.dark, boxes = [];
    ctx.font = '600 11px -apple-system, BlinkMacSystemFont, system-ui, sans-serif'; ctx.textBaseline = 'middle'; ctx.textAlign = 'center';
    for (const pl of list) {
      if (boxes.length >= 16) break;
      const p = api.toScreen(pl.lat, pl.lon), tw = ((ctx.measureText(pl.text) || {}).width || pl.text.length * 6.5) + (pl.arrowDeg != null ? 12 : 0), w = tw + 10, h = 16, x = p.x + 3, y = p.y + 9;
      if (boxes.some((b) => x < b.x + b.w + 2 && x + w + 2 > b.x && y < b.y + b.h + 2 && y + h + 2 > b.y)) continue;
      boxes.push({ x, y, w, h });
      const cxText = x + w / 2 - (pl.arrowDeg != null ? 6 : 0);
      ctx.beginPath(); if (ctx.roundRect) ctx.roundRect(x, y, w, h, 8); else ctx.rect(x, y, w, h);
      ctx.fillStyle = pl.tone; ctx.fill(); ctx.lineWidth = 1; ctx.strokeStyle = dk ? 'rgba(0,0,0,0.55)' : 'rgba(255,255,255,0.8)'; ctx.stroke();
      ctx.fillStyle = '#0A0A0B'; ctx.fillText(pl.text, cxText, y + h / 2 + 0.5);
      if (pl.arrowDeg != null) {
        const r = (pl.arrowDeg * Math.PI) / 180, cx = x + w - 10, cy = y + h / 2, dx = Math.sin(r), dy = -Math.cos(r);
        ctx.beginPath(); ctx.moveTo(cx - dx * 4.5, cy - dy * 4.5); ctx.lineTo(cx + dx * 4.5, cy + dy * 4.5);
        ctx.moveTo(cx + dx * 4.5 - dx * 3 - dy * 2.6, cy + dy * 4.5 - dy * 3 + dx * 2.6); ctx.lineTo(cx + dx * 4.5, cy + dy * 4.5); ctx.lineTo(cx + dx * 4.5 - dx * 3 + dy * 2.6, cy + dy * 4.5 - dy * 3 - dx * 2.6);
        ctx.strokeStyle = '#0A0A0B'; ctx.lineWidth = 1.4; ctx.stroke();
      }
    }
  }

  // ---------------------------------------------------------------------------------------------- page events
  const onVis = () => {
    if (hidden()) { stopMotion(); if (S.refreshTimer) { timers.clearTimeout(S.refreshTimer); S.refreshTimer = 0; } return; }
    if (S.id === 'wind' && S.field) startMotion();
    S.plan = planFor(choice(), conn());
    // back on screen: one look at once when the last is older than the cadence, else the rest of the wait
    const due = S.plan.refreshMin && S.lastCheck && now() - S.lastCheck >= S.plan.refreshMin * 60e3;
    armRefresh(due ? 0 : null);
    if (S.later != null) { const t = S.later; S.later = null; if (S.id && S.run && !S.off && !S.gone) draw(t); }   // the hour asked for while hidden
    retryNow();   // v018 review: a look that failed (or whose retry fell due while hidden), again at once; nothing when all is drawn
  };
  const onMotion = () => { if (S.id === 'wind' && S.field && !hidden()) startMotion(); };
  const onOnline = () => retryNow();   // v018 review: back in service
  const win = typeof globalThis.addEventListener === 'function' ? globalThis : null;
  if (doc && doc.addEventListener) doc.addEventListener('visibilitychange', onVis);
  if (mq && mq.addEventListener) mq.addEventListener('change', onMotion);
  if (win) win.addEventListener('online', onOnline);

  // ---------------------------------------------------------------------------------------------- the interface
  /** the forecast map on the map (null: none); t (optional): the hour to show first (else the last asked, else the one nearest now) */
  function set(id, t = null) {
    id = id || null;
    if (id && !FIELD(id)) throw new Error('no such forecast map: ' + id);
    if (t != null) { S.wantT = t; S.off = false; }   // a time given: shown at that hour (v018 merge: even after show(null))
    if (id === S.id) return id && t != null ? show(t) : S.ready || Promise.resolve(true);
    stopMotion(); clearMap();
    if (S.viewTimer) { timers.clearTimeout(S.viewTimer); S.viewTimer = 0; }
    if (S.retryTimer) { timers.clearTimeout(S.retryTimer); S.retryTimer = 0; }
    S.id = id; S.product = null; S.shownT = null; S.err = null; S.field = null; S.seq++; S.prefetchSeq++; S.askT = null; S.retryMs = 0;
    const token = ++S.setSeq;
    emit('field');
    if (!id) { S.ready = null; S.times = []; S.region = null; S.off = false; replan(); return Promise.resolve(true); }
    if (NEW) overlay('fields-watch', 0, -99, (ctx, api) => watch(api));
    S.ready = open(token);
    return S.ready;
  }
  /** the picked map's run and its first hour (set; again by retryNow after a look that failed) */
  async function open(token) {
    S.loading++; S.looking++; emit('loading');
    let ok = false;
    try { ok = await ensureRun(); } finally { S.loading--; S.looking--; }
    if (token !== S.setSeq || S.gone) { emit('loading'); return false; }
    if (!ok) { emit('loading'); retryLater(); return false; }   // v018 review: no signal, NOAA late: tried again by itself
    S.retryMs = 0;
    emit('loading');
    if (S.off) return true;   // v018 merge: hidden (show(null)): the hours are known; nothing is drawn until show(t)
    return draw(S.wantT != null ? S.wantT : now());
  }
  async function show(t) {
    // v018 merge: show(null) hides the field (the view's radar and nowcast frames under Precipitation's hours); the map stays picked
    if (t == null) { S.wantT = null; hideMap(); S.off = true; return false; }
    S.wantT = t; S.off = false;   // remembered: a set(id) after it opens at this hour
    if (!S.id) return false;
    if (!S.run) { const ok = await (S.ready || Promise.resolve(false)); if (!ok && !S.run) return false; if (S.off) return false; }
    return draw(t);
  }
  function legend() {
    const f = FIELD(S.id); if (!f) return null;
    const l = { id: f.id, name: f.name, unit: f.unit, ramp: f.ramp, ticks: f.ticks, scale: f.scale, model: MODEL, run: S.run ? S.run.cycle : null };
    if (f.ramps) l.ramps = f.ramps;
    return l;
  }
  // v020: w - how far the step shown is between an hourly map's two hours (0 on the hour, and for Precipitation's own steps)
  const status = () => ({ loading: S.loading > 0, err: S.err, bytes: S.bytes, cached: S.cached, requests: S.requests, model: MODEL, run: S.run ? S.run.cycle : null,
    fallback: S.run ? S.run.fallback : false, valid: S.shownT, field: S.id, plan: { ...S.plan }, w: S.product && S.product.blend ? S.product.blend.w : 0 });
  function destroy() {
    if (S.gone) return;
    set(null); S.gone = true;
    if (S.refreshTimer) timers.clearTimeout(S.refreshTimer);
    if (S.viewTimer) timers.clearTimeout(S.viewTimer);
    if (S.retryTimer) timers.clearTimeout(S.retryTimer);
    S.refreshTimer = S.viewTimer = S.retryTimer = 0;
    if (doc && doc.removeEventListener) doc.removeEventListener('visibilitychange', onVis);
    if (mq && mq.removeEventListener) mq.removeEventListener('change', onMotion);
    if (win) win.removeEventListener('online', onOnline);
    if (W) W.stop();
    for (const ac of live) { try { ac.abort(); } catch (e) { /* */ } }
    products.clear(); blends.clear(); idxMem.clear(); ijMem.clear(); flying.clear(); live.clear(); S.later = null;
  }
  /** v018 review: the map drawn again as it is now (the view's "Rain or snow" changed: typed()) */
  function repaint() { if (!S.product || S.off || S.gone) return; S.painted = null; S.memoKey = ''; S.memo = null; paint(S.product); }
  return { set, active: () => S.id, times: () => S.times.slice(), show, legend, status, pillsFor, destroy, refresh, viewChanged,
    replan: () => replan(), repaint };   // v018 review: replan - a new Keep-fresh choice used at once
}
