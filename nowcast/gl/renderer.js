// nowcast/gl/renderer.js - Wallowa Weather v018: the map's colour fields on the GPU. One off-screen WebGL canvas the size of the map (device
// px); a pass draws a list of fields into it (each a quad over its grid's box, the inverse Mercator worked out per pixel, the value
// texture read with NEAREST and interpolated by hand - so it works the same on every phone, float-filterable or not - then the ramp), and
// the pass's box is copied into the map's 2D canvas at that point of its layer order. Textures are uploaded once per field and kept
// (pans and zooms upload nothing); a lost context hands the drawing back to the 2D path until it is restored.
//   value textures: one byte (R8 / LUMINANCE) for codes and u8 values; two bytes (RG8 / LUMINANCE_ALPHA, high then low) for u16 and, on
//   WebGL1, for Float32 values quantised over their range (0 = nodata); R32F on WebGL2 (nodata and NaN -> -3e38, never sampled linearly).
import { pickBackend, guardContext } from './backend.js';
import { fieldUniforms, viewOf } from './proj.js';

const VS = (gl2) => `${gl2 ? '#version 300 es\nin' : 'attribute'} vec2 a_p;
uniform vec4 u_rect; uniform vec2 u_wh;
void main() { vec2 q = mix(u_rect.xy, u_rect.zw, a_p); gl_Position = vec4(q.x / u_wh.x * 2.0 - 1.0, 1.0 - q.y / u_wh.y * 2.0, 0.0, 1.0); }`;
const FS_HEAD = (gl2) => (gl2 ? '#version 300 es\nprecision highp float;\n#define TEX texture\n#define CH2 g\nout vec4 o_col;\n#define FRAG o_col\n'
  : 'precision highp float;\n#define TEX texture2D\n#define CH2 a\n#define FRAG gl_FragColor\n');
