// YouTube and YouTube Music through the official IFrame Player API.
//
// Pasting video and playlist links (youtube.com, youtu.be, music.youtube.com)
// works with no setup at all. A YouTube Data API key is optional and adds
// search, popular music and named playlist tracks. Signing in with Google
// (optional, needs an OAuth client ID) adds the user's own playlists, which
// include their YouTube Music playlists, and liked videos. There is no
// official API for the rest of a YouTube Music library (albums, artists).
//
// The player is an embedded YouTube iframe on another origin, so its audio
// cannot be read either; the visualizers are fed by sharing this tab's audio.
// YouTube's terms require the player to stay visible while it plays, so it
// sits in a small frame in the corner whenever a YouTube track is current.

import { debug } from '../app/debug';
import { Emitter } from '../app/emitter';
import { settings } from '../app/settings';
import { newTrackId, type Backend, type BackendEvents, type Collection, type Track } from '../player/types';
import type { MusicService, OptionalAccount, SearchResults, ServiceStatus, Shelf } from './types';

const API_URL = 'https://www.youtube.com/iframe_api';
const DATA_API = 'https://www.googleapis.com/youtube/v3';
const GIS_URL = 'https://accounts.google.com/gsi/client';
/** Read-only: lists playlists and likes. Phosphor never changes anything on the account. */
const YT_SCOPE = 'https://www.googleapis.com/auth/youtube.readonly';
const GOOGLE_TOKEN_KEY = 'phosphor.google.token';

// ---- the parts of the IFrame API this file uses

interface YtPlayer {
  loadVideoById(id: string | { videoId: string; startSeconds?: number }): void;
  cuePlaylist(opts: { listType: 'playlist'; list: string }): void;
  playVideo(): void;
  pauseVideo(): void;
  stopVideo(): void;
  seekTo(seconds: number, allowSeekAhead: boolean): void;
  setVolume(volume: number): void;
  unMute(): void;
  getCurrentTime(): number;
  getDuration(): number;
  getPlaylist(): string[] | null;
  getVideoData?(): { title?: string; author?: string; video_id?: string };
  destroy(): void;
}

interface YtNamespace {
  Player: new (
    element: HTMLElement | string,
    options: {
      width?: number | string;
      height?: number | string;
      videoId?: string;
      host?: string;
      playerVars?: Record<string, string | number>;
      events?: Record<string, (event: { data: number; target: YtPlayer }) => void>;
    },
  ) => YtPlayer;
}

// ---- the parts of Google Identity Services (token model) this file uses

interface GisTokenResponse {
  access_token?: string;
  expires_in?: number | string;
  scope?: string;
  error?: string;
  error_description?: string;
}

interface GisTokenClient {
  requestAccessToken(overrides?: { prompt?: string }): void;
}

interface GisOauth2 {
  initTokenClient(config: {
    client_id: string;
    scope: string;
    callback: (response: GisTokenResponse) => void;
    error_callback?: (error: { type?: string; message?: string }) => void;
  }): GisTokenClient;
  revoke(token: string, done?: () => void): void;
}

declare global {
  interface Window {
    YT?: YtNamespace & { loaded?: number };
    onYouTubeIframeAPIReady?: () => void;
    google?: { accounts?: { oauth2?: GisOauth2 } };
  }
}

interface GoogleToken {
  access: string;
  /** Epoch milliseconds. Google's browser tokens last an hour and can't be refreshed without a click. */
  expiresAt: number;
  clientId: string;
  /** The YouTube channel name, shown as who is signed in. */
  name?: string;
}

function readToken(): GoogleToken | null {
  try {
    return JSON.parse(localStorage.getItem(GOOGLE_TOKEN_KEY) ?? 'null') as GoogleToken | null;
  } catch {
    return null;
  }
}

/** Optional Google sign-in, through Google's own sign-in window. */
class GoogleAccount implements OptionalAccount {
  readonly signInLabel = 'Sign in with Google';
  readonly benefit = 'Adds your own YouTube and YouTube Music playlists and liked videos, and search without an API key.';
  private token: GoogleToken | null = readToken();
  private problem = '';
  private gis: Promise<GisOauth2> | null = null;

