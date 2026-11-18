// Installing Phosphor as an app on a phone, tablet or computer: the service
// worker (production builds only, so development always runs fresh code) and
// the browser's install prompt where it offers one.

import { Emitter } from './emitter';

interface InstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

class Installer extends Emitter<{ change: void }> {
  private deferred: InstallPromptEvent | null = null;
  /** Already running as an installed app. */
  readonly standalone: boolean;
  readonly ios: boolean;

  constructor() {
    super();
    this.standalone =
      matchMedia('(display-mode: standalone)').matches ||
      matchMedia('(display-mode: fullscreen)').matches ||
      (navigator as Navigator & { standalone?: boolean }).standalone === true;
    this.ios = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    window.addEventListener('beforeinstallprompt', (event) => {
      event.preventDefault();
      this.deferred = event as InstallPromptEvent;
      this.emit('change', undefined);
    });
    window.addEventListener('appinstalled', () => {
      this.deferred = null;
      this.emit('change', undefined);
    });
  }

  /** The browser will show its install dialog when asked. */
  get canPrompt(): boolean {
    return this.deferred !== null;
  }

  async prompt(): Promise<boolean> {
    const event = this.deferred;
    if (!event) return false;
    this.deferred = null;
    await event.prompt();
    const { outcome } = await event.userChoice;
    this.emit('change', undefined);
    return outcome === 'accepted';
  }

  /** How to install where the browser has no prompt (Safari on iPhone and iPad). */
  get manualHint(): string | null {
    if (this.standalone) return null;
    if (this.ios) return 'On iPhone or iPad, open Phosphor in Safari, tap Share, then Add to Home Screen.';
    return null;
  }
}

export const installer = new Installer();

export function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  if (!import.meta.env.PROD) {
    // The development server always runs fresh code: drop a worker left
    // behind by a production build served from the same address.
    void navigator.serviceWorker.getRegistrations().then((registrations) => registrations.forEach((r) => void r.unregister()));
    return;
  }
  const register = () => void navigator.serviceWorker.register('./sw.js').catch(() => {});
  if (document.readyState === 'complete') register();
  else window.addEventListener('load', register, { once: true });
}
