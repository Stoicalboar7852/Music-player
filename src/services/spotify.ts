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

import { Emitter } from '../app/emitter';
import { appBaseUrl, settings } from '../app/settings';
import { newTrackId, type Backend, type BackendEvents, type Collection, type Track } from '../player/types';
import type { MusicService, SearchResults, ServiceStatus } from './types';

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
];

const TOKENS_KEY = 'phosphor.spotify.tokens';
const PENDING_KEY = 'phosphor.spotify.pending';
const CHANNEL = 'phosphor-auth';

interface Tokens {
  access: string;
  refresh: string;
  /** Epoch milliseconds. */
  expiresAt: number;
  clientId: string;
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
}

interface SdkState {
  paused: boolean;
  loading: boolean;
  position: number;
  duration: number;
  timestamp: number;
  track_window: { current_track: SdkTrack | null; previous_tracks: SdkTrack[] };
}

interface SdkPlayer {
  connect(): Promise<boolean>;
  disconnect(): void;
  addListener(event: string, callback: (payload: never) => void): void;
  pause(): Promise<void>;
  resume(): Promise<void>;
  seek(ms: number): Promise<void>;
  setVolume(volume: number): Promise<void>;
  activateElement(): Promise<void>;
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
  owner?: { display_name?: string };
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
    await this.service.sdk?.pause();
  }
  async seek(seconds: number) {
    await this.service.sdk?.seek(Math.round(seconds * 1000));
    this.service.noteSeek(seconds);
  }
  setVolume(volume: number) {
    this.service.volume = volume;
    void this.service.sdk?.setVolume(volume).catch(() => {});
  }
  position() {
    return this.service.position();
  }
  duration() {
    return (this.service.last?.duration ?? 0) / 1000;
  }
  async stop() {
    this.service.expectUri = null;
    await this.service.sdk?.pause().catch(() => {});
  }
}

export class SpotifyService extends Emitter<{ status: void }> implements MusicService {
  readonly id = 'spotify' as const;
  readonly name = 'Spotify';
  readonly linkHint = 'Spotify track, album or playlist link';
  readonly limits = [
    'Requires Spotify Premium. Spotify does not allow browser playback for free accounts.',
    'While your Spotify app is in development mode it works for you and up to five people you add in the Spotify dashboard, and the app owner must have Premium.',
    "Spotify's audio is DRM-protected and cannot be read by the page. The visualizers react to this tab's shared audio instead, so you will be asked to share the tab once per session.",
    'Volume changes here are applied by Spotify before the audio is captured: at very low volume the visuals get less signal, and muting silences them. Use your system volume to listen quietly.',
    'Search returns up to 10 results of each kind (a limit Spotify applies to development-mode apps).',
  ];
  readonly backend = new SpotifyBackend(this);

  sdk: SdkPlayer | null = null;
  last: SdkState | null = null;
  volume = 0.8;
  /** The URI the player asked for; state events about anything else are ignored. */
  expectUri: string | null = null;

  private tokens: Tokens | null = readJson<Tokens>(TOKENS_KEY);
  private deviceId: string | null = null;
  private account = '';
  private problem = '';
  private connecting: Promise<void> | null = null;
  private refreshing: Promise<string> | null = null;
  private sawPlaying = false;
  /** When we last sought to the start of a track (see onState). */
  private seekedAt = 0;

  constructor() {
    super();
    settings.on('change', (patch) => {
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
  }

  private authWaiter: ((failure: string) => void) | null = null;

  private get clientId(): string {
    return settings.get('spotifyClientId').trim();
  }

  status(): ServiceStatus {
    return {
      configured: this.clientId.length > 0,
      connected: Boolean(this.sdk && this.deviceId),
      account: this.account || undefined,
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
    await this.startSdk();
    try {
      const me = await this.api<{ display_name?: string; id: string; product?: string }>('/me');
      this.account = me.display_name || me.id;
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
    this.sdk?.disconnect();
    this.sdk = null;
    this.deviceId = null;
    this.tokens = null;
    this.account = '';
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

  private async startSdk() {
    await this.loadSdk();
    if (this.sdk) return;
    const sdk = new window.Spotify!.Player({
      name: 'Phosphor',
      getOAuthToken: (cb) => void this.token().then(cb, () => cb('')),
      volume: this.volume,
    });
    const on = <T>(event: string, callback: (payload: T) => void) => sdk.addListener(event, callback as (payload: never) => void);

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
      this.last = null;
      this.backend.events.state?.(false);
      return;
    }
    const current = state.track_window.current_track;
    if (!this.expectUri || !current) return;
    const previous = this.last;
    this.last = state;
    const events = this.backend.events;

    if (current.uri === this.expectUri) {
      if (!state.paused && !state.loading) this.sawPlaying = true;
      // The SDK has no "ended" event. A finished track shows up as paused at
      // position 0 after it had been playing (and not because we just sought there).
      const ended =
        this.sawPlaying &&
        state.paused &&
        state.position === 0 &&
        !state.loading &&
        Boolean(previous && previous.position > 0) &&
        performance.now() - this.seekedAt > 1500;
      if (ended) {
        this.sawPlaying = false;
        events.ended?.();
        return;
      }
      events.meta?.({ duration: state.duration / 1000 });
      if (!state.loading) events.state?.(!state.paused);
    } else if (this.sawPlaying && state.track_window.previous_tracks.some((t) => t.uri === this.expectUri)) {
      // Spotify moved on by itself (autoplay / its own queue): our track is over.
      this.sawPlaying = false;
      void this.sdk?.pause().catch(() => {});
      events.ended?.();
    }
  }

  noteSeek(seconds: number) {
    // Only a seek back to the very start can be mistaken for the end of a track.
    if (seconds < 1) this.seekedAt = performance.now();
    if (this.last) this.last = { ...this.last, position: seconds * 1000, timestamp: Date.now() };
  }

  position(): number {
    const s = this.last;
    if (!s) return 0;
    const elapsed = s.paused ? 0 : Date.now() - s.timestamp;
    return Math.min(s.duration, s.position + Math.max(0, elapsed)) / 1000;
  }

  /** Starts a track on this tab's Spotify device. */
  async playUri(track: Track) {
    if (!track.ref) throw new Error('missing Spotify URI');
    if (!this.sdk || !this.deviceId) await this.connect();
    this.expectUri = track.ref;
    this.sawPlaying = false;
    this.last = null;
    // Lets the SDK start audio even if the click that got us here has expired.
    await this.sdk?.activateElement().catch(() => {});
    const start = () =>
      this.api(`/me/player/play?device_id=${encodeURIComponent(this.deviceId ?? '')}`, {
        method: 'PUT',
        body: JSON.stringify({ uris: [track.ref] }),
      });
    try {
      await start();
    } catch (error) {
      // "Device not found" right after connecting: Spotify hasn't registered the device yet.
      if (!/device|404/i.test((error as Error).message)) throw error;
      await new Promise((resolve) => setTimeout(resolve, 1200));
      await start();
    }
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
      entries = await this.pages<Entry>(`/playlists/${collection.id}/tracks`);
    }
    return keep(entries.map((e) => this.toTrack(e.item ?? e.track)));
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
    const data = await this.api<ApiCollection>(`/${kind}s/${id}`);
    const collection = this.toCollection(data, kind as 'album' | 'playlist');
    return { tracks: [], collections: collection ? [collection] : [] };
  }
}
