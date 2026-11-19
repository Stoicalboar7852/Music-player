// Spiral Galaxy: a galaxy seen at an angle, turning. Its radius is the
// spectrum, bass at the core and treble at the rim, so each band lights its
// own ring of the arms. Kicks flare the core and the beat sends a shock ring
// outward; the bassline spins the arms faster; the vocals fill in the
// nebulae; hi-hats make the stars twinkle. Each drop turns the view.

import { COLOR, COMMON_UNIFORMS, FS_HEADER, HASH, NOISE, PALETTE, RHYTHM } from '../../gl/glsl';
import { drawFullscreen, FULLSCREEN_VS, Program } from '../../gl/util';
import { bindOutput, commonUniforms, defineVisualizer } from '../types';

const FS = /* glsl */ `${FS_HEADER}
in vec2 vUv; out vec4 o;
${COMMON_UNIFORMS}
${RHYTHM}
uniform float uSpin;
uniform float uView;
${HASH}
${NOISE}
${COLOR}
${PALETTE}

float spectrumAt(float x) { return texture(uSpectrum, vec2(clamp(x, 0.0, 1.0), 0.5)).r; }

void main() {
  vec2 p = (gl_FragCoord.xy - 0.5 * uRes) / uRes.y;
  // Distant stars behind everything.
  vec2 sg = floor(p * 260.0);
  float far = step(0.997, hash21(sg)) * (0.3 + 0.7 * hash21(sg + 1.0));
  vec3 col = vec3(0.004, 0.004, 0.012) + vec3(0.8, 0.85, 1.0) * far * 0.6;

  // Into the galaxy's plane: tilted, and turned a little.
  float tilt = 0.42 + 0.12 * sin(uView);
  float turn = 0.35 + uView * 0.7;
  vec2 q = mat2(cos(turn), -sin(turn), sin(turn), cos(turn)) * p;
  q.y /= tilt;
  float r = length(q);
  float a = atan(q.y, q.x);

  // The arms turn as a whole (a density wave, as in real galaxies); the
  // stars and clouds in them turn faster near the middle.
  float spin = uSpin / (0.25 + r * 2.0);
  float arm = a - log(r + 0.04) * 2.4 + uSpin * 0.35;
  float arms = pow(0.5 + 0.5 * cos(arm * 2.0), 3.0);
  float lanes = pow(0.5 + 0.5 * cos(arm * 2.0 + 0.7), 10.0);
  float disk = exp(-r * 3.2);
  float band = clamp(r * 1.25, 0.0, 1.0);
  float level = spectrumAt(0.02 + band * 0.92);
  float cloud = fbm(vec2((a + spin) * 1.3, r * 7.0));
  vec3 armCol = mix(pal(0.55), pal(0.85), smoothstep(0.0, 0.7, r));
  vec3 nebula = mix(pal(0.15), vec3(1.0, 0.45, 0.6), 0.4);
  col += armCol * arms * disk * (0.35 + 2.2 * level) * (0.6 + 0.6 * cloud);
  col += nebula * arms * cloud * cloud * disk * (0.1 + 1.4 * colourDrive());
  col *= 1.0 - lanes * 0.55 * smoothstep(0.05, 0.25, r) * disk * 2.0;

  // Stars that turn with the arms, twinkling with the hi-hats.
  vec2 cell = vec2(r * 90.0, (a + spin) * 14.0);
  vec2 id = floor(cell);
  vec2 f = fract(cell) - 0.5;
  float h = hash21(id);
  float star = exp(-dot(f, f) * 40.0) * step(0.86, h) * (0.4 + 0.6 * arms) * smoothstep(0.75, 0.1, r);
  float tw = 0.5 + 1.5 * sparkle() * step(0.5, hash21(id + floor(uTime * 10.0)));
  col += vec3(0.9, 0.92, 1.0) * star * tw;

  // The core flares on the kick; the beat sends a shock ring out.
  col += mix(vec3(1.0, 0.9, 0.75), pal(0.05), 0.3) * (exp(-r * 13.0) * (0.8 + 2.5 * pulse() + 1.5 * onBeat(0.25)) + exp(-r * 5.0) * 0.25);
  float ringR = (1.0 - onBeat(1.0)) * 0.8;
  col += mix(pal(0.3), vec3(1.0), 0.3) * smoothstep(0.035, 0.0, abs(r - ringR)) * onBeat(0.8) * (0.4 + 0.8 * pulse()) * disk * 3.0;

  vec2 c = vUv - 0.5;
  col *= 1.0 - 0.6 * dot(c, c);
  o = vec4(aces(col * 1.2), 1.0);
}`;

export default defineVisualizer({
  id: 'galaxy',
  name: 'Spiral Galaxy',
  family: 'modern',
  order: 215,
  description: 'A turning spiral galaxy whose radius is the spectrum: bass at the core, treble at the rim; kicks flare the core.',
  create(ctx) {
    const { gl } = ctx;
    const program = new Program(gl, FULLSCREEN_VS, FS);
    let spin = 0;
    let view = 0;
    return {
      resize() {},
      render(frame) {
        const a = frame.audio;
        const dt = Math.min(frame.dt, 0.05);
        // Turning with the bassline, lurching forward a little on every kick.
        spin += dt * (0.25 + 1.2 * Math.max(a.bassline, a.bass * 0.5) + 0.4 * a.energy) + (a.kickHit ? 0.12 : 0);
        view += (a.dropCount * 1.3 - view) * Math.min(1, dt * 0.6);
        bindOutput(gl, frame);
        program.use().set({ ...commonUniforms(frame), uSpin: spin, uView: view });
        drawFullscreen(gl);
      },
      dispose() {
        program.dispose();
      },
    };
  },
});