  constructor(private changed: () => void) {}

  private get clientId() {
    return settings.get('googleClientId').trim();
  }

  private valid(): GoogleToken | null {
    const t = this.token;
    return t && t.clientId === this.clientId && t.expiresAt - Date.now() > 60_000 ? t : null;
  }

  /** A usable access token, or null (signed out or expired). */
  accessToken(): string | null {
    return this.valid()?.access ?? null;
  }

  status() {
    const token = this.valid();
    return {
      available: this.clientId.length > 0,
      signedIn: token !== null,
      name: token?.name,
      problem: this.problem || (this.token && !token && this.token.clientId === this.clientId ? 'Your Google sign-in has run out (Google ends them after an hour). Sign in again.' : undefined),
      setupHint: this.clientId ? undefined : 'Add a Google client ID in Settings to sign in and see your own playlists.',
    };
  }

  private loadGis(): Promise<GisOauth2> {
    this.gis ??= new Promise<GisOauth2>((resolve, reject) => {
      if (window.google?.accounts?.oauth2) return resolve(window.google.accounts.oauth2);
      const script = document.createElement('script');
      script.src = GIS_URL;
      script.async = true;
      script.onload = () => (window.google?.accounts?.oauth2 ? resolve(window.google.accounts.oauth2) : reject(new Error("Google's sign-in loaded without its API.")));
      script.onerror = () => reject(new Error("Google's sign-in could not be loaded. Check your connection or content blockers."));
      document.head.append(script);
    }).catch((error) => {
      this.gis = null;
      throw error;
    });
    return this.gis;
  }

  async signIn(): Promise<void> {
    const clientId = this.clientId;
    if (!clientId) throw new Error('Add a Google client ID in Settings first.');
    const oauth2 = await this.loadGis();
    const response = await new Promise<GisTokenResponse>((resolve, reject) => {
      const client = oauth2.initTokenClient({
        client_id: clientId,
        scope: YT_SCOPE,
        callback: resolve,
        error_callback: (error) =>
          reject(new Error(error.type === 'popup_closed' ? 'Google sign-in was cancelled.' : `Google sign-in failed: ${error.message ?? error.type ?? 'unknown error'}`)),
      });
      client.requestAccessToken({ prompt: this.token ? '' : 'consent' });
    });
    if (!response.access_token || response.error) {
      this.problem = `Google sign-in failed: ${response.error_description ?? response.error ?? 'no token'}`;
      this.changed();
      throw new Error(this.problem);
    }
    if (response.scope && !response.scope.split(' ').includes(YT_SCOPE)) {
      this.problem = 'Google sign-in finished without permission to see your YouTube account. Sign in again and tick the YouTube box.';
      this.changed();
      throw new Error(this.problem);
    }
    this.problem = '';
    this.token = { access: response.access_token, expiresAt: Date.now() + Number(response.expires_in ?? 3600) * 1000, clientId };
    try {
      const me = await fetch(`${DATA_API}/channels?part=snippet&mine=true`, { headers: { Authorization: `Bearer ${response.access_token}` } });
      const body = (await me.json()) as { items?: { snippet?: { title?: string } }[] };
      this.token.name = body.items?.[0]?.snippet?.title;
    } catch {
      /* the name is cosmetic */
    }
    localStorage.setItem(GOOGLE_TOKEN_KEY, JSON.stringify(this.token));
    debug('youtube', `signed in to Google as ${this.token.name ?? 'unknown channel'}`);
    this.changed();
  }

  signOut() {
    const token = this.token?.access;
    this.token = null;
    this.problem = '';
    localStorage.removeItem(GOOGLE_TOKEN_KEY);
    if (token) window.google?.accounts?.oauth2?.revoke(token);
    this.changed();
  }
}

const ERRORS: Record<number, string> = {
  2: 'YouTube rejected the video id',
  5: "the video can't be played in the browser's HTML5 player",
  100: 'the video was not found (removed or private)',
  101: "the owner doesn't allow this video to be played outside YouTube",
  150: "the owner doesn't allow this video to be played outside YouTube",
  153: 'YouTube needs the page to send a Referer header; check the referrer policy',
};

