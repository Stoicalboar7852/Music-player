// Pulse Runner: a glowing square runs a neon course laid out by the music.
// Every beat sets down an obstacle two beats ahead, so the square's jumps
// peak right on the beat; snares make them double. Kicks pump the background
// shapes, the spectrum stands behind the course as light columns, the vocals
// shift its colours, the bassline rolls the floor, and hi-hats glitter in
// the trail. A drop flips gravity for a while. An original take on rhythm
// runners, not any particular game.

import { COLOR, COMMON_UNIFORMS, FS_HEADER, HASH, PALETTE, RHYTHM } from '../../gl/glsl';
import { drawFullscreen, FULLSCREEN_VS, Program } from '../../gl/util';
import { bindOutput, commonUniforms, defineVisualizer } from '../types';

const MAX_OBSTACLES = 12;
const TRAIL = 8;
const GROUND = 0.26;
const CEILING = 0.8;
const SIZE = 0.05;

const FS = /* glsl */ `${FS_HEADER}
in vec2 vUv; out vec4 o;
${COMMON_UNIFORMS}
${RHYTHM}
uniform vec4 uObstacles[${MAX_OBSTACLES}];   // x, kind (0 spike, 1 double spike, 2 block), on the ceiling, alive
uniform vec4 uPlayer;                         // x, y, angle, unused
uniform vec2 uTrail[${TRAIL}];
uniform float uCam;
uniform float uFlip;
uniform float uScene;
${HASH}
${COLOR}
${PALETTE}

const float GROUND = ${GROUND.toFixed(3)};
const float CEILING = ${CEILING.toFixed(3)};
const float SIZE = ${SIZE.toFixed(3)};

float spectrumAt(float x) { return texture(uSpectrum, vec2(clamp(x, 0.0, 1.0), 0.5)).r; }

float triangleSdf(vec2 p, float w, float h) {
  // Isosceles triangle with its base on y = 0, pointing up.
  p.x = abs(p.x);
  vec2 a = vec2(w, 0.0), b = vec2(0.0, h);
  vec2 e = b - a;
  vec2 q = p - a;
  // Inside: above the base and below the slanted side (s >= 0 there).
  float s = e.x * q.y - e.y * q.x;
  float inside = step(0.0, p.y) * step(0.0, s);
  vec2 c = q - e * clamp(dot(q, e) / dot(e, e), 0.0, 1.0);
  float d = min(length(c), abs(p.y));
  return inside > 0.5 ? -d : d;
}

float boxSdf(vec2 p, vec2 b) {
  vec2 q = abs(p) - b;
  return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0);
}

void main() {
  float aspect = uRes.x / uRes.y;
  vec2 p = vec2(vUv.x * aspect, vUv.y);
  float scene = mod(uScene, 4.0);
  vec3 a = pal(0.05 + 0.25 * scene + 0.15 * colourDrive());
  vec3 b = pal(0.55 + 0.25 * scene);

  // ---- background: a gradient, light columns from the spectrum, shapes that pump with the kick
  vec3 col = mix(a * 0.3, b * 0.55, vUv.y) + mix(a, b, 0.5) * 0.08 * (1.0 + pulse());
  float bx = vUv.x;
  float column = spectrumAt(0.02 + floor(bx * 32.0) / 32.0 * 0.92);
  float inColumn = step(0.12, fract(bx * 32.0)) * step(fract(bx * 32.0), 0.88);
  float columnTop = GROUND + 0.05 + 0.5 * column;
  col += mix(b, vec3(1.0), 0.2) * inColumn * step(GROUND, vUv.y) * smoothstep(columnTop + 0.01, columnTop, vUv.y) * (0.08 + column * 0.5);
  for (int i = 0; i < 4; i++) {
    float fi = float(i);
    float par = 0.15 + 0.12 * fi;
    vec2 c = vec2(mod(fi * 0.83 - uCam * par, aspect + 0.6) - 0.3, 0.55 + 0.12 * sin(fi * 2.1));
    vec2 q = p - c;
    float ang = uTime * (0.2 + 0.1 * fi) + fi;
    q = mat2(cos(ang), -sin(ang), sin(ang), cos(ang)) * q;
    float s = (0.09 + 0.04 * fi) * (1.0 + 0.35 * pulse());
    float outline = abs(boxSdf(q, vec2(s))) - 0.004;
    col += mix(mix(a, b, 0.5), vec3(1.0), 0.3) * smoothstep(0.005, 0.0, outline) * (0.45 + 0.9 * pulse());
  }

  // ---- floor and ceiling, with a grid that rolls with the bassline
  float floorY = GROUND + 0.006 * sin(p.x * 8.0 - uCam * 6.0) * lowDrive();
  float ceilY = CEILING;
  float ground = smoothstep(0.002, -0.002, p.y - floorY);
  float roof = smoothstep(-0.002, 0.002, p.y - ceilY) * uFlip;
  vec3 floorCol = a * 0.12;
  vec2 g = vec2((p.x + uCam) * 12.0, (floorY - p.y) * 18.0);
  float lines = step(0.92, fract(g.x)) + step(0.9, fract(g.y));
  floorCol += b * lines * 0.12;
  // Hi-hat glitter on the floor.
  floorCol += vec3(1.0) * step(0.985, hash21(floor(vec2(p.x + uCam, p.y) * 70.0) + floor(uTime * 12.0))) * sparkle() * 0.8;
  col = mix(col, floorCol, max(ground, roof));
  col += mix(a, vec3(1.0), 0.4) * smoothstep(0.004, 0.0, abs(p.y - floorY)) * (0.9 + 0.8 * onBeat(0.3));
  col += mix(b, vec3(1.0), 0.4) * smoothstep(0.004, 0.0, abs(p.y - ceilY)) * (0.3 + 0.9 * uFlip);

  // ---- obstacles
  for (int i = 0; i < ${MAX_OBSTACLES}; i++) {
    vec4 ob = uObstacles[i];
    if (ob.w < 0.5) continue;
    float top = ob.z;
    vec2 q = p - vec2(ob.x, top > 0.5 ? ceilY : floorY);
    if (top > 0.5) q.y = -q.y;
    float d;
    if (ob.y < 0.5) d = triangleSdf(q, SIZE * 0.55, SIZE * 1.1);
    else if (ob.y < 1.5) d = min(triangleSdf(q + vec2(SIZE * 0.55, 0.0), SIZE * 0.55, SIZE * 1.1), triangleSdf(q - vec2(SIZE * 0.55, 0.0), SIZE * 0.55, SIZE * 1.1));
    else d = boxSdf(q - vec2(0.0, SIZE * 0.5), vec2(SIZE * 0.5));
    vec3 oc = mix(b, vec3(1.0), 0.25);
    col = mix(col, vec3(0.0), smoothstep(0.003, 0.0, d));
    col += oc * smoothstep(0.004, 0.0, abs(d)) * 1.3;
    col += oc * exp(-max(d, 0.0) * 50.0) * 0.12;
  }

  // ---- the trail, then the square itself
  for (int i = 0; i < ${TRAIL}; i++) {
    float td = length(p - uTrail[i]);
    float fade = 1.0 - float(i) / float(${TRAIL});
    col += a * exp(-td * td * 2500.0) * fade * (0.35 + 1.2 * sparkle());
  }
  vec2 q = p - uPlayer.xy;
  float ang = uPlayer.z;
  q = mat2(cos(ang), -sin(ang), sin(ang), cos(ang)) * q;
  float d = boxSdf(q, vec2(SIZE * 0.5)) - 0.004;
  vec3 pc = mix(a, vec3(1.0), 0.35);
  col = mix(col, pc * 0.35, smoothstep(0.003, 0.0, d));
  col += pc * smoothstep(0.004, 0.0, abs(d)) * 1.6;
  col += pc * smoothstep(0.004, 0.0, abs(boxSdf(q, vec2(SIZE * 0.2)))) * 1.2;
  col += pc * exp(-max(d, 0.0) * 30.0) * (0.15 + 0.4 * pulse());

  vec2 c = vUv - 0.5;
  col *= 1.0 - 0.7 * dot(c, c);
  o = vec4(aces(col * 1.2), 1.0);
}`;

