// nowcast/dgmr/kernels_int8.js - DGMR in integer maths (the low-memory model): WGSL kernels, ported unchanged in their arithmetic
// from the reference implementation, which gave the same bytes on Apple, NVIDIA and AMD GPUs and the CPU reference. Every kernel does integer
// arithmetic only. The conv kernel multiplies in f32 but only ever holds exact integers: |x*w| <= 4095*127 and a partial sum of at most
// `chunk` products stays below 2^24, where every f32 add / fma is exact in any order; each chunk then goes into an i32 sum.
// Storage: activations NHWC, int8 / uint8 packed 4 channels per u32 (int16: 2 per u32); weights int8 packed [K/4][Cout].

export const REQUANT = /* wgsl */`
fn requant(y: i32, M: i32, S: u32) -> i32 {      // floor((y*M + 2^(S-1)) / 2^S) exactly, 16 <= S <= 31, 0 <= M < 2^15
  let al = u32(y) & 0xffffu;
  let ah = y >> 16u;
  let Y = al * u32(M) + (1u << (S - 1u));
  let q = ah * M + i32(Y >> 16u);
  return q >> (S - 16u);
}
fn sx8(w: u32, j: u32) -> i32 { return i32(w << (24u - 8u * j)) >> 24u; }
fn zx8(w: u32, j: u32) -> i32 { return i32((w >> (8u * j)) & 0xffu); }
fn sx16(w: u32, j: u32) -> i32 { return i32(w << (16u - 16u * j)) >> 16u; }
fn rshr(a: i32, S: u32) -> i32 { return (a + (1 << (S - 1u))) >> S; }
`;

