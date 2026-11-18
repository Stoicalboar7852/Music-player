// Web Worker: works out a beat grid for a decoded file (beatgrid.ts), so the
// few seconds of number crunching never touch the frame rate.

import { analyzeBeatGrid } from './beatgrid.ts';
import type { BeatGrid } from './rhythm.ts';

interface Request {
  id: number;
  mono: Float32Array;
  sampleRate: number;
}

const scope = self as unknown as {
  onmessage: ((event: MessageEvent<Request>) => void) | null;
  postMessage(message: { id: number; grid: BeatGrid | null; error?: string }): void;
};

scope.onmessage = (event) => {
  const { id, mono, sampleRate } = event.data;
  try {
    scope.postMessage({ id, grid: analyzeBeatGrid(mono, sampleRate) });
  } catch (error) {
    scope.postMessage({ id, grid: null, error: String(error) });
  }
};
