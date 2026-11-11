// Part of BEAM's phone code (kept identical to BEAM's own build).
// Wallowa Weather engine: BEAM forward pass (a specialised fork of the author's own WebGPU engine)
// kernels.js - the WGSL kernels of the BEAM U-Net, generated per layer shape. Every shape BEAM has is fixed (a 304 x 304 frame,
// 32-256 channels), so each kernel has its sizes written into the code as constants: no division by a runtime value (WebKit turns
// those into helper calls) and no shape uniforms in the conv inner loop.
// Tensors are HWC (channels last, 4 channels a vec4), 16-bit floats in memory, every sum in 32-bit floats.
//   f16 = true:  shader-f16; workgroup tiles in f16, k step 32.
//   f16 = false: the same f16 memory read and written as packed u32 pairs (unpack2x16float / pack2x16float, core WGSL), f32 tiles,
//                k step 16 (the tiles stay within the 16 KB of workgroup memory every device has).
// Safe patterns for Apple GPUs: no subgroups, <= 16 KB workgroup memory, every shared vec4 / scalar written whole by ONE thread,
// every storage index kept in range by clamping (the value is then masked with select).
'use strict';

const u = (v) => `${v >>> 0}u`;
// f32 -> f16 rounded to nearest, ties to even, in integer maths: WGSL lets a GPU's own conversion round either way (a GPU was
// measured truncating), so every stored half is rounded here, exactly as numpy / PyTorch do, on every device.
//   normal halves: add 0xfff + the kept lowest bit, shift, re-bias; |x| >= 65520 -> inf; |x| < 2^-14: round(|x| * 2^24) (round() is
//   ties-to-even in WGSL) is the subnormal's bits. Inputs are finite (the model never makes NaN).
export const RNE = `fn rne4(v: vec4<f32>) -> vec2<u32> {
  let b = bitcast<vec4<u32>>(v); let a = b & vec4<u32>(0x7fffffffu); let s = (b >> vec4<u32>(16u)) & vec4<u32>(0x8000u);
  let nrm = ((a + vec4<u32>(0xfffu) + ((a >> vec4<u32>(13u)) & vec4<u32>(1u))) >> vec4<u32>(13u)) - vec4<u32>(0x1c000u);
  let sub = vec4<u32>(round(bitcast<vec4<f32>>(a) * 16777216.0));
  let h = s | select(select(nrm, vec4<u32>(0x7c00u), a >= vec4<u32>(0x477ff000u)), sub, a < vec4<u32>(0x38800000u));
  return vec2<u32>(h.x | (h.y << 16u), h.z | (h.w << 16u));
}
`;
const head = (f16) => (f16 ? 'enable f16;\n' : '') + RNE + (f16 ? '' : `fn h4(q: vec2<u32>) -> vec4<f32> { return vec4<f32>(unpack2x16float(q.x), unpack2x16float(q.y)); }
`);
const ST = (f16) => (f16 ? 'vec4<f16>' : 'vec2<u32>');                 // 4 halves in storage
const LD = (f16, a) => (f16 ? `vec4<f32>(${a})` : `h4(${a})`);           // -> vec4<f32>
const SV = (f16, v) => (f16 ? `bitcast<vec4<f16>>(rne4(${v}))` : `rne4(${v})`);   // vec4<f32> -> storage, rounded to nearest even

/**
 * Convolution as an implicit GEMM, Y[m][n] = bias[n] + sum_k X(m, k) W[k][n] (m = output pixel, n = output channel).
 *   ks 3: 3x3, stride 1, zero padding 1, k = (ky * 3 + kx) * Ci + ci;  ks 1: 1x1 (k = ci)
 *   epi 'store': Y[(m * ldy + cy0 + n)]           epi 'up': conv-transpose 2x2 stride 2 as a 1x1 GEMM to 4 * Cup channels
 *                                                 n = (dy * 2 + dx) * Cup + co, written to pixel (2y + dy, 2x + dx) of a 2H x 2W image
 * c = { f16, ks, H, W, Ci, ldx, cx0, N, Kpad, Kreal, ldy, cy0, BM, BN, epi, Cup, acc: 'f32' | 'f16' (f16 partial sums per k step) }
 * Bindings: 0 X (read), 1 W [Kpad][N] (read), 2 bias f32 (read), 3 Y (read_write). Dispatch [ceil(M / BM), N / BN].
 */
