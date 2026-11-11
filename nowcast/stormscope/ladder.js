// nowcast/stormscope/ladder.js - v003: the alert ladder (yellow: storm on the way, from the radar; red: damaging within 30 min, from StormScope).

'use strict';

import { stormCorridors, arrivalMin, CORRIDOR } from '../corridor.js';
import { hrrrLatLon, cropRC, HRRR } from './lcc.js';

export const LADDER = {
  redWithinMin: 30,
  yellow: { kind: 'track', level: 'yellow', label: 'Storm on the way', color: '#FFD60A',
            note: 'A strong storm core (50 dBZ or more) is moving this way. The box is everywhere it could go in the next 90 minutes.' },
  red: { kind: 'damaging', level: 'red', label: 'Damaging storm', color: '#FF2D55',
         note: 'StormScope forecasts a storm core strong enough for hail (55 dBZ or more), often with strong wind, within 30 minutes.' },
  later: { level: 'orange', label: 'Possible hail later', color: '#FF9F0A' },
};

export function radarFrames(prep) {
  const H = prep.tile.y1 - prep.tile.y0;
  const W = prep.tile.x1 - prep.tile.x0;
  const HW = H * W;
  const frames = [];
  for (let L = 0; L <= 5; L++) {
    const f = new Float32Array(HW);
    const base = (48 + 2 * L) * HW;
    for (let m = 0; m < HW; m++) {
      f[m] = prep.valid[m] ? prep.cond[base + m] * prep.std[0] + prep.mean[0] : -10;
    }
    frames.push(f);
  }
  return { frames, H, W };
}

function centroid(hull) {
  let sx = 0, sy = 0;
  for (const p of hull) { sx += p[0]; sy += p[1]; }
  const n = hull.length || 1;
  return [sx / n, sy / n];
}

function ringFromHull(hull, tile) {
  const pts = hull.map(p => hrrrLatLon(p[0] + tile.x0 + HRRR.crop.x, p[1] + tile.y0 + HRRR.crop.y));
  const ring = pts.map(p => [p.lon, p.lat]);
  if (ring.length) ring.push(ring[0].slice());
  return ring;
}

function bboxOverlap(ring, area) {
  let s = Infinity, w = Infinity, n = -Infinity, e = -Infinity;
  for (const [lon, lat] of ring) {
    if (lat < s) s = lat;
    if (lon < w) w = lon;
    if (lat > n) n = lat;
    if (lon > e) e = lon;
  }
  return !(e < area[1] || w > area[3] || n < area[0] || s > area[2]);
}

export function trackAlerts(prep, place = null, area = null) {
  const { frames, H, W } = radarFrames(prep);
  const tile = prep.tile;
  const cors = stormCorridors(frames, H, W, CORRIDOR);
  let px = null;
  if (place) {
    const q = cropRC(place.lat, place.lon);
    px = [q.c - tile.x0, q.r - tile.y0];
  }
  const out = [];
  for (const cor of cors) {
    const ring = ringFromHull(cor.hull, tile);
    if (area && !bboxOverlap(ring, area)) continue;
    const c = centroid(cor.steps[0].hull);
    const centre = hrrrLatLon(c[0] + tile.x0 + HRRR.crop.x, c[1] + tile.y0 + HRRR.crop.y);
    out.push({
      kind: LADDER.yellow.kind, level: LADDER.yellow.level, label: LADDER.yellow.label,
      color: LADDER.yellow.color, note: LADDER.yellow.note,
      startMin: px ? arrivalMin(cor, px[0], px[1]) : null, endMin: 90, peak: null,
      rings: [ring], centre: { lat: centre.lat, lon: centre.lon },
      px: cor.steps[0].hull.length, speedKmh: cor.speedKmh, bearing: cor.bearing, cor, tile,
    });
  }
  return out;
}

export function ladderAlerts(ssAlerts, tracks) {
  const red = [], later = [], pass = [];
  for (const a of ssAlerts) {
    if (a.kind !== 'hail') { pass.push(a); continue; }
    const b = Object.assign({}, a);
    if (a.startMin <= LADDER.redWithinMin) {
      b.kind = LADDER.red.kind; b.level = LADDER.red.level; b.label = LADDER.red.label;
      b.color = LADDER.red.color; b.note = LADDER.red.note;
      red.push(b);
    } else {
      b.level = LADDER.later.level; b.label = LADDER.later.label; b.color = LADDER.later.color;
      later.push(b);
    }
  }
  return tracks.concat(pass, later, red);
}

export function arrivalAt(alert, lat, lon) {
  if (!alert || alert.level !== 'yellow' || !alert.cor || !alert.tile) return null;
  const q = cropRC(lat, lon);
  return arrivalMin(alert.cor, q.c - alert.tile.x0, q.r - alert.tile.y0);
}