/** Pulls a video id and/or playlist id out of any YouTube or YouTube Music URL. */
export function parseYouTubeLink(input: string): { video?: string; list?: string; unsupported?: string } | null {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    // A bare 11-character video id.
    return /^[\w-]{11}$/.test(input.trim()) ? { video: input.trim() } : null;
  }
  const host = url.hostname.replace(/^(www|m)\./, '');
  const isVideoId = (id: string | null | undefined): id is string => Boolean(id && /^[\w-]{11}$/.test(id));
  if (host === 'youtu.be') {
    const id = url.pathname.slice(1);
    return isVideoId(id) ? { video: id, list: url.searchParams.get('list') ?? undefined } : null;
  }
  if (host !== 'youtube.com' && host !== 'music.youtube.com' && host !== 'youtube-nocookie.com') return null;

  const parts = url.pathname.split('/').filter(Boolean);
  if (parts[0] === 'browse' || parts[0] === 'channel') {
    return {
      unsupported:
        'That is a YouTube Music album or artist page, which has no public id the player can use. Use Share on the album (it gives a playlist link) or on a song instead.',
    };
  }
  let video = url.searchParams.get('v') ?? undefined;
  if (!video && ['shorts', 'embed', 'live', 'v'].includes(parts[0])) video = parts[1];
  const list = url.searchParams.get('list') ?? undefined;
  if (!isVideoId(video)) video = undefined;
  if (!video && !list) return null;
  return { video, list };
}

/** ISO 8601 duration (PT3M27S) to seconds. */
function isoDuration(value?: string): number | undefined {
  const m = /^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(value ?? '');
  if (!m) return undefined;
  const [, d, h, min, s] = m.map((x) => Number(x ?? 0));
  return d * 86400 + h * 3600 + min * 60 + s;
}

/** Artist names on auto-generated YouTube Music uploads come as "Name - Topic". */
const cleanArtist = (channel?: string) => channel?.replace(/ - Topic$/, '');

const thumbnail = (id: string) => `https://i.ytimg.com/vi/${id}/mqdefault.jpg`;

class YouTubeBackend implements Backend {
  readonly source = 'youtube' as const;
  events: Partial<BackendEvents> = {};

  constructor(private service: YouTubeService) {}

  load(track: Track) {
    return this.service.playVideo(track);
  }
  async play() {
    this.service.player?.playVideo();
  }
  async pause() {
    this.service.player?.pauseVideo();
  }
  async seek(seconds: number) {
    this.service.player?.seekTo(seconds, true);
  }
  setVolume(volume: number) {
    this.service.volume = volume;
    this.service.player?.setVolume(Math.round(volume * 100));
  }
  position() {
    return this.service.player?.getCurrentTime?.() ?? 0;
  }
  duration() {
    return this.service.player?.getDuration?.() ?? 0;
  }
  async stop() {
    this.service.current = null;
    this.service.player?.stopVideo();
    this.service.showFrame(false);
  }
}

export class YouTubeService extends Emitter<{ status: void }> implements MusicService {
  readonly id = 'youtube' as const;
  readonly name = 'YouTube';
  readonly linkHint = 'YouTube or YouTube Music video or playlist link';
  readonly signIn = false;
  readonly limits = [
    'Paste any YouTube or YouTube Music video or playlist link; nothing needs setting up. To queue a YouTube Music album, use Share on the album page, which gives a playlist link.',
    'Signing in with Google is optional (it needs an OAuth client ID in Settings) and read-only. It adds your own playlists, which include your YouTube Music playlists, and your liked videos. YouTube has no official API for the rest of a YouTube Music library (saved albums, artists), so those cannot be shown.',
    "Phosphor doesn't like or save videos: that would need permission to manage your YouTube account, which it doesn't ask for. Public and unlisted playlists work by link.",
    'Searching needs a free YouTube Data API key or a Google sign-in. Each search makes two search requests (videos and playlists) at 100 quota units each, so the default 10,000 daily units allow about 50 searches a day. Pasting links and popular music cost a few units.',
    "Google ends browser sign-ins after an hour; when that happens your playlists ask you to sign in again (one click).",
    'Some videos, often official music videos from labels, are blocked from playing outside YouTube by their owner. Those are skipped with a message.',
    "YouTube's terms require the player to stay visible while it plays, so a small video frame stays in the corner, even in fullscreen.",
    "The embedded player runs on YouTube's own origin and its audio cannot be read. The visualizers react to this tab's shared audio instead.",
  ];
  readonly backend = new YouTubeBackend(this);

