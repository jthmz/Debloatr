// MAXAPACITY Debloat: the wizard, the phone he works on, and his lightning.
//
// One WebGL canvas laid over the whole window. Nothing in here knows about
// adb or the tool. The page says what there is to show (which apps circle the
// phone, what the wizard is doing) and this draws it wherever the page has
// put a stage: an element marked data-stage="full", "hero" or "side". Sparks
// and lightning are drawn in window coordinates, so a spell can leave the
// stage and land on a row of a list.
//
// No dependencies and no assets: every shape is built here from a profile or
// a few points. If WebGL is not there, create() returns null and the page
// carries on without any of this.
(() => {
  'use strict';

  const TAU = Math.PI * 2;
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const mix = (a, b, t) => a + (b - a) * t;
  const ease = t => 1 - Math.pow(1 - clamp(t, 0, 1), 3);
  const smooth = t => { const u = clamp(t, 0, 1); return u * u * (3 - 2 * u); };
  const back = t => { const u = clamp(t, 0, 1) - 1; return 1 + u * u * (2.7 * u + 1.7); };

  // ---- Matrices ------------------------------------------------------------
  // Column-major 4x4, as WebGL takes them. A small stack, so that a hand can be
  // placed relative to an arm and an arm relative to a body.
  const STACK = Array.from({ length: 48 }, () => new Float32Array(16));
  let top = 0;
  const identity = m => { m.fill(0); m[0] = m[5] = m[10] = m[15] = 1; return m; };
  const push = () => { STACK[top + 1].set(STACK[top]); top += 1; };
  const pop = () => { top -= 1; };
  function T(x, y, z) {
    const m = STACK[top];
    m[12] += m[0] * x + m[4] * y + m[8] * z;
    m[13] += m[1] * x + m[5] * y + m[9] * z;
    m[14] += m[2] * x + m[6] * y + m[10] * z;
    m[15] += m[3] * x + m[7] * y + m[11] * z;
  }
  function S(x, y, z) {
    const m = STACK[top];
    for (let i = 0; i < 4; i++) { m[i] *= x; m[4 + i] *= y; m[8 + i] *= z; }
  }
  function RX(a) {
    const m = STACK[top], c = Math.cos(a), s = Math.sin(a);
    for (let i = 0; i < 4; i++) {
      const y = m[4 + i], z = m[8 + i];
      m[4 + i] = y * c + z * s;
      m[8 + i] = z * c - y * s;
    }
  }
  function RY(a) {
    const m = STACK[top], c = Math.cos(a), s = Math.sin(a);
    for (let i = 0; i < 4; i++) {
      const x = m[i], z = m[8 + i];
      m[i] = x * c - z * s;
      m[8 + i] = x * s + z * c;
    }
  }
  function RZ(a) {
    const m = STACK[top], c = Math.cos(a), s = Math.sin(a);
    for (let i = 0; i < 4; i++) {
      const x = m[i], y = m[4 + i];
      m[i] = x * c + y * s;
      m[4 + i] = y * c - x * s;
    }
  }
  function multiply(out, a, b) {
    for (let c = 0; c < 4; c++) {
      const b0 = b[c * 4], b1 = b[c * 4 + 1], b2 = b[c * 4 + 2], b3 = b[c * 4 + 3];
      out[c * 4] = a[0] * b0 + a[4] * b1 + a[8] * b2 + a[12] * b3;
      out[c * 4 + 1] = a[1] * b0 + a[5] * b1 + a[9] * b2 + a[13] * b3;
      out[c * 4 + 2] = a[2] * b0 + a[6] * b1 + a[10] * b2 + a[14] * b3;
      out[c * 4 + 3] = a[3] * b0 + a[7] * b1 + a[11] * b2 + a[15] * b3;
    }
    return out;
  }
  // The inverse transpose of the upper 3x3: what keeps a normal square to its
  // surface when the shape has been stretched.
  function normalMatrix(out, m) {
    const a00 = m[0], a01 = m[1], a02 = m[2], a10 = m[4], a11 = m[5], a12 = m[6], a20 = m[8], a21 = m[9], a22 = m[10];
    const b01 = a22 * a11 - a12 * a21, b11 = -a22 * a10 + a12 * a20, b21 = a21 * a10 - a11 * a20;
    let det = a00 * b01 + a01 * b11 + a02 * b21;
    det = det ? 1 / det : 0;
    out[0] = b01 * det; out[1] = b11 * det; out[2] = b21 * det;
    out[3] = (-a22 * a01 + a02 * a21) * det; out[4] = (a22 * a00 - a02 * a20) * det; out[5] = (-a21 * a00 + a01 * a20) * det;
    out[6] = (a12 * a01 - a02 * a11) * det; out[7] = (-a12 * a00 + a02 * a10) * det; out[8] = (a11 * a00 - a01 * a10) * det;
  }

  // ---- Shapes --------------------------------------------------------------
  // Each returns interleaved position and normal, and indices.

  // A profile of [radius, height] turned around the vertical axis.
  function lathe(profile, seg = 22) {
    const n = profile.length;
    const nr = new Float32Array(n), ny = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      let ax = 0, ay = 0;
      for (const [a, b] of [[i - 1, i], [i, i + 1]]) {
        if (a < 0 || b >= n) continue;
        const dr = profile[b][0] - profile[a][0], dy = profile[b][1] - profile[a][1];
        const len = Math.hypot(dr, dy);
        if (len < 1e-6) continue;
        ax += dy / len;
        ay -= dr / len;
      }
      const len = Math.hypot(ax, ay) || 1;
      nr[i] = ax / len;
      ny[i] = ay / len;
    }
    const verts = new Float32Array(n * (seg + 1) * 6);
    let k = 0;
    for (let i = 0; i < n; i++) {
      for (let j = 0; j <= seg; j++) {
        const a = j / seg * TAU, c = Math.cos(a), s = Math.sin(a);
        verts[k++] = profile[i][0] * c; verts[k++] = profile[i][1]; verts[k++] = profile[i][0] * s;
        verts[k++] = nr[i] * c; verts[k++] = ny[i]; verts[k++] = nr[i] * s;
      }
    }
    const idx = new Uint16Array((n - 1) * seg * 6);
    k = 0;
    for (let i = 0; i < n - 1; i++) {
      for (let j = 0; j < seg; j++) {
        const a = i * (seg + 1) + j, b = a + seg + 1;
        idx[k++] = a; idx[k++] = b; idx[k++] = a + 1;
        idx[k++] = a + 1; idx[k++] = b; idx[k++] = b + 1;
      }
    }
    return { verts, idx };
  }

  const ball = (rings = 16, seg = 28) => lathe(Array.from({ length: rings + 1 }, (_, i) => {
    const a = -Math.PI / 2 + i / rings * Math.PI;
    return [Math.cos(a), Math.sin(a)];
  }), seg);

  // A slab with rounded corners, standing in the XY plane: a phone, an app
  // icon, a lens.
  function slab(w, h, d, r, steps = 5) {
    const pts = [];
    const corners = [[w / 2 - r, h / 2 - r], [-(w / 2 - r), h / 2 - r], [-(w / 2 - r), -(h / 2 - r)], [w / 2 - r, -(h / 2 - r)]];
    corners.forEach(([cx, cy], q) => {
      for (let i = 0; i <= steps; i++) {
        const a = (q + i / steps) * Math.PI / 2;
        pts.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r, Math.cos(a), Math.sin(a)]);
      }
    });
    const n = pts.length, v = [], ix = [];
    for (let i = 0; i <= n; i++) {
      const p = pts[i % n];
      v.push(p[0], p[1], d / 2, p[2], p[3], 0, p[0], p[1], -d / 2, p[2], p[3], 0);
    }
    for (let i = 0; i < n; i++) {
      const a = i * 2;
      ix.push(a, a + 1, a + 2, a + 2, a + 1, a + 3);
    }
    for (const z of [1, -1]) {
      const base = v.length / 6;
      v.push(0, 0, z * d / 2, 0, 0, z);
      for (let i = 0; i <= n; i++) {
        const p = pts[i % n];
        v.push(p[0], p[1], z * d / 2, 0, 0, z);
      }
      for (let i = 1; i <= n; i++) ix.push(base, base + i, base + i + 1);
    }
    return { verts: new Float32Array(v), idx: new Uint16Array(ix) };
  }

  // A flat outline facing forward: the stars and the bolt.
  function flat(points, tris) {
    const v = [];
    for (const [x, y] of points) v.push(x, y, 0, 0, 0, 1);
    return { verts: new Float32Array(v), idx: new Uint16Array(tris.flat()) };
  }
  const starShape = () => {
    const pts = [[0, 0]], tris = [];
    for (let i = 0; i < 10; i++) {
      const r = i % 2 ? 0.44 : 1, a = Math.PI / 2 + i * Math.PI / 5;
      pts.push([Math.cos(a) * r, Math.sin(a) * r]);
      tris.push([0, i + 1, (i + 1) % 10 + 1]);
    }
    return flat(pts, tris);
  };
  // The MAXAPACITY bolt.
  const boltShape = () => flat(
    [[0.25, 1], [-0.55, -0.12], [-0.02, -0.12], [-0.25, -1], [0.55, 0.12], [0.02, 0.12]],
    [[0, 1, 2], [0, 2, 5], [2, 3, 4], [2, 4, 5]]);

  // Where a lathe's surface is at a given height: its radius there and how far
  // it leans back, for laying a star on it.
  function onProfile(profile, y) {
    for (let i = 0; i < profile.length - 1; i++) {
      const [r0, y0] = profile[i], [r1, y1] = profile[i + 1];
      if ((y - y0) * (y - y1) <= 0 && y0 !== y1) {
        const t = (y - y0) / (y1 - y0);
        return { r: mix(r0, r1, t), slope: Math.atan2(r0 - r1, y1 - y0) };
      }
    }
    return { r: profile[0][0], slope: 0 };
  }

  const ROBE = [[0.74, 0], [0.752, 0.05], [0.70, 0.17], [0.585, 0.45], [0.47, 0.8], [0.385, 1.1], [0.325, 1.3], [0.27, 1.42], [0.17, 1.5], [0, 1.52]];
  const HAT1 = [[0.335, 0], [0.235, 0.36]];
  const HAT2 = [[0.235, 0], [0.13, 0.34]];
  const HAT3 = [[0.13, 0], [0.055, 0.26], [0, 0.4]];

  // ---- Colours -------------------------------------------------------------
  const C = {
    lime: [0.749, 1, 0],
    robe: [0.33, 0.23, 0.86],
    hat: [0.28, 0.19, 0.76],
    cream: [0.97, 0.96, 0.93],
    skin: [0.97, 0.75, 0.6],
    nose: [0.95, 0.6, 0.52],
    wood: [0.52, 0.34, 0.2],
    dark: [0.085, 0.085, 0.105],
    shoe: [0.36, 0.2, 0.12],
    white: [1, 1, 1],
    phone: [0.13, 0.135, 0.16],
    glass: [0.72, 1, 0.42],
  };
  // What circles the phone. Colour says what it is: red for what puts junk
  // back, amber for the junk, grey for what is being kept.
  const KIND = {
    installer: [0.97, 0.33, 0.33],
    back: [0.97, 0.33, 0.33],
    remove: [0.98, 0.72, 0.2],
    pushed: [0.98, 0.72, 0.2],
    ask: [0.62, 0.66, 0.74],
    keep: [0.34, 0.36, 0.42],
    fail: [0.4, 0.26, 0.28],
  };

  // ---- Shaders -------------------------------------------------------------
  const MESH_VS = `
    attribute vec3 aPos; attribute vec3 aNor;
    uniform mat4 uVP; uniform mat4 uM; uniform mat3 uN;
    varying vec3 vN; varying vec3 vW;
    void main() {
      vec4 w = uM * vec4(aPos, 1.0);
      vW = w.xyz;
      vN = uN * aNor;
      gl_Position = uVP * w;
    }`;
  // Soft toy lighting: a wrapped key light, sky above and dusk below, a cool
  // rim, and the orb's own lime light falling on whatever is near it.
  const MESH_FS = `
    precision mediump float;
    uniform vec3 uColor; uniform vec3 uEmit; uniform vec4 uGlass;
    uniform vec3 uEye; uniform vec3 uLight; uniform vec4 uOrb;
    uniform vec3 uAmbLo; uniform vec3 uAmbHi; uniform vec3 uRim;
    varying vec3 vN; varying vec3 vW;
    void main() {
      vec3 n = normalize(vN);
      vec3 v = normalize(uEye - vW);
      if (dot(n, v) < 0.0) n = -n;
      float lit = smoothstep(-0.3, 0.8, dot(n, uLight));
      vec3 amb = mix(uAmbLo, uAmbHi, n.y * 0.5 + 0.5);
      vec3 c = uColor * (amb * 0.62 + vec3(1.0, 0.96, 0.9) * lit * 0.72);
      vec3 toOrb = uOrb.xyz - vW;
      c += uColor * vec3(0.75, 1.0, 0.1) * max(dot(n, normalize(toOrb)), 0.0) * uOrb.w / (1.0 + dot(toOrb, toOrb) * 1.6);
      float rim = pow(1.0 - max(dot(n, v), 0.0), 3.0);
      c += uRim * rim * uGlass.z;
      c += vec3(1.0) * pow(max(dot(n, normalize(uLight + v)), 0.0), 48.0) * uGlass.w;
      c *= mix(0.7, 1.0, smoothstep(0.0, 0.55, vW.y));
      c += uEmit;
      float a = clamp(uGlass.x + rim * uGlass.y, 0.0, 1.0);
      gl_FragColor = vec4(c * a, a);
    }`;

  const QUAD_VS = `
    attribute vec2 aPos;
    uniform mat4 uMVP; uniform float uFlat;
    varying vec2 vUv;
    void main() {
      vUv = aPos;
      gl_Position = uFlat > 0.5 ? vec4(aPos, 0.0, 1.0) : uMVP * vec4(aPos.x, 0.0, aPos.y, 1.0);
    }`;
  // Everything painted rather than modelled: the circle on the floor, the
  // shadow, the phone's screen, glows, and the night sky behind a stage.
  const QUAD_FS = `
    precision mediump float;
    uniform int uMode; uniform float uTime; uniform vec4 uA; uniform vec4 uB; uniform vec3 uTint;
    varying vec2 vUv;
    float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
    float seg(vec2 p, vec2 a, vec2 b) {
      vec2 pa = p - a, ba = b - a;
      return length(pa - ba * clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0));
    }
    float box(vec2 p, vec2 c, vec2 size, float r) {
      vec2 d = abs(p - c) - size + r;
      return length(max(d, 0.0)) + min(max(d.x, d.y), 0.0) - r;
    }
    float tri(vec2 p, float rot) {
      float a = atan(p.y, p.x) + rot;
      float k = cos(floor(0.5 + a / 2.0943951) * 2.0943951 - a) * length(p);
      return smoothstep(0.016, 0.0, abs(k - 0.40));
    }
    void main() {
      vec2 p = vUv;
      float r = length(p);
      vec4 o = vec4(0.0);
      if (uMode == 0) {
        float a = atan(p.y, p.x);
        float line = smoothstep(0.024, 0.0, abs(r - 0.94)) + smoothstep(0.014, 0.0, abs(r - 0.80)) + smoothstep(0.012, 0.0, abs(r - 0.36));
        float tick = smoothstep(0.10, 0.04, abs(fract((a + uTime * 0.22) * 3.8197186) - 0.5)) * step(0.82, r) * step(r, 0.92);
        float star = (tri(p, -uTime * 0.17) + tri(p, -uTime * 0.17 + 1.0471976)) * step(r, 0.80);
        float v = (line + tick * 0.8 + star * 0.8) * uA.x + exp(-r * r * 3.2) * uA.y;
        v *= smoothstep(1.0, 0.95, r);
        o = vec4(uTint * v, v * 0.55);
      } else if (uMode == 1) {
        o = vec4(0.0, 0.0, 0.0, smoothstep(1.0, 0.15, r) * uA.x);
      } else if (uMode == 2) {
        vec2 q = abs(p) * uB.xy - (uB.xy - uB.z);
        if (length(max(q, 0.0)) > uB.z) discard;
        vec2 uv = p * 0.5 + 0.5;
        // The same picture with x and y on one scale, for drawing shapes.
        vec2 k = vec2(uv.x, (uv.y - 0.5) * uB.y / uB.x + 0.5);
        vec3 bg = mix(vec3(0.075, 0.08, 0.095), vec3(0.135, 0.14, 0.165), uv.y);
        vec2 g = vec2(uv.x * 4.0, uv.y * 7.4 - 0.7);
        vec2 cell = floor(g);
        vec2 f = fract(g) - 0.5;
        float icon = smoothstep(0.09, 0.03, length(max(abs(f) - 0.23, 0.0))) * step(0.0, cell.y) * step(cell.y, 5.0);
        float h = hash(cell + 3.0);
        vec3 ic = vec3(0.42, 0.45, 0.52) + vec3(0.3) * h;
        float junk = step(hash(cell + 7.0), uA.z);
        ic = mix(ic, vec3(0.97, 0.33, 0.33) * (0.85 + 0.15 * sin(uTime * 4.0 + h * 6.28)), junk);
        vec3 c = mix(bg, ic, icon * 0.92);
        if (uA.x < 0.5) {
          // Nothing plugged in: a plug, waiting.
          float plug = min(min(box(k, vec2(0.5, 0.56), vec2(0.13, 0.085), 0.03), box(k, vec2(0.5, 0.33), vec2(0.022, 0.15), 0.012)),
            min(box(k, vec2(0.44, 0.7), vec2(0.022, 0.055), 0.01), box(k, vec2(0.56, 0.7), vec2(0.022, 0.055), 0.01)));
          c = bg * 0.55 + vec3(0.62, 0.65, 0.72) * smoothstep(0.012, 0.0, plug) * (0.45 + 0.3 * sin(uTime * 2.4));
        } else if (uA.x > 3.5) {
          // The phone is asking whether to trust this computer.
          c = bg * 0.6;
          float card = smoothstep(0.012, 0.0, box(k, vec2(0.5, 0.5), vec2(0.42, 0.3), 0.06));
          c = mix(c, vec3(0.2, 0.21, 0.25), card);
          float words = min(box(k, vec2(0.36, 0.67), vec2(0.2, 0.024), 0.02),
            min(box(k, vec2(0.42, 0.57), vec2(0.26, 0.016), 0.014), box(k, vec2(0.34, 0.5), vec2(0.18, 0.016), 0.014)));
          c = mix(c, vec3(0.6, 0.63, 0.7), smoothstep(0.01, 0.0, words) * card);
          c = mix(c, vec3(0.36, 0.38, 0.44), smoothstep(0.01, 0.0, box(k, vec2(0.45, 0.31), vec2(0.1, 0.045), 0.04)) * card);
          float allow = box(k, vec2(0.72, 0.31), vec2(0.12, 0.05), 0.045);
          c = mix(c, vec3(0.75, 1.0, 0.0), smoothstep(0.01, 0.0, allow) * card);
          c += vec3(0.75, 1.0, 0.0) * smoothstep(0.07, 0.0, abs(allow - 0.03 - 0.03 * fract(uTime * 0.9))) * 0.5 * (1.0 - fract(uTime * 0.9));
        } else if (uA.x > 1.5 && uA.x < 2.5) {
          float beam = smoothstep(0.09, 0.0, abs(uv.y - fract(uTime * 0.55)));
          c += vec3(0.75, 1.0, 0.0) * (beam * 0.95 + 0.05);
        } else if (uA.x > 2.5) {
          c = mix(c, bg * 1.2, 0.75);
          float tickmark = min(seg(k, vec2(0.30, 0.50), vec2(0.44, 0.37)), seg(k, vec2(0.44, 0.37), vec2(0.72, 0.65)));
          float mark = smoothstep(0.062, 0.04, tickmark) + smoothstep(0.03, 0.012, abs(length(k - 0.5) - 0.40));
          c = mix(c, vec3(0.75, 1.0, 0.0), clamp(mark, 0.0, 1.0));
        }
        o = vec4(c, 1.0);
      } else if (uMode == 3) {
        float g = exp(-r * r * 4.5) * smoothstep(1.0, 0.6, r) * uA.x;
        o = vec4(uTint * g, g * uA.y);
      } else {
        vec2 px = (p * 0.5 + 0.5) * uB.xy;
        vec2 q = abs(px - uB.xy * 0.5) - (uB.xy * 0.5 - uB.z);
        if (length(max(q, 0.0)) - uB.z > 0.0) discard;
        vec2 gp = px / 34.0;
        vec2 id = floor(gp);
        float d = length(fract(gp) - 0.2 - vec2(hash(id), hash(id + 17.0)) * 0.6);
        float tw = 0.55 + 0.45 * sin(uTime * (0.6 + hash(id + 9.0) * 1.8) + hash(id) * 6.28);
        float s = smoothstep(0.07, 0.0, d) * step(0.74, hash(id + 5.0)) * tw * (0.25 + 0.5 * hash(id + 2.0)) * uA.x;
        s *= smoothstep(0.08, 0.6, px.y / uB.y);
        float haze = exp(-pow(px.y / uB.y * 3.0, 2.0)) * 0.26;
        o = vec4(vec3(0.86, 0.88, 0.95) * s + uTint * haze, s * 0.3 + haze * 0.15);
      }
      gl_FragColor = o;
    }`;

  const POINT_VS = `
    attribute vec2 aPos; attribute float aSize; attribute vec4 aColor; attribute float aShape;
    uniform vec2 uRes; uniform float uScale;
    varying vec4 vColor; varying float vShape;
    void main() {
      gl_Position = vec4(aPos.x / uRes.x * 2.0 - 1.0, 1.0 - aPos.y / uRes.y * 2.0, 0.0, 1.0);
      gl_PointSize = aSize * uScale;
      vColor = aColor;
      vShape = aShape;
    }`;
  const POINT_FS = `
    precision mediump float;
    uniform float uOver;
    varying vec4 vColor; varying float vShape;
    void main() {
      vec2 p = gl_PointCoord * 2.0 - 1.0;
      float r = length(p);
      float a;
      if (vShape < 0.5) {
        a = smoothstep(1.0, 0.0, r);
        a *= a;
      } else {
        float arms = pow(max(0.0, 1.0 - abs(p.x) * 7.0), 2.0) + pow(max(0.0, 1.0 - abs(p.y) * 7.0), 2.0);
        a = min(1.0, arms * max(0.0, 1.0 - r) + smoothstep(0.32, 0.0, r));
      }
      a *= vColor.a;
      gl_FragColor = vec4(vColor.rgb * a, a * uOver);
    }`;

  const BOLT_VS = `
    attribute vec2 aPos; attribute float aV; attribute float aA;
    uniform vec2 uRes;
    varying float vV; varying float vA;
    void main() {
      gl_Position = vec4(aPos.x / uRes.x * 2.0 - 1.0, 1.0 - aPos.y / uRes.y * 2.0, 0.0, 1.0);
      vV = aV;
      vA = aA;
    }`;
  const BOLT_FS = `
    precision mediump float;
    uniform vec3 uColor; uniform vec3 uCore; uniform float uOver;
    varying float vV; varying float vA;
    void main() {
      float core = smoothstep(0.36, 0.08, abs(vV));
      float glow = pow(max(0.0, 1.0 - abs(vV)), 2.2);
      float i = max(core, glow * 0.75) * vA;
      gl_FragColor = vec4(mix(uColor, uCore, core) * i, i * uOver);
    }`;

  // ---- Poses ---------------------------------------------------------------
  // Everything the wizard can do is a set of numbers to ease towards. Angles
  // are in radians; "out" spreads an arm sideways, "fwd" swings it forward and
  // on up over the head.
  const REST = {
    y: 0, lean: 0, pitch: 0, turn: 0.14, headYaw: 0, headPitch: 0, headTilt: 0,
    armLOut: 0.34, armLFwd: 0.28, armROut: 0.45, armRFwd: 0.5, staffOut: 0.05, staffFwd: 0,
    brow: 0, frown: 0, glow: 0.6, look: 1,
  };
  const ACTS = {
    idle: () => ({}),
    hello: t => ({ armLOut: 2.45 + Math.sin(t * 11) * 0.3, armLFwd: 0.2, headTilt: -0.14, brow: 1, frown: 0, y: 0.02, turn: 0 }),
    scan: () => ({ turn: 0.6, pitch: 0.1, headYaw: 0.22, headPitch: 0.05, armROut: 0.55, armRFwd: 1.0, staffOut: 0.5, staffFwd: 0.2, armLOut: -0.9, armLFwd: 0.9, frown: 0.7, glow: 1.3, look: 0.1 }),
    think: t => ({ turn: 0.3, headTilt: 0.2 + Math.sin(t * 1.6) * 0.04, headPitch: -0.12, armLOut: 0.72, armLFwd: 0.1, brow: 0.8, frown: 0, look: 0.3 }),
    channel: t => ({ turn: 0.5, pitch: -0.13, y: 0.05 + Math.sin(t * 5) * 0.015, lean: Math.sin(t * 27) * 0.008, armROut: 0.3, armRFwd: 1.9, staffOut: 0.22, staffFwd: -0.25, armLOut: 1.1, armLFwd: 0.6, headPitch: -0.2, headYaw: 0.2, frown: 1, glow: 1.9, look: 0 }),
    zap: t => (t < 0.09
      ? { turn: 0.3, pitch: -0.2, armRFwd: 1.9, armROut: 0.35, staffFwd: -0.45, frown: 1, glow: 2, look: 0 }
      : { turn: 0.55, pitch: 0.12, armRFwd: 1.3, armROut: 0.6, staffOut: 0.34, staffFwd: 0.1, armLOut: 0.9, armLFwd: -0.3, headYaw: 0.3, frown: 1, glow: 2.6, look: 0 }),
    cheer: () => ({ armLOut: 2.6, armLFwd: 0.1, armROut: 0.5, armRFwd: 2.2, staffOut: -0.1, brow: 1, frown: 0, glow: 1.7, headPitch: -0.15, look: 0.2 }),
    cool: t => ({ turn: 0.05, armLOut: 0.55, armLFwd: 0.85, lean: 0.04, headTilt: -0.1, headPitch: Math.sin(t * 2.2) * 0.05, frown: 0.5, look: 0.6 }),
    shrug: () => ({ armLOut: 1.0, armLFwd: 0.45, armROut: 0.95, armRFwd: 0.5, y: 0.03, headTilt: 0.26, brow: 1, frown: 0, staffOut: 0.5, look: 0.4 }),
    search: t => ({ turn: Math.sin(t * 1.1) * 0.5, headYaw: Math.sin(t * 1.1 + 0.4) * 0.55, armLOut: 0.3, armLFwd: 2.25, pitch: 0.08, frown: 0.6, look: 0 }),
  };
  // Where his eyes go when left to themselves: mostly to whoever is there.
  const GLANCES = [[0, 0], [0, 0], [0.5, 0.05], [0.3, -0.3], [-0.35, 0.05], [0.12, 0.22]];
  // The ones that play once and hand back to whatever was going on.
  const ONCE = { hello: 1.7, zap: 0.42, cheer: 2.0, shrug: 1.6 };

  // ---- The layer -----------------------------------------------------------
  function create(canvas, options = {}) {
    let gl = null;
    try {
      gl = canvas.getContext('webgl', { alpha: true, premultipliedAlpha: true, antialias: true, depth: true, stencil: true });
    } catch (e) { /* no WebGL here */ }
    if (!gl) return null;

    // How he is dressed and lit. Graphite and lime are the app's own
    // colours; violet is what he first wore, kept for those who miss it.
    const LOOKS = {
      graphite: { robe: [0.215, 0.225, 0.26], hat: [0.175, 0.185, 0.215], ambLo: [0.22, 0.23, 0.27], ambHi: [0.66, 0.69, 0.76], rim: [0.8, 0.88, 1.0], haze: [0.05, 0.055, 0.065], stars: 0.7, floor: [0.5, 0.53, 0.6] },
      violet: { robe: [0.33, 0.23, 0.86], hat: [0.28, 0.19, 0.76], ambLo: [0.30, 0.20, 0.46], ambHi: [0.62, 0.66, 0.98], rim: [0.55, 0.5, 1.0], haze: [0.36, 0.22, 0.9], stars: 1.4, floor: [0.45, 0.35, 0.9] },
    };
    let look = LOOKS.graphite;
    function dress(name) {
      look = LOOKS[name] || LOOKS.graphite;
      C.robe = look.robe;
      C.hat = look.hat;
    }
    dress(options.look);
    const settings = {
      still: Boolean(options.still),          // reduced motion: poses, no movement
      light: Boolean(options.light),          // the page behind is light
      enabled: true,
    };

    let res = null;         // GL programs and buffers; rebuilt if the context is lost
    const masked = Boolean((gl.getContextAttributes() || {}).stencil);
    let raf = 0;
    let last = 0;
    let lastDrawn = 0;
    let clock = 0;          // seconds of animation, which stand still while hidden
    let ratio = 1;
    let slow = 0;           // how many frames in a row took too long
    let cap = 2;            // the most pixels per CSS pixel worth drawing
    let active = 0;         // the time until which this draws every frame
    const pointer = { x: -1, y: -1, at: 0 };

    const scene = {
      phone: 'none',        // none | idle | scan | clean
      phoneShown: 0,
      junk: 0,
      tiles: [],
      circle: 0.5,
      orbScreen: null,      // where things are in the window, for spells
      headScreen: null,
      phoneScreen: null,
      visible: false,
      stage: '',
      swayX: 0,             // how far the eye has moved with the pointer
      swayY: 0,
    };
    const wizard = {
      base: 'idle', baseSince: 0, once: null, onceSince: 0, shades: false, talk: 0,
      pose: { ...REST, shades: 0, blink: 0, lookX: 0, lookY: 0, hatX: 0, hatZ: 0, beardZ: 0, spin: 0, hop: 0 },
      nextBlink: 2, lastYaw: 0, poke: 0, glance: [0, 0], glanceAt: 3, arrive: 1,
    };
    const sparks = [];
    const bolts = [];
    const late = [];
    const lateMats = Array.from({ length: 12 }, () => new Float32Array(16));

    // ---- GL plumbing ----
    function program(vs, fs, attribs, uniforms) {
      const make = (type, src) => {
        const sh = gl.createShader(type);
        gl.shaderSource(sh, src);
        gl.compileShader(sh);
        if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(sh) || 'shader');
        return sh;
      };
      const prog = gl.createProgram();
      gl.attachShader(prog, make(gl.VERTEX_SHADER, vs));
      gl.attachShader(prog, make(gl.FRAGMENT_SHADER, fs));
      attribs.forEach((name, i) => gl.bindAttribLocation(prog, i, name));
      gl.linkProgram(prog);
      if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog) || 'link');
      const u = {};
      for (const name of uniforms) u[name] = gl.getUniformLocation(prog, name);
      return { prog, u };
    }
    function mesh(shape) {
      const vbo = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
      gl.bufferData(gl.ARRAY_BUFFER, shape.verts, gl.STATIC_DRAW);
      const ibo = gl.createBuffer();
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ibo);
      gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, shape.idx, gl.STATIC_DRAW);
      return { vbo, ibo, count: shape.idx.length };
    }

    function build() {
      const r = {};
      r.mesh = program(MESH_VS, MESH_FS, ['aPos', 'aNor'], ['uVP', 'uM', 'uN', 'uColor', 'uEmit', 'uGlass', 'uEye', 'uLight', 'uOrb', 'uAmbLo', 'uAmbHi', 'uRim']);
      r.quad = program(QUAD_VS, QUAD_FS, ['aPos'], ['uMVP', 'uFlat', 'uMode', 'uTime', 'uA', 'uB', 'uTint']);
      r.point = program(POINT_VS, POINT_FS, ['aPos', 'aSize', 'aColor', 'aShape'], ['uRes', 'uScale', 'uOver']);
      r.bolt = program(BOLT_VS, BOLT_FS, ['aPos', 'aV', 'aA'], ['uRes', 'uColor', 'uCore', 'uOver']);
      r.m = {
        ball: mesh(ball()),
        robe: mesh(lathe(ROBE, 44)),
        hem: mesh(lathe([[0.76, 0], [0.772, 0.035], [0.762, 0.075], [0.735, 0.1]], 44)),
        belt: mesh(lathe([[0.468, 0.83], [0.486, 0.87], [0.476, 0.93], [0.445, 0.965]], 40)),
        sleeve: mesh(lathe([[0, 0.03], [0.10, 0], [0.125, -0.2], [0.165, -0.45], [0.215, -0.62], [0.16, -0.6]], 24)),
        cuff: mesh(lathe([[0.216, -0.59], [0.224, -0.61], [0.214, -0.628], [0.185, -0.615]], 24)),
        beard: mesh(lathe([[0, 0.03], [0.2, 0], [0.27, -0.1], [0.25, -0.28], [0.17, -0.5], [0.07, -0.68], [0, -0.76]], 28)),
        brim: mesh(lathe([[0, 0], [0.5, -0.012], [0.6, 0.008], [0.612, 0.03], [0.5, 0.052], [0.33, 0.062]], 44)),
        band: mesh(lathe([[0.326, 0.045], [0.337, 0.062], [0.318, 0.14], [0.298, 0.152]], 36)),
        hat1: mesh(lathe(HAT1, 36)),
        hat2: mesh(lathe(HAT2, 30)),
        hat3: mesh(lathe(HAT3, 22)),
        staff: mesh(lathe([[0, 0], [0.03, 0.01], [0.037, 1.2], [0.032, 2.2], [0.05, 2.26], [0, 2.27]], 10)),
        cradle: mesh(lathe([[0.03, 0], [0.085, 0.04], [0.12, 0.11], [0.105, 0.12], [0.07, 0.07], [0.03, 0.05]], 14)),
        phone: mesh(slab(0.92, 1.86, 0.11, 0.14, 8)),
        tile: mesh(slab(1, 1, 0.26, 0.26, 7)),
        lens: mesh(slab(0.2, 0.115, 0.03, 0.04)),
        box: mesh(slab(2, 2, 2, 0.02, 1)),
        star: mesh(starShape()),
        zap: mesh(boltShape()),
      };
      r.quadBuf = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, r.quadBuf);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
      r.pointBuf = gl.createBuffer();
      r.pointData = new Float32Array(1400 * 8);
      r.boltBuf = gl.createBuffer();
      r.boltData = new Float32Array(4096 * 4);
      r.maxPoint = gl.getParameter(gl.ALIASED_POINT_SIZE_RANGE)[1] || 64;
      return r;
    }

    // ---- Drawing shapes ----
    const vp = new Float32Array(16), view = new Float32Array(16), proj = new Float32Array(16);
    const mvp = new Float32Array(16), nm = new Float32Array(9);
    const eye = [0, 0, 0], camRight = [1, 0, 0], camUp = [0, 1, 0];
    const orbWorld = [0, 2.4, 0.3];
    let orbGlow = 0.6;
    let bound = null;

    function useMesh() {
      gl.useProgram(res.mesh.prog);
      gl.uniformMatrix4fv(res.mesh.u.uVP, false, vp);
      gl.uniform3fv(res.mesh.u.uEye, eye);
      gl.uniform3f(res.mesh.u.uLight, -0.42, 0.72, 0.55);
      gl.uniform3fv(res.mesh.u.uAmbLo, look.ambLo);
      gl.uniform3fv(res.mesh.u.uAmbHi, look.ambHi);
      gl.uniform3fv(res.mesh.u.uRim, look.rim);
      gl.uniform4f(res.mesh.u.uOrb, orbWorld[0], orbWorld[1], orbWorld[2], orbGlow);
      gl.enableVertexAttribArray(0);
      gl.enableVertexAttribArray(1);
      bound = null;
    }
    function paint(m, color, o, matrix) {
      if (bound !== m) {
        gl.bindBuffer(gl.ARRAY_BUFFER, m.vbo);
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, m.ibo);
        gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 24, 0);
        gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 24, 12);
        bound = m;
      }
      const u = res.mesh.u;
      normalMatrix(nm, matrix);
      gl.uniformMatrix4fv(u.uM, false, matrix);
      gl.uniformMatrix3fv(u.uN, false, nm);
      gl.uniform3fv(u.uColor, color);
      const e = o.emit || 0;
      const tint = o.emitColor || color;
      gl.uniform3f(u.uEmit, tint[0] * e, tint[1] * e, tint[2] * e);
      gl.uniform4f(u.uGlass, o.alpha == null ? 1 : o.alpha, o.rimAlpha || 0, o.rim == null ? 0.35 : o.rim, o.spec || 0);
      gl.drawElements(gl.TRIANGLES, m.count, gl.UNSIGNED_SHORT, 0);
    }
    const NONE = {};
    // Solid shapes go straight to the screen. See-through ones wait until
    // every solid thing is down, or they would hide what is behind them.
    function draw(m, color, o = NONE) {
      if (o.alpha != null && o.alpha < 1) {
        if (late.length >= lateMats.length) return;
        const matrix = lateMats[late.length];
        matrix.set(STACK[top]);
        late.push({ m, color, o, matrix });
        return;
      }
      paint(m, color, o, STACK[top]);
    }

    function useQuad() {
      gl.useProgram(res.quad.prog);
      gl.bindBuffer(gl.ARRAY_BUFFER, res.quadBuf);
      gl.enableVertexAttribArray(0);
      gl.disableVertexAttribArray(1);
      gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 8, 0);
      gl.uniform1f(res.quad.u.uTime, clock);
    }
    function quad(mode, a, b, tint, flatOnScreen) {
      const u = res.quad.u;
      gl.uniform1i(u.uMode, mode);
      gl.uniform4fv(u.uA, a);
      gl.uniform4fv(u.uB, b);
      gl.uniform3fv(u.uTint, tint);
      gl.uniform1f(u.uFlat, flatOnScreen ? 1 : 0);
      if (!flatOnScreen) gl.uniformMatrix4fv(u.uMVP, false, multiply(mvp, vp, STACK[top]));
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }
    // A glow that always faces whoever is looking.
    function glowAt(x, y, z, size, tint, strength, over) {
      const m = STACK[top + 1];
      m[0] = camRight[0] * size; m[1] = camRight[1] * size; m[2] = camRight[2] * size; m[3] = 0;
      m[4] = 0; m[5] = 0; m[6] = 0; m[7] = 0;
      m[8] = camUp[0] * size; m[9] = camUp[1] * size; m[10] = camUp[2] * size; m[11] = 0;
      m[12] = x; m[13] = y; m[14] = z; m[15] = 1;
      top += 1;
      quad(3, [strength, over, 0, 0], [0, 0, 0, 0], tint, false);
      top -= 1;
    }

    // A point of the world, in window pixels.
    function toScreen(rect, x, y, z) {
      const w = vp[3] * x + vp[7] * y + vp[11] * z + vp[15];
      if (w <= 0) return null;
      const nx = (vp[0] * x + vp[4] * y + vp[8] * z + vp[12]) / w;
      const ny = (vp[1] * x + vp[5] * y + vp[9] * z + vp[13]) / w;
      return { x: rect.left + (nx * 0.5 + 0.5) * rect.width, y: rect.top + (0.5 - ny * 0.5) * rect.height };
    }

    // ---- The camera ----
    // Fits a box of the world, wide by tall around a centre, into part of a
    // stage: "into" is that part as fractions of the stage, left, top, right
    // and bottom. The rest of the stage is still sky.
    function frame(rect, cx, cy, wide, tall, into) {
      const fov = 0.5;
      const aspect = rect.width / rect.height;
      const fw = into[2] - into[0], fh = into[3] - into[1];
      const t = Math.tan(fov / 2);
      const dist = Math.max(tall / (2 * t * fh), wide / (2 * t * aspect * fw));
      const lift = dist * 0.11;
      // The eye moves a little against the pointer, which is what makes
      // near things slide over far ones: the scene has depth to look into.
      eye[0] = cx - scene.swayX * dist * 0.1;
      eye[1] = cy + lift + scene.swayY * dist * 0.05;
      eye[2] = dist;
      // Look at the centre from there: a little above, as a rule.
      let zx = eye[0] - cx, zy = eye[1] - cy, zz = dist;
      let l = Math.hypot(zx, zy, zz);
      zx /= l; zy /= l; zz /= l;
      let xx = zz, xz = -zx;
      l = Math.hypot(xx, xz);
      xx /= l; xz /= l;
      const yx = zy * xz, yy = zz * xx - zx * xz, yz = -zy * xx;
      view[0] = xx; view[1] = yx; view[2] = zx; view[3] = 0;
      view[4] = 0; view[5] = yy; view[6] = zy; view[7] = 0;
      view[8] = xz; view[9] = yz; view[10] = zz; view[11] = 0;
      view[12] = -(xx * eye[0] + xz * eye[2]);
      view[13] = -(yx * eye[0] + yy * eye[1] + yz * eye[2]);
      view[14] = -(zx * eye[0] + zy * eye[1] + zz * eye[2]);
      view[15] = 1;
      camRight[0] = xx; camRight[1] = 0; camRight[2] = xz;
      camUp[0] = yx; camUp[1] = yy; camUp[2] = yz;
      const f = 1 / t, near = 0.5, far = 80;
      proj.fill(0);
      proj[0] = f / aspect;
      proj[5] = f;
      // Off-centre, so that the box lands in the middle of "into".
      proj[8] = -((into[0] + into[2]) - 1);
      proj[9] = (into[1] + into[3]) - 1;
      proj[10] = (far + near) / (near - far);
      proj[11] = -1;
      proj[14] = 2 * far * near / (near - far);
      multiply(vp, proj, view);
    }

    // ---- The wizard ----
    const HAT_STARS = [[1, 0.25, 0.75, 0.05], [1, 0.29, 2.3, 0.042], [1, 0.26, 4.2, 0.045], [2, 0.1, 1.5, 0.038], [2, 0.2, 3.6, 0.03], [2, 0.14, 5.4, 0.034]];
    const ROBE_STARS = [[0.36, 1.0, 0.062], [0.64, 2.3, 0.05], [0.33, 2.75, 0.045], [0.55, 0.3, 0.042], [0.3, 1.8, 0.04], [0.66, 4.3, 0.05], [0.3, 5.3, 0.055], [1.1, 3.6, 0.035], [0.75, 5.9, 0.04]];

    function starOn(profile, y, angle, size, wob) {
      const at = onProfile(profile, y);
      push();
      RY(Math.PI / 2 - angle);
      T(0, y, at.r + 0.008);
      RX(-at.slope);
      RZ(angle * 3 + wob);
      S(size, size, 1);
      draw(res.m.star, C.lime, { emit: 0.55, rim: 0 });
      pop();
    }

    function drawWizard(depth, t, nest) {
      const p = wizard.pose;
      const w = settings.still ? 0 : 1;
      const m = res.m;
      const breath = Math.sin(t * 1.7) * w;

      push();
      T(0, p.y + p.hop + breath * 0.012, 0);
      RY(p.turn + p.spin);
      RX(p.pitch);
      RZ(p.lean);
      if (depth === 0 && wizard.arrive < 0.45 && !settings.still) {
        const grown = back(wizard.arrive / 0.45);
        S(grown, grown, grown);
      }

      for (const s of [-1, 1]) {
        push(); T(s * 0.22, 0.065, 0.62); S(0.14, 0.078, 0.22); draw(m.ball, C.shoe); pop();
      }
      push();
      S(1, 1 + breath * 0.008, 1);
      draw(m.robe, C.robe);
      draw(m.hem, C.lime, { emit: 0.18 });
      draw(m.belt, C.dark, { spec: 0.3 });
      for (const [y, a, size] of ROBE_STARS) starOn(ROBE, y, a, size, 0);
      pop();
      push(); T(0, 0.9, 0.478); S(0.06, 0.05, 0.016); draw(m.box, C.lime, { emit: 0.35 }); pop();
      push(); T(0, 1.47, 0.01); S(0.3, 0.085, 0.27); draw(m.ball, C.cream); pop();

      // Head, and everything that rides on it.
      push();
      T(0, 1.5, 0.02);
      RY(p.headYaw);
      RX(p.headPitch);
      RZ(p.headTilt);
      push(); T(0, 0.27, -0.07); S(0.34, 0.335, 0.32); draw(m.ball, C.cream); pop();
      push(); T(0, 0.29, 0); S(0.3, 0.31, 0.29); draw(m.ball, C.skin); pop();
      push(); T(0, 0.255, 0.29); S(0.085, 0.08, 0.09); draw(m.ball, C.nose); pop();
      // The white of each eye, and the pupil that does the looking.
      const ex = p.lookX * 0.019, ey = -p.lookY * 0.016;
      const lid = 1 - 0.94 * p.blink;
      for (const s of [-1, 1]) {
        push(); T(s * 0.112, 0.342, 0.252); S(0.05, 0.06 * lid, 0.03); draw(m.ball, C.white, { emit: 0.1, rim: 0 }); pop();
        push(); T(s * 0.112 + ex, 0.34 + ey * lid, 0.276); S(0.027, 0.031 * lid, 0.014); draw(m.ball, C.dark, { spec: 0.8, rim: 0 }); pop();
        if (p.blink < 0.5 && p.shades < 0.5) {
          push(); T(s * 0.112 + ex + 0.009, 0.352 + ey, 0.289); S(0.008, 0.008, 0.004); draw(m.ball, C.white, { emit: 1 }); pop();
        }
        push(); T(s * 0.118, 0.425 + p.brow * 0.035, 0.258); RZ(s * (0.06 + p.frown * 0.34 - p.brow * 0.22)); S(0.08, 0.027, 0.034); draw(m.ball, C.cream); pop();
        push(); T(s * 0.088, 0.196, 0.287); RZ(s * -0.45); S(0.128, 0.054, 0.062); draw(m.ball, C.cream); pop();
      }
      push();
      T(0, 0.135, 0.125);
      RX(-0.2 + Math.sin(t * 19) * 0.045 * wizard.talk * w);
      RZ(p.beardZ + Math.sin(t * 1.3) * 0.03 * w);
      S(1, 1, 0.62);
      draw(m.beard, C.cream);
      pop();

      // The shades wait under the brim and drop when he has earned them.
      if (p.shades > 0.01) {
        const down = ease(p.shades);
        push();
        T(0, mix(0.62, 0.35, down), mix(0.2, 0.306, down));
        RX(mix(-1.1, 0, down));
        for (const s of [-1, 1]) {
          push(); T(s * 0.118, 0, 0); draw(m.lens, C.dark, { spec: 1.4, rim: 1.1 }); pop();
          push(); T(s * 0.118 + 0.028, 0.012, 0.017); RZ(0.7); S(0.045, 0.007, 0.002); draw(m.box, C.lime, { emit: 0.9 }); pop();
        }
        push(); S(0.05, 0.012, 0.012); draw(m.box, C.dark); pop();
        pop();
      }

      // The hat, in three parts so that its point can flop.
      push();
      T(0, 0.5, -0.02);
      RX(-0.14);
      RZ(0.05);
      draw(m.brim, C.hat);
      draw(m.band, C.lime, { emit: 0.14 });
      push(); T(0, 0.1, 0.337); RX(-0.27); S(0.032, 0.042, 1); draw(m.zap, C.dark, { rim: 0 }); pop();
      draw(m.hat1, C.hat);
      for (const [part, y, a, size] of HAT_STARS) if (part === 1) starOn(HAT1, y, a, size, 0);
      push();
      T(0, 0.35, 0);
      RZ(0.16 + p.hatZ * 0.5);
      RX(-0.2 + p.hatX * 0.5);
      draw(m.hat2, C.hat);
      for (const [part, y, a, size] of HAT_STARS) if (part === 2) starOn(HAT2, y, a, size, 0);
      push();
      T(0, 0.33, 0);
      RZ(0.5 + p.hatZ);
      RX(-0.35 + p.hatX);
      draw(m.hat3, C.hat);
      push(); T(0, 0.41, 0); S(0.05, 0.05, 0.05); draw(m.ball, C.lime, { emit: 0.85 }); pop();
      pop();
      pop();
      pop();
      pop();

      // Arms. The left is free to wave; the right holds the staff.
      const L = 0.66;
      const arm = (side, out, fwd) => {
        push();
        T(side * 0.3, 1.36, 0.02);
        RX(-fwd);
        RZ(side * out);
        draw(m.sleeve, C.robe);
        draw(m.cuff, C.lime, { emit: 0.18 });
        push(); T(0, -L, 0); S(0.088, 0.088, 0.088); draw(m.ball, C.skin); pop();
        pop();
      };
      arm(-1, p.armLOut, p.armLFwd);
      arm(1, p.armROut, p.armRFwd);

      // The staff stays upright whatever the arm does, so it is placed at the
      // hand rather than hung from it.
      const cf = Math.cos(p.armRFwd), sf = Math.sin(p.armRFwd);
      push();
      T(0.3 + L * Math.sin(p.armROut), 1.36 - L * Math.cos(p.armROut) * cf, 0.02 + L * Math.cos(p.armROut) * sf);
      RZ(-p.staffOut);
      RX(p.staffFwd);
      T(0, -0.84, 0);
      draw(m.staff, C.wood);
      push(); T(0, 2.25, 0); draw(m.cradle, C.lime, { emit: 0.2 }); pop();
      push();
      T(0, 2.47, 0);
      if (depth === 0) {
        const o = STACK[top];
        orbWorld[0] = o[12]; orbWorld[1] = o[13]; orbWorld[2] = o[14];
      }
      const pulse = 1 + Math.sin(t * 3.1) * 0.04 * w;
      if (depth < nest) {
        // A wizard in the wizard's orb, doing what the wizard does.
        push();
        T(0, -0.135, 0);
        RY(t * 0.5 * w);
        S(0.088, 0.088, 0.088);
        drawWizard(depth + 1, t - 0.4, nest);
        pop();
      } else {
        push(); S(0.075, 0.075, 0.075); draw(m.ball, C.lime, { emit: 1.2 }); pop();
      }
      S(0.17 * pulse, 0.17 * pulse, 0.17 * pulse);
      draw(m.ball, C.glass, { alpha: 0.13, rimAlpha: 0.8, rim: 0, spec: 1.2, emit: 0.1 + 0.08 * p.glow, emitColor: C.lime });
      pop();
      pop();

      pop();
    }

    // Move every number of the pose a step towards where the current act
    // wants it.
    function animateWizard(dt, t) {
      const p = wizard.pose;
      if (wizard.once && t - wizard.onceSince > ONCE[wizard.once]) wizard.once = null;
      const name = wizard.once || wizard.base;
      const since = t - (wizard.once ? wizard.onceSince : wizard.baseSince);
      const want = { ...REST, ...ACTS[name](since) };
      const quick = name === 'zap' ? 30 : 11;
      const k = settings.still ? 1 : 1 - Math.exp(-quick * dt);

      // Looking at the pointer, when there is nothing better to look at; and
      // once the pointer has been still a while, about himself: at the
      // phone, at the orb, back at whoever is watching.
      let lookYaw = 0, lookPitch = 0;
      if (scene.headScreen && pointer.x >= 0 && performance.now() - pointer.at < 4000) {
        lookYaw = clamp((pointer.x - scene.headScreen.x) / 420, -1, 1) * 0.65;
        lookPitch = clamp((pointer.y - scene.headScreen.y) / 420, -1, 1) * 0.4;
      } else if (!settings.still) {
        if (t > wizard.glanceAt) {
          wizard.glance = GLANCES[Math.floor(Math.random() * GLANCES.length)];
          wizard.glanceAt = t + 1.8 + Math.random() * 4;
        }
        lookYaw = wizard.glance[0];
        lookPitch = wizard.glance[1];
      }
      want.headYaw += lookYaw * want.look - want.turn * 0.5 * want.look;
      want.headPitch += lookPitch * want.look;

      for (const key of Object.keys(REST)) p[key] += (want[key] - p[key]) * k;
      p.lookX += (clamp(lookYaw * 1.6, -1, 1) * want.look - p.lookX) * k;
      p.lookY += (clamp(lookPitch * 2, -1, 1) * want.look - p.lookY) * k;
      p.shades += ((wizard.shades ? 1 : 0) - p.shades) * (settings.still ? 1 : 1 - Math.exp(-5 * dt));
      // A spin and a hop are not eased: they are over too soon for that.
      const lively = !settings.still;
      p.spin = name === 'cheer' && since < 0.9 && lively ? smooth(since / 0.9) * TAU : 0;
      p.hop = name === 'cheer' && lively ? Math.abs(Math.sin(since * 7)) * 0.2 * Math.max(0, 1 - since / 1.8) : 0;
      if (wizard.poke > 0) {
        wizard.poke = Math.max(0, wizard.poke - dt);
        const u = 1 - wizard.poke / 0.7;
        p.spin += smooth(u) * TAU;
        p.hop += Math.sin(u * Math.PI) * 0.12;
      }

      // The point of the hat and the beard trail behind the head.
      const yawSpeed = dt > 0 ? (p.headYaw + p.turn - wizard.lastYaw) / dt : 0;
      wizard.lastYaw = p.headYaw + p.turn;
      const sway = lively ? 1 : 0;
      p.hatZ += ((clamp(-yawSpeed * 0.12, -0.5, 0.5) + Math.sin(t * 1.9) * 0.04) * sway - p.hatZ) * (1 - Math.exp(-6 * dt));
      p.hatX += ((Math.sin(t * 1.4 + 1) * 0.05 - (p.y + p.hop) * 1.5) * sway - p.hatX) * (1 - Math.exp(-6 * dt));
      p.beardZ += (clamp(-yawSpeed * 0.07, -0.3, 0.3) * sway - p.beardZ) * (1 - Math.exp(-7 * dt));

      wizard.arrive += dt;
      wizard.nextBlink -= dt;
      if (wizard.nextBlink < 0) wizard.nextBlink = 2 + Math.random() * 3.5;
      p.blink = !settings.still && wizard.nextBlink < 0.13 ? Math.sin(wizard.nextBlink / 0.13 * Math.PI) : 0;
      orbGlow = p.glow;
    }

    // ---- The phone and what circles it ----
    const screenAt = new Float32Array(16);
    let screenShown = false;
    const PHONE = [2.35, 1.48, 0];
    const RINGS = [
      { r: 0.92, speed: 0.5, tiltX: 0.42, tiltZ: 0.2 },
      { r: 1.14, speed: -0.38, tiltX: -0.3, tiltZ: -0.28 },
      { r: 1.36, speed: 0.3, tiltX: 0.16, tiltZ: 0.5 },
    ];
    function tilePlace(tile, t) {
      const ring = RINGS[tile.ring];
      const a = tile.phase + t * ring.speed * (settings.still ? 0 : 1);
      const radius = ring.r + tile.drift;
      let x = Math.cos(a) * radius, y = 0, z = Math.sin(a) * radius * 0.8;
      let c = Math.cos(ring.tiltX), s = Math.sin(ring.tiltX);
      [y, z] = [y * c - z * s, y * s + z * c];
      c = Math.cos(ring.tiltZ);
      s = Math.sin(ring.tiltZ);
      [x, y] = [x * c - y * s, x * s + y * c];
      tile.x = PHONE[0] + x;
      tile.y = PHONE[1] + y + Math.sin(t * 1.3 + tile.phase * 3) * 0.03;
      tile.z = PHONE[2] + z;
    }
    function animateTiles(dt, t) {
      for (let i = scene.tiles.length - 1; i >= 0; i--) {
        const tile = scene.tiles[i];
        const age = t - tile.since;
        tilePlace(tile, t);
        const kept = tile.state === 'keep';
        tile.drift += ((kept ? 0.3 : 0) - tile.drift) * (1 - Math.exp(-6 * dt));
        let size = tile.size * (kept ? 0.7 : 1);
        if (tile.state === 'in') {
          const u = settings.still ? 1 : age / 0.55;
          const e = back(u);
          tile.x = mix(PHONE[0], tile.x, e);
          tile.y = mix(PHONE[1], tile.y, e);
          tile.z = mix(PHONE[2] + 0.2, tile.z, e);
          size *= ease(u);
          if (u >= 1) tile.state = tile.next || 'orbit';
        } else if (tile.state === 'zap' || tile.state === 'out') {
          const u = settings.still ? 1 : age / (tile.state === 'zap' ? 0.26 : 0.4);
          size *= Math.pow(1 - clamp(u, 0, 1), 2);
          tile.spin += dt * 22;
          if (u >= 1) { scene.tiles.splice(i, 1); continue; }
        } else if (tile.state === 'fail') {
          tile.x += Math.sin(t * 44) * 0.03 * Math.max(0, 1 - age / 0.6);
        }
        tile.shown = size;
      }
    }
    function drawTiles(t) {
      for (const tile of scene.tiles) {
        if (tile.shown <= 0.001) continue;
        const colour = tile.state === 'keep' ? KIND.keep : tile.state === 'fail' ? KIND.fail : (KIND[tile.kind] || KIND.remove);
        const aimed = tile.state === 'aim';
        push();
        T(tile.x, tile.y, tile.z);
        RY(tile.spin + t * 0.7 * (settings.still ? 0 : 1));
        RX(0.25);
        S(tile.shown, tile.shown, tile.shown);
        draw(res.m.tile, colour, {
          emit: aimed ? 0.25 + 0.2 * Math.sin(t * 12 + tile.phase) : 0.1,
          emitColor: aimed ? C.lime : colour, spec: 0.5, rim: 0.7,
        });
        pop();
      }
    }
    function drawPhone(t) {
      const shown = scene.phoneShown;
      if (shown < 0.01) return;
      const w = settings.still ? 0 : 1;
      push();
      T(PHONE[0], PHONE[1] + Math.sin(t * 1.1) * 0.06 * w, PHONE[2]);
      RY(-0.4 + Math.sin(t * 0.5) * 0.2 * w);
      RX(-0.05 + Math.sin(t * 0.8) * 0.04 * w);
      RZ(0.06);
      S(shown, shown, shown);
      draw(res.m.phone, C.phone, { spec: 0.6, rim: 1.1 });
      push(); T(0, 0, 0.062); RX(-Math.PI / 2); S(0.415, 1, 0.885); screenAt.set(STACK[top]); screenShown = true; pop();
      pop();
    }

    // ---- Sparks and lightning, in window pixels ----
    function spark(x, y, vx, vy, life, size, colour, shape = 0, pull = 0) {
      if (sparks.length >= 1300 || settings.still) return;
      sparks.push({ x, y, vx, vy, life, age: 0, size, r: colour[0], g: colour[1], b: colour[2], shape, pull });
    }
    // The colour of magic is the one accent the app has: charged lime, with
    // white heat. On a light page that lime would not show, so it is drawn in
    // the darker lime the page itself uses there, with ink for heat.
    const ink = dark => (dark || !settings.light ? [[0.749, 1, 0], [1, 1, 0.9], [0.86, 1, 0.45]] : [[0.36, 0.5, 0], [0.09, 0.09, 0.1], [0.42, 0.56, 0]]);
    function burst(x, y, { count = 26, power = 1, dark = false, colour = null } = {}) {
      const inks = ink(dark);
      for (let i = 0; i < count; i++) {
        const a = Math.random() * TAU, sp = (60 + Math.random() * 260) * power;
        spark(x, y, Math.cos(a) * sp, Math.sin(a) * sp - 40, 0.35 + Math.random() * 0.5, 5 + Math.random() * 9,
          colour && i % 3 === 0 ? colour : inks[i % inks.length], i % 4 === 0 ? 1 : 0, 0);
      }
      for (let i = 0; i < 4; i++) spark(x + (Math.random() - 0.5) * 16, y + (Math.random() - 0.5) * 16, 0, -12, 0.3, 46 * power, inks[0], 0, 0);
    }
    function bolt(x0, y0, x1, y1, { dark = false, width = 1, life = 0.24, steady = false } = {}) {
      if (settings.still) return;
      bolts.push({ x0, y0, x1, y1, age: 0, life, dark, width, steady, seed: Math.random() * 1000 });
    }
    // A cheap random number that comes out the same for the same seed, so a
    // bolt holds its shape for a few frames and then jumps.
    const rnd = s => { const v = Math.sin(s * 127.1) * 43758.5453; return v - Math.floor(v); };
    // Two vertices per point, one each side of the line; "v" runs from -1 to
    // 1 across it, which is what the shader shades by.
    function strip(pts, half, alpha, data, at) {
      let k = at;
      for (let i = 0; i < pts.length; i++) {
        const a = pts[Math.max(0, i - 1)], b = pts[Math.min(pts.length - 1, i + 1)];
        let nx = -(b[1] - a[1]), ny = b[0] - a[0];
        const l = Math.hypot(nx, ny) || 1;
        nx = nx / l * half;
        ny = ny / l * half;
        const fade = alpha * (i === 0 || i === pts.length - 1 ? 0.35 : 1);
        data[k++] = pts[i][0] - nx; data[k++] = pts[i][1] - ny; data[k++] = -1; data[k++] = fade;
        data[k++] = pts[i][0] + nx; data[k++] = pts[i][1] + ny; data[k++] = 1; data[k++] = fade;
      }
      return k;
    }
    function jagged(x0, y0, x1, y1, seed, amount) {
      let pts = [[x0, y0], [x1, y1]];
      let sway = Math.hypot(x1 - x0, y1 - y0) * amount;
      for (let level = 0; level < 5; level++) {
        const next = [pts[0]];
        for (let i = 0; i < pts.length - 1; i++) {
          const a = pts[i], b = pts[i + 1];
          const dx = b[0] - a[0], dy = b[1] - a[1];
          const l = Math.hypot(dx, dy) || 1;
          const off = (rnd(seed + level * 31.7 + i * 7.3) - 0.5) * sway;
          next.push([(a[0] + b[0]) / 2 - dy / l * off, (a[1] + b[1]) / 2 + dx / l * off], b);
        }
        pts = next;
        sway *= 0.52;
      }
      return pts;
    }
    function drawBolts(dt, winW, winH) {
      if (!bolts.length) return;
      const data = res.boltData;
      const runs = [];
      let k = 0;
      for (let i = bolts.length - 1; i >= 0; i--) {
        const b = bolts[i];
        b.age += dt;
        if (b.age > b.life) { bolts.splice(i, 1); continue; }
        if (k + 800 > data.length) continue;
        const fade = b.steady ? 0.5 + 0.25 * Math.sin(clock * 30) : Math.pow(1 - b.age / b.life, 1.5);
        // The same shape for a few frames, then another: that is the flicker.
        const seed = b.seed + Math.floor(clock * 24);
        const main = jagged(b.x0, b.y0, b.x1, b.y1, seed, b.steady ? 0.03 : 0.16);
        let from = k;
        k = strip(main, (b.steady ? 7 : 9) * b.width, fade, data, k);
        runs.push([from / 4, (k - from) / 4, b]);
        if (b.steady) continue;
        for (let n = 0; n < 2; n++) {
          const root = main[4 + Math.floor(rnd(seed + n * 3.3) * 20)];
          const a = Math.atan2(b.y1 - b.y0, b.x1 - b.x0) + (rnd(seed + n) - 0.5) * 1.6;
          const len = Math.hypot(b.x1 - b.x0, b.y1 - b.y0) * (0.14 + rnd(seed + n * 9.1) * 0.16);
          const fork = jagged(root[0], root[1], root[0] + Math.cos(a) * len, root[1] + Math.sin(a) * len, seed + n * 77, 0.2);
          from = k;
          k = strip(fork.filter((_, j) => j % 2 === 0), 5 * b.width, fade * 0.7, data, k);
          runs.push([from / 4, (k - from) / 4, b]);
        }
      }
      if (!k) return;
      gl.useProgram(res.bolt.prog);
      gl.uniform2f(res.bolt.u.uRes, winW, winH);
      gl.bindBuffer(gl.ARRAY_BUFFER, res.boltBuf);
      gl.bufferData(gl.ARRAY_BUFFER, data.subarray(0, k), gl.DYNAMIC_DRAW);
      for (let i = 0; i < 3; i++) gl.enableVertexAttribArray(i);
      gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 16, 0);
      gl.vertexAttribPointer(1, 1, gl.FLOAT, false, 16, 8);
      gl.vertexAttribPointer(2, 1, gl.FLOAT, false, 16, 12);
      for (const [first, count, b] of runs) {
        const onDark = b.dark || !settings.light;
        gl.uniform3fv(res.bolt.u.uColor, ink(b.dark)[0]);
        gl.uniform3fv(res.bolt.u.uCore, onDark ? C.white : C.dark);
        gl.uniform1f(res.bolt.u.uOver, onDark ? 0.25 : 1);
        gl.drawArrays(gl.TRIANGLE_STRIP, first, count);
      }
      gl.disableVertexAttribArray(2);
    }
    function drawSparks(dt, winW, winH) {
      const data = res.pointData;
      let k = 0;
      for (let i = sparks.length - 1; i >= 0; i--) {
        const s = sparks[i];
        s.age += dt;
        if (s.age >= s.life) { sparks.splice(i, 1); continue; }
        if (s.pull && scene.orbScreen) {
          s.vx += (scene.orbScreen.x - s.x) * s.pull * dt;
          s.vy += (scene.orbScreen.y - s.y) * s.pull * dt;
        } else {
          s.vy += 180 * dt;
        }
        const drag = Math.exp(-2.2 * dt);
        s.vx *= drag;
        s.vy *= drag;
        s.x += s.vx * dt;
        s.y += s.vy * dt;
        const u = s.age / s.life;
        data[k++] = s.x; data[k++] = s.y;
        data[k++] = Math.min(res.maxPoint / ratio, s.size * (s.shape ? 1 + 0.3 * Math.sin(s.age * 30) : 1 - u * 0.5));
        data[k++] = s.r; data[k++] = s.g; data[k++] = s.b;
        data[k++] = Math.min(1, (1 - u) * 1.6);
        data[k++] = s.shape;
      }
      if (!k) return;
      gl.useProgram(res.point.prog);
      gl.uniform2f(res.point.u.uRes, winW, winH);
      gl.uniform1f(res.point.u.uScale, ratio);
      gl.uniform1f(res.point.u.uOver, settings.light ? 0.9 : 0.3);
      gl.bindBuffer(gl.ARRAY_BUFFER, res.pointBuf);
      gl.bufferData(gl.ARRAY_BUFFER, data.subarray(0, k), gl.DYNAMIC_DRAW);
      for (let i = 0; i < 4; i++) gl.enableVertexAttribArray(i);
      gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 32, 0);
      gl.vertexAttribPointer(1, 1, gl.FLOAT, false, 32, 8);
      gl.vertexAttribPointer(2, 4, gl.FLOAT, false, 32, 12);
      gl.vertexAttribPointer(3, 1, gl.FLOAT, false, 32, 28);
      gl.drawArrays(gl.POINTS, 0, k / 8);
      gl.disableVertexAttribArray(2);
      gl.disableVertexAttribArray(3);
    }

    // ---- A frame ----
    // The stage to draw on: the wizard's own screen if it is open, else the
    // one on the overview, else the small one in the corner.
    function findStage() {
      for (const kind of ['full', 'hero', 'side']) {
        const node = document.querySelector(`[data-stage="${kind}"]`);
        if (!node) continue;
        const rect = node.getBoundingClientRect();
        if (rect.width < 24 || rect.height < 24) continue;
        if (rect.bottom < 0 || rect.top > innerHeight || rect.right < 0 || rect.left > innerWidth) continue;
        return { kind, node, rect };
      }
      return null;
    }
    const SHOTS = {
      // centre x, centre y, width and height of what must be seen, and
      // how many wizards deep the orb goes
      full: { box: [1.42, 1.56, 5.0, 3.75], nest: 2 },
      hero: { box: [1.42, 1.5, 4.85, 3.4], nest: 1 },
      side: { box: [0.2, 2.02, 1.55, 1.75], nest: 1 },
    };

    function drawScene(stage, t, dt, winW, winH) {
      const { rect, kind } = stage;
      const shot = SHOTS[kind];
      const style = getComputedStyle(stage.node);
      const radius = Math.min(parseFloat(style.borderTopLeftRadius) || 0, rect.width / 2, rect.height / 2);
      const into = (stage.node.dataset.into || '0.03 0.04 0.97 0.96').split(/\s+/).map(Number);

      const px = v => Math.round(v * ratio);
      const box = [px(rect.left), px(winH - rect.bottom), px(rect.width), px(rect.height)];
      gl.enable(gl.SCISSOR_TEST);
      gl.viewport(box[0], box[1], box[2], box[3]);
      gl.scissor(Math.max(0, box[0]), Math.max(0, box[1]), box[2], box[3]);

      // The sky first, behind everything. It is cut to the stage's rounded
      // shape, and marks that shape so that nothing after it can stray
      // outside: a glow near the edge of a round stage would otherwise show
      // as a square.
      gl.disable(gl.DEPTH_TEST);
      if (masked) {
        gl.enable(gl.STENCIL_TEST);
        gl.clearStencil(0);
        gl.clear(gl.STENCIL_BUFFER_BIT);
        gl.stencilFunc(gl.ALWAYS, 1, 0xff);
        gl.stencilOp(gl.KEEP, gl.KEEP, gl.REPLACE);
      }
      useQuad();
      quad(4, [look.stars, 0, 0, 0], [rect.width, rect.height, radius, 0], look.haze, true);
      if (masked) {
        gl.stencilFunc(gl.EQUAL, 1, 0xff);
        gl.stencilOp(gl.KEEP, gl.KEEP, gl.KEEP);
      }

      // Where the pointer is, measured from the middle of the stage, moves
      // the eye; when it has been still a while the eye drifts home.
      const moving = !settings.still && pointer.x >= 0 && performance.now() - pointer.at < 4000;
      const wantX = moving ? clamp((pointer.x - (rect.left + rect.width / 2)) / innerWidth, -0.5, 0.5) : 0;
      const wantY = moving ? clamp((pointer.y - (rect.top + rect.height / 2)) / innerHeight, -0.5, 0.5) : 0;
      const ease3 = settings.still ? 1 : 1 - Math.exp(-3 * dt);
      scene.swayX += (wantX - scene.swayX) * ease3;
      scene.swayY += (wantY - scene.swayY) * ease3;
      frame(rect, shot.box[0], shot.box[1], shot.box[2], shot.box[3], into);
      scene.phoneShown += ((kind === 'side' ? 0 : 1) - scene.phoneShown) * (settings.still ? 1 : 1 - Math.exp(-8 * dt));
      identity(STACK[0]);
      top = 0;

      // The floor: the circle under the phone, and the wizard's shadow.
      if (kind !== 'side') {
        push(); T(PHONE[0], 0.01, 0); S(1.5, 1, 1.5);
        quad(0, [scene.circle, scene.circle * 0.22, 0, 0], [0, 0, 0, 0], C.lime, false);
        pop();
        // A pool of light to stand in, the orb's own light on the floor,
        // and his shadow in both.
        push(); T(0.25, 0.008, 0.2); S(2.4, 1, 1.7); quad(3, [0.085, 0, 0, 0], [0, 0, 0, 0], look.floor, false); pop();
        push(); T(orbWorld[0], 0.009, orbWorld[2] * 0.6); S(1.4, 1, 1.1); quad(3, [0.05 + orbGlow * 0.05, 0, 0, 0], [0, 0, 0, 0], C.lime, false); pop();
        push(); T(0, 0.012, 0.05); S(1.05, 1, 0.8); quad(1, [0.55, 0, 0, 0], [0, 0, 0, 0], C.dark, false); pop();
      }

      gl.enable(gl.DEPTH_TEST);
      gl.depthMask(true);
      gl.clear(gl.DEPTH_BUFFER_BIT);
      late.length = 0;
      screenShown = false;
      useMesh();
      drawWizard(0, t, shot.nest);
      if (kind !== 'side') {
        drawPhone(t);
        drawTiles(t);
      }

      // What the phone shows.
      if (screenShown) {
        useQuad();
        STACK[1].set(screenAt);
        top = 1;
        const state = { none: 0, idle: 1, scan: 2, clean: 3, ask: 4 }[scene.phone] || 0;
        quad(2, [state, 0, scene.junk, 0], [0.415, 0.885, 0.1, 0], C.white, false);
        top = 0;
      }

      // Glass and glows last, and without hiding each other.
      gl.depthMask(false);
      useMesh();
      for (const item of late) paint(item.m, item.color, item.o, item.matrix);
      useQuad();
      glowAt(orbWorld[0], orbWorld[1], orbWorld[2], 0.55 + orbGlow * 0.22, C.lime, 0.32 + orbGlow * 0.22, 0.1);
      if (kind !== 'side' && scene.phone === 'clean') glowAt(PHONE[0], PHONE[1], PHONE[2] - 0.2, 2.1, C.lime, 0.3, 0.1);
      gl.depthMask(true);
      gl.disable(gl.DEPTH_TEST);
      gl.disable(gl.SCISSOR_TEST);
      if (masked) gl.disable(gl.STENCIL_TEST);

      scene.orbScreen = toScreen(rect, orbWorld[0], orbWorld[1], orbWorld[2]);
      scene.headScreen = toScreen(rect, 0, 1.85, 0.2);
      scene.phoneScreen = kind === 'side' ? null : toScreen(rect, PHONE[0], PHONE[1], PHONE[2]);
      for (const tile of scene.tiles) tile.screen = kind === 'side' ? null : toScreen(rect, tile.x, tile.y, tile.z);
    }

    // What the wizard gives off without being asked.
    function ambient(dt, stage) {
      const orb = scene.orbScreen;
      if (!orb || settings.still) return;
      const dark = true;
      const inks = ink(dark);
      const size = stage.kind === 'side' ? 0.5 : stage.kind === 'hero' ? 0.75 : 1.2;
      const name = wizard.once || wizard.base;
      if (Math.random() < dt * (name === 'channel' ? 0 : 5)) {
        spark(orb.x + (Math.random() - 0.5) * 14 * size, orb.y + (Math.random() - 0.5) * 14 * size,
          (Math.random() - 0.5) * 30, -30 - Math.random() * 40, 0.8 + Math.random() * 0.6, (4 + Math.random() * 5) * size, inks[Math.random() < 0.7 ? 0 : 1], Math.random() < 0.3 ? 1 : 0, 0);
      }
      if (name === 'channel') {
        // Drawn in from all around, faster as they near the orb.
        for (let i = 0; i < 3; i++) {
          const a = Math.random() * TAU, d = (70 + Math.random() * 70) * size;
          spark(orb.x + Math.cos(a) * d, orb.y + Math.sin(a) * d, -Math.sin(a) * 160, Math.cos(a) * 160, 0.55, (5 + Math.random() * 6) * size, inks[i % 3], i === 0 ? 1 : 0, 26);
        }
      }
      if (name === 'scan' && scene.phoneScreen && !bolts.some(b => b.steady)) {
        bolt(orb.x, orb.y, scene.phoneScreen.x, scene.phoneScreen.y, { dark: true, width: 0.8 * size, life: 0.12, steady: true });
      }
    }

    // The canvas covers the window, so on a large sharp screen it could run
    // to tens of millions of pixels, and several times that in memory. Past
    // about four million it is drawn a little softer instead.
    function resize() {
      const want = Math.min(window.devicePixelRatio || 1, cap, Math.sqrt(4e6 / Math.max(1, innerWidth * innerHeight)));
      const w = Math.max(1, Math.round(innerWidth * want)), h = Math.max(1, Math.round(innerHeight * want));
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
      }
      ratio = want;
    }

    function tick(now) {
      raf = requestAnimationFrame(tick);
      if (!res || !settings.enabled || document.hidden) { last = now; return; }
      // Every frame while anything is happening or the pointer is moving;
      // half as often at rest, which a breathing wizard and a slow orbit do
      // not show; and a few times a second when the window is not the one
      // in front, or when it has been asked to hold still.
      const busy = now < active || sparks.length > 0 || bolts.length > 0 || wizard.once || wizard.base !== 'idle' || document.querySelector('[data-stage="full"]');
      const gap = settings.still ? 240 : !document.hasFocus() ? 100 : busy ? 0 : 30;
      if (now - lastDrawn < gap) return;
      const dt = Math.min(settings.still ? 0.5 : 0.1, (now - (last || now)) / 1000);
      last = now;
      lastDrawn = now;
      clock += dt;

      // A machine that cannot keep up gets fewer pixels to fill.
      if (busy && dt > 0.034) slow += 1; else slow = Math.max(0, slow - 1);
      if (slow > 40 && cap > 0.75) { cap = Math.max(0.75, cap - 0.5); slow = 0; }
      resize();

      const stage = findStage();
      // Seen for the first time, or stepping onto his own screen: he arrives.
      if (stage && (!scene.visible || (stage.kind === 'full' && scene.stage !== 'full'))) wizard.arrive = 0;
      scene.visible = Boolean(stage);
      scene.stage = stage ? stage.kind : '';
      gl.viewport(0, 0, canvas.width, canvas.height);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);

      animateWizard(dt, clock);
      animateTiles(dt, clock);
      const target = scene.phone === 'scan' ? 1.5 : wizard.base === 'channel' ? 1.8 : scene.phone === 'clean' ? 1.0 : 0.55;
      scene.circle += (target - scene.circle) * (1 - Math.exp(-4 * dt));
      if (stage) {
        drawScene(stage, clock, dt, innerWidth, innerHeight);
        ambient(dt, stage);
      } else {
        scene.orbScreen = scene.headScreen = scene.phoneScreen = null;
        for (const tile of scene.tiles) tile.screen = null;
      }
      gl.viewport(0, 0, canvas.width, canvas.height);
      drawBolts(dt, innerWidth, innerHeight);
      drawSparks(dt, innerWidth, innerHeight);
    }

    function start() {
      try {
        res = build();
      } catch (e) {
        // Said once, where someone looking for the reason will find it.
        if (window.console) console.warn(`MAXAPACITY Debloat: the wizard could not start (${e.message})`);
        res = null;
        return false;
      }
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(tick);
      return true;
    }
    if (!start()) return null;

    canvas.addEventListener('webglcontextlost', event => { event.preventDefault(); res = null; });
    canvas.addEventListener('webglcontextrestored', () => { start(); });
    addEventListener('pointermove', event => {
      pointer.x = event.clientX;
      pointer.y = event.clientY;
      pointer.at = performance.now();
      active = performance.now() + 4000;
    }, { passive: true });
    document.addEventListener('pointerleave', () => { pointer.x = -1; });

    const wake = (ms = 3000) => { active = Math.max(active, performance.now() + ms); };
    const wait = ms => new Promise(resolve => setTimeout(resolve, settings.still ? 0 : ms));
    const centre = rect => ({ x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 });

    // ---- What the page can ask for ----
    return {
      // What the wizard is doing. Some acts play once and hand back.
      act(name) {
        if (!ACTS[name]) return;
        if (ONCE[name]) {
          wizard.once = name;
          wizard.onceSince = clock;
        } else if (wizard.base !== name) {
          wizard.base = name;
          wizard.baseSince = clock;
        } else {
          return;
        }
        wake();
      },
      shades(on) { wizard.shades = Boolean(on); wake(); },
      talking(on) { wizard.talk = on ? 1 : 0; if (on) wake(1500); },
      // A little turn on the spot, for being clicked.
      poke() {
        wake();
        if (!settings.still) wizard.poke = 0.7;
        if (scene.orbScreen) burst(scene.orbScreen.x, scene.orbScreen.y, { count: 18, power: 0.6, dark: true });
      },
      // The phone: 'none' while there is none, 'ask' while it is asking
      // whether to trust this computer, then 'idle', 'scan' or 'clean'.
      // "junk" is how much of its screen is still junk, 0 to 1.
      phone(state, junk = 0) {
        scene.phone = state;
        scene.junk = clamp(junk, 0, 0.6);
        wake();
      },
      // The apps circling the phone: [{ id, kind, state }]. Ones already
      // there stay where they are and take the state given ('orbit' if none:
      // see tile() below); new ones fly out of the phone.
      tiles(list) {
        wake();
        const shown = list.slice(0, 42);
        const want = new Map(shown.map(item => [item.id, item]));
        for (const tile of scene.tiles) {
          if (!want.has(tile.id) && tile.state !== 'zap' && tile.state !== 'out') { tile.state = 'out'; tile.since = clock; }
        }
        const have = new Map(scene.tiles.filter(tile => tile.state !== 'zap' && tile.state !== 'out').map(tile => [tile.id, tile]));
        const size = clamp(0.3 * Math.sqrt(10 / Math.max(10, shown.length)), 0.15, 0.3);
        shown.forEach((item, i) => {
          const state = item.state || 'orbit';
          const old = have.get(item.id);
          if (old) {
            old.kind = item.kind;
            old.size = size;
            if (old.state === 'in') old.next = state;
            else if (old.state !== state) { old.state = state; old.since = clock; }
            return;
          }
          const ring = shown.length <= 10 ? i % 2 : i % 3;
          scene.tiles.push({
            id: item.id, kind: item.kind, ring, phase: i * 2.399963 + ring, drift: 0, size, shown: 0,
            spin: i * 1.7, state: 'in', next: state, since: clock + (settings.still ? 0 : i * 0.07), x: 0, y: 0, z: 0, screen: null,
          });
        });
      },
      // 'orbit', 'keep' (unticked: it drifts out and cools), 'aim', 'fail'.
      tile(id, state) {
        const tile = scene.tiles.find(candidate => candidate.id === id && candidate.state !== 'zap' && candidate.state !== 'out');
        if (!tile) return;
        if (tile.state === 'in') tile.next = state;
        else { tile.state = state; tile.since = clock; }
        wake();
      },
      // Lightning from the orb to each of these apps in turn; each goes.
      async zapTiles(ids, pause = 150) {
        wake(ids.length * pause + 2000);
        for (const id of ids) {
          const tile = scene.tiles.find(candidate => candidate.id === id && candidate.state !== 'zap' && candidate.state !== 'out');
          if (!tile) continue;
          if (scene.orbScreen && tile.screen) {
            wizard.once = 'zap';
            wizard.onceSince = clock;
            bolt(scene.orbScreen.x, scene.orbScreen.y, tile.screen.x, tile.screen.y, { dark: true, width: scene.stage === 'full' ? 1 : 0.6 });
            burst(tile.screen.x, tile.screen.y, { dark: true, colour: KIND[tile.kind], power: scene.stage === 'full' ? 1 : 0.6 });
          }
          tile.state = 'zap';
          tile.since = clock;
          await wait(pause);
        }
        await wait(260);
      },
      // Lightning to places on the page: rows of a list, a button.
      async zapRects(rects, pause = 90) {
        wake(rects.length * pause + 2000);
        const from = scene.orbScreen;
        for (const rect of rects.slice(0, 14)) {
          const to = centre(rect);
          if (from) {
            wizard.once = 'zap';
            wizard.onceSince = clock;
            bolt(from.x, from.y, to.x, to.y, { width: 0.7 });
          }
          burst(to.x, to.y, { count: 24, power: 0.75 });
          for (let i = 0; i < 16; i++) {
            spark(rect.left + Math.random() * rect.width, rect.top + Math.random() * rect.height, (Math.random() - 0.5) * 60, -30 - Math.random() * 50,
              0.5 + Math.random() * 0.4, 5 + Math.random() * 6, ink(false)[i % 3], i % 3 === 0 ? 1 : 0, 0);
          }
          await wait(pause);
        }
      },
      burst(x, y, opts) { wake(); burst(x, y, opts); },
      // Everything goes off at once.
      celebrate() {
        wake(4000);
        const orb = scene.orbScreen;
        if (!orb) return;
        const inks = ink(true);
        for (let i = 0; i < 110; i++) {
          const a = -Math.PI / 2 + (Math.random() - 0.5) * 2.2, sp = 250 + Math.random() * 520;
          spark(orb.x, orb.y, Math.cos(a) * sp, Math.sin(a) * sp, 0.9 + Math.random() * 1.1, 5 + Math.random() * 10, inks[i % 3], i % 3 === 0 ? 1 : 0, 0);
        }
      },
      // Where the orb is in the window, or null when the wizard is not out.
      orb() { return scene.orbScreen; },
      visible() { return scene.visible; },
      set(changes) {
        if (changes.look) dress(changes.look);
        Object.assign(settings, changes);
        canvas.style.display = settings.enabled ? '' : 'none';
        if (!settings.enabled) { sparks.length = 0; bolts.length = 0; }
        wake();
      },
    };
  }

  window.DebloatMagic = { create };
})();
