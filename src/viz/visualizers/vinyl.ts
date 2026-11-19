// Turntable: the song's record, spinning, with its cover as the label. Light
// catches the grooves where the music is (bass near the label, treble at the
// rim), the strobe dots on the platter flash with the kicks and the beat,
// the needle trembles with the bassline, the vocals warm the light, and dust
// on the record glints with the hi-hats.

import { COLOR, COMMON_UNIFORMS, FS_HEADER, HASH, PALETTE, RHYTHM } from '../../gl/glsl';
import { drawFullscreen, FULLSCREEN_VS, Program } from '../../gl/util';
import { bindOutput, commonUniforms, defineVisualizer } from '../types';

const FS = /* glsl */ `${FS_HEADER}
in vec2 vUv; out vec4 o;
${COMMON_UNIFORMS}
${RHYTHM}
uniform sampler2D uArtwork;
uniform float uHasArt;
uniform float uSpin;
uniform float uArm;
${HASH}
${COLOR}
${PALETTE}

const float R = 0.41;
const float LABEL = 0.135;

float spectrumAt(float x) { return texture(uSpectrum, vec2(clamp(x, 0.0, 1.0), 0.5)).r; }

float segment(vec2 p, vec2 a, vec2 b) {
  vec2 pa = p - a, ba = b - a;
  float t = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0);
  return length(pa - ba * t);
}

void main() {
  float aspect = uRes.x / uRes.y;
  vec2 p = (gl_FragCoord.xy - 0.5 * uRes) / uRes.y;
  vec2 centre = vec2(-0.08 * min(aspect, 1.8), 0.0);
  float bump = 1.0 + 0.015 * pulse();
  vec2 q = (p - centre) / bump;
  float r = length(q);
  float screenAngle = atan(q.y, q.x);
  float a = screenAngle + uSpin;

  // The deck: a dark plinth with a soft light from the top left.
  vec3 col = mix(vec3(0.02, 0.018, 0.022), vec3(0.06, 0.05, 0.06), smoothstep(-0.6, 0.6, p.y - p.x * 0.3));
  col += pal(0.6) * 0.03;

  // Platter rim with strobe dots.
  float rim = smoothstep(0.004, 0.0, abs(r - (R + 0.035)) - 0.012);
  col = mix(col, vec3(0.16, 0.16, 0.18), rim);
  float dots = step(0.5, fract(a * 72.0 / 6.2832)) * smoothstep(0.004, 0.0, abs(r - (R + 0.035)) - 0.006);
  col += mix(vec3(1.0, 0.35, 0.2), pal(0.0), 0.4) * dots * (0.25 + 1.5 * pulse() + 0.6 * onBeat(0.2));

  if (r < R) {
    // Vinyl: fine grooves, the gaps between tracks, a sheen that follows the light.
    float groove = 0.5 + 0.5 * sin(r * 1400.0);
    float gaps = smoothstep(0.004, 0.0, abs(fract((r - LABEL) / (R - LABEL) * 5.0) - 0.5) - 0.48);
    vec3 vinyl = vec3(0.025) + vec3(0.02) * groove;
    float band = clamp((r - LABEL) / (R - LABEL), 0.0, 1.0);
    float level = spectrumAt(0.02 + band * 0.92);
    float light = pow(max(0.0, cos(2.0 * (screenAngle - 2.3))), 28.0);
    float light2 = pow(max(0.0, cos(2.0 * (screenAngle - 2.3) + 0.3)), 60.0);
    vec3 sheenCol = mix(vec3(0.85, 0.9, 1.0), pal(0.15) * 1.5, 0.3 + 0.5 * colourDrive());
    vinyl += sheenCol * (light * (0.12 + 1.1 * level) + light2 * 0.25) * (0.6 + 0.4 * groove);
    vinyl += vec3(0.08) * gaps;
    // Dust, glinting with the hi-hats.
    vec2 dg = floor(vec2(r * 300.0, a * 40.0));
    vinyl += vec3(1.0) * step(0.996, hash21(dg)) * (0.15 + 1.4 * sparkle());
    col = vinyl;
    if (r < LABEL) {
      // The label: the song's cover, turning with the record.
      vec2 lq = mat2(cos(uSpin), -sin(uSpin), sin(uSpin), cos(uSpin)) * q;
      vec2 auv = lq / (LABEL * 2.0) + 0.5;
      vec3 art = texture(uArtwork, auv).rgb;
      vec3 plain = mix(pal(0.0), pal(0.5), smoothstep(0.0, LABEL, r)) * (0.7 + 0.3 * step(0.5, fract(r * 40.0)));
      col = mix(plain, art, uHasArt);
      col *= 0.85 + 0.25 * colourDrive();
      col = mix(col, vec3(0.0), smoothstep(0.007, 0.006, r));
    }
  }
  // A thin highlight on the record's edge.
  col += vec3(0.25) * smoothstep(0.003, 0.0, abs(r - R)) * (0.4 + 0.6 * pow(max(0.0, cos(screenAngle - 2.3)), 4.0));

  // The tonearm: from its pivot to the needle, trembling with the bassline.
  vec2 pivot = centre + vec2(0.52, 0.36);
  float needleR = mix(R - 0.03, LABEL + 0.03, uArm);
  vec2 needle = centre + vec2(cos(-0.35), sin(-0.35)) * needleR;
  needle += vec2(0.0, 1.0) * 0.003 * sin(uTime * 90.0) * lowDrive();
  float arm = segment(p, pivot, needle + vec2(0.05, 0.04));
  float head = segment(p, needle + vec2(0.05, 0.04), needle);
  col = mix(col, vec3(0.6, 0.62, 0.66), smoothstep(0.009, 0.006, arm));
  col = mix(col, vec3(0.12), smoothstep(0.014, 0.011, head));
  col = mix(col, vec3(0.25), smoothstep(0.035, 0.03, length(p - pivot)));
  col += vec3(0.9) * smoothstep(0.004, 0.0, abs(length(p - pivot) - 0.032)) * 0.3;

  vec2 c = vUv - 0.5;
  col *= 1.0 - 0.7 * dot(c, c);
  o = vec4(aces(col * 1.3), 1.0);
}`;

export default defineVisualizer({
  id: 'vinyl',
  name: 'Turntable',
  family: 'modern',
  order: 220,
  description: "The song's record spinning with its cover as the label: light catches the grooves where the music is, the strobe flashes on kicks.",
  create(ctx) {
    const { gl } = ctx;
    const program = new Program(gl, FULLSCREEN_VS, FS);
    let spin = 0;
    let arm = 0;
    return {
      resize() {},
      render(frame) {
        const a = frame.audio;
        const dt = Math.min(frame.dt, 0.05);
        // 33⅓ rpm, nudged toward 45 when the music is busy.
        spin += dt * 3.49 * (1 + 0.35 * a.energy);
        arm = (arm + dt / 240) % 1;
        bindOutput(gl, frame);
        program.use().set({ ...commonUniforms(frame), uSpin: spin, uArm: arm });
        drawFullscreen(gl);
      },
      dispose() {
        program.dispose();
      },
    };
  },
});
