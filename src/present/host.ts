// The controller's side of the presenter: opens the presenter window (on
// another screen when there is one), answers its requests for frames, and
// tells it what to show. Overlays are switched on here only; the presenter
// has no controls of its own.

import type { App } from '../app/app';
import { desktop } from '../app/desktop';
import { Emitter } from '../app/emitter';
import { settings } from '../app/settings';
import { encodeFrame, eventBits } from '../audio/frameCodec';
import { SOURCE_NAMES } from '../player/types';
import {
  CHANNEL,
  NO_OVERLAYS,
  SOURCE_PROPERTY,
  screenDetails,
  screenPermission,
  WINDOW_NAME,
  type ControllerMessage,
  type FrameSource,
  type FullscreenRequest,
  type Overlays,
  type PresenterMessage,
  type PresenterState,
  type PresenterStats,
  type ScreenDetailed,
  type ScreenDetails,
} from './protocol';

const LOGO_KEY = 'phosphor.presenter.logo';
/** A presenter that hasn't been heard from in this long has gone. */
const GONE_MS = 2500;
/** Frames a presenter asks for are analysed afresh at most this often (the main window's own frames count). */
const PULL_GAP_MS = 12;

interface Connection {
  id: string;
  /** Beats, hits and drops since its last frame. */
  events: number;
  seen: number;
  stats: PresenterStats | null;
}

export interface ScreenChoice {
  label: string;
  left: number;
  top: number;
  width: number;
  height: number;
  current: boolean;
}

export type PresenterStatus = 'closed' | 'opening' | 'open';

export class PresenterHost extends Emitter<{ change: void }> {
  overlays: Overlays = { ...NO_OVERLAYS };
  /** Something to tell the person (a blocked pop-up, a failed full screen). */
  notice = '';
  /** Draw the visuals in this window too while presenting (off saves graphics power on a laptop). */
  preview = true;

  private channel = new BroadcastChannel(CHANNEL);
  private connections = new Map<string, Connection>();
  private win: Window | null = null;
  private opening = false;
  private screens: ScreenDetails | null = null;
  private logoUrl = '';
  private artworkFor = -1;
  private artworkUrl = '';
  private sentKey = '';
  private sentState: PresenterState | null = null;

  constructor(private app: App) {
    super();
    try {
      this.logoUrl = localStorage.getItem(LOGO_KEY) ?? '';
    } catch {
      this.logoUrl = '';
    }
    this.channel.onmessage = (event: MessageEvent<PresenterMessage>) => this.receive(event.data);
    // A presenter this window opened calls this directly, right before it draws.
    const source: FrameSource = { pull: (id) => this.pullFrame(String(id)) };
    Object.defineProperty(window, SOURCE_PROPERTY, { value: source, configurable: true });
    // Every analysis step: remember single-frame events for each presenter until its next frame.
    const previous = app.renderer.onAnalysis;
    app.renderer.onAnalysis = (frame, analysis) => {
      previous?.(frame, analysis);
      if (this.connections.size === 0) return;
      const bits = eventBits(frame);
      if (bits) for (const c of this.connections.values()) c.events |= bits;
    };
    app.player.on('track', () => this.sync());
    app.player.on('change', () => this.sync());
    settings.on('change', () => this.sync());
    // Presenters that stop asking (closed, crashed) drop off the list.
    window.setInterval(() => {
      const now = performance.now();
      let changed = false;
      for (const [id, c] of this.connections) {
        if (now - c.seen > GONE_MS) {
          this.connections.delete(id);
          changed = true;
        }
      }
      if (this.win?.closed) {
        this.win = null;
        changed = true;
      }
      if (changed) {
        this.applyPreview();
        this.emit('change', undefined);
      }
    }, 1000);
    // A presenter left open while this page reloaded announces itself.
    this.sync(true);
  }

  // ------------------------------------------------------------------ status

  get status(): PresenterStatus {
    if (this.connections.size > 0) return 'open';
    return this.opening || (this.win && !this.win.closed) ? 'opening' : 'closed';
  }

  /** The most recent figures from the presenter (the first, if there are several). */
  get stats(): PresenterStats | null {
    for (const c of this.connections.values()) if (c.stats) return c.stats;
    return null;
  }

  get presenters(): number {
    return this.connections.size;
  }

  /** The song's link, which the QR code shows; null hides the QR code. */
  get link(): string | null {
    const track = this.app.player.current;
    if (!track || track.source === 'local') return null;
    return this.app.services.find((s) => s.id === track.source)?.link(track) ?? null;
  }

  get logo(): string {
    return this.logoUrl;
  }

  // ----------------------------------------------------------------- actions

