// nowcast/clouds.js - the satellite layer: NOAA GOES-East / GOES-West imagery through NASA GIBS (US government, public domain; tiles
// answer with Access-Control-Allow-Origin: *), in two modes (v018):
//   'overlay' - the Clouds over the map (v011, unchanged in look): GeoColor (true colour) by day or band 13, the "clean infrared", by
//               night, turned into plain white clouds - brighter / colder = more solid, never in the rain's colours - and see-through,
//               never more than CLOUD_CAP, so the map under them (satellite, public land, county lines) shows even under an overcast.
//   'full'    - the Satellite live map: the imagery itself. GeoColor by day; by night band 13 drawn as a satellite picture with our own
//               curve (satimg.js IR_CURVE: a dark ground, greys lighter as cloud tops get colder, pale tints on the coldest storm tops);
//               the two blended pixel by pixel across the terminator by the sun's height at each pixel, never a hard switch.
// Both: GOES-West over the West, GOES-East over the rest, blended across the seam near 105 W where both have data; each radar frame gets
// the newest image at or before its time (GIBS's own time list, so its gaps are respected; images are every 10 minutes and reach GIBS
// 25 minutes to 2 hours late); the GIBS level that fits the view and the screen's pixels, stretched smoothly past the picture's most
// detailed level; the visible tiles put together into one picture and drawn at once (no tile seams); a new frame fades in over the last,
// which stays until the new one is in (no blank tiles while the loop plays); the next frame's tiles fetched ahead while the loop plays;
// a failed tile tried again after 20 s, 3 tries a round, a new round after 5 minutes; one level less and nothing fetched ahead on the
// data saver / cellular.
// One picture = one time (v018 fix, seen live Nov-09-2026): GIBS lists times it has not published every tile of (a 404 for the rest,
// filled in over minutes), and its lists have gaps. A view is drawn from ONE image time: the newest at or before the frame that has all
// of the view's tiles - a tile GIBS does not have is asked for at the time before it in GIBS's own list (2 back at most, never a gap),
// the time it was missing from is tried again on the retries above - and the picture on screen stays until the next one is whole, then
// all of it fades at once. The screen says the time drawn ("clouds 9:50 PM": shown(), onShown); no signal is not "missing".
import { connectionOf } from './cadence.js';
import { TILE, MAX_LEVEL, FADE_MS, DAY, levelFor, tilesFor, snap, parseDomains, pickTime, timeBefore, solarAt, elevationAt, dayWeight, dayGrid,
  eastColumns, tileNeeds, satsFor, composeTile, upsample, irTable, irTemps, irNightT, validOf } from './satimg.js';

const GIBS = 'https://gibs.earthdata.nasa.gov/';
const COLORMAP = GIBS + 'colormaps/v1.3/Clean_Longwave_Infrared_Window_Band.xml';
export const SATS = {
  west: { name: 'GOES-West', ir: 'GOES-West_ABI_Band13_Clean_Infrared', geo: 'GOES-West_ABI_GeoColor' },
  east: { name: 'GOES-East', ir: 'GOES-East_ABI_Band13_Clean_Infrared', geo: 'GOES-East_ABI_GeoColor' },
};
const LAYERS = [SATS.west.geo, SATS.west.ir, SATS.east.geo, SATS.east.ir];
const KIND = { [SATS.west.geo]: 'geo', [SATS.east.geo]: 'geo', [SATS.west.ir]: 'ir', [SATS.east.ir]: 'ir' };
export const CLOUD_CREDIT = 'Clouds: NOAA GOES via NASA GIBS';
export const SAT_CREDIT = 'Satellite: NOAA GOES via NASA GIBS';   // v018: the full Satellite map's line
/** what the layer keeps (v018): finished tile pictures (256 x 256, about 256 KB each in memory), downloaded tiles (PNG, 30-150 KB) */
export const LIMITS = { comps: 96, blobs: 240, blobBytes: 24e6 };
const TIMES_TTL = 5 * 60e3, NET_MAX = 6;
/** a picture goes back at most to the 2nd image before its own in GIBS's list: the 3 images a missing tile was asked at before v018's fix */
const STEPS = 3;
/** the satellite that sees a longitude best (GOES-West over the West, GOES-East over the rest of the lower 48) */
export const satFor = (lon) => (lon < -105 ? 'west' : 'east');
/** the sun's height over the horizon in degrees (a short form of NOAA's solar position formulas; a degree or so is enough here) */
export function sunElevation(lat, lon, t) {
  const d = new Date(t), D2R = Math.PI / 180;
  const day = (Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - Date.UTC(d.getUTCFullYear(), 0, 0)) / 864e5;
  const hr = d.getUTCHours() + d.getUTCMinutes() / 60, g = (2 * Math.PI / 365) * (day - 1 + (hr - 12) / 24);
  const decl = 0.006918 - 0.399912 * Math.cos(g) + 0.070257 * Math.sin(g) - 0.006758 * Math.cos(2 * g) + 0.000907 * Math.sin(2 * g) - 0.002697 * Math.cos(3 * g) + 0.00148 * Math.sin(3 * g);
  const eqt = 229.18 * (0.000075 + 0.001868 * Math.cos(g) - 0.032077 * Math.sin(g) - 0.014615 * Math.cos(2 * g) - 0.040849 * Math.sin(2 * g));
  const ha = ((hr * 60 + eqt + 4 * lon) / 4 - 180) * D2R;
  const cz = Math.sin(lat * D2R) * Math.sin(decl) + Math.cos(lat * D2R) * Math.cos(decl) * Math.cos(ha);
  return 90 - Math.acos(Math.max(-1, Math.min(1, cz))) / D2R;
}
/** NASA's colour table (XML) -> Map(0xRRGGBB -> degrees C at the bin's middle) */
export function parseColormap(xml) {
  const m = new Map(), re = /<ColorMapEntry rgb="(\d+),(\d+),(\d+)"[^>]*?value="\(([-+\d.INF]+),([-+\d.INF]+)\]"/g; let x;
  while ((x = re.exec(String(xml || '')))) {
    const lo = parseFloat(x[4]), hi = parseFloat(x[5]), v = Number.isFinite(lo) && Number.isFinite(hi) ? (lo + hi) / 2 : Number.isFinite(lo) ? lo : hi;
    m.set((+x[1] << 16) | (+x[2] << 8) | +x[3], v);
  }
  return m;
}
/** the most a cloud covers the map (v011, tuned by eye on GOES-West GeoColor over Wallowa County, overcast Nov-08-2026 20:00 UTC):
 *  a sky solid from edge to edge still lets the ground, the public land and the county lines through */
