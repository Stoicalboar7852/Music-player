// Starfighter: a little pixel-art space shooter that plays itself to the
// music. A formation of crystals hangs at the top, each one a band that grows
// with it. The ship weaves with the bassline and fires on every kick; shots
// that reach a crystal burst it, snares set off bursts of their own, hi-hats
// make the stars twinkle and the engine flicker, and a drop brings a new wave.
// An original take on the vertical-scrolling shooter, not any particular game.

import { COMMON_UNIFORMS, FS_HEADER, HASH, PALETTE, RHYTHM } from '../../gl/glsl';
import { drawFullscreen, FULLSCREEN_VS, Program } from '../../gl/util';
import { bindOutput, commonUniforms, defineVisualizer } from '../types';

const BOLTS = 16;
const BOOMS = 10;
const CRYSTALS = 12;

const FS = /* glsl */ `${FS_HEADER}
in vec2 vUv; out vec4 o;
${COMMON_UNIFORMS}
${RHYTHM}
uniform float uShip;
uniform float uScroll;
uniform float uFormation;
uniform vec2 uBolts[${BOLTS}];
uniform vec3 uBooms[${BOOMS}];
${HASH}
${PALETTE}

const int CRYSTALS = ${CRYSTALS};
float spectrumAt(float x) { return texture(uSpectrum, vec2(clamp(x, 0.0, 1.0), 0.5)).r; }

// Where crystal i sits (screen units, x scaled by aspect).
vec2 crystalPos(int i, float aspect) {
  float fi = float(i);
  float wave = mod(uFormation, 3.0);
  float x = (fi + 0.5) / float(CRYSTALS);
  float y = 0.8 + 0.035 * sin(uTime * 1.3 + fi * 0.9);
  if (wave > 0.5 && wave < 1.5) y = 0.72 + 0.12 * abs(fi - 5.5) / 5.5;       // a V
  if (wave > 1.5) y = 0.76 + 0.06 * sin(fi * 1.7 + uTime * 0.6);              // a wave
  return vec2((x - 0.5) * aspect * 0.86, y);
}

void main() {
  float px = max(2.0, floor(uRes.x / 300.0));
  vec2 frag = floor(gl_FragCoord.xy / px) * px + px * 0.5;
  float aspect = uRes.x / uRes.y;
  vec2 uv = frag / uRes;
  vec2 p = vec2((uv.x - 0.5) * aspect, uv.y);
  vec3 col = vec3(0.0, 0.0, 0.012);

  // Three layers of stars rushing past.
  for (int l = 0; l < 3; l++) {
    float fl = float(l);
    float speed = 0.15 + fl * 0.22;
    vec2 g = vec2(p.x * (60.0 + fl * 30.0), (uv.y + uScroll * speed) * (40.0 + fl * 20.0));
    vec2 cell = floor(g);
    float star = step(0.9965 - fl * 0.0015, hash21(cell + fl * 31.0));
    float tw = 0.5 + 0.5 * step(0.5, hash21(cell + floor(uTime * 12.0))) * sparkle();
    col += vec3(0.55 + 0.45 * fl) * star * tw * (0.2 + 0.3 * fl);
  }

  // The formation: crystals sized by their band.
  for (int i = 0; i < CRYSTALS; i++) {
    vec2 c = crystalPos(i, aspect);
    float level = spectrumAt(0.03 + float(i) / float(CRYSTALS) * 0.85);
    float size = 0.012 + 0.04 * level;
    vec2 d = abs(p - c);
    float diamond = d.x + d.y * 0.75;
    if (diamond < size) {
      vec3 tint = pal(float(i) / float(CRYSTALS) + 0.25 * colourDrive());
      float facet = step(0.5, fract((p.x - c.x) * 90.0 + (p.y - c.y) * 40.0));
      col = tint * (0.6 + 0.6 * level + 0.25 * facet) + vec3(0.3) * pulse() * 0.4;
    } else if (diamond < size + 0.006) {
      col += pal(float(i) / float(CRYSTALS)) * 0.35;
    }
  }

  // Bursts: a ring of sparks and a flash.
  for (int i = 0; i < ${BOOMS}; i++) {
    vec3 b = uBooms[i];
    if (b.z >= 1.0) continue;
    vec2 d = p - vec2(b.x, b.y);
    float r = length(d);
    float ring = smoothstep(0.008, 0.0, abs(r - b.z * 0.09));
    float flash = smoothstep(0.03 * (1.0 - b.z), 0.0, r);
    float debris = step(0.8, hash21(floor(d * 140.0) + float(i))) * step(r, b.z * 0.1) * (1.0 - b.z);
    col += mix(pal(0.05), vec3(1.0, 0.9, 0.6), 1.0 - b.z) * (ring + flash * 2.0 + debris) * (1.0 - b.z);
  }

  // Shots.
  for (int i = 0; i < ${BOLTS}; i++) {
    vec2 b = uBolts[i];
    if (b.y < 0.0) continue;
    vec2 d = abs(p - b);
    if (d.x < 0.0035 && d.y < 0.022) col = mix(pal(0.5), vec3(1.0), 0.6) * 1.6;
  }

  // The ship: a pixel arrowhead with a flickering engine.
  vec2 s = p - vec2(uShip, 0.24);
  float body = step(abs(s.x) * 1.7 + s.y * 0.0, 0.035 - s.y * 0.9) * step(-0.02, s.y) * step(s.y, 0.04);
  float cockpit = step(length(s - vec2(0.0, 0.012)), 0.007);
  float flame = step(abs(s.x), 0.007) * step(s.y, -0.02) * step(-0.02 - 0.03 * (0.4 + 0.6 * max(sparkle(), lowDrive())), s.y);
  col = mix(col, pal(0.3) * 1.1, body);
  col = mix(col, vec3(0.8, 0.95, 1.0), cockpit);
  col += vec3(1.0, 0.55, 0.15) * flame * 1.5;

  // A border flash on the beat, and scanlines.
  col += pal(0.1) * 0.12 * pulse() * smoothstep(0.42, 0.5, max(abs(uv.x - 0.5), abs(uv.y - 0.5)));
  col *= 0.82 + 0.18 * step(0.5, fract(gl_FragCoord.y / (px * 0.5)));
  o = vec4(col, 1.0);
}`;

