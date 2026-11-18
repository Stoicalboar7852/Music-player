// Particle Field: a couple of hundred thousand GPU particles (transform
// feedback) that assemble into a shape, get blown apart by the beat and pull
// themselves back together. The shape changes every 16 beats.

import { BloomScene } from '../../gl/bloom';
import { FS_HEADER } from '../../gl/glsl';
import { lookAt, multiply, perspective } from '../../gl/mat4';
import { Program } from '../../gl/util';
import { defineVisualizer } from '../types';

const SHAPES = 5;

const UPDATE_VS = /* glsl */ `#version 300 es
precision highp float;
layout(location = 0) in vec4 aPos;      // xyz position, w = brightness flicker phase
layout(location = 1) in vec4 aVel;      // xyz velocity, w = seed 0..1
out vec4 vPos;
out vec4 vVel;
uniform float uDt, uTime, uBass, uMid, uTreble, uKick, uShapeA, uShapeB, uMorph;

const float TAU = 6.2831853;

float hash(float n) { return fract(sin(n * 127.1) * 43758.5453); }

// Where particle (u, v) belongs on shape s.
vec3 shape(float s, float u, float v, float w) {
  if (s < 0.5) {                       // sphere
    float phi = u * TAU, ct = v * 2.0 - 1.0, st = sqrt(1.0 - ct * ct);
    return vec3(st * cos(phi), ct, st * sin(phi)) * 1.25;
  } else if (s < 1.5) {                // torus
    float a = u * TAU, b = v * TAU;
    return vec3((1.15 + 0.42 * cos(b)) * cos(a), 0.42 * sin(b), (1.15 + 0.42 * cos(b)) * sin(a));
  } else if (s < 2.5) {                // trefoil knot tube
    float t = u * TAU;
    vec3 c = vec3(sin(t) + 2.0 * sin(2.0 * t), cos(t) - 2.0 * cos(2.0 * t), -sin(3.0 * t)) * 0.42;
    float b = v * TAU;
    vec3 n = normalize(vec3(cos(t * 3.0), sin(t * 2.0), cos(t)));
    vec3 bn = normalize(cross(n, vec3(0.3, 1.0, 0.2)));
    return (c + (n * cos(b) + bn * sin(b)) * (0.10 + 0.10 * w)) * 1.15;
  } else if (s < 3.5) {                // spiral galaxy
    float rad = pow(v, 0.6) * 1.9;
    float a = u * TAU + rad * 2.4 + floor(u * 3.0) * TAU / 3.0;
    float arm = (hash(u * 91.0) - 0.5) * 0.5 * rad;
    return vec3(cos(a + arm) * rad, (w - 0.5) * 0.28 * exp(-rad * 1.1), sin(a + arm) * rad);
  }
  // rippling sheet
  vec2 g = vec2(u, v) * 2.0 - 1.0;
  return vec3(g.x * 1.9, 0.25 * sin(g.x * 5.0 + uTime) * cos(g.y * 4.0 - uTime * 0.7), g.y * 1.9);
}

vec3 flow(vec3 p, float t) {
  vec3 q = p * 1.3 + vec3(0.0, t * 0.13, 0.0);
  vec3 v = vec3(sin(q.y) + cos(q.z), sin(q.z) + cos(q.x), sin(q.x) + cos(q.y));
  q = p * 3.1 + 7.0 - t * 0.21;
  return v + 0.5 * vec3(sin(q.y) + cos(q.z), sin(q.z) + cos(q.x), sin(q.x) + cos(q.y));
}

void main() {
  vec3 p = aPos.xyz;
  vec3 v = aVel.xyz;
  float seed = aVel.w;
  float u = hash(seed * 3.7 + 0.1), w = hash(seed * 9.1 + 0.7), vv = hash(seed * 5.3 + 0.3);

  vec3 home = mix(shape(uShapeA, u, vv, w), shape(uShapeB, u, vv, w), uMorph);
  home *= 1.0 + 0.16 * uBass;

  vec3 force = (home - p) * (10.0 + 8.0 * w);                // spring back to the shape
  force += flow(p, uTime) * (0.2 + 1.9 * uMid);              // mids stir the field
  v += force * uDt;
  // The beat throws everything outward; lighter particles fly farther.
  vec3 away = normalize(p + 1e-4 * vec3(u - 0.5, vv - 0.5, w - 0.5));
  v += away * uKick * (0.5 + 2.4 * w * w * w);
  v *= exp(-uDt * (3.2 + 1.5 * w));
  p += v * uDt;

  vPos = vec4(p, aPos.w);
  vVel = vec4(v, seed);
}`;

