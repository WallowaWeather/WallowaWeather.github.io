// nowcast/fields/units.js - the forecast maps' units and wind math. Pure (page, worker, Node).
//   HRRR gives m/s, K, %, Pa and kg m-2 s-1 (= mm/s); the maps show mph, F, %, hPa and in/h (the field itself stays in mm/h so it
//   shares the radar's colour stops).
//   Wind: speed = hypot(u, v); the meteorological direction is where it blows FROM (0 = from the north, 90 = from the east), the map's
//   arrow points where it blows TO. HRRR's 10 m winds are relative to its Lambert grid (GRIB2 flag uvRelativeToGrid = 1): gridToEarth()
//   turns them to east / north. The grid's +y axis bears cone x (lon - LoV) from true north (cone = sin 38.5, LoV = 97.5 W); checked
//   against axes measured from ecCodes' own grid latitudes / longitudes.
'use strict';

export const msToMph = (x) => x / 0.44704;   // 1 mph = 0.44704 m/s exactly
export const kToF = (k) => ((k - 273.15) * 9) / 5 + 32;
export const paToHpa = (p) => p / 100;
export const paToInHg = (p) => p / 3386.389;
export const rateToMmH = (r) => r * 3600;
export const rateToInH = (r) => (r * 3600) / 25.4;
export const mmhToInH = (x) => x / 25.4;

const DEG = 180 / Math.PI;
export const windSpeed = (u, v) => Math.hypot(u, v);
/** degrees clockwise from north the wind comes FROM, in [0, 360); calm (0, 0) has none: NaN */
export function windFrom(u, v) {
  if (u === 0 && v === 0) return NaN;
  const d = Math.atan2(-u, -v) * DEG;
  return d < 0 ? d + 360 : d >= 360 ? d - 360 : d;
}
/** degrees clockwise from north the wind blows TO (the map's arrow), in [0, 360); calm: NaN */
export function windTo(u, v) {
  if (u === 0 && v === 0) return NaN;
  const d = Math.atan2(u, v) * DEG;
  return d < 0 ? d + 360 : d >= 360 ? d - 360 : d;
}
const WORDS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
/** a bearing -> its 16-point compass word (sectors of 22.5 degrees centred on the words) */
export const compass = (deg) => (Number.isFinite(deg) ? WORDS[Math.floor((((deg % 360) + 360) % 360 + 11.25) / 22.5) % 16] : '');
/** a TO bearing -> the unit vector to draw on the screen (x right, y down: north is up) */
export const arrowXY = (deg) => [Math.sin(deg / DEG), -Math.cos(deg / DEG)];

// HRRR CONUS: Lambert conformal, both standard parallels 38.5 N, LoV 262.5 E
export const CONE = Math.sin((38.5 * Math.PI) / 180), LOV = -97.5;
/** the bearing of the grid's +y axis at a longitude (degrees, + = east of north) */
export const rotationDeg = (lon) => { let d = lon - LOV; while (d > 180) d -= 360; while (d < -180) d += 360; return CONE * d; };
/** grid-relative (u, v) at a longitude -> earth-relative [east, north] (m/s) */
export function gridToEarth(ug, vg, lon) {
  const a = rotationDeg(lon) / DEG, c = Math.cos(a), s = Math.sin(a);
  return [ug * c + vg * s, -ug * s + vg * c];
}
