// nowcast/dgmr/kernels_float.js - DGMR in floating point (the default, most accurate model): WGSL kernels. Activations f32 (NHWC,
// 4 channels a vec4), weights 16-bit floats packed two to a u32 (unpack2x16float, core WGSL: no shader-f16 needed) or 32-bit floats,
// every sum in f32. A conv with a long K and few output tiles is split along K: each part writes its own partial sums and a second
// pass adds them in a fixed order (no float atomics), so a run gives the same numbers every time on the same GPU.

/** the conv kernel; wenc 'f16' (two weights per u32, [K/2][Cout]) or 'f32' ([K][Cout]) */
export const convF = (wenc) => /* wgsl */`
struct U {
  m0: u32, mcnt: u32, H: u32, W: u32,
  cout: u32, ktot: u32, k: u32, up: u32,
  hin: u32, win: u32, nref: u32, cin: u32,
  kper: u32, out_i0: u32, act: u32, split: u32,
  boff: u32, woff: u32, nsplit: u32, p0: u32,
  r: array<vec4<u32>, 8>,          // per ref: (buf, i0, C, cstart), (relu, 0, 0, 0)
}
@group(0) @binding(0) var<uniform> u: U;
@group(0) @binding(1) var<storage, read> in0: array<vec4<f32>>;
@group(0) @binding(2) var<storage, read> in1: array<vec4<f32>>;
@group(0) @binding(3) var<storage, read> wts: array<u32>;
@group(0) @binding(4) var<storage, read_write> outb: array<vec4<f32>>;
@group(0) @binding(5) var<storage, read_write> scr: array<vec4<f32>>;

var<workgroup> As: array<f32, 1024>;
var<workgroup> Bs: array<f32, 1024>;

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
}

@compute @workgroup_size(256)
fn main(@builtin(workgroup_id) wg: vec3<u32>, @builtin(local_invocation_index) tid: u32) {
  let tx = tid & 15u; let ty = tid >> 4u;
  let pad = i32(u.k / 2u);
  let hw = u.H * u.W;
  let pa = tid & 63u; let kg = tid >> 6u;
  let ma = u.m0 + wg.y * 64u + pa;
  let mvalid = ma < u.m0 + u.mcnt;
  let img = ma / hw; let rem = ma - img * hw; let oy = rem / u.W; let ox = rem - oy * u.W;
  let co_l = tid & 63u;
  let cob = wg.x * 64u + co_l;
  var acc: array<vec4<f32>, 4>;
  for (var i = 0u; i < 4u; i++) { acc[i] = vec4<f32>(0.0); }
  let kbeg = wg.z * u.kper;
  let kend = min(u.ktot, kbeg + u.kper);
  for (var kb = kbeg; kb < kend; kb += 16u) {
    // A tile: 64 pixels x 16 k (4 channels a thread)
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
            av = ld(a.x, ((a.y + img) * u.hin * u.win + iy * u.win + ix) * (a.z / 4u) + (ci - a.w) / 4u);
            if (b.x == 1u) { av = max(av, vec4<f32>(0.0)); }
          }
        }
      }
    }
    As[(kg * 4u + 0u) * 64u + pa] = av.x; As[(kg * 4u + 1u) * 64u + pa] = av.y;
    As[(kg * 4u + 2u) * 64u + pa] = av.z; As[(kg * 4u + 3u) * 64u + pa] = av.w;
    // B tile: 16 k x 64 output channels
    var bv = vec4<f32>(0.0);
    if (kidx < kend && cob < u.cout) {
${wenc === 'f16' ? `      let w0 = unpack2x16float(wts[u.woff + (kidx / 2u) * u.cout + cob]);
      let w1 = unpack2x16float(wts[u.woff + (kidx / 2u + 1u) * u.cout + cob]);
      bv = vec4<f32>(w0.x, w0.y, w1.x, w1.y);`
    : `      bv = vec4<f32>(wf(u.woff + kidx * u.cout + cob), wf(u.woff + (kidx + 1u) * u.cout + cob), wf(u.woff + (kidx + 2u) * u.cout + cob), wf(u.woff + (kidx + 3u) * u.cout + cob));`}
    }
    Bs[(kg * 4u + 0u) * 64u + co_l] = bv.x; Bs[(kg * 4u + 1u) * 64u + co_l] = bv.y;
    Bs[(kg * 4u + 2u) * 64u + co_l] = bv.z; Bs[(kg * 4u + 3u) * 64u + co_l] = bv.w;
    workgroupBarrier();
    for (var kk = 0u; kk < 16u; kk++) {
      let b = vec4<f32>(Bs[kk * 64u + tx * 4u], Bs[kk * 64u + tx * 4u + 1u], Bs[kk * 64u + tx * 4u + 2u], Bs[kk * 64u + tx * 4u + 3u]);
      for (var i = 0u; i < 4u; i++) { acc[i] = fma(vec4<f32>(As[kk * 64u + ty + 16u * i]), b, acc[i]); }
    }
    workgroupBarrier();
  }
  let co0 = wg.x * 64u + tx * 4u;
  if (co0 >= u.cout) { return; }
  for (var i = 0u; i < 4u; i++) {
    let m = u.m0 + wg.y * 64u + ty + 16u * i;
    if (m >= u.m0 + u.mcnt) { continue; }
    if (u.split == 1u) { scr[(wg.z * u.mcnt + (m - u.m0)) * (u.cout / 4u) + co0 / 4u] = acc[i]; }
    else { store(m, co0, epi(acc[i], co0)); }
  }
}

@compute @workgroup_size(64)
fn fin(@builtin(global_invocation_id) gid: vec3<u32>) {     // split-K: the parts added in order, then bias and activation
  let groups = u.cout / 4u;
  let t = gid.x + gid.y * 65535u * 64u;
  if (t >= u.mcnt * groups) { return; }
  let mi = t / groups; let cg = t - mi * groups;
  var a = vec4<f32>(0.0);
  for (var z = 0u; z < u.nsplit; z++) { a += scr[(z * u.mcnt + mi) * groups + cg]; }
  store(u.m0 + mi, cg * 4u, epi(a, cg * 4u));
}
`;

