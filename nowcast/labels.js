// nowcast/labels.js - Wallowa Weather (v018): the map's city names and value pills. Which places get a name (by how many people live
// there: big cities first; at a closer zoom the small towns too, and a lone town early where nothing bigger is near), where each name
// goes (beside its dot, never on another name, dot or pill, nor under the screen's own buttons, legend and card), what it says (the
// Census's legal kind dropped: "Lostine city" -> "Lostine", "Boise City" -> "Boise"), how it looks (a dot and the name on a halo: white
// on dark in the dark theme, near-black on white in the light one, decided by contrast tests; it reads on imagery and on colour fields),
// and the small rounded value pills under the names (map.set('pills', ...): "8" with an arrow drawn where the wind blows TO, "42°").
// The place sizes: nowcast/data/place_pop.txt.gz, read once (US Census Bureau: 2024 estimates for cities and towns, the ACS 2020-2024
// for census-designated places; the app's counties' own small places from USGS GNIS). Until it is read, the place table's own w.
// Pure functions besides that one read: map.js calls chooseLabels() every frame and drawLabels() to draw the choice.

const FAMILY = '-apple-system, BlinkMacSystemFont, system-ui, sans-serif';
export const LABEL_FONT = { major: `700 13px ${FAMILY}`, town: `600 12px ${FAMILY}` };
export const PILL_FONT = `700 11px ${FAMILY}`;
/** theme-aware, decided by contrast: the names sit on the satellite / relief imagery in both themes, which
 *  map.js darkens in the dark theme (white text wins there, 10.5 : 2.3 mean contrast) and lightens in the light one (near-black wins,
 *  5.6 : 4.9). Over everything else (forecast colour fields, radar, the topo map) the halo carries it: text vs halo >= 7:1 everywhere */
export const LABEL_STYLE = {
  light: { text: '#111111', halo: 'rgba(255,255,255,0.86)', haloWidth: 3.5, dot: '#111111', ring: 'rgba(255,255,255,0.92)' },
  dark: { text: '#FFFFFF', halo: 'rgba(0,0,0,0.8)', haloWidth: 3.5, dot: '#FFFFFF', ring: 'rgba(0,0,0,0.9)' },
};
/** a pill with no tone: the theme's own chip */
export const PILL_STYLE = {
  light: { fill: 'rgba(255,255,255,0.94)', edge: 'rgba(0,0,0,0.3)' },
  dark: { fill: 'rgba(28,30,38,0.92)', edge: 'rgba(255,255,255,0.25)' },
};
const MAJOR = 100000;           // people: a big city's name in the bigger type
const ISO_PX = 120;             // a place with no bigger place within this many px is named whatever its size
const SEP_PX = 14;              // ... and one with a bigger place nearer than this waits for a closer zoom (a city's suburbs)
const PILL_DOT_GAP = 3 + 3;   // v018 gallery: a pill's edge at least 3 px clear of another place's dot (its 3 px radius): never touching it
const ISO_W = 0.25;             // how much being alone adds to a place's rank (log10 people + ISO_W * log10 km to the next bigger place)
// last frame's names: ranked higher (x 3 people), kept down to 0.6 of the size floor, on their side, with tighter gaps (no flicker)
const STICKY = 0.5, HYST = 0.6, ISO_HYST = 0.8;
const MAXN = 80, MAX_LONE = 60, MAX_AHEAD = 200;
const GAP_X = 4, GAP_Y = 2, AVOID_GAP = 4, EDGE = 2, DOT_EDGE = 3;
const PILL_H = 16, PILL_PAD = 6, ARROW = 9, ARROW_GAP = 3;
/** where a name may go ([1 right | -1 left, 0 level | 1 a little below | -1 above]), tried in two steps: level, then below / above */
const SIDE = { r: [1, 0], l: [-1, 0], rb: [1, 1], ra: [1, -1], lb: [-1, 1], la: [-1, -1] }, LEVELS = [['r', 'l'], ['rb', 'ra', 'lb', 'la']];
const D2R = Math.PI / 180;

/** the size floor at a zoom: people a place needs to be named (a lone place needs none): 50,000 at zoom 5, a quarter of that a zoom
 *  level closer (12,500 at 6, 3,125 at 7, 780 at 8 ...), none from zoom 8 in */
const FLOOR5 = 50000, FLOOR_STEP = 4, FLOOR_NONE = 8;
export function floorPop(z) { return z >= FLOOR_NONE ? 0 : Math.round(FLOOR5 * Math.pow(FLOOR_STEP, 5 - z)); }
/** the zoom from which a place of `pop` people clears the size floor */
export const floorZoom = (pop) => Math.min(FLOOR_NONE, 5 - Math.log(Math.max(pop, 1e-9) / FLOOR5) / Math.log(FLOOR_STEP));

