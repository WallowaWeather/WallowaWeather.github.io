// nowcast/drainlist.js - Wallowa Weather 1.0.3: "Drainages at risk", the list of the drainages BEAM's cloudburst warning flags (the Water
// (OWRD) preset's map, drainages.js). Until 1.0.3 a flag lived only on the map and its tap sheet: a watermaster had to pan the county to
// find them. A round button for the map's right margin with a red count (under the ⚠️ properties button), and a panel that slides in
// from the right in the properties list's look (affected.css): one row per flagged drainage - its name, its HUC-12 code, since when (the
// BEAM run that flagged it) and until when, and the USGS gauges inside it with their newest reading and its trend. A tap on a row frames
// that drainage on the map. Nothing is fetched here: the rows are made from what the map already has (the flags, the gauges' last poll).
'use strict';
import { icon } from './icons.js';
import { gaugeReading } from './gauges.js';

const clockOf = (t) => { try { return new Date(t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }); } catch (e) { return new Date(t).toISOString().slice(11, 16); } };

/** flagged: drainages.listFlagged(); gauges: the stream gauges' last list (gauges.js summarise) or null when that layer is off;
 *  hucAt(lat, lon): the HUC-12 code of the drainage at a point, or null -> rows [{ huc12, name, huc10name, since, until, gauges: [{ id,
 *  name, lat, lon, reading }] | null }] in listFlagged's order (gauges null: not known, the layer is off) */
export function drainRows(flagged, gauges, hucAt) {
  const inside = new Map();
  if (gauges) for (const g of gauges) {
    const k = hucAt(g.lat, g.lon); if (!k) continue;
    if (!inside.has(k)) inside.set(k, []);
    inside.get(k).push({ id: g.id, name: g.name, lat: g.lat, lon: g.lon, reading: gaugeReading(g) });
  }
  return (flagged || []).map((f) => ({ huc12: f.huc12, name: f.name, huc10name: f.huc10name, since: f.since == null ? null : f.since, until: f.until == null ? null : f.until,
    gauges: gauges ? inside.get(f.huc12) || [] : null }));
}
/** "3 drainages at risk" */
export const countWords = (n) => `${n.toLocaleString('en-US')} ${n === 1 ? 'drainage' : 'drainages'} at risk`;
/** a row's lines under its name: the code and watershed, then when (the BEAM run's radar time, as the BEAM warning sheet says it) */
export function rowLines(r) {
  const t = (v) => (v == null || isNaN(new Date(v)) ? '' : clockOf(typeof v === 'number' ? v : Date.parse(v)));
  const since = t(r.since), until = t(r.until);
  return [`HUC ${r.huc12}${r.huc10name ? ` · ${r.huc10name} watershed` : ''}`,
    [since ? `Since BEAM’s run on the ${since} radar` : '', until ? `until about ${until}` : ''].filter(Boolean).join(' · ')].filter(Boolean);
}
/** a gauge's line in a row: "Minam River at Minam, OR: Flow 719 cfs, rising 40.0 cfs in the last hour (fast) · as of 3:15 PM" */
export function gaugeLine(g) { return `${g.name}: ${g.reading.text}${g.reading.t ? ` · as of ${clockOf(g.reading.t)}` : ''}`; }

export const DRAINLIST_FOOT = 'Flagged by this app’s own experimental forecast (BEAM’s cloudburst warning), not by the NWS or OWRD. BEAM’s warning areas are much bigger than the ground hit: most flagged drainages see no flash flooding. Gauge readings are the USGS’s provisional data. For flood warnings, follow the National Weather Service.';

/** onPick(row): a row was tapped (the view frames the drainage). -> { button, panel, set(rows, { gaugesOn }), open(), close(), isOpen,
 *  rows() } */
