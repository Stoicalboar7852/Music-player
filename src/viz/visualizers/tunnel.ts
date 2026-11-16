// Demoscene tunnel: tiled walls rushing past, each tile lit by the spectrum.
// Sound enters at the far end and flies toward you as rings of light.

import { COLOR, COMMON_UNIFORMS, FS_HEADER, HASH } from '../../gl/glsl';
import { drawFullscreen, FULLSCREEN_VS, Program } from '../../gl/util';
import { bindOutput, commonUniforms, defineVisualizer } from '../types';

const FS = /* glsl */ `${FS_HEADER}
in vec2 vUv; out vec4 o;
${COMMON_UNIFORMS}
uniform sampler2D uHistory;
uniform float uHistHead;
uniform float uTravel;   // distance flown so far
uniform float uRoll;
${HASH}
${COLOR}

const float TAU = 6.2831853;
const float SEGMENTS = 40.0;     // tiles around the circumference
const float ROWS = 2.2;          // tile rows per unit of depth
const float FAR = 9.0;           // depth at which sound enters
const float SPEED = 3.6;         // depth units per second (matches uTravel)

void main() {
  vec2 p = (gl_FragCoord.xy - 0.5 * uRes) / uRes.y;
  // The tunnel bends: its vanishing point drifts.
  vec2 bend = 0.16 * vec2(sin(uTime * 0.41), cos(uTime * 0.53)) * (0.5 + uMid);
  p -= bend;
  p *= 1.0 - 0.10 * uBeat;                         // beat: the walls lurch outward

  float r = length(p);
  float depth = 0.42 / max(r, 1e-3);
  float ang = atan(p.y, p.x) / TAU + uRoll + depth * 0.03 * sin(uTime * 0.2);

  // Tile coordinates.
  float z = depth + uTravel;
  vec2 cell = vec2(ang * SEGMENTS, z * ROWS);
  vec2 id = floor(cell);
  vec2 f = fract(cell);

  // Which moment and which frequency does this tile show?
  float tileDepth = (id.y + 0.5) / ROWS - uTravel;
  float age = clamp((FAR - tileDepth) / SPEED, 0.0, 4.0);       // seconds since it entered
  float around = fract((id.x + 0.5) / SEGMENTS);
  float freq = 0.02 + abs(around * 2.0 - 1.0) * 0.9;            // mirrored: bass meets at one seam
  float s = texture(uHistory, vec2(freq, uHistHead - age * 60.0 / 256.0)).r;
  s *= step(tileDepth, FAR);

  // Tile shape: bevelled edge, slightly domed face.
  vec2 edge = smoothstep(vec2(0.0), vec2(0.08, 0.10), f) * smoothstep(vec2(1.0), vec2(0.92, 0.90), f);
  float tile = edge.x * edge.y;
  float dome = 1.0 - 0.55 * dot(f - 0.5, f - 0.5) * 2.0;
  float checker = mod(id.x + id.y, 2.0);

  float hue = uTime * 0.03 + freq * 0.5 + id.y * 0.004;
  vec3 base = hsv2rgb(vec3(hue, 0.78, 1.0));
  vec3 col = base * (0.045 + 0.04 * checker) * tile * dome;     // unlit wall
  float lit = pow(s, 1.7);
  col += base * tile * dome * lit * 2.6;                        // lit by sound
  col += vec3(1.0) * tile * pow(s, 7.0) * 1.4;                  // loudest tiles go white-hot

  // Every sixth row is a steel rib that flashes with the beat.
  float rib = step(mod(id.y, 6.0), 0.5);
  vec3 steel = mix(vec3(0.10, 0.11, 0.14), hsv2rgb(vec3(hue + 0.5, 0.35, 1.0)), 0.25 + 0.75 * uBeat);
  col = mix(col, steel * tile * (0.6 + 1.6 * uBeat + 0.5 * dome), rib);

  // Four neon tubes run the length of the tunnel; treble makes them fizz.
  float tube = abs(fract(ang * 4.0 + 0.125) - 0.5);
  float neon = smoothstep(0.022, 0.0, tube) + 0.35 * smoothstep(0.09, 0.0, tube);
  float fizz = 0.75 + 0.25 * hash21(vec2(id.y, floor(uTime * 24.0)));
  col += hsv2rgb(vec3(uTime * 0.03 + 0.55, 0.6, 1.0)) * neon * (0.22 + 1.5 * uTreble * fizz);

  // Distance haze, then the light at the end of the tunnel.
  float fog = exp(-depth * 0.2);
  vec3 haze = hsv2rgb(vec3(uTime * 0.03 + 0.6, 0.6, 1.0));
  col = col * fog + haze * (1.0 - fog) * (0.05 + 0.12 * uLevel);
  col += haze * (0.08 + 0.55 * uBass + 0.9 * uBeat) * exp(-r * (7.5 - 3.0 * uBass));

  vec2 q = vUv - 0.5;
  col *= 1.0 - 0.6 * dot(q, q);
  col = col / (1.0 + 0.2 * col);
  o = vec4(col, 1.0);
}`;

export default defineVisualizer({
  id: 'tunnel',
  name: 'Tunnel',
  family: 'classic',
  order: 40,
  description: 'A tiled demoscene tunnel where rings of spectrum fly toward you.',
  create(ctx) {
    const { gl } = ctx;
    const program = new Program(gl, FULLSCREEN_VS, FS);
    let roll = 0;
    let rollDir = 1;
    return {
      resize() {},
      render(frame) {
        const a = frame.audio;
        if (a.beat && a.beatCount % 16 === 0) rollDir = -rollDir;
        roll += frame.dt * rollDir * (0.015 + 0.09 * a.mid);
        bindOutput(gl, frame);
        program.use().set({ ...commonUniforms(frame), uTravel: frame.time * 3.6, uRoll: roll });
        drawFullscreen(gl);
      },
      dispose() {
        program.dispose();
      },
    };
  },
});
