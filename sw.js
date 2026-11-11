// sw.js - Wallowa Weather's offline store, so the app loads quickly. It keeps the app's own files, so the app opens with no signal, and answers Wallowa County map tiles from the phone
// first (nowcast/offline.js saves the county ahead of time; tiles looked at are kept too, capped). Radar, alerts, the NWS, forecasts and
// everything else always go to the network. Oregon's OSIP aerials are never kept here (no published terms): the browser handles them.
// v014: the same for every other county kept on this phone (Settings › Counties): its saved map is the cache COUNTY + ':' + its id, and
// tiles looked at inside it are kept too; a county not kept is left to the network, as before.
'use strict';

const BUILD = 'e7a31dce8796';   // a hash of the files below (refilled for each release)
const FILES = ["app.css", "config.js", "dlall.js", "engine/core/gpu.js", "engine/core/opfs_worker.js", "engine/core/pin.js", "engine/core/store.js", "icon-180.png", "icon-192.png", "icon-32.png", "icon-512-maskable.png", "icon-512.png", "index.html", "install.js", "landing.css", "landing.js", "licenses/Apache-2.0.txt", "licenses/BEAM-NOTICE.txt", "licenses/BSD-3-Clause-climt.txt", "licenses/NOTICE.txt", "licenses/NVIDIA-Open-Model-License.txt", "logo-256.png", "manifest.webmanifest", "nowcast/affected.css", "nowcast/affected.js", "nowcast/basemaps.js", "nowcast/beam.css", "nowcast/beam.js", "nowcast/beam/engine/beam.js", "nowcast/beam/engine/engine.js", "nowcast/beam/engine/gpu.js", "nowcast/beam/engine/input.js", "nowcast/beam/engine/kernels.js", "nowcast/beam/engine/sha256.js", "nowcast/beam/inputs/abi/abi.js", "nowcast/beam/inputs/glm/glm.js", "nowcast/beam/inputs/hrrr/f16.js", "nowcast/beam/inputs/hrrr/grib2_frame.js", "nowcast/beam/inputs/hrrr/hrrr.js", "nowcast/beam/inputs/radar/radar.js", "nowcast/beam/runner/builders.js", "nowcast/beam/runner/cache.js", "nowcast/beam/runner/inputs_worker.js", "nowcast/beam/runner/net.js", "nowcast/beam/runner/run_beam.js", "nowcast/beam/runner/stack.js", "nowcast/beam/shared/grib2.js", "nowcast/beam_live.js", "nowcast/bench.css", "nowcast/bench.js", "nowcast/cadence.js", "nowcast/cardfold.js", "nowcast/clouds.js", "nowcast/colors.js", "nowcast/corridor.js", "nowcast/counties.js", "nowcast/county_layers.js", "nowcast/credits.js", "nowcast/data/beam_examples/beam-2021-06-03.json", "nowcast/data/beam_examples/beam-2022-08-11.json", "nowcast/data/beam_examples/beam-2025-07-31.json", "nowcast/data/beam_examples/beam-2026-07-23.json", "nowcast/data/beam_examples/index.json", "nowcast/data/beam_recal.json", "nowcast/data/county_douglas.json", "nowcast/data/county_lane.json", "nowcast/data/county_wallowa.json", "nowcast/data/huc12_douglas.json", "nowcast/data/huc12_lane.json", "nowcast/data/huc12_wallowa.json", "nowcast/data/lands_douglas.json", "nowcast/data/lands_lane.json", "nowcast/data/place_pop.txt.gz", "nowcast/data/rain_examples/dgmr-2021-06-03.json", "nowcast/data/rain_examples/dgmr-2022-08-11.json", "nowcast/data/rain_examples/dgmr-2025-07-31.json", "nowcast/data/rain_examples/dgmr-2026-07-23.json", "nowcast/data/rain_examples/index.json", "nowcast/data/rain_examples/stormscope-2021-06-03.json", "nowcast/data/rain_examples/stormscope-2022-08-11.json", "nowcast/data/rain_examples/stormscope-2025-07-31.json", "nowcast/data/rain_examples/stormscope-2026-07-23.json", "nowcast/data/us_lines.bin", "nowcast/dgmr/dgmr.js", "nowcast/dgmr/kernels_float.js", "nowcast/dgmr/kernels_int8.js", "nowcast/dgmr/plan.js", "nowcast/drainages.js", "nowcast/engine.js", "nowcast/ensemble.js", "nowcast/examples.js", "nowcast/exampleui.js", "nowcast/feeds.js", "nowcast/fields/budget.js", "nowcast/fields/cache.js", "nowcast/fields/decode.js", "nowcast/fields/hrrr.js", "nowcast/fields/index.js", "nowcast/fields/particles.js", "nowcast/fields/ramps.js", "nowcast/fields/units.js", "nowcast/fields/worker.js", "nowcast/fires.js", "nowcast/firewx.js", "nowcast/gauges.js", "nowcast/gl/backend.js", "nowcast/gl/field.js", "nowcast/gl/proj.js", "nowcast/gl/ramp.js", "nowcast/gl/renderer.js", "nowcast/gps.js", "nowcast/grib2.js", "nowcast/icons.js", "nowcast/labels.js", "nowcast/lands.js", "nowcast/layerspanel.js", "nowcast/legend.js", "nowcast/lines.js", "nowcast/lotcount.js", "nowcast/map.js", "nowcast/mine.css", "nowcast/mine.js", "nowcast/model.js", "nowcast/modelpick.css", "nowcast/modelpick.js", "nowcast/models_info.js", "nowcast/mrms.js", "nowcast/nowcast.css", "nowcast/nowcast_app.js", "nowcast/nws.js", "nowcast/offline.js", "nowcast/parcels.js", "nowcast/post.js", "nowcast/presets.css", "nowcast/presets.js", "nowcast/public_lands.json", "nowcast/qc.js", "nowcast/radar.js", "nowcast/radar_worker.js", "nowcast/regrid.js", "nowcast/report.css", "nowcast/report.js", "nowcast/roads.js", "nowcast/run.js", "nowcast/satimg.js", "nowcast/settings.css", "nowcast/settings.js", "nowcast/skill.js", "nowcast/store.js", "nowcast/stormscope/alerts.js", "nowcast/stormscope/engine.js", "nowcast/stormscope/grib53.js", "nowcast/stormscope/kernels.js", "nowcast/stormscope/ladder.js", "nowcast/stormscope/lcc.js", "nowcast/stormscope/prep/app_link.js", "nowcast/stormscope/prep/cond.js", "nowcast/stormscope/prep/glm.js", "nowcast/stormscope/prep/goes.js", "nowcast/stormscope/prep/grid.js", "nowcast/stormscope/prep/hdf5.js", "nowcast/stormscope/prep/index.js", "nowcast/stormscope/prep/layers.js", "nowcast/stormscope/prep/mrms_ss.js", "nowcast/stormscope/prep/nn.js", "nowcast/stormscope/prep/s3.js", "nowcast/stormscope/prep/tile.js", "nowcast/stormscope/run_ss.js", "nowcast/stormscope/ss.js", "nowcast/stormscope/type.js", "nowcast/summary.js", "nowcast/timebar.js", "nowcast/tune/core.js", "nowcast/tune/measure.js", "nowcast/tune/tune.js", "nowcast/tune/ui.js", "nowcast/tune/variants.js", "nowcast/view.js", "places/data/places_us.txt.gz", "places/data/zcta_us.bin.gz", "places/neutralise.js", "places/places.js", "places/weather.js", "ww.css", "ww.js"];   // the app's own files (refilled for each release)
const SCOPE = self.registration.scope;
const APP_PREFIX = 'wallowa-weather:app:' + SCOPE + ':';
const APP = APP_PREFIX + BUILD;
const COUNTY = 'wallowa-weather:county';   // the county map, saved ahead by nowcast/offline.js
const VIEWED = 'wallowa-weather:viewed';   // tiles looked at inside the county, oldest dropped past VIEWED_MAX
const VIEWED_MAX = 2500;
const AREA = [44.75, -118.15, 46.15, -116.35];   // [south, west, north, east]: the app's county box plus ~10 km
// v014: the other counties' boxes plus ~10 km (nowcast/counties.js bbox + 0.1 degree; a test checks they match)
const MORE = [['lane', [43.34, -124.33, 44.39, -121.67]], ['douglas', [42.6, -124.39, 44.04, -121.87]]];
const MAX_AGE = 30 * 864e5;   // a saved tile older than 30 days is refreshed in the background (when there is signal)
const OWN = new Set(FILES.map((f) => new URL(f, SCOPE).href));
const NM = 'https://basemap.nationalmap.gov/arcgis/rest/services/';
const TILES = [   // [url prefix, how its tile is named]: 'zyx' = .../{z}/{y}/{x}[.ext], 'bbox' = an ArcGIS export with bbox= in Web Mercator metres
  [NM + 'USGSImageryOnly/MapServer/tile/', 'zyx'],
  [NM + 'USGSShadedReliefOnly/MapServer/tile/', 'zyx'],
  [NM + 'USGSTopo/MapServer/tile/', 'zyx'],
  ['https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/BlueMarble_ShadedRelief_Bathymetry/', 'zyx'],
  ['https://carto.nationalmap.gov/arcgis/rest/services/transportation/MapServer/export', 'bbox'],
];

