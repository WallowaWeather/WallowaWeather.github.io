// landing.js - Wallowa Weather's first run (Josh, Nov-08-2026: "we need a landing page ... whereas it instructs Safari and chrome users
// how to add to Home Screen or install"; "a small bar at the bottom with copy right noting Joshua Hughes"). In a browser tab (not
// installed) the first screen is this page, once: the app's name, what it is, the install steps for this browser (install.js works out
// which), a quiet "Continue in the browser". The map waits behind it: nothing is fetched for the map until then. Also here: which
// first-run screen comes when (startScreen, offerBubble: plain functions, tests/landing_test.mjs) and the copyright bar under the map.
// Styles: landing.css (ld-, ww-foot). The download-all bubble is dlall.js.
'use strict';
import { deviceOf, forecastHere, stepsFor } from './install.js';
import { EXPERIMENTAL } from './nowcast/models_info.js';

/** the logo slot: one image (a logo is being designed: swap this file) */
export const LOGO = 'logo-256.png';   // the Echo logo (topo of the Wallowa range + WW as radar echoes), 256 px for 2x screens
export const COPYRIGHT = '© 2026 Joshua Hughes · Wallowa Weather';
export const LEAD = 'Free, public-good storm forecasts that run on your phone.';
/** localStorage keys: the landing passed, the old install guide seen (v008: counts as passed), the download-all bubble shown */
export const KEYS = { landing: 'ww:landingDone', guide: 'ww:guideSeen', bubble: 'ww:dlAllSeen' };

/** the first screen -> 'landing' (a browser tab that has not been past it) | 'app' (installed, or seen before). seen(key) -> bool */
export function startScreen({ installed, seen = () => false }) {
  if (installed) return 'app';
  return seen(KEYS.landing) || seen(KEYS.guide) ? 'app' : 'landing';
}
/** after the landing (or an installed app's first launch): show the download-all bubble now? Once: `seen` = it was shown before.
 *  plan: dlall.js planDownloads(); noGpu: no model can run here (the bubble then says so, once); online: navigator.onLine */
export function offerBubble({ seen, plan, noGpu = false, online = true }) {
  if (seen || !online) return false;   // offline: not now, and not counted as shown
  if (noGpu) return true;
  return !!plan && !plan.allReady;
}

/** the steps for this browser, as parts: a string, { ic: 'share' | 'add' } (an inline picture) or { b: 'words' } (bold).
 *  d = install.js deviceOf(), cap = forecastHere(), g = stepsFor(d, cap) (its words and its Install button for every other browser)
 *  -> { title, steps: [[part]], button?: { label, run }, note, cap: { ok, text } } */
export function landingSteps(d, cap, g) {
  const name = d.ipad ? 'iPad' : 'iPhone', c = cap || {}, out = { title: g.title, steps: g.steps.map((s) => [s]), button: g.button || null, note: g.note || '', cap: capLine(d, c) };
  if (/is installed/.test(g.title)) return out;
  if (!c.ok && /WebGPU|graphics chip|forecast needs/.test(out.note)) out.note = '';   // the line under the card says it
  const keep = `Then download the forecast models in the app, not here: your ${name} keeps the Home Screen app's storage apart from Safari's.`;
  if (d.os === 'ios' && d.browser !== 'safari' && d.browser !== 'chrome') {   // Firefox, Edge on the iPhone: Safari adds it
    out.title = 'Open in Safari to install'; out.steps = [['Copy this page\'s address, open it in Safari, then follow the steps there.']]; out.note = ''; out.button = null;
  } else if (d.os === 'ios' && d.browser === 'safari') {
    out.title = `Add it to your ${name}'s Home Screen`;
    out.steps = [
      d.ipad ? ['Tap ', { ic: 'share' }, ' ', { b: 'Share' }, ' at the top right.'] : ['Tap ', { ic: 'share' }, ' ', { b: 'Share' }, '. On iOS 26, tap ⋯ at the bottom right first.'],
      ['Tap ', { ic: 'add' }, ' ', { b: 'Add to Home Screen' }, '. Scroll down if you don\'t see it.'],
      ['Leave ', { b: 'Open as Web App' }, ' on, then tap ', { b: 'Add' }, '.'],
      ['Open Wallowa Weather from its new icon.'],
    ];
    out.note = keep; out.button = null;
  } else if (d.os === 'ios' && d.browser === 'chrome') {
    out.title = `Add it to your ${name}'s Home Screen`;
    out.steps = [['Tap ', { ic: 'share' }, ' ', { b: 'Share' }, ' in the address bar.'], ['Tap ', { ic: 'add' }, ' ', { b: 'Add to Home Screen' }, ', then ', { b: 'Add' }, '.'], ['Open Wallowa Weather from its new icon.']];
    out.note = keep; out.button = null;
  }
  return out;
}
/** can the forecasts run here, in one line (and what still works when they can't) */
export function capLine(d, cap) {
  const what = d.os === 'ios' ? (d.ipad ? 'iPad' : 'iPhone') : d.os === 'android' ? 'phone' : 'computer';
  if (cap.ok) return { ok: true, text: `This ${what} can run the forecasts itself.` };
  const still = 'The NWS forecast, warnings and radar work without it.';
  if (cap.why === 'no-adapter' || cap.why === 'limits') return { ok: false, text: `This ${what}'s graphics chip can't run the forecasts. ${still}` };
  const how = d.os === 'ios' ? 'iOS 26 or later (Settings › General › Software Update)' : d.os === 'android' ? 'Chrome 121 or later on Android 12 or later' : 'a recent Safari, Chrome or Edge';
  return { ok: false, text: `The forecasts need WebGPU: ${how}. ${still}` };
}

