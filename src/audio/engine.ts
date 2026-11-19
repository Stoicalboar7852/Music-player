// The Web Audio graph.
//
//   deck A: <audio> ─► low shelf ─► high-pass ─► gain ─┬─► outGain ──► speakers
//   deck B: <audio> ─► low shelf ─► high-pass ─► gain ─┤
//                                                     └─► localTap ─┐
//   capture stream ─► captureTap ───────────────────────────────────┴─► tap ─► analysers
//
// Local files play on one deck at a time; during a crossfade or a mix the
// next song starts on the other deck and the two overlap (see transitions).
// The filters are only used by mixes (bass swaps, filter rises).
//
// Captured audio (system / tab / input device) only ever reaches the analysers.
// It is never routed to the speakers, otherwise you would hear it twice.

import { FFT_SIZE } from './analysis';
import { PcmStream } from './pcmStream';

export type AnalysisInput = 'local' | 'capture';

/** One of the two players for local files, with its own gain and filters. */
export class Deck {
  readonly element: HTMLAudioElement;
  readonly gain: GainNode;
  /** Low shelf at 180 Hz: a bass swap pulls this down to about -30 dB. */
  readonly low: BiquadFilterNode;
  /** High-pass: a filter rise sweeps it up. Normally out of the way at 10 Hz. */
  readonly high: BiquadFilterNode;

  constructor(
    private readonly context: AudioContext,
    out: AudioNode,
    tap: AudioNode,
  ) {
    this.element = new Audio();
    this.element.preload = 'auto';
    // Tempo changes in a mix keep the pitch (Chrome time-stretches).
    this.element.preservesPitch = true;
    const source = context.createMediaElementSource(this.element);
    this.low = context.createBiquadFilter();
    this.low.type = 'lowshelf';
    this.low.frequency.value = 180;
    this.low.gain.value = 0;
    this.high = context.createBiquadFilter();
    this.high.type = 'highpass';
    this.high.frequency.value = 10;
    this.high.Q.value = 0.8;
    this.gain = context.createGain();
    source.connect(this.low).connect(this.high).connect(this.gain);
    this.gain.connect(out);
    this.gain.connect(tap);
  }

  /** Back to plain playback: full gain, filters open, normal speed. */
  reset() {
    const now = this.context.currentTime;
    for (const param of [this.gain.gain, this.low.gain, this.high.frequency]) param.cancelScheduledValues(now);
    this.gain.gain.setValueAtTime(1, now);
    this.low.gain.setValueAtTime(0, now);
    this.high.frequency.setValueAtTime(10, now);
    this.element.playbackRate = 1;
  }
}