// ------------------------------------------------------------------------------------------------ names
const KIND = /\s+(?:city and borough|consolidated government \(balance\)|metropolitan government \(balance\)|metro government \(balance\)|unified government \(balance\)|unified government|consolidated government|metropolitan government|metro government|urban county|city \(balance\)|town \(balance\)|\(balance\)|municipality|borough|city|town|township|village|CDP|comunidad|zona urbana|plantation|corporation)$/;
/** legal names nobody says: 'ST|legal' (no state: the common reading) */
const LEGAL = new Map([['ID|Boise City', 'Boise'], ['|Boise City', 'Boise']]);
/** consolidated city-counties the Census names by both parts */
const CONSOLIDATED = new Map([['Nashville-Davidson', 'Nashville'], ['Lexington-Fayette', 'Lexington'], ['Butte-Silver Bow', 'Butte']]);
/** a name in parentheses is the one people use ("San Buenaventura (Ventura)" -> "Ventura"), except where the legal part is */
const KEEP_LEGAL = new Map([['Village of Oak Creek (Big Park)', 'Village of Oak Creek']]);
const NAMES = new Map();
/** the name a label shows. e: { name, st } or a string (no state: the common reading) -> a string ('' for nothing) */
export function cleanName(e) {
  const raw = typeof e === 'string' ? e : e && typeof e.name === 'string' ? e.name : '';
  const st = e && typeof e === 'object' && typeof e.st === 'string' ? e.st : '';
  const key = st + '|' + raw, hit = NAMES.get(key);
  if (hit !== undefined) return hit;
  let n = raw.replace(/\s+/g, ' ').trim();
  for (let k = 0; k < 3; k++) { const m = KIND.exec(n); if (!m) break; n = n.slice(0, m.index).trim(); }
  n = n.replace(/^Urban\s+(?=\S)/, '');
  if (KEEP_LEGAL.has(n)) n = KEEP_LEGAL.get(n);
  else { const p = /^(.*\S)\s*\(([^()]*\S[^()]*)\)$/.exec(n); if (p) n = p[2].trim(); }
  const comma = /^([^,]+),\s+\S.*$/.exec(n); if (comma) n = comma[1].trim();
  const county = /^(.+?)[-/].*\sCounty$/.exec(n); if (county) n = county[1].trim();
  if (CONSOLIDATED.has(n)) n = CONSOLIDATED.get(n);
  if (LEGAL.has(st + '|' + n)) n = LEGAL.get(st + '|' + n);
  else if (!st && LEGAL.has('|' + n)) n = LEGAL.get('|' + n);
  if (!n) n = raw.trim();
  if (NAMES.size > 50000) NAMES.clear();
  NAMES.set(key, n);
  return n;
}