const UPDATE_FS = /* glsl */ `${FS_HEADER}
out vec4 o;
void main() { o = vec4(0.0); }`;

const DRAW_VS = /* glsl */ `#version 300 es
precision highp float;
layout(location = 0) in vec4 aPos;
layout(location = 1) in vec4 aVel;
uniform mat4 uViewProj;
uniform vec3 uPal[4];
uniform float uPointScale, uTime, uTreble, uTrebleHit, uBeat, uFocus, uExposure;
out vec3 vColor;

float hash(float n) { return fract(sin(n * 127.1) * 43758.5453); }

vec3 pal(float t) {
  t = fract(t) * 4.0;
  int i = int(t);
  return mix(uPal[i & 3], uPal[(i + 1) & 3], smoothstep(0.0, 1.0, fract(t)));
}

void main() {
  float seed = aVel.w;
  vec4 clip = uViewProj * vec4(aPos.xyz, 1.0);
  gl_Position = clip;
  float speed = length(aVel.xyz);

  // Depth of field: out-of-focus particles get bigger and proportionally dimmer.
  float blur = 1.0 + 3.0 * abs(clip.w - uFocus) / uFocus;
  float size = uPointScale * (0.6 + 0.8 * hash(seed * 2.3)) * blur / max(clip.w, 0.1);
  gl_PointSize = clamp(size, 1.0, 48.0);

  // A fraction of the particles are "glitter" that flashes with the treble.
  float glitter = step(0.88, hash(seed * 7.7));
  float flash = glitter * (uTreble * (0.5 + 0.5 * sin(uTime * 22.0 + seed * 400.0)) + uTrebleHit) * 4.0;

  vec3 c = pal(hash(seed * 3.7 + 0.1) * 0.55 + speed * 0.07 + uTime * 0.01);
  c = mix(c, vec3(1.0), min(0.75, speed * 0.1 + flash * 0.2));
  float energy = (0.5 + 0.35 * uBeat + flash + speed * 0.3) / (blur * blur);
  // Keep total light roughly constant when the point is clamped to one pixel.
  energy *= min(1.0, size * size);
  vColor = c * energy * uExposure;
}`;

const DRAW_FS = /* glsl */ `${FS_HEADER}
in vec3 vColor; out vec4 o;
void main() {
  vec2 d = gl_PointCoord * 2.0 - 1.0;
  float r2 = dot(d, d);
  if (r2 > 1.0) discard;
  o = vec4(vColor * exp(-r2 * 3.0), 1.0);
}`;

