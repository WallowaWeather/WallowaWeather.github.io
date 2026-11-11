// nowcast/store.js - the last few nowcasts, on this phone only (IndexedDB), so the view can show a run again after a reload. A run is a
// few MB (the ensemble's mean and chances); the 3 newest are kept.

const KEEP = 3;
// the database keeps its older name: test installs already hold their runs there
const DB_NAME = 'wallowa-weather-nowcast';

/** IndexedDB 'runs' (keyPath 'id'), every write resolved on tx.oncomplete; if IndexedDB cannot open (private mode, blocked), a store in
 *  memory for this page */
async function openRuns() {
  let db = null;
  try {
    db = await new Promise((res, rej) => {
      const r = indexedDB.open(DB_NAME, 1);
      r.onupgradeneeded = () => { const d = r.result; if (!d.objectStoreNames.contains('runs')) d.createObjectStore('runs', { keyPath: 'id' }); };
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
      r.onblocked = () => setTimeout(() => rej(new Error('IndexedDB blocked by another tab')), 6000);
    });
    db.onversionchange = () => { db.close(); };
  } catch (e) { db = null; }
  if (!db) {
    const m = new Map(), clone = (v) => (v && typeof v === 'object' && !(v instanceof Blob) ? structuredClone(v) : v);
    return { get: async (s, key) => clone(m.get(key)), all: async () => [...m.values()].map(clone), put: async (s, v) => { m.set(v.id, clone(v)); }, del: async (s, key) => { m.delete(key); } };
  }
  const run = (names, mode, fn) => new Promise((res, rej) => {
    const t = db.transaction(names, mode), box = {};
    t.oncomplete = () => res(box.v);
    t.onerror = () => rej(t.error);
    t.onabort = () => rej(t.error || new DOMException('Transaction aborted', 'AbortError'));
    fn(t, box);
  });
  const req = (r, box) => { r.onsuccess = () => { box.v = r.result; }; };
  return {
    get: (s, key) => run([s], 'readonly', (t, b) => req(t.objectStore(s).get(key), b)),
    all: (s) => run([s], 'readonly', (t, b) => req(t.objectStore(s).getAll(), b)),
    put: (s, v) => run([s], 'readwrite', (t) => { t.objectStore(s).put(v); }),
    del: (s, key) => run([s], 'readwrite', (t) => { t.objectStore(s).delete(key); }),
  };
}
let dbP = null;
const db = () => dbP || (dbP = openRuns());
const mem = new Map();
export async function saveRun(r) {
  mem.set(r.id, r); while (mem.size > 2) mem.delete(mem.keys().next().value);
  try {
    const d = await db(); await d.put('runs', r);
    const all = (await d.all('runs')).sort((a, b) => b.made - a.made);
    for (const x of all.slice(KEEP)) await d.del('runs', x.id);
  } catch (e) { /* storage full or private: this page keeps it */ }
}
export async function getRun(id) {
  if (mem.has(id)) return mem.get(id);
  try { const r = await (await db()).get('runs', id); if (r) mem.set(id, r); return r || null; } catch (e) { return null; }
}
/** the newest run that covers a point and is still current (its radar at most maxAgeMin old) */
export async function recentRun(lat, lon, { maxAgeMin = 25, now = Date.now(), covers } = {}) {
  let all = [...mem.values()];
  try { all = all.concat(await (await db()).all('runs')); } catch (e) { /* */ }
  all.sort((a, b) => b.made - a.made);
  return all.find((r) => now - r.t0 <= maxAgeMin * 60e3 && (!covers || covers(r, lat, lon))) || null;
}
