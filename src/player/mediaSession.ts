// Hardware media keys, headset buttons and the OS "Now Playing" panel.
//
// Chrome shows Now Playing for one frame of the page at a time: the top-most
// frame that is playing media and uses the Media Session API. Spotify's and
// YouTube's players are iframes that register their own media-key handlers
// without setting any track info, so while only they were playing, macOS
// showed the tab title ("Rise · Lynnic — Phosphor") instead of the track.
// While a streaming source is current, Phosphor therefore plays an inaudible
// loop in its own page, which makes Chrome use Phosphor's session: the right
// title, artist and artwork, and media keys that drive Phosphor's queue.

import { debug } from '../app/debug';
import type { Player } from './player';
import type { Track } from './types';

/** 10 s of silence (8 kHz, 8-bit mono). Long enough that Chrome treats it as content, not a sound effect. */
function silentLoop(): string {
  const samples = 80000;
  const bytes = new Uint8Array(44 + samples);
  const view = new DataView(bytes.buffer);
  const text = (offset: number, value: string) => {
    for (let i = 0; i < value.length; i++) bytes[offset + i] = value.charCodeAt(i);
  };
  text(0, 'RIFF');
  view.setUint32(4, 36 + samples, true);
  text(8, 'WAVEfmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, 8000, true);
  view.setUint32(28, 8000, true);
  view.setUint16(32, 1, true);
  view.setUint16(34, 8, true);
  text(36, 'data');
  view.setUint32(40, samples, true);
  bytes.fill(128, 44);
  return URL.createObjectURL(new Blob([bytes], { type: 'audio/wav' }));
}

/** Artwork with the size each service actually serves, so the OS can pick sensibly. */
function artworkFor(track: Track): MediaImage[] {
  const src = track.artworkUrl;
  if (!src) return [];
  let sizes = '512x512';
  if (/(^|\.)scdn\.co\//.test(src)) sizes = '640x640';
  else if (/mzstatic\.com/.test(src)) sizes = /(\d+)x(\d+)/.exec(src)?.slice(1, 3).join('x') ?? '600x600';
  else if (/ytimg\.com/.test(src)) sizes = /mqdefault/.test(src) ? '320x180' : /hqdefault/.test(src) ? '480x360' : '1280x720';
  return [{ src, sizes }];
}

export function connectMediaSession(player: Player) {
  const session = navigator.mediaSession;
  if (!session) return;

  const handlers: [MediaSessionAction, MediaSessionActionHandler][] = [
    ['play', () => void player.play()],
    ['pause', () => void player.pause()],
    ['previoustrack', () => void player.previous()],
    ['nexttrack', () => void player.next()],
    ['seekbackward', (d) => void player.seekBy(-(d.seekOffset ?? 10))],
    ['seekforward', (d) => void player.seekBy(d.seekOffset ?? 10)],
    ['seekto', (d) => d.seekTime !== undefined && void player.seek(d.seekTime)],
    ['stop', () => void player.pause()],
  ];
  for (const [action, handler] of handlers) {
    try {
      session.setActionHandler(action, handler);
    } catch {
      /* this browser does not know the action */
    }
  }

  // The inaudible loop that keeps Now Playing on Phosphor's own session. It is
  // a plain element, not connected to the visualizers' audio graph.
  const anchor = new Audio(silentLoop());
  anchor.loop = true;
  anchor.preload = 'auto';
  anchor.setAttribute('aria-hidden', 'true');
  document.body.append(anchor);

  const syncAnchor = () => {
    const track = player.current;
    // Local files play through Phosphor's own <audio> element, which already counts.
    const wanted = Boolean(track && track.source !== 'local' && (player.playing || player.loading));
    if (wanted && anchor.paused) {
      anchor.play().then(
        () => debug('media-session', 'holding Now Playing for Phosphor'),
        (error) => debug('media-session', 'could not start the Now Playing anchor', error),
      );
    } else if (!wanted && !anchor.paused) {
      anchor.pause();
    }
  };

  player.on('track', (track) => {
    if (!track) {
      session.metadata = null;
      return;
    }
    session.metadata = new MediaMetadata({
      title: track.title,
      artist: track.artist ?? '',
      album: track.album ?? '',
      artwork: artworkFor(track),
    });
  });

  const sync = () => {
    syncAnchor();
    session.playbackState = player.current ? (player.playing ? 'playing' : 'paused') : 'none';
    const duration = player.duration;
    if (duration > 0 && Number.isFinite(duration)) {
      try {
        session.setPositionState({ duration, position: Math.min(player.position, duration), playbackRate: 1 });
      } catch {
        /* rejected while the values are momentarily inconsistent */
      }
    }
  };
  player.on('change', sync);
  player.on('track', sync);
}
