// nowcast/fields/ramps.js - the forecast maps' colours: our own ramps, designed in OKLCH (perceptually even steps) and checked
// numerically for colour-blind readers (neighbouring stops CIEDE2000 >= 10 for normal vision, >= 7 under
// deuteranopia, >= 6 protanopia, >= 5 tritanopia, and no two stops of a ramp confusable under deuteranopia) and as drawn over the
// map's ground. Temperature and pressure are deliberately not the usual weather-map colours, so the maps look like ours.
//   wind      calm indigo, rising in lightness through blue, teal and green to yellow at 30 mph, then orange, red and magenta
//   temp      built around freezing, the line that decides frost, ice and rain or snow: navy, petrol and teal lighten to
//             aqua at 32 F, then one sharp step to pale ivory just above freezing (clear in every colour vision and over any ground),
//             darkening through butter, amber, orange, vermilion and crimson to wine at 110 F - no purple in the cold, no green or
//             cyan above freezing, the lightest colour at the thaw instead of a yellow peak in the 70s
//   rh        diverging: dry rust -> pale at 40 % -> wet blue, both ends equally dark (dry air, the fire-weather end, stands out)
//   pressure  diverging: lows plum / violet / lavender, standard pressure pale cream, highs gold / ochre / umber
//   precip    the app's own radar colours (nowcast/colors.js RAIN / SNOW / SLEET / FRZ, mm/h) so the forecast matches the radar legend
// A ramp is [[value, [r, g, b, a]], ...] (values ascending, a in 0..1, linear in between: the map API's format). Pure.
'use strict';
import { RAIN, SNOW, SLEET, FRZ } from '../colors.js';

const A = (rows, alpha) => rows.map(([v, r, g, b], i) => [v, [r, g, b, typeof alpha === 'function' ? alpha(v, i) : alpha]]);
const fromRadar = (stops) => [[0, [stops[0][1], stops[0][2], stops[0][3], 0]], ...stops.map(([v, r, g, b, a]) => [v, [r, g, b, a]])];

export const RAMPS = {
  wind: A([[0, 64, 59, 120], [5, 47, 87, 156], [10, 0, 120, 169], [15, 0, 151, 163], [20, 33, 181, 143], [25, 130, 202, 105], [30, 227, 216, 70],
    [40, 250, 153, 2], [50, 239, 97, 27], [60, 217, 38, 65], [80, 171, 0, 106]], (v) => (v <= 0 ? 0.62 : v <= 5 ? 0.7 : v <= 10 ? 0.78 : 0.85)),
  // the step at freezing: 32 F is the last cold colour, 33 F the first warm one (a pill reading "32°" is tinted cold)
  temp: A([[-20, 20, 48, 101], [0, 0, 83, 126], [16, 0, 122, 148], [32, 8, 162, 175], [33, 248, 243, 213], [45, 244, 227, 130], [57, 244, 175, 56],
    [70, 236, 129, 45], [83, 221, 80, 60], [96, 184, 40, 77], [110, 129, 17, 71]], 0.72),
  rh: A([[0, 120, 50, 24], [10, 155, 78, 26], [20, 183, 115, 43], [30, 204, 160, 81], [40, 210, 223, 163], [50, 148, 205, 167], [60, 96, 186, 172],
    [70, 45, 160, 173], [80, 6, 131, 170], [90, 36, 98, 162], [100, 56, 64, 143]], 0.7),
  pressure: A([[970, 83, 1, 68], [980, 118, 30, 125], [990, 141, 76, 180], [1000, 163, 125, 219], [1008, 190, 174, 245], [1013, 236, 234, 196],
    [1018, 235, 207, 117], [1024, 231, 164, 39], [1030, 211, 118, 0], [1040, 174, 80, 0], [1050, 131, 47, 0]], 0.62),
  rain: fromRadar(RAIN), snow: fromRadar(SNOW), sleet: fromRadar(SLEET), frz: fromRadar(FRZ),
};

