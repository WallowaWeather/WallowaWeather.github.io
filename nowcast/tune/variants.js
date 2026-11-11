// nowcast/tune/variants.js - Wallowa Weather's speed tune: the other ways of running each model's heaviest kernel, and which ones to
// try where. Pure (no GPU, no page): the WGSL text and the plans are node-testable.
//   StormScope: its GEMM (nowcast/stormscope/kernels.js gemmWGSL; every linear layer and both halves of attention) with another
//               output tile, threads per workgroup, outputs per thread and k step.
//   DGMR (float): its convolution (nowcast/dgmr/kernels_float.js convF) the same way.
//   BEAM: its own convolution generator already takes a tile per layer (BeamNet opts.tiles): only the choice is made here.
// Every variant does each output's arithmetic exactly as the standard kernel does it: the same products, added in the same order, with
// the same roundings. Only the work split across threads and the k step change, so a correct variant gives the standard kernel's numbers
// bit for bit, and the speed tune accepts nothing less (measure.js checks every one on this phone before timing it). No variant changes a
// sum's precision or order (no 16-bit sums, no other split of DGMR's long sums): those would change a forecast, not only its speed.
// The standard kernels stay the code in their own files; the defaults here are only the numbers that describe them.
'use strict';

/** iOS-safe ceilings every variant stays inside (as the models' own kernels): 16 KB of workgroup memory, 256 threads */
export const WG_BYTES = 16384, WG_THREADS = 256;

// ------------------------------------------------------------------------------------------------ StormScope GEMM
/** the standard StormScope GEMM: 64 x 64 outputs a workgroup, 8 x 8 a thread (64 threads), k step 32 */
export const SS_DEFAULT = Object.freeze({ BM: 64, BN: 64, KS: 32, TM: 8, TN: 8 });
/** the other tiles tried, in order of preference (a phone tries the first few that fit) */
export const SS_TILES = Object.freeze([
  { BM: 64, BN: 64, KS: 32, TM: 4, TN: 8 },     // 128 threads
  { BM: 128, BN: 64, KS: 32, TM: 8, TN: 8 },    // 128 threads, taller tile
  { BM: 64, BN: 64, KS: 32, TM: 4, TN: 4 },     // 256 threads
  { BM: 64, BN: 128, KS: 32, TM: 8, TN: 8 },    // 128 threads, wider tile
  { BM: 128, BN: 128, KS: 16, TM: 8, TN: 8 },   // 256 threads, big tile
  { BM: 64, BN: 64, KS: 16, TM: 8, TN: 8 },     // the standard tile, half the k step (less shared memory)
  { BM: 32, BN: 64, KS: 32, TM: 4, TN: 8 },     // 64 threads, more workgroups
]);
export const tileId = (t) => `t${t.BM}x${t.BN}k${t.KS}m${t.TM}n${t.TN}`;
export const ssThreads = (t) => (t.BM / t.TM) * (t.BN / t.TN);
export const ssWgBytes = (t, f16) => t.KS * (t.BM + t.BN) / 4 * (f16 ? 8 : 16);
/** a StormScope tile's own rules -> '' | why not */
export function ssTileWhy(t, { f16 = true, b = 'i8', N = 0 } = {}) {
  if (![4, 8].includes(t.TM) || ![4, 8].includes(t.TN)) return 'outputs per thread';
  if (t.BM % t.TM || t.BN % t.TN || t.BM % 4 || t.BN % 4 || t.KS % 4 || t.KS < 4) return 'tile shape';
  const nt = ssThreads(t);
  if (nt > WG_THREADS || nt < 16) return 'threads';
  if (ssWgBytes(t, f16) > WG_BYTES) return 'workgroup memory';
  if (b === 'nn' && N && N % t.BN) return 'N % BN';   // the [K][N] operand is read without a column clamp (as the standard kernel)
  return '';
}
/** the tile as it fits this device: a tile too big for 32-bit tiles gets half the k step (once); null if it still does not fit */
export function ssFit(t, o = {}) {
  if (!ssTileWhy(t, o)) return Object.assign({}, t);
  if (t.KS > 16) { const h = Object.assign({}, t, { KS: t.KS / 2 }); if (!ssTileWhy(h, o)) return h; }
  return null;
}

/** StormScope's GEMM with another tile ({BM, BN, KS, TM, TN}); the same bindings, uniforms and epilogues as gemmWGSL, and per output the
 *  same arithmetic: a tile value is the same f16 (rne16 or the GPU's own cast) or f32 value, a product is the same multiply, the sum
 *  runs over k from 0 up in f32 exactly as the standard kernel's. Dispatch [ceil(N / BN), ceil(M / BM), z]. */
