// nowcast/mine.js - "My layers" (the person's own map layers, phone friendly): pins, lines, areas and circles drawn with a finger, and tax lots
// highlighted, each with a name and a colour. Kept on this phone only (localStorage), never sent anywhere; Export / Import carry them to
// another phone as a .json file the person moves themselves.
// While drawing, a see-through layer over the map takes the touches, so a tap adds a point at once (no double-tap zoom, no city name or
// long press in the way) and a dot can be dragged; one finger still moves the map and two pinch, through the map's own center(). Off it,
// the map's gestures are untouched.
import { icon } from './icons.js';

export const MINE_KEY = 'wallowa-weather:mine';
export const MAX_ITEMS = 300, MAX_CHARS = 1500000, NAME_MAX = 40, MAX_PTS = 500, LOT_PTS = 1500;
/** an import bigger than this is refused before it is read (a full My layers file is at most MAX_CHARS, about 1.5 MB) */
export const IMPORT_MAX_BYTES = 3e6;
// the bright (dark-mode) system colours: they sit on satellite imagery, where the light-mode ones go muddy
export const COLORS = [['red', 'Red', '#FF453A'], ['orange', 'Orange', '#FF9F0A'], ['yellow', 'Yellow', '#FFD60A'], ['green', 'Green', '#30D158'],
  ['teal', 'Teal', '#40C8E0'], ['blue', 'Blue', '#0A84FF'], ['purple', 'Purple', '#BF5AF2'], ['white', 'White', '#FFFFFF']];
const HEX = Object.fromEntries(COLORS.map(([k, , h]) => [k, h]));
export const KIND_NAME = { pin: 'Pin', line: 'Line', area: 'Area', circle: 'Circle', lot: 'Tax lot' };
const WORD = { pin: 'pin', line: 'line', area: 'area', circle: 'circle', lot: 'tax lot' };
const DRAWN = ['pin', 'line', 'area', 'circle'];
const D2R = Math.PI / 180, A = 6378137, E2 = 0.00669437999014, PIN_H = 22;
export const ACRE = 4046.8564224, MILE = 1609.344, FT = 0.3048;
// own keys only: a shared file's 'constructor' or 'toString' is no colour and no kind (a plain object answers them from Object.prototype)
const has = (o, k) => typeof k === 'string' && Object.prototype.hasOwnProperty.call(o, k);
export const hexOf = (c) => (has(HEX, c) ? HEX[c] : HEX.orange);
const pale = (c) => c === 'white' || c === 'yellow';   // a dark dot / tick reads on these
const r6 = (p) => [Math.round(p[0] * 1e6) / 1e6, Math.round(p[1] * 1e6) / 1e6];   // ~0.1 m: plenty, and a third of the bytes
export const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

// ---------------------------------------------------------------------------------------------- geometry (pure)
/** the ellipsoid's radii of curvature at a latitude: M north-south, N east-west */
function radii(lat) { const s = Math.sin(lat * D2R), w = 1 - E2 * s * s; return { M: A * (1 - E2) / (w * Math.sqrt(w)), N: A / Math.sqrt(w) }; }
/** metres between two [lon, lat] points, flat on the ellipsoid's local radii (a few cm off over the miles of a county line) */
export function metres(a, b) {
  const lat = (a[1] + b[1]) / 2, { M, N } = radii(lat);
  return Math.hypot((b[0] - a[0]) * D2R * N * Math.cos(lat * D2R), (b[1] - a[1]) * D2R * M);
}
export function lengthM(pts) { let s = 0; for (let i = 1; i < pts.length; i++) s += metres(pts[i - 1], pts[i]); return s; }
const openRing = (r) => (r.length > 1 && r[0][0] === r[r.length - 1][0] && r[0][1] === r[r.length - 1][1] ? r.slice(0, -1) : r);
/** square metres inside a ring of [lon, lat] (closed or not): the spherical sum on a sphere of the ellipsoid's own (Gaussian) radius there,
 *  which is what a surveyor's flat acres come to over a lot or a ranch */
export function ringM2(ring) {
  const r = openRing(ring), n = r.length; if (n < 3) return 0;
  let lat = 0; for (const p of r) lat += p[1];
  const { M, N } = radii(lat / n); let s = 0;
  for (let i = 0; i < n; i++) { const a = r[(i + n - 1) % n], b = r[i], c = r[(i + 1) % n]; s += (c[0] - a[0]) * D2R * Math.sin(b[1] * D2R); }
  return Math.abs(s * M * N / 2);
}
/** polygons (each [outer, ...holes]) */
export function polysM2(polys) { let s = 0; for (const p of polys) p.forEach((ring, i) => { s += i ? -ringM2(ring) : ringM2(ring); }); return Math.max(0, s); }
/** even-odd over rings of [x, y] */
export function inRings(rings, x, y) {
  let inside = false;
  for (const r of rings) for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
    const [xi, yi] = r[i], [xj, yj] = r[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
export function distToSeg(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay, L = dx * dx + dy * dy, t = L ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / L)) : 0;
  return Math.hypot(px - ax - t * dx, py - ay - t * dy);
}
/** the shortest distance from (x, y) to a path of {x, y} (closed: back to the start too) */
export function distToPath(pts, x, y, closed) {
  let d = Infinity; const n = pts.length; if (n === 1) return Math.hypot(x - pts[0].x, y - pts[0].y);
  for (let i = 0; i < (closed ? n : n - 1); i++) { const a = pts[i], b = pts[(i + 1) % n]; d = Math.min(d, distToSeg(x, y, a.x, a.y, b.x, b.y)); }
  return d;
}
const shoelace = (r) => { let s = 0; for (let i = 0, j = r.length - 1; i < r.length; j = i++) s += (r[j][0] - r[i][0]) * (r[j][1] + r[i][1]); return Math.abs(s / 2); };
/** Douglas-Peucker on a ring of [lon, lat], tolerance in metres */
export function simplifyRing(ring, tol) {
  const n = ring.length; if (n <= 4 || !(tol > 0)) return ring.slice();
  const k = Math.cos(ring[0][1] * D2R) * 111320, xy = ring.map(([lo, la]) => [lo * k, la * 110574]);
  const keep = new Uint8Array(n); keep[0] = keep[n - 1] = 1; const st = [[0, n - 1]];
  while (st.length) {
    const [a, b] = st.pop(); let at = -1, far = tol;
    for (let i = a + 1; i < b; i++) { const d = distToSeg(xy[i][0], xy[i][1], xy[a][0], xy[a][1], xy[b][0], xy[b][1]); if (d > far) { far = d; at = i; } }
    if (at >= 0) { keep[at] = 1; st.push([a, at], [at, b]); }
  }
  const out = ring.filter((_, i) => keep[i]); return out.length >= 4 ? out : ring.slice();
}
/** a lot's polygons, rounded, and simplified (half a metre, then coarser) only when they are huge: a few big ranches have thousands of points */
export function simplifyPolys(polys, max = LOT_PTS) {
  const count = (ps) => ps.reduce((s, p) => s + p.reduce((t, r) => t + r.length, 0), 0);
  let out = polys.map((p) => p.map((r) => r.map(r6)));
  for (let tol = 0.5; count(out) > max && tol <= 64; tol *= 2) out = polys.map((p) => p.map((r) => simplifyRing(r, tol).map(r6)));
  return out;
}
const isPt = (p) => Array.isArray(p) && typeof p[0] === 'number';
/** parcels' polys are [polygon][ring][point]; a bare ring or one polygon is taken too */
export function normPolys(x) { if (!Array.isArray(x) || !x.length) return []; if (isPt(x[0])) return [[x]]; if (isPt(x[0] && x[0][0])) return [x]; return x; }
const ringsOf = (it) => (it.kind === 'lot' ? it.polys.flat() : [it.pts]);
const polysOf = (it) => (it.kind === 'lot' ? it.polys : [[it.pts]]);
/** [west, south, east, north] */
export function boxOf(it) {
  if (it.kind === 'circle') { const [lo, la] = it.pts[0], { M, N } = radii(la), dla = it.r / M / D2R, dlo = it.r / (N * Math.cos(la * D2R)) / D2R; return [lo - dlo, la - dla, lo + dlo, la + dla]; }
  let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
  for (const r of ringsOf(it)) for (const [lo, la] of r) { if (lo < w) w = lo; if (lo > e) e = lo; if (la < s) s = la; if (la > n) n = la; }
  return [w, s, e, n];
}
/** where a shape's name goes: its middle when that is inside it, else the middle of the widest stretch across it there ([lon, lat]) */
export function labelPoint(it) {
  if (it.kind === 'circle' || it.kind === 'pin') return it.pts[0];
  let ring = it.pts;
  if (it.kind === 'lot') { let best = -1; for (const p of it.polys) { const a = ringM2(p[0]); if (a > best) { best = a; ring = p[0]; } } }
  const r = openRing(ring), k = Math.cos(r[0][1] * D2R), xy = r.map(([lo, la]) => [lo * k, la]);
  let cx = 0, cy = 0, a2 = 0;
  for (let i = 0, j = xy.length - 1; i < xy.length; j = i++) { const f = xy[j][0] * xy[i][1] - xy[i][0] * xy[j][1]; a2 += f; cx += (xy[j][0] + xy[i][0]) * f; cy += (xy[j][1] + xy[i][1]) * f; }
  if (Math.abs(a2) < 1e-14) { cx = xy.reduce((s, p) => s + p[0], 0) / xy.length; cy = xy.reduce((s, p) => s + p[1], 0) / xy.length; } else { cx /= 3 * a2; cy /= 3 * a2; }
  if (!inRings([xy], cx, cy)) {
    const xs = [];
    for (let i = 0, j = xy.length - 1; i < xy.length; j = i++) { const [x1, y1] = xy[j], [x2, y2] = xy[i]; if ((y1 > cy) !== (y2 > cy)) xs.push(x1 + (cy - y1) * (x2 - x1) / (y2 - y1)); }
    xs.sort((p, q) => p - q); let wide = -1;
    for (let i = 0; i + 1 < xs.length; i += 2) if (xs[i + 1] - xs[i] > wide) { wide = xs[i + 1] - xs[i]; cx = (xs[i] + xs[i + 1]) / 2; }
  }
  return [cx / k, cy];
}
/** the item under a tap at (x, y) screen px: a pin first, then a line or a shape's edge, then the smallest shape the tap is inside (a
 *  pasture drawn inside a highlighted lot). proj(lat, lon) -> {x, y}; mpp(lat): metres a screen px */
