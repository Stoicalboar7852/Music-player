// Ferrofluid: a glossy black drop of magnetic fluid that grows a spike for
// each band of the spectrum. Kicks make every spike surge, the bassline
// makes the drop breathe and turn, the vocals tint the studio lights it
// reflects, hi-hats glint along its edges, and the beat flashes a light
// across it. Each drop of the song turns it to a new face.

import { COLOR, COMMON_UNIFORMS, FS_HEADER, HASH, PALETTE, RHYTHM } from '../../gl/glsl';
import { drawFullscreen, FULLSCREEN_VS, Program } from '../../gl/util';
import { bindOutput, commonUniforms, defineVisualizer } from '../types';

const SPIKES = 32;

const FS = /* glsl */ `${FS_HEADER}
in vec2 vUv; out vec4 o;
${COMMON_UNIFORMS}
${RHYTHM}
uniform vec3 uDirs[${SPIKES}];
uniform float uHeights[${SPIKES}];
uniform mat3 uRot;
uniform float uBreath;
uniform float uBound;        // radius of a sphere that contains every spike
${HASH}
${COLOR}
${PALETTE}

float map(vec3 p) {
  vec3 q = uRot * p;
  float r = length(q);
  // Outside every spike: no need to look at them.
  if (r > uBound + 0.05) return r - uBound;
  vec3 n = q / max(r, 1e-4);
  float spike = 0.0;
  for (int i = 0; i < ${SPIKES}; i++) {
    float c = dot(n, uDirs[i]);
    // Angle from the spike's axis (small-angle form), so the spike is a sharp cone.
    float ang = sqrt(max(0.0, 2.0 * (1.0 - c)));
    float s = max(0.0, 1.0 - ang / 0.3);
    spike = max(spike, s * sqrt(s) * uHeights[i]);
  }
  float base = 0.58 + 0.03 * uBreath * sin(q.y * 5.0 + uTime * 2.0);
  return (r - base - spike) * 0.32;
}

vec3 normalAt(vec3 p) {
  const vec2 k = vec2(1.0, -1.0);
  float e = 0.002;
  return normalize(k.xyy * map(p + k.xyy * e) + k.yyx * map(p + k.yyx * e) + k.yxy * map(p + k.yxy * e) + k.xxx * map(p + k.xxx * e));
}

// A studio around the drop: a dark room with soft light panels.
vec3 studio(vec3 d) {
  vec3 col = mix(vec3(0.01, 0.01, 0.015), vec3(0.04, 0.04, 0.05), d.y * 0.5 + 0.5);
  vec3 key = mix(vec3(1.0), pal(0.1), 0.25 + 0.5 * colourDrive());
  vec3 rim = mix(vec3(0.6, 0.7, 1.0), pal(0.6), 0.5);
  col += key * smoothstep(0.75, 0.95, dot(d, normalize(vec3(-0.6, 0.6, 0.5)))) * 2.2;
  col += rim * smoothstep(0.85, 0.98, dot(d, normalize(vec3(0.8, 0.1, -0.4)))) * 1.6;
  col += key * smoothstep(0.02, 0.0, abs(d.y - 0.75)) * 0.6;
  // A sweep of light on the beat.
  col += vec3(1.0) * smoothstep(0.9, 1.0, dot(d, normalize(vec3(sin(uTime), 0.3, cos(uTime))))) * onBeat(0.3) * pulse() * 2.0;
  return col;
}

void main() {
  vec2 uv = (gl_FragCoord.xy - 0.5 * uRes) / uRes.y;
  vec3 ro = vec3(0.0, 0.05, 2.6);
  vec3 rd = normalize(vec3(uv, -1.55));

  vec3 col = mix(vec3(0.015, 0.012, 0.02), pal(0.6) * 0.06, 1.0 - length(uv));
  col += pal(0.1) * exp(-length(uv) * 3.0) * 0.08 * (1.0 + 2.0 * pulse());

  // March only inside the bounding sphere.
  float b = dot(ro, rd);
  float disc = b * b - (dot(ro, ro) - uBound * uBound);
  float hit = -1.0;
  if (disc > 0.0) {
    float t = max(0.0, -b - sqrt(disc));
    float tEnd = -b + sqrt(disc);
    for (int i = 0; i < 80; i++) {
      vec3 p = ro + rd * t;
      float d = map(p);
      if (d < 0.0008) { hit = t; break; }
      t += d;
      if (t > tEnd) break;
    }
  }
  if (hit > 0.0) {
    vec3 p = ro + rd * hit;
    vec3 n = normalAt(p);
    vec3 refl = reflect(rd, n);
    float fres = 0.04 + 0.96 * pow(1.0 - max(dot(-rd, n), 0.0), 5.0);
    vec3 surface = vec3(0.004) + studio(refl) * (0.25 + 0.75 * fres);
    // Glints along the edges with the hi-hats.
    float edge = pow(1.0 - max(dot(-rd, n), 0.0), 3.0);
    vec3 cell = floor(p * 60.0);
    float glint = step(0.985, hash31(cell + floor(uTime * 12.0))) * smoothstep(0.5, 0.0, length(fract(p * 60.0) - 0.5));
    surface += vec3(0.9, 0.95, 1.0) * edge * sparkle() * glint * 3.0;
    surface += vec3(0.6, 0.7, 0.9) * edge * sparkle() * 0.15;
    col = surface;
  }
  // A soft reflection on the floor under it.
  col += pal(0.6) * 0.04 * smoothstep(-0.25, -0.45, uv.y) * smoothstep(0.6, 0.0, abs(uv.x));

  vec2 c = vUv - 0.5;
  col *= 1.0 - 0.6 * dot(c, c);
  o = vec4(aces(col * 1.2), 1.0);
}`;

