// prep_js/hdf5.js - a minimal read-only HDF5 reader for NOAA netCDF-4 files (GOES ABI L2 MCMIP, GLM L2 LCFA), over HTTP Range reads.
// Pure ES module (browser + Node 18+): no DOM, deflate through DecompressionStream.
// Covers: superblock v0-v3; object headers v1 / v2 (+ continuation blocks); groups as symbol tables (v1 B-tree + local heap), compact
// link messages and dense links (fractal heap + v2 B-tree); compact and dense attributes; datatypes fixed-point / float / fixed string;
// dataspaces; layouts compact / contiguous / chunked (v3 layout = v1 B-tree; v4 layout = single chunk, implicit, fixed array, v2 B-tree);
// filters deflate (1), shuffle (2), fletcher32 (3, stripped). Anything else throws a clear error.
//
//   const src = httpSource(url) | bytesSource(u8)       // { read(off, len) -> Uint8Array, bytes, requests }
//   const f = await H5File.open(src)
//   const ds = await f.dataset('CMI_C01')               // { shape, dtype, attrs(), readChunks(...), chunkGrid() }
//   const a = await ds.attrs()                          // { scale_factor: Float32Array|number, _Unsigned: 'true', ... }

const UNDEF = -1;

// ------------------------------------------------------------------------------------------------------------ byte sources
/** An HTTP object read with Range requests. Metadata reads go through a page cache (pages of `page` bytes, fetched on demand, first
 *  `prefetch` bytes in one go); data reads (`readExact`) fetch exactly the bytes asked for, merged across small gaps. */
export function httpSource(url, { fetchFn = fetch, signal, page = 32768, prefetch = 0, prefetchTail = 0, size = null, onBytes } = {}) {
  const pages = new Map(); let bytes = 0, requests = 0;
  async function get(a, b) {   // [a, b) exactly
    requests++;
    const r = await fetchFn(url, { headers: { Range: `bytes=${a}-${b - 1}` }, signal });
    if (r.status !== 206 && r.status !== 200) throw Object.assign(new Error(`range read ${r.status} ${url}`), { code: 'HTTP_' + r.status });
    let u = new Uint8Array(await r.arrayBuffer()); bytes += u.length; if (onBytes) onBytes(u.length);
    if (r.status === 200) u = u.subarray(a, b);   // a server that ignored Range: cut what was asked for
    if (u.length < b - a && (size == null || b <= size)) throw new Error(`short range read ${u.length} < ${b - a} at ${a} ${url}`);
    return u;
  }
  const inflight = new Map();   // page -> promise (one request per page even when many reads want it at once)
  async function ensurePages(p0, p1) {
    const miss = [], wait = [];
    for (let p = p0; p <= p1; p++) if (!pages.has(p)) { if (inflight.has(p)) wait.push(inflight.get(p)); else miss.push(p); }
    if (miss.length) {
      // merge runs of missing pages into single requests
      const runs = []; let s = miss[0], e = miss[0];
      for (let i = 1; i < miss.length; i++) { if (miss[i] === e + 1) e = miss[i]; else { runs.push([s, e]); s = e = miss[i]; } }
      runs.push([s, e]);
      for (const [s0, e0] of runs) {
        let a = s0 * page, b = (e0 + 1) * page; if (size != null) b = Math.min(b, size);
        const pr = get(a, b).then((u) => { for (let p = s0; p <= e0; p++) { pages.set(p, u.subarray((p - s0) * page, Math.min(u.length, (p - s0 + 1) * page))); inflight.delete(p); } });
        for (let p = s0; p <= e0; p++) inflight.set(p, pr);
        wait.push(pr);
      }
    }
    if (wait.length) await Promise.all(wait);
  }
  const src = {
    url, get bytes() { return bytes; }, get requests() { return requests; },
    async init() {
      const jobs = [];
      if (prefetch > 0) jobs.push(ensurePages(0, Math.floor((Math.min(prefetch, size ?? prefetch) - 1) / page)));
      if (prefetchTail > 0 && size != null) {   // whole pages covering the last prefetchTail bytes
        const p0 = Math.max(Math.ceil(prefetch / page), Math.floor((size - prefetchTail) / page)), a = p0 * page;
        if (a < size) jobs.push(ensurePages(p0, Math.floor((size - 1) / page)));
      }
      await Promise.all(jobs);
    },
    async read(off, len) {
      const p0 = Math.floor(off / page), p1 = Math.floor((off + len - 1) / page);
      await ensurePages(p0, p1);
      if (p0 === p1) { const pg = pages.get(p0), o = off - p0 * page; return pg.subarray(o, o + len); }
      const out = new Uint8Array(len); let w = 0;
      for (let p = p0; p <= p1; p++) {
        const pg = pages.get(p), a = p === p0 ? off - p0 * page : 0, b = Math.min(pg.length, p === p1 ? off + len - p * page : page);
        out.set(pg.subarray(a, b), w); w += b - a;
      }
      return out;
    },
    /** exact data reads: ranges [{off, len}] -> Uint8Array[] (same order); neighbours closer than `gap` share one request */
    async readExact(ranges, gap = 8192) {
      const idx = ranges.map((r, i) => i).sort((i, j) => ranges[i].off - ranges[j].off), groups = [];
      for (const i of idx) {
        const r = ranges[i], g = groups[groups.length - 1];
        if (g && r.off <= g.b + gap) { g.items.push(i); g.b = Math.max(g.b, r.off + r.len); } else groups.push({ a: r.off, b: r.off + r.len, items: [i] });
      }
      const out = new Array(ranges.length);
      await Promise.all(groups.map(async (g) => {
        const u = await get(g.a, g.b);
        for (const i of g.items) out[i] = u.subarray(ranges[i].off - g.a, ranges[i].off - g.a + ranges[i].len);
      }));
      return out;
    },
  };
  return src;
}

