// The visualizer gallery: pick one, filter by family, set up auto-cycling.

import type { App } from '../app/app';
import { settings } from '../app/settings';
import type { Family } from '../viz/types';
import { clear, h } from './dom';

export const CYCLE_CHOICES: [number, string][] = [
  [15, '15 seconds'],
  [30, '30 seconds'],
  [45, '45 seconds'],
  [60, '1 minute'],
  [120, '2 minutes'],
  [300, '5 minutes'],
];

export function toggle(checked: boolean, label: string, onChange: (value: boolean) => void): HTMLButtonElement {
  const el = h('button', { class: 'switch', type: 'button', role: 'switch', 'aria-checked': String(checked), 'aria-label': label });
  el.addEventListener('click', () => {
    const next = el.getAttribute('aria-checked') !== 'true';
    el.setAttribute('aria-checked', String(next));
    onChange(next);
  });
  return el;
}

export function segmented<T extends string>(options: [T, string][], value: T, onChange: (value: T) => void): HTMLElement {
  const el = h('div', { class: 'segmented', role: 'radiogroup' });
  for (const [key, label] of options) {
    const button = h('button', { type: 'button', role: 'radio', class: key === value ? 'active' : '', text: label });
    button.addEventListener('click', () => {
      el.querySelectorAll('button').forEach((b) => b.classList.remove('active'));
      button.classList.add('active');
      onChange(key);
    });
    el.append(button);
  }
  return el;
}

export function select<T extends string | number>(options: [T, string][], value: T, onChange: (value: T) => void, cls = 'input'): HTMLSelectElement {
  const el = h('select', { class: cls });
  for (const [key, label] of options) el.append(h('option', { value: String(key), text: label, selected: key === value }));
  el.addEventListener('change', () => {
    const picked = options.find(([key]) => String(key) === el.value);
    if (picked) onChange(picked[0]);
  });
  return el;
}

export function openGallery(app: App) {
  const { renderer } = app;
  let filter: Family | 'all' = 'all';
  const grid = h('div', { class: 'gallery' });

  const render = () => {
    clear(grid);
    renderer.defs.forEach((def, index) => {
      if (filter !== 'all' && def.family !== filter) return;
      const key = index < 9 ? String(index + 1) : index === 9 ? '0' : '';
      const card = h(
        'button',
        { class: `card ${renderer.currentId === def.id ? 'current' : ''}`, type: 'button', 'data-id': def.id },
        h('div', { class: 'card-thumb', style: `background-image:url("./thumbs/${def.id}.jpg")` }),
        key ? h('span', { class: 'key', text: key }) : null,
        h(
          'div',
          { class: 'card-body' },
          h('div', { class: 'card-name' }, def.name, h('span', { class: 'tag', text: def.family })),
          h('div', { class: 'card-desc', text: def.description }),
        ),
      );
      card.addEventListener('click', () => {
        app.setVisualizer(def.id);
        grid.querySelectorAll('.card').forEach((c) => c.classList.toggle('current', c === card));
      });
      grid.append(card);
    });
  };

  const bar = h(
    'div',
    { class: 'gallery-bar' },
    segmented<Family | 'all'>(
      [
        ['all', 'All'],
        ['classic', 'Classic'],
        ['modern', 'Modern'],
      ],
      filter,
      (value) => {
        filter = value;
        render();
      },
    ),
    h(
      'label',
      { class: 'inline-label' },
      'Auto-cycle',
      toggle(settings.get('autoCycle'), 'Auto-cycle visualizers', (on) => app.setAutoCycle(on)),
    ),
    h(
      'label',
      { class: 'inline-label' },
      'every',
      select(CYCLE_CHOICES, settings.get('cycleSeconds'), (seconds) => settings.set({ cycleSeconds: seconds }), 'compact'),
    ),
  );

  render();
  return { body: h('div', null, grid), headerExtras: [bar] };
}
