// Bullet Box: a little bullet-dodging battle that plays itself to the music.
// A spark weaves through patterns fired into a glowing box: kicks fire rings
// of orbs, snares drop walls with a gap to slip through, hi-hats rain fine
// pellets, the vocals keep a spiral turning, and the bassline makes the box
// breathe. A drop starts a new phase with a burst. Drawn in chunky pixels.
// An original take on the bullet-dodging genre, not any particular game.

import { COLOR, COMMON_UNIFORMS, FS_HEADER, HASH, PALETTE, RHYTHM } from '../../gl/glsl';
import { bindTexture, drawFullscreen, FULLSCREEN_VS, Program, Target } from '../../gl/util';
import { bindOutput, commonUniforms, defineVisualizer } from '../types';

const MAX_BULLETS = 72;
const MAX_WALLS = 8;
const PIXELS_ACROSS = 384;

const SCENE_FS = /* glsl */ `${FS_HEADER}
in vec2 vUv; out vec4 o;
${COMMON_UNIFORMS}
${RHYTHM}
uniform vec4 uBullets[${MAX_BULLETS}];   // x, y, radius, kind (0 orb, 1 pellet, 2 spiral; <0 unused)
uniform vec4 uWalls[${MAX_WALLS}];       // centre x, y, half width, half height (half width 0 = unused)
uniform vec2 uBox;                        // half size
uniform vec2 uDodger;
uniform vec2 uTrail[6];
uniform float uPhase;
${HASH}
${COLOR}
${PALETTE}

float roundBox(vec2 p, vec2 b, float r) {
  vec2 q = abs(p) - b + r;
  return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r;
}

void main() {
  float aspect = uRes.x / uRes.y;
  vec2 p = (vUv - 0.5) * vec2(aspect, 1.0);
  vec2 bc = vec2(0.0, -0.06);
  vec2 q = p - bc;

  // Background: a slow grid, brighter on the beat.
  vec2 gp = p * 9.0 + vec2(0.0, uTime * 0.2);
  vec2 gl2 = abs(fract(gp) - 0.5);
  float grid = step(0.47, max(gl2.x, gl2.y));
  vec3 col = vec3(0.01, 0.008, 0.02) + pal(0.6) * grid * (0.03 + 0.08 * onBeat(0.3));

  // The box: a rounded neon frame that pulses with the kick.
  float d = roundBox(q, uBox, 0.02);
  float frame = smoothstep(0.006, 0.0, abs(d) - 0.004);
  vec3 frameCol = mix(pal(0.0 + 0.25 * mod(uPhase, 4.0)), vec3(1.0), 0.35);
  col += frameCol * frame * (0.8 + 1.4 * pulse());
  col += frameCol * exp(-max(d, 0.0) * 40.0) * 0.08 * (1.0 + 2.0 * pulse()) * step(0.0, d);
  float inside = smoothstep(0.003, -0.003, d);
  col = mix(col, vec3(0.0, 0.0, 0.006), inside * 0.85);

  // Walls with a gap.
  for (int i = 0; i < ${MAX_WALLS}; i++) {
    vec4 w = uWalls[i];
    if (w.z <= 0.0) continue;
    float wd = roundBox(q - w.xy, w.zw, 0.004);
    col += pal(0.5) * smoothstep(0.004, 0.0, wd) * 1.1 * inside;
  }

  // Bullets.
  vec3 bulletCol = vec3(0.0);
  for (int i = 0; i < ${MAX_BULLETS}; i++) {
    vec4 b = uBullets[i];
    if (b.w < 0.0) continue;
    float bd = length(q - b.xy) - b.z;
    vec3 c = b.w < 0.5 ? pal(0.15 + 0.3 * colourDrive()) : b.w < 1.5 ? vec3(1.0) : pal(0.75);
    bulletCol += c * (smoothstep(0.003, 0.0, bd) * 1.2 + exp(-max(bd, 0.0) * 120.0) * 0.25);
  }
  col += bulletCol * inside;

  // The spark, with a short trail.
  for (int i = 0; i < 6; i++) {
    float td = length(q - uTrail[i]);
    col += pal(0.35) * exp(-td * td * 9000.0) * (0.5 - 0.07 * float(i)) * inside;
  }
  vec2 sp = q - uDodger;
  float diamond = abs(sp.x) + abs(sp.y) - 0.016;
  col += mix(pal(0.35), vec3(1.0), 0.5) * smoothstep(0.004, 0.0, diamond) * 1.6;
  col += pal(0.35) * exp(-max(diamond, 0.0) * 60.0) * 0.4;

  o = vec4(col, 1.0);
}`;

