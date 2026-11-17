// The player: one queue and one transport, whatever is producing the sound.
// Each track names its source; the matching backend plays it.

import { Emitter } from '../app/emitter';
import type { RepeatMode } from '../app/settings';
import type { Backend, SourceId, Track } from './types';

export interface PlayerEvents extends Record<string, unknown> {
  /** Anything about the queue or transport changed. */
  change: void;
  /** The current track changed (or its metadata was filled in). */
  track: Track | null;
  /** Something went wrong that the user should hear about. */
  error: string;
}

export class Player extends Emitter<PlayerEvents> {
  queue: Track[] = [];
  playing = false;
  loading = false;
  shuffle = false;
  repeat: RepeatMode = 'off';
  volume = 0.8;
  muted = false;

  private currentId: string | null = null;
  private backends = new Map<SourceId, Backend>();
  private active: Backend | null = null;
  /** Play order when shuffling: a permutation of track ids. */
  private order: string[] = [];
  private loadToken = 0;
  private errorStreak = 0;

  register(backend: Backend) {
    this.backends.set(backend.source, backend);
    backend.events = {
      ended: () => {
        if (this.active === backend) this.onEnded();
      },
      state: (playing) => {
        if (this.active !== backend || this.loading) return;
        if (playing) this.errorStreak = 0;
        if (this.playing !== playing) {
          this.playing = playing;
          this.emit('change', undefined);
        }
      },
      error: (message) => {
        if (this.active === backend) this.onError(message);
      },
      meta: (patch) => {
        const track = this.current;
        if (this.active !== backend || !track) return;
        // Tags read from a file are better than what the decoder reports; only fill gaps.
        let changed = false;
        for (const [key, value] of Object.entries(patch) as [keyof Track, never][]) {
          if (value === undefined || value === null || track[key] === value) continue;
          if (key !== 'duration' && track[key] && track.source === 'local') continue;
          track[key] = value;
          changed = true;
        }
        if (changed) {
          this.emit('track', track);
          this.emit('change', undefined);
        }
      },
    };
    backend.setVolume(this.effectiveVolume);
  }

  // ------------------------------------------------------------------ state

  get current(): Track | null {
    return this.queue.find((t) => t.id === this.currentId) ?? null;
  }

  get currentIndex(): number {
    return this.queue.findIndex((t) => t.id === this.currentId);
  }

  get position(): number {
    return this.active?.position() ?? 0;
  }

  get duration(): number {
    const d = this.active?.duration() ?? 0;
    return d > 0 && Number.isFinite(d) ? d : (this.current?.duration ?? 0);
  }

  private get effectiveVolume(): number {
    return this.muted ? 0 : this.volume;
  }

  // ------------------------------------------------------------------ queue

  /** Appends tracks. With `play`, starts the first of them immediately. */
  add(tracks: Track[], opts: { play?: boolean } = {}) {
    if (tracks.length === 0) return;
    const wasEmpty = this.queue.length === 0;
    this.queue.push(...tracks);
    if (this.shuffle) {
      // New tracks join the unplayed part of the shuffle at random positions.
      const played = Math.max(0, this.order.indexOf(this.currentId ?? '')) + 1;
      for (const t of tracks) {
        const at = played + Math.floor(Math.random() * (this.order.length - played + 1));
        this.order.splice(at, 0, t.id);
      }
    }
    this.emit('change', undefined);
    if (opts.play || (wasEmpty && !this.currentId)) void this.playTrack(tracks[0].id);
  }

  remove(id: string) {
    const index = this.queue.findIndex((t) => t.id === id);
    if (index < 0) return;
    const wasCurrent = id === this.currentId;
    const [removed] = this.queue.splice(index, 1);
    this.order = this.order.filter((o) => o !== id);
    if (removed.artworkUrl?.startsWith('blob:') && !this.queue.some((t) => t.artworkUrl === removed.artworkUrl)) {
      URL.revokeObjectURL(removed.artworkUrl);
    }
    if (wasCurrent) {
      const next = this.queue[Math.min(index, this.queue.length - 1)];
      if (next && this.playing) void this.playTrack(next.id);
      else void this.stop(next?.id ?? null);
    }
    this.emit('change', undefined);
  }

  clear() {
    for (const t of this.queue) if (t.artworkUrl?.startsWith('blob:')) URL.revokeObjectURL(t.artworkUrl);
    this.queue = [];
    this.order = [];
    void this.stop(null);
  }

  move(from: number, to: number) {
    if (from === to || from < 0 || to < 0 || from >= this.queue.length || to >= this.queue.length) return;
    const [track] = this.queue.splice(from, 1);
    this.queue.splice(to, 0, track);
    this.emit('change', undefined);
  }

  /** Lets a source update a queued track once it knows more (e.g. tags finished parsing). */
  patch(id: string, patch: Partial<Track>) {
    const track = this.queue.find((t) => t.id === id);
    if (!track) return;
    Object.assign(track, patch);
    if (id === this.currentId) this.emit('track', track);
    this.emit('change', undefined);
  }

  // -------------------------------------------------------------- transport

