// lines.js - reads nowcast/data/us_lines.bin: the outline (coast, Great Lakes shore, Canada
// and Mexico borders), state lines and county lines of the lower 48 states and DC, from US Census Bureau boundary data.
//
// decodeLines(buf) -> { meta, outline, state, county, boxes }
//   meta     the file's JSON header ({ v, q, classes, counts, bbox, source, sha256, made })
//   outline, state, county   arrays of Int32Array, each [lon0, lat0, lon1, lat1, ...] in thousandths of a degree (absolute)
//   boxes    { outline, state, county }: one Float64Array per class, 4 numbers per polyline in the same order,
//            [minLon, minLat, maxLon, maxLat] in degrees, worked out once here
// linesIn(lines, bbox, classes) -> { <class>: [Int32Array, ...] } the polylines whose own box meets bbox
//   bbox = [minLon, minLat, maxLon, maxLat] in degrees; classes = names to look in (default all three)
//
// File: 'USL1', uint32 LE header length H, H bytes of JSON, then per class its polylines: varint(points), zigzag varints of
// the first point (lon*1000, lat*1000), then zigzag varint deltas. Varint = unsigned LEB128.

export const CLASSES = ['outline', 'state', 'county'];

export function decodeLines(buf) {
  const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  if (u8.length < 8 || u8[0] !== 0x55 || u8[1] !== 0x53 || u8[2] !== 0x4c || u8[3] !== 0x31) throw new Error('lines: not a USL1 file');
  const hlen = u8[4] | (u8[5] << 8) | (u8[6] << 16) | (u8[7] * 16777216);
  const meta = JSON.parse(new TextDecoder().decode(u8.subarray(8, 8 + hlen)));
  if (meta.v !== 1) throw new Error('lines: version ' + meta.v);
  const q = meta.q, classes = meta.classes || CLASSES;
  let p = 8 + hlen;
  const uv = () => {                       // unsigned LEB128; plain arithmetic so values past 2^31 stay right
    let v = 0, s = 1, b;
    do { if (p >= u8.length) throw new Error('lines: file is cut short'); b = u8[p++]; v += (b & 127) * s; s *= 128; } while (b & 128);
    return v;
  };
  const zz = () => { const v = uv(); return v % 2 ? -(v + 1) / 2 : v / 2; };
  const out = { meta, boxes: {} };
  classes.forEach((name, ci) => {
    const n = meta.counts[ci], list = new Array(n), box = new Float64Array(4 * n);
    for (let i = 0; i < n; i++) {
      const m = uv(), a = new Int32Array(2 * m);
      let x = 0, y = 0, x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (let k = 0; k < m; k++) {
        x += zz(); y += zz();
        a[2 * k] = x; a[2 * k + 1] = y;
        if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
      }
      list[i] = a;
      box[4 * i] = x0 / q; box[4 * i + 1] = y0 / q; box[4 * i + 2] = x1 / q; box[4 * i + 3] = y1 / q;
    }
    out[name] = list;
    out.boxes[name] = box;
  });
  if (p !== u8.length) throw new Error('lines: ' + (u8.length - p) + ' bytes left over');
  return out;
}

export function linesIn(lines, bbox, classes = CLASSES) {
  const [w, s, e, n] = bbox, res = {};
  for (const name of classes) {
    const list = lines[name] || [], box = lines.boxes[name], hit = [];
    for (let i = 0; i < list.length; i++) {
      const j = 4 * i;
      if (box[j] <= e && box[j + 2] >= w && box[j + 1] <= n && box[j + 3] >= s) hit.push(list[i]);
    }
    res[name] = hit;
  }
  return res;
}