export function hitTest(list, x, y, proj, mpp) {
  const P = (p) => proj(p[1], p[0]);
  const near = (it, pad) => { const b = boxOf(it), a = proj(b[3], b[0]), c = proj(b[1], b[2]); return x >= a.x - pad && x <= c.x + pad && y >= a.y - pad - (it.kind === 'pin' ? PIN_H : 0) && y <= c.y + pad; };
  let best = null, bd = Infinity;
  for (const it of list) if (it.kind === 'pin' && near(it, 24)) {
    const p = P(it.pts[0]), d = Math.min(Math.hypot(x - p.x, y - (p.y - PIN_H)), Math.hypot(x - p.x, y - p.y));
    if (d <= 22 && d < bd) { bd = d; best = it; }
  }
  if (best) return best;
  const shapes = list.filter((it) => it.kind !== 'pin' && near(it, 18));
  for (const it of shapes) {
    let d = Infinity;
    if (it.kind === 'circle') { const c = P(it.pts[0]); d = Math.abs(Math.hypot(x - c.x, y - c.y) - it.r / mpp(it.pts[0][1])); }
    else for (const r of ringsOf(it)) d = Math.min(d, distToPath(r.map(P), x, y, it.kind !== 'line'));
    if (d <= (it.kind === 'line' ? 16 : 10) && d < bd) { bd = d; best = it; }
  }
  if (best) return best;
  let ba = Infinity;
  for (const it of shapes) {
    if (it.kind === 'line') continue;
    let inside = false, a = 0;
    if (it.kind === 'circle') { const c = P(it.pts[0]), r = it.r / mpp(it.pts[0][1]); inside = Math.hypot(x - c.x, y - c.y) <= r; a = Math.PI * r * r; }
    else for (const poly of polysOf(it)) { const rings = poly.map((r) => r.map((q) => { const s = P(q); return [s.x, s.y]; })); if (inRings(rings, x, y)) inside = true; a += shoelace(rings[0]); }
    if (inside && a < ba) { ba = a; best = it; }
  }
  return best;
}

// ---------------------------------------------------------------------------------------------- words
const num = (v, d) => v.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
const sig3 = (v) => { if (!(v > 0)) return 0; const k = 10 ** Math.max(0, Math.floor(Math.log10(v)) - 2); return Math.round(v / k) * k; };
export function areaM2(it) { return it.kind === 'area' ? ringM2(it.pts) : it.kind === 'circle' ? Math.PI * it.r * it.r : it.kind === 'lot' ? polysM2(it.polys) : 0; }
export function acresText(m2) {
  const a = m2 / ACRE, t = `${num(a, a < 10 ? 2 : a < 100 ? 1 : 0)} acres`;
  return a < 1 ? `${t} (${num(sig3(m2 / FT / FT), 0)} sq ft)` : t;
}
export function milesText(m) { const mi = m / MILE, t = `${num(mi, mi < 10 ? 2 : 1)} miles`; return mi < 0.25 ? `${t} (${num(sig3(m / FT), 0)} ft)` : t; }
export const feetText = (m) => `${num(sig3(m / FT), 0)} ft`;
/** "Area · 12.40 acres", "Line · 1.32 miles", ... */
export function kindLine(it) {
  if (it.kind === 'pin') return `Pin · ${it.pts[0][1].toFixed(5)}, ${it.pts[0][0].toFixed(5)}`;
  if (it.kind === 'line') return `Line · ${milesText(lengthM(it.pts))}`;
  if (it.kind === 'circle') return `Circle · ${acresText(areaM2(it))} · ${feetText(2 * it.r)} across`;
  if (it.kind === 'lot') return `${it.lot ? `Tax lot ${it.lot}` : 'Tax lot'} · ${acresText(areaM2(it))}`;
  return `Area · ${acresText(areaM2(it))}`;
}

