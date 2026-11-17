// Local files: playback through the engine's <audio> element, plus everything
// involved in getting files into the app (pickers, drag and drop, folders)
// and reading their tags and cover art.

import type { AudioEngine } from '../audio/engine';
import { newTrackId, type Backend, type BackendEvents, type Track } from './types';

/** Extensions Chrome/Edge can usually decode. The browser has the final say. */
const AUDIO_EXTENSION = /\.(mp3|m4a|m4b|aac|flac|wav|wave|ogg|oga|opus|weba|webm|mp4|caf)$/i;
const COVER_FILE = /^(cover|folder|front|album|albumart|artwork)\.(jpe?g|png|webp|gif)$/i;

export function isAudioFile(file: File): boolean {
  return file.type.startsWith('audio/') || AUDIO_EXTENSION.test(file.name);
}

export class LocalBackend implements Backend {
  readonly source = 'local' as const;
  events: Partial<BackendEvents> = {};
  private url: string | null = null;

  constructor(private engine: AudioEngine) {
    const el = engine.element;
    el.addEventListener('ended', () => this.events.ended?.());
    el.addEventListener('playing', () => this.events.state?.(true));
    el.addEventListener('pause', () => {
      // "pause" also fires at the end of a track and while a new one loads.
      if (!el.ended && el.readyState > 0) this.events.state?.(false);
    });
    el.addEventListener('durationchange', () => {
      if (Number.isFinite(el.duration) && el.duration > 0) this.events.meta?.({ duration: el.duration });
    });
    el.addEventListener('error', () => {
      if (!el.src || el.src === location.href) return;
      const code = el.error?.code;
      this.events.error?.(
        code === MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED || code === MediaError.MEDIA_ERR_DECODE
          ? "this browser can't decode the file's format"
          : (el.error?.message || 'the file could not be read'),
      );
    });
  }

  async load(track: Track) {
    if (!track.file) throw new Error('the file is no longer available');
    const el = this.engine.element;
    const previous = this.url;
    this.url = URL.createObjectURL(track.file);
    el.src = this.url;
    if (previous) URL.revokeObjectURL(previous);
    await this.engine.resume();
    await el.play();
  }

  async play() {
    await this.engine.resume();
    await this.engine.element.play();
  }

  async pause() {
    this.engine.element.pause();
  }

  async seek(seconds: number) {
    this.engine.element.currentTime = seconds;
  }

  setVolume(volume: number) {
    this.engine.setVolume(volume);
  }

  position() {
    return this.engine.element.currentTime || 0;
  }

  duration() {
    return this.engine.element.duration || 0;
  }

  async stop() {
    const el = this.engine.element;
    el.pause();
    el.removeAttribute('src');
    el.load();
    if (this.url) URL.revokeObjectURL(this.url);
    this.url = null;
  }
}

// ----------------------------------------------------------------- intake

export interface IncomingFile {
  file: File;
  /** Path within whatever was picked or dropped, used for ordering and cover lookup. */
  path: string;
}

function titleFromName(name: string): string {
  return name
    .replace(/\.[^.]+$/, '')
    .replace(/^\d{1,3}[\s._-]+/, '')
    .replace(/_/g, ' ')
    .trim();
}

const naturalOrder = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

/**
 * Turns picked/dropped files into queue tracks, in natural path order. Image
 * files named like cover art are used for tracks in the same folder that have
 * no embedded artwork.
 */
export function tracksFromFiles(incoming: IncomingFile[]): { tracks: Track[]; folderCovers: Map<string, File> } {
  const folderCovers = new Map<string, File>();
  const dirOf = (path: string) => path.slice(0, Math.max(0, path.lastIndexOf('/')));
  for (const { file, path } of incoming) {
    if (COVER_FILE.test(file.name) && !folderCovers.has(dirOf(path))) folderCovers.set(dirOf(path), file);
  }
  const tracks = incoming
    .filter(({ file }) => isAudioFile(file))
    .sort((a, b) => naturalOrder.compare(a.path, b.path))
    .map(({ file, path }): Track & { dir: string } => ({
      id: newTrackId('local'),
      source: 'local',
      title: titleFromName(file.name),
      file,
      dir: dirOf(path),
    }));
  return { tracks, folderCovers };
}

interface FsEntry {
  isFile: boolean;
  isDirectory: boolean;
  name: string;
  fullPath: string;
  file(ok: (file: File) => void, fail: (error: unknown) => void): void;
  createReader(): { readEntries(ok: (entries: FsEntry[]) => void, fail: (error: unknown) => void): void };
}

