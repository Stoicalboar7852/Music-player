// Fluid: a real-time Navier-Stokes ink simulation (semi-Lagrangian advection,
// vorticity confinement, Jacobi pressure solve). Bass, mids and treble each
// own jets that inject ink and momentum; beats detonate bursts.

import { BloomScene } from '../../gl/bloom';
import { COLOR, FS_HEADER } from '../../gl/glsl';
import { bindTexture, drawFullscreen, FULLSCREEN_VS, PingPong, Program, Target } from '../../gl/util';
import { defineVisualizer } from '../types';

const MAX_SPLATS = 12;
const PRESSURE_ITERATIONS = 18;

const fs = (body: string) => `${FS_HEADER}\nin vec2 vUv; out vec4 o;\n${body}`;

const SPLAT_FS = fs(/* glsl */ `
uniform vec4 uPoint[${MAX_SPLATS}];      // xy = centre (uv), z = radius^2, w unused
uniform vec3 uValue[${MAX_SPLATS}];
uniform int uCount;
uniform float uAspect;
void main() {
  vec3 sum = vec3(0.0);
  for (int i = 0; i < ${MAX_SPLATS}; i++) {
    if (i >= uCount) break;
    vec2 d = (vUv - uPoint[i].xy) * vec2(uAspect, 1.0);
    sum += uValue[i] * exp(-dot(d, d) / uPoint[i].z);
  }
  o = vec4(sum, 0.0);
}`);

const ADVECT_FS = fs(/* glsl */ `
uniform sampler2D uVelocity; uniform sampler2D uSource;
uniform vec2 uTexel;       // one velocity texel in uv
uniform float uDt; uniform float uDissipation;
void main() {
  vec2 coord = vUv - uDt * texture(uVelocity, vUv).xy * uTexel;
  o = uDissipation * texture(uSource, coord);
}`);

const CURL_FS = fs(/* glsl */ `
uniform sampler2D uVelocity; uniform vec2 uTexel;
void main() {
  float l = texture(uVelocity, vUv - vec2(uTexel.x, 0.0)).y;
  float r = texture(uVelocity, vUv + vec2(uTexel.x, 0.0)).y;
  float b = texture(uVelocity, vUv - vec2(0.0, uTexel.y)).x;
  float t = texture(uVelocity, vUv + vec2(0.0, uTexel.y)).x;
  o = vec4(0.5 * (r - l - t + b), 0.0, 0.0, 1.0);
}`);

const VORTICITY_FS = fs(/* glsl */ `
uniform sampler2D uVelocity; uniform sampler2D uCurl; uniform vec2 uTexel;
uniform float uStrength; uniform float uDt;
void main() {
  float l = texture(uCurl, vUv - vec2(uTexel.x, 0.0)).x;
  float r = texture(uCurl, vUv + vec2(uTexel.x, 0.0)).x;
  float b = texture(uCurl, vUv - vec2(0.0, uTexel.y)).x;
  float t = texture(uCurl, vUv + vec2(0.0, uTexel.y)).x;
  float c = texture(uCurl, vUv).x;
  vec2 force = 0.5 * vec2(abs(t) - abs(b), abs(r) - abs(l));
  force = force / (length(force) + 1e-4) * uStrength * c;
  force.y = -force.y;
  vec2 v = texture(uVelocity, vUv).xy + force * uDt;
  o = vec4(clamp(v, -1500.0, 1500.0), 0.0, 1.0);
}`);

const DIVERGENCE_FS = fs(/* glsl */ `
uniform sampler2D uVelocity; uniform vec2 uTexel;
void main() {
  vec2 c = texture(uVelocity, vUv).xy;
  vec2 lc = vUv - vec2(uTexel.x, 0.0), rc = vUv + vec2(uTexel.x, 0.0);
  vec2 bc = vUv - vec2(0.0, uTexel.y), tc = vUv + vec2(0.0, uTexel.y);
  float l = texture(uVelocity, lc).x, r = texture(uVelocity, rc).x;
  float b = texture(uVelocity, bc).y, t = texture(uVelocity, tc).y;
  // Walls: the fluid bounces off the edges of the screen.
  if (lc.x < 0.0) l = -c.x;
  if (rc.x > 1.0) r = -c.x;
  if (bc.y < 0.0) b = -c.y;
  if (tc.y > 1.0) t = -c.y;
  o = vec4(0.5 * (r - l + t - b), 0.0, 0.0, 1.0);
}`);

