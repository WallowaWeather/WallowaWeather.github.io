// dlall.js - Wallowa Weather's "Download all" (Josh, Nov-08-2026: "Since we are working from 3 models they should have a download all
// button with an advisement the amount of data and that it would be faster on WiFi. That landed bubble should be nearly the first thing
// they see after the add to homescreen instruction page"). The three forecast models with their sizes and the total, a Wi-Fi note
// (stronger on cellular or with Data Saver on), a check that the phone has room, then the downloads one after another with one
// progress bar and a tick per model. A bubble once (an installed app's first launch, or after the landing's "Continue in the browser"),
// and again as Settings › Download all. No model can run here (no WebGPU): it says so instead of offering them.
// v019 (Josh, Nov-09-2026: "County map download should be lumped with model downloads"): the county map is one more line, after the
// models (it no longer downloads by itself): its size in the total, the Wi-Fi note and the room check; it needs no WebGPU, so a phone
// that can't run the models is still offered it. Its line comes from the app (models() with id 'map', its own name and short line).
// The downloads are a queue (Josh: "Not in parallel"): one at a time, each only once the one before has settled; one that stops short
// does not stop the rest, and the end names what stopped.
// The sizes are the app's own (ww.js: each pack's byte count once its list is read, else its known size; DGMR's is the low-memory
// model's when this phone gets that one; the map's: offline.js's plan). Plain functions first (tests/landing_test.mjs), then the view.
// Styles: landing.css (dl-).
//   const D = createDownloadAll({ models() -> [{ id, bytes, have, ready, downloading, pct, precision?, name?, short? }], caps() -> Promise<{ id: { supported, reason } }>,
//                                 download(id, { signal }) -> Promise, estimate() -> Promise<{ quota, usage }>, connection() -> navigator.connection,
//                                 device() -> { ios, installed } });
//   D.open() (the bubble) · D.build(el) (inside Settings) · D.sub() (Settings' row) · D.plan() · D.caps()
'use strict';
import { modelById, modelIcon, glyph } from './nowcast/models_info.js';

/** the order they download in: the models smallest first, so one is ready within a minute; v019: then the county map */
export const ORDER = ['beam', 'dgmr', 'stormscope', 'map'];
const NB = ' ';   // "356 MB" never splits
export const mbOf = (bytes) => Math.round((bytes || 0) / 1e6);
export const sizeText = (mb) => (mb >= 1000 ? `${(mb / 1000).toFixed(1)}${NB}GB` : `${mb}${NB}MB`);

/** list (the app's model states, v019: and the map's) -> { items: [{ id, name, short, model, mb, needMb, need, ready, skip, why, low }],
 *  needMb, needBytes, allReady, todo, anyRuns (a model runs here) } */
