// Part of BEAM's phone code (kept identical to BEAM's own build).
// js/runner/run_beam.js - one BEAM run for the whole Inland NW frame (HRRR 3 km, 304 x 304, rows from the south): the newest runnable
// frame time, the four input builders (radar, lightning, satellite, HRRR) side by side, the 40-channel float16 stack, the trained
// fallbacks, the model, and a result in the app's run shape (run.js / run_ss.js: id, t0, made, size, km, members, precision, spec,
// ms, ...) with BEAM's maps and flags. No map layers here: the app wiring is a later step.
//
// Time rule: the lightning frame of t0 holds the flashes of [t0, t0 + 10 min) (the backtest's pull), so a run for t0 needs every
// GLM file through the one that starts at t0 + 8:00: runnable from t0 + 9 min (glmEarliestRun). Until then the GLM builder answers
// "pending" with a retry_at; the runner waits for it (up to retry.glmMaxWaitMs) and reads only GLM again.
//
// Fallbacks, all inside what BEAM was trained on (PLAN 2.1, 6.6):
//   MRMS unreachable, or its grid / format changed -> condition 'hidden' (radar channels 0, coverage [1, 1, 1, 0], radar_valid 0);
//   HRRR late -> the previous cycle (the HRRR builder does it; `degraded`);
//   GLM or ABI gaps -> zeros as in training, flagged (a GLM frame with fewer than 4 of its 5 sampled files is flagged: no lightning
//   there may be missing data, never "no lightning").
//
//   const pool = await makeInputPool({ workers: 1 });                       // reuse it: its cache makes the next run cheap
//   const e = await createBeamEngine(); await e.load('pack/');                 // js/engine/engine.js
//   const res = await runBeam({ pool, engine: e });                             // static channels from e.staticChannels()
//   res.mean (Float32Array 12 x 304 x 304: map = 4 x bin + head), res.maps.hail[bin], res.ok, res.degraded, res.condition, res.missing
'use strict';
import { NAMES, runBuilder } from './builders.js';
import { meteredFetch } from './net.js';
import { openInputCache } from './cache.js';
import { assembleStack, staticBits, stackHash, toHWC, N, S } from './stack.js';
import { glmEarliestRun, glmLatestT0 } from '../inputs/glm/glm.js';
import { hrrrLatLon } from '../../stormscope/lcc.js';

const MIN = 60e3;
export const BEAM = {
  id: 'beam', name: 'BEAM', long: 'Blended Early-warning Alert Model',
  frame: { row0: 689, col0: 260, size: S, km: 3, grid: 'HRRR 3 km Lambert', rowsFrom: 'south' },
  outputs: { maps: 12, heads: ['hail', 'core', 'lightning', 'rain'], binsMin: [[0, 30], [30, 60], [60, 90]], index: 'map = 4 * bin + head' },
  runAfterMin: 9,
};
const clock = () => (globalThis.performance || Date).now();
const memNow = () => (globalThis.performance && performance.memory ? +(performance.memory.usedJSHeapSize / 1e6).toFixed(1) : null);

// ------------------------------------------------------------------------------------------------ time
/** the newest frame time whose inputs can all be posted at `now` (t0 + 9 min) */
export function newestRunnableT0(now = Date.now()) { return glmLatestT0(now); }
/** when a run for t0 can start */
export function runnableAt(t0) { return glmEarliestRun(t0); }
/** frame pixel (row from the south, column) -> { lat, lon } */
export function frameLatLon(row, col) { return hrrrLatLon(BEAM.frame.col0 + col, BEAM.frame.row0 + row); }

