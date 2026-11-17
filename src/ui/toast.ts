import { h } from './dom';

export function createToasts() {
  const el = h('div', { class: 'toasts', role: 'status', 'aria-live': 'polite' });
  let last = '';
  let lastAt = 0;
  return {
    el,
    show(message: string, kind: 'info' | 'error' = 'info') {
      // The same message twice in quick succession is noise.
      const now = performance.now();
      if (message === last && now - lastAt < 2500) return;
      last = message;
      lastAt = now;
      const toast = h('div', { class: `toast ${kind}`, text: message });
      el.append(toast);
      while (el.children.length > 4) el.firstElementChild?.remove();
      const life = kind === 'error' ? 7000 : 3200;
      setTimeout(() => {
        toast.classList.add('leaving');
        setTimeout(() => toast.remove(), 320);
      }, life);
    },
  };
}