export default defineVisualizer({
  id: 'starfighter',
  name: 'Starfighter',
  family: 'retro',
  order: 165,
  description: 'A pixel-art shooter that plays itself: the ship fires on kicks at a formation made of the spectrum.',
  create(ctx) {
    const { gl } = ctx;
    const program = new Program(gl, FULLSCREEN_VS, FS);
    const bolts = new Float32Array(BOLTS * 2).fill(-1);
    const booms = new Float32Array(BOOMS * 3);
    for (let i = 0; i < BOOMS; i++) booms[i * 3 + 2] = 1;
    let ship = 0;
    let scroll = 0;
    let nextBolt = 0;
    let nextBoom = 0;
    let aspect = 16 / 9;

    const crystalX = (i: number, wave: number) => ((i + 0.5) / CRYSTALS - 0.5) * aspect * 0.86 * (wave >= 0 ? 1 : 1);
    const boom = (x: number, y: number) => {
      booms[nextBoom * 3] = x;
      booms[nextBoom * 3 + 1] = y;
      booms[nextBoom * 3 + 2] = 0;
      nextBoom = (nextBoom + 1) % BOOMS;
    };

    return {
      resize(width, height) {
        aspect = width / height;
      },
      render(frame) {
        const a = frame.audio;
        const dt = Math.min(frame.dt, 0.05);
        scroll += dt * (0.35 + 0.9 * a.energy + 1.2 * a.kick);
        // The ship weaves; the bassline widens its swerves.
        const target = Math.sin(frame.time * 0.9) * aspect * (0.18 + 0.2 * a.bassline) + Math.sin(frame.time * 2.3) * 0.05;
        ship += (target - ship) * Math.min(1, dt * 4);
        // Fire on every kick (or tracked beat), a pair of shots.
        if (a.kickHit || (a.beat && a.beatSource === 'tracked' && a.kick < 0.5)) {
          for (const off of [-0.018, 0.018]) {
            bolts[nextBolt * 2] = ship + off;
            bolts[nextBolt * 2 + 1] = 0.29;
            nextBolt = (nextBolt + 1) % BOLTS;
          }
        }
        // Shots fly up; one that reaches the formation bursts the nearest crystal.
        for (let i = 0; i < BOLTS; i++) {
          if (bolts[i * 2 + 1] < 0) continue;
          bolts[i * 2 + 1] += dt * 1.6;
          if (bolts[i * 2 + 1] > 0.74) {
            const x = bolts[i * 2];
            let nearest = 0;
            for (let c = 1; c < CRYSTALS; c++) if (Math.abs(crystalX(c, 0) - x) < Math.abs(crystalX(nearest, 0) - x)) nearest = c;
            if (Math.abs(crystalX(nearest, 0) - x) < 0.06) boom(crystalX(nearest, 0), 0.78);
            bolts[i * 2 + 1] = -1;
          }
        }
        // Snares set off bursts across the formation; a drop sets off a lot of them.
        if (a.snareHit) boom(crystalX(Math.floor(ctx.random() * CRYSTALS), 0), 0.76 + 0.06 * ctx.random());
        if (a.drop) for (let c = 0; c < CRYSTALS; c += 2) boom(crystalX(c, 0), 0.78);
        for (let i = 0; i < BOOMS; i++) booms[i * 3 + 2] = Math.min(1, booms[i * 3 + 2] + dt * 1.8);
        bindOutput(gl, frame);
        program.use().set({ ...commonUniforms(frame), uShip: ship, uScroll: scroll, uFormation: a.dropCount, uBolts: bolts, uBooms: booms });
        drawFullscreen(gl);
      },
      dispose() {
        program.dispose();
      },
    };
  },
});