export function ssGemmTiledWGSL({ f16, b, epi, rne = true, BM, BN, KS, TM, TN }) {
  const why = ssTileWhy({ BM, BN, KS, TM, TN }, { f16, b });
  if (why) throw new Error('ssGemmTiledWGSL: ' + why);
  const T = f16 ? 'f16' : 'f32', rn = f16 && rne;
  const TV = (v) => (rn ? `rne16(${v})` : `vec4<${T}>(${v})`);
  const BM4 = BM / 4, BN4 = BN / 4, KQ = KS / 4, TXN = BN / TN, NT = ssThreads({ BM, BN, TM, TN }), MQ = TM / 4, NQ = TN / 4;
  const L = [];
  if (f16) L.push('enable f16;');
  if (rn) L.push(RNE16_COPY);
  L.push(`struct P { M: u32, N: u32, K: u32, lda: u32, ldb: u32, ldc: u32, aOff: u32, bOff: u32, cOff: u32, aZ: u32, bZ: u32, cZ: u32,
  sOff: u32, gOff: u32, eOff: u32, gw: u32, gh: u32, kh: u32, kw: u32, bRows: u32, alpha: f32, p1: u32, p2: u32, p3: u32 };`);
  L.push('@group(0) @binding(0) var<uniform> p: P;');
  const B = [];
  const bind = (decl) => { B.push(decl); return `@group(0) @binding(${B.length}) var<storage, ${decl}`; };
  L.push(bind('read> A: array<vec4<f32>>;'));
  L.push(bind(b === 'i8' ? 'read> Bm: array<u32>;' : 'read> Bm: array<vec4<f32>>;'));
  L.push(bind('read_write> Cm: array<f32>;'));
  if (b === 'i8') L.push(bind('read> SB: array<f32>;'));
  if (epi === 'resgate') L.push(bind('read> G: array<f32>;'));
  if (epi === 'addbuf') L.push(bind('read> E: array<f32>;'));
  L.push(`var<workgroup> xs: array<vec4<${T}>, ${KS * BM4}>;`);   // [k][m/4]
  L.push(`var<workgroup> ws: array<vec4<${T}>, ${KS * BN4}>;`);   // [k][n/4]
  L.push(`fn aload(base: u32, row: u32, kk: u32) -> vec4<f32> { if (kk >= p.K) { return vec4<f32>(0.0); } return A[(base + row * p.lda + kk) / 4u]; }`);
  if (b === 'i8') L.push(`fn sb8(q: u32, i: u32) -> f32 { return f32((bitcast<i32>(q) << (24u - 8u * i)) >> 24u); }`);
  L.push(`fn allowed(m: u32, n: u32) -> bool {
  let qi = i32(m / p.gw); let qj = i32(m % p.gw); let ki = i32(n / p.gw); let kj = i32(n % p.gw);
  let si = clamp(qi - i32(p.kh / 2u), 0, i32(p.gh) - i32(p.kh)); let sj = clamp(qj - i32(p.kw / 2u), 0, i32(p.gw) - i32(p.kw));
  return ki >= si && ki < si + i32(p.kh) && kj >= sj && kj < sj + i32(p.kw); }`);
  L.push('fn epi(z: u32, m: u32, n: u32, a: f32) {');
  L.push('  if (m >= p.M || n >= p.N) { return; }');
  L.push('  let ci = p.cOff + z * p.cZ + m * p.ldc + n;');
  L.push(b === 'i8' ? '  let v = a * SB[p.sOff + n] + SB[p.sOff + p.N + n];' : '  let v = a * p.alpha;');
  if (epi === 'store') L.push('  Cm[ci] = v;');
  if (epi === 'gelu') L.push('  let u = clamp(0.7978845608 * (v + 0.044715 * v * v * v), -15.0, 15.0); Cm[ci] = 0.5 * v * (1.0 + tanh(u));');
  if (epi === 'resgate') L.push('  Cm[ci] = Cm[ci] + G[p.gOff + n] * v;');
  if (epi === 'addbuf') L.push('  Cm[ci] = v + E[p.eOff + m * p.ldc + n];');
  if (epi === 'mask') L.push('  Cm[ci] = select(-1.0e30, v, allowed(m, n));');
  L.push('}');
  L.push(`@compute @workgroup_size(${NT})`);
  L.push('fn main(@builtin(workgroup_id) wid: vec3<u32>, @builtin(local_invocation_index) li: u32) {');
  L.push(`  let mB = wid.y * ${BM}u; let nB = wid.x * ${BN}u; let z = wid.z;`);
  L.push('  let aBase = p.aOff + z * p.aZ; let bBase = p.bOff + z * p.bZ;');
  L.push(`  let tx = li % ${TXN}u; let ty = li / ${TXN}u; let lm = p.M - 1u; let ln = p.N - 1u;`);
  for (let r = 0; r < TM; r++) for (let j = 0; j < NQ; j++) L.push(`  var a${r}_${j} = vec4<f32>(0.0);`);
  L.push(`  for (var k0 = 0u; k0 < p.K; k0 = k0 + ${KS}u) {`);
  // X tile -> xs[k][m/4]: 4 rows x 4 k per task, transposed in registers, whole-vec4 stores
  L.push(`    for (var t = li; t < ${BM4 * KQ}u; t = t + ${NT}u) {`);
  L.push(`      let mq = t / ${KQ}u; let kq = t % ${KQ}u; let r0 = mB + mq * 4u; let kk = k0 + kq * 4u;`);
  L.push('      let v0 = aload(aBase, min(r0, lm), kk); let v1 = aload(aBase, min(r0 + 1u, lm), kk); let v2 = aload(aBase, min(r0 + 2u, lm), kk); let v3 = aload(aBase, min(r0 + 3u, lm), kk);');
  ['x', 'y', 'z', 'w'].forEach((c, j) => L.push(`      xs[(kq * 4u + ${j}u) * ${BM4}u + mq] = ${TV(`vec4<f32>(v0.${c}, v1.${c}, v2.${c}, v3.${c})`)};`));
  L.push('    }');
  if (b === 'i8') {
    L.push(`    for (var t = li; t < ${BN4 * KQ}u; t = t + ${NT}u) {`);
    L.push(`      let cq = t % ${BN4}u; let w = t / ${BN4}u; let n0 = nB + cq * 4u; let kw4 = k0 / 4u + w;`);
    L.push('      let q0 = Bm[bBase + min(n0, ln) * p.ldb + kw4]; let q1 = Bm[bBase + min(n0 + 1u, ln) * p.ldb + kw4];');
    L.push('      let q2 = Bm[bBase + min(n0 + 2u, ln) * p.ldb + kw4]; let q3 = Bm[bBase + min(n0 + 3u, ln) * p.ldb + kw4];');
    for (let i = 0; i < 4; i++) L.push(`      ws[(w * 4u + ${i}u) * ${BN4}u + cq] = vec4<${T}>(vec4<f32>(sb8(q0, ${i}u), sb8(q1, ${i}u), sb8(q2, ${i}u), sb8(q3, ${i}u)));`);
    L.push('    }');
  } else if (b === 'nt') {
    L.push(`    for (var t = li; t < ${BN4 * KQ}u; t = t + ${NT}u) {`);
    L.push(`      let cq = t % ${BN4}u; let kq = t / ${BN4}u; let n0 = nB + cq * 4u; let kk = k0 + kq * 4u;`);
    L.push('      let u0 = Bm[(bBase + min(n0, ln) * p.ldb + kk) / 4u]; let u1 = Bm[(bBase + min(n0 + 1u, ln) * p.ldb + kk) / 4u];');
    L.push('      let u2 = Bm[(bBase + min(n0 + 2u, ln) * p.ldb + kk) / 4u]; let u3 = Bm[(bBase + min(n0 + 3u, ln) * p.ldb + kk) / 4u];');
    ['x', 'y', 'z', 'w'].forEach((c, j) => L.push(`      ws[(kq * 4u + ${j}u) * ${BN4}u + cq] = ${TV(`vec4<f32>(u0.${c}, u1.${c}, u2.${c}, u3.${c})`)};`));
    L.push('    }');
  } else {
    L.push(`    for (var t = li; t < ${KS * BN4}u; t = t + ${NT}u) {`);
    L.push(`      let kk = t / ${BN4}u; let cq = t % ${BN4}u; let row = min(k0 + kk, p.bRows - 1u);`);
    L.push(`      ws[kk * ${BN4}u + cq] = ${TV('Bm[(bBase + row * p.ldb + nB + cq * 4u) / 4u]')};`);
    L.push('    }');
  }
  L.push('    workgroupBarrier();');
  L.push(`    for (var k = 0u; k < ${KS}u; k = k + 1u) {`);
  const xq = [], wq = [];
  for (let q = 0; q < MQ; q++) xq.push(`let x${q} = xs[k * ${BM4}u + ty * ${MQ}u${q ? ` + ${q}u` : ''}];`);
  for (let q = 0; q < NQ; q++) wq.push(`let w${q} = ws[k * ${BN4}u + tx * ${NQ}u${q ? ` + ${q}u` : ''}];`);
  L.push('      ' + xq.concat(wq).join(' '));
  for (let r = 0; r < TM; r++) {
    const xv = `x${r >> 2}.${'xyzw'[r & 3]}`;
    L.push('      ' + Array.from({ length: NQ }, (_, j) => `a${r}_${j} = a${r}_${j} + vec4<f32>(${xv} * w${j});`).join(' '));
  }
  L.push('    }');
  L.push('    workgroupBarrier();');
  L.push('  }');
  for (let r = 0; r < TM; r++) for (let j = 0; j < NQ; j++) for (let c = 0; c < 4; c++)
    L.push(`  epi(z, mB + ty * ${TM}u + ${r}u, nB + tx * ${TN}u + ${j * 4 + c}u, a${r}_${j}.${'xyzw'[c]});`);
  L.push('}');
  return { code: L.join('\n'), bindings: B.length };
}
// the f32 -> f16 round-to-nearest-even of nowcast/stormscope/kernels.js (RNE16), word for word (a test checks they are the same text)
const RNE16_COPY = `fn rne16(v: vec4<f32>) -> vec4<f16> {
  let b = bitcast<vec4<u32>>(v); let a = b & vec4<u32>(0x7fffffffu); let s = (b >> vec4<u32>(16u)) & vec4<u32>(0x8000u);
  let nrm = ((a + vec4<u32>(0xfffu) + ((a >> vec4<u32>(13u)) & vec4<u32>(1u))) >> vec4<u32>(13u)) - vec4<u32>(0x1c000u);
  let sub = vec4<u32>(round(bitcast<vec4<f32>>(a) * 16777216.0));
  let big = select(vec4<u32>(0x7c00u), vec4<u32>(0x7e00u), a > vec4<u32>(0x7f800000u));
  let h = s | select(select(nrm, big, a >= vec4<u32>(0x477ff000u)), sub, a < vec4<u32>(0x38800000u));
  return bitcast<vec4<f16>>(vec2<u32>(h.x | (h.y << 16u), h.z | (h.w << 16u)));
}`;
export const _RNE16_COPY = RNE16_COPY;   // tests