/** a whole object already in memory (tests; also a GLM file fetched in one GET) */
export function bytesSource(u8, { label = 'bytes' } = {}) {
  return {
    url: label, bytes: u8.length, requests: 0, async init() {},
    async read(off, len) { if (off + len > u8.length) throw new Error(`read past end ${off}+${len} > ${u8.length}`); return u8.subarray(off, off + len); },
    async readExact(ranges) { return ranges.map((r) => u8.subarray(r.off, r.off + r.len)); },
  };
}

// ------------------------------------------------------------------------------------------------------------ little helpers
class Cur {
  constructor(u8, O = 8, L = 8) { this.b = u8; this.p = 0; this.O = O; this.L = L; this.dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength); }
  u8() { return this.b[this.p++]; }
  u16() { const v = this.dv.getUint16(this.p, true); this.p += 2; return v; }
  u32() { const v = this.dv.getUint32(this.p, true); this.p += 4; return v; }
  uN(n) { let v = 0, m = 1, all = true; for (let i = 0; i < n; i++) { const x = this.b[this.p + i]; if (x !== 0xff) all = false; v += x * m; m *= 256; } this.p += n; return all && n > 0 ? UNDEF : v; }
  uv(n) { let v = 0, m = 1; for (let i = 0; i < n; i++) { v += this.b[this.p + i] * m; m *= 256; } this.p += n; return v; }   // no UNDEF check
  off() { return this.uN(this.O); }
  len() { return this.uN(this.L); }
  bytes(n) { const v = this.b.subarray(this.p, this.p + n); this.p += n; return v; }
  skip(n) { this.p += n; return this; }
  sig(s) { const t = String.fromCharCode(...this.b.subarray(this.p, this.p + 4)); this.p += 4; if (t !== s) throw new Error(`HDF5: expected ${s}, found ${JSON.stringify(t)}`); }
  align8(base = 0) { this.p += (8 - ((this.p - base) % 8)) % 8; }
}
const log2 = (x) => Math.round(Math.log2(x));
const limitEncSize = (l) => Math.floor((l > 0 ? Math.floor(Math.log2(l)) : 0) / 8) + 1;   // H5VM_limit_enc_size
const txt = (u8) => { let e = u8.indexOf(0); if (e < 0) e = u8.length; return new TextDecoder().decode(u8.subarray(0, e)); };

/** zlib inflate through DecompressionStream */
export async function inflate(u8) {
  const s = new Blob([u8]).stream().pipeThrough(new DecompressionStream('deflate')), rd = s.getReader(), parts = []; let n = 0;
  for (;;) { const { done, value } = await rd.read(); if (done) break; parts.push(value); n += value.length; }
  if (parts.length === 1) return parts[0];
  const out = new Uint8Array(n); let o = 0; for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}
function unshuffle(u8, es) {
  if (es <= 1) return u8;
  const n = Math.floor(u8.length / es), out = new Uint8Array(u8.length);
  for (let b = 0; b < es; b++) { const base = b * n; for (let i = 0; i < n; i++) out[i * es + b] = u8[base + i]; }
  if (n * es < u8.length) out.set(u8.subarray(n * es), n * es);
  return out;
}

