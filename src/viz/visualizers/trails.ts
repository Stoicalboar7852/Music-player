// Feedback trails: each frame the previous image is zoomed, twisted and
// hue-shifted, then the waveform is drawn on top. The picture is its own history.

import { WAVE_SIZE } from '../../audio/analysis';
import { COLOR, COMMON_UNIFORMS, FS_HEADER } from '../../gl/glsl';
import { bindTexture, drawFullscreen, FULLSCREEN_VS, PingPong, Program } from '../../gl/util';
import { bindOutput, commonUniforms, defineVisualizer, UNIT_WAVE } from '../types';

const FEEDBACK_FS = /* glsl */ `${FS_HEADER}
in vec2 vUv; out vec4 o;
uniform sampler2D uPrev;
uniform vec2 uRes;
uniform float uTime, uZoom, uTwist, uSwirl, uDecay, uHueShift, uWobble;
uniform vec4 uComets[5];      // xy = position, z = energy, w = hue
${COLOR}

vec3 hueRotate(vec3 c, float a) {
  const vec3 k = vec3(0.57735);
  float ca = cos(a), sa = sin(a);
  return c * ca + cross(k, c) * sa + k * dot(k, c) * (1.0 - ca);
}

void main() {
  float aspect = uRes.x / uRes.y;
  vec2 p0 = (vUv - 0.5) * vec2(aspect, 1.0);
  float r = length(p0);
  // Sampling closer to the centre makes the picture flow outward.
  float a = uTwist + uSwirl * (0.6 - r);
  float ca = cos(a), sa = sin(a);
  vec2 p = mat2(ca, -sa, sa, ca) * p0 * uZoom;
  p += uWobble * vec2(sin(p.y * 7.0 + uTime * 0.9), cos(p.x * 6.0 - uTime * 0.7));
  vec2 uv = p / vec2(aspect, 1.0) + 0.5;
  vec3 c = texture(uPrev, uv).rgb;
  c = hueRotate(c, uHueShift);
  // Nothing flows away from the exact centre, so let it fade faster there.
  c = max(c * uDecay * mix(0.90, 1.0, smoothstep(0.0, 0.22, r)) - 0.0025, 0.0);

  // Comets: one per frequency region, each dragging its own trail.
  for (int i = 0; i < 5; i++) {
    vec2 d = p0 - uComets[i].xy;
    float size = 0.012 + 0.02 * uComets[i].z;
    float glow = exp(-dot(d, d) / (size * size));
    c += hsv2rgb(vec3(uComets[i].w, 0.7, 1.0)) * glow * (0.10 + 0.9 * uComets[i].z);
  }
  o = vec4(c, 1.0);
}`;

// A ribbon around a circle whose radius follows the waveform.
const SHAPE_VS = /* glsl */ `#version 300 es
precision highp float;
uniform sampler2D uWave;
uniform vec2 uRes;
uniform float uRadius, uAmp, uWidth, uSpin, uChannel;
out float vEdge;
out float vT;

vec2 point(int i) {
  i = clamp(i, 0, ${WAVE_SIZE - 1});
  vec4 s = texelFetch(uWave, ivec2(i, 0), 0) * 2.0 - 1.0;
  float v = uChannel < 0.5 ? s.g : s.b;
  float t = float(i) / float(${WAVE_SIZE - 1});
  // Fade the displacement to zero at the seam so the loop closes.
  float seam = smoothstep(0.0, 0.04, t) * smoothstep(1.0, 0.96, t);
  float a = t * 6.2831853 + uSpin;
  return vec2(cos(a), sin(a)) * (uRadius + v * uAmp * seam) * uRes.y * 0.5;
}

void main() {
  int i = gl_VertexID >> 1;
  float side = float(gl_VertexID & 1) * 2.0 - 1.0;
  vec2 p = point(i);
  vec2 d = point(i + 1) - point(i - 1);
  vec2 n = vec2(-d.y, d.x) / max(length(d), 1e-4);
  vEdge = side;
  vT = float(i) / float(${WAVE_SIZE - 1});
  gl_Position = vec4((p + n * side * uWidth) / (uRes * 0.5), 0.0, 1.0);
}`;

const SHAPE_FS = /* glsl */ `${FS_HEADER}
in float vEdge; in float vT; out vec4 o;
uniform float uHue, uPower;
${COLOR}
void main() {
  float core = exp(-vEdge * vEdge * 3.5);
  vec3 c = hsv2rgb(vec3(uHue + vT * 0.35, 0.75, 1.0));
  o = vec4(c * core * uPower, 1.0);
}`;

const SHOW_FS = /* glsl */ `${FS_HEADER}
in vec2 vUv; out vec4 o;
${COMMON_UNIFORMS}
uniform sampler2D uImage;
void main() {
  vec3 c = texture(uImage, vUv).rgb;
  c = 1.0 - exp(-c * 1.35);                       // soft shoulder: bright trails keep their colour
  vec2 q = vUv - 0.5;
  c *= 1.0 - 0.9 * dot(q, q);
  o = vec4(c, 1.0);
}`;