export function planDownloads(list, caps = {}) {
  const items = [];
  for (const id of ORDER) {
    const s = (list || []).find((x) => x.id === id); if (!s) continue;
    const m = modelById(id), c = caps[id] || { supported: true };
    const ready = !!s.ready, skip = !ready && c.supported === false, bytes = s.bytes || 0;
    const need = ready || skip ? 0 : Math.max(0, bytes - (s.have || 0));
    items.push({ id, name: m ? m.name : s.name || id, short: m ? m.short : s.short || '', model: !!m, mb: mbOf(bytes), need, needMb: need ? Math.max(1, mbOf(need)) : 0,
      ready, skip, why: skip ? c.reason || '' : '', low: s.precision === 'int8' });
  }
  const todo = items.filter((i) => !i.ready && !i.skip);
  return { items, todo, needMb: todo.reduce((a, i) => a + i.needMb, 0), needBytes: todo.reduce((a, i) => a + i.need, 0), allReady: !todo.length, anyRuns: items.some((i) => i.model && !i.skip) };
}
/** v019: what is on this phone once nothing is left to do, in words (the three models, as before; with the map listed, it too) */
export function readyWords(p) {
  const map = p.items.some((i) => !i.model);
  if (!map) return 'All three are on this phone';
  return p.anyRuns ? 'The forecast models and the county map are on this phone' : 'The county map is on this phone';
}
/** names in a sentence: "DGMR", "DGMR and StormScope", "BEAM, DGMR and StormScope" */
export const inWords = (names) => (names.length < 2 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`);
/** the Wi-Fi note: { kind: 'strong' | 'ok' | 'plain', text } from navigator.connection (Chrome on Android has it; Safari doesn't) */
export function netAdvice(conn, mb) {
  const c = conn || {}, size = sizeText(mb);
  if (c.saveData) return { kind: 'strong', text: `Data Saver is on. This is about ${size}: wait for Wi-Fi if you can. It's faster and saves your data plan.` };
  if (c.type === 'cellular') return { kind: 'strong', text: `You're on cellular data. This is about ${size} of your data plan: Wi-Fi is faster and saves it.` };
  if (c.type === 'wifi' || c.type === 'ethernet') return { kind: 'ok', text: `About ${size}. You're on Wi-Fi: good.` };
  return { kind: 'plain', text: `About ${size}. Use Wi-Fi: it's faster and saves your data plan.` };
}
/** room for them? est = navigator.storage.estimate() -> '' (yes, or not known) | why not, in words */
export function roomCheck(est, needBytes) {
  if (!est || !est.quota) return '';
  const free = est.quota - (est.usage || 0);
  if (free >= needBytes + 50e6) return '';
  return `Not enough room: the downloads need about ${sizeText(Math.ceil(needBytes / 1e6))} and this phone lets the app have about ${sizeText(Math.max(0, Math.floor(free / 1e6)))} more. Free some space, then try again.`;
}
/** one progress for them all (0-1): what came in since the start over what was needed then */
export function combined(start, list) {
  let need = 0, got = 0;
  for (const it of (start && start.todo) || []) {
    const s = (list || []).find((x) => x.id === it.id) || {}, bytes = s.bytes || it.need;
    const have0 = Math.max(0, bytes - it.need), now = s.ready ? bytes : s.downloading ? (s.pct || 0) * bytes : Math.max(have0, s.have || 0);
    need += it.need; got += Math.min(it.need, Math.max(0, now - have0));
  }
  return need ? Math.min(1, got / need) : 1;
}
/** no model can run here: what to say (dev: { ios, android }) */
export function noGpuWords(dev, caps) {
  const why = Object.values(caps || {}).map((c) => c.reason || '').join(' ');
  const chip = /limits|graphics chip/.test(why) && !/WebGPU/.test(why);
  const what = dev && dev.ios ? 'iPhone' : 'phone';
  if (chip) return `This ${what}'s graphics chip can't run the forecast models.`;
  const how = dev && dev.ios ? 'Update to iOS 26 or later (Settings › General › Software Update).' : dev && dev.android ? 'Update Chrome (121 or later, on Android 12 or later).' : 'Use a recent Safari, Chrome or Edge.';
  return `The forecast models need WebGPU, and this browser doesn't have it. ${how}`;
}