// ------------------------------------------------------------------------------------------------ the input pool
/**
 * makeInputPool({ workers, maxFetch, fetch, cache, cacheName, budgetMB, log, workerUrl, radarAlone })
 *   workers 0: the builders run on this thread (fetch / cache may be given: tests, Node);
 *   workers 1: one module worker runs all four (decoding off the page's thread; the CPU work is serial, which also bounds memory);
 *   workers 2: radar + GLM in one, HRRR + ABI in the other.
 *   maxFetch: downloads in flight per thread. A worker that will not start falls back to this thread (pool.fallback says why).
 * -> { mode, persistent, build(name, t0, opts, { signal }), flush(), evict(t0), stats(), meter(), close() }
 */
export async function makeInputPool(o = {}) {
  const { workers = 0, maxFetch = 6, budgetMB = 120, cacheName = 'beam-inputs', log = false } = o;
  if (workers > 0 && typeof Worker !== 'undefined') {
    try { return await workerPool({ ...o, workers, maxFetch, budgetMB, cacheName, log }); } catch (e) {
      const p = await localPool({ ...o, maxFetch, budgetMB, cacheName, log }); p.fallback = String((e && e.message) || e); return p;
    }
  }
  return localPool({ ...o, maxFetch, budgetMB, cacheName, log });
}

async function localPool(o) {
  const cache = o.cache || await openInputCache({ name: o.cacheName, budgetMB: o.budgetMB });
  const fetch = meteredFetch(o.fetch, { max: o.maxFetch, log: o.log });
  return {
    mode: 'main', workers: 0, persistent: !!cache.persistent, cache, fetchMeter: fetch.meter,
    async build(name, t0, opts, { signal } = {}) { const r = await runBuilder(name, t0, opts, { fetch, cache, signal }); r.flushed = await cache.flush().catch(() => 0); return r; },
    flush: () => cache.flush(), evict: (t0) => cache.evict(t0), stats: async () => ({ ...(await cache.stats()), persistent: !!cache.persistent }),
    async meter() { const { log, byTag, ...rest } = fetch.meter; return { ...rest, log: log ? log.splice(0) : null }; },
    close() { /* the caller's cache */ },
  };
}