const SCREEN_FS = /* glsl */ `${FS_HEADER}
in vec2 vUv; out vec4 o;
uniform sampler2D uScene;
uniform vec2 uTexel;
uniform float uSparkle;
void main() {
  vec3 c = texture(uScene, vUv).rgb;
  // Glow from a few wider taps.
  vec3 g = vec3(0.0);
  for (int i = 0; i < 8; i++) {
    float a = float(i) * 0.785;
    vec2 dir = vec2(cos(a), sin(a));
    g += texture(uScene, vUv + dir * uTexel * 2.5).rgb + texture(uScene, vUv + dir * uTexel * 6.0).rgb * 0.6;
  }
  c += g / 12.8 * 0.55;
  // Scanlines.
  c *= 0.85 + 0.15 * step(0.5, fract(vUv.y / uTexel.y));
  o = vec4(c, 1.0);
}`;

interface Bullet {
  x: number;
  y: number;
  vx: number;
  vy: number;
  r: number;
  kind: number;
}

interface Wall {
  x: number;
  y: number;
  hw: number;
  vy: number;
}

export default defineVisualizer({
  id: 'bullets',
  name: 'Bullet Box',
  family: 'games',
  order: 315,
  description: 'A spark dodges patterns fired into a neon box: rings on kicks, walls on snares, pellet rain on hi-hats, a spiral with the vocals.',
  create(ctx) {
    const { gl } = ctx;
    const sceneProgram = new Program(gl, FULLSCREEN_VS, SCENE_FS);
    const screen = new Program(gl, FULLSCREEN_VS, SCREEN_FS);
    const target = new Target(gl, 2, 2, { filter: 'nearest' });
    const bulletData = new Float32Array(MAX_BULLETS * 4);
    const wallData = new Float32Array(MAX_WALLS * 4);
    const trail = new Float32Array(12);
    const bullets: Bullet[] = [];
    const walls: Wall[] = [];
    const box = { w: 0.34, h: 0.3 };
    const dodger = { x: 0, y: -0.1, vx: 0, vy: 0 };
    let spiral = 0;
    let spiralClock = 0;
    let ringSide = 0;
    let trailClock = 0;

    const add = (b: Bullet) => {
      if (bullets.length >= MAX_BULLETS) bullets.shift();
      bullets.push(b);
    };
    const ring = (x: number, y: number, count: number, speed: number, offset: number) => {
      for (let i = 0; i < count; i++) {
        const a = offset + (i / count) * Math.PI * 2;
        add({ x, y, vx: Math.cos(a) * speed, vy: Math.sin(a) * speed, r: 0.012, kind: 0 });
      }
    };

    return {
      resize(width, height) {
        target.resize(PIXELS_ACROSS, Math.round((PIXELS_ACROSS * height) / width));
      },
      render(frame) {
        const a = frame.audio;
        const dt = Math.min(frame.dt, 0.05);
        const low = Math.max(a.bassline, a.bass * 0.5);
        // The box breathes with the bassline.
        box.w += (0.42 + 0.08 * low + 0.04 * (a.dropCount % 2) - box.w) * Math.min(1, dt * 3);
        box.h += (0.33 + 0.05 * low - box.h) * Math.min(1, dt * 3);

        // Kicks: a ring of orbs from a point along the top edge.
        if (a.kickHit || (a.beat && a.beatSource === 'tracked' && a.kick < 0.5)) {
          ringSide = (ringSide + 0.37) % 1;
          ring((ringSide * 2 - 1) * box.w * 0.8, box.h * 0.85, 14, 0.32 + 0.2 * a.energy, ctx.random() * 6.28);
        }
        // Snares: a wall with a gap, falling through the box.
        if (a.snareHit) {
          const gap = (ctx.random() * 2 - 1) * box.w * 0.6;
          const g = 0.06;
          const left = (gap - g - -box.w) / 2;
          const right = (box.w - (gap + g)) / 2;
          if (walls.length > MAX_WALLS - 2) walls.splice(0, 2);
          walls.push({ x: -box.w + left, y: box.h, hw: left, vy: -0.28 });
          walls.push({ x: gap + g + right, y: box.h, hw: right, vy: -0.28 });
        }
        // Hi-hats: fine pellets raining from the top.
        const hat = Math.max(a.hat, a.trebleHit * 0.5);
        if (ctx.random() < hat * dt * 40) add({ x: (ctx.random() * 2 - 1) * box.w, y: box.h, vx: 0, vy: -0.75, r: 0.005, kind: 1 });
        // The vocals keep a spiral turning from the centre.
        spiral += dt * (1.2 + 2.5 * low);
        spiralClock += dt * a.vocals * 14;
        while (spiralClock >= 1) {
          spiralClock -= 1;
          for (const arm of [0, Math.PI]) add({ x: 0, y: box.h * 0.2, vx: Math.cos(spiral + arm) * 0.22, vy: Math.sin(spiral + arm) * 0.22, r: 0.008, kind: 2 });
        }
        // A drop: a new phase, opened with a burst.
        if (a.drop) ring(0, 0, 24, 0.45, 0);

        for (const b of bullets) {
          b.x += b.vx * dt;
          b.y += b.vy * dt;
        }
        for (let i = bullets.length - 1; i >= 0; i--) {
          const b = bullets[i];
          if (Math.abs(b.x) > box.w + 0.1 || Math.abs(b.y) > box.h + 0.1) bullets.splice(i, 1);
        }
        for (const w of walls) w.y += w.vy * dt;
        for (let i = walls.length - 1; i >= 0; i--) if (walls[i].y < -box.h - 0.05) walls.splice(i, 1);

        // The spark: pushed away from whatever is close, drawn gently back to the middle.
        let fx = -dodger.x * 1.5;
        let fy = (-0.1 - dodger.y) * 1.5;
        for (const b of bullets) {
          const dx = dodger.x - b.x;
          const dy = dodger.y - b.y;
          const d2 = dx * dx + dy * dy;
          if (d2 < 0.02) {
            const s = 0.0025 / Math.max(d2, 1e-4);
            fx += dx * s;
            fy += dy * s;
          }
        }
        for (const w of walls) {
          const dy = dodger.y - w.y;
          if (Math.abs(dy) < 0.12 && Math.abs(dodger.x - w.x) < w.hw + 0.03) {
            // Head for the nearer end of the wall: that's where the gap is.
            fx += (dodger.x < w.x ? -1 : 1) * 2.5;
            fy += Math.sign(dy || 1) * 0.5;
          }
        }
        dodger.vx = (dodger.vx + fx * dt * 6) * Math.exp(-dt * 5);
        dodger.vy = (dodger.vy + fy * dt * 6) * Math.exp(-dt * 5);
        const speed = Math.hypot(dodger.vx, dodger.vy);
        if (speed > 0.9) {
          dodger.vx *= 0.9 / speed;
          dodger.vy *= 0.9 / speed;
        }
        dodger.x = Math.max(-box.w + 0.02, Math.min(box.w - 0.02, dodger.x + dodger.vx * dt));
        dodger.y = Math.max(-box.h + 0.02, Math.min(box.h - 0.02, dodger.y + dodger.vy * dt));
        trailClock += dt;
        if (trailClock > 0.03) {
          trailClock = 0;
          trail.copyWithin(2, 0, 10);
          trail[0] = dodger.x;
          trail[1] = dodger.y;
        }

        bulletData.fill(0);
        for (let i = 0; i < MAX_BULLETS; i++) {
          const b = bullets[i];
          if (b) bulletData.set([b.x, b.y, b.r, b.kind], i * 4);
          else bulletData[i * 4 + 3] = -1;
        }
        wallData.fill(0);
        walls.forEach((w, i) => wallData.set([w.x, w.y, w.hw, 0.012], i * 4));

        target.bind();
        sceneProgram.use().set({
          ...commonUniforms({ ...frame, width: target.width, height: target.height }),
          uBullets: bulletData,
          uWalls: wallData,
          uBox: [box.w, box.h],
          uDodger: [dodger.x, dodger.y],
          uTrail: trail,
          uPhase: a.dropCount,
        });
        drawFullscreen(gl);

        bindOutput(gl, frame);
        screen.use().set({ uScene: 0, uTexel: [1 / target.width, 1 / target.height] });
        bindTexture(gl, 0, target.tex);
        drawFullscreen(gl);
      },
      dispose() {
        sceneProgram.dispose();
        screen.dispose();
        target.dispose();
      },
    };
  },
});
