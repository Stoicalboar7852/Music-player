// Frequency Terrain: the last few seconds of spectrum as a glowing landscape.
// The newest sound rises at your feet and rolls away toward the horizon.

import { BloomScene } from '../../gl/bloom';
import { COLOR, COMMON_UNIFORMS, FS_HEADER, HASH, NOISE, PALETTE, RHYTHM } from '../../gl/glsl';
import { lookAt, multiply, perspective } from '../../gl/mat4';
import { drawFullscreen, FULLSCREEN_VS, Program } from '../../gl/util';
import { commonUniforms, defineVisualizer, HISTORY_ROWS } from '../types';

const GRID_X = 200;
const GRID_Z = 170;
/** Fraction of the history texture laid out along the terrain's depth. */
const SPAN = 0.72;

const TERRAIN_VS = /* glsl */ `#version 300 es
precision highp float;
layout(location = 0) in vec2 aGrid;     // x: -1..1 across, y: 0 (near) .. 1 (far)
uniform sampler2D uHistory;
uniform float uHistHead;
uniform mat4 uViewProj;
uniform float uBass;
uniform float uBassline;
out float vHeight;
out vec2 vGrid;
out float vRow;
out vec3 vWorld;
out vec3 vNormal;

const vec3 SIZE = vec3(5.6, 1.1, 16.0);

float heightAt(vec2 g) {
  float fx = abs(g.x);
  float h = texture(uHistory, vec2(0.012 + fx * 0.9, uHistHead - g.y * ${SPAN.toFixed(3)})).r;
  h = pow(h, 1.35);
  // Taller in the middle (bass), and flattening out toward the horizon.
  return h * (1.0 - 0.35 * fx) * (1.0 - 0.45 * g.y);
}

void main() {
  float h = heightAt(aGrid);
  vec2 e = vec2(1.0 / ${GRID_X}.0, 1.0 / ${GRID_Z}.0);
  float hx = heightAt(aGrid + vec2(e.x * 2.0, 0.0)) - heightAt(aGrid - vec2(e.x * 2.0, 0.0));
  float hz = heightAt(aGrid + vec2(0.0, e.y)) - heightAt(aGrid - vec2(0.0, e.y));
  vNormal = normalize(vec3(-hx * SIZE.y / (4.0 * e.x * SIZE.x), 1.0, hz * SIZE.y / (2.0 * e.y * SIZE.z)));
  // The near edge sits behind the camera so the mesh never shows its rim.
  // The bassline lifts the land; kicks are already in the spectrum it is made of.
  vec3 world = vec3(aGrid.x * SIZE.x, h * SIZE.y * (1.0 + 0.25 * max(uBassline, uBass * 0.5)), 2.6 - aGrid.y * SIZE.z);
  vHeight = h;
  vGrid = aGrid;
  // Row number in data space, so grid lines travel with the sound.
  vRow = (uHistHead - aGrid.y * ${SPAN.toFixed(3)}) * ${HISTORY_ROWS}.0;
  vWorld = world;
  gl_Position = uViewProj * vec4(world, 1.0);
}`;

const TERRAIN_FS = /* glsl */ `${FS_HEADER}
in float vHeight; in vec2 vGrid; in float vRow; in vec3 vWorld; in vec3 vNormal;
out vec4 o;
${COMMON_UNIFORMS}
${RHYTHM}
uniform vec3 uEye;
${COLOR}
${PALETTE}

void main() {
  vec3 n = normalize(vNormal);
  float h = vHeight;

  // Surface: dark at rest, palette colour as it rises.
  vec3 tint = pal(0.05 + h * 0.55 + abs(vGrid.x) * 0.22);
  vec3 col = tint * (0.03 + 0.5 * h * h);
  // A soft key light from the horizon picks out the ridges.
  vec3 l = normalize(vec3(0.0, 0.35, -1.0));
  col += tint * pow(max(dot(n, l), 0.0), 2.0) * 0.35 * h;

  // Wireframe that rides the data: lines across every 6 rows and along 48 columns.
  float across = vRow / 6.0;
  float along = vGrid.x * 24.0;
  float la = abs(fract(across + 0.5) - 0.5) / max(fwidth(across), 1e-4);
  float lb = abs(fract(along + 0.5) - 0.5) / max(fwidth(along), 1e-4);
  float lines = max(1.0 - min(la, 1.0), 1.0 - min(lb, 1.0));
  vec3 lineColor = pal(0.3 + h * 0.5);
  // Treble runs along the wires as a fine shimmer.
  float shimmer = 0.5 + 0.5 * sin(vRow * 1.7 + vGrid.x * 40.0 - uTime * 9.0);
  col += lineColor * lines * (0.22 + 2.2 * h + 0.9 * pulse() * (1.0 - vGrid.y) + 1.3 * max(uTreble * 0.7, sparkle()) * shimmer);

  // Peaks catch the treble as glints.
  col += vec3(1.0) * pow(h, 5.0) * (0.10 + 0.9 * uTreble);

  // Fade into the horizon glow.
  float dist = length(vWorld - uEye);
  float fog = 1.0 - exp(-dist * 0.085);
  vec3 horizon = mix(pal(0.0), pal(0.25 + 0.2 * colourDrive()), 0.5) * (0.22 + 0.5 * lowDrive());
  col = mix(col, horizon, fog * fog);
  o = vec4(col, 1.0);
}`;

