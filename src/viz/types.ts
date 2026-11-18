// The visualizer contract.
//
// To add a visualizer, drop one file into ./visualizers that default-exports
// `defineVisualizer({...})`. The registry picks it up automatically; nothing
// else needs editing.

import type { AudioFrame } from '../audio/analysis';
import type { GL } from '../gl/util';

/** Gallery categories. */
export type Family = 'classic' | 'modern' | '3d' | 'retro' | 'simulation';

export const FAMILY_NAMES: Record<Family, string> = {
  classic: 'Classic',
  modern: 'Modern',
  '3d': '3D',
  retro: 'Retro & arcade',
  simulation: 'Simulations',
};

/** Texture units reserved for the shared audio/artwork textures. */
export const UNIT_ARTWORK = 12;
export const UNIT_HISTORY = 13;
export const UNIT_SPECTRUM = 14;
export const UNIT_WAVE = 15;

/** Rows in the scrolling spectrum-history texture (one row per 1/60s). */
export const HISTORY_ROWS = 256;

/** Long-lived resources handed to a visualizer when it is created. */
export interface VizContext {
  gl: GL;
  /** True when half-float render targets are available (bloom, simulations). */
  hdr: boolean;
  /** 0..1 hint for scaling particle counts, step counts and the like. */
  quality: number;
  /** Deterministic PRNG, so test runs are repeatable. Use instead of Math.random. */
  random(): number;
  /**
   * True in a window that mirrors another (the presenter): don't change
   * variant on your own; the other window's choice arrives via setVariant.
   */
  follower: boolean;
  /**
   * Shared textures, already bound to their reserved units every frame:
   *  - spectrum: BANDS x 1, R = magnitude 0..1 (log-spaced frequency on x)
   *  - wave: WAVE_SIZE x 1, R = mono, G = left, B = right (0.5 = silence)
   *  - history: BANDS x HISTORY_ROWS ring buffer of past spectra
   */
  spectrumTex: WebGLTexture;
  waveTex: WebGLTexture;
  historyTex: WebGLTexture;
}

/** Everything that changes per frame. */
export interface RenderFrame {
  audio: AudioFrame;
  time: number;
  dt: number;
  /** Size of the output in pixels. */
  width: number;
  height: number;
  /** Where the final image must go: null is the screen. */
  target: WebGLFramebuffer | null;
  /** Four RGB colours (12 floats) taken from the current artwork. */
  palette: Float32Array;
  /** Current cover art, or null when the track has none. */
  artwork: WebGLTexture | null;
  /** Increments whenever the artwork changes. */
  artworkVersion: number;
  /** V coordinate of the newest row in the history texture. */
  historyHead: number;
}

export interface Visualizer {
  /** Called once before the first frame and whenever the output size changes. */
  resize(width: number, height: number): void;
  /** Draw one frame into `frame.target` at `frame.width` x `frame.height`. */
  render(frame: RenderFrame): void;
  dispose(): void;
  /** Optional: resolves when asynchronous setup has finished. */
  ready?: Promise<void>;
  /** Optional: step through built-in variations (e.g. MilkDrop presets). */
  nextVariant?(direction: 1 | -1): string | void;
  /** Optional: the current variation's name. */
  variant?(): string | undefined;
  /** Optional: switch to a variation by name (also before the visualizer has finished loading). */
  setVariant?(name: string): void;
}

export interface VisualizerDef {
  id: string;
  name: string;
  family: Family;
  description: string;
  /** Position in the gallery; lower comes first. */
  order: number;
  create(ctx: VizContext): Visualizer;
}

export function defineVisualizer(def: VisualizerDef): VisualizerDef {
  return def;
}

const shared: Record<string, number | Float32Array | number[]> = {};
const res = [0, 0];

/** Uniform values matching COMMON_UNIFORMS in gl/glsl.ts. */
export function commonUniforms(frame: RenderFrame): Record<string, number | Float32Array | number[]> {
  const a = frame.audio;
  res[0] = frame.width;
  res[1] = frame.height;
  shared.uTime = frame.time;
  shared.uDt = frame.dt;
  shared.uRes = res;
  shared.uLevel = a.level;
  shared.uBass = a.bass;
  shared.uMid = a.mid;
  shared.uTreble = a.treble;
  shared.uBassHit = a.bassHit;
  shared.uMidHit = a.midHit;
  shared.uTrebleHit = a.trebleHit;
  shared.uBeat = a.beatPulse;
  shared.uBeatCount = a.beatCount;
  shared.uKick = a.kick;
  shared.uSnare = a.snare;
  shared.uHat = a.hat;
  shared.uBassline = a.bassline;
  shared.uVocals = a.vocals;
  shared.uBright = a.brightness;
  shared.uEnergy = a.energy;
  shared.uBeatPhase = a.beatPhase;
  shared.uBarPhase = a.barPhase;
  shared.uBuild = a.build;
  shared.uDrop = a.dropPulse;
  shared.uDropCount = a.dropCount;
  shared.uPal = frame.palette;
  shared.uSpectrum = UNIT_SPECTRUM;
  shared.uWave = UNIT_WAVE;
  shared.uHistory = UNIT_HISTORY;
  shared.uHistHead = frame.historyHead;
  shared.uArtwork = UNIT_ARTWORK;
  shared.uHasArt = frame.artwork ? 1 : 0;
  return shared;
}

/** Binds the frame's output target and sets the viewport to cover it. */
export function bindOutput(gl: GL, frame: RenderFrame) {
  gl.bindFramebuffer(gl.FRAMEBUFFER, frame.target);
  gl.viewport(0, 0, frame.width, frame.height);
}
