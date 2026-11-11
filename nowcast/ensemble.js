// nowcast/ensemble.js - one picture from an ensemble without washing it out. A plain average of the members smooths every peak (where
// the members put a shower in slightly different places, the average is a wide, faint smear): the probability-matched mean (PMM) keeps
// the average's pattern (which places are wettest) but gives it the members' own intensities (the pooled values of all members, every
// m-th of them sorted). Pure, node-tested; also the frame statistics.

/** PMM of one frame: mean (Float32Array n), members (array of m Float32Array n) -> Float32Array n */
export function pmm(mean, members) {
  const m = members.length, n = mean.length;
  if (m === 1) return Float32Array.from(members[0]);
  const pool = new Float32Array(n * m);
  members.forEach((f, k) => pool.set(f.subarray(0, n), k * n));
  pool.sort();   // ascending
  const order = rankDesc(mean), out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[order[i]] = pool[n * m - 1 - (i * m + (m >> 1))];   // the i-th wettest place gets the i-th of every m pooled values
  return out;
}
/** indices of a, wettest first (ties: the lower index first) */
export function rankDesc(a) {
  const n = a.length, idx = new Uint32Array(n);
  for (let i = 0; i < n; i++) idx[i] = i;
  return idx.sort((x, y) => (a[y] - a[x]) || (x - y));
}
/** a frame's numbers: mean rate, 95th / 99th percentile over the whole frame, area (pixels) over each rate */
export function frameStats(f, thr = [0.1, 0.5, 1, 4]) {
  const n = f.length, s = Float32Array.from(f, (v) => (v > 0 ? v : 0)).sort();
  let sum = 0; for (let i = 0; i < n; i++) sum += s[i];
  const pct = (q) => s[Math.min(n - 1, Math.floor(q * (n - 1)))];
  const o = { mean: sum / n, p95: pct(0.95), p99: pct(0.99) };
  for (const t of thr) { let c = 0; for (let i = n - 1; i >= 0 && s[i] >= t; i--) c++; o['a' + t] = c; }
  return o;
}
