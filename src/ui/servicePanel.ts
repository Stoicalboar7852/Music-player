// One tab of the "Add music" sheet for a streaming service: connection state,
// search and paste-a-link, the service's home (shelves of whatever its API
// offers for this account), and album and playlist pages. The same component
// serves Spotify, Apple Music and YouTube.

import type { App } from '../app/app';
import type { Collection, Track } from '../player/types';
import type { MusicService, SearchResults, Shelf } from '../services/types';
import { clear, formatTime, h, icon, iconButton, setIcon } from './dom';
import { trackThumb } from './queue';

/** Home views are kept for a few minutes, so reopening the sheet is instant. */
const homeCache = new Map<string, { at: number; key: string; shelves: Shelf[] }>();
const HOME_TTL = 5 * 60_000;

type View = { kind: 'home' } | { kind: 'results'; found: SearchResults; emptyText: string } | { kind: 'collection'; collection: Collection };

export function createServicePanel(app: App, service: MusicService): HTMLElement {
  const { player } = app;
  const root = h('div', { class: 'service-panel' });
  const head = h('div');
  const tools = h('div');
  const body = h('div', { class: 'browse' });
  const foot = h('div');
  let view: View = { kind: 'home' };
  const history: View[] = [];
  let busy = false;
  // YouTube cards show 16:9 video thumbnails.
  const wide = service.id === 'youtube';

  const fail = (error: unknown) => app.toast(error instanceof Error ? error.message : String(error), 'error');

  /** What the tools and body depend on. A cached home is only reused for the same answer. */
  const homeKey = () => {
    const status = service.status();
    return `${service.id}|${status.configured}|${status.connected}|${service.account?.status().signedIn ?? ''}|${status.connected && service.canSearch()}`;
  };

  // ------------------------------------------------------------- actions

  const enqueue = (tracks: Track[], play: boolean) => {
    if (tracks.length === 0) return;
    player.add(tracks, { play });
    app.toast(tracks.length === 1 ? `Added "${tracks[0].context?.title ?? tracks[0].title}"` : `Added ${tracks.length} tracks`);
  };

  const loadCollection = async (collection: Collection, play: boolean) => {
    try {
      const tracks = await service.tracksOf(collection);
      if (tracks.length === 0) app.toast(`"${collection.title}" has no playable tracks.`, 'error');
      else enqueue(tracks, play);
    } catch (error) {
      fail(error);
    }
  };

  const linkToPlaylist = (anchor: HTMLElement, collection: Collection) =>
    app.addToPlaylist(anchor, { collection, label: `"${collection.title}" (linked, always up to date)` });

  /** A heart that saves to the user's library on the service, where its API allows. */
  const saveButton = (item: Track | Collection, cls = 'keep'): HTMLButtonElement | null => {
    if (!service.saveToLibrary || service.canSave?.(item) === false) return null;
    const label = `Save to your ${service.name} library`;
    const button = iconButton(
      'heart',
      label,
      (e) => {
        e.stopPropagation();
        if (button.classList.contains('saved')) return;
        button.disabled = true;
        void service.saveToLibrary!(item).then(
          () => {
            button.classList.add('saved');
            setIcon(button, 'heartFilled');
            button.title = `In your ${service.name} library`;
            app.toast(`Saved "${'kind' in item ? item.title : (item.context?.title ?? item.title)}" to your ${service.name} library`);
          },
          (error: unknown) => fail(error),
        ).finally(() => (button.disabled = false));
      },
      cls,
    );
    return button;
  };

  const stop = (fn: (e: MouseEvent) => void) => (e: MouseEvent) => {
    e.stopPropagation();
    fn(e);
  };

  // --------------------------------------------------------------- rows

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
        iconButton('listPlus', 'Add to a Phosphor playlist', (e) => app.addToPlaylist(e.currentTarget as HTMLElement, { tracks: [track], label: `"${track.title}"` }), 'keep'),
        saveButton(track),
      ),
    );

  const collectionRow = (collection: Collection) => {
    const title = h('button', { class: 'row-title link-like', type: 'button', text: collection.title, title: `Open "${collection.title}"`, onClick: () => go({ kind: 'collection', collection }) });
    return h(
      'div',
      { class: 'row' },
      trackThumb(collection),
      h('div', null, title, h('div', { class: 'row-sub', text: collection.subtitle ?? (collection.kind === 'album' ? 'Album' : 'Playlist') })),
      h(
        'div',
        { class: 'row-end' },
        iconButton('play', 'Play all', () => void loadCollection(collection, true), 'keep'),
        iconButton('plus', 'Add all to queue', () => void loadCollection(collection, false), 'keep'),
        iconButton('listPlus', 'Link to a Phosphor playlist (stays up to date)', (e) => linkToPlaylist(e.currentTarget as HTMLElement, collection), 'keep'),
        saveButton(collection),
      ),
    );
  };

  // -------------------------------------------------------------- cards

  const art = (url: string | undefined, liked = false) => {
    // Liked Songs / Liked videos have no cover of their own.
    const box = h('div', { class: `media-art ${liked ? 'liked' : ''}` }, icon(liked ? 'heartFilled' : 'note', liked ? 34 : 26));
    if (url) {
      const img = h('img', { alt: '', loading: 'lazy', src: url, draggable: 'false' });
      img.addEventListener('error', () => img.remove());
      box.append(img);
    }
    return box;
  };

  const card = (opts: { title: string; sub?: string; artworkUrl?: string; liked?: boolean; badge?: string; label: string; onOpen: () => void; onPlay: () => void; tools: (Node | null)[] }) => {
    const play = h('button', { class: 'media-play', type: 'button', title: 'Play', 'aria-label': `Play ${opts.title}`, onClick: stop(opts.onPlay) }, icon('play', 18));
    const cover = art(opts.artworkUrl, opts.liked);
    cover.append(play);
    if (opts.badge) cover.append(h('span', { class: 'media-badge', text: opts.badge }));
    const el = h(
      'div',
      { class: 'media-card', tabindex: '0', role: 'button', title: opts.label, 'aria-label': opts.label },
      cover,
      h('div', { class: 'media-title', text: opts.title }),
      h('div', { class: 'media-sub', text: opts.sub || ' ' }),
      h('div', { class: 'media-tools' }, opts.tools),
    );
    el.addEventListener('click', opts.onOpen);
    el.addEventListener('keydown', (e) => {
      if (e.target === el && (e.key === 'Enter' || e.key === ' ')) {
        e.preventDefault();
        opts.onOpen();
      }
    });
    return el;
  };

  const trackCard = (track: Track) =>
    card({
      title: track.title,
      sub: track.artist,
      artworkUrl: track.artworkUrl,
      label: `Play "${track.title}"`,
      onOpen: () => enqueue([track], true),
      onPlay: () => enqueue([track], true),
      tools: [
        iconButton('plus', 'Add to queue', stop(() => enqueue([track], false))),
        iconButton('listPlus', 'Add to a Phosphor playlist', stop((e) => app.addToPlaylist(e.currentTarget as HTMLElement, { tracks: [track], label: `"${track.title}"` }))),
        saveButton(track, ''),
      ],
    });

  const collectionCard = (collection: Collection) =>
    card({
      title: collection.title,
      sub: collection.subtitle,
      artworkUrl: collection.artworkUrl,
      liked: collection.id === 'liked',
      badge: collection.contextOnly ? 'Plays as a whole' : undefined,
      label: `Open "${collection.title}"`,
      onOpen: () => go({ kind: 'collection', collection }),
      onPlay: () => void loadCollection(collection, true),
      tools: [
        iconButton('plus', 'Add all to queue', stop(() => void loadCollection(collection, false))),
        iconButton('listPlus', 'Link to a Phosphor playlist (stays up to date)', stop((e) => linkToPlaylist(e.currentTarget as HTMLElement, collection))),
        saveButton(collection, ''),
      ],
    });

  // -------------------------------------------------------------- views

  const go = (next: View) => {
    history.push(view);
    view = next;
    renderBody();
    root.closest('.tab-panel')?.scrollTo({ top: 0 });
  };

  const back = () => {
    view = history.pop() ?? { kind: 'home' };
    renderBody();
  };

  const backButton = () =>
    h(
      'button',
      { class: 'btn small ghost back-btn', type: 'button', onClick: back },
      icon('chevronLeft', 16),
      history.at(-1)?.kind === 'results' ? 'Back to results' : `${service.name} home`,
    );

  const drawShelves = (into: HTMLElement, shelves: Shelf[]) => {
    let shown = 0;
    for (const shelf of shelves) {
      const items = [...(shelf.tracks ?? []).map(trackCard), ...(shelf.collections ?? []).map(collectionCard)];
      if (items.length === 0 && !shelf.note) continue;
      shown++;
      const reconnect =
        shelf.needsReconnect && service.reconnect
          ? h(
              'button',
              {
                class: 'btn small',
                type: 'button',
                onClick: () =>
                  void service.reconnect!().then(() => {
                    homeCache.delete(service.id);
                    app.toast(`Reconnected to ${service.name}`);
                    renderBody();
                  }, fail),
              },
              icon('link', 16),
              `Reconnect ${service.name}`,
            )
          : null;
      into.append(
        h(
          'section',
          { class: 'shelf', 'data-shelf': shelf.title },
          h('div', { class: 'shelf-head' }, h('h4', { text: shelf.title }), reconnect),
          shelf.note ? h('p', { class: 'shelf-note', text: shelf.note }) : null,
          items.length ? h('div', { class: `shelf-row ${wide ? 'wide' : ''}` }, items) : null,
        ),
      );
    }
    if (shown === 0) into.append(h('p', { class: 'shelf-note', text: `Nothing to show from ${service.name} yet. Search or paste a link above.` }));
  };

  const renderHome = (into: HTMLElement) => {
    if (!service.home) return;
    const key = homeKey();
    const refresh = h(
      'button',
      {
        class: 'btn small ghost',
        type: 'button',
        title: `Reload your ${service.name} home`,
        onClick: () => {
          homeCache.delete(service.id);
          renderBody();
        },
      },
      icon('refresh', 16),
      'Refresh',
    );
    into.append(h('div', { class: 'browse-head' }, h('h3', { text: `Your ${service.name}` }), refresh));
    const shelves = h('div', { class: 'shelves' });
    into.append(shelves);
    const cached = homeCache.get(service.id);
    if (cached && cached.at > Date.now() - HOME_TTL && cached.key === key) {
      drawShelves(shelves, cached.shelves);
      return;
    }
    shelves.append(h('p', { class: 'shelf-note loading', text: `Loading your ${service.name} home…` }));
    void service.home().then(
      (list) => {
        homeCache.set(service.id, { at: Date.now(), key, shelves: list });
        if (!shelves.isConnected) return;
        clear(shelves);
        drawShelves(shelves, list);
      },
      (error: unknown) => {
        if (!shelves.isConnected) return;
        clear(shelves);
        shelves.append(h('p', { class: 'note warn', text: `${service.name} home couldn't load: ${error instanceof Error ? error.message : String(error)}` }));
      },
    );
  };

  const renderResults = (into: HTMLElement, found: SearchResults, emptyText: string) => {
    into.append(backButton());
    const results = h('div', { class: 'results' });
    if (found.tracks.length === 0 && found.collections.length === 0) {
      results.append(h('p', { style: 'margin:10px 8px', text: emptyText }));
    }
    if (found.tracks.length) {
      results.append(h('h4', { text: 'Tracks' }));
      found.tracks.forEach((t) => results.append(trackRow(t)));
    }
    if (found.collections.length) {
      results.append(h('h4', { text: 'Albums & playlists' }));
      found.collections.forEach((c) => results.append(collectionRow(c)));
    }
    into.append(results);
  };

  const renderCollection = (into: HTMLElement, collection: Collection) => {
    into.append(backButton());
    const station = collection.contextOnly && collection.id.startsWith('stations:');
    const kindLabel = station ? 'Station' : collection.kind === 'album' ? 'Album' : 'Playlist';
    const cover = art(collection.artworkUrl, collection.id === 'liked');
    into.append(
      h(
        'div',
        { class: 'collection-head' },
        cover,
        h(
          'div',
          { class: 'collection-meta' },
          h('div', { class: 'eyebrow', text: `${service.name} ${kindLabel.toLowerCase()}` }),
          h('h3', { class: 'collection-title', text: collection.title }),
          collection.subtitle ? h('p', { class: 'collection-sub', text: collection.subtitle }) : null,
          h(
            'div',
            { class: 'actions' },
            h('button', { class: 'btn primary', type: 'button', onClick: () => void loadCollection(collection, true) }, icon('play', 18), 'Play'),
            h('button', { class: 'btn', type: 'button', onClick: () => void loadCollection(collection, false) }, icon('plus', 18), 'Add to queue'),
            h('button', { class: 'btn', type: 'button', title: 'Link to a Phosphor playlist (stays up to date)', onClick: (e: MouseEvent) => linkToPlaylist(e.currentTarget as HTMLElement, collection) }, icon('listPlus', 18), 'Add to a playlist'),
            saveButton(collection, 'btn-like'),
          ),
        ),
      ),
    );
    if (collection.contextOnly) {
      into.append(
        h(
          'p',
          { class: 'note' },
          station
            ? 'A station plays as a whole, the way Apple Music runs it. Phosphor shows each song as it comes up, and Next moves on within the station.'
            : `${service.name} doesn't let apps list the songs in its own playlists, but it will play them. Phosphor has ${service.name} play this as a whole: each song shows as it comes up, and Next and Previous move through it.`,
        ),
      );
      return;
    }
    const list = h('div', { class: 'results' }, h('p', { style: 'margin:10px 8px', text: 'Loading…' }));
    into.append(list);
    void service.tracksOf(collection).then(
      (tracks) => {
        clear(list);
        if (tracks.length === 0) list.append(h('p', { style: 'margin:10px 8px', text: 'Nothing playable in here.' }));
        // A Spotify-made playlist can only be played whole: offer exactly that.
        if (tracks.length === 1 && tracks[0].context) {
          list.append(h('p', { class: 'note', text: `${service.name} doesn't let apps list this playlist's songs, but Phosphor can have ${service.name} play it as a whole.` }));
          return;
        }
        tracks.forEach((t) => list.append(trackRow(t)));
      },
      (error: unknown) => {
        clear(list);
        list.append(h('p', { class: 'note warn', text: error instanceof Error ? error.message : String(error) }));
      },
    );
  };

  const renderBody = () => {
    clear(body);
    if (!service.status().connected) return;
    if (view.kind === 'results') renderResults(body, view.found, view.emptyText);
    else if (view.kind === 'collection') renderCollection(body, view.collection);
    else renderHome(body);
  };

  // ----------------------------------------------------- search, links

  const run = async (work: () => Promise<View | null>) => {
    if (busy) return;
    busy = true;
    const waiting = h('p', { class: 'shelf-note loading', text: 'Loading…' });
    body.prepend(waiting);
    try {
      const next = await work();
      if (next) go(next);
    } catch (error) {
      fail(error);
    } finally {
      waiting.remove();
      busy = false;
    }
  };

  const renderTools = () => {
    clear(tools);
    if (!service.status().connected) return;
    if (service.canSearch()) {
      const query = h('input', { class: 'input', type: 'search', placeholder: `Search ${service.name}`, 'aria-label': `Search ${service.name}` });
      const search = () => {
        const q = query.value.trim();
        if (q) void run(async () => ({ kind: 'results', found: await service.search(q), emptyText: `Nothing found for "${q}".` }));
      };
      query.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') search();
      });
      tools.append(h('div', { class: 'input-row' }, query, h('button', { class: 'btn', type: 'button', onClick: search }, icon('search', 18), 'Search')));
    } else if (service.searchUnavailable) {
      tools.append(h('p', { class: 'note', text: service.searchUnavailable() }));
    }

    const link = h('input', { class: 'input', type: 'url', placeholder: `Paste a ${service.linkHint}`, 'aria-label': 'Paste a link' });
    const open = () => {
      const url = link.value.trim();
      if (!url) return;
      void run(async () => {
        const found = await service.resolveLink(url);
        if (!found) {
          app.toast(`That doesn't look like a ${service.linkHint}.`, 'error');
          return null;
        }
        link.value = '';
        // Opening a Spotify-made playlist pins it to the home view.
        homeCache.delete(service.id);
        if (found.tracks.length === 0 && found.collections.length === 1) return { kind: 'collection', collection: found.collections[0] };
        return { kind: 'results', found, emptyText: 'Nothing playable at that link.' };
      });
    };
    link.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') open();
    });
    tools.append(h('div', { class: 'input-row', style: 'margin-top:10px' }, link, h('button', { class: 'btn', type: 'button', onClick: open }, icon('link', 18), 'Open link')));
  };

  // --------------------------------------------------------------- head

  const renderHead = () => {
    const status = service.status();
    clear(head);
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
      return;
    }
    if (!status.connected) {
      if (status.problem) head.append(h('p', { class: 'note warn', text: status.problem }));
      head.append(
        h(
          'div',
          { class: 'actions' },
          h('button', { class: 'btn primary', type: 'button', onClick: () => void service.connect().catch(fail) }, icon('link', 18), `Connect ${service.name}`),
          h('button', { class: 'btn', type: 'button', onClick: () => app.openSheet('settings', service.id) }, 'Settings'),
        ),
      );
      return;
    }
    const optionalSignedIn = service.account?.status().signedIn === true;
    if (!optionalSignedIn) {
      head.append(
        h(
          'div',
          { class: 'note ok', style: 'display:flex;align-items:center;justify-content:space-between;gap:12px' },
          h('span', null, status.label ?? 'Connected', status.account && service.signIn !== false ? h('span', null, ' as ', h('strong', { text: status.account })) : null),
          service.signIn === false ? null : h('button', { class: 'btn small', type: 'button', onClick: () => service.disconnect() }, 'Disconnect'),
        ),
      );
    }
    if (status.problem) head.append(h('p', { class: 'note warn', text: status.problem }));

    // An optional sign-in that adds to the service (YouTube: Google).
    const account = service.account;
    if (account) {
      const a = account.status();
      if (a.signedIn) {
        head.append(
          h(
            'div',
            { class: 'note ok account-note', style: 'display:flex;align-items:center;justify-content:space-between;gap:12px' },
            h('span', null, 'Signed in with Google', a.name ? h('span', null, ' as ', h('strong', { text: a.name })) : null),
            h('button', { class: 'btn small', type: 'button', onClick: () => account.signOut() }, 'Sign out'),
          ),
        );
      } else if (a.available) {
        if (a.problem) head.append(h('p', { class: 'note warn', text: a.problem }));
        head.append(
          h(
            'div',
            { class: 'account-offer' },
            h('button', { class: 'btn', type: 'button', onClick: () => void account.signIn().catch(fail) }, icon('link', 18), account.signInLabel),
            h('span', { class: 'hint-text', text: account.benefit }),
          ),
        );
      } else if (a.setupHint) {
        head.append(h('p', { class: 'hint-text', style: 'margin:0 0 12px' }, a.setupHint, ' ', h('button', { class: 'link-like', type: 'button', text: 'Open Settings', onClick: () => app.openSheet('settings', service.id) })));
      }
    }
  };

  const renderFoot = () => {
    clear(foot);
    foot.append(h('h3', { text: 'How this works, and its limits' }), h('ul', null, service.limits.map((text) => h('li', { text }))));
  };

  const render = () => {
    renderHead();
    renderTools();
    renderBody();
  };

  let lastKey = homeKey();
  const off = service.onStatus(() => {
    renderHead();
    // Status changes often (a device coming and going, the account name arriving):
    // only rebuild the rest when what it shows would change.
    const key = homeKey();
    if (key === lastKey) return;
    lastKey = key;
    if (!service.status().connected) {
      view = { kind: 'home' };
      history.length = 0;
    }
    renderTools();
    renderBody();
  });
  render();
  renderFoot();
  root.append(head, tools, body, foot);
  (root as HTMLElement & { cleanup?: () => void }).cleanup = off;
  return root;
}
