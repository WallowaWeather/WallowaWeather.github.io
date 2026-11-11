// nowcast/beam.js - Wallowa Weather v008: BEAM on the map, with each storm cell's fan plotted on the map. Until BEAM runs live on the phone, it shows RECORDED example storms
// (data/beam_examples, made from the backtest): BEAM's own forecast for that day (the half of the model
// that never trained on that year), the radar, the GOES lightning, and each lightning cell's fan - the "hurricane cone" of where its
// lightning goes in the next 30, 60 and 90 minutes (2 in 3 chance inside, the sizes frozen in the backtest). The examples were CHOSEN
// because the fan verified: the player says so; the tested rates live on the model's page in Settings.
// The drawing (chances, warning outlines, fans, lightning) is shared with the live runs to come: the same layers from the same pieces.
import { levelOf, codeLut } from './colors.js';   // v018 examples: the recorded radar in the map's own rain colours
import { EXPERIMENTAL } from './models_info.js';

const BASE = new URL('./data/beam_examples/', import.meta.url).href;

/** BEAM's four forecasts. warn = the frozen warning level of the backtest (THRESHOLDS.json, radar as is, the 'every tile' rule with no
 *  CAPE gate; rain has only the CAPE-gated value 0.65): the outline is drawn where the chance reaches it */
// v009: hail's colours start at 5 % - BEAM's (recalibrated) hail chances are mostly under 15 %, so a faint tint shows
// where hail is possible before it reaches the warning line
export const HEADS = {
  lightning: { label: 'Lightning', warn: 0.75, ramp: [[0.15, [255, 236, 140]], [0.4, [255, 190, 40]], [0.75, [255, 110, 20]], [1, [220, 30, 60]]], edge: '#FF7A1A' },
  hail: { label: 'Hail', warn: 0.35, ramp: [[0.05, [150, 235, 255]], [0.35, [120, 140, 255]], [0.6, [200, 80, 255]], [1, [255, 40, 200]]], edge: '#C04CFF' },
  rain: { label: 'Cloudburst', warn: 0.65, ramp: [[0.15, [150, 210, 255]], [0.4, [60, 140, 255]], [0.7, [30, 70, 220]], [1, [20, 30, 160]]], edge: '#2F6BFF' },
  core: { label: 'Strong cores', warn: 0.9, ramp: [[0.15, [255, 220, 150]], [0.5, [255, 140, 60]], [0.9, [230, 50, 40]], [1, [150, 0, 30]]], edge: '#E5332A' },
};
const FAN = { fill: [[90, 'rgba(255,200,40,0.16)'], [60, 'rgba(255,170,30,0.22)'], [30, 'rgba(255,140,20,0.30)']], edge: '#FFB21F' };
const LATER = { 30: '#FFFFFF', 60: '#5AC8FA', 90: '#C77DFF' };   // 30 / 60 / 90 min: the cone's track dots AND the lightning that came then
/** v011: the example's own storm: a cell whose cone verified (the examples chosen for that), or the storm the example is about (lead:
 *  Bear Creek, chosen for what happened on the ground, its cone shown whether it held or not) */
export const isLead = (c) => !!(c && (c.verified || c.lead));

/** a chance ramp -> 256-entry RGBA table (alpha grows with the chance; nothing under 10 %) */
export function chanceLut(ramp) {
  const lut = new Uint8ClampedArray(256 * 4);
  for (let v = 0; v < 256; v++) {
    const p = v / 255; if (p < ramp[0][0]) continue;
    let i = 0; while (i < ramp.length - 1 && p > ramp[i + 1][0]) i++;
    const [p0, c0] = ramp[i], [p1, c1] = ramp[Math.min(i + 1, ramp.length - 1)], f = p1 > p0 ? Math.min(1, (p - p0) / (p1 - p0)) : 0;
    for (let k = 0; k < 3; k++) lut[v * 4 + k] = Math.round(c0[k] + (c1[k] - c0[k]) * f);
    lut[v * 4 + 3] = Math.round(55 + 120 * Math.min(1, (p - ramp[0][0]) / 0.7));
  }
  return lut;
}
/** v018 examples (Josh: no change of look for the example storms): the recorded radar is reflectivity (stored dBZ + 32); today's radar is
 *  a rain rate in the map's own colours. A table turns each stored value into the map's rain-rate code - Marshall-Palmer, Z = 200 R^1.6,
 *  from 15 dBZ as before (about 0.3 mm/h) - so the example's radar is drawn exactly like today's: the same colours, full opacity */
