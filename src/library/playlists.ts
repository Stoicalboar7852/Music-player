// Phosphor playlists. A playlist mixes three kinds of item:
//  - a song from any source (Spotify, Apple Music, YouTube or a local file)
//  - a linked service playlist or album, fetched fresh every time it plays,
//    so changes made on the service show up
//  - another Phosphor playlist (nesting, with loops refused)
// Everything is stored in this browser (IndexedDB). Local files are kept as
// File System Access handles, which Chrome can reopen after a restart.

import { Emitter } from '../app/emitter';
import { newTrackId, SOURCE_NAMES, type Collection, type SourceId, type Track } from '../player/types';
import type { MusicService } from '../services/types';
import { db } from './store';

export type PlayMode = 'order' | 'shuffle' | 'interleave';

/** A track as stored: everything but the in-memory parts (file, handle, queue id). */
export interface SavedTrack {
  source: SourceId;
  title: string;
  artist?: string;
  album?: string;
  duration?: number;
  artworkUrl?: string;
  ref?: string;
  /** Local files: the key of the stored handle, if the browser gave one. */
  handleKey?: string;
  fileName?: string;
  fileSize?: number;
}

export type PlaylistItem =
  | { kind: 'track'; uid: string; track: SavedTrack }
  | { kind: 'remote'; uid: string; collection: Collection }
  | { kind: 'playlist'; uid: string; playlistId: string };

export interface PhosphorPlaylist {
  id: string;
  name: string;
  items: PlaylistItem[];
  mode: PlayMode;
  createdAt: number;
  updatedAt: number;
}

interface StoredHandle {
  key: string;
  handle: FileSystemFileHandle;
  name: string;
  size: number;
}

/**
 * Where file handles are kept. In the app that's IndexedDB, as the File System
 * Access API intends. The test browser used by scripts/verify.cjs crashes when
 * a handle is read back from IndexedDB (real Chrome doesn't), so the tests
 * substitute their own store through window.__phosphorHandleStore.
 */
interface HandleStore {
  put(record: StoredHandle): Promise<unknown>;
  get(key: string): Promise<StoredHandle | undefined>;
}

const indexedDbHandles: HandleStore = {
  put: (record) => db.put<StoredHandle>('handles', record),
  get: (key) => db.get<StoredHandle>('handles', key),
};

function handles(): HandleStore {
  return (window as unknown as { __phosphorHandleStore?: HandleStore }).__phosphorHandleStore ?? indexedDbHandles;
}

type PermissionedHandle = FileSystemFileHandle & {
  queryPermission?(options: { mode: 'read' }): Promise<PermissionState>;
  requestPermission?(options: { mode: 'read' }): Promise<PermissionState>;
};

export interface Resolved {
  tracks: Track[];
  /** Plain explanations of anything that was skipped. */
  notes: string[];
}

const uid = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

/** Shrinks local cover art (a blob: URL that won't survive a reload) to a small stored data URL. */
async function thumbnail(url: string): Promise<string | undefined> {
  try {
    const image = new Image();
    image.src = url;
    await image.decode();
    const size = 160;
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = size;
    const ctx = canvas.getContext('2d');
    if (!ctx) return undefined;
    const side = Math.min(image.naturalWidth, image.naturalHeight);
    ctx.drawImage(image, (image.naturalWidth - side) / 2, (image.naturalHeight - side) / 2, side, side, 0, 0, size, size);
    return canvas.toDataURL('image/jpeg', 0.82);
  } catch {
    return undefined;
  }
}