/** StormScope's GEMM sites in one forecast (9 steps x 7 evaluations x 16 blocks; attention per head) and the pick key each one uses
 *  (gemmPipe's b.epi). T = the 51 x 51 token tile, ldS = T rounded up to 4. Weights = dispatches of that shape per forecast. */
export function ssSites({ T = 2601, ldS = Math.ceil(2601 / 4) * 4, depth = 16, evals = 63, heads = 6, gw = 51, gh = 51, kernel = 49 } = {}) {
  const blk = depth * evals, win = { gw, gh, kh: Math.min(kernel, gh), kw: Math.min(kernel, gw) };
  const lin = (id, epi, N, K) => ({ id, b: 'i8', epi, M: T, N, K, lda: K, ldb: K / 4, ldc: N, weight: blk, ...win });
  return [
    { key: 'i8.store', sites: [lin('qkv', 'store', 2304, 768)] },
    { key: 'i8.gelu', sites: [lin('fc1', 'gelu', 3072, 768)] },
    { key: 'i8.resgate', sites: [lin('fc2', 'resgate', 768, 3072), lin('proj', 'resgate', 768, 768)] },
    { key: 'nt.mask', sites: [{ id: 'scores', b: 'nt', epi: 'mask', M: T, N: T, K: 128, lda: 128, ldb: 128, ldc: ldS, alpha: 1 / Math.sqrt(128), weight: blk * heads, ...win }] },
    { key: 'nn.store', sites: [{ id: 'values', b: 'nn', epi: 'store', M: T, N: 128, K: ldS, lda: ldS, ldb: 128, ldc: 768, bRows: T, weight: blk * heads, ...win }] },
  ];
}
/** the units StormScope tunes on this device: mode 'r' (f16 tiles, rne16) | 'h' (f16, the GPU's own casts) | 'f' (f32 tiles) */
export function planStormScope({ mode = 'r', cap = 5, sites = ssSites() } = {}) {
  const f16 = mode !== 'f';
  return sites.map((g) => {
    const N = g.sites[0].N, b = g.sites[0].b, cands = [{ id: 'standard', tile: null }];
    for (const t of SS_TILES) {
      const f = ssFit(t, { f16, b, N }); if (!f) continue;
      const id = tileId(f); if (id === tileId(SS_DEFAULT) || cands.some((c) => c.id === id)) continue;
      cands.push({ id, tile: f }); if (cands.length > cap) break;
    }
    return { model: 'stormscope', key: `${g.key}.${mode}`, label: g.sites.map((s) => s.id).join(' + '), mode, sites: g.sites, cands };
  });
}

