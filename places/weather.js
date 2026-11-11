// weather.js - the app's weather sources.
// Sources share one interface, forecast(lat, lon, o) -> facts | { outside } (createWeather): the US National Weather Service today
// (api.weather.gov, public domain); a nowcast source for the next 90 minutes (the Nowcast's DGMR, CONUS) can sit beside it. Only the
// coordinates, rounded to 0.01 degree (about 1 km), go to a source: never the place's name or the ZIP.
import { STATES, normName, stateOf } from './places.js';
import { neutralise } from './neutralise.js';   // NWS text never carries chat-template control tokens

// ---------------------------------------------------------------------------------------------------------------- the sources
const r2 = (v) => Math.round(+v * 100) / 100;
const str = (v, n) => (v == null ? '' : neutralise(String(v))).slice(0, n);   // untrusted text from the network
const NWS = 'https://api.weather.gov/';
export const NWS_CREDIT = 'Forecast: US National Weather Service (weather.gov)';
/** an NWS request that has not answered (headers and body) within this long fails like a bad answer (nowcast/nws.js uses it too) */
export const NWS_TIMEOUT_MS = 20e3;
/** the caller's signal (if any) joined with the time limit (AbortSignal.timeout; AbortSignal.any where the browser has it) */
export function withTimeout(signal, ms = NWS_TIMEOUT_MS) {
  let t;
  if (typeof AbortSignal.timeout === 'function') t = AbortSignal.timeout(ms);
  else { const c = new AbortController(); setTimeout(() => c.abort(new DOMException('timed out', 'TimeoutError')), ms); t = c.signal; }
  if (!signal) return t;
  if (typeof AbortSignal.any === 'function') return AbortSignal.any([signal, t]);
  const c = new AbortController(), stop = (s) => () => c.abort(s.reason);
  if (signal.aborted) c.abort(signal.reason); else { signal.addEventListener('abort', stop(signal), { once: true }); t.addEventListener('abort', stop(t), { once: true }); }
  return c.signal;
}
/** a request stopped by the time limit -> a plain error (code WEATHER_TIMEOUT) on the usual error path; any other error unchanged (the
 *  caller's own abort stays an AbortError) */
export const timeoutError = (e, who = 'the weather service') => (e && e.name === 'TimeoutError'
  ? Object.assign(new Error(`${who} did not answer within ${Math.round(NWS_TIMEOUT_MS / 1000)} s`), { code: 'WEATHER_TIMEOUT' }) : e);
async function defaultFetchJSON(url, { signal } = {}) {
  try {
    const r = await fetch(url, { headers: { Accept: 'application/geo+json' }, signal: withTimeout(signal) });
    if (r.status === 404) return { status: 404 };
    if (!r.ok) throw Object.assign(new Error('the weather service answered ' + r.status), { code: 'WEATHER_HTTP' });
    return await r.json();
  } catch (e) { throw timeoutError(e); }
}
/** the US National Weather Service: /points/{lat},{lon}, then its forecast (and its hourly forecast when asked) and the active alerts
 *  for the point -> { source, name, credit, place, periods (14: a week of day and night), hourly (3), alerts (3), updated, ms } or { outside: true } (no NWS
 *  forecast there: outside the US) */
export function nwsSource({ fetchJSON = defaultFetchJSON, now = () => Date.now() } = {}) {
  return { id: 'nws', name: 'US National Weather Service', credit: NWS_CREDIT,
    async forecast(lat, lon, { hourly = false, signal } = {}) {
      const t0 = now(), la = r2(lat), lo = r2(lon);
      const pt = await fetchJSON(`${NWS}points/${la},${lo}`, { signal }), P = pt && pt.properties;
      const fu = P && P.forecast, hu = P && P.forecastHourly, ok = (u) => typeof u === 'string' && u.startsWith(NWS);
      if (!ok(fu)) return { outside: true, ms: now() - t0 };
      const [fc, al, hr] = await Promise.all([fetchJSON(fu, { signal }), fetchJSON(`${NWS}alerts/active?point=${la},${lo}`, { signal }).catch(() => null),
        hourly && ok(hu) ? fetchJSON(hu, { signal }).catch(() => null) : null]);
      const per = ((fc && fc.properties && fc.properties.periods) || []).slice(0, 14).map((x) => ({ name: str(x.name, 30), start: str(x.startTime, 30), day: !!x.isDaytime,
        temp: +x.temperature, unit: str(x.temperatureUnit, 2), short: str(x.shortForecast, 80), wind: [str(x.windDirection, 4), str(x.windSpeed, 20)].filter(Boolean).join(' '),
        pop: x.probabilityOfPrecipitation && x.probabilityOfPrecipitation.value != null ? +x.probabilityOfPrecipitation.value : null }));
      if (!per.length) throw Object.assign(new Error('the weather service sent no forecast'), { code: 'WEATHER_EMPTY' });
      const loc = (P.relativeLocation && P.relativeLocation.properties) || {};
      return { source: 'nws', name: 'US National Weather Service', credit: NWS_CREDIT, place: str([loc.city, loc.state].filter(Boolean).join(', '), 60), periods: per,
        hourly: ((hr && hr.properties && hr.properties.periods) || []).slice(0, 3).map((x) => ({ start: str(x.startTime, 30), temp: +x.temperature, unit: str(x.temperatureUnit, 2), short: str(x.shortForecast, 60) })),
        alerts: ((al && al.features) || []).slice(0, 3).map((f) => { const x = f.properties || {}; return { event: str(x.event, 60), severity: str(x.severity, 20), headline: str(x.headline, 200), ends: str(x.ends || x.expires, 30) }; }),
        updated: str(fc.properties.updateTime || fc.properties.updated, 30), ms: Math.round(now() - t0) };
    } };
}
/** the weather sources behind one forecast(lat, lon, o): the first source that covers the point answers; each point's answer is kept
 *  ttlMs (30 min) -> { forecast(lat, lon, o) -> facts (+ cached) | { outside } , drop() } */
export function createWeather({ sources = null, ttlMs = 30 * 60e3, now = () => Date.now(), fetchJSON } = {}) {
  const src = sources || [nwsSource(fetchJSON ? { fetchJSON, now } : { now })], cache = new Map();
  return {
    sources: src,
    async forecast(lat, lon, o = {}) {
      const key = `${r2(lat)},${r2(lon)}`, c = cache.get(key), t = now();
      if (c && t - c.at < ttlMs && (!o.hourly || (c.v.hourly && c.v.hourly.length) || c.v.outside)) return Object.assign({}, c.v, { cached: true, ms: 0 });
      let v = { outside: true, ms: 0 };
      for (const s of src) { v = await s.forecast(lat, lon, o); if (!v.outside) break; }
      cache.set(key, { at: t, v }); for (const [k, x] of cache) if (t - x.at >= ttlMs) cache.delete(k);
      return Object.assign({}, v, { cached: false });
    },
    drop() { cache.clear(); },
  };
}
