// One analysis frame as a small binary message (under 5 KB), so another
// window can draw exactly what this one hears: the presenter window over a
// BroadcastChannel, and later a web source in presentation software over a
// socket. The receiving side never touches audio; it adopts these frames.
//
// Layout (little-endian):
//   0  float64  when the audio was read (performance.timeOrigin + now, ms)
//   8  uint32   event bits (beat, downbeat, kick, snare, hat, drop) | beat source << 8
//  12  uint32   format version
//  16  float32  the scalar fields below, in order
//   …  float32  BANDS spectrum values, 0..1
//   …  uint8    WAVE_SIZE × 4 waveform bytes (mono, left, right, 255), as uploaded

import { BANDS, WAVE_SIZE, type Analysis, type AudioFrame } from './analysis';
import type { BeatSource } from './rhythm';

const VERSION = 1;

const SCALARS = [
  'time',
  'dt',
  'level',
  'bass',
  'mid',
  'treble',
  'bassHit',
  'midHit',
  'trebleHit',
  'beatPulse',
  'beatCount',
  'presence',
  'kick',
  'snare',
  'hat',
  'bassline',
  'vocals',
  'brightness',
  'energy',
  'bpm',
  'tempoConfidence',
  'beatPhase',
  'beatInBar',
  'barPhase',
  'build',
  'dropPulse',
  'dropCount',
] as const satisfies readonly (keyof AudioFrame)[];

/** Things that are true on a single frame. A window that draws less often than the analysis runs must not miss them. */
export const EVENTS = ['beat', 'downbeat', 'kickHit', 'snareHit', 'hatHit', 'drop'] as const satisfies readonly (keyof AudioFrame)[];

const SOURCES: BeatSource[] = ['none', 'grid', 'tracked', 'onsets'];

const HEADER = 16;
const SCALAR_BYTES = SCALARS.length * 4;
const SPECTRUM_AT = HEADER + SCALAR_BYTES;
const WAVE_AT = SPECTRUM_AT + BANDS * 4;
export const FRAME_BYTES = WAVE_AT + WAVE_SIZE * 4;

/** The frame's single-frame events as bits. */
export function eventBits(frame: AudioFrame): number {
  let bits = 0;
  for (let i = 0; i < EVENTS.length; i++) if (frame[EVENTS[i]]) bits |= 1 << i;
  return bits;
}

/** Sets the frame's single-frame events from bits (what happened since it was last drawn). */
export function applyEvents(frame: AudioFrame, bits: number) {
  for (let i = 0; i < EVENTS.length; i++) frame[EVENTS[i]] = (bits & (1 << i)) !== 0;
}

/**
 * Encodes the analysis's current frame. `events` replaces the frame's own
 * event flags: everything that happened since the receiver's last frame.
 */
export function encodeFrame(analysis: Analysis, events: number, readAt: number): ArrayBuffer {
  const buffer = new ArrayBuffer(FRAME_BYTES);
  const view = new DataView(buffer);
  const f = analysis.frame;
  view.setFloat64(0, readAt, true);
  view.setUint32(8, (events & 0xff) | (Math.max(0, SOURCES.indexOf(f.beatSource)) << 8), true);
  view.setUint32(12, VERSION, true);
  for (let i = 0; i < SCALARS.length; i++) view.setFloat32(HEADER + i * 4, f[SCALARS[i]], true);
  new Float32Array(buffer, SPECTRUM_AT, BANDS).set(f.spectrum);
  new Uint8Array(buffer, WAVE_AT, WAVE_SIZE * 4).set(analysis.waveBytes);
  return buffer;
}

export interface DecodedFrame {
  /** When the audio in it was read, on the shared clock (performance.timeOrigin + now). */
  readAt: number;
  events: number;
}

/**
 * Writes an encoded frame into `analysis` (its frame, spectrum and waveform
 * bytes), as if it had analysed the audio itself. Returns null for a message
 * that isn't a frame of this version.
 */
export function decodeFrame(buffer: ArrayBuffer, analysis: Analysis): DecodedFrame | null {
  // (Not `instanceof`: a frame handed over directly by the main window is that window's ArrayBuffer.)
  if (Object.prototype.toString.call(buffer) !== '[object ArrayBuffer]' || buffer.byteLength !== FRAME_BYTES) return null;
  const view = new DataView(buffer);
  if (view.getUint32(12, true) !== VERSION) return null;
  const f = analysis.frame;
  const flags = view.getUint32(8, true);
  for (let i = 0; i < SCALARS.length; i++) f[SCALARS[i]] = view.getFloat32(HEADER + i * 4, true);
  f.beatSource = SOURCES[(flags >> 8) & 0xff] ?? 'none';
  applyEvents(f, flags & 0xff);

  const spectrum = new Float32Array(buffer, SPECTRUM_AT, BANDS);
  f.spectrum.set(spectrum);
  const bytes = analysis.spectrumBytes;
  for (let i = 0; i < BANDS; i++) bytes[i] = (Math.min(1, Math.max(0, spectrum[i])) * 255) | 0;

  const wave = new Uint8Array(buffer, WAVE_AT, WAVE_SIZE * 4);
  analysis.waveBytes.set(wave);
  for (let i = 0; i < WAVE_SIZE; i++) {
    const o = i * 4;
    f.waveform[i] = wave[o] / 127.5 - 1;
    f.waveL[i] = wave[o + 1] / 127.5 - 1;
    f.waveR[i] = wave[o + 2] / 127.5 - 1;
  }
  return { readAt: view.getFloat64(0, true), events: flags & 0xff };
}