// ------------------------------------------------------------------------------------------------ place sizes
let RANKS = null, VER = 1, LOADING = null, lastTry = -Infinity;
export const RANKS_URL = new URL('./data/place_pop.txt.gz', import.meta.url);
/** place_pop.txt -> { pop: Map('ST\tname' -> people), extra: [{ name, st, lat, lon, w: 0, pop: 0, local: true }], count } */
export function parseRanks(text) {
  const pop = new Map(), extra = []; let st = '', count = 0;
  for (const line of String(text || '').split('\n')) {
    if (!line || line[0] === '#') continue;
    if (line[0] === '@') { st = line.slice(1).trim(); continue; }
    if (line[0] === '+') {
      const f = line.slice(1).split('\t'), la = +f[2] / 100, lo = +f[3] / 100;
      if (f.length >= 4 && f[1] && Number.isFinite(la) && Number.isFinite(lo)) extra.push({ name: f[1], st: f[0], lat: la, lon: lo, w: 0, pop: 0, local: true });
      continue;
    }
    const t = line.indexOf('\t'), v = t > 0 ? +line.slice(t + 1) : NaN;
    if (Number.isFinite(v)) { pop.set(st + '\t' + line.slice(0, t), v); count++; }
  }
  return { pop, extra, count };
}
/** the sizes: their text, parseRanks()'s result, or null (back to the place table's w) */
export function setRanks(t) { RANKS = t == null ? null : typeof t === 'string' ? parseRanks(t) : t; VER++; }
export const ranksReady = () => !!RANKS;
/** read the sizes once (gzip, or a body the server already unpacked) -> Promise<true | false> (false: not read; never throws) */
export function loadRanks({ url = RANKS_URL, fetchFn = (u) => fetch(u) } = {}) {
  if (RANKS) return Promise.resolve(true);
  if (LOADING) return LOADING;
  const job = (async () => {
    try {
      const r = await fetchFn(url);
      if (!r || !r.ok) return false;
      let u8 = new Uint8Array(await r.arrayBuffer());
      if (u8.length > 2 && u8[0] === 0x1f && u8[1] === 0x8b) u8 = new Uint8Array(await new Response(new Blob([u8]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer());
      setRanks(new TextDecoder().decode(u8));
      return true;
    } catch (e) { return false; }
  })();
  LOADING = job;
  job.then(() => { if (LOADING === job) LOADING = null; });
  return job;
}
/** map.js: read the sizes if not yet (at most a try a minute), then onReady() (a redraw) */
export function ensureRanks(onReady) {
  const now = Date.now();
  if (RANKS || LOADING || now - lastTry < 60e3) return;
  lastTry = now;
  loadRanks().then((ok) => { if (ok && onReady) onReady(); });
}
const src = (e) => (e && e.src) || e;
/** does the place have a size of its own (not the place table's w)? */
export function hasPop(e) { const s = src(e); return !!s && (typeof s.pop === 'number' || (!!RANKS && RANKS.pop.has(s.st + '\t' + s.name))); }
/** people in a place: its own pop, the sizes table's, else the place table's w (thousands of people, or a CDP's km2) */
export function popOf(e) {
  if (!e) return 0;
  if (typeof e.pop === 'number') return e.pop;
  const s = src(e);
  if (typeof s.pop === 'number') return s.pop;
  if (RANKS) { const v = RANKS.pop.get(s.st + '\t' + s.name); return v != null ? v : 0; }
  return (+s.w || 0) * 1000;
}

// ------------------------------------------------------------------------------------------------ the index (once a place list)
const IDX = new WeakMap();
const mercX = (lon) => (lon + 180) / 360;
const mercY = (lat) => { const s = Math.sin(Math.max(-85, Math.min(85, lat)) * D2R); return 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI); };
function indexOf(places, withExtra) {
  const I = IDX.get(places);
  if (I && I.ver === VER && I.n === places.length && I.withExtra === withExtra) return I;
  const J = buildIndex(places, withExtra);
  IDX.set(places, J);
  return J;
}
function buildIndex(places, withExtra) {
  const ents = [];
  for (const e of places) if (e && typeof e.name === 'string' && Number.isFinite(+e.lat) && Number.isFinite(+e.lon)) ents.push(e);
  if (withExtra && RANKS && ents.length) for (const x of RANKS.extra) ents.push(x);   // the counties' small places join a real list only
  const n = ents.length, lat = new Float64Array(n), lon = new Float64Array(n), pop = new Float64Array(n), mx = new Float64Array(n), my = new Float64Array(n), cos = new Float64Array(n);
  const names = new Array(n), sts = new Array(n), idOf = new Map();
  for (let i = 0; i < n; i++) {
    const e = ents[i];
    lat[i] = +e.lat; lon[i] = +e.lon; pop[i] = Math.max(0, popOf(e) || 0); mx[i] = mercX(lon[i]); my[i] = mercY(lat[i]); cos[i] = Math.max(0.01, Math.cos(lat[i] * D2R));
    names[i] = e.name; sts[i] = String(e.st || '');
    if (!idOf.has(e)) idOf.set(e, i);
  }
  // ties: by name, state, then place (never by where it sits in the list: the same choice whatever the order of the places)
  const tie = (a, b) => (names[a] < names[b] ? -1 : names[a] > names[b] ? 1 : sts[a] < sts[b] ? -1 : sts[a] > sts[b] ? 1 : lat[a] - lat[b] || lon[a] - lon[b] || a - b);
  const byPop = Array.from({ length: n }, (_, i) => i).sort((a, b) => pop[b] - pop[a] || tie(a, b));
  const iso = isolation(byPop, lat, lon);
  const rank = new Float64Array(n), zmin = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    rank[i] = Math.log10(pop[i] + 1) + ISO_W * Math.log10(1 + iso[i]);
    // the zoom from which it may be named (sizes and isolation only; names still need room): see admit() in chooseLabels
    const zAt = (px) => (iso[i] > 0 ? Math.log2((px * 40075016.686 * cos[i]) / (iso[i] * 256000)) : Infinity);
    zmin[i] = Math.max(zAt(SEP_PX), Math.min(floorZoom(pop[i]), zAt(ISO_PX)));
  }
  const order = Int32Array.from(Array.from({ length: n }, (_, i) => i).sort((a, b) => rank[b] - rank[a] || tie(a, b)));
  // a 1-degree grid of the places, each cell in rank order (a close view takes its candidates from the cells it covers)
  const cells = new Map(), pos = new Int32Array(n);
  for (let k = 0; k < n; k++) {
    const i = order[k], key = cellKey(Math.floor(lat[i]), Math.floor(lon[i])), c = cells.get(key);
    pos[i] = k;
    if (c) c.push(i); else cells.set(key, [i]);
  }
  return { ver: VER, n: places.length, withExtra, ents, lat, lon, pop, iso, rank, zmin, mx, my, cos, tie, idOf, order, pos, cells, orders: new Map(), disp: new Array(n) };
}
const cellKey = (a, b) => (a + 200) * 1000 + (b + 400);
/** the places to try in a view, in rank order: from the grid cells it covers when it is small (a close zoom), else the zoom's list */
function candidatesIn(I, z, [w, s, e, n]) {
  const zq = Math.ceil(z * 4) / 4;
  if (!((e - w) * (n - s) <= 40)) return orderFrom(I, z);
  const got = [];
  for (let a = Math.floor(s); a <= Math.floor(n); a++) for (let b = Math.floor(w); b <= Math.floor(e); b++) {
    const c = I.cells.get(cellKey(a, b)); if (!c) continue;
    for (const i of c) if (I.zmin[i] <= zq + 1e-9) got.push(i);
  }
  const pos = I.pos;
  got.sort((a, b) => pos[a] - pos[b]);
  return got;
}
/** the order kept to the places that may be named from zoom zq on (a quarter-zoom step, cached): a frame skips the rest at once */
function orderFrom(I, z) {
  const zq = Math.ceil(z * 4) / 4;
  let o = I.orders.get(zq);
  if (!o) {
    const keep = [];
    for (const i of I.order) if (I.zmin[i] <= zq + 1e-9) keep.push(i);
    o = Int32Array.from(keep);
    if (I.orders.size > 64) I.orders.clear();
    I.orders.set(zq, o);
  }
  return o;
}
/** km from each place to the nearest place ahead of it in `order` (bigger, or as big and first by name): a grid of 0.5 degree cells,
 *  searched ring by ring out from the place; 1500 km at most */