/** Spike directions spread evenly over a sphere (a Fibonacci lattice). */
function directions(count: number): Float32Array {
  const out = new Float32Array(count * 3);
  const golden = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < count; i++) {
    const y = 1 - (i / (count - 1)) * 2;
    const r = Math.sqrt(1 - y * y);
    const a = golden * i;
    out.set([Math.cos(a) * r, y, Math.sin(a) * r], i * 3);
  }
  return out;
}

export default defineVisualizer({
  id: 'ferro',
  name: 'Ferrofluid',
  family: '3d',
  order: 230,
  description: 'A glossy drop of magnetic fluid with a spike for each band of the spectrum; kicks make every spike surge.',
  create(ctx) {
    const { gl } = ctx;
    const program = new Program(gl, FULLSCREEN_VS, FS);
    const dirs = directions(SPIKES);
    const heights = new Float32Array(SPIKES);
    // Each spike listens to a band; neighbours on the sphere get unrelated bands.
    const order = Array.from({ length: SPIKES }, (_, i) => i);
    for (let i = SPIKES - 1; i > 0; i--) {
      const j = Math.floor(ctx.random() * (i + 1));
      [order[i], order[j]] = [order[j], order[i]];
    }
    const rot = new Float32Array(9);
    let yaw = 0;
    let pitch = 0.3;
    let surge = 0;
    let breath = 0;
    return {
      resize() {},
      render(frame) {
        const a = frame.audio;
        const dt = Math.min(frame.dt, 0.05);
        const low = Math.max(a.bassline, a.bass * 0.5);
        surge = Math.max(surge * Math.exp(-dt * 6), Math.max(a.kick, a.beatPulse * 0.85));
        breath += (low - breath) * Math.min(1, dt * 3);
        const spectrum = a.spectrum;
        for (let i = 0; i < SPIKES; i++) {
          const band = order[i];
          const from = Math.floor((band / SPIKES) * spectrum.length * 0.9);
          const to = Math.max(from + 1, Math.floor(((band + 1) / SPIKES) * spectrum.length * 0.9));
          let level = 0;
          for (let b = from; b < to; b++) level = Math.max(level, spectrum[b]);
          const target = 0.03 + level * 0.36 + surge * 0.16;
          heights[i] += (target - heights[i]) * Math.min(1, dt * (target > heights[i] ? 14 : 5));
        }
        yaw += dt * (0.15 + 0.5 * low);
        pitch += (0.3 + (a.dropCount % 4) * 0.5 - pitch) * Math.min(1, dt * 0.8);
        const cy = Math.cos(yaw), sy = Math.sin(yaw), cp = Math.cos(pitch), sp = Math.sin(pitch);
        // Rotation about y, then x (column-major for GLSL).
        rot.set([cy, sy * sp, -sy * cp, 0, cp, sp, sy, -cy * sp, cy * cp]);
        bindOutput(gl, frame);
        let tallest = 0;
        for (let i = 0; i < SPIKES; i++) tallest = Math.max(tallest, heights[i]);
        program.use().set({ ...commonUniforms(frame), uDirs: dirs, uHeights: heights, uRot: rot, uBreath: breath, uBound: 0.62 + tallest + 0.02 });
        drawFullscreen(gl);
      },
      dispose() {
        program.dispose();
      },
    };
  },
});