const FS = `
uniform sampler2D u_val; uniform sampler2D u_ramp;
uniform vec2 u_size;   // cols, rows
uniform vec2 u_px;     // dpr, the canvas height in device px
uniform vec2 u_int;    // the whole parts of u and v at the reference (exact)
uniform vec4 u_lin;    // fu, B, fv, S : u = iu + fu + B x ; v = iv + fv - S D(y)
uniform vec3 u_merc;   // yc, mc, k
uniform vec4 u_hole;   // CSS px x0 y0 x1 y1 left out (x1 < x0: none)
uniform vec4 u_dec;    // fmt (0 u8, 1 two bytes, 2 f32), mode (0 value, 1 code), entries a class, dry (0 no, 1 level 0 / under the value, 2 no colour)
uniform vec4 u_v2;     // nodata (raw), dry value, scale, offset
uniform vec4 u_look;   // vmin, 1 / (vmax - vmin), smooth (0 nearest, 1 bilinear, 2 B-spline), aa
uniform float u_op;
float sinh_(float x) { if (abs(x) < 0.05) { float x2 = x * x; return x * (1.0 + x2 / 6.0 * (1.0 + x2 / 20.0)); } float e = exp(x); return 0.5 * (e - 1.0 / e); }
float cosh_(float x) { float e = exp(x); return 0.5 * (e + 1.0 / e); }
float rawAt(vec2 t) {
  vec4 s = TEX(u_val, (t + 0.5) / u_size);
  if (u_dec.x < 0.5) return floor(s.r * 255.0 + 0.5);
  if (u_dec.x < 1.5) return floor(s.r * 255.0 + 0.5) * 256.0 + floor(s.CH2 * 255.0 + 0.5);
  return s.r;
}
// a texel: x = valid, y = wet, z = value (level or physical), w = class
vec4 tap(vec2 t) {
  t = clamp(t, vec2(0.0), u_size - 1.0);
  float r = rawAt(t);
  float ok = u_dec.x > 1.5 ? (r > -1.0e37 ? 1.0 : 0.0) : (abs(r - u_v2.x) < 0.5 ? 0.0 : 1.0);
  if (ok < 0.5) return vec4(0.0);
  if (u_dec.y > 0.5) {   // a code: coloured or "none" by its own table entry (the ramp texel at the code, read at its centre: exact)
    float cls = floor(r / u_dec.z); float lv = r - cls * u_dec.z;
    float wet = u_dec.w < 0.5 ? 1.0 : u_dec.w < 1.5 ? (lv > 0.5 ? 1.0 : 0.0) : (TEX(u_ramp, vec2((r + 0.5) / 256.0, 0.5)).a > 0.5 / 255.0 ? 1.0 : 0.0);
    return vec4(1.0, wet, lv, cls);
  }
  float v = r * u_v2.z + u_v2.w;
  return vec4(1.0, (u_dec.w < 0.5 || v > u_v2.y) ? 1.0 : 0.0, v, 0.0);
}
void add(inout vec4 acc, inout vec4 cw, vec4 t, float w) {
  if (t.x < 0.5) return;
  acc.x += w;
  if (t.y < 0.5) return;
  acc.y += w; acc.z += w * t.z;
  cw += w * vec4(equal(vec4(t.w), vec4(0.0, 1.0, 2.0, 3.0)));
}
void main() {
  float x = gl_FragCoord.x / u_px.x, y = (u_px.y - gl_FragCoord.y) / u_px.x;
  if (x >= u_hole.x && x < u_hole.z && y >= u_hole.y && y < u_hole.w) discard;
  float d = u_merc.z * (y - u_merc.x);
  float D = 2.0 * atan(sinh_(-0.5 * d) / cosh_(u_merc.y - 0.5 * d));
  vec2 g = vec2(u_lin.x + u_lin.y * x, u_lin.z - u_lin.w * D);
  if (g.x < -u_int.x || g.y < -u_int.y || g.x > u_size.x - u_int.x || g.y > u_size.y - u_int.y) discard;
  vec2 fl = floor(g);
  vec4 n = tap(u_int + fl);
  if (n.x < 0.5) discard;   // a nodata cell: cut at its edge
  vec4 acc = vec4(0.0); vec4 cw = vec4(0.0);
  if (u_look.z < 0.5) {
    if (n.y < 0.5) discard;
    add(acc, cw, n, 1.0);
  } else if (u_look.z < 1.5) {
    vec2 p = g - 0.5; vec2 f0 = floor(p); vec2 f = p - f0; vec2 t0 = u_int + f0;
    add(acc, cw, tap(t0), (1.0 - f.x) * (1.0 - f.y));
    add(acc, cw, tap(t0 + vec2(1.0, 0.0)), f.x * (1.0 - f.y));
    add(acc, cw, tap(t0 + vec2(0.0, 1.0)), (1.0 - f.x) * f.y);
    add(acc, cw, tap(t0 + vec2(1.0, 1.0)), f.x * f.y);
  } else {
    vec2 dd = g - fl - 0.5; vec2 t0 = u_int + fl;
    vec2 wa = 0.5 * (0.5 - dd) * (0.5 - dd), wb = 0.75 - dd * dd, wc = 0.5 * (0.5 + dd) * (0.5 + dd);
    add(acc, cw, tap(t0 + vec2(-1.0, -1.0)), wa.x * wa.y); add(acc, cw, tap(t0 + vec2(0.0, -1.0)), wb.x * wa.y); add(acc, cw, tap(t0 + vec2(1.0, -1.0)), wc.x * wa.y);
    add(acc, cw, tap(t0 + vec2(-1.0, 0.0)), wa.x * wb.y);  add(acc, cw, n, wb.x * wb.y);                         add(acc, cw, tap(t0 + vec2(1.0, 0.0)), wc.x * wb.y);
    add(acc, cw, tap(t0 + vec2(-1.0, 1.0)), wa.x * wc.y);  add(acc, cw, tap(t0 + vec2(0.0, 1.0)), wb.x * wc.y);  add(acc, cw, tap(t0 + vec2(1.0, 1.0)), wc.x * wc.y);
  }
  if (acc.y <= 0.0) discard;
  float val = acc.z / acc.y;
  float shape = 1.0;
  if (u_dec.w > 0.5 && u_look.z > 0.5) shape = smoothstep(0.5 - u_look.w, 0.5 + u_look.w, acc.y / acc.x);
  vec4 col = vec4(0.0);
  if (u_dec.y > 0.5) {
    for (int c = 0; c < 4; c++) {
      if (cw[c] > 0.0) { vec4 r = TEX(u_ramp, vec2((float(c) * u_dec.z + val + 0.5) / 256.0, 0.5)); col += cw[c] * vec4(r.rgb * r.a, r.a); }
    }
    col /= acc.y;
  } else {
    float t = clamp((val - u_look.x) * u_look.y, 0.0, 1.0);
    vec4 r = TEX(u_ramp, vec2((t * 255.0 + 0.5) / 256.0, 0.5));
    col = vec4(r.rgb * r.a, r.a);
  }
  FRAG = col * (shape * u_op);
}`;
const UNIFORMS = ['u_rect', 'u_wh', 'u_val', 'u_ramp', 'u_size', 'u_px', 'u_int', 'u_lin', 'u_merc', 'u_hole', 'u_dec', 'u_v2', 'u_look', 'u_op'];
export const FEATHER = 0.12;   // the dry outline's least softening (wet-fraction units): soft at close zooms, ~a pixel far out
const BUDGET = 96 * 2 ** 20;   // texture bytes kept before the least recently used go

