// Pastel Horizon: a painterly alien meadow under a huge ringed planet.
// Long-legged machines walk the middle distance; their footfalls land on the
// kicks and their lamps flash on the beat. The grass in front is an
// equalizer (bass on the left, treble on the right) and the bassline is the
// wind moving through it. The vocals warm the sky and light the planet's
// rim, hi-hats make the drifting pollen glint, and each drop sweeps a band
// of light across the land. An original scene in the spirit of painterly
// adventure games.

import { COLOR, COMMON_UNIFORMS, FS_HEADER, HASH, NOISE, PALETTE, RHYTHM } from '../../gl/glsl';
import { drawFullscreen, FULLSCREEN_VS, Program } from '../../gl/util';
import { bindOutput, commonUniforms, defineVisualizer } from '../types';

const FS = /* glsl */ `${FS_HEADER}
in vec2 vUv; out vec4 o;
${COMMON_UNIFORMS}
${RHYTHM}
uniform float uScroll;
uniform float uWalk;
uniform float uThump;
uniform float uWind;
uniform float uSweep;
uniform float uScene;
${HASH}
${NOISE}
${COLOR}
${PALETTE}

float spectrumAt(float x) { return texture(uSpectrum, vec2(clamp(x, 0.0, 1.0), 0.5)).r; }

float segment(vec2 p, vec2 a, vec2 b) {
  vec2 pa = p - a, ba = b - a;
  float t = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0);
  return length(pa - ba * t);
}

// One walking machine: a lantern-bodied hull on four jointed legs. Returns
// coverage in x and lamp glow in y.
vec2 walker(vec2 p, float x0, float scale, float phase) {
  float bob = abs(sin(phase)) * 0.012 * scale;
  vec2 body = vec2(x0, 0.43 * scale + 0.3 * (1.0 - scale) + bob);
  vec2 q = (p - body) / scale;
  float hull = length(q * vec2(1.0, 1.7)) - 0.055;
  float cover = smoothstep(0.004, -0.004, hull);
  float glow = 0.0;
  for (int i = 0; i < 4; i++) {
    float fi = float(i);
    float side = fi < 2.0 ? -1.0 : 1.0;
    float ph = phase + fi * 1.5708;
    float stride = 0.06 * sin(ph);
    float lift = max(0.0, cos(ph)) * 0.02;
    vec2 hip = vec2(side * 0.03 + (fi - 1.5) * 0.008, -0.02);
    vec2 foot = vec2(side * 0.07 + stride, -0.23 + lift);
    vec2 knee = (hip + foot) * 0.5 + vec2(side * 0.035, 0.045);
    float leg = min(segment(q, hip, knee), segment(q, knee, foot));
    cover = max(cover, smoothstep(0.006, 0.002, leg));
  }
  // Lamps along the hull.
  for (int k = 0; k < 3; k++) {
    vec2 lamp = vec2(-0.03 + 0.03 * float(k), 0.008);
    glow += exp(-dot(q - lamp, q - lamp) * 5000.0);
  }
  return vec2(cover, glow);
}

void main() {
  float aspect = uRes.x / uRes.y;
  vec2 p = vec2(vUv.x * aspect, vUv.y);
  float scene = mod(uScene, 3.0);
  float shake = uThump * 0.006 * sin(uTime * 60.0);

  // ---- sky
  vec3 top = mix(vec3(0.32, 0.42, 0.7), pal(0.6) * 0.8, 0.35);
  vec3 low = mix(vec3(1.0, 0.78, 0.62), pal(0.05), 0.3);
  vec3 col = mix(low, top, smoothstep(0.25, 1.0, p.y));
  col = mix(col, low * 1.15 + pal(0.0) * 0.1, (0.15 + 0.6 * colourDrive()) * (1.0 - smoothstep(0.25, 0.7, p.y)));

  // ---- the ringed planet, and two moons
  vec2 pc = vec2(aspect * 0.68, 0.66);
  vec2 d = p - pc;
  float r = length(d);
  float R = 0.27;
  vec3 planetCol = mix(vec3(0.95, 0.82, 0.78), pal(0.2), 0.4);
  float bands = 0.5 + 0.5 * sin(d.y * 42.0 + 3.0 * fbm(d * 6.0));
  vec3 planet = planetCol * (0.75 + 0.25 * bands);
  float lit = clamp(dot(normalize(vec3(d / R, sqrt(max(0.0, 1.0 - dot(d, d) / (R * R))))), normalize(vec3(-0.5, 0.4, 0.75))), 0.0, 1.0);
  planet *= 0.45 + 0.65 * lit;
  float rim = smoothstep(R - 0.03, R, r) * (0.3 + 1.2 * colourDrive());
  planet += low * rim;
  float inPlanet = smoothstep(R + 0.002, R - 0.002, r);
  col = mix(col, mix(planet, col, 0.25), inPlanet);
  vec2 ringQ = vec2(d.x, (d.y + d.x * 0.18) * 4.2);
  float ring = smoothstep(0.012, 0.0, abs(length(ringQ) - 0.43)) + 0.6 * smoothstep(0.008, 0.0, abs(length(ringQ) - 0.37));
  float front = step(0.0, -(d.y + d.x * 0.18)) + (1.0 - inPlanet);
  col = mix(col, planetCol * 1.1, clamp(ring * 0.7 * min(front, 1.0), 0.0, 1.0));
  for (int m = 0; m < 2; m++) {
    vec2 mc = vec2(aspect * (0.18 + 0.17 * float(m)), 0.84 - 0.08 * float(m));
    col = mix(col, vec3(0.97, 0.94, 0.9), smoothstep(0.022 - 0.008 * float(m), 0.018 - 0.008 * float(m), length(p - mc)) * 0.85);
  }

  // ---- drifting clouds
  float cl = fbm(vec2(p.x * 1.4 - uTime * 0.01 - uScroll * 0.05, p.y * 5.0));
  col = mix(col, mix(vec3(1.0, 0.95, 0.92), low, 0.3), smoothstep(0.55, 0.85, cl) * smoothstep(0.45, 0.75, p.y) * 0.55);

  // ---- far hills
  float h1 = 0.34 + 0.07 * fbm(vec2(p.x * 1.1 + uScroll * 0.08, 2.0 + scene));
  vec3 far = mix(col, mix(pal(0.45), vec3(0.45, 0.55, 0.65), 0.5), 0.55);
  col = mix(col, far, smoothstep(0.003, -0.003, p.y - h1));

  // ---- the walkers, in the middle distance
  for (int w = 0; w < 3; w++) {
    float fw = float(w);
    float scale = 0.55 + 0.25 * fw;
    float span = aspect + 0.8;
    float x0 = mod(0.3 + fw * 0.9 - uScroll * (0.12 + 0.06 * fw), span) - 0.4;
    vec2 wk = walker(p + vec2(0.0, shake), x0, scale, uWalk + fw * 2.1);
    vec3 hull = mix(col, vec3(0.12, 0.13, 0.2), 0.55 + 0.15 * fw);
    col = mix(col, hull, wk.x);
    col += pal(0.12 + 0.2 * fw) * wk.y * (0.4 + 2.4 * pulse() + 1.2 * onBeat(0.25));
    col += pal(0.12 + 0.2 * fw) * wk.x * onBeat(0.3) * pulse() * 0.25;
  }

  // ---- near hills (they shake on a footfall)
  float py = p.y + shake;
  float h2 = 0.23 + 0.08 * fbm(vec2(p.x * 1.5 + uScroll * 0.3, 7.0 + scene));
  vec3 nearHill = mix(vec3(0.2, 0.38, 0.3), pal(0.3) * 0.6, 0.35);
  col = mix(col, nearHill, smoothstep(0.003, -0.003, py - h2));

  // ---- grass: an equalizer, swaying in the bassline's wind
  float gx = p.x * 90.0;
  for (int k = -1; k <= 1; k++) {
    float cell = floor(gx) + float(k);
    float base = (cell + 0.5 + (hash11(cell) - 0.5) * 0.6) / 90.0;
    float band = clamp(base / aspect, 0.0, 1.0);
    float H = 0.05 + 0.03 * hash11(cell * 1.3) + 0.2 * spectrumAt(0.02 + band * 0.92);
    float t = clamp(py / H, 0.0, 1.0);
    float sway = (uWind * 0.05 + 0.01) * sin(uTime * 2.1 + base * 6.0 + hash11(cell) * 3.0) * t * t;
    float bx = base + sway;
    float width = 0.0028 * (1.0 - t);
    float blade = step(py, H) * smoothstep(width, width * 0.4, abs(p.x - bx));
    vec3 grass = mix(vec3(0.08, 0.2, 0.12), pal(0.3) * 0.7 + vec3(0.2, 0.35, 0.15), t);
    col = mix(col, grass, blade);
  }

  // ---- pollen drifting up, glinting with the hi-hats
  vec2 g = vec2(p.x * 9.0 - uScroll, p.y * 6.0 - uTime * 0.15);
  vec2 id = floor(g);
  vec2 f = fract(g) - 0.5;
  float h = hash21(id);
  vec2 pos = 0.3 * vec2(sin(uTime * 0.7 + h * 6.28), cos(uTime * 0.5 + h * 4.0));
  float glint = 0.3 + 1.6 * sparkle() * step(0.45, hash21(id + floor(uTime * 8.0)));
  col += vec3(1.0, 0.97, 0.85) * exp(-dot(f - pos, f - pos) * 1500.0) * glint * step(0.4, h);

  // ---- a drop sweeps light across the land
  float sweep = smoothstep(0.12, 0.0, abs(p.x - p.y * 0.4 - (uSweep * (aspect + 0.8) - 0.4)));
  col += low * sweep * 0.6 * step(0.001, uSweep) * (1.0 - uSweep);

  vec2 c = vUv - 0.5;
  col *= 1.0 - 0.55 * dot(c, c);
  o = vec4(col, 1.0);
}`;

