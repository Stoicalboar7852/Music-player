// Beat grids for local files. While a file plays, it is decoded once more and
// analysed in a worker (beatgrid.ts); when the grid arrives the visuals switch
// from live beat tracking to the grid, which is exact. Grids are kept for the
// session, keyed by file name, size and date.

import { debug } from '../app/debug';
import { keyName } from '../player/transitions';
import type { BeatGrid } from './rhythm';

/** Longer files aren't analysed: decoding them whole would take too much memory. */
const MAX_SECONDS = 20 * 60;
const MAX_BYTES = 400e6;

export class BeatGrids {
  private readonly context: BaseAudioContext;
  private readonly cache = new Map<string, Promise<BeatGrid | null>>();
  private readonly ready = new Map<string, BeatGrid | null>();
  private worker: Worker | null = null;
  private seq = 0;
  private readonly waiting = new Map<number, (grid: BeatGrid | null) => void>();

  constructor(context: BaseAudioContext) {
    this.context = context;
  }

  /** The grid for a file, worked out on first request. Null when it has no steady beat. */
  forFile(file: File): Promise<BeatGrid | null> {
    const key = BeatGrids.key(file);
    let grid = this.cache.get(key);
    if (!grid) {
      grid = this.analyse(file).catch((error: unknown) => {
        debug('rhythm', `no beat grid for ${file.name}: ${error instanceof Error ? error.message : String(error)}`);
        return null;
      });
      this.cache.set(key, grid);
      void grid.then((g) => this.ready.set(key, g));
    }
    return grid;
  }

  /** The grid for a file if it has been worked out already (undefined while it is still being worked out). */
  peek(file: File): BeatGrid | null | undefined {
    return this.ready.get(BeatGrids.key(file));
  }

  private static key(file: File) {
    return `${file.name}|${file.size}|${file.lastModified}`;
  }

  private async analyse(file: File): Promise<BeatGrid | null> {
    if (file.size > MAX_BYTES) return null;
    const started = performance.now();
    const buffer = await this.context.decodeAudioData(await file.arrayBuffer());
    if (buffer.duration > MAX_SECONDS) return null;
    const mono = new Float32Array(buffer.length);
    const channels = buffer.numberOfChannels;
    for (let c = 0; c < channels; c++) {
      const data = buffer.getChannelData(c);
      for (let i = 0; i < data.length; i++) mono[i] += data[i] / channels;
    }
    const grid = await this.run(mono, buffer.sampleRate);
    debug(
      'rhythm',
      grid
        ? `beat grid for ${file.name}: ${grid.bpm.toFixed(1)} BPM, ${grid.beats.length} beats, confidence ${grid.confidence.toFixed(2)}${grid.key ? `, key ${keyName(grid.key)}` : ''}, ${Math.round(performance.now() - started)} ms`
        : `no steady beat in ${file.name}; tracking it live instead`,
    );
    return grid;
  }

  private run(mono: Float32Array, sampleRate: number): Promise<BeatGrid | null> {
    if (!this.worker) {
      this.worker = new Worker(new URL('./beatgridWorker.ts', import.meta.url), { type: 'module' });
      this.worker.onmessage = (event: MessageEvent<{ id: number; grid: BeatGrid | null; error?: string }>) => {
        const { id, grid, error } = event.data;
        if (error) debug('rhythm', `beat grid failed: ${error}`);
        this.waiting.get(id)?.(grid);
        this.waiting.delete(id);
      };
    }
    const id = ++this.seq;
    return new Promise((resolve) => {
      this.waiting.set(id, resolve);
      this.worker!.postMessage({ id, mono, sampleRate }, [mono.buffer]);
    });
  }
}
