// Album Halo: the cover art as a disc, ringed by a mirrored radial spectrum,
// a waveform halo and beat ripples, over a blurred wash of the same artwork.
// Every colour comes from the artwork's palette.

import { BloomScene } from '../../gl/bloom';
import { AUDIO_SAMPLING, COLOR, COMMON_UNIFORMS, FS_HEADER, HASH, PALETTE, RHYTHM } from '../../gl/glsl';
import { drawFullscreen, FULLSCREEN_VS, Program } from '../../gl/util';
import { commonUniforms, defineVisualizer } from '../types';

const FS = /* glsl */ `${FS_HEADER}
in vec2 vUv; out vec4 o;
${COMMON_UNIFORMS}
${RHYTHM}
uniform sampler2D uArtwork;
uniform float uHasArt;
uniform float uSpin;
${HASH}
${COLOR}
${PALETTE}
${AUDIO_SAMPLING}

const float PI = 3.14159265;
const float BARS = 84.0;          // per side

vec3 blurredArt(vec2 uv) {
  // A handful of high-mip taps is a cheap, very wide blur.
  vec3 c = vec3(0.0);
  for (int i = 0; i < 6; i++) {
    float a = float(i) * 1.0472 + 0.3;
    c += textureLod(uArtwork, uv + 0.045 * vec2(cos(a), sin(a)), 5.0).rgb;
  }
  return c / 6.0;
}

void main() {
  float aspect = uRes.x / uRes.y;
  vec2 p = (gl_FragCoord.xy - 0.5 * uRes) / uRes.y;
  float r = length(p);
  float ang = atan(p.x, p.y);                      // 0 at the top, +/-PI at the bottom
  float side = abs(ang) / PI;                      // 0 top .. 1 bottom, mirrored left/right

  // ---- backdrop
  float breathe = 1.0 - 0.04 * lowDrive() - 0.03 * pulse();
  vec2 buv = p / max(aspect, 1.0) * breathe * 0.86 + 0.5;
  vec3 wash = mix(pal(0.08 + 0.25 * buv.x + 0.1 * sin(uTime * 0.1)), pal(0.6 + 0.25 * buv.y), 0.5 + 0.5 * sin(uTime * 0.07 + r * 2.0));
  vec3 bg = mix(wash * 0.5, blurredArt(buv), uHasArt);
  bg *= 0.20 + 0.20 * uLevel + 0.12 * pulse();
  bg *= smoothstep(1.25, 0.2, r);

  vec3 col = bg;
  float R = 0.2 + 0.014 * lowDrive() + 0.02 * pulse();    // disc radius

  // ---- radial spectrum
  float fi = side * BARS;
  float index = floor(fi);
  float f = fract(fi);
  float h = spectrum(0.015 + (index + 0.5) / BARS * 0.93);
  float len = 0.012 + h * h * 0.26 + h * 0.03;
  float r0 = R + 0.02;
  float angPx = BARS / (PI * max(r, 0.05) * uRes.y);          // one pixel in bar-space
  float across = smoothstep(0.16, 0.16 + angPx * 1.5, f) * smoothstep(0.84, 0.84 - angPx * 1.5, f);
  float along = smoothstep(r0 - 0.002, r0, r) * smoothstep(r0 + len + 0.002, r0 + len, r);
  vec3 barColor = pal(side * 0.72 + uTime * 0.015);
  float tip = smoothstep(r0 + len - 0.02, r0 + len, r);        // tips burn brighter
  col += barColor * across * along * (0.7 + 1.6 * h + 1.3 * tip + 0.9 * pulse());

  // ---- waveform halo
  float w = wave(0.08 + side * 0.84);
  float halo = R + 0.335 + w * (0.012 + 0.03 * uLevel);
  float haloLine = smoothstep(0.0035, 0.0, abs(r - halo));
  col += pal(0.5 + side * 0.4 + 0.12 * colourDrive()) * haloLine * (0.25 + 0.7 * uLevel + 0.4 * colourDrive() + 0.6 * sparkle());

  // ---- beat ripple: a ring leaves the disc on every beat
  float age = -log(max(uBeat, 1e-3)) / 5.5;                   // seconds since the beat
  float ripple = R + age * 0.95;
  col += pal(0.3) * smoothstep(0.012, 0.0, abs(r - ripple)) * uBeat * 1.6;

  // ---- treble sparks drifting outward
  vec2 sg = vec2(ang * 9.0, r * 16.0 - uTime * 1.2);
  vec2 sid = floor(sg);
  vec2 sf = fract(sg) - 0.5;
  float spark = step(0.86, hash21(sid)) * smoothstep(0.16, 0.0, length(sf * vec2(r * 3.0 + 0.3, 1.0)));
  col += pal(hash21(sid + 7.0)) * spark * max(uTreble, sparkle()) * 1.6 * smoothstep(R + 0.03, R + 0.12, r) * smoothstep(0.75, 0.45, r);

  // ---- the disc itself is drawn after the bloom pass so the artwork stays
  // crisp and true to its colours; here it is just a dark hole.
  col *= 1.0 - smoothstep(R + 0.002, R - 0.002, r) * 0.92;
  // rim light around the disc
  col += pal(0.12 + side * 0.3) * smoothstep(0.006, 0.0, abs(r - R - 0.004)) * (0.6 + 1.6 * lowDrive() + 1.2 * pulse());

  o = vec4(col, 1.0);
}`;

