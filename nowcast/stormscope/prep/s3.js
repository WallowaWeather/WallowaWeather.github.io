// prep_js/s3.js - anonymous reads of NOAA's public S3 buckets (CORS *: list, GET, Range GET) with per-source byte accounting.
// Only the buckets' own addresses are requested; nothing about the person or the place is sent. Pure ES module.
export const bucketUrl = (bucket) => `https://${bucket}.s3.amazonaws.com/`;

/** a run context: { fetchFn, signal, stats: {source: {bytes, requests, files}}, onProgress } */
export function makeCtx({ fetchFn = (u, o) => fetch(u, o), signal, onProgress } = {}) {
  const stats = {};
  const ctx = {
    signal, onProgress,
    stat(source) { return (stats[source] ||= { bytes: 0, requests: 0, files: 0 }); },
    stats,
    /** fetch accounted to `source` */
    async fetch(source, url, opts = {}) {
      const st = ctx.stat(source); st.requests++;
      const r = await fetchFn(url, { ...opts, signal });
      return r;
    },
    count(source, n) { ctx.stat(source).bytes += n; },
    progress(source, frac) { if (onProgress) try { onProgress({ source, frac, bytes: ctx.stat(source).bytes }); } catch (e) { /* the caller's problem */ } },
  };
  return ctx;
}

/** ListObjectsV2 with pagination -> [{ key, size }] in key order. Stops early once a key > stopAfter (lexicographic) or after `limit` keys. */
export async function s3List(ctx, source, bucket, prefix, { startAfter = '', maxKeys = 1000, stopAfter = null, limit = Infinity } = {}) {
  const out = []; let token = null;
  for (;;) {
    let u = `${bucketUrl(bucket)}?list-type=2&prefix=${encodeURIComponent(prefix)}&max-keys=${maxKeys}`;
    if (token) u += `&continuation-token=${encodeURIComponent(token)}`; else if (startAfter) u += `&start-after=${encodeURIComponent(startAfter)}`;
    const r = await ctx.fetch(source, u, { cache: 'no-store' });
    if (!r.ok) throw Object.assign(new Error(`${bucket} list answered ${r.status}`), { code: 'S3_LIST_' + r.status });
    const xml = await r.text(); ctx.count(source, xml.length);
    const re = /<Contents>([\s\S]*?)<\/Contents>/g; let m, stop = false;
    while ((m = re.exec(xml))) {
      const k = /<Key>([^<]+)<\/Key>/.exec(m[1]), z = /<Size>(\d+)<\/Size>/.exec(m[1]);
      if (!k) continue;
      const key = k[1].replace(/&amp;/g, '&');
      if (stopAfter != null && key > stopAfter) { stop = true; break; }
      out.push({ key, size: z ? +z[1] : 0 });
      if (out.length >= limit) { stop = true; break; }
    }
    const tr = /<IsTruncated>true<\/IsTruncated>/.test(xml), nt = /<NextContinuationToken>([^<]+)<\/NextContinuationToken>/.exec(xml);
    if (stop || !tr || !nt) break;
    token = nt[1];
  }
  return out;
}

/** GET a whole object -> Uint8Array (accounted) */
export async function s3Get(ctx, source, bucket, key) {
  const r = await ctx.fetch(source, bucketUrl(bucket) + key.split('/').map(encodeURIComponent).join('/'));
  if (!r.ok) throw Object.assign(new Error(`${bucket}/${key} answered ${r.status}`), { code: r.status === 404 ? 'S3_MISSING' : 'S3_HTTP_' + r.status });
  const u = new Uint8Array(await r.arrayBuffer()); ctx.count(source, u.length); ctx.stat(source).files++;
  return u;
}
export const objectUrl = (bucket, key) => bucketUrl(bucket) + key.split('/').map(encodeURIComponent).join('/');

// ------------------------------------------------------------------------------------------------------------ UTC helpers
const p2 = (v, n = 2) => String(v).padStart(n, '0');
export const ymd = (t) => { const d = new Date(t); return `${d.getUTCFullYear()}${p2(d.getUTCMonth() + 1)}${p2(d.getUTCDate())}`; };
export const hms = (t) => { const d = new Date(t); return `${p2(d.getUTCHours())}${p2(d.getUTCMinutes())}${p2(d.getUTCSeconds())}`; };
export const doy = (t) => { const d = new Date(t); return Math.floor((Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - Date.UTC(d.getUTCFullYear(), 0, 1)) / 864e5) + 1; };
export const hourStart = (t) => Math.floor(t / 36e5) * 36e5;
/** "%Y%j%H%M%S" -> ms UTC */
export function parseYjHMS(s) {
  const y = +s.slice(0, 4), j = +s.slice(4, 7), H = +s.slice(7, 9), M = +s.slice(9, 11), S = +s.slice(11, 13);
  return Date.UTC(y, 0, 1) + (j - 1) * 864e5 + H * 36e5 + M * 6e4 + S * 1e3;
}
export const yjHMS = (t) => { const d = new Date(t); return `${d.getUTCFullYear()}${p2(doy(t), 3)}${p2(d.getUTCHours())}${p2(d.getUTCMinutes())}${p2(d.getUTCSeconds())}`; };
export const iso = (t) => new Date(t).toISOString().replace('.000Z', 'Z');