export const CLOUD_CAP = 0.58;
/** cloud-top temperature (C) -> white cloud's opacity 0..1: nothing down to -5 C (the ground and the lowest clouds look alike in
 *  infrared), then smoothly more solid the colder (higher) the top, 0.88 from -55 C (drawn at CLOUD_CAP / 0.88: CLOUD_CAP at most) */
export const cloudAlpha = (c) => (!(c < -5) ? 0 : Math.min(0.88, 0.88 * (-5 - c) / 50));
/** GeoColor (true colour) pixels -> white clouds, in place (RGBA bytes). How cloudy a pixel looks: its brightness less half its colour
 *  (clouds are bright and grey; fields, forest, rock and water are darker or coloured), 0 up to GEO_LO, smoothly 1 from GEO_HI; that is
 *  its opacity (drawn at CLOUD_CAP, so CLOUD_CAP at most) and it keeps a little of its own shade (white to light grey, as in infrared).
 *  Snow looks like cloud here too, as it does in the picture itself. */
export const GEO_LO = 135, GEO_HI = 225;
export function geoToClouds(d, lo = GEO_LO, hi = GEO_HI) {
  for (let i = 0; i < d.length; i += 4) {
    if (!d[i + 3]) continue;
    const r = d[i], g = d[i + 1], b = d[i + 2], mx = Math.max(r, g, b), mn = Math.min(r, g, b);
    const u = Math.max(0, Math.min(1, (0.2126 * r + 0.7152 * g + 0.0722 * b - 0.5 * (mx - mn) - lo) / (hi - lo))), a = u * u * (3 - 2 * u);
    const w = 225 + Math.round(30 * a);   // thin = a touch grey, thick = white
    d[i] = w; d[i + 1] = w; d[i + 2] = Math.min(255, w + 4); d[i + 3] = Math.round(a * d[i + 3]);
  }
  return d;
}
/** temperatures (C, NaN = no data; satimg.js irTemps reads them from a band-13 tile) -> white clouds, in place: the v011 infrared clouds
 *  (cloudAlpha; a touch grey where thin) */
export function irToCloudsT(d, T) {
  for (let i = 0, o = 0; i < T.length; i++, o += 4) {
    const t = T[i], a = t === t ? cloudAlpha(t) : 0, w = 235 + Math.round(20 * Math.min(1, a / 0.6));
    d[o] = w; d[o + 1] = w; d[o + 2] = Math.min(255, w + 4); d[o + 3] = Math.round(a * 255);
  }
  return d;
}
/** the colour table's temperature for any colour: an exact entry, else the nearest entry (the tiles are resampled, so their colours
 *  fall between the table's: about two thirds of a tile's pixels); a colour far from every entry (> 40 in RGB) is not a temperature */
export function temperatureOf(cm, rgb, cache) {
  const c = cache.get(rgb); if (c !== undefined) return c;
  let t = cm.get(rgb);
  if (t === undefined) {
    const r = rgb >> 16, g = (rgb >> 8) & 255, b = rgb & 255; let best = 1e9;
    for (const [k, v] of cm) { const d = (r - (k >> 16)) ** 2 + (g - ((k >> 8) & 255)) ** 2 + (b - (k & 255)) ** 2; if (d < best) { best = d; t = v; } }
    if (best > 1600) t = null;
  }
  cache.set(rgb, t); return t;
}

const isoOf = (t) => new Date(t).toISOString().replace('.000Z', 'Z');
const tileUrl = (layer, t, L, x, y) => `${GIBS}wmts/epsg3857/best/${layer}/default/${isoOf(t)}/GoogleMapsCompatible_Level${MAX_LEVEL[KIND[layer]]}/${L}/${y}/${x}.png`;
/** Data Saver on, or a network the browser says is not Wi-Fi / Ethernet (Android Chrome tells; iPhone Safari cannot: full detail there) */
const onSaver = () => { const c = connectionOf(); return c.saveData || (c.known && c.type !== 'wifi' && c.type !== 'ethernet'); };
const onReduced = () => { try { return matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (e) { return false; } };
const clockOf = (t) => { try { return new Date(t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }); } catch (e) { return new Date(t).toISOString().slice(11, 16); } };
/** the satellite's words in the time bar (v018 fix): the picture on screen (shown()) - "clouds 9:50 PM", "(infrared)" by night - or
 *  "clouds loading" while there is none, never a time that is not drawn */
