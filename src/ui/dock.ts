// The transport bar: now playing, play/seek controls, volume and panel buttons.

import type { App } from '../app/app';
import { SOURCE_NAMES } from '../player/types';
import { formatTime, h, icon, iconButton, setIcon } from './dom';

export function createDock(app: App) {
  const { player, capture } = app;

  // ---- now playing
  const artImg = h('img', { alt: '', hidden: true });
  const art = h('div', { class: 'art' }, icon('note', 24), artImg);
  const title = h('div', { class: 'title' });
  const artist = h('div', { class: 'artist' });
  const source = h('div', { class: 'source' });
  const now = h('div', { class: 'now' }, art, h('div', { class: 'meta' }, title, artist, source));
  artImg.addEventListener('error', () => (artImg.hidden = true));

  // ---- transport
  const shuffle = iconButton('shuffle', 'Shuffle (S)', () => player.setShuffle(!player.shuffle));
  const previous = iconButton('previous', 'Previous (P)', () => void player.previous());
  const play = h('button', { class: 'play-btn', type: 'button', onClick: () => void player.toggle() }, icon('play', 22));
  const next = iconButton('next', 'Next (N)', () => void player.next());
  const repeat = iconButton('repeat', 'Repeat (R)', () => player.cycleRepeat());

  const elapsed = h('span', { text: '0:00' });
  const total = h('span', { text: '0:00' });
  const seek = h('input', { type: 'range', min: '0', max: '1000', value: '0', step: '1', 'aria-label': 'Seek' });
  let scrubbing = false;
  seek.addEventListener('input', () => {
    scrubbing = true;
    const fraction = Number(seek.value) / 1000;
    seek.style.setProperty('--p', `${fraction * 100}%`);
    elapsed.textContent = formatTime(fraction * player.duration);
  });
  seek.addEventListener('change', () => {
    void player.seek((Number(seek.value) / 1000) * player.duration);
    scrubbing = false;
  });
  // The arrow keys belong to the visualizer switcher and volume, not to
  // whichever slider was clicked last. Tab and the rest still work.
  const ignoreArrows = (e: KeyboardEvent) => {
    if (e.key.startsWith('Arrow') || e.key === 'Home' || e.key === 'End' || e.key.startsWith('Page')) e.preventDefault();
  };
  seek.addEventListener('keydown', ignoreArrows);

  const transport = h(
    'div',
    { class: 'transport' },
    h('div', { class: 'transport-buttons' }, shuffle, previous, play, next, repeat),
    h('div', { class: 'seek' }, elapsed, seek, total),
  );

  // ---- tools
  const muteBtn = iconButton('volume', 'Mute (M)', () => player.toggleMute());
  const volume = h('input', { type: 'range', min: '0', max: '100', value: '80', 'aria-label': 'Volume' });
  volume.addEventListener('input', () => player.setVolume(Number(volume.value) / 100));
  volume.addEventListener('keydown', ignoreArrows);
  const add = iconButton('plus', 'Add music (O)', () => app.openSheet('sources'));
  const queue = iconButton('queue', 'Queue (Q)', () => app.toggleQueue());
  const gallery = iconButton('grid', 'Visualizers (G)', () => app.openSheet('gallery'));
  const settingsBtn = iconButton('settings', 'Settings (,)', () => app.openSheet('settings'));
  const fullscreen = iconButton('fullscreen', 'Fullscreen (F)', () => app.toggleFullscreen());
  const tools = h(
    'div',
    { class: 'tools' },
    h('div', { class: 'volume' }, muteBtn, volume),
    add,
    queue,
    gallery,
    settingsBtn,
    fullscreen,
  );

  const el = h('div', { class: 'dock glass' }, now, transport, tools);

  let lastArt: string | undefined;
  const render = () => {
    const track = player.current;
    if (track) {
      title.textContent = track.title;
      artist.textContent = [track.artist, track.album].filter(Boolean).join(' — ') || 'Unknown artist';
      source.textContent = SOURCE_NAMES[track.source];
    } else if (capture.state.active) {
      title.textContent = capture.state.label;
      artist.textContent = 'Listening to what is playing';
      source.textContent = 'Capture';
    } else {
      title.textContent = 'Nothing playing';
      artist.textContent = 'Add music or capture system audio';
      source.textContent = '';
    }
    const artUrl = track?.artworkUrl;
    if (artUrl !== lastArt) {
      lastArt = artUrl;
      artImg.hidden = !artUrl;
      if (artUrl) artImg.src = artUrl;
      else artImg.removeAttribute('src');
    }

    const hasQueue = player.queue.length > 0;
    for (const b of [previous, next]) b.disabled = !hasQueue;
    play.disabled = !hasQueue;
    play.style.opacity = hasQueue ? '' : '0.4';
    play.title = player.playing ? 'Pause (Space)' : 'Play (Space)';
    play.setAttribute('aria-label', play.title);
    play.classList.toggle('loading', player.loading);
    setIcon(play, player.playing ? 'pause' : 'play', 22);

    shuffle.classList.toggle('on', player.shuffle);
    repeat.classList.toggle('on', player.repeat !== 'off');
    setIcon(repeat, player.repeat === 'one' ? 'repeatOne' : 'repeat');
    repeat.title = `Repeat: ${player.repeat} (R)`;

    const level = player.muted ? 0 : player.volume;
    setIcon(muteBtn, level === 0 ? 'mute' : level < 0.5 ? 'volumeLow' : 'volume');
    volume.value = String(Math.round(level * 100));
    volume.style.setProperty('--p', `${level * 100}%`);
  };

  /** Called a few times a second to move the seek bar. */
  const tick = () => {
    const duration = player.duration;
    seek.disabled = !(duration > 0);
    total.textContent = formatTime(duration);
    if (scrubbing) return;
    const position = Math.min(player.position, duration || 0);
    const fraction = duration > 0 ? position / duration : 0;
    seek.value = String(Math.round(fraction * 1000));
    seek.style.setProperty('--p', `${fraction * 100}%`);
    elapsed.textContent = formatTime(position);
  };

  player.on('change', render);
  player.on('track', render);
  capture.on('change', render);
  document.addEventListener('fullscreenchange', () => {
    setIcon(fullscreen, document.fullscreenElement ? 'exitFullscreen' : 'fullscreen');
  });
  render();
  tick();

  return { el, tick, queueButton: queue };
}
