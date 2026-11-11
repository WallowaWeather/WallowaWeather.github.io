// nowcast/map.js - the Nowcast's map: one canvas, Web Mercator, pan with a finger, pinch or the wheel to zoom, a double tap to zoom in.
// Layers, bottom up: the basemap (NASA GIBS Blue Marble shaded relief: US government imagery, tiles fetched from NASA, nothing else),
// the rain (radar or nowcast pictures on their own lat / lon grids, drawn in thin strips so they sit right on Mercator), the bundled
// Census coast, state and county lines, NWS warning outlines, the nowcast area's outline, city names from the on-phone Census table
// (more as you zoom in; never under the screen's own buttons and card: avoid() gives their boxes), and the "you are here" dot. A tap on
// a city name or a long press anywhere asks for that place's forecast.
import { linesIn } from './lines.js';
import { LANDS_STYLE } from './lands.js';   // Wallowa Weather (v006): the public land colours
import { chooseLabels, drawLabels as drawChosen, ensureRanks } from './labels.js';   // v018: the city names and value pills

export const GIBS = 'https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/BlueMarble_ShadedRelief_Bathymetry/default/GoogleMapsCompatible_Level8/{z}/{y}/{x}.jpeg';
const TILE = 256, MAXTZ = 8, D2R = Math.PI / 180;
const wx = (lon, z) => ((lon + 180) / 360) * TILE * 2 ** z;
const wy = (lat, z) => { const s = Math.sin(Math.max(-85, Math.min(85, lat)) * D2R); return (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * TILE * 2 ** z; };
const lonOf = (x, z) => (x / (TILE * 2 ** z)) * 360 - 180;
const latOf = (y, z) => { const n = Math.PI - (2 * Math.PI * y) / (TILE * 2 ** z); return (180 / Math.PI) * Math.atan(Math.sinh(n)); };
// v018: colour fields drawn smooth on the GPU (WebGL2, else WebGL1, else the 2D path as before); the same Mercator (gl/proj.js = the above)
import { normField, colorize } from './gl/field.js';
import { createFieldRenderer } from './gl/renderer.js';

/** v018 options: gl 'auto' | 'webgl2' | 'webgl1' | '2d' (how fields are drawn), glSoftware (accept software GL: the tests only) */
export function createMap(canvas, { tileUrl = GIBS, sources = null, fetchFn = (...a) => fetch(...a), onTap = () => {}, onTapEmpty = () => {}, onLongPress = () => {}, onMove = () => {}, avoid = () => [], dark = () => false, minZoom = 3.2, maxZoom = 11, gl: glMode = 'auto', glSoftware = false } = {}) {
  const ctx0 = canvas.getContext('2d');
  let ctx = ctx0;   // v018: while an animation runs, the layers under / over it are painted into two kept canvases (the same calls)
  const st = { lat: 37.5, lon: -96, z: 3.6, w: 0, h: 0, dpr: 1 };
  const tiles = new Map();   // 'z/x/y' -> { img, at } | { p }
  const L = { lines: null, rain: null, nowcast: null, warnings: [], alerts: [], outlines: [], places: [], here: null, pick: null, parcels: [], lot: null, lands: [], roads: null, me: null };
  let labels = [], raf = 0, pending = false, gone = false;
  const overlays = [];   // v008: modules draw their own layers: { name, z (order), draw(ctx, api) } (BEAM, fans, drainages, my layers, affected lots)
  const FIELDS = new Map(), anims = new Set();   // v018: setField's fields (name -> { F, seq }); requestFrame's functions
  let fseq = 0, R = null, dirty = true, cache = null, split = null, lastDrawn = [], lastPaintMs = 0;

  function size() {
    const r = canvas.getBoundingClientRect(), dpr = Math.min(2, globalThis.devicePixelRatio || 1);
    if (!r.width || !r.height) return false;
    st.w = r.width; st.h = r.height; st.dpr = dpr;
    const W = Math.round(r.width * dpr), H = Math.round(r.height * dpr);
    if (canvas.width !== W || canvas.height !== H) { canvas.width = W; canvas.height = H; }
    return true;
  }
  /** screen (CSS px) <-> lat / lon */
  const origin = () => ({ x: wx(st.lon, st.z) - st.w / 2, y: wy(st.lat, st.z) - st.h / 2 });
  const toScreen = (lat, lon) => { const o = origin(); return { x: wx(lon, st.z) - o.x, y: wy(lat, st.z) - o.y }; };
  const toLatLon = (x, y) => { const o = origin(); return { lat: latOf(o.y + y, st.z), lon: lonOf(o.x + x, st.z) }; };
  const view = () => { const a = toLatLon(0, 0), b = toLatLon(st.w, st.h); return [a.lon, b.lat, b.lon, a.lat]; };

  // Wallowa Weather: the basemap is a STACK of sources (src: { id, url ({z}/{y}/{x}), maxNative, minZoom, bounds [s, w, n, e], alpha, blend })
  let SRC = sources || [{ id: 'gibs', url: tileUrl, maxNative: MAXTZ }];
  const tileBox = (z, x, y) => ({ w: lonOf(x * TILE, z), e: lonOf((x + 1) * TILE, z), n: latOf(y * TILE, z), s: latOf((y + 1) * TILE, z) });
  function tile(z, x, y, src = SRC[0]) {
    const n = 2 ** z; if (y < 0 || y >= n) return null;
    const xx = ((x % n) + n) % n, k = `${src.id}/${z}/${xx}/${y}`, t = tiles.get(k);
    if (t) { t.at = performance.now(); if (watchTiles && !t.img && !t.failed) watchTiles.add(k); return t.img || null; }
    const rec = { at: performance.now(), img: null }; tiles.set(k, rec); if (watchTiles) watchTiles.add(k);
    fetchFn(src.urlFor ? src.urlFor(z, xx, y) : src.url.replace('{z}', z).replace('{x}', xx).replace('{y}', y)).then((r) => (r.ok ? r.blob() : null)).then((b) => (b ? createImageBitmap(b) : null))
      .then((img) => { if (gone) { if (img && img.close) img.close(); return; } rec.img = img; if (!img) rec.failed = true; draw(); }, () => { rec.failed = true; /* offline: the map goes on without it */ });
    if (tiles.size > 360) {   // the oldest tiles go (more room: several sources at high zoom)
      const old = [...tiles.entries()].sort((a, b) => a[1].at - b[1].at).slice(0, 40);
      for (const [kk, v] of old) { if (v.img && v.img.close) v.img.close(); tiles.delete(kk); }
    }
    return null;
  }
  function drawBase() {
    for (const src of SRC) drawSource(src);
    ctx.fillStyle = dark() ? 'rgba(0,0,0,0.38)' : 'rgba(255,255,255,0.12)'; ctx.fillRect(0, 0, st.w, st.h);
  }
  /** one basemap source: tiles at min(its native zoom, the view's) stretched to the view; only inside its bounds; parents while loading */
  function drawSource(src) {
    if (src.minZoom != null && st.z < src.minZoom) return;
    const tz = Math.max(0, Math.min(src.maxNative == null ? MAXTZ : src.maxNative, Math.round(st.z))), sc = 2 ** (st.z - tz), o = origin();
    const x0 = Math.floor(o.x / sc / TILE), y0 = Math.floor(o.y / sc / TILE), x1 = Math.floor((o.x + st.w) / sc / TILE), y1 = Math.floor((o.y + st.h) / sc / TILE);
    ctx.save(); ctx.globalAlpha = src.alpha == null ? 1 : src.alpha; if (src.blend) ctx.globalCompositeOperation = src.blend;
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      if (src.bounds) { const b = tileBox(tz, x, y), [S0, W0, N0, E0] = src.bounds; if (b.s > N0 || b.n < S0 || b.w > E0 || b.e < W0) continue; }
      let img = tile(tz, x, y, src), dz = 0, px = x, py = y;
      while (!img && dz < 3 && tz - dz > 0) { dz++; px = Math.floor(x / 2 ** dz); py = Math.floor(y / 2 ** dz); const zz = tz - dz, nn = 2 ** zz; const t = tiles.get(`${src.id}/${zz}/${((px % nn) + nn) % nn}/${py}`); img = t && t.img; }
      const s = TILE * sc;
      if (img && dz) { const f = 2 ** dz, k = (img.width || TILE) / TILE, sx = (x - px * f) * TILE / f, sy = (y - py * f) * TILE / f; ctx.drawImage(img, sx * k, sy * k, TILE / f * k, TILE / f * k, x * s - o.x, y * s - o.y, s + 0.5, s + 0.5); }
      else if (img) ctx.drawImage(img, x * s - o.x, y * s - o.y, s + 0.5, s + 0.5);
    }
    ctx.restore();
  }
  /** satellite clouds: src = { maxZ, alpha, get(z, x, y) -> ImageBitmap | null (it loads what is missing and calls draw()) }; v018: or
   *  src.draw(ctx, api) - the satellite layer draws itself (its level for the screen, fades between frames, one picture with no seams) */
  function drawClouds(src) {
    if (src.draw) { ctx.save(); try { src.draw(ctx, overlayApi()); } catch (e) { console.error('[map] clouds', e); } ctx.restore(); return; }
    const tz = Math.max(0, Math.min(src.maxZ, Math.round(st.z))), sc = 2 ** (st.z - tz), o = origin(), s = TILE * sc, n = 2 ** tz;
    const x0 = Math.floor(o.x / s), y0 = Math.floor(o.y / s), x1 = Math.floor((o.x + st.w) / s), y1 = Math.floor((o.y + st.h) / s);
    // see-through tiles meet on whole device pixels: an overlap would be drawn twice (a light line along every tile edge)
    const px = (v) => Math.round(v * st.dpr) / st.dpr;
    ctx.save(); ctx.globalAlpha = src.alpha == null ? 1 : src.alpha;
    for (let y = Math.max(0, y0); y <= Math.min(n - 1, y1); y++) for (let x = x0; x <= x1; x++) {
      const img = src.get(tz, ((x % n) + n) % n, y), l = px(x * s - o.x), t = px(y * s - o.y);
      if (img) ctx.drawImage(img, l, t, px((x + 1) * s - o.x) - l, px((y + 1) * s - o.y) - t);
    }
    ctx.restore();
  }
  /** a grid's box on screen */
  const gridRect = (g) => { const a = toScreen(g.top, g.left), b = toScreen(g.top - g.rows * g.dlat, g.left + g.cols * g.dlon); return { x: a.x, y: a.y, w: b.x - a.x, h: b.y - a.y }; };
  /** a picture on a lat / lon grid: row r at lat top - r * dlat, column c at lon left + c * dlon; drawn in strips of 8 rows. `hole`:
   *  a screen rectangle left out (the fine radar is drawn there instead, so no rain is drawn twice); `c`: the context drawn into (the
   *  map's own, or one the size of the map with the same CSS-px transform, like the hatching's) */
  function drawGrid(g, alpha = 1, hole = null, c = ctx) {
    if (!g || !g.canvas) return;
    const v = view(), n = g.rows, strip = 8;
    c.save(); c.globalAlpha = alpha; c.imageSmoothingEnabled = false;
    if (hole) { c.beginPath(); c.rect(0, 0, st.w, st.h); c.rect(hole.x, hole.y, hole.w, hole.h); c.clip('evenodd'); }
    // strip edges snapped to whole device pixels: neighbouring strips meet exactly (an overlap would draw see-through colours twice)
    const snap = (y) => Math.round(y * st.dpr) / st.dpr;
    const xa = snap(toScreen(0, g.left).x), xb = snap(toScreen(0, g.left + g.cols * g.dlon).x);
    for (let r = 0; r < n; r += strip) {
      const la = g.top - r * g.dlat, lb = g.top - Math.min(n, r + strip) * g.dlat;
      if (lb > v[3] || la < v[1]) continue;
      const ya = snap(toScreen(la, 0).y), yb = snap(toScreen(lb, 0).y);
      if (yb > ya) c.drawImage(g.canvas, 0, r, g.cols, Math.min(strip, n - r), xa, ya, xb - xa, yb - ya);
    }
    c.restore();
  }
  function path(pts, close) {   // pts: Int32Array thousandths (lon, lat, ...)
    for (let i = 0; i < pts.length; i += 2) { const p = toScreen(pts[i + 1] / 1000, pts[i] / 1000); if (i) ctx.lineTo(p.x, p.y); else ctx.moveTo(p.x, p.y); }
    if (close) ctx.closePath();
  }
  function drawLines() {
    if (!L.lines) return;
    const v = view(), want = st.z >= 6.2 ? ['outline', 'state', 'county'] : ['outline', 'state'], got = linesIn(L.lines, v, want), dk = dark();
    const style = { county: [dk ? 'rgba(255,255,255,0.22)' : 'rgba(30,30,40,0.22)', 0.7], state: [dk ? 'rgba(255,255,255,0.6)' : 'rgba(25,25,35,0.55)', 1.2], outline: [dk ? 'rgba(255,255,255,0.75)' : 'rgba(25,25,35,0.65)', 1.1] };
    for (const c of want) { ctx.beginPath(); for (const p of got[c] || []) path(p); ctx.strokeStyle = style[c][0]; ctx.lineWidth = style[c][1]; ctx.stroke(); }
  }
  /** Wallowa Weather (v006): public land (National Forest, Wilderness, BLM): a see-through fill and a thin edge, under the weather */
  function drawLands() {
    if (!L.lands || !L.lands.length) return;
    const v = view();
    for (const a of L.lands) {
      const s = LANDS_STYLE[a.kind]; if (!s) continue;
      if (a.bbox && (a.bbox[0] > v[2] || a.bbox[2] < v[0] || a.bbox[1] > v[3] || a.bbox[3] < v[1])) continue;
      ctx.beginPath();
      for (const poly of a.polys) for (const ring of poly) ring.forEach(([lon, lat], i) => { const p = toScreen(lat, lon); if (i) ctx.lineTo(p.x, p.y); else ctx.moveTo(p.x, p.y); });
      ctx.fillStyle = s.fill; ctx.fill('evenodd');
      ctx.strokeStyle = s.edge; ctx.lineWidth = s.width; ctx.stroke();
    }
  }
  /** Wallowa Weather (v006): the person's GPS position: the accuracy ring, a cone the way the phone points, the dot */
  function drawMe() {
    const m = L.me; if (!m) return;
    const p = toScreen(m.lat, m.lon), mpp = 40075016.686 * Math.cos(m.lat * D2R) / (TILE * 2 ** st.z);
    if (m.acc) { const r = m.acc / mpp; if (r > 12) { ctx.beginPath(); ctx.arc(p.x, p.y, Math.min(r, 4000), 0, 2 * Math.PI); ctx.fillStyle = 'rgba(10,132,255,0.12)'; ctx.fill(); ctx.lineWidth = 1; ctx.strokeStyle = 'rgba(10,132,255,0.5)'; ctx.stroke(); } }
    if (m.heading != null) {
      const a = (m.heading - 90) * D2R, h = (m.spread || 30) * D2R, R = 56, g = ctx.createRadialGradient(p.x, p.y, 4, p.x, p.y, R);
      g.addColorStop(0, 'rgba(10,132,255,0.6)'); g.addColorStop(1, 'rgba(10,132,255,0)');
      ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.arc(p.x, p.y, R, a - h, a + h); ctx.closePath(); ctx.fillStyle = g; ctx.fill();
    }
    ctx.beginPath(); ctx.arc(p.x, p.y, 7.5, 0, 2 * Math.PI); ctx.fillStyle = '#0A84FF'; ctx.fill(); ctx.lineWidth = 2.5; ctx.strokeStyle = '#fff'; ctx.stroke();
  }
  /** Wallowa Weather: the county's lot lines at zoom 12+ (lighter below 14) */
  function drawParcels() {
    if (st.z < 12 || !L.parcels || !L.parcels.length) return;
    const [w, s, e, n] = view();
    ctx.beginPath();
    for (const l of L.parcels) {
      const b = l.box; if (b[2] < w || b[0] > e || b[3] < s || b[1] > n) continue;
      for (const poly of l.polys) for (const ring of poly) ring.forEach(([lon, lat], i) => { const p = toScreen(lat, lon); if (i) ctx.lineTo(p.x, p.y); else ctx.moveTo(p.x, p.y); });
    }
    const far = st.z < 14;
    ctx.lineJoin = 'round'; ctx.strokeStyle = far ? 'rgba(0,0,0,0.35)' : 'rgba(0,0,0,0.45)'; ctx.lineWidth = far ? 1.6 : 2.4; ctx.stroke();
    ctx.strokeStyle = far ? 'rgba(255,241,176,0.8)' : 'rgba(255,241,176,0.95)'; ctx.lineWidth = far ? 0.7 : 1; ctx.stroke();
    if (L.lot && !shotPublic) {   // v020: the lot picked: never in a public picture
      ctx.beginPath();
      for (const poly of L.lot.polys) for (const ring of poly) ring.forEach(([lon, lat], i) => { const p = toScreen(lat, lon); if (i) ctx.lineTo(p.x, p.y); else ctx.moveTo(p.x, p.y); });
      ctx.strokeStyle = 'rgba(0,0,0,0.55)'; ctx.lineWidth = 5; ctx.stroke(); ctx.strokeStyle = '#FFD60A'; ctx.lineWidth = 2.6; ctx.stroke();
    }
  }
  function drawWarnings() {
    for (const w of L.warnings) {
      ctx.beginPath();
      for (const ring of w.rings) { ring.forEach(([lon, lat], i) => { const p = toScreen(lat, lon); if (i) ctx.lineTo(p.x, p.y); else ctx.moveTo(p.x, p.y); }); ctx.closePath(); }
      ctx.strokeStyle = w.color; ctx.lineWidth = 2.5; ctx.stroke();   // v057: NWS warnings are a LINED box (the app's own alerts are hatched)
    }
  }
  /** v057: the app's own alert areas (StormScope pilot): diagonal hatching in the hazard's colour inside a thin dashed edge */
  function drawAlerts() {
    for (const a of L.alerts || []) {
      const pts = a.rings[0].map(([lon, lat]) => toScreen(lat, lon)); if (pts.length < 3) continue;
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity; for (const p of pts) { x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y); }
      if (x1 < 0 || y1 < 0 || x0 > st.w || y0 > st.h) continue;
      ctx.save(); ctx.beginPath(); pts.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y))); ctx.closePath();
      ctx.fillStyle = a.color + '1A'; ctx.fill(); ctx.clip();
      ctx.beginPath(); for (let d = x0 - (y1 - y0); d < x1; d += 7) { ctx.moveTo(d, y1); ctx.lineTo(d + (y1 - y0), y0); }
      ctx.strokeStyle = a.color + 'B3'; ctx.lineWidth = 1.6; ctx.stroke(); ctx.restore();
      ctx.beginPath(); pts.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y))); ctx.closePath();
      ctx.setLineDash([4, 3]); ctx.strokeStyle = a.color; ctx.lineWidth = 1.2; ctx.stroke(); ctx.setLineDash([]);
    }
  }
  /** radar quality marks: a dashed ring around each isolated speck (drawn as it is, never removed), hatching over low-quality radar.
   *  q.mask (v011): a grid picture, opaque on every low-quality pixel: the hatching is drawn at the SCREEN's resolution inside it (the
   *  old q.hatch, every third pixel of the 1 km grid inked, became a checkerboard of squares zoomed in; it is still drawn as it was) */
  function drawQc() {
    const q = L.qc; if (!q) return;
    if (q.mask && q.mask.canvas) drawHatch(q.mask);
    else if (q.hatch) drawGrid(q.hatch);
    const r = Math.max(7, 3 * TILE * 2 ** st.z / 40075);   // about 3 km, at least 7 px
    ctx.save(); ctx.setLineDash([3, 3]); ctx.lineWidth = 1.5; ctx.strokeStyle = dark() ? 'rgba(255,255,255,0.9)' : 'rgba(20,20,30,0.85)';
    for (const s of q.rings || []) { const p = toScreen(s.lat, s.lon); if (p.x < -20 || p.y < -20 || p.x > st.w + 20 || p.y > st.h + 20) continue; ctx.beginPath(); ctx.arc(p.x, p.y, r, 0, 2 * Math.PI); ctx.stroke(); }
    ctx.restore();
  }
  /** the mask into a canvas the map's size (kept from frame to frame: resized only when the map is), then the hatch lines kept only
   *  where the mask is ('source-in' over the whole canvas, so the result is the same however a browser bounds the operation), then
   *  that onto the map. The lines are fixed to the screen (they do not crawl as the map pans) and drawn at its resolution. */
  let hatchBuf = null, hatchPat = null;
  function drawHatch(g) {
    const W = canvas.width, H = canvas.height, dk = dark();
    if (!hatchBuf) hatchBuf = newCanvas(W, H);
    else if (hatchBuf.width !== W || hatchBuf.height !== H) { hatchBuf.width = W; hatchBuf.height = H; }
    const b = hatchBuf.getContext('2d');
    b.setTransform(1, 0, 0, 1, 0, 0); b.globalCompositeOperation = 'source-over'; b.globalAlpha = 1; b.clearRect(0, 0, W, H);
    b.setTransform(st.dpr, 0, 0, st.dpr, 0, 0); drawGrid(g, 1, null, b);
    if (!hatchPat || hatchPat.dpr !== st.dpr || hatchPat.dk !== dk) hatchPat = { dpr: st.dpr, dk, p: b.createPattern(hatchTile(st.dpr, dk), 'repeat') };
    b.setTransform(1, 0, 0, 1, 0, 0); b.globalCompositeOperation = 'source-in'; b.fillStyle = hatchPat.p; b.fillRect(0, 0, W, H);
    b.globalCompositeOperation = 'source-over';
    ctx.save(); ctx.imageSmoothingEnabled = false; ctx.drawImage(hatchBuf, 0, 0, st.w, st.h); ctx.restore();
  }
  function drawOutlines() {
    for (const o of L.outlines) {
      ctx.beginPath(); o.corners.forEach((c, i) => { const p = toScreen(c.lat, c.lon); if (i) ctx.lineTo(p.x, p.y); else ctx.moveTo(p.x, p.y); }); ctx.closePath();
      ctx.setLineDash([6, 5]); ctx.strokeStyle = o.color || (dark() ? 'rgba(200,190,255,0.9)' : 'rgba(80,60,220,0.85)'); ctx.lineWidth = 1.5; ctx.stroke(); ctx.setLineDash([]);
    }
  }
  /** v018: city names (labels.js: by people, relative to the zoom; never under the screen's own buttons and card: avoid() gives their
   *  boxes) with the value pills of map.set('pills', [{ lat, lon, text, arrowDeg?, tone? }] | fn(places) | null) under them */
  const measure = (t, f) => { ctx.font = f; return ctx.measureText(t).width; };
  function drawLabels() {
    let keep = []; try { keep = avoid() || []; } catch (e) { /* no boxes: draw everywhere */ }
    if (L.places.length) ensureRanks(draw);   // the place sizes, read once; until then the table's own w
    labels = chooseLabels(L.places, { w: st.w, h: st.h, bounds: view(), project: toScreen }, st.z, keep, measure, { prev: labels, pills: L.pills });
    drawChosen(ctx, labels, { dark: dark() });
  }
  let shotNoHere = false;   // v018 review: snapshot({ here: false }) - a picture without the place's dot
  let watchTiles = null;    // v020: the tiles a picture at another view asks for (snapshotAt waits for them)
  let shotPublic = false;   // v020: a public picture (snapshotAt): the person's own marks left out (overlays marked personal, the parts an
                            // overlay keeps for the person when api.public is set, the lot picked), as are the place's and the tapped spot's dots
  function drawHere() {
    if (shotNoHere) return;
    for (const [pt, kind] of [[L.pick, 'pick'], [L.here, 'here']]) {
      if (!pt) continue;
      const p = toScreen(pt.lat, pt.lon);
      ctx.beginPath(); ctx.arc(p.x, p.y, kind === 'here' ? 11 : 9, 0, 2 * Math.PI); ctx.fillStyle = kind === 'here' ? 'rgba(10,132,255,0.22)' : 'rgba(139,124,255,0.25)'; ctx.fill();
      ctx.beginPath(); ctx.arc(p.x, p.y, 5.5, 0, 2 * Math.PI); ctx.fillStyle = kind === 'here' ? '#0A84FF' : '#8B7CFF'; ctx.fill(); ctx.lineWidth = 2; ctx.strokeStyle = '#fff'; ctx.stroke();
    }
  }
  function frame(t) {
    raf = 0; pending = false; if (gone || !size()) return;
    const t0 = performance.now();
    if (anims.size) {   // v018: an animation runs: the layers under and over it are kept, painted again only when the map changed
      const stale = dirty || (cache ? cache.b.width !== canvas.width || cache.b.height !== canvas.height : cache !== false);
      if (stale) { dirty = false; if (cache !== false) renderCaches(); else paint(true); lastPaintMs = performance.now() - t0; onMove({ lat: st.lat, lon: st.lon, z: st.z, view: view() }); }
      if (cache) composite(t == null ? t0 : t); else if (!stale) paint(true);   // no canvas to keep layers in: the whole map each frame
      pending = true; raf = requestAnimationFrame(frame); return;
    }
    dirty = false; if (cache) freeCaches(); cache = null;
    paint(true); lastPaintMs = performance.now() - t0;
    onMove({ lat: st.lat, lon: st.lon, z: st.z, view: view() });
  }
  /** one whole picture of the map into the canvas; withMe = false leaves out the person's GPS layer (snapshot) */
  function paint(withMe) {
    ctx.setTransform(st.dpr, 0, 0, st.dpr, 0, 0); ctx.clearRect(0, 0, st.w, st.h);
    ctx.fillStyle = dark() ? '#0B0D12' : '#C9D3DC'; ctx.fillRect(0, 0, st.w, st.h);
    drawBase();
    drawLands();   // v006: public land, under the clouds and the rain
    if (L.clouds) drawClouds(L.clouds);
    drawFields();   // v018: setField's fields, the radar and the nowcast: smooth colour fields on the GPU (drawFields says how)
    midLayer();     // v018: requestFrame's animation goes here (over the fields, under the roads, lines, marks and names)
    drawQc();
    if (L.roads) drawSource(L.roads);   // v006: roads over the rain, under the lot lines and the alerts
    drawParcels(); drawLines();
    drawOverlays(0);   // v008: area layers (BEAM chances, drainages, my shapes) over the lot lines, under the alerts
    drawAlerts(); drawWarnings(); drawOutlines();
    drawOverlays(1);   // v008: marks (fans, lightning, highlighted lots) over the alerts, under the names
    drawLabels(); drawHere(); if (withMe) drawMe();   // v057: the app's alerts under the NWS lines
  }
  function draw() { dirty = true; if (!pending) { pending = true; raf = requestAnimationFrame(frame); } }
  // v018: project = toScreen, bounds() = [w, s, e, n], zoom = z; drawGrid draws a grid of codes / values (or a paint() canvas) smooth on the GPU
  const overlayApi = () => ({ toScreen, toLatLon, view: view(), z: st.z, w: st.w, h: st.h, dpr: st.dpr, dark: dark(), mpp: (lat) => 40075016.686 * Math.cos(lat * D2R) / (TILE * 2 ** st.z), drawGrid: drawGridApi,
    project: toScreen, bounds: view, zoom: st.z, public: shotPublic });
  function drawOverlays(level) {
    if (!overlays.length) return; const api = overlayApi();
    for (const o of overlays) { if ((o.level || 0) !== level || (shotPublic && o.personal)) continue; ctx.save(); try { o.draw(ctx, api); } catch (e) { console.error('[map] overlay', o.name, e); } ctx.restore(); }
  }

  // ---------------------------------------------------------------------------------------------- v018: colour fields and animation
  // A field (gl/field.js) is drawn on the GPU (gl/renderer.js: per pixel inverse Mercator, value-space interpolation that never mixes in
  // nodata, then the colour ramp) and copied into this canvas at its place in the layer order; with no GPU (or a lost context) the same
  // field is drawn the 2D way as before (one pixel a texel, nearest). The radar's one-byte codes keep today's colours at every level.
  const rend = () => R || (R = createFieldRenderer({ force: glMode, allowSoftware: glSoftware, onChange: () => draw() }));
  const gridF = new WeakMap();   // a layer's grid object (set('rain' | 'nowcast')) -> its field: a new object is new data, uploaded again
  const arrF = new WeakMap();    // api.drawGrid: a values array -> { key, F } (the same array and table = the same field, no upload)
  const slotF = {}, f2d = new WeakMap(), ids = new WeakMap(); let idn = 0;
  const idOf = (o) => (o && typeof o === 'object' ? ids.get(o) || (ids.set(o, ++idn), idn) : String(o));
  /** a grid of codes / values, or a canvas made by paint() (it remembers its codes) -> its field; null = a plain picture */
  function asField(g) {
    if (!g) return null;
    if (g.codes || g.values) return normField(g);
    const t = g.canvas && TAG.get(g.canvas);
    return t && t.codes.length === (g.rows | 0) * (g.cols | 0) ? normField({ top: g.top, left: g.left, dlat: g.dlat, dlon: g.dlon, rows: g.rows, cols: g.cols, codes: t.codes, lut: t.lut }) : null;
  }
  function releaseSlot(slot, keep = null) { if (slotF[slot] && slotF[slot] !== keep && R) R.release(slotF[slot]); slotF[slot] = keep; }
  function layerItem(g, slot) {
    let F = gridF.get(g);
    if (F === undefined) { try { F = asField(g); } catch (e) { console.warn('[map]', slot, e.message); F = null; } gridF.set(g, F); }
    releaseSlot(slot, F);
    return { name: slot, F, g };
  }
  /** the fields under the roads: setField's (by z), then the radar (z 100: the 4 km picture with the 1 km crop's box left out - never both
   *  in one place: two see-through layers made the radar look stronger than the nowcast), then the nowcast (z 101). The 4 km radar zoomed
   *  in (a texel 4 CSS px or more) is smoothed a little more (B-spline). */
  function drawFields() {
    lastDrawn = [];
    const items = [];
    for (const [name, s] of FIELDS) items.push({ name, F: s.F, z: s.F.z, seq: s.seq });
    if (L.rain && L.rain.coarse) {
      const fine = L.rain.fine, it = layerItem(L.rain.coarse, 'rain-coarse');
      it.z = 100; it.seq = -3; it.hole = fine ? gridRect(fine) : null;
      if (it.F && it.F.grid.dlon * TILE * 2 ** st.z / 360 >= 4) it.smooth = 2;
      items.push(it);
    } else releaseSlot('rain-coarse');
    if (L.rain && L.rain.fine) { const it = layerItem(L.rain.fine, 'rain-fine'); it.z = 100; it.seq = -2; items.push(it); } else releaseSlot('rain-fine');
    if (L.nowcast) { const it = layerItem(L.nowcast, 'nowcast'); it.z = 101; it.seq = -1; items.push(it); } else releaseSlot('nowcast');
    items.sort((a, b) => a.z - b.z || a.seq - b.seq);
    if (items.length) drawItems(items, ctx);
  }
  /** fields and pictures in order into c: a run of fields in one GPU pass when it can, else each the 2D way */
  function drawItems(items, c) {
    const r = items.some((it) => it.F) ? rend() : null, gpu = !!(r && r.ok());
    let run = [];
    const flush = () => {
      if (!run.length) return;
      if (r.draw(c, run, { lat: st.lat, lon: st.lon, z: st.z, w: st.w, h: st.h, dpr: st.dpr }, canvas.width, canvas.height)) lastDrawn.push(...(r.stats.drawn || []));
      else for (const it of run) draw2D(it, c);
      run = [];
    };
    for (const it of items) { if (it.F && gpu && r.fits(it.F)) run.push(it); else { flush(); draw2D(it, c); } }
    flush();
  }
  function draw2D(it, c) {
    const a = it.alpha == null ? 1 : it.alpha;
    lastDrawn.push({ name: it.name || null, smooth: 0, aa: 0, d2: true });
    if (it.g && it.g.canvas) { drawGrid(it.g, a, it.hole || null, c); return; }   // today's picture as it was painted
    if (!it.F) return;
    let pic = f2d.get(it.F);
    if (pic === undefined) { pic = picture(it.F); f2d.set(it.F, pic); }
    if (pic) drawGrid(Object.assign({ canvas: pic }, it.F.grid), a, it.hole || null, c);
  }
  function picture(F) {
    const { cols: w, rows: h } = F.grid; let cv = null; try { cv = newCanvas(w, h); } catch (e) { return null; }
    const g = cv.getContext('2d'), im = g.createImageData(w, h); im.data.set(colorize(F)); g.putImageData(im, 0, 0); return cv;
  }
  /** api.drawGrid (overlays): a grid of codes / values / a paint() canvas is drawn as a field; anything else as before. Pass a NEW values
   *  array for new data (the same array and table are not uploaded again). */
  function drawGridApi(g, alpha = 1, hole = null, c = ctx) {
    const t = g && g.canvas && TAG.get(g.canvas), arr = g && (g.codes || g.values || (t && t.codes));
    if (!arr) { drawGrid(g, alpha, hole, c); return; }
    const gg = g.grid || g, key = [gg.top, gg.left, gg.dlat, gg.dlon, gg.rows, gg.cols, g.code, idOf(g.lut || (t && t.lut)), idOf(g.ramp), g.nodata, g.scale, g.offset, g.smooth, g.opacity, g.dry].join();
    let e = arrF.get(arr);
    if (!e || e.key !== key) {
      let F = null; try { F = g.codes || g.values ? normField(g) : asField(g); } catch (x) { console.warn('[map] drawGrid', x.message); }
      if (e && e.F && R) R.release(e.F);
      arrF.set(arr, (e = { key, F }));
    }
    if (e.F) drawItems([{ name: g.name || 'overlay', F: e.F, g: g.canvas ? g : null, alpha, hole }], c); else if (g.canvas) drawGrid(g, alpha, hole, c);
  }
  /** the animation's place in paint(): splitting the kept layers there, or (a whole paint while animating, the snapshot) the animation */
  function midLayer() {
    if (split) { ctx = split; ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, canvas.width, canvas.height); ctx.setTransform(st.dpr, 0, 0, st.dpr, 0, 0); return; }
    if (anims.size) drawAnims(performance.now());
  }
  function drawAnims(t) {
    const api = overlayApi();
    for (const fn of [...anims]) { ctx.save(); try { fn(ctx, api, t); } catch (e) { console.error('[map] frame', e); } ctx.restore(); }
  }
  function renderCaches() {
    const W = canvas.width, H = canvas.height;
    if (!cache) { try { cache = { b: newCanvas(W, H), a: newCanvas(W, H) }; } catch (e) { cache = false; paint(true); return; } }
    for (const c of [cache.b, cache.a]) if (c.width !== W || c.height !== H) { c.width = W; c.height = H; }
    split = cache.a.getContext('2d'); ctx = cache.b.getContext('2d');
    try { paint(true); } finally { ctx = ctx0; split = null; }
  }
  function composite(t) {
    const W = canvas.width, H = canvas.height;
    ctx0.setTransform(1, 0, 0, 1, 0, 0); ctx0.clearRect(0, 0, W, H); ctx0.drawImage(cache.b, 0, 0);
    ctx0.setTransform(st.dpr, 0, 0, st.dpr, 0, 0); drawAnims(t);
    ctx0.setTransform(1, 0, 0, 1, 0, 0); ctx0.drawImage(cache.a, 0, 0); ctx0.setTransform(st.dpr, 0, 0, st.dpr, 0, 0);
  }
  function freeCaches() { if (cache) for (const c of [cache.a, cache.b]) { c.width = 0; c.height = 0; } cache = null; }

  // ---------------------------------------------------------------------------------------------- gestures
  const pts = new Map(); let pinch = null, press = 0, moved = false, lastTap = 0, downAt = null, tapT = 0, longFired = false;
  const clampZ = (z) => Math.max(minZoom, Math.min(maxZoom, z));
  function zoomAt(z, sx, sy) {
    z = clampZ(z); const a = toLatLon(sx, sy);
    st.z = z; const p = toScreen(a.lat, a.lon); const o = origin();   // keep the point under the finger
    st.lon = lonOf(o.x + (p.x - sx) + st.w / 2, z); st.lat = latOf(o.y + (p.y - sy) + st.h / 2, z); draw();
  }
  function panBy(dx, dy) { const o = origin(); st.lon = lonOf(o.x - dx + st.w / 2, st.z); st.lat = Math.max(15, Math.min(60, latOf(o.y - dy + st.h / 2, st.z))); draw(); }
  const local = (e) => { const r = canvas.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
  canvas.addEventListener('pointerdown', (e) => {
    canvas.setPointerCapture(e.pointerId); const p = local(e); pts.set(e.pointerId, p); moved = false; downAt = p;
    clearTimeout(press); if (pts.size === 1) longFired = false;
    // a long press's release is not also a tap (nor a click on the sheet it just opened under the finger: touchend below)
    if (pts.size === 1) press = setTimeout(() => { if (!moved && pts.size === 1) { moved = longFired = true; const ll = toLatLon(p.x, p.y); onLongPress(ll.lat, ll.lon); } }, 550);
    if (pts.size === 2) { const [a, b] = [...pts.values()]; pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), z: st.z }; clearTimeout(press); }
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!pts.has(e.pointerId)) return;
    const p = local(e), q = pts.get(e.pointerId); pts.set(e.pointerId, p);
    if (Math.hypot(p.x - downAt.x, p.y - downAt.y) > 6) { moved = true; clearTimeout(press); }
    if (pts.size === 2 && pinch) {
      const [a, b] = [...pts.values()], d = Math.hypot(a.x - b.x, a.y - b.y);
      panBy((p.x - q.x) / 2, (p.y - q.y) / 2); zoomAt(pinch.z + Math.log2(d / pinch.d), (a.x + b.x) / 2, (a.y + b.y) / 2);
    } else if (pts.size === 1) panBy(p.x - q.x, p.y - q.y);
  });
  const up = (e) => {
    if (!pts.has(e.pointerId)) return;
    const p = local(e); pts.delete(e.pointerId); clearTimeout(press);
    if (pts.size < 2) pinch = null;
    if (e.type === 'pointercancel') { moved = true; return; }   // the browser took the touch (Android: a system gesture): not a tap
    if (!moved && pts.size === 0) {
      const now = performance.now();
      if (now - lastTap < 320) { clearTimeout(tapT); zoomAt(st.z + 1, p.x, p.y); lastTap = 0; return; }
      lastTap = now;
      const hit = labels.find((l) => p.x >= Math.min(l.b.x, l.p.x - 6) && p.x <= Math.max(l.b.x + l.b.w, l.p.x + 6) && p.y >= l.b.y - 4 && p.y <= l.b.y + l.b.h + 4);
      if (hit) onTap(hit.e);
      else { const ll = toLatLon(p.x, p.y); clearTimeout(tapT); tapT = setTimeout(() => onTapEmpty(ll.lat, ll.lon, st.z), 330); }   // wait: a double tap zooms instead
    }
  };
  canvas.addEventListener('pointerup', up); canvas.addEventListener('pointercancel', up);
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());   // Android Chrome: a long press is the map's own (no menu, no cancelled touch)
  canvas.addEventListener('touchend', (e) => { if (longFired && e.cancelable) e.preventDefault(); }, { passive: false });   // no click after a long press
  canvas.addEventListener('wheel', (e) => { e.preventDefault(); const p = local(e); zoomAt(st.z - e.deltaY / 300, p.x, p.y); }, { passive: false });
  const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => draw()) : null; if (ro) ro.observe(canvas);

  return {
    draw, toScreen, toLatLon, view,
    get state() { return { lat: st.lat, lon: st.lon, z: st.z }; },
    /** centre on a point at a zoom (the 256 km box fills a phone screen at about 8) */
    center(lat, lon, z = st.z) { st.lat = lat; st.lon = lon; st.z = clampZ(z); draw(); },
    /** fit a lat / lon box */
    fit(s, w, n, e, pad = 24) {
      if (!size()) return;
      const span = Math.max((wx(e, 0) - wx(w, 0)) / (st.w - 2 * pad), (wy(s, 0) - wy(n, 0)) / (st.h - 2 * pad));
      st.z = clampZ(Math.log2(1 / span)); st.lon = (w + e) / 2; st.lat = latOf((wy(s, st.z) + wy(n, st.z)) / 2, st.z); draw();
    },
    set(k, v) { L[k] = v; draw(); },
    /** v018: a smooth colour field under the roads and names: f = { grid: { top, left, dlat, dlon, rows, cols }, values
     *  (Float32Array | Uint8Array | Uint16Array, row 0 = north; NaN / nodata = transparent), nodata?, scale?, offset? (physical = raw x scale
     *  + offset), ramp [[value, [r, g, b, a 0..1]], ...], smooth? (true bilinear | false nearest | 'bspline'), opacity?, z? (higher on top;
     *  the radar is z 100, the nowcast 101), dry? (values at or under it are "none": outlined at the cell edge) } | null = remove. A new
     *  object is new data (uploaded once; pans and zooms upload nothing). Bad input throws a TypeError. */
    setField(name, f) {
      const old = FIELDS.get(name);
      if (f) FIELDS.set(name, { F: normField(f), seq: old ? old.seq : ++fseq }); else FIELDS.delete(name);
      if (old && R) R.release(old.F);
      draw();
    },
    /** v018: fn(ctx, api, tMs) every frame while registered (wind streaks): over the fields, under the roads, lines, marks and names; the
     *  layers under and over it are kept between frames (painted again only when the map changes) */
    requestFrame(fn) { if (typeof fn === 'function') { anims.add(fn); draw(); } },
    cancelFrame(fn) { if (anims.delete(fn)) draw(); },
    /** v018: how the fields are drawn: { backend 'webgl2' | 'webgl1' | '2d', fields, uploads, uploadBytes, passes, lost, restored, dpr,
     *  lastPaintMs, drawn [{ name, smooth, aa }], canvas (the GPU's), maxTex } */
    renderInfo() {
      const r = rend();
      return { backend: r.kind, fields: FIELDS.size, uploads: r.stats.uploads, uploadBytes: r.stats.uploadBytes, passes: r.stats.passes, lost: r.stats.lost, restored: r.stats.restored,
        dpr: st.dpr, lastPaintMs, drawn: lastDrawn.slice(), canvas: r.canvas || null, maxTex: r.caps ? r.caps.maxTex : 0 };
    },
    /** the field report's picture: the map as it is now, WITHOUT the person's own GPS layer (the dot, its accuracy ring, the heading cone)
     *  and centred on the view's middle rounded to `round` degrees (0.001, about 100 m), so neither a mark nor the picture's middle gives
     *  the exact position away. The screen is drawn again as it was before the browser shows it.
     *  -> { canvas (device px), w, h (CSS px), dpr, toScreen(lat, lon) in the picture's CSS px } | null */
    snapshot({ round = 1e-3, here = true } = {}) {
      if (gone || !size()) return null;
      const keep = { lat: st.lat, lon: st.lon };
      if (round > 0) { st.lat = Math.round(st.lat / round) * round; st.lon = Math.round(st.lon / round) * round; }
      const o = origin(), z = st.z, shot = { canvas: null, w: st.w, h: st.h, dpr: st.dpr, toScreen: (la, lo) => ({ x: wx(lo, z) - o.x, y: wy(la, z) - o.y }) };
      try {
        shotNoHere = !here; paint(false);
        const c = newCanvas(canvas.width, canvas.height); c.getContext('2d').drawImage(canvas, 0, 0); shot.canvas = c;
      } finally { shotNoHere = false; st.lat = keep.lat; st.lon = keep.lon; paint(true); dirty = true; }
      return shot;
    },
    /** v020: a picture of the map at another view { lat, lon, z } (a public post's: its middle snapped, zoomed out) - that view's tiles
     *  fetched first (up to `wait` ms), then drawn as snapshot() draws (no GPS layer; here: false leaves the place's dot out too) - and as a
     *  public picture: none of the person's own marks (My layers' pins and shapes, a lot picked; mine: true draws them, for tests only) */
    async snapshotAt(v, { here = false, mine = false, wait = 4000 } = {}) {
      if (gone || !size() || !v || !isFinite(v.lat) || !isFinite(v.lon) || !isFinite(v.z)) return null;
      const keep = { lat: st.lat, lon: st.lon, z: st.z }, want = new Set();
      try { watchTiles = want; st.lat = v.lat; st.lon = v.lon; st.z = clampZ(v.z); paint(false); }   // asks for that view's tiles
      finally { watchTiles = null; st.lat = keep.lat; st.lon = keep.lon; st.z = keep.z; paint(true); dirty = true; }
      const t0 = performance.now(), pending = () => [...want].some((k) => { const t = tiles.get(k); return t && !t.img && !t.failed; });
      while (pending() && performance.now() - t0 < wait && !gone) await new Promise((r) => setTimeout(r, 120));
      if (gone) return null;
      const back = { lat: st.lat, lon: st.lon, z: st.z }, o = { x: 0, y: 0 };
      let shot = null;
      try {
        st.lat = v.lat; st.lon = v.lon; st.z = clampZ(v.z); shotNoHere = !here; shotPublic = !mine; paint(false);
        const og = origin(), z = st.z; o.x = og.x; o.y = og.y;
        const c = newCanvas(canvas.width, canvas.height); c.getContext('2d').drawImage(canvas, 0, 0);
        shot = { canvas: c, w: st.w, h: st.h, dpr: st.dpr, z, toScreen: (la, lo) => ({ x: wx(lo, z) - o.x, y: wy(la, z) - o.y }) };
      } finally { shotNoHere = false; shotPublic = false; st.lat = back.lat; st.lon = back.lon; st.z = back.z; paint(true); dirty = true; }
      return shot;
    },
    /** v008: a module's own layer. o = { name, level: 0 (areas, under the alerts) | 1 (marks, over them), order, draw(ctx, api) }; api: toScreen(lat, lon),
     *  toLatLon(x, y), view [w, s, e, n], z, w, h, dpr, dark, mpp(lat) metres per CSS px, drawGrid(g, alpha) (a picture on a lat / lon grid) */
    addOverlay(o) { const i = overlays.findIndex((x) => x.name === o.name); if (i >= 0) overlays.splice(i, 1); overlays.push(o); overlays.sort((a, b) => (a.order || 0) - (b.order || 0)); draw(); },
    removeOverlay(name) { const i = overlays.findIndex((x) => x.name === name); if (i >= 0) { overlays.splice(i, 1); draw(); } },
    /** Wallowa Weather: swap the basemap stack (the old tiles stay cached under their own ids) */
    setSources(list) { SRC = list && list.length ? list : SRC; draw(); },
    /** the sources drawn at the current view (for the credits line) */
    visibleSources() { return SRC.filter((s0) => !(s0.minZoom != null && st.z < s0.minZoom)).filter((s0) => { if (!s0.bounds) return true; const v = view(); return !(v[1] > s0.bounds[2] || v[3] < s0.bounds[0] || v[0] > s0.bounds[3] || v[2] < s0.bounds[1]); }); },
    get(k) { return L[k]; },
    /** v018: the places named on the map now ({ name (clean), st, lat, lon, pop, src }), most important first: who gets a pill */
    labels() { return labels.map((l) => l.e); },
    destroy() { gone = true; if (raf) cancelAnimationFrame(raf); if (ro) ro.disconnect(); for (const t of tiles.values()) if (t.img && t.img.close) t.img.close(); tiles.clear(); if (hatchBuf) { hatchBuf.width = hatchBuf.height = 0; hatchBuf = null; }
      anims.clear(); FIELDS.clear(); if (cache) freeCaches(); if (R) { R.destroy(); R = null; } },
  };
}

