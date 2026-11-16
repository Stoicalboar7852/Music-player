// Deterministic synthetic audio for the verification harness. Each stimulus
// isolates one thing a visualizer is supposed to respond to.

import { FFT_SIZE } from '../audio/analysis';

export type Stimulus = 'silence' | 'bass' | 'mid' | 'treble' | 'full';

const TAU = Math.PI * 2;

function noise(n: number): number {
  let x = (n | 0) * 374761393 + 668265263;
  x = (x ^ (x >>> 13)) * 1274126177;
  x ^= x >>> 16;
  return ((x >>> 0) / 4294967295) * 2 - 1;
}

/** A kick drum every half second: pitch sweeps 130Hz -> 46Hz. */
function kick(t: number): number {
  const tk = t % 0.5;
  const env = Math.exp(-tk * 9);
  const phase = TAU * (46 * tk + (84 / 32) * (1 - Math.exp(-32 * tk)));
  return Math.sin(phase) * env * 0.9;
}

/** A sustained minor chord in the midrange with slow tremolo, no transients below 300Hz. */
function chord(t: number): number {
  const trem = 0.6 + 0.4 * Math.sin(TAU * 1.5 * t);
  return (Math.sin(TAU * 440 * t) + Math.sin(TAU * 523.25 * t) + Math.sin(TAU * 659.25 * t) + 0.5 * Math.sin(TAU * 1318.5 * t)) * 0.2 * trem;
}

/** Hi-hat: high-passed noise bursts eight times a second. */
function hat(n: number, t: number): number {
  const th = t % 0.125;
  const env = Math.exp(-th * 45);
  // First difference twice = crude 12dB/oct high-pass.
  const hp = noise(n) - 2 * noise(n - 1) + noise(n - 2);
  return hp * env * 0.22;
}

export function sample(stimulus: Stimulus, n: number, sampleRate: number): number {
  const t = n / sampleRate;
  switch (stimulus) {
    case 'bass':
      return kick(t);
    case 'mid':
      return chord(t);
    case 'treble':
      return hat(n, t);
    case 'full':
      return kick(t) * 0.8 + chord(t) * 0.7 + hat(n, t);
    default:
      return 0;
  }
}

/** Fills `left`/`right` with the FFT_SIZE samples ending at `time`. */
export function fillStimulus(
  stimulus: Stimulus,
  time: number,
  sampleRate: number,
  left: Float32Array,
  right: Float32Array,
) {
  const end = Math.floor(time * sampleRate);
  for (let i = 0; i < FFT_SIZE; i++) {
    const n = end - FFT_SIZE + i;
    const s = n < 0 ? 0 : sample(stimulus, n, sampleRate);
    left[i] = s;
    // A level difference so L/R-aware visualizers have something to show
    // without adding energy outside the band under test.
    right[i] = s * 0.8;
  }
}