// kinds: 0 i8, 1 u8, 2 g8 (gate, 0..255), 3 i16
export const CONV = /* wgsl */`
${REQUANT}
struct U {
  m0: u32, mcnt: u32, H: u32, W: u32,
  cout: u32, ktot: u32, k: u32, up: u32,
  hin: u32, win: u32, nref: u32, cin: u32,
  chunk_steps: u32, kper: u32, out_i0: u32, out_kind: u32,
  act: u32, split: u32, boff: u32, moff: u32,
  soff: u32, lutoff: u32, woff: u32, pad0: u32,
  r: array<vec4<u32>, 8>,          // per ref: (buf, i0, C, cstart), (kind, relu, 0, 0)
}
@group(0) @binding(0) var<uniform> u: U;
@group(0) @binding(1) var<storage, read> in0: array<u32>;
@group(0) @binding(2) var<storage, read> in1: array<u32>;
@group(0) @binding(3) var<storage, read> wts: array<u32>;
@group(0) @binding(4) var<storage, read_write> outb: array<u32>;
@group(0) @binding(5) var<storage, read_write> scr: array<atomic<i32>>;

var<workgroup> As: array<f32, 1024>;
var<workgroup> Bs: array<f32, 1024>;

fn ld(buf: u32, idx: u32) -> u32 { if (buf == 0u) { return in0[idx]; } return in1[idx]; }

fn epi(acc: i32, co: u32) -> i32 {
  let y = acc + bitcast<i32>(wts[u.boff / 4u + co]);
  let v = requant(y, bitcast<i32>(wts[u.moff / 4u + co]), wts[u.soff / 4u + co]);
  if (u.act == 2u) { return bitcast<i32>(wts[u.lutoff / 4u + u32(clamp(v, -127, 127) + 127)]); }
  if (u.act == 1u) { return clamp(v, 0, 255); }
  if (u.out_kind == 3u) { return clamp(v, -32767, 32767); }
  return clamp(v, -127, 127);
}

fn store(m: u32, co0: u32, v: vec4<i32>) {
  let hw = u.H * u.W;
  let img = m / hw; let rem = m - img * hw;
  let po = (u.out_i0 + img) * hw + rem;
  if (u.out_kind == 3u) {
    let base = po * (u.cout / 2u) + co0 / 2u;
    outb[base] = (u32(v.x) & 0xffffu) | ((u32(v.y) & 0xffffu) << 16u);
    if (co0 + 2u < u.cout) { outb[base + 1u] = (u32(v.z) & 0xffffu) | ((u32(v.w) & 0xffffu) << 16u); }
  } else {
    outb[po * (u.cout / 4u) + co0 / 4u] = (u32(v.x) & 0xffu) | ((u32(v.y) & 0xffu) << 8u) | ((u32(v.z) & 0xffu) << 16u) | ((u32(v.w) & 0xffu) << 24u);
  }
}

@compute @workgroup_size(256)
fn main(@builtin(workgroup_id) wg: vec3<u32>, @builtin(local_invocation_index) tid: u32) {
  let tx = tid & 15u; let ty = tid >> 4u;
  let pad = i32(u.k / 2u);
  let hw = u.H * u.W;
  // this thread's A-load pixel and k-group
  let pa = tid & 63u; let kg = tid >> 6u;
  let ma = u.m0 + wg.y * 64u + pa;
  let mvalid = ma < u.m0 + u.mcnt;
  let img = ma / hw; let rem = ma - img * hw; let oy = rem / u.W; let ox = rem - oy * u.W;
  let co_l = tid & 63u;
  let cob = wg.x * 64u + co_l;
  var facc: array<vec4<f32>, 4>;
  var iacc: array<vec4<i32>, 4>;
  for (var i = 0u; i < 4u; i++) { facc[i] = vec4<f32>(0.0); iacc[i] = vec4<i32>(0); }
  let kbeg = wg.z * u.kper;
  let kend = min(u.ktot, kbeg + u.kper);
  var steps = 0u;
  for (var kb = kbeg; kb < kend; kb += 16u) {
    // ---- A tile: 64 pixels x 16 k (one u32 = 4 channels per thread)
    let kidx = kb + kg * 4u;
    var av = vec4<f32>(0.0);
    if (mvalid && kidx < kend) {
      let tap = kidx / u.cin; let ci = kidx - tap * u.cin;
      let dy = i32(tap / u.k); let dx = i32(tap % u.k);
      let yy = i32(oy) + dy - pad; let xx = i32(ox) + dx - pad;
      if (yy >= 0 && yy < i32(u.H) && xx >= 0 && xx < i32(u.W)) {
        var iy = u32(yy); var ix = u32(xx);
        if (u.up == 1u) { iy = iy >> 1u; ix = ix >> 1u; }
        for (var r = 0u; r < u.nref; r++) {
          let a = u.r[2u * r]; let b = u.r[2u * r + 1u];
          if (ci >= a.w && ci < a.w + a.z) {
            let cl = ci - a.w;
            let pix = (a.y + img) * u.hin * u.win + iy * u.win + ix;
            if (b.x == 3u) {
              let w0 = ld(a.x, pix * (a.z / 2u) + cl / 2u); let w1 = ld(a.x, pix * (a.z / 2u) + cl / 2u + 1u);
              av = vec4<f32>(f32(sx16(w0, 0u)), f32(sx16(w0, 1u)), f32(sx16(w1, 0u)), f32(sx16(w1, 1u)));
            } else {
              let w = ld(a.x, pix * (a.z / 4u) + cl / 4u);
              if (b.x == 0u) { av = vec4<f32>(f32(sx8(w, 0u)), f32(sx8(w, 1u)), f32(sx8(w, 2u)), f32(sx8(w, 3u))); }
              else { av = vec4<f32>(f32(zx8(w, 0u)), f32(zx8(w, 1u)), f32(zx8(w, 2u)), f32(zx8(w, 3u))); }
            }
            if (b.y == 1u) { av = max(av, vec4<f32>(0.0)); }
          }
        }
      }
    }
    As[(kg * 4u + 0u) * 64u + pa] = av.x; As[(kg * 4u + 1u) * 64u + pa] = av.y;
    As[(kg * 4u + 2u) * 64u + pa] = av.z; As[(kg * 4u + 3u) * 64u + pa] = av.w;
    // ---- B tile: 16 k x 64 output channels
    let k4 = kb / 4u + kg;
    var bw = 0u;
    if (k4 * 4u < kend && cob < u.cout) { bw = wts[u.woff / 4u + k4 * u.cout + cob]; }
    Bs[(kg * 4u + 0u) * 64u + co_l] = f32(sx8(bw, 0u)); Bs[(kg * 4u + 1u) * 64u + co_l] = f32(sx8(bw, 1u));
    Bs[(kg * 4u + 2u) * 64u + co_l] = f32(sx8(bw, 2u)); Bs[(kg * 4u + 3u) * 64u + co_l] = f32(sx8(bw, 3u));
    workgroupBarrier();
    for (var kk = 0u; kk < 16u; kk++) {
      let b = vec4<f32>(Bs[kk * 64u + tx * 4u], Bs[kk * 64u + tx * 4u + 1u], Bs[kk * 64u + tx * 4u + 2u], Bs[kk * 64u + tx * 4u + 3u]);
      for (var i = 0u; i < 4u; i++) { facc[i] = fma(vec4<f32>(As[kk * 64u + ty + 16u * i]), b, facc[i]); }
    }
    workgroupBarrier();
    steps += 1u;
    if (steps == u.chunk_steps) {
      for (var i = 0u; i < 4u; i++) { iacc[i] += vec4<i32>(facc[i]); facc[i] = vec4<f32>(0.0); }
      steps = 0u;
    }
  }
  for (var i = 0u; i < 4u; i++) { iacc[i] += vec4<i32>(facc[i]); }
  let co0 = wg.x * 64u + tx * 4u;
  if (co0 >= u.cout) { return; }
  for (var i = 0u; i < 4u; i++) {
    let m = u.m0 + wg.y * 64u + ty + 16u * i;
    if (m >= u.m0 + u.mcnt) { continue; }
    if (u.split == 1u) {
      let base = (m - u.m0) * u.cout + co0;
      atomicAdd(&scr[base], iacc[i].x); atomicAdd(&scr[base + 1u], iacc[i].y);
      atomicAdd(&scr[base + 2u], iacc[i].z); atomicAdd(&scr[base + 3u], iacc[i].w);
    } else {
      store(m, co0, vec4<i32>(epi(iacc[i].x, co0), epi(iacc[i].y, co0 + 1u), epi(iacc[i].z, co0 + 2u), epi(iacc[i].w, co0 + 3u)));
    }
  }
}

@compute @workgroup_size(64)
fn fin(@builtin(global_invocation_id) gid: vec3<u32>) {     // split-K finish: one thread per (pixel, 4 channels)
  let groups = u.cout / 4u;
  let t = gid.x + gid.y * 65535u * 64u;
  if (t >= u.mcnt * groups) { return; }
  let mi = t / groups; let co0 = (t - mi * groups) * 4u;
  let base = mi * u.cout + co0;
  let a = vec4<i32>(atomicExchange(&scr[base], 0), atomicExchange(&scr[base + 1u], 0), atomicExchange(&scr[base + 2u], 0), atomicExchange(&scr[base + 3u], 0));
  store(u.m0 + mi, co0, vec4<i32>(epi(a.x, co0), epi(a.y, co0 + 1u), epi(a.z, co0 + 2u), epi(a.w, co0 + 3u)));
}
`;