  async playTrack(id: string) {
    const track = this.queue.find((t) => t.id === id);
    if (!track) return;
    const backend = this.backends.get(track.source);
    if (!backend) {
      this.emit('error', `No player is available for ${track.source} tracks.`);
      return;
    }
    const token = ++this.loadToken;
    if (this.active && this.active !== backend) await this.active.stop().catch(() => {});
    this.active = backend;
    this.currentId = id;
    this.loading = true;
    this.playing = true;
    backend.setVolume(this.effectiveVolume);
    this.emit('track', track);
    this.emit('change', undefined);
    try {
      await backend.load(track);
      if (token !== this.loadToken) return;
      this.loading = false;
      this.emit('change', undefined);
    } catch (error) {
      if (token !== this.loadToken) return;
      this.loading = false;
      if ((error as DOMException)?.name === 'NotAllowedError') {
        // The browser wants a click before it makes sound. The track is fine:
        // leave it loaded and paused rather than skipping it.
        this.playing = false;
        this.emit('change', undefined);
        this.emit('error', 'Your browser blocked the sound until you click. Press play to start.');
        return;
      }
      this.onError(error instanceof Error ? error.message : String(error));
    }
  }

  async toggle() {
    if (this.playing) await this.pause();
    else await this.play();
  }

  async play() {
    const track = this.current ?? this.queue[0];
    if (!track) return;
    if (!this.active || track.id !== this.currentId) {
      await this.playTrack(track.id);
      return;
    }
    this.playing = true;
    this.emit('change', undefined);
    try {
      await this.active.play();
    } catch (error) {
      this.playing = false;
      this.emit('change', undefined);
      this.emit('error', error instanceof Error ? error.message : String(error));
    }
  }

  async pause() {
    if (!this.active) return;
    this.playing = false;
    this.emit('change', undefined);
    await this.active.pause().catch(() => {});
  }

  private async stop(selectId: string | null) {
    this.loadToken++;
    this.playing = false;
    this.loading = false;
    await this.active?.stop().catch(() => {});
    this.active = null;
    this.currentId = selectId;
    this.emit('track', this.current);
    this.emit('change', undefined);
  }

  /** Ids in the order they will play. */
  private playOrder(): string[] {
    if (!this.shuffle) return this.queue.map((t) => t.id);
    // Keep the shuffle in step with the queue.
    const ids = new Set(this.queue.map((t) => t.id));
    this.order = this.order.filter((id) => ids.has(id));
    for (const id of ids) if (!this.order.includes(id)) this.order.push(id);
    return this.order;
  }

  private reshuffle(first: string | null) {
    const ids = this.queue.map((t) => t.id).filter((id) => id !== first);
    for (let i = ids.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [ids[i], ids[j]] = [ids[j], ids[i]];
    }
    this.order = first ? [first, ...ids] : ids;
  }

  private neighbour(direction: 1 | -1, wrap: boolean): Track | null {
    const order = this.playOrder();
    if (order.length === 0) return null;
    const at = order.indexOf(this.currentId ?? '');
    let next = at + direction;
    if (next >= order.length) {
      if (!wrap) return null;
      if (this.shuffle) this.reshuffle(null);
      next = 0;
    } else if (next < 0) {
      if (!wrap) return null;
      next = order.length - 1;
    }
    const id = (this.shuffle ? this.order : order)[next];
    return this.queue.find((t) => t.id === id) ?? null;
  }

  async next() {
    const track = this.neighbour(1, this.repeat === 'all');
    if (track) await this.playTrack(track.id);
  }

  async previous() {
    // Like every player since the CD: a few seconds in, "previous" restarts the track.
    if (this.position > 3) {
      await this.seek(0);
      return;
    }
    const track = this.neighbour(-1, this.repeat === 'all');
    if (track) await this.playTrack(track.id);
    else await this.seek(0);
  }

  async seek(seconds: number) {
    if (!this.active) return;
    const duration = this.duration;
    const clamped = Math.max(0, duration > 0 ? Math.min(seconds, duration - 0.25) : seconds);
    await this.active.seek(clamped).catch(() => {});
    this.emit('change', undefined);
  }

  async seekBy(delta: number) {
    await this.seek(this.position + delta);
  }

  private onEnded() {
    if (this.repeat === 'one' && this.current) {
      void this.playTrack(this.current.id);
      return;
    }
    const track = this.neighbour(1, this.repeat === 'all');
    if (track) {
      void this.playTrack(track.id);
    } else {
      // End of the queue: rest on the last track, ready to replay.
      this.playing = false;
      this.emit('change', undefined);
    }
  }

  private onError(message: string) {
    const title = this.current?.title ?? 'track';
    this.emit('error', `Couldn't play "${title}": ${message}`);
    this.errorStreak++;
    const track = this.errorStreak <= 3 ? this.neighbour(1, false) : null;
    if (track) {
      void this.playTrack(track.id);
    } else {
      this.playing = false;
      this.loading = false;
      this.emit('change', undefined);
    }
  }

  // --------------------------------------------------------------- options

  setVolume(volume: number) {
    this.volume = Math.max(0, Math.min(1, volume));
    if (this.volume > 0) this.muted = false;
    for (const b of this.backends.values()) b.setVolume(this.effectiveVolume);
    this.emit('change', undefined);
  }

  toggleMute() {
    this.muted = !this.muted;
    for (const b of this.backends.values()) b.setVolume(this.effectiveVolume);
    this.emit('change', undefined);
  }

  setShuffle(on: boolean) {
    this.shuffle = on;
    if (on) this.reshuffle(this.currentId);
    this.emit('change', undefined);
  }

  setRepeat(mode: RepeatMode) {
    this.repeat = mode;
    this.emit('change', undefined);
  }

  cycleRepeat() {
    this.setRepeat(this.repeat === 'off' ? 'all' : this.repeat === 'all' ? 'one' : 'off');
  }
}