// element-wise ops: one thread per 4 channels of one pixel. mode: 0 add, 1 cbn, 2 gmul, 3 gru
export const EW_F = /* wgsl */`
struct U {
  w0: u32, nw: u32, H: u32, W: u32,
  C: u32, mode: u32, out_i0: u32, a_i0: u32,
  pool: u32, up_b: u32, nb: u32, coff: u32,
  b0: vec4<u32>,     // (i0, C, cstart, 0)
  b1: vec4<u32>,
  h_out: u32, a_t0: u32, p0: u32, p1: u32,
}
@group(0) @binding(0) var<uniform> u: U;
@group(0) @binding(1) var<storage, read> A: array<vec4<f32>>;
@group(0) @binding(2) var<storage, read> B0: array<vec4<f32>>;
@group(0) @binding(3) var<storage, read> B1: array<vec4<f32>>;
@group(0) @binding(4) var<storage, read> P: array<f32>;
@group(0) @binding(5) var<storage, read_write> O: array<vec4<f32>>;

fn ldA(j: u32, y: u32, x: u32, H: u32, W: u32, cg: u32) -> vec4<f32> { return A[((u.a_i0 + j) * H * W + y * W + x) * (u.C / 4u) + cg]; }
fn ldB(r: u32, j: u32, y: u32, x: u32, H: u32, W: u32, c: u32) -> vec4<f32> {
  var b = u.b0; if (r == 1u) { b = u.b1; }
  let idx = ((b.x + j) * H * W + y * W + x) * (b.y / 4u) + (c - b.z) / 4u;
  if (r == 0u) { return B0[idx]; } return B1[idx];
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
  var o = vec4<f32>(0.0);
  if (u.mode == 0u) {            // add (pool: the 2x2 means of both; up_b: b read at half resolution)
    var r = 0u; if (u.nb == 2u && c0 >= u.b1.z) { r = 1u; }
    if (u.pool == 1u) {
      var a = vec4<f32>(0.0); var b = vec4<f32>(0.0);
      for (var dy = 0u; dy < 2u; dy++) { for (var dx = 0u; dx < 2u; dx++) {
        a += ldA(j, 2u * y + dy, 2u * x + dx, u.H * 2u, u.W * 2u, cg);
        b += ldB(r, j, 2u * y + dy, 2u * x + dx, u.H * 2u, u.W * 2u, c0);
      } }
      o = a * 0.25 + b * 0.25;
    } else {
      var b = vec4<f32>(0.0);
      if (u.up_b == 1u) { b = ldB(r, j, y >> 1u, x >> 1u, u.H / 2u, u.W / 2u, c0); } else { b = ldB(r, j, y, x, u.H, u.W, c0); }
      o = ldA(j, y, x, u.H, u.W, cg) + b;
    }
  } else if (u.mode == 1u) {     // cbn: relu(x * mul[t, c] + off[t, c]); P[coff]: mul [18][C] then off [18][C]
    let t = u.a_t0 + j;
    let mi = u.coff + t * u.C + c0; let oi = u.coff + 18u * u.C + t * u.C + c0;
    o = max(ldA(j, y, x, u.H, u.W, cg) * vec4<f32>(P[mi], P[mi + 1u], P[mi + 2u], P[mi + 3u]) + vec4<f32>(P[oi], P[oi + 1u], P[oi + 2u], P[oi + 3u]), vec4<f32>(0.0));
  } else if (u.mode == 2u) {     // gmul: r * h
    o = ldA(j, y, x, u.H, u.W, cg) * B0[((u.b0.x + j) * hw + y * u.W + x) * groups + cg];
  } else {                       // gru: u * h + (1 - u) * c ; h in B0, or in O when it is an earlier image of the output tensor
    let g = ldA(j, y, x, u.H, u.W, cg);
    let c = B1[((u.b1.x + j) * hw + y * u.W + x) * groups + cg];
    let hidx = ((u.b0.x + j) * hw + y * u.W + x) * groups + cg;
    var h = vec4<f32>(0.0);
    if (u.h_out == 1u) { h = O[hidx]; } else { h = B0[hidx]; }
    o = g * h + (1.0 - g) * c;
  }
  O[((u.out_i0 + j) * hw + rem) * groups + cg] = o;
}
`;