export default defineVisualizer({
  id: 'particles',
  name: 'Particle Field',
  family: 'modern',
  order: 70,
  description: 'GPU particles that form shapes, scatter on the beat and reassemble.',
  create(ctx) {
    const { gl } = ctx;
    const count = Math.round(50000 + 190000 * ctx.quality);
    const update = new Program(gl, UPDATE_VS, UPDATE_FS, { feedback: ['vPos', 'vVel'] });
    const draw = new Program(gl, DRAW_VS, DRAW_FS);
    const scene = new BloomScene(gl, ctx.hdr);

    const pos = new Float32Array(count * 4);
    const vel = new Float32Array(count * 4);
    for (let i = 0; i < count; i++) {
      // Start as a loose cloud; the springs pull it into the first shape.
      const a = ctx.random() * Math.PI * 2;
      const z = ctx.random() * 2 - 1;
      const r = 2.5 * Math.cbrt(ctx.random());
      const s = Math.sqrt(1 - z * z);
      pos[i * 4] = Math.cos(a) * s * r;
      pos[i * 4 + 1] = z * r;
      pos[i * 4 + 2] = Math.sin(a) * s * r;
      pos[i * 4 + 3] = ctx.random();
      vel[i * 4 + 3] = (i + 0.5) / count;
    }

    // Two copies of the state; each frame reads one and writes the other.
    const buffers = [0, 1].map(() => {
      const p = gl.createBuffer()!;
      gl.bindBuffer(gl.ARRAY_BUFFER, p);
      gl.bufferData(gl.ARRAY_BUFFER, pos, gl.DYNAMIC_COPY);
      const v = gl.createBuffer()!;
      gl.bindBuffer(gl.ARRAY_BUFFER, v);
      gl.bufferData(gl.ARRAY_BUFFER, vel, gl.DYNAMIC_COPY);
      const vao = gl.createVertexArray()!;
      gl.bindVertexArray(vao);
      gl.bindBuffer(gl.ARRAY_BUFFER, p);
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 4, gl.FLOAT, false, 0, 0);
      gl.bindBuffer(gl.ARRAY_BUFFER, v);
      gl.enableVertexAttribArray(1);
      gl.vertexAttribPointer(1, 4, gl.FLOAT, false, 0, 0);
      gl.bindVertexArray(null);
      const tf = gl.createTransformFeedback()!;
      gl.bindTransformFeedback(gl.TRANSFORM_FEEDBACK, tf);
      gl.bindBufferBase(gl.TRANSFORM_FEEDBACK_BUFFER, 0, p);
      gl.bindBufferBase(gl.TRANSFORM_FEEDBACK_BUFFER, 1, v);
      gl.bindTransformFeedback(gl.TRANSFORM_FEEDBACK, null);
      return { p, v, vao, tf };
    });
    gl.bindBuffer(gl.ARRAY_BUFFER, null);

    let read = 0;
    // Start on the knot: it shows off depth better than a plain sphere.
    let shapeA = 2;
    let shapeB = 2;
    let morph = 1;
    let orbit = 0;
    const proj = new Float32Array(16);
    const view = new Float32Array(16);
    const viewProj = new Float32Array(16);

    return {
      resize(width, height) {
        scene.resize(width, height);
      },
      render(frame) {
        const a = frame.audio;
        const dt = Math.min(frame.dt, 1 / 24);

        // A new shape on a drop, or every 32 beats when there are none.
        if ((a.drop || (a.beat && a.beatCount % 32 === 0)) && morph >= 1) {
          shapeA = shapeB;
          shapeB = (shapeB + 1) % SHAPES;
          morph = 0;
        }
        morph = Math.min(1, morph + dt / 2.2);
        const eased = morph * morph * (3 - 2 * morph);

        // ---- simulate
        const src = buffers[read];
        const dst = buffers[1 - read];
        update.use().set({
          uDt: dt,
          uTime: frame.time,
          uBass: Math.max(a.bassline, a.bass * 0.5),
          uMid: a.mid * 0.5 + a.vocals * 0.6,
          uTreble: a.treble,
          uKick: a.kickHit || a.beat ? 1 : 0,
          uShapeA: shapeA,
          uShapeB: shapeB,
          uMorph: eased,
        });
        gl.enable(gl.RASTERIZER_DISCARD);
        gl.bindVertexArray(src.vao);
        gl.bindTransformFeedback(gl.TRANSFORM_FEEDBACK, dst.tf);
        gl.beginTransformFeedback(gl.POINTS);
        gl.drawArrays(gl.POINTS, 0, count);
        gl.endTransformFeedback();
        gl.bindTransformFeedback(gl.TRANSFORM_FEEDBACK, null);
        gl.disable(gl.RASTERIZER_DISCARD);
        read = 1 - read;

        // ---- draw
        orbit += dt * (0.12 + 0.3 * a.mid + 0.3 * a.vocals);
        const dist = 3.5 - 0.3 * Math.max(a.bassline, a.bass * 0.5);
        const eye: [number, number, number] = [
          Math.sin(orbit) * dist,
          0.9 + 0.5 * Math.sin(frame.time * 0.19),
          Math.cos(orbit) * dist,
        ];
        perspective(0.95, scene.width / scene.height, 0.1, 40, proj);
        lookAt(eye, [0, 0, 0], [0, 1, 0], view);
        multiply(proj, view, viewProj);

        scene.begin();
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.ONE, gl.ONE);
        draw.use().set({
          uViewProj: viewProj,
          uPal: frame.palette,
          uPointScale: scene.height * 0.011,
          uTime: frame.time,
          uTreble: a.treble,
          uTrebleHit: Math.max(a.hat, a.trebleHit * 0.5),
          uBeat: Math.max(a.kick, a.beatPulse * 0.85),
          uFocus: dist,
          // Fewer particles each carry more light, so the look holds across quality levels.
          uExposure: (0.55 * 240000) / count,
        });
        gl.bindVertexArray(buffers[read].vao);
        gl.drawArrays(gl.POINTS, 0, count);
        gl.bindVertexArray(null);
        gl.disable(gl.BLEND);

        scene.end(frame, { threshold: 0.45, knee: 0.4, intensity: 0.8, vignette: 0.45, exposure: 1.0 });
      },
      dispose() {
        update.dispose();
        draw.dispose();
        scene.dispose();
        for (const b of buffers) {
          gl.deleteBuffer(b.p);
          gl.deleteBuffer(b.v);
          gl.deleteVertexArray(b.vao);
          gl.deleteTransformFeedback(b.tf);
        }
      },
    };
  },
});
