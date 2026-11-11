// nowcast/settings.js - the Settings sheet behind the gear under Layers (each model's strengths and
// weaknesses, and deleting it; settings are not layers). Pages, pushed inside the same sheet with a Back button: Settings (the list),
// each model (what it does, strengths, weaknesses, size, status, Download / Delete with a confirm, licence), Map data and credits (moved
// off the map), Install the app, About, Diagnostics. Styles: settings.css (st-); the model facts: models_info.js.
//   const gear = createGearButton({ onClick: () => openSheet((b) => { ctl = buildSettings(b, hooks); }, 'settings') });
//   hooks = { models: { beam|stormscope|dgmr: { status() -> { ready, downloading, pct, bytes, note, error }, size() -> bytes, download(), del(), extra?(el) } },
//             current?() -> id, onUse?(id), credits() -> Node, notes: [string], installGuide(el), installed?() -> bool, diagnostics(el), version, about?: [string], start?: 'model:beam' | 'credits' | ...,
//             counties?: { list() -> [{ id, name, kept, line, frac (0-1 while saving, else null), savedMb }], set(id, on), busy() -> bool },
//             fresh?: { value() -> 'Off' | '30 min' ..., sub, build(el) } (Nov-08: "Keep forecasts fresh", cadence.js: a Data row and its page),
//             downloadAll?: { sub() -> words, build(el) } (LANDING, Nov-08: "Download all", a row under the models and its page, dlall.js;
//               v019: it holds the county map too, so no longer "Download all models") }
// v014: Counties (when hooks.counties is given): the app's counties, each with its saved map's state and a switch to keep its maps on this
// phone (switching one off asks first, then deletes its saved map).
// BENCH TEST (Nov-08, Josh: "I need a bench test button in settings"): hooks.bench(el) fills Settings › Bench test (view.js -> bench.js).
'use strict';
import { MODELS, modelById, modelIcon, glyph, statusText, EXPERIMENTAL, FOLLOW_NWS } from './models_info.js';

const MB = (b) => `${Math.round((b || 0) / 1e6).toLocaleString('en-US')} MB`;   // a no-break space: "356 MB" never splits
/** a list in a sentence: "Hail, strong storm cores, lightning" (capitals kept for names such as NOAA) */
const inLine = (items) => items.map((t, i) => (i && /^[A-Z][a-z]/.test(t) ? t.charAt(0).toLowerCase() + t.slice(1) : t)).join(', ');
const call = (f, ...a) => { try { return typeof f === 'function' ? f(...a) : undefined; } catch (e) { return undefined; } };

/** the size line: "about 30 MB" for a placeholder size (BEAM), "356 MB" otherwise */
export function sizeWords(model, bytes) {
  if (bytes) return model && model.stage === 'examples' ? `about ${MB(bytes)}` : MB(bytes);
  return model && model.sizeMB ? `about ${model.sizeMB} MB` : 'not known yet';
}
/** a model's state in one sentence (the model page) */
export function statusLine(st, model, bytes) {
  const s = st || {}, m = model || {}, size = bytes || s.bytes || (m.sizeMB ? m.sizeMB * 1e6 : 0);
  if (s.downloading) return `Downloading · ${Math.floor(100 * (s.pct || 0))}%${size ? ` of ${MB(size)}` : ''}. Keep the app open.`;
  if (s.ready) return `On this phone${size ? ` · ${MB(size)}` : ''}.`;
  if (m.stage === 'examples') return m.stageNote || 'Shows recorded example storms for now.';
  if (s.error) return `The download can't be reached right now: ${String(s.error).slice(0, 90)}`;
  return `Not on this phone yet${size ? ` · a ${MB(size)} download, once` : ''}.`;
}
/** what the action button does for a state: 'busy' | 'delete' | 'download' | 'none' */
export function actionOf(st, hook) {
  const s = st || {}, h = hook || {};
  if (s.downloading) return 'busy';
  if (s.ready) return typeof h.del === 'function' ? 'delete' : 'none';
  return typeof h.download === 'function' ? 'download' : 'none';
}

/** the round gear button (same look as Layers: nc-round) */
export function createGearButton({ onClick = null, doc = document } = {}) {
  const b = doc.createElement('button'); b.type = 'button'; b.className = 'nc-round st-gear'; b.setAttribute('aria-label', 'Settings');
  b.append(glyph('gear', 'nc-ic st-gear-ic', 24, doc));
  if (onClick) b.addEventListener('click', onClick);
  return b;
}