// ---------------------------------------------------------------------------------------------- storage and import (pure)
export function cleanName(s) { if (typeof s !== 'string') return ''; return Array.from(s.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim()).slice(0, NAME_MAX).join('').trim(); }
function cleanPt(p) {
  if (!Array.isArray(p) || p.length < 2 || typeof p[0] !== 'number' || typeof p[1] !== 'number') return null;
  if (!Number.isFinite(p[0]) || !Number.isFinite(p[1]) || Math.abs(p[0]) > 180 || Math.abs(p[1]) > 85) return null;
  return r6(p);
}
function cleanPts(a, max) { if (!Array.isArray(a) || !a.length || a.length > max) return null; const out = []; for (const p of a) { const q = cleanPt(p); if (!q) return null; out.push(q); } return out; }
function cleanPolys(x) {
  const ps = normPolys(x); if (!ps.length || ps.length > 100) return null;
  let total = 0; const out = [];
  for (const p of ps) {
    if (!Array.isArray(p) || !p.length || p.length > 100) return null;
    const rings = []; for (const r of p) { const q = cleanPts(r, 5000); if (!q || q.length < 3) return null; total += q.length; rings.push(q); }
    out.push(rings);
  }
  return total <= 5000 ? out : null;
}
/** one item as it may be kept, or null: known kinds only, a name, a known colour, real coordinates, nothing else carried along */
export function cleanItem(o) {
  if (!o || typeof o !== 'object' || !has(KIND_NAME, o.kind)) return null;
  const name = cleanName(o.name); if (!name) return null;
  const it = { id: typeof o.id === 'string' && /^[A-Za-z0-9_-]{1,40}$/.test(o.id) ? o.id : newId(), kind: o.kind, name, color: has(HEX, o.color) ? o.color : 'orange',
    at: Number.isFinite(o.at) ? Math.round(o.at) : Date.now() };
  if (o.hidden === true) it.hidden = true;
  if (o.kind === 'lot') {
    const polys = cleanPolys(o.polys); if (!polys) return null;
    it.polys = polys; it.lot = typeof o.lot === 'string' ? o.lot.replace(/[^\w .\-/]/g, '').slice(0, 40) : ''; return it;
  }
  const pts = cleanPts(o.pts, MAX_PTS), need = { pin: 1, circle: 1, line: 2, area: 3 }[o.kind];
  if (!pts || pts.length < need) return null;
  it.pts = need === 1 ? pts.slice(0, 1) : pts;
  if (o.kind === 'circle') { if (!(typeof o.r === 'number' && o.r > 0 && o.r <= 100000)) return null; it.r = Math.round(o.r * 10) / 10; }
  return it;
}
/** -> { items, last, err? } (err: 'storage' the phone wouldn't read it, 'broken' it couldn't be parsed) */
export function loadItems(storage) {
  let raw = null;
  try { raw = storage ? storage.getItem(MINE_KEY) : null; } catch (e) { return { items: [], last: null, err: 'storage' }; }
  if (!raw) return { items: [], last: null };
  try {
    const d = JSON.parse(raw), items = [], ids = new Set();
    for (const o of (d && Array.isArray(d.items) ? d.items : []).slice(0, MAX_ITEMS)) { const it = cleanItem(o); if (!it) continue; if (ids.has(it.id)) it.id = newId(); ids.add(it.id); items.push(it); }
    return { items, last: d && has(HEX, d.last) ? d.last : null };
  } catch (e) { return { items: [], last: null, err: 'broken' }; }
}
/** -> { ok, chars } | { ok: false, why: 'many' | 'big' (over the caps: nothing written) | 'storage' (the phone refused: private mode, quota) } */
export function saveItems(storage, items, last = null) {
  if (items.length > MAX_ITEMS) return { ok: false, why: 'many' };
  const text = JSON.stringify(last ? { v: 1, items, last } : { v: 1, items });
  if (text.length > MAX_CHARS) return { ok: false, why: 'big' };
  try { if (!storage) throw new Error('no storage'); storage.setItem(MINE_KEY, text); return { ok: true, chars: text.length }; } catch (e) { return { ok: false, why: 'storage' }; }
}
export function exportText(items) { return JSON.stringify({ v: 1, app: 'Wallowa Weather', what: 'My layers', saved: new Date().toISOString(), items }); }
const sameShape = (a, b) => JSON.stringify([a.kind, a.name, a.color, a.pts, a.r, a.polys, a.lot]) === JSON.stringify([b.kind, b.name, b.color, b.pts, b.r, b.polys, b.lot]);
/** a file's text merged into what is here -> { items, added, same (already here), bad (unreadable items), over (past the cap) }; throws
 *  an Error with words for the person when the file is not a My layers file at all */
export function mergeImport(have, text, max = MAX_ITEMS) {
  let d; try { d = JSON.parse(text); } catch (e) { throw new Error('That file isn’t a My layers file.'); }
  const arr = Array.isArray(d) ? d : d && typeof d === 'object' && Array.isArray(d.items) ? d.items : null;
  if (!arr) throw new Error('That file isn’t a My layers file.');
  if (!Array.isArray(d) && d.v != null && d.v !== 1) throw new Error('That file is from a newer Wallowa Weather: update the app first.');
  const out = have.slice(), ids = new Map(have.map((i) => [i.id, i])); let added = 0, same = 0, bad = 0, over = 0;
  for (const o of arr.slice(0, 5000)) {
    const it = cleanItem(o); if (!it) { bad++; continue; }
    const was = ids.get(it.id);
    if (was) { if (sameShape(was, it)) { same++; continue; } it.id = newId(); }
    if (out.length >= max) { over++; continue; }
    out.push(it); ids.set(it.id, it); added++;
  }
  return { items: out, added, same, bad, over };
}

// ---------------------------------------------------------------------------------------------- the screen
const NS = 'http://www.w3.org/2000/svg';
const GLYPH = {
  pin: ['M12 21s-6.5-6-6.5-11a6.5 6.5 0 0 1 13 0c0 5-6.5 11-6.5 11Z', 'M12 7.7a2.3 2.3 0 1 0 0 4.6 2.3 2.3 0 0 0 0-4.6Z'],
  line: ['M4 18.5 9.5 10l4.5 4.5 6-9.5', 'M4 18.5h.01M9.5 10h.01M14 14.5h.01M20 5h.01'],
  area: ['M5 7.5 12.5 4 20 9.5l-2.5 9.5L6 17.5 5 7.5Z'],
  circle: ['M12 3.5a8.5 8.5 0 1 0 0 17 8.5 8.5 0 0 0 0-17Z', 'M12 12h.01'],
  undo: ['M9 14.5 4.5 10 9 5.5', 'M4.5 10h10a5 5 0 0 1 0 10H11'],
};
function glyph(name, cls = 'mn-ic') {
  const s = document.createElementNS(NS, 'svg'); s.setAttribute('viewBox', '0 0 24 24'); s.setAttribute('aria-hidden', 'true'); s.setAttribute('class', cls);
  s.setAttribute('fill', 'none'); s.setAttribute('stroke', 'currentColor'); s.setAttribute('stroke-width', '1.8'); s.setAttribute('stroke-linecap', 'round'); s.setAttribute('stroke-linejoin', 'round');
  for (const d of GLYPH[name]) { const p = document.createElementNS(NS, 'path'); p.setAttribute('d', d); if (d.includes('h.01')) p.setAttribute('stroke-width', '3.2'); s.append(p); }
  return s;
}
const mk = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
const button = (cls, label, ic) => { const b = mk('button', cls); b.type = 'button'; if (ic) b.append(ic); if (label) b.append(mk('span', null, label)); return b; };
const rgba = (hex, a) => `rgba(${parseInt(hex.slice(1, 3), 16)},${parseInt(hex.slice(3, 5), 16)},${parseInt(hex.slice(5, 7), 16)},${a})`;
const defaultStorage = () => { try { return globalThis.localStorage || null; } catch (e) { return null; } };   // Safari's private mode can throw on the getter
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const midOf = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });

/** map: createMap's; root: the screen's element (the map's canvas is in it); toast(text); onChange(items) after any change.
 *  Optional: storage (localStorage), canvas (the map's), closeHost() (closes the sheet that holds listInto's section) */
