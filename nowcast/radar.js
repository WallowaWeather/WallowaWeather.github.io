// nowcast/radar.js - the radar frames the Nowcast view and its runs use, from NOAA MRMS (mrms.js): which exist, a small cache of the
// downloaded files for this page (a run reuses the loop's), decoding in one module worker (radar_worker.js) that ends when idle.
// No official NOAA service gives raw rain-rate values for a box (the NOAA map services serve coloured pictures or hourly totals), so a
// frame is the whole CONUS file (about 1.1 MB, + 0.25 MB for rain or snow) and the place's part is cut out on the phone.
import { listFrames, fetchFrame, inputFrames, pickT0, loopFrames, MIN } from './mrms.js';

const CACHE_FILES = 16;
export function createRadar({ fetchFn = (...a) => fetch(...a), workerUrl = new URL('./radar_worker.js', import.meta.url), idleMs = 30e3, diag = () => {} } = {}) {
  const files = new Map();   // `${p}:${t}` -> Promise<Uint8Array>
  const lists = new Map();   // p -> { at, since, frames }
  let w = null, wid = 0, idleT = 0; const pend = new Map();
  let ctl = new AbortController();   // every download this radar starts; abort() stops them (the page leaves, the screen closes)
  const worker = () => {
    clearTimeout(idleT);
    if (!w) {
      w = new Worker(workerUrl, { type: 'module' });
      w.onmessage = (ev) => { const p = pend.get(ev.data.id); if (!p) return; pend.delete(ev.data.id); if (ev.data.error) p.rej(Object.assign(new Error(ev.data.error.message), { code: ev.data.error.code || 'BAD_RADAR' })); else p.res(ev.data.result); idle(); };
      w.onerror = (e) => { for (const p of pend.values()) p.rej(new Error('the radar decoder stopped: ' + (e.message || e))); pend.clear(); try { w.terminate(); } catch (x) { /* */ } w = null; };
    }
    return w;
  };
  const idle = () => { clearTimeout(idleT); if (!pend.size) idleT = setTimeout(() => { if (w && !pend.size) { w.terminate(); w = null; } }, idleMs); };
  const call = (msg) => new Promise((res, rej) => { const id = ++wid; pend.set(id, { res, rej }); worker().postMessage(Object.assign({ id }, msg)); });

  async function list(p, now, minutes, { fresh = false, signal } = {}) {
    const c = lists.get(p), since = now - minutes * MIN;
    if (c && !fresh && now - c.at < 60e3 && c.since <= since) return c.frames.filter((f) => f.t >= since);
    const frames = await listFrames(p, since, now + 5 * MIN, { fetchFn, signal });
    lists.set(p, { at: now, since, frames }); return frames;
  }
  function file(p, t, { signal } = {}) {
    const k = `${p}:${t}`;
    if (!files.has(k)) {
      const pr = fetchFrame(p, t, { fetchFn, signal: signal || ctl.signal }); files.set(k, pr); pr.catch(() => files.delete(k));
      while (files.size > CACHE_FILES) files.delete(files.keys().next().value);
    }
    return files.get(k);
  }
  return {
    /** the newest frames: { rate: [{t, size}], flag: [...] } over the last `minutes` */
    async available(now = Date.now(), minutes = 100, o = {}) {
      const [rate, flag, rqi] = await Promise.all([list('rate', now, minutes, o), list('flag', now, minutes, o).catch(() => []), list('rqi', now, 30, o).catch(() => [])]);
      return { rate, flag, rqi, newest: rate.length ? rate[rate.length - 1].t : null };
    },
    /** the radar loop's frames (every `step` minutes back from the newest, `minutes` long) and their download size */
    loopPlan(av, { minutes = 60, step = 10, typed = true } = {}) {
      const ts = loopFrames(av.rate.map((f) => f.t), { minutes, step }), fs = new Map(av.flag.map((f) => [f.t, f]));
      const q = av.rqi && av.rqi.length ? av.rqi[av.rqi.length - 1] : null;   // the newest radar quality, one file for the whole loop
      const bytes = ts.reduce((s, t) => s + ((av.rate.find((f) => f.t === t) || {}).size || 0) + (typed && fs.has(t) ? fs.get(t).size : 0), 0) + (q ? q.size : 0);
      return { times: ts, bytes, typed: typed && ts.some((t) => fs.has(t)), rqi: q ? q.t : null };
    },
    /** one loop frame decoded: { t, conus, cw, ch, step, crop, cropBox, meta, typed } */
    async frame(t, { typed = true, flags = null, crop = null, step = 4, rqi = null, signal } = {}) {
      const rate = await file('rate', t, { signal });
      let flag = null; if (typed && (!flags || flags.some((f) => f.t === t))) { try { flag = await file('flag', t, { signal }); } catch (e) { flag = null; } }
      let q = null; if (rqi && crop) { try { q = await file('rqi', rqi, { signal }); } catch (e) { q = null; } }
      const r = await call({ op: 'frame', rate: rate.slice(), flag: flag ? flag.slice() : null, rqi: q ? q.slice() : null, step, crop });
      return Object.assign(r, { t });
    },
    /** a model's inputs for each point (each box centred on its point): the newest complete set of frames, at most maxAgeMin old ->
     *  { t0, ageMin, inputs: [Int16Array], snow: [share of rain flagged snow], bytes } ; throws STALE / RADAR_MISSING */
    async inputsFor(points, spec, { now = Date.now(), maxAgeMin = 15, signal, onStep } = {}) {
      const av = await this.available(now, 40, { fresh: true, signal });
      const pick = pickT0(av.rate.map((f) => f.t), spec.inputs.offsetsMin, now, { maxAgeMin });
      if (pick.none) throw Object.assign(new Error('NOAA has no radar frames for the last 40 minutes.'), { code: 'RADAR_MISSING' });
      if (pick.stale) throw Object.assign(new Error(`The newest complete radar is ${Math.round(pick.ageMin)} minutes old.`), { code: 'STALE', ageMin: pick.ageMin, newest: pick.newest });
      const ts = [...new Set(pick.frames.flat())].sort((a, b) => a - b), boxes = new Map(), snow = points.map(() => 0);
      let bytes = 0;
      for (let k = 0; k < ts.length; k++) {
        const t = ts[k]; bytes += (av.rate.find((f) => f.t === t) || {}).size || 0;
        if (onStep) onStep({ step: k, steps: ts.length, t });
        const typed = t === pick.t0;   // rain or snow: from the newest frame (for the note)
        const r = await call({ op: 'frame', rate: (await file('rate', t, { signal })).slice(), flag: typed ? await file('flag', t, { signal }).then((x) => x.slice(), () => null) : null,
          step: 8, crop: null, boxes: points.map((p) => ({ lat: p.lat, lon: p.lon })) });
        boxes.set(t, r.boxes); if (typed) r.snow.forEach((s, i) => { snow[i] = s; });
      }
      const per = points.map((_, i) => pick.frames.map((list) => list.map((t) => boxes.get(t)[i])));
      const r = await call({ op: 'inputs', boxes: per });   // the clearest isolated speckle set to its surroundings (qc.js) before the model sees it
      return { t0: pick.t0, ageMin: pick.ageMin, inputs: r.inputs, qc: r.qc, snow, bytes };
    },
    /** stop every download in flight (they fail as AbortError, which callers do not report) */
    abort() { ctl.abort(); ctl = new AbortController(); files.clear(); },
    drop() { files.clear(); lists.clear(); if (w) { w.terminate(); w = null; } },
  };
}
export { inputFrames };
