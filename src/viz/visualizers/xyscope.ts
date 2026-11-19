// XY Scope: the classic vector display. The left channel drives the beam
// across and the right channel, a moment later, drives it up and down, so
// every tone draws its own figure: a kick a long sweep, a chord loops and
// knots, a hi-hat a fizzing cloud. The phosphor holds the trace for a moment;
// kicks fatten the beam and swell the figure, beats ring the graticule, and
// the vocals tint the trace.

import { WAVE_SIZE } from '../../audio/analysis';
import { COLOR, COMMON_UNIFORMS, FS_HEADER, RHYTHM } from '../../gl/glsl';
import { bindTexture, drawFullscreen, FULLSCREEN_VS, PingPong, Program } from '../../gl/util';
import { bindOutput, commonUniforms, defineVisualizer, UNIT_WAVE } from '../types';

const DELAY = 18;
const POINTS = WAVE_SIZE - DELAY;

const DECAY_FS = /* glsl */ `${FS_HEADER}
in vec2 vUv; out vec4 o;
uniform sampler2D uPrev; uniform float uDecay;
void main() { o = vec4(max(texture(uPrev, vUv).rgb * uDecay - 0.003, 0.0), 1.0); }`;

// A ribbon along the figure, two vertices per sample.
const BEAM_VS = /* glsl */ `#version 300 es
precision highp float;
uniform sampler2D uWave;
uniform vec2 uRes;
uniform float uGain;
uniform float uWidth;
uniform float uAngle;
out float vEdge;
out float vSpeed;
out float vT;

vec2 point(int i) {
  i = clamp(i, 0, ${POINTS - 1});
  float l = texelFetch(uWave, ivec2(i, 0), 0).g * 2.0 - 1.0;
  float r = texelFetch(uWave, ivec2(i + ${DELAY}, 0), 0).b * 2.0 - 1.0;
  vec2 v = vec2(l, r) * uGain;
  float c = cos(uAngle), s = sin(uAngle);
  v = mat2(c, -s, s, c) * v;
  return v * uRes.y * 0.5;
}

void main() {
  int i = gl_VertexID >> 1;
  float side = float(gl_VertexID & 1) * 2.0 - 1.0;
  vec2 p = point(i);
  vec2 d = point(i + 1) - point(i - 1);
  float len = max(length(d), 1e-4);
  vec2 n = vec2(-d.y, d.x) / len;
  vEdge = side;
  vSpeed = len * 0.5;
  vT = float(i) / float(${POINTS});
  gl_Position = vec4((p + n * side * uWidth) / (uRes * 0.5), 0.0, 1.0);
}`;

const BEAM_FS = /* glsl */ `${FS_HEADER}
in float vEdge; in float vSpeed; in float vT; out vec4 o;
uniform float uPower;
uniform vec3 uPal[4];
uniform float uTint;
vec3 palette(float t) {
  t = fract(t) * 4.0;
  int i = int(t);
  return mix(uPal[i & 3], uPal[(i + 1) & 3], smoothstep(0.0, 1.0, fract(t)));
}
void main() {
  float core = exp(-vEdge * vEdge * 4.0);
  float energy = uPower / (1.0 + vSpeed * 0.06);
  vec3 c = mix(vec3(0.35, 1.0, 0.75), palette(vT * 0.5 + uTint), 0.6);
  o = vec4(c * core * energy, 1.0);
}`;

