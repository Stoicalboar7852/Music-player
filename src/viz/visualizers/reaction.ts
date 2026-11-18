// Reaction-Diffusion: two chemicals feeding on and spreading into each other
// (the Gray-Scott model), growing coral, cells, worms or mazes. Kicks drop new
// seeds that grow outward, snares smaller ones, hi-hats a fine spray; vocals
// and the bassline nudge the reaction's rates so the growth changes character,
// and each drop switches to a different kind of growth.

import { COLOR, COMMON_UNIFORMS, FS_HEADER, HASH, PALETTE, RHYTHM } from '../../gl/glsl';
import { bindTexture, drawFullscreen, FULLSCREEN_VS, PingPong, Program } from '../../gl/util';
import { bindOutput, commonUniforms, defineVisualizer } from '../types';

const SEEDS = 8;

const STEP_FS = /* glsl */ `${FS_HEADER}
in vec2 vUv; out vec4 o;
uniform sampler2D uState;
uniform vec2 uTexel;
uniform float uFeed;
uniform float uKill;
uniform vec3 uSeeds[${SEEDS}];   // x, y, radius (radius 0 = none)
uniform float uAspect;
void main() {
  vec2 c = texture(uState, vUv).rg;
  vec2 lap = -c;
  lap += 0.2 * (texture(uState, vUv + vec2(uTexel.x, 0.0)).rg + texture(uState, vUv - vec2(uTexel.x, 0.0)).rg
              + texture(uState, vUv + vec2(0.0, uTexel.y)).rg + texture(uState, vUv - vec2(0.0, uTexel.y)).rg);
  lap += 0.05 * (texture(uState, vUv + uTexel).rg + texture(uState, vUv - uTexel).rg
               + texture(uState, vUv + vec2(uTexel.x, -uTexel.y)).rg + texture(uState, vUv + vec2(-uTexel.x, uTexel.y)).rg);
  float a = c.r, b = c.g;
  float abb = a * b * b;
  a += 1.0 * lap.r - abb + uFeed * (1.0 - a);
  b += 0.5 * lap.g + abb - (uKill + uFeed) * b;
  for (int i = 0; i < ${SEEDS}; i++) {
    vec3 s = uSeeds[i];
    if (s.z <= 0.0) continue;
    vec2 d = (vUv - s.xy) * vec2(uAspect, 1.0);
    if (length(d) < s.z) b = 1.0;
  }
  o = vec4(clamp(a, 0.0, 1.0), clamp(b, 0.0, 1.0), 0.0, 1.0);
}`;

const INIT_FS = /* glsl */ `${FS_HEADER}
in vec2 vUv; out vec4 o;
${HASH}
uniform float uSeed;
uniform float uAspect;
void main() {
  // Clean chemical A everywhere, with a few scattered blobs of B.
  float b = 0.0;
  for (int i = 0; i < 14; i++) {
    vec2 c = vec2(hash11(float(i) * 3.1 + uSeed), hash11(float(i) * 7.7 + uSeed * 1.3));
    if (length((vUv - c) * vec2(uAspect, 1.0)) < 0.025 + 0.02 * hash11(float(i) + uSeed)) b = 1.0;
  }
  o = vec4(1.0, b, 0.0, 1.0);
}`;

const SHOW_FS = /* glsl */ `${FS_HEADER}
in vec2 vUv; out vec4 o;
${COMMON_UNIFORMS}
${RHYTHM}
uniform sampler2D uState;
uniform vec2 uTexel;
${HASH}
${COLOR}
${PALETTE}
void main() {
  float b = texture(uState, vUv).g;
  float bx = texture(uState, vUv + vec2(uTexel.x, 0.0)).g - texture(uState, vUv - vec2(uTexel.x, 0.0)).g;
  float by = texture(uState, vUv + vec2(0.0, uTexel.y)).g - texture(uState, vUv - vec2(0.0, uTexel.y)).g;
  vec3 n = normalize(vec3(-bx * 6.0, -by * 6.0, 1.0));
  vec3 l = normalize(vec3(-0.5, 0.6, 0.8));
  float diff = max(dot(n, l), 0.0);
  float spec = pow(max(dot(reflect(-l, n), vec3(0.0, 0.0, 1.0)), 0.0), 24.0);
  float v = smoothstep(0.1, 0.45, b);
  vec3 base = mix(uPal[3] * 0.05, pal(0.15 + v * 0.6 + 0.25 * colourDrive() + 0.1 * uMid), v);
  vec3 col = base * (0.35 + 0.85 * diff) * (0.85 + 0.4 * lowDrive() + 0.5 * pulse());
  col += vec3(1.0) * spec * v * (0.25 + 0.8 * uTreble);
  // Edges glint with the hi-hats.
  float edge = smoothstep(0.02, 0.12, length(vec2(bx, by)));
  col += vec3(1.0) * edge * sparkle() * step(0.7, hash21(floor(gl_FragCoord.xy / 3.0) + floor(uTime * 20.0)));
  vec2 q = vUv - 0.5;
  col *= 1.0 - 0.45 * dot(q, q);
  o = vec4(col, 1.0);
}`;

