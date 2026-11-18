// The player: one queue and one transport, whatever is producing the sound.
// Each track names its source; the matching backend plays it.

import { debug } from '../app/debug';
import { Emitter } from '../app/emitter';
import type { RepeatMode } from '../app/settings';
import type { TransitionPlan } from './transitions';
import type { Backend, SourceId, Track } from './types';

/** Works out how to go from one song to the next; null for a plain cut. */
export type TransitionPlanner = (current: Track, next: Track, duration: number) => TransitionPlan | null;

/** What a local backend offers on top of the basics: overlapping songs on its two decks. */
interface MixingBackend extends Backend {
  transition(next: Track, plan: TransitionPlan): Promise<{ finish(): void; done: Promise<void> }>;
}

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

  /** The track whose end has already been handled, so one ending advances once. */
  private endedHandledFor: string | null = null;
  /** When playback reached the last moments of the current track (see watchEnd). */
  private nearEndSince: number | null = null;
  /** The user paused (as opposed to the track stopping by itself). */
  private userPaused = false;

  constructor() {
    super();
    window.setInterval(() => this.watchEnd(), 500);
    window.setInterval(() => this.watchTransition(), 100);
  }

  // ------------------------------------------------------------ transitions

  private planner: TransitionPlanner | null = null;
  /** A hand-over in progress (crossfade or mix); finished early by any transport action. */
  private handover: { finish(): void } | null = null;
  /** The next song is starting while this one fades: don't start another. */
  private handing = false;
  /** Fading this streaming song out before the next on the same service (they can't overlap). */
  private fadingOut = false;
  /** Fade the song that starts next in from silence. */
  private fadeInNext = 0;
  /** Bumped to call off a fade-out in progress. */
  private fadeSerial = 0;

  setTransitionPlanner(planner: TransitionPlanner | null) {
    this.planner = planner;
  }

  private finishHandover() {
    this.handover?.finish();
    this.handover = null;
  }

  /** A fade-out before the next song on the same service is called off: back to full volume. */
  private cancelFadeOut() {
    if (!this.fadingOut) return;
    this.fadingOut = false;
    this.fadeInNext = 0;
    this.fadeSerial++;
    this.active?.setVolume(this.effectiveVolume);
  }

  /** Ten times a second: is it time to start moving to the next song? */
  private watchTransition() {
    const current = this.current;
    const backend = this.active;
    if (!this.planner || !current || !backend || !this.playing || this.loading || this.handing || this.repeat === 'one') return;
    // A whole album or playlist the service plays itself moves on by itself.
    if (current.context) return;
    const next = this.neighbour(1, this.repeat === 'all', false);
    if (!next || next.id === current.id) return;
    const duration = this.duration;
    const position = this.position;
    if (!(duration > 0)) return;
    const plan = this.planner(current, next, duration);
    if (!plan) return;
    const nextBackend = this.backends.get(next.source);
    if (!nextBackend) return;

    if (backend === nextBackend && backend.source === 'local' && 'transition' in backend) {
      // Two local songs: overlap them on the two decks. The backend takes it
      // from a little before the overlap (a rise's build starts there too).
      if (position < plan.outStart - 1.6) return;
      void this.mixLocal(backend as MixingBackend, next, plan);
    } else if (backend === nextBackend) {
      // Two songs on the same streaming service can't play at once: fade out, then in.
      const fade = Math.min(plan.length, 4);
      if (position < duration - fade || this.fadingOut) return;
      this.fadingOut = true;
      this.fadeInNext = fade;
      const serial = ++this.fadeSerial;
      void this.ramp([backend], fade, (x) => [1 - x], () => serial === this.fadeSerial && this.fadingOut);
    } else {
      // Different players: overlap them, one fading down while the other fades up.
      if (position < duration - plan.length) return;
      void this.crossBackends(backend, nextBackend, next, plan.length);
    }
  }

  private async mixLocal(backend: MixingBackend, next: Track, plan: TransitionPlan) {
    this.handing = true;
    debug('player', `mixing into "${next.title}": ${plan.why}`);
    const from = this.currentId;
    try {
      const running = await backend.transition(next, plan);
      if (this.currentId !== from) {
        running.finish();
        return;
      }
      if (!this.queue.some((t) => t.id === next.id)) {
        // The song was taken out of the queue meanwhile: play whatever is next now.
        running.finish();
        this.onEnded();
        return;
      }
      this.handover = running;
      // The incoming song is now the current one.
      this.endedHandledFor = null;
      this.nearEndSince = null;
      this.currentId = next.id;
      this.emit('track', next);
      this.emit('change', undefined);
      void running.done.then(() => {
        if (this.handover === running) this.handover = null;
      });
    } catch (error) {
      debug('player', `no mix into "${next.title}" (${(error as Error).message})`);
    } finally {
      this.handing = false;
    }
  }

  private async crossBackends(from: Backend, to: Backend, next: Track, seconds: number) {
    this.handing = true;
    debug('player', `crossfading from ${from.source} into ${to.source} "${next.title}" over ${seconds.toFixed(1)} s`);
    const token = ++this.loadToken;
    let over = false;
    // Ends the crossfade: the outgoing player stops (unless it has been
    // given something new to play meanwhile) and the new one is at full volume.
    const finish = () => {
      if (over) return;
      over = true;
      if (this.handover === handle) this.handover = null;
      if (this.active !== from) void from.stop().catch(() => {}).finally(() => from.setVolume(this.effectiveVolume));
      else from.setVolume(this.effectiveVolume);
      if (this.active === to) to.setVolume(this.effectiveVolume);
    };
    const handle = { finish };
    this.active = to;
    this.currentId = next.id;
    this.endedHandledFor = null;
    this.nearEndSince = null;
    to.setVolume(0);
    this.loading = true;
    this.emit('track', next);
    this.emit('change', undefined);
    try {
      await to.load(next);
      if (token !== this.loadToken) return;
      this.loading = false;
      this.emit('change', undefined);
      this.handover = handle;
      await this.ramp([from, to], seconds, (x) => [Math.cos((x * Math.PI) / 2), Math.sin((x * Math.PI) / 2)], () => !over && token === this.loadToken);
    } catch (error) {
      if (token === this.loadToken) {
        this.loading = false;
        this.onError(error instanceof Error ? error.message : String(error));
      }
    } finally {
      finish();
      this.handing = false;
    }
  }

  /** Steps backend volumes along curves over `seconds` (x runs 0 to 1), while `alive()` holds. */
  private async ramp(backends: Backend[], seconds: number, curves: (x: number) => number[], alive: () => boolean) {
    const steps = Math.max(8, Math.round(seconds * 20));
    for (let i = 1; i <= steps; i++) {
      await new Promise((r) => setTimeout(r, (seconds * 1000) / steps));
      if (!alive()) return;
      const levels = curves(i / steps);
      backends.forEach((b, k) => b.setVolume(this.effectiveVolume * levels[k]));
    }
  }

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

  /** The song that plays after the current one, without changing anything. */
  get upNext(): Track | null {
    return this.neighbour(1, this.repeat === 'all', false);
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
    this.finishHandover();
    const token = ++this.loadToken;
    this.endedHandledFor = null;
    this.nearEndSince = null;
    this.userPaused = false;
    const fadeIn = this.fadingOut ? this.fadeInNext : 0;
    this.fadingOut = false;
    this.fadeInNext = 0;
    if (this.active && this.active !== backend) await this.active.stop().catch(() => {});
    this.active = backend;
    this.currentId = id;
    this.loading = true;
    this.playing = true;
    backend.setVolume(fadeIn > 0 ? 0 : this.effectiveVolume);
    this.emit('track', track);
    this.emit('change', undefined);
    try {
      await backend.load(track);
      if (token !== this.loadToken) return;
      this.loading = false;
      this.emit('change', undefined);
      // After a fade-out on the same streaming service, the new song fades in.
      if (fadeIn > 0) void this.ramp([backend], fadeIn, (x) => [x], () => token === this.loadToken).then(() => token === this.loadToken && backend.setVolume(this.effectiveVolume));
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
    this.userPaused = false;
    // Replaying a track that already ended (end of the queue): its next ending counts again.
    if (this.endedHandledFor === this.currentId) this.endedHandledFor = null;
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
    this.finishHandover();
    this.cancelFadeOut();
    if (!this.active) return;
    this.playing = false;
    this.userPaused = true;
    this.emit('change', undefined);
    await this.active.pause().catch(() => {});
  }

  private async stop(selectId: string | null) {
    this.finishHandover();
    this.loadToken++;
    this.playing = false;
    this.loading = false;
    // Update the state now, not after the backend has stopped: something may
    // start playing in the meantime (clearing the queue and adding new tracks
    // in one go), and that must not be undone when this stop completes.
    const active = this.active;
    this.active = null;
    this.currentId = selectId;
    this.emit('track', this.current);
    this.emit('change', undefined);
    await active?.stop().catch(() => {});
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

  private neighbour(direction: 1 | -1, wrap: boolean, reshuffle = true): Track | null {
    const order = this.playOrder();
    if (order.length === 0) return null;
    const at = order.indexOf(this.currentId ?? '');
    let next = at + direction;
    if (next >= order.length) {
      if (!wrap) return null;
      if (this.shuffle && reshuffle) this.reshuffle(null);
      next = 0;
    } else if (next < 0) {
      if (!wrap) return null;
      next = order.length - 1;
    }
    const id = (this.shuffle ? this.order : order)[next];
    return this.queue.find((t) => t.id === id) ?? null;
  }

  async next() {
    if (await this.skipWithinList(1)) return;
    const track = this.neighbour(1, this.repeat === 'all');
    if (track) await this.playTrack(track.id);
  }

  async previous() {
    // Like every player since the CD: a few seconds in, "previous" restarts the track.
    if (this.position > 3) {
      await this.seek(0);
      return;
    }
    if (await this.skipWithinList(-1)) return;
    const track = this.neighbour(-1, this.repeat === 'all');
    if (track) await this.playTrack(track.id);
    else await this.seek(0);
  }

  /** A queue item that is a whole list the service plays: Next and Previous move within it first. */
  private async skipWithinList(direction: 1 | -1): Promise<boolean> {
    const track = this.current;
    if (!track?.context || !this.active?.skip || this.loading) return false;
    try {
      if (!(await this.active.skip(direction))) return false;
    } catch {
      return false;
    }
    this.nearEndSince = null;
    if (!this.playing) {
      this.playing = true;
      this.userPaused = false;
      this.emit('change', undefined);
    }
    return true;
  }

  async seek(seconds: number) {
    this.finishHandover();
    this.cancelFadeOut();
    if (!this.active) return;
    const duration = this.duration;
    const clamped = Math.max(0, duration > 0 ? Math.min(seconds, duration - 0.25) : seconds);
    this.nearEndSince = null;
    await this.active.seek(clamped).catch(() => {});
    this.emit('change', undefined);
  }

  async seekBy(delta: number) {
    await this.seek(this.position + delta);
  }

  /**
   * Safety net for players that don't report the end of a track, or report it
   * in a way we don't recognise: if playback has sat at the very end for a
   * few seconds, and the user didn't pause it there, move on.
   */
  private watchEnd() {
    const id = this.currentId;
    if (!this.active || !id || this.loading || this.endedHandledFor === id) {
      this.nearEndSince = null;
      return;
    }
    const duration = this.duration;
    const position = this.position;
    if (!(duration > 1)) return;
    if (position >= duration - 1.5) this.nearEndSince ??= performance.now();
    else if (this.playing && position < duration - 3) this.nearEndSince = null;
    // A list the service plays itself gets longer: the next song's report can lag behind the last one's end.
    const grace = this.current?.context ? 8000 : 3500;
    if (this.nearEndSince !== null && !this.userPaused && performance.now() - this.nearEndSince > grace) {
      debug('player', `"${this.current?.title}" reached its end without the player saying so; moving on`);
      this.onEnded();
    }
  }

  private onEnded() {
    const id = this.currentId;
    if (id !== null && this.endedHandledFor === id) return;
    this.endedHandledFor = id;
    this.nearEndSince = null;
    debug('player', `"${this.current?.title}" ended`);
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
