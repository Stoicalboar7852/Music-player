// Aurora: curtains of light over dark mountains and a still lake. The
// curtains are the spectrum laid out left to right, rippling with the
// bassline; kicks flare their lower edges and the beat runs a bright seam
// along them; the vocals deepen their colour; hi-hats make the stars twinkle.
// Each drop rearranges the sky.

import { COLOR, COMMON_UNIFORMS, FS_HEADER, HASH, NOISE, PALETTE, RHYTHM } from '../../gl/glsl';
import { drawFullscreen, FULLSCREEN_VS, Program } from '../../gl/util';
import { bindOutput, commonUniforms, defineVisualizer } from '../types';

const FS = /* glsl */ `${FS_HEADER}
in vec2 vUv; out vec4 o;
${COMMON_UNIFORMS}
${RHYTHM}
uniform float uFlow;
uniform float uScene;
${HASH}
${NOISE}
${COLOR}
${PALETTE}

const float HORIZON = 0.3;

float spectrumAt(float x) { return texture(uSpectrum, vec2(clamp(x, 0.0, 1.0), 0.5)).r; }

float mountains(float x) {
  return HORIZON + 0.05 + 0.09 * fbm(vec2(x * 1.4, 3.0 + uScene)) + 0.05 * abs(sin(x * 2.3 + uScene));
}

vec3 sky(vec2 q, float aspect) {
  vec3 col = mix(vec3(0.012, 0.02, 0.06), vec3(0.0, 0.0, 0.015), smoothstep(HORIZON, 1.0, q.y));
  // Stars, twinkling with the hi-hats.
  vec2 g = floor(q * vec2(220.0, 160.0));
  float star = step(0.996, hash21(g));
  float tw = 0.4 + 0.6 * hash21(g + 3.0) + 1.4 * sparkle() * step(0.5, hash21(g + floor(uTime * 11.0)));
  col += vec3(0.85, 0.9, 1.0) * star * tw * smoothstep(HORIZON, 0.6, q.y) * 0.8;

  // Three curtains, each the spectrum laid across the sky.
  float seam = 0.0;
  for (int i = 0; i < 3; i++) {
    float fi = float(i);
    float x = q.x * (0.75 + 0.3 * fi) + fi * 3.1 + uScene * 1.7;
    float bottom = 0.5 + 0.11 * fi + 0.1 * fbm(vec2(x * 0.5 + uFlow * 0.12, fi + uScene));
    bottom += 0.045 * sin(x * 2.2 + uFlow * 0.7 + fi) * (0.3 + lowDrive());
    float h = q.y - bottom;
    if (h < -0.03) continue;
    float level = spectrumAt(0.02 + clamp(q.x / aspect, 0.0, 1.0) * 0.92);
    float rays = vnoise(vec2(x * 26.0, uFlow * 0.25 + fi * 10.0));
    rays = 0.25 + 0.75 * rays * rays;
    float glow = exp(-max(h, 0.0) * (6.5 - 3.5 * level)) * smoothstep(-0.03, 0.005, h);
    float strength = rays * (0.15 + 1.4 * level + 0.5 * colourDrive());
    strength *= 1.0 + 1.6 * pulse() * exp(-max(h, 0.0) * 14.0);
    vec3 lowCol = mix(vec3(0.15, 1.0, 0.45), pal(0.3 + 0.2 * fi), 0.35);
    vec3 highCol = mix(vec3(0.55, 0.2, 0.9), pal(0.8 + 0.1 * fi), 0.4 + 0.4 * colourDrive());
    col += mix(lowCol, highCol, smoothstep(0.0, 0.25, h)) * glow * strength * (0.55 - 0.12 * fi);
    seam += smoothstep(0.006, 0.0, abs(h)) * (1.0 - fi * 0.3);
  }
  col += vec3(0.8, 1.0, 0.9) * seam * onBeat(0.35) * pulse() * 0.6;

  // Mountains.
  float m = mountains(q.x);
  if (q.y < m) {
    col = vec3(0.004, 0.006, 0.012);
    float snow = smoothstep(m - 0.035, m - 0.005, q.y) * step(0.5, fbm(vec2(q.x * 9.0, q.y * 30.0)));
    col += vec3(0.05, 0.08, 0.1) * snow;
  }
  return col;
}

void main() {
  float aspect = uRes.x / uRes.y;
  vec2 p = vec2(vUv.x * aspect, vUv.y);
  vec3 col;
  if (p.y >= HORIZON) {
    col = sky(p, aspect);
  } else {
    // The lake: the sky upside down, rippled by the bassline.
    vec2 q = vec2(p.x + 0.004 * sin(p.y * 140.0 + uTime * 2.0) * (0.4 + lowDrive()), 2.0 * HORIZON - p.y);
    col = sky(q, aspect) * vec3(0.45, 0.55, 0.65);
    col *= 0.85 + 0.15 * sin(p.y * 300.0 + uTime);
  }
  vec2 c = vUv - 0.5;
  col *= 1.0 - 0.5 * dot(c, c);
  o = vec4(aces(col * 1.3), 1.0);
}`;

export default defineVisualizer({
  id: 'aurora',
  name: 'Aurora',
  family: 'modern',
  order: 210,
  description: 'Northern lights over mountains and a lake: the curtains are the spectrum, rippling with the bass and flaring on kicks.',
  create(ctx) {
    const { gl } = ctx;
    const program = new Program(gl, FULLSCREEN_VS, FS);
    let flow = 0;
    return {
      resize() {},
      render(frame) {
        const a = frame.audio;
        flow += Math.min(frame.dt, 0.05) * (0.4 + 1.6 * Math.max(a.bassline, a.bass * 0.5) + 0.6 * a.energy);
        bindOutput(gl, frame);
        program.use().set({ ...commonUniforms(frame), uFlow: flow, uScene: a.dropCount % 5 });
        drawFullscreen(gl);
      },
      dispose() {
        program.dispose();
      },
    };
  },
});