// ------------------------------------------------------------------------------------------------ DGMR (float) convolution
/** the standard DGMR conv: 64 output pixels x 64 output channels a workgroup, 4 x 4 a thread (256 threads), k step 16 */
export const DGMR_DEFAULT = Object.freeze({ BM: 64, BN: 64, KS: 16, TM: 4, TN: 4 });
const DG64 = [
  { BM: 64, BN: 32, KS: 16, TM: 4, TN: 4 },     // 128 threads
  { BM: 32, BN: 64, KS: 16, TM: 4, TN: 4 },     // 128 threads
  { BM: 64, BN: 64, KS: 16, TM: 8, TN: 4 },     // 128 threads, 8 pixels a thread
  { BM: 128, BN: 64, KS: 16, TM: 8, TN: 4 },    // 256 threads, taller tile
  { BM: 64, BN: 64, KS: 32, TM: 4, TN: 4 },     // the standard tile, twice the k step
];
const DG48 = [   // 48 and 96 output channels: a 48-wide tile wastes no threads
  { BM: 64, BN: 48, KS: 16, TM: 4, TN: 4 },     // 192 threads
  { BM: 128, BN: 48, KS: 16, TM: 8, TN: 4 },    // 192 threads
  { BM: 64, BN: 32, KS: 16, TM: 4, TN: 4 },
  { BM: 32, BN: 64, KS: 16, TM: 4, TN: 4 },
  { BM: 64, BN: 64, KS: 32, TM: 4, TN: 4 },
];
export const dgThreads = (t) => (t.BM / t.TM) * (t.BN / t.TN);
export const dgWgBytes = (t) => (t.BM + t.BN) * t.KS * 4;
export function dgTileWhy(t) {
  if (![4, 8].includes(t.TM) || t.TN !== 4) return 'outputs per thread';
  if (t.BM % t.TM || t.BN % t.TN || t.KS % 4 || t.KS < 4) return 'tile shape';
  const nt = dgThreads(t);
  if (nt > WG_THREADS || nt < 16) return 'threads';
  if (dgWgBytes(t) > WG_BYTES) return 'workgroup memory';
  return '';
}

