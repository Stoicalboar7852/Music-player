// Neon Racer: an endless night drive on a pseudo-3D road, the way arcade
// racers drew them, rendered in chunky pixels. The bassline bends the road,
// kicks surge the speed and flash the kerbs, snares strobe the roadside
// posts, the city skyline is the spectrum, its windows twinkle with the
// hi-hats, and each drop moves the drive to a new time of night.

import { COLOR, COMMON_UNIFORMS, FS_HEADER, HASH, PALETTE, RHYTHM } from '../../gl/glsl';
import { drawFullscreen, FULLSCREEN_VS, Program } from '../../gl/util';
import { bindOutput, commonUniforms, defineVisualizer } from '../types';

const FS = /* glsl */ `${FS_HEADER}
in vec2 vUv; out vec4 o;
${COMMON_UNIFORMS}
${RHYTHM}
uniform float uTravel;
uniform float uCurve;
uniform float uScene;
${HASH}
${COLOR}
${PALETTE}

float spectrumAt(float x) { return texture(uSpectrum, vec2(clamp(x, 0.0, 1.0), 0.5)).r; }

void main() {
  // Chunky pixels: about 320 across.
  float px = max(2.0, floor(uRes.x / 320.0));
  vec2 frag = floor(gl_FragCoord.xy / px) * px + px * 0.5;
  vec2 uv = frag / uRes;
  float aspect = uRes.x / uRes.y;
  float horizon = 0.48;
  float scene = mod(uScene, 3.0);
  vec3 skyTop = scene < 1.0 ? vec3(0.02, 0.0, 0.08) : scene < 2.0 ? vec3(0.0, 0.03, 0.06) : vec3(0.08, 0.0, 0.03);
  vec3 skyLow = mix(pal(0.0), pal(0.5), scene / 2.0) * 0.55;
  vec3 col;

  if (uv.y > horizon) {
    // Sky, and a skyline made of the spectrum.
    float h = (uv.y - horizon) / (1.0 - horizon);
    col = mix(skyLow, skyTop, smoothstep(0.0, 0.7, h));
    float x = uv.x * aspect;
    float slot = floor(x * 24.0);
    float level = spectrumAt(0.02 + fract(slot * 0.1371) * 0.8);
    float height = 0.06 + 0.32 * level * (0.6 + 0.4 * hash11(slot));
    if (h < height) {
      col = vec3(0.01, 0.01, 0.03);
      vec2 win = vec2(fract(x * 24.0 * 4.0), fract(h * 70.0));
      float lit = step(0.55, hash21(vec2(slot * 7.0 + floor(x * 96.0), floor(h * 70.0))));
      float flicker = step(0.92, hash21(vec2(slot, floor(h * 70.0) + floor(uTime * 10.0)))) * sparkle();
      if (win.x > 0.3 && win.y > 0.35) col += pal(0.3 + 0.2 * colourDrive()) * (lit * 0.35 + flicker * 1.4);
    }
    // A big low moon.
    vec2 m = vec2(uv.x * aspect - aspect * 0.72, h - 0.42);
    col += pal(0.15) * smoothstep(0.13, 0.12, length(m)) * (0.5 + 0.4 * pulse());
  } else {
    // The road: depth from the screen row, offset by the curve.
    float y = horizon - uv.y;
    float z = 0.32 / max(y, 0.002);
    float bend = uCurve * z * z * 0.0009;
    float x = (uv.x - 0.5) * aspect - bend;
    float roadHalf = 1.1 / z * (1.0 + 0.0);
    float stripe = step(0.5, fract(z * 0.3 + uTravel));
    float onRoad = step(abs(x), roadHalf);
    vec3 grass = mix(vec3(0.02, 0.0, 0.05), vec3(0.06, 0.0, 0.1), stripe) * (1.0 + 0.4 * lowDrive());
    vec3 asphalt = mix(vec3(0.07, 0.06, 0.1), vec3(0.1, 0.09, 0.14), stripe);
    col = mix(grass, asphalt, onRoad);
    // Kerbs that flash with the kick.
    float kerb = step(roadHalf * 0.86, abs(x)) * onRoad;
    col = mix(col, mix(pal(0.0), vec3(1.0), stripe) * (0.6 + 1.2 * pulse()), kerb);
    // Lane dashes.
    float lane = step(abs(x), roadHalf * 0.03) * stripe;
    col = mix(col, vec3(0.9, 0.9, 0.8), lane);
    // Neon posts on both sides; snares strobe them.
    float postZ = fract(z * 0.12 + uTravel * 0.4);
    float post = step(abs(abs(x) - roadHalf * 1.25), roadHalf * 0.05) * step(postZ, 0.12);
    col += pal(0.6 + 0.3 * uSnare) * post * (0.8 + 2.0 * uSnare + 0.6 * onBeat(0.3));
    // Fog into the horizon.
    col = mix(col, skyLow, smoothstep(14.0, 60.0, z));
  }
  // Scanlines.
  col *= 0.86 + 0.14 * step(0.5, fract(gl_FragCoord.y / (px * 0.5)));
  o = vec4(col, 1.0);
}`;

export default defineVisualizer({
  id: 'racer',
  name: 'Neon Racer',
  family: 'retro',
  order: 160,
  description: 'An endless pixel-art night drive: the bass bends the road, kicks surge the speed, the skyline is the spectrum.',
  create(ctx) {
    const { gl } = ctx;
    const program = new Program(gl, FULLSCREEN_VS, FS);
    let travel = 0;
    let curve = 0;
    let curveTarget = 0;
    let nextBend = 0;
    return {
      resize() {},
      render(frame) {
        const a = frame.audio;
        // Cruise faster with energy; a kick surges.
        const speed = 0.9 + 1.6 * a.energy + 2.5 * Math.max(a.kick, a.beatPulse * 0.6);
        travel = (travel + frame.dt * speed) % 1000;
        // A new bend every few bars, its sharpness set by the bassline.
        nextBend -= frame.dt;
        if (nextBend <= 0 || a.drop) {
          curveTarget = (ctx.random() * 2 - 1) * (40 + 120 * Math.max(a.bassline, 0.3));
          nextBend = 3 + ctx.random() * 5;
        }
        curve += (curveTarget - curve) * Math.min(1, frame.dt * 0.6);
        bindOutput(gl, frame);
        program.use().set({ ...commonUniforms(frame), uTravel: travel, uCurve: curve, uScene: a.dropCount });
        drawFullscreen(gl);
      },
      dispose() {
        program.dispose();
      },
    };
  },
});