const SKY_FS = /* glsl */ `${FS_HEADER}
in vec2 vUv; out vec4 o;
${COMMON_UNIFORMS}
${RHYTHM}
uniform float uHorizon;      // screen-space y of the horizon, 0..1
${HASH}
${NOISE}
${COLOR}
${PALETTE}

void main() {
  float aspect = uRes.x / uRes.y;
  vec2 p = vec2((vUv.x - 0.5) * aspect, vUv.y - uHorizon);
  float up = max(p.y, 0.0);

  // Sky: palette glow at the horizon falling off to near-black.
  vec3 glow = mix(pal(0.0), pal(0.25), 0.5);
  vec3 col = glow * (0.20 + 0.45 * lowDrive()) * exp(-up * 6.5);
  col += pal(0.5) * 0.05 * exp(-up * 1.8);

  // Sun: a banded disc sitting on the horizon, swelling with the bass.
  float radius = 0.17 + 0.03 * lowDrive() + 0.035 * pulse();
  float d = length(p - vec2(0.0, 0.085));
  float disc = smoothstep(radius, radius - 0.004, d);
  float bands = smoothstep(0.0, 0.012, abs(fract(p.y * 26.0 - uTime * 0.25) - 0.5) - 0.5 * smoothstep(0.24, 0.0, p.y));
  vec3 sun = mix(pal(0.25), pal(0.0), smoothstep(0.0, 0.26, p.y)) * (1.3 + 1.2 * pulse());
  col += sun * disc * mix(1.0, bands, step(p.y, 0.24)) * step(0.0, p.y);
  col += glow * 0.35 * exp(-d * 5.0) * (0.6 + 0.9 * lowDrive());

  // Aurora: curtains of light high in the sky that flare with the treble.
  float sway = fbm(vec2(p.x * 1.6 + uTime * 0.05, uTime * 0.11));
  float curtain = fbm(vec2(p.x * 5.0 + sway * 2.5, uTime * 0.25));
  float band = smoothstep(0.18, 0.34, up) * smoothstep(0.75, 0.42, up + 0.25 * (sway - 0.5));
  float rays = 0.55 + 0.45 * sin(p.x * 70.0 + sway * 30.0);
  vec3 aurora = mix(pal(0.5), pal(0.75), curtain) * pow(curtain, 2.0) * band * rays;
  col += aurora * (0.10 + 1.6 * uTreble + 1.2 * colourDrive() + 1.6 * sparkle());

  // Stars that twinkle with the treble.
  vec2 sg = vUv * vec2(aspect, 1.0) * 70.0;
  vec2 sid = floor(sg);
  float star = step(0.985, hash21(sid)) * smoothstep(0.35, 0.0, length(fract(sg) - 0.5));
  float twinkle = 0.35 + 0.65 * sin(uTime * 2.0 + hash21(sid + 3.0) * 40.0) * uTreble + 0.8 * sparkle();
  col += vec3(0.85, 0.9, 1.0) * star * max(twinkle, 0.15) * smoothstep(0.05, 0.4, up) * (1.0 - disc);

  // Below the horizon: the same haze the terrain fades into, so they meet seamlessly.
  vec3 ground = glow * (0.22 + 0.5 * lowDrive()) * exp(p.y * 5.0);
  col = mix(ground, col, step(0.0, p.y));
  o = vec4(col, 1.0);
}`;

