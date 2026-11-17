// The Web Audio graph.
//
//   <audio> (local files) ──► outGain ──► speakers
//          │
//          └──► localTap ─┐
//   capture stream ─► captureTap ─┴─► tap ─► splitter ─► analyserL / analyserR
//
// Captured audio (system / tab / input device) only ever reaches the analysers.
// It is never routed to the speakers, otherwise you would hear it twice.

import { FFT_SIZE } from './analysis';

export type AnalysisInput = 'local' | 'capture';

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
  /** The element that plays local files. */
  readonly element: HTMLAudioElement;
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

    this.element = new Audio();
    this.element.preload = 'auto';
    const source = ctx.createMediaElementSource(this.element);

    this.outGain = ctx.createGain();
    source.connect(this.outGain).connect(ctx.destination);

    this.tap = ctx.createGain();
    this.localTap = ctx.createGain();
    this.captureTap = ctx.createGain();
    this.captureTap.gain.value = 0;
    source.connect(this.localTap).connect(this.tap);
    this.captureTap.connect(this.tap);

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

    // If the element starts while the context is still suspended (the browser
    // hasn't counted a click yet), the audio would play in silence. Try to
    // start it, and say so if the browser refuses.
    this.element.addEventListener('playing', () => {
      if (this.element.src === this.silence) return;
      if (ctx.state === 'running') return;
      void ctx.resume().catch(() => {});
      window.setTimeout(() => {
        if (ctx.state !== 'running' && !this.element.paused) this.onBlocked();
      }, 600);
    });
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
    const el = this.element;
    // Already holding a track: it was started from a gesture, nothing to prime.
    if (el.getAttribute('src')) return;
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

  /** True while a priming clip (not real audio) is loaded. */
  get priming(): boolean {
    return this.element.src === this.silence;
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
