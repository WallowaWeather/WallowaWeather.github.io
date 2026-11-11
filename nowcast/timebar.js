// nowcast/timebar.js - v018: the time bar at the bottom of the map, a compact pill of its own (it was the card's lower half): play /
// pause, the time in the middle ("Now 8:00 AM", "Today 4:10 PM") with what the frame is under it, the ticks, back to now. A slider for
// the keyboard (arrows, Home, End) and a screen reader (the frame's words). One height whatever the frame: two lines of words, always.
// The bar's scale: each step between frames takes room by its own kind's step - 10 minutes of radar or nowcast, an hour of a forecast
// map - so radar, a 90-minute nowcast and a day of hourly forecast all fit, every frame as easy to reach (radar + a nowcast alone stay
// linear in time, as in v017).
'use strict';
import { icon } from './icons.js';

const MIN = 60e3, H = 60 * MIN;
/** the time one unit of the bar stands for, by the frame's kind */
export const unitOf = (kind) => (kind === 'field' ? H : 10 * MIN);
/** items [{ t, kind }] (ascending) -> { f: [0..1 per item], total, pos(t), nearest(x) } */
export function scaleOf(items) {
  const n = items.length, f = new Array(n).fill(0);
  if (n < 2) return { f, total: 0, pos: () => 0, nearest: () => 0 };
  const w = []; let tot = 0;
  for (let i = 1; i < n; i++) { const d = Math.max(0, items[i].t - items[i - 1].t) / unitOf(items[i].kind); w.push(d); tot += d; }
  let acc = 0; for (let i = 1; i < n; i++) { acc += w[i - 1]; f[i] = tot ? acc / tot : i / (n - 1); }
  const pos = (t) => {
    if (t <= items[0].t) return 0; if (t >= items[n - 1].t) return 1;
    let i = 1; while (items[i].t < t) i++;
    const a = items[i - 1].t, b = items[i].t; return f[i - 1] + (f[i] - f[i - 1]) * ((t - a) / (b - a || 1));
  };
  const nearest = (x) => { let best = 0; for (let i = 1; i < n; i++) if (Math.abs(f[i] - x) < Math.abs(f[best] - x)) best = i; return best; };
  return { f, total: tot, pos, nearest };
}
/** the ticks: every 10 minutes (bigger on the half hour) where frames are 10 minutes or closer, every hour (bigger every 3) over a
 *  forecast map's hours -> [{ t, f, major, future }] */
export function ticksFor(items, scale, { nowT = 0 } = {}) {
  const out = [], seen = new Set();
  for (let i = 1; i < items.length; i++) {
    const step = unitOf(items[i].kind), a = items[i - 1].t, b = items[i].t;
    for (let t = Math.ceil(a / step) * step; t <= b; t += step) {
      if (seen.has(t)) continue; seen.add(t);
      const d = new Date(t), major = step >= H ? d.getHours() % 3 === 0 && d.getMinutes() === 0 : d.getMinutes() % 30 === 0;
      out.push({ t, f: scale.pos(t), major, future: t > nowT });
    }
  }
  return out.sort((x, y) => x.t - y.t);
}
const dayStart = (x) => { const d = new Date(x); return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime(); };
/** Today, Tomorrow, Yesterday, else the weekday ("Wed") */
export function dayWord(t, now = Date.now()) {
  const k = Math.round((dayStart(t) - dayStart(now)) / 864e5);
  return k === 0 ? 'Today' : k === 1 ? 'Tomorrow' : k === -1 ? 'Yesterday' : new Date(t).toLocaleDateString('en-US', { weekday: 'short' });
}
/** the pill's big words: { day: 'Now' | 'Today' | ..., time } */
export function whenWords(t, { now = Date.now(), isNow = false, clock = (x) => new Date(x).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) } = {}) {
  return { day: isNow ? 'Now' : dayWord(t, now), time: clock(t) };
}
/** a forecast map's times as timeline items (kind 'field') after `after`, merged in order */
export function mergeField(items, times, { after = -Infinity, id = null } = {}) {
  const add = (times || []).filter((t) => t > after).map((t) => ({ t, kind: 'field', id }));
  return items.concat(add).sort((a, b) => a.t - b.t);
}

