// One tab of the "Add music" sheet for a streaming service: connection state,
// search, the user's playlists, and a paste-a-link box. The same component
// serves Spotify, Apple Music and YouTube.

import type { App } from '../app/app';
import type { Collection, Track } from '../player/types';
import type { MusicService, SearchResults } from '../services/types';
import { clear, formatTime, h, icon, iconButton } from './dom';
import { trackThumb } from './queue';

export function createServicePanel(app: App, service: MusicService): HTMLElement {
  const { player } = app;
  const root = h('div');
  const head = h('div');
  const browse = h('div');
  const results = h('div', { class: 'results' });
  let busy = false;

  const fail = (error: unknown) => app.toast(error instanceof Error ? error.message : String(error), 'error');

  const enqueue = (tracks: Track[], play: boolean) => {
    if (tracks.length === 0) return;
    player.add(tracks, { play });
    app.toast(tracks.length === 1 ? `Added "${tracks[0].title}"` : `Added ${tracks.length} tracks`);
  };

  const trackRow = (track: Track) =>
    h(
      'div',
      { class: 'row' },
      trackThumb(track),
      h('div', null, h('div', { class: 'row-title', text: track.title }), h('div', { class: 'row-sub', text: [track.artist, track.album].filter(Boolean).join(' — ') || ' ' })),
      h(
        'div',
        { class: 'row-end' },
        track.duration ? h('span', { text: formatTime(track.duration) }) : null,
        iconButton('play', 'Play now', () => enqueue([track], true), 'keep'),
        iconButton('plus', 'Add to queue', () => enqueue([track], false), 'keep'),
      ),
    );

  const collectionRow = (collection: Collection) => {
    const load = async (play: boolean) => {
      try {
        const tracks = await service.tracksOf(collection);
        if (tracks.length === 0) app.toast(`"${collection.title}" has no playable tracks.`, 'error');
        else enqueue(tracks, play);
      } catch (error) {
        fail(error);
      }
    };
    return h(
      'div',
      { class: 'row' },
      trackThumb(collection),
      h('div', null, h('div', { class: 'row-title', text: collection.title }), h('div', { class: 'row-sub', text: collection.subtitle ?? (collection.kind === 'album' ? 'Album' : 'Playlist') })),
      h(
        'div',
        { class: 'row-end' },
        iconButton('play', 'Play all', () => void load(true), 'keep'),
        iconButton('plus', 'Add all to queue', () => void load(false), 'keep'),
      ),
    );
  };

  const showResults = (found: SearchResults | null, emptyText: string) => {
    clear(results);
    if (!found || (found.tracks.length === 0 && found.collections.length === 0)) {
      results.append(h('p', { style: 'margin:10px 8px', text: emptyText }));
      return;
    }
    if (found.tracks.length) {
      results.append(h('h4', { text: 'Tracks' }));
      found.tracks.forEach((t) => results.append(trackRow(t)));
    }
    if (found.collections.length) {
      results.append(h('h4', { text: 'Albums & playlists' }));
      found.collections.forEach((c) => results.append(collectionRow(c)));
    }
  };

  const run = async (work: () => Promise<void>) => {
    if (busy) return;
    busy = true;
    clear(results);
    results.append(h('p', { style: 'margin:10px 8px', text: 'Loading…' }));
    try {
      await work();
    } catch (error) {
      clear(results);
      fail(error);
    } finally {
      busy = false;
    }
  };

  const render = () => {
    const status = service.status();
    clear(head);
    clear(browse);

    head.append(h('h3', { text: service.name }));
    if (!status.configured) {
      head.append(
        h('p', { class: 'note warn' }, `${service.name} needs credentials before it can be used. `, 'Setup takes a few minutes and is described step by step in the README.'),
        h(
          'div',
          { class: 'actions' },
          h('button', { class: 'btn primary', type: 'button', onClick: () => app.openSheet('settings', service.id) }, icon('settings', 18), `Set up ${service.name}`),
        ),
      );
    } else if (!status.connected) {
      if (status.problem) head.append(h('p', { class: 'note warn', text: status.problem }));
      head.append(
        h(
          'div',
          { class: 'actions' },
          h(
            'button',
            { class: 'btn primary', type: 'button', onClick: () => void service.connect().catch(fail) },
            icon('link', 18),
            `Connect ${service.name}`,
          ),
          h('button', { class: 'btn', type: 'button', onClick: () => app.openSheet('settings', service.id) }, 'Settings'),
        ),
      );
    } else {
      head.append(
        h(
          'div',
          { class: 'note ok', style: 'display:flex;align-items:center;justify-content:space-between;gap:12px' },
          h('span', null, 'Connected', status.account ? h('span', null, ' as ', h('strong', { text: status.account })) : null),
          h('button', { class: 'btn small', type: 'button', onClick: () => service.disconnect() }, 'Disconnect'),
        ),
      );
      if (status.problem) head.append(h('p', { class: 'note warn', text: status.problem }));
    }

    if (status.connected) {
      // ---- search
      if (service.canSearch()) {
        const query = h('input', { class: 'input', type: 'search', placeholder: `Search ${service.name}`, 'aria-label': `Search ${service.name}` });
        const go = () => {
          const q = query.value.trim();
          if (q) void run(async () => showResults(await service.search(q), `Nothing found for "${q}".`));
        };
        query.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') go();
        });
        browse.append(
          h('div', { class: 'input-row' }, query, h('button', { class: 'btn', type: 'button', onClick: go }, icon('search', 18), 'Search')),
        );
      } else if (service.searchUnavailable) {
        browse.append(h('p', { class: 'note', text: service.searchUnavailable() }));
      }

      // ---- paste a link
      const link = h('input', { class: 'input', type: 'url', placeholder: `Paste a ${service.linkHint}`, 'aria-label': 'Paste a link' });
      const open = () => {
        const url = link.value.trim();
        if (!url) return;
        void run(async () => {
          const found = await service.resolveLink(url);
          if (!found) {
            clear(results);
            app.toast(`That doesn't look like a ${service.linkHint}.`, 'error');
            return;
          }
          showResults(found, 'Nothing playable at that link.');
          link.value = '';
        });
      };
      link.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') open();
      });
      browse.append(
        h('div', { class: 'input-row', style: 'margin-top:10px' }, link, h('button', { class: 'btn', type: 'button', onClick: open }, icon('link', 18), 'Open link')),
      );

      // ---- library
      if (service.library) {
        const library = service.library.bind(service);
        browse.append(
          h(
            'div',
            { class: 'actions', style: 'margin-top:12px' },
            h(
              'button',
              { class: 'btn small', type: 'button', onClick: () => void run(async () => showResults({ tracks: [], collections: await library() }, 'No playlists found.')) },
              'Show my playlists',
            ),
          ),
        );
      }
      browse.append(results);
    }

    browse.append(
      h('h3', { text: 'How this works, and its limits' }),
      h('ul', null, service.limits.map((text) => h('li', { text }))),
    );
  };

  const off = service.onStatus(render);
  render();
  root.append(head, browse);
  (root as HTMLElement & { cleanup?: () => void }).cleanup = off;
  return root;
}
