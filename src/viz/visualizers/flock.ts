// Murmuration: a flock of starlings wheeling over a sunset. Each bird
// follows the simple rules real flocks seem to follow (keep apart, keep up,
// keep together), steering after a point that jumps to a new place on every
// beat, so the flock turns with the music. Kicks startle it outward, the
// bassline draws it tight, hi-hats catch the light on wings, the vocals warm
// the sky, and a drop splits the flock in two.

import { COLOR, COMMON_UNIFORMS, FS_HEADER, HASH, NOISE, PALETTE, RHYTHM } from '../../gl/glsl';
import { drawFullscreen, FULLSCREEN_VS, Program } from '../../gl/util';
import { bindOutput, commonUniforms, defineVisualizer } from '../types';

const BIRDS = 420;
const STRIDE = 4; // x, y, angle, glint

const SKY_FS = /* glsl */ `${FS_HEADER}
in vec2 vUv; out vec4 o;
${COMMON_UNIFORMS}
${RHYTHM}
${HASH}
${NOISE}
${COLOR}
${PALETTE}
void main() {
  float aspect = uRes.x / uRes.y;
  vec2 p = vec2(vUv.x * aspect, vUv.y);
  vec3 top = mix(vec3(0.15, 0.2, 0.42), pal(0.6) * 0.5, 0.3);
  vec3 low = mix(vec3(1.0, 0.55, 0.3), pal(0.05), 0.35);
  low = mix(low, vec3(1.0, 0.42, 0.25), 0.4 * colourDrive());
  vec3 col = mix(low, top, smoothstep(0.1, 0.9, p.y));
  vec2 sun = vec2(aspect * 0.62, 0.2);
  float d = length(p - sun);
  col += mix(vec3(1.0, 0.85, 0.6), low, 0.3) * (smoothstep(0.07, 0.065, d) + exp(-d * 6.0) * (0.35 + 0.5 * colourDrive()));
  float cl = fbm(vec2(p.x * 1.2 - uTime * 0.01, p.y * 6.0));
  col = mix(col, mix(low * 1.1, vec3(1.0, 0.8, 0.7), 0.3), smoothstep(0.55, 0.8, cl) * smoothstep(0.15, 0.4, p.y) * smoothstep(0.85, 0.5, p.y) * 0.5);
  // Treeline.
  float trees = 0.12 + 0.05 * fbm(vec2(p.x * 8.0, 2.0)) + 0.02 * vnoise(vec2(p.x * 40.0, 0.0));
  col = mix(col, vec3(0.03, 0.03, 0.05), smoothstep(0.003, -0.003, p.y - trees));
  col *= 0.95 + 0.1 * pulse();
  o = vec4(col, 1.0);
}`;

const BIRD_VS = /* glsl */ `#version 300 es
precision highp float;
layout(location = 0) in vec2 aPos;
layout(location = 1) in float aAngle;
layout(location = 2) in float aGlint;
uniform float uAspect;
uniform float uSize;
out float vAngle;
out float vGlint;
void main() {
  gl_Position = vec4(aPos.x / uAspect * 2.0 - 1.0, aPos.y * 2.0 - 1.0, 0.0, 1.0);
  gl_PointSize = uSize;
  vAngle = aAngle;
  vGlint = aGlint;
}`;

const BIRD_FS = /* glsl */ `${FS_HEADER}
in float vAngle; in float vGlint; out vec4 o;
uniform vec3 uGlintCol;
float segment(vec2 p, vec2 a, vec2 b) {
  vec2 pa = p - a, ba = b - a;
  float t = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0);
  return length(pa - ba * t);
}
void main() {
  vec2 q = (gl_PointCoord - 0.5) * 2.0;
  q.y = -q.y;
  float c = cos(-vAngle), s = sin(-vAngle);
  q = mat2(c, -s, s, c) * q;
  // A bird seen from below: a short body and two swept wings.
  float flap = 0.35 + 0.35 * sin(floor(vGlint) * 0.05);
  float d = min(segment(q, vec2(-0.5, 0.0), vec2(0.4, 0.0)), min(segment(q, vec2(0.1, 0.0), vec2(-0.35, 0.8 * flap + 0.2)), segment(q, vec2(0.1, 0.0), vec2(-0.35, -0.8 * flap - 0.2))));
  float a = smoothstep(0.2, 0.08, d);
  if (a < 0.01) discard;
  vec3 col = mix(vec3(0.02, 0.02, 0.03), uGlintCol, fract(vGlint) * 0.9);
  o = vec4(col, a);
}`;