const newCanvas = (w, h) => (typeof document !== 'undefined' ? Object.assign(document.createElement('canvas'), { width: w, height: h }) : new OffscreenCanvas(w, h));
/** the low-radar-quality hatching (v011): thin diagonal lines (bottom left to top right) HATCH.gap CSS px apart, HATCH.width wide, in
 *  the ink of the old hatching. One tile of the repeating pattern at a device-pixel ratio: a whole number of device px on a side, so
 *  the lines meet across tiles; each line is drawn with its neighbours' ends so nothing is cut at the tile's edge. */
export const HATCH = { gap: 6, width: 1.3 };
const hatchInk = (dk) => (dk ? 'rgba(255,255,255,0.6)' : 'rgba(32,32,40,0.6)');
function hatchTile(dpr, dk) {
  const T = Math.max(4, Math.round(HATCH.gap * Math.SQRT2 * dpr)), c = newCanvas(T, T), g = c.getContext('2d');
  g.strokeStyle = hatchInk(dk); g.lineWidth = HATCH.width * dpr; g.lineCap = 'square';
  g.beginPath(); for (const k of [-T, 0, T]) { g.moveTo(k - T, T + T); g.lineTo(k + T + T, -T); }   // x + y = T + k, past the tile's corners
  g.stroke(); return c;
}
/** the top bar's key for the hatching: the same lines as on the map over a light see-through fill, on `cv` sized 18 x 10 CSS px */
export function paintHatchSwatch(cv, dk) {
  const dpr = Math.min(2, globalThis.devicePixelRatio || 1), W = Math.round(18 * dpr), H = Math.round(10 * dpr);
  cv.width = W; cv.height = H; if (cv.style) { cv.style.width = '18px'; cv.style.height = '10px'; }
  const g = cv.getContext('2d'); g.clearRect(0, 0, W, H);
  g.fillStyle = dk ? 'rgba(255,255,255,0.1)' : 'rgba(32,32,40,0.08)'; g.fillRect(0, 0, W, H);
  g.fillStyle = g.createPattern(hatchTile(dpr, dk), 'repeat'); g.fillRect(0, 0, W, H);
  return cv;
}

/** codes (one byte a pixel) -> a canvas through a 256-colour table (reuses `into`). v018: the canvas remembers its codes and table, so a
 *  grid { canvas } made here is drawn smooth on the GPU like a grid of codes */
const TAG = new WeakMap();
export function paint(codes, w, h, lut, into = null) {
  const c = into && into.width === w && into.height === h ? into : Object.assign(document.createElement('canvas'), { width: w, height: h });
  const g = c.getContext('2d'), im = g.createImageData(w, h), d = new Uint32Array(im.data.buffer), L32 = new Uint32Array(lut.buffer);
  for (let i = 0; i < codes.length; i++) d[i] = L32[codes[i]];
  g.putImageData(im, 0, 0); TAG.set(c, { codes, lut }); return c;
}