  player: YtPlayer | null = null;
  volume = 0.8;
  current: Track | null = null;

  readonly account = new GoogleAccount(() => this.emit('status', undefined));

  private frame: HTMLElement;
  private ready: Promise<void> | null = null;
  private endedFor: string | null = null;

  constructor() {
    super();
    this.frame = document.createElement('div');
    this.frame.className = 'yt-frame';
    this.frame.hidden = true;
    this.frame.append(Object.assign(document.createElement('div'), { id: 'yt-player' }));
    document.body.append(this.frame);
    settings.on('change', (patch) => {
      if ('youtubeApiKey' in patch || 'googleClientId' in patch) this.emit('status', undefined);
    });
  }

  private get key(): string {
    return settings.get('youtubeApiKey').trim();
  }

  /** The Data API can be used: with the signed-in account, or with the API key. */
  private canQuery(): boolean {
    return this.account.accessToken() !== null || this.key.length > 0;
  }

  status(): ServiceStatus {
    const google = this.account.status();
    return {
      configured: true,
      connected: true,
      account: google.name,
      label: google.signedIn ? 'Signed in to YouTube' : this.key ? 'Ready: links and search' : 'Ready: paste links (add an API key in Settings to search)',
    };
  }

  onStatus(listener: () => void) {
    return this.on('status', listener);
  }

  async connect() {
    await this.ensurePlayer();
  }

  disconnect() {
    /* nothing to sign out of */
  }

  showFrame(show: boolean) {
    this.frame.hidden = !show;
  }

  // -------------------------------------------------------------- player

  private loadApi(): Promise<YtNamespace> {
    if (window.YT?.Player && window.YT.loaded) return Promise.resolve(window.YT);
    return new Promise((resolve, reject) => {
      const previous = window.onYouTubeIframeAPIReady;
      window.onYouTubeIframeAPIReady = () => {
        previous?.();
        resolve(window.YT!);
      };
      if (!document.querySelector(`script[src="${API_URL}"]`)) {
        const script = document.createElement('script');
        script.src = API_URL;
        script.onerror = () => reject(new Error("YouTube's player could not be loaded. Check your connection or content blockers."));
        document.head.append(script);
      }
    });
  }

  private ensurePlayer(): Promise<void> {
    this.ready ??= (async () => {
      const YT = await this.loadApi();
      await new Promise<void>((resolve, reject) => {
        const timer = window.setTimeout(() => reject(new Error('The YouTube player took too long to start.')), 20000);
        this.player = new YT.Player('yt-player', {
          width: '100%',
          height: '100%',
          playerVars: { playsinline: 1, rel: 0, enablejsapi: 1, origin: location.origin, iv_load_policy: 3 },
          events: {
            onReady: () => {
              window.clearTimeout(timer);
              this.player?.setVolume(Math.round(this.volume * 100));
              resolve();
            },
            onStateChange: ({ data }) => this.onState(data),
            onError: ({ data }) => {
              if (this.current) this.backend.events.error?.(ERRORS[data] ?? `YouTube error ${data}`);
            },
          },
        });
      });
    })().catch((error) => {
      this.ready = null;
      throw error;
    });
    return this.ready;
  }

