// Slime Mold: sixty-five thousand agents that follow each other's trails, the
// way a slime mould finds food, weaving living networks. Energy sets how fast
// they travel, vocals how widely they look before turning, the bassline how
// strongly they mark their paths; kicks scatter them outward from the middle,
// hi-hats glitter on the busiest paths, and each drop starts a new colony.

import { COLOR, COMMON_UNIFORMS, FS_HEADER, HASH, PALETTE, RHYTHM } from '../../gl/glsl';
import { bindTexture, drawFullscreen, FULLSCREEN_VS, PingPong, Program } from '../../gl/util';
import { bindOutput, commonUniforms, defineVisualizer } from '../types';

const INIT_FS = /* glsl */ `${FS_HEADER}
in vec2 vUv; out vec4 o;
${HASH}
uniform float uFormation;
uniform float uSeed;
uniform float uAspect;
void main() {
  vec2 id = gl_FragCoord.xy;
  float r1 = hash21(id + uSeed), r2 = hash21(id * 1.7 + uSeed + 3.1), r3 = hash21(id * 2.3 - uSeed);
  float f = mod(uFormation, 4.0);
  vec2 pos;
  float ang;
  if (f < 1.0) {                       // a ring, facing inward
    float a = r1 * 6.2831853;
    pos = vec2(0.5) + vec2(cos(a) / uAspect, sin(a)) * (0.32 + 0.04 * r2);
    ang = a + 3.14159;
  } else if (f < 2.0) {                // a disc, facing outward
    float a = r1 * 6.2831853;
    float rr = sqrt(r2) * 0.3;
    pos = vec2(0.5) + vec2(cos(a) / uAspect, sin(a)) * rr;
    ang = a;
  } else if (f < 3.0) {                // two colonies
    float a = r1 * 6.2831853;
    vec2 c = r3 < 0.5 ? vec2(0.3, 0.5) : vec2(0.7, 0.5);
    pos = c + vec2(cos(a) / uAspect, sin(a)) * sqrt(r2) * 0.15;
    ang = r3 * 6.2831853;
  } else {                             // everywhere
    pos = vec2(r1, r2);
    ang = r3 * 6.2831853;
  }
  o = vec4(fract(pos), ang, 1.0);
}`;

const UPDATE_FS = /* glsl */ `${FS_HEADER}
in vec2 vUv; out vec4 o;
uniform sampler2D uAgents;
uniform sampler2D uTrail;
uniform vec2 uTrailRes;
uniform float uSensorAngle;
uniform float uSensorDist;
uniform float uTurn;
uniform float uSpeed;
uniform float uScatter;
uniform float uTime;
${HASH}
float sense(vec2 p, float a) {
  vec2 q = p + vec2(cos(a), sin(a)) * uSensorDist / uTrailRes;
  return texture(uTrail, fract(q)).r;
}
void main() {
  vec4 ag = texelFetch(uAgents, ivec2(gl_FragCoord.xy), 0);
  vec2 pos = ag.xy;
  float ang = ag.z;
  float f = sense(pos, ang), l = sense(pos, ang + uSensorAngle), r = sense(pos, ang - uSensorAngle);
  float rnd = hash21(gl_FragCoord.xy + fract(uTime) * 91.0);
  if (f < l && f < r) ang += (rnd - 0.5) * 2.0 * uTurn;
  else if (l > r) ang += uTurn * (0.5 + 0.5 * rnd);
  else if (r > l) ang -= uTurn * (0.5 + 0.5 * rnd);
  vec2 dir = vec2(cos(ang), sin(ang));
  pos += dir * uSpeed / uTrailRes;
  // A kick scatters everyone away from the middle.
  vec2 away = pos - 0.5;
  pos += normalize(away + 1e-5) * uScatter * 0.006;
  o = vec4(fract(pos), mod(ang, 6.2831853), 1.0);
}`;

const DEPOSIT_VS = /* glsl */ `#version 300 es
precision highp float;
precision highp sampler2D;
uniform sampler2D uAgents;
uniform float uPointSize;
void main() {
  ivec2 size = textureSize(uAgents, 0);
  ivec2 t = ivec2(gl_VertexID % size.x, gl_VertexID / size.x);
  vec4 ag = texelFetch(uAgents, t, 0);
  gl_Position = vec4(ag.xy * 2.0 - 1.0, 0.0, 1.0);
  gl_PointSize = uPointSize;
}`;

const DEPOSIT_FS = /* glsl */ `${FS_HEADER}
out vec4 o;
uniform float uDeposit;
void main() { o = vec4(uDeposit, 0.0, 0.0, 1.0); }`;

const DIFFUSE_FS = /* glsl */ `${FS_HEADER}
in vec2 vUv; out vec4 o;
uniform sampler2D uTrail;
uniform vec2 uTexel;
uniform float uDecay;
void main() {
  float s = 0.0;
  for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++) s += texture(uTrail, fract(vUv + vec2(float(x), float(y)) * uTexel)).r;
  o = vec4(min(s / 9.0 * uDecay, 4.0), 0.0, 0.0, 1.0);
}`;

