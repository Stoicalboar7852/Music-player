// Fireworks over a city on the water. Kicks launch shells, snares set off low
// bursts, the vocals keep a golden fountain going from the shore, hi-hats
// make the falling embers crackle and glint, the bassline sets how hard the
// shells fly, and a drop sets off a finale. Shells take the song's colours.

import { COLOR, COMMON_UNIFORMS, FS_HEADER, HASH, PALETTE, RHYTHM } from '../../gl/glsl';
import { bindTexture, drawFullscreen, FULLSCREEN_VS, PingPong, Program } from '../../gl/util';
import { bindOutput, commonUniforms, defineVisualizer } from '../types';

const MAX = 1400;
const STRIDE = 6; // x, y, r, g, b, size
const SHORE = 0.1;

const DECAY_FS = /* glsl */ `${FS_HEADER}
in vec2 vUv; out vec4 o;
uniform sampler2D uPrev; uniform float uDecay;
void main() { o = vec4(max(texture(uPrev, vUv).rgb * uDecay - 0.002, 0.0), 1.0); }`;

const POINT_VS = /* glsl */ `#version 300 es
precision highp float;
layout(location = 0) in vec2 aPos;
layout(location = 1) in vec3 aCol;
layout(location = 2) in float aSize;
uniform float uAspect;
out vec3 vCol;
void main() {
  gl_Position = vec4(aPos.x / uAspect * 2.0 - 1.0, aPos.y * 2.0 - 1.0, 0.0, 1.0);
  gl_PointSize = aSize;
  vCol = aCol;
}`;

const POINT_FS = /* glsl */ `${FS_HEADER}
in vec3 vCol; out vec4 o;
void main() {
  float d = length(gl_PointCoord - 0.5);
  o = vec4(vCol * smoothstep(0.5, 0.05, d), 1.0);
}`;

const SCREEN_FS = /* glsl */ `${FS_HEADER}
in vec2 vUv; out vec4 o;
${COMMON_UNIFORMS}
${RHYTHM}
uniform sampler2D uTrails;
${HASH}
${COLOR}
${PALETTE}
const float SHORE = ${SHORE.toFixed(3)};
void main() {
  float aspect = uRes.x / uRes.y;
  vec3 sky = mix(vec3(0.02, 0.02, 0.06), vec3(0.0, 0.0, 0.015), vUv.y);
  vec3 light = texture(uTrails, vUv).rgb;
  // The city's skyline along the shore.
  float x = vUv.x * aspect;
  float col1 = floor(x * 30.0);
  float height = SHORE + 0.02 + 0.07 * hash11(col1) * hash11(col1 * 1.7);
  vec3 col = sky + light;
  if (vUv.y < height && vUv.y > SHORE) {
    col = vec3(0.01, 0.01, 0.02);
    vec2 win = vec2(fract(x * 30.0 * 3.0), fract(vUv.y * 120.0));
    float lit = step(0.7, hash21(vec2(col1 * 3.0 + floor(x * 90.0), floor(vUv.y * 120.0))));
    col += pal(0.15) * lit * step(0.4, win.x) * step(0.4, win.y) * 0.25;
  }
  // The water: the sky reflected, broken by ripples.
  if (vUv.y < SHORE) {
    float y = 2.0 * SHORE - vUv.y;
    vec2 ruv = vec2(vUv.x + 0.006 * sin(vUv.y * 160.0 + uTime * 3.0) * (0.5 + lowDrive()), y);
    col = (sky + texture(uTrails, ruv).rgb) * vec3(0.4, 0.45, 0.6);
  }
  col *= 1.0 + 0.15 * pulse();
  vec2 c = vUv - 0.5;
  col *= 1.0 - 0.4 * dot(c, c);
  o = vec4(aces(col * 1.3), 1.0);
}`;

interface Spark {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  max: number;
  r: number;
  g: number;
  b: number;
  size: number;
  rocket: boolean;
}

