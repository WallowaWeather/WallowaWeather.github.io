// Part of BEAM's phone code (kept identical to BEAM's own build).
// js/runner/builders.js - the four BEAM input builders behind one call, the same in a worker and on the page: runBuilder(name, t0,
// opts, env) runs buildRadar / buildGLM / buildABI / buildHRRR with the shared metered fetch and cache, and returns the builder's
// result trimmed to what the runner uses, with this build's own request and byte counts (from the metered fetch).
'use strict';
import { buildRadar } from '../inputs/radar/radar.js';
import { buildGLM } from '../inputs/glm/glm.js';
import { buildABI } from '../inputs/abi/abi.js';
import { buildHRRR } from '../inputs/hrrr/hrrr.js';

export const NAMES = ['radar', 'glm', 'abi', 'hrrr'];
export const CHANNELS = {
  radar: [0, 1, 2, 3, 4, 5, 6, 7, 8, 12, 13],
  glm: [9, 10, 11],
  abi: [25, 26, 27, 28],
  hrrr: [14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 29, 30],
};

let seq = 0;
const clock = () => (globalThis.performance || Date).now();

/**
 * name: 'radar' | 'glm' | 'abi' | 'hrrr'.  t0: Date | ms (a 10-minute mark).
 * opts: plain data, per builder: radar { concurrency }, hrrr { envHour, envAnchor, envStep, fallback, concurrency }, all { now }.
 * env: { fetch (meteredFetch), cache, signal }.
 * -> { name, ch, ok, missing, urls (count), bytes (builder's own count), net: { requests, bytes }, ms, extra: {...} }
 */
export async function runBuilder(name, t0, opts = {}, env = {}) {
  const T0 = new Date(+t0), tag = `${name}#${++seq}`, f = env.fetch && env.fetch.tagged ? env.fetch.tagged(tag) : env.fetch;
  const base = { fetch: f, cache: env.cache || undefined, signal: env.signal };
  if (opts.now != null) base.now = +opts.now;
  const t = clock();
  let r;
  if (name === 'radar') r = await buildRadar(T0, { ...base, concurrency: opts.concurrency || 2 });
  else if (name === 'glm') r = await buildGLM(T0, base);
  else if (name === 'abi') r = await buildABI(T0, base);
  else if (name === 'hrrr') {
    const o = { ...base, concurrency: opts.concurrency || 4, fallback: opts.fallback ?? 1 };
    for (const k of ['envHour', 'envAnchor']) if (opts[k] != null) o[k] = new Date(opts[k]);
    if (opts.envStep) o.envStep = opts.envStep;
    delete o.now;
    r = await buildHRRR(T0, o);
  } else throw new Error('unknown builder ' + name);
  const ms = clock() - t;
  const m = env.fetch && env.fetch.meter ? env.fetch.meter.byTag[tag] : null;
  if (env.fetch && env.fetch.meter) delete env.fetch.meter.byTag[tag];
  const extra = {};
  if (name === 'radar') { extra.files = r.files; extra.stats = r.stats; }
  if (name === 'glm') { extra.frames = r.frames; extra.ready_at = r.ready_at; extra.filesRead = r.files.length; extra.how = [...new Set(r.files.map((x) => x.how))]; }
  if (name === 'abi') extra.scans = r.scans;
  if (name === 'hrrr') { extra.cycles = r.cycles; extra.degraded = r.degraded; extra.cachedBytes = r.cachedBytes; extra.fields = Object.fromEntries(Object.entries(r.fields).map(([c, x]) => [c, { v: x.v, file: x.file, tpl: x.tpl, partial: x.partial }])); }
  return { name, ch: r.ch, ok: r.ok, missing: r.missing, urls: r.urls.length, bytes: r.bytes, net: m || { requests: 0, bytes: 0 }, ms: Math.round(ms), extra };
}

/** the Float32Array buffers of a result, for postMessage transfer */
export const transfers = (res) => Object.values(res.ch || {}).map((a) => a.buffer);
