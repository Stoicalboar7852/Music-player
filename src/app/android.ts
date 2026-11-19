// In the Android app (android/): hearing what the phone plays, the Spotify
// app included, without the microphone. The app listens natively (Android's
// Visualizer API on the output mix, or playback capture) and hands the sound
// over as 16-bit stereo PCM; it goes through a PcmStream into the analysis
// only (it's already audible from the app that plays it).

import type { AudioEngine } from '../audio/engine';
import type { CaptureManager } from '../audio/capture';
import { PcmStream } from '../audio/pcmStream';

interface AndroidBridge {
  capabilities(): string;
  start(mode: string): void;
  stop(): void;
}

export interface AndroidCapabilities {
  sdk: number;
  version: string;
  visualizer: boolean;
  playbackCapture: boolean;
  /** The "record audio" permission both ways need (Android's name for it; no microphone is used). */
  permission: boolean;
}

export type PhoneMode = 'visualizer' | 'capture';
export type PhoneResult = 'listening' | 'denied' | 'dismissed' | 'error';

/** The app's bridge, when this page runs inside Phosphor for Android. */
export const androidBridge: AndroidBridge | null = (window as unknown as { PhosphorAndroid?: AndroidBridge }).PhosphorAndroid ?? null;

export function androidCapabilities(): AndroidCapabilities | null {
  if (!androidBridge) return null;
  try {
    return JSON.parse(androidBridge.capabilities()) as AndroidCapabilities;
  } catch {
    return null;
  }
}

const LABELS: Record<PhoneMode, string> = { visualizer: 'This phone', capture: 'This phone (playback capture)' };

export class PhoneListener {
  private pcm: PcmStream | null = null;
  private mode: PhoneMode = 'visualizer';
  private waiting: ((result: PhoneResult) => void) | null = null;
  /** The last problem the app reported, for the toast. */
  detail = '';

  constructor(
    private engine: AudioEngine,
    private capture: CaptureManager,
  ) {
    Object.assign(window, {
      __phosphorNative: {
        audio: (base64: string) => this.audio(base64),
        state: (s: { state: string; detail: string }) => this.state(s),
      },
    });
    // Stopped from the page (the capture chip, another source): stop listening natively too.
    capture.on('change', (state) => {
      if (this.pcm && !(state.active && state.label === LABELS[this.mode])) {
        androidBridge?.stop();
        this.release();
      }
    });
  }

  get listening(): boolean {
    return this.pcm !== null;
  }

  /** Starts listening; resolves once the app says how it went. */
  start(mode: PhoneMode): Promise<PhoneResult> {
    if (!androidBridge) return Promise.resolve('error');
    this.mode = mode;
    this.detail = '';
    this.waiting?.('dismissed');
    return new Promise((resolve) => {
      const timer = window.setTimeout(() => finish('error'), mode === 'capture' ? 120_000 : 20_000);
      const finish = (result: PhoneResult) => {
        window.clearTimeout(timer);
        if (this.waiting === finish) this.waiting = null;
        resolve(result);
      };
      this.waiting = finish;
      androidBridge!.start(mode);
    });
  }

  stop() {
    androidBridge?.stop();
    if (this.pcm) this.capture.stop();
  }

  private attach() {
    const pcm = new PcmStream(this.engine.context, { bufferSeconds: this.mode === 'visualizer' ? 0.12 : 0.15 });
    const destination = this.engine.context.createMediaStreamDestination();
    pcm.output.connect(destination);
    // (Taking over from another capture stops that one first; this.pcm is set
    // afterwards so that stop isn't taken for ours.)
    this.capture.adoptStream(destination.stream, LABELS[this.mode]);
    this.pcm = pcm;
  }

  private release() {
    this.pcm?.dispose();
    this.pcm = null;
  }

  private audio(base64: string) {
    if (!this.pcm) this.attach();
    const text = atob(base64);
    const bytes = new Uint8Array(text.length);
    for (let i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i);
    this.pcm!.push(bytes);
  }

  private state({ state, detail }: { state: string; detail: string }) {
    if (state === 'listening') {
      if (!this.pcm) this.attach();
      this.waiting?.('listening');
    } else if (state === 'denied' || state === 'dismissed' || state === 'error') {
      this.detail = detail;
      this.waiting?.(state);
    } else if (state === 'stopped' && this.pcm) {
      this.capture.stop();
    }
  }
}
