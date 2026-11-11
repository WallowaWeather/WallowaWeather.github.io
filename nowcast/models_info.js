// nowcast/models_info.js - the three forecast models in plain words: what each does, what it is good and bad at, who made it, its
// licence, and its icon. Read by the model picker (modelpick.js) and the Settings sheet (settings.js). All three are experimental and
// never an official warning: for warnings, follow the National Weather Service.
// Wording rules: short bullets a rancher or a firefighter can read in 20 seconds; every model has at
// least two strengths and two weaknesses; only what was measured; no "best", "always" or "beats everything".
'use strict';

/** v009: BEAM's download, rounded (the pack: six members in 16-bit floats + the static terrain channels, 24.8 MB; config.js pins it).
 *  Settings shows the pack's own byte count once its list is read. */
export const BEAM_SIZE_MB = 25;

export const EXPERIMENTAL = 'Experimental · never an official warning';
export const FOLLOW_NWS = 'For warnings, follow the National Weather Service.';

export const MODELS = [
  {
    id: 'beam',
    name: 'BEAM',
    long: 'Blended Early-warning Alert Model',
    maker: 'Made for Wallowa Weather',
    year: 2026,
    licence: { name: 'Apache License 2.0', url: 'https://www.apache.org/licenses/LICENSE-2.0', file: 'licenses/Apache-2.0.txt', when: 'To be released under this licence.' },
    source: null,
    short: 'Hail, lightning and cloudbursts for radar gaps',
    what: 'A public-good model made for this app, for the Inland Northwest\'s radar gaps, Wallowa County among them. It blends radar, satellite, lightning and NOAA\'s HRRR model to warn of storms up to 90 minutes ahead.',
    reads: ['Radar (NOAA MRMS)', 'Satellite and lightning (NOAA GOES-West, GLM)', 'NOAA\'s HRRR weather model'],
    trained: 'Storms from 2020 to 2026 in the Inland Northwest',
    forecasts: ['Hail', 'Strong storm cores', 'Lightning', 'Cloudbursts (very heavy rain)'],
    horizon: 'The next 90 minutes, every half hour',
    runs: 'Runs on this phone (on the graphics chip; download once)',
    strengthsNote: 'From blind tests on storm days it never saw:',
    strengths: [
      'Lightning 30+ minutes out: beat NOAA\'s LightningCast, by about 15 points in radar gaps.',
      'Never lost to NOAA\'s HRRR model: 29 wins, 0 losses, 7 ties.',
      'Strong storm cores: scored ahead of HRRR.',
      'Its storm-path fan held the next lightning about 2 times in 3.',
    ],
    weaknesses: [
      'Hail: about even with NOAA\'s ProbSevere at the same false alarms. Not better.',
      'Warning areas are much bigger than the ground hit. Property counts mean inside the area, not damaged.',
      'The dry-lightning (fire-start) rule failed its tests: experimental only.',
      'Quiet in winter: a thunderstorm model.',
      'Where radar can\'t see, hail and heavy rain are hard to check.',
    ],
    stage: 'live',
    examples: true,   // v009: its recorded example storms show without the download
    stageNote: 'New in this test build: BEAM runs live on this phone. The recorded example storms (with each storm’s cone) are still there.',
    sizeMB: BEAM_SIZE_MB,
    tint: 'beam',
    icon: [
      { d: 'M14 2.5 7.5 12.5H12l-2 9 7-11.5h-4.5L14 2.5Z' },
      { d: 'M5 16.6a1.6 1.6 0 1 0 0 3.2 1.6 1.6 0 0 0 0-3.2Z' },
      { d: 'M19 15.1a1.6 1.6 0 1 0 0 3.2 1.6 1.6 0 0 0 0-3.2Z' },
      { d: 'M3 6.5h3.2M2.5 10h2.4' },
    ],
  },
  {
    id: 'stormscope',
    name: 'StormScope',
    long: 'NVIDIA StormScope',
    maker: 'NVIDIA',
    year: 2025,
    licence: { name: 'NVIDIA Open Model License', url: 'https://www.nvidia.com/en-us/agreements/enterprise-software/nvidia-open-model-license/', file: 'licenses/NVIDIA-Open-Model-License.txt',
      notice: 'Licensed by NVIDIA Corporation under the NVIDIA Open Model License.',
      changes: 'Modified for this app: quantised to 8-bit integers and run as WebGPU kernels; the satellite input is held at its newest image.' },
    source: 'https://huggingface.co/nvidia/stormscope-goes-mrms',
    short: 'Storms from radar, satellite and lightning',
    what: 'NVIDIA\'s storm model. It reads the radar, the GOES satellite and lightning, and draws storms for the next 90 minutes.',
    reads: ['Radar (NOAA MRMS)', 'Satellite and lightning (NOAA GOES)'],
    trained: 'Storms over the central and eastern US',
    forecasts: ['Storms on the radar', 'Lightning', 'Strong storm cores'],
    horizon: 'The next 90 minutes, every 10 minutes',
    runs: 'Runs on this phone (8-bit, on the graphics chip)',
    strengths: [
      'Sees storms forming on the satellite, not only on radar.',
      'Draws each storm cell, with rain or snow marked (type from NOAA\'s HRRR).',
    ],
    weaknesses: [
      'Trained on the central and eastern US, not here: less sure in the West.',
      'Less sure where radar can\'t see.',
      'A big download.',
      'Uses data while the map is open: it keeps the radar, satellite and lightning fresh.',
    ],
    stage: 'live',
    tint: 'ss',
    icon: [
      { d: 'M12 3.5a8.5 8.5 0 1 0 0 17 8.5 8.5 0 0 0 0-17Z' },
      { d: 'M12 1v2.5M12 20.5V23M1 12h2.5M20.5 12H23' },
      { d: 'M9 15.2h6.2a2.4 2.4 0 0 0 .3-4.8 3.4 3.4 0 0 0-6.5.7 2.05 2.05 0 0 0 0 4.1Z' },
      { d: 'M12.6 15.2 11.4 17.4h1.8L12 19.4' },
    ],
  },
  {
    id: 'dgmr',
    name: 'DGMR',
    long: 'DeepMind DGMR',
    maker: 'DeepMind',
    year: 2021,
    licence: { name: 'CC BY 4.0', url: 'https://creativecommons.org/licenses/by/4.0/',
      notice: 'Copyright 2021 DeepMind Technologies Limited. Licensed under CC BY 4.0.',
      changes: 'Modified: the weights converted to 16-bit floats (the full model) or quantised to 8-bit integers (the low-memory model), and run as WebGPU kernels.' },
    source: 'https://github.com/google-deepmind/deepmind-research/tree/master/nowcasting',
    short: 'Rain from radar, with a chance of rain',
    what: 'DeepMind\'s rain model. It reads the newest radar and draws the next 90 minutes of rain; several runs give a chance of rain.',
    reads: ['Radar (NOAA MRMS)'],
    trained: 'UK radar',
    forecasts: ['Rain', 'Chance of rain'],
    horizon: 'The next 90 minutes, every 5 minutes',
    runs: 'Runs on this phone (on the graphics chip)',
    strengths: [
      'Rain patterns that look real.',
      'The chance-of-rain view: several runs, one possible future each.',
    ],
    weaknesses: [
      'Rain only: no hail, no lightning.',
      'Trained on UK radar: on US radar it is an experiment.',
      'Needs radar, so it is weak in radar gaps like Wallowa County.',
      'Small storms can fade too fast.',
    ],
    stage: 'live',
    tint: 'dgmr',
    icon: [
      { d: 'M9 5.5c2.7 3.3 4.4 5.8 4.4 8.2a4.4 4.4 0 0 1-8.8 0c0-2.4 1.7-4.9 4.4-8.2Z' },
      { d: 'M17.5 2.8c1.5 1.9 2.5 3.3 2.5 4.6a2.5 2.5 0 0 1-5 0c0-1.3 1-2.7 2.5-4.6Z' },
      { d: 'M17.5 13.2c1.5 1.9 2.5 3.3 2.5 4.6a2.5 2.5 0 0 1-5 0c0-1.3 1-2.7 2.5-4.6Z' },
    ],
  },
];

