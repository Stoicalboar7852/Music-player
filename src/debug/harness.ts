// Verification hooks exposed on window.__phosphor. They let an automated
// browser test prove that each visualizer animates and that it responds to
// bass, mids, treble and beats individually, using deterministic synthetic audio.

import type { Renderer } from '../viz/renderer';
import { fillStimulus, type Stimulus } from './stimulus';

function meanAbsDiff(a: Uint8Array, b: Uint8Array): number {
  let sum = 0;
  let n = 0;
  for (let i = 0; i < a.length; i += 4) {
    sum += Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]);
    n += 3;
  }
  return sum / n;
}

function meanBrightness(a: Uint8Array): number {
  let sum = 0;
  for (let i = 0; i < a.length; i += 4) sum += a[i] + a[i + 1] + a[i + 2];
  return sum / ((a.length / 4) * 3);
}

export interface ReactionResult {
  /** Mean per-channel difference (0-255) between the stimulus run and the silent run. */
  difference: number;
  /** How much the image changed over the last 0.2s of each run. */
  motion: number;
  motionSilent: number;
  brightness: number;
  beats: number;
}

export function createHarness(renderer: Renderer) {
  return {
    /**
     * Runs one visualizer twice from an identical starting state, once in
     * silence and once with `stimulus`, and reports how different the results are.
     */
    async reaction(id: string, stimulus: Stimulus, frames = 150): Promise<ReactionResult> {
      const run = (s: Stimulus) =>
        renderer.offlineRun(id, (t, rate, l, r) => fillStimulus(s, t, rate, l, r), { frames });
      const silent = await run('silence');
      const active = await run(stimulus);
      return {
        difference: meanAbsDiff(silent.final, active.final),
        motion: meanAbsDiff(active.final, active.earlier),
        motionSilent: meanAbsDiff(silent.final, silent.earlier),
        brightness: meanBrightness(active.final),
        beats: active.audio.beatCount,
      };
    },
    /** Band energies the analysis layer reports for a stimulus, to check it isolates what it claims. */
    async analyse(stimulus: Stimulus, frames = 150) {
      const id = renderer.defs[0].id;
      const r = await renderer.offlineRun(id, (t, rate, l, rr) => fillStimulus(stimulus, t, rate, l, rr), { frames, width: 16, height: 16 });
      const { bass, mid, treble, level, beatCount } = r.audio;
      return { bass, mid, treble, level, beatCount };
    },
  };
}