export function convWGSL(c) {
  const { f16, ks, H, W, Ci, ldx, cx0, N, Kpad, ldy, cy0, BM, BN } = c;
  const Kreal = c.Kreal || Kpad, epi = c.epi || 'store', acc16 = f16 && c.acc === 'f16';
  const BK = f16 ? 32 : 16, KQ = BK / 4, TX = BN / 8, TY = BM / 8, NT = TX * TY, M = H * W;
  const BM4 = BM / 4, BN4 = BN / 4, TASKS = BM4 * KQ, TPT = Math.ceil(TASKS / NT), MQS = NT / KQ;
  const WV = BK * BN4, WPT = Math.ceil(WV / NT);
  const bad = [];
  if (N % BN) bad.push('N % BN'); if (Kpad % BK) bad.push('Kpad % BK'); if (ldx % 4 || cx0 % 4 || ldy % 4 || cy0 % 4) bad.push('channel alignment');
  if (M % 4) bad.push('M % 4'); if (NT > 256 || NT < KQ || NT % KQ || BN % 8 || BM % 8) bad.push('tile ' + BM + 'x' + BN);
  if (ks === 3 && Ci % 4) bad.push('Ci % 4'); if (epi === 'up' && (c.Cup % 8 || N !== 4 * c.Cup)) bad.push('Cup');
  if (bad.length) throw new Error('convWGSL: ' + bad.join(', '));
  const T = f16 ? 'f16' : 'f32', V = `vec4<${T}>`;
  const uniTap = ks === 3 && Ci % BK === 0, w4 = W % 4 === 0;
  const L = [head(f16)];
  L.push(`@group(0) @binding(0) var<storage, read> X: array<${ST(f16)}>;`);
  L.push(`@group(0) @binding(1) var<storage, read> Wt: array<${ST(f16)}>;`);
  L.push('@group(0) @binding(2) var<storage, read> Bv: array<vec4<f32>>;');
  L.push(`@group(0) @binding(3) var<storage, read_write> Y: array<${ST(f16)}>;`);
  L.push(`var<workgroup> xs: array<${V}, ${BK * BM4}>;`);   // [k][m / 4]
  L.push(`var<workgroup> ws: array<${V}, ${BK * BN4}>;`);   // [k][n / 4]
  L.push(`@compute @workgroup_size(${NT})`);
  L.push('fn main(@builtin(workgroup_id) wid: vec3<u32>, @builtin(local_invocation_index) li: u32) {');
  L.push(`  let mB = wid.x * ${u(BM)}; let nB = wid.y * ${u(BN)};`);
  L.push(`  let tx = li % ${u(TX)}; let ty = li / ${u(TX)}; let kq = li % ${u(KQ)}; let mq0 = li / ${u(KQ)};`);
  // the rows each thread loads, decoded once (task i = row quad mq0 + i * MQS)
  for (let i = 0; i < TPT; i++) {
    L.push(`  let r${i} = mB + (mq0 + ${u(i * MQS)}) * 4u;`);
    if (ks === 3 && w4) L.push(`  let oy${i} = i32(r${i} / ${u(W)}); let ox${i} = i32(r${i} % ${u(W)}); let ok${i} = r${i} < ${u(M)};`);
    else if (ks === 3) {
      L.push(`  let rr${i} = min(vec4<u32>(r${i}) + vec4<u32>(0u, 1u, 2u, 3u), vec4<u32>(${u(M - 1)}));`);
      L.push(`  let oy${i} = vec4<i32>(rr${i} / vec4<u32>(${u(W)})); let ox${i} = vec4<i32>(rr${i} % vec4<u32>(${u(W)}));`);
      L.push(`  let ok${i} = r${i} < ${u(M)};`);   // M % 4 == 0: a row quad is all in or all out
    } else L.push(`  let ok${i} = r${i} < ${u(M)}; let rb${i} = min(r${i}, ${u(M - 4)});`);
  }
  for (let r = 0; r < 8; r++) for (let j = 0; j < 2; j++) L.push(`  var a${r}_${j} = vec4<f32>(0.0);`);
  L.push(`  for (var k0 = 0u; k0 < ${u(Kpad)}; k0 = k0 + ${u(BK)}) {`);
  if (ks === 3) {
    if (uniTap) L.push(`    let tap = k0 / ${u(Ci)}; let ci = k0 - tap * ${u(Ci)} + kq * 4u; let kok = true;`);
    else L.push(`    let kk = k0 + kq * 4u; let tap = min(kk / ${u(Ci)}, 8u); let ci = min(kk - tap * ${u(Ci)}, ${u(Ci - 4)}); let kok = kk < ${u(Kreal)};`);
    L.push(`    let dy = i32(tap / 3u) - 1; let dx = i32(tap % 3u) - 1; let cq = (${u(cx0)} + ci) / 4u;`);
  } else L.push(`    let cq = (${u(cx0)} + k0) / 4u + kq;`);
  for (let i = 0; i < TPT; i++) {
    const guard = TASKS % NT && i === TPT - 1;
    if (guard) L.push(`    if (mq0 + ${u(i * MQS)} < ${u(BM4)}) {`);
    for (let j = 0; j < 4; j++) {
      if (ks === 3) {
        const oy = w4 ? `oy${i}` : `oy${i}[${j}]`, ox = w4 ? `(ox${i} + ${j})` : `ox${i}[${j}]`;
        L.push(`    { let iy = ${oy} + dy; let ix = ${ox} + dx;`);
        L.push(`      let ok = ok${i} && kok && iy >= 0 && iy < ${H} && ix >= 0 && ix < ${W};`);
        L.push(`      let q = (u32(clamp(iy, 0, ${H - 1})) * ${u(W)} + u32(clamp(ix, 0, ${W - 1}))) * ${u(ldx / 4)} + cq;`);
      } else {
        L.push(`    { let ok = ok${i}; let q = (rb${i} + ${j}u) * ${u(ldx / 4)} + cq;`);
      }
      L.push(`      v${j}_${i} = select(${V}(0.0), ${f16 ? 'X[q]' : 'h4(X[q])'}, ok); }`);
    }
    L.push(`    { let xo = kq * ${u(4 * BM4)} + mq0 + ${u(i * MQS)};`);
    ['x', 'y', 'z', 'w'].forEach((cc, j) => L.push(`      xs[xo + ${u(j * BM4)}] = ${V}(v0_${i}.${cc}, v1_${i}.${cc}, v2_${i}.${cc}, v3_${i}.${cc});`));
    L.push('    }');
    if (guard) L.push('    }');
  }
  for (let s = 0; s < WPT; s++) {
    const g = WV % NT && s === WPT - 1;
    L.push(`    ${g ? `if (li + ${u(s * NT)} < ${u(WV)}) ` : ''}{ let wi = li + ${u(s * NT)}; let kr = wi / ${u(BN4)}; let cw = wi % ${u(BN4)};`);
    L.push(`      ws[wi] = ${f16 ? '' : 'vec4<f32>'}(${f16 ? `Wt[(k0 + kr) * ${u(N / 4)} + nB / 4u + cw]` : `h4(Wt[(k0 + kr) * ${u(N / 4)} + nB / 4u + cw])`}); }`);
  }
  L.push('    workgroupBarrier();');
  if (acc16) for (let r = 0; r < 8; r++) for (let j = 0; j < 2; j++) L.push(`    var h${r}_${j} = vec4<f16>(0.0);`);
  L.push(`    for (var k = 0u; k < ${u(BK)}; k = k + 1u) {`);
  L.push(`      let xb = k * ${u(BM4)} + ty * 2u; let kb = k * ${u(BN4)} + tx * 2u;`);
  if (acc16) {
    L.push('      let x0 = xs[xb]; let x1 = xs[xb + 1u]; let w0 = ws[kb]; let w1 = ws[kb + 1u];');
    for (let r = 0; r < 8; r++) { const xv = `x${r >> 2}.${'xyzw'[r & 3]}`; L.push(`      h${r}_0 = fma(vec4<f16>(${xv}), w0, h${r}_0); h${r}_1 = fma(vec4<f16>(${xv}), w1, h${r}_1);`); }
  } else {
    L.push('      let x0 = vec4<f32>(xs[xb]); let x1 = vec4<f32>(xs[xb + 1u]); let w0 = vec4<f32>(ws[kb]); let w1 = vec4<f32>(ws[kb + 1u]);');
    for (let r = 0; r < 8; r++) { const xv = `x${r >> 2}.${'xyzw'[r & 3]}`; L.push(`      a${r}_0 = fma(vec4<f32>(${xv}), w0, a${r}_0); a${r}_1 = fma(vec4<f32>(${xv}), w1, a${r}_1);`); }
  }
  L.push('    }');
  if (acc16) for (let r = 0; r < 8; r++) for (let j = 0; j < 2; j++) L.push(`    a${r}_${j} = a${r}_${j} + vec4<f32>(h${r}_${j});`);
  L.push('    workgroupBarrier();');
  L.push('  }');
  // epilogue: bias, round to f16
  L.push('  let n0 = nB + tx * 8u;');
  if (epi === 'up') {
    L.push(`  let qd = n0 / ${u(c.Cup)}; let co = n0 - qd * ${u(c.Cup)}; let ddy = qd >> 1u; let ddx = qd & 1u;`);
    L.push('  let b0 = Bv[co / 4u]; let b1 = Bv[co / 4u + 1u];');
  } else L.push('  let b0 = Bv[n0 / 4u]; let b1 = Bv[n0 / 4u + 1u];');
  for (let r = 0; r < 8; r++) {
    L.push(`  { let m = mB + ty * 8u + ${r}u; if (m < ${u(M)}) {`);
    if (epi === 'up') {
      L.push(`    let iy = m / ${u(W)}; let ix = m - iy * ${u(W)}; let op = (2u * iy + ddy) * ${u(2 * W)} + 2u * ix + ddx;`);
      L.push(`    let o = (op * ${u(ldy)} + ${u(cy0)} + co) / 4u;`);
    } else L.push(`    let o = (m * ${u(ldy)} + ${u(cy0)} + n0) / 4u;`);
    L.push(`    Y[o] = ${SV(f16, `a${r}_0 + b0`)}; Y[o + 1u] = ${SV(f16, `a${r}_1 + b1`)}; } }`);
  }
  L.push('}');
  // the per-task registers v{j}_{i} are declared at the top of the k loop body
  const decl = [];
  for (let i = 0; i < TPT; i++) for (let j = 0; j < 4; j++) decl.push(`    var v${j}_${i}: ${V};`);
  const at = L.findIndex((s) => s.startsWith('  for (var k0'));
  L.splice(at + 1, 0, ...decl);
  return L.join('\n');
}