export default defineVisualizer({
  id: 'terrain',
  name: 'Frequency Terrain',
  family: '3d',
  order: 90,
  description: 'A 3D landscape built from the spectrum, rolling toward a sun on the horizon.',
  create(ctx) {
    const { gl } = ctx;
    const terrain = new Program(gl, TERRAIN_VS, TERRAIN_FS);
    const sky = new Program(gl, FULLSCREEN_VS, SKY_FS);
    const scene = new BloomScene(gl, ctx.hdr, { depth: true });

    // Grid mesh: positions are just (x, depth) pairs; the shader does the rest.
    const verts = new Float32Array(GRID_X * GRID_Z * 2);
    for (let z = 0; z < GRID_Z; z++) {
      for (let x = 0; x < GRID_X; x++) {
        const i = (z * GRID_X + x) * 2;
        verts[i] = (x / (GRID_X - 1)) * 2 - 1;
        // Rows bunch up near the camera, where detail is visible.
        verts[i + 1] = Math.pow(z / (GRID_Z - 1), 1.35);
      }
    }
    const indices = new Uint32Array((GRID_X - 1) * (GRID_Z - 1) * 6);
    let k = 0;
    for (let z = 0; z < GRID_Z - 1; z++) {
      for (let x = 0; x < GRID_X - 1; x++) {
        const a = z * GRID_X + x;
        const b = a + GRID_X;
        indices[k++] = a;
        indices[k++] = b;
        indices[k++] = a + 1;
        indices[k++] = a + 1;
        indices[k++] = b;
        indices[k++] = b + 1;
      }
    }
    const vao = gl.createVertexArray()!;
    gl.bindVertexArray(vao);
    const vbo = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bufferData(gl.ARRAY_BUFFER, verts, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    const ibo = gl.createBuffer()!;
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ibo);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, indices, gl.STATIC_DRAW);
    gl.bindVertexArray(null);

    const proj = new Float32Array(16);
    const view = new Float32Array(16);
    const viewProj = new Float32Array(16);

    return {
      resize(width, height) {
        scene.resize(width, height);
      },
      render(frame) {
        const a = frame.audio;
        const t = frame.time;
        const eye: [number, number, number] = [
          Math.sin(t * 0.17) * 0.55,
          1.85 + 0.12 * Math.sin(t * 0.23) + 0.1 * Math.max(a.bassline, a.bass * 0.5),
          1.9,
        ];
        const target: [number, number, number] = [Math.sin(t * 0.11) * 0.3, 0.7, -6];
        perspective(1.0, frame.width / frame.height, 0.1, 60, proj);
        lookAt(eye, target, [Math.sin(t * 0.13) * 0.03, 1, 0], view);
        multiply(proj, view, viewProj);

        // Where the horizon lands on screen, so the sky's sun sits on it.
        const hx = viewProj[4] * 0 + viewProj[8] * -400 + viewProj[12];
        const hy = viewProj[5] * 0 + viewProj[9] * -400 + viewProj[13];
        const hw = viewProj[7] * 0 + viewProj[11] * -400 + viewProj[15];
        void hx;
        const horizon = (hy / hw) * 0.5 + 0.5;

        scene.begin();
        const uniforms = { ...commonUniforms(frame), uRes: [scene.width, scene.height] };
        sky.use().set({ ...uniforms, uHorizon: horizon });
        drawFullscreen(gl);

        gl.enable(gl.DEPTH_TEST);
        gl.depthFunc(gl.LESS);
        terrain.use().set({ ...uniforms, uViewProj: viewProj, uEye: eye });
        gl.bindVertexArray(vao);
        gl.drawElements(gl.TRIANGLES, indices.length, gl.UNSIGNED_INT, 0);
        gl.bindVertexArray(null);
        gl.disable(gl.DEPTH_TEST);

        scene.end(frame, { threshold: 0.6, knee: 0.5, intensity: 0.7, vignette: 0.4, exposure: 1.1 });
      },
      dispose() {
        terrain.dispose();
        sky.dispose();
        scene.dispose();
        gl.deleteVertexArray(vao);
        gl.deleteBuffer(vbo);
        gl.deleteBuffer(ibo);
      },
    };
  },
});