/** DGMR's conv kernel with another tile: convF's bindings, uniforms, loads, epilogue and split-K partial sums, field for field; per output
 *  the same fma chain over k (in the same order, the same split parts), so the same f32 bits. The fin entry (the split parts' sum) is
 *  convF's own. Dispatch [ceil(cout / BN), ceil(mcnt / BM), split]. */
export function dgmrConvTiledWGSL(wenc, { BM, BN, KS, TM, TN }) {
  const why = dgTileWhy({ BM, BN, KS, TM, TN }); if (why) throw new Error('dgmrConvTiledWGSL: ' + why);
  const KQ = KS / 4, NT = dgThreads({ BM, BN, TM, TN }), TXN = BN / TN, RS = BM / TM, NQ = TN / 4;
  const TA = Math.ceil(BM * KQ / NT), TB = Math.ceil(BN * KQ / NT), full = (n, s) => (s + 1) * NT <= n;
  const L = [];
  L.push(`struct U {
  m0: u32, mcnt: u32, H: u32, W: u32,
  cout: u32, ktot: u32, k: u32, up: u32,
  hin: u32, win: u32, nref: u32, cin: u32,
  kper: u32, out_i0: u32, act: u32, split: u32,
  boff: u32, woff: u32, nsplit: u32, p0: u32,
  r: array<vec4<u32>, 8>,
}
@group(0) @binding(0) var<uniform> u: U;
@group(0) @binding(1) var<storage, read> in0: array<vec4<f32>>;
@group(0) @binding(2) var<storage, read> in1: array<vec4<f32>>;
@group(0) @binding(3) var<storage, read> wts: array<u32>;
@group(0) @binding(4) var<storage, read_write> outb: array<vec4<f32>>;
@group(0) @binding(5) var<storage, read_write> scr: array<vec4<f32>>;

var<workgroup> As: array<f32, ${BM * KS}>;
var<workgroup> Bs: array<f32, ${KS * BN}>;

fn ld(buf: u32, idx: u32) -> vec4<f32> { if (buf == 0u) { return in0[idx]; } return in1[idx]; }
fn wf(i: u32) -> f32 { return bitcast<f32>(wts[i]); }

fn epi(acc: vec4<f32>, co0: u32) -> vec4<f32> {
  let b = u.boff + co0;
  var v = acc + vec4<f32>(wf(b), wf(b + 1u), wf(b + 2u), wf(b + 3u));
  if (u.act == 1u) { v = max(v, vec4<f32>(0.0)); }
  else if (u.act == 2u) { v = 1.0 / (1.0 + exp(-v)); }
  return v;
}
fn store(m: u32, co0: u32, v: vec4<f32>) {
  let hw = u.H * u.W;
  let img = m / hw; let rem = m - img * hw;
  outb[((u.out_i0 + img) * hw + rem) * (u.cout / 4u) + co0 / 4u] = v;
}`);
  L.push(`@compute @workgroup_size(${NT})`);
  L.push('fn main(@builtin(workgroup_id) wg: vec3<u32>, @builtin(local_invocation_index) tid: u32) {');
  L.push(`  let tx = tid % ${TXN}u; let ty = tid / ${TXN}u;`);
  L.push('  let pad = i32(u.k / 2u);');
  L.push('  let hw = u.H * u.W;');
  for (let s = 0; s < TA; s++) {   // A tasks: (pixel, 4 k) pairs, decoded once
    L.push(`  let ta${s} = tid + ${s * NT}u; let pa${s} = ta${s} % ${BM}u; let kg${s} = ta${s} / ${BM}u;`);
    L.push(`  let ma${s} = u.m0 + wg.y * ${BM}u + pa${s};`);
    L.push(`  let mvalid${s} = ma${s} < u.m0 + u.mcnt${full(BM * KQ, s) ? '' : ` && ta${s} < ${BM * KQ}u`};`);
    L.push(`  let img${s} = ma${s} / hw; let rem${s} = ma${s} - img${s} * hw; let oy${s} = rem${s} / u.W; let ox${s} = rem${s} - oy${s} * u.W;`);
  }
  for (let s = 0; s < TB; s++) {   // B tasks: (output channel, 4 k) pairs
    L.push(`  let tb${s} = tid + ${s * NT}u; let co_l${s} = tb${s} % ${BN}u; let kgb${s} = tb${s} / ${BN}u; let cob${s} = wg.x * ${BN}u + co_l${s};`);
  }
  L.push(`  var acc: array<vec4<f32>, ${TM * NQ}>;`);
  L.push(`  for (var i = 0u; i < ${TM * NQ}u; i++) { acc[i] = vec4<f32>(0.0); }`);
  L.push('  let kbeg = wg.z * u.kper;');
  L.push('  let kend = min(u.ktot, kbeg + u.kper);');
  L.push(`  for (var kb = kbeg; kb < kend; kb += ${KS}u) {`);
  for (let s = 0; s < TA; s++) {
    const own = full(BM * KQ, s);
    L.push(`    ${own ? '' : `if (ta${s} < ${BM * KQ}u) `}{`);
    L.push(`      let kidx = kb + kg${s} * 4u;`);
    L.push('      var av = vec4<f32>(0.0);');
    L.push(`      if (mvalid${s} && kidx < kend) {`);
    L.push('        let tap = kidx / u.cin; let ci = kidx - tap * u.cin;');
    L.push('        let dy = i32(tap / u.k); let dx = i32(tap % u.k);');
    L.push(`        let yy = i32(oy${s}) + dy - pad; let xx = i32(ox${s}) + dx - pad;`);
    L.push('        if (yy >= 0 && yy < i32(u.H) && xx >= 0 && xx < i32(u.W)) {');
    L.push('          var iy = u32(yy); var ix = u32(xx);');
    L.push('          if (u.up == 1u) { iy = iy >> 1u; ix = ix >> 1u; }');
    L.push('          for (var r = 0u; r < u.nref; r++) {');
    L.push('            let a = u.r[2u * r]; let b = u.r[2u * r + 1u];');
    L.push('            if (ci >= a.w && ci < a.w + a.z) {');
    L.push(`              av = ld(a.x, ((a.y + img${s}) * u.hin * u.win + iy * u.win + ix) * (a.z / 4u) + (ci - a.w) / 4u);`);
    L.push('              if (b.x == 1u) { av = max(av, vec4<f32>(0.0)); }');
    L.push('            }');
    L.push('          }');
    L.push('        }');
    L.push('      }');
    ['x', 'y', 'z', 'w'].forEach((c, j) => L.push(`      As[(kg${s} * 4u + ${j}u) * ${BM}u + pa${s}] = av.${c};`));
    L.push('    }');
  }
  for (let s = 0; s < TB; s++) {
    const own = full(BN * KQ, s);
    L.push(`    ${own ? '' : `if (tb${s} < ${BN * KQ}u) `}{`);
    L.push(`      let kidx = kb + kgb${s} * 4u; let cob = cob${s};`);
    L.push('      var bv = vec4<f32>(0.0);');
    L.push('      if (kidx < kend && cob < u.cout) {');
    if (wenc === 'f16') {
      L.push('        let w0 = unpack2x16float(wts[u.woff + (kidx / 2u) * u.cout + cob]);');
      L.push('        let w1 = unpack2x16float(wts[u.woff + (kidx / 2u + 1u) * u.cout + cob]);');
      L.push('        bv = vec4<f32>(w0.x, w0.y, w1.x, w1.y);');
    } else {
      L.push('        bv = vec4<f32>(wf(u.woff + kidx * u.cout + cob), wf(u.woff + (kidx + 1u) * u.cout + cob), wf(u.woff + (kidx + 2u) * u.cout + cob), wf(u.woff + (kidx + 3u) * u.cout + cob));');
    }
    L.push('      }');
    ['x', 'y', 'z', 'w'].forEach((c, j) => L.push(`      Bs[(kgb${s} * 4u + ${j}u) * ${BN}u + co_l${s}] = bv.${c};`));
    L.push('    }');
  }
  L.push('    workgroupBarrier();');
  L.push(`    for (var kk = 0u; kk < ${KS}u; kk++) {`);
  for (let j = 0; j < NQ; j++) {
    const o = `kk * ${BN}u + tx * ${TN}u${j ? ` + ${4 * j}u` : ''}`;
    L.push(`      let b${j} = vec4<f32>(Bs[${o}], Bs[${o} + 1u], Bs[${o} + 2u], Bs[${o} + 3u]);`);
  }
  L.push(`      for (var i = 0u; i < ${TM}u; i++) {`);
  L.push(`        let a = vec4<f32>(As[kk * ${BM}u + ty + ${RS}u * i]);`);
  for (let j = 0; j < NQ; j++) L.push(`        acc[i * ${NQ}u + ${j}u] = fma(a, b${j}, acc[i * ${NQ}u + ${j}u]);`);
  L.push('      }');
  L.push('    }');
  L.push('    workgroupBarrier();');
  L.push('  }');
  L.push(`  for (var j = 0u; j < ${NQ}u; j++) {`);
  L.push(`    let co0 = wg.x * ${BN}u + tx * ${TN}u + 4u * j;`);
  L.push('    if (co0 >= u.cout) { continue; }');
  L.push(`    for (var i = 0u; i < ${TM}u; i++) {`);
  L.push(`      let m = u.m0 + wg.y * ${BM}u + ty + ${RS}u * i;`);
  L.push('      if (m >= u.m0 + u.mcnt) { continue; }');
  L.push(`      let v = acc[i * ${NQ}u + j];`);
  L.push('      if (u.split == 1u) { scr[(wg.z * u.mcnt + (m - u.m0)) * (u.cout / 4u) + co0 / 4u] = v; }');
  L.push('      else { store(m, co0, epi(v, co0)); }');
  L.push('    }');
  L.push('  }');
  L.push('}');
  return L.join('\n');
}

