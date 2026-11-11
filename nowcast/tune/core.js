// nowcast/tune/core.js - Wallowa Weather's speed tune, the parts that need no GPU: medians, the order candidates are timed in, the pick
// rule, one kernel's tune against a measuring interface (measure.js gives the real one, the tests a mock), the run over the models with
// time caps and Stop, this device's key, the saved record and the words the Settings page shows. Pure: node-testable.
'use strict';

export const TUNE_SCHEMA = 1;
export const LS_RECORD = 'wallowa-weather:tune';           // the saved result (one per device and app version)
export const LS_TESTING = 'wallowa-weather:tune:testing';  // what the tune was doing (removed when it finishes: left behind = the page died)
export const LS_SKIP = 'wallowa-weather:tune:skip';        // kernels a tune died in on this device: never tried again here
export const MODEL_NAMES = { beam: 'BEAM', stormscope: 'StormScope', dgmr: 'DGMR' };
/** the rules: a variant is kept only when its total over the kernel's sites is at least minGain faster than the standard kernel's,
 *  measured twice (the screen, then a confirm of the two alone) */
export const RULES = Object.freeze({ minGain: 0.03, warmups: 2, rounds: 5, confirmRounds: 5, targetMs: 4, maxReps: 32, maxSampleMs: 60, slowMs: 400, warmMs: 300 });

const LS = (k, v) => {
  try {
    if (v === undefined) { const s = localStorage.getItem(k); return s == null ? null : JSON.parse(s); }
    if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, JSON.stringify(v));
  } catch (e) { return null; }
  return null;
};
export const lsGet = (k) => LS(k), lsSet = (k, v) => LS(k, v);

export function median(a) {
  const s = a.filter((x) => Number.isFinite(x)).sort((x, y) => x - y), n = s.length;
  if (!n) return NaN;
  return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
}
/** the order of round r: rotated by r, every other round reversed (A B C, C B A ... : heat and clock drift land on every candidate) */
export function roundOrder(ids, r) {
  const n = ids.length; if (!n) return [];
  const rot = ids.map((_, i) => ids[(i + r) % n]);
  return r % 2 ? rot.reverse() : rot;
}
/** totals: { id: ms } (Infinity / NaN = not measured) -> { pick, gain } : the fastest, kept only if it beats the standard by minGain */
export function pickBest(totals, std = 'standard', minGain = RULES.minGain) {
  const t0 = totals[std];
  if (!Number.isFinite(t0) || t0 <= 0) return { pick: std, gain: 0 };
  let best = std, bt = t0;
  for (const [id, t] of Object.entries(totals)) if (Number.isFinite(t) && t > 0 && t < bt) { best = id; bt = t; }
  const gain = 1 - bt / t0;
  return best !== std && gain >= minGain ? { pick: best, gain } : { pick: std, gain: 0 };
}
/** how many back-to-back runs make one timing sample: about targetMs of work, never more than maxSampleMs in one submit */
export function repsFor(oneMs, R = RULES) {
  if (!(oneMs > 0)) return 1;
  return Math.max(1, Math.min(R.maxReps, Math.floor(R.targetMs / oneMs), Math.floor(R.maxSampleMs / oneMs) || 1));
}
const abortErr = () => Object.assign(new Error('stopped'), { name: 'AbortError' });

/**
 * One kernel's tune. api (measure.js, or a mock):
 *   prepare(unit) -> ctx: buffers, inputs, the standard kernel's output (the reference), every candidate compiled
 *                    ctx.ok = { [candId]: true | 'why not' } (compiled), ctx.self = true | 'why' (the standard kernel repeats itself)
 *   gate(ctx, candId) -> true | 'why not'   (every site's output, from a poisoned buffer, equal to the reference: bit-exact)
 *   time(ctx, candId, siteIdx, reps) -> ms per run (one sample)
 *   release(ctx)
 * o: { rules, now(), deadline (ms, by now()), signal, onStep(text) }
 * -> { key, pick, gain, ms: { [candId]: total ms over sites (weighted) }, rejected: { [candId]: why }, partial, note }
 */