// ------------------------------------------------------------------ GroupNorm(G) statistics, two passes
// pass 1: one workgroup per chunk of P pixels; thread = (lane = 4 channels, slot); Welford per thread, Chan merges in shared memory
//         (slots, then the lanes of one group) -> partial (n, mean, M2) per (chunk, group)
// pass 2: merge the chunks in a fixed order -> per channel a = gamma * rstd, b = beta - mean * a (biased variance, eps)
/** c = { f16, C, G } ; uniforms {HW, ldq, cq0, P}; bindings 0 U, 1 Y (read), 2 PT vec4 f32 [J][G] */
export function gnPartWGSL(c) {
  const { f16, C, G } = c, Lq = C / 4, S = 256 / Lq, LG = C / G / 4;
  if (C % (4 * G) || 256 % Lq || LG < 1) throw new Error('gnPartWGSL: C ' + C);
  return `${head(f16)}
struct U { HW: u32, ldq: u32, cq0: u32, P: u32 };
@group(0) @binding(0) var<uniform> un: U;
@group(0) @binding(1) var<storage, read> Y: array<${ST(f16)}>;
@group(0) @binding(2) var<storage, read_write> PT: array<vec4<f32>>;
var<workgroup> sn: array<f32, 256>;
var<workgroup> sm: array<f32, 256>;
var<workgroup> s2: array<f32, 256>;
fn merge(a: u32, b: u32) {
  let na = sn[a]; let nb = sn[b];
  if (nb > 0.0) { let nn = na + nb; let d = sm[b] - sm[a]; sm[a] = sm[a] + d * (nb / nn); s2[a] = s2[a] + s2[b] + d * d * (na * nb / nn); sn[a] = nn; }
}
@compute @workgroup_size(256)
fn main(@builtin(workgroup_id) wid: vec3<u32>, @builtin(local_invocation_index) li: u32) {
  let lane = li % ${u(Lq)}; let slot = li / ${u(Lq)};
  let p0 = wid.x * un.P; let p1 = min(un.HW, p0 + un.P);
  var n = 0.0; var mean = vec4<f32>(0.0); var m2 = vec4<f32>(0.0);
  for (var px = p0 + slot; px < p1; px = px + ${u(S)}) {
    let v = ${LD(f16, 'Y[px * un.ldq + un.cq0 + lane]')};
    n = n + 1.0; let d = v - mean; mean = mean + d / n; m2 = m2 + d * (v - mean);
  }
  let mu = (mean.x + mean.y + mean.z + mean.w) * 0.25; let dm = mean - vec4<f32>(mu);
  sn[li] = 4.0 * n; sm[li] = mu; s2[li] = m2.x + m2.y + m2.z + m2.w + n * dot(dm, dm);
  workgroupBarrier();
  for (var s = ${u(S / 2)}; s > 0u; s = s >> 1u) {
    if (slot < s) { merge(li, li + s * ${u(Lq)}); }
    workgroupBarrier();
  }
  for (var s = ${u(LG / 2)}; s > 0u; s = s >> 1u) {
    if (slot == 0u && lane % ${u(LG)} < s) { merge(li, li + s); }
    workgroupBarrier();
  }
  if (slot == 0u && lane % ${u(LG)} == 0u) { PT[wid.x * ${u(G)} + lane / ${u(LG)}] = vec4<f32>(sn[li], sm[li], s2[li], 0.0); }
}`;
}
/** c = { C, G, eps }; uniforms {J}; bindings 0 U, 1 PT (read), 2 GB f32 [gamma C | beta C] (read), 3 AB f32 [a C | b C] (read_write) */
export function gnFinWGSL(c) {
  const { C, G, eps } = c;
  return `struct U { J: u32, p0: u32, p1: u32, p2: u32 };
@group(0) @binding(0) var<uniform> un: U;
@group(0) @binding(1) var<storage, read> PT: array<vec4<f32>>;
@group(0) @binding(2) var<storage, read> GB: array<f32>;
@group(0) @binding(3) var<storage, read_write> AB: array<f32>;
@compute @workgroup_size(${C})
fn main(@builtin(local_invocation_index) c: u32) {
  let g = c / ${u(C / G)};
  var n = 0.0; var mean = 0.0; var m2 = 0.0;
  for (var j = 0u; j < un.J; j = j + 1u) {
    let q = PT[j * ${u(G)} + g];
    if (q.x > 0.0) { let nn = n + q.x; let d = q.y - mean; mean = mean + d * (q.x / nn); m2 = m2 + q.z + d * d * (n * q.x / nn); n = nn; }
  }
  let rs = inverseSqrt(m2 / max(n, 1.0) + ${eps.toExponential()});
  let a = GB[c] * rs;
  AB[c] = a; AB[${u(C)} + c] = GB[${u(C)} + c] - mean * a;
}`;
}