// latent attention: 64 queries x 64 keys, 48 channels; one workgroup, one thread per query
export const ATTN_F = /* wgsl */`
struct U { q_i0: u32, k_i0: u32, v_i0: u32, out_i0: u32 }
@group(0) @binding(0) var<uniform> u: U;
@group(0) @binding(1) var<storage, read> Q: array<f32>;
@group(0) @binding(2) var<storage, read> K: array<f32>;
@group(0) @binding(3) var<storage, read> V: array<f32>;
@group(0) @binding(4) var<storage, read_write> O: array<f32>;
@compute @workgroup_size(64)
fn main(@builtin(local_invocation_index) i: u32) {
  var lg: array<f32, 64>;
  var mx = -3.0e38;
  for (var l = 0u; l < 64u; l++) {
    var s = 0.0;
    for (var c = 0u; c < 48u; c++) { s = fma(Q[(u.q_i0 * 64u + i) * 48u + c], K[(u.k_i0 * 64u + l) * 48u + c], s); }
    lg[l] = s; mx = max(mx, s);
  }
  var sum = 0.0;
  for (var l = 0u; l < 64u; l++) { lg[l] = exp(lg[l] - mx); sum += lg[l]; }
  for (var c = 0u; c < 48u; c++) {
    var a = 0.0;
    for (var l = 0u; l < 64u; l++) { a = fma(lg[l], V[(u.v_i0 * 64u + l) * 48u + c], a); }
    O[(u.out_i0 * 64u + i) * 48u + c] = a / sum;
  }
}
`;