function isolation(order, lat, lon) {
  const CELL = 0.5, MAXD = 1500, out = new Float32Array(lat.length), grid = new Map();
  const ck = (ci, cj) => (ci + 400) * 4000 + (cj + 2000);
  for (const i of order) {
    const la = lat[i], lo = lon[i], ci = Math.floor(la / CELL), cj = Math.floor(lo / CELL);
    const kx = Math.max(0.01, Math.cos(la * D2R)) * 111.32, ky = 110.57, cellKm = CELL * Math.min(kx, ky);
    let best2 = Infinity, best = Infinity;
    const visit = (a, b) => {
      const cell = grid.get(ck(a, b)); if (!cell) return;
      for (const j of cell) { const dx = (lon[j] - lo) * kx, dy = (lat[j] - la) * ky, d2 = dx * dx + dy * dy; if (d2 < best2) best2 = d2; }
    };
    for (let r = 0; (r - 1) * cellKm <= Math.min(best, MAXD); r++) {
      if (r === 0) visit(ci, cj);
      else {
        for (let d = -r; d <= r; d++) { visit(ci - r, cj + d); visit(ci + r, cj + d); }
        for (let d = -r + 1; d <= r - 1; d++) { visit(ci + d, cj - r); visit(ci + d, cj + r); }
      }
      best = Math.sqrt(best2);
    }
    out[i] = Math.min(best, MAXD);
    const k = ck(ci, cj), cell = grid.get(k);
    if (cell) cell.push(i); else grid.set(k, [i]);
  }
  return out;
}
/** the entry a label carries (and a tap gives view.js): the place with its clean name and its size; .src = the place table's entry */
function display(I, i) {
  let d = I.disp[i];
  if (!d) {
    const e = I.ents[i];
    d = I.disp[i] = { name: cleanName(e) || e.name, st: e.st, lat: I.lat[i], lon: I.lon[i], w: e.w, pop: I.pop[i], src: e };
  }
  return d;
}
/** why a place is (not) named: { name, pop, isoKm (to the next bigger place), rank, zmin (the zoom from which its size and isolation
 *  let it be named) } | null (not in the list) */
export function placeInfo(places, e) {
  const I = indexOf(Array.isArray(places) ? places : [], true), i = I.idOf.get(src(e));
  return i === undefined ? null : { name: display(I, i).name, pop: I.pop[i], isoKm: I.iso[i], rank: I.rank[i], zmin: I.zmin[i] };
}

// ------------------------------------------------------------------------------------------------ choosing
const MEASURES = new WeakMap();
const estimate = (t, font) => String(t).length * (+((/(\d+(?:\.\d+)?)px/.exec(font) || [0, 12])[1])) * 0.58;
function widthOf(measure, text, font) {
  let c = MEASURES.get(measure);
  if (!c) { c = new Map(); MEASURES.set(measure, c); }
  const k = font + '\u0000' + text; let w = c.get(k);
  if (w === undefined) { w = +measure(text, font) || 0; if (c.size > 6000) c.clear(); c.set(k, w); }
  return w;
}
const pillKey = (lat, lon) => Math.round(lat * 100) * 100000 + Math.round(lon * 100);
function cleanPill(q) {
  if (!q || typeof q !== 'object' || !Number.isFinite(+q.lat) || !Number.isFinite(+q.lon) || q.text == null || String(q.text) === '') return null;
  const deg = Number.isFinite(q.arrowDeg) ? ((q.arrowDeg % 360) + 360) % 360 : null;
  return { lat: +q.lat, lon: +q.lon, text: String(q.text).slice(0, 12), arrowDeg: deg, tone: typeof q.tone === 'string' ? q.tone : null };
}
/** a pill's box and its parts, centred on cx with its top at y */
function pillAt(q, cx, y, measure) {
  const tw = widthOf(measure, q.text, PILL_FONT), arrowW = q.arrowDeg == null ? 0 : ARROW + ARROW_GAP, w = 2 * PILL_PAD + tw + arrowW;
  const b = { x: cx - w / 2, y, w, h: PILL_H };
  return { text: q.text, arrowDeg: q.arrowDeg, tone: q.tone, lat: q.lat, lon: q.lon, b, font: PILL_FONT, padX: PILL_PAD, arrowW, tx: b.x + PILL_PAD, ty: y + PILL_H / 2,
    arrow: q.arrowDeg == null ? null : { cx: b.x + w - PILL_PAD - ARROW / 2, cy: y + PILL_H / 2, size: ARROW, deg: q.arrowDeg } };
}
/** a box grid (cells of 48 px): collision tests touch only the boxes near. Kinds: 'dot', 'name', 'pill' (placed), 'res' (a dot kept
 *  free for a place still to come: names avoid covering it when they can) */
