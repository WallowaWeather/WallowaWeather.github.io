// places.js - Wallowa Weather's place search: US places and ZIP codes -> coordinates, on the phone, with no geocoder online. Two tables
// made from the US Census Bureau 2025 Gazetteer files (public domain), read once (the map's place names and search):
//   places/data/places_us.txt.gz     32,132 city / town names with their state and size (245 KB)
//   places/data/zcta_us.bin.gz       33,791 ZIP codes (ZCTAs) with their centre (86 KB)
// Coordinates are kept to 0.01 degree (about 1 km): all a forecast needs, and all that ever goes to a weather source.

export const STATES = { AL: 'Alabama', AK: 'Alaska', AZ: 'Arizona', AR: 'Arkansas', CA: 'California', CO: 'Colorado', CT: 'Connecticut', DE: 'Delaware',
  DC: 'District of Columbia', FL: 'Florida', GA: 'Georgia', HI: 'Hawaii', ID: 'Idaho', IL: 'Illinois', IN: 'Indiana', IA: 'Iowa', KS: 'Kansas',
  KY: 'Kentucky', LA: 'Louisiana', ME: 'Maine', MD: 'Maryland', MA: 'Massachusetts', MI: 'Michigan', MN: 'Minnesota', MS: 'Mississippi',
  MO: 'Missouri', MT: 'Montana', NE: 'Nebraska', NV: 'Nevada', NH: 'New Hampshire', NJ: 'New Jersey', NM: 'New Mexico', NY: 'New York',
  NC: 'North Carolina', ND: 'North Dakota', OH: 'Ohio', OK: 'Oklahoma', OR: 'Oregon', PA: 'Pennsylvania', RI: 'Rhode Island', SC: 'South Carolina',
  SD: 'South Dakota', TN: 'Tennessee', TX: 'Texas', UT: 'Utah', VT: 'Vermont', VA: 'Virginia', WA: 'Washington', WV: 'West Virginia',
  WI: 'Wisconsin', WY: 'Wyoming', PR: 'Puerto Rico' };