export const shownWords = (sh, clock = clockOf) => (sh ? `clouds ${clock(sh.t)}${sh.kind === 'ir' ? ' (infrared)' : ''}` : 'clouds loading');
/** the browser's pictures: decode a PNG to pixels, pixels or a PNG to something drawImage takes, a canvas, let one go */
function browserRaster() {
  const canvas = (w, h) => (typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(w, h) : Object.assign(document.createElement('canvas'), { width: w, height: h }));
  let scratch = null;   // builds run one at a time (createClouds' build queue), so one canvas reads them all
  return {
    async decode(blob) {
      const bmp = await createImageBitmap(blob), w = bmp.width, h = bmp.height;
      if (!scratch || scratch.width !== w || scratch.height !== h) scratch = canvas(w, h);
      const g = scratch.getContext('2d', { willReadFrequently: true });
      g.clearRect(0, 0, w, h); g.drawImage(bmp, 0, 0); if (bmp.close) bmp.close();
      return { w, h, data: g.getImageData(0, 0, w, h).data };
    },
    async fromPixels(px) { const c = canvas(px.w, px.h); c.getContext('2d').putImageData(new ImageData(px.data, px.w, px.h), 0, 0); return createImageBitmap(c); },
    fromBlob: (blob) => createImageBitmap(blob),
    canvas,
    release(img) { if (img && img.close) img.close(); },
  };
}

/** the layer. o: { fetchFn, onTile (something new to draw: the map redraws), onShown (v018 fix: the picture on screen changed time:
 *  the time bar says shown()), raster (tests), saver () -> bool, reduced () -> bool, now (ms, for retries and fades), wallNow (ms, for
 *  GIBS's time list), clock (t -> "9:50 PM") } */
