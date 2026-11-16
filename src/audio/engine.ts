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
