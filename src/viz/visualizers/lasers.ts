// Laser Show: beams fan out from the stage through haze, sweeping across the
// bar. Each beam carries one band; kicks flash and widen them all, snares
// strobe their colours, hi-hats glitter along them, and each drop brings a
// new pattern (fan, crossfire, tunnel).

import { BloomScene } from '../../gl/bloom';
import { COLOR, COMMON_UNIFORMS, FS_HEADER, HASH, NOISE, PALETTE, RHYTHM } from '../../gl/glsl';
import { drawFullscreen, FULLSCREEN_VS, Program } from '../../gl/util';
import { commonUniforms, defineVisualizer } from '../types';

const BEAMS = 12;

const FS = /* glsl */ `${FS_HEADER}
in vec2 vUv; out vec4 o;
${COMMON_UNIFORMS}
${RHYTHM}
uniform float uSweep;
uniform float uPattern;
${HASH}
${NOISE}
${COLOR}
${PALETTE}

const int BEAMS = ${BEAMS};

float spectrumAt(float x) { return texture(uSpectrum, vec2(clamp(x, 0.0, 1.0), 0.5)).r; }

// Distance from p to the ray starting at a with direction d (only in front of a).
float rayDist(vec2 p, vec2 a, vec2 d) {
  vec2 ap = p - a;
  float t = max(dot(ap, d), 0.0);
  return length(ap - d * t);
}

void main() {
  float aspect = uRes.x / uRes.y;
  vec2 p = (vUv - vec2(0.5, 0.0)) * vec2(aspect, 1.0);
  float haze = 0.55 + 0.45 * fbm(p * 2.2 + vec2(uTime * 0.05, -uTime * 0.08));
  vec3 col = uPal[3] * 0.02 * haze;
  float pattern = mod(uPattern, 3.0);

  for (int i = 0; i < BEAMS; i++) {
    float fi = float(i) / float(BEAMS - 1);
    float band = spectrumAt(0.05 + fi * 0.85);
    vec2 origin;
    float angle;
    if (pattern < 1.0) {
      // A fan from the middle of the stage.
      origin = vec2(0.0, -0.02);
      angle = mix(-1.05, 1.05, fi) + 0.35 * sin(uSweep * 6.2831 + fi * 3.0);
    } else if (pattern < 2.0) {
      // Crossfire from both sides.
      float side = mod(float(i), 2.0) * 2.0 - 1.0;
      origin = vec2(side * aspect * 0.48, 0.02);
      angle = -side * (0.35 + 0.7 * fi) + 0.3 * sin(uSweep * 6.2831 + fi * 5.0);
    } else {
      // A cone straight at you, spinning.
      origin = vec2(0.0, 0.5);
      angle = fi * 6.2831 + uSweep * 3.1416;
    }
    vec2 dir = pattern < 2.0 ? vec2(sin(angle), cos(angle)) : vec2(cos(angle), sin(angle));
    float width = 0.0025 + 0.004 * pulse() + 0.004 * band;
    float d = rayDist(p, origin, dir);
    float along = length(p - origin);
    float core = exp(-d * d / (width * width));
    float glow = exp(-d / (0.02 + 0.03 * band)) * 0.35;
    vec3 tint = pal(fi * 0.9 + 0.2 * colourDrive() + uSnare * 0.5);
    float strength = (0.15 + 1.6 * band * band + 0.9 * pulse()) * (0.6 + 0.6 * haze) * exp(-along * 0.6);
    col += tint * (core + glow) * strength;
    // Hi-hats glitter along the beams.
    float glitter = step(0.97, hash21(floor(p * 120.0) + floor(uTime * 30.0))) * sparkle();
    col += vec3(1.0) * glitter * core * 2.0;
  }
  // Stage lights along the bottom flash with the beat.
  col += pal(0.05) * exp(-vUv.y * 40.0) * (0.15 + 0.8 * onBeat(0.3) * pulse() + 0.3 * lowDrive());
  o = vec4(col, 1.0);
}`;

export default defineVisualizer({
  id: 'lasers',
  name: 'Laser Show',
  family: 'modern',
  order: 130,
  description: 'Beams sweep through stage haze in time with the bar; each drop brings a new pattern.',
  create(ctx) {
    const { gl } = ctx;
    const program = new Program(gl, FULLSCREEN_VS, FS);
    const scene = new BloomScene(gl, ctx.hdr, { scale: 0.75 });
    let sweep = 0;
    return {
      resize(width, height) {
        scene.resize(width, height);
      },
      render(frame) {
        const a = frame.audio;
        // Sweeps follow the bar when the beat is known, a slow drift when not.
        sweep = a.bpm > 0 && a.tempoConfidence > 0.3 ? a.barPhase : (sweep + frame.dt * 0.12) % 1;
        scene.begin();
        program.use().set({ ...commonUniforms(frame), uRes: [scene.scene.width, scene.scene.height], uSweep: sweep, uPattern: a.dropCount });
        drawFullscreen(gl);
        scene.end(frame, { threshold: 0.45, knee: 0.4, intensity: 1.1, vignette: 0.3, exposure: 1.05 });
      },
      dispose() {
        program.dispose();
        scene.dispose();
      },
    };
  },
});
