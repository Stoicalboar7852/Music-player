// Top bar: brand, capture indicator, visualizer switcher, auto-cycle, stats.

import type { App } from '../app/app';
import { settings } from '../app/settings';
import { h, iconButton } from './dom';

export function createTopbar(app: App) {
  const { renderer, capture } = app;

  const bars = [0, 1, 2, 3].map(() => h('i', { style: 'height:30%' }));
  const brand = h('div', { class: 'brand' }, h('div', { class: 'brand-mark' }, bars), h('span', { text: 'Phosphor' }));

  const chipLabel = h('span');
  const chip = h(
    'div',
    { class: 'chip glass', hidden: true },
    h('i', { class: 'dot' }),
    chipLabel,
    iconButton('close', 'Stop capturing', () => capture.stop()),
  );

  const family = h('small');
  const name = h('span');
  const nameBtn = h(
    'button',
    { class: 'viz-name', type: 'button', title: 'Choose a visualizer (G)', onClick: () => app.openSheet('gallery') },
    family,
    name,
  );
  const auto = iconButton('sparkles', 'Auto-cycle visualizers (A)', () => app.setAutoCycle(!settings.get('autoCycle')));
  const stats = h('div', { class: 'stats glass', hidden: true });

  const el = h(
    'header',
    { class: 'topbar' },
    h('div', { style: 'display:flex;align-items:center;gap:14px;min-width:0' }, brand, chip),
    h(
      'div',
      { class: 'top-right' },
      stats,
      h(
        'div',
        { class: 'viz-switch glass' },
        iconButton('chevronLeft', 'Previous visualizer (←)', () => app.stepVisualizer(-1)),
        nameBtn,
        iconButton('chevronRight', 'Next visualizer (→)', () => app.stepVisualizer(1)),
      ),
      h('div', { class: 'viz-switch glass' }, auto),
      h('div', { class: 'viz-switch glass hide-narrow' }, iconButton('keyboard', 'Keyboard shortcuts (?)', () => app.openSheet('shortcuts'))),
    ),
  );

  const render = () => {
    const def = renderer.currentDef;
    family.textContent = def ? def.family : '';
    name.textContent = def?.name ?? 'No visualizer';
    auto.classList.toggle('on', settings.get('autoCycle'));
    auto.title = settings.get('autoCycle')
      ? `Auto-cycle is on: every ${settings.get('cycleSeconds')}s (A)`
      : 'Auto-cycle visualizers (A)';
    chip.hidden = !capture.state.active;
    chipLabel.textContent = capture.state.label;
    stats.hidden = !settings.get('showStats');
  };
  capture.on('change', render);
  settings.on('change', render);

  /** ~20 times a second: animate the brand mark from the live analysis, refresh stats. */
  const tick = () => {
    const a = renderer.audio;
    const levels = [a.bass, a.mid, a.treble, a.level];
    for (let i = 0; i < 4; i++) bars[i].style.height = `${Math.round(22 + 78 * Math.min(1, levels[i] * 1.3))}%`;
    if (!stats.hidden) {
      const s = renderer.stats;
      stats.textContent = `${s.fps.toFixed(0)} fps  ${s.frameMs.toFixed(1)} ms\n${s.width}×${s.height}  ×${s.scale.toFixed(2)}`;
    }
  };

  render();
  return { el, render, tick };
}