/** the shape of one DGMR conv op (the model's own tensors) */
export function dgmrConvShape(T, op) {
  const o = T[op.out.t], cin = op.ins.reduce((s, r) => s + T[r.t].c, 0), slots = [];
  for (const r of op.ins) if (!slots.includes(r.t)) slots.push(r.t);
  const ti = T[op.ins[0].t];
  return { n: op.out.n, H: o.h, W: o.w, cout: o.c, cin, k: op.k, up: op.up ? 1 : 0, nref: op.ins.length, nslot: slots.length,
    Hin: ti.h, Win: ti.w, ktot: op.k * op.k * cin, mcnt: op.out.n * o.h * o.w, act: op.act || 'none',
    refs: op.ins.map((r) => ({ slot: slots.indexOf(r.t), C: T[r.t].c, relu: r.relu ? 1 : 0 })) };
}
/** the key a DGMR conv's pick is filed under: its shape and how many inputs it reads (two convs with one key run the same code path) */
export const dgmrConvKey = (s) => `${s.n}x${s.H}x${s.W}.${s.cin}-${s.cout}.k${s.k}u${s.up}r${s.nref}`;
/** dgmr.js Dgmr._split, the same arithmetic: how a long sum is cut in parts (a test checks they agree) */
export function dgmrSplit(cout, mcnt, ktot) {
  const blocks = Math.ceil(cout / 64) * Math.ceil(mcnt / 64);
  let split = 1;
  if (blocks < 32 && ktot >= 2048) split = Math.max(1, Math.min(Math.ceil(64 / blocks), Math.floor(ktot / 512)));
  let kper = Math.ceil(ktot / split / 16) * 16; split = Math.ceil(ktot / kper);
  if (split === 1) kper = Math.ceil(ktot / 16) * 16;
  return { split, kper };
}
/** DGMR's units: one per conv shape, the heaviest first, until `coverage` of the model's multiply-adds (at most maxUnits). A site holds
 *  at most outCap bytes of output: a conv over many images is timed on fewer images (images are independent; weight scales back up).
 *  -> { units, macsAll, macsTuned } */
