// Lattice Flight: a raymarched flight down a corridor through an endless grid
// of cubes. Each cube is wired to one frequency band and swells with it; the
// beat sends a wave of light racing ahead of you.

import { BloomScene } from '../../gl/bloom';
import { AUDIO_SAMPLING, COLOR, COMMON_UNIFORMS, FS_HEADER, HASH, PALETTE, RHYTHM } from '../../gl/glsl';
import { drawFullscreen, FULLSCREEN_VS, Program } from '../../gl/util';
import { commonUniforms, defineVisualizer } from '../types';

const FS = /* glsl */ `${FS_HEADER}
in vec2 vUv; out vec4 o;
${COMMON_UNIFORMS}
${RHYTHM}
uniform vec3 uEye;
uniform float uRoll;
uniform float uYaw;
${HASH}
${COLOR}
${PALETTE}
${AUDIO_SAMPLING}

const float S = 1.35;         // spacing between cube centres

struct Cell { float box; float exit; vec3 q; float id; float level; float size; };

Cell cellAt(vec3 p, vec3 rd) {
  Cell c;
  vec3 ci = floor(p / S + 0.5);
  c.q = p - ci * S;
  c.id = hash31(ci);
  c.level = spectrum(0.02 + c.id * 0.9);
  c.size = 0.10 + 0.24 * c.level * c.level + 0.03 * pulse();
  vec3 d = abs(c.q) - vec3(c.size);
  c.box = length(max(d, 0.0)) + min(max(d.x, max(d.y, d.z)), 0.0) - 0.02;
  // Keep the flight path clear, and leave gaps so the grid isn't a solid wall.
  bool corridor = abs(ci.x) < 0.5 && abs(ci.y) < 0.5;
  if (corridor || hash31(ci + 17.0) > 0.66) c.box = 1e3;
  // Never step past the cell boundary: the next cell holds a different cube.
  // This is the exact distance along the ray to the wall it will leave through.
  vec3 e = (sign(rd) * 0.5 * S - c.q) / (rd + 1e-6 * sign(rd) + 1e-9);
  c.exit = min(e.x, min(e.y, e.z)) + 0.012;
  return c;
}

void main() {
  vec2 p = (gl_FragCoord.xy - 0.5 * uRes) / uRes.y;
  float cr = cos(uRoll), sr = sin(uRoll);
  p = mat2(cr, -sr, sr, cr) * p;

  vec3 ro = uEye;
  vec3 fw = normalize(vec3(sin(uYaw) * 0.35, sin(uYaw * 0.7) * 0.2, -1.0));
  vec3 rt = normalize(cross(fw, vec3(0.0, 1.0, 0.0)));
  vec3 up = cross(rt, fw);
  vec3 rd = normalize(fw * (1.05 - 0.12 * pulse()) + rt * p.x + up * p.y);

  // The beat launches a sheet of light that travels down the corridor.
  float age = -log(max(uBeat, 1e-3)) / 5.5;
  float waveZ = ro.z - age * 22.0;

  vec3 fogColor = mix(pal(0.6), pal(0.85), 0.5 + 0.5 * rd.y) * (0.035 + 0.06 * lowDrive());
  vec3 glow = vec3(0.0);
  vec3 col = fogColor;
  float t = 0.05;
  bool hit = false;
  Cell c;
  for (int i = 0; i < 72; i++) {
    vec3 pos = ro + rd * t;
    c = cellAt(pos, rd);
    if (c.box < 0.001 + 0.0015 * t) { hit = true; break; }
    float stepLen = min(c.box, c.exit);
    // Haze of light around each cube, brighter for louder bands.
    float wave = exp(-abs(pos.z - waveZ) * 0.9) * uBeat;
    glow += pal(c.id * 0.9 + 0.2 * colourDrive()) * exp(-max(c.box, 0.0) * 6.5) * (0.006 + 0.07 * c.level * c.level + 0.10 * wave + 0.05 * uTreble) * min(stepLen, 0.35) * exp(-t * 0.09);
    t += stepLen;
    if (t > 26.0) break;
  }

  if (hit) {
    vec3 pos = ro + rd * t;
    vec3 a = abs(c.q) / c.size;
    // Face normal: the axis we are furthest out along.
    vec3 n = step(a.yzx, a.xyz) * step(a.zxy, a.xyz) * sign(c.q);
    // Edge: two axes are both near the surface.
    float second = a.x + a.y + a.z - max(a.x, max(a.y, a.z)) - min(a.x, min(a.y, a.z));
    float edge = smoothstep(0.86, 0.98, second);
    vec3 tint = pal(c.id * 0.9);
    float wave = exp(-abs(pos.z - waveZ) * 0.9) * uBeat;

    vec3 surf = vec3(0.012) + tint * 0.04;
    // Glossy faces pick up the fog colour at grazing angles.
    float fres = pow(1.0 - max(dot(n, -rd), 0.0), 4.0);
    surf += fogColor * 6.0 * fres;
    // Inner panel lit by this cube's band; edges are neon.
    float panel = smoothstep(0.75, 0.55, second);
    surf += tint * panel * (0.03 + 0.75 * c.level * c.level);
    // Treble sets random cubes' edges sparking.
    float twinkle = step(0.55, hash21(vec2(c.id * 91.0, floor(uTime * 14.0))));
    surf += tint * edge * (0.4 + 1.7 * c.level + 1.8 * wave);
    surf += mix(tint, vec3(1.0), 0.6) * edge * twinkle * (1.6 * uTreble + 2.2 * sparkle());
    surf += vec3(1.0) * edge * pow(c.level, 4.0) * 0.6;

    float fog = exp(-t * 0.15);
    col = mix(fogColor, surf, fog);
  }
  col += glow;
  o = vec4(col, 1.0);
}`;

export default defineVisualizer({
  id: 'lattice',
  name: 'Lattice Flight',
  family: '3d',
  order: 85,
  description: 'A raymarched flight through an endless grid of cubes, each pulsing to its own frequency.',
  create(ctx) {
    const { gl } = ctx;
    const program = new Program(gl, FULLSCREEN_VS, FS);
    const scene = new BloomScene(gl, ctx.hdr, { scale: 0.55 + 0.4 * ctx.quality });
    let z = 0;
    let roll = 0;
    let rollDir = 1;
    return {
      resize(width, height) {
        scene.resize(width, height);
      },
      render(frame) {
        const a = frame.audio;
        const t = frame.time;
        z -= frame.dt * (1.1 + 2.6 * Math.max(a.bassline, a.bass * 0.5) + 1.5 * Math.max(a.kick, a.beatPulse * 0.85));
        // The roll turns round on a drop, or every 32 beats when there are none.
        if (a.drop || (a.beat && a.beatCount % 32 === 0)) rollDir = -rollDir;
        roll += frame.dt * rollDir * (0.04 + 0.15 * a.mid + 0.2 * a.vocals);
        const eye = [0.22 * Math.sin(t * 0.31), 0.18 * Math.cos(t * 0.27), z];
        scene.begin(false);
        program.use().set({
          ...commonUniforms(frame),
          uRes: [scene.width, scene.height],
          uEye: eye,
          uRoll: roll,
          uYaw: t * 0.23,
        });
        drawFullscreen(gl);
        scene.end(frame, { threshold: 0.7, knee: 0.5, intensity: 0.6, vignette: 0.5, exposure: 1.1 });
      },
      dispose() {
        program.dispose();
        scene.dispose();
      },
    };
  },
});
