// Lava Lamp: wax blobs rising and falling in a glowing lamp. Each blob's size
// follows a band of the spectrum, kicks heat the lamp so every blob swells
// and the glow brightens, the bassline sets how fast the wax climbs, the
// vocals shift its colour, hi-hats send bubbles up through the liquid, and
// the beat flashes the glass. Each drop stirs the wax up from the bottom.

import { COLOR, COMMON_UNIFORMS, FS_HEADER, HASH, PALETTE, RHYTHM } from '../../gl/glsl';
import { drawFullscreen, FULLSCREEN_VS, Program } from '../../gl/util';
import { bindOutput, commonUniforms, defineVisualizer } from '../types';

const BLOBS = 10;

const FS = /* glsl */ `${FS_HEADER}
in vec2 vUv; out vec4 o;
${COMMON_UNIFORMS}
${RHYTHM}
uniform vec3 uBlobs[${BLOBS}];   // x (from the lamp's centre), y, radius
uniform float uHeat;
${HASH}
${COLOR}
${PALETTE}

const float BOTTOM = 0.17;
const float TOP = 0.84;

// Half-width of the glass at height y: wide at the bottom, narrowing upward.
float glassWidth(float y) {
  float t = clamp((y - BOTTOM) / (TOP - BOTTOM), 0.0, 1.0);
  return mix(0.15, 0.075, smoothstep(0.15, 1.0, t)) + 0.02 * sin(t * 3.1416);
}

float field(vec2 q) {
  float f = 0.0;
  for (int i = 0; i < ${BLOBS}; i++) {
    vec3 b = uBlobs[i];
    vec2 d = q - b.xy;
    f += b.z * b.z / (dot(d, d) + 1e-4);
  }
  return f;
}

void main() {
  float aspect = uRes.x / uRes.y;
  vec2 p = vec2((vUv.x - 0.5) * aspect, vUv.y);
  vec3 lava = mix(pal(0.0 + 0.3 * colourDrive()), vec3(1.0, 0.35, 0.15), 0.35);
  vec3 liquid = mix(pal(0.55), vec3(0.15, 0.05, 0.3), 0.5);

  // The room, lit by the lamp.
  float glow = exp(-length(p - vec2(0.0, 0.5)) * 2.5) * (0.25 + 0.5 * uHeat);
  vec3 col = vec3(0.012, 0.01, 0.018) + lava * glow * 0.35;

  float w = glassWidth(p.y);
  float inGlass = step(BOTTOM, p.y) * step(p.y, TOP) * smoothstep(w + 0.002, w - 0.002, abs(p.x));
  if (inGlass > 0.0) {
    vec3 inside = liquid * (0.35 + 0.4 * uHeat) * (0.8 + 0.4 * (1.0 - abs(p.x) / w));
    float f = field(p);
    if (f > 1.0) {
      // Wax: shaded from the field's slope, glowing at its heart.
      vec2 e = vec2(0.003, 0.0);
      vec2 grad = vec2(field(p + e.xy) - field(p - e.xy), field(p + e.yx) - field(p - e.yx));
      vec3 n = normalize(vec3(-grad * 0.02, 1.0));
      float light = 0.55 + 0.45 * max(dot(n, normalize(vec3(-0.4, 0.5, 0.75))), 0.0);
      vec3 wax = lava * light * (0.8 + 0.6 * uHeat) + lava * smoothstep(1.0, 4.0, f) * 0.4;
      wax += vec3(1.0, 0.9, 0.8) * pow(max(dot(reflect(vec3(0.0, 0.0, -1.0), n), normalize(vec3(-0.4, 0.5, 0.75))), 0.0), 20.0) * 0.6;
      inside = mix(inside, wax, smoothstep(1.0, 1.15, f));
    }
    // Bubbles rising with the hi-hats.
    vec2 g = vec2(p.x * 40.0, p.y * 25.0 - uTime * 3.0);
    vec2 id = floor(g);
    vec2 bf = fract(g) - 0.5;
    float bubble = smoothstep(0.2, 0.1, length(bf)) * step(0.86, hash21(id + floor(uTime * 2.0)));
    inside += vec3(0.8, 0.9, 1.0) * bubble * sparkle() * 1.4;
    inside += vec3(0.5, 0.6, 0.9) * sparkle() * 0.06;
    // The glass: edges, a highlight streak that flashes on the beat.
    float edge = smoothstep(0.01, 0.0, w - abs(p.x));
    inside += vec3(0.6, 0.7, 0.9) * edge * 0.3;
    float streak = smoothstep(0.012, 0.0, abs(p.x + w * 0.55)) * smoothstep(TOP, BOTTOM + 0.2, p.y);
    inside += vec3(1.0) * streak * (0.1 + 0.5 * onBeat(0.3) * pulse());
    col = mix(col, inside, inGlass);
  }

  // Metal base and cap.
  float baseW = mix(0.19, 0.13, smoothstep(0.03, BOTTOM, p.y));
  float base = step(0.03, p.y) * step(p.y, BOTTOM) * step(abs(p.x), baseW);
  float capW = mix(0.08, 0.05, smoothstep(TOP, 0.93, p.y));
  float cap = step(TOP, p.y) * step(p.y, 0.93) * step(abs(p.x), capW);
  vec3 metal = vec3(0.12, 0.12, 0.14) + vec3(0.25) * pow(1.0 - abs(p.x) / max(baseW, 0.01), 3.0) * 0.4;
  col = mix(col, metal + lava * 0.08 * uHeat, max(base, cap));
  col += lava * smoothstep(0.004, 0.0, abs(p.y - BOTTOM)) * step(abs(p.x), 0.15) * (0.4 + uHeat);

  vec2 c = vUv - 0.5;
  col *= 1.0 - 0.7 * dot(c, c);
  o = vec4(aces(col * 1.3), 1.0);
}`;

