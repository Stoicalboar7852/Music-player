// What the app needs from a streaming service. Each service plays its own
// audio through the vendor's official player; this interface covers sign-in,
// finding music, and a Backend the shared Player can drive.

import type { Backend, Collection, SourceId, Track } from '../player/types';

export interface ServiceStatus {
  /** The credentials this service needs have been entered in Settings. */
  configured: boolean;
  /** Signed in / ready to play. */
  connected: boolean;
  /** Who is signed in, when known. */
  account?: string;
  /** A problem worth showing (expired token, wrong account type, ...). */
  problem?: string;
  /** Replaces "Connected" in the panel, for services without a sign-in. */
  label?: string;
}

export interface SearchResults {
  tracks: Track[];
  collections: Collection[];
}

export interface MusicService {
  readonly id: Exclude<SourceId, 'local'>;
  readonly name: string;
  readonly backend: Backend;
  /** Plain statement of what this integration can and cannot do. */
  readonly limits: string[];
  /** What the paste-a-link box accepts, e.g. "Spotify track, album or playlist link". */
  readonly linkHint: string;
  /** False for services that work without signing in (no Disconnect button). */
  readonly signIn?: boolean;

  status(): ServiceStatus;
  onStatus(listener: () => void): () => void;
  /** Sign in (or otherwise get ready). Must be called from a user gesture. */
  connect(): Promise<void>;
  disconnect(): void;

  /** Whether search() can be used right now. */
  canSearch(): boolean;
  /** Why search is unavailable, when it is. */
  searchUnavailable?(): string;
  search(query: string): Promise<SearchResults>;
  /** The signed-in user's playlists, where the service offers them. */
  library?(): Promise<Collection[]>;
  tracksOf(collection: Collection): Promise<Track[]>;
  /** Turns a pasted link into something playable, or null if it isn't one of ours. */
  resolveLink(url: string): Promise<SearchResults | null>;
}
