// Boost Arena: two rocket cars knock a giant ball around a neon arena, side
// on. On each kick the car nearest the ball jumps and boosts into it; the
// bassline fires their boosters along the floor; the back wall is a band of
// LEDs showing the spectrum, chasing on the beat; the crowd's lights follow
// the vocals and the floodlights glint with the hi-hats. Goals explode in the
// scoring team's colours, and a drop sends the ball flying at a goal.
// An original take on car-ball games, not any particular one.

import { COLOR, COMMON_UNIFORMS, FS_HEADER, HASH, PALETTE, RHYTHM } from '../../gl/glsl';
import { drawFullscreen, FULLSCREEN_VS, Program } from '../../gl/util';
import { bindOutput, commonUniforms, defineVisualizer } from '../types';

const WALL = 1.02;
const CEIL = 1.0;
const BALL_R = 0.085;
const GOAL_H = 0.32;

const FS = /* glsl */ `${FS_HEADER}
in vec2 vUv; out vec4 o;
${COMMON_UNIFORMS}
${RHYTHM}
uniform vec4 uBall;        // x, y, radius, spin
uniform vec4 uCars[2];     // x, y, facing (-1 or 1), boost 0..1
uniform vec4 uBlast;       // x, y, age (s), team
uniform float uShake;
uniform float uScene;
${HASH}
${COLOR}
${PALETTE}

const float WALL = ${WALL.toFixed(3)};
const float CEIL = ${CEIL.toFixed(3)};
const float GOAL_H = ${GOAL_H.toFixed(3)};

float spectrumAt(float x) { return texture(uSpectrum, vec2(clamp(x, 0.0, 1.0), 0.5)).r; }

float boxSdf(vec2 p, vec2 b, float r) {
  vec2 q = abs(p) - b + r;
  return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r;
}

vec3 team(float t) { return t < 0.5 ? mix(pal(0.0), vec3(0.2, 0.6, 1.0), 0.45) : mix(pal(0.5), vec3(1.0, 0.55, 0.15), 0.45); }

void main() {
  float aspect = uRes.x / uRes.y;
  vec2 w = vec2((vUv.x - 0.5) * aspect, vUv.y) * 1.22 - vec2(0.0, 0.12);
  w += vec2(sin(uTime * 70.0), cos(uTime * 63.0)) * uShake * 0.006;
  float scene = mod(uScene, 3.0);

  // ---- stadium: dark stands, crowd lights (the vocals), floodlights (the hi-hats)
  vec3 col = mix(vec3(0.01, 0.012, 0.03), pal(0.6) * 0.12, smoothstep(0.0, 1.3, w.y));
  vec2 cg = vec2(w.x * 26.0, w.y * 14.0);
  vec2 cid = floor(cg);
  float seat = hash21(cid + scene * 7.0);
  vec2 cf = fract(cg) - 0.5;
  float crowd = exp(-dot(cf, cf) * 14.0) * step(CEIL + 0.02, w.y) * step(0.45, seat);
  col += pal(seat) * crowd * (0.06 + 0.5 * colourDrive() * step(0.6, hash21(cid + floor(uTime * 3.0))));
  for (int i = 0; i < 4; i++) {
    float fx = (float(i) - 1.5) * 0.75;
    vec2 lp = w - vec2(fx, CEIL + 0.26);
    float lamp = exp(-dot(lp, lp) * 900.0);
    float glint = 0.35 + 1.5 * sparkle() * step(0.5, hash11(float(i) + floor(uTime * 14.0)));
    col += vec3(1.0, 0.97, 0.9) * lamp * glint;
    col += vec3(1.0, 0.97, 0.9) * exp(-abs(lp.x) * 30.0) * smoothstep(0.0, -0.9, lp.y) * 0.025 * glint;
  }

  // ---- the back wall: an LED band showing the spectrum, chasing on the beat
  if (w.y > 0.06 && w.y < CEIL && abs(w.x) < WALL) {
    vec3 wallCol = vec3(0.02, 0.025, 0.05);
    float x = (w.x + WALL) / (2.0 * WALL);
    float level = spectrumAt(0.02 + x * 0.92);
    float led = step(0.25, fract(w.x * 40.0)) * step(0.3, fract(w.y * 30.0));
    float bar = step(w.y, 0.12 + 0.5 * level);
    float chase = step(0.82, fract(x * 6.0 - uBeatPhase)) * onBeat(0.6);
    wallCol += mix(pal(0.2 + x * 0.5), vec3(1.0), 0.2) * led * (bar * (0.35 + 0.6 * level) + chase * 0.5);
    col = wallCol;
  }

  // ---- floor (a receding grid below the playing surface)
  if (w.y < 0.0) {
    float depth = 0.25 / max(-w.y + 0.02, 0.02);
    vec2 fg = vec2(w.x * depth * 2.0, depth * 3.0);
    float lines = step(0.94, fract(fg.x)) + step(0.9, fract(fg.y));
    col = vec3(0.01, 0.02, 0.03) + mix(pal(0.0), pal(0.5), 0.5) * lines * 0.12 * exp(-depth * 0.15);
  }
  col += mix(pal(0.3), vec3(1.0), 0.5) * smoothstep(0.006, 0.0, abs(w.y)) * (0.7 + 1.2 * pulse()) * step(abs(w.x), WALL);

  // ---- side walls and goals (each goal glows in its team's colour)
  for (int s = 0; s < 2; s++) {
    float side = s == 0 ? -1.0 : 1.0;
    float gx = w.x * side - WALL;
    vec3 tc = team(float(s));
    float post = smoothstep(0.006, 0.0, abs(gx)) * step(GOAL_H, w.y) * step(w.y, CEIL);
    col += vec3(0.5, 0.6, 0.8) * post * 0.6;
    if (gx > 0.0 && gx < 0.16 && w.y > 0.0 && w.y < GOAL_H) {
      float net = step(0.85, fract(gx * 60.0)) + step(0.85, fract(w.y * 60.0));
      col = mix(col, tc * 0.25, 0.6) + tc * net * 0.25;
    }
    float frame = smoothstep(0.006, 0.0, abs(boxSdf(vec2(gx - 0.08, w.y - GOAL_H * 0.5), vec2(0.08, GOAL_H * 0.5), 0.0)));
    col += tc * frame * 1.2;
  }

  // ---- the ball
  vec2 bp = w - uBall.xy;
  float br = uBall.z;
  float bd = length(bp) - br;
  if (bd < 0.0) {
    vec3 n = vec3(bp / br, sqrt(max(0.0, 1.0 - dot(bp, bp) / (br * br))));
    float c = cos(uBall.w), s = sin(uBall.w);
    vec2 r = mat2(c, -s, s, c) * n.xy;
    vec2 hex = abs(fract(r * 3.5) - 0.5);
    float seams = step(0.42, max(hex.x, hex.y));
    vec3 ballCol = mix(vec3(0.85, 0.87, 0.9), vec3(0.25, 0.27, 0.32), seams);
    float light = 0.35 + 0.75 * max(dot(n, normalize(vec3(-0.4, 0.7, 0.6))), 0.0);
    col = ballCol * light + pow(max(dot(reflect(vec3(0.0, 0.0, -1.0), n), normalize(vec3(-0.4, 0.7, 0.6))), 0.0), 24.0) * 0.8;
  }
  col += vec3(0.6, 0.8, 1.0) * exp(-max(bd, 0.0) * 30.0) * 0.12 * (1.0 + 2.0 * pulse());

  // ---- the cars
  for (int i = 0; i < 2; i++) {
    vec4 car = uCars[i];
    vec2 q = (w - car.xy) / 1.5;               // drawn half as big again
    q.x *= car.z;                            // face the way it's going
    vec3 tc = team(float(i));
    // Boost flame out of the back.
    vec2 fq = q - vec2(-0.1, 0.035);
    float flame = exp(-pow(max(-fq.x, 0.0) * 9.0, 2.0)) * exp(-fq.y * fq.y * 1800.0 / (1.0 + max(-fq.x, 0.0) * 30.0)) * step(fq.x, 0.0);
    float flicker = 0.7 + 0.3 * hash11(floor(uTime * 40.0) + float(i));
    col += mix(tc, vec3(1.0, 0.9, 0.6), 0.5) * flame * car.w * flicker * 1.6;
    float body = boxSdf(q - vec2(0.0, 0.035), vec2(0.1, 0.022), 0.012);
    float cabin = boxSdf(q - vec2(-0.015, 0.065), vec2(0.045, 0.016), 0.012);
    float hull = min(body, cabin);
    float wheels = min(length(q - vec2(-0.06, 0.016)) - 0.02, length(q - vec2(0.06, 0.016)) - 0.02);
    col = mix(col, tc * 0.45, smoothstep(0.003, 0.0, hull));
    col += tc * smoothstep(0.004, 0.0, abs(hull)) * 1.2;
    col = mix(col, vec3(0.03), smoothstep(0.003, 0.0, wheels));
    col += vec3(0.7, 0.9, 1.0) * smoothstep(0.004, 0.0, abs(cabin)) * step(0.0, q.y - 0.06) * 0.6;
  }

  // ---- a goal explosion
  float age = uBlast.z;
  if (age < 2.5) {
    vec2 eq = w - uBlast.xy;
    float r = length(eq);
    float radius = age * 1.1;
    vec3 tc = team(uBlast.w);
    float fade = exp(-age * 1.6);
    col += tc * smoothstep(0.03, 0.0, abs(r - radius)) * fade * 2.0;
    float ang = atan(eq.y, eq.x);
    float rays = pow(max(0.0, sin(ang * 14.0 + hash11(uBlast.x) * 6.0)), 18.0) * step(r, radius) * smoothstep(0.0, radius, r);
    col += mix(tc, vec3(1.0), 0.4) * rays * fade * 1.5;
    vec2 sg = floor(eq * 30.0);
    col += tc * step(0.97, hash21(sg + floor(age * 10.0))) * step(r, radius) * fade * 1.4;
  }

  vec2 c = vUv - 0.5;
  col *= 1.0 - 0.6 * dot(c, c);
  o = vec4(aces(col * 1.15), 1.0);
}`;