// ---------------------------------------------------------------------------------------------- the runner + the view
export function createDownloadAll(hooks) {
  const call = (f, ...a) => { try { return typeof f === 'function' ? f(...a) : undefined; } catch (e) { return undefined; } };
  const list = () => call(hooks.models) || [];
  const R = { phase: 'idle', current: null, msg: '', start: null, ctl: null };   // phase: idle | checking | running | stopped | failed | done | noroom
  let capsP = null, caps = null, pollT = 0;
  const views = new Set();
  const getCaps = () => capsP || (capsP = Promise.resolve(call(hooks.caps)).then((c) => (caps = c || {}), () => (caps = {})));
  const plan = () => planDownloads(list(), caps || {});
  const paint = () => { for (const v of [...views]) { if (v.el.isConnected === false) views.delete(v); else v.paint(); } };
  function poll() { clearTimeout(pollT); if (R.phase === 'running' && views.size) pollT = setTimeout(() => { paint(); poll(); }, 500); }

  async function start() {
    if (R.phase === 'running' || R.phase === 'checking') return;
    await getCaps();
    const p = plan(); if (!p.todo.length) { R.phase = 'done'; paint(); return; }
    R.phase = 'checking'; R.msg = ''; paint();
    let est = null; try { est = await call(hooks.estimate); } catch (e) { est = null; }
    const room = roomCheck(est, p.needBytes);
    if (room) { R.phase = 'noroom'; R.msg = room; paint(); return; }
    R.ctl = new AbortController(); R.start = p; R.phase = 'running'; paint(); poll();
    // v019 (Josh, Nov-09-2026: "Download all likely needs to be a queue of downloads. Not in parallel"): one at a time, in ORDER (the
    // models, then the county map); each starts once the one before has settled and no model is downloading by its own button; one that
    // stops short does not stop the rest (until v018 it did): the end names what stopped
    const signal = R.ctl.signal, stopped = [], stateOf = (id) => list().find((x) => x.id === id) || {};
    for (const it of p.todo) {
      if (signal.aborted) break;
      R.current = null; await quiet(signal); if (signal.aborted) break;
      if (stateOf(it.id).ready) continue;   // finished meanwhile (its own button)
      R.current = it.id; paint();
      try { await hooks.download(it.id, { signal }); } catch (e) { /* ww.js says what went wrong */ }
      if (!stateOf(it.id).ready && !signal.aborted) stopped.push(it.name);
    }
    R.current = null; R.msg = '';
    if (signal.aborted) R.phase = 'stopped';
    else if (stopped.length) { R.phase = 'failed'; R.msg = `${inWords(stopped)} stopped before ${stopped.length > 1 ? 'they' : 'it'} finished. Tap Download all to carry on: what came in is kept.`; }
    else R.phase = 'done';
    paint();
  }
  /** v019: resolves once no model on the list is downloading (one started by its own button in Settings finishes first), or at Cancel */
  function quiet(signal) {
    return new Promise((res) => { (function look() { if (signal.aborted || !list().some((x) => x.downloading && modelById(x.id))) res(); else setTimeout(look, 400); })(); });
  }
  function cancel() { if (R.ctl && R.phase === 'running') R.ctl.abort(); }

  /** the view, into el (the bubble's box, or Settings' page); o: { modal, onClose } */
  function build(el, o = {}) {
    const doc = el.ownerDocument || document;
    const mk = (t, c, x) => { const e = doc.createElement(t); if (c) e.className = c; if (x != null) e.textContent = x; return e; };
    const btn = (c, x) => { const b = mk('button', c, x); b.type = 'button'; return b; };
    const root = mk('div', 'dl' + (o.modal ? ' dl-modal' : '')); el.append(root);
    const v = { el: root, paint: () => {} }; views.add(v);
    root.append(mk('p', 'dl-wait', 'Checking this phone…'));
    getCaps().then(() => { draw(); });
    function draw() {
      root.textContent = '';
      const p = plan(), dev = call(hooks.device) || {}, more = p.items.filter((i) => !i.model);   // more: v019's county map
      if (!p.anyRuns) {   // no WebGPU (or a chip too small for all three): say so; v019: the map needs no WebGPU, so it is still offered
        if (o.modal) { const h = mk('h2', 'dl-h', 'The forecasts can\'t run here'); h.id = 'dl-h'; root.append(h); }
        root.append(mk('p', 'dl-lead', noGpuWords(dev, caps)), mk('p', 'dl-lead', 'The NWS forecast, warnings and radar all work without them.'));
        if (!more.length) {
          if (o.modal) { const b = btn('nc-btn', 'OK'); b.addEventListener('click', () => close()); const row = mk('div', 'dl-btns'); row.append(b); root.append(row); }
          v.paint = () => {}; return;
        }
      } else {
        if (o.modal) { const h = mk('h2', 'dl-h', 'Get the forecast models'); h.id = 'dl-h'; root.append(h); }
        root.append(mk('p', 'dl-lead', `Wallowa Weather works out its forecasts on this phone, with three models. Download them${more.length ? ' and the county map' : ''} once; they stay on this phone.`));
      }
      const ul = mk('ul', 'dl-list'), rows = new Map();
      for (const it of p.anyRuns ? p.items : more) {
        const m = modelById(it.id), li = mk('li', 'dl-item'), tile = mk('span', 'st-tile dl-tile' + (m ? '' : ' st-tile-plain')); if (m) tile.dataset.model = m.tint || it.id;
        tile.append(m ? modelIcon(m, 'st-ic', 20, doc) : glyph('map', 'st-ic', 20, doc));   // v019: the map's picture, as Settings' map rows
        const t = mk('span', 'dl-t'); t.append(mk('b', 'dl-name', it.name), mk('span', 'dl-what', it.short + (it.low ? ' · the low-memory version, for this phone' : '')));
        const st = mk('span', 'dl-st'); li.append(tile, t, st); ul.append(li); rows.set(it.id, { li, st });
      }
      const total = mk('li', 'dl-total'); ul.append(total); root.append(ul);
      const net = mk('p', 'dl-net'), safari = dev.ios && !dev.installed ? mk('p', 'dl-fine', 'In Safari, these are kept for Safari only. For the Home Screen app, open it from its icon and download them there.') : null;
      const bar = mk('div', 'st-bar dl-bar'), barI = mk('i'), prog = mk('p', 'dl-prog'), msg = mk('p', 'dl-msg'), btns = mk('div', 'dl-btns'), later = o.modal ? mk('p', 'dl-fine', 'Later: Settings (the gear) › Download all.') : null;
      bar.append(barI); root.append(net); if (safari) root.append(safari); root.append(bar, prog, msg, btns); if (later) root.append(later);
      let shown = '';
      v.paint = () => {
        const L = list(), q = plan(), running = R.phase === 'running' || R.phase === 'checking';
        for (const it of q.items) {
          const r = rows.get(it.id); if (!r) continue;
          const s = L.find((x) => x.id === it.id) || {}, cur = R.phase === 'running' && R.current === it.id;
          r.li.classList.toggle('dl-now', cur); r.li.classList.toggle('dl-done', it.ready); r.st.textContent = ''; r.st.className = 'dl-st';
          if (it.ready) { r.st.classList.add('dl-ok'); r.st.append(glyph('check', 'dl-ck', 18, doc), mk('span', null, 'Ready')); }
          else if (it.skip) { r.st.classList.add('dl-no'); r.st.textContent = 'Not for this phone'; }
          else if (cur && s.downloading) { r.st.classList.add('dl-busy'); r.st.textContent = `${Math.floor(100 * (s.pct || 0))}%`; }
          else r.st.textContent = sizeText(it.mb);
        }
        const t = running && R.start ? R.start : q, adv = netAdvice(call(hooks.connection), q.needMb);   // while it runs: the total it started with
        total.textContent = ''; total.hidden = q.allReady;
        // v019: "In all" while nothing is in yet (what can't run here doesn't count: no WebGPU, the map alone is still "In all")
        total.append(mk('span', null, t === R.start || t.todo.length === t.items.filter((i) => !i.skip).length ? 'In all' : 'Still to download'), mk('b', null, sizeText(t.needMb)));
        if (later) later.hidden = q.allReady;
        net.textContent = adv.text; net.className = 'dl-net dl-' + adv.kind; net.hidden = q.allReady || running;
        const f = running && R.start ? combined(R.start, L) : R.phase === 'done' ? 1 : 0;
        bar.hidden = !(running || R.phase === 'stopped' || R.phase === 'failed') || !R.start; barI.style.transform = `scaleX(${f})`;
        const cur = R.current && R.start ? R.start.todo.findIndex((x) => x.id === R.current) : -1;
        prog.textContent = R.phase === 'checking' ? 'Checking there is room…' : R.phase === 'running' && cur >= 0
          ? `Downloading ${R.start.todo[cur].name} · ${cur + 1} of ${R.start.todo.length} · ${sizeText(Math.round(f * R.start.needMb))} of ${sizeText(R.start.needMb)}. Keep the app open.`
          : R.phase === 'stopped' ? 'Stopped. What finished stays on this phone; Download all carries on from there.' : R.phase === 'done' && q.allReady ? `${readyWords(q)}.` : '';
        prog.hidden = !prog.textContent;
        msg.textContent = R.phase === 'noroom' || R.phase === 'failed' ? R.msg : ''; msg.hidden = !msg.textContent;
        const key = [R.phase, q.allReady].join(':'); if (key === shown) return; shown = key;
        btns.textContent = '';
        if (R.phase === 'checking') { const w = btn('nc-btn', 'Checking…'); w.disabled = true; btns.append(w); }
        else if (running) {
          const c = btn('nc-btn ghost', 'Cancel'); c.addEventListener('click', () => cancel()); btns.append(c);
          if (o.modal) { const h = btn('nc-btn ghost dl-plain', 'Hide'); h.addEventListener('click', () => close()); h.title = 'The downloads keep going'; btns.append(h); }
        } else if (q.allReady) { if (o.modal) { const d = btn('nc-btn', 'Done'); d.addEventListener('click', () => close()); btns.append(d); } }
        else {
          const go = btn('nc-btn', `Download all · ${sizeText(q.needMb)}`); go.addEventListener('click', () => { start(); }); btns.append(go);
          if (o.modal) { const n = btn('nc-btn ghost dl-plain', 'Not now'); n.addEventListener('click', () => close()); btns.append(n); }
        }
      };
      v.paint(); poll();
    }
    function close() { views.delete(v); clearTimeout(pollT); poll(); if (o.onClose) o.onClose(); }
    return { root, close };
  }

  /** the bubble, over the map */
  function open({ doc = document } = {}) {
    if (doc.querySelector('.dl-scrim')) return;
    const scrim = doc.createElement('div'); scrim.className = 'dl-scrim';
    const box = doc.createElement('div'); box.className = 'dl-bubble'; box.setAttribute('role', 'dialog'); box.setAttribute('aria-modal', 'true'); box.setAttribute('aria-labelledby', 'dl-h');
    scrim.append(box); doc.body.append(scrim);
    const shut = () => { scrim.remove(); doc.removeEventListener('keydown', esc); };
    const esc = (e) => { if (e.key === 'Escape' && R.phase !== 'running') v.close(); };
    const v = build(box, { modal: true, onClose: shut });
    doc.addEventListener('keydown', esc);
    scrim.addEventListener('click', (e) => { if (e.target === scrim && R.phase !== 'running' && R.phase !== 'checking') v.close(); });
    requestAnimationFrame(() => scrim.classList.add('on'));
  }
  /** Settings' row: what is left, in a few words (v019: no model runs here but the map is listed: the map) */
  function sub() {
    const p = plan();
    if (caps && !p.anyRuns && !p.items.some((i) => !i.model)) return 'This phone can\'t run them';
    if (R.phase === 'running') return 'Downloading…';
    return p.allReady ? readyWords(p) : `${p.todo.map((i) => i.name).join(', ')} · about ${sizeText(p.needMb)}`;
  }
  return { open, build, sub, plan, caps: getCaps, start, cancel, get phase() { return R.phase; }, get msg() { return R.msg; } };
}
