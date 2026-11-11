// nowcast/cardfold.js - v018: the forecast card folds above the time bar. Folded it is one line, a button: the place and the key
// sentence ("Wallowa, OR · Next 90 min here: hail 4 %, ..."); a tap opens today's whole card (BEAM's chips, Run BEAM now, the examples,
// Keep fresh, the flags) and the chevron folds it again. The NWS warning banner above it never folds away (the view keeps it outside).
'use strict';
import { icon } from './icons.js';

/** the first sentence of a card's words (a full stop followed by a space and a capital ends it; 4.5 or "12 %;" do not) */
export function keySentence(text, max = 180) {
  const t = String(text || '').replace(/\s+/g, ' ').trim(); if (!t) return '';
  const m = /^(.+?[.!?])(?=\s+[A-Z(“"]|$)/.exec(t), s = m ? m[1] : t;
  return s.length > max ? s.slice(0, max - 1).trimEnd() + '…' : s;
}
/** -> { toggle, key, set(open, tell = true), setKey(text), get open } */
export function createFold({ card, head, body, place, doc = globalThis.document, open = false, onToggle = () => {} } = {}) {
  const mk = (tag, cls, text) => { const e = doc.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  const toggle = mk('button', 'nc-fold'); toggle.type = 'button';
  const key = mk('span', 'nc-key'), hint = mk('span', 'vh');
  if (!body.id) body.id = 'nc-card-body';
  toggle.setAttribute('aria-controls', body.id);
  toggle.append(icon('chevup', 'nc-ic sm nc-chev', 18), place, key, hint);
  head.prepend(toggle);
  let isOpen = false;
  function set(o, tell = true) {
    isOpen = !!o; card.classList.toggle('collapsed', !isOpen);
    toggle.setAttribute('aria-expanded', String(isOpen)); hint.textContent = isOpen ? ', fold the card' : ', show the whole card';
    if (tell) onToggle(isOpen);
  }
  toggle.addEventListener('click', () => set(!isOpen, true));
  set(open, false);
  return { toggle, key, set, setKey(text) { key.textContent = keySentence(text); }, get open() { return isOpen; } };
}
