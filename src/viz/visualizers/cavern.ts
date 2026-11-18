// Crystal Cavern: a slow flight through a cave of glowing crystals. Each
// crystal cluster belongs to a band and lights with it. Kicks flash the
// lanterns, vocals tint the crystals, hi-hats glint on their facets, and a
// drop sends the flight down a new passage.

import { BloomScene } from '../../gl/bloom';
import { COLOR, COMMON_UNIFORMS, FS_HEADER, HASH, PALETTE, RHYTHM } from '../../gl/glsl';
import { drawFullscreen, FULLSCREEN_VS, Program } from '../../gl/util';
import { commonUniforms, defineVisualizer } from '../types';

const FS = /* glsl */ `${FS_HEADER}
in vec2 vUv; out vec4 o;
${COMMON_UNIFORMS}
${RHYTHM}
uniform float uFly;
uniform float uSteps;
uniform float uVariant;
${HASH}
${COLOR}
${PALETTE}

float spectrumAt(float x) { return texture(uSpectrum, vec2(clamp(x, 0.0, 1.0), 0.5)).r; }

// The cave: the inside of a gyroid-like surface around a winding path.
vec2 path(float z) { return vec2(sin(z * 0.21) * 1.4 + sin(z * 0.53) * 0.5, cos(z * 0.17) * 0.9); }

float cave(vec3 p) {
  vec2 c = path(p.z);
  vec3 q = p - vec3(c, 0.0);
  float tube = 1.7 - length(q.xy);
  float wobble = dot(sin(p * (0.9 + 0.2 * uVariant)), cos(p.yzx * 1.3)) * 0.35;
  return tube + wobble;
}

// Crystals: octahedra on a grid, kept near the cave wall.
float crystal(vec3 p, out vec3 cell) {
  vec3 s = vec3(1.6, 1.6, 1.9);
  cell = floor(p / s);
  vec3 q = mod(p, s) - s * 0.5;
  float r = hash31(cell);
  q.xy *= mat2(cos(r * 6.0), -sin(r * 6.0), sin(r * 6.0), cos(r * 6.0));
  float size = 0.14 + 0.3 * r;
  return (abs(q.x) + abs(q.y) * 0.6 + abs(q.z)) * 0.577 - size;
}

float map(vec3 p, out float id, out vec3 cell) {
  // Distance to the cave wall from inside the passage.
  float d = cave(p);
  float k = crystal(p, cell);
  // Only crystals that grow out of the wall.
  k = max(k, d - 0.35);
  id = k < d ? 1.0 : 0.0;
  return min(d, k);
}

vec3 normalAt(vec3 p) {
  float id; vec3 cell;
  vec2 e = vec2(0.01, 0.0);
  return normalize(vec3(
    map(p + e.xyy, id, cell) - map(p - e.xyy, id, cell),
    map(p + e.yxy, id, cell) - map(p - e.yxy, id, cell),
    map(p + e.yyx, id, cell) - map(p - e.yyx, id, cell)));
}

void main() {
  float aspect = uRes.x / uRes.y;
  vec2 q = (vUv - 0.5) * vec2(aspect, 1.0);
  float z = uFly;
  vec3 ro = vec3(path(z), z);
  vec3 ahead = vec3(path(z + 1.5), z + 1.5);
  vec3 fw = normalize(ahead - ro);
  vec3 rt = normalize(cross(vec3(0.0, 1.0, 0.0), fw));
  vec3 up = cross(fw, rt);
  vec3 rd = normalize(fw * (1.2 - 0.1 * pulse()) + rt * q.x + up * q.y);

  float t = 0.05;
  float id = 0.0;
  vec3 cell = vec3(0.0);
  bool hit = false;
  int steps = int(uSteps);
  for (int i = 0; i < 96; i++) {
    if (i >= steps) break;
    vec3 p = ro + rd * t;
    float d = map(p, id, cell);
    if (d < 0.002 * t) { hit = true; break; }
    t += d * 0.85;
    if (t > 24.0) break;
  }
  vec3 col = vec3(0.0);
  vec3 fogCol = uPal[3] * 0.08;
  if (hit) {
    vec3 p = ro + rd * t;
    vec3 n = normalAt(p);
    // A lantern travels with you; it flashes with the kick.
    vec3 l = normalize(ro + fw * 0.5 - p);
    float diff = max(dot(n, l), 0.0);
    float lantern = (0.6 + 1.5 * pulse()) / (1.0 + t * t * 0.08);
    if (id > 0.5) {
      float band = fract(hash31(cell) * 7.3);
      float level = spectrumAt(0.03 + band * 0.85);
      vec3 tint = pal(band + 0.3 * colourDrive());
      float glow = 0.45 + 2.6 * level * level;
      col = tint * (glow + diff * lantern * 0.6);
      float spec = pow(max(dot(reflect(-l, n), -rd), 0.0), 40.0);
      col += vec3(1.0) * spec * (0.3 + 2.0 * sparkle());
    } else {
      vec3 rock = mix(vec3(0.09, 0.08, 0.11), uPal[3] * 0.25, 0.4) * (0.6 + 0.4 * hash31(floor(p * 4.0)));
      col = rock * (0.18 + 1.4 * diff * lantern) + uPal[1] * 0.04 * lowDrive();
    }
    col = mix(col, fogCol, smoothstep(6.0, 22.0, t));
  } else {
    col = fogCol;
  }
  col += pal(0.1) * exp(-length(q) * 3.5) * 0.08 * (lowDrive() + pulse());
  o = vec4(col, 1.0);
}`;

export default defineVisualizer({
  id: 'cavern',
  name: 'Crystal Cavern',
  family: '3d',
  order: 145,
  description: 'Fly through a cave whose crystals each glow with their own band; a drop takes a new passage.',
  create(ctx) {
    const { gl } = ctx;
    const program = new Program(gl, FULLSCREEN_VS, FS);
    const scene = new BloomScene(gl, ctx.hdr, { scale: 0.6 });
    let fly = 0;
    return {
      resize(width, height) {
        scene.resize(width, height);
      },
      render(frame) {
        const a = frame.audio;
        fly += frame.dt * (0.8 + 1.4 * a.energy + 1.6 * Math.max(a.kick, a.beatPulse * 0.6));
        scene.begin();
        program.use().set({
          ...commonUniforms(frame),
          uRes: [scene.scene.width, scene.scene.height],
          uFly: fly,
          uSteps: Math.round(40 + 56 * ctx.quality),
          uVariant: a.dropCount % 4,
        });
        drawFullscreen(gl);
        scene.end(frame, { threshold: 0.5, knee: 0.45, intensity: 1.0, vignette: 0.45, exposure: 1.15 });
      },
      dispose() {
        program.dispose();
        scene.dispose();
      },
    };
  },
});
