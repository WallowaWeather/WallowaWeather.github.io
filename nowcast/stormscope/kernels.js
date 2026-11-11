// StormScope MRMS kernels (WGSL). Activations are f32 in device memory; GEMM tiles are f16 when the device has shader-f16
// (int8 weights are exact in f16), else f32; every f32 -> f16 tile value goes through rne16 (below) unless the device's own
// conversion was probed to round to nearest even (ss.js f16Rounding: then the plain casts). Accumulation is always f32.
// iOS-safe patterns: <= 16 KB workgroup memory, <= 256 threads, no subgroups, and NEVER a single-component
// store into a shared vec4 (Metal races).
'use strict';

const BM = 64, BN = 64, KS = 32;   // 8 x 8 outputs per thread, 64 threads
// f32 -> f16 rounded to nearest, ties to even, in integer maths (the BEAM engine's rne4): WGSL lets a GPU's own conversion round
// either way (one GPU tried truncates its casts; pack2x16float truncated on both GPUs tried), so the halves are rounded here,
// the same on every device, as numpy and PyTorch round them. Normal halves: add 0xfff + the kept lowest bit, shift, re-bias;
// |x| >= 65520 -> inf; |x| < 2^-14: round(|x| * 2^24) (ties to even in WGSL) is the subnormal's bits; NaN stays NaN.
export const RNE16 = `fn rne16(v: vec4<f32>) -> vec4<f16> {
  let b = bitcast<vec4<u32>>(v); let a = b & vec4<u32>(0x7fffffffu); let s = (b >> vec4<u32>(16u)) & vec4<u32>(0x8000u);
  let nrm = ((a + vec4<u32>(0xfffu) + ((a >> vec4<u32>(13u)) & vec4<u32>(1u))) >> vec4<u32>(13u)) - vec4<u32>(0x1c000u);
  let sub = vec4<u32>(round(bitcast<vec4<f32>>(a) * 16777216.0));
  let big = select(vec4<u32>(0x7c00u), vec4<u32>(0x7e00u), a > vec4<u32>(0x7f800000u));
  let h = s | select(select(nrm, big, a >= vec4<u32>(0x477ff000u)), sub, a < vec4<u32>(0x38800000u));
  return bitcast<vec4<f16>>(vec2<u32>(h.x | (h.y << 16u), h.z | (h.w << 16u)));
}`;

/** GEMM  C[m, n] (epi)= sum_k A[m, k] * B(k, n)
 *  b: 'i8' (B = int8 rows [N][K] packed in u32, per-row scale + bias in SB) | 'nt' (B f32 [N][K]) | 'nn' (B f32 [K][N])
 *  epi: 'store' | 'gelu' | 'resgate' (C += G[n] * v) | 'addbuf' (C = v + E) | 'mask' (2D neighbourhood window, else -1e30)
 *  rne (f16 only): true = tile values rounded by rne16; false = the GPU's own casts (only where they were probed to round to nearest) */
