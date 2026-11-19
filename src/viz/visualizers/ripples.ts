// Ripple Pool: a tiled pool seen from above, its surface a real wave
// simulation. Kicks drop big stones into it, snares smaller ones, hi-hats
// spatter it with drops, and the vocals draw a finger through the water. The
// waves bend the view of the tiles (and the song's cover on the pool floor),
// focus the light into caustics, and the bassline sets how long they last.
// Each drop retiles the pool.

import { COLOR, COMMON_UNIFORMS, FS_HEADER, HASH, PALETTE, RHYTHM } from '../../gl/glsl';
import { bindTexture, drawFullscreen, FULLSCREEN_VS, PingPong, Program } from '../../gl/util';
import { bindOutput, commonUniforms, defineVisualizer } from '../types';

const DROPS = 12;
const SIM_WIDTH = 288;

const STEP_FS = /* glsl */ `${FS_HEADER}
in vec2 vUv; out vec4 o;
uniform sampler2D uState;   // r: height now, g: height a step ago
uniform vec2 uTexel;
uniform float uDamping;
uniform vec4 uDrops[${DROPS}];  // x, y (0..1), radius (in uv), strength
uniform float uAspect;
void main() {
  vec2 s = texture(uState, vUv).rg;
  float n = texture(uState, vUv + vec2(uTexel.x, 0.0)).r + texture(uState, vUv - vec2(uTexel.x, 0.0)).r
          + texture(uState, vUv + vec2(0.0, uTexel.y)).r + texture(uState, vUv - vec2(0.0, uTexel.y)).r;
  float next = (n * 0.5 - s.g) * uDamping;
  // A touch of smoothing keeps the grid's own ripple (a checkerboard) from building up.
  next = mix(next, n * 0.25, 0.04);
  for (int i = 0; i < ${DROPS}; i++) {
    vec4 d = uDrops[i];
    if (d.w == 0.0) continue;
    vec2 q = (vUv - d.xy) * vec2(uAspect, 1.0);
    next += d.w * exp(-dot(q, q) / (d.z * d.z));
  }
  o = vec4(clamp(next, -4.0, 4.0), s.r, 0.0, 1.0);
}`;

const SCREEN_FS = /* glsl */ `${FS_HEADER}
in vec2 vUv; out vec4 o;
${COMMON_UNIFORMS}
${RHYTHM}
uniform sampler2D uState;
uniform vec2 uTexel;
uniform sampler2D uArtwork;
uniform float uHasArt;
uniform float uTiles;
${HASH}
${COLOR}
${PALETTE}
void main() {
  float aspect = uRes.x / uRes.y;
  // Wider taps (between texels, so they are filtered) for smooth shading.
  vec2 e = uTexel * 1.5;
  float h = texture(uState, vUv).r;
  float hr = texture(uState, vUv + vec2(e.x, 0.0)).r, hl = texture(uState, vUv - vec2(e.x, 0.0)).r;
  float hu = texture(uState, vUv + vec2(0.0, e.y)).r, hd = texture(uState, vUv - vec2(0.0, e.y)).r;
  vec3 n = normalize(vec3(-(hr - hl), -(hu - hd), 0.45));
  float lap = hr + hl + hu + hd - 4.0 * h;

  // The pool floor, seen through the bent surface.
  vec2 floorUv = vUv + n.xy * 0.035;
  vec2 tp = floorUv * vec2(aspect, 1.0) * uTiles;
  vec2 tile = fract(tp);
  float grout = step(0.06, tile.x) * step(0.06, tile.y);
  float tint = hash21(floor(tp) + uTiles);
  vec3 floorCol = mix(vec3(0.5, 0.66, 0.74), pal(0.55 + 0.1 * tint), 0.3) * (0.85 + 0.15 * tint);
  floorCol = mix(vec3(0.22, 0.3, 0.36), floorCol, grout);
  // The cover, set into the middle of the floor.
  vec2 artUv = (floorUv - 0.5) * vec2(aspect, 1.0) / 0.62 + 0.5;
  float inArt = step(0.0, artUv.x) * step(artUv.x, 1.0) * step(0.0, artUv.y) * step(artUv.y, 1.0) * uHasArt;
  floorCol = mix(floorCol, texture(uArtwork, artUv).rgb * 0.9, inArt * 0.85);

  // Water: depth tint, caustics where the waves focus the light, sky glints.
  vec3 water = floorCol * mix(vec3(0.45, 0.75, 0.85), pal(0.6) * 1.1, 0.25);
  float caustic = smoothstep(0.05, 0.4, -lap * 2.5);
  water += vec3(1.0, 0.98, 0.9) * caustic * (0.25 + 0.4 * colourDrive());
  vec3 sun = normalize(vec3(-0.4, 0.5, 0.75));
  float spec = pow(max(dot(reflect(vec3(0.0, 0.0, -1.0), n), sun), 0.0), 60.0);
  water += vec3(1.0) * spec * (0.2 + 0.8 * sparkle());
  water += pal(0.2) * 0.12 * (1.0 - n.z);
  // The vocals warm the light in the water; hi-hats make the surface shimmer.
  water = mix(water, water * (0.7 + 0.8 * pal(0.1)), 0.35 * colourDrive());
  water += vec3(0.9, 0.95, 1.0) * sparkle() * (1.0 - n.z) * 0.6;
  water *= 1.0 + 0.12 * pulse();

  vec2 c = vUv - 0.5;
  water *= 1.0 - 0.5 * dot(c, c);
  o = vec4(aces(water * 1.1), 1.0);
}`;

