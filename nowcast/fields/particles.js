// nowcast/fields/particles.js - the wind map's moving streaks. Each streak is a point in Web Mercator world units (X, Y in 0..1, so
// a pan or a zoom never smears it), moved each frame by the wind under it with RK2 (the midpoint rule: steady curves, no spiralling
// out), at a screen speed that looks the same at every zoom (pxPerFrame px a frame per m/s; Mercator is conformal, so the direction on
// the screen is the wind's). It lives a random 40-110 frames, then starts again somewhere random on the screen (also when it leaves the
// screen or reaches a place the model has no wind); its last `trail` positions are drawn as a fading tail, so faster wind draws a
// longer streak; tails are faint in calm air (< 3 m/s), brighter in a breeze, brightest from 8 m/s. The count follows the screen's
// area and the zoom (at most 3000). Reduced motion: arrowGrid() gives still arrows.
// Pure: the drawing takes any 2D context.
'use strict';
import { msToMph, windTo } from './units.js';

const D2R = Math.PI / 180;
export function worldOf(lat, lon) {
  const s = Math.sin(Math.max(-85, Math.min(85, lat)) * D2R);
  return [(lon + 180) / 360, 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)];
}
export const latLonOf = (X, Y) => [Math.atan(Math.sinh(Math.PI - 2 * Math.PI * Y)) / D2R, X * 360 - 180];
/** the map's projection (lat, lon) -> {x, y} as an affine of world units: x = a X + bx, y = a Y + by */
export function affineFrom(project) {
  const p1 = project(0, 0), p2 = project(0, 90), [X1, Y1] = worldOf(0, 0), [X2] = worldOf(0, 90);
  const a = (p2.x - p1.x) / (X2 - X1);
  return { a, bx: p1.x - a * X1, by: p1.y - a * Y1 };
}
/** streaks for a screen of w x h CSS px at zoom z: one per 200 px^2 zoomed out, one per 280 px^2 at zoom 9 and in; at most `cap` */
export function particleCount(w, h, z, cap = 3000) {
  const per = 200 + (Math.max(4, Math.min(9, z)) - 4) * 16;
  return Math.max(0, Math.min(cap, Math.round((w * h) / per)));
}

/** one RK2 (midpoint) step of size h: vel(x, y, out) fills out with dx/dt, dy/dt (false: no wind there) -> [x, y] | null */
const K1 = [0, 0], K2 = [0, 0];
export function rk2(x, y, vel, h) {
  if (!vel(x, y, K1)) return null;
  if (!vel(x + 0.5 * h * K1[0], y + 0.5 * h * K1[1], K2)) return null;
  return [x + h * K2[0], y + h * K2[1]];
}
/** the same with Euler's rule (the tests' comparison) */
export function euler(x, y, vel, h) { if (!vel(x, y, K1)) return null; return [x + h * K1[0], y + h * K1[1]]; }

/** a field sampler on a product's lat / lon grid: sample(X, Y, out) -> out = [east, north] m/s, false off the grid / no data */
export function sampler(p) {
  const g = p.grid, U = p.u, V = p.v, W = g.cols, Hh = g.rows;
  return {
    sample(X, Y, out) {
      const lat = Math.atan(Math.sinh(Math.PI - 2 * Math.PI * Y)) / D2R, lon = X * 360 - 180;
      const r = (g.top - lat) / g.dlat - 0.5, c = (lon - g.left) / g.dlon - 0.5;
      if (!(r >= 0 && c >= 0 && r <= Hh - 1 && c <= W - 1)) return false;
      const r0 = Math.min(Math.floor(r), Hh - 2), c0 = Math.min(Math.floor(c), W - 2), fr = r - r0, fc = c - c0, k = r0 * W + c0;
      const u = (U[k] * (1 - fc) + U[k + 1] * fc) * (1 - fr) + (U[k + W] * (1 - fc) + U[k + W + 1] * fc) * fr;
      const v = (V[k] * (1 - fc) + V[k + 1] * fc) * (1 - fr) + (V[k + W] * (1 - fc) + V[k + W + 1] * fc) * fr;
      if (u !== u || v !== v) return false;
      out[0] = u; out[1] = v; return true;
    },
  };
}

