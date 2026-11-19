// Circuit Board: a printed circuit board carrying the music as signals. Each
// row of traces is a band of the spectrum (bass at the bottom, treble at the
// top) and pulses run along it as that band plays; the vocals carry signals
// up the vertical traces; kicks surge power through the whole board and light
// the chips; the beat sends a wave out from the processor; hi-hats spark at
// the vias. Each drop reroutes the board.

import { COLOR, COMMON_UNIFORMS, FS_HEADER, HASH, PALETTE, RHYTHM } from '../../gl/glsl';
import { drawFullscreen, FULLSCREEN_VS, Program } from '../../gl/util';
import { bindOutput, commonUniforms, defineVisualizer } from '../types';

const FS = /* glsl */ `${FS_HEADER}
in vec2 vUv; out vec4 o;
${COMMON_UNIFORMS}
${RHYTHM}
uniform float uFlow;
uniform float uLayout;
${HASH}
${COLOR}
${PALETTE}

const float CELLS_Y = 18.0;

float spectrumAt(float x) { return texture(uSpectrum, vec2(clamp(x, 0.0, 1.0), 0.5)).r; }

float hasH(vec2 node) { return step(0.42, hash21(node + uLayout * 17.0)); }
float hasV(vec2 node) { return step(0.62, hash21(node * 1.3 + 5.0 + uLayout * 11.0)); }

void main() {
  float aspect = uRes.x / uRes.y;
  vec2 p = vec2(vUv.x * aspect, vUv.y) * CELLS_Y;
  vec2 node = floor(p + 0.5);
  vec2 f = p - node;                       // -0.5..0.5 around the nearest node
  vec3 board = vec3(0.01, 0.055, 0.035);
  vec3 copper = vec3(0.55, 0.42, 0.2);
  vec3 signal = mix(vec3(0.2, 1.0, 0.85), pal(0.4), 0.45);
  vec3 col = board + vec3(0.0, 0.02, 0.01) * hash21(floor(p * 4.0));

  float row = node.y / CELLS_Y;
  float level = spectrumAt(0.02 + clamp(row, 0.0, 1.0) * 0.92);
  float surge = pulse();

  // Horizontal traces from this node to the right, and from the left neighbour.
  float w = 0.07;
  float right = hasH(node) * step(0.0, f.x) * step(abs(f.y), w);
  float left = hasH(node - vec2(1.0, 0.0)) * step(f.x, 0.0) * step(abs(f.y), w);
  float up = hasV(node) * step(0.0, f.y) * step(abs(f.x), w);
  float down = hasV(node - vec2(0.0, 1.0)) * step(f.y, 0.0) * step(abs(f.x), w);
  float traceH = max(right, left);
  float traceV = max(up, down);
  float trace = max(traceH, traceV);
  col = mix(col, copper * (0.35 + 0.4 * surge), trace);

  // Pulses running along each row as its band plays.
  float x = p.x;
  float speed = 2.0 + 3.0 * hash11(node.y);
  float pulseX = fract((x - uFlow * speed) * 0.12 + hash11(node.y * 3.0));
  float runner = smoothstep(0.18, 0.0, pulseX) * traceH;
  col += signal * runner * (0.1 + 2.2 * level);
  // The vocals carry signals up the vertical traces.
  float pulseY = fract((p.y - uFlow * 2.5) * 0.15 + hash11(node.x * 7.0));
  col += mix(signal, pal(0.8), 0.6) * smoothstep(0.2, 0.0, pulseY) * traceV * (0.05 + 1.8 * colourDrive());
  // Power surges with the kick.
  col += signal * trace * surge * 0.35;

  // Vias, sparking with the hi-hats.
  float connections = hasH(node) + hasH(node - vec2(1.0, 0.0)) + hasV(node) + hasV(node - vec2(0.0, 1.0));
  float via = step(0.5, connections) * step(0.55, hash21(node + 3.3));
  float ring = smoothstep(0.03, 0.0, abs(length(f) - 0.16)) * via;
  col = mix(col, copper * 0.9, ring);
  float spark = via * step(length(f), 0.1) * step(0.5, hash21(node + floor(uTime * 12.0)));
  col += vec3(1.0, 0.95, 0.8) * spark * sparkle() * 1.5;

  // Chips in some blocks, their lamps lit by the kick.
  vec2 block = floor(p / vec2(5.0, 4.0));
  vec2 bf = fract(p / vec2(5.0, 4.0));
  if (hash21(block + uLayout * 3.0) > 0.78) {
    vec2 cq = (bf - 0.5) * vec2(5.0, 4.0);
    float chip = step(abs(cq.x), 1.6) * step(abs(cq.y), 1.1);
    float pins = (step(abs(cq.y), 1.0) * step(1.6, abs(cq.x)) * step(abs(cq.x), 1.85) + step(abs(cq.x), 1.5) * step(1.1, abs(cq.y)) * step(abs(cq.y), 1.35)) * step(0.5, fract(cq.x * 2.0 + cq.y * 2.0));
    col = mix(col, copper * 0.8, pins);
    col = mix(col, vec3(0.03, 0.03, 0.035), chip);
    float lamp = smoothstep(0.25, 0.1, length(cq - vec2(1.1, 0.6)));
    col += pal(0.1) * lamp * chip * (0.15 + 1.6 * surge);
  }

  // The beat sends a wave out from the centre.
  vec2 centre = vec2(aspect * 0.5, 0.5) * CELLS_Y;
  float dist = length(p - centre) / CELLS_Y;
  float wave = smoothstep(0.04, 0.0, abs(dist - (1.0 - onBeat(1.0)) * 0.9)) * onBeat(0.8);
  col += signal * wave * trace * 1.5;

  vec2 c = vUv - 0.5;
  col *= 1.0 - 0.6 * dot(c, c);
  o = vec4(aces(col * 1.3), 1.0);
}`;

export default defineVisualizer({
  id: 'circuit',
  name: 'Circuit Board',
  family: 'retro',
  order: 245,
  description: 'Signals racing across a circuit board: each row is a band of the spectrum, kicks surge power through it, beats ripple out.',
  create(ctx) {
    const { gl } = ctx;
    const program = new Program(gl, FULLSCREEN_VS, FS);
    let flow = 0;
    return {
      resize() {},
      render(frame) {
        const a = frame.audio;
        flow += Math.min(frame.dt, 0.05) * (0.6 + 1.5 * Math.max(a.bassline, a.bass * 0.5) + 0.8 * a.energy);
        bindOutput(gl, frame);
        program.use().set({ ...commonUniforms(frame), uFlow: flow, uLayout: a.dropCount % 6 });
        drawFullscreen(gl);
      },
      dispose() {
        program.dispose();
      },
    };
  },
});