interface Car {
  x: number;
  y: number;
  vx: number;
  vy: number;
  facing: number;
  boost: number;
}

export default defineVisualizer({
  id: 'arena',
  name: 'Boost Arena',
  family: 'games',
  order: 325,
  description: 'Two rocket cars knock a giant ball around a neon arena: kicks launch them at it, the back wall is the spectrum, goals explode.',
  create(ctx) {
    const { gl } = ctx;
    const program = new Program(gl, FULLSCREEN_VS, FS);
    const ball = { x: 0, y: 0.5, vx: 0.2, vy: 0, spin: 0 };
    const cars: Car[] = [
      { x: -0.6, y: 0, vx: 0, vy: 0, facing: 1, boost: 0 },
      { x: 0.6, y: 0, vx: 0, vy: 0, facing: -1, boost: 0 },
    ];
    const carData = new Float32Array(8);
    const blast = [0, 0, 99, 0];
    let shake = 0;
    let kickoff = 0;
    let lastDrop = 0;
    let turn = 0;

    const reset = () => {
      ball.x = 0;
      ball.y = 0.55;
      ball.vx = (ctx.random() - 0.5) * 0.4;
      ball.vy = 0;
      cars[0].x = -0.6;
      cars[1].x = 0.6;
    };

    return {
      resize() {},
      render(frame) {
        const a = frame.audio;
        const dt = Math.min(frame.dt, 0.04);
        const low = Math.max(a.bassline, a.bass * 0.5);
        const kicked = a.kickHit || (a.beat && a.beatSource === 'tracked' && a.kick < 0.5);

        // A drop: the ball flies at a goal.
        if (a.dropCount !== lastDrop) {
          lastDrop = a.dropCount;
          const toward = ctx.random() < 0.5 ? -1 : 1;
          ball.vx = toward * 2.6;
          ball.vy = 0.6;
        }

        // The cars chase the ball; the bassline fires their boosters along the floor.
        for (let i = 0; i < 2; i++) {
          const car = cars[i];
          const goalSide = i === 0 ? -1 : 1;
          // Get on the far side of the ball from your own goal.
          const want = ball.x + goalSide * 0.14;
          const dir = Math.sign(want - car.x);
          if (car.y <= 0) {
            car.vx += dir * dt * (2.5 + 3 * low);
            car.vx *= Math.exp(-dt * 2);
            if (Math.abs(car.vx) > 0.15) car.facing = Math.sign(car.vx);
          }
          car.boost = Math.max(car.boost * Math.exp(-dt * 4), car.y <= 0 ? low * 0.8 : 0);
        }
        // On a kick, the car nearest the ball jumps and boosts into it.
        if (kicked && kickoff <= 0) {
          const pick = Math.abs(cars[0].x - ball.x) < Math.abs(cars[1].x - ball.x) ? 0 : 1;
          const car = cars[(pick + (turn++ % 3 === 2 ? 1 : 0)) % 2];
          if (car.y <= 0) {
            car.vy = 1.0 + 0.6 * Math.min(1, ball.y);
            car.vx = Math.sign(ball.x - car.x) * (0.9 + 0.5 * a.energy);
            car.facing = Math.sign(car.vx) || car.facing;
          }
          car.boost = 1;
          shake = 1;
        }
        for (const car of cars) {
          car.x += car.vx * dt;
          car.y += car.vy * dt;
          car.vy -= 2.6 * dt;
          if (car.y <= 0) {
            car.y = 0;
            car.vy = 0;
          }
          car.x = Math.max(-WALL + 0.12, Math.min(WALL - 0.12, car.x));
          // Contact: the ball is knocked away from the car.
          const dx = ball.x - car.x;
          const dy = ball.y - (car.y + 0.065);
          const d = Math.hypot(dx, dy);
          if (d < BALL_R + 0.13 && d > 1e-4) {
            const push = 1.2 + 0.8 * car.boost + 0.6 * a.energy;
            ball.vx = (dx / d) * push + car.vx * 0.4;
            ball.vy = Math.abs(dy / d) * push + 0.3 + Math.max(0, car.vy) * 0.3;
            ball.x = car.x + (dx / d) * (BALL_R + 0.131);
            ball.y = Math.max(ball.y, car.y + 0.065 + (dy / d) * (BALL_R + 0.131));
          }
        }

        // The ball: gravity, drag, and bounces off the floor, walls and ceiling.
        if (kickoff > 0) {
          kickoff -= dt;
          if (kickoff <= 0) reset();
        } else {
          ball.vy -= 1.4 * dt;
          ball.vx *= Math.exp(-dt * 0.25);
          ball.x += ball.vx * dt;
          ball.y += ball.vy * dt;
          ball.spin -= (ball.vx / BALL_R) * dt * 0.5;
          if (ball.y < BALL_R) {
            ball.y = BALL_R;
            ball.vy = Math.abs(ball.vy) * 0.72;
          }
          if (ball.y > CEIL - BALL_R) {
            ball.y = CEIL - BALL_R;
            ball.vy = -Math.abs(ball.vy) * 0.7;
          }
          const inGoalMouth = ball.y < GOAL_H - BALL_R * 0.5;
          if (Math.abs(ball.x) > WALL - BALL_R && !inGoalMouth) {
            ball.x = Math.sign(ball.x) * (WALL - BALL_R);
            ball.vx = -ball.vx * 0.75;
          }
          // In the net: a goal for the team attacking that end.
          if (Math.abs(ball.x) > WALL + 0.06) {
            const side = Math.sign(ball.x);
            blast[0] = side * (WALL + 0.06);
            blast[1] = GOAL_H * 0.5;
            blast[2] = 0;
            blast[3] = side < 0 ? 1 : 0;
            kickoff = 1.6;
            shake = 1.5;
          }
        }
        blast[2] += dt;
        shake *= Math.exp(-dt * 6);

        cars.forEach((c, i) => carData.set([c.x, c.y, c.facing, c.boost], i * 4));
        bindOutput(gl, frame);
        program.use().set({
          ...commonUniforms(frame),
          uBall: [ball.x, kickoff > 0 ? -5 : ball.y, BALL_R, ball.spin],
          uCars: carData,
          uBlast: blast,
          uShake: shake,
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
