// Petals: a mandala of polar roses. Each petal belongs to a band and opens
// with it; rings turn against each other. The bassline swells the flower,
// vocals tint it and curl the petals, kicks make it bloom, hi-hats catch the
// petal tips, and each drop changes how many petals there are.

import { BloomScene } from '../../gl/bloom';
import { COLOR, COMMON_UNIFORMS, FS_HEADER, HASH, PALETTE, RHYTHM } from '../../gl/glsl';
import { drawFullscreen, FULLSCREEN_VS, Program } from '../../gl/util';
import { commonUniforms, defineVisualizer } from '../types';

const FS = /* glsl */ `${FS_HEADER}
in vec2 vUv; out vec4 o;
${COMMON_UNIFORMS}
${RHYTHM}
uniform float uSpin;
uniform float uPetals;
${HASH}
${COLOR}
${PALETTE}

float spectrumAt(float x) { return texture(uSpectrum, vec2(clamp(x, 0.0, 1.0), 0.5)).r; }

// One ring of petals: returns the distance outside the petal outline (negative inside).
float ring(vec2 p, float n, float radius, float open, float twist, out float petal) {
  float r = length(p);
  float a = atan(p.y, p.x) + twist;
  float k = a * n / 6.2831853;
  petal = floor(k + 0.5);
  float local = (fract(k + 0.5) - 0.5) * 6.2831853 / n;      // angle within this petal
  float level = spectrumAt(0.04 + fract(petal / n) * 0.8);
  float reach = radius * (0.55 + 0.45 * open) * (0.75 + 0.6 * level);
  float rose = reach * pow(max(cos(local * n * 0.5), 0.0), 0.65);
  return r - rose;
}

void main() {
  float aspect = uRes.x / uRes.y;
  vec2 p = (vUv - 0.5) * vec2(aspect, 1.0);
  float size = 0.82 + 0.25 * lowDrive() + 0.12 * pulse();
  p /= size;
  vec3 col = vec3(0.0);
  float n = uPetals;
  float curl = 0.25 * colourDrive();
  for (int i = 0; i < 4; i++) {
    float fi = float(i);
    float dir = mod(fi, 2.0) * 2.0 - 1.0;
    float petal;
    float d = ring(p, n + fi * 2.0, 0.42 - fi * 0.085, 0.6 + 0.4 * pulse(), uSpin * dir * (1.0 + fi * 0.4) + curl * length(p) * 6.0, petal);
    float fill = smoothstep(0.012, -0.03, d);
    float rim = smoothstep(0.006, 0.0, abs(d));
    vec3 tint = pal(fi * 0.22 + petal * 0.03 + 0.3 * colourDrive());
    col = mix(col, tint * (0.25 + 0.5 * smoothstep(-0.2, 0.0, d)), fill * (0.85 - fi * 0.12));
    col += mix(tint, vec3(1.0), 0.5) * rim * (0.5 + 0.8 * pulse());
    // Tips glint with the hi-hats.
    float tip = smoothstep(0.02, 0.0, abs(d)) * smoothstep(0.2, 0.42, length(p));
    col += vec3(1.0) * tip * sparkle() * step(0.5, hash21(vec2(petal, fi + floor(uTime * 8.0))));
  }
  // A glowing heart that beats.
  float r = length(p);
  col += pal(0.05) * exp(-r * (14.0 - 6.0 * pulse())) * (0.4 + 1.2 * pulse());
  col += uPal[2] * exp(-r * 2.2) * (0.04 + 0.08 * uLevel);
  o = vec4(col, 1.0);
}`;

const COUNTS = [6, 8, 5, 10, 7, 12];

export default defineVisualizer({
  id: 'petals',
  name: 'Petals',
  family: 'modern',
  order: 135,
  description: 'A mandala of polar roses; every petal opens with its own band, and drops change the flower.',
  create(ctx) {
    const { gl } = ctx;
    const program = new Program(gl, FULLSCREEN_VS, FS);
    const scene = new BloomScene(gl, ctx.hdr, { scale: 0.75 });
    let spin = 0;
    let petals = COUNTS[0];
    let shown = petals;
    return {
      resize(width, height) {
        scene.resize(width, height);
      },
      render(frame) {
        const a = frame.audio;
        spin += frame.dt * (0.08 + 0.25 * a.vocals + 0.2 * a.mid);
        petals = COUNTS[a.dropCount % COUNTS.length];
        // Glide to a new petal count rather than jump.
        shown += (petals - shown) * Math.min(1, frame.dt * 2.5);
        scene.begin();
        program.use().set({ ...commonUniforms(frame), uRes: [scene.scene.width, scene.scene.height], uSpin: spin, uPetals: Math.round(shown) });
        drawFullscreen(gl);
        scene.end(frame, { threshold: 0.55, knee: 0.45, intensity: 0.9, vignette: 0.35, exposure: 1.0 });
      },
      dispose() {
        program.dispose();
        scene.dispose();
      },
    };
  },
});
