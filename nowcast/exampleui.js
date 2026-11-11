// nowcast/exampleui.js - v018 examples (Josh: the app must not switch look when people look at the example storms): an example storm on
// the live map's own controls. The players (beam.js createBeamPlayer, examples.js createRainPlayer) describe the frame shown - ui():
// { kind, model, pill, title, frames [{ t, kind }], i, moment, date, time, tag, valuetext, momentWords, sentence, chipsLabel,
// chips [{ id, label, on, disabled }], switches [{ id, label, on }], dots ({ colours, words } | null), chance, credit, about [], delay } -
// and the view draws it: the time bar (timebar.js) runs the example's frames with the date in its centred words and the forecast's
// moment as its "now"; the folding card (cardfold.js) holds the sentence, the chips, the switches, BEAM's 30 / 60 / 90 dots, the
// credits and "About this example". No key of its own: the top key (legend.js) explains the colours.
'use strict';

/** the time bar's state (timebar.js render) for an example's frame */
export function exampleTime(u) {
  const m = Math.max(0, Math.min(u.frames.length - 1, u.moment | 0));
  return { items: u.frames, idx: u.i, nowIdx: m, nowT: u.frames[m].t, day: u.date, time: u.time, tag: u.tag, tagClass: u.i <= m ? 'past' : '', valuetext: u.valuetext };
}

/** the card's body for an example -> { el, update(u), reset() }: built once per example's shape, then kept (a chip keeps its focus while
 *  the frames play); onChip(id), onSwitch(id, on) */
export function createExampleBody({ doc = globalThis.document, onChip = () => {}, onSwitch = () => {} } = {}) {
  const mk = (tag, cls, text) => { const e = doc.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  const el = mk('div', 'bm-live nc-ex-body');
  const ttl = mk('p', 'nc-ex-title'), sum = mk('p', 'nc-sum'), chips = mk('div', 'bm-chips'), row = mk('div', 'bm-row nc-ex-sw'), dots = mk('div', 'bm-later'), credit = mk('p', 'nc-note footnote nc-ex-credit');
  const fine = mk('details', 'bm-fine'), fineSum = mk('summary', null, 'About this example'), fineBody = mk('div', 'nc-ex-about');
  chips.setAttribute('role', 'group'); fine.append(fineSum, fineBody);
  el.append(ttl, sum, chips, row, dots, credit, fine);
  let shape = '', about = '', fineOpen = false, chipEls = new Map(), swEls = new Map();
  fine.addEventListener('toggle', () => { fineOpen = fine.open; });
  function build(u) {
    chips.textContent = ''; row.textContent = ''; chipEls = new Map(); swEls = new Map();
    for (const c of u.chips) {
      const b = mk('button', 'bm-chip', c.label); b.type = 'button'; b.dataset.id = c.id;
      b.addEventListener('click', () => { if (!b.disabled) onChip(c.id); });
      chips.append(b); chipEls.set(c.id, b);
    }
    for (const s of u.switches) {
      const l = mk('label', 'bm-sw'), i = mk('input'); i.type = 'checkbox'; i.dataset.id = s.id;
      i.addEventListener('change', () => onSwitch(s.id, i.checked));
      l.append(i, mk('span', null, s.label)); row.append(l); swEls.set(s.id, i);
    }
    row.hidden = !u.switches.length;
  }
  function update(u) {
    const key = [u.kind, u.chips.map((c) => c.id).join(), u.switches.map((s) => s.id).join()].join('|');
    if (key !== shape) { build(u); shape = key; }
    ttl.textContent = u.title || ''; sum.textContent = u.sentence || '';
    chips.setAttribute('aria-label', u.chipsLabel || 'View'); chips.hidden = !u.chips.length;
    for (const c of u.chips) { const b = chipEls.get(c.id); b.classList.toggle('on', !!c.on); b.setAttribute('aria-pressed', String(!!c.on)); b.disabled = !!c.disabled; }
    for (const s of u.switches) { const i = swEls.get(s.id); if (i.checked !== !!s.on) i.checked = !!s.on; }
    dots.hidden = !u.dots; dots.textContent = '';
    if (u.dots) { for (const L of [30, 60, 90]) { const d = mk('i', 'bm-dot'); d.style.background = u.dots.colours[L]; dots.append(d, mk('span', null, `${L} min`)); } dots.append(mk('span', 'dim', u.dots.words)); }
    credit.textContent = u.credit || '';
    const a = (u.about || []).join('\n');
    if (a !== about) { about = a; fineBody.textContent = ''; for (const p of u.about || []) fineBody.append(mk('p', null, p)); }
    fine.open = fineOpen;
  }
  return { el, update, reset() { shape = ''; about = ''; fineOpen = false; fine.open = false; } };
}
