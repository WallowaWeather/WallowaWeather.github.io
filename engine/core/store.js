// Wallowa Weather's model pack store: each model's pack downloads once (HTTP Range requests, resumable, every 16 MiB chunk's SHA-256
// checked with the browser's WebCrypto against the pinned manifest), is kept in this site's private storage (OPFS) and is read back
// from there: whole small files (readFile), or a shard streamed into a NEW GPU buffer with queue.writeBuffer (upload).
'use strict';
import { fetchManifest, manifestRefused, pinnedCopy } from './pin.js';   // pinned manifests
// a load waits for the GPU after every UPCAP bytes it writes: queue.writeBuffer copies into Safari's GPU process, which otherwise holds a
// whole model's weights until the copies run. Bounded, the GPU process holds ~64 MB of weights in flight.
const UPCAP = 64 * 1024 * 1024;
// the format name in every published pack's manifest.json (fixed: the manifests are pinned by their sha256 in config.js)
const PACK_FORMAT = 'pocketflux.pack';

export class Storage {
  constructor(url) { this.url = url || new URL('./opfs_worker.js', import.meta.url); this.id = 0; this.pend = new Map(); }
  async start() {
    if (this.closing) await this.closing;   // a retiring worker lets go of its file handles first
    if (this.w) return;
    const w = this.w = new Worker(this.url, { type: 'module' });
    w.onmessage = (ev) => { const m = ev.data; const p = this.pend.get(m.id); if (!p) return; this.pend.delete(m.id); m.error ? p.rej(new Error(m.error)) : p.res(m.result); if (!this.pend.size && this.w === w) this._idle(); };
    w.onerror = (e) => { for (const p of this.pend.values()) p.rej(new Error('storage worker error: ' + (e.message || e))); this.pend.clear(); };
    const r = await this.call('hello');
    if (!r.sync) throw new Error('OPFS sync access handles are not available');
  }
  call(op, args = {}, transfer = []) {
    if (this.idleT) { clearTimeout(this.idleT); this.idleT = null; }
    if (!this.w) return this.start().then(() => this.call(op, args, transfer));   // retired while idle: a new worker
    return new Promise((res, rej) => { const id = ++this.id; this.pend.set(id, { res, rej }); this.w.postMessage(Object.assign({ id, op }, args), transfer); });
  }
  /** idle for `idleMs` (20 s; 0 = never) -> close every file handle, terminate the worker (WebKit: a thread + a JS VM each) */
  _idle() {
    const ms = this.idleMs != null ? this.idleMs : 20000; if (!ms) return;
    if (this.idleT) clearTimeout(this.idleT);
    this.idleT = setTimeout(() => {
      this.idleT = null; const w = this.w; if (!w || this.pend.size) return;
      this.w = null;
      this.closing = new Promise((res) => {
        const id = ++this.id, end = () => { clearTimeout(to); try { w.terminate(); } catch (e) { /* */ } res(); }, to = setTimeout(end, 3000);
        this.pend.set(id, { res: end, rej: end }); w.postMessage({ id, op: 'closeAll' });
      }).then(() => { this.closing = null; });
    }, ms);
  }
}

const hex = (ab) => Array.from(new Uint8Array(ab), (b) => b.toString(16).padStart(2, '0')).join('');