const defaultMake = () => (typeof document !== 'undefined' ? document.createElement('canvas') : typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(1, 1) : null);

/** -> { kind, ok(), canvas, caps, stats, fits(F), draw(ctx, items, view, W, H), release(F), destroy() }
 *  items: [{ F (gl/field.js normField), alpha = 1, hole = CSS px rect | null, smooth (override) }]; view: { lat, lon, z, w, h, dpr } */
export function createFieldRenderer({ make = defaultMake, force = 'auto', allowSoftware = false, onChange = () => {} } = {}) {
  const B = pickBackend(make, { force, allowSoftware }), gl = B.gl, gl2 = B.kind === 'webgl2';
  const stats = { uploads: 0, uploadBytes: 0, rampUploads: 0, passes: 0, lost: 0, restored: 0, errors: 0 };
  const recs = new Map();   // F -> { tex, ramp, bytes, used, enc }
  let P = null, buf = null, lost = false, guard = null, clock = 0, total = 0, broken = false;
  function compile(type, src) {
    const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS) && !gl.isContextLost()) throw new Error('field shader: ' + gl.getShaderInfoLog(s));
    return s;
  }
  function init() {
    recs.clear(); total = 0;
    const prog = gl.createProgram();
    gl.attachShader(prog, compile(gl.VERTEX_SHADER, VS(gl2))); gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, FS_HEAD(gl2) + FS));
    gl.bindAttribLocation(prog, 0, 'a_p'); gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS) && !gl.isContextLost()) throw new Error('field program: ' + gl.getProgramInfoLog(prog));
    const u = {}; for (const k of UNIFORMS) u[k] = gl.getUniformLocation(prog, k);
    buf = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, buf); gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), gl.STATIC_DRAW);
    P = { prog, u };
  }
  if (gl) {
    try { init(); } catch (e) { console.warn('[map] the GPU fields are off:', e.message); broken = true; }
    guard = guardContext(B.canvas, {
      onLost: () => { lost = true; P = null; recs.clear(); total = 0; stats.lost++; onChange('lost'); },
      onRestored: () => { try { init(); lost = false; broken = false; stats.restored++; } catch (e) { broken = true; } onChange('restored'); },
    });
  }
  const ok = () => !!gl && !lost && !broken && !!P && !gl.isContextLost();
  const fits = (F) => F.grid.cols <= B.caps.maxTex && F.grid.rows <= B.caps.maxTex;

  function texture(filter) {
    const t = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return t;
  }
  /** the field's textures (uploaded the first time it is drawn) -> rec */
  function recOf(F) {
    let r = recs.get(F); if (r) { r.used = clock; return r; }
    const { cols: w, rows: h } = F.grid, n = w * h, raw = F.raw;
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1); gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false); gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    if (gl.UNPACK_COLORSPACE_CONVERSION_WEBGL) gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
    const tex = texture(gl.NEAREST);
    let enc = { fmt: 0, nodata: F.nodata == null ? -1 : F.nodata, scale: F.scale, offset: F.offset }, bytes = n;
    if (F.fmt === 'u8') {
      const a = raw instanceof Uint8Array ? raw : new Uint8Array(raw.buffer, raw.byteOffset, raw.length);
      if (gl2) gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, w, h, 0, gl.RED, gl.UNSIGNED_BYTE, a);
      else gl.texImage2D(gl.TEXTURE_2D, 0, gl.LUMINANCE, w, h, 0, gl.LUMINANCE, gl.UNSIGNED_BYTE, a);
    } else if (F.fmt === 'f32' && gl2) {
      const a = new Float32Array(n), nd = F.nodata;
      for (let i = 0; i < n; i++) { const v = raw[i]; a[i] = v === v && v !== nd && Math.abs(v) < 1e37 ? v : -3e38; }
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.R32F, w, h, 0, gl.RED, gl.FLOAT, a); enc = { fmt: 2, nodata: -1, scale: F.scale, offset: F.offset }; bytes = 4 * n;
    } else {   // two bytes: u16 as is; Float32 (WebGL1) quantised over its range, 0 = nodata
      const a = new Uint8Array(2 * n);
      if (F.fmt === 'u16') { for (let i = 0; i < n; i++) { a[2 * i] = raw[i] >> 8; a[2 * i + 1] = raw[i] & 255; } }
      else {
        let lo = Infinity, hi = -Infinity; const nd = F.nodata;
        for (let i = 0; i < n; i++) { const v = raw[i]; if (v === v && v !== nd && Math.abs(v) < 1e37) { if (v < lo) lo = v; if (v > hi) hi = v; } }
        if (!(lo <= hi)) { lo = 0; hi = 0; }
        const step = (hi - lo) / 65534, inv = step > 0 ? 1 / step : 0;
        for (let i = 0; i < n; i++) { const v = raw[i]; const q = v === v && v !== nd && Math.abs(v) < 1e37 ? 1 + Math.round((v - lo) * inv) : 0; a[2 * i] = q >> 8; a[2 * i + 1] = q & 255; }
        enc = { fmt: 1, nodata: 0, scale: step * F.scale, offset: (lo - step) * F.scale + F.offset };
      }
      if (F.fmt === 'u16') enc = { fmt: 1, nodata: F.nodata == null ? -1 : F.nodata, scale: F.scale, offset: F.offset };
      if (gl2) gl.texImage2D(gl.TEXTURE_2D, 0, gl.RG8, w, h, 0, gl.RG, gl.UNSIGNED_BYTE, a);
      else gl.texImage2D(gl.TEXTURE_2D, 0, gl.LUMINANCE_ALPHA, w, h, 0, gl.LUMINANCE_ALPHA, gl.UNSIGNED_BYTE, a);
      bytes = 2 * n;
    }
    const ramp = texture(gl.LINEAR);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 256, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, F.ramp);
    stats.uploads++; stats.uploadBytes += bytes; stats.rampUploads++;
    r = { tex, ramp, bytes, used: clock, enc }; recs.set(F, r); total += bytes;
    return r;
  }
  function free(F, r) { gl.deleteTexture(r.tex); gl.deleteTexture(r.ramp); total -= r.bytes; recs.delete(F); }
  function evict() {
    if (total <= BUDGET) return;
    for (const [F, r] of [...recs.entries()].sort((a, b) => a[1].used - b[1].used)) { if (total <= BUDGET || r.used === clock) break; free(F, r); }
  }

  /** draw the items into ctx (the map's canvas or a layer cache, device px W x H); false = not drawn (the caller uses the 2D path) */
  function draw(ctx, items, view, W, H) {
    if (!ok()) return false;
    clock++;
    const V = viewOf(view), dpr = view.dpr || 1, todo = [];
    let x0 = W, y0 = H, x1 = 0, y1 = 0;
    for (const it of items) {
      const g = it.F.grid, a = V.toScreen(g.top, g.left), b = V.toScreen(g.top - g.rows * g.dlat, g.left + g.cols * g.dlon);
      const rx0 = Math.max(0, Math.floor(Math.min(a.x, b.x) * dpr)), ry0 = Math.max(0, Math.floor(Math.min(a.y, b.y) * dpr));
      const rx1 = Math.min(W, Math.ceil(Math.max(a.x, b.x) * dpr)), ry1 = Math.min(H, Math.ceil(Math.max(a.y, b.y) * dpr));
      if (rx1 <= rx0 || ry1 <= ry0) continue;
      todo.push({ it, r: [rx0, ry0, rx1, ry1] });
      x0 = Math.min(x0, rx0); y0 = Math.min(y0, ry0); x1 = Math.max(x1, rx1); y1 = Math.max(y1, ry1);
    }
    if (!todo.length) return true;
    const cv = B.canvas; if (cv.width !== W || cv.height !== H) { cv.width = W; cv.height = H; }
    gl.viewport(0, 0, W, H);
    gl.enable(gl.SCISSOR_TEST); gl.scissor(x0, H - y1, x1 - x0, y1 - y0);
    gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
    gl.disable(gl.DEPTH_TEST); gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.useProgram(P.prog); gl.bindBuffer(gl.ARRAY_BUFFER, buf); gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    const u = P.u, drawn = [];
    gl.uniform2f(u.u_wh, W, H); gl.uniform2f(u.u_px, dpr, H); gl.uniform1i(u.u_val, 0); gl.uniform1i(u.u_ramp, 1);
    for (const { it, r } of todo) {
      const F = it.F, rec = recOf(F), U = fieldUniforms(view, F.grid), e = rec.enc, sm = it.smooth != null ? it.smooth : F.smooth;
      const aa = Math.min(0.5, Math.max(FEATHER, 0.75 * U.tpp)), h = it.hole;
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, rec.tex);
      gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, rec.ramp);
      gl.uniform4f(u.u_rect, r[0], r[1], r[2], r[3]);
      gl.uniform2f(u.u_size, F.grid.cols, F.grid.rows);
      gl.uniform2f(u.u_int, U.iu, U.iv); gl.uniform4f(u.u_lin, U.fu, U.B, U.fv, U.S); gl.uniform3f(u.u_merc, U.yc, U.mc, U.k);
      if (h) gl.uniform4f(u.u_hole, h.x, h.y, h.x + h.w, h.y + h.h); else gl.uniform4f(u.u_hole, 1, 1, 0, 0);
      gl.uniform4f(u.u_dec, e.fmt, F.mode === 'code' ? 1 : 0, F.lb, !F.dry ? 0 : F.dryBy === 'table' ? 2 : 1);
      gl.uniform4f(u.u_v2, e.nodata, F.dryV == null ? 0 : F.dryV, e.scale, e.offset);
      gl.uniform4f(u.u_look, F.vmin, F.vmax > F.vmin ? 1 / (F.vmax - F.vmin) : 0, sm, aa);
      gl.uniform1f(u.u_op, F.opacity * (it.alpha == null ? 1 : it.alpha));
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      drawn.push({ name: it.name || null, smooth: sm, aa });
    }
    gl.disable(gl.SCISSOR_TEST);
    ctx.save(); ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over'; ctx.imageSmoothingEnabled = false;
    ctx.drawImage(cv, x0, y0, x1 - x0, y1 - y0, x0, y0, x1 - x0, y1 - y0);
    ctx.restore();
    stats.passes++; stats.drawn = drawn;
    evict();
    return true;
  }
  return {
    get kind() { return ok() ? B.kind : '2d'; }, ok, fits, draw, stats, canvas: B.canvas, caps: B.caps,
    release(F) { const r = F && recs.get(F); if (r && ok()) free(F, r); else if (r) recs.delete(F); },
    /** frees the textures and hands the context back at once (browsers keep only so many: a map opened and closed many times must not
     *  push the newest out) */
    destroy() {
      if (guard) guard.dispose();
      if (ok()) { for (const [F, r] of [...recs.entries()]) free(F, r); try { gl.deleteBuffer(buf); gl.deleteProgram(P.prog); } catch (e) { /* */ } }
      recs.clear(); P = null; broken = true;
      try { const x = gl && gl.getExtension('WEBGL_lose_context'); if (x) x.loseContext(); } catch (e) { /* */ }
      if (B.canvas) { B.canvas.width = 1; B.canvas.height = 1; }
    },
  };
}
