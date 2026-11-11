// nowcast/nws.js - the US National Weather Service (api.weather.gov, public domain) for the Nowcast view: the active storm-based
// warnings with their own outlines (tornado, severe thunderstorm, flash flood ...), the alerts at a point, and the 7-day forecast
// through the app's weather source (places/weather.js nwsSource, its interface unchanged; each point kept 30 minutes there).
// Only coordinates rounded to 0.01 degree are sent, as there. Official warnings always come first: the nowcast never hides one.
import { nwsSource, createWeather, withTimeout, timeoutError } from '../places/weather.js';
import { warnOf } from './colors.js';
import { neutralise } from '../places/neutralise.js';

const NWS = 'https://api.weather.gov/';
const r2 = (v) => Math.round(+v * 100) / 100;
const str = (v, n) => (v == null ? '' : neutralise(String(v))).slice(0, n);   // untrusted text from the network
// the warnings NWS draws as storm polygons (zone-wide alerts have no outline of their own: they show in the place's banner)
const POLY_EVENTS = ['Tornado Warning', 'Severe Thunderstorm Warning', 'Flash Flood Warning', 'Extreme Wind Warning', 'Snow Squall Warning', 'Dust Storm Warning', 'Special Weather Statement'];

// every request has a time limit (weather.js withTimeout, 20 s): a stalled answer fails like a bad one (code WEATHER_TIMEOUT)
async function getJSON(url, { signal, fetchFn = fetch } = {}) {
  try {
    const r = await fetchFn(url, { headers: { Accept: 'application/geo+json' }, signal: withTimeout(signal) });
    if (r.status === 404) return { status: 404 };
    if (!r.ok) throw Object.assign(new Error('the National Weather Service answered ' + r.status), { code: 'WEATHER_HTTP' });
    return await r.json();
  } catch (e) { throw timeoutError(e, 'the National Weather Service'); }
}
/** an alert feature -> { event, severity, headline, ends, color, label, rings: [[[lon, lat] ...]] } */
function alertOf(f) {
  const p = f.properties || {}, w = warnOf(p.event), g = f.geometry, rings = [];
  if (g && g.type === 'Polygon') for (const r of g.coordinates) rings.push(r);
  else if (g && g.type === 'MultiPolygon') for (const poly of g.coordinates) for (const r of poly) rings.push(r);
  return { id: str(p.id || f.id, 200), event: str(p.event, 80), severity: str(p.severity, 20), urgency: str(p.urgency, 20), headline: str(p.headline, 240), area: str(p.areaDesc, 300),
    ends: str(p.ends || p.expires, 40), instruction: str(p.instruction, 600), color: w ? w.color : '#8E8E93', key: w ? w.key : 'other', label: w ? w.label : str(p.event, 60), rings };
}
const rank = (a) => ['tornado', 'severe', 'flash', 'other', 'watch'].indexOf(a.key) + (/warning/i.test(a.event) ? 0 : 10);

/** -> { warnings: (the drawn outlines, most serious first), at(lat, lon): point alerts, forecast(lat, lon) } */
export function createNws({ fetchFn = (...a) => fetch(...a) } = {}) {
  const details = new Map();   // the forecast's detailed text per point (weather.js keeps the periods, not the long text)
  const fetchJSON = async (url, o = {}) => {
    const j = await getJSON(url, Object.assign({ fetchFn }, o));
    if (/\/forecast$/.test(new URL(url).pathname) && j && j.properties && Array.isArray(j.properties.periods)) details.set(url, j.properties.periods.map((x) => ({ start: str(x.startTime, 30), detail: str(x.detailedForecast, 400), icon: str(x.icon, 200) })));
    return j;
  };
  const W = createWeather({ sources: [nwsSource({ fetchJSON })] });
  let polys = null;
  return {
    /** the storm-based warnings now in force over the US, with their outlines (cached 2 minutes) */
    async warnings({ signal } = {}) {
      if (polys && Date.now() - polys.at < 120e3) return polys.list;
      const j = await getJSON(`${NWS}alerts/active?status=actual&message_type=alert,update&event=${encodeURIComponent(POLY_EVENTS.join(','))}`, { signal, fetchFn });
      const list = ((j && j.features) || []).map(alertOf).filter((a) => a.rings.length).sort((a, b) => rank(a) - rank(b));
      polys = { at: Date.now(), list }; return list;
    },
    /** every alert in force at a point (warnings first) */
    async at(lat, lon, { signal } = {}) {
      const j = await getJSON(`${NWS}alerts/active?point=${r2(lat)},${r2(lon)}`, { signal, fetchFn });
      return ((j && j.features) || []).map(alertOf).sort((a, b) => rank(a) - rank(b));
    },
    /** the 7-day forecast: { place, periods (14, each with its detailed text), alerts, updated } | { outside: true } */
    async forecast(lat, lon, { signal } = {}) {
      const fc = await W.forecast(lat, lon, { signal });
      if (fc.outside) return fc;
      let d = null; for (const v of details.values()) if (v.length && fc.periods.length && v[0].start === fc.periods[0].start) d = v;
      return Object.assign({}, fc, { periods: fc.periods.map((p, i) => Object.assign({}, p, { detail: d && d[i] && d[i].start === p.start ? d[i].detail : '' })) });
    },
  };
}
export const NWS_LINE = 'Forecast: US National Weather Service';
export const OFFICIAL = 'For warnings, follow the National Weather Service and your local officials. This nowcast is experimental.';
