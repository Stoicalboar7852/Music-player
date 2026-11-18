// Settings: visuals, behaviour, and the credentials each streaming service needs.

import type { App } from '../app/app';
import { appBaseUrl, settings, type AutoHide } from '../app/settings';
import type { Quality } from '../viz/renderer';
import { h, icon } from './dom';
import { CYCLE_CHOICES, segmented, select, toggle } from './gallery';

function field(label: string, control: Node, hint?: string | Node): HTMLElement {
  return h('div', { class: 'field' }, h('label', { text: label }), control, hint ? h('p', { class: 'hint' }, hint) : null);
}

function textInput(key: 'spotifyClientId' | 'youtubeApiKey', placeholder: string): HTMLInputElement {
  const input = h('input', { class: 'input', type: 'text', placeholder, value: settings.get(key), spellcheck: 'false', autocomplete: 'off' });
  input.addEventListener('change', () => settings.set({ [key]: input.value.trim() }));
  return input;
}

export function openSettings(app: App, section?: string) {
  const redirect = appBaseUrl();
  const redirectOk = /^https:|^http:\/\/(127\.0\.0\.1|\[::1\])(:|\/)/.test(redirect);

  const appleToken = h('textarea', {
    class: 'input',
    placeholder: 'eyJhbGciOiJFUzI1NiIsImtpZCI6…',
    spellcheck: 'false',
  });
  appleToken.value = settings.get('appleDeveloperToken');
  appleToken.addEventListener('change', () => settings.set({ appleDeveloperToken: appleToken.value.trim() }));

  const copy = h('button', { class: 'btn small', type: 'button' }, icon('copy', 16), 'Copy');
  copy.addEventListener('click', () => {
    void navigator.clipboard.writeText(redirect).then(
      () => app.toast('Redirect URI copied'),
      () => app.toast('Could not copy; select the text instead', 'error'),
    );
  });

  const body = h(
    'div',
    null,
    h('h3', { text: 'Visuals' }),
    field(
      'Quality',
      segmented<Quality>(
        [
          ['auto', 'Auto'],
          ['high', 'High'],
          ['medium', 'Medium'],
          ['low', 'Low'],
        ],
        settings.get('quality'),
        (quality) => settings.set({ quality }),
      ),
      'Auto lowers the internal resolution when frames start dropping and raises it again when there is headroom.',
    ),
    field('Auto-cycle visualizers', toggle(settings.get('autoCycle'), 'Auto-cycle visualizers', (on) => app.setAutoCycle(on))),
    field(
      'Change every',
      select(CYCLE_CHOICES, settings.get('cycleSeconds'), (cycleSeconds) => settings.set({ cycleSeconds })),
    ),
    field(
      'Cycle order',
      segmented<'shuffle' | 'order'>(
        [
          ['shuffle', 'Shuffled'],
          ['order', 'In gallery order'],
        ],
        settings.get('cycleShuffle') ? 'shuffle' : 'order',
        (value) => settings.set({ cycleShuffle: value === 'shuffle' }),
      ),
    ),
    field(
      'Crossfade',
      select<number>(
        [
          [0, 'Off (cut)'],
          [0.8, 'Quick (0.8s)'],
          [1.6, 'Normal (1.6s)'],
          [3, 'Slow (3s)'],
        ],
        settings.get('crossfadeSeconds'),
        (crossfadeSeconds) => settings.set({ crossfadeSeconds }),
      ),
    ),
    field(
      'Hide the interface when idle',
      segmented<AutoHide>(
        [
          ['fullscreen', 'In fullscreen'],
          ['always', 'Always'],
          ['never', 'Never'],
        ],
        settings.get('autoHide'),
        (autoHide) => settings.set({ autoHide }),
      ),
      'The controls fade out a few seconds after the mouse stops, while something is playing.',
    ),
    field('Show frame rate', toggle(settings.get('showStats'), 'Show frame rate', (showStats) => settings.set({ showStats }))),

    h('h3', { text: 'Streaming audio' }),
    field(
      'Ask to share this tab automatically',
      toggle(settings.get('autoShare'), 'Ask to share this tab automatically', (autoShare) => settings.set({ autoShare })),
      'Streaming services protect their audio, so the visualizers listen to this tab. When you start a streaming song, Chrome asks once to share the tab; click Allow. The desktop app does this without asking.',
    ),

    h('h3', { text: 'Spotify', 'data-section': 'spotify' }),
    h('p', null, 'Needs a Spotify Premium account and a (free) app registered at developer.spotify.com. Full steps are in the README.'),
    field('Client ID', textInput('spotifyClientId', '32-character Client ID from your Spotify app')),
    field(
      'Redirect URI',
      h('div', { class: 'input-row' }, h('input', { class: 'input', type: 'text', readonly: true, value: redirect }), copy),
      redirectOk
        ? 'Add exactly this address under "Redirect URIs" in your Spotify app.'
        : 'Spotify only accepts https addresses or http://127.0.0.1. Open the app at http://127.0.0.1:5173 instead of this address.',
    ),

    h('h3', { text: 'Apple Music', 'data-section': 'apple' }),
    h(
      'p',
      null,
      'Needs an Apple Developer Program membership to create a MusicKit key, and an Apple Music subscription to play full tracks. ',
      'Generate a developer token with ',
      h('code', { text: 'npm run apple-token' }),
      ' (see the README) and paste it here.',
    ),
    h('div', { class: 'field stack' }, h('label', { text: 'Developer token (JWT)' }), appleToken, h('p', { class: 'hint', text: 'Tokens last at most six months; generate a new one when this stops working.' })),

    h('h3', { text: 'YouTube', 'data-section': 'youtube' }),
    h('p', null, 'Pasting YouTube and YouTube Music links works with no setup. A YouTube Data API key is optional and adds search and playlist track names.'),
    field('Data API key (optional)', textInput('youtubeApiKey', 'AIza…')),

    h('h3', { text: 'About' }),
    h(
      'p',
      null,
      'Settings and credentials are stored only in this browser (localStorage) and are sent nowhere except to the service they belong to.',
    ),
    h(
      'div',
      { class: 'actions' },
      h('button', { class: 'btn', type: 'button', onClick: () => app.openSheet('shortcuts') }, icon('keyboard', 18), 'Keyboard shortcuts'),
    ),
  );

  if (section) {
    requestAnimationFrame(() => body.querySelector(`[data-section="${section}"]`)?.scrollIntoView({ block: 'start' }));
  }
  return { body };
}
