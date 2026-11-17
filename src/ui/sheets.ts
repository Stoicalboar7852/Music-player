// Modal sheets (gallery, sources, settings, shortcuts). One at a time.

import { h, iconButton } from './dom';

export interface SheetOptions {
  title: string;
  /** Extra controls placed in the header, left of the close button. */
  headerExtras?: Node[];
  /** Body is a two-column tabs + panel layout rather than a scrolling column. */
  split?: boolean;
  narrow?: boolean;
  onClose?: () => void;
}

export function createSheets(host: HTMLElement) {
  let current: { backdrop: HTMLElement; onClose?: () => void; name: string } | null = null;

  const close = () => {
    if (!current) return;
    const { backdrop, onClose } = current;
    current = null;
    backdrop.classList.remove('open');
    setTimeout(() => backdrop.remove(), 220);
    onClose?.();
  };

  const open = (name: string, body: HTMLElement, opts: SheetOptions) => {
    close();
    body.classList.add('sheet-body');
    if (opts.split) body.classList.add('split');
    const sheet = h(
      'div',
      { class: `sheet glass ${opts.narrow ? 'narrow' : ''}`, role: 'dialog', 'aria-modal': 'true', 'aria-label': opts.title },
      h(
        'div',
        { class: 'sheet-head' },
        h('h2', { text: opts.title }),
        h('div', { class: 'spacer' }),
        opts.headerExtras ?? null,
        iconButton('close', 'Close (Esc)', close),
      ),
      body,
    );
    const backdrop = h('div', { class: 'backdrop' }, sheet);
    backdrop.addEventListener('mousedown', (e) => {
      if (e.target === backdrop) close();
    });
    host.append(backdrop);
    current = { backdrop, onClose: opts.onClose, name };
    requestAnimationFrame(() => backdrop.classList.add('open'));
  };

  return {
    open,
    close,
    get isOpen() {
      return current !== null;
    },
    get openName() {
      return current?.name ?? null;
    },
  };
}
