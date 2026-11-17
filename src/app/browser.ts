// Which browser engine this is. Phosphor is built for Chromium (Chrome, Edge,
// Brave, Arc...); the others can play local files but not capture audio.

export type BrowserKind = 'chromium' | 'safari' | 'firefox' | 'other';

export function detectBrowser(): { kind: BrowserKind; name: string } {
  // Every Chromium browser (Chrome, Edge, Brave, Arc, Opera) keeps "Chrome/" in
  // its user agent; Safari and Firefox never have it.
  const ua = navigator.userAgent;
  if (/\b(Chrome|Chromium|Edg|OPR)\//.test(ua)) {
    return { kind: 'chromium', name: /Edg\//.test(ua) ? 'Edge' : 'Chrome' };
  }
  if (/Firefox\//.test(ua)) return { kind: 'firefox', name: 'Firefox' };
  if (/Safari\//.test(ua)) return { kind: 'safari', name: 'Safari' };
  return { kind: 'other', name: 'this browser' };
}

/** Plain explanation of what does not work in a non-Chromium browser, or null in Chrome/Edge. */
export function browserLimitation(): string | null {
  const { kind, name } = detectBrowser();
  if (kind === 'chromium') return null;
  return `You're using ${name}. Your own music files play here, but ${name} can't capture system or tab audio, and Spotify won't play in it. For everything to work, open this page in Chrome or Edge.`;
}
