// nowcast/bench.js - Wallowa Weather's BENCH TEST (Josh, Nov-08-2026: "I need a bench test button in settings"): Settings › Bench test.
// One button runs a short check of how well THIS phone runs the app: the graphics chip (WebGPU: the adapter, its features and the
// limits the three models need), 16-bit shaders and the f16 rounding StormScope chose here, the app's storage (kept or not, room
// left), then each model already on this phone (BEAM, DGMR, StormScope): its load, a first (cold) run and a second (warm) run on a
// made-up storm that is the same every time (seeded, each model's real input shape), a check of what came out (all numbers finite,
// in the model's range, the same both times) and that its graphics memory was given back. Each row is Pass, Slow, Fail or Not run
// (with why); the card ends with the whole bench's time and can be copied or shared as text.
// NOTHING IS DOWNLOADED OR SENT: the models are read from this phone's storage, the input is made here, the card stays on the phone
// (its last result in localStorage) until the person copies or shares it. No network calls, no analytics.
// The runs go through the app's one queue (nowcast_app.js benchStep: a 'bench' job per model), so a bench never runs beside a forecast
// and the other models let go of the graphics chip first, as for any forecast. view.js loads this file the first time the page opens.
//   fillBench(el, { version, installed(), models: { beam|dgmr|stormscope: settings hook }, step(model, fn, { signal }), toast, diag })
//   runBench(env, { only, signal, onUpdate }) -> result;  benchText(result) -> the card as plain text (pure: tests/bench_test.mjs)
//
// HOW A ROW IS JUDGED (from the app's own clocks; no phone's measurements are used or kept here):
//   a model's "forecast" = its load + its first run + the rest of one forecast's runs at the warm speed (what a person waits for from a
//   cold start: the queue lets a model go two minutes after its last run). One forecast = BEAM 1 pass (all six members at once),
//   DGMR 4 runs (DGMR.ensemble.members, one area), StormScope 9 ten-minute steps (run_ss.js STORMSCOPE.outputs.frames).
//   Pass: the forecast's model work takes at most 1 minute (run_ss.js uses inputs refreshed under a minute ago as they are: the app
//         counts a minute as "now").
//   Slow: longer, but it still lands within one step of the model's own clock: DGMR 5 min (its radar frames are 5 min apart),
//         BEAM and StormScope 10 min (their frames are 10 min apart; BEAM's shortest refresh is every 10 min, cadence.js).
//   Fail: past that (the forecast would be a step old before it is done), or it did not load or run, or its output was not finite,
//         out of range or different the second time, or its graphics memory was not given back.
//   16-bit shaders missing = Slow (the models fall back to their 32-bit maths). No room for a model not yet downloaded = Fail.
'use strict';
import { h16 } from './beam/engine/gpu.js';

export const BENCH_KEY = 'ww:bench:last';
export const LIMITS = {
  passS: 60,
  clockMin: { beam: 10, dgmr: 5, stormscope: 10 },
  runs: { beam: 1, dgmr: 4, stormscope: 9 },
  roomMB: 50,   // free room kept beyond a download (ww.js canDownload)
};
/** what each engine asks of the graphics chip (nowcast/engine.js, stormscope/engine.js _init; BEAM: any WebGPU adapter, a 32-bit path) */
export const NEEDS = { dgmr: { storageBuffers: 5, bindMB: 72, floatBindMB: 130 }, stormscope: { storageBuffers: 7, bindMB: 96 } };
/** the sanity range of each model's output: BEAM chances 0-1 (a sigmoid); DGMR mm/h inside what the 8-bit model's int16 / 64 output can
 *  hold (a GAN dips a little below 0; the app floors it); StormScope reflectivity in dBZ once de-normalised (the app's byte holds -20 ...
 *  235) and its lightning channel (log1p of flashes) */
export const RANGE = { beam: [0, 1], dgmr: [-16, 512], ssDbz: [-200, 200], ssLight: [-20, 20] };
/** the largest difference allowed between the first and second run of the same input (the same maths twice) */
export const SAME = { beam: 1e-4, dgmr: 0.05, stormscope: 0.05 };
export const MODEL_IDS = ['beam', 'dgmr', 'stormscope'];
export const NAMES = { gpu: 'WebGPU', f16: '16-bit shaders', storage: 'Storage', beam: 'BEAM', dgmr: 'DGMR', stormscope: 'StormScope', total: 'Whole bench' };
export const WORDS = { pass: 'Pass', slow: 'Slow', fail: 'Fail', skip: 'Not run', wait: 'Waiting', run: 'Running' };
const ORDER = ['gpu', 'f16', 'storage', 'beam', 'dgmr', 'stormscope', 'total'];
const BEAM_HW = 304 * 304, SS_H = 204, SS_W = 204;
const MiB = 1048576;