// ------------------------------------------------------------------------------------------------------------ messages
function parseDatatype(c) {
  const b0 = c.u8(), cls = b0 & 15, version = b0 >> 4, f0 = c.u8(), f1 = c.u8(), f2 = c.u8(), size = c.u32();
  const t = { cls, version, size, bits: [f0, f1, f2] };
  if (cls === 0) { t.le = (f0 & 1) === 0; t.signed = (f0 & 8) !== 0; t.bitOffset = c.u16(); t.precision = c.u16(); t.kind = 'int'; }
  else if (cls === 1) { t.le = (f0 & 1) === 0; t.kind = 'float'; c.skip(12); }
  else if (cls === 3) { t.kind = 'string'; }
  else if (cls === 9) { t.kind = (f0 & 15) === 1 ? 'vlen-string' : 'vlen'; t.base = parseDatatype(c); }
  else t.kind = 'other';
  return t;
}
function parseDataspace(c) {
  const version = c.u8(), rank = c.u8(), flags = c.u8(); let type = 1;
  if (version === 1) c.skip(5); else type = c.u8();
  const dims = []; for (let i = 0; i < rank; i++) dims.push(c.len());
  if (flags & 1) for (let i = 0; i < rank; i++) c.len();
  return { rank, dims, scalar: rank === 0 && type !== 2, empty: type === 2 };
}
function decodeValues(t, raw, n) {
  if (t.kind === 'string') return txt(raw);
  if (t.kind === 'int' || t.kind === 'float') {
    const dv = new DataView(raw.buffer, raw.byteOffset, raw.byteLength), out = []; const le = t.le;
    for (let i = 0; i < n; i++) {
      const o = i * t.size; let v;
      if (t.kind === 'float') v = t.size === 4 ? dv.getFloat32(o, le) : dv.getFloat64(o, le);
      else if (t.size === 1) v = t.signed ? dv.getInt8(o) : dv.getUint8(o);
      else if (t.size === 2) v = t.signed ? dv.getInt16(o, le) : dv.getUint16(o, le);
      else if (t.size === 4) v = t.signed ? dv.getInt32(o, le) : dv.getUint32(o, le);
      else v = Number(t.signed ? dv.getBigInt64(o, le) : dv.getBigUint64(o, le));
      out.push(v);
    }
    return n === 1 ? out[0] : out;
  }
  return { unsupported: t.kind, raw };
}
function parseAttribute(c) {
  const version = c.u8(); let flags = 0;
  if (version === 1) c.skip(1); else flags = c.u8();
  const nameSize = c.u16(), dtSize = c.u16(), dsSize = c.u16();
  if (version >= 3) c.skip(1);
  if (flags & 3) throw new Error('HDF5: shared attribute datatype/dataspace not supported');
  const pad = version === 1 ? (n) => n + ((8 - (n % 8)) % 8) : (n) => n;
  const name = txt(c.bytes(pad(nameSize)));
  const p0 = c.p; const dt = parseDatatype(c); c.p = p0 + pad(dtSize);
  const p1 = c.p; const ds = parseDataspace(c); c.p = p1 + pad(dsSize);
  const n = ds.empty ? 0 : ds.dims.reduce((a, b) => a * b, 1);
  return { name, dt, ds, raw: c.bytes(n * dt.size), n };
}
function parseLink(c) {
  const version = c.u8(), flags = c.u8();
  if (version !== 1) throw new Error('HDF5: link message version ' + version);
  let type = 0; if (flags & 8) type = c.u8();
  if (flags & 4) c.skip(8);
  if (flags & 16) c.skip(1);
  const ln = c.uv(1 << (flags & 3)), name = new TextDecoder().decode(c.bytes(ln));
  if (type === 0) return { name, addr: c.off() };
  return { name, addr: UNDEF, type };
}

// a walk through a file's structure (object header continuations, B-tree nodes, fractal heap blocks) never visits an address twice and
// never more than MAX_VISITS of them: a file that loops back on itself (broken, or made to) stops with an error instead of spinning
const MAX_VISITS = 65536;
function visit(seen, addr, what) {
  if (seen.has(addr) || seen.size >= MAX_VISITS) throw Object.assign(new Error(`HDF5: ${what} loops back (at ${addr})`), { code: 'H5_LOOP' });
  seen.add(addr);
}

