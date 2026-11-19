// The first screen: every way to start music, including the streaming
// services with their live connection state. Shown until something plays.

import { androidBridge } from '../app/android';
import type { App } from '../app/app';
import { browserLimitation } from '../app/browser';
import { installer } from '../app/install';
import type { MusicService } from '../services/types';
import { clear, h, icon } from './dom';

/** A phone or tablet: a touchscreen and no mouse, so no dragging files in and no keyboard. */
function touchOnly(): boolean {
  return matchMedia('(hover: none) and (pointer: coarse)').matches;
}

function tileStatus(service: MusicService): { text: string; state: 'on' | 'ready' | 'off' } {
  const status = service.status();
  if (status.connected) {
    if (service.signIn === false) {
      const account = service.account?.status();
      if (account?.signedIn) return { text: account.name ? `Signed in as ${account.name}` : 'Signed in', state: 'on' };
      return { text: status.label?.startsWith('Ready: links and search') ? 'Search and links' : 'Paste a link', state: 'on' };
    }
    return { text: status.account ? `Connected as ${status.account}` : 'Connected', state: 'on' };
  }
  if (!status.configured) return { text: service.id === 'spotify' ? 'Set up (needs Premium)' : 'Set up', state: 'off' };
  return { text: 'Connect', state: 'ready' };
}

export function createWelcome(app: App) {
  const tiles = h('div', { class: 'service-tiles' });
  const extra = h('div');

  const renderTiles = () => {
    clear(tiles);
    for (const service of app.services) {
      const { text, state } = tileStatus(service);
      const tile = h(
        'button',
        { class: `service-tile ${state}`, type: 'button', 'data-service': service.id, title: `${service.name}: ${text}` },
        h('span', { class: 'service-name' }, h('i', { class: 'status-dot' }), service.name),
        h('span', { class: 'service-state', text }),
      );
      tile.addEventListener('click', () => {
        const status = service.status();
        if (!status.configured) {
          app.openSheet('settings', service.id);
          return;
        }
        if (!status.connected) {
          // Connecting may open the service's sign-in window, which needs this click.
          void service.connect().then(
            () => app.openSheet('sources', service.id),
            (error: unknown) => app.toast(error instanceof Error ? error.message : String(error), 'error'),
          );
          return;
        }
        app.openSheet('sources', service.id);
      });
      tiles.append(tile);
    }
  };

  const el = h(
    'div',
    { class: 'welcome glass' },
    h('h1', { text: 'Put some music on' }),
    h('p', {
      text: touchOnly()
        ? 'Pick some music, or a source. Then sit back.'
        : 'Drop audio files anywhere on this window, or pick a source. Then press F and sit back.',
    }),
    h(
      'div',
      { class: 'actions' },
      h('button', { class: 'btn primary', type: 'button', onClick: () => app.openFilePicker() }, icon('file', 18), 'Open files'),
      // iPhone and iPad can't pick a folder from a web page.
      installer.ios ? null : h('button', { class: 'btn', type: 'button', onClick: () => void app.openFolderPicker() }, icon('folder', 18), 'Open folder'),
      h('button', { class: 'btn', type: 'button', onClick: () => void app.playDemo() }, icon('sparkles', 18), 'Play demo'),
    ),
    h('div', { class: 'welcome-label', text: 'Streaming' }),
    tiles,
    app.capture.supported
      ? h(
          'button',
          { class: 'welcome-link', type: 'button', onClick: () => app.openSheet('sources', 'capture') },
          icon('capture', 18),
          h('span', null, h('strong', { text: 'Visualize anything playing on this computer' }), h('span', { text: 'Share system or tab audio' })),
          icon('chevronRight', 18),
        )
      : androidBridge
        ? // The Android app hears what the phone plays, without the microphone.
          h(
            'button',
            { class: 'welcome-link', type: 'button', onClick: () => void app.listenToPhone() },
            icon('capture', 18),
            h('span', null, h('strong', { text: 'Visualize what this phone plays' }), h('span', { text: 'The Spotify app, YouTube Music, any app: no microphone' })),
            icon('chevronRight', 18),
          )
        : // Phones and tablets can't share other apps' audio with a page; the microphone can hear it.
        h(
          'button',
          {
            class: 'welcome-link',
            type: 'button',
            onClick: () =>
              void app.capture.startInput().then(
                () => app.toast('Listening through the microphone. Play some music nearby.'),
                (error: unknown) => app.toast(error instanceof Error ? error.message : String(error), 'error'),
              ),
          },
          icon('mic', 18),
          h('span', null, h('strong', { text: 'Visualize music playing nearby' }), h('span', { text: 'Listen through the microphone' })),
          icon('chevronRight', 18),
        ),
    extra,
    browserLimitation() ? h('p', { class: 'note warn', style: 'text-align:left;margin:14px auto 0', text: browserLimitation()! }) : null,
    h('small', null, 'Press ', h('kbd', { text: '?' }), ' for keyboard shortcuts'),
  );

  for (const service of app.services) service.onStatus(renderTiles);
  renderTiles();

  return {
    el,
    /** A slot below the main actions for content added by other modules (e.g. playlists). */
    extra,
    set hidden(value: boolean) {
      el.classList.toggle('gone', value);
    },
  };
}