export const DBZ_RATE = (() => {
  const t = new Uint8Array(256);
  for (let v = 0; v < 256; v++) { const d = v - 32; if (d < 15) continue; t[v] = levelOf((10 ** (d / 10) / 200) ** (1 / 1.6)); }
  return t;
})();
/** values (Uint8 rows x cols) -> a canvas through a table */
function paintLut(vals, rows, cols, lut, into) {
  const c = into && into.width === cols && into.height === rows ? into : Object.assign(document.createElement('canvas'), { width: cols, height: rows });
  const g = c.getContext('2d'), im = g.createImageData(cols, rows);
  for (let i = 0; i < vals.length; i++) { const o = vals[i] * 4; im.data[i * 4] = lut[o]; im.data[i * 4 + 1] = lut[o + 1]; im.data[i * 4 + 2] = lut[o + 2]; im.data[i * 4 + 3] = lut[o + 3]; }
  g.putImageData(im, 0, 0); return c;
}
/** a PNG data URL (8-bit grey) -> Uint8Array of its values */
async function pngValues(url, rows, cols) {
  const img = new Image(); img.src = url; await img.decode();
  const c = Object.assign(document.createElement('canvas'), { width: cols, height: rows }), g = c.getContext('2d', { willReadFrequently: true });
  g.drawImage(img, 0, 0); const d = g.getImageData(0, 0, cols, rows).data, out = new Uint8Array(rows * cols);
  for (let i = 0; i < out.length; i++) out[i] = d[i * 4];
  return out;
}
/** the pixels at or over a level, as connected areas -> [{ ring: [[lon, lat]...] (convex hull of the pixels' corners), px, max }] for
 *  the property list and sharing (a hull is a little bigger than the area: "possibly affected" errs that way) */
export function warnAreas(vals, grid, level) {
  const { rows, cols, top, left, dlat, dlon } = grid, thr = Math.ceil(level * 255), seen = new Uint8Array(rows * cols), out = [];
  for (let s0 = 0; s0 < vals.length; s0++) {
    if (seen[s0] || vals[s0] < thr) continue;
    const stack = [s0], pts = []; seen[s0] = 1; let px = 0, max = 0;
    while (stack.length) {
      const i = stack.pop(), r = (i / cols) | 0, c = i % cols; px++; max = Math.max(max, vals[i]);
      for (const [dr, dc] of [[0, 0], [1, 0], [0, 1], [1, 1]]) pts.push([left + (c + dc) * dlon, top - (r + dr) * dlat]);
      for (const [nr, nc] of [[r - 1, c], [r + 1, c], [r, c - 1], [r, c + 1]]) { if (nr < 0 || nc < 0 || nr >= rows || nc >= cols) continue; const j = nr * cols + nc; if (!seen[j] && vals[j] >= thr) { seen[j] = 1; stack.push(j); } }
    }
    out.push({ ring: hull(pts), px, max: max / 255 });
  }
  return out.sort((a, b) => b.px - a.px);
}
function hull(pts) {
  pts = pts.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cr = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]), lo = [], up = [];
  for (const p of pts) { while (lo.length >= 2 && cr(lo[lo.length - 2], lo[lo.length - 1], p) <= 0) lo.pop(); lo.push(p); }
  for (let i = pts.length - 1; i >= 0; i--) { const p = pts[i]; while (up.length >= 2 && cr(up[up.length - 2], up[up.length - 1], p) <= 0) up.pop(); up.push(p); }
  const h = lo.slice(0, -1).concat(up.slice(0, -1)); h.push(h[0]); return h;
}
/** a point km away along a compass bearing */
export function along(lat, lon, km, deg) {
  const b = deg * Math.PI / 180;
  return { lat: lat + km * Math.cos(b) / 110.574, lon: lon + km * Math.sin(b) / (111.32 * Math.cos(lat * Math.PI / 180)) };
}
const compass = (d) => ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'][Math.round((((d % 360) + 360) % 360) / 45) % 8];
const mph = (kmh) => Math.round(kmh / 1.609);

