// Spotify: sign-in with Authorization Code + PKCE (no backend, no client
// secret), playback through the Web Playback SDK, browsing through the Web API.
//
// What Spotify does not allow: reading the audio. The SDK plays DRM-protected
// streams inside this tab, so the visualizers are fed by sharing the tab's
// audio (see audio/capture.ts), not by anything in this file.
//
// Written against the documentation as of late 2026, including:
//  - redirect URIs must be https or a loopback IP literal (not "localhost")
//  - the implicit grant is gone; PKCE is the browser flow
//  - February 2026 Web API changes: playlist "tracks" became "items", and
//    development-mode apps are capped at 10 search results per type

import { debug } from '../app/debug';
import { desktop, widevineAvailable, type SpotState } from '../app/desktop';
import { androidBridge } from '../app/android';
import { Emitter } from '../app/emitter';
import { appBaseUrl, settings } from '../app/settings';
import type { PcmStream } from '../audio/pcmStream';
import { newTrackId, type Backend, type BackendEvents, type Collection, type Track } from '../player/types';
import type { MusicService, SearchResults, ServiceStatus, Shelf } from './types';

/** The name librespot's Spotify Connect device goes by. */
export const LIBRESPOT_NAME = 'Phosphor (librespot)';

/** What to tell the person when librespot didn't come up. */
function librespotProblem(state: SpotState | null): string {
  switch (state?.status) {
    case 'missing':
      return "This build of the desktop app doesn't include librespot. Choose another option under Settings → Spotify → Plays in.";
    case 'auth-failed':
      return 'librespot could not sign in to Spotify with your account (it needs Spotify Premium). Sign out of Spotify in Phosphor and connect again.';
    case 'unreachable':
      return "librespot could not reach Spotify's servers. Check your connection (a firewall or proxy may block it).";
    default:
      return `librespot did not start${state?.log ? `: ${state.log.trim().split('\n').pop()}` : '.'}`;
  }
}

/** The open.spotify.com page for a Spotify URI (spotify:track:…, :album:, :playlist:), or null. */
export function spotifyWebLink(uri: string | undefined | null): string | null {
  const m = /^spotify:(track|album|playlist|episode|show|artist):([A-Za-z0-9]+)$/.exec(uri ?? '');
  return m ? `https://open.spotify.com/${m[1]}/${m[2]}` : null;
}

const ACCOUNTS = 'https://accounts.spotify.com';
const API = 'https://api.spotify.com/v1';
const SDK_URL = 'https://sdk.scdn.co/spotify-player.js';
const SCOPES = [
  'streaming',
  'user-read-email',
  'user-read-private',
  'user-read-playback-state',
  'user-modify-playback-state',
  'playlist-read-private',
  'playlist-read-collaborative',
  'user-library-read',
  // Added in Phosphor 2 for the Spotify home and saving to your library.
  // Older sign-ins lack them; the home offers to reconnect.
  'user-read-recently-played',
  'user-top-read',
  'user-library-modify',
  'playlist-modify-public',
];

const TOKENS_KEY = 'phosphor.spotify.tokens';
const PENDING_KEY = 'phosphor.spotify.pending';
/** Spotify-made playlists opened by link, kept for the home view. */
const PINNED_KEY = 'phosphor.spotify.pinned';
const CHANNEL = 'phosphor-auth';

interface Tokens {
  access: string;
  refresh: string;
  /** Epoch milliseconds. */
  expiresAt: number;
  clientId: string;
  /** The permissions Spotify granted, space separated (missing on sign-ins from before Phosphor 2). */
  scope?: string;
}

interface PendingAuth {
  verifier: string;
  state: string;
  clientId: string;
}

// ---- the parts of the Web Playback SDK this file uses

interface SdkTrack {
  uri: string;
  id: string | null;
  name: string;
  duration_ms: number;
  artists: { name: string }[];
  album: { name: string; images: { url: string }[] };
  /** Present when Spotify plays a different copy of the requested track ("relinking"). */
  linked_from?: { uri: string | null } | null;
}

interface SdkState {
  paused: boolean;
  loading: boolean;
  position: number;
  duration: number;
  timestamp: number;
  /** What Spotify is playing from: the playlist or album URI, when there is one. */
  context?: { uri: string | null } | null;
  track_window: { current_track: SdkTrack | null; previous_tracks: SdkTrack[]; next_tracks?: SdkTrack[] };
}

interface SdkPlayer {
  connect(): Promise<boolean>;
  disconnect(): void;
  addListener(event: string, callback: (payload: never) => void): void;
  pause(): Promise<void>;
  resume(): Promise<void>;
  seek(ms: number): Promise<void>;
  nextTrack(): Promise<void>;
  previousTrack(): Promise<void>;
  setVolume(volume: number): Promise<void>;
  activateElement(): Promise<void>;
  getCurrentState(): Promise<SdkState | null>;
}

declare global {
  interface Window {
    Spotify?: { Player: new (opts: { name: string; getOAuthToken: (cb: (token: string) => void) => void; volume?: number }) => SdkPlayer };
    onSpotifyWebPlaybackSDKReady?: () => void;
  }
}

// ---- the parts of Web API responses this file uses

interface ApiImage {
  url: string;
}
interface ApiTrack {
  uri: string;
  name: string;
  type?: string;
  duration_ms: number;
  is_local?: boolean;
  is_playable?: boolean;
  artists?: { name: string }[];
  album?: { name: string; images?: ApiImage[] };
}
interface ApiCollection {
  id: string;
  name: string;
  images?: ApiImage[] | null;
  artists?: { name: string }[];
  owner?: { id?: string; display_name?: string };
}
interface Page<T> {
  items: (T | null)[];
  next: string | null;
}

// --------------------------------------------------------------------- PKCE