// element-wise ops: one thread per output word (4 channels). EW.mode: 0 add, 1 cbn, 2 gmul, 3 gru
export const EW = /* wgsl */`
${REQUANT}
struct U {
  w0: u32, nw: u32, H: u32, W: u32,
  C: u32, mode: u32, S: u32, out_i0: u32,
  a_i0: u32, a_kind: u32, pool: u32, up_b: u32,
  ma: i32, mboff: u32, nb: u32, coff: u32,
  b0: vec4<u32>,     // (i0, C, cstart, kind)
  b1: vec4<u32>,
  Ah: i32, Ac: i32, h_out: u32, a_t0: u32,
}
@group(0) @binding(0) var<uniform> u: U;
@group(0) @binding(1) var<storage, read> A: array<u32>;
@group(0) @binding(2) var<storage, read> B0: array<u32>;
@group(0) @binding(3) var<storage, read> B1: array<u32>;
@group(0) @binding(4) var<storage, read> P: array<u32>;
@group(0) @binding(5) var<storage, read_write> O: array<u32>;

fn byte(w: u32, j: u32, kind: u32) -> i32 { if (kind == 0u) { return sx8(w, j); } return zx8(w, j); }

fn ldA(j: u32, y: u32, x: u32, H: u32, W: u32, cg: u32) -> u32 {
  return A[((u.a_i0 + j) * H * W + y * W + x) * (u.C / 4u) + cg];
}
fn ldB(r: u32, j: u32, y: u32, x: u32, H: u32, W: u32, c: u32) -> vec4<i32> {
  var b = u.b0; if (r == 1u) { b = u.b1; }
  let idx = ((b.x + j) * H * W + y * W + x) * (b.y / 4u) + (c - b.z) / 4u;
  var w = 0u; if (r == 0u) { w = B0[idx]; } else { w = B1[idx]; }
  return vec4<i32>(byte(w, 0u, b.w), byte(w, 1u, b.w), byte(w, 2u, b.w), byte(w, 3u, b.w));
}

@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let wi = gid.x + gid.y * 65535u * 256u;
  if (wi >= u.nw) { return; }
  let w = u.w0 + wi;
  let groups = u.C / 4u;
  let pix = w / groups; let cg = w - pix * groups; let c0 = cg * 4u;
  let hw = u.H * u.W;
  let j = pix / hw; let rem = pix - j * hw; let y = rem / u.W; let x = rem - y * u.W;
  var o = vec4<i32>(0);
  if (u.mode == 0u) {            // add
    var a = vec4<i32>(0); var b = vec4<i32>(0);
    var r = 0u; if (u.nb == 2u && c0 >= u.b1.z) { r = 1u; }
    if (u.pool == 1u) {
      for (var dy = 0u; dy < 2u; dy++) { for (var dx = 0u; dx < 2u; dx++) {
        let wa = ldA(j, 2u * y + dy, 2u * x + dx, u.H * 2u, u.W * 2u, cg);
        a += vec4<i32>(byte(wa, 0u, u.a_kind), byte(wa, 1u, u.a_kind), byte(wa, 2u, u.a_kind), byte(wa, 3u, u.a_kind));
        b += ldB(r, j, 2u * y + dy, 2u * x + dx, u.H * 2u, u.W * 2u, c0);
      } }
    } else {
      let wa = ldA(j, y, x, u.H, u.W, cg);
      a = vec4<i32>(byte(wa, 0u, u.a_kind), byte(wa, 1u, u.a_kind), byte(wa, 2u, u.a_kind), byte(wa, 3u, u.a_kind));
      if (u.up_b == 1u) { b = ldB(r, j, y >> 1u, x >> 1u, u.H / 2u, u.W / 2u, c0); } else { b = ldB(r, j, y, x, u.H, u.W, c0); }
    }
    let mb = vec4<i32>(bitcast<i32>(P[u.mboff / 4u + c0]), bitcast<i32>(P[u.mboff / 4u + c0 + 1u]), bitcast<i32>(P[u.mboff / 4u + c0 + 2u]), bitcast<i32>(P[u.mboff / 4u + c0 + 3u]));
    let acc = a * u.ma + b * mb;
    o = clamp(vec4<i32>(rshr(acc.x, u.S), rshr(acc.y, u.S), rshr(acc.z, u.S), rshr(acc.w, u.S)), vec4<i32>(-127), vec4<i32>(127));
  } else if (u.mode == 1u) {     // cbn: relu(x*A[t,c] + B[t,c]) -> u8 ; coefficients at P[coff]: A [18][C] then B [18][C]
    let wa = ldA(j, y, x, u.H, u.W, cg);
    let t = u.a_t0 + j;
    for (var q = 0u; q < 4u; q++) {
      let c = c0 + q;
      let Av = bitcast<i32>(P[u.coff / 4u + t * u.C + c]);
      let Bv = bitcast<i32>(P[u.coff / 4u + 18u * u.C + t * u.C + c]);
      o[q] = clamp(rshr(byte(wa, q, u.a_kind) * Av + Bv, u.S), 0, 255);
    }
  } else if (u.mode == 2u) {     // gmul: r*h/255 (r gate in A, h in B0)
    let wr = ldA(j, y, x, u.H, u.W, cg);
    let wh = B0[((u.b0.x + j) * hw + y * u.W + x) * groups + cg];
    for (var q = 0u; q < 4u; q++) { o[q] = (zx8(wr, q) * zx8(wh, q) * 257 + 32768) >> 16u; }
  } else {                       // gru: (u*h*Ah + (255-u)*c*Ac) >> S ; u in A, c in B1, h in B0 (or in O when h_out)
    let wu = ldA(j, y, x, u.H, u.W, cg);
    let wc = B1[((u.b1.x + j) * hw + y * u.W + x) * groups + cg];
    var wh = 0u;
    let hidx = ((u.b0.x + j) * hw + y * u.W + x) * groups + cg;
    if (u.h_out == 1u) { wh = O[hidx]; } else { wh = B0[hidx]; }
    for (var q = 0u; q < 4u; q++) {
      let g = zx8(wu, q);
      o[q] = clamp(rshr(g * zx8(wh, q) * u.Ah + (255 - g) * zx8(wc, q) * u.Ac, u.S), 0, 255);
    }
  }
  let po = (u.out_i0 + j) * hw + rem;
  O[po * groups + cg] = (u32(o.x) & 0xffu) | ((u32(o.y) & 0xffu) << 8u) | ((u32(o.z) & 0xffu) << 16u) | ((u32(o.w) & 0xffu) << 24u);
}
`;

