// Raw PCM from outside the page, played and visualized like a local file:
// in the desktop app, Spotify through librespot (see desktop/librespot.mjs)
// arrives as signed 16-bit stereo at 44.1 kHz. An AudioWorklet buffers it
// (about 200 ms, to ride out uneven delivery), resamples it to the audio
// context's rate and feeds it into the same mix as the decks, so the
// speakers, the volume and the analysis all treat it like any other song.

const WORKLET = /* js */ `
class PhosphorPcm extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const o = options.processorOptions;
    this.ratio = o.inRate / sampleRate;
    this.capacity = o.inRate * 4;                 // four seconds of frames
    this.data = new Float32Array(this.capacity * 2);
    this.written = 0;                              // frames written, ever
    this.position = 0;                             // frames read (fractional)
    this.target = Math.round(o.inRate * o.bufferSeconds);
    this.playing = false;
    this.underruns = 0;
    this.port.onmessage = (event) => {
      const m = event.data;
      if (m === 'flush') {
        this.position = this.written;
        this.playing = false;
        return;
      }
      const frames = m.length >> 1;
      for (let i = 0; i < frames; i++) {
        const w = (this.written % this.capacity) * 2;
        this.data[w] = m[i * 2];
        this.data[w + 1] = m[i * 2 + 1];
        this.written++;
      }
      // Too far ahead (the sender paused for a while then caught up): drop the oldest.
      if (this.written - this.position > this.capacity - 1) this.position = this.written - this.target;
    };
  }
  process(inputs, outputs) {
    const left = outputs[0][0];
    const right = outputs[0][1] || left;
    const available = this.written - this.position;
    if (!this.playing && available >= this.target) this.playing = true;
    if (!this.playing) {
      left.fill(0);
      right.fill(0);
      return true;
    }
    // Keep the buffer near its target: read a touch faster when it grows, slower when it shrinks.
    const drift = Math.max(-0.002, Math.min(0.002, (available - this.target) / this.target * 0.002));
    const step = this.ratio * (1 + drift);
    for (let i = 0; i < left.length; i++) {
      if (this.written - this.position < 2) {
        left[i] = right[i] = 0;
        if (this.playing) this.underruns++;
        this.playing = false;
        continue;
      }
      const i0 = Math.floor(this.position);
      const f = this.position - i0;
      const a = (i0 % this.capacity) * 2;
      const b = ((i0 + 1) % this.capacity) * 2;
      left[i] = this.data[a] + (this.data[b] - this.data[a]) * f;
      right[i] = this.data[a + 1] + (this.data[b + 1] - this.data[a + 1]) * f;
      this.position += step;
    }
    return true;
  }
}
registerProcessor('phosphor-pcm', PhosphorPcm);
`;

let moduleUrl: string | null = null;

export class PcmStream {
  /** The stream before its volume: connect it to the analysis. */
  readonly output: GainNode;
  /** The stream after its volume: connect it to the speakers. */
  readonly speaker: GainNode;
  private node: AudioWorkletNode | null = null;
  private ready: Promise<void>;
  private remainder: Uint8Array | null = null;
  private pending: Float32Array[] = [];
  /** Frames received so far (for tests and the debug log). */
  received = 0;

  constructor(
    context: AudioContext,
    private options: { inRate?: number; bufferSeconds?: number } = {},
  ) {
    this.output = context.createGain();
    this.speaker = context.createGain();
    this.output.connect(this.speaker);
    moduleUrl ??= URL.createObjectURL(new Blob([WORKLET], { type: 'text/javascript' }));
    this.ready = context.audioWorklet.addModule(moduleUrl).then(() => {
      this.node = new AudioWorkletNode(context, 'phosphor-pcm', {
        numberOfInputs: 0,
        numberOfOutputs: 1,
        outputChannelCount: [2],
        processorOptions: { inRate: this.options.inRate ?? 44100, bufferSeconds: this.options.bufferSeconds ?? 0.2 },
      });
      this.node.connect(this.output);
      for (const chunk of this.pending) this.node.port.postMessage(chunk, [chunk.buffer]);
      this.pending = [];
    });
  }

  /** Resolves once the worklet is running. */
  whenReady(): Promise<void> {
    return this.ready;
  }

  /** Adds signed 16-bit little-endian interleaved stereo bytes (any chunk size). */
  push(bytes: Uint8Array) {
    let data = bytes;
    if (this.remainder) {
      const joined = new Uint8Array(this.remainder.length + bytes.length);
      joined.set(this.remainder);
      joined.set(bytes, this.remainder.length);
      data = joined;
      this.remainder = null;
    }
    const usable = data.length - (data.length % 4);
    if (usable < data.length) this.remainder = data.slice(usable);
    if (usable === 0) return;
    const view = new DataView(data.buffer, data.byteOffset, usable);
    const samples = new Float32Array(usable / 2);
    for (let i = 0; i < samples.length; i++) samples[i] = view.getInt16(i * 2, true) / 32768;
    this.received += samples.length / 2;
    if (this.node) this.node.port.postMessage(samples, [samples.buffer]);
    else this.pending.push(samples);
  }

  /** Volume 0..1 (applied after the analysis, like the decks', so turning it down doesn't dim the visuals). */
  setVolume(volume: number) {
    const ctx = this.speaker.context;
    this.speaker.gain.setTargetAtTime(volume * volume, ctx.currentTime, 0.015);
  }

  /** Drops what is buffered (after a skip, a seek or a pause), so the next audio starts promptly. */
  flush() {
    this.remainder = null;
    this.pending = [];
    this.node?.port.postMessage('flush');
  }

  dispose() {
    this.node?.disconnect();
    this.output.disconnect();
    this.speaker.disconnect();
    this.node = null;
  }
}