function centreOf(href, kind) {
  try {
    if (kind === 'zyx') {
      const m = href.match(/\/(\d+)\/(\d+)\/(\d+)(?:\.\w+)?(?:\?.*)?$/);
      if (!m) return null;
      const z = Number(m[1]);
      const y = Number(m[2]);
      const x = Number(m[3]);
      const n = 2 ** z;
      const lon = (x + 0.5) / n * 360 - 180;
      const lat = Math.atan(Math.sinh(Math.PI * (1 - 2 * (y + 0.5) / n))) * 180 / Math.PI;
      return { z, lat, lon };
    }
    if (kind === 'bbox') {
      const b = (new URL(href).searchParams.get('bbox') || '').split(',').map(Number);
      if (b.length !== 4 || !b.every((v) => Number.isFinite(v))) return null;
      const mx = (b[0] + b[2]) / 2;
      const my = (b[1] + b[3]) / 2;
      const lon = mx / 6378137 * 180 / Math.PI;
      const lat = (2 * Math.atan(Math.exp(my / 6378137)) - Math.PI / 2) * 180 / Math.PI;
      const z = Math.round(Math.log2(2 * 20037508.342789244 / (b[2] - b[0])));
      return { z, lat, lon };
    }
    return null;
  } catch (e) {
    return null;
  }
}