// latent attention: 64 queries x 64 keys, 48 channels; one workgroup, one thread per query
export const ATTN = /* wgsl */`
${REQUANT}
struct U { Es: u32, Ed: i32, M: i32, S: u32, expoff: u32, q_i0: u32, k_i0: u32, v_i0: u32, out_i0: u32, p0: u32, p1: u32, p2: u32 }
@group(0) @binding(0) var<uniform> u: U;
@group(0) @binding(1) var<storage, read> Q: array<u32>;
@group(0) @binding(2) var<storage, read> K: array<u32>;
@group(0) @binding(3) var<storage, read> V: array<u32>;
@group(0) @binding(4) var<storage, read> P: array<u32>;
@group(0) @binding(5) var<storage, read_write> O: array<u32>;
fn q8(buf: u32, base: u32, c: u32) -> i32 {
  var w = 0u;
  if (buf == 0u) { w = Q[base + c / 4u]; } else if (buf == 1u) { w = K[base + c / 4u]; } else { w = V[base + c / 4u]; }
  return sx8(w, c % 4u);
}
@compute @workgroup_size(64)
fn main(@builtin(local_invocation_index) i: u32) {
  var lg: array<i32, 64>;
  var mx = -2147483647;
  for (var l = 0u; l < 64u; l++) {
    var s = 0;
    for (var c = 0u; c < 48u; c++) { s += q8(0u, (u.q_i0 * 64u + i) * 12u, c) * q8(1u, (u.k_i0 * 64u + l) * 12u, c); }
    lg[l] = s; mx = max(mx, s);
  }
  var e: array<i32, 64>; var sum = 0;
  for (var l = 0u; l < 64u; l++) {
    let d = mx - lg[l];
    let idx = min(255, (d * u.Ed + (1 << (u.Es - 1u))) >> u.Es);
    e[l] = bitcast<i32>(P[u.expoff / 4u + u32(idx)]); sum += e[l];
  }
  var acc: array<i32, 48>;
  for (var c = 0u; c < 48u; c++) { acc[c] = 0; }
  for (var l = 0u; l < 64u; l++) {
    let beta = (e[l] * 32768 + sum / 2) / sum;
    for (var c = 0u; c < 48u; c++) { acc[c] += beta * q8(2u, (u.v_i0 * 64u + l) * 12u, c); }
  }
  for (var g = 0u; g < 12u; g++) {
    var w = 0u;
    for (var q = 0u; q < 4u; q++) { w |= (u32(clamp(requant(acc[g * 4u + q], u.M, u.S), -127, 127)) & 0xffu) << (8u * q); }
    O[(u.out_i0 * 64u + i) * 12u + g] = w;
  }
}
`;
