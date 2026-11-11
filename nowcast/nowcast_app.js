// nowcast/nowcast_app.js - Wallowa Weather's Nowcast: its screen (the whole app, inside ww.js's shell) and its queue job ('nowcast':
// one run at a time through the app's one queue, the model loaded for the job and let go after) for DGMR, StormScope and BEAM.
// The model and the radar load only when a run or the screen asks.
import { createNowcastView } from './view.js';
import { createRadar } from './radar.js';
import { runNowcast } from './run.js';
import { saveRun } from './store.js';
import { DGMR } from './model.js';
import { searchPlaces } from '../places/places.js';

/** api (ww.js): { Q(), section (the screen's element), ready(), dl(), download(), sizeOf(), precision(), geo(), position(), toast, diag, home(),
 *  ssReady(), ssDl(), ssSize(), ssDownload(), ssListed(), ssEngine(), beam, area, defaultModel, defaultBasemap, settings } */
export function initNowcast(api) {
  const radar = createRadar({ diag: api.diag });
  let view = null;
  const partial = new Set();   // PILOT: StormScope publishes each frame as it lands; the screen listens here (never through the queue's progress)
  // v057: StormScope's input layers, kept fresh while the screen is up (one cache for the page; it needs the downloaded pack's grid)
  let LAYERS = null, LAYERS_P = null; const layerFns = new Set();
  const ssLayers = () => LAYERS_P || (LAYERS_P = (async () => {
    const eng = await api.ssEngine(), { loadGrid } = await import('./stormscope/prep/index.js'), grid = await eng.grid(loadGrid);
    const { createLayers } = await import('./stormscope/prep/layers.js');
    return (LAYERS = createLayers({ grid, onChange: (st) => { for (const f of layerFns) { try { f(st); } catch (e) { /* */ } } } }));
  })().catch((e) => { LAYERS_P = null; throw e; }));
  // Nov-08: o.due(t0) = the app's "Keep forecasts fresh" cadence (prep/layers.js start); a stop() before the layers load wins
  let layersWant = 0;
  const layersApi = { start: (p, o) => { const my = ++layersWant; ssLayers().then((L) => { if (my === layersWant) L.start(p, o); }, (e) => api.diag('stormscope layers', { message: String((e && e.message) || e).slice(0, 160) })); },
    stop: () => { layersWant++; if (LAYERS) LAYERS.stop(); }, status: () => (LAYERS ? LAYERS.status() : null), onChange: (fn) => { layerFns.add(fn); return () => layerFns.delete(fn); } };
  const viewOf = () => view || (view = createNowcastView({ root: api.section, radar, ready: api.ready, dl: api.dl, sizeOf: api.sizeOf, precision: api.precision,
    download: api.download, run: runJob, inflight, onPartial: (fn) => { partial.add(fn); return () => partial.delete(fn); },
    ssReady: api.ssReady, ssDl: api.ssDl, ssSize: api.ssSize, ssDownload: api.ssDownload, ssListed: api.ssListed, ssLayers: layersApi, geo: api.geo, position: api.position, toast: api.toast, diag: api.diag, home: api.home,
    // Wallowa Weather: its area (forecasts inside it only), its defaults, and place search inside the area (v014: inside any of its counties)
    area: api.area || null, defaultModel: api.defaultModel || null, defaultBasemap: api.defaultBasemap || null, settings: api.settings || null,
    beam: api.beam ? Object.assign({}, api.beam, { run: runBeamJob, cancel: cancelBeam }) : null,   // v009: BEAM live (Wallowa Weather)
    benchStep: runBenchStep,   // BENCH TEST: Settings › Bench test
    searchPlaces: api.area ? (geo, q, n = 5) => searchPlaces(geo, q, 60).filter((e) => api.area.contains(e.lat, e.lon)).slice(0, n) : searchPlaces }));
  /** v014: StormScope's alert area = the box of the county the run's place is in (Wallowa Weather's counties), else the app's area */
  const areaBox = (P) => { const A = api.area; if (!A) return null; const c = A.countyAt ? A.countyAt(P.lat, P.lon) : null; return (c && c.bbox) || A.bbox || null; };
  const live = (j) => j && j.kind === 'nowcast' && !/^(done|failed|cancelled)$/.test(j.status);
  const samePlace = (a, b) => Math.abs(a.lat - b.lat) < 0.02 && Math.abs(a.lon - b.lon) < 0.02 && !!a.wide === !!b.wide && (a.model || 'dgmr') === (b.model || 'dgmr');
  /** a nowcast job not finished yet for this place (or any, without one) */
  const pendingFor = (p) => { const Q = api.Q(); return Q ? Q.list().find((j) => live(j) && j.params.model !== 'beam' && (!p || samePlace(j.params, p))) || null : null; };
  /** v009: one BEAM run through the queue (never beside another model's) -> Promise<{ id, t0, ok, pending }>; the maps come through the
   *  BEAM model's 'result' event (beam_live.js), so the queue never holds them. A BEAM job already queued or running is waited for. */
  async function runBeamJob(onProgress = () => {}) {
    const Q = api.Q(); if (!Q) throw new Error('the queue is not ready');
    const j = Q.list().find((x) => live(x) && x.params.model === 'beam') || await Q.add('nowcast', { purpose: 'view', model: 'beam' }, { title: 'BEAM' });
    onProgress(j.progress || { phase: 'queue', frac: 0, text: 'Waiting its turn…' });
    return new Promise((res, rej) => {
      const offs = [], end = (f) => { for (const o of offs) o(); f(); };
      offs.push(Q.on('progress', (x, p) => { if (x.id === j.id) onProgress(p); }));
      offs.push(Q.on('done', (x) => { if (x.id === j.id) end(() => (x.result && x.result.beam ? res(x.result.beam) : rej(Object.assign(new Error((x.result && x.result.error) || 'BEAM did not run'), { code: (x.result && x.result.code) || null })))); }));
      offs.push(Q.on('failed', (x) => { if (x.id === j.id) end(() => rej(Object.assign(new Error((x.error && x.error.message) || 'failed'), { code: x.error && x.error.code }))); }));
      offs.push(Q.on('cancelled', (x) => { if (x.id === j.id) end(() => rej(Object.assign(new Error('cancelled'), { code: 'ABORTED' }))); }));
      offs.push(Q.on('needs-download', (x) => { if (x.id === j.id) end(() => rej(Object.assign(new Error('Download BEAM first.'), { code: 'NOT_DOWNLOADED' }))); }));
    });
  }
  /** v009: stop a BEAM job (queued or running): the map closed, the page went away */
  function cancelBeam() { const Q = api.Q(); if (!Q) return; for (const x of Q.list()) if (live(x) && x.params.model === 'beam') Q.cancel(x.id).catch(() => {}); }
  /** BENCH TEST (Settings › Bench test, bench.js): one model's bench step as a 'bench' job in the app's one queue, so it never runs beside
   *  a forecast and the other models let go of the GPU first (ww.js's queue, as for a forecast; it is no 'nowcast' job: the screen never
   *  waits on it). step(ctx) gets the queue's ctx (its engine for the model, signal) and returns the row's numbers.
   *  -> Promise<step's result | { stopped } | { notDownloaded } | { error, code }>; o.signal = the bench's Stop */
  async function runBenchStep(model, step, o = {}) {
    const Q = api.Q(); if (!Q) throw new Error('the queue is not ready');
    const j = await Q.add('bench', { purpose: 'bench', model, step }, { title: 'Bench test' });
    return new Promise((res) => {
      const offs = [], sig = o.signal, stop = () => { Q.cancel(j.id).catch(() => {}); };
      const end = (v) => { for (const f of offs) f(); if (sig) sig.removeEventListener('abort', stop); res(v); };
      offs.push(Q.on('done', (x) => { if (x.id === j.id) end(x.result || { error: 'no result' }); }));
      offs.push(Q.on('failed', (x) => { if (x.id === j.id) end({ error: (x.error && x.error.message) || 'failed', code: (x.error && x.error.code) || null, stage: 'load' }); }));
      offs.push(Q.on('cancelled', (x) => { if (x.id === j.id) end({ stopped: true }); }));
      offs.push(Q.on('needs-download', (x) => { if (x.id === j.id) end({ notDownloaded: true }); }));
      if (sig) { if (sig.aborted) stop(); else sig.addEventListener('abort', stop, { once: true }); }
    });
  }

  /** a nowcast through the queue -> Promise<run id>; onProgress({ phase, frac, member, members, tile, tiles }). The same place already
   *  queued or running: that job is waited for, never a second one (a second tap, a page that came back after a fresh page) */
  async function runJob(params, onProgress = () => {}) {
    const Q = api.Q(); if (!Q) throw new Error('the queue is not ready');
    const j = pendingFor(params) || await Q.add('nowcast', Object.assign({ purpose: 'view' }, params), { title: params.label || 'Nowcast' });
    return waitFor(j, onProgress);
  }
  /** the view's place may already have a job going: -> Promise<run id> | null */
  function inflight(onProgress = () => {}) { const j = pendingFor(null); return j ? waitFor(j, onProgress) : null; }
  function waitFor(j, onProgress) {
    const Q = api.Q();
    onProgress(j.progress || { phase: 'queue', frac: 0 });
    return new Promise((res, rej) => {
      const offs = [];
      const end = (f) => { for (const o of offs) o(); f(); };
      offs.push(Q.on('progress', (x, p) => { if (x.id === j.id) onProgress(p); }));
      offs.push(Q.on('done', (x) => { if (x.id === j.id) end(() => (x.result && x.result.runId ? res(x.result.runId) : rej(Object.assign(new Error((x.result && x.result.error) || 'no nowcast'), { code: (x.result && x.result.code) || null })))); }));
      offs.push(Q.on('failed', (x) => { if (x.id === j.id) end(() => rej(Object.assign(new Error((x.error && x.error.message) || 'failed'), { code: x.error && x.error.code }))); }));
      offs.push(Q.on('cancelled', (x) => { if (x.id === j.id) end(() => rej(Object.assign(new Error('cancelled'), { code: 'ABORTED' }))); }));
      offs.push(Q.on('blocked', (x) => { if (x.id === j.id) end(() => rej(Object.assign(new Error((x.error && x.error.message) || 'blocked'), { code: x.error && x.error.code }))); }));
      offs.push(Q.on('needs-download', (x) => { if (x.id === j.id) { Q.cancel(x.id).catch(() => {}); end(() => rej(Object.assign(new Error('Download the nowcast model first.'), { code: 'NOT_DOWNLOADED' }))); } }));
    });
  }
  // ---------------------------------------------------------------------------------------------- the queue's runner
  const runner = {
    async run(ctx) {
      const P = ctx.params;
      if (P.purpose === 'bench' && typeof P.step === 'function') return P.step(ctx);   // BENCH TEST: the step never throws (it says what failed)
      if (P.model === 'beam') {   // v009: BEAM live (beam_live.js); its maps go out through the model's 'result' event
        try {
          const { info } = await ctx.engine.run({ signal: ctx.signal, onProgress: (p) => ctx.progress(p) });
          api.diag('beam done', { t0: new Date(info.t0).toISOString(), ok: info.ok, degraded: info.degraded, pending: info.pending, condition: info.condition,
            flags: info.flags.map((f) => f.kind), mb: +(info.bytes / 1e6).toFixed(2), requests: info.requests, ms: info.ms, cache: info.cache });
          return { beam: { id: info.id, t0: info.t0, ok: info.ok, pending: info.pending, retryAt: info.retryAt } };
        } catch (e) {
          if (e && (e.name === 'AbortError' || e.code === 'ABORTED')) throw e;
          api.diag('beam stopped', { code: (e && e.code) || null, message: String((e && e.message) || e).slice(0, 200) });
          return { error: String((e && e.message) || e).slice(0, 200), code: (e && e.code) || 'ERROR' };
        }
      }
      try {
        const ss = P.model === 'stormscope';   // PILOT: the second model
        const r = ss ? await (await import('./stormscope/run_ss.js')).runStormScope({ engine: ctx.engine, lat: P.lat, lon: P.lon, label: P.label, signal: ctx.signal,
            onProgress: (p) => ctx.progress({ phase: p.phase, frac: p.frac, text: p.text, frame: p.frame, frames: p.frames }),
            onFrame: (res) => { for (const f of partial) { try { f(res); } catch (e) { /* */ } } }, area: areaBox(P), layers: api.ssReady() ? await ssLayers().catch(() => null) : null })
          : await runNowcast({ engine: ctx.engine, radar, lat: P.lat, lon: P.lon, label: P.label, wide: !!P.wide, members: P.members || DGMR.ensemble.members, signal: ctx.signal, onProgress: (p) => ctx.progress(p) });
        await saveRun(r);
        if (r.ss) api.diag('stormscope done', Object.assign({ flags: r.ss.flags.map((f) => f.kind) }, r.ss.timing, { bytes: r.ss.bytes }));
        if (!r.ss) try { const v = JSON.parse(localStorage.getItem('wallowa-weather:view') || '{}'); v.msPerRun = +(r.ms.reduce((a, b) => a + b, 0) / r.ms.length / 1000).toFixed(2); localStorage.setItem('wallowa-weather:view', JSON.stringify(v)); } catch (e) { /* */ }
        api.diag('nowcast done', { precision: r.precision, members: r.members, tiles: r.tiles.length, ms: r.totalMs, perRun: Math.round(r.ms.reduce((a, b) => a + b, 0) / r.ms.length), ageMin: Math.round(r.ageMin) });
        if (view && view.shown) view.showRun(r);   // also after a planned fresh page, when the screen came back without its wait
        return { runId: r.id, t0: r.t0, summary: r.summary ? r.summary.text : '' };
      } catch (e) {
        if (e && (e.name === 'AbortError' || e.code === 'ABORTED')) throw e;
        if (e && (e.code === 'OUT_OF_MEMORY' || e.code === 'GPU_LOST')) throw e;   // the queue's fallback / retry
        api.diag('nowcast stopped', { code: (e && e.code) || null, message: String((e && e.message) || e).slice(0, 160) });
        return { error: String((e && e.message) || e).slice(0, 200), code: (e && e.code) || 'ERROR' };
      }
    },
  };
  return {
    runner,
    benchStep: runBenchStep,   // BENCH TEST (the view's Settings page; tests)
    open: (o) => viewOf().open(o), refresh: () => { if (view) view.refresh(); },
    /** the screen is open: the model stays loaded between its nowcasts (ww.js's queue) */
    get shown() { return !!(view && view.shown); },
    get view() { return viewOf(); },
  };
}
