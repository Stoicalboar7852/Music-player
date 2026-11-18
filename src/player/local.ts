// Local files: playback through the engine's <audio> element, plus everything
// involved in getting files into the app (pickers, drag and drop, folders)
// and reading their tags and cover art.

import type { AudioEngine } from '../audio/engine';
import type { TransitionPlan } from './transitions';
import { newTrackId, type Backend, type BackendEvents, type Track } from './types';

/** Extensions Chrome/Edge can usually decode. The browser has the final say. */
const AUDIO_EXTENSION = /\.(mp3|m4a|m4b|aac|flac|wav|wave|ogg|oga|opus|weba|webm|mp4|caf)$/i;
const COVER_FILE = /^(cover|folder|front|album|albumart|artwork)\.(jpe?g|png|webp|gif)$/i;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export function isAudioFile(file: File): boolean {
  return file.type.startsWith('audio/') || AUDIO_EXTENSION.test(file.name);
}

/** A hand-over in progress; finish() completes it at once (pause, skip, seek). */
export interface RunningTransition {
  finish(): void;
  readonly done: Promise<void>;
}

export class LocalBackend implements Backend {
  readonly source = 'local' as const;
  events: Partial<BackendEvents> = {};
  /** Object URL loaded on each deck (index matches engine.decks). */
  private urls: (string | null)[] = [null, null];
  private running: { finish(): void } | null = null;
  /** A hand-over being prepared (the next song hasn't started yet). */
  private pending: { cancel(): void } | null = null;

  constructor(private engine: AudioEngine) {
    engine.decks.forEach((deck, index) => {
      const el = deck.element;
      // Only the current deck speaks for the player; the other one may be
      // finishing the previous song, or warming up the next. The engine also
      // briefly plays silence on the elements to unlock audio; ignore that too.
      const real = () => this.urls[index] !== null && el.src === this.urls[index] && engine.deck === deck;
      el.addEventListener('ended', () => real() && this.events.ended?.());
      el.addEventListener('playing', () => real() && this.events.state?.(true));
      el.addEventListener('pause', () => {
        // "pause" also fires at the end of a track and while a new one loads.
        if (real() && !el.ended && el.readyState > 0 && !this.running) this.events.state?.(false);
      });
      el.addEventListener('durationchange', () => {
        if (real() && Number.isFinite(el.duration) && el.duration > 0) this.events.meta?.({ duration: el.duration });
      });
      el.addEventListener('error', () => {
        if (!real()) return;
        const code = el.error?.code;
        this.events.error?.(
          code === MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED || code === MediaError.MEDIA_ERR_DECODE
            ? "this browser can't decode the file's format"
            : (el.error?.message || 'the file could not be read'),
        );
      });
    });
  }

  private cancelPending() {
    this.pending?.cancel();
    this.pending = null;
  }

  private get index(): number {
    return this.engine.decks.indexOf(this.engine.deck);
  }

  private setUrl(index: number, file: File): string {
    const previous = this.urls[index];
    const url = URL.createObjectURL(file);
    this.urls[index] = url;
    if (previous) URL.revokeObjectURL(previous);
    return url;
  }

  private clearDeck(index: number) {
    const deck = this.engine.decks[index];
    deck.element.pause();
    deck.element.removeAttribute('src');
    deck.element.load();
    deck.reset();
    const url = this.urls[index];
    if (url) URL.revokeObjectURL(url);
    this.urls[index] = null;
  }

  async load(track: Track) {
    if (!track.file) throw new Error('the file is no longer available');
    this.cancelPending();
    this.running?.finish();
    // Anything still sounding on the other deck stops: this is a plain change of song.
    this.clearDeck(1 - this.index);
    const deck = this.engine.deck;
    deck.reset();
    deck.element.src = this.setUrl(this.index, track.file);
    await this.engine.resume();
    await deck.element.play();
  }