/** the hurricane-style cone of a cell, from the frozen fan sizes (FAN.json, one set per lead: kappa, alpha_deg, beta, eps_km). The tested
 *  2-in-3 region at lead L = the points within (storm radius + eps) of the sector of centre positions (heading +- alpha, from kappa |v| L
 *  (1 - beta) to kappa |v| L (1 + beta)). Split like the hurricane cone: extra = 0 gives the cone of the storm's CENTRE (eps only), from a
 *  point now, widening with time; extra = the storm's radius gives the whole tested region (how far its lightning reaches). Each = the
 *  convex envelope over now, 30, 60 and 90 min, in a local km plane (x east, y north) -> [[lon, lat]...] */
export function coneOf(c, sizes, q = 'p67', extra = 0) {
  const key = `_cone_${q}_${extra}`; if (c[key]) return c[key];
  const lin = (a, b, n) => (n < 2 ? [(a + b) / 2] : Array.from({ length: n }, (_, i) => a + (b - a) * i / (n - 1)));
  const circ = (cx, cy, r, n, out) => { for (let i = 0; i < n; i++) { const t = (i / n) * 2 * Math.PI; out.push([cx + r * Math.cos(t), cy + r * Math.sin(t)]); } };
  const h0 = c.motion.toward * Math.PI / 180, v = c.motion.kmh / 60, pts = [];
  circ(0, 0, Math.max(1.5, extra), 32, pts);
  for (const L of [30, 60, 90]) {
    const z = sizes && sizes[L] && sizes[L][q]; if (!z) continue;
    const sL = z.kappa * v * L, al = z.alpha_deg * Math.PI / 180, buf = z.eps_km + extra;
    for (const ang of lin(h0 - al, h0 + al, al > 0 ? 7 : 1)) for (const r of lin(sL * Math.max(0, 1 - z.beta), sL * (1 + z.beta), 7)) circ(r * Math.sin(ang), r * Math.cos(ang), buf, 24, pts);
  }
  const k = Math.cos(c.lat * Math.PI / 180);
  c[key] = hull(pts).map(([x, y]) => [c.lon + x / (111.32 * k), c.lat + y / 110.574]);
  return c[key];
}

