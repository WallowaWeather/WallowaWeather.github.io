// nowcast/legend.js - v018: the map's key across the top of the screen, a stack of full-width bars - the unit first, then the colours
// with their labels inside ("mph  0  10  20 ..."). Still one combined key (v010: Rain and Snow always, the active model's key
// under them), plus the forecast map's own bar when one is on. Each bar's colours are the map's own, composited on the panel's colour
// for the theme (so the bar looks like the map and every label's ink can be checked); each label is black or white, whichever reads
// better on the colours under it (4.5:1 or more on any colour). Labels that would crowd each other go, the ends and marks first kept.
// The bars only change when the keys do, never per frame, so the bar keeps one height while the loop plays; the radar's
// low-confidence note sits inside the rain bar. No canvas for the colours: a CSS gradient set through the CSSOM.
//   const lg = createLegend({ dark });  top.append(lg.el);  lg.set([rainSpec(), snowSpec(), beamSpec('hail'), fieldSpec(fields.legend())]);
'use strict';
import * as COL from './colors.js';
import { HEADS, chanceLut as beamLut } from './beam.js';

/** the panel's own colour under the bars (app.css --surface-1), dark / light */
export const BACKDROP = { dark: [15, 15, 17], light: [255, 255, 255] };
/** the two inks: black and white (any colour reads at 4.58:1 or more in one of them) */
export const INK = { d: [0, 0, 0], l: [255, 255, 255] };
const lin = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
export const luminance = (c) => 0.2126 * lin(c[0]) + 0.7152 * lin(c[1]) + 0.0722 * lin(c[2]);
/** WCAG contrast ratio of two opaque colours */
export function contrast(a, b) { const x = luminance(a), y = luminance(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); }
/** a colour [r, g, b, a] laid on an opaque backdrop -> [r, g, b] */
export function over(c, bg) { const a = c[3] == null ? 1 : c[3]; return [0, 1, 2].map((i) => Math.round(c[i] * a + bg[i] * (1 - a))); }
/** the ink that reads best on every colour under a label: { ink: 'd' | 'l', ratio (its worst) } */
export function inkFor(samples) {
  let best = null;
  for (const k of ['d', 'l']) { const r = Math.min(...samples.map((s) => contrast(INK[k], s))); if (!best || r > best.ratio) best = { ink: k, ratio: r }; }
  return best;
}
/** 'rgba(1,2,3,0.4)' | 'rgb(1, 2, 3)' | '#abc' | '#aabbcc' | 'transparent' -> [r, g, b, a] */
export function rgbaOf(css) {
  const s = String(css || '').trim(); let m;
  if ((m = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/.exec(s))) return [+m[1], +m[2], +m[3], m[4] == null ? 1 : +m[4]];
  if ((m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(s))) { const h = m[1].length === 3 ? m[1].replace(/./g, '$&$&') : m[1]; return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)).concat(1); }
  return [0, 0, 0, 0];
}
const logScale = (v0, v1) => ({ f: (v) => Math.log(v / v0) / Math.log(v1 / v0), v: (f) => v0 * (v1 / v0) ** f });
const pct = (v) => `${Math.round(v * 100)}%`;
const RAIN_WORDS = (COL.LEGEND && COL.LEGEND.rain) || [['Light', 0.5], ['Moderate', 4], ['Heavy', 16]];
const SNOW_WORDS = (COL.LEGEND && COL.LEGEND.snow) || [['Light', 0.5], ['Heavy', 4]];
const ends = (ticks) => ticks.map((t) => Object.assign({ prio: t.f <= 0.001 || t.f >= 0.999 ? 2 : 1 }, t));