// ---------------------------------------------------------------------------------------------- the page
const NS = 'http://www.w3.org/2000/svg';
const PICS = {   // Safari's Share button (a box with an arrow up) and Add to Home Screen (a plus in a box), drawn for the steps
  share: ['M12 3.6v10.6', 'M8.4 7.1 12 3.6l3.6 3.5', 'M9.2 9.6H7.6a1.6 1.6 0 0 0-1.6 1.6v7.2a1.6 1.6 0 0 0 1.6 1.6h8.8a1.6 1.6 0 0 0 1.6-1.6v-7.2a1.6 1.6 0 0 0-1.6-1.6h-1.6'],
  add: ['M7.5 4.5h9a3 3 0 0 1 3 3v9a3 3 0 0 1-3 3h-9a3 3 0 0 1-3-3v-9a3 3 0 0 1 3-3Z', 'M12 8.5v7M8.5 12h7'],
};
function pic(name, doc) {
  const s = doc.createElementNS(NS, 'svg');
  for (const [k, v] of [['viewBox', '0 0 24 24'], ['aria-hidden', 'true'], ['class', 'ld-pic'], ['fill', 'none'], ['stroke', 'currentColor'], ['stroke-width', '1.8'], ['stroke-linecap', 'round'], ['stroke-linejoin', 'round']]) s.setAttribute(k, v);
  for (const d of PICS[name] || []) { const p = doc.createElementNS(NS, 'path'); p.setAttribute('d', d); s.append(p); }
  return s;
}
/** a step's parts into a node; the menu buttons in the words (⋯ ⋮ ≡) become small keys, as on the screen */
function fill(el, parts, doc) {
  for (const p of parts) {
    if (typeof p === 'string') {
      for (const bit of p.split(/([⋯⋮≡])/)) { if (!bit) continue; if (/^[⋯⋮≡]$/.test(bit)) { const k = doc.createElement('span'); k.className = 'ld-key'; k.textContent = bit; el.append(k); } else el.append(bit); }
    } else if (p.ic) { const k = doc.createElement('span'); k.className = 'ld-key ld-key-ic'; k.append(pic(p.ic, doc)); el.append(k); }
    else if (p.b) { const b = doc.createElement('b'); b.textContent = p.b; el.append(b); }
  }
  return el;
}

/** the landing, over everything, until "Continue in the browser" -> Promise (resolves then). Android: Chrome's own install prompt can come
 *  late (install.js keeps it): the page draws again when it does, and when the app is installed. */
export function showLanding({ doc = document, diag = () => {} } = {}) {
  const mk = (t, c, x) => { const e = doc.createElement(t); if (c) e.className = c; if (x != null) e.textContent = x; return e; };
  const wrap = mk('div', 'ld'); wrap.setAttribute('role', 'dialog'); wrap.setAttribute('aria-modal', 'true'); wrap.setAttribute('aria-labelledby', 'ld-name');
  const inner = mk('div', 'ld-in'), head = mk('header', 'ld-head'), logo = mk('img', 'ld-logo');
  logo.src = LOGO; logo.alt = ''; logo.width = 84; logo.height = 84; logo.decoding = 'async';
  const h1 = mk('h1', 'ld-name', 'Wallowa Weather'); h1.id = 'ld-name';
  head.append(logo, h1, mk('p', 'ld-lead', LEAD), mk('p', 'ld-exp', EXPERIMENTAL));
  const card = mk('section', 'ld-card'), capP = mk('p', 'ld-cap'), cont = mk('button', 'ld-cont', 'Continue in the browser'); cont.type = 'button';
  inner.append(head, card, capP, cont);
  wrap.append(inner, mk('footer', 'ld-foot', COPYRIGHT));
  doc.body.append(wrap); doc.documentElement.classList.add('ld-on');
  let cap = { ok: false, why: 'checking' };
  const d = deviceOf();
  function draw() {
    if (!wrap.isConnected) return;
    const L = landingSteps(d, cap, stepsFor(d, cap));
    card.textContent = '';
    const h2 = mk('h2', 'ld-h', L.title); card.append(h2);
    const ol = mk('ol', 'ld-steps'); for (const s of L.steps) { const li = mk('li'); li.append(fill(mk('span', 'ld-step'), s, doc)); ol.append(li); } card.append(ol);
    if (L.button) {
      const b = mk('button', 'ld-cta', L.button.label); b.type = 'button';
      b.addEventListener('click', async () => { b.disabled = true; try { await L.button.run(); } catch (e) { /* */ } diag('landing install prompt'); setTimeout(draw, 0); });
      card.append(b);
    }
    if (L.note) card.append(mk('p', 'ld-note', L.note));
    capP.textContent = cap.why === 'checking' ? '' : L.cap.text; capP.classList.toggle('ld-cap-no', cap.why !== 'checking' && !L.cap.ok);
  }
  const again = () => setTimeout(draw, 0);   // after install.js has kept the prompt (its listener runs first)
  addEventListener('beforeinstallprompt', again); addEventListener('appinstalled', again);
  draw();
  forecastHere().then((c) => { cap = c; draw(); });
  return new Promise((res) => {
    cont.addEventListener('click', () => {
      removeEventListener('beforeinstallprompt', again); removeEventListener('appinstalled', again);
      wrap.remove(); doc.documentElement.classList.remove('ld-on'); res();
    });
  });
}

/** the copyright bar under the map: quiet, above the phone's home bar; a tap opens About (the licence is there) */
export function copyrightBar({ onOpen, doc = document } = {}) {
  const b = doc.createElement('button'); b.type = 'button'; b.className = 'ww-foot'; b.textContent = COPYRIGHT;
  b.setAttribute('aria-label', `${COPYRIGHT}. About and the licence`);
  if (onOpen) b.addEventListener('click', onOpen);
  return b;
}