  /**
   * Opens the presenter window, or brings it forward if it is open. Call from
   * a click: browsers block pop-ups otherwise.
   */
  open() {
    this.notice = '';
    if (this.win && !this.win.closed) {
      this.win.focus();
      return;
    }
    const url = new URL('present.html', location.href).href;
    let features = 'popup,width=1280,height=720';
    const target = this.otherScreen();
    if (target) features = `popup,left=${target.availLeft},top=${target.availTop},width=${target.availWidth},height=${target.availHeight}`;
    // Opening by name with no address finds a presenter that is already open
    // (left from before this page reloaded) without reloading it.
    let win = window.open('', WINDOW_NAME, features);
    if (!win) {
      this.notice = 'The browser blocked the presenter window. Allow pop-ups for this site (the icon at the end of the address bar), then press Present again.';
      this.emit('change', undefined);
      return;
    }
    try {
      if (win.location.href === 'about:blank') win.location.replace(url);
    } catch {
      win = window.open(url, WINDOW_NAME, features);
    }
    this.win = win;
    this.opening = true;
    window.setTimeout(() => {
      this.opening = false;
      this.emit('change', undefined);
    }, 6000);
    this.emit('change', undefined);
    // In the browser: find the other screen (asking the first time) and move there.
    if (!desktop && !target) void this.moveToOtherScreen();
  }

  /** Closes every presenter window. */
  close() {
    this.post({ type: 'close' });
    try {
      this.win?.close();
    } catch {
      /* already gone */
    }
    this.win = null;
    this.opening = false;
    this.overlays = { ...this.overlays, blackout: false, freeze: false };
    window.setTimeout(() => this.emit('change', undefined), 300);
  }

  setOverlay(name: keyof Overlays, on: boolean) {
    if (this.overlays[name] === on) return;
    this.overlays = { ...this.overlays, [name]: on };
    this.sync();
    this.emit('change', undefined);
  }

  toggleOverlay(name: keyof Overlays) {
    this.setOverlay(name, !this.overlays[name]);
  }

  setPreview(on: boolean) {
    this.preview = on;
    this.applyPreview();
    this.emit('change', undefined);
  }

  /** Without a preview, this window holds its last frame (dimmed) while a presenter is showing. */
  private applyPreview() {
    const off = !this.preview && this.connections.size > 0;
    this.app.renderer.frozen = off;
    document.body.classList.toggle('preview-off', off);
  }