// ------------------------------------------------------------------------------------------------------------ the file
export class H5File {
  static async open(src) { const f = new H5File(src); await src.init?.(); await f._superblock(); return f; }
  constructor(src) { this.src = src; this.O = 8; this.L = 8; this._groups = new Map(); this._ohdr = new Map(); }
  async cur(addr, n) { return new Cur(await this.src.read(addr, n), this.O, this.L); }

  async _superblock() {
    const b = await this.src.read(0, 64);
    const sig = [0x89, 0x48, 0x44, 0x46, 0x0d, 0x0a, 0x1a, 0x0a];
    for (let i = 0; i < 8; i++) if (b[i] !== sig[i]) throw new Error('HDF5: no superblock at 0 (user block not supported)');
    const v = b[8]; this.sbVersion = v;
    if (v === 0 || v === 1) {
      this.O = b[13]; this.L = b[14];
      const c = await this.cur(0, 128); c.p = v === 0 ? 24 : 28;
      c.off(); c.off(); c.off(); c.off();   // base, free space, eof, driver
      c.off(); this.root = c.off();         // root symbol table entry: link name offset, object header address
    } else if (v === 2 || v === 3) {
      this.O = b[9]; this.L = b[10];
      const c = await this.cur(0, 12 + 4 * this.O + 4); c.p = 12;
      c.off(); c.off(); c.off(); this.root = c.off();
    } else throw new Error('HDF5: superblock version ' + v);
  }

  /** object header -> [{type, flags, data}] (continuations followed) */
  async objectHeader(addr) {
    if (this._ohdr.has(addr)) return this._ohdr.get(addr);
    const pr = this._objectHeader(addr); this._ohdr.set(addr, pr); return pr;
  }
  async _objectHeader(addr) {
    const msgs = [], O = this.O, L = this.L;
    const head = await this.src.read(addr, 16);
    if (head[0] === 1) {   // version 1
      const c0 = new Cur(head, O, L); c0.skip(2); const nmsg = c0.u16(); c0.u32(); const hsize = c0.u32();
      const blocks = [[addr + 16, hsize]];
      while (blocks.length && msgs.length < nmsg) {
        const [a, n] = blocks.shift(); const c = await this.cur(a, n);
        while (c.p + 8 <= n && msgs.length < nmsg) {
          const type = c.u16(), size = c.u16(), flags = c.u8(); c.skip(3);
          const data = c.bytes(size);
          if (type === 0x10) { const cc = new Cur(data, O, L); blocks.push([cc.off(), cc.len()]); }
          msgs.push({ type, flags, data });
        }
      }
      return msgs;
    }
    if (String.fromCharCode(head[0], head[1], head[2], head[3]) !== 'OHDR') throw new Error('HDF5: bad object header at ' + addr);
    const flags = head[5]; let p = 6;
    if (flags & 0x20) p += 16;
    if (flags & 0x10) p += 4;
    const szb = 1 << (flags & 3), sizeHead = await this.cur(addr + p, szb), chunk0 = sizeHead.uv(szb); p += szb;
    const trackOrder = (flags & 0x04) !== 0, mh = trackOrder ? 6 : 4;
    const parse = (c, end) => {
      const conts = [];
      while (c.p + mh <= end) {
        const type = c.u8(), size = c.u16(), mf = c.u8(); if (trackOrder) c.skip(2);
        if (c.p + size > end) break;
        const data = c.bytes(size);
        if (type === 0x10) { const cc = new Cur(data, O, L); conts.push([cc.off(), cc.len()]); }
        msgs.push({ type, flags: mf, data });
      }
      return conts;
    };
    let conts = parse(await this.cur(addr + p, chunk0), chunk0);
    const seen = new Set();
    while (conts.length) {
      const [a, n] = conts.shift(); visit(seen, a, 'an object header continuation'); const c = await this.cur(a, n); c.sig('OCHK');
      conts = conts.concat(parse(c, n - 4));
    }
    return msgs;
  }

