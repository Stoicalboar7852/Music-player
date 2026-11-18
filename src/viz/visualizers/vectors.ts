// Vector Arcade: glowing wireframes on a vector monitor, with the phosphor
// afterglow those screens had. Polyhedra hang over a grid floor that rolls
// toward you one cell per beat. Each shape's edges carry a band; kicks punch
// the shapes outward, vocals turn them, hi-hats flash single edges white, and
// a drop brings in a new set of shapes.

import { BloomScene } from '../../gl/bloom';
import { COMMON_UNIFORMS, FS_HEADER, HASH, PALETTE, RHYTHM } from '../../gl/glsl';
import { lookAt, multiply, perspective } from '../../gl/mat4';
import { drawFullscreen, FULLSCREEN_VS, Program } from '../../gl/util';
import { commonUniforms, defineVisualizer } from '../types';

type Edge = [number, number, number, number, number, number];

function polyEdges(vertices: number[][], maxLength: number): Edge[] {
  const out: Edge[] = [];
  for (let i = 0; i < vertices.length; i++) {
    for (let j = i + 1; j < vertices.length; j++) {
      const [a, b] = [vertices[i], vertices[j]];
      const d = Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
      if (d < maxLength) out.push([a[0], a[1], a[2], b[0], b[1], b[2]]);
    }
  }
  return out;
}

const phi = (1 + Math.sqrt(5)) / 2;
const SHAPES: Edge[][] = [
  // Cube
  polyEdges([-1, 1].flatMap((x) => [-1, 1].flatMap((y) => [-1, 1].map((z) => [x, y, z]))), 2.01),
  // Octahedron
  polyEdges([[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]].map((v) => v.map((c) => c * 1.4)), 2.0),
  // Icosahedron
  polyEdges(
    [
      [0, 1, phi], [0, -1, phi], [0, 1, -phi], [0, -1, -phi],
      [1, phi, 0], [-1, phi, 0], [1, -phi, 0], [-1, -phi, 0],
      [phi, 0, 1], [-phi, 0, 1], [phi, 0, -1], [-phi, 0, -1],
    ].map((v) => v.map((c) => c * 0.75)),
    1.6,
  ),
  // Tetrahedron
  polyEdges([[1, 1, 1], [1, -1, -1], [-1, 1, -1], [-1, -1, 1]].map((v) => v.map((c) => c * 1.1)), 3.2),
];

const LINE_VS = /* glsl */ `#version 300 es
precision highp float;
layout(location = 0) in vec2 aCorner;          // x: 0..1 along the edge, y: -1..1 across
layout(location = 1) in vec3 aA;
layout(location = 2) in vec3 aB;
layout(location = 3) in float aBand;
uniform mat4 uViewProj;
uniform mat4 uModel;
uniform vec2 uRes;
uniform float uWidth;
out float vBand;
out float vAcross;
out float vEdge;
void main() {
  vec4 a = uViewProj * uModel * vec4(aA, 1.0);
  vec4 b = uViewProj * uModel * vec4(aB, 1.0);
  vec2 sa = a.xy / a.w * uRes;
  vec2 sb = b.xy / b.w * uRes;
  vec2 dir = normalize(sb - sa + 1e-6);
  vec2 normal = vec2(-dir.y, dir.x);
  vec4 p = mix(a, b, aCorner.x);
  p.xy += normal * aCorner.y * uWidth / uRes * p.w;
  gl_Position = p;
  vBand = aBand;
  vAcross = aCorner.y;
  vEdge = float(gl_InstanceID);
}`;

const LINE_FS = /* glsl */ `${FS_HEADER}
in float vBand; in float vAcross; in float vEdge;
out vec4 o;
${COMMON_UNIFORMS}
${RHYTHM}
uniform float uHue;
uniform float uLineBright;
${HASH}
${PALETTE}
void main() {
  float level = texture(uSpectrum, vec2(clamp(vBand, 0.0, 1.0), 0.5)).r;
  float core = 1.0 - vAcross * vAcross;
  vec3 tint = pal(uHue + vBand * 0.6 + 0.2 * colourDrive());
  float flash = step(0.93, hash11(vEdge * 7.13 + floor(uTime * 14.0))) * sparkle();
  vec3 c = mix(tint, vec3(1.0), 0.25 + 0.6 * flash) * core * uLineBright * (0.35 + 1.4 * level + 0.6 * pulse() + 1.5 * flash);
  o = vec4(c, 1.0);
}`;

const FADE_FS = /* glsl */ `${FS_HEADER}
in vec2 vUv; out vec4 o;
uniform float uKeep;
void main() { o = vec4(0.0, 0.0, 0.0, 1.0 - uKeep); }`;

/** Floor grid: lines across and along a plane under the shapes, as edges. */
function gridEdges(): Edge[] {
  const out: Edge[] = [];
  for (let i = -8; i <= 8; i++) out.push([i * 1.5, 0, -40, i * 1.5, 0, 6]);
  for (let k = 0; k <= 30; k++) out.push([-12, 0, -k * 1.5 + 6, 12, 0, -k * 1.5 + 6]);
  return out;
}