export function gemmWGSL({ f16, b, epi, rne = true }) {
  const T = f16 ? 'f16' : 'f32', rn = f16 && rne;
  const TV = (v) => (rn ? `rne16(${v})` : `vec4<${T}>(${v})`);   // a vec4<f32> -> a tile value
  const L = [];
  if (f16) L.push('enable f16;');
  if (rn) L.push(RNE16);
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
  L.push(`var<workgroup> xs: array<vec4<${T}>, ${KS * BM / 4}>;`);   // [k][m/4]
  L.push(`var<workgroup> ws: array<vec4<${T}>, ${KS * BN / 4}>;`);   // [k][n/4]
  L.push(`fn aload(base: u32, row: u32, kk: u32) -> vec4<f32> { if (kk >= p.K) { return vec4<f32>(0.0); } return A[(base + row * p.lda + kk) / 4u]; }`);
  if (b === 'i8') L.push(`fn sb8(q: u32, i: u32) -> f32 { return f32((bitcast<i32>(q) << (24u - 8u * i)) >> 24u); }`);
  L.push(`fn allowed(m: u32, n: u32) -> bool {
  let qi = i32(m / p.gw); let qj = i32(m % p.gw); let ki = i32(n / p.gw); let kj = i32(n % p.gw);
  let si = clamp(qi - i32(p.kh / 2u), 0, i32(p.gh) - i32(p.kh)); let sj = clamp(qj - i32(p.kw / 2u), 0, i32(p.gw) - i32(p.kw));
  return ki >= si && ki < si + i32(p.kh) && kj >= sj && kj < sj + i32(p.kw); }`);
  // epilogue for one output
  const ep = [];
  ep.push(`fn epi(z: u32, m: u32, n: u32, a: f32) {`);
  ep.push(`  if (m >= p.M || n >= p.N) { return; }`);
  ep.push(`  let ci = p.cOff + z * p.cZ + m * p.ldc + n;`);
  if (b === 'i8') ep.push(`  let v = a * SB[p.sOff + n] + SB[p.sOff + p.N + n];`); else ep.push(`  let v = a * p.alpha;`);
  if (epi === 'store') ep.push(`  Cm[ci] = v;`);
  if (epi === 'gelu') ep.push(`  let u = clamp(0.7978845608 * (v + 0.044715 * v * v * v), -15.0, 15.0); Cm[ci] = 0.5 * v * (1.0 + tanh(u));`);
  if (epi === 'resgate') ep.push(`  Cm[ci] = Cm[ci] + G[p.gOff + n] * v;`);
  if (epi === 'addbuf') ep.push(`  Cm[ci] = v + E[p.eOff + m * p.ldc + n];`);
  if (epi === 'mask') ep.push(`  Cm[ci] = select(-1.0e30, v, allowed(m, n));`);
  ep.push('}');
  L.push(...ep);
  L.push('@compute @workgroup_size(64)');
  L.push('fn main(@builtin(workgroup_id) wid: vec3<u32>, @builtin(local_invocation_index) li: u32) {');
  L.push('  let mB = wid.y * 64u; let nB = wid.x * 64u; let z = wid.z;');
  L.push('  let aBase = p.aOff + z * p.aZ; let bBase = p.bOff + z * p.bZ;');
  L.push('  let tx = li % 8u; let ty = li / 8u; let lm = p.M - 1u; let ln = p.N - 1u;');
  for (let r = 0; r < 8; r++) for (let j = 0; j < 2; j++) L.push(`  var a${r}_${j} = vec4<f32>(0.0);`);
  L.push(`  for (var k0 = 0u; k0 < p.K; k0 = k0 + ${KS}u) {`);
  // X tile -> xs[k][m/4]: 4 rows x 4 k per task, transposed in registers, whole-vec4 stores
  L.push('    for (var t = li; t < 128u; t = t + 64u) {');
  L.push('      let mq = t / 8u; let kq = t % 8u; let r0 = mB + mq * 4u; let kk = k0 + kq * 4u;');
  L.push('      let v0 = aload(aBase, min(r0, lm), kk); let v1 = aload(aBase, min(r0 + 1u, lm), kk); let v2 = aload(aBase, min(r0 + 2u, lm), kk); let v3 = aload(aBase, min(r0 + 3u, lm), kk);');
  ['x', 'y', 'z', 'w'].forEach((c, j) => L.push(`      xs[(kq * 4u + ${j}u) * 16u + mq] = ${TV(`vec4<f32>(v0.${c}, v1.${c}, v2.${c}, v3.${c})`)};`));
  L.push('    }');
  if (b === 'i8') {   // B int8 rows: u32 index = bBase + n * ldb + k/4 (int8 -> f16 is exact: no rounding to choose)
    L.push('    for (var t = li; t < 128u; t = t + 64u) {');
    L.push('      let cq = t % 16u; let w = t / 16u; let n0 = nB + cq * 4u; let kw4 = k0 / 4u + w;');
    L.push('      let q0 = Bm[bBase + min(n0, ln) * p.ldb + kw4]; let q1 = Bm[bBase + min(n0 + 1u, ln) * p.ldb + kw4];');
    L.push('      let q2 = Bm[bBase + min(n0 + 2u, ln) * p.ldb + kw4]; let q3 = Bm[bBase + min(n0 + 3u, ln) * p.ldb + kw4];');
    for (let i = 0; i < 4; i++) L.push(`      ws[(w * 4u + ${i}u) * 16u + cq] = vec4<${T}>(vec4<f32>(sb8(q0, ${i}u), sb8(q1, ${i}u), sb8(q2, ${i}u), sb8(q3, ${i}u)));`);
    L.push('    }');
  } else if (b === 'nt') {   // B f32 [N][K] (vec4 units)
    L.push('    for (var t = li; t < 128u; t = t + 64u) {');
    L.push('      let cq = t % 16u; let kq = t / 16u; let n0 = nB + cq * 4u; let kk = k0 + kq * 4u;');
    L.push('      let u0 = Bm[(bBase + min(n0, ln) * p.ldb + kk) / 4u]; let u1 = Bm[(bBase + min(n0 + 1u, ln) * p.ldb + kk) / 4u];');
    L.push('      let u2 = Bm[(bBase + min(n0 + 2u, ln) * p.ldb + kk) / 4u]; let u3 = Bm[(bBase + min(n0 + 3u, ln) * p.ldb + kk) / 4u];');
    ['x', 'y', 'z', 'w'].forEach((c, j) => L.push(`      ws[(kq * 4u + ${j}u) * 16u + cq] = ${TV(`vec4<f32>(u0.${c}, u1.${c}, u2.${c}, u3.${c})`)};`));
    L.push('    }');
  } else {   // nn: B f32 [K][N]; rows beyond bRows clamp (A is zero there)
    L.push('    for (var t = li; t < 512u; t = t + 64u) {');
    L.push('      let kk = t / 16u; let cq = t % 16u; let row = min(k0 + kk, p.bRows - 1u);');
    L.push(`      ws[kk * 16u + cq] = ${TV('Bm[(bBase + row * p.ldb + nB + cq * 4u) / 4u]')};`);
    L.push('    }');
  }
  L.push('    workgroupBarrier();');
  L.push(`    for (var k = 0u; k < ${KS}u; k = k + 1u) {`);
  L.push('      let xa = xs[k * 16u + ty * 2u]; let xb = xs[k * 16u + ty * 2u + 1u]; let wa = ws[k * 16u + tx * 2u]; let wb = ws[k * 16u + tx * 2u + 1u];');
  const xc = ['xa.x', 'xa.y', 'xa.z', 'xa.w', 'xb.x', 'xb.y', 'xb.z', 'xb.w'];
  for (let r = 0; r < 8; r++) L.push(`      a${r}_0 = a${r}_0 + vec4<f32>(${xc[r]} * wa); a${r}_1 = a${r}_1 + vec4<f32>(${xc[r]} * wb);`);
  L.push('    }');
  L.push('    workgroupBarrier();');
  L.push('  }');
  for (let r = 0; r < 8; r++) for (let j = 0; j < 2; j++) for (let c = 0; c < 4; c++)
    L.push(`  epi(z, mB + ty * 8u + ${r}u, nB + tx * 8u + ${j * 4 + c}u, a${r}_${j}.${'xyzw'[c]});`);
  L.push('}');
  return { code: L.join('\n'), bindings: B.length };
}

