// User settings, persisted in localStorage. Service credentials live here too:
// this is a personal, single-user app with no backend, so there is nowhere
// else for them to go. They never leave the browser except to the service
// they belong to.

import type { Quality } from '../viz/renderer';
import { Emitter } from './emitter';

export type RepeatMode = 'off' | 'all' | 'one';
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
