// nowcast/mrms.js - NOAA MRMS radar frames from NOAA's public bucket on AWS (public domain; the bucket answers list and GET requests
// with Access-Control-Allow-Origin: *). Which frames exist, which ones a nowcast needs, which ones the radar loop shows. Only the
// bucket's own addresses are requested; nothing about the person or the place is sent (every phone downloads the same CONUS files).
// Pure except fetchFrame / listFrames (network).

export const BUCKET = 'https://noaa-mrms-pds.s3.amazonaws.com/';
/** the two products the Nowcast reads: rain rate (mm/h, 16-bit) and precipitation type (rain, snow, ...; 8-bit) */
export const PRODUCTS = {
  rate: { prefix: 'CONUS/PrecipRate_00.00/', file: 'MRMS_PrecipRate_00.00_', what: 'rain rate' },
  flag: { prefix: 'CONUS/PrecipFlag_00.00/', file: 'MRMS_PrecipFlag_00.00_', what: 'precipitation type' },
  rqi: { prefix: 'CONUS/RadarQualityIndex_00.00/', file: 'MRMS_RadarQualityIndex_00.00_', what: 'radar quality (0..1)' },
};
/** MRMS PrecipFlag values (after the GRIB scaling): what each one is */
export const FLAG = { NONE: 0, WARM_STRAT: 1, SNOW: 3, CONVECTIVE: 6, HAIL: 7, COLD_STRAT: 10, TROP_STRAT: 91, TROP_CONV: 96, NO_COVERAGE: -3 };
export const CADENCE_MIN = 2;

const pad = (v, n = 2) => String(v).padStart(n, '0');
const ymd = (t) => { const d = new Date(t); return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}`; };
const hms = (t) => { const d = new Date(t); return `${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`; };
export const MIN = 60e3;
/** the frame's key in the bucket */
export const keyOf = (p, t) => `${PRODUCTS[p].prefix}${ymd(t)}/${PRODUCTS[p].file}${ymd(t)}-${hms(t)}.grib2.gz`;
export const urlOf = (p, t) => BUCKET + keyOf(p, t);
/** a key -> its valid time (ms, UTC), or null */
export function timeOfKey(key) {
  const m = /_(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})\.grib2\.gz$/.exec(String(key || ''));
  return m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) : null;
}
/** the bucket's list answer (ListObjectsV2 XML) -> [{ key, t, size }] sorted by time, and whether it was cut short */
export function parseListing(xml) {
  const out = [], s = String(xml || ''), re = /<Contents>([\s\S]*?)<\/Contents>/g; let m;
  while ((m = re.exec(s))) {
    const k = /<Key>([^<]+)<\/Key>/.exec(m[1]), z = /<Size>(\d+)<\/Size>/.exec(m[1]), t = k ? timeOfKey(k[1]) : null;
    if (k && t != null) out.push({ key: k[1], t, size: z ? +z[1] : 0 });
  }
  out.sort((a, b) => a.t - b.t);
  return { frames: out, truncated: /<IsTruncated>true<\/IsTruncated>/.test(s) };
}
/** the list request(s) for a product's frames from `since` to `until` (one per UTC day touched) */
export function listUrls(p, since, until) {
  const urls = [];
  for (let d = Date.UTC(new Date(since).getUTCFullYear(), new Date(since).getUTCMonth(), new Date(since).getUTCDate()); d <= until; d += 864e5) {
    const pre = `${PRODUCTS[p].prefix}${ymd(d)}/`, after = d < since ? `${pre}${PRODUCTS[p].file}${ymd(since)}-${hms(since - 1000)}` : '';
    urls.push(`${BUCKET}?list-type=2&prefix=${encodeURIComponent(pre)}${after ? `&start-after=${encodeURIComponent(after)}` : ''}`);
  }
  return urls;
}
/** the product's frames from `since` to `until` (ms) -> [{ key, t, size }] */
export async function listFrames(p, since, until, { fetchFn = fetch, signal } = {}) {
  const all = [];
  for (const u of listUrls(p, since, until)) {
    const r = await fetchFn(u, { signal, cache: 'no-store' });
    if (!r.ok) throw Object.assign(new Error('the NOAA radar list answered ' + r.status), { code: 'RADAR_HTTP' });
    for (const f of parseListing(await r.text()).frames) if (f.t >= since && f.t <= until) all.push(f);
  }
  return all.sort((a, b) => a.t - b.t);
}
/** one frame's bytes (gzipped GRIB2) */
export async function fetchFrame(p, t, { fetchFn = fetch, signal } = {}) {
  const r = await fetchFn(urlOf(p, t), { signal });
  if (!r.ok) throw Object.assign(new Error(`a NOAA radar frame answered ${r.status}`), { code: r.status === 404 ? 'RADAR_MISSING' : 'RADAR_HTTP' });
  return new Uint8Array(await r.arrayBuffer());
}

// ---------------------------------------------------------------------------------------------------------- which frames
const minuteOf = (t) => Math.round(t / MIN);   // MRMS stamps are on the minute (a few products add a second or two)
/** the frames that stand for each input time of a model (inputs at `offsets` minutes from t0; on a 2-minute radar an odd minute is
 *  the mean of the frames one minute either side) -> [[t, ...] per offset] */
export function inputFrames(t0, offsets, cadence = CADENCE_MIN) {
  return offsets.map((m) => { const t = t0 + m * MIN; return minuteOf(t) % cadence === 0 ? [t] : [t - MIN, t + MIN]; });
}
/** the newest t0 whose input frames are all in `have` (times, ms), at most `maxAgeMin` old at `now` ->
 *  { t0, frames: [[t...]...], ageMin } | { stale: true, newest, ageMin } | { none: true } */
export function pickT0(have, offsets, now, { maxAgeMin = 15, cadence = CADENCE_MIN } = {}) {
  const set = new Set(have.map(minuteOf)); if (!set.size) return { none: true };
  const newest = Math.max(...have);
  for (let m = Math.floor(minuteOf(newest) / cadence) * cadence; m * MIN >= now - maxAgeMin * MIN; m -= cadence) {
    const t0 = m * MIN, fr = inputFrames(t0, offsets, cadence);
    if (fr.every((l) => l.every((t) => set.has(minuteOf(t))))) return { t0, frames: fr, ageMin: (now - t0) / MIN };
  }
  return { stale: true, newest, ageMin: (now - newest) / MIN };
}
/** the radar loop's frames: every `step` minutes back from the newest frame for `minutes`, each the frame nearest that time (within a
 *  cadence step) -> [t] oldest first */
export function loopFrames(have, { minutes = 60, step = 10, newest = null } = {}) {
  if (!have.length) return [];
  const sorted = have.slice().sort((a, b) => a - b), top = newest != null ? newest : sorted[sorted.length - 1], out = [];
  for (let m = 0; m <= minutes; m += step) {
    const want = top - m * MIN; let best = null;
    for (const t of sorted) if (Math.abs(t - want) <= CADENCE_MIN * MIN && (best == null || Math.abs(t - want) < Math.abs(best - want))) best = t;
    if (best != null && !out.includes(best)) out.push(best);
  }
  return out.sort((a, b) => a - b);
}
