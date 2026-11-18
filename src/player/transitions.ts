// Planning the move from one song to the next.
//
// A plain crossfade overlaps the end of one song with the start of the next
// for a set number of seconds, with equal-power curves so the loudness holds
// steady. A mix (local files with beat grids) is what a DJ would do: the
// incoming song starts on a downbeat lined up with a downbeat of the outgoing
// one, its tempo is matched (time-stretched, so its pitch doesn't change), and
// the hand-over follows one of three styles:
//  - fade:  an equal-power crossfade across whole bars
//  - blend: the incoming song comes in without its bass, the basslines swap
//           on a downbeat halfway through, then the outgoing song fades out
//  - rise:  the outgoing song is filtered upward into a build, and the
//           incoming one drops in at the next phrase
// Keys are taken into account: songs in clashing keys get a shorter overlap,
// so their harmonies don't sit on top of each other for long.
//
// Plain TypeScript with no browser APIs, so it can be tested in Node.

import type { BeatGrid } from '../audio/rhythm.ts';

export type TransitionMode = 'crossfade' | 'mix';
export type MixStyle = 'fade' | 'blend' | 'rise';

export interface TransitionPlan {
  /** fade/blend/rise for a mix; 'crossfade' when beats aren't lined up. */
  style: MixStyle | 'crossfade';
  /** Position (seconds) in the outgoing song where the overlap starts. */
  outStart: number;
  /** Position (seconds) in the incoming song it starts from. */
  inStart: number;
  /** How long the hand-over lasts, in seconds of the outgoing song. */
  length: number;
  /** Playback rate for the incoming song while they overlap (tempo match); 1 = none. */
  rate: number;
  /** Seconds into the hand-over when the basslines swap (blend). */
  swapAt: number;
  /** Seconds into the hand-over when the incoming song becomes audible (rise drops it in at the end). */
  enterAt: number;
  /** True when beats and bars are lined up. */
  aligned: boolean;
  /** Plain description, for the debug log. */
  why: string;
}

export interface PlanInput {
  outDuration: number;
  outGrid?: BeatGrid | null;
  inGrid?: BeatGrid | null;
  /** Crossfade length in seconds; 0 = no overlap (unless mixing). */
  crossfade: number;
  mode: TransitionMode;
  style: MixStyle;
}

/** Camelot wheel numbers: a key's neighbours (±1, or the relative major/minor) mix well. */
export function camelot(key: { tonic: number; minor: boolean }): { number: number; letter: 'A' | 'B' } {
  // tonic: pitch class with 0 = A. Camelot 8A is A minor, 8B is C major; each step of +1 is a fifth up.
  const fromA = key.minor ? key.tonic : (key.tonic + 9) % 12; // a major key's relative minor, 3 semitones down
  const fifths = (fromA * 7) % 12; // how many fifths above A minor
  return { number: ((7 + fifths) % 12) + 1, letter: key.minor ? 'A' : 'B' };
}

/** 0 = the same key or a neighbour on the wheel (mixes well), 1 = a step further, 2 = clashing. */
export function keyDistance(a: BeatGrid['key'], b: BeatGrid['key']): number {
  if (!a || !b) return 1;
  const ca = camelot(a);
  const cb = camelot(b);
  const steps = Math.min((ca.number - cb.number + 12) % 12, (cb.number - ca.number + 12) % 12);
  if (steps === 0) return 0;
  if (steps === 1 && ca.letter === cb.letter) return 0;
  if (steps <= 2) return 1;
  return 2;
}

const NOTE_NAMES = ['A', 'B♭', 'B', 'C', 'C♯', 'D', 'E♭', 'E', 'F', 'F♯', 'G', 'A♭'];
export function keyName(key: { tonic: number; minor: boolean }): string {
  const c = camelot(key);
  return `${NOTE_NAMES[key.tonic]}${key.minor ? ' minor' : ' major'} (${c.number}${c.letter})`;
}

/** The tempo ratio closest to 1 among straight, double and half time. */
function tempoRatio(outBpm: number, inBpm: number): number {
  const options = [outBpm / inBpm, (outBpm * 2) / inBpm, outBpm / (inBpm * 2)];
  return options.reduce((best, r) => (Math.abs(Math.log(r)) < Math.abs(Math.log(best)) ? r : best));
}

export function planTransition(input: PlanInput): TransitionPlan | null {
  const { outDuration, outGrid, inGrid, crossfade, mode, style } = input;
  const plain = (seconds: number, why: string): TransitionPlan | null => {
    if (!(seconds > 0) || outDuration < seconds * 2) return null;
    return { style: 'crossfade', outStart: outDuration - seconds, inStart: 0, length: seconds, rate: 1, swapAt: seconds / 2, enterAt: 0, aligned: false, why };
  };
  if (mode !== 'mix') return plain(crossfade, `crossfade over ${crossfade} s`);
  if (!outGrid || !inGrid || outGrid.beats.length < 24 || inGrid.beats.length < 24) {
    return plain(Math.max(crossfade, 6), 'crossfade: no beat grid for one of the songs yet');
  }

  // Tempo: match within ±8%, otherwise just line up the downbeats.
  const ratio = tempoRatio(outGrid.bpm, inGrid.bpm);
  const matched = Math.abs(ratio - 1) <= 0.08;
  const rate = matched ? ratio : 1;

  // How many beats to overlap: long for a blend, shorter for a rise; halved for clashing keys.
  const clash = keyDistance(outGrid.key, inGrid.key);
  let beats = style === 'blend' ? 32 : 16;
  if (clash === 2) beats = Math.max(8, beats / 2);
  if (!matched) beats = Math.min(beats, 8);

  // The outgoing song: the last phrase start (a downbeat, preferably every
  // 16 beats) that leaves room for the overlap before its beats run out.
  const ob = outGrid.beats;
  const lastBeat = ob.length - 1;
  let start = -1;
  for (const phrase of [16, 8, 4]) {
    for (let i = lastBeat - beats; i >= 0; i--) {
      if ((i - outGrid.downbeat) % phrase === 0 && i >= outGrid.downbeat) {
        start = i;
        break;
      }
    }
    if (start >= 0) break;
  }
  if (start < 0 || ob[start] < outDuration * 0.4) return plain(Math.max(crossfade, 6), 'crossfade: the outgoing song has too few beats left to mix over');
  const outStart = ob[start];
  const length = ob[start + beats] - outStart;

  // The incoming song: from its first downbeat.
  const inStart = inGrid.beats[inGrid.downbeat] ?? 0;
  const half = Math.round(beats / 2 / 4) * 4; // a downbeat about halfway
  const swapAt = ob[start + half] - outStart;
  const enterAt = style === 'rise' ? ob[start + beats - 4 >= start ? start + beats : start] - outStart : 0;
  const keyNote = clash === 2 ? ', short because the keys clash' : clash === 0 ? ', keys compatible' : '';
  return {
    style,
    outStart,
    inStart,
    length,
    rate,
    swapAt,
    enterAt: style === 'rise' ? length : enterAt,
    aligned: true,
    why: `${style} over ${beats} beats from beat ${start} (${outStart.toFixed(1)} s)${matched ? `, tempo ×${rate.toFixed(3)}` : ', tempos too far apart to match'}${keyNote}`,
  };
}