// ------------------------------------------------------------------------------------------------ small pure helpers
/** seconds in words: 0.8 s, 12 s, 3.5 min (a no-break space: "0.8 s" never splits) */
export function secs(ms) {
  if (ms == null || !isFinite(ms)) return '–';
  const s = ms / 1000;
  if (s < 0.05) return 'under 0.1 s';
  return s < 10 ? `${s.toFixed(1)} s` : s < 120 ? `${Math.round(s)} s` : `${(s / 60).toFixed(1)} min`;
}
const mb = (bytes) => `${Math.round((bytes || 0) / 1e6).toLocaleString('en-US')} MB`;
/** "BEAM", "BEAM and DGMR", "BEAM, DGMR and StormScope" */
export const listWords = (a) => (a.length < 3 ? a.join(' and ') : `${a.slice(0, -1).join(', ')} and ${a[a.length - 1]}`);
const gb = (bytes) => (bytes >= 1e9 ? `${(bytes / 1e9).toFixed(1)} GB` : mb(bytes));
/** the worst verdict of a list (Not run and Waiting do not count) */
export function worst(vs) { return vs.includes('fail') ? 'fail' : vs.includes('slow') ? 'slow' : vs.includes('pass') ? 'pass' : 'skip'; }
/** a seeded generator in [0, 1) (mulberry32): the made-up storm is the same on every phone and every run */
export function rng(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
/** a smooth made-up field [H][W] (a few seeded Gaussian blobs, separable, plus a little noise): base + amp x blobs, clipped to [lo, hi] */
export function field(R, H, W, { blobs = 4, base = 0, amp = 1, noise = 0.02, lo = -Infinity, hi = Infinity, shift = [0, 0] } = {}, out = new Float32Array(H * W)) {
  out.fill(base);
  for (let b = 0; b < blobs; b++) {
    const cy = R() * H + shift[0], cx = R() * W + shift[1], ry = (0.04 + 0.12 * R()) * H, rx = (0.04 + 0.12 * R()) * W, a = amp * (0.4 + 0.6 * R());
    const gy = new Float32Array(H), gx = new Float32Array(W);
    for (let y = 0; y < H; y++) gy[y] = Math.exp(-0.5 * ((y - cy) / ry) ** 2);
    for (let x = 0; x < W; x++) gx[x] = Math.exp(-0.5 * ((x - cx) / rx) ** 2);
    for (let y = 0; y < H; y++) { const v = a * gy[y]; if (v < 1e-6) continue; for (let x = 0, o = y * W; x < W; x++) out[o + x] += v * gx[x]; }
  }
  for (let i = 0; i < out.length; i++) { const v = out[i] + noise * (R() - 0.5); out[i] = v < lo ? lo : v > hi ? hi : v; }
  return out;
}
/** BEAM's channels 0-30 (model-scaled, 0-1) as f16 bits, CHW [31][304 x 304]; the step adds the pack's 31-38 and 39 = 1 (radar seen) */
export function beamInput(seed = 20261108) {
  const R = rng(seed), bits = new Uint16Array(31 * BEAM_HW), f = new Float32Array(BEAM_HW), u = new Uint32Array(f.buffer);
  for (let c = 0; c < 31; c++) { field(R, 304, 304, { base: 0.05, amp: 0.8, lo: 0, hi: 1 }, f); for (let p = 0, o = c * BEAM_HW; p < BEAM_HW; p++) bits[o + p] = h16(u[p]); }
  return bits;
}
/** DGMR's 4 radar frames, 5 min apart, rain cells drifting east-north-east: Int16Array [4][256][256] in 1/32 mm/h (clipped to 128 mm/h) */
export function dgmrInput(seed = 20261108) {
  const out = new Int16Array(4 * 65536), f = new Float32Array(65536);
  for (let t = 0; t < 4; t++) {
    field(rng(seed), 256, 256, { blobs: 6, base: 0, amp: 45, noise: 0, lo: 0, hi: 128, shift: [-2 * t, 3 * t] }, f);   // the same cells, moved
    for (let p = 0; p < 65536; p++) out[t * 65536 + p] = Math.round((f[p] < 0.2 ? 0 : f[p]) * 32);
  }
  return out;
}
/** StormScope's prep for a 204 x 204 tile: cond [72][H][W] (normalised inputs), latents [9][3][H][W] (normal noise), valid [H][W] = 1,
 *  cz [9][2][H][W] (cos zenith); mean / std come from the pack's grid */
export function ssInput(seed = 20261108, H = SS_H, W = SS_W) {
  const R = rng(seed), HW = H * W, cond = new Float32Array(72 * HW), cz = new Float32Array(9 * 2 * HW), latents = new Float32Array(9 * 3 * HW);
  for (let c = 0; c < 72; c++) field(R, H, W, c >= 68 && c < 70 ? { blobs: 1, base: 0.3, amp: 0.4, lo: 0, hi: 1 } : { base: -0.8, amp: 2.2, lo: -2, hi: 3 }, cond.subarray(c * HW, (c + 1) * HW));
  for (let k = 0; k < 18; k++) field(R, H, W, { blobs: 1, base: 0.3, amp: 0.4, lo: 0, hi: 1, noise: 0 }, cz.subarray(k * HW, (k + 1) * HW));
  for (let i = 0; i < latents.length; i += 2) { const r = Math.sqrt(-2 * Math.log(R() || 1e-12)), th = 2 * Math.PI * R(); latents[i] = r * Math.cos(th); if (i + 1 < latents.length) latents[i + 1] = r * Math.sin(th); }
  return { cond, latents, cz, valid: new Uint8Array(HW).fill(1), H, W };
}
/** one output's numbers: { n, nonFinite, outside, min, max } (outside = finite values outside [lo, hi]) */
export function scan(a, lo, hi, from = 0, to = a.length) {
  let nonFinite = 0, outside = 0, min = Infinity, max = -Infinity;
  for (let i = from; i < to; i++) { const v = a[i]; if (!Number.isFinite(v)) { nonFinite++; continue; } if (v < min) min = v; if (v > max) max = v; if (v < lo || v > hi) outside++; }
  return { n: to - from, nonFinite, outside, min, max };
}
/** the largest |a - b| (Infinity when the lengths differ or a number is not finite) */
export function maxDiff(a, b) {
  if (!a || !b || a.length !== b.length) return Infinity;
  let d = 0; for (let i = 0; i < a.length; i++) { const x = Math.abs(a[i] - b[i]); if (!(x <= d)) d = Number.isFinite(x) ? x : Infinity; if (d === Infinity) break; }
  return d;
}
/** a model's time verdict: { estMs, verdict } from { loadMs, coldMs, warmMs } */
export function timeVerdict(id, t) {
  const n = LIMITS.runs[id], est = t.loadMs + t.coldMs + (n - 1) * t.warmMs;
  return { estMs: est, verdict: est <= LIMITS.passS * 1000 ? 'pass' : est <= LIMITS.clockMin[id] * 60e3 ? 'slow' : 'fail' };
}

// ------------------------------------------------------------------------------------------------ the device rows (pure, from what the browser says)
const FEATS = ['shader-f16', 'subgroups', 'timestamp-query', 'float32-filterable'];
/** the adapter's facts: { vendor, architecture, features, bufMB, bindMB, storageBuffers, wgKB, wgThreads, can: { beam, dgmr, stormscope }, dgmrPrecision } */
export function adapterFacts(ad) {
  if (!ad) return null;
  const i = ad.info || {}, L = ad.limits || {}, has = (f) => !!(ad.features && ad.features.has && ad.features.has(f));
  const bindMB = Math.round((L.maxStorageBufferBindingSize || 0) / MiB), sb = L.maxStorageBuffersPerShaderStage || 0;
  return { vendor: i.vendor || '', architecture: i.architecture || '', features: FEATS.filter(has), f16: has('shader-f16'),
    bufMB: Math.round((L.maxBufferSize || 0) / MiB), bindMB, storageBuffers: sb, wgKB: Math.round((L.maxComputeWorkgroupStorageSize || 0) / 1024), wgThreads: L.maxComputeInvocationsPerWorkgroup || 0,
    can: { beam: true, dgmr: sb >= NEEDS.dgmr.storageBuffers && bindMB >= NEEDS.dgmr.bindMB, stormscope: sb >= NEEDS.stormscope.storageBuffers && bindMB >= NEEDS.stormscope.bindMB },
    dgmrPrecision: bindMB >= NEEDS.dgmr.floatBindMB ? 'float' : 'int8' };
}
export const gpuName = (f) => (f ? [f.vendor, f.architecture].filter(Boolean).join(' ') || 'a WebGPU graphics chip (it gives no name)' : '');
export function gpuRow(f, why = '') {
  if (!f) return { id: 'gpu', verdict: 'fail', lines: [why || 'This browser has no WebGPU: the models cannot run here (Safari on iOS 26 or later, or Chrome on Android 12 or later)'] };
  const lines = [gpuName(f), f.features.length ? `Features: ${f.features.join(', ')}` : 'Features: none of the ones the models use',
    `Limits: largest buffer ${f.bufMB} MB · a binding ${f.bindMB} MB · ${f.storageBuffers} storage buffers a shader · workgroup ${f.wgKB} KB, ${f.wgThreads} threads`];
  const no = [];
  if (!f.can.dgmr) no.push(`DGMR needs ${NEEDS.dgmr.storageBuffers} storage buffers and a ${NEEDS.dgmr.bindMB} MB binding`);
  if (!f.can.stormscope) no.push(`StormScope needs ${NEEDS.stormscope.storageBuffers} storage buffers and a ${NEEDS.stormscope.bindMB} MB binding`);
  if (f.can.dgmr && f.dgmrPrecision === 'int8') lines.push(`DGMR uses its 8-bit model here (its float model binds ${NEEDS.dgmr.floatBindMB} MB at once)`);
  if (no.length) lines.push(`Too small: ${no.join('; ')}`);
  return { id: 'gpu', verdict: no.length ? 'fail' : 'pass', lines };
}
/** 16-bit shaders (the adapter's shader-f16) and the f16 rounding StormScope's own probe chose on its device (its row, when it ran) */
export function f16Row(f, ss = null) {
  if (!f) return { id: 'f16', verdict: 'skip', why: 'needs WebGPU', lines: [] };
  if (!f.f16) return { id: 'f16', verdict: 'slow', lines: ['Not offered here: the models use their 32-bit maths, which is slower'] };
  const lines = ['On: the models use 16-bit maths'];
  const p = ss && ss.f16;
  if (!p) {
    lines.push(!ss ? 'StormScope’s rounding: checked when StormScope runs in the bench' : ss.ran ? 'StormScope’s rounding: not reported' : 'StormScope’s rounding: not checked (StormScope did not run: see its row)');
    return { id: 'f16', verdict: 'pass', lines };
  }
  if (p.error) return { id: 'f16', verdict: 'fail', lines: [...lines, `StormScope’s rounding check did not run: ${String(p.error).slice(0, 120)}`] };
  lines.push(p.mode === 'native' ? 'StormScope’s rounding: native (this chip rounds 16-bit floats the way StormScope was checked with)'
    : p.mode === 'f32' ? 'StormScope’s rounding: 32-bit (no 16-bit shaders on its device)'
    : 'StormScope’s rounding: rne16 (StormScope rounds in its own shaders on this chip: the same numbers, a little more work)');
  return { id: 'f16', verdict: 'pass', lines };
}
/** st: { persisted (bool | null), usage, quota (bytes | null), need (bytes not yet downloaded), needNames, installed } */
export function storageRow(st) {
  if (!st || st.quota == null) return { id: 'storage', verdict: 'skip', why: 'this browser does not say how much room the app has', lines: [] };
  const free = Math.max(0, st.quota - (st.usage || 0)), lines = [];
  lines.push(st.persisted === true ? 'Kept: yes (the browser will not clear the models to make room)'
    : st.persisted === false ? `Kept: not for sure (the browser may clear the models when the phone runs short of space${st.installed ? '' : '; an installed app is usually kept'})`
    : 'Kept: this browser does not say');
  lines.push(`Room: about ${gb(free)} free for the app · it uses ${mb(st.usage || 0)}`);
  const room = free >= (st.need || 0) + LIMITS.roomMB * 1e6;
  if (st.need > 0) lines.push(room ? `Room for ${listWords(st.needNames)} (${mb(st.need)}): yes` : `Not enough room for ${listWords(st.needNames)} (${mb(st.need)} + ${LIMITS.roomMB} MB spare)`);
  else if (!room) lines.push(`Under ${LIMITS.roomMB} MB spare: the forecasts' small files may not fit`);
  return { id: 'storage', verdict: room ? 'pass' : 'fail', lines };
}
/** a model's row from its step's result r (see STEPS) or a reason it was not run */
export function modelRow(id, r) {
  if (!r || r.notRun) return { id, verdict: 'skip', why: (r && r.notRun) || 'not run', lines: [] };
  if (r.stopped) return { id, verdict: 'skip', why: 'stopped', lines: [] };
  if (r.hidden) return { id, verdict: 'skip', why: 'the app went to the background during it (the phone may pause the graphics chip): run the bench again with the app on screen', lines: [] };
  if (r.error) return { id, verdict: 'fail', lines: [`${r.stage === 'load' ? 'Did not load' : r.stage === 'run' ? 'Did not run' : 'Stopped'}: ${String(r.error).slice(0, 160)}`] };
  const lines = [`Load ${secs(r.loadMs)} · first run ${secs(r.coldMs)} · warm run ${secs(r.warmMs)}`], fails = [];
  const tv = timeVerdict(id, r), n = LIMITS.runs[id];
  lines.push(`A forecast’s model work from a cold start: about ${secs(tv.estMs)}${n > 1 ? ` (${n} ${id === 'stormscope' ? 'steps' : 'runs'})` : ''}`);
  const c = r.check || {};
  if (c.nonFinite || c.outside || !(c.same <= SAME[id]) || c.empty) {
    const why = [c.nonFinite ? `${c.nonFinite.toLocaleString('en-US')} numbers not finite` : '', c.outside ? `${c.outside.toLocaleString('en-US')} out of range` : '',
      c.empty ? 'no rain where the made-up storm had it' : '', !(c.same <= SAME[id]) ? `the second run differs by ${Number.isFinite(c.same) ? +c.same.toPrecision(3) : 'a lot'}` : ''].filter(Boolean);
    lines.push(`Output: wrong (${why.join(', ')})`); fails.push('output');
  } else lines.push(`Output: finite, in range, the same both times${c.what ? ` · ${c.what}` : ''}`);
  if (r.released) lines.push(`Graphics memory: ${mb(r.heldBytes)} during the runs, all given back`);
  else { lines.push(`Graphics memory: ${mb(r.afterBytes)} still held after the runs (of ${mb(r.heldBytes)})`); fails.push('memory'); }
  if (r.note) lines.push(r.note);
  const verdict = fails.length ? 'fail' : tv.verdict;
  if (!fails.length && verdict !== 'pass') lines.push(verdict === 'slow' ? `Slow: over ${LIMITS.passS} s, inside its ${LIMITS.clockMin[id]}-minute step` : `Too slow: longer than its ${LIMITS.clockMin[id]}-minute step`);
  return { id, verdict, lines, estMs: tv.estMs };
}
export function totalRow(rows, ms) {
  const ran = rows.filter((r) => r.id !== 'total'), count = (v) => ran.filter((r) => r.verdict === v).length;
  const v = worst(ran.map((r) => r.verdict));
  return { id: 'total', verdict: v, lines: [`${count('pass')} pass · ${count('slow')} slow · ${count('fail')} fail · ${count('skip')} not run · ${secs(ms)} in all`] };
}

// ------------------------------------------------------------------------------------------------ the device line
/** "Safari 26.1 · iOS 26.1 · GPU apple common-3" from the user agent, and its client hints when the browser has them (hi: the
 *  platformVersion it gives on request, on this phone only: Chrome's user agent says "Android 10" on every Android) */
export function deviceLine(ua = '', uaData = null, f = null, hi = null) {
  const m = (re) => { const x = ua.match(re); return x ? x[1] : null; };
  const v = (s) => (s ? s.split('.').slice(0, 2).join('.').replace(/\.0$/, '') : '');
  const major = (s) => v(s).split('.')[0];
  let browser = 'a browser', safari = null;
  if (m(/EdgiOS\/([\d.]+)/)) browser = `Edge ${major(m(/EdgiOS\/([\d.]+)/))}`;
  else if (m(/Edg\/([\d.]+)/)) browser = `Edge ${major(m(/Edg\/([\d.]+)/))}`;
  else if (m(/SamsungBrowser\/([\d.]+)/)) browser = `Samsung Internet ${v(m(/SamsungBrowser\/([\d.]+)/))}`;
  else if (m(/CriOS\/([\d.]+)/)) browser = `Chrome ${major(m(/CriOS\/([\d.]+)/))}`;
  else if (m(/FxiOS\/([\d.]+)/)) browser = `Firefox ${major(m(/FxiOS\/([\d.]+)/))}`;
  else if (m(/Firefox\/([\d.]+)/)) browser = `Firefox ${major(m(/Firefox\/([\d.]+)/))}`;
  else if (m(/Chrome\/([\d.]+)/)) browser = `Chrome ${major(m(/Chrome\/([\d.]+)/))}`;
  else if (m(/Version\/([\d.]+).*Safari/)) { safari = v(m(/Version\/([\d.]+)/)); browser = `Safari ${safari}`; }
  const pv = hi && hi.platformVersion ? String(hi.platformVersion) : '', plat = (uaData && uaData.platform) || '';
  const ios = m(/(?:iPhone|CPU) OS ([\d_]+)/), android = m(/Android ([\d.]+)/);
  let os;
  if (ios) {   // Safari 26 and later keep the user agent's iOS at 18.x: its own version is the system's
    const u = ios.replace(/_/g, '.'), s = safari && parseInt(safari, 10) > parseInt(u, 10) ? safari : u;
    os = `${/iPad/.test(ua) ? 'iPadOS' : 'iOS'} ${s}`;
  } else if (android || plat === 'Android') os = `Android ${pv ? major(pv) : android || ''}`.trim();
  else if (/Windows/.test(ua) || plat === 'Windows') os = pv ? (parseInt(pv, 10) >= 13 ? 'Windows 11' : 'Windows 10') : 'Windows';
  else if (/Mac OS X/.test(ua) || plat === 'macOS') os = pv ? `macOS ${v(pv)}` : 'macOS';
  else os = /CrOS/.test(ua) || plat === 'Chrome OS' ? 'ChromeOS' : /Linux/.test(ua) || plat === 'Linux' ? 'Linux' : plat || 'an unknown system';
  return `${browser} · ${os} · ${f ? 'GPU ' + gpuName(f) : 'no WebGPU'}`;
}

// ------------------------------------------------------------------------------------------------ the model steps (inside the queue)
// Each runs as one 'bench' job: ctx = { engine (the queue's own engine for the model: ww.js), signal (Stop), progress }. A step never
// throws: it returns { loadMs, coldMs, warmMs, check, heldBytes, afterBytes, released, ... } | { error, stage } | { stopped } | { hidden }.
const now = () => (globalThis.performance ? performance.now() : Date.now());
const hiddenNow = () => !!(globalThis.document && document.visibilityState === 'hidden');
function guard(ctx, o) { if ((ctx.signal && ctx.signal.aborted) || (o.signal && o.signal.aborted)) return { stopped: true }; if (o.hidden && o.hidden()) return { hidden: true }; return null; }
const errOf = (e) => String((e && e.message) || e).slice(0, 200);

export const STEPS = {
  /** BEAM: the engine itself (BeamModel.load), never BeamModel.run's saved-stack path: that one shows its maps on the map ('result') */
  async beam(ctx, o) {
    const bm = ctx.engine, phase = o.onPhase || (() => {}); let e = null, stage = 'load', st;
    try {
      bm.unload();   // a cold start: the GPU buffers go (the device stays, as after the queue's own idle unload)
      phase('Loading');
      let t = now(); e = await bm.load(); const loadMs = now() - t;
      if ((st = guard(ctx, o))) { bm.unload(); return st; }
      const stack = new Uint16Array(40 * BEAM_HW); stack.set(o.input, 0); stack.set(e.staticChannels(), 31 * BEAM_HW); stack.fill(0x3c00, 39 * BEAM_HW);   // the pack's 31-38, 39 = 1 (radar seen)
      const heldBytes = e.gpu ? e.gpu.alive : 0;
      stage = 'run'; phase('First run');
      t = now(); const r1 = await e.run(stack, { statics: 'stack', layout: 'chw' }); const coldMs = now() - t;   // the app's own call (run_beam.js)
      if ((st = guard(ctx, o))) { bm.unload(); return st; }
      phase('Warm run');
      t = now(); const r2 = await e.run(stack, { statics: 'stack', layout: 'chw' }); const warmMs = now() - t;
      phase('Checking');
      const n = 12 * BEAM_HW, s = scan(r2.mean, RANGE.beam[0] - 1e-6, RANGE.beam[1] + 1e-6), s1 = scan(r1.mean, RANGE.beam[0] - 1e-6, RANGE.beam[1] + 1e-6);
      const check = { nonFinite: s.nonFinite + s1.nonFinite + (r2.mean.length !== n ? 1 : 0), outside: s.outside + s1.outside, same: maxDiff(r1.mean, r2.mean), what: '12 maps (4 hazards x 3 half-hours)' };
      stage = 'free'; bm.unload();
      const afterBytes = e.gpu ? e.gpu.alive : 0;
      return { loadMs, coldMs, warmMs, check, heldBytes, afterBytes, released: afterBytes === 0, note: e.gpu && !e.gpu.f16 ? 'Maths: 32-bit (no 16-bit shaders here)' : '' };
    } catch (x) { try { bm.unload(); } catch (y) { /* */ } return hiddenNow() ? { hidden: true } : { error: errOf(x), stage }; }
  },
  /** DGMR: the queue loaded it before the job; it is let go and loaded again so its load is timed */
  async dgmr(ctx, o) {
    const eng = ctx.engine, phase = o.onPhase || (() => {}); let stage = 'load', st;
    try {
      eng.unload(); phase('Loading');
      let t = now(); const li = await eng.load(); const loadMs = now() - t;
      if ((st = guard(ctx, o))) { eng.unload(); return st; }
      const heldBytes = eng.gpu ? eng.gpu.alive : 0;
      stage = 'run'; phase('First run');
      t = now(); const r1 = await eng.nowcast(o.input, { members: 1, seed: 1 }); const coldMs = now() - t;
      if ((st = guard(ctx, o))) { eng.unload(); return st; }
      phase('Warm run');
      t = now(); const r2 = await eng.nowcast(o.input, { members: 1, seed: 1 }); const warmMs = now() - t;
      phase('Checking');
      const a = r1.frames[0], b = r2.frames[0], s = scan(b, RANGE.dgmr[0], RANGE.dgmr[1]), s1 = scan(a, RANGE.dgmr[0], RANGE.dgmr[1]);
      const check = { nonFinite: s.nonFinite + s1.nonFinite + (b.length !== 18 * 65536 ? 1 : 0), outside: s.outside + s1.outside, empty: !(s.max >= 0.1), same: maxDiff(a, b), what: '18 frames of rain, +5 to +90 min' };
      stage = 'free'; eng.unload();
      const afterBytes = eng.gpu ? eng.gpu.alive : 0;
      return { loadMs, coldMs, warmMs, check, heldBytes, afterBytes, released: afterBytes === 0, note: `Model: ${li && li.precision === 'int8' ? '8-bit' : 'float (16-bit weights)'}` };
    } catch (x) { try { eng.unload(); } catch (y) { /* */ } return hiddenNow() ? { hidden: true } : { error: errOf(x), stage }; }
  },
  /** StormScope: one ten-minute step (7 network passes) is one run; its own forecast() is stopped after its first step */
  async stormscope(ctx, o) {
    const eng = ctx.engine, phase = o.onPhase || (() => {}); let stage = 'load', st, m = null;
    try {
      const { loadGrid } = await import('./stormscope/prep/grid.js');
      const grid = await eng.grid(loadGrid), rope = grid.rope(o.input.H / 4, o.input.W / 4), N = grid.json.norm;
      const prep = { cond: o.input.cond, latents: o.input.latents, valid: o.input.valid, cz: o.input.cz, mean: N.state_means.slice(0, 2), std: N.state_stds.slice(0, 2) };
      eng.unload(); phase('Loading');
      let t = now(); await eng.load({ rope_cos: rope.cos, rope_sin: rope.sin }, { H: o.input.H, W: o.input.W }); const loadMs = now() - t;
      m = eng.model;
      if ((st = guard(ctx, o))) { eng.unload(); return st; }
      const heldBytes = m.bytes;
      let f16 = { mode: m.f16Mode };
      if (eng.gpu && eng.gpu.f16) { const { probeF16Rounding } = await import('./stormscope/ss.js'); f16 = await probeF16Rounding(eng.gpu.device); }   // the load's own probe (one a device): no new GPU work
      stage = 'run'; phase('First step');
      const one = async () => {
        const ac = new AbortController(); let got = null;
        try { await eng.forecast(prep, { signal: ac.signal, onStep: (k, out, ms) => { got = { out, ms }; ac.abort(); } }); } catch (e) { if (!got || !(e && e.name === 'AbortError')) throw e; }
        return got;
      };
      const a = await one(); const coldMs = a.ms;
      if ((st = guard(ctx, o))) { eng.unload(); return st; }
      phase('Warm step');
      const b = await one(); const warmMs = b.ms;
      phase('Checking');
      const HW = o.input.H * o.input.W, dbz = new Float32Array(2 * HW);
      for (let v = 0; v < 2; v++) for (let i = 0; i < HW; i++) dbz[v * HW + i] = b.out[v * HW + i] * prep.std[v] + prep.mean[v];
      const s = scan(dbz, RANGE.ssDbz[0], RANGE.ssDbz[1]), l = scan(b.out, RANGE.ssLight[0], RANGE.ssLight[1], 2 * HW, 3 * HW), s1 = scan(a.out, -1e6, 1e6);
      const check = { nonFinite: s.nonFinite + l.nonFinite + s1.nonFinite + (b.out.length !== 3 * HW ? 1 : 0), outside: s.outside + l.outside, same: maxDiff(a.out, b.out), what: 'radar and lightning on a 204 x 204 tile' };
      stage = 'free'; eng.unload();
      const afterBytes = (m.bytes || 0) + ((m.all && m.all.length) ? 1 : 0) + (eng.gpu ? eng.gpu.alive : 0);
      return { loadMs, coldMs, warmMs, check, heldBytes, afterBytes, released: afterBytes === 0 && !eng.model, f16: { mode: f16.mode, error: f16.error || null }, ran: true };
    } catch (x) { try { eng.unload(); } catch (y) { /* */ } return hiddenNow() ? { hidden: true } : { error: errOf(x), stage, ran: true }; }
  },
};
export const INPUTS = { beam: () => beamInput(), dgmr: () => dgmrInput(), stormscope: () => ssInput() };

// ------------------------------------------------------------------------------------------------ the run
const call = (f, ...a) => { try { return typeof f === 'function' ? f(...a) : undefined; } catch (e) { return undefined; } };
/** a model hook's state for the bench: 'ready' | 'downloading' | 'absent' (not downloaded) | 'unlisted' (not in this build) */
export function modelState(hook) {
  const s = (hook && call(hook.status)) || {};
  if (s.downloading) return 'downloading';
  if (s.ready) return 'ready';
  return hook && typeof hook.download === 'function' ? 'absent' : 'unlisted';
}
/**
 * env: { gpu (navigator.gpu), storage (navigator.storage), ua, uaData, version, installed(), models: { id: hook }, step(model, fn, { signal }),
 *        hidden(), inputs (tests: { id: () => input }) }
 * o: { only: [row ids] (tests, desk runs), signal (Stop), onUpdate(result) }
 * -> { t, version, device, rows: [{ id, name, verdict, why?, lines }], ms, done, stopped }
 */
export async function runBench(env, o = {}) {
  const t0 = now(), want = (id) => !o.only || o.only.includes(id), models = env.models || {};
  const res = { v: 1, t: Date.now(), version: env.version || '', device: '', rows: ORDER.filter(want).map((id) => ({ id, verdict: 'wait', lines: [] })), ms: 0, done: false, running: null };
  const set = (row) => { const i = res.rows.findIndex((r) => r.id === row.id); if (i >= 0) res.rows[i] = Object.assign({ name: NAMES[row.id] }, row); };
  const tell = () => { for (const r of res.rows) r.name = NAMES[r.id]; call(o.onUpdate, res); };
  const stopped = () => !!(o.signal && o.signal.aborted);
  // the graphics chip: the adapter the models get (high-performance, as the engines ask); no device is made here
  let ad = null, why = '';
  try { if (env.gpu) ad = await env.gpu.requestAdapter({ powerPreference: 'high-performance' }); if (env.gpu && !ad) why = 'This browser has WebGPU but gave no graphics chip (an adapter): the models cannot run here'; } catch (e) { why = `WebGPU did not answer: ${errOf(e)}`; }
  const F = adapterFacts(ad);
  let hi = null;
  try { if (env.uaData && env.uaData.getHighEntropyValues) hi = await env.uaData.getHighEntropyValues(['platformVersion']); } catch (e) { hi = null; }   // asked of the browser, on this phone
  res.device = deviceLine(env.ua || '', env.uaData || null, F, hi); res.gpu = F ? gpuName(F) : '';
  if (want('gpu')) set(gpuRow(F, why));
  if (want('f16')) set(f16Row(F, null));
  tell();
  if (want('storage')) {
    let st = null;
    try {
      const S = env.storage, est = S && S.estimate ? await S.estimate() : null, persisted = S && S.persisted ? await S.persisted() : null;
      const absent = MODEL_IDS.filter((id) => modelState(models[id]) === 'absent' && (!F || F.can[id]));
      const need = absent.reduce((s, id) => s + (call(models[id].size) || 0), 0);
      st = est ? { persisted, usage: est.usage || 0, quota: est.quota == null ? null : est.quota, need, needNames: absent.map((id) => NAMES[id]), installed: !!call(env.installed) } : null;
    } catch (e) { st = null; }
    set(storageRow(st)); tell();
  }
  let ss = null;
  for (const id of MODEL_IDS) {
    if (!want(id)) continue;
    let r;
    const state = modelState(models[id]);
    if (stopped()) r = { stopped: true };
    else if (!F) r = { notRun: 'needs WebGPU' };
    else if (!F.can[id]) r = { notRun: 'this graphics chip’s limits are too small for it (see WebGPU)' };
    else if (state === 'unlisted') r = { notRun: 'not in this build of the app' };
    else if (state === 'absent') r = { notRun: `not on this phone (Settings › ${NAMES[id]} downloads it)` };
    else if (state === 'downloading') r = { notRun: 'still downloading: run the bench when it is done' };
    else {
      res.running = id; set({ id, verdict: 'run', lines: ['Waiting its turn'] }); tell();
      const input = ((env.inputs && env.inputs[id]) || INPUTS[id])();
      const onPhase = (p) => { set({ id, verdict: 'run', lines: [p] }); tell(); };
      const hid0 = { n: 0 }, onVis = () => { if (hiddenNow()) hid0.n++; };
      if (globalThis.document && document.addEventListener) document.addEventListener('visibilitychange', onVis);
      try {
        r = await env.step(id, (ctx) => STEPS[id](ctx, { input, onPhase, signal: o.signal, hidden: () => hid0.n > 0 || (env.hidden ? env.hidden() : hiddenNow()) }), { signal: o.signal });
      } catch (e) { r = { error: errOf(e), stage: 'run' }; }
      finally { if (globalThis.document && document.removeEventListener) document.removeEventListener('visibilitychange', onVis); }
      if (r && r.notDownloaded) r = { notRun: `not on this phone (Settings › ${NAMES[id]} downloads it)` };
      if (r && hid0.n && !r.stopped && !r.error) r = { hidden: true };
      res.running = null;
    }
    if (id === 'stormscope') ss = r;
    set(modelRow(id, r));
    if (want('f16') && id === 'stormscope') set(f16Row(F, ss && ss.ran ? ss : { ran: false }));
    tell();
  }
  res.ms = now() - t0; res.stopped = stopped(); res.done = true; res.running = null;
  if (want('total')) set(totalRow(res.rows, res.ms));
  tell();
  return res;
}

// ------------------------------------------------------------------------------------------------ the text (Copy / Share)
const LABEL = { pass: 'PASS', slow: 'SLOW', fail: 'FAIL', skip: 'NOT RUN', wait: 'WAITING', run: 'RUNNING' };
export function rulesText() {
  return `Pass: a forecast's model work from a cold start in ${LIMITS.passS} s or less. Slow: longer, but inside its clock step (DGMR ${LIMITS.clockMin.dgmr} min, BEAM and StormScope ${LIMITS.clockMin.beam} min). Fail: past that, or it did not load or run, its output was wrong, or it kept graphics memory.`;
}
export function benchText(res) {
  const d = new Date(res.t), pad = (x) => String(x).padStart(2, '0');
  const when = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const L = ['Wallowa Weather · bench test', `${res.version || 'Wallowa Weather'} · ${when}`, `Device: ${res.device}`, ''];
  for (const r of res.rows) {
    const body = r.verdict === 'skip' ? (r.why || '') : r.lines.join('; ');
    L.push(`${LABEL[r.verdict] || r.verdict}  ${NAMES[r.id]}${body ? ': ' + body : ''}`);
  }
  L.push('', rulesText(), 'Made-up storm (the same every time), the models already on this phone; nothing was downloaded or sent.');
  return L.join('\n');
}

// ------------------------------------------------------------------------------------------------ the page (Settings › Bench test)
let cssOn = false;
function loadCss(doc) {
  if (cssOn || !doc || !doc.head) return; cssOn = true;
  const l = doc.createElement('link'); l.rel = 'stylesheet'; l.href = new URL('./bench.css', import.meta.url).href; doc.head.append(l);
}
const lsGet = () => { try { const v = localStorage.getItem(BENCH_KEY); return v ? JSON.parse(v) : null; } catch (e) { return null; } };
const lsSet = (v) => { try { localStorage.setItem(BENCH_KEY, JSON.stringify(v)); } catch (e) { /* the card still shows */ } };
/** the run going on in this page (the page can be left and opened again while it runs) */
const LIVE = { res: null, ac: null, views: new Set() };
/** a saved result whose run never finished (the page ended: the phone ran out of memory, or the app was closed) -> the row it was on fails */
export function settle(saved) {
  if (!saved || saved.done) return saved;
  const r = JSON.parse(JSON.stringify(saved)), at = r.running;
  for (const row of r.rows) {
    if (row.id === at) Object.assign(row, { verdict: 'fail', lines: ['The page stopped during this row (the phone may have run out of memory, or the app was closed)'] });
    else if (row.verdict === 'wait' || row.verdict === 'run') Object.assign(row, { verdict: 'skip', why: 'the bench stopped before it', lines: [] });
  }
  r.done = true; r.running = null; r.ended = true;
  const i = r.rows.findIndex((x) => x.id === 'total');
  if (i >= 0) r.rows[i] = Object.assign({ name: NAMES.total }, totalRow(r.rows, r.ms || 0));
  return r;
}
/** about how long the bench takes before it has run here: up to a minute a model (the Pass bound) + a few seconds; afterwards: this phone's own last time */
export function etaWords(env, last) {
  const n = MODEL_IDS.filter((id) => modelState((env.models || {})[id]) === 'ready').length;
  if (last && last.done && !last.ended && last.ms > 0) return `about ${secs(last.ms)}, as last time on this phone`;
  return n ? `up to about ${n} minute${n > 1 ? 's' : ''} (${n} model${n > 1 ? 's' : ''})` : 'a few seconds (no model is on this phone yet)';
}

export function fillBench(el, env = {}) {
  const doc = env.doc || el.ownerDocument || document;
  loadCss(doc);
  const mk = (tag, cls, text) => { const e = doc.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  const btn = (cls, text) => { const b = mk('button', cls, text); b.type = 'button'; return b; };
  const root = mk('div', 'bt'); el.append(root);
  const ready = MODEL_IDS.filter((id) => modelState((env.models || {})[id]) === 'ready').map((id) => NAMES[id]);
  const note = mk('p', 'bt-note'), run = btn('nc-btn bt-go', 'Run the bench'), stop = btn('nc-btn ghost bt-go', 'Stop'), card = mk('div', 'bt-card');
  stop.hidden = true; card.hidden = true;
  const paintNote = () => {
    note.textContent = ready.length
      ? `Checks the graphics chip and storage, then runs the models already on this phone (${listWords(ready)}) once from a cold start and once warm, on a made-up storm that is the same every time. Takes ${etaWords(env, lsGet())}. Best plugged in. Wi-Fi is not needed: nothing is downloaded or sent.`
      : `Checks the graphics chip and storage. No model is on this phone yet: download one in Settings to time it here. Takes a few seconds. Wi-Fi is not needed: nothing is downloaded or sent.`;
  };
  paintNote();
  root.append(note, run, stop, card);
  const view = { paint: (res) => paintCard(res) };
  function paintCard(res) {
    if (root.isConnected === false) { LIVE.views.delete(view); return; }
    const going = !!(LIVE.res && LIVE.res === res && !res.done);
    run.hidden = going; stop.hidden = !going; run.textContent = res ? 'Run the bench again' : 'Run the bench';
    if (!res) { card.hidden = true; return; }
    card.hidden = false; card.textContent = '';
    const top = mk('div', 'bt-head'), d = new Date(res.t);
    top.append(mk('b', 'bt-title', going ? 'Bench test · running' : res.ended ? 'Bench test · stopped early' : 'Bench test'),
      mk('span', 'bt-when', d.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })));
    card.append(top, mk('p', 'bt-dev', res.device || ''));
    const ul = mk('ul', 'bt-rows');
    for (const r of res.rows) {
      const li = mk('li', 'bt-row bt-' + r.verdict); li.dataset.row = r.id;
      const v = mk('span', 'bt-v', WORDS[r.verdict] || r.verdict), t = mk('div', 'bt-t');
      t.append(mk('b', 'bt-n', NAMES[r.id]));
      if (r.verdict === 'skip' && r.why) t.append(mk('span', 'bt-l', r.why));
      for (const line of r.lines || []) t.append(mk('span', 'bt-l', line));
      li.append(v, t); ul.append(li);
    }
    card.append(ul, mk('p', 'bt-ver', res.version || ''));
    if (res.done) {
      const text = benchText(res), btns = mk('div', 'bt-btns'), copy = btn('nc-btn ghost sm', 'Copy');
      copy.addEventListener('click', async () => {
        try { await navigator.clipboard.writeText(text); call(env.toast, 'Copied.'); } catch (e) { call(env.toast, 'Copy did not work: select the text below instead.'); pre.parentElement.open = true; }
      });
      btns.append(copy);
      if (globalThis.navigator && navigator.share) {
        const sh = btn('nc-btn ghost sm', 'Share');
        sh.addEventListener('click', () => { navigator.share({ title: 'Wallowa Weather bench test', text }).catch(() => {}); });
        btns.append(sh);
      }
      const det = mk('details', 'bt-text'), pre = mk('pre', 'bt-pre', text); det.append(mk('summary', null, 'The text'), pre);
      card.append(btns, det, mk('p', 'bt-fine', rulesText()), mk('p', 'bt-fine', 'The card stays on this phone. Copy or Share sends it only where you choose.'));
    }
  }
  run.addEventListener('click', () => start());
  stop.addEventListener('click', () => { if (LIVE.ac) LIVE.ac.abort(); stop.disabled = true; stop.textContent = 'Stopping…'; });
  async function start() {
    if (LIVE.res && !LIVE.res.done) return;
    const ac = new AbortController(); LIVE.ac = ac; stop.disabled = false; stop.textContent = 'Stop';
    let lock = null;
    try { if (navigator.wakeLock) lock = await navigator.wakeLock.request('screen'); } catch (e) { lock = null; }   // the screen stays on (a locked phone pauses the graphics chip)
    const benv = Object.assign({ gpu: (globalThis.navigator && navigator.gpu) || null, storage: (globalThis.navigator && navigator.storage) || null,
      ua: (globalThis.navigator && navigator.userAgent) || '', uaData: (globalThis.navigator && navigator.userAgentData) || null }, env);
    try {
      const res = await runBench(benv, { signal: ac.signal, onUpdate: (r) => { LIVE.res = r; lsSet(r); for (const v of LIVE.views) v.paint(r); } });
      LIVE.res = res; lsSet(res);
      call(env.diag, 'bench test', { device: res.device, ms: Math.round(res.ms), rows: res.rows.map((r) => `${r.id}:${r.verdict}`).join(' '), stopped: !!res.stopped });
      if (root.isConnected === false) call(env.toast, 'The bench test is done: Settings › Bench test has the card.');
    } catch (e) {
      call(env.diag, 'bench test', { message: errOf(e) }); call(env.toast, `The bench test stopped: ${errOf(e).slice(0, 90)}`);
      if (LIVE.res) { LIVE.res = settle(Object.assign({}, LIVE.res, { done: false })); lsSet(LIVE.res); }
    } finally {
      try { if (lock) lock.release(); } catch (e) { /* */ }
      LIVE.ac = null; paintNote();
      for (const v of LIVE.views) v.paint(LIVE.res);
    }
  }
  LIVE.views.add(view);
  const saved = LIVE.res || settle(lsGet());
  if (saved && saved !== LIVE.res && saved.ended) lsSet(saved);
  paintCard(saved || null);
  return { start, stop: () => { if (LIVE.ac) LIVE.ac.abort(); }, get result() { return LIVE.res || saved || null; }, root };
}
/** tests: forget the run held by this page */
export function _reset() { LIVE.res = null; LIVE.ac = null; LIVE.views.clear(); cssOn = false; }