/** row softmax in place over [rows][ld], first T entries; pad columns T..ld-1 set to 0 */
export const SOFTMAX = `
struct P { T: u32, ld: u32, p0: u32, p1: u32 };
@group(0) @binding(0) var<uniform> p: P;
@group(0) @binding(1) var<storage, read_write> S: array<f32>;
var<workgroup> red: array<f32, 256>;
@compute @workgroup_size(256)
fn main(@builtin(workgroup_id) wid: vec3<u32>, @builtin(local_invocation_index) li: u32) {
  let base = (wid.x + wid.y * 65535u) * p.ld;
  var mx = -3.0e38;
  for (var i = li; i < p.T; i = i + 256u) { mx = max(mx, S[base + i]); }
  red[li] = mx; workgroupBarrier();
  for (var s = 128u; s > 0u; s = s >> 1u) { if (li < s) { red[li] = max(red[li], red[li + s]); } workgroupBarrier(); }
  mx = red[0]; workgroupBarrier();
  var sm = 0.0;
  for (var i = li; i < p.T; i = i + 256u) { let e = exp(S[base + i] - mx); S[base + i] = e; sm = sm + e; }
  red[li] = sm; workgroupBarrier();
  for (var s = 128u; s > 0u; s = s >> 1u) { if (li < s) { red[li] = red[li] + red[li + s]; } workgroupBarrier(); }
  let inv = 1.0 / red[0];
  for (var i = li; i < p.ld; i = i + 256u) { S[base + i] = select(0.0, S[base + i] * inv, i < p.T); }
}`;