/**
 * createParticles({ count, trail = 12, life: [min, max] frames, margin: px beyond the screen before a respawn, pxPerFrame, rng })
 *   .reset(view)            every streak somewhere random on the screen (view = { a, bx, by, w, h }: affineFrom() + the size)
 *   .step(field, view, dt)  move them dt frames (field.sample(X, Y, out) -> east / north m/s or false)
 *   .build(view)            the tails as line segments in screen px: { buckets: [{ n, xy (x0, y0, x1, y1 ...), alpha, age, cls }], length }
 *   .draw(ctx, built, { rgb, width })
 */
export const SPEED_CLASSES = [3, 8];   // m/s: calm < 3 <= breeze < 8 <= wind
const CLASS_ALPHA = [0.42, 0.72, 1];
const classOf = (v) => (v < SPEED_CLASSES[0] ? 0 : v < SPEED_CLASSES[1] ? 1 : 2);
export function createParticles({ count = 1000, trail = 12, life = [40, 110], margin = 24, pxPerFrame = 0.32, rng = Math.random } = {}) {
  const T = Math.max(2, trail | 0), sys = { count: 0, pxPerFrame, trail: T };
  let X, Y, age, lim, spd, hist, ring = 0, buckets = [];
  const out = [0, 0], o2 = [0, 0];
  function alloc(n) {
    const keep = Math.min(n, sys.count), nX = new Float64Array(n), nY = new Float64Array(n), nA = new Int32Array(n), nL = new Int32Array(n), nS = new Float32Array(n), nH = new Float64Array(n * T * 2);
    if (keep) { nX.set(X.subarray(0, keep)); nY.set(Y.subarray(0, keep)); nA.set(age.subarray(0, keep)); nL.set(lim.subarray(0, keep)); nS.set(spd.subarray(0, keep)); nH.set(hist.subarray(0, keep * T * 2)); }
    X = nX; Y = nY; age = nA; lim = nL; spd = nS; hist = nH; sys.count = n; sys.X = X; sys.Y = Y; sys.age = age;
    // one bucket per (tail segment, speed class): segment 0 is the oldest, faintest
    buckets = [];
    for (let b = 0; b < T - 1; b++) for (let c = 0; c < 3; c++) buckets.push({ n: 0, xy: new Float32Array(4 * n), alpha: (0.1 + (0.78 * (b + 1)) / (T - 1)) * CLASS_ALPHA[c], age: b, cls: c });
    return keep;
  }
  function place(i, x, y) {
    X[i] = x; Y[i] = y; age[i] = 0; spd[i] = 0; lim[i] = life[0] + Math.floor(rng() * (life[1] - life[0] + 1));
    for (let k = 0, o = i * T * 2; k < T; k++, o += 2) { hist[o] = x; hist[o + 1] = y; }
  }
  function respawn(i, view, field) {
    let x = 0, y = 0;
    for (let tries = 0; tries < 6; tries++) {
      x = (rng() * view.w - view.bx) / view.a; y = (rng() * view.h - view.by) / view.a;
      if (!field || field.sample(x, y, o2)) break;
    }
    place(i, x, y);
  }
  sys.reset = (view) => { for (let i = 0; i < sys.count; i++) respawn(i, view, null); };
  sys.resize = (n, view = null) => { const k = alloc(Math.max(0, n | 0)); if (view) for (let i = k; i < sys.count; i++) respawn(i, view, null); };
  sys.step = (field, view, dt = 1) => {
    const k = (pxPerFrame * dt) / view.a, x0 = -margin, x1 = view.w + margin, y0 = -margin, y1 = view.h + margin;
    ring = (ring + 1) % T;
    for (let i = 0; i < sys.count; i++) {
      const x = X[i], y = Y[i];
      let nx, ny;
      if (field.sample(x, y, out)) {
        const mx = x + 0.5 * k * out[0], my = y - 0.5 * k * out[1];
        if (field.sample(mx, my, out)) { nx = x + k * out[0]; ny = y - k * out[1]; }
      }
      if (nx === undefined) { respawn(i, view, field); continue; }
      const sx = view.a * nx + view.bx, sy = view.a * ny + view.by;
      if (++age[i] >= lim[i] || sx < x0 || sx > x1 || sy < y0 || sy > y1) { respawn(i, view, field); continue; }
      X[i] = nx; Y[i] = ny; spd[i] = Math.sqrt(out[0] * out[0] + out[1] * out[1]);
      const o = (i * T + ring) * 2; hist[o] = nx; hist[o + 1] = ny;
    }
  };
  sys.build = (view) => {
    const a = view.a, bx = view.bx, by = view.by; let length = 0;
    for (const b of buckets) b.n = 0;
    for (let i = 0; i < sys.count; i++) {
      const base = i * T, c = classOf(spd[i]);
      let k0 = (ring + 1) % T, px = a * hist[(base + k0) * 2] + bx, py = a * hist[(base + k0) * 2 + 1] + by;
      for (let s = 0; s < T - 1; s++) {
        const k1 = (ring + 2 + s) % T, qx = a * hist[(base + k1) * 2] + bx, qy = a * hist[(base + k1) * 2 + 1] + by;
        const dx = qx - px, dy = qy - py;
        if (dx * dx + dy * dy > 1e-4) {
          const bk = buckets[s * 3 + c], o = 4 * bk.n++;
          bk.xy[o] = px; bk.xy[o + 1] = py; bk.xy[o + 2] = qx; bk.xy[o + 3] = qy; length += Math.sqrt(dx * dx + dy * dy);
        }
        px = qx; py = qy; k0 = k1;
      }
    }
    return { buckets, length };
  };
  sys.draw = (ctx, built, { rgb = '255,255,255', width = 1.3 } = {}) => {
    ctx.lineCap = 'round'; ctx.lineWidth = width;
    for (const b of built.buckets) {
      if (!b.n) continue;
      ctx.beginPath();
      for (let i = 0, o = 0; i < b.n; i++, o += 4) { ctx.moveTo(b.xy[o], b.xy[o + 1]); ctx.lineTo(b.xy[o + 2], b.xy[o + 3]); }
      ctx.strokeStyle = `rgba(${rgb},${b.alpha.toFixed(3)})`; ctx.stroke();
    }
  };
  alloc(Math.max(0, count | 0));
  return sys;
}