// ------------------------------------------------------------------ GroupNorm apply + SiLU (in place), optionally + 2x2 max-pool
const silu = 'fn silu(z: vec4<f32>) -> vec4<f32> { return z / (vec4<f32>(1.0) + exp(-z)); }';
/** c = { f16, C }; uniforms {HW, ldq, cq0}; bindings 0 U, 1 AB vec4 (read), 2 Y (read_write). One thread per (pixel, 4 channels). */
export function gnApplyWGSL(c) {
  const { f16, C } = c, Lq = C / 4;
  return `${head(f16)}
struct U { HW: u32, ldq: u32, cq0: u32, p0: u32 };
@group(0) @binding(0) var<uniform> un: U;
@group(0) @binding(1) var<storage, read> AB: array<vec4<f32>>;
@group(0) @binding(2) var<storage, read_write> Y: array<${ST(f16)}>;
${silu}
@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let px = gid.x / ${u(Lq)}; let lane = gid.x % ${u(Lq)};
  if (px >= un.HW) { return; }
  let q = px * un.ldq + un.cq0 + lane;
  Y[q] = ${SV(f16, `silu(${LD(f16, 'Y[q]')} * AB[lane] + AB[${u(Lq)} + lane])`)};
}`;
}
/** c = { f16, C, W (input width) }; uniforms {HWo, ldq, cq0}; bindings 0 U, 1 AB (read), 2 Y skip (read_write, in place),
 *  3 P pooled [HWo][C] (read_write). One thread per (pooled pixel, 4 channels). */