export default defineVisualizer({
  id: 'meadow',
  name: 'Pastel Horizon',
  family: 'games',
  order: 310,
  description: 'A painterly meadow under a ringed planet: walking machines step on the kicks, the grass is an equalizer blowing in the bassline.',
  create(ctx) {
    const { gl } = ctx;
    const program = new Program(gl, FULLSCREEN_VS, FS);
    let scroll = 0;
    let walk = 0;
    let thump = 0;
    let wind = 0;
    let sweep = 0;
    let sweepFor = -1;
    return {
      resize() {},
      render(frame) {
        const a = frame.audio;
        const dt = Math.min(frame.dt, 0.05);
        scroll += dt * (0.05 + 0.08 * a.energy);
        // Footfalls: the walk cycle hurries into each kick.
        walk += dt * (1.2 + 2.5 * a.energy) + (a.kickHit ? 0.6 : 0);
        thump = Math.max(thump * Math.exp(-dt * 7), Math.max(a.kick, a.beatPulse * 0.7));
        wind += (Math.max(a.bassline, a.bass * 0.6) - wind) * Math.min(1, dt * 2.5);
        if (a.dropCount !== sweepFor) {
          if (sweepFor >= 0) sweep = 0.0001;
          sweepFor = a.dropCount;
        }
        if (sweep > 0) sweep = sweep >= 1 ? 0 : Math.min(1, sweep + dt * 0.5);
        bindOutput(gl, frame);
        program.use().set({ ...commonUniforms(frame), uScroll: scroll, uWalk: walk, uThump: thump, uWind: wind, uSweep: sweep, uScene: a.dropCount });
        drawFullscreen(gl);
      },
      dispose() {
        program.dispose();
      },
    };
  },
});