export function planDgmr(m, { cap = 5, coverage = 0.9, maxUnits = 16, outCap = 32 * 1048576 } = {}) {
  if (!m || !Array.isArray(m.ops)) return { units: [], macsAll: 0, macsTuned: 0 };
  const T = m.tensors, groups = new Map(); let macsAll = 0;
  for (const op of m.ops) {
    if (op.op !== 'conv') continue;
    const s = dgmrConvShape(T, op), key = dgmrConvKey(s), macs = s.mcnt * s.cout * s.ktot;
    macsAll += macs;
    if (!groups.has(key)) groups.set(key, { key, shape: s, count: 0, macs: 0 });
    const g = groups.get(key); g.count++; g.macs += macs;
  }
  const order = [...groups.values()].sort((a, b) => b.macs - a.macs || (a.key < b.key ? -1 : 1));
  const units = []; let macsTuned = 0;
  for (const g of order) {
    if (units.length >= maxUnits || macsTuned >= coverage * macsAll) break;
    const s = g.shape, per = s.H * s.W * s.cout * 4, nn = Math.max(1, Math.min(s.n, Math.floor(outCap / per)));
    const sh = Object.assign({}, s, { n: nn, mcnt: nn * s.H * s.W });
    const real = dgmrSplit(s.cout, s.mcnt, s.ktot), cut = dgmrSplit(sh.cout, sh.mcnt, sh.ktot);
    if (real.split !== cut.split || real.kper !== cut.kper) { sh.n = s.n; sh.mcnt = s.mcnt; }   // never time another split than the model's
    const list = s.cout % 64 === 0 ? DG64 : DG48, cands = [{ id: 'standard', tile: null }];
    for (const t of list) { if (dgTileWhy(t) || tileId(t) === tileId(DGMR_DEFAULT)) continue; cands.push({ id: tileId(t), tile: Object.assign({}, t) }); if (cands.length > cap) break; }
    units.push({ model: 'dgmr', key: g.key, label: `${s.cin}→${s.cout} ${s.H}×${s.W}`, wenc: m.wenc || 'f16',
      sites: [Object.assign({ id: g.key, weight: g.count * s.n / sh.n }, sh, dgmrSplit(sh.cout, sh.mcnt, sh.ktot))], cands, macs: g.macs });
    macsTuned += g.macs;
  }
  return { units, macsAll, macsTuned };
}