export default defineVisualizer({
  id: 'fireworks',
  name: 'Fireworks',
  family: 'simulation',
  order: 250,
  description: 'Fireworks over a city on the water: kicks launch shells, the vocals keep a fountain going, hi-hats make embers crackle.',
  create(ctx) {
    const { gl } = ctx;
    const decay = new Program(gl, FULLSCREEN_VS, DECAY_FS);
    const points = new Program(gl, POINT_VS, POINT_FS);
    const screen = new Program(gl, FULLSCREEN_VS, SCREEN_FS);
    const trails = new PingPong(gl, 2, 2, { format: ctx.hdr ? 'rgba16f' : 'rgba8' });
    const data = new Float32Array(MAX * STRIDE);
    const vao = gl.createVertexArray()!;
    const buffer = gl.createBuffer()!;
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, data.byteLength, gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, STRIDE * 4, 0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 3, gl.FLOAT, false, STRIDE * 4, 8);
    gl.enableVertexAttribArray(2);
    gl.vertexAttribPointer(2, 1, gl.FLOAT, false, STRIDE * 4, 20);
    gl.bindVertexArray(null);

    const sparks: Spark[] = [];
    let aspect = 16 / 9;
    let scale = 1;
    let fountainClock = 0;
    let lastDrop = 0;
    let palette: Float32Array = new Float32Array(12);

    const colour = (i: number): [number, number, number] => {
      const k = (i % 4) * 3;
      return [palette[k] * 0.8 + 0.2, palette[k + 1] * 0.8 + 0.2, palette[k + 2] * 0.8 + 0.2];
    };
    const add = (s: Spark) => {
      if (sparks.length >= MAX) sparks.shift();
      sparks.push(s);
    };
    const launch = (power: number, fuse: number) => {
      const [r, g, b] = colour(Math.floor(ctx.random() * 4));
      add({ x: aspect * (0.15 + 0.7 * ctx.random()), y: SHORE + 0.02, vx: (ctx.random() - 0.5) * 0.15, vy: 0.8 + 0.4 * power, life: 0, max: fuse, r, g, b, size: 4, rocket: true });
    };
    const burst = (s: Spark, count: number) => {
      for (let i = 0; i < count; i++) {
        const a = ctx.random() * Math.PI * 2;
        const speed = 0.06 + 0.32 * Math.sqrt(ctx.random());
        add({ x: s.x, y: s.y, vx: Math.cos(a) * speed, vy: Math.sin(a) * speed, life: 0, max: 1.1 + ctx.random() * 0.9, r: s.r, g: s.g, b: s.b, size: 3.5, rocket: false });
      }
    };

    return {
      resize(width, height) {
        aspect = width / height;
        scale = Math.max(1, height / 540);
        trails.resize(width, height);
      },
      render(frame) {
        const a = frame.audio;
        const dt = Math.min(frame.dt, 0.05);
        palette = frame.palette;
        const low = Math.max(a.bassline, a.bass * 0.5);
        if (a.kickHit || (a.beat && a.beatSource === 'tracked' && a.kick < 0.5)) launch(0.4 + low, 0.8 + 0.4 * ctx.random());
        if (a.snareHit) {
          launch(0.0, 0.45);
          launch(0.1, 0.5);
        }
        if (a.dropCount !== lastDrop) {
          lastDrop = a.dropCount;
          for (let i = 0; i < 6; i++) launch(0.6 + 0.6 * ctx.random(), 0.7 + 0.6 * ctx.random());
        }
        // The vocals keep a golden fountain going.
        fountainClock += dt * a.vocals * 110;
        while (fountainClock >= 1) {
          fountainClock -= 1;
          const ang = Math.PI / 2 + (ctx.random() - 0.5) * 0.5;
          const speed = 0.35 + 0.25 * ctx.random();
          add({ x: aspect * 0.5, y: SHORE + 0.01, vx: Math.cos(ang) * speed, vy: Math.sin(ang) * speed, life: 0, max: 1.0, r: 1.0, g: 0.75, b: 0.35, size: 2.5, rocket: false });
        }
        // Hi-hats: embers crackle with white glints.
        const hat = Math.max(a.hat, a.trebleHit * 0.5);
        const glints = Math.floor(hat * dt * 260 + ctx.random());
        for (let i = 0; i < glints && sparks.length > 0; i++) {
          const s = sparks[Math.floor(ctx.random() * sparks.length)];
          add({ x: s.x, y: s.y, vx: 0, vy: 0, life: 0, max: 0.12, r: 1.6, g: 1.6, b: 1.6, size: 5, rocket: false });
        }
        if (hat > 0.05 && sparks.length === 0) add({ x: aspect * ctx.random(), y: 0.5 + 0.4 * ctx.random(), vx: 0, vy: 0, life: 0, max: 0.12, r: 1.6, g: 1.6, b: 1.6, size: 5, rocket: false });

        for (let i = sparks.length - 1; i >= 0; i--) {
          const s = sparks[i];
          s.life += dt;
          if (s.rocket) {
            s.vy -= 0.25 * dt;
            if (s.life >= s.max) {
              sparks.splice(i, 1);
              burst(s, 80 + Math.floor(ctx.random() * 40));
              continue;
            }
          } else {
            s.vy -= 0.32 * dt;
            const drag = Math.exp(-dt * 1.3);
            s.vx *= drag;
            s.vy *= drag;
            if (s.life >= s.max) {
              sparks.splice(i, 1);
              continue;
            }
          }
          s.x += s.vx * dt;
          s.y += s.vy * dt;
        }

        let n = 0;
        for (const s of sparks) {
          const fade = s.rocket ? 1 : Math.max(0, 1 - s.life / s.max);
          const o = n * STRIDE;
          data[o] = s.x;
          data[o + 1] = s.y;
          data[o + 2] = s.r * fade * fade;
          data[o + 3] = s.g * fade * fade;
          data[o + 4] = s.b * fade * fade;
          data[o + 5] = s.size * scale * (0.5 + 0.5 * fade);
          n++;
        }

        trails.write.bind();
        decay.use().set({ uPrev: 0, uDecay: Math.exp(-dt / 0.22) });
        bindTexture(gl, 0, trails.read.tex);
        drawFullscreen(gl);
        if (n > 0) {
          gl.enable(gl.BLEND);
          gl.blendFunc(gl.ONE, gl.ONE);
          gl.bindVertexArray(vao);
          gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
          gl.bufferSubData(gl.ARRAY_BUFFER, 0, data, 0, n * STRIDE);
          points.use().set({ uAspect: aspect });
          gl.drawArrays(gl.POINTS, 0, n);
          gl.bindVertexArray(null);
          gl.disable(gl.BLEND);
        }
        trails.swap();

        bindOutput(gl, frame);
        screen.use().set({ ...commonUniforms(frame), uTrails: 0 });
        bindTexture(gl, 0, trails.read.tex);
        drawFullscreen(gl);
      },
      dispose() {
        decay.dispose();
        points.dispose();
        screen.dispose();
        trails.dispose();
        gl.deleteBuffer(buffer);
        gl.deleteVertexArray(vao);
      },
    };
  },
});