interface Blob {
  x: number;
  y: number;
  vy: number;
  phase: number;
  band: number;
  size: number;
}

export default defineVisualizer({
  id: 'lavalamp',
  name: 'Lava Lamp',
  family: 'retro',
  order: 240,
  description: 'Wax rising and falling in a glowing lamp: each blob is a band of the spectrum, kicks heat the lamp, bubbles rise with the hi-hats.',
  create(ctx) {
    const { gl } = ctx;
    const program = new Program(gl, FULLSCREEN_VS, FS);
    const data = new Float32Array(BLOBS * 3);
    const blobs: Blob[] = Array.from({ length: BLOBS }, (_, i) => ({
      x: (ctx.random() - 0.5) * 0.12,
      y: 0.2 + ctx.random() * 0.6,
      vy: 0,
      phase: ctx.random() * 6.28,
      band: i / BLOBS,
      size: 0.03,
    }));
    let heat = 0;
    let lastDrop = 0;
    return {
      resize() {},
      render(frame) {
        const a = frame.audio;
        const dt = Math.min(frame.dt, 0.05);
        heat = Math.max(heat * Math.exp(-dt * 3), Math.max(a.kick, a.beatPulse * 0.8));
        const low = Math.max(a.bassline, a.bass * 0.5);
        if (a.dropCount !== lastDrop) {
          lastDrop = a.dropCount;
          for (const b of blobs) b.vy = 0.25 + ctx.random() * 0.2;
        }
        const spectrum = a.spectrum;
        blobs.forEach((b, i) => {
          // Warm wax rises, cooled wax sinks; the bassline speeds the cycle.
          b.phase += dt * (0.25 + 0.6 * low) * (0.7 + 0.6 * ((i * 0.37) % 1));
          const target = 0.5 + 0.3 * Math.sin(b.phase);
          b.vy += (target - b.y) * dt * 1.5;
          b.vy *= Math.exp(-dt * 1.2);
          b.y = Math.min(0.8, Math.max(0.2, b.y + b.vy * dt));
          b.x = Math.sin(b.phase * 0.7 + i) * 0.05;
          const index = Math.floor(b.band * spectrum.length * 0.85);
          const level = Math.max(spectrum[index] ?? 0, spectrum[index + 1] ?? 0);
          const size = 0.02 + 0.028 * level + 0.012 * heat;
          b.size += (size - b.size) * Math.min(1, dt * 8);
          data.set([b.x, b.y, b.size], i * 3);
        });
        bindOutput(gl, frame);
        program.use().set({ ...commonUniforms(frame), uBlobs: data, uHeat: heat });
        drawFullscreen(gl);
      },
      dispose() {
        program.dispose();
      },
    };
  },
});