const SCREEN_FS = /* glsl */ `${FS_HEADER}
in vec2 vUv; out vec4 o;
${COMMON_UNIFORMS}
${RHYTHM}
${COLOR}
uniform sampler2D uPhosphor;
void main() {
  vec2 px = 1.0 / uRes;
  vec3 e = texture(uPhosphor, vUv).rgb;
  vec3 g = vec3(0.0);
  for (int i = 0; i < 8; i++) {
    float a = float(i) * 0.785;
    vec2 dir = vec2(cos(a), sin(a));
    g += texture(uPhosphor, vUv + dir * px * 4.0).rgb + 0.6 * texture(uPhosphor, vUv + dir * px * 11.0).rgb;
  }
  vec3 col = e * 1.1 + g / 12.8 * 0.8;
  col += vec3(1.0) * smoothstep(0.9, 2.0, luma(e)) * 0.5;

  // A polar graticule; a beat sends a ring out across it.
  vec2 p = (gl_FragCoord.xy - 0.5 * uRes) / uRes.y;
  float r = length(p);
  float rings = smoothstep(0.003, 0.0, abs(fract(r * 6.0 + 0.5) - 0.5) / 6.0) * step(r, 0.5);
  float a = atan(p.y, p.x);
  float spokes = smoothstep(0.004, 0.0, abs(sin(a * 4.0)) * r) * step(r, 0.5);
  col += vec3(0.08, 0.2, 0.16) * (rings + spokes * 0.7) * (0.6 + 0.6 * pulse());
  float wave = smoothstep(0.012, 0.0, abs(r - 0.04 - (1.0 - onBeat(1.0)) * 0.5)) * onBeat(0.6);
  col += vec3(0.2, 0.8, 0.6) * wave * 0.8;

  col *= 1.0 - 0.9 * dot(vUv - 0.5, vUv - 0.5);
  o = vec4(aces(col), 1.0);
}`;

export default defineVisualizer({
  id: 'xyscope',
  name: 'XY Scope',
  family: 'classic',
  order: 200,
  description: 'A vector display: left and right channels draw the beam across and up, so every sound traces its own figure.',
  create(ctx) {
    const { gl } = ctx;
    const decay = new Program(gl, FULLSCREEN_VS, DECAY_FS);
    const beam = new Program(gl, BEAM_VS, BEAM_FS);
    const screen = new Program(gl, FULLSCREEN_VS, SCREEN_FS);
    const phosphor = new PingPong(gl, 2, 2, { format: ctx.hdr ? 'rgba16f' : 'rgba8' });
    const vao = gl.createVertexArray()!;
    let angle = 0;
    let swell = 0;
    return {
      resize(width, height) {
        phosphor.resize(width, height);
      },
      render(frame) {
        const a = frame.audio;
        const { width, height } = frame;
        const dt = Math.min(frame.dt, 0.05);
        const hit = Math.max(a.kick, a.beatPulse * 0.85);
        angle += dt * (0.08 + 0.3 * Math.max(a.bassline, a.bass * 0.5));
        swell = Math.max(swell * Math.exp(-dt * 6), hit);

        phosphor.write.bind();
        decay.use().set({ uPrev: 0, uDecay: Math.exp(-dt / 0.11) });
        bindTexture(gl, 0, phosphor.read.tex);
        drawFullscreen(gl);

        gl.enable(gl.BLEND);
        gl.blendFunc(gl.ONE, gl.ONE);
        gl.bindVertexArray(vao);
        beam.use().set({
          uWave: UNIT_WAVE,
          uRes: [width, height],
          uGain: 0.8 * (1 + 0.2 * swell),
          uWidth: Math.max(1.5, height / 420) * (1 + 1.2 * hit),
          uAngle: angle - Math.PI / 4,
          uPower: 0.55 + 0.6 * hit + 0.4 * Math.max(a.hat, a.trebleHit * 0.5),
          uPal: frame.palette,
          uTint: a.vocals * 0.6,
        });
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, POINTS * 2);
        gl.disable(gl.BLEND);
        gl.bindVertexArray(null);
        phosphor.swap();

        bindOutput(gl, frame);
        screen.use().set({ ...commonUniforms(frame), uPhosphor: 0 });
        bindTexture(gl, 0, phosphor.read.tex);
        drawFullscreen(gl);
      },
      dispose() {
        decay.dispose();
        beam.dispose();
        screen.dispose();
        phosphor.dispose();
        gl.deleteVertexArray(vao);
      },
    };
  },
});
