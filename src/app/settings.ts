// User settings, persisted in localStorage. Service credentials live here too:
// this is a personal, single-user app with no backend, so there is nowhere
// else for them to go. They never leave the browser except to the service
// they belong to.

import type { Quality } from '../viz/renderer';
import { Emitter } from './emitter';

export type RepeatMode = 'off' | 'all' | 'one';

/** Desktop app: sending the visuals to presentation software, and following its slides. */
export interface StageSettings {
  ndi: { enabled: boolean; name: string; size: '1280x720' | '1920x1080' | '3840x2160'; fps: 30 | 60 };
  propresenter: { enabled: boolean; host: string; port: number; notes: boolean; macro: string; message: string };
  freeshow: { enabled: boolean; host: string; port: number; password: string; notes: boolean; variables: boolean; action: string };
}

export const STAGE_DEFAULTS: StageSettings = {
  ndi: { enabled: false, name: 'Phosphor', size: '1920x1080', fps: 30 },
  propresenter: { enabled: false, host: '127.0.0.1', port: 50001, notes: true, macro: '', message: '' },
  freeshow: { enabled: false, host: '127.0.0.1', port: 5506, password: '', notes: true, variables: true, action: '' },
};
export type AutoHide = 'fullscreen' | 'always' | 'never';

export interface Settings {
  visualizer: string;
  autoCycle: boolean;
  cycleSeconds: number;
  cycleShuffle: boolean;
  crossfadeSeconds: number;
  quality: Quality;
  showStats: boolean;
  autoHide: AutoHide;
  /** Open the share-this-tab dialog when a streaming song is started by a click. */
  autoShare: boolean;
  /**
   * What the visualizers listen to for streaming songs, in a browser: this
   * tab (Chrome's share dialog), or a loopback device (no dialog once the
   * microphone permission is granted; hears other apps too).
   */
  streamingListen: 'tab' | 'loopback';
  /** The loopback device chosen in Settings, by id and name (the id can change if site data is cleared). */
  loopbackDevice: { id: string; label: string } | null;
  /**
   * Android app: how it hears what the phone plays. The Visualizer API (asks
   * once, then by itself) or playback capture (full quality; Android asks
   * each time).
   */
  phoneListen: 'visualizer' | 'capture';
  /** Seconds songs overlap when one gives way to the next (0 = off). */
  songCrossfade: number;
  /** Local files: a plain crossfade, or a beat-matched mix. */
  transitionMode: 'crossfade' | 'mix';
  mixStyle: 'fade' | 'blend' | 'rise';
  volume: number;
  shuffle: boolean;
  repeat: RepeatMode;
  spotifyClientId: string;
  /**
   * Where Spotify plays: in this page (the Web Playback SDK), in the Spotify
   * app (Spotify Connect), or (desktop app only, off unless chosen) through
   * librespot, an unofficial client the app bundles.
   */
  spotifyPlayback: 'page' | 'app' | 'librespot';
  appleDeveloperToken: string;
  youtubeApiKey: string;
  /** Google OAuth client ID (web application), for signing in to YouTube. */
  googleClientId: string;
  /** How big the presenter window's QR code is. */
  presenterQrSize: 'small' | 'medium' | 'large';
  /** Desktop app: NDI, ProPresenter and FreeShow (Settings → Presentation software). */
  stage: StageSettings;
}

const DEFAULTS: Settings = {
  visualizer: 'radial',
  autoCycle: false,
  cycleSeconds: 45,
  cycleShuffle: true,
  crossfadeSeconds: 1.6,
  quality: 'auto',
  showStats: false,
  autoHide: 'fullscreen',
  autoShare: true,
  streamingListen: 'tab',
  loopbackDevice: null,
  phoneListen: 'visualizer',
  songCrossfade: 0,
  transitionMode: 'crossfade',
  mixStyle: 'blend',
  volume: 0.8,
  shuffle: false,
  repeat: 'off',
  spotifyClientId: '',
  spotifyPlayback: 'page',
  appleDeveloperToken: '',
  youtubeApiKey: '',
  googleClientId: '',
  presenterQrSize: 'medium',
  stage: STAGE_DEFAULTS,
};

const KEY = 'phosphor.settings.v1';

class SettingsStore extends Emitter<{ change: Partial<Settings> }> {
  private values: Settings;

  constructor() {
    super();
    let stored: Partial<Settings> = {};
    try {
      stored = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Partial<Settings>;
    } catch {
      /* corrupt or unavailable storage: fall back to defaults */
    }
    this.values = { ...DEFAULTS, ...stored };
  }

  get<K extends keyof Settings>(key: K): Settings[K] {
    return this.values[key];
  }

  /** The presentation software settings, with any newer fields filled in. */
  get stage(): StageSettings {
    const stored = (this.values.stage ?? {}) as Partial<StageSettings>;
    return {
      ndi: { ...STAGE_DEFAULTS.ndi, ...stored.ndi },
      propresenter: { ...STAGE_DEFAULTS.propresenter, ...stored.propresenter },
      freeshow: { ...STAGE_DEFAULTS.freeshow, ...stored.freeshow },
    };
  }

  /** Changes one part of the presentation software settings. */
  setStage<K extends keyof StageSettings>(part: K, patch: Partial<StageSettings[K]>) {
    const stage = this.stage;
    this.set({ stage: { ...stage, [part]: { ...stage[part], ...patch } } });
  }

  get all(): Readonly<Settings> {
    return this.values;
  }

  set(patch: Partial<Settings>) {
    this.values = { ...this.values, ...patch };
    try {
      localStorage.setItem(KEY, JSON.stringify(this.values));
    } catch {
      /* private mode or full storage: settings just won't persist */
    }
    this.emit('change', patch);
  }
}

export const settings = new SettingsStore();

/** The page's own address without query or hash: what OAuth redirects come back to. */
export function appBaseUrl(): string {
  return new URL('.', location.origin + location.pathname).href;
}