export async function tuneUnit(api, unit, o = {}) {
  const R = Object.assign({}, RULES, o.rules), now = o.now || (() => Date.now()), late = () => o.deadline != null && now() > o.deadline;
  const out = { key: unit.key, model: unit.model, label: unit.label, pick: 'standard', gain: 0, ms: {}, rejected: {}, partial: false, note: '', prepMs: 0 };
  const stop = () => { if (o.signal && o.signal.aborted) throw abortErr(); };
  let ctx = null;
  try {
    stop();
    const tp = now(); ctx = await api.prepare(unit); out.prepMs = now() - tp;   // inputs, compiles and the reference
    if (ctx.self !== true) { out.note = 'standard kernel: ' + ctx.self; return out; }
    let cands = [];
    for (const c of unit.cands) {
      if (c.id === 'standard') continue;
      const ok = ctx.ok[c.id];
      if (ok !== true) { out.rejected[c.id] = 'compile: ' + ok; continue; }
      stop();
      const g = await api.gate(ctx, c.id);
      if (g !== true) { out.rejected[c.id] = 'different numbers: ' + g; continue; }
      cands.push(c.id);
    }
    const ids = ['standard', ...cands], S = unit.sites.length;
    // samples: per candidate, per site; reps per site from one warm run of the standard kernel
    if (o.warm) { const until = now() + R.warmMs; do { stop(); await api.time(ctx, 'standard', 0, 1); } while (now() < until); }   // clocks up first
    const reps = [];
    for (let s = 0; s < S; s++) {
      stop();
      await api.time(ctx, 'standard', s, 1);   // the first run of a pipeline can carry its driver's late compile
      const one = await api.time(ctx, 'standard', s, 1);
      if (!(one < R.slowMs)) { out.note = `too slow to tune safely here (${Math.round(one)} ms a run)`; return out; }
      reps.push(repsFor(one, R));
    }
    const samp = Object.fromEntries(ids.map((id) => [id, Array.from({ length: S }, () => [])]));
    const total = (id) => unit.sites.reduce((a, site, s) => a + site.weight * median(samp[id][s]), 0);
    if (!cands.length) {   // nothing to race: the standard kernel's time still counts in the model's estimate (the same both sides)
      for (let q = 0; q < 3; q++) for (let s = 0; s < S; s++) { stop(); samp.standard[s].push(await api.time(ctx, 'standard', s, reps[s])); }
      out.ms.standard = total('standard'); return out;
    }
    for (let w = 0; w < R.warmups; w++) for (const id of roundOrder(ids, w)) for (let s = 0; s < S; s++) { stop(); await api.time(ctx, id, s, reps[s]); }
    let r = 0;
    for (; r < R.rounds; r++) {
      if (late()) { out.partial = true; break; }
      for (const id of roundOrder(ids, r)) for (let s = 0; s < S; s++) { stop(); samp[id][s].push(await api.time(ctx, id, s, reps[s])); }
      if (o.onStep) o.onStep(r + 1, R.rounds);
    }
    if (r < 3) { out.partial = true; out.note = 'not enough time to measure'; return out; }   // fewer than 3 rounds: no pick
    for (const id of ids) out.ms[id] = total(id);
    let { pick, gain } = pickBest(out.ms, 'standard', R.minGain);
    if (pick !== 'standard' && R.confirmRounds > 0 && late()) { out.partial = true; out.note = `no time left to confirm ${pick}`; pick = 'standard'; gain = 0; }   // never kept unconfirmed
    else if (pick !== 'standard' && R.confirmRounds > 0) {   // confirm: the two alone, alternating
      const c = { standard: Array.from({ length: S }, () => []), [pick]: Array.from({ length: S }, () => []) };
      for (let q = 0; q < R.confirmRounds; q++) for (const id of roundOrder(['standard', pick], q)) for (let s = 0; s < S; s++) { stop(); c[id][s].push(await api.time(ctx, id, s, reps[s])); }
      const tot = (id) => unit.sites.reduce((a, site, s) => a + site.weight * median(c[id][s]), 0);
      const g2 = 1 - tot(pick) / tot('standard');
      if (!(g2 >= R.minGain)) { out.note = `${pick} did not hold up in the confirm`; pick = 'standard'; gain = 0; } else gain = Math.min(gain, g2);
    }
    out.pick = pick; out.gain = gain;
    return out;
  } finally { if (ctx) { try { await api.release(ctx); } catch (e) { /* */ } } }
}

/**
 * The tune over the models. plans: [{ model, units: [unit], rest?: (ms by candidate totals) -> extra ms of untimed work (both sides) }]
 * o: { api, budgets: { model: ms }, now(), signal, onProgress({ model, unit, of, label, frac }), skip: Set of 'model:key' }
 * -> { ms, models: { model: { units: [tuneUnit results], before, after, gain, partial, stopped, done, of } }, picks: { model: { key: candId } }, stopped }
 */