  /**
   * Hands over to `next` on the other deck following `plan`: a crossfade, or a
   * beat-matched mix. Resolves once the next song has started (it is then the
   * current one); the outgoing song fades out in the background. Until then
   * any transport action (pause, seek, another song) calls it off, and the
   * promise rejects.
   */
  async transition(next: Track, plan: TransitionPlan): Promise<RunningTransition> {
    if (!next.file) throw new Error('the file is no longer available');
    this.cancelPending();
    this.running?.finish();
    const ctx = this.engine.context;
    const outDeck = this.engine.deck;
    const inDeck = this.engine.otherDeck;
    const outIndex = this.index;
    const inIndex = 1 - outIndex;
    const out = outDeck.element;
    const incoming = inDeck.element;

    let cancelled = false;
    const pending = {
      cancel: () => {
        if (cancelled) return;
        cancelled = true;
        if (this.pending === pending) this.pending = null;
        // The outgoing song carries on as if nothing had been planned.
        const t = ctx.currentTime;
        outDeck.high.frequency.cancelScheduledValues(t);
        outDeck.high.frequency.setValueAtTime(10, t);
        this.clearDeck(inIndex);
      },
    };
    this.pending = pending;
    const stillOn = () => {
      if (cancelled) throw new Error('called off');
    };

    const entry = plan.outStart + plan.enterAt;
    const end = plan.outStart + plan.length;
    /** Context time at which the outgoing song reaches `pos` (now, if it already has). */
    const when = (pos: number) => ctx.currentTime + Math.max(0, (pos - out.currentTime) / Math.max(0.01, out.playbackRate));
    /** Where the incoming song should be when the outgoing one is at `outPos`. */
    const inAt = (outPos: number) => plan.inStart + (outPos - entry) * plan.rate;

    try {
      inDeck.reset();
      incoming.src = this.setUrl(inIndex, next.file);
      incoming.playbackRate = plan.rate;
      inDeck.gain.gain.setValueAtTime(0, ctx.currentTime);
      if (plan.style === 'blend') inDeck.low.gain.setValueAtTime(-30, ctx.currentTime);
      while (incoming.readyState < 1) {
        stillOn();
        if (incoming.error) throw new Error("the next file couldn't be read");
        await sleep(30);
      }
      stillOn();

      if (plan.style === 'rise') {
        // The build: from the start of the phrase, the outgoing song is
        // filtered upward until the next one drops in.
        const f = outDeck.high.frequency;
        const t0 = Math.max(ctx.currentTime + 0.02, when(plan.outStart));
        f.cancelScheduledValues(ctx.currentTime);
        f.setValueAtTime(10, t0);
        f.exponentialRampToValueAtTime(2400, Math.max(t0 + 0.1, when(entry)));
      }

      // A mix starts the incoming song a moment early, silent, so it is
      // running in time when its part begins. A plain crossfade starts it from
      // the top as the fade begins.
      const preroll = plan.aligned ? 0.35 : 0;
      while (out.currentTime < entry - preroll && !out.ended) {
        stillOn();
        await sleep(Math.min(40, Math.max(4, (entry - preroll - out.currentTime) * 500)));
      }
      stillOn();
      incoming.currentTime = Math.max(0, inAt(out.currentTime));
      await incoming.play();
      stillOn();
      if (plan.aligned) {
        // Now that it is running (and still silent), line it up exactly.
        const error = incoming.currentTime - inAt(out.currentTime);
        if (Math.abs(error) > 0.015) incoming.currentTime = Math.max(0, incoming.currentTime - error);
      }
    } catch (error) {
      pending.cancel();
      throw error;
    }

    // From here the incoming song is the current one; the outgoing deck finishes the hand-over.
    this.pending = null;
    this.engine.swapDecks();
    const now = ctx.currentTime;
    const tStart = Math.max(now + 0.02, when(plan.outStart));
    const tEnter = Math.max(now + 0.02, when(entry));
    const tEnd = Math.max(tStart + 0.1, when(end));
    const curve = (n: number, f: (x: number) => number) => Float32Array.from({ length: n }, (_, i) => f(i / (n - 1)));
    const equalIn = curve(64, (x) => Math.sin((x * Math.PI) / 2));
    const equalOut = curve(64, (x) => Math.cos((x * Math.PI) / 2));
    const inGain = inDeck.gain.gain;
    const outGain = outDeck.gain.gain;
    inGain.cancelScheduledValues(now);
    outGain.cancelScheduledValues(now);
    inGain.setValueAtTime(0, now);
    outGain.setValueAtTime(1, now);
    // (A curve may not share its time span with any other change on the same parameter.)
    let over = tEnd;
    if (plan.style === 'rise') {
      // The build cuts off and the next song drops in on the new phrase.
      outGain.setValueAtTime(1, Math.max(now + 0.01, tEnter - 0.2));
      outGain.linearRampToValueAtTime(0, tEnter + 0.04);
      inGain.setValueAtTime(0, Math.max(now + 0.01, tEnter - 0.02));
      inGain.linearRampToValueAtTime(1, tEnter + 0.02);
      over = Math.max(tEnd, tEnter + 0.05);
    } else if (plan.style === 'blend') {
      const tSwap = Math.max(tStart + 0.2, when(plan.outStart + plan.swapAt));
      // In without its bass, up to nearly full volume a little past halfway to the swap...
      const rise = Math.max(0.1, (tSwap - tStart) * 0.6);
      inGain.setValueCurveAtTime(curve(32, (x) => Math.sin((x * Math.PI) / 2) * 0.95), tStart, rise);
      // ...the basslines swap on the downbeat...
      const inLow = inDeck.low.gain;
      const outLow = outDeck.low.gain;
      inLow.cancelScheduledValues(now);
      outLow.cancelScheduledValues(now);
      inLow.setValueAtTime(-30, now);
      outLow.setValueAtTime(0, now);
      inLow.setValueAtTime(-30, tSwap - 0.12);
      inLow.linearRampToValueAtTime(0, tSwap + 0.12);
      outLow.setValueAtTime(0, tSwap - 0.12);
      outLow.linearRampToValueAtTime(-30, tSwap + 0.12);
      // ...then the outgoing song fades away.
      const fadeFrom = tSwap + 0.13;
      const fadeFor = Math.max(0.1, tEnd - fadeFrom);
      outGain.setValueCurveAtTime(equalOut, fadeFrom, fadeFor);
      const full = Math.max(tStart + rise + 0.01, fadeFrom + fadeFor - 0.5);
      inGain.setValueAtTime(0.95, full);
      inGain.linearRampToValueAtTime(1, full + 0.5);
      over = Math.max(fadeFrom + fadeFor, full + 0.5);
    } else {
      // Equal power: the loudness holds steady while one song gives way to the other.
      inGain.setValueCurveAtTime(equalIn, tStart, tEnd - tStart);
      outGain.setValueCurveAtTime(equalOut, tStart, tEnd - tStart);
    }

    // Keep the beats locked while they overlap: nudge the incoming tempo by a
    // hair when it drifts, the way a DJ rides the pitch fader.
    let finished = false;
    let resolveDone: () => void = () => {};
    const done = new Promise<void>((r) => (resolveDone = r));
    const lock = window.setInterval(() => {
      if (!plan.aligned || out.paused || incoming.paused) return;
      const error = incoming.currentTime - inAt(out.currentTime); // seconds ahead (+) or behind (-)
      if (Math.abs(error) > 0.25) {
        incoming.currentTime -= error;
        return;
      }
      const target = plan.rate * (1 - Math.max(-0.02, Math.min(0.02, error * 0.8)));
      if (Math.abs(incoming.playbackRate - target) > 0.0005) incoming.playbackRate = target;
    }, 100);
    const finish = () => {
      if (finished) return;
      finished = true;
      window.clearInterval(lock);
      window.clearTimeout(timer);
      if (this.running === handle) this.running = null;
      this.clearDeck(outIndex);
      const t = ctx.currentTime;
      inGain.cancelScheduledValues(t);
      inDeck.low.gain.cancelScheduledValues(t);
      inGain.setValueAtTime(1, t);
      inDeck.low.gain.setValueAtTime(0, t);
      // Back to the incoming song's own tempo, gently, over a few seconds.
      const from = incoming.playbackRate;
      if (Math.abs(from - 1) > 0.001) {
        let step = 0;
        const glide = window.setInterval(() => {
          step++;
          // A new song on this deck (or a new mix) takes over the tempo.
          if (this.engine.deck !== inDeck || this.running) return window.clearInterval(glide);
          incoming.playbackRate = from + (1 - from) * Math.min(1, step / 40);
          if (step >= 40) window.clearInterval(glide);
        }, 100);
      }
      resolveDone();
    };
    const timer = window.setTimeout(finish, (over - now + 0.15) * 1000);
    const handle = { finish, done };
    this.running = handle;
    return handle;
  }