/** 0.1 s of silence as a WAV data URL, used to unlock the player inside a click. */
function silentWav(): string {
  const samples = 800; // 8 kHz, 8-bit mono
  const bytes = new Uint8Array(44 + samples);
  const view = new DataView(bytes.buffer);
  const text = (offset: number, value: string) => {
    for (let i = 0; i < value.length; i++) bytes[offset + i] = value.charCodeAt(i);
  };
  text(0, 'RIFF');
  view.setUint32(4, 36 + samples, true);
  text(8, 'WAVEfmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, 8000, true);
  view.setUint32(28, 8000, true);
  view.setUint16(32, 1, true);
  view.setUint16(34, 8, true);
  text(36, 'data');
  view.setUint32(40, samples, true);
  bytes.fill(128, 44);
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return `data:audio/wav;base64,${btoa(binary)}`;
}

export class AudioEngine {
  readonly context: AudioContext;
  /** The two decks local files play on. */
  readonly decks: [Deck, Deck];
  private activeDeck = 0;
  /** Everything the visualizers hear passes through this node. */
  readonly tap: GainNode;

  private outGain: GainNode;
  private localTap: GainNode;
  private captureTap: GainNode;
  private analyserL: AnalyserNode;
  private analyserR: AnalyserNode;
  private captureNode: MediaStreamAudioSourceNode | null = null;
  private input: AnalysisInput = 'local';
  private primed = false;
  private readonly silence = silentWav();

  /** Called when audio is playing but the browser is keeping it silent. */
  onBlocked: () => void = () => {};

  constructor() {
    const ctx = new AudioContext({ latencyHint: 'playback' });
    this.context = ctx;

    this.outGain = ctx.createGain();
    this.outGain.connect(ctx.destination);
    this.tap = ctx.createGain();
    this.localTap = ctx.createGain();
    this.localTap.connect(this.tap);
    this.captureTap = ctx.createGain();
    this.captureTap.gain.value = 0;
    this.captureTap.connect(this.tap);
    this.decks = [new Deck(ctx, this.outGain, this.localTap), new Deck(ctx, this.outGain, this.localTap)];

    const splitter = ctx.createChannelSplitter(2);
    // Force stereo so a mono source still feeds both analysers.
    this.tap.channelCount = 2;
    this.tap.channelCountMode = 'explicit';
    this.tap.channelInterpretation = 'speakers';
    this.tap.connect(splitter);

    this.analyserL = this.makeAnalyser();
    this.analyserR = this.makeAnalyser();
    splitter.connect(this.analyserL, 0);
    splitter.connect(this.analyserR, 1);

    // A silent path to the destination keeps the analysers being pulled even
    // when nothing else in their subgraph is audible.
    const sink = ctx.createGain();
    sink.gain.value = 0;
    this.analyserL.connect(sink);
    this.analyserR.connect(sink);
    sink.connect(ctx.destination);

    // If an element starts while the context is still suspended (the browser
    // hasn't counted a click yet), the audio would play in silence. Try to
    // start it, and say so if the browser refuses.
    for (const deck of this.decks) {
      const el = deck.element;
      el.addEventListener('playing', () => {
        if (el.src === this.silence) return;
        if (ctx.state === 'running') return;
        void ctx.resume().catch(() => {});
        window.setTimeout(() => {
          if (ctx.state !== 'running' && !el.paused) this.onBlocked();
        }, 600);
      });
    }
  }

  /** The deck that is playing the current song. */
  get deck(): Deck {
    return this.decks[this.activeDeck];
  }

  /** The other deck, where the next song starts in a crossfade or a mix. */
  get otherDeck(): Deck {
    return this.decks[1 - this.activeDeck];
  }

  /** The element that plays the current local song. */
  get element(): HTMLAudioElement {
    return this.deck.element;
  }

  /** Makes the other deck the current one (when a crossfade or mix hands over). */
  swapDecks() {
    this.activeDeck = 1 - this.activeDeck;
  }

  /**
   * Must be called synchronously inside a user gesture (click, key press).
   * Starts the audio context and plays a moment of silence on the player so
   * that browsers which only allow sound during a gesture (Safari) also allow
   * the element to start later, e.g. after the demo track is synthesised.
   */
  unlock() {
    if (this.context.state !== 'running') void this.context.resume().catch(() => {});
    if (this.primed) return;
    this.primed = true;
    for (const { element: el } of this.decks) {
      // Already holding a track: it was started from a gesture, nothing to prime.
      if (el.getAttribute('src')) continue;
      el.src = this.silence;
      el.play().then(
        () => {
          if (el.src !== this.silence) return; // a real track took over meanwhile
          el.pause();
          el.removeAttribute('src');
          el.load();
        },
        () => {
          if (el.src === this.silence) {
            el.removeAttribute('src');
            el.load();
          }
          this.primed = false; // try again on the next gesture
        },
      );
    }
  }

  /** True while a priming clip (not real audio) is loaded on the current deck. */
  get priming(): boolean {
    return this.element.src === this.silence;
  }

  isPriming(el: HTMLAudioElement): boolean {
    return el.src === this.silence;
  }

  private makeAnalyser(): AnalyserNode {
    const a = this.context.createAnalyser();
    a.fftSize = FFT_SIZE;
    a.smoothingTimeConstant = 0;
    return a;
  }

  /** Browsers start the context suspended until a user gesture. */
  async resume() {
    if (this.context.state !== 'running') {
      try {
        await this.context.resume();
      } catch {
        /* resumed on the next gesture instead */
      }
    }
  }

  setVolume(volume: number) {
    // Volume is applied after the analysis tap so turning it down doesn't flatten the visuals.
    this.outGain.gain.setTargetAtTime(volume * volume, this.context.currentTime, 0.015);
  }

  get analysisInput(): AnalysisInput {
    return this.input;
  }

  setAnalysisInput(input: AnalysisInput) {
    if (input === this.input) return;
    this.input = input;
    const now = this.context.currentTime;
    this.localTap.gain.setTargetAtTime(input === 'local' ? 1 : 0, now, 0.03);
    this.captureTap.gain.setTargetAtTime(input === 'capture' ? 1 : 0, now, 0.03);
  }

  /**
   * A stream of raw PCM from outside the page (librespot in the desktop app),
   * seen by the analysis like a deck and heard at its own volume.
   */
  createPcmStream(): PcmStream {
    const stream = new PcmStream(this.context);
    stream.output.connect(this.localTap);
    // Its own volume, so a crossfade with a local file (whose volume is the engine's) works.
    stream.speaker.connect(this.context.destination);
    return stream;
  }

  /** Routes a captured stream into the analysers only. */
  attachCapture(stream: MediaStream) {
    this.detachCapture();
    this.captureNode = this.context.createMediaStreamSource(stream);
    this.captureNode.connect(this.captureTap);
  }

  detachCapture() {
    this.captureNode?.disconnect();
    this.captureNode = null;
  }

  get hasCapture() {
    return this.captureNode !== null;
  }

  /** Copies the most recent FFT_SIZE samples of each channel. */
  read(left: Float32Array<ArrayBuffer>, right: Float32Array<ArrayBuffer>) {
    this.analyserL.getFloatTimeDomainData(left);
    this.analyserR.getFloatTimeDomainData(right);
  }
}