export async function runTune(plans, o = {}) {
  const now = o.now || (() => Date.now()), t0 = now(), res = { models: {}, picks: {}, stopped: false, ms: 0 };
  const all = plans.reduce((a, p) => a + p.units.length, 0); let done = 0;
  for (const p of plans) {
    const m = { units: [], before: 0, after: 0, gain: 0, partial: false, stopped: false, done: 0, of: p.units.length, skipped: [] };
    res.models[p.model] = m; res.picks[p.model] = {};
    const deadline = o.budgets && o.budgets[p.model] ? now() + o.budgets[p.model] : null;
    for (const u of p.units) {
      if (res.stopped) break;
      if (deadline != null && now() > deadline) { m.partial = true; break; }
      if (o.skip && o.skip.has(`${p.model}:${u.key}`)) { m.skipped.push(u.key); done++; continue; }
      if (o.onProgress) o.onProgress({ model: p.model, unit: m.done + 1, of: p.units.length, label: u.label, frac: done / Math.max(1, all), ways: u.cands.length });
      try {
        if (o.onUnit) o.onUnit(p.model, u.key);
        const r = await tuneUnit(o.api, u, { rules: o.rules, now, deadline, signal: o.signal, warm: m.done === 0 });
        m.units.push(r); m.done++; done++;
        if (r.partial) m.partial = true;
        if (r.pick !== 'standard') res.picks[p.model][u.key] = r.pick;
      } catch (e) {
        if (e && e.name === 'AbortError') { res.stopped = true; m.stopped = true; break; }
        m.units.push({ key: u.key, pick: 'standard', gain: 0, ms: {}, rejected: {}, note: 'error: ' + String((e && e.message) || e).slice(0, 160) });
        m.done++; done++;
        if (o.fatal && o.fatal(e)) { res.stopped = true; m.stopped = true; break; }
      } finally { if (o.onUnitDone) o.onUnitDone(p.model, u.key); }
    }
    // the estimate: every measured kernel at the standard kernel's time vs its pick's, plus the model's untimed share (the same both sides)
    let b = 0, a = 0;
    for (const r of m.units) {
      const ts = r.ms && r.ms.standard;
      if (!Number.isFinite(ts)) continue;
      b += ts; a += r.pick !== 'standard' ? ts * (1 - r.gain) : ts;   // the pick at its confirmed (smaller) gain
    }
    const rest = p.rest ? p.rest(m.units) : 0;
    m.before = b + rest; m.after = a + rest; m.gain = m.after > 0 && b > 0 ? m.before / m.after - 1 : 0;
    if (res.stopped) break;
  }
  if (o.onProgress) o.onProgress({ frac: 1 });
  res.ms = now() - t0;
  return res;
}

