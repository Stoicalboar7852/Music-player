// The queue drawer: what is lined up, click to play, drag to reorder.

import type { App } from '../app/app';
import type { Track } from '../player/types';
import { clear, formatTime, h, icon, iconButton } from './dom';

/** A track row shared by the queue and the service browsers. */
export function trackThumb(track: { artworkUrl?: string }, round = false): HTMLElement {
  const thumb = h('div', { class: `thumb ${round ? 'round' : ''}` }, icon('note', 18));
  if (track.artworkUrl) {
    const img = h('img', { alt: '', loading: 'lazy', src: track.artworkUrl });
    img.addEventListener('error', () => img.remove());
    thumb.append(img);
  }
  return thumb;
}

export function createQueue(app: App) {
  const { player } = app;
  const count = h('small');
  const list = h('div', { class: 'queue-list' });
  const el = h(
    'aside',
    { class: 'drawer glass', 'aria-label': 'Queue' },
    h(
      'div',
      { class: 'drawer-head' },
      h('h2', null, 'Queue', count),
      h(
        'div',
        { style: 'display:flex;gap:2px' },
        iconButton('plus', 'Add music', () => app.openSheet('sources')),
        iconButton('trash', 'Clear queue', () => player.clear()),
        iconButton('close', 'Close (Q)', () => app.toggleQueue(false)),
      ),
    ),
    list,
  );

  let dragFrom = -1;
  let signature = '';

  const row = (track: Track, index: number): HTMLElement => {
    const isCurrent = player.current?.id === track.id;
    const thumb = trackThumb(track);
    if (isCurrent) {
      thumb.append(h('div', { class: `eq ${player.playing ? '' : 'paused'}` }, h('i'), h('i'), h('i')));
    }
    const el = h(
      'div',
      { class: `row ${isCurrent ? 'current' : ''}`, draggable: 'true', title: track.file?.name ?? track.title },
      thumb,
      h(
        'div',
        null,
        h('div', { class: 'row-title', text: track.title }),
        h('div', { class: 'row-sub', text: [track.artist, track.album].filter(Boolean).join(' — ') || ' ' }),
      ),
      h(
        'div',
        { class: 'row-end' },
        track.duration ? h('span', { text: formatTime(track.duration) }) : null,
        iconButton('close', 'Remove from queue', (e) => {
          e.stopPropagation();
          player.remove(track.id);
        }),
      ),
    );
    el.addEventListener('click', () => void player.playTrack(track.id));
    el.addEventListener('dragstart', (e) => {
      dragFrom = index;
      el.classList.add('dragging');
      e.dataTransfer?.setData('application/x-phosphor-row', String(index));
      if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
    });
    el.addEventListener('dragend', () => {
      dragFrom = -1;
      list.querySelectorAll('.row').forEach((r) => r.classList.remove('dragging', 'drop-above', 'drop-below'));
    });
    el.addEventListener('dragover', (e) => {
      if (dragFrom < 0) return;
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      const above = e.clientY < rect.top + rect.height / 2;
      el.classList.toggle('drop-above', above);
      el.classList.toggle('drop-below', !above);
    });
    el.addEventListener('dragleave', () => el.classList.remove('drop-above', 'drop-below'));
    el.addEventListener('drop', (e) => {
      if (dragFrom < 0) return;
      e.preventDefault();
      e.stopPropagation();
      const rect = el.getBoundingClientRect();
      let to = e.clientY < rect.top + rect.height / 2 ? index : index + 1;
      if (to > dragFrom) to--;
      player.move(dragFrom, to);
    });
    return el;
  };

  const render = () => {
    const q = player.queue;
    // Skip rebuilding when nothing visible changed (this runs on every transport event).
    const next =
      q.map((t) => `${t.id}|${t.title}|${t.artist}|${t.artworkUrl}|${t.duration}`).join('\n') +
      `#${player.current?.id}#${player.playing}`;
    if (next === signature) return;
    signature = next;
    count.textContent = q.length ? `${q.length} track${q.length === 1 ? '' : 's'}` : '';
    const scroll = list.scrollTop;
    clear(list);
    if (q.length === 0) {
      list.append(h('div', { class: 'queue-empty' }, 'The queue is empty.', h('br'), 'Drop audio files anywhere to add them.'));
      return;
    }
    q.forEach((t, i) => list.append(row(t, i)));
    list.scrollTop = scroll;
  };

  player.on('change', render);
  player.on('track', render);
  render();

  return {
    el,
    toggle(force?: boolean) {
      const open = force ?? !el.classList.contains('open');
      el.classList.toggle('open', open);
      if (open) el.querySelector('.row.current')?.scrollIntoView({ block: 'nearest' });
      return open;
    },
    get isOpen() {
      return el.classList.contains('open');
    },
  };
}