export default defineVisualizer({
  id: 'ripples',
  name: 'Ripple Pool',
  family: 'simulation',
  order: 255,
  description: 'A pool whose surface is a wave simulation: kicks drop stones, hi-hats spatter drops, the vocals draw a finger through it.',
  create(ctx) {
    const { gl } = ctx;
    if (!ctx.hdr) throw new Error('Ripple Pool needs float render targets, which this GPU does not support.');
    const step = new Program(gl, FULLSCREEN_VS, STEP_FS);
    const screen = new Program(gl, FULLSCREEN_VS, SCREEN_FS);
    const state = new PingPong(gl, 2, 2, { format: 'rgba16f' });
    const drops = new Float32Array(DROPS * 4);
    let count = 0;
    let aspect = 16 / 9;
    let fingerAngle = 0;
    let lastDrop = 0;
    let tiles = 9;

    const drop = (x: number, y: number, radius: number, strength: number) => {
      if (count >= DROPS) return;
      drops.set([x, y, radius, strength], count * 4);
      count++;
    };

    return {
      resize(width, height) {
        aspect = width / height;
        state.resize(SIM_WIDTH, Math.round(SIM_WIDTH / aspect));
      },
      render(frame) {
        const a = frame.audio;
        const dt = Math.min(frame.dt, 0.05);
        drops.fill(0);
        count = 0;
        if (a.kickHit || (a.beat && a.beatSource === 'tracked' && a.kick < 0.5)) drop(0.15 + 0.7 * ctx.random(), 0.15 + 0.7 * ctx.random(), 0.035, 1.6);
        if (a.snareHit) drop(0.1 + 0.8 * ctx.random(), 0.1 + 0.8 * ctx.random(), 0.02, 0.9);
        const hat = Math.max(a.hat, a.trebleHit * 0.5);
        const spatter = Math.floor(hat * dt * 90 + ctx.random());
        for (let i = 0; i < spatter; i++) drop(ctx.random(), ctx.random(), 0.014, 0.45);
        // The vocals draw a finger round the pool.
        fingerAngle += dt * (0.6 + 0.6 * a.vocals);
        if (a.vocals > 0.02) drop(0.5 + 0.3 * Math.cos(fingerAngle) / aspect * 1.6, 0.5 + 0.3 * Math.sin(fingerAngle * 1.3), 0.02, a.vocals * 0.9);
        if (a.dropCount !== lastDrop) {
          lastDrop = a.dropCount;
          tiles = 6 + Math.floor(ctx.random() * 8);
          drop(0.5, 0.5, 0.09, 3);
        }
        // The bassline lets waves carry further.
        const damping = 0.985 + 0.012 * Math.max(a.bassline, a.bass * 0.5);
        const texel = [1 / state.read.width, 1 / state.read.height];
        for (let s = 0; s < 2; s++) {
          state.write.bind();
          step.use().set({ uState: 0, uTexel: texel, uDamping: damping, uDrops: drops, uAspect: aspect });
          bindTexture(gl, 0, state.read.tex);
          drawFullscreen(gl);
          state.swap();
          drops.fill(0);
        }
        bindOutput(gl, frame);
        screen.use().set({ ...commonUniforms(frame), uState: 0, uTexel: texel, uTiles: tiles });
        bindTexture(gl, 0, state.read.tex);
        drawFullscreen(gl);
      },
      dispose() {
        step.dispose();
        screen.dispose();
        state.dispose();
      },
    };
  },
});