function shuffle<T>(items: T[]): T[] {
  const out = items.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/** Alternates between sources (Spotify, local, YouTube, ...), keeping each source's own order. */
function interleave(tracks: Track[]): Track[] {
  const groups = new Map<SourceId, Track[]>();
  for (const t of tracks) {
    if (!groups.has(t.source)) groups.set(t.source, []);
    groups.get(t.source)!.push(t);
  }
  const queues = [...groups.values()];
  const out: Track[] = [];
  while (queues.some((q) => q.length)) for (const q of queues) if (q.length) out.push(q.shift()!);
  return out;
}

export class PlaylistLibrary extends Emitter<{ change: void }> {
  playlists: PhosphorPlaylist[] = [];
  readonly ready: Promise<void>;

  constructor() {
    super();
    this.ready = db
      .getAll<PhosphorPlaylist>('playlists')
      .then((all) => {
        this.playlists = all.sort((a, b) => a.createdAt - b.createdAt);
        this.emit('change', undefined);
      })
      .catch((error) => console.warn('Playlists could not be loaded', error));
  }

  get(id: string): PhosphorPlaylist | undefined {
    return this.playlists.find((p) => p.id === id);
  }

  private async save(playlist: PhosphorPlaylist) {
    playlist.updatedAt = Date.now();
    if (!this.playlists.includes(playlist)) this.playlists.push(playlist);
    await db.put('playlists', playlist);
    this.emit('change', undefined);
  }

  private require(id: string): PhosphorPlaylist {
    const playlist = this.get(id);
    if (!playlist) throw new Error('That playlist no longer exists.');
    return playlist;
  }

  // -------------------------------------------------------------- editing

  async create(name = 'New playlist'): Promise<PhosphorPlaylist> {
    await this.ready;
    const taken = new Set(this.playlists.map((p) => p.name));
    let unique = name;
    for (let n = 2; taken.has(unique); n++) unique = `${name} ${n}`;
    const playlist: PhosphorPlaylist = { id: `pl-${uid()}`, name: unique, items: [], mode: 'order', createdAt: Date.now(), updatedAt: Date.now() };
    await this.save(playlist);
    return playlist;
  }

  async rename(id: string, name: string) {
    const playlist = this.require(id);
    playlist.name = name.trim() || playlist.name;
    await this.save(playlist);
  }

  async setMode(id: string, mode: PlayMode) {
    const playlist = this.require(id);
    playlist.mode = mode;
    await this.save(playlist);
  }

  async remove(id: string) {
    this.playlists = this.playlists.filter((p) => p.id !== id);
    await db.delete('playlists', id);
    // Other playlists that contained this one lose that item.
    for (const p of this.playlists) {
      const before = p.items.length;
      p.items = p.items.filter((item) => !(item.kind === 'playlist' && item.playlistId === id));
      if (p.items.length !== before) await this.save(p);
    }
    this.emit('change', undefined);
  }

  async removeItem(id: string, itemUid: string) {
    const playlist = this.require(id);
    playlist.items = playlist.items.filter((item) => item.uid !== itemUid);
    await this.save(playlist);
  }

  async moveItem(id: string, from: number, to: number) {
    const playlist = this.require(id);
    if (from === to || from < 0 || to < 0 || from >= playlist.items.length || to >= playlist.items.length) return;
    const [item] = playlist.items.splice(from, 1);
    playlist.items.splice(to, 0, item);
    await this.save(playlist);
  }

  /** Stores tracks (any source). Local files keep their handle when the browser provided one. */
  async addTracks(id: string, tracks: Track[]): Promise<number> {
    const playlist = this.require(id);
    for (const track of tracks) playlist.items.push({ kind: 'track', uid: uid(), track: await this.toSaved(track) });
    await this.save(playlist);
    return tracks.length;
  }

  async addCollection(id: string, collection: Collection) {
    const playlist = this.require(id);
    playlist.items.push({ kind: 'remote', uid: uid(), collection: { ...collection } });
    await this.save(playlist);
  }

  /** Does playlist `outer` contain `inner`, directly or through nesting? */
  contains(outer: string, inner: string, seen = new Set<string>()): boolean {
    if (outer === inner) return true;
    if (seen.has(outer)) return false;
    seen.add(outer);
    const playlist = this.get(outer);
    return Boolean(playlist?.items.some((item) => item.kind === 'playlist' && this.contains(item.playlistId, inner, seen)));
  }

  /** Nests one Phosphor playlist in another, refusing anything that would loop. */
  async addPlaylist(id: string, otherId: string) {
    const playlist = this.require(id);
    if (this.contains(otherId, id)) {
      throw new Error(otherId === id ? "A playlist can't contain itself." : `"${this.get(otherId)?.name}" already contains "${playlist.name}", so adding it would loop.`);
    }
    playlist.items.push({ kind: 'playlist', uid: uid(), playlistId: otherId });
    await this.save(playlist);
  }

  private async toSaved(track: Track): Promise<SavedTrack> {
    const saved: SavedTrack = {
      source: track.source,
      title: track.title,
      artist: track.artist,
      album: track.album,
      duration: track.duration,
      artworkUrl: track.artworkUrl,
      ref: track.ref,
    };
    if (track.source === 'local') {
      saved.fileName = track.file?.name;
      saved.fileSize = track.file?.size;
      if (track.artworkUrl?.startsWith('blob:')) saved.artworkUrl = await thumbnail(track.artworkUrl);
      if (track.handle) {
        const key = `h-${uid()}`;
        await handles().put({ key, handle: track.handle, name: track.file?.name ?? track.title, size: track.file?.size ?? 0 });
        saved.handleKey = key;
      }
    }
    return saved;
  }

  /**
   * Gives stored local items without a handle (imported playlists, or files
   * opened in a way that provided none) the handle of a matching file just
   * added: same name and size. Returns how many were reconnected.
   */
  async relink(tracks: Track[]): Promise<number> {
    const withHandles = tracks.filter((t) => t.source === 'local' && t.handle && t.file);
    if (withHandles.length === 0) return 0;
    let count = 0;
    for (const playlist of this.playlists) {
      let changed = false;
      for (const item of playlist.items) {
        if (item.kind !== 'track' || item.track.source !== 'local' || item.track.handleKey) continue;
        const match = withHandles.find((t) => t.file!.name === item.track.fileName && t.file!.size === item.track.fileSize);
        if (!match) continue;
        const key = `h-${uid()}`;
        await handles().put({ key, handle: match.handle!, name: match.file!.name, size: match.file!.size });
        item.track.handleKey = key;
        changed = true;
        count++;
      }
      if (changed) await this.save(playlist);
    }
    return count;
  }

  // ------------------------------------------------------------ playing

  /**
   * Turns a playlist into queue tracks: local files reopened, linked service
   * playlists fetched now (so they're current), nested playlists expanded.
   * Must start inside a click when local files may need permission again.
   */
  async resolve(id: string, services: MusicService[]): Promise<Resolved> {
    const notes: string[] = [];
    const tracks = await this.expand(id, services, notes, new Set());
    const mode = this.get(id)?.mode ?? 'order';
    return { tracks: mode === 'shuffle' ? shuffle(tracks) : mode === 'interleave' ? interleave(tracks) : tracks, notes };
  }

  private async expand(id: string, services: MusicService[], notes: string[], path: Set<string>): Promise<Track[]> {
    const playlist = this.get(id);
    if (!playlist || path.has(id)) return [];
    path.add(id);
    const out: Track[] = [];
    // Local permissions first, while the click that started this still counts.
    const localTracks = new Map<string, Track | null>();
    for (const item of playlist.items) {
      if (item.kind === 'track' && item.track.source === 'local') localTracks.set(item.uid, await this.reopen(item.track, notes));
    }
    for (const item of playlist.items) {
      if (item.kind === 'track') {
        if (item.track.source === 'local') {
          const local = localTracks.get(item.uid);
          if (local) out.push(local);
        } else {
          out.push({ ...item.track, id: newTrackId(item.track.source) });
        }
      } else if (item.kind === 'remote') {
        const service = services.find((s) => s.id === item.collection.source);
        if (!service || !service.status().connected) {
          notes.push(`Connect ${SOURCE_NAMES[item.collection.source]} to include "${item.collection.title}".`);
          continue;
        }
        try {
          out.push(...(await service.tracksOf(item.collection)));
        } catch (error) {
          notes.push(`"${item.collection.title}" couldn't be loaded: ${(error as Error).message}`);
        }
      } else {
        out.push(...(await this.expand(item.playlistId, services, notes, path)));
      }
    }
    path.delete(id);
    return out;
  }

  private async reopen(saved: SavedTrack, notes: string[]): Promise<Track | null> {
    const name = saved.fileName ?? saved.title;
    if (!saved.handleKey) {
      notes.push(`"${name}" needs adding again: open or drop the file once and Phosphor reconnects it.`);
      return null;
    }
    try {
      const stored = await handles().get(saved.handleKey);
      if (!stored) throw new Error('missing');
      const handle = stored.handle as PermissionedHandle;
      let permission = (await handle.queryPermission?.({ mode: 'read' })) ?? 'granted';
      if (permission === 'prompt') permission = (await handle.requestPermission?.({ mode: 'read' })) ?? 'denied';
      if (permission !== 'granted') {
        notes.push(`Phosphor wasn't allowed to open "${name}" again.`);
        return null;
      }
      const file = await handle.getFile();
      return { ...saved, id: newTrackId('local'), file, handle };
    } catch {
      notes.push(`"${name}" can't be found any more (moved or deleted?). Open it again to reconnect it.`);
      return null;
    }
  }

  // ------------------------------------------------------ export, import

  exportJson(ids?: string[]): string {
    const chosen = ids ? this.playlists.filter((p) => ids.includes(p.id)) : this.playlists;
    // Handles can't leave the browser; local files go out as name and size, ready to relink.
    const playlists = chosen.map((p) => ({
      ...p,
      items: p.items.map((item) => (item.kind === 'track' ? { ...item, track: { ...item.track, handleKey: undefined } } : item)),
    }));
    return JSON.stringify({ format: 'phosphor-playlists', version: 1, exportedAt: new Date().toISOString(), playlists }, null, 2);
  }

  async importJson(text: string): Promise<number> {
    let data: { format?: string; playlists?: PhosphorPlaylist[] };
    try {
      data = JSON.parse(text);
    } catch {
      throw new Error("That file isn't valid JSON.");
    }
    if (data.format !== 'phosphor-playlists' || !Array.isArray(data.playlists)) throw new Error("That file isn't a Phosphor playlist export.");
    await this.ready;
    // Fresh ids, with nested references remapped to the imported copies.
    const idMap = new Map(data.playlists.map((p) => [p.id, `pl-${uid()}`]));
    const taken = new Set(this.playlists.map((p) => p.name));
    for (const source of data.playlists) {
      let name = source.name;
      for (let n = 2; taken.has(name); n++) name = `${source.name} (${n})`;
      taken.add(name);
      const items = (source.items ?? [])
        .map((item): PlaylistItem | null => {
          if (item.kind === 'playlist') return idMap.has(item.playlistId) ? { ...item, uid: uid(), playlistId: idMap.get(item.playlistId)! } : null;
          if (item.kind === 'track') return { kind: 'track', uid: uid(), track: { ...item.track, handleKey: undefined } };
          if (item.kind === 'remote') return { kind: 'remote', uid: uid(), collection: item.collection };
          return null;
        })
        .filter((item): item is PlaylistItem => item !== null);
      await this.save({ id: idMap.get(source.id)!, name, items, mode: source.mode ?? 'order', createdAt: Date.now(), updatedAt: Date.now() });
    }
    return data.playlists.length;
  }

  /** A short description of a playlist's contents, e.g. "12 songs · 2 linked playlists". */
  summary(id: string): string {
    const playlist = this.get(id);
    if (!playlist) return '';
    const songs = playlist.items.filter((i) => i.kind === 'track').length;
    const linked = playlist.items.filter((i) => i.kind === 'remote').length;
    const nested = playlist.items.filter((i) => i.kind === 'playlist').length;
    const parts = [
      songs ? `${songs} song${songs === 1 ? '' : 's'}` : '',
      linked ? `${linked} linked playlist${linked === 1 ? '' : 's'}` : '',
      nested ? `${nested} playlist${nested === 1 ? '' : 's'} inside` : '',
    ].filter(Boolean);
    return parts.join(' · ') || 'Empty';
  }
}
