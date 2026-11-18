// Ribbons: two dozen ribbons of light winding through space, each one a band
// that widens and brightens with it. The bassline sets how far they roam,
// kicks throw them outward, vocals twist and tint them, hi-hats send sparks
// running along them, and each drop rearranges the whole knot.

import { BloomScene } from '../../gl/bloom';
import { COMMON_UNIFORMS, FS_HEADER, HASH, PALETTE, RHYTHM } from '../../gl/glsl';
import { lookAt, multiply, perspective } from '../../gl/mat4';
import { Program } from '../../gl/util';
import { commonUniforms, defineVisualizer } from '../types';

const RIBBONS = 24;
const SEGMENTS = 160;

const VS = /* glsl */ `#version 300 es
precision highp float;
precision highp sampler2D;
layout(location = 0) in vec2 aVertex;     // x: 0..1 along the ribbon, y: -1 or 1 across
uniform mat4 uViewProj;
uniform vec3 uEye;
uniform float uTime;
uniform float uReach;
uniform float uThrow;
uniform float uTwist;
uniform float uForm;
uniform sampler2D uSpectrum;
out float vBand;
out float vAlong;
out float vAcross;
out float vRibbon;

vec3 curve(float i, float t) {
  float f = mod(uForm, 3.0);
  vec3 k = f < 1.0 ? vec3(1.0, 1.31, 0.77) : f < 2.0 ? vec3(0.62, 1.93, 1.17) : vec3(1.47, 0.53, 1.71);
  float ph = i * 2.399;                      // golden-angle spread
  vec3 p = vec3(sin(t * k.x + ph) * 2.2, sin(t * k.y + ph * 1.7) * 1.3, cos(t * k.z + ph * 0.6) * 2.2);
  p += 0.6 * vec3(sin(t * 2.3 + i), cos(t * 1.9 + i * 0.5), sin(t * 2.7 - i));
  return p * uReach;
}

void main() {
  float i = float(gl_InstanceID);
  float band = 0.04 + (i / ${RIBBONS - 1}.0) * 0.85;
  float level = texture(uSpectrum, vec2(band, 0.5)).r;
  float t = aVertex.x * 2.6 + uTime * (0.25 + 0.03 * mod(i, 5.0));
  vec3 p = curve(i, t);
  vec3 q = curve(i, t + 0.01);
  vec3 tangent = normalize(q - p);
  // Kicks throw everything outward from the middle.
  p *= 1.0 + 0.35 * uThrow;
  vec3 toEye = normalize(uEye - p);
  vec3 side = normalize(cross(tangent, toEye));
  // Vocals twist the ribbons about their own length.
  float twist = uTwist * sin(aVertex.x * 9.0 + i);
  side = normalize(side * cos(twist) + cross(tangent, side) * sin(twist));
  float taper = sin(3.14159 * aVertex.x);
  float width = (0.035 + 0.14 * level * level) * taper;
  gl_Position = uViewProj * vec4(p + side * aVertex.y * width, 1.0);
  vBand = band;
  vAlong = aVertex.x;
  vAcross = aVertex.y;
  vRibbon = i;
}`;

const FS = /* glsl */ `${FS_HEADER}
in float vBand; in float vAlong; in float vAcross; in float vRibbon;
out vec4 o;
${COMMON_UNIFORMS}
${RHYTHM}
${HASH}
${PALETTE}
void main() {
  float level = texture(uSpectrum, vec2(vBand, 0.5)).r;
  float edge = 1.0 - vAcross * vAcross;
  vec3 tint = pal(vRibbon / ${RIBBONS}.0 * 0.9 + 0.25 * colourDrive());
  float bright = 0.25 + 1.6 * level * level + 0.45 * pulse();
  vec3 c = tint * edge * bright;
  // Sparks running along each ribbon with the hi-hats.
  float run = fract(vAlong * 6.0 - uTime * 1.8 + hash11(vRibbon) * 7.0);
  c += vec3(1.0) * smoothstep(0.04, 0.0, run) * edge * sparkle() * 1.8;
  o = vec4(c * smoothstep(0.0, 0.08, vAlong) * smoothstep(1.0, 0.92, vAlong), 1.0);
}`;

export default defineVisualizer({
  id: 'ribbons',
  name: 'Ribbons',
  family: '3d',
  order: 150,
  description: 'Ribbons of light winding through space, each one a band; kicks throw them out, drops retie the knot.',
  create(ctx) {
    const { gl } = ctx;
    const program = new Program(gl, VS, FS);
    const scene = new BloomScene(gl, ctx.hdr, { scale: 0.85 });
    // One triangle strip per ribbon, drawn instanced.
    const strip = new Float32Array(SEGMENTS * 2 * 2);
    for (let s = 0; s < SEGMENTS; s++) {
      const x = s / (SEGMENTS - 1);
      strip.set([x, -1, x, 1], s * 4);
    }
    const vao = gl.createVertexArray()!;
    const buffer = gl.createBuffer()!;
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, strip, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 8, 0);
    gl.bindVertexArray(null);
    const proj = new Float32Array(16);
    const view = new Float32Array(16);
    const viewProj = new Float32Array(16);
    let orbit = 0;
    let reach = 1;
    let thrown = 0;
    let twist = 0;
    return {
      resize(width, height) {
        scene.resize(width, height);
      },
      render(frame) {
        const a = frame.audio;
        const dt = Math.min(frame.dt, 0.05);
        orbit += dt * (0.12 + 0.2 * a.mid);
        reach += (0.8 + 0.45 * Math.max(a.bassline, a.bass * 0.5) - reach) * Math.min(1, dt * 3);
        thrown = Math.max(thrown * Math.exp(-dt * 5), a.kick, a.beatPulse * 0.7);
        twist += (1.6 * a.vocals - twist) * Math.min(1, dt * 2);
        const eye: [number, number, number] = [Math.sin(orbit) * 5.6, 1.2 + Math.sin(orbit * 0.7) * 1.2, Math.cos(orbit) * 5.6];
        perspective(0.85, scene.scene.width / scene.scene.height, 0.1, 60, proj);
        lookAt(eye, [0, 0, 0], [0, 1, 0], view);
        multiply(proj, view, viewProj);
        scene.begin();
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.ONE, gl.ONE);
        program.use().set({
          ...commonUniforms(frame),
          uViewProj: viewProj,
          uEye: eye,
          uReach: reach,
          uThrow: thrown,
          uTwist: twist,
          uForm: a.dropCount,
        });
        gl.bindVertexArray(vao);
        gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, SEGMENTS * 2, RIBBONS);
        gl.bindVertexArray(null);
        gl.disable(gl.BLEND);
        scene.end(frame, { threshold: 0.4, knee: 0.4, intensity: 1.1, vignette: 0.35, exposure: 1.05 });
      },
      dispose() {
        program.dispose();
        scene.dispose();
        gl.deleteVertexArray(vao);
        gl.deleteBuffer(buffer);
      },
    };
  },
});
