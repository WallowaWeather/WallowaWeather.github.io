// nowcast/tune/tune.js - Wallowa Weather's speed tune (Settings > Speed tune), the side the rest of the app sees:
//   tunedPicks(model)  what an engine asks as it loads: this device's tuned table for its kernels, or null (the standard kernels). A table
//                      counts only on the device, browser and app version it was measured on (any change: the standard kernels again).
//   runSpeedTune(...)  the tune itself, for the models on this phone (Settings starts it; the measuring is measure.js, loaded then)
//   resetTune()        back to the standard kernels;  tuneState()  what Settings says about the saved table
// Nothing is downloaded and nothing leaves the phone: the record stays in this site's own storage (localStorage).
'use strict';
import { LS_RECORD, LS_TESTING, MODEL_NAMES, deviceKey, recordState, makeRecord, runTune, resultLines, lsGet, lsSet, takeSkips, addSkip } from './core.js';
import { cleanTable } from './variants.js';

let APP = '';
const KEYS = new Map();
/** the app's version (ww.js VERSION): part of the key, so an update starts from the standard kernels until the next tune */
export function setTuneApp(version) { const v = String(version || ''); if (v !== APP) { APP = v; KEYS.clear(); } }
export const tuneApp = () => APP;

/** this device's key for an adapter of that power preference (asked once a page) */
export function currentKey(powerPreference = 'high-performance') {
  if (!KEYS.has(powerPreference)) KEYS.set(powerPreference, (async () => {
    if (!globalThis.navigator || !navigator.gpu) return null;
    const ad = await navigator.gpu.requestAdapter({ powerPreference });
    return ad ? deviceKey({ info: ad.info || {}, features: ad.features, limits: ad.limits, ua: navigator.userAgent || '', app: APP }) : null;
  })().catch(() => null));
  return KEYS.get(powerPreference);
}
export const readRecord = () => lsGet(LS_RECORD);
/** -> { state: 'ok' | 'none' | 'app' | 'device', rec } */
export async function tuneState(powerPreference = 'high-performance') {
  const rec = readRecord();
  if (!rec) return { state: 'none', rec: null };
  return { state: recordState(rec, APP ? await currentKey(powerPreference) : null), rec };
}

/** an engine at load: model 'stormscope' | 'dgmr' | 'beam' -> its table ({ kernel key: tile }) or null. Never throws. */
export async function tunedPicks(model, { powerPreference = 'high-performance' } = {}) {
  try {
    if (!APP) return null;
    const rec = readRecord();
    if (!rec || !rec.picks || !rec.picks[model] || !Object.keys(rec.picks[model]).length) return null;
    if (recordState(rec, await currentKey(powerPreference)) !== 'ok') return null;
    const layers = model === 'beam' ? (await import('../beam/engine/beam.js')).LAYERS : null;
    const t = cleanTable(model, rec.picks[model], { layers });
    return Object.keys(t).length ? t : null;
  } catch (e) { return null; }
}
/** back to the standard kernels (a model already loaded keeps its kernels until it loads again: Settings unloads them) */
export function resetTune() { lsSet(LS_RECORD, null); }

/** the tables the engines read, from the candidates picked */
export function tablesFrom(plans, res) {
  const out = {};
  for (const p of plans) {
    const t = {};
    for (const [key, id] of Object.entries((res.picks && res.picks[p.model]) || {})) {
      const u = p.units.find((x) => x.key === key), c = u && u.cands.find((x) => x.id === id);
      if (c && c.tile) t[key] = Array.isArray(c.tile) ? c.tile.slice() : Object.assign({}, c.tile);
    }
    if (Object.keys(t).length) out[p.model] = t;
  }
  return out;
}

/** the caps a phone keeps to (ms a model; candidates a kernel): about a minute for all three */
export const BUDGETS = Object.freeze({ beam: 20000, stormscope: 25000, dgmr: 30000 });

/**
 * The tune. models: { beam: bool, stormscope: bool, dgmr: DGMR's float model JSON | null }; skipped: { model: why } (said in the result).
 * onProgress({ model, unit, of, label, frac, ways }); signal (Stop: the kernels already done are kept).
 * -> { lines: [sentences], res, rec (saved, or null when nothing was measured), skipped }
 */
export async function runSpeedTune({ models = {}, skipped = {}, onProgress, signal, powerPreference = 'high-performance', budgets = BUDGETS, caps = {}, rules } = {}) {
  if (!APP) throw new Error('the speed tune needs the app version (setTuneApp)');
  const M = await import('./measure.js');
  const t = await M.openTuneDevice({ powerPreference });
  try {
    const key = deviceKey({ info: t.info, features: t.adapter.features, limits: t.adapter.limits, ua: navigator.userAgent || '', app: APP });
    // a tune that died in a kernel on this device (the page was killed, or the graphics chip reset) never tries that kernel again here
    const skip = takeSkips(key.id);
    const { plans, ssMode, skipped: sk } = await M.planFor(t, models, { caps });
    const api = M.makeApi(t, { ssMode });
    let cur = null;
    const res = await runTune(plans, { api, budgets, signal, onProgress, rules, skip: new Set(skip.units),
      onUnit: (m, k) => { cur = `${m}:${k}`; lsSet(LS_TESTING, { id: key.id, unit: cur, t: Date.now() }); },
      onUnitDone: () => { lsSet(LS_TESTING, null); cur = null; },
      fatal: (e) => { if (!(e && e.code === 'GPU_LOST')) return false; addSkip(skip, cur); return true; } });
    const tables = tablesFrom(plans, res);
    const measured = Object.values(res.models).some((m) => m.done > 0);
    const rec = measured ? makeRecord({ key, res, tables }) : null;
    if (rec) lsSet(LS_RECORD, rec);
    const why = Object.assign({}, skipped, sk);
    return { lines: resultLines(res, why), res, rec, skipped: why, gpu: [t.info.vendor, t.info.architecture, t.info.description].filter(Boolean).join(' ') };
  } finally { try { t.device.destroy(); } catch (e) { /* */ } }
}
export { MODEL_NAMES };
