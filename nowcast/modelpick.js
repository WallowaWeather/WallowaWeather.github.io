// nowcast/modelpick.js - the forecast-model picker at the map's bottom-left, above the card. A small glass chip shows the
// model in use (its icon, its short name, a chevron); a tap opens a short list above it: each model's icon, name, one line and status
// (On this phone / Download · 356 MB / Downloading · 42% / Examples), the one in use checked. A tap picks; a tap outside or Escape
// closes. A listbox for screen readers and the keyboard (arrows, Home, End, Enter, Space, Escape). Styles: modelpick.css (mp-).
//   const p = createModelPicker({ models: MODELS, current: 'beam', onPick: (id) => { ... }, statusOf: (id) => ({ ready, downloading, pct, note, bytes }) });
//   dock.append(p.el); p.refresh();   // after a download moves on
'use strict';
import { MODELS, modelIcon, glyph, statusText, EXPERIMENTAL } from './models_info.js';

let seq = 0;
const reduced = () => { try { return matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (e) { return false; } };

/** -> { el, setCurrent(id), refresh(), open(), close(), get isOpen, get current } */
export function createModelPicker({ models = MODELS, current = null, onPick = () => {}, statusOf = () => ({}), onAbout = null, doc = document } = {}) {
  const mk = (tag, cls, text) => { const e = doc.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  const uid = 'mp' + (++seq);
  let cur = models.some((m) => m.id === current) ? current : models[0].id, isOpen = false, active = 0;

  const el = mk('div', 'mp');
  const chip = mk('button', 'mp-chip'); chip.type = 'button';
  chip.setAttribute('aria-haspopup', 'listbox'); chip.setAttribute('aria-expanded', 'false'); chip.setAttribute('aria-controls', uid + '-list');
  const chipIc = mk('span', 'mp-chip-ic'), chipName = mk('span', 'mp-chip-name'), chipPct = mk('span', 'mp-chip-pct');
  chip.append(chipIc, chipName, chipPct, glyph('chevUp', 'mp-chev', 12, doc));
  const scrim = mk('div', 'mp-scrim'); scrim.hidden = true;   // a tap outside lands here and only closes (the map underneath never sees it)
  const pop = mk('div', 'mp-pop'); pop.id = uid + '-pop';
  const head = mk('p', 'mp-head', 'Forecast model'); head.id = uid + '-head';
  const list = mk('ul', 'mp-list'); list.id = uid + '-list';
  list.setAttribute('role', 'listbox'); list.setAttribute('aria-labelledby', uid + '-head');
  const foot = mk('div', 'mp-foot'); foot.append(mk('span', null, EXPERIMENTAL));
  if (onAbout) { const ab = mk('button', 'mp-about', 'Strengths and weaknesses'); ab.type = 'button'; ab.addEventListener('click', () => { close(false); onAbout(cur); }); foot.append(ab); }
  pop.append(head, list, foot);
  el.append(scrim, chip, pop);

  const rows = models.map((m, i) => {
    const li = mk('li', 'mp-opt'); li.id = `${uid}-${m.id}`; li.setAttribute('role', 'option'); li.tabIndex = -1; li.dataset.model = m.tint || m.id;
    const tile = mk('span', 'mp-tile'); tile.append(modelIcon(m, 'mp-ic', 22, doc));
    const txt = mk('span', 'mp-txt'), top = mk('span', 'mp-name'), st = mk('span', 'mp-st');
    top.append(mk('b', null, m.name), st); txt.append(top, mk('span', 'mp-line', m.short));
    const ck = mk('span', 'mp-ck'); ck.append(glyph('check', 'mp-gl', 18, doc));
    li.append(tile, txt, ck);
    li.addEventListener('click', () => pick(m.id));
    li.addEventListener('pointermove', () => { if (active !== i) focusRow(i, false); });
    list.append(li);
    return { m, li, st };
  });

  function paintChip() {
    const m = models.find((x) => x.id === cur), s = statusText(statusOf(cur), m);
    chipIc.textContent = ''; chipIc.append(modelIcon(m, 'mp-ic', 20, doc)); chip.dataset.model = m.tint || m.id;
    chipName.textContent = m.name; chipPct.textContent = s.kind === 'busy' ? ` ${Math.floor(100 * ((statusOf(cur) || {}).pct || 0))}%` : '';
    chip.setAttribute('aria-label', `Forecast model: ${m.name}${s.kind === 'busy' ? `, ${s.text}` : ''}. Change`);
  }
  function refresh() {
    for (const r of rows) {
      const s = statusText(statusOf(r.m.id), r.m);
      r.st.textContent = s.text; r.st.className = 'mp-st mp-k-' + s.kind;
      r.li.setAttribute('aria-selected', r.m.id === cur ? 'true' : 'false');
    }
    paintChip();
  }
  function focusRow(i, move = true) {
    active = (i + rows.length) % rows.length;
    rows.forEach((r, k) => { r.li.tabIndex = k === active ? 0 : -1; r.li.classList.toggle('mp-act', k === active); });
    if (move && rows[active].li.focus) rows[active].li.focus();
  }
  function open() {
    if (isOpen) return; isOpen = true; refresh();
    el.classList.add('mp-open'); el.classList.toggle('mp-still', reduced()); scrim.hidden = false; chip.setAttribute('aria-expanded', 'true');
    focusRow(Math.max(0, rows.findIndex((r) => r.m.id === cur)));
    doc.addEventListener('keydown', onDocKey, true);
  }
  function close(focusChip = true) {
    if (!isOpen) return; isOpen = false;
    el.classList.remove('mp-open'); scrim.hidden = true; chip.setAttribute('aria-expanded', 'false');
    rows.forEach((r) => r.li.classList.remove('mp-act'));
    doc.removeEventListener('keydown', onDocKey, true);
    if (focusChip && chip.focus) chip.focus();
  }
  function pick(id) {
    const ok = onPick(id);   // onPick may return false to keep the model in use (say it opens a download sheet instead)
    if (ok !== false) { cur = id; refresh(); }
    close();
  }
  function setCurrent(id) { if (models.some((m) => m.id === id)) { cur = id; refresh(); } }
  function onDocKey(e) { if (e.key === 'Escape') { e.preventDefault(); close(); } }

  chip.addEventListener('click', () => (isOpen ? close() : open()));
  chip.addEventListener('keydown', (e) => { if (e.key === 'ArrowUp' || e.key === 'ArrowDown') { e.preventDefault(); open(); } });
  list.addEventListener('keydown', (e) => {
    const k = e.key;
    if (k === 'ArrowDown') { e.preventDefault(); focusRow(active + 1); }
    else if (k === 'ArrowUp') { e.preventDefault(); focusRow(active - 1); }
    else if (k === 'Home') { e.preventDefault(); focusRow(0); }
    else if (k === 'End') { e.preventDefault(); focusRow(rows.length - 1); }
    else if (k === 'Enter' || k === ' ') { e.preventDefault(); pick(rows[active].m.id); }
    else if (k === 'Tab') close(false);
  });
  const shut = (e) => { if (e && e.preventDefault) e.preventDefault(); close(false); };
  scrim.addEventListener('pointerdown', (e) => { if (e.preventDefault) e.preventDefault(); });
  scrim.addEventListener('pointerup', shut);
  scrim.addEventListener('click', shut);

  refresh();
  return { el, setCurrent, refresh, open, close: () => close(false), get isOpen() { return isOpen; }, get current() { return cur; }, chip, list };
}