/** LayerNorm (no affine) + adaLN modulation: Y = (x - mean) * rstd * (1 + scale) + shift; MOD[modOff..] = shift, MOD[modOff+D..] = scale */
export const LNMOD = `
struct P { D: u32, modOff: u32, eps: f32, p0: u32 };
@group(0) @binding(0) var<uniform> p: P;
@group(0) @binding(1) var<storage, read> X: array<f32>;
@group(0) @binding(2) var<storage, read_write> Y: array<f32>;
@group(0) @binding(3) var<storage, read> MOD: array<f32>;
var<workgroup> red: array<f32, 256>;
fn reduce(v: f32, li: u32) -> f32 {
  red[li] = v; workgroupBarrier();
  for (var s = 128u; s > 0u; s = s >> 1u) { if (li < s) { red[li] = red[li] + red[li + s]; } workgroupBarrier(); }
  let r = red[0]; workgroupBarrier(); return r;
}
@compute @workgroup_size(256)
fn main(@builtin(workgroup_id) wid: vec3<u32>, @builtin(local_invocation_index) li: u32) {
  let base = wid.x * p.D;
  var s = 0.0;
  for (var i = li; i < p.D; i = i + 256u) { s = s + X[base + i]; }
  let mean = reduce(s, li) / f32(p.D);
  var q = 0.0;
  for (var i = li; i < p.D; i = i + 256u) { let d = X[base + i] - mean; q = q + d * d; }
  let rstd = inverseSqrt(reduce(q, li) / f32(p.D) + p.eps);
  for (var i = li; i < p.D; i = i + 256u) {
    Y[base + i] = (X[base + i] - mean) * rstd * (1.0 + MOD[p.modOff + p.D + i]) + MOD[p.modOff + i];
  }
}`;

/** per-head affine LayerNorm on q and k (eps 1e-5) + axial 2D RoPE (interleaved pairs) + head-major Q/K/V.
 *  QKV [T][2304] (q | k | v, heads contiguous); NRM = [qw|qb|kw|kb] (4 x 128); ROPE = [cos T x 128 | sin T x 128] */
