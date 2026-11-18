// What the main window (the controller) and its presenter windows say to each
// other over the 'phosphor-presenter' BroadcastChannel.
//
// The presenter draws the same visualizer from the controller's analysis:
// every animation frame it asks for the latest one ('pull'), and the
// controller answers with an encoded frame (audio/frameCodec.ts). Asking,
// rather than being sent frames, keeps the presenter smooth while the
// controller window is hidden and draws nothing itself.

import type { Quality } from '../viz/renderer';

export const CHANNEL = 'phosphor-presenter';
/** window.open() name of the presenter, so a second press finds the open one. */
export const WINDOW_NAME = 'phosphor-presenter';

export type QrSize = 'small' | 'medium' | 'large';

export interface Overlays {
  /** A QR code for the song's own link (hidden for songs without one). */
  qr: boolean;
  /** Title and artist, lower third. */
  title: boolean;
  /** A logo in the corner: the one chosen in Settings, or Phosphor's. */
  logo: boolean;
  /** Black screen. */
  blackout: boolean;
  /** Hold the current picture. */
  freeze: boolean;
}

export const NO_OVERLAYS: Overlays = { qr: false, title: false, logo: false, blackout: false, freeze: false };

export interface PresenterTrack {
  title: string;
  artist: string;
  album: string;
  /** e.g. "Spotify", "Local file". */
  sourceName: string;
}

export interface PresenterState {
  visualizer: string | null;
  /** MilkDrop preset (or another visualizer's variation). */
  variant: string | null;
  crossfadeSeconds: number;
  /** The main window's quality setting (the two windows share the graphics card). */
  quality: Quality;
  /** The cover the visualizers use, as a data: URL ('' for none). */
  artwork: string;
  /** The palette the controller uses (12 floats: four RGB colours, 0..1). */
  palette: number[];
  track: PresenterTrack | null;
  /** The song's page on its service; the QR code points here. */
  link: string | null;
  overlays: Overlays;
  qrSize: QrSize;
  /** The logo as a data: URL; '' shows Phosphor's mark. */
  logo: string;
}

export interface PresenterStats {
  fps: number;
  /** Milliseconds behind the controller (it reading the audio → the presenter starting to draw it): mean, 95th percentile, worst. */
  latency: { mean: number; p95: number; max: number };
  width: number;
  height: number;
  fullscreen: boolean;
  /** The screen it is on, when the browser says. */
  screen: string;
  frozen: boolean;
}

/** Presenter → controller. */
export type PresenterMessage =
  | { type: 'hello'; id: string }
  | { type: 'pull'; id: string }
  | { type: 'stats'; id: string; stats: PresenterStats }
  | { type: 'fullscreen-result'; id: string; ok: boolean; error?: string }
  | { type: 'bye'; id: string };

/** Controller → presenter. */
export type ControllerMessage =
  | { type: 'frame'; to: string; frame: ArrayBuffer }
  | { type: 'state'; state: PresenterState }
  | { type: 'close' };

/**
 * What the main window puts on itself for a presenter it opened: that window
 * (same origin, same thread) calls it right before drawing each frame, so it
 * shows the newest analysis with no waiting. Presenters without this (opened
 * some other way) ask over the channel instead.
 */
export interface FrameSource {
  pull(id: string): ArrayBuffer;
}

export const SOURCE_PROPERTY = '__phosphorPresenterSource';

/** Sent with window.postMessage (it carries the user's click, so the presenter may go full screen). */
export interface FullscreenRequest {
  type: 'phosphor-fullscreen';
  /** Where the target screen's top-left corner is, to pick it out of the presenter's own screen list. */
  screen: { left: number; top: number } | null;
}

/** The Window Management API (Chromium), which TypeScript's DOM types don't include yet. */
export interface ScreenDetailed extends Screen {
  readonly availLeft: number;
  readonly availTop: number;
  readonly left: number;
  readonly top: number;
  readonly isPrimary: boolean;
  readonly isInternal: boolean;
  readonly label: string;
  readonly devicePixelRatio: number;
}

export interface ScreenDetails extends EventTarget {
  readonly screens: readonly ScreenDetailed[];
  readonly currentScreen: ScreenDetailed;
}

type WithScreens = Window & { getScreenDetails?: () => Promise<ScreenDetails> };

/** 'granted', 'prompt', 'denied', or 'unsupported' (no Window Management API). */
export async function screenPermission(): Promise<PermissionState | 'unsupported'> {
  if (!(window as WithScreens).getScreenDetails) return 'unsupported';
  for (const name of ['window-management', 'window-placement']) {
    try {
      return (await navigator.permissions.query({ name: name as PermissionName })).state;
    } catch {
      // Older Chromium used the second name.
    }
  }
  return 'prompt';
}

/** The screens, asking for permission the first time (Chromium shows "Manage windows on all your displays"). */
export async function screenDetails(): Promise<ScreenDetails | null> {
  const get = (window as WithScreens).getScreenDetails;
  if (!get) return null;
  try {
    return await get.call(window);
  } catch {
    return null;
  }
}
