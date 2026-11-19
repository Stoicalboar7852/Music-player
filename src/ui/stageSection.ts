// Settings → Presentation software: the visuals in ProPresenter, FreeShow,
// OBS and the like (a web source, NDI), the control API, and cue sync that
// follows their slides. Most of it needs the desktop app, which runs the
// local server and talks to the other programs.

import type { App } from '../app/app';
import { desktop, type LinkStatus, type StageStatus } from '../app/desktop';
import { settings, type StageSettings } from '../app/settings';
import { clear, h, icon } from './dom';
import { segmented, toggle } from './gallery';

function field(label: string, control: Node, hint?: string | Node): HTMLElement {
  return h('div', { class: 'field' }, h('label', { text: label }), control, hint ? h('p', { class: 'hint' }, hint) : null);
}

function copyRow(app: App, value: string, label: string): HTMLElement {
  const input = h('input', { class: 'input', type: 'text', readonly: true, value, 'aria-label': label });
  const copy = h('button', { class: 'btn small', type: 'button' }, icon('copy', 16), 'Copy');
  copy.addEventListener('click', () => {
    void navigator.clipboard.writeText(input.value).then(
      () => app.toast(`${label} copied`),
      () => app.toast('Could not copy; select the text instead', 'error'),
    );
  });
  return h('div', { class: 'input-row' }, input, copy);
}

function text<K extends 'propresenter' | 'freeshow' | 'ndi'>(part: K, key: keyof StageSettings[K] & string, placeholder: string, type = 'text'): HTMLInputElement {
  const current = settings.stage[part][key] as unknown;
  const input = h('input', { class: 'input', type, placeholder, value: String(current ?? ''), spellcheck: 'false', autocomplete: 'off' });
  input.addEventListener('change', () => {
    const raw = input.value.trim();
    const value = typeof current === 'number' ? Number(raw) || (current as number) : raw;
    settings.setStage(part, { [key]: value } as Partial<StageSettings[K]>);
  });
  return input;
}

function switchFor<K extends 'propresenter' | 'freeshow' | 'ndi'>(part: K, key: keyof StageSettings[K] & string, label: string): HTMLButtonElement {
  return toggle(Boolean(settings.stage[part][key]), label, (on) => settings.setStage(part, { [key]: on } as Partial<StageSettings[K]>));
}

const LINK_TEXT: Record<LinkStatus['state'], string> = {
  off: 'Off.',
  connecting: 'Connecting…',
  connected: 'Connected:',
  error: 'Not connected:',
};

function linkLine(status: LinkStatus | undefined): string {
  if (!status) return '';
  return `${LINK_TEXT[status.state]} ${status.detail}`.trim();
}

function ndiLine(status: StageStatus['ndi'] | undefined): string {
  if (!status) return '';
  switch (status.state) {
    case 'off':
      return 'Off.';
    case 'starting':
      return 'Starting…';
    case 'running':
      return `Sending ${status.detail}. ${status.receivers === 1 ? '1 program is receiving it.' : `${status.receivers} programs are receiving it.`}`;
    default:
      return status.detail;
  }
}