export default defineVisualizer({
  id: 'vectors',
  name: 'Vector Arcade',
  family: 'retro',
  order: 170,
  description: 'Glowing wireframes on a vector monitor with phosphor afterglow; the floor grid rolls one cell per beat.',
  create(ctx) {
    const { gl } = ctx;
    const lines = new Program(gl, LINE_VS, LINE_FS);
    const fade = new Program(gl, FULLSCREEN_VS, FADE_FS);
    const scene = new BloomScene(gl, ctx.hdr, { scale: 1 });

    // One static quad (two triangles), and per-edge instance data for each mesh.
    const quad = new Float32Array([0, -1, 1, -1, 1, 1, 0, -1, 1, 1, 0, 1]);
    const quadBuffer = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, quadBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, quad, gl.STATIC_DRAW);
    const mesh = (edges: Edge[], bandOf: (i: number) => number) => {
      const data = new Float32Array(edges.length * 7);
      edges.forEach((e, i) => {
        data.set(e, i * 7);
        data[i * 7 + 6] = bandOf(i);
      });
      const vao = gl.createVertexArray()!;
      const buffer = gl.createBuffer()!;
      gl.bindVertexArray(vao);
      gl.bindBuffer(gl.ARRAY_BUFFER, quadBuffer);
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 8, 0);
      gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
      gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
      for (const [loc, size, offset] of [[1, 3, 0], [2, 3, 12], [3, 1, 24]] as const) {
        gl.enableVertexAttribArray(loc);
        gl.vertexAttribPointer(loc, size, gl.FLOAT, false, 28, offset);
        gl.vertexAttribDivisor(loc, 1);
      }
      gl.bindVertexArray(null);
      return { vao, buffer, count: edges.length };
    };
    const shapeMeshes = SHAPES.map((edges) => mesh(edges, (i) => 0.04 + (i / edges.length) * 0.85));
    const grid = mesh(gridEdges(), (i) => 0.05 + ((i * 0.37) % 1) * 0.3);

    const proj = new Float32Array(16);
    const view = new Float32Array(16);
    const viewProj = new Float32Array(16);
    const model = new Float32Array(16);
    const spins = [0, 1.3, 2.6];
    let punch = 0;

    const setModel = (x: number, y: number, z: number, yaw: number, pitch: number, scale: number) => {
      const cy = Math.cos(yaw), sy = Math.sin(yaw), cp = Math.cos(pitch), sp = Math.sin(pitch);
      // Rotation Y * rotation X, scaled, then translated.
      model.set([cy * scale, 0, -sy * scale, 0, sy * sp * scale, cp * scale, cy * sp * scale, 0, sy * cp * scale, -sp * scale, cy * cp * scale, 0, x, y, z, 1]);
    };

    return {
      resize(width, height) {
        scene.resize(width, height);
      },
      render(frame) {
        const a = frame.audio;
        const dt = Math.min(frame.dt, 0.05);
        punch = Math.max(punch * Math.exp(-dt * 7), a.kick, a.beatPulse * 0.7);
        for (let i = 0; i < spins.length; i++) spins[i] += dt * (0.3 + 0.9 * a.vocals + 0.4 * a.mid) * (i % 2 ? -1 : 1) * (1 + i * 0.3);
        const w = scene.scene.width;
        const h = scene.scene.height;
        perspective(0.9, w / h, 0.1, 80, proj);
        lookAt([Math.sin(frame.time * 0.1) * 1.2, 1.4, 7.5], [0, 0.4, 0], [0, 1, 0], view);
        multiply(proj, view, viewProj);

        scene.begin(false);
        gl.enable(gl.BLEND);
        // Afterglow: last frame fades rather than clears.
        gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
        fade.use().set({ uKeep: 0.6 });
        drawFullscreen(gl);
        gl.blendFunc(gl.ONE, gl.ONE);
        const common = commonUniforms(frame);
        const thick = Math.max(1.5, h / 300);
        lines.use().set({ ...common, uViewProj: viewProj, uRes: [w / 2, h / 2], uWidth: thick });

        // The floor rolls one grid cell per beat when the beat is known.
        const travel = a.bpm > 0 ? ((a.beatCount + a.beatPhase) * 1.5) % 1.5 : (frame.time * 1.2) % 1.5;
        setModel(0, -1.4, travel, 0, 0, 1);
        lines.set({ uModel: model, uHue: 0.55, uLineBright: 0.22 });
        gl.bindVertexArray(grid.vao);
        gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, grid.count);

        const set = a.dropCount % SHAPES.length;
        for (let i = 0; i < 3; i++) {
          const meshIndex = (set + i) % SHAPES.length;
          const x = (i - 1) * 2.8;
          const bob = Math.sin(frame.time * 0.8 + i * 2) * 0.25;
          setModel(x, 0.6 + bob, -i * 0.3, spins[i], spins[i] * 0.6 + 0.4, (i === 1 ? 1.0 : 0.75) * (1 + 0.28 * punch));
          lines.set({ uModel: model, uHue: i * 0.3, uLineBright: 0.5 });
          gl.bindVertexArray(shapeMeshes[meshIndex].vao);
          gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, shapeMeshes[meshIndex].count);
        }
        gl.bindVertexArray(null);
        gl.disable(gl.BLEND);
        scene.end(frame, { threshold: 0.55, knee: 0.4, intensity: 0.7, vignette: 0.5, exposure: 0.9 });
      },
      dispose() {
        lines.dispose();
        fade.dispose();
        scene.dispose();
        gl.deleteBuffer(quadBuffer);
        for (const m of [...shapeMeshes, grid]) {
          gl.deleteVertexArray(m.vao);
          gl.deleteBuffer(m.buffer);
        }
      },
    };
  },
});