  private onState(state: number) {
    debug('youtube', `state: ${({ [-1]: 'unstarted', 0: 'ended', 1: 'playing', 2: 'paused', 3: 'buffering', 5: 'cued' } as Record<number, string>)[state] ?? state}`);
    const track = this.current;
    if (!track) return;
    const events = this.backend.events;
    if (state === 1) {
      events.state?.(true);
      // Without an API key, titles are only known once the video loads.
      const data = this.player?.getVideoData?.();
      const duration = this.player?.getDuration() ?? 0;
      const patch: Partial<Track> = {};
      if (duration > 0) patch.duration = duration;
      if (data?.title && track.title !== data.title && track.title.startsWith('YouTube video')) {
        patch.title = data.title;
        if (data.author) patch.artist = cleanArtist(data.author);
      }
      if (Object.keys(patch).length) events.meta?.(patch);
    } else if (state === 2) {
      events.state?.(false);
    } else if (state === 0 && this.endedFor !== track.id) {
      this.endedFor = track.id;
      events.ended?.();
    }
  }

  async playVideo(track: Track) {
    if (!track.ref) throw new Error('missing YouTube video id');
    await this.ensurePlayer();
    this.current = track;
    this.endedFor = null;
    this.showFrame(true);
    this.player!.setVolume(Math.round(this.volume * 100));
    this.player!.loadVideoById(track.ref);
  }

  // ---------------------------------------------------------------- data

  private videoTrack(id: string, title?: string, channel?: string, duration?: number): Track {
    return {
      id: newTrackId('youtube'),
      source: 'youtube',
      ref: id,
      title: title ?? `YouTube video ${id}`,
      artist: cleanArtist(channel),
      duration,
      artworkUrl: thumbnail(id),
    };
  }

  private async data<T>(path: string, params: Record<string, string>): Promise<T> {
    // The signed-in account's quota is used when there is one; otherwise the API key's.
    const token = this.account.accessToken();
    const query = new URLSearchParams(token ? params : { ...params, key: this.key });
    const response = await fetch(`${DATA_API}/${path}?${query}`, token ? { headers: { Authorization: `Bearer ${token}` } } : undefined);
    const body = (await response.json().catch(() => ({}))) as T & { error?: { message?: string; errors?: { reason?: string }[] } };
    if (!response.ok) {
      const reason = body.error?.errors?.[0]?.reason;
      if (token && response.status === 401) {
        this.account.signOut();
        throw new Error('Your Google sign-in has run out. Sign in again.');
      }
      if (reason === 'quotaExceeded') throw new Error("The YouTube API key's daily quota is used up. It resets at midnight Pacific time.");
      if (reason === 'keyInvalid' || response.status === 400) throw new Error('YouTube rejected the API key. Check it in Settings.');
      if (response.status === 403) throw new Error(`YouTube refused the request: ${body.error?.message ?? 'forbidden'}. Is the YouTube Data API v3 enabled for this key?`);
      throw new Error(`YouTube: ${body.error?.message ?? response.statusText}`);
    }
    return body;
  }

  /** Fills in title, channel and duration for a list of video ids (50 per request, 1 quota unit each). */
  private async describe(ids: string[]): Promise<Track[]> {
    type Videos = { items: { id: string; snippet: { title: string; channelTitle: string }; contentDetails: { duration: string } }[] };
    const out: Track[] = [];
    for (let i = 0; i < ids.length; i += 50) {
      const chunk = ids.slice(i, i + 50);
      const { items } = await this.data<Videos>('videos', { part: 'snippet,contentDetails', id: chunk.join(','), maxResults: '50' });
      const byId = new Map(items.map((v) => [v.id, v]));
      // Keep the requested order; ids the API doesn't return are private or deleted.
      for (const id of chunk) {
        const v = byId.get(id);
        if (v) out.push(this.videoTrack(id, v.snippet.title, v.snippet.channelTitle, isoDuration(v.contentDetails.duration)));
      }
    }
    return out;
  }

  canSearch() {
    return this.canQuery();
  }

  searchUnavailable() {
    return 'Search needs a YouTube Data API key (Settings, free from Google Cloud) or a Google sign-in. Pasting links works without either.';
  }

