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
  /** Streaming tracks: the service's own identifier (Spotify URI, Apple song id, YouTube video id). */
  ref?: string;
}

/** An album or playlist on a streaming service. */
export interface Collection {
  id: string;
  source: SourceId;
  kind: 'album' | 'playlist';
  title: string;
  subtitle?: string;
  artworkUrl?: string;
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
}

let counter = 0;
export function newTrackId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${(counter++).toString(36)}`;
}
