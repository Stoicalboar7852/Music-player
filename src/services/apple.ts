// Apple Music through MusicKit on the Web (v3). MusicKit handles sign-in (in
// Apple's own window), catalog and library requests, and DRM playback; this
// file adapts it to the shared player.
//
// As with Spotify, the audio itself cannot be read: the visualizers are fed
// by sharing this tab's audio.

import { debug } from '../app/debug';
import { Emitter } from '../app/emitter';
import { settings } from '../app/settings';
import { newTrackId, type Backend, type BackendEvents, type Collection, type Track } from '../player/types';
import type { MusicService, SearchResults, ServiceStatus } from './types';

const SDK_URL = 'https://js-cdn.music.apple.com/musickit/v3/musickit.js';

// ---- the parts of MusicKit this file uses

interface MkResource {
  id: string;
  type: string;
  attributes?: {
    name?: string;
    artistName?: string;
    albumName?: string;
    curatorName?: string;
    durationInMillis?: number;
    artwork?: { url?: string };
    playParams?: { id?: string };
  };
}

interface MkResponse {
  data: {
    data?: MkResource[];
    next?: string;
    results?: Record<string, { data?: MkResource[] } | undefined>;
  };
}

interface MkInstance {
  isAuthorized: boolean;
  storefrontId: string;
  storefrontCountryCode?: string;
  playbackState: number;
  currentPlaybackTime: number;
  currentPlaybackDuration: number;
  volume: number;
  autoplayEnabled?: boolean;
  authorize(): Promise<string | void>;
  unauthorize(): Promise<void>;
  setQueue(options: Record<string, unknown>): Promise<unknown>;
  play(): Promise<void>;
  pause(): Promise<void> | void;
  stop(): Promise<void> | void;
  seekToTime(seconds: number): Promise<void>;
  addEventListener(name: string, listener: (event: never) => void): void;
  api: { music(path: string, params?: Record<string, unknown>): Promise<MkResponse> };
}

interface MkGlobal {
  configure(config: { developerToken: string; app: { name: string; build: string } }): Promise<MkInstance>;
  getInstance(): MkInstance;
  PlaybackStates: Record<string, number>;
}

declare global {
  interface Window {
    MusicKit?: MkGlobal;
  }
}

/** Reads a JWT's expiry without verifying it (Apple does the verifying). */
export function inspectDeveloperToken(token: string): { valid: boolean; problem?: string } {
  const parts = token.split('.');
  if (parts.length !== 3) return { valid: false, problem: 'That is not a developer token: it should be three dot-separated parts starting with "eyJ".' };
  try {
    const payload = JSON.parse(atob(parts[1].replace(/-/g, '+').replace(/_/g, '/'))) as { exp?: number; iss?: string };
    if (!payload.iss) return { valid: false, problem: 'The developer token has no team ID (iss) in it.' };
    if (payload.exp && payload.exp * 1000 < Date.now()) {
      return { valid: false, problem: `The developer token expired on ${new Date(payload.exp * 1000).toLocaleDateString()}. Generate a new one with "npm run apple-token".` };
    }
    return { valid: true };
  } catch {
    return { valid: false, problem: 'The developer token could not be read. Paste the whole token with nothing added.' };
  }
}

function artworkUrl(artwork?: { url?: string }): string | undefined {
  return artwork?.url?.replace('{w}', '600').replace('{h}', '600').replace('{f}', 'jpg').replace('{c}', 'bb');
}

class AppleBackend implements Backend {
  readonly source = 'apple' as const;
  events: Partial<BackendEvents> = {};

  constructor(private service: AppleMusicService) {}

  load(track: Track) {
    return this.service.playSong(track);
  }
  async play() {
    await this.service.music?.play();
  }
  async pause() {
    await this.service.music?.pause();
  }
  async seek(seconds: number) {
    await this.service.music?.seekToTime(seconds);
  }
  setVolume(volume: number) {
    this.service.volume = volume;
    if (this.service.music) this.service.music.volume = volume;
  }
  position() {
    return this.service.music?.currentPlaybackTime ?? 0;
  }
  duration() {
    return this.service.music?.currentPlaybackDuration ?? 0;
  }
  async stop() {
    this.service.active = false;
    await this.service.music?.stop();
  }
}

export class AppleMusicService extends Emitter<{ status: void }> implements MusicService {
  readonly id = 'apple' as const;
  readonly name = 'Apple Music';
  readonly linkHint = 'Apple Music song, album or playlist link';
  readonly limits = [
    'Needs a developer token, which can only be made with a paid Apple Developer Program membership (the MusicKit key it is signed with comes from there). Tokens expire after at most six months.',
    'Full tracks need an Apple Music subscription. Without one, Apple only plays 30-second previews.',
    "You sign in in Apple's own window; this app never sees your Apple ID.",
    "Apple Music's audio is DRM-protected and cannot be read by the page. The visualizers react to this tab's shared audio instead, so you will be asked to share the tab once per session.",
    'Volume is applied by Apple before the audio is captured, so very low volume gives the visuals less to work with. Use your system volume to listen quietly.',
  ];
  readonly backend = new AppleBackend(this);