function boxGrid() {
  const CELL = 48, cells = new Map();
  const span = (b, mx, my, f) => {
    const x0 = Math.floor((b.x - mx) / CELL), x1 = Math.floor((b.x + b.w + mx) / CELL), y0 = Math.floor((b.y - my) / CELL), y1 = Math.floor((b.y + b.h + my) / CELL);
    for (let gy = y0; gy <= y1; gy++) for (let gx = x0; gx <= x1; gx++) if (f(gy * 4096 + gx) === true) return true;
    return false;
  };
  const touch = (b, q, mx, my) => b.x < q.x + q.w + mx && b.x + b.w + mx > q.x && b.y < q.y + q.h + my && b.y + b.h + my > q.y;
  return {
    add(b, kind, who = -1) { const r = { b, kind, who }; span(b, 0, 0, (k) => { const c = cells.get(k); if (c) c.push(r); else cells.set(k, [r]); }); },
    /** does b (a name or pill box; or a dot) touch a placed box, with the gaps between names kept (slack: last frame's name, tighter gaps)? */
    // dotGap: the room kept from other places' dots (v018: a pill keeps PILL_DOT_GAP, so a chip never reads as a neighbour's value)
    hits(b, dot, slack = false, dotGap = 1) {
      const gx = slack ? -1 : GAP_X, gy = slack ? -1 : GAP_Y, gd = slack ? (dotGap > 1 ? dotGap - 2 : -2) : dotGap;   // last frame's name: may overlap by a px or two
      return span(b, Math.max(gx, gd, 0), Math.max(gy, gd, 0), (k) => {
        const c = cells.get(k); if (!c) return false;
        for (const r of c) {
          if (r.kind === 'res') continue;
          const near = dot || r.kind === 'dot';
          if (touch(b, r.b, near ? gd : gx, near ? gd : gy)) return true;
        }
        return false;
      });
    },
    /** the rank of the most important place still to come whose kept-free dot b covers (-Infinity: none) */
    covers(b, me, pending, rank) {
      let worst = -Infinity;
      span(b, 1, 1, (k) => {
        const c = cells.get(k); if (!c) return false;
        for (const r of c) if (r.kind === 'res' && r.who !== me && pending.has(r.who) && touch(b, r.b, 1, 1) && rank[r.who] > worst) worst = rank[r.who];
        return false;
      });
      return worst;
    },
  };
}
function cleanBoxes(avoid) {
  const out = [];
  if (Array.isArray(avoid)) for (const a of avoid) if (a && [a.x, a.y, a.w, a.h].every((v) => Number.isFinite(+v)) && a.w > 0 && a.h > 0) out.push({ x: +a.x, y: +a.y, w: +a.w, h: +a.h });
  return out;
}
/** Web Mercator views (map.js) project linearly from the index's Mercator x / y: found from three points; anything else: view.project */
function fastProject(view) {
  try {
    const [w, s, e, n] = view.bounds, p1 = view.project(n, w), p2 = view.project(s, e), lc = (s + n) / 2, oc = (w + e) / 2, p3 = view.project(lc, oc);
    const X1 = mercX(w), X2 = mercX(e), Y1 = mercY(n), Y2 = mercY(s);
    if (!(Math.abs(X2 - X1) > 1e-12 && Math.abs(Y2 - Y1) > 1e-12)) return null;
    const ax = (p2.x - p1.x) / (X2 - X1), bx = p1.x - ax * X1, ay = (p2.y - p1.y) / (Y2 - Y1), by = p1.y - ay * Y1;
    if (!Number.isFinite(ax + bx + ay + by)) return null;
    if (Math.abs(ax * mercX(oc) + bx - p3.x) > 0.01 || Math.abs(ay * mercY(lc) + by - p3.y) > 0.01) return null;
    return { ax, bx, ay, by };
  } catch (err) { return null; }
}

/** which places get a name, and where. places: the place table's entries [{ name, st, lat, lon, w }] (or any with their own .pop);
 *  view: { w, h (CSS px), bounds [w, s, e, n], project(lat, lon) -> { x, y } }; zoom: the map's; avoidBoxes: the controls' boxes
 *  [{ x, y, w, h }]; measure(text, font) -> px. opts: { prev: the last choice (its names are kept where they still fit: no flicker),
 *  pills: [{ lat, lon, text, arrowDeg?, tone? }] or a function (the places that may be named) -> that list, extra: false (no GNIS
 *  small places), trace: [] (why each place of the zoom's list in view got its name or not: placed, floor, near, edge, avoid,
 *  collide, cap; places far too small for the zoom are skipped unseen) }.
 *  A place may be named when it has the people for the zoom (floorPop) or no bigger place within ISO_PX, and no bigger place nearer
 *  than SEP_PX; they are tried most important first (people, and a little for being alone); a name goes right of its dot, else left,
 *  else a little below or above (a side that would cover the dot of a place still to come is avoided when another is free); a pill
 *  goes under its name, and gives way first (a place keeps its name without its pill).
 *  -> [{ e (the place, clean name, .src = the table's entry), name, x, y, p: {x, y} (the dot), tx (text start), ty (text middle),
 *       b (the name's box), font, major, side 'r' | 'l' | 'rb' | 'ra' | 'lb' | 'la' (right / left, b: a little below, a: above),
 *       rank, isolated, sticky, pill: null | { text, b, tx, ty, font, arrow, tone, ... } }]
 *     in the order placed (most important first), with .lone = the pills drawn alone (no place tried for a name there) */
