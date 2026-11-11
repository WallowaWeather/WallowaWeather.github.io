// Part of BEAM's phone code (kept identical to BEAM's own build).
// js/runner/inputs_worker.js - a module worker that runs BEAM's input builders off the page's thread (the decoding: MRMS PNG rows,
// HRRR GRIB2 unpacking, HDF5 chunks). It has its own metered fetch (at most `maxFetch` downloads at once) and its own connection to
// the IndexedDB input cache. Messages (all answered { id, result } | { id, error: { message, code } }):
//   { id, op: 'init', maxFetch, cacheName, budgetMB, log }   -> { persistent, openError }
//   { id, op: 'build', name, t0, opts }                       -> runBuilder's result (channel buffers transferred)
//   { id, op: 'abort', of }                                   -> aborts build `of`
//   { id, op: 'flush' | 'stats' | 'clear' } / { id, op: 'evict', t0 } / { id, op: 'meter' }
'use strict';
import { runBuilder, transfers } from './builders.js';
import { meteredFetch } from './net.js';
import { openInputCache, memoryCache } from './cache.js';

let env = null;
const running = new Map();
const mem = () => (globalThis.performance && performance.memory ? { usedMB: +(performance.memory.usedJSHeapSize / 1e6).toFixed(1) } : null);

async function init(m) {
  if (env) { try { env.cache.close(); } catch (e) { /* */ } }
  const cache = m.cache === 'memory' ? memoryCache({ budgetMB: m.budgetMB }) : await openInputCache({ name: m.cacheName, budgetMB: m.budgetMB });
  env = { fetch: meteredFetch(undefined, { max: m.maxFetch || 4, log: !!m.log }), cache };
  return { persistent: !!cache.persistent, openError: cache.openError || null };
}

const OPS = {
  init,
  async build(m) {
    if (!env) await init({});
    const ac = new AbortController(); running.set(m.id, ac);
    try {
      const r = await runBuilder(m.name, m.t0, m.opts || {}, { ...env, signal: ac.signal });
      try { r.flushed = await env.cache.flush(); } catch (e) { r.flushed = 0; }
      r.worker = { heap: mem() };
      return r;
    } finally { running.delete(m.id); }
  },
  async abort(m) { const a = running.get(m.of); if (a) a.abort(); return !!a; },
  async flush() { return env ? env.cache.flush() : 0; },
  async evict(m) { return env ? env.cache.evict(m.t0) : null; },
  async stats() { return env ? { ...(await env.cache.stats()), persistent: env.cache.persistent } : null; },
  async clear() { if (env) await env.cache.clear(); return true; },
  async meter() { if (!env) return null; const { log, byTag, ...rest } = env.fetch.meter; return { ...rest, log: log ? log.splice(0) : null }; },
};

self.onmessage = async (ev) => {
  const m = ev.data || {}, { id, op } = m;
  try {
    const result = await OPS[op](m);
    self.postMessage({ id, result }, op === 'build' ? transfers(result) : []);
  } catch (e) {
    self.postMessage({ id, error: { message: String((e && e.message) || e), code: (e && e.code) || null, name: (e && e.name) || null } });
  }
};
