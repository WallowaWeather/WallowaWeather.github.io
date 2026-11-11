// Part of BEAM's phone code (kept identical to BEAM's own build).
// Wallowa Weather engine: BEAM forward pass (a specialised fork of the author's own WebGPU engine)
// sha256.js - SHA-256 in plain JS, for pages without crypto.subtle (it needs a secure context). FIPS 180-4.
'use strict';

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2]);

/** Uint8Array -> 32-byte Uint8Array */
export function sha256(data) {
  const H = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
  const W = new Uint32Array(64), n = data.length, full = n - (n % 64), tail = new Uint8Array(n - full + 9 <= 64 ? 64 : 128);
  const block = (b, o) => {
    for (let i = 0; i < 16; i++) W[i] = (b[o + 4 * i] << 24) | (b[o + 4 * i + 1] << 16) | (b[o + 4 * i + 2] << 8) | b[o + 4 * i + 3];
    for (let i = 16; i < 64; i++) {
      const x = W[i - 15], y = W[i - 2];
      const s0 = ((x >>> 7) | (x << 25)) ^ ((x >>> 18) | (x << 14)) ^ (x >>> 3), s1 = ((y >>> 17) | (y << 15)) ^ ((y >>> 19) | (y << 13)) ^ (y >>> 10);
      W[i] = (W[i - 16] + s0 + W[i - 7] + s1) | 0;
    }
    let a = H[0], b2 = H[1], c = H[2], d = H[3], e = H[4], f = H[5], g = H[6], h = H[7];
    for (let i = 0; i < 64; i++) {
      const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7)), ch = (e & f) ^ (~e & g);
      const t1 = (h + S1 + ch + K[i] + W[i]) | 0;
      const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10)), mj = (a & b2) ^ (a & c) ^ (b2 & c);
      const t2 = (S0 + mj) | 0;
      h = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b2; b2 = a; a = (t1 + t2) | 0;
    }
    H[0] += a; H[1] += b2; H[2] += c; H[3] += d; H[4] += e; H[5] += f; H[6] += g; H[7] += h;
  };
  for (let o = 0; o < full; o += 64) block(data, o);
  tail.set(data.subarray(full)); tail[n - full] = 0x80;
  const L = tail.length, bits = n * 8;
  tail[L - 4] = bits >>> 24; tail[L - 3] = bits >>> 16; tail[L - 2] = bits >>> 8; tail[L - 1] = bits;
  tail[L - 8] = Math.floor(n / 0x20000000) >>> 24; tail[L - 7] = Math.floor(n / 0x20000000) >>> 16; tail[L - 6] = Math.floor(n / 0x20000000) >>> 8; tail[L - 5] = Math.floor(n / 0x20000000);
  for (let o = 0; o < L; o += 64) block(tail, o);
  const out = new Uint8Array(32);
  for (let i = 0; i < 8; i++) { out[4 * i] = H[i] >>> 24; out[4 * i + 1] = H[i] >>> 16; out[4 * i + 2] = H[i] >>> 8; out[4 * i + 3] = H[i]; }
  return out;
}
export const hex = (u8) => Array.from(u8, (b) => b.toString(16).padStart(2, '0')).join('');
/** hex sha256 of bytes: WebCrypto when the page has it, else the JS version */
export async function sha256hex(u8) {
  if (globalThis.crypto && crypto.subtle && (globalThis.isSecureContext !== false)) {
    try { return hex(new Uint8Array(await crypto.subtle.digest('SHA-256', u8))); } catch (e) { /* fall through */ }
  }
  return hex(sha256(u8));
}