// ------------------------------------------------------------------------------------------------ the saved tables, checked again
const isTile = (t) => !!t && typeof t === 'object' && ['BM', 'BN', 'KS', 'TM', 'TN'].every((k) => Number.isInteger(t[k]) && t[k] > 0);
/** a model's saved table with every entry the engine could not build left out (storage edited, or written by another version):
 *  stormscope { 'b.epi.mode': tile } | dgmr { key: tile } | beam { layer: [BM, BN] } (layers: beam.js LAYERS, for each layer's N) */
export function cleanTable(model, table, { layers = null } = {}) {
  const out = {};
  if (!table || typeof table !== 'object') return out;
  for (const [k, v] of Object.entries(table)) {
    if (model === 'stormscope') {
      const m = /^(i8|nt|nn)\.(store|gelu|resgate|addbuf|mask)\.([rhf])$/.exec(k);
      if (m && isTile(v) && !ssTileWhy(v, { f16: m[3] !== 'f', b: m[1], N: m[1] === 'nn' ? 128 : 0 })) out[k] = { BM: v.BM, BN: v.BN, KS: v.KS, TM: v.TM, TN: v.TN };
    } else if (model === 'dgmr') {
      if (isTile(v) && !dgTileWhy(v)) out[k] = { BM: v.BM, BN: v.BN, KS: v.KS, TM: v.TM, TN: v.TN };
    } else if (model === 'beam') {
      const l = layers && layers.find((x) => x.name === k && (x.kind === 'conv' || x.kind === 'up'));
      if (l && Array.isArray(v) && v.length === 2 && v.every((x) => Number.isInteger(x) && x > 0) && !beamTileWhy(v, { N: l.kind === 'up' ? 4 * l.Co : l.Co, f16: true })
        && !beamTileWhy(v, { N: l.kind === 'up' ? 4 * l.Co : l.Co, f16: false })) out[k] = [v[0], v[1]];
    }
  }
  return out;
}

// ------------------------------------------------------------------------------------------------ BEAM
/** the tiles BEAM's conv generator can take ([BM, BN], 8 x 8 outputs a thread), tried nearest the layer's standard tile first */
export const BEAM_TILES = Object.freeze([[32, 32], [64, 32], [128, 32], [192, 32], [32, 64], [64, 64], [128, 64], [64, 128], [128, 128], [32, 128]]);
/** BEAM's own tile rules (convWGSL's checks) plus the 16 KB ceiling -> '' | why not */
export function beamTileWhy([BM, BN], { N, f16 = true }) {
  const KQ = (f16 ? 32 : 16) / 4, NT = (BN / 8) * (BM / 8);
  if (N % BN) return 'N % BN';
  if (BN % 8 || BM % 8 || NT > WG_THREADS || NT < KQ || NT % KQ) return 'tile';
  if (64 * (BM + BN) > WG_BYTES) return 'workgroup memory';
  return '';
}
/** BEAM's units: one per layer (its convs and transposes, as BeamNet.load builds them), each with the layer's standard tile first.
 *  layers / defaults: beam.js LAYERS / DEFAULT_TILES */
export function planBeam({ layers, defaults, f16 = true, cap = 3 }) {
  const units = [];
  for (const l of layers || []) {
    if (l.kind !== 'conv' && l.kind !== 'up') continue;
    const up = l.kind === 'up', H = up ? l.Hin : l.H, N = up ? 4 * l.Co : l.Co, Kreal = up ? l.Ci : 9 * l.Ci, Kpad = Math.ceil(Kreal / 32) * 32;
    const def = up ? defaults[l.name] : (defaults[l.name] || defaults['c' + l.Co]);
    const c = { f16, ks: up ? 1 : 3, H, W: H, Ci: l.Ci, ldx: l.src.ld, cx0: l.src.c0, N, Kpad, Kreal, ldy: l.dst.ld, cy0: l.dst.c0,
      epi: up ? 'up' : 'store', Cup: up ? l.Co : 0, acc: 'f32' };
    const dist = (t) => Math.abs(Math.log2(t[0] / def[0])) + Math.abs(Math.log2(t[1] / def[1]));
    const alts = BEAM_TILES.filter((t) => (t[0] !== def[0] || t[1] !== def[1]) && !beamTileWhy(t, { N, f16 })).sort((a, b) => dist(a) - dist(b) || a[0] * a[1] - b[0] * b[1]);
    const cands = [{ id: 'standard', tile: def.slice() }, ...alts.slice(0, cap).map((t) => ({ id: `${t[0]}x${t[1]}`, tile: t.slice() }))];
    units.push({ model: 'beam', key: l.name, label: l.name, sites: [{ id: l.name, weight: 1, conv: c, M: H * H, out: (up ? 4 : 1) * H * H * l.dst.ld }], cands });
  }
  return { units };
}