  async play() {
    this.cancelPending();
    this.running?.finish();
    await this.engine.resume();
    await this.engine.element.play();
  }

  async pause() {
    this.cancelPending();
    this.running?.finish();
    this.engine.element.pause();
  }

  async seek(seconds: number) {
    this.cancelPending();
    this.running?.finish();
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
    this.cancelPending();
    this.running?.finish();
    this.clearDeck(0);
    this.clearDeck(1);
  }
}

// ----------------------------------------------------------------- intake

export interface IncomingFile {
  file: File;
  /** Path within whatever was picked or dropped, used for ordering and cover lookup. */
  path: string;
  /** Present when the browser gave a reopenable handle (Chrome's file and folder pickers, drag and drop). */
  handle?: FileSystemFileHandle;
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
    .map(({ file, path, handle }): Track & { dir: string } => ({
      id: newTrackId('local'),
      source: 'local',
      title: titleFromName(file.name),
      file,
      handle,
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

type DirectoryEntryHandle = FileSystemDirectoryHandle & { values(): AsyncIterable<FileSystemHandle> };

/** Walks a directory handle, collecting files with their handles. */
async function walkHandle(dir: DirectoryEntryHandle, prefix: string, out: IncomingFile[]) {
  for await (const handle of dir.values()) {
    const path = `${prefix}${handle.name}`;
    if (handle.kind === 'file') {
      const fileHandle = handle as FileSystemFileHandle;
      out.push({ file: await fileHandle.getFile(), path, handle: fileHandle });
    } else {
      await walkHandle(handle as DirectoryEntryHandle, `${path}/`, out);
    }
  }
}

/** Collects every file in a drop, descending into dropped folders. */
export async function filesFromDrop(data: DataTransfer): Promise<IncomingFile[]> {
  const out: IncomingFile[] = [];
  const items = Array.from(data.items).filter((item) => item.kind === 'file');
  type HandleItem = DataTransferItem & { getAsFileSystemHandle?: () => Promise<FileSystemHandle | null> };
  // Everything must be requested synchronously, before the first await.
  if (items.length > 0 && typeof (items[0] as HandleItem).getAsFileSystemHandle === 'function') {
    const pending = items.map((item) => ({ handle: (item as HandleItem).getAsFileSystemHandle!(), file: item.getAsFile() }));
    for (const { handle, file } of pending) {
      const h = await handle.catch(() => null);
      if (h?.kind === 'file') out.push({ file: await (h as FileSystemFileHandle).getFile(), path: h.name, handle: h as FileSystemFileHandle });
      else if (h?.kind === 'directory') await walkHandle(h as DirectoryEntryHandle, `${h.name}/`, out);
      else if (file) out.push({ file, path: file.name });
    }
    return out;
  }
  const entries: FsEntry[] = [];
  const loose: File[] = [];
  for (const item of items) {
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

const AUDIO_ACCEPT = ['.mp3', '.flac', '.wav', '.m4a', '.aac', '.ogg', '.oga', '.opus', '.weba', '.webm', '.mp4'];

/**
 * Opens the file picker. Uses the File System Access API where available, so
 * playlists can reopen the files later; returns null when it isn't, so the
 * caller can fall back to an <input type=file>.
 */
export async function pickFiles(): Promise<IncomingFile[] | null> {
  const picker = (window as unknown as { showOpenFilePicker?: (opts?: object) => Promise<FileSystemFileHandle[]> }).showOpenFilePicker;
  if (!picker) return null;
  let handles: FileSystemFileHandle[];
  try {
    handles = await picker({ id: 'phosphor-music', multiple: true, types: [{ description: 'Audio files', accept: { 'audio/*': AUDIO_ACCEPT } }] });
  } catch {
    return []; // dismissed
  }
  return Promise.all(handles.map(async (handle) => ({ file: await handle.getFile(), path: handle.name, handle })));
}

export function filesFromInput(input: HTMLInputElement): IncomingFile[] {
  return Array.from(input.files ?? []).map((file) => ({ file, path: file.webkitRelativePath || file.name }));
}

/**
 * Opens the folder picker. Uses the File System Access API where available and
 * returns null when it isn't, so the caller can fall back to an
 * <input webkitdirectory>.
 */
export async function pickFolder(): Promise<IncomingFile[] | null> {
  const picker = (window as unknown as { showDirectoryPicker?: (opts?: object) => Promise<DirectoryEntryHandle> }).showDirectoryPicker;
  if (!picker) return null;
  let root: DirectoryEntryHandle;
  try {
    root = await picker({ id: 'phosphor-music', mode: 'read' });
  } catch {
    return []; // dismissed
  }
  const out: IncomingFile[] = [];
  await walkHandle(root, `${root.name}/`, out);
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
