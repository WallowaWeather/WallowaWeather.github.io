// nowcast/drainages.js - Wallowa Weather v008: the county's drainages for the Water (OWRD) preset: which drainages
// might see high water or flash flooding. The 149 USGS WBD 12-digit subwatersheds (HUC-12) that reach into Wallowa
// County, whole (not clipped), from data/huc12_wallowa.json (built once: shared edges simplified once, so neighbours
// still meet exactly). Drawn as a map overlay (level 0, under the alerts): thin blue outlines, names when zoomed in; a flagged drainage
// is filled: amber = may see high water, red = flash flooding possible. The names are a second overlay (level 1, after the gauges and
// fires): over the alert lines, so a red-flag or warning line never runs through a name, and they step around the marks and their
// labels (the level's overlays share one list of taken boxes per frame: api.placed). The flags come from the app's own forecast (BEAM's rain head):
// setFlags({ huc12: { level: 'watch' | 'warning', why, until } }). Nothing is fetched but the bundled file.
// v014: the active county's file (counties.js drainages) and name (county, in the sheet and the note); Wallowa's are the defaults.
'use strict';
import { inRings } from './lands.js';

export const DRAINAGES_URL = new URL('./data/huc12_wallowa.json', import.meta.url).href;
export const DRAINAGES_CREDIT = 'Drainages: USGS WBD';
export const drainagesNote = (county = 'Wallowa County') => `Drainages are the US Geological Survey’s Watershed Boundary Dataset 12-digit subwatersheds (HUC-12) that reach into ${county}, simplified to about 30 m for the map. Not for site-level or regulatory decisions. A drainage is flagged by this app’s own experimental heavy-rain forecast, not by the NWS or OWRD: for flood warnings, follow the National Weather Service.`;
export const DRAINAGES_NOTE = drainagesNote();
export const FLAG_STYLE = {
  watch: { label: 'May see high water', fill: 'rgba(255,176,32,0.30)', edge: '#FFB020', css: '#FFB020' },
  warning: { label: 'Flash flooding possible', fill: 'rgba(255,59,48,0.34)', edge: '#FF3B30', css: '#FF3B30' },
};
const LINE = '#7CC8FF', HALO = 'rgba(0,22,44,0.55)';
const SQMI = 2.589988;

/** a ring from the file: [lon0, lat0, dlon1, dlat1, ...] in 1/q degree -> [[lon, lat], ...] (open: the first point is not repeated) */
export function decodeRing(flat, q = 1e4) {
  const out = new Array(flat.length >> 1); let x = 0, y = 0;
  for (let i = 0; i < flat.length; i += 2) { x += flat[i]; y += flat[i + 1]; out[i >> 1] = [x / q, y / q]; }
  return out;
}
/** the file -> { units: [{ huc12, name, huc10, huc10name, to, states, km2, inKm2, label: [lon, lat], box: [w, s, e, n], polys }], county, countyKm2, made } */
export function decodeDrainages(j) {
  const q = j.q || 1e4, dec = (polys) => polys.map((p) => p.map((r) => decodeRing(r, q)));
  return {
    made: j.made, countyKm2: j.countyKm2, county: dec(j.county || []),
    units: (j.units || []).map((u) => ({ huc12: String(u.huc12), name: String(u.name || ''), huc10: String(u.huc10 || ''), huc10name: String(u.huc10name || ''),
      to: String(u.to || ''), states: String(u.states || ''), km2: +u.km2, inKm2: +u.inKm2, label: u.label, box: u.box, polys: dec(u.polys || []) })),
  };
}
const inPolys = (polys, lon, lat) => polys.some((p) => inRings(p, lon, lat));
const timeOf = (t) => { if (t == null || t === '') return ''; const d = new Date(typeof t === 'number' ? t : String(t)); if (isNaN(d)) return ''; try { return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }); } catch (e) { return d.toISOString().slice(11, 16) + ' UTC'; } };
const sqmi = (km2) => { const m = km2 / SQMI; return m >= 10 ? Math.round(m).toLocaleString() : m.toFixed(1); };

/** { map (createMap's), url, fetchFn, labelZ (names of every drainage from this zoom; below it only flagged ones), county (its short name) } ->
 *  { load(), setFlags(flags), flags(), at(lat, lon), listFlagged(), on(bool), isOn(), units(), byHuc(huc12), note, overlay (areas, level 0), overlays: [areas, names (level 1)] } */