/** the BEAM layers on a map (shared by the examples and, later, the live runs). state = { grid, frame, head, radar, later, fanSizes } */
export function createBeamLayers(map) {
  const S = { grid: null, frame: null, head: 'lightning', radar: true, later: false, fanSizes: null, vals: null, valsShow: null, valsRadar: null, cvs: null, cvr: null, areas: [] };
  const LUTS = Object.fromEntries(Object.entries(HEADS).map(([k, h]) => [k, chanceLut(h.ramp)])), RLUT = codeLut();   // v018 examples: the map's rain colours
  function gridOf(canvas) { const g = S.grid; return { canvas, top: g.top, left: g.left, dlat: g.dlat, dlon: g.dlon, rows: g.rows, cols: g.cols }; }
  map.addOverlay({ name: 'beam-chance', level: 0, order: 10, draw(ctx, api) {
    if (!S.grid || !S.frame) return;
    // v018: the values and their table go along: the map draws them smooth on the GPU (the painted canvas is the 2D path's)
    // v018 examples: the recorded radar like today's radar - the map's rain-rate colours ('rate') at full opacity (it was dBZ colours at 0.8)
    if (S.radar && S.cvr) api.drawGrid(Object.assign(gridOf(S.cvr), { codes: S.valsRadar, code: 'rate' }), 1);
    if (S.cvs) api.drawGrid(Object.assign(gridOf(S.cvs), { codes: S.valsShow, lut: LUTS[S.head] }), 0.75);
    if (S.vals) {   // the warning level: the pixel edges where the chance crosses it
      const { rows, cols, top, left, dlat, dlon } = S.grid, thr = Math.ceil(HEADS[S.head].warn * 255), v = S.vals;
      ctx.beginPath();
      const seg = (la1, lo1, la2, lo2) => { const a = api.toScreen(la1, lo1), b = api.toScreen(la2, lo2); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); };
      for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
        if (v[r * cols + c] < thr) continue;
        const la = top - r * dlat, lo = left + c * dlon;
        if (r === 0 || v[(r - 1) * cols + c] < thr) seg(la, lo, la, lo + dlon);
        if (r === rows - 1 || v[(r + 1) * cols + c] < thr) seg(la - dlat, lo, la - dlat, lo + dlon);
        if (c === 0 || v[r * cols + c - 1] < thr) seg(la, lo, la - dlat, lo);
        if (c === cols - 1 || v[r * cols + c + 1] < thr) seg(la, lo + dlon, la - dlat, lo + dlon);
      }
      ctx.lineWidth = 3.4; ctx.strokeStyle = 'rgba(0,0,0,0.55)'; ctx.stroke();
      ctx.lineWidth = 1.8; ctx.strokeStyle = HEADS[S.head].edge; ctx.stroke();
    }
  } });
  map.addOverlay({ name: 'beam-fans', level: 1, order: 10, draw(ctx, api) {
    const f = S.frame; if (!f) return;
    const path = (ring) => { ctx.beginPath(); ring.forEach(([lon, lat], i) => { const p = api.toScreen(lat, lon); if (i) ctx.lineTo(p.x, p.y); else ctx.moveTo(p.x, p.y); }); ctx.closePath(); };
    const big = (f.cells || []).filter((c) => c.flashes >= 3 || isLead(c));   // the one-flash specks get no cone (clutter); they still show as lightning
    const lead = big.some(isLead);   // the example's storm: its cone bold, the other cells' faint and unlabelled
    const dim = (c) => lead && !isLead(c);
    // like the National Hurricane Center's cone: the
    // forecast circles along the track (here the tested 30 / 60 / 90 min regions) joined by their envelope, from the storm as it is now,
    // so it widens with time; a track line with time dots. Each time's region is unchanged: only the drawing joins them.
    for (const c of big) {
      ctx.globalAlpha = dim(c) ? 0.35 : 1;
      const reach = coneOf(c, S.fanSizes, 'p67', c.radKm), cone = coneOf(c, S.fanSizes, 'p67', 0);
      // white like the National Hurricane Center's cone, so it stands apart from the chance colours under it
      path(reach); ctx.fillStyle = 'rgba(255,255,255,0.10)'; ctx.fill(); ctx.lineWidth = 1.3; ctx.setLineDash([5, 4]); ctx.strokeStyle = 'rgba(255,255,255,0.85)'; ctx.stroke(); ctx.setLineDash([]);
      path(cone); ctx.fillStyle = 'rgba(255,255,255,0.34)'; ctx.fill();
      ctx.lineWidth = 4; ctx.strokeStyle = 'rgba(0,0,0,0.5)'; ctx.stroke(); ctx.lineWidth = 2.2; ctx.strokeStyle = '#FFFFFF'; ctx.stroke();
    }
    ctx.globalAlpha = 1;
    ctx.font = '600 11px -apple-system, BlinkMacSystemFont, system-ui, sans-serif'; ctx.textBaseline = 'middle'; ctx.textAlign = 'center';
    // lightning seen in this frame (GOES GLM), then (What happened) the verified cells' lightning at +30 / +60 / +90 min
    const bolt = (x, y, s, fill) => { ctx.beginPath(); ctx.moveTo(x + 0.2 * s, y - s); ctx.lineTo(x - 0.45 * s, y + 0.1 * s); ctx.lineTo(x - 0.02 * s, y + 0.1 * s); ctx.lineTo(x - 0.25 * s, y + s); ctx.lineTo(x + 0.5 * s, y - 0.2 * s); ctx.lineTo(x + 0.06 * s, y - 0.2 * s); ctx.closePath(); ctx.fillStyle = fill; ctx.fill(); ctx.lineWidth = 1; ctx.strokeStyle = 'rgba(0,0,0,0.75)'; ctx.stroke(); };
    for (const [lat, lon, n] of f.flashes || []) { const p = api.toScreen(lat, lon); bolt(p.x, p.y, Math.min(9, 5 + n), '#FFE14D'); }
    if (S.later) for (const c of f.cells || []) if (c.later) for (const L of [30, 60, 90]) for (const [lon, lat, n] of c.later[L] || []) {
      const p = api.toScreen(lat, lon); bolt(p.x, p.y, Math.min(8, 5 + n), LATER[L]);
    }
    for (const c of big) {   // the track: now, then the 30 / 60 / 90 min positions on the cone's centre line
      if (dim(c)) continue;
      const p = api.toScreen(c.lat, c.lon), kmPx = 1000 / api.mpp(c.lat);
      const marks = [30, 60, 90].map((L) => { const k = S.fanSizes ? S.fanSizes[L].p67.kappa : 0.6; return [L, along(c.lat, c.lon, k * c.motion.kmh / 60 * L, c.motion.toward)]; });
      const end = api.toScreen(marks[2][1].lat, marks[2][1].lon);
      ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(end.x, end.y); ctx.lineWidth = 4; ctx.strokeStyle = 'rgba(255,255,255,0.9)'; ctx.stroke(); ctx.lineWidth = 2; ctx.strokeStyle = '#151A33'; ctx.stroke();
      const ang = Math.atan2(end.y - p.y, end.x - p.x);
      const gap = Math.hypot(...['x', 'y'].map((k) => api.toScreen(marks[1][1].lat, marks[1][1].lon)[k] - api.toScreen(marks[0][1].lat, marks[0][1].lon)[k]));
      for (const [L, q] of marks) {   // close marks (a slow storm, or zoomed out): dots for all, words for 90 only
        const s0 = api.toScreen(q.lat, q.lon), t = gap < 34 && L !== 90 ? '' : `${L} min`;
        ctx.beginPath(); ctx.arc(s0.x, s0.y, 9, 0, 2 * Math.PI); ctx.fillStyle = '#fff'; ctx.fill();
        ctx.beginPath(); ctx.arc(s0.x, s0.y, 7.4, 0, 2 * Math.PI); ctx.fillStyle = '#151A33'; ctx.fill();
        ctx.beginPath(); ctx.arc(s0.x, s0.y, 5, 0, 2 * Math.PI); ctx.fillStyle = LATER[L]; ctx.fill();
        if (!t) continue;
        const ox = 17 * Math.cos(ang + Math.PI / 2), oy = 17 * Math.sin(ang + Math.PI / 2);
        ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(0,0,0,0.8)'; ctx.strokeText(t, s0.x + ox, s0.y + oy); ctx.fillStyle = LATER[L]; ctx.fillText(t, s0.x + ox, s0.y + oy);
      }
      // the storm now: a bold dot, like the hurricane cone's current position
      ctx.beginPath(); ctx.arc(p.x, p.y, 7, 0, 2 * Math.PI); ctx.fillStyle = '#FF8A00'; ctx.fill(); ctx.lineWidth = 2.2; ctx.strokeStyle = '#fff'; ctx.stroke();
      if (isLead(c) || big.length <= 3) {
        const t = `Now · ${mph(c.motion.kmh)} mph → ${compass(c.motion.toward)}`, ox = -22 * Math.cos(ang), oy = -22 * Math.sin(ang);
        ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(0,0,0,0.8)'; ctx.strokeText(t, p.x + ox, p.y + oy); ctx.fillStyle = '#FFE08A'; ctx.fillText(t, p.x + ox, p.y + oy);
      }
      void kmPx;
    }
  } });
  let tok = 0;
  async function setFrame(grid, frame, o = {}) {
    Object.assign(S, { grid, frame }, o); const my = ++tok;
    const g = grid, bins = frame && frame.beam ? frame.beam[S.head] : null;
    if (bins) {   // the next 90 minutes: the highest chance of the three half-hours, per pixel
      const parts = await Promise.all(bins.map((u) => pngValues(u, g.rows, g.cols))); if (my !== tok) return;
      const v = new Uint8Array(g.rows * g.cols); for (const p of parts) for (let i = 0; i < v.length; i++) if (p[i] > v[i]) v[i] = p[i];
      S.vals = v; S.valsShow = v; S.cvs = paintLut(v, g.rows, g.cols, LUTS[S.head], S.cvs); S.areas = warnAreas(v, g, HEADS[S.head].warn);
    } else { S.vals = null; S.valsShow = null; S.cvs = null; S.areas = []; }
    if (frame && frame.radar && S.radar) {
      const r = await pngValues(frame.radar, g.rows, g.cols); if (my !== tok) return;
      const codes = new Uint8Array(r.length); for (let q = 0; q < r.length; q++) codes[q] = DBZ_RATE[r[q]];
      S.valsRadar = codes; S.cvr = paintLut(codes, g.rows, g.cols, RLUT, S.cvr);
    } else { S.valsRadar = null; S.cvr = null; }
    map.draw();
  }
  /** v009: a live BEAM run's half-hour (beam_live.js), in the same look: `vals` = the raw chance (the warning outline and areas, at the
   *  frozen level), `show` = the chance coloured (hail recalibrated), both Uint8 (255 = 100 %) on the lat / lon `grid`. No cones live. */
  function setLive(grid, { vals, show = vals, head = S.head } = {}) {
    tok++;
    Object.assign(S, { grid, frame: { live: true, cells: [], flashes: [] }, head, radar: false, later: false, vals, valsShow: show, valsRadar: null, cvr: null });
    S.cvs = paintLut(show, grid.rows, grid.cols, LUTS[head], S.cvs && S.cvs.width === grid.cols && S.cvs.height === grid.rows ? S.cvs : null);
    S.areas = warnAreas(vals, grid, HEADS[head].warn);
    map.draw();
  }
  return {
    setFrame, setLive, get live() { return !!(S.frame && S.frame.live); }, get state() { return S; },
    /** the warning areas of the head shown (for the property list): [{ ring, px, max }] */
    areas: () => S.areas,
    clear() { tok++; Object.assign(S, { frame: null, vals: null, valsShow: null, valsRadar: null, cvs: null, cvr: null, areas: [] }); map.draw(); },
    destroy() { map.removeOverlay('beam-chance'); map.removeOverlay('beam-fans'); },
  };
}

