// The Present panel: everything about the presenter window, from the main
// window. It opens under the Present button in the top bar and stays open
// while you need it: what the presenter is doing, where it is, and the
// overlays (QR code, title, logo, blackout, freeze), which only switch on here.

import type { App } from '../app/app';
import { desktop } from '../app/desktop';
import { settings } from '../app/settings';
import type { PresenterHost, ScreenChoice } from '../present/host';
import { screenPermission, type Overlays } from '../present/protocol';
import { clear, h, icon, iconButton } from './dom';
import type { IconName } from './icons';

const TILES: { key: keyof Overlays; label: string; icon: IconName; shortcut: string }[] = [
  { key: 'qr', label: 'QR code', icon: 'qr', shortcut: 'Shift+Q' },
  { key: 'title', label: 'Title', icon: 'lowerThird', shortcut: 'Shift+T' },
  { key: 'logo', label: 'Logo', icon: 'badge', shortcut: 'Shift+L' },
  { key: 'blackout', label: 'Blackout', icon: 'moon', shortcut: 'Shift+B' },
  { key: 'freeze', label: 'Freeze', icon: 'snowflake', shortcut: 'Shift+Z' },
];

export function createPresenterPanel(app: App, host: PresenterHost) {
  const status = h('div', { class: 'pp-status' });
  const statusText = h('span');
  status.append(h('i', { class: 'dot' }), statusText);
  const notice = h('p', { class: 'pp-notice', hidden: true });

  const tiles = new Map<keyof Overlays, HTMLButtonElement>();
  const tileGrid = h(
    'div',
    { class: 'pp-tiles' },
    TILES.map((t) => {
      const button = h(
        'button',
        {
          class: `pp-tile pp-${t.key}`,
          type: 'button',
          'aria-pressed': 'false',
          title: `${t.label} (${t.shortcut})`,
          onClick: () => host.toggleOverlay(t.key),
        },
        icon(t.icon, 22),
        h('span', { text: t.label }),
      );
      tiles.set(t.key, button);
      return button;
    }),
  );
  const qrNote = h('p', { class: 'pp-hint' });

  const screens = h('div', { class: 'pp-screens' });
  const fillButton = h('button', { class: 'btn small', type: 'button', onClick: () => void chooseScreen() }, icon('fullscreen', 16), 'Fill a screen');
  const closeButton = h('button', { class: 'btn small ghost', type: 'button', onClick: () => host.close() }, 'Close presenter');
  const openButton = h('button', { class: 'btn small primary', type: 'button', onClick: () => host.open() }, icon('present', 16), 'Open presenter');

  const sizes = h(
    'div',
    { class: 'segmented', role: 'radiogroup', 'aria-label': 'QR code size' },
    (['small', 'medium', 'large'] as const).map((size) =>
      h('button', { type: 'button', 'data-size': size, onClick: () => settings.set({ presenterQrSize: size }) }, size[0].toUpperCase() + size.slice(1)),
    ),
  );
  const logoInput = h('input', { type: 'file', accept: 'image/*', hidden: true });
  logoInput.addEventListener('change', () => {
    const file = logoInput.files?.[0];
    logoInput.value = '';
    if (file) void host.setLogo(file).catch(() => app.toast("That image couldn't be used as a logo.", 'error'));
  });
  const previewSwitch = h('button', {
    class: 'switch',
    type: 'button',
    role: 'switch',
    'aria-label': 'Preview in this window',
    onClick: () => host.setPreview(!host.preview),
  });
  const logoPreview = h('img', { class: 'pp-logo-preview', alt: '' });
  const removeLogo = h('button', { class: 'btn small ghost', type: 'button', onClick: () => void host.setLogo(null) }, 'Use Phosphor\'s');

  const el = h(
    'section',
    { class: 'presenter-panel glass', 'aria-label': 'Presenter', hidden: true },
    h('header', null, h('h3', { text: 'Presenter' }), iconButton('close', 'Hide this panel (D)', () => hide())),
    status,
    notice,
    h('div', { class: 'pp-actions' }, openButton, fillButton, closeButton),
    screens,
    tileGrid,
    qrNote,
    h('div', { class: 'pp-row' }, h('span', { text: 'QR code size' }), sizes),
    h('div', { class: 'pp-row', title: 'Off: this window keeps its last picture while the presenter shows the visuals, which saves graphics power on a laptop.' }, h('span', { text: 'Preview in this window' }), previewSwitch),
    h(
      'div',
      { class: 'pp-row' },
      h('span', { text: 'Logo' }),
      h('div', { class: 'pp-logo' }, logoPreview, h('button', { class: 'btn small', type: 'button', onClick: () => logoInput.click() }, 'Choose image…'), removeLogo),
    ),
    logoInput,
  );

  async function chooseScreen() {
    clear(screens);
    if (desktop?.presenterDisplays) {
      // The desktop app places the window itself.
      const list = await desktop.presenterDisplays();
      if (list.length <= 1) {
        desktop.presentOn?.(list[0]?.id ?? null);
        return;
      }
      screens.append(
        h('p', { class: 'pp-hint', text: 'Fill which screen?' }),
        ...list.map((d) => h('button', { class: 'btn small', type: 'button', onClick: () => (desktop?.presentOn?.(d.id), clear(screens)) }, d.label)),
      );
      return;
    }
    // The click that goes full screen is handed to the presenter window, and a
    // click only counts for a few seconds: never wait on a permission prompt first.
    const permission = await screenPermission();
    if (permission === 'unsupported' || permission === 'denied') {
      host.fullscreen(null);
      return;
    }
    const asked = permission === 'prompt';
    const list: ScreenChoice[] = await host.listScreens().catch(() => []);
    if (list.length <= 1 && !asked) {
      host.fullscreen(null);
      return;
    }
    const pick = (label: string, screen: ScreenChoice | null) =>
      h(
        'button',
        {
          class: 'btn small',
          type: 'button',
          onClick: () => {
            host.fullscreen(screen ? { left: screen.left, top: screen.top } : null);
            clear(screens);
          },
        },
        label,
      );
    screens.append(
      h('p', { class: 'pp-hint', text: list.length > 1 ? 'Fill which screen?' : 'Fill the screen the presenter is on:' }),
      ...(list.length > 1 ? list.map((s) => pick(`${s.label}${s.current ? ' (this one)' : ''}`, s)) : [pick('Fill it', null)]),
    );
  }

  function render() {
    const s = host.status;
    const stats = host.stats;
    el.dataset.status = s;
    status.dataset.status = s;
    if (s === 'open' && stats) {
      const where = stats.fullscreen ? `full screen${stats.screen ? ` on ${stats.screen}` : ''}` : `in a window${stats.screen ? ` on ${stats.screen}` : ''}`;
      const behind = stats.latency.mean > 0 ? ` · ${Math.round(stats.latency.mean)} ms behind` : '';
      statusText.textContent = `Showing ${where} · ${Math.round(stats.fps)} fps${behind}${host.presenters > 1 ? ` · ${host.presenters} windows` : ''}`;
    } else if (s === 'open') statusText.textContent = 'Showing';
    else if (s === 'opening') statusText.textContent = 'Opening…';
    else statusText.textContent = 'Not showing. Open the presenter, then drag it to the audience screen or fill a screen from here.';
    notice.hidden = !host.notice;
    notice.textContent = host.notice;
    openButton.hidden = s !== 'closed';
    fillButton.hidden = closeButton.hidden = s === 'closed';
    if (s === 'closed') clear(screens);

    for (const t of TILES) {
      const button = tiles.get(t.key)!;
      const on = host.overlays[t.key];
      button.classList.toggle('on', on);
      button.setAttribute('aria-pressed', String(on));
    }
    const link = host.link;
    const track = app.player.current;
    qrNote.textContent = link
      ? `The QR code opens ${link.replace(/^https:\/\//, '')}`
      : track?.source === 'local'
        ? 'Local files have no link to scan, so the QR code stays hidden for them.'
        : track
          ? 'This song has no link to scan, so the QR code stays hidden.'
          : 'The QR code links to the playing song on its service (Spotify, Apple Music or YouTube).';
    tiles.get('qr')!.classList.toggle('unavailable', !link);

    for (const button of sizes.querySelectorAll<HTMLButtonElement>('button')) {
      button.setAttribute('aria-checked', String(button.dataset.size === settings.get('presenterQrSize')));
      button.classList.toggle('active', button.dataset.size === settings.get('presenterQrSize'));
    }
    previewSwitch.setAttribute('aria-checked', String(host.preview));
    logoPreview.hidden = !host.logo;
    if (host.logo) logoPreview.src = host.logo;
    removeLogo.hidden = !host.logo;
  }

  function show() {
    el.hidden = false;
    render();
  }
  function hide() {
    el.hidden = true;
  }

  host.on('change', render);
  app.player.on('track', () => !el.hidden && render());
  settings.on('change', (patch) => 'presenterQrSize' in patch && render());

  return {
    el,
    show,
    hide,
    get open() {
      return !el.hidden;
    },
    toggle() {
      if (el.hidden) show();
      else hide();
    },
  };
}
