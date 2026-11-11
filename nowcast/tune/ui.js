// nowcast/tune/ui.js - Settings > Speed tune: what the tune is, a Tune now button for the models on this phone, its progress (Stop keeps
// the kernels already done), the result in plain sentences worked out from the timings, and "Use the standard kernels". The tune runs
// with the graphics chip to itself: the forecast queue waits and every model lets go of its GPU memory first (env.quiet), and the
// models load the new table by themselves the next time they run. Built from the Settings sheet's own classes (settings.css).
//   SETTINGS.tune = speedTuneHooks({ version, diag, ready: { beam, stormscope, dgmr }: () -> bool, dgmrPrecision() -> 'float' | 'int8',
//                                    dgmrSpec() -> Promise<model JSON | null>, quiet() -> Promise (queue held, models unloaded), resume() })
'use strict';
import { setTuneApp, tuneState, runSpeedTune, resetTune, MODEL_NAMES } from './tune.js';

const ORDER = ['beam', 'stormscope', 'dgmr'];
const call = (f, ...a) => { try { return typeof f === 'function' ? f(...a) : undefined; } catch (e) { return undefined; } };
const list = (names) => (names.length < 2 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`);
const day = (t) => { try { return new Date(t).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }); } catch (e) { return ''; } };

/** the saved record's lines (Settings, between tunes) */
export function savedLines(rec) {
  const out = [];
  for (const m of ORDER) {
    const r = rec && rec.report && rec.report[m]; if (!r || !r.done) continue;
    const p = Math.round((r.gain || 0) * 100), part = r.partial ? ' (tuned in part)' : '';
    out.push(p >= 2 ? `${MODEL_NAMES[m]}: about ${p}% faster${part}.` : `${MODEL_NAMES[m]}: the standard kernels are the fastest here${part}.`);
  }
  return out;
}
/** the state sentence above the button */
export function stateLine(st, rec) {
  if (st === 'ok') return `Tuned for this phone${rec && rec.at ? ` on ${day(rec.at)}` : ''}.`;
  if (st === 'app') return 'The last tune was for an older version of the app, so the models use their standard kernels until you tune again.';
  if (st === 'device') return 'The last tune was for another graphics chip or browser, so the models use their standard kernels until you tune again.';
  return 'Not tuned yet: the models use their standard kernels.';
}

export function speedTuneHooks(env = {}) {
  setTuneApp(env.version);
  const S = { run: null, last: null, state: 'none', rec: null, paint: null }, run = env.run || runSpeedTune;   // env.run: tests
  const log = (n, d) => { try { if (env.diag) env.diag(n, d); } catch (e) { /* */ } };
  const ready = () => ORDER.filter((m) => !!call(env.ready && env.ready[m]));
  const refreshState = async () => { try { const s = await tuneState(); S.state = s.state; S.rec = s.rec; } catch (e) { S.state = 'none'; } if (S.paint) S.paint(); };
  refreshState();

  async function start() {
    if (S.run) return;
    const ctl = new AbortController();
    S.run = { ctl, text: 'Getting the graphics chip ready…', frac: 0 }; S.last = null; if (S.paint) S.paint();
    let wake = null;
    try { if (navigator.wakeLock) wake = await navigator.wakeLock.request('screen'); } catch (e) { wake = null; }
    try {
      await call(env.quiet);
      const models = {}, skipped = {};
      for (const m of ready()) {
        if (m !== 'dgmr') { models[m] = true; continue; }
        const p = await call(env.dgmrPrecision);
        if (p === 'int8') { skipped.dgmr = 'it uses its small 8-bit model on this phone, which has no other kernels to try yet'; continue; }
        const spec = await call(env.dgmrSpec);
        if (spec) models.dgmr = spec; else skipped.dgmr = 'its model file could not be read';
      }
      const r = await run({ models, skipped, signal: ctl.signal, onProgress: (p) => {
        if (!S.run) return;
        if (p.model) S.run.text = `${MODEL_NAMES[p.model] || p.model} · kernel ${p.unit} of ${p.of}${p.ways > 1 ? ` · trying ${p.ways} ways` : ''}`;
        S.run.frac = p.frac || 0; if (S.paint) S.paint();
      } });
      S.last = { lines: r.lines };
      log('speed tune', { gpu: r.gpu, seconds: Math.round(r.res.ms / 1000), stopped: r.res.stopped,
        models: Object.fromEntries(Object.entries(r.res.models).map(([m, x]) => [m, { gain: +x.gain.toFixed(3), done: x.done, of: x.of, changed: Object.keys(r.res.picks[m] || {}).length }])),
        skipped: r.skipped });
    } catch (e) {
      const msg = String((e && e.message) || e).slice(0, 140);
      S.last = { lines: [`The speed tune stopped: ${msg}. The models keep the kernels they had.`], error: true };
      log('speed tune failed', { message: msg, code: (e && e.code) || null });
    } finally {
      S.run = null; try { if (wake) await wake.release(); } catch (e) { /* */ }
      call(env.resume); await refreshState();
    }
  }
  async function reset() {
    resetTune(); S.last = { lines: ['The models use their standard kernels again.'] };
    log('speed tune reset');
    try { await call(env.quiet); } finally { call(env.resume); }   // a model already loaded lets go, so its next run loads the standard kernels
    await refreshState();
  }

  /** the page (settings.js PAGES.tune) */
  function build(el, { doc = document } = {}) {
    const mk = (tag, cls, text) => { const e = doc.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
    const btn = (cls, text) => { const b = mk('button', cls, text); b.type = 'button'; return b; };
    el.append(mk('p', 'st-note st-tight', 'The speed tune tries a few other ways of running each model’s heaviest maths on this phone’s graphics chip, keeps the quickest way that gives exactly the same numbers, and the models use it from then on. It takes about a minute: keep the app open. Nothing is downloaded and nothing leaves the phone.'));
    const card = mk('div', 'st-card st-tune'), stEl = mk('p', 'st-stat'), bar = mk('div', 'st-bar'), barI = mk('i'), msg = mk('div', 'st-msg'), btns = mk('div', 'st-btns');
    bar.append(barI); card.append(stEl, bar, msg, btns); el.append(card);
    const which = mk('p', 'st-note'); el.append(which);
    el.append(mk('p', 'st-note', 'Every way it keeps gives the same numbers as the standard one, bit for bit, so the forecasts do not change. The speed-ups are estimates from timing each model’s heaviest steps at their real sizes on this phone.'));
    let kind = null;
    const paint = () => {
      if (el.isConnected === false) { if (S.paint === paint) S.paint = null; return; }
      const r = ready(), names = r.map((m) => MODEL_NAMES[m]);
      if (S.run) { stEl.textContent = 'Tuning…'; stEl.className = 'st-stat'; }
      else { stEl.textContent = stateLine(S.state, S.rec); stEl.className = 'st-stat' + (S.state === 'ok' ? ' st-k-ready' : ''); }
      bar.hidden = !S.run; barI.style.transform = `scaleX(${Math.max(0.02, Math.min(1, (S.run && S.run.frac) || 0))})`;
      msg.textContent = '';
      const lines = S.run ? [S.run.text] : S.last ? S.last.lines : S.state === 'ok' ? savedLines(S.rec) : [];
      for (const t of lines) msg.append(mk('p', 'st-tune-l', t));
      msg.hidden = !lines.length;
      which.textContent = names.length ? `It runs for the models on this phone: ${list(names)}.` : 'Download a forecast model first: the tune runs for the models on this phone.';
      const k = (S.run ? 'run' : 'idle') + (S.rec ? ':rec' : '') + (names.length ? ':m' : '');
      if (k === kind) return; kind = k; btns.textContent = '';
      if (S.run) { const b = btn('nc-btn ghost', 'Stop'); b.addEventListener('click', () => { b.disabled = true; b.textContent = 'Stopping…'; S.run && S.run.ctl.abort(); }); btns.append(b); return; }
      const go = btn('nc-btn', S.rec ? 'Tune again' : 'Tune now'); go.disabled = !names.length; go.addEventListener('click', () => { start(); }); btns.append(go);
      if (S.rec) { const rs = btn('nc-btn ghost', 'Use the standard kernels'); rs.addEventListener('click', () => { reset(); }); btns.append(rs); }
    };
    S.paint = paint; paint();
    return { paint };
  }
  return {
    sub: 'Make the forecasts run faster on this phone',
    value: () => (S.run ? 'Tuning…' : S.state === 'ok' ? 'Tuned' : ''),
    build, start, reset, get running() { return !!S.run; }, _state: S,
  };
}
