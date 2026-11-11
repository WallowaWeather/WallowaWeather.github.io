// nowcast/post.js - Wallowa Weather v020: public posts (Josh, Nov-09-2026: "Share picture of the map in social media posts without GPS or
// location. In the event there are warnings those need to be able to be shared as well."). One post box for a field report, an NWS warning
// and the app's own warnings (BEAM, StormScope): the exact words and the picture shown first, then
//   Share words + picture  the phone's share sheet (X, Facebook, Messages, ...); the words are copied too, for apps that drop them
//   Post to X              X's post link carrying the words (a link can't carry a picture)
//   Post to Facebook       its share page takes no words from apps: they are copied, the page opened
// The picture never shows where the person is: no GPS dot, no place mark, no ring; its middle is snapped to a 0.2 degree grid (never the
// spot) and it shows a region at least (zoom 9 at most); a warning's picture frames the warning's own area.
'use strict';
export const X_MAX = 280;
/** X's post link with the words */
export const xPostUrl = (text) => `https://x.com/intent/tweet?text=${encodeURIComponent(text)}`;
/** Facebook's share link: it takes a web address only (never words) - the app's public one, else Facebook itself */
export const fbShareUrl = (url) => (url ? `https://www.facebook.com/sharer/sharer.php?u=${encodeURIComponent(url)}` : 'https://www.facebook.com/');
/** the app's public address (config.js publicUrl, set for a public release; never the address the app happens to be served from) */
export const publicUrl = () => { try { const u = globalThis.P0_CONFIG && globalThis.P0_CONFIG.publicUrl; return typeof u === 'string' && /^https:\/\//.test(u) ? u : ''; } catch (e) { return ''; } };

export const PICTURE_GRID = 0.2;   // degrees: the picture's middle snapped to this grid (about 22 x 16 km here)
export const PICTURE_ZOOM = 9;     // at most: a phone's picture spans about 100 km
const snap = (v) => Math.round(Math.round(v / PICTURE_GRID) * PICTURE_GRID * 1e9) / 1e9;
/** the view a public picture of a place is drawn at -> { lat, lon, z } */
export function pictureView(p, z) { return { lat: snap(p.lat), lon: snap(p.lon), z: Math.min(z, PICTURE_ZOOM) }; }
/** the view that frames a warning's rings ([[lon, lat], ...] each) on a screen of w x h CSS px -> { lat, lon, z } (zoom 6..10) */
export function ringsView(rings, { w = 390, h = 844 } = {}) {
  let n = -90, s = 90, e = -180, wl = 180;
  for (const r of rings || []) for (const [lo, la] of r) { if (la > n) n = la; if (la < s) s = la; if (lo > e) e = lo; if (lo < wl) wl = lo; }
  if (!(n > s && e > wl)) return { lat: 45.5, lon: -117.5, z: 8 };
  const merc = (la) => Math.log(Math.tan(Math.PI / 4 + (la * Math.PI) / 360));
  const fx = (w * 0.7) / 256 / ((e - wl) / 360), fy = (h * 0.5) / 256 / ((merc(n) - merc(s)) / (2 * Math.PI));
  const z = Math.max(6, Math.min(10, Math.log2(Math.min(fx, fy))));
  return { lat: (n + s) / 2, lon: (e + wl) / 2, z: Math.round(z * 10) / 10 };
}
const clockOf = (iso) => { const t = Date.parse(iso || ''); if (!isFinite(t)) return ''; try { return new Date(t).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZoneName: 'short' }); } catch (e) { return ''; } };
const fit = (head, mid, tail, max = X_MAX) => { const room = max - head.length - tail.length; let m = mid || ''; if (m.length > room) m = room > 12 ? m.slice(0, room - 1).replace(/\s+\S*$/, '') + '…' : ''; return head + m + tail; };
/** an NWS warning's public words: what, until when, the areas, whose (the National Weather Service), the app's tag */
export function nwsWords(a) {
  const until = clockOf(a.ends);
  const head = `${a.event || 'NWS alert'}${until ? ` until ${until}` : ''}`;
  return fit(head, a.area ? ` · ${a.area}` : '', ' · from the National Weather Service · #WallowaWeather');
}
/** the app's own warning (BEAM, StormScope) in public words: what and where its area is - never the person's own place ("here"), never
 *  coordinates - and that it is experimental, not an official warning */
export function appWarningWords({ label = '', what = '', where = '' } = {}) {
  const clean = (t) => String(t || '').replace(/\s*Here:[^.]*\.?/g, '').replace(/[-+]?\b\d{1,3}\.\d{2,}\b/g, '').replace(/\s{2,}/g, ' ').trim();
  return fit(label, [clean(what), clean(where)].filter(Boolean).map((t) => ` · ${t}`).join(''), ' · Experimental, not an official warning · #WallowaWeather');
}

/** a map picture for a public post (shot = map.snapshotAt()): the map with a caption under it - no ring, no mark of any place -> a PNG
 *  File, or null (no canvas; a map from another site's tiles could not be read) */
