// install.js - Wallowa Weather's "choose your own adventure" install guide: it works out which device and browser this
// is (by feature first, the user agent only to pick the right words), checks that the forecast can run here (WebGPU), and shows the
// steps that fit: add to the Home Screen, add to the Dock, install the app, or just use the website. Platform facts: research Nov-04-2026
// (gpuweb implementation status, WebKit Safari 26 notes, Chrome / Mozilla help pages).
'use strict';

export const isInstalled = () => { try { return matchMedia('(display-mode: standalone)').matches || navigator.standalone === true; } catch (e) { return false; } };
let deferred = null;   // Chrome / Edge / Samsung Internet: their own install prompt, kept for our button
let justInstalled = false;   // Chrome said the app went in (this tab itself stays a browser tab)
const redraw = new Map();   // Android: Chrome can offer its prompt late (after the page has been used a little): an open guide draws again
addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); deferred = e; for (const f of [...redraw.values()]) f(); });
addEventListener('appinstalled', () => { deferred = null; justInstalled = true; for (const f of [...redraw.values()]) f(); });

/** what this device is, in the guide's own terms */
export function deviceOf() {
  const ua = navigator.userAgent || '', touchMac = /Macintosh/.test(ua) && navigator.maxTouchPoints > 1;
  const ios = /iPhone|iPad|iPod/.test(ua) || touchMac, android = /Android/.test(ua), mac = /Macintosh/.test(ua) && !touchMac;
  const win = /Windows/.test(ua), cros = /CrOS/.test(ua), linux = /Linux/.test(ua) && !android && !cros;
  const browser = /EdgiOS|Edg\//.test(ua) ? 'edge' : /CriOS|Chrome\//.test(ua) && !/SamsungBrowser/.test(ua) ? 'chrome' : /FxiOS|Firefox\//.test(ua) ? 'firefox'
    : /SamsungBrowser/.test(ua) ? 'samsung' : /Safari\//.test(ua) ? 'safari' : 'other';
  return { os: ios ? 'ios' : android ? 'android' : mac ? 'mac' : win ? 'windows' : cros ? 'chromeos' : linux ? 'linux' : 'other', browser, ipad: /iPad/.test(ua) || touchMac };
}
/** can the forecast run here? -> { ok, f16, why } (an adapter must actually come back: "has navigator.gpu" is not enough on some phones) */
export async function forecastHere() {
  try {
    if (!navigator.gpu) return { ok: false, why: 'no-webgpu' };
    const ad = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
    if (!ad) return { ok: false, why: 'no-adapter' };
    return { ok: ad.limits.maxStorageBufferBindingSize >= 96 * 1048576, f16: ad.features.has('shader-f16'), why: ad.limits.maxStorageBufferBindingSize >= 96 * 1048576 ? '' : 'limits' };
  } catch (e) { return { ok: false, why: 'error' }; }
}
/** the steps for this device -> { title, steps: [string], button?: { label, run }, note? } */
export function stepsFor(d, cap) {
  const name = d.ipad ? 'iPad' : 'iPhone';
  if (isInstalled()) return { title: 'Wallowa Weather is installed', steps: ['You opened it from its icon. Nothing more to do.'] };
  if (justInstalled) return { title: 'Wallowa Weather is installed', steps: ['Open it from its new icon on your home screen.'] };
  if (deferred) return { title: 'Install Wallowa Weather', steps: ['Tap Install. It gets its own icon and window, and opens straight to the forecast.'], button: { label: 'Install', run: async () => { deferred.prompt(); try { await deferred.userChoice; } catch (e) { /* */ } deferred = null; } } };
  if (d.os === 'ios') {
    if (!cap.ok) return { title: `Update your ${name}`, steps: [`The on-${name} forecast needs iOS 26 or later (Settings › General › Software Update).`, 'Until then, the NWS forecast and the radar work here.'] };
    if (d.browser === 'chrome') return { title: `Add to your ${name}'s Home Screen`, steps: ['Tap the Share button in the address bar.', 'Tap Add to Home Screen, then Add.'] };
    if (d.browser === 'firefox' || d.browser === 'edge') return { title: 'Open in Safari to install', steps: ['Copy this page\'s address, open it in Safari, then follow the Safari steps.'] };
    return { title: `Add to your ${name}'s Home Screen`, steps: ['Tap ⋯ (bottom right), then Share.', 'Tap Add to Home Screen.', 'Leave "Open as Web App" on, then tap Add.'],
      note: `Install first, then download the forecast model from the installed app: the ${name} keeps the Home Screen app's storage separate from Safari's.` };
  }
  if (d.os === 'android') {
    // Android: the installed app and the browser share this site's storage (unlike the iPhone), so a model downloaded in either is in both
    const why = cap.ok ? 'A forecast model downloaded here is in the installed app too.' : cap.why === 'no-webgpu'
      ? 'The on-phone forecast needs WebGPU: Chrome 121 or later on Android 12 or later (update Chrome in the Play Store). The NWS forecast and the radar work here now.'
      : 'Chrome on this phone can\'t run the forecast on its graphics chip yet; the NWS forecast and the radar still work.';
    if (d.browser === 'firefox' && !cap.ok) return { title: 'Use Chrome for the forecast', steps: ['Firefox on Android can\'t run the on-phone forecast here.', 'Open this page in Chrome to install the app.'] };
    if (d.browser === 'samsung') return { title: 'Install Wallowa Weather', steps: ['Tap the install icon in the address bar, or ≡ › Add page to › Home screen.'], note: cap.ok ? '' : 'This phone\'s graphics chip doesn\'t run the forecast; the NWS forecast and the radar still work.' };
    if (d.browser === 'firefox') return { title: 'Install Wallowa Weather', steps: ['Tap ⋮ (next to the address bar).', 'Tap Add app to Home screen (or Install), then Add.'], note: why };
    return { title: 'Install Wallowa Weather', steps: ['Tap ⋮ (next to the address bar; at the bottom if you moved it there).', 'Tap Add to home screen (or Install app).', 'Choose Install (not Create shortcut), then confirm.'], note: why };
  }
  if (d.os === 'mac') {
    if (d.browser === 'safari') return { title: 'Add Wallowa Weather to your Dock', steps: ['In the menu bar choose File › Add to Dock.', 'Click Add.'], note: cap.ok ? '' : 'The forecast needs macOS 26 (Tahoe) or later in Safari, or Chrome.' };
    if (d.browser === 'firefox') return { title: 'Use it here, or install from Safari or Chrome', steps: ['Firefox can run the site in a tab but can\'t install it as an app.', 'For an app with its own icon, open this page in Safari (File › Add to Dock) or Chrome.'] };
    return chromeDesktop(d);
  }
  if (d.os === 'windows') {
    if (d.browser === 'firefox') return { title: 'Pin Wallowa Weather', steps: ['Click the web-apps button at the right of the address bar to pin it to the taskbar (Firefox 143 or later).'] };
    return chromeDesktop(d);
  }
  if (d.os === 'chromeos') return { title: 'Install Wallowa Weather', steps: ['Click the install icon in the address bar, or ⋮ › Cast, save, and share › Install page as app.'] };
  if (d.os === 'linux') return d.browser === 'firefox' ? { title: 'Use Chrome for the forecast', steps: ['Firefox on Linux has no WebGPU yet. Open this page in Chrome.'] }
    : { title: 'Install Wallowa Weather', steps: ['⋮ › Cast, save, and share › Install page as app.'], note: cap.ok ? '' : 'Chrome on Linux runs WebGPU on recent Intel and NVIDIA graphics only; the NWS forecast and the radar still work.' };
  return { title: 'Use Wallowa Weather in this browser', steps: ['Bookmark this page. For the on-device forecast use a recent Safari, Chrome or Edge.'] };
}
function chromeDesktop(d) {
  return d.browser === 'edge' ? { title: 'Install Wallowa Weather', steps: ['Click ⋯ (top right) › Apps › Install this site as an app.'] }
    : { title: 'Install Wallowa Weather', steps: ['Click the install icon at the right of the address bar,', 'or ⋮ › Cast, save, and share › Install page as app.'] };
}
/** the guide as DOM (the shell puts it in its sheet) */
export async function renderGuide(box, { onDone } = {}) {
  const d = deviceOf(), cap = await forecastHere(), g = stepsFor(d, cap), mk = (t, c, x) => { const e = document.createElement(t); if (c) e.className = c; if (x != null) e.textContent = x; return e; };
  box.textContent = '';
  box.append(mk('h2', 'ww-h', g.title));
  const ol = mk('ol', 'ww-steps'); for (const s of g.steps) ol.append(mk('li', null, s)); box.append(ol);
  if (g.note) box.append(mk('p', 'footnote', g.note));
  box.append(mk('p', 'footnote dim', cap.ok ? 'This device can run the 90-minute forecast itself.' : 'This device can\'t run the on-device forecast; the NWS forecast, warnings and radar all work.'));
  const row = mk('div', 'ww-row');
  if (g.button) { const b = mk('button', 'btn', g.button.label); b.type = 'button'; b.onclick = async () => { await g.button.run(); if (onDone) onDone(); }; row.append(b); }
  const web = mk('button', 'btn ghost', isInstalled() ? 'Done' : 'Use it in the browser'); web.type = 'button'; web.onclick = () => onDone && onDone(); row.append(web);
  box.append(row);
  // Chrome's prompt (or the install itself) after this was drawn: draw it again while it is on the screen
  const again = () => { redraw.delete(box); if (box.isConnected) renderGuide(box, { onDone }); };
  if (isInstalled() || justInstalled) redraw.delete(box); else redraw.set(box, again);
  return { device: d, cap };
}