/** a map tile's middle ({ z, lat, lon }), or null: not a tile of a saved source, or closer than z17 */
function tileCentre(href) {
  for (const [prefix, kind] of TILES) {
    if (href.startsWith(prefix)) {
      const c = centreOf(href, kind);
      return c && c.z <= 17 ? c : null;
    }
  }
  return null;
}
const inBox = (c, [s, w, n, e]) => c.lat >= s && c.lat <= n && c.lon >= w && c.lon <= e;

async function save(cache, href, res) {
  const b = await res.blob();
  await cache.put(href, new Response(b, {
    status: 200,
    headers: {
      'Content-Type': res.headers.get('Content-Type') || b.type || 'image/png',
      'X-WW-Saved': String(Date.now())
    }
  }));
}

let puts = 0;

async function trim() {
  puts++;
  if (puts % 50 !== 0) return;
  const c = await caches.open(VIEWED);
  const keys = await c.keys();
  if (keys.length > VIEWED_MAX) {
    const toDelete = keys.slice(0, keys.length - (VIEWED_MAX - 250));
    await Promise.all(toDelete.map((k) => c.delete(k)));
  }
}

async function refresh(cache, href) {
  try {
    const r = await fetch(href, { mode: 'cors', credentials: 'omit' });
    if (r.ok) {
      await save(cache, href, r);
    }
  } catch (e) {
    // swallow every error
  }
}

/** names: the saved maps to look in first (Wallowa's; v014: the kept counties' whose box holds the tile) */
async function tile(event, href, names = [COUNTY]) {
  const viewedCache = await caches.open(VIEWED);
  let hit = null;
  let thatCache = null;
  for (const name of names) {
    const countyCache = await caches.open(name);
    hit = await countyCache.match(href);
    thatCache = countyCache;
    if (hit) break;
  }
  if (!hit) {
    hit = await viewedCache.match(href);
    thatCache = viewedCache;
  }
  if (hit) {
    const savedAt = Number(hit.headers.get('X-WW-Saved')) || 0;
    if (Date.now() - savedAt > MAX_AGE) {
      event.waitUntil(refresh(thatCache, href));
    }
    return hit;
  }
  try {
    const r = await fetch(event.request);
    if (r.ok) {
      event.waitUntil(save(viewedCache, href, r.clone()).then(trim).catch(() => {}));
    }
    return r;
  } catch (e) {
    return Response.error();
  }
}

/** v014: a tile in a county's box: kept counties answer it (and keep the tiles looked at); none kept: the network, untouched. Wallowa's
 *  too (v018 review): its saved map switched off, nothing records where the map was looked at (offline.js makes a kept county's cache at
 *  once and deletes it when switched off; caches.open here would make it again) */
async function kept(event, href, names) {
  const have = [];
  for (const name of names) if (await caches.has(name)) have.push(name);
  if (have.length) return tile(event, href, have);
  try {
    return await fetch(event.request);
  } catch (e) {
    return Response.error();
  }
}

async function own(req, href) {
  const c = await caches.open(APP);
  const hit = await c.match(href);
  if (hit) return hit;
  return fetch(req);
}

async function page(req) {
  const c = await caches.open(APP);
  const indexUrl = new URL('index.html', SCOPE).href;
  const hit = await c.match(indexUrl);
  if (hit) return hit;
  return fetch(req);
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(APP)
      .then((c) => c.addAll(FILES.map((f) => new Request(new URL(f, SCOPE).href, { cache: 'reload' }))))
    // Josh, v018: a new version waits until the app is closed and opened again (no skipWaiting: a page that is open keeps the files it
    // started with, never half old and half new)
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((ks) => Promise.all(ks.filter((k) => k.startsWith(APP_PREFIX) && k !== APP).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const href = req.url.split('#')[0];

  if (req.mode === 'navigate') {
    const u = new URL(href);
    u.search = '';
    if (u.href === SCOPE || u.href === SCOPE + 'index.html') {
      event.respondWith(page(req));
      return;
    }
  }

  if (OWN.has(href)) {
    event.respondWith(own(req, href));
    return;
  }

  if (req.cache === 'no-cache' || req.cache === 'no-store' || req.cache === 'reload') return;

  const c = tileCentre(href);
  if (!c) return;
  const names = (inBox(c, AREA) ? [COUNTY] : []).concat(MORE.filter(([, box]) => inBox(c, box)).map(([id]) => COUNTY + ':' + id));
  if (names.length) event.respondWith(kept(event, href, names));
});