export function chooseLabels(places, view, zoom, avoidBoxes = [], measure = null, opts = {}) {
  const out = []; out.lone = [];
  if (!view || !view.bounds || typeof view.project !== 'function' || !(view.w > 0 && view.h > 0)) return out;
  opts = opts || {};
  const I = indexOf(Array.isArray(places) ? places : [], opts.extra !== false);
  const W = view.w, H = view.h, [bw, bs, be, bn] = view.bounds, avoid = cleanBoxes(avoidBoxes), meas = typeof measure === 'function' ? measure : estimate;
  const trace = Array.isArray(opts.trace) ? opts.trace : null;
  const z = Number.isFinite(+zoom) ? +zoom : 6, floor = floorPop(z), mpp0 = 40075016.686 / (256 * 2 ** z);
  const lin = fastProject(view), LAT = I.lat, LON = I.lon, MX = I.mx, MY = I.my, POP = I.pop, ISO = I.iso, COS = I.cos, RANK = I.rank;
  const order = candidatesIn(I, z, view.bounds);
  const proj = (i) => (lin ? { x: lin.ax * MX[i] + lin.bx, y: lin.ay * MY[i] + lin.by } : view.project(LAT[i], LON[i]));
  const pxPerKm = 1000 / mpp0;
  // last frame's names (by place): ranked higher, kept down to a lower floor, on the side they were, with tighter gaps
  const prev = new Map();
  if (Array.isArray(opts.prev)) for (const l of opts.prev) { const i = l && l.e ? I.idOf.get(src(l.e)) : undefined; if (i !== undefined && !prev.has(i)) prev.set(i, l); }
  const sticky = [...prev.keys()].sort((a, b) => RANK[b] - RANK[a] || I.tie(a, b));
  /** 1: has the people; 2: alone (no bigger place within ISO_PX); 0: too small for this zoom; -1: a bigger place right next to it */
  const admit = (i, st) => {
    const isoPx = (ISO[i] * pxPerKm) / COS[i];
    if (isoPx < SEP_PX * (st ? ISO_HYST : 1)) return -1;
    if (POP[i] >= floor * (st ? HYST : 1)) return 1;
    return isoPx >= ISO_PX * (st ? ISO_HYST : 1) ? 2 : 0;
  };
  // the order tried: last frame's names merged in by their raised rank
  let si = 0, oi = 0;
  const next = () => {   // -> index, with nextSticky set; -1 at the end
    while (si < sticky.length || oi < order.length) {
      if (si < sticky.length && (oi >= order.length || RANK[sticky[si]] + STICKY >= RANK[order[oi]])) { nextSticky = true; return sticky[si++]; }
      const i = order[oi++];
      if (!prev.has(i)) { nextSticky = false; return i; }
    }
    return -1;
  };
  let nextSticky = false;
  const inView = (i) => { const la = LAT[i], lo = LON[i]; return la >= bs && la <= bn && lo >= bw && lo <= be; };
  const onScreen = (p) => p.x >= DOT_EDGE && p.y >= DOT_EDGE && p.x <= W - DOT_EDGE && p.y <= H - DOT_EDGE;
  const fits = (b, e = EDGE) => b.x >= e && b.y >= e && b.x + b.w <= W - e && b.y + b.h <= H - e;
  const clear = (b) => {
    for (let k = 0; k < avoid.length; k++) { const a = avoid[k]; if (b.x < a.x + a.w + AVOID_GAP && b.x + b.w + AVOID_GAP > a.x && b.y < a.y + a.h + AVOID_GAP && b.y + b.h + AVOID_GAP > a.y) return false; }
    return true;
  };
  // a first look ahead: the first places that may be named here (their dots are kept free where a name can go the other way; a pills
  // function gets them)
  const G = boxGrid(), pending = new Set(), ahead = [];
  for (let i = next(); i >= 0 && ahead.length < MAX_AHEAD; i = next()) {
    if (!inView(i) || admit(i, nextSticky) <= 0) continue;
    const p = proj(i), dot = { x: p.x - 3, y: p.y - 3, w: 6, h: 6 };
    if (!onScreen(p) || !clear(dot)) continue;
    ahead.push(i); pending.add(i); G.add(dot, 'res', i);
  }
  si = 0; oi = 0;
  let pillList = opts.pills;
  if (typeof pillList === 'function') { try { pillList = pillList(ahead.map((i) => display(I, i))); } catch (err) { pillList = null; } }
  const pills = new Map(), loneOrder = [];
  if (Array.isArray(pillList)) for (const raw of pillList) { const q = cleanPill(raw); if (!q) continue; const k = pillKey(q.lat, q.lon); if (!pills.has(k)) { pills.set(k, q); loneOrder.push(k); } }
  const considered = new Set();
  const note = (i, why) => { pending.delete(i); if (trace) trace.push({ name: display(I, i).name, st: I.ents[i].st, pop: POP[i], why }); };

  for (let i = next(); i >= 0; i = next()) {
    const st = nextSticky;
    if (!inView(i)) continue;
    const how = admit(i, st);
    if (how <= 0) { note(i, how < 0 ? 'near' : 'floor'); continue; }
    if (out.length >= MAXN) { if (!trace) break; note(i, 'cap'); continue; }
    let x, y;
    if (lin) { x = lin.ax * MX[i] + lin.bx; y = lin.ay * MY[i] + lin.by; } else { const p = view.project(LAT[i], LON[i]); x = p.x; y = p.y; }
    if (!(x >= DOT_EDGE && y >= DOT_EDGE && x <= W - DOT_EDGE && y <= H - DOT_EDGE)) { note(i, 'edge'); continue; }
    const dot = { x: x - 3, y: y - 3, w: 6, h: 6 };
    if (!clear(dot)) { note(i, 'avoid'); continue; }
    if (G.hits(dot, true, st)) { note(i, 'collide'); continue; }
    const d = display(I, i), pk = pills.size ? pillKey(d.lat, d.lon) : 0, q = pills.size ? pills.get(pk) || null : null;
    if (q) considered.add(pk);
    const major = d.pop >= MAJOR, font = major ? LABEL_FONT.major : LABEL_FONT.town, h = major ? 17 : 16;
    const tw = widthOf(meas, d.name, font);
    // the ways to place it, best first: with its pill, then without; level with the dot (right, then left; last frame's side first),
    // then a little below or above (right, then left); at each step a side that keeps others' dots free, else the one over the least
    // important dot of a place still to come (only within a step: a name stays level with its dot when it can)
    const was = st && SIDE[prev.get(i).side] ? prev.get(i).side : null;
    const steps = was ? [[was], ...LEVELS.map((l) => l.filter((k) => k !== was))] : LEVELS;
    let got = null, why = 'collide';
    for (const withPill of q ? [true, false] : [false]) {
      for (const step of steps) {
        let spare = null, spareCost = Infinity;
        for (const side of step) {
          const [lr, dv] = SIDE[side], by = dv ? (dv > 0 ? y + 3 : y - 3 - h) : y - h / 2;
          const b = lr > 0 ? { x: x + 5, y: by, w: tw + 4, h } : { x: x - 9 - tw, y: by, w: tw + 4, h };
          if (!fits(b, st ? 0 : EDGE)) { why = 'edge'; continue; }
          if (!clear(b)) { why = 'avoid'; continue; }
          if (G.hits(b, false, st)) { why = 'collide'; continue; }
          const tx = lr > 0 ? x + 6 : x - 6 - tw;
          let pill = null;
          if (withPill) { pill = pillAt(q, tx + tw / 2, b.y + b.h + 1, meas); if (!(fits(pill.b) && clear(pill.b) && !G.hits(pill.b, false, st, PILL_DOT_GAP))) continue; }
          const way = { b, tx, ty: by + h / 2, side, pill };
          const cost = st ? -Infinity : Math.max(G.covers(b, i, pending, RANK), pill ? G.covers(pill.b, i, pending, RANK) : -Infinity);
          if (cost === -Infinity) { got = way; break; }
          if (cost < spareCost) { spare = way; spareCost = cost; }   // else: the side over the least important dot
        }
        got = got || spare;
        if (got) break;
      }
      if (got) break;   // a way with the pill, even a step down, beats one without it
    }
    if (!got) { note(i, why); continue; }
    G.add(dot, 'dot'); G.add(got.b, 'name'); if (got.pill) G.add(got.pill.b, 'pill');
    out.push({ e: d, name: d.name, x, y, p: { x, y }, tx: got.tx, ty: got.ty, b: got.b, font, major, side: got.side, rank: RANK[i] + (st ? STICKY : 0),
      isolated: how === 2, sticky: st, pill: got.pill });
    note(i, 'placed');
  }
  // v018 gallery: a chip that ends up hugging another named place's dot (that place was named after it) reads as that place's value:
  // the chip goes, its name stays
  for (const l of out) {
    if (!l.pill) continue;
    const q = l.pill.b;
    for (const o of out) {
      if (o === l) continue;
      const dx = Math.max(q.x - o.x, 0, o.x - (q.x + q.w)), dy = Math.max(q.y - o.y, 0, o.y - (q.y + q.h));
      if (Math.hypot(dx, dy) < PILL_DOT_GAP) { l.pill = null; break; }
    }
  }
  // lone pills: where no place was even tried for a name (a pill whose place lost its name is not drawn alone)
  for (const k of loneOrder) {
    if (out.lone.length >= MAX_LONE) break;
    if (considered.has(k)) continue;
    const q = pills.get(k);
    if (q.lat < bs || q.lat > bn || q.lon < bw || q.lon > be) continue;
    let p; try { p = view.project(q.lat, q.lon); } catch (err) { continue; }
    if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y)) continue;
    const pill = pillAt(q, p.x, p.y - PILL_H / 2, meas);
    if (!(fits(pill.b) && clear(pill.b) && !G.hits(pill.b, false, false, PILL_DOT_GAP))) continue;
    G.add(pill.b, 'pill'); out.lone.push(pill);
  }
  return out;
}

