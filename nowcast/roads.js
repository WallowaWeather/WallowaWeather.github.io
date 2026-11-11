// nowcast/roads.js - Wallowa Weather's "Roads" layer (including National Forest roads): the USGS National
// Map's transportation service (public domain: Census TIGER/Line roads and the Forest Service's roads with their numbers), as see-through tiles.
'use strict';

export const ROADS_CREDIT = 'Roads: USGS';

export const ROADS_NOTE = 'Roads from the USGS National Map (Census TIGER/Line and Forest Service roads). Not a record of which roads are open: forest roads can be closed, gated or impassable. Check the Forest Service’s Motor Vehicle Use Map before you drive.';

/** v011 (so the layer never disappears): from zoom 8 (was 10), with the service's small-scale major roads (layer 0) at 8-10. Checked
 *  Nov-08-2026 over Wallowa County: at 8 and 9 it draws the highways (the state routes and I-84) and their shields, readable; at 7 the
 *  same layer is a web of roads with each US route's shield five times down a tile, so 7 is left out. */
export const ROADS_MIN_Z = 8;

export const ROADS_URL = 'https://carto.nationalmap.gov/arcgis/rest/services/transportation/MapServer/export';

export function roadsTileUrl(z, x, y) {
  const R = 20037508.342789244;
  const size = (2 * R) / (2 ** z);
  const xmin = -R + x * size;
  const xmax = xmin + size;
  const ymax = R - y * size;
  const ymin = ymax - size;
  return `${ROADS_URL}?bbox=${xmin.toFixed(2)},${ymin.toFixed(2)},${xmax.toFixed(2)},${ymax.toFixed(2)}&bboxSR=3857&imageSR=3857` +
    `&size=512,512&dpi=192&format=png32&transparent=true&layers=show:${roadsLayers(z)}&f=image`;
}

/** which of the service's layers at each zoom (checked Nov-05-2026): its large-scale group (13) draws nothing zoomed out past 1:500,000,
 *  so zooms 8-10 take the small-scale major roads (0); zooms 11-12 take every road line (26: incl. Forest Service, 4WD and closed roads)
 *  with only the highway shields and names (16-19), since every spur's number at that zoom is a wall of labels; 13+ takes everything (13) */
export function roadsLayers(z) {
  return z <= 10 ? '0' : z <= 12 ? '26,16,17,18,19' : '13';
}

export const ROADS_SOURCE = { id: 'roads', minZoom: ROADS_MIN_Z, maxNative: 16, credit: ROADS_CREDIT, urlFor: roadsTileUrl };
