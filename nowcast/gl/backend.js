// nowcast/gl/backend.js - Wallowa Weather v018: which way the map's colour fields are drawn. WebGL2 first, else WebGL1, each only with
// high-precision fragment floats (the projection is worked out per pixel); else none: the canvas-2D path, today's look. Software GL is
// refused unless asked for (failIfMajorPerformanceCaveat: a phone whose GPU is blocked would draw a full-screen shader on its CPU, far
// slower than the 2D path); the tests ask for it (SwiftShader). guardContext: a lost context hands the map back to the 2D path and a
// restored one brings it back. Pure apart from the canvases it is given.
const ATTRS = { alpha: true, premultipliedAlpha: true, antialias: false, depth: false, stencil: false, preserveDrawingBuffer: true, powerPreference: 'default' };

function capsOf(gl, kind) {
  let hp = null; try { hp = gl.getShaderPrecisionFormat(gl.FRAGMENT_SHADER, gl.HIGH_FLOAT); } catch (e) { hp = null; }
  const ext = (n) => { try { return !!gl.getExtension(n); } catch (e) { return false; } };
  let maxTex = 0; try { maxTex = gl.getParameter(gl.MAX_TEXTURE_SIZE) || 0; } catch (e) { maxTex = 0; }
  return { highp: !!hp && hp.precision >= 23, maxTex: maxTex || 2048, floatTex: kind === 'webgl2' || ext('OES_texture_float'), floatLinear: ext('OES_texture_float_linear'), colorBufferFloat: ext('EXT_color_buffer_float') };
}
function drop(gl) { try { const x = gl.getExtension && gl.getExtension('WEBGL_lose_context'); if (x) x.loseContext(); } catch (e) { /* */ } }

/** make() -> a fresh canvas. opts.force: 'auto' | 'webgl2' | 'webgl1' | '2d'; allowSoftware: accept software GL -> { kind, gl, canvas, caps } */
export function pickBackend(make, { force = 'auto', allowSoftware = false } = {}) {
  const none = { kind: '2d', gl: null, canvas: null, caps: null };
  if (force === '2d') return none;
  const order = force === 'webgl1' ? ['webgl1'] : force === 'webgl2' ? ['webgl2'] : ['webgl2', 'webgl1'];
  for (const kind of order) {
    let canvas = null; try { canvas = make(); } catch (e) { canvas = null; }
    if (!canvas || typeof canvas.getContext !== 'function') return none;
    let gl = null; try { gl = canvas.getContext(kind === 'webgl2' ? 'webgl2' : 'webgl', { ...ATTRS, failIfMajorPerformanceCaveat: !allowSoftware }); } catch (e) { gl = null; }
    if (!gl) continue;
    const caps = capsOf(gl, kind);
    if (!caps.highp) { drop(gl); continue; }
    return { kind, gl, canvas, caps };
  }
  return none;
}
/** lost: flagged and reported (the default prevented, so the browser may restore it); restored: reported -> { lost, dispose() } */
export function guardContext(canvas, { onLost = () => {}, onRestored = () => {} } = {}) {
  let lost = false;
  const L = (e) => { if (e && e.preventDefault) e.preventDefault(); lost = true; onLost(); };
  const R = () => { lost = false; onRestored(); };
  canvas.addEventListener('webglcontextlost', L); canvas.addEventListener('webglcontextrestored', R);
  return { get lost() { return lost; }, dispose() { canvas.removeEventListener('webglcontextlost', L); canvas.removeEventListener('webglcontextrestored', R); } };
}
