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

/** A row of things on a service's home view: songs, or albums and playlists. */
export interface Shelf {
  title: string;
  tracks?: Track[];
  collections?: Collection[];
  /** A line shown under the title: why the shelf is empty, or what its items are. */
  note?: string;
  /** Offer to reconnect: the shelf needs a permission the current sign-in doesn't have. */
  needsReconnect?: boolean;
}

export interface OptionalAccount {
  /** e.g. "Sign in with Google". */
  readonly signInLabel: string;
  /** What signing in adds, for the panel. */
  readonly benefit: string;
  status(): { available: boolean; signedIn: boolean; name?: string; problem?: string; setupHint?: string };
  signIn(): Promise<void>;
  signOut(): void;
}

export interface MusicService {
  readonly id: Exclude<SourceId, 'local'>;
  readonly name: string;
  readonly backend: Backend;
  /** Plain statement of what this integration can and cannot do. */
  readonly limits: string[];
  /** The music plays in another program (e.g. the Spotify app), so sharing this tab can't hear it. */
  readonly playsOutsidePage?: boolean;
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
  /** The service's home view: what the API offers for this account. */
  home?(): Promise<Shelf[]>;
  /** Saves a song, album or playlist to the user's library on the service. */
  saveToLibrary?(item: Track | Collection): Promise<void>;
  /** Whether saveToLibrary makes sense for this item (not for things already in the library). */
  canSave?(item: Track | Collection): boolean;
  /** Whether a song, album or playlist is already in the user's library on the service. */
  isSaved?(item: Track | Collection): Promise<boolean>;
  /** Signs in again, asking for any permissions added since. */
  reconnect?(): Promise<void>;
  /** An optional sign-in that adds to what the service can do (YouTube: Google, for your own playlists). */
  readonly account?: OptionalAccount;
  /** Turns a pasted link into something playable, or null if it isn't one of ours. */
  resolveLink(url: string): Promise<SearchResults | null>;
  /** The song's page on the service, for a QR code people can scan; null when there is none. */
  link(track: Track): string | null;
}