  /** the links of a group object header -> Map(name -> address) */
  async links(addr) {
    if (this._groups.has(addr)) return this._groups.get(addr);
    const pr = this._links(addr); this._groups.set(addr, pr); return pr;
  }
  async _links(addr) {
    const msgs = await this.objectHeader(addr), out = new Map(), O = this.O, L = this.L;
    for (const m of msgs) {
      if (m.type === 0x06) { const l = parseLink(new Cur(m.data, O, L)); out.set(l.name, l.addr); }
      else if (m.type === 0x11) {   // symbol table: v1 B-tree (type 0) + local heap
        const c = new Cur(m.data, O, L), bt = c.off(), lh = c.off();
        const h = await this.cur(lh, 8 + 2 * L + O); h.sig('HEAP'); h.skip(4); const dsize = h.len(); h.len(); const daddr = h.off();
        const heap = await this.src.read(daddr, dsize), seen = new Set();
        const walk = async (node) => {
          visit(seen, node, 'a group B-tree');
          const c0 = await this.cur(node, 8 + 2 * O); c0.sig('TREE'); const type = c0.u8(), level = c0.u8(), n = c0.u16();
          if (type !== 0) throw new Error('HDF5: group B-tree type ' + type);
          const c1 = await this.cur(node + 8 + 2 * O, (n + 1) * L + n * O);
          const kids = []; for (let i = 0; i < n; i++) { c1.len(); kids.push(c1.off()); }
          for (const k of kids) {
            if (level > 0) { await walk(k); continue; }
            const s = await this.cur(k, 8); s.sig('SNOD'); s.skip(2); const ns = s.u16();
            const e = await this.cur(k + 8, ns * (2 * O + 24));
            for (let i = 0; i < ns; i++) { const no = e.off(), oa = e.off(); e.skip(24); out.set(txt(heap.subarray(no)), oa); }
          }
        };
        await walk(bt);
      } else if (m.type === 0x02) {   // link info: dense links
        const c = new Cur(m.data, O, L); c.u8(); const fl = c.u8(); if (fl & 1) c.skip(8);
        const fh = c.off(), bt = c.off();
        if (fh !== UNDEF && bt !== UNDEF) {
          const heap = await this.fractalHeap(fh);
          const recs = await this.btree2Records(bt);   // type 5 record: hash (4) + heap id
          const ls = await Promise.all(recs.map(async (rec) => parseLink(new Cur(await heap.get(rec.subarray(4)), O, L))));
          for (const l of ls) out.set(l.name, l.addr);
        }
      }
    }
    return out;
  }

  /** every record of a v2 B-tree -> [Uint8Array(recordSize)] */
  async btree2Records(addr) {
    const O = this.O, L = this.L, h = await this.cur(addr, 4 + 1 + 1 + 4 + 2 + 2 + 1 + 1 + O + 2 + L + 4);
    h.sig('BTHD'); h.u8(); h.u8(); const nodeSize = h.u32(), rs = h.u16(), depth = h.u16(); h.skip(2); const root = h.off(), rootN = h.u16();
    // node_info (H5B2__hdr_init)
    const info = [{ max: Math.floor((nodeSize - 10) / rs) }]; info[0].cum = info[0].max; info[0].cumSize = 0;
    const maxNrecSize = limitEncSize(info[0].max);
    for (let d = 1; d <= depth; d++) {
      const ptr = O + maxNrecSize + (d > 1 ? info[d - 1].cumSize : 0), max = Math.floor((nodeSize - 10 - ptr) / (rs + ptr));
      const cum = (max + 1) * info[d - 1].cum + max; info.push({ max, cum, cumSize: limitEncSize(cum) });
    }
    const out = [];
    const walk = async (a, n, d) => {
      const c = await this.cur(a, nodeSize); c.sig(d === 0 ? 'BTLF' : 'BTIN'); c.u8(); c.u8();
      const recs = []; for (let i = 0; i < n; i++) recs.push(c.bytes(rs));
      if (d === 0) return recs;
      const kids = [];
      for (let i = 0; i <= n; i++) { const ca = c.off(), cn = c.uv(maxNrecSize); if (d > 1) c.uv(info[d - 1].cumSize); kids.push([ca, cn]); }
      const sub = await Promise.all(kids.map(([ca, cn]) => walk(ca, cn, d - 1)));
      const res = []; for (let i = 0; i <= n; i++) { res.push(...sub[i]); if (i < n) res.push(recs[i]); }
      return res;
    };
    if (root !== UNDEF && rootN > 0) out.push(...await walk(root, rootN, depth));
    return out;
  }