/** a place name as the tables compare it: lower case, no accents or dots, "Saint" = "St", "Mount" = "Mt", "Fort" = "Ft" */
export const normName = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[.'’]/g, '')
  .replace(/\bsaint\b/g, 'st').replace(/\bmount\b/g, 'mt').replace(/\bfort\b/g, 'ft').replace(/[^a-z0-9]+/g, ' ').trim();
/** a state by its name or its USPS code -> the code, or null */
export function stateOf(s) {
  const t = normName(s); if (!t) return null;
  if (t.length === 2 && STATES[t.toUpperCase()]) return t.toUpperCase();
  for (const [k, v] of Object.entries(STATES)) if (normName(v) === t) return k;
  return t === 'washington dc' || t === 'dc' ? 'DC' : null;
}

/** places_us.txt -> Map(normName -> [{ name, st, lat, lon, w }]) (w = its people in thousands; a census-designated place: its land km2) */
export function parsePlaces(text) {
  const map = new Map(); let st = null, a = 0, b = 0;
  for (const line of String(text).split('\n')) {
    if (!line || line[0] === '#') continue;
    if (line[0] === '@') { st = line.slice(1).trim(); a = b = 0; continue; }
    const f = line.split('\t'); if (f.length < 4) continue;
    a += +f[1]; b += +f[2];
    const e = { name: f[0], st, lat: a / 100, lon: b / 100, w: +f[3] }, k = normName(f[0]), l = map.get(k);
    if (l) l.push(e); else map.set(k, [e]);
  }
  return map;
}
/** zcta_us.bin -> { count, find(zip) -> { zip, lat, lon } | null } (a binary search over the sorted ZIPs) */
export function parseZcta(u8) {
  if (!(u8 && u8.length > 8 && u8[0] === 0x5a && u8[1] === 0x43 && u8[2] === 0x31)) throw new Error('not a ZIP table');
  const n = new DataView(u8.buffer, u8.byteOffset, u8.byteLength).getUint32(4, true), zips = new Uint32Array(n), lat = new Int16Array(n), lon = new Int16Array(n);
  let p = 8;
  const rd = () => { let v = 0, s = 0, x; do { x = u8[p++]; v += (x & 0x7f) * 2 ** s; s += 7; } while (x & 0x80); return v; };
  const zz = (v) => (v % 2 ? -(v + 1) / 2 : v / 2);
  for (let i = 0, z = 0, la = 0, lo = 0; i < n; i++) { z += rd(); la += zz(rd()); lo += zz(rd()); zips[i] = z; lat[i] = la; lon[i] = lo; }
  return { count: n, find(zip) {
    const q = parseInt(zip, 10); if (!(q >= 0)) return null;
    let a = 0, b = n - 1;
    while (a <= b) { const m = (a + b) >> 1; if (zips[m] === q) return { zip: String(q).padStart(5, '0'), lat: lat[m] / 100, lon: lon[m] / 100 }; if (zips[m] < q) a = m + 1; else b = m - 1; }
    return null;
  } };
}
/** "Moab, UT" / "Portland Oregon" / "Austin TX" / "Seattle" -> { city, st } (st: a state named after a comma, by its name, or by its
 *  USPS code in capitals) */
export function splitCityState(raw) {
  const s = String(raw || '').trim(), parts = s.split(/\s*,\s*/);
  if (parts.length > 1) { const st = stateOf(parts[parts.length - 1]); if (st) return { city: parts.slice(0, -1).join(' '), st }; }
  const w = s.replace(/,/g, ' ').split(/\s+/).filter(Boolean);
  for (let k = Math.min(3, w.length - 1); k >= 1; k--) {
    const tail = w.slice(-k).join(' '), st = stateOf(tail);
    if (st && (tail.length > 2 || /^[A-Z]{2}$/.test(tail))) return { city: w.slice(0, -k).join(' '), st };
  }
  return { city: s.replace(/,/g, ''), st: null };
}
/** the place in the list nearest to a point (a ZIP code's name) */
export function nearestPlace(geo, lat, lon) {
  const c = Math.cos(lat * Math.PI / 180); let best = null, bd = Infinity;
  for (const l of geo.places.values()) for (const e of l) { const d = (e.lat - lat) ** 2 + ((e.lon - lon) * c) ** 2; if (d < bd || (d === bd && e.w > best.w)) { bd = d; best = e; } }
  return best;
}
/** a place search on this phone: "Moab", "Moab, UT", "Portland Oregon", "10001" -> up to n
 *  [{ name, region, st, lat, lon, zip? }], the biggest first; outside the US, or not in the list: [] */
export function searchPlaces(geo, q, n = 5) {
  const s = String(q || '').trim(), z = /^(\d{5})(?:-\d{4})?$/.exec(s);
  if (z) {
    const c = geo.zcta.find(z[1]); if (!c) return [];
    const near = nearestPlace(geo, c.lat, c.lon);
    return [{ name: near ? `${near.name} (${c.zip})` : c.zip, region: near ? STATES[near.st] || near.st : '', st: near ? near.st : '', lat: c.lat, lon: c.lon, zip: c.zip }];
  }
  const { city, st } = splitCityState(s);
  let l = geo.places.get(normName(city)) || []; if (st) l = l.filter((e) => e.st === st);
  return l.slice().sort((a, b) => b.w - a.w).slice(0, n).map((e) => ({ name: e.name, region: STATES[e.st] || e.st, st: e.st, lat: e.lat, lon: e.lon }));
}
const isGz = (u8) => u8.length > 2 && u8[0] === 0x1f && u8[1] === 0x8b;
async function gunzip(u8) {
  if (!isGz(u8)) return u8;   // a server that sent it with Content-Encoding: the browser already unpacked it
  return new Uint8Array(await new Response(new Blob([u8]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer());
}
let GEO = null;
/** the two tables, read once (when the map first needs its place names) -> Promise<{ places, zcta }>. fetchBytes(url) -> Uint8Array (tests) */
export function loadGeo({ base = new URL('./data/', import.meta.url), fetchBytes = null } = {}) {
  if (GEO) return GEO;
  const get = fetchBytes || (async (u) => { const r = await fetch(u); if (!r.ok) throw Object.assign(new Error('the place list could not be read (' + r.status + ')'), { code: 'GEO_READ' }); return gunzip(new Uint8Array(await r.arrayBuffer())); });
  GEO = Promise.all([get(new URL('places_us.txt.gz', base)), get(new URL('zcta_us.bin.gz', base))])
    .then(([p, z]) => ({ places: parsePlaces(new TextDecoder().decode(p)), zcta: parseZcta(z) }));
  GEO.catch(() => { GEO = null; });
  return GEO;
}