const PRESSURE_FS = fs(/* glsl */ `
uniform sampler2D uPressure; uniform sampler2D uDivergence; uniform vec2 uTexel;
void main() {
  float l = texture(uPressure, vUv - vec2(uTexel.x, 0.0)).x;
  float r = texture(uPressure, vUv + vec2(uTexel.x, 0.0)).x;
  float b = texture(uPressure, vUv - vec2(0.0, uTexel.y)).x;
  float t = texture(uPressure, vUv + vec2(0.0, uTexel.y)).x;
  o = vec4((l + r + b + t - texture(uDivergence, vUv).x) * 0.25, 0.0, 0.0, 1.0);
}`);

const GRADIENT_FS = fs(/* glsl */ `
uniform sampler2D uPressure; uniform sampler2D uVelocity; uniform vec2 uTexel;
void main() {
  float l = texture(uPressure, vUv - vec2(uTexel.x, 0.0)).x;
  float r = texture(uPressure, vUv + vec2(uTexel.x, 0.0)).x;
  float b = texture(uPressure, vUv - vec2(0.0, uTexel.y)).x;
  float t = texture(uPressure, vUv + vec2(0.0, uTexel.y)).x;
  o = vec4(texture(uVelocity, vUv).xy - 0.5 * vec2(r - l, t - b), 0.0, 1.0);
}`);

const SCALE_FS = fs(/* glsl */ `
uniform sampler2D uTex; uniform float uScale;
void main() { o = texture(uTex, vUv) * uScale; }`);

const DISPLAY_FS = fs(/* glsl */ `
uniform sampler2D uDye; uniform vec2 uTexel; uniform vec3 uTint; uniform float uBeat;
${COLOR}
void main() {
  vec3 c = texture(uDye, vUv).rgb;
  // Treat ink density as a height field and light it, so the fluid has body.
  float l = luma(texture(uDye, vUv - vec2(uTexel.x, 0.0)).rgb);
  float r = luma(texture(uDye, vUv + vec2(uTexel.x, 0.0)).rgb);
  float b = luma(texture(uDye, vUv - vec2(0.0, uTexel.y)).rgb);
  float t = luma(texture(uDye, vUv + vec2(0.0, uTexel.y)).rgb);
  vec3 n = normalize(vec3(l - r, b - t, 0.22));
  float diffuse = max(dot(n, normalize(vec3(-0.45, 0.6, 0.65))), 0.0);
  float spec = pow(max(dot(n, normalize(vec3(-0.2, 0.35, 0.92))), 0.0), 40.0);
  vec3 col = c * (0.55 + 0.75 * diffuse) + vec3(spec) * 0.5 * smoothstep(0.05, 0.6, luma(c));
  col += uTint * (0.018 + 0.03 * uBeat);            // never fully black
  o = vec4(col, 1.0);
}`);

interface Splat {
  x: number;
  y: number;
  radius: number;
  value: [number, number, number];
}