export const SCALE = { wind: 'linear', temp: 'linear', rh: 'linear', pressure: 'linear', precip: 'log' };
const MINUS = '−';
const lin = (ramp, list) => { const a = ramp[0][0], b = ramp[ramp.length - 1][0]; return list.map(([v, label]) => ({ v, label, pos: (v - a) / (b - a) })); };
const PMIN = 0.1, PMAX = 64;   // the radar ramp's coloured range, mm/h
const logt = (list) => list.map(([v, label]) => ({ v, label, pos: Math.log(v / PMIN) / Math.log(PMAX / PMIN) }));
/** the legend's labelled ticks: v in the field's own units (mph, F, %, hPa; precipitation mm/h, labelled in in/h), pos 0..1 on the bar */
export const TICKS = {
  wind: lin(RAMPS.wind, [[0, '0'], [10, '10'], [20, '20'], [30, '30'], [40, '40'], [50, '50'], [60, '60'], [80, '80']]),
  temp: lin(RAMPS.temp, [[-20, MINUS + '20'], [0, '0'], [20, '20'], [32, '32'], [50, '50'], [70, '70'], [90, '90'], [110, '110']]),
  rh: lin(RAMPS.rh, [[0, '0'], [20, '20'], [40, '40'], [60, '60'], [80, '80'], [100, '100']]),
  pressure: lin(RAMPS.pressure, [[980, '980'], [990, '990'], [1000, '1000'], [1010, '1010'], [1020, '1020'], [1030, '1030'], [1040, '1040']]),
  precip: logt([[0.254, '0.01'], [1.27, '0.05'], [2.54, '0.1'], [6.35, '0.25'], [12.7, '0.5'], [25.4, '1'], [50.8, '2']]),
};

/** the ramp's colour at a value: [r, g, b, a] (linear between stops, clamped at the ends), null for NaN */
export function colorAt(ramp, v) {
  if (v !== v) return null;
  const n = ramp.length;
  if (v <= ramp[0][0]) return ramp[0][1].slice();
  if (v >= ramp[n - 1][0]) return ramp[n - 1][1].slice();
  let lo = 0, hi = n - 1;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (ramp[m][0] <= v) lo = m; else hi = m; }
  const [va, ca] = ramp[lo], [vb, cb] = ramp[hi], f = (v - va) / (vb - va);
  return [ca[0] + (cb[0] - ca[0]) * f, ca[1] + (cb[1] - ca[1]) * f, ca[2] + (cb[2] - ca[2]) * f, ca[3] + (cb[3] - ca[3]) * f];
}
/** an opaque css colour for a value (the pills' chip tone) */
export function cssAt(ramp, v) {
  const c = colorAt(ramp, v);
  return c ? `rgb(${Math.round(c[0])}, ${Math.round(c[1])}, ${Math.round(c[2])})` : 'transparent';
}
/** the pills' chip colour: the ramp's colour mixed half way to white, so the chip's dark text always reads (tests: WCAG >= 4.5) */
export function tintAt(ramp, v, mix = 0.5) {
  const c = colorAt(ramp, v);
  if (!c) return 'transparent';
  const t = (x) => Math.round(x + (255 - x) * mix);
  return `rgb(${t(c[0])}, ${t(c[1])}, ${t(c[2])})`;
}
/** values -> RGBA bytes through the ramp (the canvas-2D fallback; NaN transparent) */
export function paintRGBA(values, ramp, out = null) {
  const n = values.length, px = out && out.length === 4 * n ? out : new Uint8ClampedArray(4 * n);
  for (let i = 0; i < n; i++) {
    const c = colorAt(ramp, values[i]), o = 4 * i;
    if (!c) { px[o] = px[o + 1] = px[o + 2] = px[o + 3] = 0; continue; }
    px[o] = c[0]; px[o + 1] = c[1]; px[o + 2] = c[2]; px[o + 3] = Math.round(c[3] * 255);
  }
  return px;
}