  /** Stores a logo (shrunk to at most 640 px) for the presenter's corner. */
  async setLogo(file: File | null) {
    if (!file) {
      this.logoUrl = '';
    } else {
      const bitmap = await createImageBitmap(file);
      const scale = Math.min(1, 640 / Math.max(bitmap.width, bitmap.height));
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(bitmap.width * scale));
      canvas.height = Math.max(1, Math.round(bitmap.height * scale));
      canvas.getContext('2d')!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      bitmap.close();
      this.logoUrl = canvas.toDataURL('image/png');
    }
    try {
      if (this.logoUrl) localStorage.setItem(LOGO_KEY, this.logoUrl);
      else localStorage.removeItem(LOGO_KEY);
    } catch {
      this.notice = 'The logo is too big to keep for next time; it is used until the page closes.';
    }
    this.sync();
    this.emit('change', undefined);
  }

  /** The screens the presenter can fill (asks the browser for permission the first time). */
  async listScreens(): Promise<ScreenChoice[]> {
    this.screens ??= await screenDetails();
    const details = this.screens;
    if (!details) return [];
    return details.screens.map((s) => ({
      label: s.label || `${s.width}×${s.height}`,
      left: s.left,
      top: s.top,
      width: s.width,
      height: s.height,
      current: s === details.currentScreen,
    }));
  }

  /**
   * Makes the presenter fill a screen (or the one it is on). Call from a
   * click: the click is handed to the presenter window, which may then go
   * full screen without one of its own.
   */
  fullscreen(screen: { left: number; top: number } | null) {
    this.notice = '';
    if (!this.win || this.win.closed) {
      // Left open from before a reload: find it by name (an open one isn't reloaded).
      const found = window.open('', WINDOW_NAME);
      if (found && found.location.href !== 'about:blank') this.win = found;
      else {
        found?.close();
        this.notice = 'Open the presenter first.';
        this.emit('change', undefined);
        return;
      }
    }
    const message: FullscreenRequest = { type: 'phosphor-fullscreen', screen };
    try {
      // Capability delegation (Chromium): the presenter may call requestFullscreen() with this click.
      this.win.postMessage(message, { targetOrigin: location.origin, delegate: 'fullscreen' } as WindowPostMessageOptions);
    } catch {
      // No click to hand over (it took too long) or no delegation in this browser: ask anyway, it may be allowed.
      this.win.postMessage(message, location.origin);
    }
  }

  // --------------------------------------------------------------- messages

  private post(message: ControllerMessage) {
    this.channel.postMessage(message);
  }

  /** The presenter with this id, added (and sent the state) the first time it is heard from. */
  private connection(id: string): Connection {
    let c = this.connections.get(id);
    if (!c) {
      c = { id, events: 0, seen: performance.now(), stats: null };
      this.connections.set(id, c);
      this.opening = false;
      this.sync(true);
      this.applyPreview();
      this.emit('change', undefined);
    }
    c.seen = performance.now();
    return c;
  }

  /** The newest analysis for a presenter, with the beats and hits since its last frame. */
  private pullFrame(id: string): ArrayBuffer {
    const c = this.connection(id);
    const renderer = this.app.renderer;
    renderer.analyse(performance.now(), PULL_GAP_MS);
    const frame = encodeFrame(renderer.analyser, c.events, performance.timeOrigin + renderer.lastAnalysis);
    c.events = 0;
    // Things that change without an event of their own: MilkDrop moving to its next preset, new artwork.
    this.sync();
    return frame;
  }

  private receive(message: PresenterMessage) {
    if (!message || typeof message !== 'object' || typeof message.id !== 'string') return;
    if (message.type === 'bye') {
      if (this.connections.delete(message.id)) {
        this.applyPreview();
        this.emit('change', undefined);
      }
      return;
    }
    const c = this.connection(message.id);
    switch (message.type) {
      case 'hello':
        this.sync(true);
        break;
      case 'pull':
        this.post({ type: 'frame', to: c.id, frame: this.pullFrame(c.id) });
        break;
      case 'stats':
        c.stats = message.stats;
        this.emit('change', undefined);
        break;
      case 'fullscreen-result':
        if (!message.ok) {
          this.notice = 'The browser wouldn\'t let the presenter fill the screen from here. Click the presenter window once, or press F in it.';
          this.emit('change', undefined);
        }
        break;
    }
  }

  // ------------------------------------------------------------------- state

  private state(): PresenterState {
    const { renderer, player } = this.app;
    if (renderer.artworkRevision !== this.artworkFor) {
      this.artworkFor = renderer.artworkRevision;
      const image = renderer.artworkImage;
      try {
        this.artworkUrl = image ? image.toDataURL('image/jpeg', 0.88) : '';
      } catch {
        this.artworkUrl = '';
      }
    }
    const track = player.current;
    return {
      visualizer: renderer.currentId,
      variant: renderer.variant ?? null,
      crossfadeSeconds: settings.get('crossfadeSeconds'),
      quality: settings.get('quality'),
      artwork: this.artworkUrl,
      palette: renderer.paletteTargetValues,
      track: track
        ? { title: track.title, artist: track.artist ?? '', album: track.album ?? '', sourceName: SOURCE_NAMES[track.source] }
        : null,
      link: this.link,
      overlays: { ...this.overlays },
      qrSize: settings.get('presenterQrSize'),
      logo: this.logoUrl,
    };
  }

  /** Sends the state if anything in it changed (or always, with `force`). */
  sync(force = false) {
    if (!force && this.connections.size === 0) return;
    const state = this.state();
    const key = JSON.stringify({ ...state, artwork: this.artworkFor, logo: this.logoUrl.length, palette: state.palette.map((v) => v.toFixed(3)) });
    if (!force && key === this.sentKey) return;
    this.sentKey = key;
    this.sentState = state;
    this.post({ type: 'state', state });
  }

  /** What was last sent (for the tests). */
  get lastState(): PresenterState | null {
    return this.sentState;
  }

  // ----------------------------------------------------------------- screens

  /** Another screen than this window's, when the Window Management permission was already given. */
  private otherScreen(): ScreenDetailed | null {
    const details = this.screens;
    if (!details) return null;
    const others = details.screens.filter((s) => s !== details.currentScreen);
    return others.find((s) => !s.isInternal) ?? others[0] ?? null;
  }

  private async moveToOtherScreen() {
    const permission = await screenPermission();
    if (permission === 'unsupported' || permission === 'denied') return;
    this.screens ??= await screenDetails();
    const target = this.otherScreen();
    const win = this.win;
    if (!target || !win || win.closed) return;
    try {
      win.moveTo(target.availLeft, target.availTop);
      win.resizeTo(target.availWidth, target.availHeight);
    } catch {
      /* the browser may refuse; it stays where it opened */
    }
    this.emit('change', undefined);
  }
}