// ------------------------------------------------------------------------------------------------ the keys
/** Rain: the radar's colours from 0.1 to 100 mm/h (log), Light / Moderate / Heavy where the app's words are */
export function rainSpec() {
  const s = logScale(0.1, 100);
  return { id: 'rain', sig: 'rain', unit: 'Rain', aria: 'Rain: light, moderate, heavy', colorAt: (f) => rgbaOf(COL.cssOf(COL.RAIN, s.v(f))),
    ticks: RAIN_WORDS.filter(([w]) => w).map(([label, v]) => ({ f: s.f(v), label, prio: 1 })), marks: [] };
}
/** Snow: 0.1 to 10 mm/h of melted snow (log) */
export function snowSpec() {
  const s = logScale(0.1, 10);
  return { id: 'snow', sig: 'snow', unit: 'Snow', aria: 'Snow: light to heavy', colorAt: (f) => rgbaOf(COL.cssOf(COL.SNOW, s.v(f))),
    ticks: SNOW_WORDS.filter(([w]) => w).map(([label, v]) => ({ f: s.f(v), label, prio: 1 })), marks: [] };
}
/** DGMR / StormScope's chance of rain over `thr` mm/h, 10 % to 100 % */
export function chanceSpec(thr = 4, name = 'Nowcast') {
  return { id: 'model', sig: `chance-${thr}`, unit: `Chance >${thr} mm/h`, aria: `${name}: chance of rain over ${thr} mm/h, 10% to 100%`,
    colorAt: (f) => rgbaOf(COL.cssOf(COL.CHANCE, 0.1 + 0.9 * f)), ticks: ends([{ f: 0, label: '10%' }, { f: 0.4 / 0.9, label: '50%' }, { f: 1, label: '100%' }]), marks: [] };
}
/** BEAM's chance of a hazard (as the map draws it) from its first colour to 100 %, its warning level marked (the map's outline) */
export function beamSpec(head, { recal = false } = {}) {
  const H = Object.prototype.hasOwnProperty.call(HEADS, head) ? HEADS[head] : null; if (!H) return null;   // own keys: 'toString' is no hazard
  const r0 = H.ramp[0][0], lut = beamLut(H.ramp), at = (v) => (v - r0) / (1 - r0);
  const first = (() => { for (let k = Math.round(255 * r0); k < 256; k++) if (lut[4 * k + 3]) return k; return 255; })();   // the table starts at the ramp's first colour
  const colorAt = (f) => { const o = 4 * Math.max(first, Math.round(255 * Math.min(1, r0 + (1 - r0) * f))); return [lut[o], lut[o + 1], lut[o + 2], Math.max(0.35, lut[o + 3] / 255)]; };
  const ticks = [{ f: 0, label: pct(r0) }]; if (r0 < 0.4) ticks.push({ f: at(0.5), label: '50%' }); ticks.push({ f: 1, label: '100%' });
  const warnWords = recal && head === 'hail' ? 'the line is BEAM’s warning level (hail shown recalibrated)' : `the line is BEAM’s warning level, ${pct(H.warn)}`;
  return { id: 'model', sig: `beam-${head}-${recal ? 'r' : ''}`, unit: `BEAM · ${H.label}`, aria: `BEAM, chance of ${H.label.toLowerCase()}: ${pct(r0)} to 100%; ${warnWords}`,
    colorAt, ticks: ends(ticks), marks: [{ v: H.warn, f: at(H.warn), label: 'warning' }] };
}
/** a forecast map's bar from fields.legend(): { name, unit, legendUnit?, ramp: [[value, [r, g, b, a]]], ticks: [{ v, label }] } (linear) */
export function fieldSpec(lg) {
  if (!lg || !lg.ramp || lg.ramp.length < 2) return null;
  const R = lg.ramp, v0 = R[0][0], v1 = R[R.length - 1][0], unit = lg.legendUnit || lg.unit || '';
  const colorAt = (f) => {
    const v = v0 + (v1 - v0) * f;
    for (let i = 1; i < R.length; i++) if (v <= R[i][0]) { const [a, ca] = R[i - 1], [b, cb] = R[i], u = b > a ? (v - a) / (b - a) : 0; return ca.map((x, k) => x + (cb[k] - x) * u); }
    return R[R.length - 1][1].slice();
  };
  const ticks = (lg.ticks || []).filter((t) => t.v >= v0 && t.v <= v1).map((t) => ({ f: (t.v - v0) / (v1 - v0), label: String(t.label) }));
  return { id: 'field', sig: `field-${lg.name}-${unit}-${v0}-${v1}-${R.length}-${ticks.length}`, unit, aria: `${lg.name} in ${unit}${ticks.length ? `: ${ticks[0].label} to ${ticks[ticks.length - 1].label}` : ''}`,
    colorAt, ticks: ends(ticks), marks: [] };
}
/** n opaque colours along a key, on the backdrop: [[f, [r, g, b]]] */
export function sampleStops(spec, n = 32, bg = BACKDROP.dark) { return Array.from({ length: n }, (_, i) => { const f = i / (n - 1); return [f, over(spec.colorAt(f) || [0, 0, 0, 0], bg)]; }); }
export function gradientCss(stops) { return `linear-gradient(90deg, ${stops.map(([f, c]) => `rgb(${c[0]}, ${c[1]}, ${c[2]}) ${(f * 100).toFixed(1)}%`).join(', ')})`; }
/** which labels to keep on a bar `width` px wide: [{ f, w (px), prio, align? 's' | 'c' | 'e' }] -> [bool]; the highest priority first, none
 *  within `gap` px of another (ends: a label at 0 starts there, one at 1 ends there) */
