// Inline SVG icons (24x24 grid). Filled shapes use fill, line icons use stroke.

const stroke = (d: string) =>
  `<g fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${d}</g>`;
const fill = (d: string) => `<g fill="currentColor">${d}</g>`;

export const ICONS = {
  play: fill('<path d="M8 5.2v13.6a.9.9 0 0 0 1.38.76l10.6-6.8a.9.9 0 0 0 0-1.52L9.38 4.44A.9.9 0 0 0 8 5.2z"/>'),
  pause: fill('<rect x="6.5" y="4.5" width="4" height="15" rx="1.2"/><rect x="13.5" y="4.5" width="4" height="15" rx="1.2"/>'),
  next: fill('<path d="M5 5.6v12.8a.8.8 0 0 0 1.25.66L15.5 12.7v5.8a1 1 0 0 0 2 0v-13a1 1 0 0 0-2 0v5.8L6.25 4.94A.8.8 0 0 0 5 5.6z"/>'),
  previous: fill('<path d="M19 5.6v12.8a.8.8 0 0 1-1.25.66L8.5 12.7v5.8a1 1 0 0 1-2 0v-13a1 1 0 0 1 2 0v5.8l9.25-6.36A.8.8 0 0 1 19 5.6z"/>'),
  shuffle: stroke('<path d="M3 7h3.5c2 0 3.2 1 4.3 2.6l2.4 4.8c1.1 1.6 2.3 2.6 4.3 2.6H21"/><path d="M3 17h3.5c1.4 0 2.4-.5 3.3-1.4M21 7h-3.5c-1.4 0-2.4.5-3.3 1.4"/><path d="m18 4 3 3-3 3M18 14l3 3-3 3"/>'),
  repeat: stroke('<path d="M4 11V9.5A3.5 3.5 0 0 1 7.5 6H20M20 13v1.5a3.5 3.5 0 0 1-3.5 3.5H4"/><path d="m17 3 3 3-3 3M7 21l-3-3 3-3"/>'),
  repeatOne: stroke('<path d="M4 11V9.5A3.5 3.5 0 0 1 7.5 6H20M20 13v1.5a3.5 3.5 0 0 1-3.5 3.5H4"/><path d="m17 3 3 3-3 3M7 21l-3-3 3-3"/><path d="M11 10.5 12.5 9.5v5"/>'),
  volume: stroke('<path d="M4 9.5v5h3.5L12 18.5v-13L7.5 9.5z"/><path d="M15.5 9a4 4 0 0 1 0 6M18 6.5a7.5 7.5 0 0 1 0 11"/>'),
  volumeLow: stroke('<path d="M4 9.5v5h3.5L12 18.5v-13L7.5 9.5z"/><path d="M15.5 9a4 4 0 0 1 0 6"/>'),
  mute: stroke('<path d="M4 9.5v5h3.5L12 18.5v-13L7.5 9.5z"/><path d="m16 9.5 5 5M21 9.5l-5 5"/>'),
  queue: stroke('<path d="M4 6h12M4 11h12M4 16h7"/><path d="M15.5 19v-6.5l4.5-1v6"/><circle cx="14" cy="19" r="1.6"/><circle cx="18.500" cy="17.5" r="1.6"/>'),
  grid: stroke('<rect x="4" y="4" width="6.5" height="6.5" rx="1.5"/><rect x="13.5" y="4" width="6.5" height="6.5" rx="1.5"/><rect x="4" y="13.5" width="6.5" height="6.5" rx="1.5"/><rect x="13.5" y="13.5" width="6.5" height="6.5" rx="1.5"/>'),
  settings: stroke('<circle cx="12" cy="12" r="3"/><path d="M19.4 14.6a1.2 1.2 0 0 0 .3 1.4l.1.1a2 2 0 1 1-2.900 2.800l-.1-.1a1.2 1.2 0 0 0-2 .9V20a2 2 0 0 1-4 0v-.2a1.2 1.2 0 0 0-2-.9l-.1.1a2 2 0 1 1-2.800-2.800l.1-.1a1.2 1.2 0 0 0-.9-2H4a2 2 0 0 1 0-4h.2a1.2 1.2 0 0 0 .9-2l-.1-.1a2 2 0 1 1 2.800-2.800l.1.1a1.2 1.2 0 0 0 2-.9V4a2 2 0 0 1 4 0v.2a1.2 1.2 0 0 0 2 .9l.1-.1a2 2 0 1 1 2.800 2.800l-.1.1a1.2 1.2 0 0 0 .9 2h.2a2 2 0 0 1 0 4h-.2a1.200 1.200 0 0 0-.2.700z"/>'),
  fullscreen: stroke('<path d="M4 9V5.500A1.500 1.500 0 0 1 5.500 4H9M15 4h3.500A1.500 1.500 0 0 1 20 5.500V9M20 15v3.500a1.500 1.500 0 0 1-1.500 1.500H15M9 20H5.500A1.500 1.500 0 0 1 4 18.500V15"/>'),
  exitFullscreen: stroke('<path d="M9 4v3.500A1.500 1.500 0 0 1 7.500 9H4M20 9h-3.500A1.500 1.500 0 0 1 15 7.500V4M15 20v-3.500a1.500 1.500 0 0 1 1.500-1.500H20M4 15h3.500A1.500 1.500 0 0 1 9 16.500V20"/>'),
  plus: stroke('<path d="M12 5v14M5 12h14"/>'),
  close: stroke('<path d="m6 6 12 12M18 6 6 18"/>'),
  file: stroke('<path d="M9 18V6.500l10-2V16"/><circle cx="6.500" cy="18" r="2.500"/><circle cx="16.500" cy="16" r="2.500"/>'),
  folder: stroke('<path d="M3.500 7.500A1.500 1.500 0 0 1 5 6h4l2 2.500h8a1.500 1.500 0 0 1 1.500 1.500v7.500A1.500 1.500 0 0 1 19 19H5a1.500 1.500 0 0 1-1.500-1.500z"/>'),
  capture: stroke('<rect x="3" y="4.500" width="18" height="12" rx="2"/><path d="M8 20h8M12 16.500V20"/><path d="M8.500 11.500v-2M11 12.500v-4M13.500 11.800v-2.600M16 11v-1"/>'),
  sparkles: stroke('<path d="M12 4l1.600 4.400L18 10l-4.400 1.600L12 16l-1.600-4.400L6 10l4.400-1.600z"/><path d="M18.500 15.500l.7 1.800 1.800.7-1.800.7-.7 1.800-.7-1.800-1.800-.7 1.800-.7zM5.500 15l.5 1.300 1.300.5-1.300.5-.5 1.300-.5-1.300-1.300-.5 1.300-.5z"/>'),
  chevronLeft: stroke('<path d="m14.500 6-6 6 6 6"/>'),
  chevronRight: stroke('<path d="m9.500 6 6 6-6 6"/>'),
  trash: stroke('<path d="M5 7h14M10 7V5h4v2M7 7l.800 11.500A1.500 1.500 0 0 0 9.300 20h5.400a1.500 1.500 0 0 0 1.500-1.500L17 7"/>'),
  search: stroke('<circle cx="11" cy="11" r="6"/><path d="m20 20-4.500-4.500"/>'),
  link: stroke('<path d="M10 14a4 4 0 0 0 5.700 0l3-3a4 4 0 0 0-5.700-5.700l-1 1"/><path d="M14 10a4 4 0 0 0-5.700 0l-3 3a4 4 0 0 0 5.700 5.700l1-1"/>'),
  keyboard: stroke('<rect x="3" y="6" width="18" height="12" rx="2"/><path d="M7 10h.01M11 10h.01M15 10h.01M7 14h10"/>'),
  mic: stroke('<rect x="9" y="3.500" width="6" height="10" rx="3"/><path d="M6 11.500a6 6 0 0 0 12 0M12 17.500V21"/>'),
  note: stroke('<path d="M9 18V6l10-2v12"/><circle cx="6.500" cy="18" r="2.500"/><circle cx="16.500" cy="16" r="2.500"/>'),
  check: stroke('<path d="m5 12.500 4.500 4.500L19 7.500"/>'),
  stop: fill('<rect x="6.500" y="6.500" width="11" height="11" rx="2"/>'),
  external: stroke('<path d="M14 5h5v5M19 5l-8 8M18 14v4a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h4"/>'),
  copy: stroke('<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V6a2 2 0 0 1 2-2h9"/>'),
} as const;

export type IconName = keyof typeof ICONS;