  music: MkInstance | null = null;
  volume = 0.8;
  /** True while the shared player wants Apple Music to be the thing playing. */
  active = false;

  private configuredToken = '';
  private problem = '';
  private connecting: Promise<void> | null = null;
  private endedSent = false;

  constructor() {
    super();
    settings.on('change', (patch) => {
      if (!('appleDeveloperToken' in patch)) return;
      // MusicKit can only be configured once per page load with one token.
      if (this.music && this.configuredToken !== this.token) {
        this.problem = 'The developer token changed. Reload the page to use the new one.';
      } else {
        this.problem = '';
      }
      this.emit('status', undefined);
    });
  }

  private get token(): string {
    return settings.get('appleDeveloperToken').trim();
  }

  status(): ServiceStatus {
    const token = this.token;
    const check = token ? inspectDeveloperToken(token) : { valid: false };
    return {
      configured: token.length > 0,
      connected: Boolean(this.music?.isAuthorized),
      problem: this.problem || check.problem,
    };
  }

  onStatus(listener: () => void) {
    return this.on('status', listener);
  }

  // ------------------------------------------------------------- sign-in

  async connect(): Promise<void> {
    this.connecting ??= this.doConnect().finally(() => (this.connecting = null));
    return this.connecting;
  }

  private loadSdk(): Promise<MkGlobal> {
    if (window.MusicKit) return Promise.resolve(window.MusicKit);
    return new Promise((resolve, reject) => {
      document.addEventListener('musickitloaded', () => (window.MusicKit ? resolve(window.MusicKit) : reject(new Error('MusicKit loaded without its API.'))), { once: true });
      const script = document.createElement('script');
      script.src = SDK_URL;
      script.async = true;
      script.onerror = () => reject(new Error("Apple's MusicKit could not be loaded. Check your connection or content blockers."));
      document.head.append(script);
    });
  }

  private async doConnect() {
    const token = this.token;
    if (!token) throw new Error('Add your Apple Music developer token in Settings first.');
    const check = inspectDeveloperToken(token);
    if (!check.valid) throw new Error(check.problem);
    this.problem = '';

    const MusicKit = await this.loadSdk();
    if (!this.music) {
      let music: MkInstance;
      try {
        music = await MusicKit.configure({ developerToken: token, app: { name: 'Phosphor', build: '1.0.0' } });
      } catch (error) {
        this.problem = `Apple rejected the developer token (${(error as Error).message ?? error}). Check the team ID, key ID and key it was made with.`;
        this.emit('status', undefined);
        throw new Error(this.problem);
      }
      this.music = music ?? MusicKit.getInstance();
      this.configuredToken = token;
      this.listen(MusicKit, this.music);
    } else if (this.configuredToken !== token) {
      throw new Error('The developer token changed. Reload the page to use the new one.');
    }

    if (!this.music.isAuthorized) {
      try {
        await this.music.authorize();
      } catch (error) {
        throw new Error(`Apple Music sign-in did not complete${(error as Error)?.message ? `: ${(error as Error).message}` : '.'}`);
      }
    }
    if (!this.music.isAuthorized) throw new Error('Apple Music sign-in was cancelled.');
    this.music.volume = this.volume;
    // When our one-song queue ends, the shared queue decides what is next, not Apple.
    this.music.autoplayEnabled = false;
    this.emit('status', undefined);
  }

  disconnect() {
    void this.music?.stop();
    void this.music?.unauthorize().finally(() => this.emit('status', undefined));
    this.active = false;
    this.emit('status', undefined);
  }

  private listen(MusicKit: MkGlobal, music: MkInstance) {
    const S = MusicKit.PlaybackStates;
    const events = this.backend.events;
    music.addEventListener('playbackStateDidChange', ({ state }: { state: number }) => {
      debug('apple', `state: ${Object.keys(S).find((k) => S[k] === state) ?? state} at ${music.currentPlaybackTime?.toFixed?.(1)}s`);
      if (!this.active) return;
      if (state === S.playing) {
        this.endedSent = false;
        events.state?.(true);
      } else if (state === S.paused) {
        events.state?.(false);
      } else if ((state === S.ended || state === S.completed) && !this.endedSent) {
        this.endedSent = true;
        events.ended?.();
      }
    });
    music.addEventListener('playbackDurationDidChange', ({ duration }: { duration: number }) => {
      if (this.active && duration > 0) events.meta?.({ duration });
    });
    music.addEventListener('mediaPlaybackError', (error: { message?: string; errorCode?: string }) => {
      if (this.active) events.error?.(error?.message || error?.errorCode || 'Apple Music could not play this');
    });
    music.addEventListener('authorizationStatusDidChange', () => this.emit('status', undefined));
  }