// ------------------------------------------------------------------------------------------------ colours
/** '#rgb' | '#rrggbb' | '#rrggbbaa' | 'rgb(r, g, b)' | 'rgba(r, g, b, a)' (commas or spaces) -> [r, g, b, a] | null */
export function parseColor(c) {
  if (typeof c !== 'string') return null;
  const s = c.trim().toLowerCase();
  let m = /^#([0-9a-f]{3,8})$/.exec(s);
  if (m) {
    const h = m[1];
    if (h.length === 3 || h.length === 4) return [...h.slice(0, 3)].map((x) => parseInt(x + x, 16)).concat(h.length === 4 ? parseInt(h[3] + h[3], 16) / 255 : 1);
    if (h.length === 6 || h.length === 8) return [0, 2, 4].map((k) => parseInt(h.slice(k, k + 2), 16)).concat(h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1);
    return null;
  }
  m = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:\s*[,/]\s*([\d.]+%?))?\s*\)$/.exec(s);
  if (!m) return null;
  const a = m[4] == null ? 1 : m[4].endsWith('%') ? parseFloat(m[4]) / 100 : parseFloat(m[4]);
  const v = [+m[1], +m[2], +m[3]].map((x) => Math.max(0, Math.min(255, x)));
  return v.every(Number.isFinite) && Number.isFinite(a) ? [...v, Math.max(0, Math.min(1, a))] : null;
}
/** a see-through colour over an opaque one -> the opaque mix */
export function over(top, under) {
  const a = top[3] == null ? 1 : top[3];
  return [0, 1, 2].map((k) => top[k] * a + under[k] * (1 - a)).concat(1);
}
const toLinear = (v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
const lum = (c) => 0.2126 * toLinear(c[0]) + 0.7152 * toLinear(c[1]) + 0.0722 * toLinear(c[2]);
/** WCAG contrast ratio of two colours ([r, g, b, a]; alpha ignored) */
export function contrast(a, b) { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); }
/** the pill's text colour: black or white, whichever reads better on the tone (an unreadable tone: the theme's chip) */
export function pillTextColor(tone, dark = false) {
  const c = parseColor(tone) || parseColor(PILL_STYLE[dark ? 'dark' : 'light'].fill);
  return contrast(c, [255, 255, 255, 1]) >= contrast(c, [0, 0, 0, 1]) ? '#FFFFFF' : '#000000';
}
/** the wind arrow: a polygon (tip first) in a size x size box at (cx, cy), pointing where the wind blows TO (deg clockwise from north) */
export function arrowPath(cx, cy, size, deg) {
  const s = size / 2, a = (+deg || 0) * D2R, c = Math.cos(a), si = Math.sin(a), neck = 0.05 * s;
  const P = [[0, -s], [0.8 * s, -neck], [0.26 * s, -neck], [0.26 * s, s], [-0.26 * s, s], [-0.26 * s, -neck], [-0.8 * s, -neck]];
  return P.map(([x, y]) => [cx + x * c - y * si, cy + x * si + y * c]);
}