export function createDrainList({ onPick = () => {}, doc = globalThis.document } = {}) {
  const mk = (tag, cls, text) => { const e = doc.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  let rows = [], gaugesOn = false, isOpen = false, closeT = 0, lastFocus = null;
  const reduced = () => { try { return matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (e) { return false; } };

  const button = mk('button', 'nc-round af-btn dl-btn'); button.type = 'button'; button.hidden = true;
  const badge = mk('span', 'af-badge'); button.append(icon('drainages'), badge);
  button.setAttribute('aria-haspopup', 'dialog');
  button.addEventListener('click', () => open());

  const panel = mk('div', 'af-layer dl-layer'); panel.hidden = true;
  const scrim = mk('div', 'af-scrim'), box = mk('section', 'af-panel'); box.setAttribute('role', 'dialog'); box.setAttribute('aria-modal', 'true'); box.setAttribute('aria-labelledby', 'dl-count');
  const head = mk('header', 'af-head'), bar = mk('div', 'af-bar');
  const kicker = mk('p', 'af-kicker dl-kicker'); kicker.append(icon('drainages', 'af-ic sm', 16), mk('span', null, 'Drainages at risk · BEAM cloudburst'));
  const xB = mk('button', 'af-x'); xB.type = 'button'; xB.setAttribute('aria-label', 'Close'); const xDisc = mk('span', 'af-x-disc'); xDisc.append(icon('close', 'af-ic', 18)); xB.append(xDisc);
  bar.append(kicker, xB);
  const count = mk('h2', 'af-count'); count.id = 'dl-count'; count.setAttribute('aria-live', 'polite');
  const sub = mk('p', 'af-sub', 'HUC-12 drainages under BEAM’s cloudburst warning: flash flooding possible. Tap one to see it on the map.');
  const gnote = mk('p', 'af-sub dl-gnote', 'Turn on Stream gauges (Layers) to see the USGS gauges in these drainages.');
  head.append(bar, count, sub, gnote);
  const scroll = mk('div', 'af-scroll dl-scroll'); scroll.tabIndex = -1;
  const foot = mk('footer', 'af-foot', DRAINLIST_FOOT);
  box.append(head, scroll, foot); panel.append(scrim, box);

  function render() {
    const n = rows.length;
    button.hidden = !n; badge.textContent = n ? String(n) : '';
    button.setAttribute('aria-label', n ? `${countWords(n)}. Show the list` : 'Drainages at risk');
    if (!isOpen) return;
    count.textContent = n ? countWords(n) : 'No drainages at risk now';
    gnote.hidden = gaugesOn;
    scroll.textContent = '';
    for (const r of rows) {
      const el = mk('button', 'dl-row'); el.type = 'button'; el.dataset.huc = r.huc12;
      el.append(mk('b', 'af-lot dl-name', r.name));
      for (const t of rowLines(r)) el.append(mk('span', 'dl-line', t));
      if (r.gauges) {
        if (r.gauges.length) for (const g of r.gauges) { const s = mk('span', 'dl-gauge' + (g.reading.fast ? ' fast' : ''), gaugeLine(g)); el.append(s); }
        else el.append(mk('span', 'dl-line dim', 'No USGS gauge in this drainage'));
      }
      el.addEventListener('click', () => { close('pick'); try { onPick(r); } catch (e) { console.error('[drainlist] onPick', e); } });
      scroll.append(el);
    }
    if (!n) scroll.append(mk('p', 'af-sec-empty', 'BEAM’s newest run flags no drainage.'));
  }
  /** rows: drainRows(...); gaugesOn: the Stream gauges layer is on (its readings are in the rows) */
  function set(list, o = {}) { rows = list || []; gaugesOn = !!o.gaugesOn; if (!rows.length && isOpen) close(); render(); }
  function open() {
    if (!rows.length) return;
    if (!panel.isConnected) (button.closest('.nc') || doc.body).append(panel);
    clearTimeout(closeT); lastFocus = doc.activeElement; isOpen = true; panel.hidden = false; render(); scroll.scrollTop = 0;
    void panel.offsetWidth; panel.classList.add('on');
    requestAnimationFrame(() => { try { xB.focus({ preventScroll: true }); } catch (e) { /* old Safari */ } });
    doc.addEventListener('keydown', onKey);
  }
  /** how = 'pick': a row was tapped (the map takes over; focus stays off the button) */
  function close(how) {
    if (!isOpen) return;
    isOpen = false; panel.classList.remove('on'); doc.removeEventListener('keydown', onKey);
    clearTimeout(closeT); closeT = setTimeout(() => { if (!isOpen) panel.hidden = true; }, reduced() ? 160 : 300);
    if (how !== 'pick' && lastFocus && lastFocus.focus && lastFocus.isConnected) try { lastFocus.focus({ preventScroll: true }); } catch (e) { /* gone */ }
  }
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  scrim.addEventListener('click', () => close()); xB.addEventListener('click', () => close());
  render();
  return { button, panel, set, open, close: () => close(), get isOpen() { return isOpen; }, rows: () => rows.slice() };
}
