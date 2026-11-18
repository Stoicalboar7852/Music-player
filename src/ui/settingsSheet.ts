// Settings: visuals, behaviour, and the credentials each streaming service needs.

import type { App } from '../app/app';
import { appBaseUrl, settings, type AutoHide } from '../app/settings';
import type { Quality } from '../viz/renderer';
import { installer } from '../app/install';
import { clear, h, icon } from './dom';
import { CYCLE_CHOICES, segmented, select, toggle } from './gallery';

function field(label: string, control: Node, hint?: string | Node): HTMLElement {
  return h('div', { class: 'field' }, h('label', { text: label }), control, hint ? h('p', { class: 'hint' }, hint) : null);
}

function textInput(key: 'spotifyClientId' | 'youtubeApiKey' | 'googleClientId', placeholder: string): HTMLInputElement {
  const input = h('input', { class: 'input', type: 'text', placeholder, value: settings.get(key), spellcheck: 'false', autocomplete: 'off' });
  input.addEventListener('change', () => settings.set({ [key]: input.value.trim() }));
  return input;
}

/** Installing Phosphor as an app, where the browser allows it. */
function appSection(): HTMLElement {
  const box = h('div');
  const render = () => {
    clear(box);
    if (installer.standalone) {
      box.append(h('p', { text: 'Phosphor is running as an installed app.' }));
    } else if (installer.canPrompt) {
      box.append(
        h('p', null, 'Install Phosphor to open it from your home screen, dock or start menu, in its own window. It still runs in this browser, so everything here keeps working.'),
        h('div', { class: 'actions' }, h('button', { class: 'btn primary', type: 'button', onClick: () => void installer.prompt() }, icon('download', 18), 'Install Phosphor')),
      );
    } else {
      box.append(h('p', { text: installer.manualHint ?? "Your browser installs apps from its own menu (in Chrome or Edge: the install icon in the address bar, or Cast, save and share, then Install page as app). On a phone, use the browser's Add to Home screen." }));
    }
    box.append(
      h(
        'p',
        { class: 'hint-text' },
        "On phones and tablets, local files, the demo and the visualizers work fully, and the installed app works offline. A phone browser can't share a tab's or another app's audio with a page, so for streaming songs or anything else the visualizers listen through the microphone. Phone browsers may pause music when the screen locks or you switch apps.",
      ),
    );
  };
  installer.on('change', render);
  render();
  return box;
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

    h('h3', { text: 'Between songs', 'data-section': 'transitions' }),
    field(
      'Crossfade',
      select<number>(
        [
          [0, 'Off'],
          [2, '2 seconds'],
          [4, '4 seconds'],
          [6, '6 seconds'],
          [8, '8 seconds'],
          [10, '10 seconds'],
          [12, '12 seconds'],
        ],
        settings.get('songCrossfade'),
        (songCrossfade) => settings.set({ songCrossfade }),
      ),
      'The end of one song overlaps the start of the next, with the loudness held steady. Songs on different services overlap too. Two songs on the same streaming service can\'t play at once (one player each), so they fade out and back in instead.',
    ),
    field(
      'Local files',
      segmented<'crossfade' | 'mix'>(
        [
          ['crossfade', 'Crossfade'],
          ['mix', 'Mix, like a DJ'],
        ],
        settings.get('transitionMode'),
        (transitionMode) => settings.set({ transitionMode }),
      ),
      'A mix lines up the beats and bars of the two songs, matches their tempo (without changing pitch) and keeps clashing keys short. It uses the beat analysis Phosphor does for local files; if that isn\'t ready, it crossfades.',
    ),
    field(
      'Mix style',
      segmented<'fade' | 'blend' | 'rise'>(
        [
          ['fade', 'Fade'],
          ['blend', 'Blend'],
          ['rise', 'Rise'],
        ],
        settings.get('mixStyle'),
        (mixStyle) => settings.set({ mixStyle }),
      ),
      'Fade: an even crossfade across whole bars. Blend: the next song comes in without its bass, the basslines swap on a downbeat, then the first song fades. Rise: the first song is filtered upward into a build and the next one drops in on the new phrase.',
    ),

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
    h('p', null, 'Pasting YouTube and YouTube Music links works with no setup. A YouTube Data API key is optional and adds search, popular music and playlist track names.'),
    field('Data API key (optional)', textInput('youtubeApiKey', 'AIza…')),
    field(
      'Google client ID (optional)',
      textInput('googleClientId', '…apps.googleusercontent.com'),
      h(
        'span',
        null,
        'Lets you sign in with Google to see your own YouTube and YouTube Music playlists and liked videos. Create an OAuth client of type "Web application" with ',
        h('code', { text: location.origin }),
        ' as an authorised JavaScript origin (README, YouTube section).',
      ),
    ),

    h('h3', { text: 'App', 'data-section': 'app' }),
    appSection(),

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
