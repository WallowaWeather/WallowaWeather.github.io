// Part of BEAM's phone code (kept identical to BEAM's own build).
// js/runner/net.js - one fetch for all four input builders: at most `max` downloads in flight (all buckets together; a slot is held
// until the body has arrived, so the cap also bounds the bytes held mid-download), every request counted (requests, body bytes, by
// bucket and by builder). The body is read here once and handed on without a copy. GET only, as the buckets need: HEAD carries
// no CORS header there. Pure ES module (page, worker, Node).
'use strict';

/** a counting semaphore */
export function limiter(max) {
  const cap = Math.max(1, max | 0); let free = cap; const q = [];
  return {
    get inFlight() { return cap - free; },
    async run(fn) {
      if (free > 0) free--; else await new Promise((r) => q.push(r));
      try { return await fn(); } finally { const n = q.shift(); if (n) n(); else free++; }
    },
  };
}

/** the body already read, handed on without another copy (the builders use ok, status, arrayBuffer() and text() only) */
function liteResponse(r, ab) {
  return {
    ok: r.ok, status: r.status, statusText: r.statusText, headers: r.headers, url: r.url, type: r.type, bodyUsed: false,
    async arrayBuffer() { return ab; },
    async text() { return new TextDecoder().decode(ab); },
    async json() { return JSON.parse(new TextDecoder().decode(ab)); },
    async blob() { return new Blob([ab]); },
  };
}

const hostOf = (u) => { try { return new URL(u).host.split('.')[0]; } catch (e) { return 'other'; } };
const clock = () => (globalThis.performance || Date).now();
const NO_BODY = new Set([101, 204, 205, 304]);

/**
 * meteredFetch(baseFetch, { max, log }) -> fetch(url, init) with
 *   .meter = { requests, bytes, errors, peakInFlight, byHost: {host: {requests, bytes}}, byTag: {...}, log: [{ url, range, status, bytes, ms, tag }] | null }
 *   .tagged(tag) -> a fetch on the same slots that also counts under `tag`.
 */
export function meteredFetch(baseFetch = (u, o) => globalThis.fetch(u, o), { max = 6, log = false } = {}) {
  const lim = limiter(max), meter = { requests: 0, bytes: 0, errors: 0, peakInFlight: 0, byHost: {}, byTag: {}, log: log ? [] : null };
  const add = (k, o, n) => { const x = (o[k] ||= { requests: 0, bytes: 0 }); x.requests++; x.bytes += n; };
  function make(tag) {
    return (url, init = {}) => lim.run(async () => {
      meter.peakInFlight = Math.max(meter.peakInFlight, lim.inFlight);
      const t = clock(), u = String(url), h = init.headers || {};
      const range = (typeof h.get === 'function' ? h.get('range') : h.Range || h.range) || '';
      let r, ab = null;
      try {
        r = await baseFetch(u, init);
        if (!NO_BODY.has(r.status)) ab = await r.arrayBuffer();
      } catch (e) {
        meter.errors++; meter.requests++; if (tag) add(tag, meter.byTag, 0);
        if (meter.log) meter.log.push({ url: u, range, status: 0, bytes: 0, ms: Math.round(clock() - t), tag, error: String((e && e.message) || e).slice(0, 160) });
        throw e;
      }
      const n = ab ? ab.byteLength : 0;
      meter.requests++; meter.bytes += n; add(hostOf(u), meter.byHost, n); if (tag) add(tag, meter.byTag, n);
      if (meter.log) meter.log.push({ url: u, range, status: r.status, bytes: n, ms: Math.round(clock() - t), tag });
      return ab ? liteResponse(r, ab) : r;
    });
  }
  const f = make(null);
  f.meter = meter;
  f.tagged = (tag) => make(tag);
  return f;
}