// Feed and kill rates for different kinds of growth.
const REGIMES: [number, number][] = [
  [0.0545, 0.062], // coral
  [0.0367, 0.0649], // dividing cells
  [0.078, 0.061], // worms
  [0.029, 0.057], // maze
];

export default defineVisualizer({
  id: 'reaction',
  name: 'Reaction-Diffusion',
  family: 'simulation',
  order: 180,
  description: 'Two chemicals growing coral, cells or mazes; kicks drop new seeds, drops change the kind of growth.',
  create(ctx) {
    const { gl } = ctx;
    const step = new Program(gl, FULLSCREEN_VS, STEP_FS);
    const init = new Program(gl, FULLSCREEN_VS, INIT_FS);
    const show = new Program(gl, FULLSCREEN_VS, SHOW_FS);
    const state = new PingPong(gl, 2, 2, { format: ctx.hdr ? 'rgba16f' : 'rgba8', wrap: 'repeat' });
    const seeds = new Float32Array(SEEDS * 3);
    let pending = 0;
    let aspect = 16 / 9;
    let regime = 0;
    let feed = REGIMES[0][0];
    let kill = REGIMES[0][1];

    const reset = (seed: number) => {
      for (const t of [state.read, state.write]) {
        t.bind();
        init.use().set({ uSeed: seed, uAspect: aspect });
        drawFullscreen(gl);
      }
    };
    const plant = (radius: number) => {
      if (pending >= SEEDS) return;
      seeds.set([ctx.random(), ctx.random(), radius], pending * 3);
      pending++;
    };

    return {
      resize(width, height) {
        aspect = width / height;
        const w = Math.max(64, Math.min(480, Math.round(width / 3)));
        state.resize(w, Math.max(36, Math.round(w / aspect)));
        reset(1);
      },
      render(frame) {
        const a = frame.audio;
        if (a.drop) {
          regime = (regime + 1) % REGIMES.length;
          reset(frame.time);
        }
        if (a.kickHit || (a.beat && a.beatSource === 'tracked' && a.kick < 0.5)) plant(0.03);
        if (a.snareHit) plant(0.016);
        if (a.hatHit) plant(0.006);
        // Vocals and the bassline nudge the rates within the current kind of growth.
        const [f0, k0] = REGIMES[regime];
        feed += (f0 + 0.004 * (a.vocals - 0.4) - feed) * Math.min(1, frame.dt * 2);
        kill += (k0 + 0.0015 * (Math.max(a.bassline, a.bass * 0.5) - 0.4) - kill) * Math.min(1, frame.dt * 2);
        const texel = [1 / state.read.width, 1 / state.read.height];
        const steps = 10;
        step.use();
        for (let i = 0; i < steps; i++) {
          state.write.bind();
          bindTexture(gl, 0, state.read.tex);
          step.set({ uState: 0, uTexel: texel, uFeed: feed, uKill: kill, uAspect: aspect, uSeeds: i === 0 ? seeds : new Float32Array(SEEDS * 3) });
          drawFullscreen(gl);
          state.swap();
        }
        seeds.fill(0);
        pending = 0;
        bindOutput(gl, frame);
        bindTexture(gl, 0, state.read.tex);
        show.use().set({ ...commonUniforms(frame), uState: 0, uTexel: texel });
        drawFullscreen(gl);
      },
      dispose() {
        step.dispose();
        init.dispose();
        show.dispose();
        state.dispose();
      },
    };
  },
});
