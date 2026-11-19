// Capturing audio that the page itself cannot read directly: other tabs, the
// whole system, or (for DRM-protected streaming services) this tab's own
// output. The captured stream feeds the analysers only; it is never played.

import { detectBrowser } from '../app/browser';
import { Emitter } from '../app/emitter';
import type { AudioEngine } from './engine';

export type CaptureKind = 'display' | 'input';

export interface CaptureState {
  active: boolean;
  kind: CaptureKind | null;
  /** Human-readable description of what is being captured. */
  label: string;
}

export type CaptureFailure = 'unsupported' | 'dismissed' | 'no-audio' | 'failed';

export class CaptureError extends Error {
  constructor(
    readonly reason: CaptureFailure,
    message: string,
  ) {
    super(message);
  }
}

export type Platform = 'windows' | 'mac' | 'linux' | 'chromeos' | 'other';

export function detectPlatform(): Platform {
  const uaData = (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData;
  const hint = `${uaData?.platform ?? ''} ${navigator.platform ?? ''} ${navigator.userAgent}`.toLowerCase();
  if (hint.includes('cros') || hint.includes('chrome os') || hint.includes('chromeos')) return 'chromeos';
  if (hint.includes('win')) return 'windows';
  if (hint.includes('mac')) return 'mac';
  if (hint.includes('linux') || hint.includes('x11')) return 'linux';
  return 'other';
}

export interface CaptureAdvice {
  /** What to choose in the browser's share dialog on this platform. */
  steps: string[];
  /** Limits worth knowing about. */
  note?: string;
}

/**
 * What the share dialog can actually deliver differs by OS:
 *  - Tab audio works everywhere in Chrome and Edge.
 *  - Whole-system audio works on Windows and ChromeOS, and on macOS 14.2+
 *    with a recent Chrome (it arrived around Chrome 141).
 *  - Linux offers tab audio only.
 *  - Sharing a single window never carries that window's audio on its own.
 */
export function captureAdvice(platform = detectPlatform()): CaptureAdvice {
  switch (platform) {
    case 'windows':
      return {
        steps: [
          'For everything your PC is playing: choose "Entire screen", pick a screen, and switch on "Also share system audio".',
          'For one browser tab: choose "Chrome tab" (or "Microsoft Edge tab"), pick the tab, and switch on "Also share tab audio".',
        ],
        note: 'Sharing a "Window" does not include sound.',
      };
    case 'mac':
      return {
        steps: [
          'For one browser tab (works on every Mac): choose the "Chrome tab" section, pick the tab that is playing, and make sure "Also share tab audio" is switched on.',
          'For everything your Mac is playing (the Music app, Spotify, anything): choose "Entire screen", pick the screen, and switch on "Also share system audio". This needs macOS 14.2 or later and Chrome or Edge 141 or later. If that switch is not in the dialog, your versions can\'t do it.',
          'The first time, macOS asks to let Chrome record the screen and system audio. If you said no, or nothing is picked up: open System Settings → Privacy & Security → Screen & System Audio Recording, switch Chrome on, then quit Chrome completely (Cmd+Q) and reopen it.',
        ],
        note: 'On older macOS or browser versions, install a free loopback device such as BlackHole, send your Mac\'s output to it, and use "Audio input device" below instead.',
      };
    case 'linux':
      return {
        steps: ['Choose "Chrome tab", pick the tab that is playing, and switch on "Also share tab audio".'],
        note: 'Chrome on Linux cannot capture whole-system audio. To visualize other apps, pick your sound server\'s "Monitor of ..." source under "Audio input device" below.',
      };
    case 'chromeos':
      return {
        steps: [
          'For everything: choose "Entire screen" and switch on "Also share system audio".',
          'For one tab: choose "Chrome tab" and switch on "Also share tab audio".',
        ],
      };
    default:
      return {
        steps: ['Choose a browser tab and switch on "Also share tab audio". If "Entire screen" offers system audio, that works too.'],
        note: 'Audio capture needs Chrome or Edge on a desktop computer.',
      };
  }
}

interface DisplayMediaExtras {
  systemAudio?: 'include' | 'exclude';
  windowAudio?: 'exclude' | 'window' | 'system';
  selfBrowserSurface?: 'include' | 'exclude';
  surfaceSwitching?: 'include' | 'exclude';
  monitorTypeSurfaces?: 'include' | 'exclude';
  preferCurrentTab?: boolean;
  controller?: unknown;
}

export class CaptureManager extends Emitter<{ change: CaptureState }> {
  state: CaptureState = { active: false, kind: null, label: '' };
  private stream: MediaStream | null = null;

  constructor(private engine: AudioEngine) {
    super();
  }

  /** Screen-share audio capture is only implemented in Chromium browsers. */
  get supported(): boolean {
    return typeof navigator.mediaDevices?.getDisplayMedia === 'function' && detectBrowser().kind === 'chromium';
  }

  /**
   * Opens the browser's share dialog. With `thisTab`, the dialog offers the
   * current tab up front, which is what the streaming services need.
   * Must be called from a user gesture.
   */
  async startDisplay(opts: { thisTab?: boolean } = {}): Promise<void> {
    if (!this.supported) {
      const { kind, name } = detectBrowser();
      throw new CaptureError(
        'unsupported',
        kind === 'chromium'
          ? 'This browser cannot capture audio. Use Chrome or Edge on a desktop computer.'
          : `${name} can't capture system or tab audio (only Chrome and Edge can). Open this page in Chrome or Edge, or use "Audio input device" with a loopback device.`,
      );
    }
    const Controller = (window as unknown as { CaptureController?: new () => { setFocusBehavior(b: string): void } })
      .CaptureController;
    const controller = Controller ? new Controller() : undefined;

    const constraints: DisplayMediaStreamOptions & DisplayMediaExtras = {
      // Video is mandatory for getDisplayMedia; ask for as little as possible and discard it.
      video: { width: { max: 640 }, height: { max: 360 }, frameRate: { max: 5 } },
      audio: {
        // Music, not a voice call: leave the signal alone.
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        channelCount: 2,
        // Keep the captured tab audible.
        suppressLocalAudioPlayback: false,
      } as MediaTrackConstraints,
      systemAudio: 'include',
      windowAudio: 'system',
      selfBrowserSurface: 'include',
      surfaceSwitching: 'include',
      monitorTypeSurfaces: 'include',
      preferCurrentTab: Boolean(opts.thisTab),
      ...(controller ? { controller } : {}),
    };

    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getDisplayMedia(constraints);
    } catch (error) {
      const name = (error as DOMException).name;
      if (name === 'NotAllowedError' || name === 'AbortError') {
        throw new CaptureError('dismissed', 'Sharing was cancelled.');
      }
      throw new CaptureError('failed', `Capture failed: ${(error as Error).message}`);
    }

    // Stay on the visualizer instead of jumping to the tab that was picked.
    try {
      controller?.setFocusBehavior('focus-capturing-application');
    } catch {
      /* only allowed for tab/window captures, and only right after the call */
    }

    const [audio] = stream.getAudioTracks();
    const [video] = stream.getVideoTracks();
    const surface = (video?.getSettings() as MediaTrackSettings & { displaySurface?: string })?.displaySurface;
    if (!audio) {
      stream.getTracks().forEach((t) => t.stop());
      let message: string;
      if (surface === 'window') {
        message = 'A window was shared, and windows do not carry sound. Share a Chrome tab or the entire screen instead.';
      } else if (surface === 'monitor' && detectPlatform() === 'mac') {
        message =
          'The screen was shared without sound. On a Mac, "Also share system audio" only appears on macOS 14.2+ with Chrome or Edge 141+. If you saw the switch, try again with it on; otherwise share the Chrome tab that is playing (with "Also share tab audio" on).';
      } else {
        message = `Nothing was shared with audio. Try again and switch on "Also share ${surface === 'monitor' ? 'system' : 'tab'} audio" in the dialog.`;
      }
      throw new CaptureError('no-audio', message);
    }

    const label =
      surface === 'monitor'
        ? 'System audio'
        : surface === 'window'
          ? 'System audio (window)'
          : opts.thisTab
            ? "This tab's audio"
            : 'Tab audio';
    // The picture is of no use here, but on macOS stopping the video track can
    // end the system-audio capture with it. Keep it running, disabled, at the
    // low size and frame rate requested above.
    if (video) video.enabled = false;
    this.adopt(stream, 'display', label);
  }

  /** Audio input devices, for loopback/monitor sources. Labels need mic permission to appear. */
  async listInputs(): Promise<MediaDeviceInfo[]> {
    const devices = await navigator.mediaDevices.enumerateDevices();
    return devices.filter((d) => d.kind === 'audioinput');
  }

  /**
   * The inputs with their names: the browser hides the names until the
   * microphone permission is granted, so this asks for it first if needed
   * (the browser's own prompt, once per site) and closes the input again.
   */
  async namedInputs(): Promise<MediaDeviceInfo[]> {
    let inputs = await this.listInputs();
    if (inputs.length && inputs.every((d) => d.label)) return inputs;
    try {
      const probe = await navigator.mediaDevices.getUserMedia({ audio: true });
      probe.getTracks().forEach((t) => t.stop());
    } catch (error) {
      const name = (error as DOMException).name;
      if (name === 'NotAllowedError') throw new CaptureError('dismissed', 'Permission to use audio inputs was denied, so their names stay hidden.');
      throw new CaptureError('failed', `Could not list the audio inputs: ${(error as Error).message}`);
    }
    inputs = await this.listInputs();
    return inputs;
  }

  /** Visualize an audio input device (a loopback device, a monitor source, or a microphone). */
  async startInput(deviceId?: string, label?: string): Promise<void> {
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          deviceId: deviceId ? { exact: deviceId } : undefined,
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
          channelCount: 2,
        },
      });
    } catch (error) {
      const name = (error as DOMException).name;
      if (name === 'NotAllowedError') throw new CaptureError('dismissed', 'Permission to use the audio input was denied.');
      throw new CaptureError('failed', `Could not open the audio input: ${(error as Error).message}`);
    }
    const track = stream.getAudioTracks()[0];
    this.adopt(stream, 'input', label || track?.label || 'Audio input');
  }

  /** Analyses a stream from elsewhere (the Android app's view of what the phone plays) as an input. */
  adoptStream(stream: MediaStream, label: string) {
    this.adopt(stream, 'input', label);
  }

  private adopt(stream: MediaStream, kind: CaptureKind, label: string) {
    this.stop();
    this.stream = stream;
    // The user can end sharing from the browser's own "Stop sharing" bar.
    for (const track of stream.getTracks()) {
      track.addEventListener('ended', () => {
        if (this.stream === stream) this.stop();
      });
    }
    void this.engine.resume();
    this.engine.attachCapture(stream);
    this.state = { active: true, kind, label };
    this.emit('change', this.state);
  }

  stop() {
    if (!this.stream) return;
    this.stream.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.engine.detachCapture();
    this.state = { active: false, kind: null, label: '' };
    this.emit('change', this.state);
  }
}