/** still arrows on a `spacing` px grid (reduced motion): [{ x, y, deg (where the wind blows TO), mph }] */
export function arrowGrid(view, field, spacing = 44) {
  const out = [], o = [0, 0];
  for (let y = spacing / 2; y < view.h; y += spacing) for (let x = spacing / 2; x < view.w; x += spacing) {
    if (!field.sample((x - view.bx) / view.a, (y - view.by) / view.a, o)) continue;
    out.push({ x, y, deg: windTo(o[0], o[1]), mph: msToMph(Math.hypot(o[0], o[1])) });
  }
  return out;
}
/** draw still arrows: a shaft along the wind with a head where it blows to, longer for stronger wind */
export function drawArrows(ctx, arrows, { rgb = '255,255,255', width = 1.6 } = {}) {
  ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.lineWidth = width; ctx.strokeStyle = `rgba(${rgb},0.9)`;
  ctx.beginPath();
  for (const a of arrows) {
    if (!(a.mph >= 1)) continue;
    const L = 7 + Math.min(14, a.mph * 0.45), r = a.deg * D2R, dx = Math.sin(r), dy = -Math.cos(r);
    const hx = a.x + (dx * L) / 2, hy = a.y + (dy * L) / 2, tx = a.x - (dx * L) / 2, ty = a.y - (dy * L) / 2;
    ctx.moveTo(tx, ty); ctx.lineTo(hx, hy);
    const w = 4, bx = hx - dx * 5, by = hy - dy * 5;
    ctx.moveTo(bx - dy * w, by + dx * w); ctx.lineTo(hx, hy); ctx.lineTo(bx + dy * w, by - dx * w);
  }
  ctx.stroke();
}