export function thinLabels(labels, width, gap = 6) {
  const box = (l) => { const x = l.f * width, a = l.align || (l.f < 0.04 ? 's' : l.f > 0.96 ? 'e' : 'c'); const s = a === 's' ? x : a === 'e' ? x - l.w : x - l.w / 2; return [s, s + l.w]; };
  const order = labels.map((l, i) => i).sort((i, j) => (labels[j].prio || 0) - (labels[i].prio || 0) || i - j), kept = [], keep = labels.map(() => false);
  for (const i of order) { const b = box(labels[i]); if (kept.every((k) => b[1] + gap <= k[0] || k[1] + gap <= b[0])) { kept.push(b); keep[i] = true; } }
  return keep;
}

// ------------------------------------------------------------------------------------------------ the DOM
/** -> { el, set(specs), qc({ low, speck }), hatch (the swatch's canvas), layout(), refresh() } */
export function createLegend({ doc = globalThis.document, dark = () => false } = {}) {
  const mk = (tag, cls, text) => { const e = doc.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  const el = mk('div', 'nc-legend'); el.setAttribute('role', 'group'); el.setAttribute('aria-label', 'Map key');
  // v011 / v016: the radar's low-confidence note (the hatching's own swatch, the ring for a lone speck), now inside the rain bar
  const qcEl = mk('span', 'nc-lg-qc'), hatch = mk('canvas', 'nc-lg-hatch'), ring = mk('span', 'nc-lg-ring', '◌');
  qcEl.append(hatch, ring, mk('span', 'nc-lg-qct', 'low conf.')); qcEl.hidden = true; qcEl.setAttribute('aria-hidden', 'true');
  qcEl.title = 'Low radar confidence: hatching over low-quality radar, a dashed ring around a lone speck';
  let bars = [], qcOn = { low: false, speck: false }, lastKey = '';
  const estW = (t) => String(t).length * 6.4 + 6;
  function build(spec) {
    const b = { spec, el: mk('div', 'nc-lgbar'), unit: mk('span', 'nc-lgb-unit', spec.unit), ramp: mk('span', 'nc-lgb-ramp'), labs: [], marks: [] };
    b.el.dataset.k = spec.id; b.el.setAttribute('role', 'img'); b.el.setAttribute('aria-label', spec.aria || spec.unit);
    for (const m of spec.marks || []) { const i = mk('i', 'nc-lgb-mark'); i.style.left = `${(100 * m.f).toFixed(2)}%`; b.ramp.append(i); b.marks.push(i); }
    const all = (spec.ticks || []).map((t) => ({ t, mark: false })).concat((spec.marks || []).map((t) => ({ t: Object.assign({ prio: 3, align: t.f > 0.6 ? 'e' : 's' }, t), mark: true })));
    for (const { t, mark } of all) {
      const l = mk('span', 'nc-lgb-lab' + (mark ? ' mark' : ''), t.label); const a = t.align || (t.f < 0.04 ? 's' : t.f > 0.96 ? 'e' : 'c');
      l.classList.add('a-' + a); l.style.left = `${(100 * t.f).toFixed(2)}%`; b.ramp.append(l); b.labs.push({ el: l, t: Object.assign({ align: a }, t) });
    }
    b.el.append(b.unit, b.ramp);
    return b;
  }
  /** colours for the theme: the unit's cell, the gradient, each label's ink (from the colours under it) */
  function paint(b, widthPx = 0) {
    const bg = dark() ? BACKDROP.dark : BACKDROP.light, spec = b.spec, W = widthPx || 300, col = (f) => over(spec.colorAt(Math.max(0, Math.min(1, f))) || [0, 0, 0, 0], bg);
    const c0 = col(0); b.unit.style.background = `rgb(${c0[0]}, ${c0[1]}, ${c0[2]})`;
    b.unit.classList.toggle('ink-d', inkFor([c0]).ink === 'd'); b.unit.classList.toggle('ink-l', inkFor([c0]).ink === 'l');
    b.ramp.style.background = gradientCss(sampleStops(spec, 40, bg));
    const rr = widthPx && b.ramp.getBoundingClientRect ? b.ramp.getBoundingClientRect() : null;
    for (const { el: l, t } of b.labs) {
      const lr = rr && l.getBoundingClientRect ? l.getBoundingClientRect() : null, w = (lr && lr.width) || estW(t.label), x = t.f * W;
      const s = lr && lr.width ? lr.left - rr.left : t.align === 's' ? x : t.align === 'e' ? x - w : x - w / 2;
      const under = [s + 1, s + w / 2, s + w - 1].map((px) => col(px / W)), best = inkFor(under);
      l.classList.toggle('ink-d', best.ink === 'd'); l.classList.toggle('ink-l', best.ink === 'l');
      l.classList.toggle('halo', best.ratio < 4.5);   // a steep stretch of colours under it: a soft backing (nowcast.css) keeps it at 4.5:1
    }
    for (const m of b.marks) { m.classList.toggle('ink-d', inkFor([col(parseFloat(m.style.left) / 100)]).ink === 'd'); }
  }
  /** labels that crowd each other go (measured, in a browser; all kept where nothing is measured) */
  function layout() {
    for (const b of bars) {
      const W = (b.ramp.getBoundingClientRect && b.ramp.getBoundingClientRect().width) || 0;
      if (!W) { for (const { el: l } of b.labs) l.hidden = false; paint(b); continue; }
      for (const { el: l, t } of b.labs) {   // a centred label too near an end starts / ends there instead
        const w = l.getBoundingClientRect().width || estW(t.label), x = t.f * W, a = t.align === 'c' && x - w / 2 < 2 ? 's' : t.align === 'c' && x + w / 2 > W - 2 ? 'e' : t.align;
        if (a !== t.align) { l.classList.remove('a-' + t.align); l.classList.add('a-' + a); t.align = a; }
      }
      // the low-confidence note's room at the rain bar's end: in words where they fit, else the swatch and the ring alone (no label goes)
      let qcW = 0;
      if (b.spec.id === 'rain' && !qcEl.hidden) {
        qcEl.classList.remove('compact'); qcW = (qcEl.getBoundingClientRect().width || 0) + 4;
        const clash = b.labs.some(({ el: l, t }) => { const w = l.getBoundingClientRect().width || estW(t.label), x = t.f * W, s0 = t.align === 's' ? x : t.align === 'e' ? x - w : x - w / 2; return s0 + w + 6 > W - qcW; });
        if (clash) { qcEl.classList.add('compact'); qcW = (qcEl.getBoundingClientRect().width || 0) + 4; }
      }
      const keep = thinLabels(b.labs.map(({ el: l, t }) => ({ f: t.f, w: l.getBoundingClientRect().width || estW(t.label), prio: t.prio || 0, align: t.align })).concat(qcW ? [{ f: 1, w: qcW, prio: 9, align: 'e' }] : []), W, 6);
      b.labs.forEach(({ el: l }, i) => { l.hidden = !keep[i]; });
      paint(b, W);
    }
  }
  function aria(b) { b.el.setAttribute('aria-label', (b.spec.aria || b.spec.unit) + (b.spec.id === 'rain' && qcOn.low ? '; hatched areas: low radar confidence' : '') + (b.spec.id === 'rain' && qcOn.speck ? '; a dashed ring: a lone speck the radar may not trust' : '')); }
  /** the keys to show, top to bottom (null ones skipped); the same keys again keep their bars */
  function set(specs) {
    // a spec's dim: true = its colours are not on the map at this frame (v018 review: the model's bar on a forecast hour) - kept, dimmed,
    // so the key keeps one height while the loop plays
    const want = specs.filter(Boolean), key = want.map((s) => s.sig + (s.dim ? '~' : '')).join('|') + (dark() ? '|d' : '|l');
    if (key === lastKey) return;   // the same keys in the same theme (every frame while the loop plays): nothing to do
    lastKey = key;
    const next = [];
    for (const s of want) { const old = bars.find((b) => b.spec.sig === s.sig && !next.includes(b)); if (old) { old.spec = s; next.push(old); } else next.push(build(s)); }
    for (const b of bars) if (!next.includes(b)) b.el.remove();
    next.forEach((b, i) => { if (el.childNodes[i] !== b.el) el.insertBefore(b.el, el.childNodes[i] || null); });
    bars = next;
    const rain = bars.find((b) => b.spec.id === 'rain'); if (rain && qcEl.parentNode !== rain.ramp) rain.ramp.append(qcEl);
    for (const b of bars) { aria(b); paint(b); b.el.classList.toggle('dim', !!b.spec.dim); if (b.spec.dim) b.el.setAttribute('aria-label', `${b.spec.aria || b.spec.unit} (not on the map at this time)`); }
    layout();
  }
  function qc({ low = false, speck = false } = {}) {
    if (qcOn.low === !!low && qcOn.speck === !!speck) return;
    qcOn = { low: !!low, speck: !!speck }; qcEl.hidden = !(low || speck); hatch.hidden = !low; ring.hidden = !speck;
    const rain = bars.find((b) => b.spec.id === 'rain'); if (rain) aria(rain);
    layout();
  }
  function refresh() { lastKey = bars.map((b) => b.spec.sig + (b.spec.dim ? '~' : '')).join('|') + (dark() ? '|d' : '|l'); for (const b of bars) paint(b); layout(); }
  return { el, set, qc, hatch, layout, refresh, get keys() { return bars.map((b) => b.spec.id); } };
}
