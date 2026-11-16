// Classic LED spectrum analyser: segmented bars, falling peak caps and a
// mirrored floor reflection.

import { BANDS } from '../../audio/analysis';
import { COMMON_UNIFORMS, FS_HEADER } from '../../gl/glsl';
import { bindTexture, DataTexture, drawFullscreen, FULLSCREEN_VS, Program } from '../../gl/util';
import { bindOutput, commonUniforms, defineVisualizer } from '../types';

const MAX_BARS = 96;

const FS = /* glsl */ `${FS_HEADER}
in vec2 vUv; out vec4 o;
${COMMON_UNIFORMS}
uniform sampler2D uBars;   // R = bar height, G = peak cap height
uniform float uCount;

const float ROWS = 34.0;
const float BASE = 0.27;
const float TOP = 0.93;
const float LEFT = 0.055;
const float RIGHT = 0.945;

vec3 ledColor(float t) {
  // green -> yellow -> orange -> red, the way hardware meters were built
  vec3 g = vec3(0.10, 1.00, 0.35), y = vec3(1.0, 0.92, 0.12), r = vec3(1.0, 0.16, 0.12);
  return t < 0.62 ? mix(g, y, smoothstep(0.30, 0.62, t)) : mix(y, r, smoothstep(0.62, 0.92, t));
}

void main() {
  vec2 uv = vUv;
  // Backdrop: near-black with a pool of light on the floor that breathes with the beat.
  vec3 col = vec3(0.012, 0.014, 0.022);
  float floorGlow = exp(-abs(uv.y - BASE) * 9.0);
  col += vec3(0.05, 0.11, 0.16) * floorGlow * (0.35 + 1.4 * uBeat + 0.6 * uBass);
  col *= 1.0 - 0.55 * dot(uv - 0.5, uv - 0.5);

  float x = (uv.x - LEFT) / (RIGHT - LEFT);
  float yRaw = (uv.y - BASE) / (TOP - BASE);
  bool reflected = yRaw < 0.0;
  float y = reflected ? -yRaw * 1.7 : yRaw;

  if (x > 0.0 && x < 1.0 && y < 1.02) {
    float fi = x * uCount;
    float index = floor(fi);
    float fx = fract(fi);
    vec2 d = texture(uBars, vec2((index + 0.5) / float(${MAX_BARS}), 0.5)).rg;
    float px = uCount / ((RIGHT - LEFT) * uRes.x);          // one pixel in bar-space
    float barMask = smoothstep(0.11, 0.11 + px * 1.5, fx) * smoothstep(0.89, 0.89 - px * 1.5, fx);

    float fr = y * ROWS;
    float row = floor(fr);
    float fy = fract(fr);
    float py = ROWS / ((TOP - BASE) * uRes.y) * (reflected ? 1.7 : 1.0);
    float segMask = smoothstep(0.10, 0.10 + py * 1.5, fy) * smoothstep(0.80, 0.80 - py * 1.5, fy);
    float rowT = (row + 0.5) / ROWS;

    float level = d.r * ROWS;
    float lit = clamp(level - row, 0.0, 1.0);       // top segment fades in rather than popping
    float peakRow = floor(min(d.g, 0.999) * ROWS);
    float isPeak = step(abs(row - peakRow), 0.5) * step(0.02, d.g);

    vec3 led = ledColor(rowT);
    vec3 c = led * 0.045;                           // unlit segments stay faintly visible
    c += led * lit * (0.85 + 0.5 * uBeat);
    c = mix(c, vec3(0.86, 0.97, 1.0) * (1.1 + 0.9 * uBeat), isPeak);
    // soft halo above the column
    float halo = exp(-max(0.0, y - d.r) * 14.0) * d.r * 0.10;
    col += led * halo * (1.0 - barMask * segMask);

    float fade = reflected ? 0.42 * exp(-y * 4.0) : 1.0;
    col = mix(col, c, barMask * segMask * fade);
    col += c * barMask * segMask * fade * 0.25;      // slight self-illumination
  }

  // Floor line
  float line = smoothstep(0.004, 0.0, abs(uv.y - BASE));
  col += vec3(0.25, 0.55, 0.7) * line * (0.25 + 0.6 * uLevel);
  o = vec4(col, 1.0);
}`;

export default defineVisualizer({
  id: 'bars',
  name: 'Spectrum',
  family: 'classic',
  order: 10,
  description: 'LED spectrum bars with falling peak caps and a floor reflection.',
  create(ctx) {
    const { gl } = ctx;
    const program = new Program(gl, FULLSCREEN_VS, FS);
    const tex = new DataTexture(gl, { width: MAX_BARS, height: 1, channels: 2, filter: 'nearest' });
    const data = new Uint8Array(MAX_BARS * 2);
    const heights = new Float32Array(MAX_BARS);
    const peaks = new Float32Array(MAX_BARS);
    const peakVelocity = new Float32Array(MAX_BARS);
    const peakHold = new Float32Array(MAX_BARS);
    let count = 64;

    return {
      resize(width) {
        count = Math.max(32, Math.min(MAX_BARS, Math.round(width / 26)));
      },
      render(frame) {
        const { spectrum } = frame.audio;
        const dt = frame.dt;
        for (let i = 0; i < count; i++) {
          // Average the spectrum bands that fall inside this bar.
          const b0 = (i / count) * BANDS;
          const b1 = ((i + 1) / count) * BANDS;
          let sum = 0;
          let n = 0;
          for (let b = Math.floor(b0); b < Math.ceil(b1); b++) {
            sum += spectrum[Math.min(BANDS - 1, b)];
            n++;
          }
          const h = Math.min(1, (sum / n) * 1.04);
          heights[i] = h;

          // Peak cap: jumps up with the bar, hangs for a moment, then falls under gravity.
          if (h >= peaks[i]) {
            peaks[i] = h;
            peakVelocity[i] = 0;
            peakHold[i] = 0.32;
          } else if (peakHold[i] > 0) {
            peakHold[i] -= dt;
          } else {
            peakVelocity[i] += 2.6 * dt;
            peaks[i] = Math.max(h, peaks[i] - peakVelocity[i] * dt);
          }
          data[i * 2] = heights[i] * 255;
          data[i * 2 + 1] = Math.min(1, peaks[i] + 1 / 34) * 255;
        }
        tex.upload(data);

        bindOutput(gl, frame);
        program.use().set({ ...commonUniforms(frame), uBars: 0, uCount: count });
        bindTexture(gl, 0, tex.tex);
        drawFullscreen(gl);
      },
      dispose() {
        program.dispose();
        tex.dispose();
      },
    };
  },
});