const SHOW_FS = /* glsl */ `${FS_HEADER}
in vec2 vUv; out vec4 o;
${COMMON_UNIFORMS}
${RHYTHM}
uniform sampler2D uTrail;
${HASH}
${COLOR}
${PALETTE}
void main() {
  float v = texture(uTrail, vUv).r;
  float t = 1.0 - exp(-v * 1.6);
  vec3 col = mix(vec3(0.0), pal(0.1 + 0.25 * colourDrive()), smoothstep(0.0, 0.35, t));
  col = mix(col, pal(0.55 + 0.25 * colourDrive() + 0.1 * uMid), smoothstep(0.35, 0.75, t));
  col = mix(col, vec3(1.0, 0.97, 0.9), smoothstep(0.78, 1.0, t));
  col *= 0.75 + 0.35 * lowDrive() + 0.4 * pulse();
  float glint = step(0.97, hash21(floor(gl_FragCoord.xy / 2.0) + floor(uTime * 24.0))) * smoothstep(0.5, 0.9, t) * sparkle();
  col += vec3(1.0) * glint;
  vec2 q = vUv - 0.5;
  col *= 1.0 - 0.4 * dot(q, q);
  o = vec4(col, 1.0);
}`;

export default defineVisualizer({
  id: 'slime',
  name: 'Slime Mold',
  family: 'simulation',
  order: 190,
  description: 'Sixty-five thousand agents following each other’s trails into living networks; kicks scatter them.',
  create(ctx) {
    const { gl } = ctx;
    const init = new Program(gl, FULLSCREEN_VS, INIT_FS);
    const update = new Program(gl, FULLSCREEN_VS, UPDATE_FS);
    const deposit = new Program(gl, DEPOSIT_VS, DEPOSIT_FS);
    const diffuse = new Program(gl, FULLSCREEN_VS, DIFFUSE_FS);
    const show = new Program(gl, FULLSCREEN_VS, SHOW_FS);
    const precise = Boolean(gl.getExtension('EXT_color_buffer_float'));
    const side = ctx.quality < 0.5 ? 160 : 256;
    const agents = new PingPong(gl, side, side, { format: precise ? 'rgba32f' : 'rgba16f', filter: 'nearest' });
    const trail = new PingPong(gl, 2, 2, { format: ctx.hdr ? 'rgba16f' : 'rgba8', wrap: 'repeat' });
    const vao = gl.createVertexArray()!;
    let aspect = 16 / 9;
    let scatter = 0;

    const seed = (formation: number, s: number) => {
      for (const t of [agents.read, agents.write]) {
        t.bind();
        init.use().set({ uFormation: formation, uSeed: s, uAspect: aspect });
        drawFullscreen(gl);
      }
    };

    return {
      resize(width, height) {
        aspect = width / height;
        const w = Math.max(160, Math.min(640, Math.round(width / 2.2)));
        trail.resize(w, Math.max(90, Math.round(w / aspect)));
        for (const t of [trail.read, trail.write]) {
          t.bind();
          gl.clearColor(0, 0, 0, 1);
          gl.clear(gl.COLOR_BUFFER_BIT);
        }
        seed(0, 1);
      },
      render(frame) {
        const a = frame.audio;
        if (a.drop) seed(a.dropCount, frame.time);
        scatter = Math.max(scatter * Math.exp(-frame.dt * 6), a.kick, a.beatPulse * 0.5);
        const trailRes = [trail.read.width, trail.read.height];

        // 1. Agents sense, turn and move.
        agents.write.bind();
        bindTexture(gl, 0, agents.read.tex);
        bindTexture(gl, 1, trail.read.tex);
        update.use().set({
          uAgents: 0,
          uTrail: 1,
          uTrailRes: trailRes,
          uSensorAngle: 0.35 + 0.65 * a.vocals,
          uSensorDist: 9,
          uTurn: 0.22 + 0.35 * a.mid,
          uSpeed: 0.6 + 1.4 * a.energy + 1.2 * scatter,
          uScatter: scatter,
          uTime: frame.time,
        });
        drawFullscreen(gl);
        agents.swap();

        // 2. Trails spread out and fade.
        trail.write.bind();
        bindTexture(gl, 0, trail.read.tex);
        diffuse.use().set({ uTrail: 0, uTexel: [1 / trail.read.width, 1 / trail.read.height], uDecay: 0.93 });
        drawFullscreen(gl);
        trail.swap();

        // 3. Every agent marks where it is.
        trail.read.bind();
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.ONE, gl.ONE);
        bindTexture(gl, 0, agents.read.tex);
        deposit.use().set({ uAgents: 0, uPointSize: 1, uDeposit: 0.05 + 0.18 * Math.max(a.bassline, a.bass * 0.5) + 0.1 * a.level });
        gl.bindVertexArray(vao);
        gl.drawArrays(gl.POINTS, 0, side * side);
        gl.bindVertexArray(null);
        gl.disable(gl.BLEND);

        // 4. Show the trails.
        bindOutput(gl, frame);
        bindTexture(gl, 0, trail.read.tex);
        show.use().set({ ...commonUniforms(frame), uTrail: 0 });
        drawFullscreen(gl);
      },
      dispose() {
        for (const p of [init, update, deposit, diffuse, show]) p.dispose();
        agents.dispose();
        trail.dispose();
        gl.deleteVertexArray(vao);
      },
    };
  },
});
