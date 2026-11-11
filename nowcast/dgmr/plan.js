// nowcast/dgmr/plan.js - what the two DGMR engines (float and int8) share: the op list's tensors and when each one lives, GPU buffers
// shared by tensors whose lives do not overlap (a tensor's memory is given back after its last reader), the job's latent noise
// (PCG32 through a fixed integer table: the same seed and member give the same latent on every device), and the frame layouts.
// Pure (no GPU): node-testable.

/** the tensor refs an op reads */
export function refsIn(op) {
  switch (op.op) {
    case 'conv': return op.ins;
    case 'add': return [op.a, ...op.b];
    case 'cbn': return [op.x];
    case 'gmul': return [op.r, op.h];
    case 'gru': return [op.u, op.h, op.c];
    case 'attn': return [op.q, op.k, op.v];
    default: return [];
  }
}
/** every tensor's life: first op that writes it, last op that reads it (the output: past the end). The radar frames and the latent
 *  are written before the first op runs, so they live from the start */
export function lifetimes(m) {
  const life = m.tensors.map(() => ({ def: Infinity, last: -1 }));
  m.ops.forEach((op, i) => {
    const o = life[op.out.t]; o.def = Math.min(o.def, op.op === 'input' || op.op === 'zin' ? -1 : i); o.last = Math.max(o.last, i);
    for (const r of refsIn(op)) life[r.t].last = Math.max(life[r.t].last, i);
  });
  life[m.output].last = m.ops.length;
  return life;
}
/** tensors -> shared buffers: a tensor takes a buffer whose tensors all died before it is first written (best fit by size), so two
 *  tensors in one buffer are never alive at the same op. bytesOf(t) -> bytes. -> { slot: [buffer index per tensor], sizes, total, peak } */
export function assignBuffers(m, bytesOf) {
  const life = lifetimes(m), order = m.tensors.map((_, t) => t).filter((t) => life[t].def < Infinity).sort((a, b) => life[a].def - life[b].def || a - b);
  const slot = new Array(m.tensors.length).fill(-1), sizes = [], freeAt = [];   // freeAt[b]: the op after which buffer b is free
  for (const t of order) {
    const need = bytesOf(t), d = life[t].def;
    let best = -1, bestCost = Infinity;
    for (let b = 0; b < sizes.length; b++) {
      if (freeAt[b] >= d) continue;
      const cost = sizes[b] >= need ? sizes[b] - need : (need - sizes[b]) * 4;   // growing a buffer costs more than a loose fit
      if (cost < bestCost) { bestCost = cost; best = b; }
    }
    if (best < 0) { best = sizes.length; sizes.push(0); freeAt.push(-1); }
    sizes[best] = Math.max(sizes[best], need); freeAt[best] = life[t].last; slot[t] = best;
  }
  // the most bytes alive at any op if every tensor had its own buffer (what sharing can at best reach)
  let peak = 0;
  for (let i = 0; i < m.ops.length; i++) { let s = 0; for (const t of order) if (life[t].def <= i && life[t].last >= i) s += bytesOf(t); peak = Math.max(peak, s); }
  return { slot, sizes, total: sizes.reduce((a, b) => a + b, 0), peak };
}
export const elemsOf = (T) => T.n * T.h * T.w * T.c;

/** multiply-accumulates of one op */
export function opMacs(m, op) {
  const T = m.tensors, o = T[op.out.t];
  if (op.op === 'conv') return op.out.n * o.h * o.w * o.c * op.ins.reduce((s, r) => s + T[r.t].c, 0) * op.k * op.k;
  if (op.op === 'attn') return 64 * 64 * 48 * 2;
  return op.out.n * o.h * o.w * o.c;
}

// ---------------------------------------------------------------------------------------------------------- the latent
/** the int8 latent [512] for (seed, member): PCG32 (O'Neill's pcg32_srandom_r(seed, member)), each draw through the thresholds */
export function zLatent(thr, seed, member) {
  const M64 = (1n << 64n) - 1n, MUL = 6364136223846793005n;
  let state = 0n; const inc = ((BigInt(member) << 1n) | 1n) & M64;
  const next = () => {
    const old = state; state = (old * MUL + inc) & M64;
    const xs = Number((((old >> 18n) ^ old) >> 27n) & 0xffffffffn), rot = Number(old >> 59n);
    return ((xs >>> rot) | (xs << ((-rot) & 31))) >>> 0;
  };
  next(); state = (state + BigInt(seed)) & M64; next();
  const z = new Int8Array(512);
  for (let i = 0; i < 512; i++) {
    const u = next(); let lo = 0, hi = thr.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (thr[mid] <= u) lo = mid + 1; else hi = mid; }
    z[i] = -127 + lo;
  }
  return z;
}

// ---------------------------------------------------------------------------------------------------------- frame layouts
/** [4][256][256] -> space-to-depth [4][128][128][4] (channel = dy * 2 + dx) */
export function s2d(frames, T = frames.constructor) {
  const o = new T(4 * 128 * 128 * 4);
  for (let f = 0; f < 4; f++) for (let y = 0; y < 128; y++) for (let x = 0; x < 128; x++)
    for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++)
      o[((f * 128 + y) * 128 + x) * 4 + dy * 2 + dx] = frames[(f * 256 + 2 * y + dy) * 256 + 2 * x + dx];
  return o;
}
/** model output [18][128][128][4] -> rain frames [18][256][256] mm/h (below 0 = 0); scale: int8 output is in 1/64 mm/h */
export function d2s(out, scale = 1, n = 18) {
  const f = new Float32Array(n * 256 * 256);
  for (let t = 0; t < n; t++) for (let y = 0; y < 128; y++) for (let x = 0; x < 128; x++) for (let q = 0; q < 4; q++) {
    const v = out[((t * 128 + y) * 128 + x) * 4 + q] * scale;
    f[(t * 256 + 2 * y + (q >> 1)) * 256 + 2 * x + (q & 1)] = v > 0 ? v : 0;
  }
  return f;
}
