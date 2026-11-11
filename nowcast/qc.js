// nowcast/qc.js - radar quality checks: isolated speckle (a few 1 km pixels far stronger than everything around them: in steady rain
// over mountains usually ground clutter or the beam, not a storm) and low radar quality (MRMS RadarQualityIndex). The map draws such
// pixels as they are and marks them ("low radar confidence"); only the model's inputs lose the strongest speckle (it would grow into a
// storm that is not there). Real storm cores are many pixels across, so they are never touched. Pure (node-tested).

export const SPECKLE = { thr: 4, maxPx: 6, ratio: 4, radius: 5, floor: 0.1 };   // the map's marks (6 km² at most: real storm cores are far bigger)
export const DESPECKLE = Object.assign({}, SPECKLE, { thr: 8, ratio: 8 });     // the model's inputs: only heavy specks (a fake storm to grow), 8x their surroundings

/** isolated speckle in a w x h grid of mm/h (1 km): groups (8-connected) of at most maxPx pixels over thr whose strongest pixel is at
 *  least `ratio` times the median of everything else within `radius` pixels -> [{ px: [index], max, med, i, j (centre) }] */
export function speckle(v, w, h, o = SPECKLE) {
  const seen = new Uint8Array(w * h), out = [], stack = [];
  for (let s = 0; s < w * h; s++) {
    if (seen[s] || !(v[s] >= o.thr)) continue;
    const px = []; stack.push(s); seen[s] = 1;
    while (stack.length) {
      const p = stack.pop(); px.push(p); if (px.length > o.maxPx + 1) { /* too big: still mark the rest seen */ }
      const y = (p / w) | 0, x = p - y * w;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const yy = y + dy, xx = x + dx; if (yy < 0 || yy >= h || xx < 0 || xx >= w) continue;
        const q = yy * w + xx; if (!seen[q] && v[q] >= o.thr) { seen[q] = 1; stack.push(q); }
      }
    }
    if (px.length > o.maxPx) continue;
    let ci = 0, cj = 0, max = 0; const inC = new Set(px);
    for (const p of px) { const y = (p / w) | 0; ci += y; cj += p - y * w; if (v[p] > max) max = v[p]; }
    ci /= px.length; cj /= px.length;
    const ring = [];
    for (let y = Math.max(0, Math.round(ci) - o.radius); y <= Math.min(h - 1, Math.round(ci) + o.radius); y++)
      for (let x = Math.max(0, Math.round(cj) - o.radius); x <= Math.min(w - 1, Math.round(cj) + o.radius); x++) { const q = y * w + x; if (!inC.has(q)) ring.push(v[q] > 0 ? v[q] : 0); }
    ring.sort((a, b) => a - b);
    const med = ring.length ? ring[ring.length >> 1] : 0;
    if (max >= o.ratio * Math.max(med, o.floor)) out.push({ px, max, med, i: ci, j: cj });
  }
  return out;
}
/** the model's inputs: the clearest speckle set to its surroundings' median (in place) -> how many pixels changed */
export function despeckle(v, w, h, o = DESPECKLE) {
  let n = 0;
  for (const s of speckle(v, w, h, o)) for (const p of s.px) { v[p] = s.med; n++; }
  return n;
}
/** low radar quality where it rains: rqi (0..1) below `min` and rain over 0.1 mm/h -> Uint8Array mask (1 = low confidence) */
export function lowQuality(rate, rqi, min = 0.5) {
  const m = new Uint8Array(rate.length);
  for (let i = 0; i < rate.length; i++) if (rate[i] >= 0.1 && rqi[i] >= 0 && rqi[i] < min) m[i] = 1;
  return m;
}
