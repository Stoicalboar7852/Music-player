// A tiny hyperscript helper: the whole interface is plain DOM, no framework.

import { ICONS, type IconName } from './icons';

type Child = Node | string | number | null | undefined | false | Child[];
type Props = Record<string, unknown> | null;

function append(parent: Node, child: Child) {
  if (child === null || child === undefined || child === false) return;
  if (Array.isArray(child)) child.forEach((c) => append(parent, c));
  else parent.appendChild(child instanceof Node ? child : document.createTextNode(String(child)));
}

/**
 * h('button', { class: 'x', onClick: fn, title: 'Hi' }, 'label')
 * `on*` props become event listeners, `class`/`text`/`style` are set directly,
 * `true` sets a bare attribute, `false`/null/undefined is skipped.
 */
export function h<K extends keyof HTMLElementTagNameMap>(tag: K, props?: Props, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props ?? {})) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class') el.className = String(value);
    else if (key === 'text') el.textContent = String(value);
    else if (key === 'style') el.style.cssText = String(value);
    else if (key.startsWith('on') && typeof value === 'function') {
      el.addEventListener(key.slice(2).toLowerCase(), value as EventListener);
    } else if (value === true) el.setAttribute(key, '');
    else el.setAttribute(key, String(value));
  }
  children.forEach((c) => append(el, c));
  return el;
}

export function icon(name: IconName, size = 20): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('aria-hidden', 'true');
  svg.classList.add('icon');
  svg.innerHTML = ICONS[name];
  return svg;
}

/** An icon-only button with an accessible label and tooltip. */
export function iconButton(name: IconName, label: string, onClick: (event: MouseEvent) => void, cls = ''): HTMLButtonElement {
  return h('button', { class: `icon-btn ${cls}`.trim(), type: 'button', title: label, 'aria-label': label, onClick }, icon(name));
}

export function setIcon(button: HTMLElement, name: IconName, size = 20) {
  button.querySelector('svg')?.replaceWith(icon(name, size));
}

export function clear(el: Element) {
  while (el.firstChild) el.removeChild(el.firstChild);
}

export function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
  const s = Math.floor(seconds);
  const hours = Math.floor(s / 3600);
  const minutes = Math.floor((s % 3600) / 60);
  const rest = String(s % 60).padStart(2, '0');
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, '0')}:${rest}` : `${minutes}:${rest}`;
}
