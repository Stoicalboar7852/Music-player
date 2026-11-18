// Life: a cellular automaton that steps in time with the music, four
// generations to the beat. Kicks plant patterns that grow and travel
// (R-pentominoes, acorns), snares launch gliders, hi-hats sprinkle cells, and
// each drop switches to a different rule (Life, HighLife, Day & Night,
// Seeds). Dead cells leave glowing trails coloured by the artwork.

import { COMMON_UNIFORMS, FS_HEADER, HASH, PALETTE, RHYTHM } from '../../gl/glsl';
import { bindTexture, drawFullscreen, FULLSCREEN_VS, PingPong, Program } from '../../gl/util';
import { bindOutput, commonUniforms, defineVisualizer } from '../types';

const STAMPS = 6;

const STEP_FS = /* glsl */ `${FS_HEADER}
in vec2 vUv; out vec4 o;
uniform sampler2D uCells;
uniform float uBirth;
uniform float uSurvive;
uniform vec4 uStamps[${STAMPS}];   // x, y (cells), pattern, seed (pattern < 0 = none)
uniform float uDecay;
${HASH}
bool bit(float mask, float n) { return mod(floor(mask / exp2(n)), 2.0) > 0.5; }
bool inPattern(vec2 d, float pattern, float seed) {
  ivec2 c = ivec2(d);
  if (d.x < 0.0 || d.y < 0.0) return false;
  if (pattern < 0.5) {         // R-pentomino
    return (c == ivec2(1, 0)) || (c == ivec2(2, 0)) || (c == ivec2(0, 1)) || (c == ivec2(1, 1)) || (c == ivec2(1, 2));
  } else if (pattern < 1.5) {  // glider
    return (c == ivec2(1, 0)) || (c == ivec2(2, 1)) || (c == ivec2(0, 2)) || (c == ivec2(1, 2)) || (c == ivec2(2, 2));
  } else if (pattern < 2.5) {  // acorn
    return (c == ivec2(1, 0)) || (c == ivec2(3, 1)) || (c == ivec2(0, 2)) || (c == ivec2(1, 2)) || (c == ivec2(4, 2)) || (c == ivec2(5, 2)) || (c == ivec2(6, 2));
  }
  // a patch of random soup
  return c.x < 10 && c.y < 10 && hash21(vec2(c) + seed * 13.1) < 0.42;
}
void main() {
  ivec2 size = textureSize(uCells, 0);
  ivec2 p = ivec2(gl_FragCoord.xy);
  vec4 me = texelFetch(uCells, p, 0);
  float n = 0.0;
  for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++) {
    if (x == 0 && y == 0) continue;
    n += step(0.5, texelFetch(uCells, (p + ivec2(x, y) + size) % size, 0).r);
  }
  bool alive = me.r > 0.5;
  bool next = alive ? bit(uSurvive, n) : bit(uBirth, n);
  for (int i = 0; i < ${STAMPS}; i++) {
    vec4 s = uStamps[i];
    if (s.z < 0.0) continue;
    if (inPattern(vec2(p) - s.xy, s.z, s.w)) next = true;
  }
  float trail = max(me.g * uDecay, next ? 1.0 : 0.0);
  float age = next ? (alive ? min(me.b + 0.04, 1.0) : 0.0) : 0.0;
  o = vec4(next ? 1.0 : 0.0, trail, age, 1.0);
}`;

const SHOW_FS = /* glsl */ `${FS_HEADER}
in vec2 vUv; out vec4 o;
${COMMON_UNIFORMS}
${RHYTHM}
uniform sampler2D uCells;
${HASH}
${PALETTE}
void main() {
  vec2 size = vec2(textureSize(uCells, 0));
  vec2 cell = vUv * size;
  vec4 c = texelFetch(uCells, ivec2(cell), 0);
  vec2 f = fract(cell);
  float square = smoothstep(0.0, 0.12, f.x) * smoothstep(1.0, 0.88, f.x) * smoothstep(0.0, 0.12, f.y) * smoothstep(1.0, 0.88, f.y);
  vec3 alive = mix(vec3(1.0), pal(0.2 + c.b * 0.6 + 0.3 * colourDrive()), 0.35 + 0.6 * c.b);
  vec3 trail = pal(0.55 + 0.3 * colourDrive() + 0.1 * uMid) * c.g * c.g * (0.25 + 0.35 * lowDrive() + 0.2 * uMid);
  vec3 col = trail + alive * c.r * square * (0.8 + 0.6 * pulse());
  float glint = step(0.96, hash21(floor(cell) + floor(uTime * 15.0))) * sparkle() * c.g;
  col += vec3(1.0) * glint;
  vec2 q = vUv - 0.5;
  col *= 1.0 - 0.4 * dot(q, q);
  o = vec4(col, 1.0);
}`;

