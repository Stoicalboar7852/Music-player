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
  volume: number;
  shuffle: boolean;
  repeat: RepeatMode;
  spotifyClientId: string;
  appleDeveloperToken: string;
  youtubeApiKey: string;
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
  volume: 0.8,
  shuffle: false,
  repeat: 'off',
  spotifyClientId: '',
  appleDeveloperToken: '',
  youtubeApiKey: '',
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
