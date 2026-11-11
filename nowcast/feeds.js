// nowcast/feeds.js - Wallowa Weather v008: what the live layers share (gauges.js, fires.js, firewx.js): a poller that asks a service
// only while its layer is on, at most once every `every` ms (a failure waits `retry`), never while the page is hidden, and stops the
// request in flight when the layer goes off; a JSON fetch with a time limit; and the cleaning of text that comes from the network.
'use strict';

const hiddenDoc = () => { try { return typeof document !== 'undefined' && document.visibilityState === 'hidden'; } catch (e) { return false; } };

/** run(signal) -> Promise (resolves = success). -> { start(), stop(), refresh(force), destroy(), state } */
export function createPoller({ run, every = 15 * 60e3, retry = 2 * 60e3, minGap = 60e3, now = () => Date.now(), hidden = hiddenDoc,
  setTimer = (f, ms) => setTimeout(f, ms), clearTimer = (t) => clearTimeout(t), doc = typeof document !== 'undefined' ? document : null, onError = () => {} } = {}) {
  let active = false, timer = 0, ctrl = null, busy = null, cur = null, nextAt = 0, lastStart = -Infinity, runs = 0;
  function fire(force = false) {
    if (!active) return Promise.resolve(false);
    if (busy) return busy;
    const t = now();
    if (!force && t < nextAt) return Promise.resolve(false);
    if (t - lastStart < minGap) return Promise.resolve(false);   // even a forced refresh waits a minute between requests
    lastStart = t; runs++;
    const tok = {}; cur = tok; ctrl = new AbortController(); const signal = ctrl.signal;
    busy = (async () => {
      let ok = false;
      try { await run(signal); ok = !signal.aborted; } catch (e) { if (!signal.aborted) onError(e); }
      if (!signal.aborted) nextAt = now() + (ok ? every : retry);
      if (cur === tok) { busy = null; ctrl = null; }
      return ok;
    })();
    return busy;
  }
  function schedule() {
    if (timer) { clearTimer(timer); timer = 0; }
    if (!active || hidden()) return;   // hidden: visibilitychange brings it back
    const t = now(), wait = Math.max(0, nextAt - t, lastStart + minGap - t);
    timer = setTimer(async () => { timer = 0; if (!active || hidden()) return; await fire(); schedule(); }, wait);
  }
  const onVis = () => { if (active && !hidden()) schedule(); };
  if (doc && doc.addEventListener) doc.addEventListener('visibilitychange', onVis);
  function stop() {
    active = false;
    if (timer) { clearTimer(timer); timer = 0; }
    if (ctrl) ctrl.abort();
    ctrl = null; busy = null; cur = null;
  }
  return {
    start() { if (active) return; active = true; schedule(); },
    stop,
    /** ask now if due (force: even if not due, but not within a minute of the last request) */
    refresh(force = false) { return fire(force).then((r) => { schedule(); return r; }); },
    destroy() { stop(); if (doc && doc.removeEventListener) doc.removeEventListener('visibilitychange', onVis); },
    get state() { return { active, busy: !!busy, nextAt, runs, timer: !!timer }; },
  };
}

/** GET a JSON document (Accept: application/json unless given), with a time limit; the signal stops it */
export async function getJSON(url, { signal = null, fetchFn = (...a) => fetch(...a), accept = 'application/json', timeoutMs = 30e3 } = {}) {
  const c = new AbortController(), t = setTimeout(() => c.abort(), timeoutMs);
  const stop = () => c.abort(); if (signal) { if (signal.aborted) c.abort(); else signal.addEventListener('abort', stop, { once: true }); }
  try {
    const r = await fetchFn(url, { headers: { Accept: accept }, signal: c.signal, referrerPolicy: 'no-referrer' });
    if (!r.ok) throw Object.assign(new Error(`${new URL(url).host} answered ${r.status}`), { status: r.status });
    return await r.json();
  } finally { clearTimeout(t); if (signal) signal.removeEventListener('abort', stop); }
}

/** untrusted text from the network: a string, no control characters, no chat-template tokens (the same rule as places/neutralise.js),
 *  at most n characters */
export function clean(v, n = 200) {
  if (v == null) return '';
  return String(v).replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/<\|?\s*"?\s*\|>|<\|[^<>\n]{0,40}>|<[^<>\n]{0,40}\|>|<(?:bos|eos|pad|mask|unk|start_of_turn|end_of_turn)>/gi, ' ')
    .replace(/\s+/g, ' ').trim().slice(0, n);
}
/** a finite number or null */
export const num = (v) => { if (v == null || v === '') return null; const x = +v; return Number.isFinite(x) ? x : null; };
/** "3:40 PM" */
export const clockOf = (t) => { const d = new Date(t); if (isNaN(d)) return ''; try { return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }); } catch (e) { return d.toISOString().slice(11, 16) + ' UTC'; } };
/** "Jul 16, 2026" */
export const dateOf = (t) => { const d = new Date(t); if (isNaN(d)) return ''; try { return d.toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' }); } catch (e) { return d.toISOString().slice(0, 10); } };
/** "12 min ago", "3 h ago", "2 days ago" */
export const agoOf = (t, now = Date.now()) => {
  const m = Math.max(0, Math.round((now - t) / 60e3));
  return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : m < 48 * 60 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} days ago`;
};
/** a pill label next to a map mark: dark box, white text; placed right of x (or left if no room), never over another (placed: boxes) */
export function pill(ctx, api, x, y, text, placed, { color = '#fff', size = 11, bg = 'rgba(8,16,28,0.84)', dx = 9 } = {}) {
  ctx.font = `600 ${size}px -apple-system, BlinkMacSystemFont, system-ui, sans-serif`;
  const tw = ctx.measureText(text).width, w = tw + 10, h = size + 7;
  let b = { x: x + dx, y: y - h / 2, w, h };
  const free = (q) => !placed.some((o) => q.x < o.x + o.w + 2 && q.x + q.w + 2 > o.x && q.y < o.y + o.h + 1 && q.y + q.h + 1 > o.y);
  const fits = (q) => q.x >= 2 && q.y >= 2 && q.x + q.w <= api.w - 2 && q.y + q.h <= api.h - 2;
  if (!fits(b) || !free(b)) { const l = { x: x - dx - w, y: b.y, w, h }; if (fits(l) && free(l)) b = l; else return null; }
  placed.push(b);
  ctx.fillStyle = bg; ctx.beginPath();
  if (ctx.roundRect) ctx.roundRect(b.x, b.y, b.w, b.h, h / 2); else ctx.rect(b.x, b.y, b.w, b.h);
  ctx.fill();
  ctx.fillStyle = color; ctx.textAlign = 'left'; ctx.textBaseline = 'middle'; ctx.fillText(text, b.x + 5, b.y + h / 2 + 0.5);
  return b;
}