export function gnApplyPoolWGSL(c) {
  const { f16, C, W } = c, Lq = C / 4, Wo = W / 2;
  return `${head(f16)}
struct U { HWo: u32, ldq: u32, cq0: u32, p0: u32 };
@group(0) @binding(0) var<uniform> un: U;
@group(0) @binding(1) var<storage, read> AB: array<vec4<f32>>;
@group(0) @binding(2) var<storage, read_write> Y: array<${ST(f16)}>;
@group(0) @binding(3) var<storage, read_write> Pd: array<${ST(f16)}>;
${silu}
@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let pp = gid.x / ${u(Lq)}; let lane = gid.x % ${u(Lq)};
  if (pp >= un.HWo) { return; }
  let oy = pp / ${u(Wo)}; let ox = pp - oy * ${u(Wo)};
  let a = AB[lane]; let b = AB[${u(Lq)} + lane];
  let i0 = ((2u * oy) * ${u(W)} + 2u * ox) * un.ldq + un.cq0 + lane;
  let i1 = i0 + un.ldq; let i2 = i0 + ${u(W)} * un.ldq; let i3 = i2 + un.ldq;
  let z0 = silu(${LD(f16, 'Y[i0]')} * a + b); let z1 = silu(${LD(f16, 'Y[i1]')} * a + b);
  let z2 = silu(${LD(f16, 'Y[i2]')} * a + b); let z3 = silu(${LD(f16, 'Y[i3]')} * a + b);
${f16 ? `  let h0 = bitcast<vec4<f16>>(rne4(z0)); let h1 = bitcast<vec4<f16>>(rne4(z1)); let h2 = bitcast<vec4<f16>>(rne4(z2)); let h3 = bitcast<vec4<f16>>(rne4(z3));
  Y[i0] = h0; Y[i1] = h1; Y[i2] = h2; Y[i3] = h3;
  Pd[pp * ${u(Lq)} + lane] = max(max(h0, h1), max(h2, h3));`
    : `  let q0 = rne4(z0); let q1 = rne4(z1); let q2 = rne4(z2); let q3 = rne4(z3);
  Y[i0] = q0; Y[i1] = q1; Y[i2] = q2; Y[i3] = q3;
  Pd[pp * ${u(Lq)} + lane] = rne4(max(max(h4(q0), h4(q1)), max(h4(q2), h4(q3))));`}
}`;
}