async function workerPool(o) {
  const url = o.workerUrl || new URL('./inputs_worker.js', import.meta.url);
  const ws = [];
  for (let i = 0; i < Math.min(2, o.workers); i++) {
    const w = new Worker(url, { type: 'module' }), wait = new Map(); let n = 0;
    const call = (msg, tr = []) => new Promise((res, rej) => { const id = ++n; wait.set(id, { res, rej }); w.postMessage({ ...msg, id }, tr); return id; });
    w.onmessage = (ev) => { const { id, result, error } = ev.data || {}; const p = wait.get(id); if (!p) return; wait.delete(id); if (error) p.rej(Object.assign(new Error(error.message), error)); else p.res(result); };
    w.onerror = (ev) => { const e = new Error('input worker failed: ' + (ev.message || 'error')); for (const p of wait.values()) p.rej(e); wait.clear(); };
    ws.push({ w, call, nextId: () => n + 1 });
  }
  const timeout = (p, ms, what) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(what + ' timed out')), ms))]);
  let info;
  try { info = await timeout(Promise.all(ws.map((x) => x.call({ op: 'init', maxFetch: o.maxFetch, cacheName: o.cacheName, budgetMB: o.budgetMB, log: o.log, cache: o.cacheKind }))), 15000, 'worker start'); }
  catch (e) { for (const x of ws) x.w.terminate(); throw e; }
  const pick = (name) => ws[ws.length === 1 ? 0 : (name === 'radar' || name === 'glm' ? 0 : 1)];
  const all = (op, extra = {}) => Promise.all(ws.map((x) => x.call({ op, ...extra })));
  return {
    mode: 'worker', workers: ws.length, persistent: info.every((x) => x.persistent), openError: info.map((x) => x.openError).filter(Boolean)[0] || null,
    async build(name, t0, opts, { signal } = {}) {
      const x = pick(name), id = x.nextId(), p = x.call({ op: 'build', name, t0: +t0, opts });
      const onAbort = () => { x.call({ op: 'abort', of: id }).catch(() => {}); };
      if (signal) signal.addEventListener('abort', onAbort, { once: true });
      try { return await p; } catch (e) { if (signal && signal.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' }); throw e; }
      finally { if (signal) signal.removeEventListener('abort', onAbort); }
    },
    async flush() { return (await all('flush')).reduce((a, b) => a + (b || 0), 0); },
    async evict(t0) { return all('evict', { t0: +t0 }); },
    async stats() { const s = await all('stats'); return s[0]; },
    async meter() { return all('meter'); },
    close() { for (const x of ws) x.w.terminate(); },
  };
}

// ------------------------------------------------------------------------------------------------ the flags
/** one builder's missing list -> [{ src, ch, what, t, why, kind: 'pending' | 'gap' | 'error' | 'fallback' | 'info', retryAt }] */
export function normalizeMissing(name, r) {
  if (!r) return [];
  const out = [];
  for (const m of r.missing || []) {
    if (name === 'hrrr') {   // the HRRR builder lists strings
      const s = String(m), kind = /: degraded$/.test(s) ? 'fallback' : /no usable cycle/.test(s) ? 'error' : 'info';
      const ch = /channel (\d+) = 0/.exec(s);
      out.push({ src: name, ch: ch ? +ch[1] : null, what: s.split(':')[0], why: s, kind });
      continue;
    }
    let kind;
    if (name === 'radar') kind = m.pending ? 'pending' : /listing failed|download failed|MRMS grid changed|^MRMS (file|PNG)/.test(m.why) ? 'error' : 'gap';
    else if (name === 'glm') kind = m.kind === 'error' ? 'error' : m.pending ? 'pending' : 'gap';
    else kind = m.kind === 'not-posted' ? 'pending' : m.kind === 'error' ? 'error' : 'gap';
    out.push({ src: name, ch: m.ch ?? null, what: m.what, t: m.t || null, why: m.why, kind, ...(m.retry_at ? { retryAt: m.retry_at } : {}) });
  }
  return out;
}
const isNetErr = (m) => /listing failed|download failed|read failed|answered 5\d\d|failed to fetch|network|timed out|\.idx not read/i.test(m.why || '');

/** MRMS unreachable or changed -> 'hidden' (PLAN 2.1) */
export function radarCondition(r, err = null) {
  if (!r) return { condition: 'hidden', why: 'the radar inputs failed: ' + (err ? String(err.message || err) : 'no result') };
  const fatal = (r.missing || []).find((m) => /MRMS grid changed|^MRMS (file|PNG)/.test(m.why));
  if (fatal) return { condition: 'hidden', why: 'MRMS grid or format changed: ' + fatal.why };
  const t0Lost = (r.missing || []).find((m) => m.ch === 5 && /listing failed|download failed/.test(m.why));
  if (t0Lost) return { condition: 'hidden', why: 'MRMS unreachable (the newest reflectivity): ' + t0Lost.why };
  return { condition: 'visible', why: null };
}

const sleep = (ms, signal) => new Promise((res, rej) => {
  const t = setTimeout(res, ms);
  if (signal) signal.addEventListener('abort', () => { clearTimeout(t); rej(Object.assign(new Error('aborted'), { name: 'AbortError' })); }, { once: true });
});

// ------------------------------------------------------------------------------------------------ the run
/**
 * opts: {
 *   pool (makeInputPool; made here on this thread when absent), static (the pack's beam.static: 8 x 304 x 304 float16; default: the
 *   loaded engine's staticChannels()), engine (js/engine/engine.js createBeamEngine(), or any { loaded, load(src), run(stack, o) -> { mean, odd?, even? } }),
 *   pack (engine.load's src: the pack URL | a store | { model, weights, static }), members (also each member's maps),
 *   now (picks t0; default the clock), t0 (a Date / ms: run this frame instead), signal, onProgress({ phase, src, frac, text }),
 *   radar: { concurrency }, hrrr: { envHour, envAnchor, envStep, fallback, concurrency },
 *   retry: { glm: 4, glmMaxWaitMs: 150000, radar: 1, abi: 1, hrrr: 1 }, runPending (run the model while inputs are pending; default false),
 *   keepStack (default true), evict (default true) }
 * -> {
 *   id, model: 'beam', t0 (ms), made, ageMin, size: 304, km: 3, frame, spec, members, precision,
 *   mean: Float32Array(12 * N) | null, folds: { odd, even } | null, maps: { hail: [bin0, bin1, bin2], core, lightning, rain } | null,
 *   ok, degraded, pending, retryAt, condition, conditionWhy, missing: [...], flags: [{ kind, text }],
 *   inputs: { radar | glm | abi | hrrr: { ok, ms, bytes, requests, missing, tries, ...extra } },
 *   stack: Uint16Array(40 * N) float16 [ch][row][col] | null, stackHash, absent: [channels no builder gave],
 *   bytes, requests, ms: { total, inputs, wait, stack, model, perBuilder }, memory: { pageMB, workerMB }, cache: { persistent, mode } }
 */
export async function runBeam(opts = {}) {
  const tStart = clock(), made = Date.now();
  const { signal, onProgress = () => {}, engine = null, pack = null, runPending = false, keepStack = true } = opts;
  const retry = { glm: 4, glmMaxWaitMs: 150e3, radar: 1, abi: 1, hrrr: 1, ...(opts.retry || {}) };
  const ownPool = !opts.pool, pool = opts.pool || await makeInputPool({ workers: 0 });
  const T0 = opts.t0 != null ? new Date(+new Date(opts.t0)) : newestRunnableT0(opts.now ?? Date.now());
  const bopts = { radar: { ...(opts.radar || {}) }, glm: {}, abi: {}, hrrr: { ...(opts.hrrr || {}) } };
  if (opts.replayNow != null) for (const k of NAMES) bopts[k].now = +opts.replayNow;
  const res = {}, err = {}, tries = { radar: 0, glm: 0, abi: 0, hrrr: 0 }, net = { bytes: 0, requests: 0 }, perBuilder = {}, workerMB = [];
  const prog = (p) => { try { onProgress(p); } catch (e) { /* the caller's */ } };
  const build = async (name) => {
    tries[name]++;
    prog({ phase: 'inputs', src: name, text: `${name}: reading` });
    try {
      const r = await pool.build(name, T0, bopts[name], { signal });
      res[name] = r; delete err[name];
      net.bytes += r.net.bytes; net.requests += r.net.requests; perBuilder[name] = (perBuilder[name] || 0) + r.ms;
      if (r.worker && r.worker.heap) workerMB.push(r.worker.heap.usedMB);
      prog({ phase: 'inputs', src: name, text: `${name}: ${r.ok ? 'ok' : 'incomplete'} (${(r.net.bytes / 1e6).toFixed(2)} MB)` });
    } catch (e) {
      if (e && e.name === 'AbortError') throw e;
      err[name] = e; res[name] = res[name] || null;
    }
  };

  // 1. all four, side by side
  const tIn = clock();
  await Promise.all(NAMES.map(build));
  const inputsMs = clock() - tIn;

  // 2. retries: transient network errors once; GLM until its last file is posted
  let waitMs = 0;
  const again = [];
  if (retry.radar && (err.radar || (res.radar && res.radar.missing.some(isNetErr)))) again.push('radar');
  if (retry.abi && (err.abi || (res.abi && res.abi.missing.some((m) => m.kind === 'error')))) again.push('abi');
  if (retry.hrrr && (err.hrrr || (res.hrrr && res.hrrr.missing.some((m) => /not read|HTTP 5|fetch|network|short read/i.test(m))))) again.push('hrrr');
  if (err.glm || (res.glm && res.glm.missing.some((m) => m.kind === 'error'))) again.push('glm');
  if (again.length) { prog({ phase: 'retry', text: 'reading again: ' + again.join(', ') }); await Promise.all(again.map(build)); }
  const glmWaiting = () => res.glm && res.glm.missing.some((m) => m.pending && m.kind !== 'error');   // not posted yet / late / frame incomplete
  for (let k = 0; k < retry.glm && glmWaiting(); k++) {
    const at = Math.max(...res.glm.missing.filter((m) => m.pending && m.kind !== 'error').map((m) => (m.retry_at ? Date.parse(m.retry_at) : Date.now() + 30e3)));
    const w = Math.max(0, at - Date.now()) + 1500;
    if (w > retry.glmMaxWaitMs) break;
    prog({ phase: 'wait', src: 'glm', text: `lightning: waiting ${Math.round(w / 1000)} s for the newest file` });
    const tw = clock(); await sleep(w, signal); waitMs += clock() - tw;
    await build('glm');
  }

  // 3. condition, stack (channels 31-38: opts.static, the pack's, or the loaded engine's)
  if (!opts.static && !(pack && pack.static instanceof ArrayBuffer) && engine && engine.load && pack && !engine.loaded) await engine.load(pack);
  const stSrc = opts.static || (pack && pack.static) || (engine && engine.loaded && engine.staticChannels ? engine.staticChannels() : null);
  if (!stSrc) throw new Error('runBeam: the static channels are needed (opts.static, pack.static or a loaded engine)');
  const stat = staticBits(stSrc);
  const rc = radarCondition(res.radar, err.radar);
  const tS = clock(), ch = {};
  for (const n of NAMES) if (res[n]) Object.assign(ch, res[n].ch);
  const st = assembleStack(ch, stat, { condition: rc.condition });
  const stackMs = clock() - tS;

  // 4. flags
  const missing = [];
  for (const n of NAMES) {
    if (err[n]) missing.push({ src: n, ch: null, what: n + ' inputs', why: String((err[n] && err[n].message) || err[n]), kind: 'error' });
    else missing.push(...normalizeMissing(n, res[n]));
  }
  if (rc.condition === 'hidden') missing.push({ src: 'radar', ch: null, what: 'radar hidden', why: rc.why, kind: 'fallback' });
  const pendingList = missing.filter((m) => m.kind === 'pending');
  const pending = pendingList.length > 0;
  const retryAt = pending ? new Date(Math.max(...pendingList.map((m) => (m.retryAt ? Date.parse(m.retryAt) : Date.now() + 60e3)))).toISOString() : null;
  const flags = [];
  const glmGap = missing.some((m) => m.src === 'glm' && m.what === 'GLM frame' && m.kind === 'gap');
  const hrrrZero = missing.some((m) => m.src === 'hrrr' && m.kind === 'error') || !!err.hrrr;
  if (rc.condition === 'hidden') flags.push({ kind: 'radar-hidden', text: 'Radar unavailable: BEAM ran from satellite, lightning and HRRR only.' });
  if (res.hrrr && res.hrrr.extra.degraded) flags.push({ kind: 'hrrr-previous', text: 'HRRR: an older model cycle was used.' });
  if (hrrrZero) flags.push({ kind: 'hrrr-missing', text: 'HRRR fields missing: BEAM was never trained on radar without HRRR.' });
  if (glmGap) flags.push({ kind: 'lightning-gap', text: 'Lightning data incomplete: no lightning shown may be missing data.' });
  if (missing.some((m) => m.src === 'abi' && (m.kind === 'gap' || m.kind === 'error'))) flags.push({ kind: 'satellite-gap', text: 'Satellite image missing (filled as in training).' });
  if (missing.some((m) => m.src === 'radar' && m.kind === 'gap')) flags.push({ kind: 'radar-gap', text: 'A radar file was missing (filled as in training).' });
  if (pending) flags.push({ kind: 'pending', text: 'Some inputs are not posted yet.' });
  // degraded: the run used a trained fallback, or has a gap or a failed input. ok: a clean run, exactly the backtest's inputs.
  const degraded = rc.condition === 'hidden' || !!(res.hrrr && res.hrrr.extra.degraded) || missing.some((m) => m.kind === 'gap' || m.kind === 'error' || m.kind === 'fallback');
  const ok = NAMES.every((n) => res[n] && res[n].ok) && rc.condition === 'visible' && !pending && !degraded;

  // 5. the model
  let mean = null, folds = null, members = null, modelMs = 0, modelInfo = null;
  if (engine && (!pending || runPending)) {
    prog({ phase: 'model', text: 'BEAM: running' });
    const tm = clock();
    if (engine.load && pack && !engine.loaded) await engine.load(pack);
    // the stack carries its own 31-39 (the pack's statics, or the hidden condition's coverage and radar_valid)
    const r = await engine.run(st.bits, { statics: 'stack', layout: 'chw', members: !!opts.members });
    modelMs = clock() - tm;
    mean = r.mean || null; folds = r.folds || (r.odd ? { odd: r.odd, even: r.even } : null); members = r.members || null; modelInfo = r.ms || null;
  }
  const maps = mean ? Object.fromEntries(BEAM.outputs.heads.map((h, hi) => [h, [0, 1, 2].map((b) => mean.subarray((4 * b + hi) * N, (4 * b + hi + 1) * N))])) : null;

  // 6. the cache: keep about the last hour (HRRR: its cycles)
  let evicted = null;
  if (opts.evict !== false) { try { evicted = await pool.evict(T0); } catch (e) { evicted = { error: String(e) }; } }
  if (ownPool) pool.close();

  const inputs = {};
  for (const n of NAMES) {
    const r = res[n];
    inputs[n] = r ? { ok: r.ok, ms: perBuilder[n] || r.ms, bytes: r.net.bytes, requests: r.net.requests, builderBytes: r.bytes, urls: r.urls, tries: tries[n],
      missing: (r.missing || []).length, ...r.extra } : { ok: false, error: String((err[n] && err[n].message) || err[n]), tries: tries[n] };
  }
  prog({ phase: 'done', text: ok ? 'BEAM: done' : 'BEAM: done (flagged)' });
  return {
    id: 'beam-' + +T0, model: 'beam', t0: +T0, made, runAt: new Date(made).toISOString(), ageMin: +((made - +T0) / MIN).toFixed(1),
    size: S, km: 3, frame: BEAM.frame, spec: { ...BEAM.outputs, model: 'beam' }, members, precision: 'fp16',
    mean, folds, maps, ok, degraded, pending, retryAt, condition: rc.condition, conditionWhy: rc.why, missing, flags,
    inputs, stack: keepStack ? st.bits : null, stackHash: stackHash(st.bits), absent: st.absent,
    bytes: net.bytes, requests: net.requests,
    ms: { total: Math.round(clock() - tStart), inputs: Math.round(inputsMs), wait: Math.round(waitMs), stack: Math.round(stackMs), model: Math.round(modelMs), modelDetail: modelInfo, perBuilder },
    memory: { pageMB: memNow(), workerMB: workerMB.length ? Math.max(...workerMB) : null },
    cache: { mode: pool.mode, persistent: pool.persistent, fallback: pool.fallback || null, evicted },
  };
}

// ------------------------------------------------------------------------------------------------ the engine
/**
 * A bare BeamNet (js/engine/beam.js: load(weights), run(inputHWC, { folds })) behind the runner's interface. The engine's own
 * createBeamEngine() (js/engine/engine.js) already has that interface: pass it to runBeam directly.
 */
export function beamNetEngine(net, { folds = true } = {}) {
  return {
    get loaded() { return !!net.loaded; },
    async load(pack) { if (!net.loaded) await net.load(pack.weights); },
    async run(bits) { const r = await net.run(toHWC(bits), { folds }); return { mean: r.mean, folds: r.folds || null, ms: r.ms }; },
    free() { if (net.free) net.free(); },
  };
}