async function walkEntry(entry: FsEntry, out: IncomingFile[]) {
  if (entry.isFile) {
    const file = await new Promise<File | null>((resolve) => entry.file(resolve, () => resolve(null)));
    if (file) out.push({ file, path: entry.fullPath.replace(/^\//, '') });
    return;
  }
  if (!entry.isDirectory) return;
  const reader = entry.createReader();
  // readEntries returns results in batches; keep asking until it comes back empty.
  for (;;) {
    const batch = await new Promise<FsEntry[]>((resolve) => reader.readEntries(resolve, () => resolve([])));
    if (batch.length === 0) break;
    for (const child of batch) await walkEntry(child, out);
  }
}

/** Collects every file in a drop, descending into dropped folders. */
export async function filesFromDrop(data: DataTransfer): Promise<IncomingFile[]> {
  const out: IncomingFile[] = [];
  const entries: FsEntry[] = [];
  const loose: File[] = [];
  // Entries must be grabbed synchronously, before the first await.
  for (const item of Array.from(data.items)) {
    if (item.kind !== 'file') continue;
    const entry = item.webkitGetAsEntry?.() as unknown as FsEntry | null | undefined;
    if (entry) entries.push(entry);
    else {
      const file = item.getAsFile();
      if (file) loose.push(file);
    }
  }
  for (const entry of entries) await walkEntry(entry, out);
  for (const file of loose) out.push({ file, path: file.name });
  return out;
}

export function filesFromInput(input: HTMLInputElement): IncomingFile[] {
  return Array.from(input.files ?? []).map((file) => ({ file, path: file.webkitRelativePath || file.name }));
}

interface DirectoryHandle {
  name: string;
  values(): AsyncIterable<DirectoryHandle & { kind: 'file' | 'directory'; getFile(): Promise<File> }>;
}

/**
 * Opens the folder picker. Uses the File System Access API where available
 * and returns null when it isn't, so the caller can fall back to an
 * <input webkitdirectory>.
 */
export async function pickFolder(): Promise<IncomingFile[] | null> {
  const picker = (window as unknown as { showDirectoryPicker?: (opts?: object) => Promise<DirectoryHandle> })
    .showDirectoryPicker;
  if (!picker) return null;
  let root: DirectoryHandle;
  try {
    root = await picker({ id: 'phosphor-music', mode: 'read' });
  } catch {
    return []; // dismissed
  }
  const out: IncomingFile[] = [];
  const walk = async (dir: DirectoryHandle, prefix: string) => {
    for await (const handle of dir.values()) {
      const path = `${prefix}${handle.name}`;
      if (handle.kind === 'file') out.push({ file: await handle.getFile(), path });
      else await walk(handle, `${path}/`);
    }
  };
  await walk(root, `${root.name}/`);
  return out;
}

// -------------------------------------------------------------------- tags

/** Reads title/artist/album/duration and embedded cover art from a file. */
export async function readTags(file: File): Promise<Partial<Track>> {
  const { parseBlob, selectCover } = await import('music-metadata');
  const meta = await parseBlob(file, { duration: false, skipCovers: false });
  const patch: Partial<Track> = {};
  const { title, artist, album, picture } = meta.common;
  if (title) patch.title = title;
  if (artist) patch.artist = artist;
  if (album) patch.album = album;
  if (meta.format.duration) patch.duration = meta.format.duration;
  const cover = selectCover(picture);
  if (cover) {
    const bytes = new Uint8Array(cover.data);
    patch.artworkUrl = URL.createObjectURL(new Blob([bytes], { type: cover.format || 'image/jpeg' }));
  }
  return patch;
}

/**
 * Fills in tags for freshly added tracks in the background, a couple at a
 * time so a big folder doesn't stall the page.
 */
export function loadTagsInBackground(
  tracks: Track[],
  folderCovers: Map<string, File>,
  apply: (id: string, patch: Partial<Track>) => void,
) {
  const pending = [...tracks];
  const coverUrls = new Map<string, string>();
  const worker = async () => {
    for (let track = pending.shift(); track; track = pending.shift()) {
      if (!track.file) continue;
      let patch: Partial<Track> = {};
      try {
        patch = await readTags(track.file);
      } catch (error) {
        console.warn(`Could not read tags from ${track.file.name}`, error);
      }
      if (!patch.artworkUrl) {
        const dir = (track as Track & { dir?: string }).dir ?? '';
        const cover = folderCovers.get(dir);
        if (cover) {
          if (!coverUrls.has(dir)) coverUrls.set(dir, URL.createObjectURL(cover));
          patch.artworkUrl = coverUrls.get(dir);
        }
      }
      if (Object.keys(patch).length > 0) apply(track.id, patch);
    }
  };
  void Promise.all([worker(), worker()]);
}
