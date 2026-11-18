// The Library sheet: Phosphor playlists, their contents, and import/export.

import type { App } from '../app/app';
import type { PlaylistItem, PlayMode } from '../library/playlists';
import { SOURCE_NAMES } from '../player/types';
import { clear, formatTime, h, icon, iconButton } from './dom';
import { segmented } from './gallery';
import { trackThumb } from './queue';

const MODES: [PlayMode, string][] = [
  ['order', 'In order'],
  ['shuffle', 'Shuffled'],
  ['interleave', 'Alternate sources'],
];

function download(name: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  const a = h('a', { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function openLibrary(app: App, initial?: string) {
  const { library } = app;
  const nav = h('nav', { class: 'tabs library-nav' });
  const panel = h('div', { class: 'tab-panel' });
  let selected = initial ?? library.playlists[0]?.id ?? null;
  let dragFrom = -1;

  const importInput = h('input', { type: 'file', accept: '.json,application/json', hidden: true });
  importInput.addEventListener('change', async () => {
    const file = importInput.files?.[0];
    importInput.value = '';
    if (!file) return;
    try {
      const count = await library.importJson(await file.text());
      app.toast(`Imported ${count} playlist${count === 1 ? '' : 's'}. Local files reconnect when you open or drop them.`);
    } catch (error) {
      app.toast((error as Error).message, 'error');
    }
  });

  const renderNav = () => {
    clear(nav);
    nav.append(
      h(
        'button',
        {
          class: 'btn small library-new',
          type: 'button',
          onClick: async () => {
            const p = await library.create();
            selected = p.id;
            render();
            panel.querySelector<HTMLInputElement>('.playlist-name')?.select();
          },
        },
        icon('plus', 16),
        'New playlist',
      ),
    );
    for (const p of library.playlists) {
      nav.append(
        h(
          'button',
          {
            class: `tab playlist-tab ${p.id === selected ? 'active' : ''}`,
            type: 'button',
            'data-id': p.id,
            onClick: () => {
              selected = p.id;
              render();
            },
          },
          h('span', { class: 'playlist-tab-name', text: p.name }),
          h('small', { text: library.summary(p.id) }),
        ),
      );
    }
    nav.append(
      h('div', { class: 'library-nav-foot' }, h('button', { class: 'btn small', type: 'button', onClick: () => importInput.click() }, icon('upload', 16), 'Import'), importInput),
    );
  };

  const itemRow = (playlistId: string, item: PlaylistItem, index: number): HTMLElement => {
    let thumb: HTMLElement;
    let title: string;
    let sub: string;
    let end: Node | null = null;
    if (item.kind === 'track') {
      thumb = trackThumb(item.track);
      title = item.track.title;
      const missing = item.track.source === 'local' && !item.track.handleKey;
      sub = [item.track.artist, SOURCE_NAMES[item.track.source]].filter(Boolean).join(' · ') + (missing ? ' · needs adding again' : '');
      if (item.track.duration) end = h('span', { text: formatTime(item.track.duration) });
    } else if (item.kind === 'remote') {
      thumb = trackThumb(item.collection);
      title = item.collection.title;
      sub = `Linked ${SOURCE_NAMES[item.collection.source]} ${item.collection.kind} · always up to date`;
      end = h('span', { class: 'tag', text: 'Live' });
    } else {
      thumb = h('div', { class: 'thumb' }, icon('library', 18));
      title = library.get(item.playlistId)?.name ?? 'Missing playlist';
      sub = `Phosphor playlist · ${library.summary(item.playlistId)}`;
    }
    const row = h(
      'div',
      { class: 'row', draggable: 'true' },
      thumb,
      h('div', null, h('div', { class: 'row-title', text: title }), h('div', { class: 'row-sub', text: sub })),
      h(
        'div',
        { class: 'row-end' },
        end,
        iconButton('close', 'Remove from this playlist', () => void library.removeItem(playlistId, item.uid)),
      ),
    );
    row.addEventListener('dragstart', (e) => {
      dragFrom = index;
      row.classList.add('dragging');
      e.dataTransfer?.setData('application/x-phosphor-playlist-row', String(index));
    });
    row.addEventListener('dragend', () => {
      dragFrom = -1;
      panel.querySelectorAll('.row').forEach((r) => r.classList.remove('dragging', 'drop-above', 'drop-below'));
    });
    row.addEventListener('dragover', (e) => {
      if (dragFrom < 0) return;
      e.preventDefault();
      const rect = row.getBoundingClientRect();
      const above = e.clientY < rect.top + rect.height / 2;
      row.classList.toggle('drop-above', above);
      row.classList.toggle('drop-below', !above);
    });
    row.addEventListener('dragleave', () => row.classList.remove('drop-above', 'drop-below'));
    row.addEventListener('drop', (e) => {
      if (dragFrom < 0) return;
      e.preventDefault();
      e.stopPropagation();
      const rect = row.getBoundingClientRect();
      let to = e.clientY < rect.top + rect.height / 2 ? index : index + 1;
      if (to > dragFrom) to--;
      void library.moveItem(playlistId, dragFrom, to);
    });
    return row;
  };

  const renderPanel = () => {
    clear(panel);
    const playlist = selected ? library.get(selected) : undefined;
    if (!playlist) {
      panel.append(
        h('h3', { text: 'Your playlists' }),
        h('p', null, 'Make playlists that mix songs from Spotify, Apple Music, YouTube and your own files. You can also link whole playlists from those services: they stay up to date, so a song you add on Spotify shows up here the next time you play.'),
        h('p', null, 'Playlists can contain other playlists too, and are saved in this browser. Export them to move them to another computer.'),
        h(
          'div',
          { class: 'actions' },
          h(
            'button',
            {
              class: 'btn primary',
              type: 'button',
              onClick: async () => {
                selected = (await library.create()).id;
                render();
              },
            },
            icon('plus', 18),
            'New playlist',
          ),
        ),
      );
      return;
    }

    const name = h('input', { class: 'input playlist-name', value: playlist.name, 'aria-label': 'Playlist name', spellcheck: 'false' });
    name.addEventListener('change', () => void library.rename(playlist.id, name.value));
    name.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') name.blur();
    });

    const others = library.playlists.filter((p) => p.id !== playlist.id && !library.contains(p.id, playlist.id));
    const nestSelect = h('select', { class: 'compact', 'aria-label': 'Playlist to add inside this one' }, others.map((p) => h('option', { value: p.id, text: p.name })));

    const items = h('div', { class: 'results library-items' });
    if (playlist.items.length === 0) {
      items.append(h('p', { class: 'note', text: 'Empty for now. Add the current song or the whole queue below, or use the playlist button on songs and playlists in Add music and in the queue.' }));
    }
    playlist.items.forEach((item, i) => items.append(itemRow(playlist.id, item, i)));

    panel.append(
      h('div', { class: 'playlist-head' }, name, h('small', { text: library.summary(playlist.id) })),
      h(
        'div',
        { class: 'actions' },
        h('button', { class: 'btn primary', type: 'button', disabled: playlist.items.length === 0, onClick: () => void app.playPlaylist(playlist.id) }, icon('play', 18), 'Play'),
        h('button', { class: 'btn', type: 'button', disabled: playlist.items.length === 0, onClick: () => void app.playPlaylist(playlist.id, { append: true }) }, icon('queue', 18), 'Add to queue'),
        segmented<PlayMode>(MODES, playlist.mode, (mode) => void library.setMode(playlist.id, mode)),
      ),
      items,
      h('h3', { text: 'Add to this playlist' }),
      h(
        'div',
        { class: 'actions' },
        h(
          'button',
          {
            class: 'btn small',
            type: 'button',
            disabled: !app.player.current,
            onClick: async () => {
              const track = app.player.current;
              if (!track) return;
              await library.addTracks(playlist.id, [track]);
              app.toast(`Added "${track.title}"`);
            },
          },
          icon('plus', 16),
          'Current song',
        ),
        h(
          'button',
          {
            class: 'btn small',
            type: 'button',
            disabled: app.player.queue.length === 0,
            onClick: async () => {
              const n = await library.addTracks(playlist.id, app.player.queue);
              app.toast(`Added ${n} song${n === 1 ? '' : 's'} from the queue`);
            },
          },
          icon('queue', 16),
          'Whole queue',
        ),
        others.length
          ? h(
              'span',
              { class: 'inline-label' },
              nestSelect,
              h(
                'button',
                {
                  class: 'btn small',
                  type: 'button',
                  onClick: async () => {
                    try {
                      await library.addPlaylist(playlist.id, nestSelect.value);
                    } catch (error) {
                      app.toast((error as Error).message, 'error');
                    }
                  },
                },
                icon('library', 16),
                'Add playlist inside',
              ),
            )
          : null,
      ),
      h('p', { class: 'hint-text', text: 'To link a whole Spotify, Apple Music or YouTube playlist, use the playlist button on its row in Add music.' }),
      h(
        'div',
        { class: 'actions library-foot' },
        h('button', { class: 'btn small', type: 'button', onClick: () => download(`${playlist.name.replace(/[^\w\- ]+/g, '').trim() || 'playlist'}.phosphor.json`, library.exportJson([playlist.id])) }, icon('download', 16), 'Export'),
        h('button', { class: 'btn small', type: 'button', onClick: () => download('phosphor-playlists.json', library.exportJson()) }, icon('download', 16), 'Export all'),
        h(
          'button',
          {
            class: 'btn small danger',
            type: 'button',
            onClick: async () => {
              if (!confirm(`Delete "${playlist.name}"? This can't be undone.`)) return;
              await library.remove(playlist.id);
              selected = library.playlists[0]?.id ?? null;
              render();
            },
          },
          icon('trash', 16),
          'Delete',
        ),
      ),
    );
  };

  const render = () => {
    if (selected && !library.get(selected)) selected = library.playlists[0]?.id ?? null;
    renderNav();
    const focusedName = document.activeElement?.classList.contains('playlist-name');
    if (!focusedName) renderPanel();
  };

  const off = library.on('change', render);
  render();
  return { body: h('div', { class: 'library' }, nav, panel), onClose: off };
}