/** Birth and survival neighbour counts as bitmasks. */
const RULES: [number[], number[]][] = [
  [[3], [2, 3]], // Life
  [[3, 6], [2, 3]], // HighLife
  [[3, 6, 7, 8], [3, 4, 6, 7, 8]], // Day & Night
  [[2], []], // Seeds
];
const mask = (counts: number[]) => counts.reduce((m, n) => m + 2 ** n, 0);

export default defineVisualizer({
  id: 'life',
  name: 'Life',
  family: 'simulation',
  order: 185,
  description: 'A cellular automaton stepping four generations a beat; kicks plant patterns and drops change the rules.',
  create(ctx) {
    const { gl } = ctx;
    const step = new Program(gl, FULLSCREEN_VS, STEP_FS);
    const show = new Program(gl, FULLSCREEN_VS, SHOW_FS);
    const cells = new PingPong(gl, 2, 2, { format: 'rgba8', filter: 'nearest', wrap: 'repeat' });
    const stamps = new Float32Array(STAMPS * 4).fill(-1);
    let pending = 0;
    let generation = 0;
    let clock = 0;
    let rule = 0;
    let lastStamp = 0;

    const stamp = (pattern: number) => {
      if (pending >= STAMPS) return;
      stamps.set([Math.floor(ctx.random() * cells.read.width), Math.floor(ctx.random() * cells.read.height), pattern, ctx.random() * 100], pending * 4);
      pending++;
    };
    const advance = () => {
      const [birth, survive] = RULES[rule];
      cells.write.bind();
      bindTexture(gl, 0, cells.read.tex);
      step.use().set({ uCells: 0, uBirth: mask(birth), uSurvive: mask(survive), uStamps: stamps, uDecay: rule === 3 ? 0.8 : 0.9 });
      drawFullscreen(gl);
      cells.swap();
      stamps.fill(-1);
      pending = 0;
    };

    return {
      resize(width, height) {
        const w = Math.max(80, Math.min(300, Math.round(width / 6)));
        cells.resize(w, Math.max(45, Math.round((w * height) / width)));
        for (let i = 0; i < STAMPS; i++) stamp(3);
        advance();
      },
      render(frame) {
        const a = frame.audio;
        if (a.drop) {
          rule = (rule + 1) % RULES.length;
          for (let i = 0; i < STAMPS; i++) stamp(3);
        }
        if (a.kickHit || (a.beat && a.beatSource === 'tracked' && a.kick < 0.5)) stamp(ctx.random() < 0.5 ? 0 : 2);
        if (a.snareHit) stamp(1);
        if (a.hatHit && ctx.random() < 0.5) stamp(3);
        if (pending > 0) lastStamp = frame.time;
        // Nothing has been planted for a while (quiet music): sprinkle some life.
        if (frame.time - lastStamp > 6) {
          stamp(3);
          lastStamp = frame.time;
        }
        // Four generations to the beat when the beat is known; ten a second when not.
        let target: number;
        if (a.bpm > 0 && a.tempoConfidence > 0.3) target = Math.floor((a.beatCount + a.beatPhase) * 4);
        else {
          clock += frame.dt * 10;
          target = Math.floor(clock);
        }
        if (target < generation || target - generation > 8) generation = target - 1;
        let steps = Math.min(4, target - generation);
        if (pending > 0 && steps === 0) steps = 1;
        for (let i = 0; i < steps; i++) advance();
        generation = target;
        bindOutput(gl, frame);
        bindTexture(gl, 0, cells.read.tex);
        show.use().set({ ...commonUniforms(frame), uCells: 0 });
        drawFullscreen(gl);
      },
      dispose() {
        step.dispose();
        show.dispose();
        cells.dispose();
      },
    };
  },
});