interface Obstacle {
  x: number;
  kind: number;
  top: boolean;
  jumped: boolean;
}

export default defineVisualizer({
  id: 'runner',
  name: 'Pulse Runner',
  family: 'games',
  order: 320,
  description: 'A glowing square runs a neon course laid out by the beats: every jump peaks on a beat, kicks pump the shapes, a drop flips gravity.',
  create(ctx) {
    const { gl } = ctx;
    const program = new Program(gl, FULLSCREEN_VS, FS);
    const obstacleData = new Float32Array(MAX_OBSTACLES * 4);
    const trailData = new Float32Array(TRAIL * 2);
    const obstacles: Obstacle[] = [];
    let aspect = 16 / 9;
    let cam = 0;
    let jump = -1; // seconds into the current jump, or -1
    let jumpLength = 0.4;
    let angle = 0;
    let angleFrom = 0;
    let flipBeats = 0;
    let flip = 0;
    let trailClock = 0;
    let lastDrop = 0;

    return {
      resize(width, height) {
        aspect = width / height;
        trailData.fill(-10);
      },
      render(frame) {
        const a = frame.audio;
        const dt = Math.min(frame.dt, 0.05);
        const beatLength = 60 / Math.min(180, Math.max(70, a.bpm || 120));
        const speed = (aspect * 0.4) / beatLength;
        const playerX = aspect * 0.3;
        cam += speed * dt;

        // A drop flips gravity for eight beats.
        if (a.dropCount !== lastDrop) {
          lastDrop = a.dropCount;
          flipBeats = 8;
        }
        if (a.beat) {
          if (flipBeats > 0) flipBeats--;
          // An obstacle two beats ahead: a spike, a double spike on a snare, sometimes a block.
          const r = ctx.random();
          if (r < 0.55 + 0.4 * a.energy) {
            const kind = a.snare > 0.5 || a.snareHit ? 1 : r < 0.2 ? 2 : 0;
            if (obstacles.length >= MAX_OBSTACLES) obstacles.shift();
            obstacles.push({ x: playerX + speed * beatLength * 2, kind, top: flipBeats > 0, jumped: false });
          }
        }
        flip += ((flipBeats > 0 ? 1 : 0) - flip) * Math.min(1, dt * 6);
        for (const o of obstacles) o.x -= speed * dt;
        while (obstacles.length && obstacles[0].x < -0.2) obstacles.shift();

        // Jump so the peak lands on the obstacle (and so on the beat).
        jumpLength = Math.min(beatLength * 0.9, 0.6);
        const next = obstacles.find((o) => !o.jumped && o.x > playerX - 0.01);
        if (jump < 0 && next && (next.x - playerX) / speed <= jumpLength / 2) {
          jump = 0;
          next.jumped = true;
          angleFrom = angle;
        }
        let height = 0;
        if (jump >= 0) {
          jump += dt;
          const t = Math.min(1, jump / jumpLength);
          height = 4 * 0.17 * t * (1 - t);
          angle = angleFrom - (Math.PI / 2) * t;
          if (t >= 1) {
            jump = -1;
            angle = angleFrom - Math.PI / 2;
          }
        }
        const onCeiling = flip > 0.5;
        const y = onCeiling ? CEILING - SIZE / 2 - height : GROUND + SIZE / 2 + 0.004 + height;

        trailClock += dt;
        if (trailClock > 0.025) {
          trailClock = 0;
          for (let i = TRAIL - 1; i > 0; i--) {
            trailData[i * 2] = trailData[(i - 1) * 2] - speed * 0.025;
            trailData[i * 2 + 1] = trailData[(i - 1) * 2 + 1];
          }
          trailData[0] = playerX - SIZE * 0.3;
          trailData[1] = y;
        }

        obstacleData.fill(0);
        obstacles.forEach((o, i) => obstacleData.set([o.x, o.kind, o.top ? 1 : 0, 1], i * 4));
        bindOutput(gl, frame);
        program.use().set({
          ...commonUniforms(frame),
          uObstacles: obstacleData,
          uPlayer: [playerX, y, angle, 0],
          uTrail: trailData,
          uCam: cam,
          uFlip: flip,
          uScene: a.dropCount,
        });
        drawFullscreen(gl);
      },
      dispose() {
        program.dispose();
      },
    };
  },
});