export default defineVisualizer({
  id: 'fluid',
  name: 'Fluid',
  family: 'simulation',
  order: 100,
  description: 'A live ink-in-water simulation stirred by bass, mid and treble jets, with beat bursts.',
  create(ctx) {
    const { gl } = ctx;
    if (!ctx.hdr) throw new Error('Fluid needs float render targets, which this GPU does not support.');

    const program = (source: string) => new Program(gl, FULLSCREEN_VS, source);
    const splat = program(SPLAT_FS);
    const advect = program(ADVECT_FS);
    const curlP = program(CURL_FS);
    const vorticity = program(VORTICITY_FS);
    const divergenceP = program(DIVERGENCE_FS);
    const pressureP = program(PRESSURE_FS);
    const gradient = program(GRADIENT_FS);
    const scaleP = program(SCALE_FS);
    const display = program(DISPLAY_FS);
    const scene = new BloomScene(gl, ctx.hdr);

    const velocity = new PingPong(gl, 2, 2, { format: 'rg16f' });
    const dye = new PingPong(gl, 2, 2, { format: 'rgba16f' });
    const pressure = new PingPong(gl, 2, 2, { format: 'r16f' });
    const divergence = new Target(gl, 2, 2, { format: 'r16f', filter: 'nearest' });
    const curl = new Target(gl, 2, 2, { format: 'r16f', filter: 'nearest' });

    let simW = 2;
    let simH = 2;
    let aspect = 1;
    const points = new Float32Array(MAX_SPLATS * 4);
    const values = new Float32Array(MAX_SPLATS * 3);
    const forces: Splat[] = [];
    const inks: Splat[] = [];
    let wander = 0;

    const applySplats = (target: Target, list: Splat[]) => {
      if (list.length === 0) return;
      const n = Math.min(list.length, MAX_SPLATS);
      for (let i = 0; i < n; i++) {
        const s = list[i];
        points[i * 4] = s.x;
        points[i * 4 + 1] = s.y;
        points[i * 4 + 2] = s.radius;
        values.set(s.value, i * 3);
      }
      target.bind();
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE);
      splat.use().set({ uPoint: points, uValue: values, uCount: n, uAspect: aspect });
      drawFullscreen(gl);
      gl.disable(gl.BLEND);
    };

    return {
      resize(width, height) {
        aspect = width / height;
        const base = Math.round(150 + 110 * ctx.quality);
        simH = base;
        simW = Math.round(base * aspect);
        velocity.resize(simW, simH);
        pressure.resize(simW, simH);
        divergence.resize(simW, simH);
        curl.resize(simW, simH);
        const dyeH = Math.min(height, Math.round(420 + 380 * ctx.quality));
        dye.resize(Math.round(dyeH * aspect), dyeH);
        scene.resize(width, height);
      },
      render(frame) {
        const a = frame.audio;
        const dt = Math.min(frame.dt, 1 / 30);
        const f = dt * 60;
        const t = frame.time;
        const pal = frame.palette;
        const color = (i: number, gain: number): [number, number, number] => [
          pal[i * 3] * gain,
          pal[i * 3 + 1] * gain,
          pal[i * 3 + 2] * gain,
        ];
        forces.length = 0;
        inks.length = 0;
        const jet = (x: number, y: number, angle: number, power: number, radius: number, ink: [number, number, number]) => {
          forces.push({ x, y, radius, value: [Math.cos(angle) * power * f, Math.sin(angle) * power * f, 0] });
          inks.push({ x, y, radius: radius * 0.8, value: [ink[0] * f, ink[1] * f, ink[2] * f] });
        };

        // The bassline feeds a fountain from the bottom of the screen; kicks make it spurt.
        const bass = Math.max(a.bassline, a.bass * 0.5) * 0.5 + Math.max(a.kick, a.bassHit * 0.6) * 1.4;
        if (bass > 0.02) {
          jet(0.5 + 0.12 * Math.sin(t * 0.7), 0.04, Math.PI / 2 + 0.35 * Math.sin(t * 1.3), 150 * bass, 0.0028, color(0, 0.55 * bass));
        }
        // Vocals and mids: two jets from the sides, sweeping up and down; snares splash them.
        const mid = a.mid * 0.3 + a.vocals * 0.4 + Math.max(a.snare, a.midHit * 0.6) * 1.2;
        if (mid > 0.02) {
          jet(0.03, 0.5 + 0.3 * Math.sin(t * 0.53), 0.5 * Math.sin(t * 0.9), 110 * mid, 0.0016, color(1, 0.5 * mid));
          jet(0.97, 0.5 - 0.3 * Math.sin(t * 0.47), Math.PI + 0.5 * Math.sin(t * 0.8), 110 * mid, 0.0016, color(2, 0.5 * mid));
        }
        // Treble: small fast nozzles circling the upper half, flicking on the hi-hats.
        const treble = a.treble * 0.5 + Math.max(a.hat, a.trebleHit * 0.5) * 1.3;
        if (treble > 0.02) {
          for (let i = 0; i < 2; i++) {
            const ang = t * (1.7 + i * 0.6) + i * Math.PI;
            jet(0.5 + 0.3 * Math.cos(ang) / aspect * 1.6, 0.62 + 0.22 * Math.sin(ang), ang + Math.PI / 2, 95 * treble, 0.0005, color(3, 0.75 * treble));
          }
        }
        // Beat: a ring of jets blasting outward from a random spot (on a drop, from the middle).
        if (a.beat || a.drop) {
          const cx = a.drop ? 0.5 : 0.25 + 0.5 * ctx.random();
          const cy = a.drop ? 0.5 : 0.3 + 0.4 * ctx.random();
          const ink = color(Math.floor(ctx.random() * 4), 1.1);
          const offset = ctx.random() * Math.PI;
          for (let i = 0; i < 5; i++) {
            const ang = offset + (i / 5) * Math.PI * 2;
            forces.push({
              x: cx + (0.02 * Math.cos(ang)) / aspect,
              y: cy + 0.02 * Math.sin(ang),
              radius: 0.0012,
              value: [Math.cos(ang) * 420, Math.sin(ang) * 420, 0],
            });
          }
          inks.push({ x: cx, y: cy, radius: 0.0035, value: ink });
        }
        // Silence: one slow, faint stirrer keeps the surface alive.
        wander += dt * 0.6;
        const idle = 1 - a.presence;
        if (idle > 0.05) {
          jet(0.5 + 0.28 * Math.cos(wander), 0.5 + 0.28 * Math.sin(wander * 1.3), wander * 1.3 + Math.PI / 2, 22 * idle, 0.002, color(Math.floor(wander / 3) % 4, 0.09 * idle));
        }

        const texel = [1 / simW, 1 / simH];
        gl.disable(gl.BLEND);

        // 1. External forces.
        applySplats(velocity.read, forces);

        // 2. Vorticity confinement keeps small swirls from smearing away.
        curl.bind();
        curlP.use().set({ uVelocity: 0, uTexel: texel });
        bindTexture(gl, 0, velocity.read.tex);
        drawFullscreen(gl);

        velocity.write.bind();
        vorticity.use().set({ uVelocity: 0, uCurl: 1, uTexel: texel, uStrength: 14 + 26 * a.treble, uDt: dt });
        bindTexture(gl, 0, velocity.read.tex);
        bindTexture(gl, 1, curl.tex);
        drawFullscreen(gl);
        velocity.swap();

        // 3. Projection: make the velocity field divergence-free.
        divergence.bind();
        divergenceP.use().set({ uVelocity: 0, uTexel: texel });
        bindTexture(gl, 0, velocity.read.tex);
        drawFullscreen(gl);

        pressure.write.bind();
        scaleP.use().set({ uTex: 0, uScale: 0.8 });
        bindTexture(gl, 0, pressure.read.tex);
        drawFullscreen(gl);
        pressure.swap();

        pressureP.use().set({ uPressure: 0, uDivergence: 1, uTexel: texel });
        bindTexture(gl, 1, divergence.tex);
        for (let i = 0; i < PRESSURE_ITERATIONS; i++) {
          pressure.write.bind();
          bindTexture(gl, 0, pressure.read.tex);
          drawFullscreen(gl);
          pressure.swap();
        }

        velocity.write.bind();
        gradient.use().set({ uPressure: 0, uVelocity: 1, uTexel: texel });
        bindTexture(gl, 0, pressure.read.tex);
        bindTexture(gl, 1, velocity.read.tex);
        drawFullscreen(gl);
        velocity.swap();

        // 4. Move the velocity field along itself, then the ink along the velocity.
        velocity.write.bind();
        advect.use().set({ uVelocity: 0, uSource: 0, uTexel: texel, uDt: dt, uDissipation: Math.exp(-dt * 0.28) });
        bindTexture(gl, 0, velocity.read.tex);
        drawFullscreen(gl);
        velocity.swap();

        applySplats(dye.read, inks);
        dye.write.bind();
        advect.use().set({ uVelocity: 0, uSource: 1, uTexel: texel, uDt: dt, uDissipation: Math.exp(-dt * 0.62) });
        bindTexture(gl, 0, velocity.read.tex);
        bindTexture(gl, 1, dye.read.tex);
        drawFullscreen(gl);
        dye.swap();

        // 5. Shade and bloom.
        scene.begin(false);
        display.use().set({
          uDye: 0,
          uTexel: [1 / dye.read.width, 1 / dye.read.height],
          uTint: [pal[3], pal[4], pal[5]],
          uBeat: Math.max(a.kick, a.beatPulse * 0.85),
        });
        bindTexture(gl, 0, dye.read.tex);
        drawFullscreen(gl);
        scene.end(frame, { threshold: 0.7, knee: 0.5, intensity: 0.55, vignette: 0.35, exposure: 1.0 });
      },
      dispose() {
        for (const p of [splat, advect, curlP, vorticity, divergenceP, pressureP, gradient, scaleP, display]) p.dispose();
        scene.dispose();
        velocity.dispose();
        dye.dispose();
        pressure.dispose();
        divergence.dispose();
        curl.dispose();
      },
    };
  },
});