// ------------------------------------------------------------------ head: 1x1 conv 32 -> 12, sigmoid, into the fold's sum
/** c = { f16, HW, add }; bindings 0 X [HW][32] (read), 1 W [32][12] f16 (read), 2 bias f32 [12] (read), 3 ACC f32 [12][HW] (read_write).
 *  ACC = sigmoid (first member of a fold) or ACC += sigmoid. */
export function headWGSL(c) {
  const { f16, HW } = c;
  const L = [head(f16)];
  L.push(`@group(0) @binding(0) var<storage, read> X: array<${ST(f16)}>;`);
  L.push(`@group(0) @binding(1) var<storage, read> Wt: array<${ST(f16)}>;`);
  L.push('@group(0) @binding(2) var<storage, read> Bv: array<vec4<f32>>;');
  L.push('@group(0) @binding(3) var<storage, read_write> ACC: array<f32>;');
  L.push('var<workgroup> ws: array<vec4<f32>, 96>;');
  L.push('@compute @workgroup_size(256)');
  L.push('fn main(@builtin(workgroup_id) wid: vec3<u32>, @builtin(local_invocation_index) li: u32) {');
  L.push(`  if (li < 96u) { ws[li] = ${LD(f16, 'Wt[li]')}; }`);
  L.push('  workgroupBarrier();');
  L.push('  let m = wid.x * 256u + li;');
  L.push(`  if (m >= ${u(HW)}) { return; }`);
  L.push('  var o0 = Bv[0]; var o1 = Bv[1]; var o2 = Bv[2];');
  L.push('  for (var k4 = 0u; k4 < 8u; k4 = k4 + 1u) {');
  L.push(`    let x = ${LD(f16, 'X[m * 8u + k4]')};`);
  for (let j = 0; j < 4; j++) {
    const w = `(k4 * 4u + ${j}u) * 3u`;
    L.push(`    o0 = fma(vec4<f32>(x.${'xyzw'[j]}), ws[${w}], o0); o1 = fma(vec4<f32>(x.${'xyzw'[j]}), ws[${w} + 1u], o1); o2 = fma(vec4<f32>(x.${'xyzw'[j]}), ws[${w} + 2u], o2);`);
  }
  L.push('  }');
  L.push('  let p0 = vec4<f32>(1.0) / (vec4<f32>(1.0) + exp(-o0)); let p1 = vec4<f32>(1.0) / (vec4<f32>(1.0) + exp(-o1)); let p2 = vec4<f32>(1.0) / (vec4<f32>(1.0) + exp(-o2));');
  const pv = (n) => `p${n >> 2}.${'xyzw'[n & 3]}`;
  for (let n = 0; n < 12; n++) L.push(c.add ? `  ACC[${u(n * HW)} + m] = ACC[${u(n * HW)} + m] + ${pv(n)};` : `  ACC[${u(n * HW)} + m] = ${pv(n)};`);
  L.push('}');
  return L.join('\n');
}

/** member mean: OUT = (sum of the folds' sums) * inv. uniforms {nq (vec4 count), nf (1 | 2 folds), f0 (first fold), inv};
 *  bindings 0 U, 1 ACC vec4 f32 [2][12 * HW / 4] (read), 2 OUT vec4 f32 (read_write) */
export const MEAN_WGSL = `struct U { nq: u32, nf: u32, f0: u32, inv: f32 };
@group(0) @binding(0) var<uniform> un: U;
@group(0) @binding(1) var<storage, read> ACC: array<vec4<f32>>;
@group(0) @binding(2) var<storage, read_write> OUT: array<vec4<f32>>;
@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let i = gid.x; if (i >= un.nq) { return; }
  var s = ACC[un.f0 * un.nq + i];
  if (un.nf == 2u) { s = s + ACC[(un.f0 + 1u) * un.nq + i]; }
  OUT[i] = s * un.inv;
}`;