/** The section for the desktop app; in a browser, a pointer to it. */
export function stageSection(app: App): HTMLElement {
  const box = h('div');
  if (!desktop?.stage || !desktop.stageInfo) {
    box.append(
      h(
        'p',
        null,
        'In the desktop app, Phosphor can send its visuals to ProPresenter, FreeShow or OBS (as NDI or a web source) and follow their slides. In this browser, open the presenter window (Present) on the audience screen, or capture that window in your presentation software.',
      ),
    );
    return box;
  }
  const bridge = desktop.stage;
  const stageInfo = desktop.stageInfo;

  const webField = h('div');
  const controlField = h('div');
  const ndiStatus = h('p', { class: 'hint', 'data-status': 'ndi' });
  const proStatus = h('p', { class: 'hint', 'data-status': 'propresenter' });
  const freeStatus = h('p', { class: 'hint', 'data-status': 'freeshow' });

  const s = settings.stage;
  box.append(
    h('p', null, "Show Phosphor's visuals inside ProPresenter, FreeShow or OBS, and let their slides control Phosphor. The README has step-by-step setups."),
    webField,
    h('h4', { text: 'NDI' }),
    field(
      'Send the visuals over NDI',
      switchFor('ndi', 'enabled', 'Send the visuals over NDI'),
      'ProPresenter (Mac and Windows), FreeShow, OBS and vMix can take an NDI source as a video input or background. Needs NDI Tools (free, from ndi.video) on this computer.',
    ),
    ndiStatus,
    field(
      'Size',
      segmented<StageSettings['ndi']['size']>(
        [
          ['1280x720', '720p'],
          ['1920x1080', '1080p'],
          ['3840x2160', '4K'],
        ],
        s.ndi.size,
        (size) => settings.setStage('ndi', { size }),
      ),
    ),
    field(
      'Frame rate',
      segmented<'30' | '60'>(
        [
          ['30', '30 fps'],
          ['60', '60 fps'],
        ],
        String(s.ndi.fps) as '30' | '60',
        (fps) => settings.setStage('ndi', { fps: fps === '60' ? 60 : 30 }),
      ),
      '60 fps is smoother and costs more of the computer.',
    ),
    field('Source name', text('ndi', 'name', 'Phosphor')),
    controlField,

    h('h4', { text: 'ProPresenter' }),
    field('Follow ProPresenter', switchFor('propresenter', 'enabled', 'Follow ProPresenter'), 'Needs ProPresenter 7.9 or later with Network turned on (ProPresenter → Settings → Network).'),
    proStatus,
    field('Address', h('div', { class: 'input-row' }, text('propresenter', 'host', '127.0.0.1'), text('propresenter', 'port', '50001', 'number')), "The computer running ProPresenter and the port its Network settings show (127.0.0.1 is this computer)."),
    field('Commands in slide notes', switchFor('propresenter', 'notes', 'Commands in slide notes'), h('span', null, 'A line like ', h('code', { text: 'phosphor: visualizer aurora' }), ' in a slide’s notes runs when the slide goes live.')),
    field('Macro when a song starts', text('propresenter', 'macro', 'Macro name (optional)'), 'Triggered in ProPresenter each time a new song starts in Phosphor, for example to switch to the visuals look.'),
    field('Message with the song', text('propresenter', 'message', 'Message name (optional)'), h('span', null, 'Shown with the song filled in: give the message tokens named ', h('code', { text: 'Title' }), ' and ', h('code', { text: 'Artist' }), '.')),

    h('h4', { text: 'FreeShow' }),
    field('Follow FreeShow', switchFor('freeshow', 'enabled', 'Follow FreeShow'), 'Turn on WebSocket/REST in FreeShow → Settings → Connection.'),
    freeStatus,
    field('Address', h('div', { class: 'input-row' }, text('freeshow', 'host', '127.0.0.1'), text('freeshow', 'port', '5506', 'number')), 'The REST port FreeShow shows (5506 unless you changed it).'),
    field('Password', text('freeshow', 'password', 'Only if FreeShow has one', 'password')),
    field('Commands in slide notes', switchFor('freeshow', 'notes', 'Commands in slide notes'), h('span', null, 'A line like ', h('code', { text: 'phosphor: blackout on' }), ' in a slide’s notes runs when the slide goes live.')),
    field(
      'Song in FreeShow variables',
      switchFor('freeshow', 'variables', 'Song in FreeShow variables'),
      h('span', null, 'Fills text variables named ', h('code', { text: 'phosphor_title' }), ', ', h('code', { text: 'phosphor_artist' }), ' and ', h('code', { text: 'phosphor_visualizer' }), ' (create them in FreeShow; show one on a slide with ', h('code', { text: '{$phosphor_title}' }), ').'),
    ),
    field('Action when a song starts', text('freeshow', 'action', 'Action name (optional)'), 'Runs a FreeShow action each time a new song starts in Phosphor.'),
  );

  const render = (status: StageStatus | null) => {
    ndiStatus.textContent = ndiLine(status?.ndi);
    ndiStatus.classList.toggle('warn', status?.ndi.state === 'missing' || status?.ndi.state === 'error');
    proStatus.textContent = linkLine(status?.propresenter);
    proStatus.classList.toggle('warn', status?.propresenter.state === 'error');
    freeStatus.textContent = linkLine(status?.freeshow);
    freeStatus.classList.toggle('warn', status?.freeshow.state === 'error');
  };

  const showAddresses = (info: { origin: string; apiKey: string; viewers: number } | null) => {
    clear(webField);
    clear(controlField);
    if (!info) return;
    const watching = info.viewers === 1 ? '1 page is showing it now.' : `${info.viewers} pages are showing it now.`;
    webField.append(
      field(
        'Web source',
        copyRow(app, `${info.origin}/present.html?feed`, 'Web source address'),
        `What the presenter window shows, as a web page: a Web item in FreeShow or a Browser source in OBS. It works without the presenter window open. ${watching}`,
      ),
    );
    controlField.append(
      h('h4', { text: 'Control' }),
      field(
        'Control address',
        copyRow(app, `${info.origin}/api/command?key=${info.apiKey}&do=next`, 'Control address'),
        h(
          'span',
          null,
          'For FreeShow’s “Send REST command” actions, Bitfocus Companion or a Stream Deck. Change ',
          h('code', { text: 'do=next' }),
          ' to ',
          h('code', { text: 'do=visualizer&id=aurora' }),
          ', ',
          h('code', { text: 'do=blackout&on=1' }),
          ', ',
          h('code', { text: 'do=qr&on=0' }),
          ' and so on (the list is in the README). Keep the key private: it lets programs on this computer control Phosphor.',
        ),
      ),
    );
  };

  void bridge.status().then(render);
  void stageInfo().then(showAddresses);
  const off = bridge.onStatus((status) => {
    if (!box.isConnected && box.dataset.shown) {
      off();
      return;
    }
    render(status);
  });
  // Refresh the "pages showing it" count while the sheet is open.
  const timer = window.setInterval(() => {
    if (!box.isConnected) {
      if (box.dataset.shown) {
        window.clearInterval(timer);
        off();
      }
      return;
    }
    box.dataset.shown = '1';
    void stageInfo().then((info) => {
      const hint = webField.querySelector('.hint');
      if (info && hint) hint.textContent = hint.textContent!.replace(/\d+ pages? (is|are) showing it now\./, info.viewers === 1 ? '1 page is showing it now.' : `${info.viewers} pages are showing it now.`);
    });
  }, 2000);
  return box;
}