/** renders the Settings pages into `body` (the sheet's body) -> { show(page, arg), back(), refresh(), get page } */
export function buildSettings(body, hooks = {}, { doc = document, models = MODELS } = {}) {
  const mk = (tag, cls, text) => { const e = doc.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  const btn = (cls, text) => { const b = mk('button', cls, text); b.type = 'button'; return b; };
  const link = (text, href) => { const a = mk('a', 'st-link', text); a.href = href; a.target = '_blank'; a.rel = 'noopener'; return a; };
  const H = hooks.models || {};
  const statusOf = (id) => call(H[id] && H[id].status) || {};
  const sizeOf = (id) => call(H[id] && H[id].size) || 0;
  const root = mk('div', 'st'); body.append(root);
  const stack = [];
  let live = null, pollT = 0;

  const TITLES = { main: 'Settings', counties: 'Counties', credits: 'Map data and credits', install: 'Install the app', about: 'About', diag: 'Diagnostics', fresh: 'Keep forecasts fresh' };
  TITLES.report = 'Field report';   // FIELD REPORT (fieldkit): hooks.fieldReport(el) fills the page (view.js -> report.js)
  TITLES.tune = 'Speed tune';   // SPEED TUNE (nowcast/tune/ui.js): hooks.tune = { sub, value(), build(el) }
  TITLES.dlall = 'Download all';   // LANDING: hooks.downloadAll = { sub() -> words, build(el) } (dlall.js, the first-run bubble again; v019: models + county map)
  TITLES.bench = 'Bench test';   // BENCH TEST: hooks.bench(el) fills the page (view.js -> bench.js)
  TITLES.share = 'Share the app';   // 1.0.2: hooks.share = { build(el) }, the app's address as a QR code a friend scans
  const titleOf = (e) => (e.page === 'model' ? (modelById(e.arg) || {}).name || 'Model' : TITLES[e.page] || 'Settings');
  const scroller = () => (body.closest ? body.closest('.nc-sheet-box') : null) || body.parentElement || null;

  function show(page, arg = null, { push = true } = {}) {
    const sc = scroller();
    if (stack.length) stack[stack.length - 1].scroll = sc ? sc.scrollTop : 0;
    if (push || !stack.length) stack.push({ page, arg, scroll: 0 }); else stack[stack.length - 1] = { page, arg, scroll: 0 };
    render(true); if (sc) sc.scrollTop = 0;
  }
  function back() {
    if (stack.length < 2) return;
    const was = stack.pop(), sc = scroller();
    render(true, was); if (sc) sc.scrollTop = stack[stack.length - 1].scroll || 0;
  }
  function render(focus = false, from = null) {
    live = null; root.textContent = '';
    const e = stack[stack.length - 1];
    root.dataset.page = e.page;
    if (stack.length > 1) {
      const b = btn('st-back'); b.append(glyph('back', 'st-gl', 18, doc), mk('span', null, titleOf(stack[stack.length - 2]))); b.setAttribute('aria-label', `Back to ${titleOf(stack[stack.length - 2])}`);
      b.addEventListener('click', back); root.append(b);
    }
    (PAGES[e.page] || PAGES.main)(root, e.arg);
    if (focus) {
      const ret = from && root.querySelector ? root.querySelector(`[data-go="${from.page === 'model' ? 'model:' + from.arg : from.page}"]`) : null;
      const h = ret || (root.querySelector ? root.querySelector('h2') : null);
      if (h) { if (!ret) h.tabIndex = -1; try { h.focus({ preventScroll: true }); } catch (x) { /* */ } }
    }
    poll();
  }
  function head(text) { const h = mk('h2', 'st-h', text); root.append(h); return h; }
  function group(title) { if (title) root.append(mk('p', 'st-gt', title)); const g = mk('div', 'st-group'); root.append(g); return g; }
  function row(g, { go, ic, model, title, badge, sub, value, valueKind }) {
    const r = btn('st-row'); r.dataset.go = go;
    const tile = mk('span', 'st-tile' + (model ? '' : ' st-tile-plain')); if (model) tile.dataset.model = model.tint || model.id;
    tile.append(model ? modelIcon(model, 'st-ic', 20, doc) : glyph(ic, 'st-ic', 20, doc));
    const t = mk('span', 'st-row-t'), n = mk('span', 'st-row-n'); n.append(mk('b', null, title)); if (badge) n.append(mk('span', 'st-badge', badge));
    t.append(n); if (sub) t.append(mk('span', 'st-row-sub', sub));
    const v = mk('span', 'st-val' + (valueKind ? ' st-k-' + valueKind : ''), value || '');
    r.append(tile, t, v, glyph('chevRight', 'st-chev', 16, doc));
    r.addEventListener('click', () => (go.startsWith('model:') ? show('model', go.slice(6)) : show(go)));
    g.append(r); return { r, v };
  }

  const PAGES = {
    main() {
      head('Settings');
      const g = group('Forecast models'), cur = call(hooks.current);
      const rows = models.map((m) => {
        const s = statusText(statusOf(m.id), m);
        const x = row(g, { go: 'model:' + m.id, model: m, title: m.name, badge: m.id === cur ? 'On the map' : '', sub: m.short, value: s.text, valueKind: s.kind });
        return { m, v: x.v };
      });
      const all = hooks.downloadAll ? row(g, { go: 'dlall', ic: 'download', title: 'Download all', sub: call(hooks.downloadAll.sub) || '' }) : null;   // LANDING
      live = { page: 'main', paint() { for (const r of rows) { const s = statusText(statusOf(r.m.id), r.m); r.v.textContent = s.text; r.v.className = 'st-val st-k-' + s.kind; }
        if (all) { const sub = all.r.querySelector ? all.r.querySelector('.st-row-sub') : null; if (sub) sub.textContent = call(hooks.downloadAll.sub) || ''; } } };   // LANDING
      root.append(mk('p', 'st-note', 'Tap a model to read what it is good and bad at, or to download or delete it.'));
      if (typeof hooks.fieldReport === 'function') row(group('Field test'), { go: 'report', ic: 'flag', title: 'Field report', sub: 'Share what the weather is doing where you are' });   // FIELD REPORT (fieldkit)
      if (hooks.fresh) row(group('Data'), { go: 'fresh', ic: 'refresh', title: 'Keep forecasts fresh', sub: hooks.fresh.sub || '', value: call(hooks.fresh.value) || '' });   // Nov-08
      const a = group('This app');
      if (hooks.share) row(a, { go: 'share', ic: 'share', title: 'Share the app', sub: 'A code a friend scans with their camera' });   // 1.0.2
      if (hooks.counties) row(a, { go: 'counties', ic: 'map', title: 'Counties', sub: 'Keep a county’s maps on this phone' });   // v014
      if (hooks.tune) row(a, { go: 'tune', ic: 'gauge', title: 'Speed tune', sub: hooks.tune.sub || '', value: call(hooks.tune.value) || '' });   // SPEED TUNE
      row(a, { go: 'credits', ic: 'map', title: 'Map data and credits', sub: 'Where the maps, data and models come from' });
      row(a, { go: 'install', ic: 'phone', title: call(hooks.installed) ? 'Installed' : 'Install the app', sub: 'Steps for this phone, tablet or computer' });
      row(a, { go: 'about', ic: 'info', title: 'About', sub: hooks.version || 'Wallowa Weather' });
      if (typeof hooks.bench === 'function') row(a, { go: 'bench', ic: 'gauge', title: 'Bench test', sub: 'How well this phone runs the models' });   // BENCH TEST
      row(a, { go: 'diag', ic: 'pulse', title: 'Diagnostics', sub: 'What happened, to send when something goes wrong' });
      root.append(mk('p', 'st-note', `${EXPERIMENTAL}. ${FOLLOW_NWS}`));
    },
    model(_, id) {
      const m = modelById(id); if (!m) return PAGES.main();
      const hook = H[id] || {};
      const top = mk('div', 'st-mhead'), tile = mk('span', 'st-tile st-tile-lg'); tile.dataset.model = m.tint || m.id; tile.append(modelIcon(m, 'st-ic', 28, doc));
      const tt = mk('div', 'st-mhead-t'), h = mk('h2', 'st-h', m.name); tt.append(h, mk('p', 'st-maker', [m.long !== m.name ? m.long : '', m.long.includes(m.maker) ? '' : m.maker, m.year].filter(Boolean).join(' · ')));
      top.append(tile, tt); root.append(top);
      root.append(mk('p', 'st-exp', EXPERIMENTAL));
      root.append(mk('p', 'st-what', m.what));
      // on this phone: the state, a bar while it downloads, Download / Delete (with a confirm)
      const card = mk('div', 'st-card'), stEl = mk('p', 'st-stat'), bar = mk('div', 'st-bar'), barI = mk('i'), btns = mk('div', 'st-btns'), msg = mk('p', 'st-msg');
      bar.append(barI); bar.hidden = true; msg.hidden = true; card.append(stEl, bar, btns, msg); root.append(card);
      let kind = null, confirming = false;
      const paintBtns = (s) => {
        btns.textContent = ''; const k = actionOf(s, hook), size = sizeOf(id) || s.bytes;
        if (confirming && k === 'delete') {
          const q = mk('p', 'st-confirm', `Delete ${m.name} from this phone?${size ? ` It frees ${MB(size)}.` : ''} You can download it again later.`);
          const yes = btn('nc-btn st-danger-solid', 'Delete'), no = btn('nc-btn ghost', 'Keep it');
          yes.addEventListener('click', async () => {
            yes.disabled = no.disabled = true; yes.textContent = 'Deleting…';
            try { await hook.del(); msg.hidden = true; } catch (e) { msg.hidden = false; msg.textContent = `It wasn't deleted: ${String((e && e.message) || e).slice(0, 100)}`; }
            confirming = false; kind = null; paint();
          });
          no.addEventListener('click', () => { confirming = false; kind = null; paint(); try { del.focus(); } catch (e) { /* */ } });
          btns.append(q, yes, no); try { no.focus({ preventScroll: true }); } catch (e) { /* */ }
          return;
        }
        if (k === 'download') {   // while it downloads: the line and the bar say it all
          const b = btn('nc-btn', `Download${size ? ` · ${MB(size)}` : ''}`);
          b.addEventListener('click', () => { b.disabled = true; b.textContent = 'Starting…'; Promise.resolve(call(hook.download)).catch(() => {}).then(() => { kind = null; paint(); }); setTimeout(() => { kind = null; paint(); }, 400); });
          btns.append(b);
        } else if (k === 'delete') { btns.append(del); }
        if (typeof hooks.onUse === 'function' && call(hooks.current) !== id && (s.ready || m.stage === 'examples' || m.examples)) {   // v009: BEAM's examples need no download
          const u = btn('nc-btn ghost', 'Use on the map'); u.addEventListener('click', () => { hooks.onUse(id); kind = null; paint(); }); btns.append(u);
        }
      };
      const del = btn('nc-btn st-danger', 'Delete from this phone'); del.addEventListener('click', () => { confirming = true; kind = null; paint(); });
      const paint = () => {
        const s = statusOf(id), k = actionOf(s, hook) + (confirming ? ':c' : '') + (call(hooks.current) === id ? ':u' : '');
        stEl.textContent = statusLine(s, m, sizeOf(id));
        stEl.className = 'st-stat st-k-' + statusText(s, m).kind;
        bar.hidden = !s.downloading; barI.style.transform = `scaleX(${Math.max(0, Math.min(1, s.pct || 0))})`;
        if (k !== kind) { kind = k; paintBtns(s); }
        btns.hidden = !btns.firstChild;
      };
      live = { page: 'model', paint, busy: () => !!statusOf(id).downloading };
      paint();
      if (m.stage !== 'examples' && m.stageNote) root.append(mk('p', 'st-note', m.stageNote));   // v009: what is new for this model
      // strengths and weaknesses: the reason for this page
      root.append(mk('h3', 'st-sub', 'Strengths'));
      if (m.strengthsNote) root.append(mk('p', 'st-note st-tight', m.strengthsNote));
      const sl = mk('ul', 'st-list st-plus'); for (const t of m.strengths) sl.append(mk('li', null, t)); root.append(sl);
      root.append(mk('h3', 'st-sub', 'Weaknesses'));
      const wl = mk('ul', 'st-list st-minus'); for (const t of m.weaknesses) wl.append(mk('li', null, t)); root.append(wl);
      // the facts
      root.append(mk('h3', 'st-sub', 'Details'));
      const kv = mk('dl', 'st-kv');
      const pair = (k, v) => { if (!v) return; kv.append(mk('dt', null, k), mk('dd', null, v)); };
      pair('Forecasts', inLine(m.forecasts)); pair('How far', m.horizon); pair('Reads', inLine(m.reads || [])); pair('Trained on', m.trained);
      pair('Runs', m.runs); pair('Size', sizeWords(m, sizeOf(id)));
      root.append(kv);
      if (typeof hook.extra === 'function') { const x = mk('div', 'st-extra'); root.append(x); call(hook.extra, x); }
      // the licence (and the credit it asks for)
      root.append(mk('h3', 'st-sub', 'Licence'));
      const lp = mk('p', 'st-lic'); lp.append(link(m.licence.name, m.licence.url));
      if (m.licence.file) lp.append(doc.createTextNode(' · '), link('Full text', m.licence.file));
      if (m.source) lp.append(doc.createTextNode(' · '), link('The model', m.source));
      root.append(lp);
      for (const t of [m.licence.when, m.licence.notice, m.licence.changes]) if (t) root.append(mk('p', 'st-note', t));
      root.append(mk('p', 'st-note', FOLLOW_NWS));
    },
    counties() {   // v014: which counties the app has, and whose maps are kept on this phone
      head('Counties');
      const C = hooks.counties || {};
      root.append(mk('p', 'st-note st-tight', 'A county’s maps kept on this phone (satellite, roads and topo) open fast and work with no signal.'));
      const cards = [];
      for (const c of call(C.list) || []) {
        const card = mk('div', 'st-card st-county'), stEl = mk('p', 'st-cstat'), bar = mk('div', 'st-bar'), barI = mk('i'), btns = mk('div', 'st-btns');
        bar.append(barI); btns.hidden = true;
        const sw = mk('label', 'st-sw'), inp = mk('input'); inp.type = 'checkbox'; inp.setAttribute('role', 'switch');
        sw.append(mk('span', 'st-sw-t', 'Keep this county’s maps on this phone'), inp);
        card.dataset.county = c.id; card.append(mk('b', 'st-cname', c.name), stEl, bar, sw, btns); root.append(card);
        const x = { id: c.id, card, stEl, bar, barI, inp, btns, asking: false };
        inp.addEventListener('change', () => {
          if (inp.checked) { x.asking = false; call(C.set, c.id, true); paint(); return; }
          inp.checked = true; x.asking = true; paint();   // off: ask first (it deletes the saved map)
        });
        cards.push(x);
      }
      function ask(x, c) {
        x.btns.textContent = ''; x.btns.hidden = false;
        const q = mk('p', 'st-confirm', `Delete ${c.short || c.name}’s saved map from this phone?${c.savedMb ? ` It frees about ${c.savedMb} MB.` : ''} You can save it again later.`);
        const yes = btn('nc-btn st-danger-solid', 'Delete'), no = btn('nc-btn ghost', 'Keep it');
        yes.addEventListener('click', () => { x.asking = false; call(C.set, x.id, false); paint(); });
        no.addEventListener('click', () => { x.asking = false; paint(); try { x.inp.focus(); } catch (e) { /* */ } });
        x.btns.append(q, yes, no);
      }
      function paint() {
        const list = call(C.list) || [];
        for (const x of cards) {
          const c = list.find((y) => y.id === x.id); if (!c) continue;
          x.inp.checked = !!c.kept; x.stEl.textContent = c.line || '';
          x.stEl.className = 'st-cstat' + (c.done && c.kept ? ' st-k-ready' : '');
          x.bar.hidden = c.frac == null; x.barI.style.transform = `scaleX(${Math.max(0, Math.min(1, c.frac || 0))})`;
          if (x.asking && c.kept) { if (x.btns.hidden) ask(x, c); } else { x.asking = false; x.btns.hidden = true; x.btns.textContent = ''; }
        }
      }
      live = { page: 'counties', paint };
      paint();
    },
    credits() {
      head('Map data and credits');
      root.append(mk('p', 'st-note', 'Every map, data source, model and piece of code in the app, with its licence and the credit it asks for.'));
      const box = mk('div', 'st-credits'); const c = call(hooks.credits); if (c) box.append(c); root.append(box);
      for (const t of hooks.notes || []) if (t) root.append(mk('p', 'st-note', t));
    },
    install() {
      const box = mk('div', 'st-install'); root.append(box);
      if (typeof hooks.installGuide === 'function') { try { const r = hooks.installGuide(box); if (r && r.catch) r.catch(() => {}); } catch (e) { /* */ } }
      else { head('Install the app'); box.append(mk('p', 'st-note', 'The install steps are not available here.')); }
    },
    about() {
      head('About');
      if (hooks.version) root.append(mk('p', 'st-note', hooks.version));
      root.append(mk('p', 'st-p', 'Wallowa Weather is a free, public-good app for Wallowa County, Oregon. Its forecasts are worked out on your own phone.'));
      root.append(mk('p', 'st-p st-strong', `Experimental. It is never an official warning. ${FOLLOW_NWS}`));
      // v016: the app's own licence and BEAM's
      { const p = mk('p', 'st-p'); p.append('© 2026 Joshua Hughes. Wallowa Weather is source-available under the ', link('Wallowa Weather Non-Commercial License', 'LICENSE.md'),
        '. BEAM, created by artist Josh Hughes, is under the ', link('Apache License 2.0', 'licenses/Apache-2.0.txt'), ' (', link('notice', 'licenses/BEAM-NOTICE.txt'), ').'); root.append(p); }
      for (const t of hooks.about || []) if (t) root.append(mk('p', 'st-p', t));
    },
    diag() {
      head('Diagnostics');
      const box = mk('div', 'st-diag'); root.append(box);
      if (typeof hooks.diagnostics === 'function') call(hooks.diagnostics, box);
    },
    share() {   // 1.0.2: the QR code, the address, Share and Copy (ww.js draws it)
      head('Share the app');
      const box = mk('div', 'st-share'); root.append(box);
      if (hooks.share) call(hooks.share.build, box); else box.append(mk('p', 'st-note', 'Not available here.'));
    },
    dlall() {   // LANDING: the three models in one go, v019: then the county map (dlall.js draws it; its own progress, so no poll here)
      head('Download all');
      const box = mk('div', 'st-dlall'); root.append(box);
      if (hooks.downloadAll) call(hooks.downloadAll.build, box); else box.append(mk('p', 'st-note', 'Not available here.'));
    },
    report() {   // FIELD REPORT (fieldkit)
      head('Field report');
      const box = mk('div', 'st-report'); root.append(box);
      call(hooks.fieldReport, box);
    },
    tune() {   // SPEED TUNE (nowcast/tune/ui.js): tune the models' kernels for this phone, see the result, back to the standard ones
      head('Speed tune');
      const box = mk('div', 'st-tunebox'); root.append(box);
      if (hooks.tune) call(hooks.tune.build, box, { doc }); else box.append(mk('p', 'st-note', 'Not available here.'));
    },
    bench() {   // BENCH TEST: how well this phone runs the models (bench.js: its own page, its own styles)
      head('Bench test');
      const box = mk('div', 'st-bench'); root.append(box);
      if (typeof hooks.bench === 'function') call(hooks.bench, box); else box.append(mk('p', 'st-note', 'Not available here.'));
    },
    fresh() {   // Nov-08: how often BEAM (and the rain under it) runs again by itself, each choice's data an hour (cadence.js fill)
      head('Keep forecasts fresh');
      const box = mk('div', 'st-fresh'); root.append(box);
      if (hooks.fresh) call(hooks.fresh.build, box); else box.append(mk('p', 'st-note', 'Not available here.'));
    },
  };

  // a download's progress shows even if no one calls refresh(): a light poll, only while one runs and this sheet is open
  function poll() {
    clearTimeout(pollT);
    const busy = models.some((m) => statusOf(m.id).downloading) || !!(hooks.counties && call(hooks.counties.busy));   // v014: a county's map saving
    if (busy) pollT = setTimeout(() => { if (root.isConnected === false) return; refresh(); poll(); }, 1000);
  }
  function refresh() { if (root.isConnected === false) { clearTimeout(pollT); return; } if (live) live.paint(); poll(); }

  const start = hooks.start || 'main';
  stack.push({ page: 'main', arg: null, scroll: 0 });
  if (start.startsWith('model:')) stack.push({ page: 'model', arg: start.slice(6), scroll: 0 }); else if (start !== 'main') stack.push({ page: start, arg: null, scroll: 0 });
  render(false);
  return { show: (p, a) => show(p, a), back, refresh, get page() { const e = stack[stack.length - 1]; return e.page === 'model' ? 'model:' + e.arg : e.page; }, root };
}