/** the recorded-storm player. v018 examples (Josh: the app must not switch look for the example storms): no panel of its own - the view
 *  draws what ui() describes in its own time bar and folding card (exampleui.js), as for the live map. It keeps the storm's frames, the
 *  hazard shown, the switches, the map's layers and the framing of the storm's cone.
 *  createBeamPlayer({ map, space: () => ({ w, h, top, bottom }) (the map's free room), onChange, onAreas, onExit, toast }) */
export function createBeamPlayer({ map, root = null, space = null, onExit = () => {}, onAreas = () => {}, onChange = () => {}, toast = () => {} }) {
  const layers = createBeamLayers(map);
  const P = { ex: null, i: 0, head: 'lightning', radar: true, later: true, title: '', moment: 0 };
  const LA = { timeZone: 'America/Los_Angeles' };
  const dateOf = (t) => new Date(t).toLocaleDateString('en-US', Object.assign({ month: 'short', day: 'numeric', year: 'numeric' }, LA));
  const clock = (t) => new Date(t).toLocaleTimeString('en-US', Object.assign({ hour: 'numeric', minute: '2-digit' }, LA));
  let idx = null;
  async function index() { const r = await fetch(BASE + 'index.json'); if (!r.ok) throw new Error('examples ' + r.status); return (await r.json()).examples || []; }
  /** the example's title from the list ("Aug 11, 2022 · the Wallowa hailstorm"), or its date */
  async function titleOf(id, ex) { try { idx = idx || index(); const e = (await idx).find((x) => x.id === id); if (e && e.title) return e.title; } catch (x) { idx = null; } return dateOf(ex.focusT || ex.frames[0].issue); }
  /** -> true when it opened (false: it could not be loaded; nothing changed) */
  async function open(id, o = {}) {
    if (o.head && HEADS[o.head]) P.head = o.head;   // v008: the preset's hazard first (Fire: lightning, Farm: hail, Water: cloudburst)
    let ex = null;
    try { const r = await fetch(BASE + id + '.json'); if (r.ok) ex = await r.json(); } catch (e) { ex = null; }
    if (!ex || !Array.isArray(ex.frames) || !ex.frames.length) { toast('That example storm could not be loaded.'); return false; }
    P.ex = ex; P.moment = Math.max(0, ex.frames.findIndex((f) => f.focus)); P.i = P.moment; P.title = await titleOf(id, ex);
    const f = ex.frames[P.i], vc = f.cells.find(isLead) || f.cells[0];
    await show(P.i);
    if (vc) frame(vc);
    return true;
  }
  async function show(i) {
    const ex = P.ex; if (!ex) return; P.i = Math.max(0, Math.min(ex.frames.length - 1, i));
    await layers.setFrame(ex.grid, ex.frames[P.i], { head: P.head, radar: P.radar, later: P.later && ex.frames[P.i].focus, fanSizes: ex.fanSizes });
    if (!P.ex) return;
    onAreas(layers.areas(), HEADS[P.head], ex.frames[P.i]); onChange();
  }
  /** a chip (a hazard) or a switch (radar / what happened) */
  function set(id, on) {
    if (HEADS[id]) P.head = id; else if (id === 'radar') P.radar = !!on; else if (id === 'later') P.later = !!on; else return Promise.resolve();
    return show(P.i);
  }
  /** the cell's 90-minute cone (9 in 10) fills the map's free room (between the key and the card) */
  function frame(c) {
    const ring = coneOf(c, P.ex.fanSizes, 'p67', c.radKm);   // the whole cone and its band
    let s = 90, w = 180, n = -90, e = -180; for (const [lo, la] of ring) { s = Math.min(s, la); n = Math.max(n, la); w = Math.min(w, lo); e = Math.max(e, lo); }
    const box = root ? root.getBoundingClientRect() : { width: 390, height: 844 }, sp = Object.assign({ w: box.width, h: box.height, top: 70, bottom: 220 }, space ? space() : {});
    map.fit(s, w, n, e, 28); const st = map.state;
    const avail = Math.max(120, sp.h - sp.top - sp.bottom), k = Math.min(1, avail / Math.max(1, sp.h - 56));   // the fit used the whole map: shrink to the room left
    const z = st.z + Math.log2(k); map.center(st.lat, st.lon, z);
    const mid = map.toLatLon(sp.w / 2, sp.h / 2 + (sp.bottom - sp.top) / 2); map.center(mid.lat, mid.lon, z);
  }
  /** what the view draws for this frame: the time bar's frames and words, the card's words, chips, switches, credits and fine print */
  function ui() {
    const ex = P.ex; if (!ex) return null;
    const f = ex.frames[P.i], foc = ex.frames[P.moment], dmin = Math.round((f.t - foc.t) / 60e3), vc = f.cells.find(isLead), H = HEADS[P.head];
    const when = f.focus ? 'the cone’s moment' : `${Math.abs(dmin)} min ${dmin < 0 ? 'before' : 'after'} the cone’s moment`;
    return {
      kind: 'beam', model: 'BEAM', pill: 'Example · BEAM', title: P.title,
      frames: ex.frames.map((x, k) => ({ t: x.issue, kind: k <= P.moment ? 'radar' : 'nowcast' })), i: P.i, moment: P.moment,
      date: dateOf(f.issue), time: clock(f.issue), tag: `Example · BEAM · ${H.label} · Experimental`,
      valuetext: `${dateOf(f.issue)} ${clock(f.issue)}, BEAM example storm, chance of ${H.label.toLowerCase()}, ${when}`,
      momentWords: 'Back to the cone’s moment',
      sentence: f.focus ? (vc ? `Storm moving ${mph(vc.motion.kmh)} mph → ${compass(vc.motion.toward)}. The cone: where its centre is headed, like a hurricane cone; the light band: how far its lightning reaches.` : 'BEAM’s forecast.')
        : `${dmin < 0 ? `${-dmin} min before` : `${dmin} min after`} the cone’s moment.`,
      chipsLabel: 'Hazard', chips: Object.entries(HEADS).map(([k, h]) => ({ id: k, label: h.label, on: k === P.head })),
      switches: [{ id: 'radar', label: 'Radar', on: P.radar }, { id: 'later', label: 'What happened', on: P.later }],
      dots: { colours: LATER, words: P.later && f.focus && vc ? '· ● forecast spot of the storm’s centre · ⚡ lightning the satellite recorded then' : '· ● forecast spot of the storm’s centre' },
      credit: `BEAM, made for this app · Radar: NOAA MRMS · Lightning: NOAA GOES GLM · ${EXPERIMENTAL}`,
      about: [ex.story || '',
        (ex.chosen === 'reported' ? 'A real storm, chosen for what happened on the ground, not for how BEAM did: an example, not a measure of accuracy (the tested rates are in Settings › Models › BEAM).'
          : 'A real storm, chosen because its cone verified: an example, not a measure of accuracy (the tested rates are in Settings › Models › BEAM).')
        + ' Drawn like the National Hurricane Center’s cone: the cone is where the storm’s centre is expected to go (the dots: 30, 60 and 90 minutes), widening as the forecast gets less sure; the light band adds the storm’s own size, how far its lightning reaches. Cone and band together: a 2 in 3 chance its lightning stays inside at those times (the backtest’s frozen sizes).'
        + (ex.chosen === 'reported' ? ' BEAM’s forecast for this day is from its blind test: the half of the model that never trained on that year, run once on the sealed day and never tuned on it.' : ' BEAM’s forecast for this day came from the half of the model that never trained on that year.')
        + ' The radar is the recorded reflectivity drawn as rain rate in the map’s own colours. Experimental, not a National Weather Service warning.'].filter(Boolean),
      delay: f.focus ? 2600 : 900,
    };
  }
  function close() { layers.clear(); P.ex = null; onAreas([], null, null); onExit(); }
  return { index, open, close, show, set, ui, get active() { return !!P.ex; }, get example() { return P.ex; }, get state() { return { i: P.i, head: P.head, radar: P.radar, later: P.later }; }, layers,
    destroy() { if (P.ex) close(); layers.destroy(); } };
}