// ------------------------------------------------------------------------------------------------ the device's key + the saved record
/** 'Chrome 141' | 'Safari 26' | 'Edge 141' | 'Firefox 145' | 'other': the browser compiles the kernels, so it is part of the key */
export function browserOf(ua = '') {
  let m;
  if ((m = /Edg(?:e|A|iOS)?\/(\d+)/.exec(ua))) return 'Edge ' + m[1];
  if ((m = /(?:CriOS|Chrome)\/(\d+)/.exec(ua))) return 'Chrome ' + m[1];
  if ((m = /(?:FxiOS|Firefox)\/(\d+)/.exec(ua))) return 'Firefox ' + m[1];
  if ((m = /Version\/(\d+)[.\d]* .*Safari\//.exec(ua))) return 'Safari ' + m[1];
  return 'other';
}
/** FNV-1a, 2 x 32 bits -> 16 hex */
export function hashStr(s) {
  let a = 0x811c9dc5, b = 0x01000193 ^ 0x5bd1e995;
  for (let i = 0; i < s.length; i++) { const c = s.charCodeAt(i); a = Math.imul(a ^ c, 0x01000193) >>> 0; b = Math.imul(b ^ c ^ (i & 0xff), 0x01000193) >>> 0; }
  return a.toString(16).padStart(8, '0') + b.toString(16).padStart(8, '0');
}
const LIMIT_KEYS = ['maxComputeWorkgroupStorageSize', 'maxComputeInvocationsPerWorkgroup', 'maxComputeWorkgroupsPerDimension', 'maxStorageBufferBindingSize', 'maxBufferSize', 'maxStorageBuffersPerShaderStage'];
/** the key a record is valid for: the graphics adapter (vendor, architecture, device, description), its limits, 16-bit shaders, the
 *  browser (family + major) and the app's version. Any change = the standard kernels until the next tune. */
export function deviceKey({ info = {}, features, limits = {}, ua = '', app = '' }) {
  const f = features && typeof features.has === 'function' ? features.has('shader-f16') : Array.isArray(features) ? features.includes('shader-f16') : false;
  const k = { vendor: String(info.vendor || ''), architecture: String(info.architecture || ''), device: String(info.device || ''), description: String(info.description || ''),
    f16: !!f, limits: Object.fromEntries(LIMIT_KEYS.map((n) => [n, Number(limits[n]) || 0])), browser: browserOf(ua), app: String(app || '') };
  k.id = hashStr(JSON.stringify(k));
  return k;
}
/** a saved record -> 'ok' | 'none' | 'app' (made by another version of the app) | 'device' (another graphics chip, browser or limits) */
export function recordState(rec, key) {
  if (!rec || rec.schema !== TUNE_SCHEMA || !rec.key) return 'none';
  if (!key) return 'device';
  if (rec.key.id === key.id) return 'ok';
  const same = (a, b) => JSON.stringify(Object.assign({}, a, { app: '', id: '' })) === JSON.stringify(Object.assign({}, b, { app: '', id: '' }));
  return rec.key.app !== key.app && same(rec.key, key) ? 'app' : 'device';
}
/** the record a run makes. tables: { model: { key: value the engine reads } } (only kernels that changed) */
export function makeRecord({ key, res, tables, at = Date.now() }) {
  const report = {};
  for (const [m, r] of Object.entries(res.models)) report[m] = { gain: +r.gain.toFixed(4), done: r.done, of: r.of, partial: !!(r.partial || r.stopped), changed: Object.keys((tables && tables[m]) || {}).length };
  return { schema: TUNE_SCHEMA, key, at, seconds: Math.round(res.ms / 1000), picks: tables || {}, report };
}

/** a tune left a kernel behind on this device (the page died in it, or the graphics chip reset): that kernel joins the device's skip
 *  list and is never tried here again. -> the skip list ({ id, units: ['model:key'] }); the 'testing' mark is cleared */
export function takeSkips(id) {
  let skip = lsGet(LS_SKIP); if (!skip || skip.id !== id || !Array.isArray(skip.units)) skip = { id, units: [] };
  const left = lsGet(LS_TESTING);
  if (left && left.id === id && left.unit && !skip.units.includes(left.unit)) { skip.units.push(left.unit); lsSet(LS_SKIP, skip); }
  lsSet(LS_TESTING, null);
  return skip;
}
export function addSkip(skip, unit) { if (unit && !skip.units.includes(unit)) { skip.units.push(unit); lsSet(LS_SKIP, skip); } }

// ------------------------------------------------------------------------------------------------ words
/** "about 12% faster" for a gain of 0.12; under 2% = no claim */
export function gainWords(gain) { const p = Math.round(gain * 100); return p >= 2 ? `about ${p}% faster` : ''; }
/** the result in sentences (Settings). res = runTune's; skipped: { model: 'why not tuned' } */
export function resultLines(res, skipped = {}, place = 'this phone') {
  const lines = [`Done in ${Math.max(1, Math.round(res.ms / 1000))} s.`];
  let any = false, measured = 0;
  for (const [m, r] of Object.entries(res.models)) {
    const name = MODEL_NAMES[m] || m, w = gainWords(r.gain), part = r.stopped || r.partial ? ` (tuned in part: ${r.done} of ${r.of} kernels)` : '';
    if (!r.done) { lines.push(`${name}: ${r.stopped ? 'stopped before it was tuned' : 'not tuned (out of time)'}.`); continue; }
    measured++;
    if (w) { any = true; lines.push(`${name} is ${w} on ${place}${part}.`); }
    else lines.push(`${name}: the standard kernels are already the fastest here${part}.`);
  }
  for (const [m, why] of Object.entries(skipped)) lines.push(`${MODEL_NAMES[m] || m}: ${why}.`);
  if (measured && !any) lines.push(`Nothing beat the standard kernels on ${place}, so they stay.`);
  return lines;
}