  async playSong(track: Track) {
    if (!track.ref) throw new Error('missing Apple Music song id');
    if (!this.music?.isAuthorized) await this.connect();
    const music = this.music!;
    this.active = true;
    this.endedSent = true; // ignore the old song's "ended" while the new one loads
    music.volume = this.volume;
    await music.setQueue({ song: track.ref, startPlaying: true });
    this.endedSent = false;
  }

  // ---------------------------------------------------------------- data

  private storefront(): string {
    return this.music?.storefrontId || this.music?.storefrontCountryCode || 'us';
  }

  private async get(path: string, params?: Record<string, unknown>): Promise<MkResponse['data']> {
    if (!this.music) await this.connect();
    try {
      return (await this.music!.api.music(path, params)).data;
    } catch (error) {
      throw new Error(`Apple Music: ${(error as Error).message ?? 'request failed'}`);
    }
  }

  /** Follows `next` links for relationship endpoints. */
  private async all(path: string, max = 500): Promise<MkResource[]> {
    const out: MkResource[] = [];
    let next: string | undefined = path;
    while (next && out.length < max) {
      const page: MkResponse['data'] = await this.get(next, next === path ? { limit: 100 } : undefined);
      out.push(...(page.data ?? []));
      next = page.next;
    }
    return out;
  }

  private toTrack(r: MkResource, fallbackArt?: string): Track | null {
    const a = r.attributes;
    // No playParams means the song is not available to play in this storefront.
    if (!a?.name || !a.playParams) return null;
    return {
      id: newTrackId('apple'),
      source: 'apple',
      ref: a.playParams.id ?? r.id,
      title: a.name,
      artist: a.artistName,
      album: a.albumName,
      duration: a.durationInMillis ? a.durationInMillis / 1000 : undefined,
      artworkUrl: artworkUrl(a.artwork) ?? fallbackArt,
    };
  }

  private toCollection(r: MkResource): Collection | null {
    const a = r.attributes;
    if (!a?.name) return null;
    const kind = r.type.includes('album') ? 'album' : 'playlist';
    return {
      // The resource type is needed to build the right URL later (catalog vs. library).
      id: `${r.type}:${r.id}`,
      source: 'apple',
      kind,
      title: a.name,
      subtitle: kind === 'album' ? a.artistName : a.curatorName ? `Playlist by ${a.curatorName}` : 'Playlist',
      artworkUrl: artworkUrl(a.artwork),
    };
  }

  canSearch() {
    return this.status().connected;
  }

  async search(query: string): Promise<SearchResults> {
    const data = await this.get(`/v1/catalog/${this.storefront()}/search`, { term: query, types: 'songs,albums,playlists', limit: 20 });
    const pick = (key: string) => data.results?.[key]?.data ?? [];
    const keep = <T>(list: (T | null)[]): T[] => list.filter((x): x is T => x !== null);
    return {
      tracks: keep(pick('songs').map((r) => this.toTrack(r))),
      collections: keep([...pick('albums'), ...pick('playlists')].map((r) => this.toCollection(r))),
    };
  }

  async library(): Promise<Collection[]> {
    const playlists = await this.all('/v1/me/library/playlists', 200);
    return playlists.map((r) => this.toCollection(r)).filter((c): c is Collection => c !== null);
  }

  async tracksOf(collection: Collection): Promise<Track[]> {
    const [type, id] = collection.id.split(':');
    const base = type.startsWith('library-') ? `/v1/me/library/${type.slice(8)}` : `/v1/catalog/${this.storefront()}/${type}`;
    const songs = await this.all(`${base}/${id}/tracks`);
    return songs.map((r) => this.toTrack(r, collection.artworkUrl)).filter((t): t is Track => t !== null);
  }

  async resolveLink(url: string): Promise<SearchResults | null> {
    let parsed: URL;
    try {
      parsed = new URL(url.trim());
    } catch {
      return null;
    }
    if (!/(^|\.)music\.apple\.com$/.test(parsed.hostname)) return null;
    const parts = parsed.pathname.split('/').filter(Boolean);
    const id = parts.at(-1) ?? '';
    const songId = parsed.searchParams.get('i');
    const kind = parts.find((p) => ['album', 'song', 'playlist'].includes(p));
    if (!kind || !id) return null;
    const library = parts[0] === 'library';
    const storefront = !library && /^[a-z]{2}$/.test(parts[0]) ? parts[0] : this.storefront();
    const root = library ? '/v1/me/library' : `/v1/catalog/${storefront}`;

    if (kind === 'song' || songId) {
      const data = await this.get(`${root}/songs/${songId ?? id}`);
      const track = data.data?.[0] ? this.toTrack(data.data[0]) : null;
      return { tracks: track ? [track] : [], collections: [] };
    }
    const data = await this.get(`${root}/${kind}s/${id}`);
    const collection = data.data?.[0] ? this.toCollection(data.data[0]) : null;
    return { tracks: [], collections: collection ? [collection] : [] };
  }
}
