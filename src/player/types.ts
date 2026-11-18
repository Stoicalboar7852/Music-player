export type SourceId = 'local' | 'spotify' | 'apple' | 'youtube';

export const SOURCE_NAMES: Record<SourceId, string> = {
  local: 'Local file',
  spotify: 'Spotify',
  apple: 'Apple Music',
  youtube: 'YouTube',
};

export interface Track {
  /** Unique within the app. */
  id: string;
  source: SourceId;
  title: string;
  artist?: string;
  album?: string;
  /** Seconds. */
  duration?: number;
  artworkUrl?: string;
  /** Local tracks: the file itself. */
  file?: File;
  /** Local tracks: the browser's handle to the file, when it gave one. Lets playlists reopen it later. */
  handle?: FileSystemFileHandle;
  /** Streaming tracks: the service's own identifier (Spotify URI, Apple song id, YouTube video id). */
  ref?: string;
  /**
   * The song's own page on its service, when it isn't the one `ref` points to:
   * in a list the service plays itself, the song playing now. (The presenter
   * window's QR code links here; see MusicService.link.)
   */
  link?: string;
  /**
   * Set when the item stands for a whole list the service plays itself: a
   * Spotify-made playlist that apps aren't allowed to list, or an Apple Music
   * station. The track's title, artist and artwork then follow whatever song
   * the service is playing, and Next/Previous move within the list first.
   */
  context?: { title: string; artworkUrl?: string };
}

/** An album or playlist on a streaming service. */
export interface Collection {
  id: string;
  source: SourceId;
  kind: 'album' | 'playlist';
  title: string;
  subtitle?: string;
  artworkUrl?: string;
  /** The service won't list its songs to apps, but can play it as a whole (see Track.context). */
  contextOnly?: boolean;
}

/** Callbacks a backend uses to tell the player what happened. */
export interface BackendEvents {
  ended(): void;
  /** Playback was started or paused by something other than the player (e.g. the service's own UI). */
  state(playing: boolean): void;
  error(message: string): void;
  /** The backend learned more about the current track (duration, title, artwork). */
  meta(patch: Partial<Track>): void;
}

/**
 * One way of producing sound. The player owns the queue and transport logic;
 * a backend only knows how to play a single track.
 */
export interface Backend {
  readonly source: SourceId;
  events: Partial<BackendEvents>;
  /** Load the track and start playing it. */
  load(track: Track): Promise<void>;
  play(): Promise<void>;
  pause(): Promise<void>;
  seek(seconds: number): Promise<void>;
  setVolume(volume: number): void;
  /** Seconds. */
  position(): number;
  duration(): number;
  stop(): Promise<void>;
  /**
   * For a context track (a list the service plays itself): move within that
   * list. Returns false when there is nowhere to go, so the queue moves on.
   */
  skip?(direction: 1 | -1): Promise<boolean>;
}

let counter = 0;
export function newTrackId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${(counter++).toString(36)}`;
}
