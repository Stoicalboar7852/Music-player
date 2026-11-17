// Keyboard shortcuts, and the sheet that lists them.

import type { App } from '../app/app';
import { settings } from '../app/settings';
import { h } from './dom';

const SHORTCUTS: [keys: string[], what: string][] = [
  [['Space'], 'Play / pause'],
  [['←', '→'], 'Previous / next visualizer'],
  [['Shift', '←', '→'], 'Previous / next variation (MilkDrop preset)'],
  [['1', '…', '0'], 'Jump to a visualizer'],
  [['A'], 'Auto-cycle visualizers on / off'],
  [['G'], 'Visualizer gallery'],
  [['↑', '↓'], 'Volume up / down'],
  [['M'], 'Mute'],
  [['N', 'P'], 'Next / previous track'],
  [['J', 'L'], 'Seek back / forward 10 seconds'],
  [['S'], 'Shuffle'],
  [['R'], 'Repeat: off, all, one'],
  [['Q'], 'Queue'],
  [['O'], 'Add music'],
  [['C'], 'Capture system or tab audio'],
  [['F'], 'Fullscreen (or double-click the visuals)'],
  [[','], 'Settings'],
  [['?'], 'This list'],
  [['Esc'], 'Close whatever is open'],
];

export function openShortcuts() {
  const body = h(
    'div',
    null,
    h(
      'div',
      { class: 'shortcut-grid' },
      SHORTCUTS.map(([keys, what]) =>
        h('div', { class: 'shortcut' }, h('span', { text: what }), h('span', null, keys.map((k) => (k === '…' ? '…' : h('kbd', { text: k }))))),
      ),
    ),
    h('p', { style: 'margin-top:18px' }, 'Media keys and headset buttons control playback too.'),
  );
  return { body };
}

export function installShortcuts(app: App, ui: { sheetOpen: () => boolean; queueOpen: () => boolean }) {
  const { player, renderer } = app;

  window.addEventListener('keydown', (e) => {
    const target = e.target as HTMLElement | null;
    const typing = target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT' || target.isContentEditable);
    const isRange = target instanceof HTMLInputElement && target.type === 'range';

    if (e.key === 'Escape') {
      if (ui.sheetOpen()) app.closeSheet();
      else if (ui.queueOpen()) app.toggleQueue(false);
      else if (typing) target.blur();
      return;
    }
    if ((typing && !isRange) || e.metaKey || e.ctrlKey || e.altKey) return;
    // With a sheet open only its own controls should react.
    if (ui.sheetOpen() && e.key !== '?') return;

    const handled = () => {
      e.preventDefault();
      // Don't leave focus on a button where Space would click it a second time.
      if (target instanceof HTMLButtonElement) target.blur();
    };

    switch (e.key) {
      case ' ':
        handled();
        void player.toggle();
        return;
      case 'ArrowRight':
        handled();
        if (e.shiftKey) renderer.nextVariant(1);
        else app.stepVisualizer(1);
        return;
      case 'ArrowLeft':
        handled();
        if (e.shiftKey) renderer.nextVariant(-1);
        else app.stepVisualizer(-1);
        return;
      case 'ArrowUp':
        handled();
        player.setVolume(player.volume + 0.05);
        return;
      case 'ArrowDown':
        handled();
        player.setVolume(player.volume - 0.05);
        return;
      case '?':
        handled();
        app.openSheet('shortcuts');
        return;
      case ',':
        handled();
        app.openSheet('settings');
        return;
    }

    if (/^[0-9]$/.test(e.key)) {
      const index = e.key === '0' ? 9 : Number(e.key) - 1;
      const def = renderer.defs[index];
      if (def) {
        handled();
        app.setVisualizer(def.id);
      }
      return;
    }

    switch (e.key.toLowerCase()) {
      case 'n':
        void player.next();
        break;
      case 'p':
        void player.previous();
        break;
      case 'j':
        void player.seekBy(-10);
        break;
      case 'l':
        void player.seekBy(10);
        break;
      case 's':
        player.setShuffle(!player.shuffle);
        app.toast(player.shuffle ? 'Shuffle on' : 'Shuffle off');
        break;
      case 'r':
        player.cycleRepeat();
        app.toast(`Repeat: ${player.repeat}`);
        break;
      case 'm':
        player.toggleMute();
        break;
      case 'f':
        app.toggleFullscreen();
        break;
      case 'g':
        app.openSheet('gallery');
        break;
      case 'q':
        app.toggleQueue();
        break;
      case 'o':
        app.openSheet('sources');
        break;
      case 'c':
        void app.startCapture();
        break;
      case 'a':
        app.setAutoCycle(!settings.get('autoCycle'));
        break;
      default:
        return;
    }
    handled();
  });
}
