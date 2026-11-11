// Part of BEAM's phone code (kept identical to BEAM's own build).
// js/runner/cache.js - the input cache behind the builders' { get(key), set(key, ArrayBuffer) }: IndexedDB on a phone (database
// 'beam-inputs'), memory where IndexedDB is missing or refused (Node, some private modes). Writes are kept in memory
// and written in one transaction by flush() (the runner flushes after each build); reads see them at once.
//
// Keys are the builders' own: an object's URL (MRMS raw files, HRRR .idx), URL + '#bytes=a-b' (HRRR range reads), URL + '#tag'
// (derived per-file products: GLM flashes, ABI band-13 frame), 'beam-radar/v1/<kind>/<mode>/<url>' (the radar frame's integers),
// list URL + '#tag' (GOES listings). Each record says what it is, so other models can find data here:
//   { key, kind: 'mrms' | 'radar' | 'glm' | 'abi' | 'hrrr' | 'other', product, t (the data's time, ms UTC), size, at (stored, ms), ab }
// IndexedDB holds two stores: 'meta' (the record without its bytes, keyPath 'key', indexes 'kind' and 't') and 'data' (key -> the
// ArrayBuffer), so listing and eviction never read the bytes.
// The raw MRMS files are stored under the same URL the app's StormScope reads them by (s3.js objectUrl), as the bucket sent them
// (gzip), with kind 'mrms' and product e.g. 'MergedReflectivityQCComposite_00.50': StormScope can look them up (index 'kind') and
// reuse the composite reflectivity instead of downloading it again.
//
// Eviction (evict(t0)): records whose data time is older than t0 minus the kind's keep time (radar 70 min, GLM 40 min, ABI 60 min,
// HRRR 7 h: the environment cycle can be 5 h old and one older cycle is the fallback), then the oldest until under the byte budget.
'use strict';

const MIN = 60e3, HOUR = 36e5;
export const KEEP_MIN = { mrms: 70, radar: 70, glm: 40, abi: 60, hrrr: 420, other: 120 };
const DB = 'beam-inputs', META = 'meta', DATA = 'data', VERSION = 1;

const yjhms = (Y, J, H = 0, M = 0, S = 0) => Date.UTC(+Y, 0, 1) + (+J - 1) * 864e5 + +H * HOUR + +M * MIN + +S * 1e3;
const ymdhms = (d, t = '000000') => Date.UTC(+d.slice(0, 4), +d.slice(4, 6) - 1, +d.slice(6, 8), +t.slice(0, 2), +t.slice(2, 4), +t.slice(4, 6));

/** key -> { kind, product, t } (t = NaN when the key carries no time) */
export function describeKey(key) {
  const k = String(key);
  let dk; try { dk = decodeURIComponent(k); } catch (e) { dk = k; }
  let m;
  if ((m = /MRMS_([A-Za-z0-9_.]+?)_(\d{8})-(\d{6})\.grib2\.gz/.exec(dk))) return { kind: k.startsWith('beam-radar/') ? 'radar' : 'mrms', product: m[1], t: ymdhms(m[2], m[3]) };
  if ((m = /hrrr\.(\d{8})\/conus\/hrrr\.t(\d{2})z\.wrf(\w+?)f(\d{2})\.grib2/.exec(dk))) return { kind: 'hrrr', product: `wrf${m[3]}f${m[4]}`, t: ymdhms(m[1], m[2] + '0000') };
  const goes = /(GLM-L2-LCFA|ABI-L2-CMIPC)/.exec(dk);
  if (goes) {
    const kind = goes[1].startsWith('GLM') ? 'glm' : 'abi';
    if ((m = /_s(\d{4})(\d{3})(\d{2})(\d{2})(\d{2})/.exec(dk))) return { kind, product: goes[1], t: yjhms(m[1], m[2], m[3], m[4], m[5]) };
    if ((m = /prefix=[A-Z0-9-]+\/(\d{4})\/(\d{3})\/(\d{2})\/(?:OR_GLM-L2-LCFA_G1\d_s\d{9}(\d))?/.exec(dk))) return { kind, product: goes[1] + ' list', t: yjhms(m[1], m[2], m[3], m[4] ? +m[4] * 10 : 0) };
    return { kind, product: goes[1], t: NaN };
  }
  return { kind: 'other', product: '', t: NaN };
}

/** a memory store with the same interface (and the same eviction) */
export function memoryCache({ budgetMB = 120 } = {}) {
  const m = new Map();
  const c = {
    persistent: false, kindOf: describeKey,
    async get(key) { const r = m.get(key); return r ? r.ab : undefined; },
    async set(key, ab) { const d = describeKey(key); m.set(key, { key, kind: d.kind, product: d.product, t: Number.isFinite(d.t) ? d.t : Date.now(), size: ab.byteLength, at: Date.now(), ab }); },
    async flush() { return 0; },
    async evict(t0, keep = KEEP_MIN) { return evictRecords([...m.values()], t0, keep, budgetMB, async (keys) => { for (const k of keys) m.delete(k); }); },
    async stats() { return statsOf([...m.values()]); },
    async records() { return [...m.values()].map(({ ab, ...r }) => r); },
    async find(kind, product = null) { return (await c.records()).filter((r) => r.kind === kind && (!product || r.product === product)).sort((x, y) => y.t - x.t); },
    async clear() { m.clear(); },
    close() {},
  };
  return c;
}

