// share.js - Settings › Share the app (1.0.2): the app's address as a QR code that a friend scans with their phone's camera, with Share
// and Copy. The code is share-qr.svg beside this file, made once for the public address by the release tools, which read the code back
// before writing it. No code is made on the phone and nothing is asked of any service.
//   shareInto(el, { url, toast })   url: config.js's publicUrl (https:// only; ww.js offers the page only when there is one)
'use strict';

const QR = new URL('./share-qr.svg', import.meta.url).href;
const mk = (t, c, x) => { const e = document.createElement(t); if (c) e.className = c; if (x != null) e.textContent = x; return e; };

export function shareInto(el, { url, toast = () => {} }) {
  el.append(mk('p', 'st-p', 'Show this to a friend. They point their phone\'s camera at the code and tap the link that appears: Wallowa Weather opens, ready to add to their Home Screen.'));
  const img = mk('img', 'ww-qr'); img.src = QR; img.alt = `QR code for ${url}`; img.width = 264; img.height = 264; img.decoding = 'async';
  el.append(img, mk('p', 'ww-qr-url', url.replace(/^https:\/\//, '').replace(/\/$/, '')));
  const row = mk('div', 'st-btns ww-qr-btns'), btn = (c, x) => { const b = mk('button', c, x); b.type = 'button'; return b; };
  if (navigator.share) {
    const s = btn('nc-btn', 'Share the link');
    s.addEventListener('click', () => navigator.share({ title: 'Wallowa Weather', text: 'Wallowa Weather: free storm forecasts for Wallowa County, worked out on your own phone.', url }).catch(() => {}));
    row.append(s);
  }
  const c = btn(navigator.share ? 'nc-btn ghost' : 'nc-btn', 'Copy the link');
  c.addEventListener('click', async () => { try { await navigator.clipboard.writeText(url); toast('Link copied.'); } catch (e) { toast('Copy did not work: the address is under the code.'); } });
  row.append(c); el.append(row);
  el.append(mk('p', 'st-note', 'The code holds only the app\'s address. Nothing about you or this phone is in it.'));
}