export function createDrainages({ map = null, url = DRAINAGES_URL, fetchFn = (...a) => fetch(...a), labelZ = 10.4, county = 'Wallowa County' } = {}) {
  const NOTE = drainagesNote(county);
  let promise = null, data = null, byId = new Map(), flags = {}, active = false;
  const overlay = { name: 'ww-drainages', level: 0, order: 10, draw: (ctx, api) => draw(ctx, api) };
  const names = { name: 'ww-drainage-names', level: 1, order: 50, draw: (ctx, api) => drawNames(ctx, api) };
  const redraw = () => { if (map && active) map.draw(); };

  function load() {
    if (promise) return promise;
    promise = Promise.resolve().then(() => fetchFn(url)).then((r) => { if (r && r.ok === false) throw new Error('drainages ' + r.status); return r.json(); })
      .then((j) => { data = decodeDrainages(j); byId = new Map(data.units.map((u) => [u.huc12, u])); redraw(); return data.units; })
      .catch(() => { promise = null; return []; });
    return promise;
  }
  /** flags: { '170601050203': { level: 'watch' | 'warning', why: 'text', until: ms | ISO time } }; anything else is ignored. Replaces the old flags */
  function setFlags(f) {
    flags = {};
    for (const [k, v] of Object.entries(f || {})) {
      if (!/^\d{12}$/.test(k) || !v || !FLAG_STYLE[v.level]) continue;
      flags[k] = { level: v.level, why: String(v.why == null ? '' : v.why).slice(0, 300), until: v.until == null ? null : v.until };
    }
    redraw();
  }
  function info(u) {
    const f = flags[u.huc12] || null, pct = u.km2 ? Math.min(100, Math.round(100 * u.inKm2 / u.km2)) : 0, until = f ? timeOf(f.until) : '';
    const lines = [`${u.huc10name ? u.huc10name + ' watershed · ' : ''}HUC ${u.huc12}`,
      `${sqmi(u.km2)} sq mi${pct < 100 ? `, ${pct}% of it in ${county}` : `, all in ${county}`}`];
    if (f && f.why) lines.push(f.why.charAt(0).toUpperCase() + f.why.slice(1) + (/[.!?]$/.test(f.why) ? '' : '.'));
    if (until) lines.push(`Until about ${until}.`);
    return { kind: 'drainage', huc12: u.huc12, name: u.name, huc10name: u.huc10name, km2: u.km2, inKm2: u.inKm2, to: u.to, flag: f,
      title: u.name, color: f ? FLAG_STYLE[f.level].css : LINE, badge: f ? FLAG_STYLE[f.level].label : '', lines,
      foot: f ? 'App forecast · experimental. ' + NOTE : NOTE };
  }
  /** the drainage at a point (the sheet text of a tap) or null */
  function at(lat, lon) {
    if (!data) return null;
    for (const u of data.units) {
      const b = u.box; if (lon < b[0] || lon > b[2] || lat < b[1] || lat > b[3]) continue;
      if (inPolys(u.polys, lon, lat)) return info(u);
    }
    return null;
  }
  /** the flagged drainages, flash flooding first, then by name: [{ huc12, name, huc10name, level, label, why, until, km2, text }] */
  function listFlagged() {
    const out = [];
    for (const [k, f] of Object.entries(flags)) {
      const u = byId.get(k); if (!u) continue;
      out.push({ huc12: k, name: u.name, huc10name: u.huc10name, level: f.level, label: FLAG_STYLE[f.level].label, why: f.why, until: f.until, km2: u.km2,
        text: `${FLAG_STYLE[f.level].label}: ${u.name}${u.huc10name ? ` (${u.huc10name} watershed)` : ''}` });
    }
    return out.sort((a, b) => (a.level === b.level ? a.name.localeCompare(b.name) : a.level === 'warning' ? -1 : 1));
  }
  function on(v) {
    active = !!v; if (!map) return;
    if (active) { map.addOverlay(overlay); map.addOverlay(names); load(); } else { map.removeOverlay(overlay.name); map.removeOverlay(names.name); }
  }

  // ---------------------------------------------------------------------------------------------- drawing
  function trace(ctx, api, u) {
    for (const poly of u.polys) for (const ring of poly) {
      for (let i = 0; i < ring.length; i++) { const p = api.toScreen(ring[i][1], ring[i][0]); if (i) ctx.lineTo(p.x, p.y); else ctx.moveTo(p.x, p.y); }
      ctx.closePath();
    }
  }
  const visible = (api) => { const [vw, vs, ve, vn] = api.view; return data ? data.units.filter((u) => !(u.box[0] > ve || u.box[2] < vw || u.box[1] > vn || u.box[3] < vs)) : []; };
  function draw(ctx, api) {
    const vis = visible(api), z = api.z;
    if (!vis.length) return;
    ctx.lineJoin = 'round';
    for (const lvl of ['watch', 'warning']) {   // the flagged fills, flash flooding on top
      const us = vis.filter((u) => flags[u.huc12] && flags[u.huc12].level === lvl); if (!us.length) continue;
      ctx.beginPath(); for (const u of us) trace(ctx, api, u); ctx.fillStyle = FLAG_STYLE[lvl].fill; ctx.fill('evenodd');
    }
    // every outline in ONE path: a shared edge is stroked once (no doubled see-through lines)
    ctx.beginPath(); for (const u of vis) trace(ctx, api, u);
    const w = z < 8.5 ? 0.7 : z < 10 ? 0.9 : z < 12 ? 1.2 : 1.5;
    ctx.strokeStyle = HALO; ctx.lineWidth = w + 1.6; ctx.stroke();
    ctx.strokeStyle = LINE; ctx.lineWidth = w; ctx.stroke();
    for (const lvl of ['watch', 'warning']) {
      const us = vis.filter((u) => flags[u.huc12] && flags[u.huc12].level === lvl); if (!us.length) continue;
      ctx.beginPath(); for (const u of us) trace(ctx, api, u); ctx.strokeStyle = 'rgba(0,0,0,0.5)'; ctx.lineWidth = 4; ctx.stroke(); ctx.strokeStyle = FLAG_STYLE[lvl].edge; ctx.lineWidth = 2.2; ctx.stroke();
    }
  }
  function drawNames(ctx, api) { const vis = visible(api); if (vis.length) labels(ctx, api, vis, api.z); }
  /** names: every drainage from labelZ, only the flagged ones below it (from zoom 7.5); a name with a dash goes on two lines */
  function labels(ctx, api, vis, z) {
    const all = z >= labelZ, list = vis.filter((u) => all || (flags[u.huc12] && z >= 7.5));
    if (!list.length) return;
    list.sort((a, b) => (!!flags[b.huc12] - !!flags[a.huc12]) || b.km2 - a.km2);   // flagged first, then the big ones
    const placed = api.placed || (api.placed = []);   // shared with the gauges' and fires' marks drawn before (same level, same frame)
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.lineJoin = 'round';
    for (const u of list) {
      const f = flags[u.huc12], p = api.toScreen(u.label[1], u.label[0]);
      if (p.x < -40 || p.y < -20 || p.x > api.w + 40 || p.y > api.h + 20) continue;
      const parts = splitName(u.name), size = f ? 12 : 11, lh = size + 2;
      ctx.font = `${f ? 700 : 600} ${size}px -apple-system, BlinkMacSystemFont, system-ui, sans-serif`;
      const tw = Math.max(...parts.map((t) => ctx.measureText(t).width)), th = parts.length * lh;
      const b = { x: p.x - tw / 2 - 3, y: p.y - th / 2 - 2, w: tw + 6, h: th + 4 };
      if (b.x < 2 || b.y < 2 || b.x + b.w > api.w - 2 || b.y + b.h > api.h - 2) continue;
      if (placed.some((q) => b.x < q.x + q.w && b.x + b.w > q.x && b.y < q.y + q.h && b.y + b.h > q.y)) continue;
      placed.push(b);
      parts.forEach((t, i) => {
        const y = p.y - th / 2 + lh / 2 + i * lh;
        ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(0,18,36,0.85)'; ctx.strokeText(t, p.x, y);
        ctx.fillStyle = f ? (f.level === 'warning' ? '#FFD2CF' : '#FFE7B0') : '#E6F4FF'; ctx.fillText(t, p.x, y);
      });
    }
  }

  return { load, setFlags, flags: () => Object.assign({}, flags), at, listFlagged, on, isOn: () => active, note: NOTE, units: () => (data ? data.units : []), byHuc: (k) => (byId.get(k) || null), county: () => (data ? data.county : []), overlay, overlays: [overlay, names] };
}

/** "Big Sheep Creek-Imnaha River" -> ["Big Sheep Creek-", "Imnaha River"]; a short name stays on one line */
export function splitName(name) {
  const s = String(name || ''), i = s.indexOf('-');
  return i > 0 && s.length > 16 ? [s.slice(0, i + 1), s.slice(i + 1)] : [s];
}