/** the DOM -> { el, play, track, ticks, thumb, nowM, tlab, nowB, render(state), setPlaying(on), get scale } */
export function createTimeBar({ doc = globalThis.document, onSeek = () => {}, onStep = () => {}, onPlay = () => {}, onNow = () => {} } = {}) {
  const mk = (tag, cls, text) => { const e = doc.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  const btn = (cls, ic) => { const b = mk('button', cls); b.type = 'button'; b.append(icon(ic)); return b; };
  const el = mk('div', 'nc-timebar'); el.setAttribute('role', 'group'); el.setAttribute('aria-label', 'Timeline');
  const play = btn('nc-play', 'play'); play.setAttribute('aria-label', 'Play');
  const mid = mk('div', 'nc-tb-mid'), tlab = mk('p', 'nc-tlab'), track = mk('div', 'nc-track'), ticks = mk('div', 'nc-ticks'), nowM = mk('i', 'nc-now'), thumb = mk('i', 'nc-thumb');
  track.setAttribute('role', 'slider'); track.setAttribute('aria-label', 'Time'); track.tabIndex = 0; track.append(ticks, nowM, thumb);
  mid.append(tlab, track);
  const nowB = btn('nc-tb-now', 'skipnow'); nowB.setAttribute('aria-label', 'Back to now');
  el.append(play, mid, nowB);
  let items = [], key = '', scale = scaleOf([]), dir = 0;
  const pct = (f) => `${(100 * f).toFixed(2)}%`;
  // the whole middle (the words and the ticks) takes a finger: the nearest frame to it
  // v018 review: a drag's moves are marked (onSeek(i, true): the view may wait for the finger to rest before reading a forecast hour);
  // letting go asks for where it rests, at once
  let dragIdx = -1;
  const seekAt = (ev, drag = false) => { if (!items.length) return; const r = track.getBoundingClientRect(); if (!r.width) return; const i = scale.nearest(Math.max(0, Math.min(1, (ev.clientX - r.left) / r.width))); if (drag) dragIdx = i; onSeek(i, drag); };
  const letGo = () => { mid.onpointermove = null; if (dragIdx >= 0) { const i = dragIdx; dragIdx = -1; onSeek(i, false); } };
  mid.addEventListener('pointerdown', (e) => { if (mid.setPointerCapture) try { mid.setPointerCapture(e.pointerId); } catch (x) { /* */ } dragIdx = -1; seekAt(e); mid.onpointermove = (ev) => seekAt(ev, true); });
  mid.addEventListener('pointerup', letGo);
  mid.addEventListener('pointercancel', letGo);
  track.addEventListener('keydown', (e) => {
    const k = e.key, n = items.length; let done = true;
    if (k === 'ArrowRight' || k === 'ArrowUp') onStep(1); else if (k === 'ArrowLeft' || k === 'ArrowDown') onStep(-1);
    else if (k === 'Home') onSeek(0); else if (k === 'End') onSeek(Math.max(0, n - 1)); else if (k === 'PageUp') onStep(6); else if (k === 'PageDown') onStep(-6); else done = false;
    if (done && e.preventDefault) e.preventDefault();
  });
  play.addEventListener('click', () => onPlay());
  nowB.addEventListener('click', () => onNow());
  function setPlaying(on) { play.replaceChildren(icon(on ? 'pause' : 'play')); play.setAttribute('aria-label', on ? 'Pause' : 'Play'); }
  /** st: { items, idx, nowIdx, nowT, day, time, tag, tagClass, valuetext } */
  function render(st) {
    items = st.items || []; const n = items.length;
    track.classList.toggle('nc-empty', !n);   // v018 examples: not 'empty' (app.css's empty-page rule made the bar half the screen tall)
    const b = mk('b'), day = mk('span', 'nc-tday', st.day || ''), tag = mk('span', 'nc-tag' + (st.tagClass ? ' ' + st.tagClass : ''), st.tag || '');
    if (st.day) b.append(day, ' '); b.append(st.time || ''); tlab.replaceChildren(b, tag);
    if (!n) { ticks.textContent = ''; key = ''; thumb.hidden = nowM.hidden = true; for (const a of ['aria-valuemin', 'aria-valuemax', 'aria-valuenow']) track.removeAttribute(a); track.setAttribute('aria-valuetext', st.tag || ''); nowB.setAttribute('aria-disabled', 'true'); return; }
    const k = items.map((x) => x.kind[0] + x.t).join(',');
    if (k !== key) {
      key = k; scale = scaleOf(items); ticks.textContent = '';
      for (const t of ticksFor(items, scale, { nowT: st.nowT || 0 })) { const i = mk('i', 'nc-tick' + (t.major ? ' major' : '') + (t.future ? ' future' : '')); i.style.left = pct(t.f); ticks.append(i); }
    }
    const idx = Math.max(0, Math.min(n - 1, st.idx < 0 ? (st.nowIdx >= 0 ? st.nowIdx : 0) : st.idx)), it = items[idx];
    thumb.hidden = false; thumb.style.left = pct(scale.f[idx]); thumb.classList.toggle('future', it.kind !== 'radar');
    nowM.hidden = st.nowIdx < 0; if (st.nowIdx >= 0) nowM.style.left = pct(scale.f[st.nowIdx]);
    tlab.classList.toggle('future', it.kind !== 'radar');
    track.setAttribute('aria-valuemin', '0'); track.setAttribute('aria-valuemax', String(n - 1)); track.setAttribute('aria-valuenow', String(idx)); track.setAttribute('aria-valuetext', st.valuetext || `${st.day || ''} ${st.time || ''}`.trim());
    const atNow = st.nowIdx < 0 || idx === st.nowIdx, d = atNow ? dir : idx > st.nowIdx ? 1 : -1;
    nowB.setAttribute('aria-disabled', atNow ? 'true' : 'false');
    if (d !== dir) { dir = d; nowB.replaceChildren(icon(d < 0 ? 'skipfwd' : 'skipnow')); }   // which way "now" is
  }
  return { el, play, track, ticks, thumb, nowM, tlab, nowB, mid, render, setPlaying, get scale() { return scale; } };
}
