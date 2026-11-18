// Spectrogram: the classic scrolling waterfall. Time runs right to left,
// pitch bottom to top; loudness is heat. Kicks light the newest column,
// hi-hats glint in the top octaves, and every beat leaves a grid line that
// scrolls away with the sound (brighter on the first beat of a bar), like
// the bar lines in a music editor.

import { COMMON_UNIFORMS, FS_HEADER, HASH, PALETTE, RHYTHM } from '../../gl/glsl';
import { drawFullscreen, FULLSCREEN_VS, Program } from '../../gl/util';
import { bindOutput, commonUniforms, defineVisualizer, HISTORY_ROWS } from '../types';

const FS = /* glsl */ `${FS_HEADER}
in vec2 vUv; out vec4 o;
${COMMON_UNIFORMS}
${RHYTHM}
uniform sampler2D uHistory;
uniform float uHistHead;
uniform float uBeatRows[16];   // history position of recent beats (negative = none)
uniform float uBeatBar[16];    // 1 for the first beat of a bar
${HASH}
${PALETTE}

const float SPAN = 0.98;

vec3 heat(float v) {
  // Dark -> artwork colours -> white, shifted by the vocals.
  float s = colourDrive() * 0.25;
  vec3 c = mix(vec3(0.0), uPal[0] * 0.55, smoothstep(0.02, 0.22, v));
  c = mix(c, pal(0.25 + s), smoothstep(0.18, 0.5, v));
  c = mix(c, pal(0.6 + s), smoothstep(0.45, 0.8, v));
  c = mix(c, vec3(1.0, 0.97, 0.92), smoothstep(0.82, 1.0, v));
  return c;
}

void main() {
  vec2 uv = vUv;
  // A soft curve: pitch on y, time on x (newest at the right edge).
  float age = 1.0 - uv.x;
  float row = uHistHead - age * SPAN;
  float v = texture(uHistory, vec2(0.004 + uv.y * 0.992, row)).r;
  v = pow(v, 1.15);
  vec3 col = heat(v) * (0.85 + 0.6 * v);

  // Octave lines and a faint time grid that scrolls with the sound.
  float oct = abs(fract(uv.y * 9.0) - 0.5);
  col += vec3(0.08, 0.1, 0.13) * smoothstep(0.495, 0.5, oct) * 0.6;
  float rows = row * ${HISTORY_ROWS}.0 / 30.0;
  col += vec3(0.05, 0.06, 0.08) * smoothstep(0.48, 0.5, abs(fract(rows) - 0.5));

  // The newest column flares with kicks and the bass.
  float edge = smoothstep(0.9, 1.0, uv.x);
  col += pal(0.1) * edge * (0.25 * lowDrive() + 0.9 * pulse()) * (1.0 - uv.y * 0.7);
  // Hi-hats glint in the top octaves, on bright pixels.
  float glint = step(0.985, hash21(floor(gl_FragCoord.xy / 2.0) + floor(uTime * 24.0))) * smoothstep(0.55, 0.9, uv.y);
  col += vec3(1.0) * glint * sparkle() * (0.4 + v);

  // The beat ticks along the bottom edge.
  float tick = smoothstep(0.012, 0.0, uv.y) * onBeat(0.25);
  col += pal(0.5) * tick * 1.5;

  // Beat lines scroll left with the waterfall; bar lines are brighter and
  // carry a marker along the bottom.
  float px = 1.0 / uRes.x;
  for (int i = 0; i < 16; i++) {
    if (uBeatRows[i] < 0.0) continue;
    float x = 1.0 - fract(uHistHead - uBeatRows[i] + 1.0) / SPAN;
    float line = smoothstep(1.6 * px, 0.0, abs(uv.x - x));
    float bar = uBeatBar[i];
    col += mix(vec3(0.16, 0.18, 0.24), pal(0.55) * 0.55, bar) * line * (0.55 + 0.45 * bar);
    col += pal(0.55) * smoothstep(4.0 * px, 0.0, abs(uv.x - x)) * smoothstep(0.045, 0.0, uv.y) * (0.5 + bar);
  }

  vec2 q = uv - 0.5;
  col *= 1.0 - 0.35 * dot(q, q);
  o = vec4(col / (1.0 + 0.15 * col), 1.0);
}`;

export default defineVisualizer({
  id: 'spectrogram',
  name: 'Spectrogram',
  family: 'classic',
  order: 120,
  description: 'The scrolling waterfall: pitch up the screen, time across it, loudness as heat.',
  create(ctx) {
    const { gl } = ctx;
    const program = new Program(gl, FULLSCREEN_VS, FS);
    const rows = new Float32Array(16).fill(-1);
    const bars = new Float32Array(16);
    let next = 0;
    return {
      resize() {},
      render(frame) {
        const a = frame.audio;
        if (a.beat) {
          rows[next] = frame.historyHead;
          bars[next] = a.downbeat ? 1 : 0;
          next = (next + 1) % 16;
        }
        // Lines that have scrolled off the left edge are retired.
        for (let i = 0; i < 16; i++) {
          if (rows[i] >= 0 && (frame.historyHead - rows[i] + 1) % 1 > 0.98) rows[i] = -1;
        }
        bindOutput(gl, frame);
        program.use().set({ ...commonUniforms(frame), uBeatRows: rows, uBeatBar: bars });
        drawFullscreen(gl);
      },
      dispose() {
        program.dispose();
      },
    };
  },
});