export default defineVisualizer({
  id: 'trails',
  name: 'Feedback Trails',
  family: 'classic',
  order: 30,
  description: 'The waveform leaves swirling, colour-cycling trails as the image feeds back into itself.',
  create(ctx) {
    const { gl } = ctx;
    const feedback = new Program(gl, FULLSCREEN_VS, FEEDBACK_FS);
    const shape = new Program(gl, SHAPE_VS, SHAPE_FS);
    const show = new Program(gl, FULLSCREEN_VS, SHOW_FS);
    const buffer = new PingPong(gl, 2, 2, { format: ctx.hdr ? 'rgba16f' : 'rgba8' });
    const vao = gl.createVertexArray()!;
    let hue = 0;
    let spin = 0;
    let swirlDir = 1;
    let swirl = 0.03;
    const comets = new Float32Array(5 * 4);
    const cometPhase = [0, 1.3, 2.6, 3.9, 5.2];

    return {
      resize(width, height) {
        buffer.resize(width, height);
      },
      render(frame) {
        const a = frame.audio;
        const dt = frame.dt;
        const f = dt * 60; // amounts below are tuned per 60Hz frame

        if (a.beat && a.beatCount % 8 === 0) swirlDir = -swirlDir;
        swirl += (swirlDir * (0.012 + 0.05 * a.mid) - swirl) * Math.min(1, dt * 2.5);
        hue = (hue + dt * (0.05 + 0.18 * a.treble)) % 1;
        spin += dt * (0.25 + 1.4 * a.mid) * swirlDir;

        // Five comets orbit at different radii, lowest frequencies innermost.
        const sp = a.spectrum;
        for (let i = 0; i < 5; i++) {
          let energy = 0;
          const b0 = Math.floor((i / 5) * sp.length * 0.9);
          const b1 = Math.floor(((i + 1) / 5) * sp.length * 0.9);
          for (let b = b0; b < b1; b++) energy = Math.max(energy, sp[b]);
          cometPhase[i] += dt * (0.5 + 0.35 * i) * (i % 2 ? -1 : 1) * (1 + 1.5 * a.mid);
          const radius = 0.07 + 0.045 * i + 0.03 * Math.sin(frame.time * 0.7 + i);
          comets[i * 4] = Math.cos(cometPhase[i]) * radius;
          comets[i * 4 + 1] = Math.sin(cometPhase[i]) * radius;
          comets[i * 4 + 2] = energy * energy;
          comets[i * 4 + 3] = hue + 0.5 + i * 0.09;
        }

        // 1. Warp the previous frame into the write buffer and add the comets.
        buffer.write.bind();
        feedback.use().set({
          uPrev: 0,
          uRes: [frame.width, frame.height],
          uTime: frame.time,
          uZoom: 1 - (0.008 + 0.022 * a.bass + 0.05 * a.beatPulse) * f,
          uTwist: 0.004 * swirlDir * f,
          uSwirl: swirl * f,
          uDecay: Math.pow(0.968, f),
          uHueShift: (0.018 + 0.03 * a.treble) * f,
          uWobble: 0.0012 * (1 + 3 * a.midHit),
          uComets: comets,
        });
        bindTexture(gl, 0, buffer.read.tex);
        drawFullscreen(gl);

        // 2. Draw this frame's waveform on top: left and right as two rings.
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.ONE, gl.ONE);
        gl.bindVertexArray(vao);
        const width = Math.max(1.5, frame.height / 380);
        const power = (0.2 + 0.3 * a.level + 0.45 * a.beatPulse) * Math.min(2, f);
        shape.use().set({ uWave: UNIT_WAVE, uRes: [frame.width, frame.height] });
        shape.set({
          uChannel: 0,
          uRadius: 0.36 + 0.1 * a.bass + 0.08 * a.beatPulse,
          uAmp: 0.08 + 0.14 * a.level,
          uWidth: width * (1.1 + 1.2 * a.beatPulse),
          uSpin: spin,
          uHue: hue,
          uPower: power,
        });
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, WAVE_SIZE * 2);
        shape.set({
          uChannel: 1,
          uRadius: 0.3 + 0.1 * a.bass + 0.08 * a.beatPulse,
          uAmp: 0.06 + 0.12 * a.level,
          uWidth: width,
          uSpin: -spin * 0.7 + 1.7,
          uHue: hue + 0.33,
          uPower: power * 0.8,
        });
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, WAVE_SIZE * 2);
        gl.disable(gl.BLEND);
        buffer.swap();

        // 3. Present.
        bindOutput(gl, frame);
        show.use().set({ ...commonUniforms(frame), uImage: 0 });
        bindTexture(gl, 0, buffer.read.tex);
        drawFullscreen(gl);
      },
      dispose() {
        feedback.dispose();
        shape.dispose();
        show.dispose();
        buffer.dispose();
        gl.deleteVertexArray(vao);
      },
    };
  },
});
