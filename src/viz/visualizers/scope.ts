// Oscilloscope: the waveform drawn as an electron beam on a phosphor screen.
// The beam is dimmer where it moves fast, and the phosphor keeps glowing for a
// moment after the beam has passed.

import { WAVE_SIZE } from '../../audio/analysis';
import { COMMON_UNIFORMS, FS_HEADER, RHYTHM } from '../../gl/glsl';
import { bindTexture, drawFullscreen, FULLSCREEN_VS, PingPong, Program } from '../../gl/util';
import { bindOutput, commonUniforms, defineVisualizer, UNIT_WAVE } from '../types';

const DECAY_FS = /* glsl */ `${FS_HEADER}
in vec2 vUv; out vec4 o;
uniform sampler2D uPrev; uniform float uDecay;
void main() {
  // The subtraction makes sure 8-bit targets actually reach black.
  o = vec4(max(texture(uPrev, vUv).rgb * uDecay - 0.004, 0.0), 1.0);
}`;

// Builds a ribbon along the waveform from gl_VertexID alone: two vertices per sample.
const BEAM_VS = /* glsl */ `#version 300 es
precision highp float;
uniform sampler2D uWave;
uniform vec2 uRes;
uniform float uGain;
uniform float uWidth;     // ribbon half-width in pixels
uniform float uChannel;   // 0 = mono, 1 = left, 2 = right
uniform float uOffset;    // vertical centre, in -1..1
out float vEdge;
out float vSpeed;

vec2 point(int i) {
  i = clamp(i, 0, ${WAVE_SIZE - 1});
  vec4 s = texelFetch(uWave, ivec2(i, 0), 0);
  float v = (uChannel < 0.5 ? s.r : uChannel < 1.5 ? s.g : s.b) * 2.0 - 1.0;
  float x = (float(i) / float(${WAVE_SIZE - 1})) * 2.0 - 1.0;
  return vec2(x * 0.94, uOffset + v * uGain) * uRes * 0.5;   // pixels from the centre
}

void main() {
  int i = gl_VertexID >> 1;
  float side = float(gl_VertexID & 1) * 2.0 - 1.0;
  vec2 p = point(i);
  vec2 d = point(i + 1) - point(i - 1);
  float len = max(length(d), 1e-4);
  vec2 n = vec2(-d.y, d.x) / len;
  vEdge = side;
  vSpeed = len * 0.5;                                   // pixels travelled per sample
  gl_Position = vec4((p + n * side * uWidth) / (uRes * 0.5), 0.0, 1.0);
}`;

const BEAM_FS = /* glsl */ `${FS_HEADER}
in float vEdge; in float vSpeed; out vec4 o;
uniform float uPower;
void main() {
  float core = exp(-vEdge * vEdge * 5.0);
  // A beam sweeping quickly deposits less energy per pixel.
  float energy = uPower / (1.0 + vSpeed * 0.16);
  o = vec4(vec3(core * energy), 1.0);
}`;

const SCREEN_FS = /* glsl */ `${FS_HEADER}
in vec2 vUv; out vec4 o;
${COMMON_UNIFORMS}
${RHYTHM}
uniform sampler2D uPhosphor;

void main() {
  // Slight barrel distortion, like a curved tube face.
  vec2 c = vUv - 0.5;
  vec2 uv = 0.5 + c * (1.0 + 0.07 * dot(c, c));
  float inside = step(0.0, uv.x) * step(uv.x, 1.0) * step(0.0, uv.y) * step(uv.y, 1.0);

  float e = texture(uPhosphor, uv).r;
  // Cheap glow: a few wider taps.
  vec2 px = 1.0 / uRes;
  float g = 0.0;
  for (int i = 0; i < 8; i++) {
    float a = float(i) * 0.7854;
    vec2 dir = vec2(cos(a), sin(a));
    g += texture(uPhosphor, uv + dir * px * 5.0).r + 0.6 * texture(uPhosphor, uv + dir * px * 13.0).r;
  }
  g /= 12.8;

  vec3 phosphor = vec3(0.16, 1.0, 0.42);
  vec3 col = phosphor * (e * 1.15 + g * 0.75);
  col += vec3(0.75, 1.0, 0.85) * smoothstep(0.75, 1.6, e);       // hot core burns toward white

  // Graticule: 10 x 8 divisions with tick marks on the centre lines.
  vec2 gridUv = (uv - 0.5) * vec2(10.0, 8.0);
  vec2 gd = abs(fract(gridUv + 0.5) - 0.5) / fwidth(gridUv);
  float grid = 1.0 - min(min(gd.x, gd.y), 1.0);
  vec2 td = abs(fract(gridUv * 5.0 + 0.5) - 0.5) / fwidth(gridUv * 5.0);
  float ticks = (1.0 - min(td.x, 1.0)) * step(abs(gridUv.y), 0.09) + (1.0 - min(td.y, 1.0)) * step(abs(gridUv.x), 0.09);
  col += vec3(0.10, 0.34, 0.24) * (grid * 0.8 + ticks * 0.9) * (0.7 + 0.6 * pulse());

  // Tube: faint green wash, scanlines, vignette.
  col += vec3(0.004, 0.02, 0.012) * (1.0 + 2.0 * uLevel);
  col *= 0.92 + 0.08 * sin(uv.y * uRes.y * 3.14159);
  col *= (1.0 - 1.5 * dot(c, c)) * inside;
  o = vec4(col, 1.0);
}`;

export default defineVisualizer({
  id: 'scope',
  name: 'Oscilloscope',
  family: 'classic',
  order: 20,
  description: 'The raw waveform as a glowing beam on a phosphor tube, left and right channels.',
  create(ctx) {
    const { gl } = ctx;
    const decay = new Program(gl, FULLSCREEN_VS, DECAY_FS);
    const beam = new Program(gl, BEAM_VS, BEAM_FS);
    const screen = new Program(gl, FULLSCREEN_VS, SCREEN_FS);
    const phosphor = new PingPong(gl, 2, 2, { format: ctx.hdr ? 'r16f' : 'rgba8' });
    const vao = gl.createVertexArray()!;

    return {
      resize(width, height) {
        phosphor.resize(width, height);
      },
      render(frame) {
        const a = frame.audio;
        const { width, height } = frame;

        // 1. Fade what is already on the screen.
        phosphor.write.bind();
        decay.use().set({ uPrev: 0, uDecay: Math.exp(-frame.dt / 0.075) });
        bindTexture(gl, 0, phosphor.read.tex);
        drawFullscreen(gl);

        // 2. Sweep the beam: left channel above, right channel below.
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.ONE, gl.ONE);
        gl.bindVertexArray(vao);
        const thickness = Math.max(2, height / 330) * (1 + 0.9 * Math.max(a.bassline, a.bass * 0.5) + 0.8 * Math.max(a.kick, a.beatPulse * 0.85));
        beam.use().set({
          uWave: UNIT_WAVE,
          uRes: [width, height],
          uGain: 0.34 + 0.1 * a.level,
          uWidth: thickness,
          uPower: 1.5 + 1.2 * Math.max(a.kick, a.beatPulse * 0.85) + 0.5 * Math.max(a.hat, a.trebleHit * 0.5),
        });
        beam.set({ uChannel: 1, uOffset: 0.46 });
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, WAVE_SIZE * 2);
        beam.set({ uChannel: 2, uOffset: -0.46 });
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, WAVE_SIZE * 2);
        gl.disable(gl.BLEND);
        phosphor.swap();

        // 3. Show the tube.
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