export class WeightStore {
  /** gpu: core Gpu (set before upload); opts: {base: URL of the pack directory (manifest.json lives there), dir: its OPFS folder} */
  constructor(gpu, opts) {
    this.gpu = gpu; this.base = opts.base.endsWith('/') ? opts.base : opts.base + '/';
    this.dir = opts.dir; this.st = new Storage();
    this.pool = [];
  }
  async open() {
    await this.st.start();
    let m = null;
    // the manifest is used and kept only when it matches config.js (its exact bytes are kept); offline or refused: the stored copy.
    // A phone that already has the pack asks the server for at most 6 s, then uses its own copy (a bad or captive network, or a server
    // out of reach, never stalls a model that is on the phone)
    const path = `${this.dir}/manifest.json`, have = (await this.st.call('size', { name: path })).size > 0;
    // Josh, v018: the list kept here matches this version's pin -> used without asking the server (models change only with the app)
    if (have) {
      const sz = (await this.st.call('size', { name: path })).size, r = await this.st.call('read', { name: path, at: 0, len: sz });
      const kept = await pinnedCopy(this.base, new Uint8Array(r.buf, 0, sz));
      if (kept && kept.format === PACK_FORMAT && kept.format_version === 1) {
        this.m = kept; this.shards = new Map(kept.shards.map((s) => [s.name, s])); this.state = await this._loadState(); return kept;
      }
    }
    const got = await fetchManifest(this.base, have && typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? { signal: AbortSignal.timeout(6000) } : {});
    if (got && got.m) {
      m = got.m; const ab = got.ab;
      await this.st.call('write', { name: path, at: 0, buf: ab, truncate: 0 }, [ab]); await this.st.call('close', { name: path });
    } else {
      const sz = (await this.st.call('size', { name: path })).size;
      if (got) manifestRefused(got, sz > 0);
      if (sz <= 0) throw new Error(got ? got.bad : 'pack manifest unavailable (offline and not downloaded)');
      const r = await this.st.call('read', { name: path, at: 0, len: sz });
      m = JSON.parse(new TextDecoder().decode(new Uint8Array(r.buf, 0, sz)));
    }
    if (m.format !== PACK_FORMAT || m.format_version !== 1) throw new Error('unsupported pack format ' + m.format + '/' + m.format_version);
    this.m = m; this.shards = new Map(m.shards.map((s) => [s.name, s]));
    this.state = await this._loadState();
    return m;
  }
  async _loadState() {
    const p = `${this.dir}/state.json`, sz = (await this.st.call('size', { name: p })).size;
    if (sz <= 0) return { pack_version: this.m.pack_version, done: {} };
    const r = await this.st.call('read', { name: p, at: 0, len: sz });
    const s = JSON.parse(new TextDecoder().decode(new Uint8Array(r.buf, 0, sz)));
    return s;
  }
  async _saveState() {
    const ab = new TextEncoder().encode(JSON.stringify(this.state)).buffer, p = `${this.dir}/state.json`;
    await this.st.call('write', { name: p, at: 0, buf: ab, truncate: 0 }, [ab]); await this.st.call('flush', { name: p });
  }
  /** per-shard chunk bitmap ('1' = written + sha256-verified); also reads the v1 state ({chunks: n} = the first n chunks) */
  _bits(s) {
    const d = this.state.done[s.name], n = s.chunk_sha256.length;
    if (!d || d.sha256 !== s.sha256) return '0'.repeat(n);
    if (typeof d.bits === 'string' && d.bits.length === n) return d.bits;
    const k = Math.min(n, d.chunks | 0); return '1'.repeat(k) + '0'.repeat(n - k);
  }
  /** a shard is complete when every chunk is verified against the manifest (whose shard sha256 must match the stored one) */
  status() {
    let have = 0, total = 0; const missing = [];
    for (const s of this.m.shards) {
      total += s.bytes;
      const b = this._bits(s); let all = true;
      for (let i = 0; i < b.length; i++) { if (b[i] === '1') have += Math.min(s.chunk_bytes, s.bytes - i * s.chunk_bytes); else all = false; }
      if (!all) missing.push(s.name);
    }
    return { have, total, missing, complete: missing.length === 0 };
  }
  /** download everything missing as 16 MiB HTTP Range requests, `parallel` (default 4) in flight; each chunk is SHA-256 verified
   *  (native WebCrypto) and written to OPFS as it lands, a bad chunk is re-fetched (up to 4 tries).  Resumable per chunk: the state
   *  (a bitmap per shard) is saved every ~3 s from a snapshot taken BEFORE the flush, so a kill never marks unflushed data as done.
   *  onProgress({have, total, shard, bytesPerSec}); signal: AbortSignal (pause). */
  async download(opts = {}) {
    const par = Math.max(1, Math.min(8, opts.parallel || 4)), t0 = performance.now(), st0 = this.status();
    const bits = new Map(this.m.shards.map((s) => [s.name, this._bits(s).split('')])), q = [], dirty = new Set();
    for (const s of this.m.shards) bits.get(s.name).forEach((b, i) => { if (b !== '1') q.push([s, i]); });
    let got = 0, lastSave = performance.now(), saving = null, err = null;
    const save = async () => {
      const snap = this.m.shards.map((s) => [s, bits.get(s.name).join('')]), files = Array.from(dirty); dirty.clear();
      for (const f of files) await this.st.call('flush', { name: f });
      for (const [s, b] of snap) { let k = 0; while (k < b.length && b[k] === '1') k++; this.state.done[s.name] = { sha256: s.sha256, bits: b, chunks: k }; }
      this.state.pack_version = this.m.pack_version; await this._saveState(); lastSave = performance.now();
    };
    const aborted = () => opts.signal && opts.signal.aborted;
    const worker = async () => {
      while (q.length && !err) {
        const [s, ci] = q.shift(), at = ci * s.chunk_bytes, len = Math.min(s.chunk_bytes, s.bytes - at), name = `${this.dir}/${s.file}`;
        let ok = false;
        for (let attempt = 0; attempt < 4 && !ok && !err; attempt++) {
          if (aborted()) throw new DOMException('aborted', 'AbortError');
          let ab = null;
          try {
            const r = await fetch(this.base + s.file, { headers: { Range: `bytes=${at}-${at + len - 1}` }, signal: opts.signal, cache: 'no-store' });
            if (r.status !== 206 && !(r.status === 200 && at === 0 && len === s.bytes)) {
              try { await r.body.cancel(); } catch (e) { /* an unread body would pin one of the browser's few connections */ }
              throw Object.assign(new Error(`download ${s.file}: HTTP ${r.status} (the pack server must honour HTTP Range requests)`), { fatal: r.status === 200 || r.status === 404 || r.status === 403 });
            }
            ab = await r.arrayBuffer();
          } catch (e) {
            if ((e && e.name === 'AbortError') || aborted()) throw new DOMException('aborted', 'AbortError');
            if (attempt === 3 || (e && e.fatal)) throw e;
            await new Promise((res) => setTimeout(res, 400 * (attempt + 1))); continue;
          }
          if (ab.byteLength !== len || hex(await crypto.subtle.digest('SHA-256', ab)) !== s.chunk_sha256[ci]) continue;
          await this.st.call('write', { name, at, buf: ab }, [ab]);
          ok = true;
        }
        if (err) return;
        if (!ok) throw new Error(`download ${s.file}: chunk ${ci} failed verification 4 times`);
        bits.get(s.name)[ci] = '1'; dirty.add(name); got += len;
        if (opts.onProgress) opts.onProgress({ have: st0.have + got, total: st0.total, shard: s.name, bytesPerSec: got / ((performance.now() - t0) / 1000) });
        if (!saving && performance.now() - lastSave > 3000) { saving = save(); try { await saving; } finally { saving = null; } }
      }
    };
    await Promise.all(Array.from({ length: par }, () => worker().catch((e) => { if (!err) err = e; })));
    if (saving) await saving;
    await save(); await this.st.call('closeAll');
    if (err) throw err;
    return this.status();
  }

