// nowcast/fields/cache.js - the bytes the forecast maps read, kept on the phone by run + forecast hour + variable (+ the part:
// 'idx', a message's 'head', a 64-row block 'b12'):  hrrr/2026110914/f06/UGRD#b12. A second look at an hour, or a pan inside what was
// read, reads nothing. Eviction: runs older than the two newest go, then the oldest records past the byte budget.
// IndexedDB (database 'ww-fields') on a phone; memory where it is missing or refused (Node, some private modes). Every store failure
// is swallowed: a full or closed store never fails a map.
'use strict';

const DB = 'ww-fields', META = 'meta', DATA = 'data', VERSION = 1, KEEP_RUNS = 2;
const pad = (n) => String(n).padStart(2, '0');
const ymdh = (t) => { const d = new Date(t); return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}${pad(d.getUTCHours())}`; };
export const keyOf = (run, fhr, v, part = '') => `hrrr/${ymdh(run)}/f${pad(fhr)}/${v}${part ? '#' + part : ''}`;
/** the run (ms) a key belongs to, NaN for a foreign key */
export function runOf(key) {
  const m = /^hrrr\/(\d{4})(\d{2})(\d{2})(\d{2})\//.exec(String(key));
  return m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4]) : NaN;
}

function evictPlan(recs, newestRun, budget) {
  const runs = [...new Set(recs.map((r) => r.run).filter(Number.isFinite))].sort((a, b) => b - a);
  const keep = new Set(runs.filter((r) => r <= newestRun).slice(0, KEEP_RUNS).concat(runs.filter((r) => r > newestRun)));
  const gone = recs.filter((r) => Number.isFinite(r.run) && !keep.has(r.run));
  let left = recs.filter((r) => !gone.includes(r)), bytes = left.reduce((s, r) => s + r.size, 0);
  if (bytes > budget) {
    left = left.slice().sort((a, b) => a.at - b.at);
    for (const r of left) { if (bytes <= budget || r === left[left.length - 1]) break; gone.push(r); bytes -= r.size; }
  }
  return { gone, bytes };
}

/** a cache in memory: { get, set, evict(newestRun), stats, clear, hits, misses, persistent: false, budget (bytes) } */
export function memoryCache({ budgetMB = 80 } = {}) {
  const m = new Map(); let tick = 0;
  const c = {
    persistent: false, budget: budgetMB * 1e6, hits: 0, misses: 0,
    async get(key) { const r = m.get(key); if (r) { c.hits++; r.at = ++tick; return r.ab; } c.misses++; return undefined; },
    async set(key, ab) { m.set(key, { key, run: runOf(key), size: ab.byteLength, at: ++tick, ab }); },
    async evict(newestRun) { const p = evictPlan([...m.values()], newestRun, budgetMB * 1e6); for (const r of p.gone) m.delete(r.key); return { removed: p.gone.length, keptBytes: p.bytes }; },
    async stats() { let bytes = 0; for (const r of m.values()) bytes += r.size; return { n: m.size, bytes }; },
    async clear() { m.clear(); },
    close() {},
  };
  return c;
}

/** a cache whose failures are misses (get) or ignored (set / evict) */
export function safeCache(inner) {
  const c = {
    persistent: !!inner.persistent, budget: +inner.budget || 0, hits: 0, misses: 0,
    async get(key) { try { const v = await inner.get(key); if (v) c.hits++; else c.misses++; return v || undefined; } catch (e) { c.misses++; return undefined; } },
    async set(key, ab) { try { await inner.set(key, ab); } catch (e) { /* not kept */ } },
    async evict(run) { try { return inner.evict ? await inner.evict(run) : null; } catch (e) { return null; } },
    async stats() { try { return inner.stats ? await inner.stats() : null; } catch (e) { return null; } },
    async clear() { try { if (inner.clear) await inner.clear(); } catch (e) { /* */ } },
    close() { try { if (inner.close) inner.close(); } catch (e) { /* */ } },
  };
  return c;
}

const req = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
const done = (tx) => new Promise((res, rej) => { tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error); tx.onabort = () => rej(tx.error || new Error('aborted')); });

/** the IndexedDB cache (memory where IndexedDB is missing, will not open, or does not answer within openMs) */
export async function openFieldCache({ name = DB, budgetMB = 80, openMs = 4000 } = {}) {
  const idb = globalThis.indexedDB;
  if (!idb) return safeCache(memoryCache({ budgetMB }));
  let db;
  try {
    db = await new Promise((res, rej) => {
      // v018 review: an open that never answers (seen in WebKit) left every forecast map waiting for good: memory after openMs
      let late = false, r;
      const t = setTimeout(() => { late = true; rej(new Error('IndexedDB did not answer')); }, openMs);
      try { r = idb.open(name, VERSION); } catch (e) { clearTimeout(t); rej(e); return; }
      r.onupgradeneeded = () => { const d = r.result; if (!d.objectStoreNames.contains(META)) d.createObjectStore(META, { keyPath: 'key' }); if (!d.objectStoreNames.contains(DATA)) d.createObjectStore(DATA); };
      r.onsuccess = () => { clearTimeout(t); if (!late) res(r.result); else try { r.result.close(); } catch (e) { /* too late: let it go */ } };
      r.onerror = () => { clearTimeout(t); rej(r.error); };
      r.onblocked = () => setTimeout(() => rej(new Error('IndexedDB blocked')), 3000);
    });
    db.onversionchange = () => { try { db.close(); } catch (e) { /* */ } };
  } catch (e) { return safeCache(memoryCache({ budgetMB })); }
  let tick = Date.now();
  const inner = {
    persistent: true, budget: budgetMB * 1e6,
    async get(key) { return (await req(db.transaction(DATA, 'readonly').objectStore(DATA).get(key))) || undefined; },
    async set(key, ab) {
      const tx = db.transaction([META, DATA], 'readwrite');
      tx.objectStore(META).put({ key, run: runOf(key), size: ab.byteLength, at: ++tick }); tx.objectStore(DATA).put(ab, key);
      await done(tx);
    },
    async evict(newestRun) {
      const recs = (await req(db.transaction(META, 'readonly').objectStore(META).getAll())) || [];
      const p = evictPlan(recs, newestRun, budgetMB * 1e6);
      if (p.gone.length) { const tx = db.transaction([META, DATA], 'readwrite'); for (const r of p.gone) { tx.objectStore(META).delete(r.key); tx.objectStore(DATA).delete(r.key); } await done(tx); }
      return { removed: p.gone.length, keptBytes: p.bytes };
    },
    async stats() { const recs = (await req(db.transaction(META, 'readonly').objectStore(META).getAll())) || []; return { n: recs.length, bytes: recs.reduce((s, r) => s + r.size, 0) }; },
    async clear() { const tx = db.transaction([META, DATA], 'readwrite'); tx.objectStore(META).clear(); tx.objectStore(DATA).clear(); await done(tx); },
    close() { db.close(); },
  };
  return safeCache(inner);
}