// ------------------------------------------------------------------------------------------------ drawing
function roundRect(ctx, x, y, w, h, r) {
  r = Math.min(r, h / 2, w / 2);
  ctx.moveTo(x + r, y); ctx.lineTo(x + w - r, y); ctx.arc(x + w - r, y + r, r, -Math.PI / 2, Math.PI / 2);
  ctx.lineTo(x + r, y + h); ctx.arc(x + r, y + r, r, Math.PI / 2, (3 * Math.PI) / 2); ctx.closePath();
}
function drawPill(ctx, q, dark) {
  const P = PILL_STYLE[dark ? 'dark' : 'light'], fill = parseColor(q.tone) ? q.tone : P.fill, ink = pillTextColor(q.tone, dark), b = q.b;
  ctx.beginPath(); roundRect(ctx, b.x, b.y, b.w, b.h, b.h / 2);
  ctx.fillStyle = fill; ctx.fill(); ctx.lineWidth = 1; ctx.strokeStyle = parseColor(q.tone) ? 'rgba(0,0,0,0.35)' : P.edge; ctx.stroke();
  ctx.font = q.font; ctx.textBaseline = 'middle'; ctx.textAlign = 'left'; ctx.fillStyle = ink; ctx.fillText(q.text, q.tx, q.ty + 0.5);
  if (q.arrow) {
    const pts = arrowPath(q.arrow.cx, q.arrow.cy, q.arrow.size, q.arrow.deg);
    ctx.beginPath(); pts.forEach(([x, y], k) => (k ? ctx.lineTo(x, y) : ctx.moveTo(x, y))); ctx.closePath();
    ctx.fillStyle = ink; ctx.fill();
  }
}
/** draw a choice (chooseLabels' result): the dots, the pills, then the names on top */
export function drawLabels(ctx, chosen, { dark = false } = {}) {
  if (!ctx || !chosen) return;
  const S = LABEL_STYLE[dark ? 'dark' : 'light'];
  ctx.save();
  ctx.lineJoin = 'round'; ctx.miterLimit = 2;
  for (const l of chosen) {
    ctx.beginPath(); ctx.arc(l.x, l.y, l.major ? 3.2 : 2.6, 0, 2 * Math.PI);
    ctx.fillStyle = S.dot; ctx.fill(); ctx.lineWidth = 1.3; ctx.strokeStyle = S.ring; ctx.stroke();
  }
  for (const l of chosen) if (l.pill) drawPill(ctx, l.pill, dark);
  for (const q of chosen.lone || []) drawPill(ctx, q, dark);
  ctx.textBaseline = 'middle'; ctx.textAlign = 'left';
  for (const l of chosen) {
    const ty = l.ty == null ? l.y : l.ty;
    ctx.font = l.font; ctx.lineWidth = S.haloWidth; ctx.strokeStyle = S.halo; ctx.strokeText(l.name, l.tx, ty);
    ctx.fillStyle = S.text; ctx.fillText(l.name, l.tx, ty);
  }
  ctx.restore();
}