  /** a fractal heap -> { get(heapId) -> Uint8Array } (managed and tiny objects) */
  async fractalHeap(addr) {
    const O = this.O, L = this.L, c = await this.cur(addr, 4 + 1 + 2 + 2 + 1 + 4 + 12 * L + 3 * O + 2 + 2 + 2 + 2 + 64);
    c.sig('FRHP'); c.u8(); const idLen = c.u16(), filtLen = c.u16(), flags = c.u8(), maxMan = c.u32();
    c.len(); c.off(); c.len(); c.off(); c.len(); c.len(); c.len(); c.len(); c.len(); c.len(); c.len(); c.len();
    const width = c.u16(), start = c.len(), maxDirect = c.len(), maxHeapBits = c.u16(); c.u16(); const rootAddr = c.off(), rootRows = c.u16();
    if (filtLen > 0) throw new Error('HDF5: filtered fractal heap not supported');
    const offSize = Math.floor((maxHeapBits + 7) / 8), lenSize = Math.min(Math.floor((log2(maxDirect) + 7) / 8), limitEncSize(maxMan));
    const maxDirectRows = log2(maxDirect) - log2(start) + 2, bs = (r) => (r < 2 ? start : start * 2 ** (r - 1));
    const csum = (flags & 2) !== 0, self = this;
    async function locate(heapOff) {   // -> file address of heap offset
      if (rootRows === 0) return rootAddr + heapOff;
      let blockAddr = rootAddr, nrows = rootRows, base = 0; const seen = new Set();
      for (;;) {
        visit(seen, blockAddr, 'a fractal heap indirect block');
        const ic = await self.cur(blockAddr, 4 + 1 + O + offSize); ic.sig('FHIB'); ic.u8(); ic.off(); ic.uv(offSize);
        const entriesAt = blockAddr + 5 + O + offSize; let cur = base, found = null;
        for (let r = 0; r < nrows && !found; r++) {
          const span = width * bs(r);
          if (heapOff < cur + span) {
            const col = Math.floor((heapOff - cur) / bs(r)), k = r * width + col;
            const e = await self.cur(entriesAt + k * O, O); const a = e.off();
            found = { r, a, blockBase: cur + col * bs(r) };
          }
          cur += span;
        }
        if (!found) throw new Error('HDF5: heap offset outside the heap');
        if (found.r < maxDirectRows) return found.a + (heapOff - found.blockBase);
        blockAddr = found.a; base = found.blockBase; nrows = log2(bs(found.r)) - log2(start * width) + 1;
      }
    }
    return {
      idLen,
      async get(id) {
        const type = (id[0] >> 4) & 3;
        if (type === 2) { const n = (id[0] & 15) + 1; return id.subarray(1, 1 + n); }   // tiny
        if (type !== 0) throw new Error('HDF5: huge fractal-heap objects not supported');
        const c2 = new Cur(id, O, L); c2.u8(); const ho = c2.uv(offSize), n = c2.uv(lenSize);
        return self.src.read(await locate(ho), n);
      },
      csum,
    };
  }

  /** attributes of an object header -> {name: value} (compact and dense) */
  async attrsOf(addr) {
    const msgs = await this.objectHeader(addr), out = {}, O = this.O, L = this.L;
    const take = (a) => { out[a.name] = decodeValues(a.dt, a.raw, a.n); };
    for (const m of msgs) {
      if (m.type === 0x0c) take(parseAttribute(new Cur(m.data, O, L)));
      else if (m.type === 0x15) {
        const c = new Cur(m.data, O, L); c.u8(); const fl = c.u8(); if (fl & 1) c.skip(2);
        const fh = c.off(), bt = c.off();
        if (fh !== UNDEF && bt !== UNDEF) {
          const heap = await this.fractalHeap(fh);
          const recs = await this.btree2Records(bt);   // type 8 record: heap id (8), flags (1), order (4), hash (4)
          for (const rec of recs) if (rec[8] & 2) throw new Error('HDF5: shared dense attribute not supported');
          const as = await Promise.all(recs.map(async (rec) => parseAttribute(new Cur(await heap.get(rec.subarray(0, 8)), O, L))));
          for (const a of as) take(a);
        }
      }
    }
    return out;
  }

  async rootLinks() { return this.links(this.root); }
  async attrs(path = '/') { return this.attrsOf(path === '/' ? this.root : await this.resolve(path)); }
  async resolve(path) {
    let addr = this.root;
    for (const part of path.split('/').filter(Boolean)) {
      const l = await this.links(addr); if (!l.has(part)) throw Object.assign(new Error(`HDF5: no object ${path}`), { code: 'H5_MISSING' });
      addr = l.get(part);
    }
    return addr;
  }
  async dataset(path) { const addr = await this.resolve(path); return new H5Dataset(this, addr, path, await this.objectHeader(addr)); }
}

