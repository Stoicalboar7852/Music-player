// Kaleidoscope: shards of coloured glass tumbling behind a ring of mirrors.
// Every shard listens to its own slice of the spectrum.

import { COLOR, COMMON_UNIFORMS, FS_HEADER, HASH, AUDIO_SAMPLING, RHYTHM } from '../../gl/glsl';
import { drawFullscreen, FULLSCREEN_VS, Program } from '../../gl/util';
import { bindOutput, commonUniforms, defineVisualizer } from '../types';

const FS = /* glsl */ `${FS_HEADER}
in vec2 vUv; out vec4 o;
${COMMON_UNIFORMS}
${RHYTHM}
uniform float uSegments;
uniform float uSpin;      // rotation of the mirrors
uniform float uTumble;    // rotation of the glass behind them
uniform float uFlash;
uniform vec2 uDrift;
${HASH}
${COLOR}
${AUDIO_SAMPLING}

const float TAU = 6.2831853;

// Returns (distance to nearest cell edge, cell id hash).
vec3 shards(vec2 p, float t) {
  vec2 n = floor(p), f = fract(p);
  vec2 nearest; vec2 nearestCell; float d1 = 8.0;
  for (int j = -1; j <= 1; j++) for (int i = -1; i <= 1; i++) {
    vec2 g = vec2(float(i), float(j));
    vec2 h = hash22(n + g);
    vec2 pt = g + 0.5 + 0.42 * sin(t * (0.4 + h.x) + TAU * h);
    float d = dot(pt - f, pt - f);
    if (d < d1) { d1 = d; nearest = pt; nearestCell = n + g; }
  }
  float edge = 8.0;
  for (int j = -2; j <= 2; j++) for (int i = -2; i <= 2; i++) {
    vec2 g = vec2(float(i), float(j));
    vec2 h = hash22(n + g);
    vec2 pt = g + 0.5 + 0.42 * sin(t * (0.4 + h.x) + TAU * h);
    vec2 diff = pt - nearest;
    if (dot(diff, diff) > 1e-5) edge = min(edge, dot(0.5 * (nearest + pt) - f, normalize(diff)));
  }
  return vec3(edge, hash22(nearestCell));
}

void main() {
  vec2 p = (gl_FragCoord.xy - 0.5 * uRes) / uRes.y;
  float r = length(p);
  float a = atan(p.y, p.x) + uSpin;

  // Mirror fold: every wedge shows the same slice of glass, alternately flipped.
  float seg = TAU / uSegments;
  a = mod(a, seg);
  a = abs(a - seg * 0.5);
  vec2 q = r * vec2(cos(a), sin(a));

  // The glass itself tumbles and drifts behind the mirrors.
  float ct = cos(uTumble), st = sin(uTumble);
  float zoom = 7.0 - 2.2 * lowDrive() - 1.2 * pulse();
  vec2 sp = mat2(ct, -st, st, ct) * q * zoom + uDrift;
  vec3 sh = shards(sp, uTime * 0.5);
  float edge = sh.x;
  float id = sh.y;

  // Each shard is tied to one frequency band and glows with it.
  float level = spectrum(0.03 + id * 0.85);
  vec3 glass = hsv2rgb(vec3(id * 1.7 + uTime * 0.035 + r * 0.12, 0.84 - 0.3 * level, 1.0));
  float body = smoothstep(0.0, 0.32, edge);                      // thicker, brighter in the middle
  float light = 0.20 + 0.22 * body + 1.9 * level * level + 0.35 * pulse();
  vec3 col = glass * light;
  col *= 0.86 + 0.14 * sin(dot(sp, vec2(3.1, 2.3)) + uTime * 1.5);   // light shimmering through

  // Leading between shards, with bright bevels that catch the treble.
  float lead = smoothstep(0.0, 0.05, edge);
  float bevel = smoothstep(0.16, 0.05, edge) * lead;
  col *= lead;
  col += glass * bevel * (0.2 + 1.8 * uTreble);
  col += vec3(1.0) * bevel * sparkle() * step(0.75, sh.z) * 1.4;     // hi-hats sparkle

  // Seams where the mirrors meet.
  float seam = smoothstep(0.006, 0.0, a * r) + smoothstep(0.006, 0.0, (seg * 0.5 - a) * r);
  col += vec3(0.9, 0.95, 1.0) * seam * (0.06 + 0.2 * pulse());

  col += glass * uFlash * 0.6;
  col *= smoothstep(1.35, 0.55, r);                                   // the tube's rim
  col = col / (1.0 + 0.22 * col);
  o = vec4(col, 1.0);
}`;

const SEGMENT_STEPS = [6, 8, 10, 12, 8, 5];

export default defineVisualizer({
  id: 'kaleido',
  name: 'Kaleidoscope',
  family: 'classic',
  order: 50,
  description: 'Mirrored shards of stained glass; each one lights up with its own frequency band.',
  create(ctx) {
    const { gl } = ctx;
    const program = new Program(gl, FULLSCREEN_VS, FS);
    let spin = 0;
    let tumble = 0;
    let step = 0;
    let flash = 0;
    const drift = [0, 0];
    return {
      resize() {},
      render(frame) {
        const a = frame.audio;
        const dt = frame.dt;
        spin += dt * (0.06 + 0.3 * a.mid + 0.4 * a.vocals);
        tumble -= dt * (0.1 + 0.6 * a.mid + 0.8 * a.midHit);
        flash *= Math.exp(-dt * 4);
        drift[0] += dt * (0.12 + 0.5 * a.level);
        drift[1] -= dt * (0.08 + 0.35 * a.level);
        // Every 16 beats the mirror count changes, with a flash to cover the cut.
        // A new pattern on a drop, or every 32 beats when there are none.
        if (a.drop || (a.beat && a.beatCount % 32 === 0)) {
          step = (step + 1) % SEGMENT_STEPS.length;
          flash = 1;
        }
        bindOutput(gl, frame);
        program.use().set({
          ...commonUniforms(frame),
          uSegments: SEGMENT_STEPS[step],
          uSpin: spin,
          uTumble: tumble,
          uFlash: flash,
          uDrift: drift,
        });
        drawFullscreen(gl);
      },
      dispose() {
        program.dispose();
      },
    };
  },
});