export const QKROPE = `
struct P { T: u32, eps: f32, p0: u32, p1: u32 };
@group(0) @binding(0) var<uniform> p: P;
@group(0) @binding(1) var<storage, read> QKV: array<f32>;
@group(0) @binding(2) var<storage, read> NRM: array<f32>;
@group(0) @binding(3) var<storage, read> ROPE: array<f32>;
@group(0) @binding(4) var<storage, read_write> QH: array<f32>;
@group(0) @binding(5) var<storage, read_write> KH: array<f32>;
@group(0) @binding(6) var<storage, read_write> VH: array<f32>;
var<workgroup> red: array<f32, 128>;
var<workgroup> buf: array<f32, 128>;
fn reduce(v: f32, li: u32) -> f32 {
  red[li] = v; workgroupBarrier();
  for (var s = 64u; s > 0u; s = s >> 1u) { if (li < s) { red[li] = red[li] + red[li + s]; } workgroupBarrier(); }
  let r = red[0]; workgroupBarrier(); return r;
}
fn normrope(x: f32, li: u32, t: u32, wOff: u32) -> f32 {
  let mean = reduce(x, li) / 128.0;
  let d = x - mean;
  let rstd = inverseSqrt(reduce(d * d, li) / 128.0 + p.eps);
  let y = d * rstd * NRM[wOff + li] + NRM[wOff + 128u + li];
  buf[li] = y; workgroupBarrier();
  let partner = buf[li ^ 1u]; workgroupBarrier();
  let rot = select(partner, -partner, (li & 1u) == 0u);
  return y * ROPE[t * 128u + li] + rot * ROPE[p.T * 128u + t * 128u + li];
}
@compute @workgroup_size(128)
fn main(@builtin(workgroup_id) wid: vec3<u32>, @builtin(local_invocation_index) li: u32) {
  let t = wid.x; let h = wid.y;
  let row = t * 2304u + h * 128u + li;
  let o = (h * p.T + t) * 128u + li;
  QH[o] = normrope(QKV[row], li, t, 0u);
  KH[o] = normrope(QKV[row + 768u], li, t, 256u);
  VH[o] = QKV[row + 1536u];
}`;

/** 4x4 patch im2col: X[t][k] = scale * IMG[c][ty*4+ky][tx*4+kx], k = c*16 + ky*4 + kx, zero for k >= C*16 */
export const PATCHIFY = `
struct P { C: u32, H: u32, W: u32, Kp: u32, scale: f32, n: u32, p0: u32, p1: u32 };
@group(0) @binding(0) var<uniform> p: P;
@group(0) @binding(1) var<storage, read> IMG: array<f32>;
@group(0) @binding(2) var<storage, read_write> X: array<f32>;
@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let i = gid.x + gid.y * 65535u * 256u;
  if (i >= p.n) { return; }
  let t = i / p.Kp; let k = i % p.Kp; let gw = p.W / 4u;
  if (k >= p.C * 16u) { X[i] = 0.0; return; }
  let c = k / 16u; let ky = (k % 16u) / 4u; let kx = k % 4u;
  X[i] = p.scale * IMG[(c * p.H + (t / gw) * 4u + ky) * p.W + (t % gw) * 4u + kx];
}`;

/** fused output head + unpatchify + Flash state update: s += delta*vskip*s + vout*(F[t] . HW[o] + HB[o]) */
export const HEAD = `
struct P { T: u32, H: u32, W: u32, hwOff: u32, hbOff: u32, vskip: f32, vout: f32, delta: f32 };
@group(0) @binding(0) var<uniform> p: P;
@group(0) @binding(1) var<storage, read> F: array<vec4<f32>>;
@group(0) @binding(2) var<storage, read> HW: array<vec4<f32>>;
@group(0) @binding(3) var<storage, read> HB: array<f32>;
@group(0) @binding(4) var<storage, read_write> ST: array<f32>;
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let i = gid.x;
  if (i >= p.T * 48u) { return; }
  let t = i / 48u; let o = i % 48u;
  var acc = 0.0;
  for (var j = 0u; j < 192u; j = j + 1u) { acc = acc + dot(F[t * 192u + j], HW[p.hwOff / 4u + o * 192u + j]); }
  let y = acc + HB[p.hbOff + o];
  let gw = p.W / 4u; let py = o / 12u; let px = (o / 3u) % 4u; let c = o % 3u;
  let pix = (c * p.H + (t / gw) * 4u + py) * p.W + (t % gw) * 4u + px;
  let s = ST[pix];
  ST[pix] = s + p.delta * p.vskip * s + p.vout * y;
}`;

/** state *= s (initial latents scaling) */
export const SCALE = `
struct P { n: u32, s: f32, p0: u32, p1: u32 };
@group(0) @binding(0) var<uniform> p: P;
@group(0) @binding(1) var<storage, read_write> X: array<f32>;
@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) { if (gid.x < p.n) { X[gid.x] = X[gid.x] * p.s; } }`;