export function createClouds({ fetchFn = (...a) => fetch(...a), onTile = () => {}, onShown = () => {}, raster = null, saver = onSaver,
  reduced = onReduced, now = () => performance.now(), wallNow = () => Date.now(), clock = clockOf } = {}) {
  const R = raster || browserRaster();
  let mode = 'overlay', cmap = null, cmapP = null, tab = null;
  const irTab = () => tab || (tab = irTable(cmap || new Map()));   // the colour table, ready to read tiles back
  const times = new Map();   // layer -> { list (ms, ascending), newest, at (wall ms), p (a fetch in flight) }
  const src = new Map();     // a downloaded tile: key -> { key, part, st: new | queued | loading | ok | failed, blob, bytes, tries, failedAt, at, gen, busy, waiters,
                             //   miss (failed: GIBS has no such tile), depth, prio }
  const comps = new Map();   // a finished tile picture: key -> { key, plan, st: wait | queued | building | ok | failed, img, at, built, recs, miss, depth }
  const slots = new Map();   // on screen: 'L/x/y' -> { img, key, from, start } (the picture shown, the one it fades from, since when)
  const needs = new Map();   // tileNeeds, kept: 'L/x/y/tSun' -> { day, night }
  const stats = { tiles: 0, bytes: 0 };
  const qNet = { hi: [], lo: [] }, qBuild = { hi: [], lo: [] };
  let netBusy = 0, building = false, blobBytes = 0, lastDraw = -1e15, mos = null, frameList = null, lastAt = null, playing = false, step = 0;
  let on = null, lastPic = null;   // v018 fix: the picture on screen (one image time; slots hold its tiles; null: none), the one last drawn
  const yes = (f) => { try { return !!f(); } catch (e) { return false; } };
  const srcKey = (layer, t, Ls, sx, sy) => `${layer}|${t}|${Ls}|${sx}|${sy}`;

  const colormap = () => cmapP || (cmapP = fetchFn(COLORMAP).then((r) => r.text()).then((t) => { cmap = parseColormap(t); tab = null; return cmap; }, (e) => { cmapP = null; throw e; }));
  /** a layer's image times: GIBS DescribeDomains (a few hundred bytes) for the last 12 hours, kept 5 minutes; if it says nothing, the old
   *  way: a 'default' tile answers with its time in Layer-Time-Actual */
  function timesOf(layer) {
    let rec = times.get(layer);
    if (rec && (rec.p || wallNow() - rec.at < TIMES_TTL)) return rec.p || Promise.resolve(rec);
    if (!rec) { rec = { list: [], newest: null, at: 0, p: null }; times.set(layer, rec); }
    const w = wallNow(), m = (t) => isoOf(Math.floor(t / 60e3) * 60e3), L = MAX_LEVEL[KIND[layer]];
    const it = rec;
    it.p = fetchFn(`${GIBS}wmts/epsg3857/best/1.0.0/${layer}/default/GoogleMapsCompatible_Level${L}/all/${m(w - 12 * 3600e3)}--${m(w + 3600e3)}.xml`)
      .then((r) => (r && r.ok && r.text ? r.text() : ''), () => '')
      .then(async (xml) => {
        const list = parseDomains(xml); let newest = list.length ? list[list.length - 1] : null;
        if (newest == null) {
          const r = await fetchFn(`${GIBS}wmts/epsg3857/best/${layer}/default/default/GoogleMapsCompatible_Level${L}/0/0/0.png`);
          const h = r.headers && r.headers.get('layer-time-actual'); try { await r.arrayBuffer(); } catch (e) { /* */ }
          const t = h ? Date.parse(h) : NaN; if (!Number.isFinite(t)) throw new Error('no time for ' + layer);
          newest = t;
        }
        it.list = list; it.newest = newest; it.at = wallNow(); it.p = null; return it;
      })
      .catch((e) => { it.p = null; it.at = wallNow() - TIMES_TTL + 60e3; throw e; });   // again in a minute; the old list stays
    return it.p;
  }
  function freshen() { for (const l of LAYERS) { const r = times.get(l); if (r && !r.p && wallNow() - r.at >= TIMES_TTL) timesOf(l).catch(() => {}); } }

  // ------------------------------------------------------------------------------------------------ one frame's picture
  /** the picture for a frame at t; base (v018 fix): the frame's own picture, when this is the same place at an earlier image time t
   *  (its look - mode, and in 'overlay' GeoColor or infrared - stays the frame's) */
  function picture(t, lat, lon, base = null) {
    const md = base ? base.mode : mode, sat = SATS[satFor(lon)], other = sat === SATS.west ? SATS.east : SATS.west, T = {};
    for (const l of LAYERS) { const r = times.get(l); T[l] = r ? pickTime(t, r.list, r.newest) : null; }
    let kind, cap = 1, maxZ, shown, sol = null, tSun = null, hasGeo = false, hasIr = false;
    if (md === 'overlay') {   // v011's choice: GeoColor if it is day at the place and the picture is not over an hour old, else infrared
      const lg = times.get(sat.geo), day = sunElevation(lat, lon, t) > 8;
      kind = base ? base.kind : day && lg && lg.newest != null && lg.newest >= t - 60 * 60e3 && T[sat.geo] != null ? 'geo' : 'ir';
      if (T[sat[kind]] == null || (kind === 'ir' && !cmap)) return null;
      shown = T[sat[kind]]; cap = kind === 'geo' ? CLOUD_CAP : CLOUD_CAP / 0.88; maxZ = MAX_LEVEL[kind];
    } else {
      hasGeo = T[sat.geo] != null || T[other.geo] != null; hasIr = !!cmap && (T[sat.ir] != null || T[other.ir] != null);
      if (!hasGeo && !hasIr) return null;
      const tg = T[sat.geo] ?? T[other.geo], ti = T[sat.ir] ?? T[other.ir];
      tSun = tg != null ? tg : ti; sol = solarAt(tSun);
      const w = dayWeight(elevationAt(sol, lat, lon));
      kind = hasGeo && (w >= 0.5 || !hasIr) ? 'geo' : 'ir'; shown = kind === 'geo' ? tg : ti;
      maxZ = hasGeo && (w > 0 || !hasIr) ? MAX_LEVEL.geo : MAX_LEVEL.ir;
    }
    const pic = { mode: md, kind, sat: sat.name, t: shown, frame: base ? base.frame : t, lat, lon, times: T, cap, alpha: 1, maxZ, sol, tSun,
      hasGeo, hasIr, label: shownWords({ t: shown, kind }, clock), vars: null,
      /** the old map.js path: one tile's picture (cap already in it, so alpha is 1), null while it loads; v018 fix: of one image time */
      get(z, x, y) {
        const w = choose(pic, z, [[x, y]], 'hi'), p = w.ready && plan(w.ready, z, x, y), c = p && comps.get(p.key);
        return c && c.st === 'ok' ? c.img : null;
      },
      /** v018: the map hands over its 2D context and its overlay api (z, dpr, w, h, view or bounds()) */
      draw(ctx, api) { drawPic(pic, ctx, api); } };
    return pic;
  }
  /** v018 fix: a frame's pictures, newest first - [0] its own, then the same place at each earlier time in GIBS's lists of the images it
   *  draws (so a gap is never asked for; with no list known, 10-minute steps) -> picture i, or null past the last */
  function variantOf(pic, i) {
    if (!i) return pic;
    let V = pic.vars;
    if (!V) {   // the earlier times of every image it draws: a time that changes nothing in a view is passed over there (choose)
      const N = 18;   // 3 hours of 10-minute images: plenty for STEPS different pictures
      const ls = pic.mode === 'overlay' ? [SATS.west[pic.kind], SATS.east[pic.kind]] : LAYERS, has = ls.filter((l) => pic.times[l] != null);
      const top = Math.max(...has.map((l) => pic.times[l])), ts = new Set();
      for (const l of has) {
        const r = times.get(l), list = r && r.list.length ? r.list : null;
        for (let t = pic.times[l], k = 0; t != null && k < N; t = timeBefore(t, list), k++) if (t < top) ts.add(t);
      }
      V = pic.vars = { list: [pic], at: [...ts].sort((a, b) => b - a).slice(0, N), next: 0 };
    }
    while (V.list.length <= i && V.next < V.at.length) { const v = picture(V.at[V.next++], pic.lat, pic.lon, pic); if (v) V.list.push(v); }
    return V.list[i] || null;
  }
  /** v018 fix: one picture = one time. Of a frame's pictures (variantOf), newest first, the first that has none of these tiles missing (a
   *  time GIBS lists but has not published all of is passed over - tried again on the retries - and so is one whose tiles are the same as
   *  the picture before it); at most STEPS tried. -> { want: that picture (null: none), ready: it once all its tiles are made } */
  function choose(pic, L, xy, prio) {
    let last = null;
    const missing = (part) => { const r = src.get(part.key); return !!r && r.st === 'failed' && r.miss; };
    for (let i = 0, tried = 0; tried < STEPS; i++) {
      const v = variantOf(pic, i); if (!v) break;
      const ps = xy.map(([x, y]) => plan(v, L, x, y));
      if (last && ps.every((p, k) => (p ? p.key : '') === (last[k] ? last[k].key : ''))) continue;
      last = ps;
      // known to miss a tile here: only the downloads it has are kept (and tried again on the retries) - none started, no pictures made
      if (ps.some((p) => p && p.parts.some(missing))) {
        for (const p of ps) if (p) for (const part of p.parts) if (src.has(part.key)) source(part, prio, null, tried);
        tried++; continue;
      }
      let miss = false, wait = false;
      for (const p of ps) {
        const c = p && compOf(p, prio, tried); if (!c || c.st === 'ok') continue;
        if (c.st === 'failed' && c.miss) miss = true; else wait = true;
      }
      tried++;
      if (!miss) return { want: v, ready: wait ? null : v };
    }
    return { want: null, ready: null };
  }
  /** a tile's plan: which downloads it needs and how they go together, under a key that names exactly that */
  function plan(pic, L, x, y) {
    const n = 2 ** L; if (y < 0 || y >= n || x < 0 || x >= n) return null;
    const parts = [], s = satsFor(L, x);
    const add = (role, kind, sk, conv) => {
      const layer = SATS[sk][kind], t = pic.times[layer]; if (t == null) return;
      const Ls = Math.min(L, MAX_LEVEL[kind]), f = 2 ** (L - Ls), sx = Math.floor(x / f), sy = Math.floor(y / f);
      parts.push({ role: role + (sk === 'west' ? 'W' : 'E'), layer, kind, t, Ls, sx, sy, f, qx: x - sx * f, qy: y - sy * f, conv, key: srcKey(layer, t, Ls, sx, sy) });
    };
    const both = (role, kind, conv) => {
      const k0 = parts.length;
      for (const sk of ['west', 'east']) if (s[sk]) add(role, kind, sk, conv);
      if (parts.length === k0) for (const sk of ['west', 'east']) if (!s[sk]) add(role, kind, sk, conv);   // its satellite has no image: the other one
    };
    let dayW = false;
    if (pic.mode === 'overlay') both('d', pic.kind, pic.kind === 'geo' ? 'geo-clouds' : 'ir-clouds');
    else {
      const nk = `${L}/${x}/${y}/${pic.tSun}`; let need = needs.get(nk);
      if (!need) { if (needs.size > 4000) needs.clear(); need = tileNeeds(pic.sol, L, x, y); needs.set(nk, need); }
      let useD = need.day && pic.hasGeo, useN = need.night && pic.hasIr;
      if (!useD && !useN) { useD = pic.hasGeo; useN = !useD; }
      if (useD) both('d', 'geo', 'geo');
      if (useN) both('n', 'ir', 'ir-night');
      dayW = useD && useN;
    }
    if (!parts.length) return null;
    return { key: [pic.mode, L, x, y, ...parts.map((p) => `${p.role}:${p.key}`), dayW ? pic.tSun : '', pic.cap].join('~'), L, x, y, parts, dayW, cap: pic.cap,
      sol: pic.sol, fast: parts.length === 1 && parts[0].conv === 'geo' && parts[0].f === 1 };
  }

  // ------------------------------------------------------------------------------------------------ downloads
  /** depth (v018 fix): how many images before its picture's own this one is (a missing tile goes back at most to STEPS - 1) */
  function source(part, prio, waiter, depth = 0) {
    let r = src.get(part.key);
    if (!r) {
      r = { key: part.key, part, st: 'new', miss: false, blob: null, bytes: 0, tries: 0, failedAt: 0, at: now(), gen: 0, busy: 0, waiters: new Set(), depth, prio };
      src.set(part.key, r);
    }
    r.at = now(); if (waiter) r.waiters.add(waiter); if (depth < r.depth) r.depth = depth; if (prio === 'hi') r.prio = 'hi';
    if (r.st === 'failed' && r.tries >= 3 && now() - r.failedAt >= 5 * 60e3) r.tries = 0;   // v018 review: 3 tries a round; a new round after 5 min (a dead spot passed)
    if (r.st === 'new' || (r.st === 'failed' && r.tries < 3 && now() - r.failedAt >= 20e3)) { r.tries++; r.st = 'queued'; net(() => load(r), prio); }
    return r;
  }
  function net(fn, prio) { qNet[prio === 'lo' ? 'lo' : 'hi'].push(fn); pump(); }
  function pump() {
    while (netBusy < NET_MAX && (qNet.hi.length || qNet.lo.length)) {
      const fn = qNet.hi.length ? qNet.hi.shift() : qNet.lo.shift(); netBusy++;
      Promise.resolve().then(fn).catch(() => {}).then(() => { netBusy--; pump(); });
    }
  }
  /** one tile: exactly the image asked for (v018 fix: never another time's in its place - that was the square seams). GIBS answering
   *  it has no such tile (a 404: a time it lists but has not published all of) -> missing: the same tile at the time before it in GIBS's
   *  list is asked for at once (at most STEPS - 1 back; the old 10 / 20 minutes asked for gaps), and the map draws again (its picture
   *  goes back to a time it has whole). No answer (no signal) or a server error is not missing: the retries only */
  async function load(r) {
    r.st = 'loading'; const p = r.part; let res = null;
    try {
      res = await fetchFn(tileUrl(p.layer, p.t, p.Ls, p.sx, p.sy));
      if (!res || !res.ok) throw new Error('no tile');
      const blob = await res.blob();
      stats.tiles++; stats.bytes += blob.size || 0;
      r.blob = blob; r.bytes = blob.size || 0; r.st = 'ok'; r.miss = false; r.gen++; blobBytes += r.bytes;
    } catch (e) { r.st = 'failed'; r.failedAt = now(); r.miss = !!res && !res.ok && !(res.status >= 500); }
    if (src.get(r.key) === r) trimBlobs();
    const w = [...r.waiters]; r.waiters.clear(); let told = 0;
    for (const k of w) { const c = comps.get(k); if (c && (c.st === 'wait' || c.st === 'failed')) { check(c); told++; } }
    if (r.miss) {
      const t = r.depth < STEPS - 1 ? before(p.layer, p.t) : null;
      if (t != null) source({ ...p, t, key: srcKey(p.layer, t, p.Ls, p.sx, p.sy) }, r.prio, null, r.depth + 1);
    }
    if (r.miss || !told) onTile();   // no picture waited for it: the map draws again (back to a time it has whole, or on to one now whole)
  }
  /** the image before t in the layer's list (satimg.js timeBefore) */
  const before = (layer, t) => { const rec = times.get(layer); return timeBefore(t, rec && rec.list.length ? rec.list : null); };
  /** a download that would not make a picture (a broken PNG): tried again on the retries, it is not "missing" */
  const failSrc = (r) => { if (r.st === 'ok') { blobBytes -= r.bytes; r.blob = null; } r.st = 'failed'; r.miss = false; r.failedAt = now(); };
  function trimBlobs() {
    if (src.size <= LIMITS.blobs && blobBytes <= LIMITS.blobBytes) return;
    const old = [...src.values()].filter((r) => !r.busy && (r.st === 'ok' || r.st === 'failed')).sort((a, b) => (a.st === b.st ? a.at - b.at : a.st === 'ok' ? -1 : 1));
    for (const r of old) {
      if (src.size <= LIMITS.blobs * 0.9 && blobBytes <= LIMITS.blobBytes * 0.9) break;
      src.delete(r.key); if (r.st === 'ok') blobBytes -= r.bytes; r.blob = null;
    }
  }

  // ------------------------------------------------------------------------------------------------ tile pictures
  /** a tile's picture for a plan (made when its downloads are in); depth: see source() */
  function compOf(p, prio, depth = 0) {
    let c = comps.get(p.key);
    if (!c) { c = { key: p.key, plan: p, st: 'wait', miss: false, img: null, at: now(), built: '', recs: null, prio, depth }; comps.set(p.key, c); trimComps(); }
    c.at = now(); if (prio === 'hi') c.prio = 'hi'; if (depth < c.depth) c.depth = depth;
    if (c.st === 'wait' || c.st === 'failed') check(c);
    return c;
  }
  /** a picture's downloads: any missing asked for (a failed one again after 20 s); all in: make it. v018 fix: only from ALL of them - one
   *  that failed fails the picture (missing: GIBS has no such tile at that time), never a square of another look or of nothing */
  function check(c) {
    const recs = c.plan.parts.map((part) => source(part, c.prio, c.key, c.depth));
    if (recs.some((r) => r.st !== 'ok' && r.st !== 'failed')) { c.st = 'wait'; return; }
    const bad = recs.filter((r) => r.st === 'failed');
    if (bad.length) { c.st = 'failed'; c.miss = bad.some((r) => r.miss); return; }
    const sig = recs.map((r) => r.gen).join(',');
    if (c.st === 'failed' && sig === c.built) return;   // these very downloads already failed to make a picture
    c.st = 'queued'; c.built = sig; c.recs = recs; c.miss = false; for (const r of recs) r.busy++;
    qBuild[c.prio === 'lo' ? 'lo' : 'hi'].push(c); if (!building) builds();
  }
  /** one picture at a time, the frame on screen first, a breath between (the phone's main thread stays smooth) */
  async function builds() {
    building = true;
    while (qBuild.hi.length || qBuild.lo.length) {
      const c = qBuild.hi.length ? qBuild.hi.shift() : qBuild.lo.shift();
      if (c.st !== 'queued') continue;
      c.st = 'building';
      // a picture that cannot be made from good downloads cannot be had at this time (missing); a broken download is tried again
      try { await build(c); } catch (e) { c.st = 'failed'; c.miss = (c.recs || []).every((r) => r.st === 'ok'); }
      for (const r of c.recs || []) r.busy = Math.max(0, r.busy - 1);
      if (comps.get(c.key) !== c && c.img) { R.release(c.img); c.img = null; }   // let go while it was being made
      await new Promise((r) => setTimeout(r, 0));
    }
    building = false;
  }
  async function build(c) {
    const p = c.plan; let img;
    if (p.fast) {   // GeoColor alone, at its own level: the PNG as it is
      const r = c.recs[0];
      try { img = await R.fromBlob(r.blob); } catch (e) { failSrc(r); throw e; }
    } else {
      const lay = {};
      for (let i = 0; i < p.parts.length; i++) {   // v018 fix: every part, or no picture (never one with a part left out)
        const part = p.parts[i], r = c.recs[i]; if (r.st !== 'ok' || !r.blob) throw new Error('a download is gone');
        let px; try { px = await R.decode(r.blob); } catch (e) { failSrc(r); throw e; }
        if (!px || !px.data || px.data.length !== TILE * TILE * 4) { failSrc(r); throw new Error('not a tile'); }
        const d = px.data, valid = part.conv === 'geo-clouds' || part.conv === 'ir-clouds' ? validOf(d) : null;
        if (part.conv === 'geo-clouds') geoToClouds(d);
        else if (part.conv === 'ir-clouds') irToCloudsT(d, irTemps(d, irTab()));
        else if (part.conv === 'ir-night') irNightT(d, irTemps(d, irTab()));
        lay[part.role] = part.f > 1 ? upsample({ data: d, valid }, part.f, part.qx, part.qy) : { data: d, valid };
      }
      if (!Object.keys(lay).length) throw new Error('nothing to draw');
      const out = new Uint8ClampedArray(TILE * TILE * 4);
      composeTile({ out, day: [lay.dW || null, lay.dE || null], night: [lay.nW || null, lay.nE || null], dayW: p.dayW ? dayGrid(p.sol, p.L, p.x, p.y) : null, east: eastColumns(p.L, p.x), cap: p.cap });
      img = await R.fromPixels({ w: TILE, h: TILE, data: out });
    }
    c.img = img; c.st = 'ok'; onTile();
  }
  function trimComps() {
    if (comps.size <= LIMITS.comps) return;
    const shown = new Set(); for (const s of slots.values()) { if (s.img) shown.add(s.img); if (s.from) shown.add(s.from); }
    const old = [...comps.values()].filter((c) => c.st !== 'queued' && c.st !== 'building' && !(c.img && shown.has(c.img))).sort((a, b) => a.at - b.at);
    for (const c of old) { if (comps.size <= LIMITS.comps - 12) break; comps.delete(c.key); if (c.img) { R.release(c.img); c.img = null; } }
  }

  // ------------------------------------------------------------------------------------------------ drawing
  /** the most detailed level worth asking for in this view: GeoColor's 7 where any of it is lit, else band 13's 6 */
  function topLevel(pic, v) {
    if (pic.mode === 'overlay') return MAX_LEVEL[pic.kind];
    if (!pic.hasGeo) return MAX_LEVEL.ir;
    if (!pic.hasIr) return MAX_LEVEL.geo;
    for (let j = 0; j <= 2; j++) for (let i = 0; i <= 2; i++) if (elevationAt(pic.sol, v[1] + (v[3] - v[1]) * j / 2, v[0] + (v[2] - v[0]) * i / 2) > DAY[0] - 1) return MAX_LEVEL.geo;
    return MAX_LEVEL.ir;
  }
  /** a tile not in yet: a coarser picture of the one on screen stretched (zooming in), else the finer ones shrunk (zooming out) */
  function standIn(g, pic, L, x, y, px, py) {
    for (let dz = 1; dz <= 3 && L - dz >= 0; dz++) {
      const f = 2 ** dz, P = plan(pic, L - dz, x >> dz, y >> dz), c = P && comps.get(P.key);
      if (c && c.st === 'ok' && c.img) { g.drawImage(c.img, (x - (x >> dz) * f) * TILE / f, (y - (y >> dz) * f) * TILE / f, TILE / f, TILE / f, px, py, TILE, TILE); return true; }
    }
    let got = false; const h = TILE / 2;
    for (let q = 0; q < 4; q++) {
      const P = plan(pic, L + 1, 2 * x + (q & 1), 2 * y + (q >> 1)), c = P && comps.get(P.key);
      if (c && c.st === 'ok' && c.img) { g.drawImage(c.img, 0, 0, TILE, TILE, px + (q & 1) * h, py + (q >> 1) * h, h, h); got = true; }
    }
    return got;
  }
  /** v018 fix: the picture on screen; the map is told when its time changes (the time bar says it) */
  function setOn(v) {
    const was = on ? on.label : null; on = v;
    if ((v ? v.label : null) !== was) { try { onShown(); } catch (e) { /* the map draws on */ } }
  }
  /** a tile of the picture on screen, if it is made (only looked up: asking for it is choose()'s) */
  function tileOf(v, L, x, y) { const p = plan(v, L, x, y), c = p && comps.get(p.key); if (c) c.at = now(); return c || null; }
  function drawPic(pic, ctx, api) {
    const t = now();
    // the layer was off a while (it comes back with a new picture): nothing old stands in. v018 fix: the same picture drawn again after a
    // still spell (a retry, a pan) keeps what is on screen
    if (t - lastDraw > 10e3 && pic !== lastPic) { slots.clear(); setOn(null); }
    lastDraw = t; lastPic = pic;
    const z = api.z != null ? api.z : api.zoom, dpr = api.dpr || 1, W = api.w, H = api.h, v = typeof api.bounds === 'function' ? api.bounds() : api.view;
    if (!(z >= 0) || !v || !(W > 0) || !(H > 0)) return;
    const sv = yes(saver), L = levelFor(z, dpr, topLevel(pic, v), sv), T = tilesFor(v, z, L, W, H), nx = T.x1 - T.x0 + 1, ny = T.y1 - T.y0 + 1;
    if (nx <= 0 || ny <= 0) return;
    const xy = []; for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) xy.push([(((T.x0 + i) % T.n) + T.n) % T.n, T.y0 + j]);
    // v018 fix: one picture = one time - the newest of the frame's pictures with all of this view's tiles goes on screen once they are all
    // made; till then the one on screen stays (a tile of it new to the view is drawn as it comes in: the same time)
    const w = choose(pic, L, xy, 'hi');
    if (w.ready) setOn(w.ready);
    if (!mos) mos = R.canvas(nx * TILE, ny * TILE);
    else if (mos.width !== nx * TILE || mos.height !== ny * TILE) { mos.width = nx * TILE; mos.height = ny * TILE; }
    const g = mos.getContext('2d'), fade = yes(reduced) ? 0 : FADE_MS, seen = new Set();
    let anim = false, any = false;
    g.imageSmoothingEnabled = true;
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
      const [x, y] = xy[j * nx + i], k = `${L}/${x}/${y}`, px = i * TILE, py = j * TILE;
      seen.add(k);
      const c = on ? tileOf(on, L, x, y) : null;
      let s = slots.get(k); if (!s) { s = { img: null, key: '', from: null, start: -1e15 }; slots.set(k, s); }
      if (c && c.st === 'ok' && c.img && s.key !== c.key) { s.from = s.img; s.img = c.img; s.key = c.key; s.start = t; }
      const f = fade > 0 ? Math.max(0, Math.min(1, (t - s.start) / fade)) : 1;
      g.globalCompositeOperation = 'source-over'; g.globalAlpha = 1; g.clearRect(px, py, TILE, TILE);
      if (s.img) {
        any = true;
        if (f < 1) {   // old * (1 - f) + new * f, exactly ('lighter' adds premultiplied colour): no dip in the see-through clouds mid-fade
          anim = true;
          if (s.from) { g.globalAlpha = 1 - f; g.drawImage(s.from, px, py, TILE, TILE); g.globalCompositeOperation = 'lighter'; }
          g.globalAlpha = f; g.drawImage(s.img, px, py, TILE, TILE);
          g.globalCompositeOperation = 'source-over'; g.globalAlpha = 1;
        } else { s.from = null; g.drawImage(s.img, px, py, TILE, TILE); }
      } else if (on && standIn(g, on, L, x, y, px, py)) any = true;
    }
    for (const k of [...slots.keys()]) if (!seen.has(k)) slots.delete(k);
    if (any) {   // the visible tiles as ONE picture: stretched smoothly past the picture's own level, no seams between tiles
      ctx.save(); ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over'; ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
      const dx = snap(T.x0 * T.s - T.ox, dpr), dy = snap(T.y0 * T.s - T.oy, dpr);
      ctx.drawImage(mos, 0, 0, nx * TILE, ny * TILE, dx, dy, snap((T.x1 + 1) * T.s - T.ox, dpr) - dx, snap((T.y1 + 1) * T.s - T.oy, dpr) - dy);
      ctx.restore();
    }
    if (anim) onTile();
    if (playing && !sv) {   // the loop is playing: the next frame's tiles for this view, after this one's (the picture it will show)
      const nt = nextOf(pic.frame), np = nt == null || nt === pic.frame ? null : picture(nt, pic.lat, pic.lon);
      if (np) choose(np, L, xy, 'lo');
    }
  }
  /** the frame after t: from the loop's list (wrapping to its start), else t + the step between the last two frames played */
  const nextOf = (t) => { if (!frameList || !frameList.length) return step ? t + step : null; for (const f of frameList) if (f > t) return f; return frameList[0]; };

  return {
    stats,
    /** 'overlay' (the see-through clouds) | 'full' (the Satellite map); no argument: which */
    mode(m) { if (m === 'overlay' || m === 'full') mode = m; return mode; },
    /** get ready for the place (colour table, image times of both satellites) -> true when the layer can draw */
    async prepare(lat, lon) {
      const res = await Promise.allSettled([colormap(), ...LAYERS.map(timesOf)]), s = SATS[satFor(lon)];
      if (mode === 'overlay') { if (res[0].status === 'rejected') throw res[0].reason; const r = times.get(s.ir); if (!r || r.newest == null) throw new Error('no clouds'); }
      else if (!LAYERS.some((l) => times.get(l) && times.get(l).newest != null)) throw new Error('no satellite');
      return true;
    },
    /** the picture for a radar frame at time t over (lat, lon) -> { mode, kind ('geo' | 'ir' at the place), sat, t (the image's time),
     *  label ("clouds 9:50 PM"), draw(ctx, api), get(z, x, y), maxZ, alpha, times } | null. t and label are the image the frame asks
     *  for; what is drawn can be an earlier one GIBS has whole, or the last frame's while this one comes: shown() */
    at(t, lat, lon) {
      freshen();
      const pic = picture(t, lat, lon);
      const prev = lastAt, quick = !!prev && now() - prev.at < 3000; lastAt = { t, at: now() };
      if (frameList && frameList.length) playing = quick && nextOf(prev.t) === t;   // the frames come one after another: the loop plays
      else { const d = prev ? t - prev.t : 0; playing = quick && d > 0 && d <= 30 * 60e3; step = playing ? d : 0; }
      return pic;
    },
    /** v018 fix: the picture on screen -> { t (its image time), kind, sat, mode, label } | null (none yet): the time bar says this
     *  (shownWords), never a time that is not drawn; onShown says when it changes */
    shown: () => (on ? { t: on.t, kind: on.kind, sat: on.sat, mode: on.mode, label: on.label } : null),
    /** the radar loop's frame times (ms): while it plays, the next frame's tiles are fetched ahead */
    frames(list) { frameList = (list || []).filter(Number.isFinite).slice().sort((a, b) => a - b); },
    /** tiles still on their way (downloads and pictures being made) */
    pending: () => qNet.hi.length + qNet.lo.length + netBusy + qBuild.hi.length + qBuild.lo.length + (building ? 1 : 0),
    sizes: () => ({ comps: comps.size, blobs: src.size, blobBytes, slots: slots.size }),
    drop() {
      for (const c of comps.values()) if (c.img) R.release(c.img);
      comps.clear(); src.clear(); slots.clear(); needs.clear(); blobBytes = 0; setOn(null);
      if (mos) { mos.width = mos.height = 0; mos = null; }
    },
  };
}