// ------------------------------------------------------------------------------------------------------------ datasets
export class H5Dataset {
  constructor(f, addr, path, msgs) {
    this.f = f; this.addr = addr; this.path = path; this.filters = [];
    const O = f.O, L = f.L;
    for (const m of msgs) {
      if (m.flags & 2) { if (m.type === 3 || m.type === 1) throw new Error('HDF5: shared datatype/dataspace not supported'); continue; }
      const c = new Cur(m.data, O, L);
      if (m.type === 0x01) this.space = parseDataspace(c);
      else if (m.type === 0x03) this.dtype = parseDatatype(c);
      else if (m.type === 0x08) this.layout = parseLayout(c, O, L);
      else if (m.type === 0x0b) this.filters = parseFilters(c);
    }
    if (!this.space || !this.dtype || !this.layout) throw new Error('HDF5: ' + path + ' is not a dataset');
    this.shape = this.space.dims;
  }
  async attrs() { if (!this._attrs) this._attrs = this.f.attrsOf(this.addr); return this._attrs; }

  /** chunk records -> [{coord: [..element offsets..], size, mask, addr}] */
  async chunks() {
    if (this._chunks) return this._chunks;
    const f = this.f, O = f.O, L = f.L, lay = this.layout, rank = this.shape.length, out = [];
    if (lay.cls === 1 || lay.cls === 0) { this._chunks = []; return this._chunks; }
    const cdims = lay.chunk.slice(0, rank), nch = this.shape.map((d, i) => Math.ceil(d / cdims[i]));
    const total = nch.reduce((a, b) => a * b, 1), es = this.dtype.size;
    const coordOf = (k) => { const cc = new Array(rank); for (let i = rank - 1; i >= 0; i--) { cc[i] = (k % nch[i]) * cdims[i]; k = Math.floor(k / nch[i]); } return cc; };
    const unfilteredBytes = cdims.reduce((a, b) => a * b, 1) * es;
    if (lay.index === 'btree1') {
      const ks = 8 + 8 * (rank + 1), seen = new Set();
      const walk = async (node) => {
        visit(seen, node, 'a chunk B-tree');
        const c0 = await f.cur(node, 8 + 2 * O); c0.sig('TREE'); const type = c0.u8(), level = c0.u8(), n = c0.u16();
        if (type !== 1) throw new Error('HDF5: chunk B-tree type ' + type);
        const c = await f.cur(node + 8 + 2 * O, (n + 1) * ks + n * O); const kids = [];
        for (let i = 0; i < n; i++) {
          const size = c.u32(), mask = c.u32(), coord = []; for (let d = 0; d <= rank; d++) coord.push(c.uv(8));
          kids.push({ size, mask, coord: coord.slice(0, rank), addr: c.off() });
        }
        if (level > 0) await Promise.all(kids.map((k) => walk(k.addr))); else out.push(...kids);
      };
      if (lay.addr !== UNDEF) await walk(lay.addr);
    } else if (lay.index === 'single') {
      out.push({ coord: new Array(rank).fill(0), size: lay.single.size ?? unfilteredBytes, mask: lay.single.mask ?? 0, addr: lay.addr });
    } else if (lay.index === 'implicit') {
      for (let k = 0; k < total; k++) out.push({ coord: coordOf(k), size: unfilteredBytes, mask: 0, addr: lay.addr + k * unfilteredBytes });
    } else if (lay.index === 'farray') {
      const c = await f.cur(lay.addr, 4 + 1 + 1 + 1 + 1 + L + O + 4); c.sig('FAHD'); c.u8(); c.u8(); const esz = c.u8(), pbits = c.u8(), nent = c.len(), dblk = c.off();
      const filtered = this.filters.length > 0, d = await f.cur(dblk, 4 + 1 + 1 + O); d.sig('FADB'); d.u8(); d.u8(); d.off();
      const pageN = 2 ** pbits;
      if (nent > pageN) throw new Error('HDF5: paged fixed-array chunk index not supported');
      const sizeBytes = filtered ? esz - O - 4 : 0;
      const e = await f.cur(dblk + 6 + O, nent * esz);
      for (let k = 0; k < nent; k++) {
        const a = e.off(); let size = unfilteredBytes, mask = 0;
        if (filtered) { size = e.uv(sizeBytes); mask = e.u32(); }
        if (a !== UNDEF) out.push({ coord: coordOf(k), size, mask, addr: a });
      }
    } else if (lay.index === 'btree2') {
      const filtered = this.filters.length > 0;
      for (const rec of await f.btree2Records(lay.addr)) {
        const c = new Cur(rec, O, L), a = c.off(); let size = unfilteredBytes, mask = 0;
        if (filtered) { size = c.uv(rec.length - O - 4 - 8 * rank); mask = c.u32(); }
        const coord = []; for (let d = 0; d < rank; d++) coord.push(c.uv(8) * cdims[d]);
        out.push({ coord, size, mask, addr: a });
      }
    } else throw new Error('HDF5: chunk index ' + lay.index + ' not supported');
    this._chunks = out; return out;
  }

