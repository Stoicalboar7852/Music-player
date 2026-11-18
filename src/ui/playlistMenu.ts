// A small floating menu: "add this to which playlist?"

import type { App } from '../app/app';
import { h } from './dom';

let openMenu: HTMLElement | null = null;

function close() {
  openMenu?.remove();
  openMenu = null;
}

/**
 * Shows the user's Phosphor playlists next to `anchor`. Picking one (or "New
 * playlist") calls `add` with its id. `label` describes what is being added.
 */
export function openPlaylistMenu(app: App, anchor: HTMLElement, label: string, add: (playlistId: string) => Promise<void>) {
  close();
  const run = async (id: string, name: string) => {
    close();
    try {
      await add(id);
      app.toast(`Added ${label} to "${name}"`);
    } catch (error) {
      app.toast(error instanceof Error ? error.message : String(error), 'error');
    }
  };
  const menu = h(
    'div',
    { class: 'menu glass', role: 'menu' },
    h('div', { class: 'menu-title', text: `Add ${label} to` }),
    app.library.playlists.map((p) =>
      h('button', { class: 'menu-item', type: 'button', role: 'menuitem', onClick: () => void run(p.id, p.name) }, h('span', { text: p.name }), h('small', { text: app.library.summary(p.id) })),
    ),
    h(
      'button',
      {
        class: 'menu-item new',
        type: 'button',
        role: 'menuitem',
        onClick: async () => {
          const playlist = await app.library.create('New playlist');
          await run(playlist.id, playlist.name);
        },
      },
      h('span', { text: '+ New playlist' }),
    ),
  );
  document.body.append(menu);
  openMenu = menu;
  // Place it beside the button, kept on screen.
  const rect = anchor.getBoundingClientRect();
  const width = menu.offsetWidth;
  const height = menu.offsetHeight;
  const left = Math.max(12, Math.min(window.innerWidth - width - 12, rect.right - width));
  const top = rect.bottom + 6 + height < window.innerHeight ? rect.bottom + 6 : Math.max(12, rect.top - height - 6);
  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;
  setTimeout(() => {
    const away = (e: Event) => {
      if (!menu.contains(e.target as Node)) {
        close();
        window.removeEventListener('pointerdown', away, true);
      }
    };
    window.addEventListener('pointerdown', away, true);
  });
}

export function closePlaylistMenu() {
  close();
}