const DISC_FS = /* glsl */ `${FS_HEADER}
in vec2 vUv; out vec4 o;
${COMMON_UNIFORMS}
${RHYTHM}
uniform sampler2D uArtwork;
uniform float uHasArt;
uniform float uSpin;
${PALETTE}

void main() {
  vec2 p = (gl_FragCoord.xy - 0.5 * uRes) / uRes.y;
  float R = 0.2 + 0.014 * lowDrive() + 0.02 * pulse();       // must match the scene shader
  float r = length(p);
  float aa = 1.5 / uRes.y;
  float mask = smoothstep(R, R - aa, r);
  if (mask <= 0.0) discard;

  vec2 duv = p / (2.0 * R);
  float rr = length(duv) * 2.0;
  vec3 face;
  if (uHasArt > 0.5) {
    face = texture(uArtwork, duv + 0.5).rgb;
  } else {
    // No artwork: a record, grooves and all, with a palette-coloured label.
    float cs = cos(uSpin), sn = sin(uSpin);
    vec2 q = mat2(cs, -sn, sn, cs) * duv;
    float grooves = 0.5 + 0.5 * sin(rr * 150.0);
    float sheen = pow(abs(cos(atan(q.y, q.x) * 2.0)), 14.0);
    face = vec3(0.022) + 0.03 * grooves + 0.16 * sheen * smoothstep(0.38, 0.6, rr);
    vec3 label = mix(pal(0.0), pal(0.25), 0.5 + 0.5 * q.x * 3.0) * (0.75 + 0.25 * sin(atan(q.y, q.x) * 3.0));
    face = mix(label, face, smoothstep(0.34, 0.36, rr));
    face = mix(vec3(0.0), face, smoothstep(0.03, 0.045, rr));
  }
  face *= 1.0 + 0.18 * pulse();
  // A soft glassy highlight and a slightly darkened edge give the disc some depth.
  face += 0.07 * smoothstep(0.15, 1.0, duv.y + 0.5 - 0.6 * length(duv)) * smoothstep(0.5, 0.2, length(duv));
  face *= 0.78 + 0.22 * smoothstep(1.0, 0.86, rr);
  o = vec4(face * mask, mask);
}`;

export default defineVisualizer({
  id: 'radial',
  name: 'Album Halo',
  family: 'modern',
  order: 110,
  description: 'Cover art ringed by a radial spectrum and beat ripples, coloured from the artwork.',
  create(ctx) {
    const { gl } = ctx;
    const program = new Program(gl, FULLSCREEN_VS, FS);
    const disc = new Program(gl, FULLSCREEN_VS, DISC_FS);
    const scene = new BloomScene(gl, ctx.hdr);
    let spin = 0;
    return {
      resize(width, height) {
        scene.resize(width, height);
      },
      render(frame) {
        spin += frame.dt * 3.49; // 33 1/3 rpm
        scene.begin(false);
        program.use().set({ ...commonUniforms(frame), uRes: [scene.width, scene.height], uSpin: spin });
        drawFullscreen(gl);
        scene.end(frame, { threshold: 0.55, knee: 0.5, intensity: 0.9, vignette: 0.3, tonemap: 1, exposure: 1.1 });

        // The cover goes on last, untouched by bloom and tonemapping.
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
        disc.use().set({ ...commonUniforms(frame), uSpin: spin });
        drawFullscreen(gl);
        gl.disable(gl.BLEND);
      },
      dispose() {
        program.dispose();
        disc.dispose();
        scene.dispose();
      },
    };
  },
});
