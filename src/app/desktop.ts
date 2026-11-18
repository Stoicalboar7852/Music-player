// Inside the desktop app (desktop/), the page talks to the app through the
// bridge desktop/preload.cjs exposes. It reports what is playing and the
// music's levels, which drive the live icon in the macOS menu bar or the
// Windows tray and the mini player under it, and it takes Play/Pause, Next
// and Previous from them (and from the Windows taskbar buttons).
//
// In a browser there is no bridge and none of this runs.

import type { CaptureManager } from '../audio/capture';
import type { Player } from '../player/player';
import type { Renderer } from '../viz/renderer';

export interface DesktopState {
  title: string;
  artist: string;
  /** A small data: URL (or a web address) for the mini player's artwork. */
  artwork: string;
  source: string;
  playing: boolean;
  /** Capturing system audio or an input. */
  listening: boolean;
}

export interface DesktopLevels {
  bass: number;
  mid: number;
  treble: number;
  /** Kick or beat, 0 to 1. */
  pulse: number;
  level: number;
  /** The spectrum in 24 bands, low to high, 0 to 1. */
  bands: number[];
}

interface DesktopBridge {
  platform: string;
  sendState(state: DesktopState): void;
  sendLevels(levels: DesktopLevels): void;
  onCommand(callback: (name: string) => void): () => void;
  /** Starts the Spotify app (for Spotify Connect). */
  openSpotify?(): void;
}

export const desktop: DesktopBridge | null = (window as Window & { phosphorDesktop?: DesktopBridge }).phosphorDesktop ?? null;

/** 'mac', 'windows' or 'linux' inside the desktop app; null in a browser. */
export const desktopPlatform: 'mac' | 'windows' | 'linux' | null = desktop
  ? desktop.platform === 'darwin'
    ? 'mac'
    : desktop.platform === 'win32'
      ? 'windows'
      : 'linux'
  : null;

/** A small square copy of the artwork as a data: URL, which the mini player (another page) can show. */
async function thumbnail(url: string | undefined): Promise<string> {
  if (!url) return '';
  try {
    const image = new Image();
    if (!url.startsWith('blob:') && !url.startsWith('data:')) image.crossOrigin = 'anonymous';
    image.src = url;
    await image.decode();
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 160;
    const side = Math.min(image.naturalWidth, image.naturalHeight);
    canvas
      .getContext('2d')!
      .drawImage(image, (image.naturalWidth - side) / 2, (image.naturalHeight - side) / 2, side, side, 0, 0, 160, 160);
    return canvas.toDataURL('image/jpeg', 0.85);
  } catch {
    // A blob: address means nothing outside this page; a web address still works there.
    return url.startsWith('http') ? url : '';
  }
}

/** Groups the spectrum into `count` bands (the loudest bin of each), 0 to 1. */
export function bands(spectrum: ArrayLike<number>, count = 24): number[] {
  const out: number[] = [];
  const n = spectrum.length;
  for (let i = 0; i < count; i++) {
    const from = Math.floor((i / count) * n);
    const to = Math.max(from + 1, Math.floor(((i + 1) / count) * n));
    let peak = 0;
    for (let b = from; b < to; b++) peak = Math.max(peak, spectrum[b]);
    out.push(Math.round(Math.min(1, peak) * 1000) / 1000);
  }
  return out;
}

export function connectDesktop(deps: { player: Player; renderer: Renderer; capture: CaptureManager }) {
  const bridge = desktop;
  if (!bridge) return;
  const { player, renderer, capture } = deps;
  document.documentElement.dataset.desktop = desktopPlatform ?? '';

  // What is playing. (Reports can overlap while the artwork is being shrunk:
  // each waits for it, and only the latest is sent.)
  let artworkFor: string | undefined;
  let artwork: Promise<string> = Promise.resolve('');
  let token = 0;
  const report = async () => {
    const track = player.current;
    const mine = ++token;
    if (track?.artworkUrl !== artworkFor) {
      artworkFor = track?.artworkUrl;
      artwork = thumbnail(artworkFor);
    }
    const image = await artwork;
    if (mine !== token) return;
    bridge.sendState({
      title: track?.title ?? '',
      artist: track?.artist ?? '',
      artwork: image,
      source: track?.source ?? (capture.state.active ? 'capture' : ''),
      playing: player.playing,
      listening: capture.state.active,
    });
  };
  player.on('track', () => void report());
  player.on('change', () => void report());
  capture.on('change', () => void report());
  void report();

  // The music's levels, twenty times a second while there is any.
  let quiet = 0;
  window.setInterval(() => {
    const live = player.playing || capture.state.active;
    quiet = live ? 0 : quiet + 1;
    if (quiet > 2) return; // a last few frames as it stops, then nothing
    const a = renderer.audio;
    bridge.sendLevels({
      bass: a.bass,
      mid: a.mid,
      treble: a.treble,
      pulse: Math.max(a.kick, a.beatPulse * 0.85),
      level: a.level,
      bands: bands(a.spectrum),
    });
  }, 50);

  // The menu bar, the tray, the mini player and the taskbar buttons.
  bridge.onCommand((name) => {
    if (name === 'toggle') void player.toggle();
    else if (name === 'next') void player.next();
    else if (name === 'previous') void player.previous();
  });
}
