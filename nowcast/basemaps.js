// nowcast/basemaps.js - Wallowa Weather's basemaps (research Nov-04-2026: free for a public site, no key, browser access allowed):
//   Satellite = USGS National Map imagery (to z16, stretched past it) + Oregon's 1-ft OSIP 2022 aerials from z13 inside Oregon (to z19)
//               + USGS 3DEP shaded relief blended in; Topo = USGS topo; Relief = NASA GIBS shaded relief (the plain map's look).
// Esri imagery is NOT used: its terms need an API key or an ArcGIS identity even though the tiles load without one.
// Each source carries the credit its terms ask for; the screen shows the credits of what is on screen.
import { GIBS } from './map.js';

const NM = 'https://basemap.nationalmap.gov/arcgis/rest/services/';
const OREGON = [41.95, -124.75, 46.3, -116.4];   // [south, west, north, east]
export const BASEMAPS = {
  satellite: { label: 'Satellite', maxZoom: 19, sources: [
    { id: 'usgs-img', url: NM + 'USGSImageryOnly/MapServer/tile/{z}/{y}/{x}', maxNative: 16, credit: 'Imagery: USDA, USGS The National Map' },
    { id: 'osip-2022', url: 'https://imagery.oregonexplorer.info/arcgis/rest/services/OSIP_2022/OSIP_2022_WM/ImageServer/tile/{z}/{y}/{x}', maxNative: 19, minZoom: 13, bounds: OREGON,
      credit: 'Imagery: Oregon Statewide Imagery Program (OSIP) 2022' },
    { id: 'usgs-relief', url: NM + 'USGSShadedReliefOnly/MapServer/tile/{z}/{y}/{x}', maxNative: 16, alpha: 0.35, blend: 'multiply', credit: 'Relief: USGS 3DEP' },
  ] },
  topo: { label: 'Topo', maxZoom: 18, sources: [
    { id: 'usgs-topo', url: NM + 'USGSTopo/MapServer/tile/{z}/{y}/{x}', maxNative: 16, credit: 'Map: USGS The National Map' },
  ] },
  relief: { label: 'Relief', maxZoom: 12, sources: [
    { id: 'gibs', url: GIBS, maxNative: 8, credit: 'Basemap: NASA GIBS' },
  ] },
};
/** the hosts the page's Content-Security-Policy must allow for these */
export const BASEMAP_HOSTS = ['https://basemap.nationalmap.gov', 'https://imagery.oregonexplorer.info', 'https://gibs.earthdata.nasa.gov'];