export const modelById = (id) => MODELS.find((m) => m.id === id) || null;

const NS = 'http://www.w3.org/2000/svg';
/** an <svg> of a model's icon (line drawing, stroke currentColor) */
export function modelIcon(idOrModel, cls = 'mp-ic', size = 24, doc = document) {
  const m = typeof idOrModel === 'string' ? modelById(idOrModel) : idOrModel;
  const s = doc.createElementNS(NS, 'svg');
  for (const [k, v] of [['viewBox', '0 0 24 24'], ['width', size], ['height', size], ['aria-hidden', 'true'], ['class', cls], ['fill', 'none'], ['stroke', 'currentColor'],
    ['stroke-width', '1.7'], ['stroke-linecap', 'round'], ['stroke-linejoin', 'round']]) s.setAttribute(k, String(v));
  for (const p of (m && m.icon) || []) { const e = doc.createElementNS(NS, 'path'); e.setAttribute('d', p.d); s.append(e); }
  return s;
}

/** small line glyphs the picker and Settings use (chevrons, check, gear) */
export const GLYPHS = {
  check: ['M5 12.5 10 17.5 19 7'],
  chevUp: ['M6 15l6-6 6 6'],
  chevRight: ['M9.5 5.5 16 12l-6.5 6.5'],
  back: ['M15 5l-7 7 7 7'],
  gear: ['M10.05 4.97L10.25 2.56A9.6 9.6 0 0 1 13.75 2.56L13.95 4.97A7.3 7.3 0 0 1 15.59 5.65L17.44 4.09A9.6 9.6 0 0 1 19.91 6.56L18.35 8.41A7.3 7.3 0 0 1 19.03 10.05L21.44 10.25A9.6 9.6 0 0 1 21.44 13.75L19.03 13.95A7.3 7.3 0 0 1 18.35 15.59L19.91 17.44A9.6 9.6 0 0 1 17.44 19.91L15.59 18.35A7.3 7.3 0 0 1 13.95 19.03L13.75 21.44A9.6 9.6 0 0 1 10.25 21.44L10.05 19.03A7.3 7.3 0 0 1 8.41 18.35L6.56 19.91A9.6 9.6 0 0 1 4.09 17.44L5.65 15.59A7.3 7.3 0 0 1 4.97 13.95L2.56 13.75A9.6 9.6 0 0 1 2.56 10.25L4.97 10.05A7.3 7.3 0 0 1 5.65 8.41L4.09 6.56A9.6 9.6 0 0 1 6.56 4.09L8.41 5.65A7.3 7.3 0 0 1 10.05 4.97Z',
    'M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6Z'],
  map: ['M9 4.5 3.5 6.5v13l5.5-2 6 2 5.5-2v-13l-5.5 2-6-2Z', 'M9 4.5v13M15 6.5v13'],
  phone: ['M8 2.5h8a1.5 1.5 0 0 1 1.5 1.5v16a1.5 1.5 0 0 1-1.5 1.5H8A1.5 1.5 0 0 1 6.5 20V4A1.5 1.5 0 0 1 8 2.5Z', 'M10.5 18.5h3'],
  info: ['M12 3.5a8.5 8.5 0 1 0 0 17 8.5 8.5 0 0 0 0-17Z', 'M12 11v5.5M12 7.8h.01'],
  pulse: ['M2.5 12h4l2.5-6 4 12 2.5-6h6'],
  gauge: ['M3.8 17.5a9 9 0 1 1 16.4 0', 'M12 13.5l4.2-4.7', 'M10.6 13.5a1.4 1.4 0 1 0 2.8 0a1.4 1.4 0 1 0-2.8 0'],   // SPEED TUNE (Settings row)
  flag: ['M5.5 21V3.5', 'M5.5 4h12l-3 4.5 3 4.5h-12'],   // FIELD REPORT (fieldkit): Settings › Field report
  refresh: ['M19.5 10.5A7.8 7.8 0 0 0 5.6 7.4L4.5 9', 'M4.5 4.5V9H9', 'M4.5 13.5a7.8 7.8 0 0 0 13.9 3.1l1.1-1.6', 'M19.5 19.5V15H15'],   // Nov-08: Keep forecasts fresh
  download: ['M12 4v10.5', 'M7.5 10 12 14.5l4.5-4.5', 'M5 19.5h14'],   // LANDING: Settings › Download all
  gauge: ['M4.6 18A8.5 8.5 0 1 1 19.4 18', 'M12 14.5l4-5', 'M12 14.5h.01', 'M7 13.5h1.5M15.5 13.5H17M12 7.5V9'],   // BENCH TEST: Settings › Bench test
};
export function glyph(name, cls = 'mp-gl', size = 24, doc = document) {
  const s = doc.createElementNS(NS, 'svg');
  for (const [k, v] of [['viewBox', '0 0 24 24'], ['width', size], ['height', size], ['aria-hidden', 'true'], ['class', cls], ['fill', 'none'], ['stroke', 'currentColor'],
    ['stroke-width', '1.7'], ['stroke-linecap', 'round'], ['stroke-linejoin', 'round']]) s.setAttribute(k, String(v));
  for (const d of GLYPHS[name] || []) { const e = doc.createElementNS(NS, 'path'); e.setAttribute('d', d); s.append(e); }
  return s;
}

const mb = (bytes) => `${Math.round(bytes / 1e6)} MB`;
/** the picker's status chip, in words: { text, kind: 'ready' | 'busy' | 'examples' | 'get' | 'error' } from statusOf(id) */
export function statusText(st, model) {
  const s = st || {}, m = model || {};
  if (s.downloading) return { text: `Downloading · ${Math.floor(100 * (s.pct || 0))}%`, kind: 'busy' };
  if (s.ready) return { text: 'On this phone', kind: 'ready' };
  if (s.note) return { text: s.note, kind: m.stage === 'examples' ? 'examples' : 'note' };
  if (m.stage === 'examples') return { text: 'Examples', kind: 'examples' };
  if (s.error) return { text: 'Not reachable', kind: 'error' };
  const bytes = s.bytes || (m.sizeMB ? m.sizeMB * 1e6 : 0);
  return { text: bytes ? `Download · ${mb(bytes)}` : 'Download', kind: 'get' };
}