  async search(query: string): Promise<SearchResults> {
    type Search = { items: { id: { videoId?: string; playlistId?: string }; snippet: { title: string; channelTitle: string; thumbnails?: { medium?: { url: string } } } }[] };
    const [videos, playlists] = await Promise.all([
      // Category 10 is Music.
      this.data<Search>('search', { part: 'snippet', type: 'video', videoCategoryId: '10', maxResults: '20', q: query }),
      this.data<Search>('search', { part: 'snippet', type: 'playlist', maxResults: '8', q: query }),
    ]);
    const ids = videos.items.map((v) => v.id.videoId).filter((id): id is string => Boolean(id));
    return {
      tracks: ids.length ? await this.describe(ids) : [],
      collections: playlists.items
        .filter((p) => p.id.playlistId)
        .map((p) => ({
          id: p.id.playlistId!,
          source: 'youtube' as const,
          kind: 'playlist' as const,
          title: decodeEntities(p.snippet.title),
          subtitle: `Playlist by ${cleanArtist(p.snippet.channelTitle)}`,
          artworkUrl: p.snippet.thumbnails?.medium?.url,
        })),
    };
  }

  async tracksOf(collection: Collection): Promise<Track[]> {
    if (collection.id === 'liked') return this.liked(500);
    if (this.canQuery()) {
      type Items = { items: { contentDetails: { videoId: string } }[]; nextPageToken?: string };
      const ids: string[] = [];
      let pageToken: string | undefined;
      do {
        const page: Items = await this.data<Items>('playlistItems', {
          part: 'contentDetails',
          playlistId: collection.id,
          maxResults: '50',
          ...(pageToken ? { pageToken } : {}),
        });
        ids.push(...page.items.map((i) => i.contentDetails.videoId));
        pageToken = page.nextPageToken;
      } while (pageToken && ids.length < 500);
      return this.describe(ids);
    }
    // No key: let a throwaway player read the playlist's video ids. Titles
    // fill in as each video plays.
    const ids = await this.playlistIdsViaPlayer(collection.id);
    return ids.map((id) => this.videoTrack(id));
  }

  /** Videos as the videos endpoint returns them (chart and liked lists). */
  private videosToTracks(items: { id: string; snippet: { title: string; channelTitle: string }; contentDetails?: { duration?: string } }[]): Track[] {
    return items.map((v) => this.videoTrack(v.id, v.snippet.title, v.snippet.channelTitle, isoDuration(v.contentDetails?.duration)));
  }

  private async liked(max: number): Promise<Track[]> {
    if (!this.account.accessToken()) throw new Error('Sign in with Google to see your liked videos.');
    type Videos = { items: { id: string; snippet: { title: string; channelTitle: string }; contentDetails?: { duration?: string } }[]; nextPageToken?: string };
    const out: Track[] = [];
    let pageToken: string | undefined;
    do {
      const page: Videos = await this.data<Videos>('videos', {
        part: 'snippet,contentDetails',
        myRating: 'like',
        maxResults: String(Math.min(50, max)),
        ...(pageToken ? { pageToken } : {}),
      });
      out.push(...this.videosToTracks(page.items));
      pageToken = page.nextPageToken;
    } while (pageToken && out.length < max);
    return out.slice(0, max);
  }

  private async myPlaylists(): Promise<Collection[]> {
    type Lists = { items: { id: string; snippet: { title: string; thumbnails?: { medium?: { url: string } } }; contentDetails?: { itemCount?: number } }[]; nextPageToken?: string };
    const out: Collection[] = [{ id: 'liked', source: 'youtube', kind: 'playlist', title: 'Liked videos', subtitle: 'Your likes on YouTube and YouTube Music' }];
    let pageToken: string | undefined;
    do {
      const page: Lists = await this.data<Lists>('playlists', { part: 'snippet,contentDetails', mine: 'true', maxResults: '50', ...(pageToken ? { pageToken } : {}) });
      for (const p of page.items) {
        const count = p.contentDetails?.itemCount;
        out.push({
          id: p.id,
          source: 'youtube',
          kind: 'playlist',
          title: p.snippet.title,
          subtitle: count !== undefined ? `${count} video${count === 1 ? '' : 's'}` : 'Your playlist',
          artworkUrl: p.snippet.thumbnails?.medium?.url,
        });
      }
      pageToken = page.nextPageToken;
    } while (pageToken && out.length < 200);
    return out;
  }

  async library(): Promise<Collection[]> {
    return this.myPlaylists();
  }