  /** chunk shape (elements) */
  get chunkShape() { return this.layout.cls === 2 ? this.layout.chunk.slice(0, this.shape.length) : this.shape.slice(); }

  /** read + decode a set of chunks -> Map(chunkKey -> Uint8Array of the unfiltered chunk bytes); key = coord.join(',') */
  async readChunks(list, { gap = 8192 } = {}) {
    const raws = await this.f.src.readExact(list.map((k) => ({ off: k.addr, len: k.size })), gap), out = new Map();
    await Promise.all(list.map(async (k, i) => { out.set(k.coord.join(','), await this.decodeChunk(raws[i], k.mask)); }));
    return out;
  }
  async decodeChunk(raw, mask = 0) {
    let u = raw;
    for (let i = this.filters.length - 1; i >= 0; i--) {
      if (mask & (1 << i)) continue;
      const fl = this.filters[i];
      if (fl.id === 1) u = await inflate(u);
      else if (fl.id === 2) u = unshuffle(u, fl.values[0] || this.dtype.size);
      else if (fl.id === 3) u = u.subarray(0, u.length - 4);
      else throw new Error('HDF5: filter ' + fl.id + ' not supported');
    }
    return u;
  }
  /** contiguous / compact data (whole dataset) -> Uint8Array */
  async readAll({ gap = 65536 } = {}) {
    const lay = this.layout;
    if (lay.cls === 0) return lay.compact;
    if (lay.cls === 1) { if (lay.addr === UNDEF) return new Uint8Array(lay.size); return (await this.f.src.readExact([{ off: lay.addr, len: lay.size }]))[0]; }
    // chunked, 1-D: concatenate chunks in order
    if (this.shape.length !== 1) throw new Error('readAll: chunked N-D not supported');
    const n = this.shape[0], es = this.dtype.size, out = new Uint8Array(n * es), cs = this.chunkShape[0];
    const ch = await this.chunks(), m = await this.readChunks(ch, { gap });
    for (const k of ch) { const u = m.get(k.coord.join(',')), a = k.coord[0], b = Math.min(n, a + cs); out.set(u.subarray(0, (b - a) * es), a * es); }
    return out;
  }
}
function parseLayout(c, O, L) {
  const version = c.u8();
  if (version < 3) throw new Error('HDF5: layout message version ' + version);
  const cls = c.u8(), lay = { version, cls };
  if (cls === 0) { const n = c.u16(); lay.compact = c.bytes(n); return lay; }
  if (cls === 1) { lay.addr = c.off(); lay.size = c.len(); return lay; }
  if (cls !== 2) throw new Error('HDF5: layout class ' + cls);
  if (version === 3) {
    const nd = c.u8(); lay.addr = c.off(); lay.chunk = []; for (let i = 0; i < nd; i++) lay.chunk.push(c.u32());
    lay.index = 'btree1'; return lay;
  }
  const flags = c.u8(), nd = c.u8(), enc = c.u8(); lay.chunk = []; for (let i = 0; i < nd; i++) lay.chunk.push(c.uv(enc));
  const it = c.u8();
  if (it === 1) { lay.index = 'single'; lay.single = {}; if (flags & 2) { lay.single.size = c.len(); lay.single.mask = c.u32(); } }
  else if (it === 2) lay.index = 'implicit';
  else if (it === 3) { lay.index = 'farray'; c.u8(); }
  else if (it === 4) { lay.index = 'earray'; c.skip(5); }
  else if (it === 5) { lay.index = 'btree2'; c.skip(6); }
  else throw new Error('HDF5: chunk index type ' + it);
  lay.addr = c.off();
  return lay;
}
function parseFilters(c) {
  const version = c.u8(), n = c.u8(), out = [];
  if (version === 1) c.skip(6);
  for (let i = 0; i < n; i++) {
    const id = c.u16(); let nameLen = 0;
    if (version === 1 || id >= 256) nameLen = c.u16();
    const flags = c.u16(), nv = c.u16();
    if (version === 1) c.skip(nameLen + ((8 - (nameLen % 8)) % 8)); else if (nameLen) c.skip(nameLen);
    const values = []; for (let k = 0; k < nv; k++) values.push(c.u32());
    if (version === 1 && nv % 2) c.skip(4);
    out.push({ id, flags, values });
  }
  return out;
}