export default defineVisualizer({
  id: 'flock',
  name: 'Murmuration',
  family: 'simulation',
  order: 260,
  description: 'A flock of starlings wheeling over a sunset: it turns on the beat, startles on kicks and draws tight with the bassline.',
  create(ctx) {
    const { gl } = ctx;
    const sky = new Program(gl, FULLSCREEN_VS, SKY_FS);
    const birdsProgram = new Program(gl, BIRD_VS, BIRD_FS);
    const data = new Float32Array(BIRDS * STRIDE);
    const vao = gl.createVertexArray()!;
    const buffer = gl.createBuffer()!;
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, data.byteLength, gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, STRIDE * 4, 0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 1, gl.FLOAT, false, STRIDE * 4, 8);
    gl.enableVertexAttribArray(2);
    gl.vertexAttribPointer(2, 1, gl.FLOAT, false, STRIDE * 4, 12);
    gl.bindVertexArray(null);

    let aspect = 16 / 9;
    let size = 8;
    const px = new Float32Array(BIRDS);
    const py = new Float32Array(BIRDS);
    const vx = new Float32Array(BIRDS);
    const vy = new Float32Array(BIRDS);
    const glint = new Float32Array(BIRDS);
    const flapPhase = new Float32Array(BIRDS);
    const team = new Uint8Array(BIRDS);
    for (let i = 0; i < BIRDS; i++) {
      px[i] = 0.6 + (ctx.random() - 0.5) * 0.5;
      py[i] = 0.55 + (ctx.random() - 0.5) * 0.3;
      const ang = ctx.random() * Math.PI * 2;
      vx[i] = Math.cos(ang) * 0.1;
      vy[i] = Math.sin(ang) * 0.1;
      flapPhase[i] = ctx.random();
      team[i] = i % 2;
    }
    const targets = [
      { x: 0.8, y: 0.55 },
      { x: 0.8, y: 0.55 },
    ];
    let split = 0;
    let lastDrop = 0;
    const CELL = 0.06;
    const grid = new Map<number, number[]>();
    const key = (cx: number, cy: number) => cx * 1000 + cy;

    const moveTarget = (t: { x: number; y: number }) => {
      t.x = aspect * (0.2 + 0.6 * ctx.random());
      t.y = 0.35 + 0.45 * ctx.random();
    };

    return {
      resize(width, height) {
        aspect = width / height;
        size = Math.max(6, height / 70);
      },
      render(frame) {
        const a = frame.audio;
        const dt = Math.min(frame.dt, 0.04);
        const low = Math.max(a.bassline, a.bass * 0.5);
        const kicked = a.kickHit || (a.beat && a.beatSource === 'tracked' && a.kick < 0.5);
        // The point the flock steers after jumps on every beat.
        if (a.beat || kicked) {
          moveTarget(targets[0]);
          if (split > 0) moveTarget(targets[1]);
          else {
            targets[1].x = targets[0].x;
            targets[1].y = targets[0].y;
          }
        }
        if (a.dropCount !== lastDrop) {
          lastDrop = a.dropCount;
          split = 6;
          moveTarget(targets[1]);
        }
        split = Math.max(0, split - dt);

        grid.clear();
        for (let i = 0; i < BIRDS; i++) {
          const k = key(Math.floor(px[i] / CELL), Math.floor(py[i] / CELL));
          let list = grid.get(k);
          if (!list) grid.set(k, (list = []));
          list.push(i);
        }
        let cx = 0;
        let cy = 0;
        for (let i = 0; i < BIRDS; i++) {
          cx += px[i];
          cy += py[i];
        }
        cx /= BIRDS;
        cy /= BIRDS;
        const cohesion = 0.6 + 2.5 * low;
        const hat = Math.max(a.hat, a.trebleHit * 0.5);
        for (let i = 0; i < BIRDS; i++) {
          let sx = 0, sy = 0, ax = 0, ay = 0, mx = 0, my = 0, n = 0;
          const gx = Math.floor(px[i] / CELL);
          const gy = Math.floor(py[i] / CELL);
          for (let ox = -1; ox <= 1; ox++) {
            for (let oy = -1; oy <= 1; oy++) {
              const list = grid.get(key(gx + ox, gy + oy));
              if (!list) continue;
              for (const j of list) {
                if (j === i) continue;
                const dx = px[j] - px[i];
                const dy = py[j] - py[i];
                const d2 = dx * dx + dy * dy;
                if (d2 > CELL * CELL) continue;
                if (d2 < 0.00025) {
                  sx -= dx / (d2 + 1e-5);
                  sy -= dy / (d2 + 1e-5);
                }
                ax += vx[j];
                ay += vy[j];
                mx += px[j];
                my += py[j];
                n++;
              }
            }
          }
          let fx = sx * 0.00002 * 60;
          let fy = sy * 0.00002 * 60;
          if (n > 0) {
            fx += (ax / n - vx[i]) * 1.6 + (mx / n - px[i]) * cohesion;
            fy += (ay / n - vy[i]) * 1.6 + (my / n - py[i]) * cohesion;
          }
          const t = targets[team[i]];
          fx += (t.x - px[i]) * 0.9;
          fy += (t.y - py[i]) * 0.9;
          // A kick startles the flock outward.
          if (kicked) {
            const dx = px[i] - cx;
            const dy = py[i] - cy;
            const d = Math.hypot(dx, dy) + 0.02;
            vx[i] += (dx / d) * 0.25;
            vy[i] += (dy / d) * 0.25;
          }
          vx[i] += fx * dt;
          vy[i] += fy * dt;
          const speed = Math.hypot(vx[i], vy[i]);
          const max = 0.45 + 0.3 * a.energy;
          const min = 0.12;
          if (speed > max) {
            vx[i] *= max / speed;
            vy[i] *= max / speed;
          } else if (speed < min && speed > 0) {
            vx[i] *= min / speed;
            vy[i] *= min / speed;
          }
          px[i] += vx[i] * dt;
          py[i] += vy[i] * dt;
          // Soft walls.
          if (px[i] < 0.05) vx[i] += dt * 2;
          if (px[i] > aspect - 0.05) vx[i] -= dt * 2;
          if (py[i] < 0.2) vy[i] += dt * 2;
          if (py[i] > 0.95) vy[i] -= dt * 2;
          // Hi-hats catch the light on some wings.
          flapPhase[i] = (flapPhase[i] + dt * 0.25) % 1;
          if (ctx.random() < hat * dt * 6) glint[i] = 1;
          glint[i] *= Math.exp(-dt * 6);
          const o = i * STRIDE;
          data[o] = px[i];
          data[o + 1] = py[i];
          data[o + 2] = Math.atan2(vy[i], vx[i]);
          // Integer part: wing beat; fraction: how much light it catches.
          data[o + 3] = Math.floor(flapPhase[i] * 1000) + Math.min(0.99, glint[i]);
        }

        bindOutput(gl, frame);
        sky.use().set({ ...commonUniforms(frame) });
        drawFullscreen(gl);
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
        gl.bindVertexArray(vao);
        gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
        gl.bufferSubData(gl.ARRAY_BUFFER, 0, data);
        const pal = frame.palette;
        birdsProgram.use().set({ uAspect: aspect, uSize: size, uGlintCol: [0.9 + 0.1 * pal[0], 0.75 + 0.2 * pal[1], 0.5 + 0.3 * pal[2]] });
        gl.drawArrays(gl.POINTS, 0, BIRDS);
        gl.bindVertexArray(null);
        gl.disable(gl.BLEND);
      },
      dispose() {
        sky.dispose();
        birdsProgram.dispose();
        gl.deleteBuffer(buffer);
        gl.deleteVertexArray(vao);
      },
    };
  },
});
