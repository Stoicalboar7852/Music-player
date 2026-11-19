// Rainy Window: city lights, out of focus, through a pane of glass with rain
// running down it. Each light belongs to a band of the spectrum and glows
// with it; kicks swell them, the vocals warm their colour, the bassline sets
// how fast the drops run, hi-hats catch glints on the drops, and a drop
// brings a flash of lightning.

import { COLOR, COMMON_UNIFORMS, FS_HEADER, HASH, PALETTE, RHYTHM } from '../../gl/glsl';
import { drawFullscreen, FULLSCREEN_VS, Program } from '../../gl/util';
import { bindOutput, commonUniforms, defineVisualizer } from '../types';

const FS = /* glsl */ `${FS_HEADER}
in vec2 vUv; out vec4 o;
${COMMON_UNIFORMS}
${RHYTHM}
uniform float uRain;
uniform float uFlash;
${HASH}
${COLOR}
${PALETTE}

float spectrumAt(float x) { return texture(uSpectrum, vec2(clamp(x, 0.0, 1.0), 0.5)).r; }

// The lights beyond the glass, as discs of bokeh.
vec3 lights(vec2 uv) {
  vec3 col = mix(vec3(0.015, 0.015, 0.035), pal(0.6) * 0.07, uv.y);
  for (int i = 0; i < 3; i++) {
    float fi = float(i);
    vec2 g = uv * vec2(5.0 + 2.5 * fi, 3.4 + 1.7 * fi) + vec2(fi * 7.1, fi * 2.3);
    vec2 id = floor(g);
    vec2 f = fract(g) - 0.5;
    float h = hash21(id + fi * 13.0);
    // Fewer lights high up: most are down at street level.
    if (h < 0.45 + 0.35 * smoothstep(0.3, 0.9, (id.y + 0.5) / (3.4 + 1.7 * fi))) continue;
    vec2 c = (hash22(id + fi * 5.0) - 0.5) * 0.45;
    float band = hash21(id * 1.7 + fi);
    float level = spectrumAt(0.02 + band * 0.92);
    float rad = (0.16 + 0.12 * h) * (1.0 + 0.25 * pulse());
    float d = length(f - c);
    float disc = smoothstep(rad, rad * 0.55, d);
    float edge = smoothstep(rad, rad - 0.04, d) * smoothstep(rad - 0.1, rad - 0.04, d);
    vec3 lc = pal(h * 1.7 + 0.25 * colourDrive());
    lc = mix(lc, vec3(1.0, 0.75, 0.45), 0.25 + 0.35 * colourDrive());
    float strength = (0.05 + 1.1 * level + 0.35 * onBeat(0.3) * pulse()) * (0.7 - 0.15 * fi);
    col += lc * (disc * 0.6 + edge * 0.25) * strength;
  }
  return col;
}

void main() {
  float aspect = uRes.x / uRes.y;
  vec2 uv = vUv;
  vec2 p = vec2(uv.x * aspect, uv.y);
  vec2 offset = vec2(0.0);
  float wet = 0.0;
  float glint = 0.0;

  // Still drops beaded on the glass.
  vec2 g = p * vec2(22.0, 14.0);
  vec2 id = floor(g);
  vec2 f = fract(g) - 0.5;
  vec2 c = (hash22(id) - 0.5) * 0.6;
  float rr = 0.12 + 0.18 * hash21(id + 4.0);
  vec2 dv = (f - c) / rr;
  float inside = smoothstep(1.0, 0.85, dot(dv, dv)) * step(0.72, hash21(id + 9.0));
  offset += dv * inside * 0.02;
  wet = max(wet, inside);
  glint += inside * smoothstep(0.35, 0.0, length(dv - vec2(-0.35, 0.35)));

  // Drops running down, each leaving a trail of droplets.
  float column = floor(p.x * 9.0);
  float h = hash11(column);
  float x = (column + 0.5 + (h - 0.5) * 0.4) / 9.0 + 0.004 * sin(p.y * 40.0 + h * 9.0);
  float y = 1.15 - fract(uRain * (0.12 + 0.12 * h) + h) * 1.4;
  vec2 rd = vec2((p.x - x) * 9.0 / 0.7, (p.y - y) * 9.0 / 0.95);
  float runner = step(dot(rd, rd), 1.0);
  offset += rd * runner * 0.035;
  wet = max(wet, runner);
  glint += runner * smoothstep(0.4, 0.0, length(rd - vec2(-0.3, 0.4)));
  float trail = step(abs(p.x - x), 0.006) * step(y, p.y) * smoothstep(0.35, 0.0, p.y - y);
  float beads = step(0.6, hash21(vec2(column, floor(p.y * 60.0)))) * trail;
  wet = max(wet, beads * 0.7);
  offset += vec2(0.0, 0.008) * beads;

  // Beyond the glass: blurred where it's dry, sharper (and upside down) through the drops.
  vec3 col = lights(uv + offset);
  col = mix(col, col * 1.25 + 0.02, wet * 0.5);
  col += vec3(1.0) * glint * (0.12 + 0.9 * sparkle());
  // Condensation and lightning.
  col = mix(col, vec3(0.05, 0.06, 0.08), 0.12 * (1.0 - wet));
  col += vec3(0.75, 0.8, 1.0) * uFlash * (0.6 + 0.4 * hash11(floor(uTime * 30.0)));

  vec2 cc = vUv - 0.5;
  col *= 1.0 - 0.8 * dot(cc, cc);
  o = vec4(aces(col * 1.4), 1.0);
}`;

export default defineVisualizer({
  id: 'rain',
  name: 'Rainy Window',
  family: 'modern',
  order: 225,
  description: 'Out-of-focus city lights through a rainy pane: each light is a band of the spectrum, kicks swell them, drops bring lightning.',
  create(ctx) {
    const { gl } = ctx;
    const program = new Program(gl, FULLSCREEN_VS, FS);
    let rain = 0;
    let flash = 0;
    return {
      resize() {},
      render(frame) {
        const a = frame.audio;
        const dt = Math.min(frame.dt, 0.05);
        rain += dt * (0.6 + 1.6 * Math.max(a.bassline, a.bass * 0.5));
        flash = a.drop ? 1 : flash * Math.exp(-dt * 7);
        bindOutput(gl, frame);
        program.use().set({ ...commonUniforms(frame), uRain: rain, uFlash: flash });
        drawFullscreen(gl);
      },
      dispose() {
        program.dispose();
      },
    };
  },
});