export function createMine({ map, root, toast = () => {}, onChange = () => {}, storage = defaultStorage(), canvas = null, closeHost = null } = {}) {
  const cv = canvas || root.querySelector('canvas');
  const got = loadItems(storage);
  let list = got.items, last = got.last || 'orange', draft = null, sheet = null, selId = null, preview = null, ghost = null, warned = false, flashT = 0, uid = 0;
  let catcher = null, B = null, drag = null;   // while drawing: the touch layer, its bar, the dot under the finger
  const views = new Set();   // the Layers sheets' "My layers" sections on screen now
  if (got.err === 'broken') toast('Your saved layers couldn’t be read on this phone.');
  const BOX = new WeakMap(), LAB = new WeakMap();   // items are replaced, never changed in place, so these stay right
  const boxC = (it) => { let b = BOX.get(it); if (!b) { b = boxOf(it); BOX.set(it, b); } return b; };
  const labC = (it) => { let p = LAB.get(it); if (!p) { p = labelPoint(it); LAB.set(it, p); } return p; };
  const shown = () => list.filter((it) => !it.hidden && !(draft && draft.editId === it.id));
  const colorOf = (it) => hexOf(preview && preview.id === it.id ? preview.color : it.color);
  const mppAt = (lat) => 40075016.686 * Math.cos(lat * D2R) / (256 * 2 ** map.state.z);

  // the list kept: over the caps a change is refused (false); a phone that won't store it keeps it until the app closes
  function commit(next, { relist = true } = {}) {
    const r = saveItems(storage, next, last);
    if (!r.ok && r.why === 'many') { toast(`My layers holds up to ${MAX_ITEMS} things: delete some to add more.`); return false; }
    if (!r.ok && r.why === 'big') { toast('My layers is full on this phone: delete a few (big lots take the most room) to add more.'); return false; }
    if (!r.ok && !warned) { warned = true; toast('This phone won’t save My layers (private browsing, or its storage is full). They stay until the app closes.'); }
    list = next; map.draw(); if (relist) relistAll();
    try { onChange(list.slice()); } catch (e) { console.error('[mine] onChange', e); }
    return true;
  }
  const add = (it) => commit(list.concat([Object.assign({ id: newId(), at: Date.now() }, it)]));
  const update = (id, patch, o) => commit(list.map((x) => (x.id === id ? Object.assign({}, x, patch) : x)), o);
  const remove = (id) => commit(list.filter((x) => x.id !== id));

  // ---------------------------------------------------------------------------------------------- drawing on the map
  function trace(ctx, api, ring, close) { ring.forEach(([lo, la], i) => { const p = api.toScreen(la, lo); if (i) ctx.lineTo(p.x, p.y); else ctx.moveTo(p.x, p.y); }); if (close) ctx.closePath(); }
  /** a dark edge under the colour: it reads on snow, fields and forest alike */
  function paint(ctx, hex, closed, sel, white) {
    if (closed) { ctx.fillStyle = rgba(hex, white ? 0.2 : sel ? 0.34 : 0.26); ctx.fill('evenodd'); }
    ctx.lineJoin = 'round'; ctx.lineCap = 'round';
    ctx.strokeStyle = 'rgba(0,0,0,0.5)'; ctx.lineWidth = closed ? (sel ? 6.5 : 4.6) : (sel ? 8.5 : 6.6); ctx.stroke();
    ctx.strokeStyle = hex; ctx.lineWidth = closed ? (sel ? 3.8 : 2.5) : (sel ? 5 : 3.6); ctx.stroke();
  }
  function drawAreas(ctx, api) {
    const [w, s, e, n] = api.view;
    for (const it of shown()) {
      if (it.kind === 'pin') continue;
      const b = boxC(it); if (b[0] > e || b[2] < w || b[1] > n || b[3] < s) continue;
      ctx.beginPath();
      if (it.kind === 'circle') { const c = api.toScreen(it.pts[0][1], it.pts[0][0]); ctx.arc(c.x, c.y, Math.max(1, it.r / api.mpp(it.pts[0][1])), 0, 2 * Math.PI); }
      else if (it.kind === 'lot') { for (const p of it.polys) for (const r of p) trace(ctx, api, r, true); }
      else trace(ctx, api, it.pts, it.kind === 'area');
      paint(ctx, colorOf(it), it.kind !== 'line', it.id === selId, it.color === 'white');
    }
  }
  /** a map pin: a round head on a point, the place exactly at the point */
  function pin(ctx, x, y, hex, sel, paleOne) {
    const r = sel ? 10.5 : 9, cy = y - PIN_H, a = Math.acos(r / PIN_H);
    ctx.beginPath(); ctx.moveTo(x, y); ctx.arc(x, cy, r, Math.PI / 2 + a, Math.PI / 2 - a + 2 * Math.PI); ctx.closePath();
    ctx.lineJoin = 'round'; ctx.lineWidth = 4; ctx.strokeStyle = 'rgba(0,0,0,0.45)'; ctx.stroke();
    ctx.fillStyle = hex; ctx.fill(); ctx.lineWidth = 2; ctx.strokeStyle = paleOne ? 'rgba(40,40,46,0.9)' : '#fff'; ctx.stroke();
    ctx.beginPath(); ctx.arc(x, cy, 3.4, 0, 2 * Math.PI); ctx.fillStyle = paleOne ? '#1C1C1E' : '#fff'; ctx.fill();
  }
  function drawMarks(ctx, api) {
    const vis = shown(), heads = [];
    for (const it of vis) {
      if (it.kind !== 'pin') continue;
      const p = api.toScreen(it.pts[0][1], it.pts[0][0]); if (p.x < -30 || p.y < -10 || p.x > api.w + 30 || p.y > api.h + PIN_H + 10) continue;
      pin(ctx, p.x, p.y, colorOf(it), it.id === selId, pale(it.color)); heads.push({ x: p.x - 11, y: p.y - PIN_H - 11, w: 22, h: PIN_H + 11 });
    }
    if (draft) for (const h of handles()) heads.push({ x: h.x - 14, y: h.y - 14, w: 28, h: 28 });   // names keep off the dots being dragged
    names(ctx, api, vis, heads);
    if (draft) drawDraft(ctx, api);
  }
  /** names in white on a dark halo (legible on satellite and topo alike), the pins' first, then the bigger shapes'; none on another */
  function names(ctx, api, vis, placed) {
    if (api.z < 9) return;
    ctx.font = '600 13px -apple-system, BlinkMacSystemFont, "SF Pro Text", system-ui, sans-serif'; ctx.textBaseline = 'middle'; ctx.lineJoin = 'round';
    const [w, s, e, n] = api.view, want = [];
    for (const it of vis) {
      const b = boxC(it); if (b[0] > e || b[2] < w || b[1] > n || b[3] < s) continue;
      if (it.kind === 'pin') { const p = api.toScreen(it.pts[0][1], it.pts[0][0]); want.push({ it, x: p.x + 14, y: p.y - PIN_H, left: true, pr: Infinity }); continue; }
      const a = api.toScreen(b[3], b[0]), c = api.toScreen(b[1], b[2]), bw = c.x - a.x, bh = c.y - a.y;
      if (it.kind === 'line') {
        const S = it.pts.map(([lo, la]) => api.toScreen(la, lo)); let L = 0; for (let i = 1; i < S.length; i++) L += dist(S[i - 1], S[i]);
        if (L < 90) continue;
        let half = L / 2, m = S[0], nx = 0, ny = -1;
        for (let i = 1; i < S.length; i++) {
          const d = dist(S[i - 1], S[i]); if (d < half) { half -= d; continue; }
          const t = d ? half / d : 0, dx = S[i].x - S[i - 1].x, dy = S[i].y - S[i - 1].y;
          m = { x: S[i - 1].x + t * dx, y: S[i - 1].y + t * dy }; nx = d ? dy / d : 0; ny = d ? -dx / d : -1;
          if (ny > 0.01 || (Math.abs(ny) <= 0.01 && nx < 0)) { nx = -nx; ny = -ny; }   // beside the line: above it, or right of a steep one
          break;
        }
        want.push({ it, x: m.x, y: m.y, nx, ny, pr: L * 20 }); continue;
      }
      if (bw < 60 || bh < 22) continue;
      const lp = labC(it), p = api.toScreen(lp[1], lp[0]); want.push({ it, x: p.x, y: p.y, pr: bw * bh });
    }
    want.sort((p, q) => q.pr - p.pr);
    for (const L of want) {
      let t = L.it.name, tw = ctx.measureText(t).width;
      if (tw > 180) { let cs = Array.from(t); while (cs.length > 4 && ctx.measureText(cs.join('') + '…').width > 180) cs = cs.slice(0, -1); t = cs.join('') + '…'; tw = ctx.measureText(t).width; }
      let cx = L.x, cy = L.y;
      if (L.nx != null) { const off = 9 + Math.abs(L.nx) * tw / 2 + Math.abs(L.ny) * 9; cx += L.nx * off; cy += L.ny * off; }
      const x0 = L.left ? cx : cx - tw / 2, box = { x: x0 - 3, y: cy - 9, w: tw + 6, h: 18 };
      if (box.x < 2 || box.y < 2 || box.x + box.w > api.w - 2 || box.y + box.h > api.h - 2) continue;
      if (placed.some((q) => box.x < q.x + q.w && box.x + box.w > q.x && box.y < q.y + q.h && box.y + box.h > q.y)) continue;
      placed.push(box);
      ctx.lineWidth = 3.6; ctx.strokeStyle = 'rgba(0,0,0,0.82)'; ctx.strokeText(t, x0, cy); ctx.fillStyle = '#fff'; ctx.fillText(t, x0, cy);
    }
  }
  function dot(ctx, x, y, r, fill, ring) { ctx.beginPath(); ctx.arc(x, y, r, 0, 2 * Math.PI); ctx.fillStyle = fill; ctx.fill(); ctx.lineWidth = 1.6; ctx.strokeStyle = ring; ctx.stroke(); }
  function drawDraft(ctx, api) {
    const d = draft, hex = hexOf(d.color), S = d.pts.map(([lo, la]) => api.toScreen(la, lo)), n = S.length;
    ctx.lineJoin = 'round'; ctx.lineCap = 'round';
    const stroke = (w) => { ctx.strokeStyle = 'rgba(0,0,0,0.5)'; ctx.lineWidth = w + 2.2; ctx.stroke(); ctx.strokeStyle = hex; ctx.lineWidth = w; ctx.stroke(); };
    if ((d.kind === 'line' || d.kind === 'area') && n) {
      if (d.kind === 'area' && n >= 3) { ctx.beginPath(); S.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y))); ctx.closePath(); ctx.fillStyle = rgba(hex, 0.24); ctx.fill('evenodd'); }
      if (n >= 2) { ctx.beginPath(); S.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y))); stroke(d.kind === 'line' ? 3.6 : 2.6); }
      if (d.kind === 'area' && n >= 3) { ctx.beginPath(); ctx.moveTo(S[n - 1].x, S[n - 1].y); ctx.lineTo(S[0].x, S[0].y); ctx.setLineDash([6, 6]); stroke(2); ctx.setLineDash([]); }   // dashed: it closes by itself
    }
    if (d.kind === 'circle' && n) {
      const c = S[0], r = Math.max(1, d.r / api.mpp(d.pts[0][1]));
      ctx.beginPath(); ctx.arc(c.x, c.y, r, 0, 2 * Math.PI); ctx.fillStyle = rgba(hex, 0.24); ctx.fill(); stroke(2.6);
      ctx.beginPath(); ctx.moveTo(c.x, c.y); ctx.lineTo(c.x + r * Math.cos(d.ang), c.y + r * Math.sin(d.ang)); ctx.setLineDash([4, 5]); ctx.strokeStyle = 'rgba(255,255,255,0.85)'; ctx.lineWidth = 1.5; ctx.stroke(); ctx.setLineDash([]);
    }
    if (d.kind === 'pin' && n) pin(ctx, S[0].x, S[0].y, hex, true, pale(d.color));
    for (const h of handles()) {
      if (h.t === 'm') dot(ctx, h.x, h.y, 5.5, 'rgba(255,255,255,0.72)', 'rgba(0,0,0,0.55)');
      else if (d.kind === 'pin') continue;   // the pin itself is the handle
      else {
        const big = d.kind === 'area' && h.i === 0 && n >= 3, active = !!(drag && dist(drag.at, h) < 2);   // handles() is rebuilt each frame: matched by place
        if (big || active) dot(ctx, h.x, h.y, 13, 'rgba(255,255,255,0.28)', 'rgba(255,255,255,0.9)');
        dot(ctx, h.x, h.y, 7.5, '#fff', 'rgba(0,0,0,0.6)');
        dot(ctx, h.x, h.y, 3, hex, hex);
      }
    }
  }
  // personal: the person's own - never in a public picture (map.snapshotAt)
  map.addOverlay({ name: 'mine-areas', level: 0, order: 50, personal: true, draw: drawAreas });
  map.addOverlay({ name: 'mine-marks', level: 1, order: 50, personal: true, draw: drawMarks });

  // ---------------------------------------------------------------------------------------------- draw mode: the touch layer and its bar
  /** the draft's dots on screen: t 'v' a point (i), 'm' between points i and i + 1 (drag or tap it for a new point), 'c' / 'e' a circle's
   *  middle and edge. ax / ay: where the point really is when the dot is drawn off it (a pin's head) */
  function handles() {
    const d = draft, out = []; if (!d || !d.pts.length) return out;
    const S = d.pts.map(([lo, la]) => map.toScreen(la, lo)), n = S.length;
    if (d.kind === 'pin') return [{ t: 'v', i: 0, x: S[0].x, y: S[0].y - PIN_H / 2, ax: S[0].x, ay: S[0].y }];
    if (d.kind === 'circle') { const c = S[0], r = d.r / mppAt(d.pts[0][1]); return [{ t: 'c', x: c.x, y: c.y }, { t: 'e', x: c.x + r * Math.cos(d.ang), y: c.y + r * Math.sin(d.ang) }]; }
    S.forEach((p, i) => out.push({ t: 'v', i, x: p.x, y: p.y }));
    const segs = d.kind === 'area' && n >= 3 ? n : n - 1;
    for (let i = 0; i < segs; i++) { const a = S[i], b = S[(i + 1) % n]; if (dist(a, b) >= 64) out.push({ t: 'm', i, x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }); }
    return out;
  }
  /** the dot within a fingertip (24 px) of a touch; the middle dots give way to the points */
  function handleAt(x, y) { let best = null, bd = 24; for (const h of handles()) { const d = Math.hypot(h.x - x, h.y - y) + (h.t === 'm' ? 6 : 0); if (d < bd) { bd = d; best = h; } } return best; }
  const valid = (d) => (d.kind === 'pin' || d.kind === 'circle' ? d.pts.length === 1 && (d.kind === 'pin' || d.r > 0) : d.pts.length >= (d.kind === 'line' ? 2 : 3));
  function remember() { draft.undo.push({ pts: draft.pts.map((p) => p.slice()), r: draft.r, ang: draft.ang }); if (draft.undo.length > 200) draft.undo.shift(); }
  function changed() { map.draw(); renderBar(); }
  function moveHandle(h, x, y) {
    const d = draft, ll = map.toLatLon(x, y), pt = [ll.lon, ll.lat];
    if (h.t === 'm') { d.pts.splice(h.i + 1, 0, pt); h.t = 'v'; h.i += 1; }   // a middle dot becomes a point of its own
    else if (h.t === 'v' || h.t === 'c') d.pts[h.t === 'c' ? 0 : h.i] = pt;
    else if (h.t === 'e') { const c = map.toScreen(d.pts[0][1], d.pts[0][0]); d.r = Math.max(1, metres(d.pts[0], pt)); d.ang = Math.atan2(y - c.y, x - c.x); }
    changed();
  }
  function tapAt(x, y) {
    const d = draft, ll = map.toLatLon(x, y), pt = [ll.lon, ll.lat];
    if (d.kind === 'pin') { const first = !d.pts.length; remember(); d.pts = [pt]; changed(); if (first && !d.editId) done(); return; }   // a pin is one tap
    if (d.kind === 'circle') {
      remember();
      if (!d.pts.length) { d.pts = [pt]; d.r = 70 * mppAt(ll.lat); d.ang = -Math.PI / 4; }
      else { const c = map.toScreen(d.pts[0][1], d.pts[0][0]); d.r = Math.max(1, metres(d.pts[0], pt)); d.ang = Math.atan2(y - c.y, x - c.x); }
      changed(); return;
    }
    if (d.pts.length >= MAX_PTS) { toast(`A shape can have up to ${MAX_PTS} points.`); return; }
    remember(); d.pts.push(pt); changed();
  }
  function tapHandle(h) {
    if (draft.kind === 'area' && h.t === 'v' && h.i === 0 && draft.pts.length >= 3) { done(); return; }   // back on the first corner: closed
    if (h.t === 'm') { remember(); moveHandle(h, h.x, h.y); }   // a tap on a middle dot adds a point there
  }
  function panBy(dx, dy) { const r = catcher.getBoundingClientRect(), c = map.toLatLon(r.width / 2 - dx, r.height / 2 - dy); map.center(c.lat, c.lon); }
  /** zoom to z keeping the place ll under the screen point m (the fingers' middle) */
  function zoomTo(ll, m, z) {
    const r = catcher.getBoundingClientRect(), s0 = map.state; map.center(s0.lat, s0.lon, z);
    const p = map.toScreen(ll.lat, ll.lon), c = map.toLatLon(r.width / 2 + p.x - m.x, r.height / 2 + p.y - m.y); map.center(c.lat, c.lon, map.state.z);
  }
  const ptr = new Map(); let g = null;
  const local = (e) => { const r = catcher.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
  function onDown(e) {
    e.preventDefault(); const p = local(e); ptr.set(e.pointerId, p);
    try { catcher.setPointerCapture(e.pointerId); } catch (er) { /* a pointer the browser no longer knows */ }
    if (ptr.size === 1) {
      const h = handleAt(p.x, p.y);
      g = h ? { mode: 'drag', id: e.pointerId, h, from: p, ox: (h.ax != null ? h.ax : h.x) - p.x, oy: (h.ay != null ? h.ay : h.y) - p.y, moved: false } : { mode: 'tap', id: e.pointerId, from: p };
      drag = h ? { h, at: { x: h.x, y: h.y } } : null; if (h) map.draw();
    } else if (ptr.size === 2) {   // a second finger: pinch (a dot being dragged stays where it got to)
      const [a, b] = [...ptr.values()], m = midOf(a, b); g = { mode: 'pinch', d0: Math.max(10, dist(a, b)), z0: map.state.z, ll: map.toLatLon(m.x, m.y) }; drag = null; renderBar();
    }
  }
  function onMove(e) {
    if (!ptr.has(e.pointerId) || !g) return;
    const p = local(e), q = ptr.get(e.pointerId); ptr.set(e.pointerId, p);
    if (g.mode === 'drag' && e.pointerId === g.id) {
      if (!g.moved && dist(p, g.from) < 4) return;
      if (!g.moved) { g.moved = true; remember(); }
      moveHandle(g.h, p.x + g.ox, p.y + g.oy); drag = { h: g.h, at: { x: p.x + g.ox, y: p.y + g.oy - (draft.kind === 'pin' ? PIN_H / 2 : 0) } }; return;
    }
    if (g.mode === 'tap' && dist(p, g.from) > 8) { g.mode = 'pan'; panBy(p.x - g.from.x, p.y - g.from.y); return; }
    if (g.mode === 'pan') { panBy(p.x - q.x, p.y - q.y); return; }
    if (g.mode === 'pinch' && ptr.size === 2) { const [a, b] = [...ptr.values()]; zoomTo(g.ll, midOf(a, b), g.z0 + Math.log2(Math.max(10, dist(a, b)) / g.d0)); }
  }
  function onUp(e) {
    if (!ptr.has(e.pointerId)) return;
    const p = local(e), cancel = e.type === 'pointercancel'; ptr.delete(e.pointerId);
    if (g && g.mode === 'tap' && !ptr.size && !cancel) tapAt(p.x, p.y);
    else if (g && g.mode === 'drag' && e.pointerId === g.id && !g.moved && !cancel) tapHandle(g.h);
    if (drag) { drag = null; map.draw(); }
    g = ptr.size ? { mode: 'pan' } : null;   // the finger left after a pinch carries on moving the map
  }
  function onWheel(e) { e.preventDefault(); const p = local(e); zoomTo(map.toLatLon(p.x, p.y), p, map.state.z - e.deltaY / 300); }
  function mountDrawing() {
    catcher = mk('div', 'mn-catch'); catcher.setAttribute('aria-hidden', 'true');
    catcher.addEventListener('pointerdown', onDown); catcher.addEventListener('pointermove', onMove);
    catcher.addEventListener('pointerup', onUp); catcher.addEventListener('pointercancel', onUp);
    catcher.addEventListener('wheel', onWheel, { passive: false }); catcher.addEventListener('contextmenu', (e) => e.preventDefault());
    if (cv && cv.parentNode === root) cv.after(catcher); else root.prepend(catcher);   // over the map, under its buttons and this bar
    const bar = mk('div', 'mn-bar'); bar.setAttribute('role', 'toolbar'); bar.setAttribute('aria-label', 'Drawing');
    const head = mk('div', 'mn-bar-head'), k = mk('b', 'mn-bar-k'), m = mk('span', 'mn-bar-m'), hint = mk('p', 'mn-bar-hint'); hint.setAttribute('aria-live', 'polite');
    head.append(k, m);
    const row = mk('div', 'mn-bar-btns'), undo = button('nc-btn ghost mn-undo', 'Undo', glyph('undo')), cancelB = button('nc-btn ghost', 'Cancel'), doneB = button('nc-btn', 'Done');
    undo.onclick = undoStep; cancelB.onclick = () => askCancel(true); doneB.onclick = done; row.append(undo, cancelB, doneB);
    const ask = mk('div', 'mn-bar-btns'), keep = button('nc-btn ghost', 'Keep drawing'), drop = button('nc-btn mn-danger', 'Discard'); ask.hidden = true;
    keep.onclick = () => askCancel(false); drop.onclick = stopDrawing; ask.append(keep, drop);
    bar.append(head, hint, row, ask); root.append(bar);
    B = { bar, k, m, hint, row, ask, undo, doneB, asking: false };
  }
  function renderBar() {
    if (!B || !draft) return;
    const d = draft, n = d.pts.length, it = d.editId && list.find((x) => x.id === d.editId);
    B.k.textContent = it ? `Editing “${it.name}”` : `New ${WORD[d.kind]}`;
    let hint;
    if (d.kind === 'pin') hint = n ? 'Drag the pin to move it, or tap where it should go.' : 'Tap the map where the pin goes.';
    else if (d.kind === 'circle') hint = n ? 'Tap the edge, or drag the white dot on the edge to size it. Drag the middle dot to move it.' : 'Tap the middle of the circle.';
    else if (d.kind === 'line') hint = n ? 'Tap to add points. Drag a dot to move it.' : 'Tap the map where the line starts.';
    else hint = !n ? 'Tap the map at each corner.' : n < 3 ? 'Tap the next corner. Drag a dot to move it.' : 'Tap to add corners, drag a dot to move it. Tap the first dot or Done to finish.';
    if (!n) hint += ' Drag the map to move it, pinch to zoom.';
    if (B.asking) hint = `Discard this ${it ? 'edit' : WORD[d.kind]}?`;
    B.hint.textContent = hint;
    B.m.textContent = measureText(d);
    B.undo.disabled = !d.undo.length; B.doneB.disabled = !valid(d);
    B.row.hidden = B.asking; B.ask.hidden = !B.asking;
  }
  function measureText(d) {
    const n = d.pts.length;
    if (d.kind === 'line' && n >= 2) return `${n} points · ${milesText(lengthM(d.pts))}`;
    if (d.kind === 'area' && n >= 3) return `${n} corners · ${acresText(ringM2(d.pts))}`;
    if (d.kind === 'circle' && n) return `${acresText(Math.PI * d.r * d.r)} · ${feetText(2 * d.r)} across`;
    if (d.kind === 'pin' && n) return `${d.pts[0][1].toFixed(5)}, ${d.pts[0][0].toFixed(5)}`;
    return '';
  }
  function undoStep() { const s = draft && draft.undo.pop(); if (!s) return; draft.pts = s.pts; draft.r = s.r; draft.ang = s.ang; changed(); }
  function askCancel(on) {
    if (on && draft && (draft.undo.length === 0 || (!draft.editId && draft.pts.length < 2))) { stopDrawing(); return; }   // nothing much to lose
    B.asking = on; renderBar();
  }
  function stopDrawing() {
    draft = null; drag = null; g = null; ptr.clear();
    if (catcher) { catcher.remove(); catcher = null; } if (B) { B.bar.remove(); B = null; }
    root.classList.remove('mn-drawing'); map.draw();
  }
  /** kind: 'pin' | 'line' | 'area' | 'circle'; it: an item of that kind to edit the points of */
  function start(kind, it = null) {
    if (!DRAWN.includes(kind)) return false;
    closeSheet(true); if (draft) stopDrawing();
    draft = { kind, pts: it ? it.pts.map((p) => p.slice()) : [], r: it && it.r ? it.r : 0, ang: -Math.PI / 4, editId: it ? it.id : null, color: it ? it.color : last, undo: [] };
    mountDrawing(); root.classList.add('mn-drawing'); changed();
    return true;
  }
  function done() {
    const d = draft; if (!d || !valid(d)) return;
    const geo = d.kind === 'circle' ? { pts: d.pts.map(r6), r: Math.round(d.r * 10) / 10 } : { pts: d.pts.map(r6) };
    if (d.editId) { const it = list.find((x) => x.id === d.editId); stopDrawing(); if (it && update(it.id, geo)) toast(`Saved “${it.name}”.`); return; }
    openForm({ title: `Name this ${WORD[d.kind]}`, sub: measureText(d) && d.kind !== 'pin' ? measureText(d) : '', name: '', color: d.color,
      onPick: (c) => { if (draft) { draft.color = c; map.draw(); } },
      onSave: (name, color) => { last = color; if (!add(Object.assign({ kind: d.kind, name, color }, geo))) return false; stopDrawing(); toast(`Saved “${name}”. It’s in Layers › My layers.`); return true; } });
  }
  const onKey = (e) => {
    if (sheet && e.key === 'Escape') { closeSheet(); return; }
    if (!draft || sheet) return;
    const inCtl = e.target && e.target.closest && e.target.closest('button, input, textarea, select, a');
    if (e.key === 'Escape') askCancel(true);
    else if (e.key === 'Enter' && !inCtl) done();
    else if ((e.ctrlKey || e.metaKey) && (e.key === 'z' || e.key === 'Z')) { e.preventDefault(); undoStep(); }
  };
  document.addEventListener('keydown', onKey);

  // ---------------------------------------------------------------------------------------------- sheets (nowcast.css's look, our own element)
  function openSheet(build, o = {}) {
    closeSheet(true);
    const s = mk('div', 'nc-sheet mn-sheet'), box = mk('div', 'nc-sheet-box mn-box'), body = mk('div', 'nc-sheet-body'), x = button('nc-round nc-sheet-x', null, icon('close'));
    x.setAttribute('aria-label', 'Close'); box.setAttribute('role', 'dialog'); box.setAttribute('aria-modal', 'true'); if (o.label) box.setAttribute('aria-label', o.label);
    box.append(x, body); s.append(box); root.append(s);
    x.onclick = () => closeSheet(); s.addEventListener('click', (e) => { if (e.target === s) closeSheet(); });
    sheet = { el: s, onClose: o.onClose || null }; selId = o.sel || null;
    build(body); map.draw();
    requestAnimationFrame(() => s.classList.add('on'));
  }
  function closeSheet(silent) {
    if (!sheet) return;
    const { el, onClose } = sheet; sheet = null; el.remove();
    const had = selId || preview || ghost; selId = null; preview = null; ghost = null; if (had) map.draw();
    if (!silent && onClose) onClose();
  }
  /** the name + colour form. o: { title, sub, name, color, sel (an item to keep highlighted), onPick(colour), onSave(name, colour) -> false
   *  keeps the form open, onClose() (closed without saving) } */
  function openForm(o) {
    let color = has(HEX, o.color) ? o.color : last;
    openSheet((b) => {
      b.append(mk('h2', 'nc-h', o.title)); if (o.sub) b.append(mk('p', 'footnote dim mn-sub', o.sub));
      const id = `mn-name-${++uid}`, lab = mk('label', 'mn-lab', 'Name'), inp = mk('input', 'nc-input mn-name'); lab.htmlFor = id;
      inp.id = id; inp.type = 'text'; inp.maxLength = NAME_MAX; inp.value = o.name || ''; inp.placeholder = 'For example: North pasture'; inp.autocomplete = 'off';
      inp.setAttribute('enterkeyhint', 'done'); inp.setAttribute('autocapitalize', 'sentences'); inp.spellcheck = false;
      const sw = mk('div', 'mn-swatches'); sw.setAttribute('role', 'radiogroup'); sw.setAttribute('aria-label', 'Colour');
      for (const [k, label, hex] of COLORS) {
        const s = mk('button', 'mn-swatch' + (pale(k) ? ' mn-pale' : '')), disc = mk('i', 'mn-disc'); s.type = 'button';
        s.setAttribute('role', 'radio'); s.setAttribute('aria-checked', String(k === color)); disc.style.setProperty('--c', hex);
        s.append(disc, mk('span', 'mn-swatch-t', label));
        s.onclick = () => { color = k; for (const c of sw.children) c.setAttribute('aria-checked', String(c === s)); if (o.onPick) o.onPick(k); };
        sw.append(s);
      }
      const save = button('nc-btn mn-save', 'Save'), sync = () => { save.disabled = !cleanName(inp.value); };
      inp.oninput = sync; sync();
      inp.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); save.click(); } };
      save.onclick = () => { const nm = cleanName(inp.value); if (!nm) { inp.focus(); return; } if (o.onSave(nm, color) !== false) closeSheet(true); };
      b.append(lab, inp, mk('p', 'nc-sub', 'Colour'), sw, save, mk('p', 'footnote dim mn-note', 'Saved only on this phone. Nothing is sent anywhere.'));
      if (!inp.value) { try { inp.focus({ preventScroll: true }); } catch (e) { /* */ } }   // still inside the tap: the iPhone shows its keyboard
    }, { onClose: o.onClose, sel: o.sel, label: o.title });
  }
  /** the item's colour in the shape of its kind, in a box of one width (the names line up) */
  function kindDot(it) { const b = mk('span', 'mn-mark'), i = mk('i', `mn-dot mn-k-${it.kind}`); i.style.setProperty('--c', hexOf(it.color)); b.append(i); return b; }
  /** a person's shape or pin: what it is, how big, and what can be done with it */
  function openItem(it) {
    openSheet((b) => {
      const h = mk('div', 'mn-ih'); h.append(kindDot(it), mk('h2', 'nc-h', it.name)); b.append(h);
      b.append(mk('p', 'mn-what', kindLine(it)));
      if (it.kind === 'lot') b.append(mk('p', 'footnote dim', 'Acres worked out from the county’s lot lines: not a survey.'));
      const acts = mk('div', 'mn-acts'), act = (label, fn, cls = '') => { const a = button('mn-act' + cls, label); a.onclick = fn; acts.append(a); return a; };
      if (it.kind !== 'lot') act(it.kind === 'pin' ? 'Move the pin' : it.kind === 'circle' ? 'Move or resize' : 'Edit points', () => start(it.kind, it));
      act('Rename or recolour', () => openForm({ title: 'Rename or recolour', name: it.name, color: it.color, sel: it.id,
        onPick: (c) => { preview = { id: it.id, color: c }; map.draw(); }, onSave: (nm, c) => { preview = null; return update(it.id, { name: nm, color: c }); } }));
      act('Hide', () => { closeSheet(true); if (update(it.id, { hidden: true })) toast(`“${it.name}” is hidden. Turn it back on in Layers › My layers.`); });
      const conf = mk('div', 'mn-confirm'); conf.hidden = true;
      const cr = mk('div', 'mn-confirm-btns'), keep = button('nc-btn ghost', 'Keep'), yes = button('nc-btn mn-danger', 'Delete');
      conf.append(mk('p', null, `Delete “${it.name}”? This can’t be undone.`), cr); cr.append(keep, yes);
      act('Delete', () => { acts.hidden = true; conf.hidden = false; keep.focus(); }, ' danger');
      keep.onclick = () => { conf.hidden = true; acts.hidden = false; };
      yes.onclick = () => { closeSheet(true); if (remove(it.id)) toast(`Deleted “${it.name}”.`); };
      b.append(acts, conf, mk('p', 'footnote dim', 'Saved only on this phone.'));
    }, { sel: it.id, label: it.name });
  }
  /** a tax lot from parcels.at ({ lot, polys }) -> the form, then kept as a 'lot' item */
  function highlightLot(l) {
    if (!l || !l.polys) return false;
    const polys = cleanPolys(simplifyPolys(normPolys(l.polys))); if (!polys) { toast('That lot’s outline couldn’t be read.'); return false; }
    const no = typeof l.lot === 'string' ? l.lot.replace(/[^\w .\-/]/g, '').slice(0, 40) : String(l.lot || '').slice(0, 40);
    const was = no && list.find((x) => x.kind === 'lot' && x.lot === no);
    if (was) {   // one highlight a lot: a second tap changes it
      openForm({ title: 'This lot is highlighted', sub: kindLine(was), name: was.name, color: was.color, sel: was.id,
        onPick: (c) => { preview = { id: was.id, color: c }; map.draw(); }, onSave: (nm, c) => { preview = null; return update(was.id, { name: nm, color: c, hidden: false }); } });
      return true;
    }
    const tmp = { kind: 'lot', polys, lot: no, color: last };
    openForm({ title: 'Highlight this lot', sub: `${no ? `Tax lot ${no} · ` : ''}${acresText(polysM2(polys))}`, name: no ? `Tax lot ${no}` : 'Tax lot', color: last,
      onPick: (c) => { tmp.color = c; ghost = tmp; map.draw(); }, onClose: () => { ghost = null; map.draw(); },
      onSave: (nm, c) => { ghost = null; last = c; if (!add({ kind: 'lot', name: nm, color: c, polys, lot: no })) return false; toast(`Highlighted “${nm}”.`); return true; } });
    ghost = tmp; map.draw();
    return true;
  }
  // the lot being highlighted, drawn while its form is open (the colour shows on the map as it is picked)
  map.addOverlay({ name: 'mine-ghost', level: 0, order: 51, personal: true, draw: (ctx, api) => {
    if (!ghost || !sheet) return;
    ctx.beginPath(); for (const p of ghost.polys) for (const r of p) trace(ctx, api, r, true); paint(ctx, hexOf(ghost.color), true, true, ghost.color === 'white');
  } });

  // ---------------------------------------------------------------------------------------------- taps when not drawing
  function tap(lat, lon) {
    if (draft) return true;
    const p = map.toScreen(lat, lon), it = hitTest(shown(), p.x, p.y, map.toScreen, mppAt);
    if (!it) return false;
    openItem(it); return true;
  }

  // ---------------------------------------------------------------------------------------------- the Layers sheet's section
  function hostClose(el) {
    if (closeHost) { closeHost(); return; }
    const sh = el && el.closest ? el.closest('.nc-sheet') : null; if (!sh || sh.classList.contains('mn-sheet')) return;
    const x = sh.querySelector('.nc-sheet-x'); if (x) x.click(); else sh.hidden = true;
  }
  function focusItem(it, el) {
    if (it.hidden) update(it.id, { hidden: false });
    hostClose(el);
    const b = boxOf(it);
    if (it.kind === 'pin') map.center(it.pts[0][1], it.pts[0][0], Math.max(map.state.z, 15));
    else {
      map.fit(b[1], b[0], b[3], b[2], 80); if (map.state.z > 17.5) map.center(map.state.lat, map.state.lon, 17.5);
      const r = (cv || root).getBoundingClientRect(), c = map.toLatLon(r.width / 2, r.height * 0.6); map.center(c.lat, c.lon);   // up a little: the card covers the bottom
    }
    const id = it.id; clearTimeout(flashT); selId = id; map.draw();   // a moment's highlight, to find it
    flashT = setTimeout(() => { if (selId === id && !sheet) { selId = null; map.draw(); } }, 1800);
  }
  function relistAll() { for (const el of views) { if (!el.isConnected) views.delete(el); else renderList(el); } }
  function renderList(el) {
    el.textContent = ''; el.classList.add('mn-section');
    el.append(mk('p', 'nc-sub', 'My layers'));
    if (!list.length) el.append(mk('p', 'footnote dim mn-empty', 'Pins, lines and areas you draw, and tax lots you highlight, show here. They stay on this phone.'));
    else {
      const ul = mk('div', 'mn-list');
      for (const it of list) {
        const row = mk('div', 'mn-row' + (it.hidden ? ' off' : '')), b = button('mn-row-b'), t = mk('span', 'mn-row-t');
        t.append(mk('b', null, it.name), mk('span', 'footnote dim', kindLine(it)));
        b.append(kindDot(it), t); b.setAttribute('aria-label', `${it.name}. ${kindLine(it)}. Show it on the map`);
        b.onclick = () => focusItem(it, el);
        const swl = mk('label', 'mn-swl'), sw = mk('input'); sw.type = 'checkbox'; sw.checked = !it.hidden; sw.setAttribute('aria-label', `Show ${it.name}`);
        sw.onchange = () => { if (update(it.id, { hidden: !sw.checked }, { relist: false })) row.classList.toggle('off', !sw.checked); else sw.checked = !sw.checked; };
        swl.append(sw); row.append(b, swl); ul.append(row);
      }
      el.append(ul);
    }
    const drawB = button('nc-btn mn-draw', 'Draw a shape'), choose = mk('div', 'mn-choose'); choose.hidden = true; choose.setAttribute('role', 'group'); choose.setAttribute('aria-label', 'What to draw');
    drawB.setAttribute('aria-expanded', 'false');
    drawB.onclick = () => { choose.hidden = !choose.hidden; drawB.setAttribute('aria-expanded', String(!choose.hidden)); };
    for (const k of DRAWN) { const c = button('mn-kind', KIND_NAME[k], glyph(k)); c.onclick = () => { hostClose(el); start(k); }; choose.append(c); }
    const row = mk('div', 'mn-draw-row'); row.append(drawB);
    el.append(row, choose, mk('p', 'footnote dim mn-hint', 'To highlight a tax lot: turn on Lot lines, zoom in close and tap the lot.'));
    const io = mk('div', 'mn-io'), ex = button('nc-btn ghost sm', 'Export'), im = button('nc-btn ghost sm', 'Import'), file = mk('input');
    file.type = 'file'; file.accept = '.json,application/json'; file.hidden = true;
    ex.onclick = exportFile; ex.disabled = !list.length; im.onclick = () => file.click();
    file.onchange = async () => { const f = file.files && file.files[0]; file.value = ''; if (f) await importFile(f); };
    io.append(ex, im, file); el.append(io, mk('p', 'footnote dim', 'Export makes a file of your layers to keep or move to another phone; Import adds one back.'));
  }
  async function exportFile() {
    if (!list.length) { toast('Nothing to export yet.'); return; }
    const text = exportText(list), name = `wallowa-weather-my-layers-${new Date().toISOString().slice(0, 10)}.json`;
    try {   // the share sheet on a phone (Save to Files, AirDrop); a download elsewhere
      const f = new File([text], name, { type: 'application/json' });
      if (navigator.canShare && navigator.canShare({ files: [f] })) { await navigator.share({ files: [f], title: 'My layers' }); return; }
    } catch (e) { if (e && e.name === 'AbortError') return; }
    const url = URL.createObjectURL(new Blob([text], { type: 'application/json' })), a = mk('a'); a.href = url; a.download = name; a.hidden = true;
    document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 60000);
  }
  async function importFile(f) {
    if (!(f.size <= IMPORT_MAX_BYTES)) { toast(`That file is too big to be a My layers file (over ${IMPORT_MAX_BYTES / 1e6} MB).`); return; }
    let r; try { r = mergeImport(list, await f.text()); } catch (e) { toast(e.message || 'That file couldn’t be read.'); return; }
    if (!r.added) { toast(r.same ? 'Everything in that file is already here.' : r.over ? `My layers is full (${MAX_ITEMS}).` : 'Nothing in that file could be read.'); return; }
    if (!commit(r.items)) return;
    toast([`Added ${r.added}.`, r.same ? `${r.same} already here.` : '', r.bad ? `${r.bad} couldn’t be read.` : '', r.over ? `${r.over} didn’t fit.` : ''].filter(Boolean).join(' '));
  }

  return {
    start: (kind) => start(kind),
    tap,
    highlightLot,
    listInto(el) { if (!el) return; views.add(el); renderList(el); },
    items: () => list.slice(),
    get drawing() { return !!draft; },
    destroy() {
      stopDrawing(); closeSheet(true); clearTimeout(flashT); document.removeEventListener('keydown', onKey); views.clear();
      for (const n of ['mine-areas', 'mine-marks', 'mine-ghost']) map.removeOverlay(n);
    },
  };
}
