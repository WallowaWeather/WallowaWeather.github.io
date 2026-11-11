// pin.js - Wallowa Weather: a model pack's manifest.json is checked against the sha256 that config.js carries for that pack
// (P0_CONFIG.manifestSha256, next to the pack's address) BEFORE it is used or kept. The manifest lists the sha256 of every chunk the
// phone downloads, so a pinned manifest pins every byte of the pack. A manifest that does not match is never used or stored: a phone
// that already has the pack keeps its own copy, a phone that does not gets a plain error.
'use strict';

const hex = (ab) => Array.from(new Uint8Array(ab), (b) => b.toString(16).padStart(2, '0')).join('');
const abs = (u) => { try { return new URL(u, globalThis.location ? globalThis.location.href : undefined).href; } catch (e) { return String(u); } };
const dir = (u) => String(u).replace(/\/?$/, '/');

/** the pin for the pack at `base`: undefined = no table at all (engine tests outside the app: not checked); null = a pack config.js
 *  does not list (refused); else {key, sha256}. A key 'pack/sub/' pins <pack address>sub/manifest.json (DGMR's float model, f16/). */
export function manifestPin(base) {
  const C = globalThis.P0_CONFIG;
  if (!C || !C.manifestSha256) return undefined;
  const want = abs(dir(base));
  for (const k of Object.keys(C.manifestSha256)) {
    const i = k.indexOf('/'), key = i > 0 ? k.slice(0, i) : k, sub = i > 0 ? k.slice(i + 1) : '';
    const u = C.packs && C.packs[key];
    if (u && abs(dir(u) + sub) === want) return { key: k, sha256: String(C.manifestSha256[k] || '').toLowerCase() };
  }
  return null;
}

/** Josh, v018: "only check for model updates if the app has changed" - a model list kept on the phone whose bytes match this version's
 *  pin is exactly what the server holds (a pinned list cannot change), so it is used without asking; a new version of the app brings new
 *  pins and the list is asked for once. -> the list, or null (no pin, a pin it does not match, or bytes that are not a list) */
export async function pinnedCopy(base, bytes, pin = manifestPin(base)) {
  if (!pin || !pin.sha256 || !bytes || !(globalThis.crypto && crypto.subtle)) return null;
  try {
    if (hex(await crypto.subtle.digest('SHA-256', bytes)) !== String(pin.sha256).toLowerCase()) return null;
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch (e) { return null; }
}

/** fetch <base>manifest.json and check it: {ab, m, key} when it may be used and kept (ab = the exact bytes, to store as they are);
 *  {bad, key} when it must not be; null when it cannot be reached (offline, HTTP error). opts: fetch options; fetchFn: tests. */
export async function fetchManifest(base, opts = {}, fetchFn = null) {
  const pin = manifestPin(base), key = pin ? pin.key : null;
  let ab;
  try {
    const r = await (fetchFn || fetch)(dir(base) + 'manifest.json', Object.assign({ cache: 'no-cache' }, opts));
    if (!r.ok) return null;
    ab = await r.arrayBuffer();
  } catch (e) { if (e && e.name === 'AbortError') throw e; return null; }
  if (pin === null) return { bad: 'this model pack is not one this version of the app knows', key };
  if (pin) {
    if (!(globalThis.crypto && crypto.subtle)) return { bad: 'this browser cannot check the model list', key };
    if (hex(await crypto.subtle.digest('SHA-256', ab)) !== pin.sha256) return { bad: 'the model list on the server does not match this version of the app', key };
  }
  let m;
  try { m = JSON.parse(new TextDecoder().decode(ab)); } catch (e) { return { bad: 'the model list is not readable', key }; }
  return { ab, m, key };
}

/** a refused manifest: a 'wallowa-weather:manifest' event (for a Diagnostics row); the phone's own copy, if any, stays in use */
export function manifestRefused(got, kept) {
  try { globalThis.dispatchEvent(new CustomEvent('wallowa-weather:manifest', { detail: { pack: got.key || null, reason: got.bad, kept: !!kept } })); } catch (e) { /* no window */ }
}