export async function publicPicture(shot, { title = '', sub = 'Wallowa Weather · Experimental, not an official report', name = 'wallowa-weather' } = {}) {
  const canvas = shot && shot.canvas;
  if (!canvas || !canvas.width || !canvas.height || typeof document === 'undefined') return null;
  const k = Math.min(1, 1280 / Math.max(canvas.width, canvas.height)), W = Math.round(canvas.width * k), H0 = Math.round(canvas.height * k), cap = Math.round(Math.max(44, W * 0.075));
  const c = Object.assign(document.createElement('canvas'), { width: W, height: H0 + cap }), g = c.getContext('2d');
  g.fillStyle = '#0B1620'; g.fillRect(0, 0, W, H0 + cap); g.drawImage(canvas, 0, 0, W, H0);
  const fs = Math.round(cap * 0.32); g.textBaseline = 'middle';
  g.fillStyle = '#F5F5F7'; g.font = `600 ${fs}px system-ui, sans-serif`; g.fillText(title, Math.round(cap * 0.3), H0 + cap * 0.32, W - cap * 0.6);
  g.fillStyle = 'rgba(235,235,245,0.75)'; g.font = `400 ${Math.round(fs * 0.85)}px system-ui, sans-serif`; g.fillText(sub, Math.round(cap * 0.3), H0 + cap * 0.7, W - cap * 0.6);
  const blob = await new Promise((res) => { try { c.toBlob((b) => res(b), 'image/png'); } catch (e) { res(null); } });
  if (!blob) return null;
  try { return new File([blob], `${name}.png`, { type: 'image/png' }); } catch (e) { return null; }
}

/** the post box -> { el, ready, update() }. o: doc, words() -> the exact words, picture() -> Promise<File | null>, nav (navigator), open(url),
 *  toast(text), makeUrl(file) (URL.createObjectURL), title, note (the footnote), onPosted(how) */
export function postBox(o) {
  const doc = o.doc || globalThis.document, nav = o.nav || globalThis.navigator || {}, toast = o.toast || (() => {});
  const open = o.open || ((u) => { try { globalThis.open(u, '_blank', 'noopener,noreferrer'); } catch (e) { /* the page stays */ } });
  const makeUrl = o.makeUrl || ((f) => { try { return URL.createObjectURL(f); } catch (e) { return ''; } });
  const mk = (tag, cls, text) => { const e = doc.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  const btn = (cls, text) => { const b = mk('button', cls, text); b.type = 'button'; return b; };
  const el = mk('div', 'nc-post'), words = mk('p', 'nc-post-words'), pic = mk('div', 'nc-post-picbox'), picNote = mk('p', 'footnote nc-post-picnote', 'Making the picture…');
  const share = btn('nc-btn nc-post-share', 'Share words + picture'), xA = mk('a', 'nc-btn ghost nc-post-x', 'Post to X'), fb = btn('nc-btn ghost nc-post-fb', 'Post to Facebook');
  xA.setAttribute('target', '_blank'); xA.setAttribute('rel', 'noopener noreferrer');
  const row = mk('div', 'nc-post-btns'); row.append(xA, fb);
  el.append(mk('p', 'nc-sub', o.title || 'Post it publicly'), words, pic, picNote, share, row,
    mk('p', 'footnote', o.note || 'Anyone can read a public post. The picture has no GPS dot and no place mark, and shows the area around, not your spot. Facebook takes no words from apps: they are copied for you to paste.'));
  let file = null, text = '';
  const canFiles = (f) => { try { return !!(f && nav.canShare && nav.canShare({ files: [f] })); } catch (e) { return false; } };
  let enabled = true;
  function update() {
    text = String(o.words() || ''); words.textContent = text; xA.setAttribute('href', xPostUrl(text));
    share.hidden = !(nav.share && canFiles(file)); share.disabled = fb.disabled = !enabled; xA.classList.toggle('off', !enabled); xA.setAttribute('aria-disabled', String(!enabled));
  }
  update();
  // the picture, made (and made again when the place moves): the newest one asked for wins (an older one finishing later is dropped);
  // the preview's blob address is let go once the picture has loaded (the File itself stays for the share)
  let seq = 0, last = null;
  async function picture() {
    const my = ++seq; let f = null;
    try { f = await o.picture(); } catch (e) { f = null; }
    if (my !== seq) return;
    file = f; pic.textContent = '';
    if (f) {
      const u = makeUrl(f), im = mk('img', 'nc-post-pic'); im.setAttribute('alt', 'The map picture that goes with the post');
      if (im.addEventListener && /^blob:/.test(u)) im.addEventListener('load', () => { try { URL.revokeObjectURL(u); } catch (e) { /* */ } }, { once: true });
      im.setAttribute('src', u); pic.append(im); picNote.textContent = ''; picNote.hidden = true;
    } else { picNote.hidden = false; picNote.textContent = 'No picture here (the map could not be drawn): the words go alone.'; }
    update();
  }
  const repicture = () => (last = picture());
  repicture();
  const copy = () => { try { return nav.clipboard ? nav.clipboard.writeText(text) : null; } catch (e) { return null; } };
  share.addEventListener('click', () => {
    update(); const c = copy();   // copied first, in the same tap (the clipboard wants the tap), for apps that keep only the picture
    let p = null; try { p = nav.share({ text, files: [file] }); } catch (e) { p = Promise.reject(e); }
    Promise.resolve(p).then(() => { if (o.onPosted) o.onPosted('share'); }, (e) => { if (e && e.name === 'AbortError') return; Promise.resolve(c).then(() => toast('Sharing did not open: the words are copied.'), () => {}); });
  });
  xA.addEventListener('click', (e) => { if (!enabled) { if (e && e.preventDefault) e.preventDefault(); return; } update(); if (o.onPosted) o.onPosted('x'); });
  fb.addEventListener('click', () => {
    update(); const c = copy(); open(fbShareUrl(o.url != null ? o.url : publicUrl()));
    if (o.onPosted) o.onPosted('facebook');
    Promise.resolve(c).then((v) => toast(c ? 'The words are copied: paste them into your Facebook post.' : 'Copy the words above into your Facebook post.'), () => toast('Copy the words above into your Facebook post.'));
  });
  // ready: the newest picture's promise; repicture(): a new picture (the place moved)
  return { el, get ready() { return last; }, update, repicture, setEnabled(on) { enabled = !!on; update(); } };
}