  /** a whole pack file as an ArrayBuffer (the model's description, its tables, the grid) */
  async readFile(shardName) {
    const s = this.shards.get(shardName);
    const r = await this.st.call('read', { name: `${this.dir}/${s.file}`, at: 0, len: s.bytes });
    return r.buf.byteLength === s.bytes ? r.buf : r.buf.slice(0, s.bytes);
  }

  // ------------------------------------------------------------------ GPU upload: one NEW buffer per shard
  /** -> {name, buf (the GPU buffer, freed with the Gpu), bytes} */
  async upload(shardName) {
    const s = this.shards.get(shardName);
    if (!s) throw new Error('unknown shard ' + shardName);
    const g = this.gpu, name = `${this.dir}/${s.file}`, CH = 16 * 1024 * 1024;
    const buf = g.buffer(s.bytes, 'shard ' + shardName);
    const take = () => this.pool.pop() || new ArrayBuffer(CH);
    // the staging buffer is TRANSFERRED to the worker and back (zero-copy); a cloned one would leave 16 MB of garbage per chunk
    const read = (at, len) => { const b = take(); return this.st.call('read', { name, at, len, buf: b }, [b]); };
    let next = read(0, Math.min(CH, s.bytes));
    for (let off = 0; off < s.bytes; off += CH) {
      const r = await next;
      const nOff = off + CH;
      if (nOff < s.bytes) next = read(nOff, Math.min(CH, s.bytes - nOff));   // read-ahead (I/O only)
      g.device.queue.writeBuffer(buf, off, r.buf, 0, r.len);
      if (this.pool.length < 3) this.pool.push(r.buf);
      if ((this.inflight = (this.inflight || 0) + r.len) >= UPCAP) { this.inflight = 0; try { await g.device.queue.onSubmittedWorkDone(); } catch (e) { /* */ } }   // at most ~64 MB of weights in flight
    }
    return { name: shardName, buf, bytes: s.bytes };
  }
}