const base64url = (bytes: ArrayBuffer) =>
  btoa(String.fromCharCode(...new Uint8Array(bytes)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

function randomString(length: number): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  return Array.from(crypto.getRandomValues(new Uint8Array(length)), (b) => alphabet[b % alphabet.length]).join('');
}

async function challengeFor(verifier: string): Promise<string> {
  return base64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
}

function readJson<T>(key: string): T | null {
  try {
    return JSON.parse(localStorage.getItem(key) ?? 'null') as T | null;
  } catch {
    return null;
  }
}

async function requestTokens(body: Record<string, string>, clientId: string): Promise<Tokens> {
  const response = await fetch(`${ACCOUNTS}/api/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ ...body, client_id: clientId }),
  });
  const data = (await response.json().catch(() => ({}))) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    scope?: string;
    error?: string;
    error_description?: string;
  };
  if (!response.ok || !data.access_token) {
    throw new Error(`Spotify sign-in failed: ${data.error_description ?? data.error ?? response.statusText}`);
  }
  return {
    access: data.access_token,
    // Spotify may or may not rotate the refresh token; keep the old one if it doesn't.
    refresh: data.refresh_token ?? body.refresh_token ?? '',
    expiresAt: Date.now() + (data.expires_in ?? 3600) * 1000,
    clientId,
    scope: data.scope,
  };
}

/**
 * Call once at startup, before the app boots. If this page load is Spotify
 * redirecting back after sign-in, finishes the exchange. Returns true when
 * this window is the sign-in popup and should not start the app.
 */
export async function handleSpotifyCallback(): Promise<boolean> {
  const params = new URLSearchParams(location.search);
  const pending = readJson<PendingAuth>(PENDING_KEY);
  const state = params.get('state');
  if (!pending || !state || state !== pending.state || !(params.has('code') || params.has('error'))) return false;

  localStorage.removeItem(PENDING_KEY);
  let failure = '';
  const code = params.get('code');
  if (code) {
    try {
      const tokens = await requestTokens(
        { grant_type: 'authorization_code', code, redirect_uri: appBaseUrl(), code_verifier: pending.verifier },
        pending.clientId,
      );
      localStorage.setItem(TOKENS_KEY, JSON.stringify(tokens));
    } catch (error) {
      failure = (error as Error).message;
    }
  } else {
    failure = params.get('error') === 'access_denied' ? 'Spotify sign-in was cancelled.' : `Spotify sign-in failed: ${params.get('error')}`;
  }

  const isPopup = Boolean(window.opener) && window.name === 'phosphor-spotify';
  const channel = new BroadcastChannel(CHANNEL);
  channel.postMessage({ service: 'spotify', failure });
  channel.close();
  // Don't leave the one-time code sitting in the address bar or history.
  history.replaceState(null, '', appBaseUrl());
  if (isPopup) {
    document.body.textContent = failure || 'Connected to Spotify. You can close this window.';
    document.body.style.cssText = 'font:16px system-ui;color:#eee;background:#0b0b10;display:grid;place-items:center;height:100vh;margin:0';
    window.close();
    return true;
  }
  if (failure) sessionStorage.setItem('phosphor.authFailure', failure);
  return false;
}

// ---------------------------------------------------------- Spotify Connect

/** What GET /me/player returns (the parts used here). */
interface ApiPlayback {
  is_playing: boolean;
  progress_ms: number | null;
  timestamp?: number;
  context?: { uri: string } | null;
  item?: (Partial<SdkTrack> & { uri: string; name: string; duration_ms: number }) | null;
  currently_playing_type?: string;
}

interface ApiDevice {
  id: string | null;
  is_active: boolean;
  is_restricted?: boolean;
  name: string;
  type: string;
}

type ApiCall = <T>(path: string, init?: RequestInit) => Promise<T>;

/**
 * Calls `tick` every `ms`, from a worker: in a background tab Chrome slows a
 * page's own timers to once a second, then once a minute, but not a
 * worker's. (Falls back to a plain timer where workers aren't available.)
 */
function steadyTicker(ms: number, tick: () => void): () => void {
  try {
    const url = URL.createObjectURL(new Blob([`setInterval(() => postMessage(0), ${ms});`], { type: 'text/javascript' }));
    const worker = new Worker(url);
    worker.onmessage = () => tick();
    return () => {
      worker.terminate();
      URL.revokeObjectURL(url);
    };
  } catch {
    const id = window.setInterval(tick, ms);
    return () => window.clearInterval(id);
  }
}

/**
 * Spotify Connect: rather than playing in this page, Phosphor drives the
 * Spotify app (on this computer, or any device signed in to the account)
 * through the Web API, and follows it by asking for its state about once a
 * second while a song plays. It stands in for the Web Playback SDK's player,
 * and like the SDK reports state only when something changes, so the
 * service's own logic for songs ending, lists and autoplay works unchanged.
 *
 * Used in the desktop app, where Spotify's web player can't run, and in the
 * browser when chosen in Settings (for example on a phone).
 */
export class ConnectPlayer implements SdkPlayer {
  deviceName = '';
  private device = '';
  /** When to ask the Spotify app for its state next (performance.now()), 0 for not at all. */
  private pollAt = 0;
  private polling = false;
  private stopTicker: (() => void) | null = null;
  private reported: SdkState | null = null;
  private reportedAt = 0;
  private volumeTimer = 0;
  private volumeSent = -1;
  private volumeWanted = -1;
  private readonly api: ApiCall;
  private readonly report: (state: SdkState | null) => void;
  private readonly following: () => boolean;

  constructor(api: ApiCall, report: (state: SdkState | null) => void, following: () => boolean) {
    this.api = api;
    this.report = report;
    this.following = following;
  }

  async connect() {
    return true;
  }
  disconnect() {
    this.pollAt = 0;
    this.stopTicker?.();
    this.stopTicker = null;
  }
  addListener() {}
  async activateElement() {}

  /**
   * Picks the device to play on: the one already playing, else a computer
   * (the Spotify app here), else any; or, given a name, only that device
   * (librespot's). Empty if none.
   */
  async findDevice(name?: string): Promise<string> {
    const answer = await this.api<{ devices?: ApiDevice[] } | undefined>('/me/player/devices');
    const usable = (answer?.devices ?? []).filter((d) => d.id && !d.is_restricted);
    const pick = name ? usable.find((d) => d.name === name) : (usable.find((d) => d.is_active) ?? usable.find((d) => d.type === 'Computer') ?? usable[0]);
    this.device = pick?.id ?? '';
    this.deviceName = pick?.name ?? '';
    return this.device;
  }

  // Commands go to whichever device is playing (the account's active one), so
  // if you move playback to your phone in the Spotify app, Phosphor's buttons
  // follow it there. Only starting a song picks the device (see playUri).
  async pause() {
    await this.api('/me/player/pause', { method: 'PUT' });
    this.followSoon();
  }
  async resume() {
    await this.api('/me/player/play', { method: 'PUT' });
    this.followSoon();
  }
  async seek(ms: number) {
    await this.api(`/me/player/seek?position_ms=${Math.max(0, Math.round(ms))}`, { method: 'PUT' });
    this.followSoon();
  }
  async nextTrack() {
    await this.api('/me/player/next', { method: 'POST' });
    this.followSoon();
  }
  async previousTrack() {
    await this.api('/me/player/previous', { method: 'POST' });
    this.followSoon();
  }

  /**
   * The Spotify app's volume follows changes to Phosphor's (a few steps a
   * second at most). The first value is only noted: starting a song doesn't
   * change the volume you had in the Spotify app.
   */
  async setVolume(volume: number) {
    this.volumeWanted = Math.round(Math.max(0, Math.min(1, volume)) * 100);
    if (this.volumeSent < 0) {
      this.volumeSent = this.volumeWanted;
      return;
    }
    if (this.volumeTimer) return;
    const send = () => {
      this.volumeTimer = 0;
      if (this.volumeWanted === this.volumeSent || !this.device) return;
      this.volumeSent = this.volumeWanted;
      void this.api(`/me/player/volume?volume_percent=${this.volumeSent}`, { method: 'PUT' }).catch(() => {});
      this.volumeTimer = window.setTimeout(send, 300);
    };
    send();
  }

  /** The state now, with the songs coming up in a list (for Next within it). */
  async getCurrentState(): Promise<SdkState | null> {
    const state = await this.read();
    if (state?.context) {
      const queue = await this.api<{ queue?: SdkTrack[] } | undefined>('/me/player/queue').catch(() => undefined);
      state.track_window.next_tracks = queue?.queue ?? [];
    }
    this.reported = state;
    this.reportedAt = performance.now();
    return state;
  }

  /** Starts following the Spotify app (after asking it to play). */
  follow() {
    this.schedule(400);
  }
  private followSoon() {
    this.schedule(350);
  }
  private schedule(ms: number) {
    this.pollAt = performance.now() + ms;
    this.stopTicker ??= steadyTicker(200, () => {
      if (this.pollAt && !this.polling && performance.now() >= this.pollAt) void this.poll();
    });
  }

  private async poll() {
    this.pollAt = 0;
    if (!this.following()) {
      // Nothing to follow: stop ticking until the next song.
      this.stopTicker?.();
      this.stopTicker = null;
      return;
    }
    this.polling = true;
    let state: SdkState | null;
    try {
      state = await this.read();
    } catch {
      this.schedule(3000);
      return;
    } finally {
      this.polling = false;
    }
    if (this.changed(state)) {
      this.reported = state;
      this.reportedAt = performance.now();
      this.report(state);
    }
    this.schedule(state && !state.paused ? 1000 : 2500);
  }

  private async read(): Promise<SdkState | null> {
    const p = await this.api<ApiPlayback | undefined>('/me/player?additional_types=track');
    const item = p?.item;
    if (!p || !item || (p.currently_playing_type && p.currently_playing_type !== 'track')) return null;
    return {
      paused: !p.is_playing,
      loading: false,
      position: p.progress_ms ?? 0,
      duration: item.duration_ms,
      timestamp: p.timestamp ?? Date.now(),
      context: p.context ? { uri: p.context.uri } : null,
      track_window: {
        current_track: {
          uri: item.uri,
          id: item.id ?? null,
          name: item.name,
          duration_ms: item.duration_ms,
          artists: item.artists ?? [],
          album: { name: item.album?.name ?? '', images: item.album?.images ?? [] },
          linked_from: item.linked_from ?? null,
        },
        previous_tracks: [],
      },
    };
  }

  /** Like the SDK: report a change, not every answer. */
  private changed(state: SdkState | null): boolean {
    const last = this.reported;
    if (!state || !last) return state !== last;
    if (state.paused !== last.paused) return true;
    if (state.track_window.current_track?.uri !== last.track_window.current_track?.uri) return true;
    if ((state.context?.uri ?? null) !== (last.context?.uri ?? null)) return true;
    // A jump the clock can't explain: a seek, or a restart.
    const expected = last.paused ? last.position : last.position + (performance.now() - this.reportedAt);
    return Math.abs(state.position - expected) > 2500;
  }
}

// ------------------------------------------------------------------ service

class SpotifyBackend implements Backend {
  readonly source = 'spotify' as const;
  events: Partial<BackendEvents> = {};

  constructor(private service: SpotifyService) {}

  load(track: Track) {
    return this.service.playUri(track);
  }
  async play() {
    await this.service.sdk?.activateElement().catch(() => {});
    await this.service.sdk?.resume();
  }
  async pause() {
    this.service.notePause();
    this.service.flushAudio();
    await this.service.sdk?.pause();
  }
  async seek(seconds: number) {
    this.service.noteSeek(seconds);
    this.service.flushAudio();
    await this.service.sdk?.seek(Math.round(seconds * 1000));
  }
  setVolume(volume: number) {
    this.service.volume = volume;
    // librespot's audio plays in this page: set its volume here, not on the device.
    if (this.service.audioInPage) this.service.pcmVolume(volume);
    else void this.service.sdk?.setVolume(volume).catch(() => {});
  }
  position() {
    return this.service.position();
  }
  duration() {
    return (this.service.last?.duration ?? 0) / 1000;
  }
  async stop() {
    this.service.expectUri = null;
    this.service.expectContext = null;
    this.service.notePause();
    await this.service.sdk?.pause().catch(() => {});
  }
  skip(direction: 1 | -1) {
    return this.service.skipInList(direction);
  }
}

export class SpotifyService extends Emitter<{ status: void }> implements MusicService {
  readonly id = 'spotify' as const;
  readonly name = 'Spotify';
  readonly linkHint = 'Spotify track, album or playlist link';
  get limits(): string[] {
    return this.connectMode ? this.connectLimits : this.pageLimits;
  }
  private readonly connectLimits = [
    'Requires Spotify Premium (Spotify only lets apps control playback for Premium accounts).',
    desktop
      ? "Spotify plays in the Spotify app, which Phosphor controls (Spotify Connect): Spotify's web player can't run inside the desktop app. Keep the Spotify app open on this computer; Phosphor starts it if it can."
      : 'Spotify plays in the Spotify app (on this computer or any device signed in to your account), which Phosphor controls (Spotify Connect). Keep it open.',
    desktop
      ? 'The visualizers listen to what this computer plays (see System audio).'
      : "The visualizers need the Spotify app's sound: share your entire screen with system audio (Windows, ChromeOS, macOS 14.2 or later), use an audio input, or on a phone the microphone. Sharing this tab won't hear it.",
    'Phosphor follows the Spotify app by asking for its state about once a second, so a song ending or changing shows up a moment late, and fades into or out of a Spotify song are coarse.',
    'While your Spotify app is in development mode it works for you and up to five people you add in the Spotify dashboard, and the app owner must have Premium.',
  ];
  private readonly pageLimits = [
    'Requires Spotify Premium. Spotify does not allow browser playback for free accounts.',
    'While your Spotify app is in development mode it works for you and up to five people you add in the Spotify dashboard, and the app owner must have Premium.',
    "Spotify's audio is DRM-protected and cannot be read by the page. The visualizers react to this tab's shared audio instead, so Chrome asks to share the tab the first time you play a song each session (one click on Allow).",
    'Volume changes here are applied by Spotify before the audio is captured: at very low volume the visuals get less signal, and muting silences them. Use your system volume to listen quietly.',
    'Search returns up to 10 results of each kind (a limit Spotify applies to development-mode apps).',
    "Spotify doesn't let apps list its own playlists (Discover Weekly, Daily Mixes, its editorial playlists) or read recommendations, new releases or charts. Paste a link to a Spotify-made playlist and Phosphor has Spotify play it as a whole: each song shows as it comes up, and Next and Previous move through it.",
    'Saving to your Spotify library may be refused: since 2026 Spotify blocks changes from many personal (development-mode) apps. Playback is not affected.',
  ];
  readonly backend = new SpotifyBackend(this);

  /**
   * Where Spotify plays. 'page': Spotify's web player in this page (needs
   * Widevine: Chrome and Edge have it, and so does the desktop app, which is
   * built on castLabs' Electron, once the module has installed). 'app': the
   * Spotify app, controlled through Spotify Connect (chosen in Settings, or
   * in the desktop app while Widevine isn't ready). 'librespot': the desktop
   * app's bundled librespot, a Connect device whose audio plays in this page
   * (off unless chosen in Settings).
   */
  get mode(): 'page' | 'app' | 'librespot' {
    const chosen = settings.get('spotifyPlayback');
    // The Android app: Spotify's web player where the WebView has Widevine
    // (the app hears the phone's sound either way), otherwise the Spotify app.
    if (androidBridge) return chosen === 'app' || this.widevine === false ? 'app' : 'page';
    if (!desktop) return chosen === 'app' ? 'app' : 'page';
    if (chosen === 'librespot') return this.librespotAvailable ? 'librespot' : 'app';
    if (chosen === 'app') return 'app';
    return this.widevine ? 'page' : 'app';
  }

  /** Playing on a Spotify Connect device (the Spotify app, or librespot) rather than in this page's web player. */
  get connectMode(): boolean {
    return this.mode !== 'page';
  }

  /** The sound comes from another program, so sharing this tab can't hear it. */
  get playsOutsidePage(): boolean {
    return this.mode === 'app';
  }

  /** librespot's audio plays in this page, so the visualizers hear it directly. */
  get audioInPage(): boolean {
    return this.mode === 'librespot';
  }

  /** Whether Widevine was found (desktop app): null until checked. */
  widevine: boolean | null = null;
  /** Whether the desktop app bundles librespot. */
  librespotAvailable = false;
  /** What librespot last reported. */
  librespotState: SpotState | null = null;
  private pcm: PcmStream | null = null;
  private pcmFactory: (() => PcmStream) | null = null;

  /** How to make the stream librespot's audio plays through (the engine's). */
  usePcm(factory: () => PcmStream) {
    this.pcmFactory = factory;
  }

  /** Signed 16-bit stereo from librespot. */
  private audioIn(chunk: Uint8Array) {
    if (this.mode !== 'librespot') return;
    this.pcm ??= this.pcmFactory?.() ?? null;
    if (this.pcm && !this.pcmVolumeSet) this.pcmVolume(this.volume);
    this.pcm?.push(chunk);
  }

  private pcmVolumeSet = false;
  pcmVolume(volume: number) {
    this.pcm ??= this.pcmFactory?.() ?? null;
    this.pcm?.setVolume(volume);
    this.pcmVolumeSet = Boolean(this.pcm);
  }

  /** Drops buffered librespot audio (a pause, a seek or a new song should be heard at once). */
  flushAudio() {
    this.pcm?.flush();
  }

  /** The PCM stream, for tests. */
  get pcmStream(): PcmStream | null {
    return this.pcm;
  }

  private async checkWidevine() {
    const before = this.mode;
    this.widevine = await widevineAvailable();
    debug('spotify', `Widevine ${this.widevine ? 'available' : 'not available'}`);
    this.modeChanged(before);
  }

  /** Switches player when where Spotify plays has changed. */
  private modeChanged(before: 'page' | 'app' | 'librespot') {
    if (this.mode === before) return;
    debug('spotify', `now playing ${this.mode === 'page' ? 'in this page' : this.mode === 'app' ? 'in the Spotify app' : 'through librespot'}`);
    this.switchPlayers(before);
  }

  private switchPlayers(before: 'page' | 'app' | 'librespot') {
    if (before === 'librespot' && this.mode !== 'librespot') {
      desktop?.spot?.stop();
      this.pcm?.flush();
    }
    if (this.sdk) {
      this.generation++;
      this.sdk.disconnect();
      this.sdk = null;
      this.deviceId = null;
      if (this.tokens) void this.connect().catch(() => {});
    }
    this.emit('status', undefined);
  }

  sdk: SdkPlayer | null = null;
  last: SdkState | null = null;
  volume = 0.8;
  /** The URI the player asked for; state events about anything else are ignored. */
  expectUri: string | null = null;
  /** For a list Spotify plays itself (see Track.context): its URI, and the song it is on. */
  expectContext: string | null = null;
  contextSong: string | null = null;
  /** Spotify has reported our list as the context at least once (so a report without it means it moved on). */
  private contextSeen = false;

  private tokens: Tokens | null = readJson<Tokens>(TOKENS_KEY);
  private deviceId: string | null = null;
  /**
   * Bumped whenever the player is replaced (the page's own, or the Spotify
   * app's): reports from the one before are ignored.
   */
  private generation = 0;
  private accountName = '';
  private problem = '';
  private connecting: Promise<void> | null = null;
  private refreshing: Promise<string> | null = null;
  // End-of-track detection. The SDK has no "ended" event and only reports
  // state when something changes, so the end has to be inferred.
  private sawPlaying = false;
  /** performance.now() when `last` arrived; positions are extrapolated from it. */
  private lastAt = 0;
  /** Title of the requested track, to recognise a relinked copy of it. */
  private expectTitle = '';
  /** The URI Spotify actually plays for our request (differs when it relinks). */
  private actualUri: string | null = null;
  private requestedAt = 0;
  /** Furthest point (ms) the current pass through the track has reached. */
  private furthest = 0;
  /** The URI we already reported as ended, so it is reported once. */
  private endedFor: string | null = null;
  private pausedByUsAt = 0;
  /** When we last sought to the very start (which also reads as "paused at 0"). */
  private seekedAt = 0;
  private checkingEnd = false;

  constructor() {
    super();
    if (androidBridge) void this.checkWidevine();
    if (desktop) {
      // Widevine installs at first launch; check now, and again when the app says it's ready.
      void this.checkWidevine();
      desktop.onWidevine?.(() => void this.checkWidevine());
      if (desktop.spot) {
        void desktop.spot.available().then((ok) => {
          const before = this.mode;
          this.librespotAvailable = ok;
          this.modeChanged(before);
        });
        desktop.spot.onState((state) => {
          this.librespotState = state;
          debug('spotify', `librespot: ${state.status}`);
          this.emit('status', undefined);
        });
        desktop.spot.onAudio((chunk) => this.audioIn(chunk));
      }
    }
    let modeBefore = this.mode;
    settings.on('change', (patch) => {
      if ('spotifyPlayback' in patch) {
        // Switch players: the page's own, the Spotify app, or librespot.
        const before = modeBefore;
        modeBefore = this.mode;
        if (this.mode !== before) this.switchPlayers(before);
      }
      if (!('spotifyClientId' in patch)) return;
      // Tokens belong to the client ID they were issued for.
      if (this.tokens && this.tokens.clientId !== this.clientId) this.disconnect();
      this.emit('status', undefined);
    });
    const channel = new BroadcastChannel(CHANNEL);
    channel.addEventListener('message', (event: MessageEvent<{ service: string; failure: string }>) => {
      if (event.data?.service !== 'spotify') return;
      this.authWaiter?.(event.data.failure);
    });
    const failure = sessionStorage.getItem('phosphor.authFailure');
    if (failure) {
      sessionStorage.removeItem('phosphor.authFailure');
      this.problem = failure;
    }
    // Returning from a full-page sign-in, or tokens kept from last time: reconnect quietly.
    if (this.tokens && this.tokens.clientId === this.clientId) void this.connect().catch(() => {});
    window.setInterval(() => void this.checkEnd(), 1000);
  }

  private authWaiter: ((failure: string) => void) | null = null;

  private get clientId(): string {
    return settings.get('spotifyClientId').trim();
  }

  status(): ServiceStatus {
    return {
      configured: this.clientId.length > 0,
      connected: Boolean(this.sdk && (this.deviceId || this.sdk instanceof ConnectPlayer)),
      account: this.accountName || undefined,
      problem: this.problem || undefined,
    };
  }

  onStatus(listener: () => void) {
    return this.on('status', listener);
  }

  private setProblem(problem: string) {
    this.problem = problem;
    this.emit('status', undefined);
  }

  // ------------------------------------------------------------- sign-in

  async connect(): Promise<void> {
    if (!this.clientId) throw new Error('Add your Spotify Client ID in Settings first.');
    this.connecting ??= this.doConnect().finally(() => (this.connecting = null));
    return this.connecting;
  }

  private async doConnect() {
    this.setProblem('');
    if (!this.tokens || this.tokens.clientId !== this.clientId) await this.authorize();
    if (this.connectMode) this.startConnect();
    else await this.startSdk();
    try {
      const me = await this.api<{ display_name?: string; id: string; product?: string }>('/me');
      this.accountName = me.display_name || me.id;
      if (me.product && me.product !== 'premium') {
        this.setProblem('This Spotify account is not Premium, so Spotify will refuse to play in the browser.');
      }
    } catch {
      /* the profile is only cosmetic */
    }
    this.emit('status', undefined);
  }

  private async authorize() {
    const redirect = appBaseUrl();
    if (!/^https:|^http:\/\/(127\.0\.0\.1|\[::1\])[:/]/.test(redirect)) {
      throw new Error('Spotify only accepts https or http://127.0.0.1 redirect addresses. Open the app at http://127.0.0.1:5173 and try again.');
    }
    const pending: PendingAuth = { verifier: randomString(64), state: randomString(24), clientId: this.clientId };
    localStorage.setItem(PENDING_KEY, JSON.stringify(pending));
    const url = `${ACCOUNTS}/authorize?${new URLSearchParams({
      client_id: this.clientId,
      response_type: 'code',
      redirect_uri: redirect,
      code_challenge_method: 'S256',
      code_challenge: await challengeFor(pending.verifier),
      scope: SCOPES.join(' '),
      state: pending.state,
    })}`;

    // A popup keeps the queue and visuals alive; fall back to a full redirect if it is blocked.
    const popup = window.open(url, 'phosphor-spotify', 'popup,width=520,height=780');
    if (!popup) {
      location.assign(url);
      await new Promise(() => {}); // the page is navigating away
    }
    const failure = await new Promise<string>((resolve) => {
      this.authWaiter = resolve;
      const timer = window.setInterval(() => {
        if (!popup?.closed) return;
        window.clearInterval(timer);
        // Closed without completing (the success path resolves first via the channel).
        window.setTimeout(() => resolve(readJson<Tokens>(TOKENS_KEY) ? '' : 'Spotify sign-in was cancelled.'), 400);
      }, 500);
    });
    this.authWaiter = null;
    if (failure) throw new Error(failure);
    this.tokens = readJson<Tokens>(TOKENS_KEY);
    if (!this.tokens) throw new Error('Spotify sign-in did not complete.');
  }

  disconnect() {
    this.generation++;
    this.sdk?.disconnect();
    this.sdk = null;
    this.deviceId = null;
    this.tokens = null;
    this.accountName = '';
    this.last = null;
    this.problem = '';
    localStorage.removeItem(TOKENS_KEY);
    this.emit('status', undefined);
  }

  /** A valid access token, refreshed if it is about to expire. */
  private async token(force = false): Promise<string> {
    const tokens = this.tokens;
    if (!tokens) throw new Error('Not signed in to Spotify.');
    if (!force && tokens.expiresAt - Date.now() > 60_000) return tokens.access;
    this.refreshing ??= requestTokens({ grant_type: 'refresh_token', refresh_token: tokens.refresh }, tokens.clientId)
      .then((fresh) => {
        this.tokens = fresh;
        localStorage.setItem(TOKENS_KEY, JSON.stringify(fresh));
        return fresh.access;
      })
      .catch((error) => {
        // A dead refresh token means signing in again.
        this.disconnect();
        this.setProblem('Your Spotify session expired. Connect again.');
        throw error;
      })
      .finally(() => (this.refreshing = null));
    return this.refreshing;
  }

  // ----------------------------------------------------------------- SDK

  private loadSdk(): Promise<void> {
    if (window.Spotify) return Promise.resolve();
    return new Promise((resolve, reject) => {
      window.onSpotifyWebPlaybackSDKReady = () => resolve();
      const script = document.createElement('script');
      script.src = SDK_URL;
      script.onerror = () => reject(new Error("Spotify's player could not be loaded. Check your connection or content blockers."));
      document.head.append(script);
    });
  }

  /** Spotify Connect: follow and drive the Spotify app instead of a player in this page. */
  private startConnect() {
    if (this.sdk instanceof ConnectPlayer) return;
    this.sdk?.disconnect();
    this.deviceId = null;
    const generation = ++this.generation;
    this.sdk = new ConnectPlayer(
      (path, init) => this.api(path, init),
      (state) => {
        if (generation === this.generation) this.onState(state);
      },
      () => generation === this.generation && Boolean(this.expectUri),
    );
    debug('spotify', 'playing through the Spotify app (Spotify Connect)');
  }

  private async startSdk() {
    await this.loadSdk();
    if (this.sdk) return;
    const sdk = new window.Spotify!.Player({
      name: 'Phosphor',
      getOAuthToken: (cb) => void this.token().then(cb, () => cb('')),
      volume: this.volume,
    });
    const generation = ++this.generation;
    const on = <T>(event: string, callback: (payload: T) => void) =>
      sdk.addListener(event, ((payload: T) => {
        // A player that has been replaced (switching to the Spotify app) may still report.
        if (generation === this.generation) callback(payload);
      }) as (payload: never) => void);

    const ready = new Promise<void>((resolve, reject) => {
      on<{ device_id: string }>('ready', ({ device_id }) => {
        this.deviceId = device_id;
        this.emit('status', undefined);
        resolve();
      });
      on<{ message: string }>('initialization_error', ({ message }) =>
        reject(new Error(`Spotify can't play in this browser (${message}). It needs Chrome or Edge with protected content enabled.`)),
      );
      on<{ message: string }>('authentication_error', ({ message }) => reject(new Error(`Spotify rejected the sign-in: ${message}`)));
      on<{ message: string }>('account_error', () =>
        reject(new Error('Spotify refused playback for this account. The Web Playback SDK requires Spotify Premium.')),
      );
    });
    on('not_ready', () => {
      this.deviceId = null;
      this.emit('status', undefined);
    });
    on<{ message: string }>('playback_error', ({ message }) => this.backend.events.error?.(message));
    on('autoplay_failed', () => this.backend.events.error?.('the browser blocked autoplay; press play again'));
    on<SdkState | null>('player_state_changed', (state) => this.onState(state));

    try {
      if (!(await sdk.connect())) throw new Error('Spotify did not accept the connection.');
      await Promise.race([
        ready,
        new Promise((_, reject) => setTimeout(() => reject(new Error('Spotify took too long to get ready.')), 15000)),
      ]);
      this.sdk = sdk;
    } catch (error) {
      sdk.disconnect();
      this.setProblem((error as Error).message);
      throw error;
    }
  }

  private onState(state: SdkState | null) {
    // null means playback moved to another device.
    if (!state) {
      debug('spotify', 'state: none (playback is on another device)');
      this.last = null;
      this.backend.events.state?.(false);
      return;
    }
    const current = state.track_window.current_track;
    debug(
      'spotify',
      `state: ${current?.name ?? '-'} ${state.paused ? 'paused' : 'playing'}${state.loading ? ' loading' : ''} at ${(state.position / 1000).toFixed(1)}/${(state.duration / 1000).toFixed(1)}s` +
        ` previous=[${state.track_window.previous_tracks.map((t) => t.name).join(', ')}]`,
    );
    if (!this.expectUri || !current || this.endedFor === this.expectUri) return;
    // Where we believed playback was just before this report.
    const believed = this.extrapolate();
    const events = this.backend.events;
    if (this.expectContext) {
      this.onContextState(state, current, believed);
      return;
    }

    if (this.isOurs(current)) {
      if (!this.actualUri && current.uri !== this.expectUri) debug('spotify', `relinked: playing ${current.uri} for ${this.expectUri}`);
      this.actualUri ??= current.uri;
      this.furthest = Math.max(this.furthest, believed, state.position);
      this.last = state;
      this.lastAt = performance.now();
      if (!state.paused && !state.loading) this.sawPlaying = true;
      if (this.looksFinished(state)) {
        this.finish('it stopped at the end');
        return;
      }
      events.meta?.({ duration: state.duration / 1000 });
      if (!state.loading) events.state?.(!state.paused);
      return;
    }

    // Another track is playing on our device. If ours had been playing to its
    // end, Spotify moved on by itself (autoplay or its own queue): stop its
    // pick and let Phosphor's queue decide what comes next.
    this.furthest = Math.max(this.furthest, believed);
    if (this.sawPlaying && (this.nearEnd() || state.track_window.previous_tracks.some((t) => this.isOurs(t)))) {
      void this.sdk?.pause().catch(() => {});
      this.finish('Spotify moved on to another track');
    }
  }

  /**
   * State while Spotify plays a whole list for us. Songs changing is normal;
   * the list is over when Spotify moves on to something else (its autoplay),
   * or stops back at the start after the last song.
   */
  private onContextState(state: SdkState, current: SdkTrack, believed: number) {
    const events = this.backend.events;
    const reported = state.context?.uri ?? null;
    if (reported === this.expectContext) this.contextSeen = true;
    if ((reported && reported !== this.expectContext) || (!reported && this.contextSeen)) {
      this.furthest = Math.max(this.furthest, believed);
      if (this.sawPlaying) {
        void this.sdk?.pause().catch(() => {});
        this.finish('Spotify moved on from the list');
      }
      return;
    }
    if (current.uri !== this.contextSong) {
      const previousDuration = this.last?.duration ?? 0;
      this.furthest = Math.max(this.furthest, believed);
      const recentlyOurs = performance.now() - this.pausedByUsAt < 2000;
      if (this.contextSong && this.sawPlaying && state.paused && !state.loading && !recentlyOurs && this.nearEnd(previousDuration) && state.position < 1500) {
        this.finish('the list ended');
        return;
      }
      if (this.contextSong) debug('spotify', `list moved on to ${current.name}`);
      this.contextSong = current.uri;
      this.furthest = state.position;
      events.meta?.({
        title: current.name,
        artist: current.artists.map((a) => a.name).join(', '),
        album: current.album.name,
        artworkUrl: current.album.images[0]?.url,
        duration: state.duration / 1000,
        link: spotifyWebLink(current.uri) ?? undefined,
      });
    }
    this.furthest = Math.max(this.furthest, state.position);
    this.last = state;
    this.lastAt = performance.now();
    if (!state.paused && !state.loading) this.sawPlaying = true;
    if (this.looksFinishedInList(state)) {
      this.finish('the list ended');
      return;
    }
    events.meta?.({ duration: state.duration / 1000 });
    if (!state.loading) events.state?.(!state.paused);
  }

  /** The last song of a list ended and Spotify stopped on it rather than wrapping round. */
  private looksFinishedInList(state: SdkState): boolean {
    if (!this.sawPlaying || !state.paused || state.loading || (state.track_window.next_tracks?.length ?? 0) > 0) return false;
    const now = performance.now();
    if (now - this.pausedByUsAt < 2000 || now - this.seekedAt < 1500) return false;
    return (state.position < 1500 || state.position >= state.duration - 1500) && this.nearEnd(state.duration);
  }

  /** Moves within a list Spotify is playing. False when there's nowhere to go. */
  async skipInList(direction: 1 | -1): Promise<boolean> {
    if (!this.expectContext || !this.sdk) return false;
    if (this.sdk instanceof ConnectPlayer) {
      // The Web API lists what comes next but not what came before; Spotify
      // itself goes back a song, or to the start of the first.
      if (direction === 1) {
        const upcoming = (await this.sdk.getCurrentState().catch(() => null))?.track_window.next_tracks ?? [];
        if (!upcoming.length) return false;
      }
      debug('spotify', `skip ${direction === 1 ? 'forward' : 'back'} within the list (Spotify app)`);
      this.notePause();
      this.furthest = 0;
      await (direction === 1 ? this.sdk.nextTrack() : this.sdk.previousTrack());
      return true;
    }
    const state = (await this.sdk.getCurrentState().catch(() => null)) ?? this.last;
    const window = state?.track_window;
    if (!window) return false;
    if (direction === 1 ? !window.next_tracks?.length : !window.previous_tracks.length) return false;
    debug('spotify', `skip ${direction === 1 ? 'forward' : 'back'} within the list`);
    // A skip briefly reads as paused at 0, like the end of the list.
    this.notePause();
    this.furthest = 0;
    await (direction === 1 ? this.sdk.nextTrack() : this.sdk.previousTrack());
    return true;
  }

  private isOurs(track: SdkTrack | null | undefined): boolean {
    if (!track || !this.expectUri) return false;
    if (track.uri === this.expectUri || (this.actualUri !== null && track.uri === this.actualUri)) return true;
    if (track.linked_from?.uri === this.expectUri) return true;
    // Spotify can swap in another copy of the same song for your country
    // ("relinking"). Right after our request, a track of the same name is ours.
    return this.actualUri === null && performance.now() - this.requestedAt < 20000 && track.name === this.expectTitle;
  }

  /** Has this pass through the track got to within 4 s of the end? */
  private nearEnd(duration = this.last?.duration ?? 0): boolean {
    return duration > 0 && this.furthest >= duration - 4000;
  }

  /**
   * A finished track shows up as paused, either back at the start or sitting
   * at the very end, after playback had got near the end. Pauses and seeks
   * that Phosphor itself just asked for don't count.
   */
  private looksFinished(state: SdkState): boolean {
    if (!this.sawPlaying || !state.paused || state.loading) return false;
    const now = performance.now();
    if (now - this.pausedByUsAt < 2000 || now - this.seekedAt < 1500) return false;
    const atStart = state.position < 1500;
    const atEnd = state.position >= state.duration - 1500;
    if (!atStart && !atEnd) return false;
    // Spotify lists a finished track in previous_tracks; our own clock is the other witness.
    return this.nearEnd(state.duration) || (atStart && state.track_window.previous_tracks.some((t) => this.isOurs(t)));
  }

  private finish(reason: string) {
    if (!this.expectUri || this.endedFor === this.expectUri) return;
    this.endedFor = this.expectUri;
    this.sawPlaying = false;
    debug('spotify', `track ended: ${reason}`);
    this.backend.events.ended?.();
  }

  /**
   * Safety net, once a second: if our clock says the track should have ended
   * a moment ago and Spotify has said nothing, ask the player directly.
   */
  private async checkEnd() {
    const s = this.last;
    if (!s || !this.sdk || !this.expectUri || this.endedFor === this.expectUri || s.paused || this.checkingEnd) return;
    const elapsed = s.position + (performance.now() - this.lastAt);
    this.furthest = Math.max(this.furthest, Math.min(elapsed, s.duration));
    if (elapsed < s.duration + 1500) return;
    this.checkingEnd = true;
    try {
      const fresh = await this.sdk.getCurrentState();
      debug('spotify', 'past the end with no report; asked the player');
      if (!fresh) return;
      this.onState(fresh);
      // Still claiming to play our track right at its end: trust the clock.
      const current = fresh.track_window.current_track;
      if (!this.expectContext && !fresh.paused && this.isOurs(current) && fresh.position >= fresh.duration - 500) this.finish('it sat at the end');
    } catch {
      /* try again next second */
    } finally {
      this.checkingEnd = false;
    }
  }

  noteSeek(seconds: number) {
    // Only a seek back to the very start can be mistaken for the end of a track.
    if (seconds < 1) this.seekedAt = performance.now();
    // "Near the end" is about the current pass through the track.
    this.furthest = seconds * 1000;
    if (this.last) {
      this.last = { ...this.last, position: seconds * 1000 };
      this.lastAt = performance.now();
    }
  }

  notePause() {
    this.pausedByUsAt = performance.now();
  }

  /** Where playback is now (ms), extrapolated from the last report. */
  private extrapolate(): number {
    const s = this.last;
    if (!s) return 0;
    const elapsed = s.paused ? 0 : performance.now() - this.lastAt;
    return Math.min(s.duration, s.position + Math.max(0, elapsed));
  }

  position(): number {
    return this.extrapolate() / 1000;
  }

  /** Starts a track on this tab's Spotify device. */
  async playUri(track: Track) {
    if (!track.ref) throw new Error('missing Spotify URI');
    // Forget the song before at once: while the next one starts, reports about
    // the old one are ignored, and the position reads 0 rather than where the
    // old song was.
    this.expectUri = null;
    this.expectContext = null;
    this.last = null;
    this.furthest = 0;
    this.sawPlaying = false;
    if (!this.sdk || (!this.deviceId && !(this.sdk instanceof ConnectPlayer))) await this.connect();
    if (this.sdk instanceof ConnectPlayer) {
      if (this.mode === 'librespot') await this.findLibrespot(this.sdk);
      else await this.findSpotifyApp(this.sdk);
    }
    this.flushAudio();
    this.expectUri = track.ref;
    this.expectContext = track.context ? track.ref : null;
    this.contextSong = null;
    this.contextSeen = false;
    this.expectTitle = track.title;
    this.actualUri = null;
    this.endedFor = null;
    this.furthest = 0;
    this.sawPlaying = false;
    this.last = null;
    this.requestedAt = performance.now();
    debug('spotify', `play ${track.ref} (${track.title})`);
    // Lets the SDK start audio even if the click that got us here has expired.
    await this.sdk?.activateElement().catch(() => {});
    const start = () =>
      this.api(`/me/player/play?device_id=${encodeURIComponent(this.deviceId ?? '')}`, {
        method: 'PUT',
        body: JSON.stringify(this.expectContext ? { context_uri: track.ref } : { uris: [track.ref] }),
      });
    try {
      await start();
    } catch (error) {
      // "Device not found" right after connecting: Spotify hasn't registered the device yet.
      if (!/device|404/i.test((error as Error).message)) throw error;
      await new Promise((resolve) => setTimeout(resolve, 1200));
      await start();
    }
    if (this.sdk instanceof ConnectPlayer) this.sdk.follow();
  }

  /** librespot's Connect device. Starts librespot (signed in with this page's token) if it isn't running. */
  private async findLibrespot(player: ConnectPlayer) {
    this.deviceId = (await player.findDevice(LIBRESPOT_NAME)) || null;
    if (!this.deviceId && desktop?.spot) {
      debug('spotify', 'starting librespot');
      this.librespotState = null;
      desktop.spot.start({ token: await this.token(), name: LIBRESPOT_NAME });
      for (let i = 0; i < 30 && !this.deviceId; i++) {
        await new Promise((resolve) => setTimeout(resolve, 700));
        // (Updated by librespot's reports while this waits.)
        const status = (this.librespotState as SpotState | null)?.status;
        if (status && ['missing', 'auth-failed', 'unreachable', 'failed', 'exited'].includes(status)) break;
        this.deviceId = (await player.findDevice(LIBRESPOT_NAME)) || null;
      }
    }
    if (!this.deviceId) throw new Error(librespotProblem(this.librespotState));
    debug('spotify', `playing on librespot ("${player.deviceName}")`);
    this.emit('status', undefined);
  }

  /** The Spotify app to play on. In the desktop app, starts it and waits for it if it isn't running. */
  private async findSpotifyApp(player: ConnectPlayer) {
    this.deviceId = (await player.findDevice()) || null;
    if (!this.deviceId && desktop?.openSpotify) {
      debug('spotify', 'no Spotify app is running; starting it');
      desktop.openSpotify();
      for (let i = 0; i < 20 && !this.deviceId; i++) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
        this.deviceId = (await player.findDevice()) || null;
      }
    }
    if (!this.deviceId) {
      throw new Error('Open Spotify on this computer (or on any device signed in to your account), then play the song again.');
    }
    debug('spotify', `playing on "${player.deviceName}"`);
    this.emit('status', undefined);
  }

  // ------------------------------------------------------------- Web API

  private async api<T = unknown>(path: string, init: RequestInit = {}, retry = true): Promise<T> {
    const url = path.startsWith('http') ? path : `${API}${path}`;
    const response = await fetch(url, {
      ...init,
      headers: { Authorization: `Bearer ${await this.token()}`, 'Content-Type': 'application/json', ...init.headers },
    });
    if (response.status === 401 && retry) {
      await this.token(true);
      return this.api<T>(path, init, false);
    }
    if (response.status === 429 && retry) {
      const wait = Math.min(10, Number(response.headers.get('Retry-After') ?? 2));
      await new Promise((resolve) => setTimeout(resolve, wait * 1000));
      return this.api<T>(path, init, false);
    }
    if (!response.ok) {
      const body = (await response.json().catch(() => null)) as { error?: { message?: string; reason?: string } } | null;
      const message = body?.error?.message ?? response.statusText;
      if (response.status === 403 && /premium/i.test(`${message} ${body?.error?.reason ?? ''}`)) {
        throw new Error('Spotify Premium is required.');
      }
      throw new Error(`Spotify: ${message} (${response.status})`);
    }
    if (response.status === 204 || response.headers.get('Content-Length') === '0') return undefined as T;
    return (await response.json().catch(() => undefined)) as T;
  }

  /** Follows `next` links, tolerating development-mode page-size limits. */
  private async pages<T>(path: string, max = 500): Promise<T[]> {
    const out: T[] = [];
    const join = path.includes('?') ? '&' : '?';
    let page: Page<T>;
    try {
      page = await this.api<Page<T>>(`${path}${join}limit=50`);
    } catch (error) {
      if (!/limit|400/i.test((error as Error).message)) throw error;
      page = await this.api<Page<T>>(`${path}${join}limit=10`);
    }
    for (;;) {
      for (const item of page.items ?? []) if (item) out.push(item);
      if (!page.next || out.length >= max) break;
      page = await this.api<Page<T>>(page.next);
    }
    return out;
  }

  private toTrack(t: ApiTrack | null | undefined, fallbackArt?: string, album?: string): Track | null {
    if (!t || !t.uri || t.is_local || t.is_playable === false || (t.type && t.type !== 'track')) return null;
    return {
      id: newTrackId('spotify'),
      source: 'spotify',
      ref: t.uri,
      title: t.name,
      artist: t.artists?.map((a) => a.name).join(', '),
      album: t.album?.name ?? album,
      duration: t.duration_ms / 1000,
      artworkUrl: t.album?.images?.[0]?.url ?? fallbackArt,
    };
  }

  private toCollection(c: ApiCollection | null | undefined, kind: 'album' | 'playlist'): Collection | null {
    if (!c?.id) return null;
    return {
      id: c.id,
      source: 'spotify',
      kind,
      title: c.name,
      subtitle: kind === 'album' ? c.artists?.map((a) => a.name).join(', ') : c.owner?.display_name ? `Playlist by ${c.owner.display_name}` : 'Playlist',
      artworkUrl: c.images?.[0]?.url,
    };
  }

  canSearch() {
    return this.status().connected;
  }

  async search(query: string): Promise<SearchResults> {
    const data = await this.api<{ tracks?: Page<ApiTrack>; albums?: Page<ApiCollection>; playlists?: Page<ApiCollection> }>(
      `/search?${new URLSearchParams({ q: query, type: 'track,album,playlist', limit: '10' })}`,
    );
    const keep = <T>(list: (T | null)[]): T[] => list.filter((x): x is T => x !== null);
    return {
      tracks: keep((data.tracks?.items ?? []).map((t) => this.toTrack(t))),
      collections: [
        ...keep((data.albums?.items ?? []).map((a) => this.toCollection(a, 'album'))),
        ...keep((data.playlists?.items ?? []).map((p) => this.toCollection(p, 'playlist'))),
      ],
    };
  }

  async library(): Promise<Collection[]> {
    const playlists = await this.pages<ApiCollection>('/me/playlists', 200);
    const liked: Collection = { id: 'liked', source: 'spotify', kind: 'playlist', title: 'Liked Songs', subtitle: 'Your saved tracks' };
    return [liked, ...playlists.map((p) => this.toCollection(p, 'playlist')).filter((c): c is Collection => c !== null)];
  }

  async tracksOf(collection: Collection): Promise<Track[]> {
    if (collection.contextOnly) return [this.listTrack(collection)];
    const keep = (list: (Track | null)[]) => list.filter((t): t is Track => t !== null);
    if (collection.kind === 'album') {
      const tracks = await this.pages<ApiTrack>(`/albums/${collection.id}/tracks`);
      return keep(tracks.map((t) => this.toTrack(t, collection.artworkUrl, collection.title)));
    }
    type Entry = { item?: ApiTrack | null; track?: ApiTrack | null };
    if (collection.id === 'liked') {
      return keep((await this.pages<Entry>('/me/tracks')).map((e) => this.toTrack(e.track ?? e.item)));
    }
    let entries: Entry[];
    try {
      entries = await this.pages<Entry>(`/playlists/${collection.id}/items`);
    } catch (error) {
      // Apps not yet migrated to the February 2026 API still use the old path.
      if (!/404|not found/i.test((error as Error).message)) throw error;
      try {
        entries = await this.pages<Entry>(`/playlists/${collection.id}/tracks`);
      } catch (again) {
        // A Spotify-made playlist: apps may not list it, but Spotify will play it.
        if (!/40[34]|not found/i.test((again as Error).message)) throw again;
        return [this.listTrack(collection)];
      }
    }
    return keep(entries.map((e) => this.toTrack(e.item ?? e.track)));
  }

  /** A queue item that has Spotify play a whole list (see Track.context). */
  private listTrack(collection: Collection): Track {
    return {
      id: newTrackId('spotify'),
      source: 'spotify',
      ref: `spotify:${collection.kind}:${collection.id}`,
      title: collection.title,
      artist: 'Played by Spotify',
      artworkUrl: collection.artworkUrl,
      context: { title: collection.title, artworkUrl: collection.artworkUrl },
    };
  }

  /** A list Spotify won't describe through the API. Its public embed page still gives the name and cover. */
  private async listOnly(kind: 'playlist' | 'album', id: string): Promise<Collection> {
    type Embed = { title?: string; thumbnail_url?: string };
    let info: Embed = {};
    try {
      const response = await fetch(`https://open.spotify.com/oembed?${new URLSearchParams({ url: `https://open.spotify.com/${kind}/${id}` })}`);
      if (response.ok) info = (await response.json()) as Embed;
    } catch {
      /* the name is cosmetic */
    }
    return {
      id,
      source: 'spotify',
      kind,
      title: info.title || 'Spotify playlist',
      subtitle: 'Made by Spotify · plays as a whole',
      artworkUrl: info.thumbnail_url,
      contextOnly: true,
    };
  }

  // ------------------------------------------------------------- home

  /** Spotify-made playlists opened by link, newest first. */
  pinned(): Collection[] {
    return readJson<Collection[]>(PINNED_KEY) ?? [];
  }

  private pin(collection: Collection) {
    const list = [collection, ...this.pinned().filter((c) => c.id !== collection.id)].slice(0, 16);
    localStorage.setItem(PINNED_KEY, JSON.stringify(list));
  }

  unpin(id: string) {
    localStorage.setItem(PINNED_KEY, JSON.stringify(this.pinned().filter((c) => c.id !== id)));
  }

  /** First page of a list, retrying with the smaller page size development-mode apps may be held to. */
  private async firstPage<T>(path: string, limit: number): Promise<T[]> {
    const join = path.includes('?') ? '&' : '?';
    let page: Page<T>;
    try {
      page = await this.api<Page<T>>(`${path}${join}limit=${limit}`);
    } catch (error) {
      if (limit <= 10 || !/limit|400/i.test((error as Error).message)) throw error;
      page = await this.api<Page<T>>(`${path}${join}limit=10`);
    }
    return (page.items ?? []).filter((x): x is T => x !== null);
  }

  private hasScope(scope: string): boolean {
    // Sign-ins from before Phosphor 2 didn't record what was granted: just try.
    return this.tokens?.scope === undefined || this.tokens.scope.split(' ').includes(scope);
  }

  async home(): Promise<Shelf[]> {
    const reconnect = 'Phosphor needs one more permission from Spotify for this. Reconnect to allow it.';
    const shelf = async (title: string, scope: string | null, load: () => Promise<Partial<Shelf>>): Promise<Shelf> => {
      if (scope && !this.hasScope(scope)) return { title, note: reconnect, needsReconnect: true };
      try {
        return { title, ...(await load()) };
      } catch (error) {
        const message = (error as Error).message;
        if (/scope|\(403\)/i.test(message)) return { title, note: reconnect, needsReconnect: true };
        return { title, note: `Couldn't load this: ${message}` };
      }
    };
    type Played = { track: ApiTrack | null; context: { type: string; uri: string } | null };
    const recent = this.hasScope('user-read-recently-played') ? this.firstPage<Played>('/me/player/recently-played', 50) : Promise.resolve([]);
    recent.catch(() => {});
    const keep = <T>(list: (T | null)[]): T[] => list.filter((x): x is T => x !== null);
    const pinned = this.pinned();

    return Promise.all([
      shelf('Recently played', 'user-read-recently-played', async () => {
        const seen = new Set<string>();
        const tracks = keep((await recent).map((p) => (p.track && !seen.has(p.track.uri) && seen.add(p.track.uri) ? this.toTrack(p.track) : null)));
        return { tracks: tracks.slice(0, 20) };
      }),
      shelf('Jump back in', 'user-read-recently-played', async () => {
        const contexts = [...new Set((await recent).map((p) => p.context?.uri).filter((uri): uri is string => Boolean(uri)))];
        const lists = contexts
          .map((uri) => /^spotify:(album|playlist):([A-Za-z0-9]+)$/.exec(uri))
          .filter((m): m is RegExpExecArray => m !== null)
          .slice(0, 8);
        const found = await Promise.all(lists.map(([, kind, id]) => this.describeList(kind as 'album' | 'playlist', id).catch(() => null)));
        return { collections: keep(found) };
      }),
      shelf('Your top songs this month', 'user-top-read', async () => ({
        tracks: keep((await this.firstPage<ApiTrack>('/me/top/tracks?time_range=short_term', 20)).map((t) => this.toTrack(t))),
      })),
      shelf('Your playlists', null, async () => ({ collections: await this.library() })),
      shelf('Saved albums', null, async () => ({
        collections: keep((await this.firstPage<{ album: ApiCollection }>('/me/albums', 20)).map((e) => this.toCollection(e.album, 'album'))),
      })),
      shelf('Spotify-made playlists', null, async () => ({
        collections: pinned,
        note: pinned.length
          ? 'Opened from links. Spotify plays these itself; Phosphor shows each song as it comes up.'
          : "Spotify doesn't let apps list its own playlists (Discover Weekly, Daily Mixes, editorial playlists). Paste a link to one above and Phosphor has Spotify play it as a whole. It will be kept here.",
      })),
    ]);
  }

  /** Name and cover of an album or playlist; Spotify-made playlists come back as play-as-a-whole lists. */
  private async describeList(kind: 'album' | 'playlist', id: string): Promise<Collection | null> {
    try {
      const data = await this.api<ApiCollection>(`/${kind}s/${id}`);
      return this.toCollection(data, kind);
    } catch (error) {
      if (kind === 'playlist' && /40[34]|not found/i.test((error as Error).message)) return this.listOnly('playlist', id);
      throw error;
    }
  }

  // ------------------------------------------------------------ library

  /** The URI to save: for a list Spotify is playing, the song playing now. */
  private uriOf(item: Track | Collection): string {
    if ('kind' in item) {
      if (item.id === 'liked') throw new Error('Liked Songs is already your library.');
      return `spotify:${item.kind}:${item.id}`;
    }
    if (item.context && item.ref === this.expectContext && this.contextSong) return this.contextSong;
    if (!item.ref) throw new Error('missing Spotify URI');
    return item.ref;
  }

  canSave(item: Track | Collection): boolean {
    return !('kind' in item && item.id === 'liked');
  }

  async saveToLibrary(item: Track | Collection): Promise<void> {
    const uri = this.uriOf(item);
    try {
      await this.api(`/me/library?${new URLSearchParams({ uris: uri })}`, { method: 'PUT' });
    } catch (error) {
      const message = (error as Error).message;
      if (/scope/i.test(message)) throw new Error('Phosphor needs one more permission to save to your library. Reconnect Spotify (Add music, Spotify) and try again.');
      if (/\(403\)/.test(message)) {
        throw new Error("Spotify refused to save it (403). Since 2026 Spotify blocks changes from many personal (development-mode) apps; save it in the Spotify app instead.");
      }
      throw error;
    }
    debug('spotify', `saved ${uri}`);
  }

  async isSaved(item: Track | Collection): Promise<boolean> {
    const uri = this.uriOf(item);
    const answer = await this.api<boolean[]>(`/me/library/contains?${new URLSearchParams({ uris: uri })}`);
    return Array.isArray(answer) && answer[0] === true;
  }

  /** Signs in again so Spotify asks for the permissions added since the last sign-in. */
  async reconnect(): Promise<void> {
    if (!this.clientId) throw new Error('Add your Spotify Client ID in Settings first.');
    await this.authorize();
    if (!this.sdk) await this.startSdk();
    this.emit('status', undefined);
  }

  link(track: Track): string | null {
    if (track.link) return track.link;
    return spotifyWebLink(track.ref);
  }

  async resolveLink(url: string): Promise<SearchResults | null> {
    const match =
      /open\.spotify\.com\/(?:intl-[a-z-]+\/)?(track|album|playlist)\/([A-Za-z0-9]+)/.exec(url) ??
      /^spotify:(track|album|playlist):([A-Za-z0-9]+)$/.exec(url.trim());
    if (!match) return null;
    const [, kind, id] = match;
    if (kind === 'track') {
      const track = this.toTrack(await this.api<ApiTrack>(`/tracks/${id}`));
      return { tracks: track ? [track] : [], collections: [] };
    }
    const collection = await this.describeList(kind as 'album' | 'playlist', id);
    if (collection?.contextOnly) this.pin(collection);
    return { tracks: [], collections: collection ? [collection] : [] };
  }
}