  async home(): Promise<Shelf[]> {
    const shelves: Shelf[] = [];
    const attempt = async (title: string, load: () => Promise<Partial<Shelf>>) => {
      try {
        shelves.push({ title, ...(await load()) });
      } catch (error) {
        shelves.push({ title, note: `Couldn't load this: ${(error as Error).message}` });
      }
    };
    if (this.account.accessToken()) {
      await attempt('Your playlists', async () => ({ collections: await this.myPlaylists() }));
      await attempt('Liked videos', async () => ({ tracks: await this.liked(24) }));
    }
    if (this.canQuery()) {
      const region = /-([A-Z]{2})$/.exec(navigator.language)?.[1] ?? 'US';
      await attempt('Popular music', async () => {
        type Videos = { items: { id: string; snippet: { title: string; channelTitle: string }; contentDetails?: { duration?: string } }[] };
        // Category 10 is Music. One quota unit.
        const chart = await this.data<Videos>('videos', { part: 'snippet,contentDetails', chart: 'mostPopular', videoCategoryId: '10', regionCode: region, maxResults: '24' });
        return { tracks: this.videosToTracks(chart.items), note: `Most popular music videos on YouTube in ${region} right now.` };
      });
    } else {
      shelves.push({
        title: 'Popular music',
        note: 'Add a YouTube Data API key in Settings, or sign in with Google, to see popular music and search YouTube.',
      });
    }
    return shelves;
  }

  private async playlistIdsViaPlayer(list: string): Promise<string[]> {
    const YT = await this.loadApi();
    const host = document.createElement('div');
    host.style.cssText = 'position:fixed;left:-10000px;top:0;width:320px;height:200px;';
    const target = document.createElement('div');
    host.append(target);
    document.body.append(host);
    try {
      return await new Promise<string[]>((resolve, reject) => {
        const timer = window.setTimeout(() => reject(new Error("YouTube didn't return that playlist. It may be private, or a mix that can't be listed.")), 12000);
        const helper = new YT.Player(target, {
          width: 320,
          height: 200,
          playerVars: { enablejsapi: 1, origin: location.origin, autoplay: 0 },
          events: {
            onReady: () => helper.cuePlaylist({ listType: 'playlist', list }),
            onStateChange: () => {
              const ids = helper.getPlaylist();
              if (ids?.length) {
                window.clearTimeout(timer);
                resolve(ids);
                helper.destroy();
              }
            },
            onError: ({ data }) => {
              window.clearTimeout(timer);
              reject(new Error(`YouTube couldn't open that playlist: ${ERRORS[data] ?? `error ${data}`}`));
            },
          },
        });
      });
    } finally {
      host.remove();
    }
  }

  async resolveLink(url: string): Promise<SearchResults | null> {
    const parsed = parseYouTubeLink(url);
    if (!parsed) return null;
    if (parsed.unsupported) throw new Error(parsed.unsupported);
    const result: SearchResults = { tracks: [], collections: [] };
    if (parsed.video) {
      result.tracks = this.canQuery() ? await this.describe([parsed.video]) : [this.videoTrack(parsed.video)];
      if (result.tracks.length === 0) throw new Error('That video is private, deleted, or not available.');
    }
    if (parsed.list) {
      let title = 'YouTube playlist';
      if (this.canQuery()) {
        type Lists = { items: { snippet: { title: string; channelTitle: string } }[] };
        const info = await this.data<Lists>('playlists', { part: 'snippet', id: parsed.list }).catch(() => null);
        if (info?.items[0]) title = info.items[0].snippet.title;
      }
      result.collections.push({
        id: parsed.list,
        source: 'youtube',
        kind: 'playlist',
        title,
        subtitle: parsed.list.startsWith('OLAK5uy_') ? 'YouTube Music album' : 'Playlist',
        artworkUrl: parsed.video ? thumbnail(parsed.video) : undefined,
      });
    }
    return result;
  }
}

/** Search snippets come HTML-escaped. */
function decodeEntities(text: string): string {
  const el = document.createElement('textarea');
  el.innerHTML = text;
  return el.value;
}