function statsOf(recs) {
  const byKind = {}; let bytes = 0;
  for (const r of recs) { const x = (byKind[r.kind] ||= { n: 0, bytes: 0 }); x.n++; x.bytes += r.size; bytes += r.size; }
  return { n: recs.length, bytes, byKind };
}
async function evictRecords(recs, t0, keep, budgetMB, del) {
  const T = +t0, gone = [];
  for (const r of recs) {
    const t = Number.isFinite(r.t) ? r.t : r.at, lim = (keep[r.kind] ?? keep.other) * MIN;
    if (t < T - lim) gone.push(r);
  }
  const left = recs.filter((r) => !gone.includes(r));
  let bytes = left.reduce((s, r) => s + r.size, 0);
  if (bytes > budgetMB * 1e6) {
    left.sort((a, b) => (Number.isFinite(a.t) ? a.t : a.at) - (Number.isFinite(b.t) ? b.t : b.at));
    for (const r of left) { if (bytes <= budgetMB * 1e6) break; gone.push(r); bytes -= r.size; }
  }
  if (gone.length) await del(gone.map((r) => r.key));
  return { removed: gone.length, removedBytes: gone.reduce((s, r) => s + r.size, 0), keptBytes: bytes };
}

const req = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
const done = (tx) => new Promise((res, rej) => { tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error); tx.onabort = () => rej(tx.error || new Error('transaction aborted')); });

/**
 * openInputCache({ name, budgetMB }) -> the IndexedDB cache, or a memory cache when IndexedDB is not there or will not open
 * (cache.persistent says which). Every failure inside get / set / flush is swallowed: a full or closed store never fails a build.
 */
export async function openInputCache({ name = DB, budgetMB = 120 } = {}) {
  const idb = globalThis.indexedDB;
  if (!idb) return memoryCache({ budgetMB });
  let db;
  try {
    db = await new Promise((res, rej) => {
      const r = idb.open(name, VERSION);
      r.onupgradeneeded = () => {
        const d = r.result;
        if (!d.objectStoreNames.contains(META)) { const os = d.createObjectStore(META, { keyPath: 'key' }); os.createIndex('kind', 'kind'); os.createIndex('t', 't'); }
        if (!d.objectStoreNames.contains(DATA)) d.createObjectStore(DATA);
      };
      r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
      r.onblocked = () => setTimeout(() => rej(new Error('IndexedDB blocked')), 4000);
    });
    db.onversionchange = () => { try { db.close(); } catch (e) { /* */ } };
  } catch (e) { const m = memoryCache({ budgetMB }); m.openError = String((e && e.message) || e); return m; }
  const pending = new Map();
  let flushing = null;
  const del = async (keys) => { const tx = db.transaction([META, DATA], 'readwrite'), a = tx.objectStore(META), b = tx.objectStore(DATA); for (const k of keys) { a.delete(k); b.delete(k); } await done(tx); };
  const c = {
    persistent: true, name, kindOf: describeKey, errors: 0,
    async get(key) {
      const p = pending.get(key); if (p) return p.ab;
      try { const ab = await req(db.transaction(DATA, 'readonly').objectStore(DATA).get(key)); return ab || undefined; } catch (e) { c.errors++; return undefined; }
    },
    async set(key, ab) {
      const d = describeKey(key);
      pending.set(key, { key, kind: d.kind, product: d.product, t: Number.isFinite(d.t) ? d.t : Date.now(), size: ab.byteLength, at: Date.now(), ab });
    },
    /** write what set() kept, in one transaction -> the number of records written */
    async flush() {
      while (flushing) await flushing;
      if (!pending.size) return 0;
      const recs = [...pending.values()];
      flushing = (async () => {
        try {
          const tx = db.transaction([META, DATA], 'readwrite'), a = tx.objectStore(META), b = tx.objectStore(DATA);
          for (const r of recs) { const { ab, ...m } = r; a.put(m); b.put(ab, r.key); }
          await done(tx);
        } catch (e) { c.errors++; c.lastError = String((e && e.message) || e); }
        for (const r of recs) if (pending.get(r.key) === r) pending.delete(r.key);
      })();
      await flushing; flushing = null;
      return recs.length;
    },
    /** drop old data (see the header) */
    async evict(t0, keep = KEEP_MIN) {
      try { await c.flush(); return await evictRecords(await c.records(), t0, keep, budgetMB, del); }
      catch (e) { c.errors++; return { removed: 0, error: String((e && e.message) || e) }; }
    },
    /** every record without its bytes */
    async records() { return (await req(db.transaction(META, 'readonly').objectStore(META).getAll())) || []; },
    async stats() { try { return statsOf(await c.records()); } catch (e) { return { n: 0, bytes: 0, error: String(e) }; } },
    /** the cached records of one kind (e.g. 'mrms') and optional product, newest first, without their bytes */
    async find(kind, product = null) { return (await c.records()).filter((r) => r.kind === kind && (!product || r.product === product)).sort((x, y) => y.t - x.t); },
    async clear() { pending.clear(); try { const tx = db.transaction([META, DATA], 'readwrite'); tx.objectStore(META).clear(); tx.objectStore(DATA).clear(); await done(tx); } catch (e) { c.errors++; } },
    close() { try { db.close(); } catch (e) { /* */ } },
  };
  return c;
}
