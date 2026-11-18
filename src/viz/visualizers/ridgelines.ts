// Ridgelines: forty lines of recent sound stacked into a mountain range, the
// newest at the front. Each ridge hides the ones behind it. The bass sits in
// the middle of every line, the treble at its edges.

import { COMMON_UNIFORMS, FS_HEADER, HASH, PALETTE, RHYTHM } from '../../gl/glsl';
import { drawFullscreen, FULLSCREEN_VS, Program } from '../../gl/util';
import { bindOutput, commonUniforms, defineVisualizer } from '../types';

const LINES = 42;

const FS = /* glsl */ `${FS_HEADER}
in vec2 vUv; out vec4 o;
${COMMON_UNIFORMS}
${RHYTHM}
uniform sampler2D uHistory;
uniform float uHistHead;
${HASH}
${PALETTE}

const int LINES = ${LINES};

// Height of ridge j at horizontal position x (0..1): spectrum mirrored around the middle.
float ridge(int j, float x) {
  float f = abs(x - 0.5) * 2.0;                       // 0 in the middle (bass) .. 1 at the edges
  float row = uHistHead - float(j) * 0.0175;
  float v = texture(uHistory, vec2(0.01 + f * 0.86, row)).r;
  float shape = smoothstep(1.0, 0.25, f);             // tall in the middle, flat at the sides
  return v * v * shape * 0.24;
}

void main() {
  float aspect = uRes.x / uRes.y;
  vec2 p = vUv;
  float x = (p.x - 0.5) * aspect / 1.15 + 0.5;
  vec3 col = vec3(0.0);
  float px = 1.5 / uRes.y;
  bool done = false;
  for (int j = 0; j < LINES; j++) {
    if (done) break;
    // Nearest (newest) ridge at the bottom; older ones rise towards the top.
    float base = 0.12 + float(j) * 0.0185;
    float top = base + ridge(j, x) * (1.0 + 0.35 * lowDrive());
    if (p.y <= top + px * 2.0) {
      float d = abs(p.y - top);
      float line = smoothstep(px * (1.6 + 1.5 * pulse() * step(float(j), 1.0)), 0.0, d);
      float fade = 1.0 - float(j) / float(LINES);
      vec3 ink = mix(vec3(0.92, 0.94, 1.0), pal(0.15 + float(j) * 0.012 + 0.3 * colourDrive()), 0.35 + 0.5 * colourDrive());
      col = ink * line * (0.35 + 0.65 * fade) * (1.0 + 0.8 * pulse() * fade * fade);
      // Hi-hats glint on the tallest peaks.
      float peak = smoothstep(0.03, 0.12, top - base);
      col += vec3(1.0) * line * peak * sparkle() * step(0.6, hash21(vec2(float(j), floor(x * 60.0) + floor(uTime * 12.0))));
      done = true;
    }
  }
  // Night sky above the range.
  if (!done) col = mix(vec3(0.0), uPal[3] * 0.06, p.y);
  vec2 q = vUv - 0.5;
  col *= 1.0 - 0.4 * dot(q, q);
  o = vec4(col, 1.0);
}`;

export default defineVisualizer({
  id: 'ridgelines',
  name: 'Ridgelines',
  family: 'classic',
  order: 125,
  description: 'Recent sound stacked into a mountain range of glowing lines, newest at the front.',
  create(ctx) {
    const { gl } = ctx;
    const program = new Program(gl, FULLSCREEN_VS, FS);
    return {
      resize() {},
      render(frame) {
        bindOutput(gl, frame);
        program.use().set(commonUniforms(frame));
        drawFullscreen(gl);
      },
      dispose() {
        program.dispose();
      },
    };
  },
});
