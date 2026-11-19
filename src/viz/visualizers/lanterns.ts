// Lantern Depths: a hand-drawn underground kingdom seen side-on, in layers
// of silhouette that drift past at different depths. Lanterns hang from the
// ceiling on chains: kicks make them flare and shake dust from the rock, the
// bassline swings them and stirs the mist, the vocals open shafts of light
// from cracks above, hi-hats make the fireflies blink, and crystal veins in
// the far wall glow with the spectrum. Each drop moves on to a new chamber.
// An original scene in the spirit of atmospheric cave-exploring games.

import { COLOR, COMMON_UNIFORMS, FS_HEADER, HASH, NOISE, PALETTE, RHYTHM } from '../../gl/glsl';
import { drawFullscreen, FULLSCREEN_VS, Program } from '../../gl/util';
import { bindOutput, commonUniforms, defineVisualizer } from '../types';

const FS = /* glsl */ `${FS_HEADER}
in vec2 vUv; out vec4 o;
${COMMON_UNIFORMS}
${RHYTHM}
uniform float uScroll;
uniform float uScene;
uniform float uDustAge;
uniform float uSwing;
${HASH}
${NOISE}
${COLOR}
${PALETTE}

float spectrumAt(float x) { return texture(uSpectrum, vec2(clamp(x, 0.0, 1.0), 0.5)).r; }

// Rock outline for a layer: how far the ceiling hangs down and the floor rises at x.
float ceilingAt(float x, float seed) {
  float h = 0.1 + 0.2 * fbm(vec2(x * 0.7, seed * 3.1));
  float cell = floor(x * 5.0);
  float u = fract(x * 5.0);
  float len = hash11(cell + seed * 17.0);
  len = len * len * 0.28;
  h += len * pow(max(0.0, 1.0 - abs(u - 0.5) * 2.0), 1.6);
  return 1.0 - h;
}
float floorAt(float x, float seed) {
  float h = 0.08 + 0.17 * fbm(vec2(x * 0.6, seed * 5.7 + 4.0));
  float cell = floor(x * 3.5 + 0.37);
  float u = fract(x * 3.5 + 0.37);
  float len = hash11(cell * 1.7 + seed * 11.0);
  len = len * len * len * 0.22;
  h += len * pow(max(0.0, 1.0 - abs(u - 0.5) * 2.0), 2.0);
  return h;
}

float segment(vec2 p, vec2 a, vec2 b) {
  vec2 pa = p - a, ba = b - a;
  float t = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0);
  return length(pa - ba * t);
}

void main() {
  float aspect = uRes.x / uRes.y;
  vec2 p = vec2(vUv.x * aspect, vUv.y);
  float scene = mod(uScene, 4.0);
  float seed = 1.0 + scene * 2.37;
  // Depth haze: far is lighter, near is darker. A hint of the song's colours.
  vec3 haze = mix(vec3(0.05, 0.1, 0.13), pal(0.55) * 0.14 + vec3(0.02, 0.04, 0.05), 0.3);
  vec3 lanternCol = mix(vec3(1.0, 0.62, 0.25), pal(0.1 + 0.25 * scene), 0.3);
  vec3 crystalCol = mix(vec3(0.45, 0.8, 1.0), pal(0.75 + 0.1 * scene), 0.45);

  // ---- the far wall: soft, hazy rock
  float fx = p.x + uScroll * 0.12;
  float wall = fbm(vec2(fx * 1.8, p.y * 2.2 + seed));
  vec3 col = haze * (0.75 + 0.5 * wall) * (0.7 + 0.3 * smoothstep(0.0, 0.6, p.y));

  // ---- light shafts from cracks in the ceiling (the vocals open them)
  float q = p.x + p.y * 0.42 - uScroll * 0.4 + seed;
  float shafts = pow(max(0.0, sin(q * 2.6)), 14.0) + 0.6 * pow(max(0.0, sin(q * 4.3 + 1.7)), 22.0);
  col += mix(vec3(0.6, 0.85, 1.0), pal(0.6), 0.3) * shafts * smoothstep(0.15, 1.0, p.y) * (0.03 + 0.4 * colourDrive());

  // ---- three layers of rock, back to front, each darker than the one behind
  for (int i = 0; i < 3; i++) {
    float fi = float(i);
    float depth = 0.35 + 0.33 * fi;               // parallax: nearer layers move faster
    float lx = p.x + uScroll * depth + fi * 13.7;
    float ls = seed + fi * 7.3;
    float sx = lx * (1.25 - 0.25 * fi);
    float top = mix(1.1, ceilingAt(sx, ls), 0.5 + 0.28 * fi);
    float bot = mix(-0.1, floorAt(sx, ls), 0.5 + 0.28 * fi);
    float edge = min(p.y - bot, top - p.y);       // negative inside the rock
    vec3 rock = haze * (0.62 - 0.27 * fi);
    if (i == 2) rock = vec3(0.004, 0.006, 0.01);
    float inRock = smoothstep(0.003, -0.003, edge);
    // Lantern light grazing the rock's edge.
    float rim = smoothstep(0.025, 0.0, -edge) * inRock * (0.3 + 0.7 * pulse());
    col = mix(col, rock, inRock);
    col += lanternCol * rim * (0.05 + 0.04 * fi);

    // ---- crystals on the middle layer's ledges, each glowing with a band
    if (i == 1) {
      float cs = 0.23;
      float cc = floor(lx / cs);
      for (int k = -1; k <= 1; k++) {
        float c = cc + float(k);
        if (hash11(c * 5.3 + ls) < 0.45) continue;
        float cx = (c + 0.5) * cs + (hash11(c * 2.1) - 0.5) * 0.08;
        float ground = mix(-0.1, floorAt(cx * (1.25 - 0.25 * fi), ls), 0.5 + 0.28 * fi);
        vec2 d = vec2(lx - cx, p.y - ground);
        float h = 0.03 + 0.04 * hash11(c * 3.7);
        // A crystal: a tall diamond, leaning a little.
        d.x += d.y * (hash11(c) - 0.5) * 0.6;
        float shape = abs(d.x) / (0.012 + 0.006 * hash11(c * 9.0)) + abs(d.y - h * 0.5) / (h * 0.5);
        float screenX = clamp((cx - uScroll * depth - fi * 13.7) / aspect, 0.0, 1.0);
        float level = spectrumAt(0.02 + screenX * 0.92);
        float glowAmt = 0.15 + 1.6 * level;
        col = mix(col, crystalCol * (0.35 + 0.9 * level), smoothstep(1.05, 0.95, shape));
        col += crystalCol * exp(-dot(d - vec2(0.0, h * 0.4), d - vec2(0.0, h * 0.4)) * 400.0) * 0.25 * glowAmt;
      }
    }

    // ---- lanterns on the middle layer, hanging from its ceiling
    if (i == 1) {
      float spacing = 0.62;
      float cell = floor(lx / spacing);
      for (int k = -1; k <= 1; k++) {
        float c = cell + float(k);
        float cx = (c + 0.5) * spacing;
        float h = hash11(c * 3.1 + seed);
        float roof = mix(1.1, ceilingAt(cx * (1.25 - 0.25 * fi), ls), 0.5 + 0.28 * fi);
        float len = 0.1 + 0.18 * h;
        float swing = sin(uTime * (1.1 + 0.4 * h) + c) * (0.06 + uSwing);
        vec2 pivot = vec2(cx, roof);
        vec2 lamp = pivot + len * vec2(sin(swing), -cos(swing));
        vec2 lp = vec2(lx, p.y);
        float chain = segment(lp, pivot, lamp);
        col = mix(col, vec3(0.01), smoothstep(0.0035, 0.001, chain) * 0.9);
        vec2 d = (lp - lamp) * vec2(1.0, 0.8);
        float body = length(d);
        float flare = 0.55 + 1.6 * pulse() + 0.5 * onBeat(0.25);
        col += lanternCol * smoothstep(0.022, 0.014, body) * (1.0 + flare);
        col += lanternCol * exp(-body * body * 90.0) * 0.3 * flare;
        col += lanternCol * exp(-body * 7.0) * 0.06 * flare;
      }
    }
  }

  // ---- dust shaken from the ceiling by a kick
  float dustFade = exp(-uDustAge * 1.4);
  if (dustFade > 0.01) {
    float colId = floor(p.x * 40.0 + uScroll * 20.0);
    float fall = uDustAge * (0.25 + 0.3 * hash11(colId));
    float y = 0.92 - fall - hash11(colId * 2.3) * 0.2;
    float dx = abs(fract(p.x * 40.0 + uScroll * 20.0) - 0.5);
    float speck = smoothstep(0.12, 0.0, dx) * smoothstep(0.012, 0.0, abs(p.y - y));
    col += vec3(0.6, 0.65, 0.7) * speck * dustFade * step(0.55, hash11(colId * 5.1));
  }

  // ---- fireflies, blinking with the hi-hats
  vec2 g = vec2(p.x * 7.0 + uScroll * 3.0, p.y * 5.0);
  vec2 id = floor(g);
  vec2 f = fract(g) - 0.5;
  float h1 = hash21(id + seed);
  vec2 pos = 0.32 * vec2(sin(uTime * 0.6 + h1 * 6.28), cos(uTime * 0.45 + h1 * 9.1));
  float dfly = length(f - pos);
  float blink = 0.2 + 0.35 * sin(uTime * 2.0 + h1 * 30.0) + 1.8 * sparkle() * step(0.5, hash21(id + floor(uTime * 9.0)));
  col += mix(vec3(0.75, 1.0, 0.5), pal(0.35), 0.3) * exp(-dfly * dfly * 1100.0) * max(blink, 0.0) * step(0.4, h1);

  // ---- mist along the floor, stirred by the bassline
  float m = fbm(vec2(p.x * 1.6 - uTime * 0.05 + uScroll, p.y * 4.0 + uTime * 0.03));
  float mistAmount = smoothstep(0.4, 0.0, p.y) * (0.2 + 0.55 * lowDrive()) * m;
  col = mix(col, haze * 1.6 + lanternCol * 0.04, clamp(mistAmount, 0.0, 0.75));

  vec2 c = vUv - 0.5;
  col *= 1.0 - 1.1 * dot(c, c);
  o = vec4(aces(col * 1.35), 1.0);
}`;

export default defineVisualizer({
  id: 'lanterns',
  name: 'Lantern Depths',
  family: 'games',
  order: 300,
  description: 'An underground kingdom in drifting silhouettes: lanterns flare on kicks and swing with the bass, light shafts follow the vocals.',
  create(ctx) {
    const { gl } = ctx;
    const program = new Program(gl, FULLSCREEN_VS, FS);
    let scroll = 0;
    let dustAge = 99;
    let swing = 0;
    return {
      resize() {},
      render(frame) {
        const a = frame.audio;
        const dt = Math.min(frame.dt, 0.05);
        scroll += dt * (0.025 + 0.05 * a.energy);
        if (a.kickHit) dustAge = 0;
        dustAge += dt;
        // The swing builds with the bassline and settles slowly.
        const target = 0.05 + 0.4 * Math.max(a.bassline, a.bass * 0.5);
        swing += (target - swing) * Math.min(1, dt * (target > swing ? 3 : 0.8));
        bindOutput(gl, frame);
        program.use().set({ ...commonUniforms(frame), uScroll: scroll, uScene: a.dropCount, uDustAge: dustAge, uSwing: swing });
        drawFullscreen(gl);
      },
      dispose() {
        program.dispose();
      },
    };
  },
});
