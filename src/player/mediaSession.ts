// Hardware media keys, headset buttons and the OS "now playing" widget.

import type { Player } from './player';

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

  player.on('track', (track) => {
    if (!track) {
      session.metadata = null;
      return;
    }
    session.metadata = new MediaMetadata({
      title: track.title,
      artist: track.artist ?? '',
      album: track.album ?? '',
      artwork: track.artworkUrl ? [{ src: track.artworkUrl, sizes: '512x512' }] : [],
    });
  });

  const syncPosition = () => {
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
  player.on('change', syncPosition);
}
