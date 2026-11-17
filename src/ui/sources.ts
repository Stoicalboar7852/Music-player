// The "Add music" sheet: local files, system audio capture, and one tab per
// streaming service.

import type { App } from '../app/app';
import { captureAdvice, CaptureError } from '../audio/capture';
import { clear, h, icon } from './dom';
import type { IconName } from './icons';
import { createServicePanel } from './servicePanel';

function filesPanel(app: App): HTMLElement {
  return h(
    'div',
    null,
    h('h3', { text: 'Play files from this computer' }),
    h(
      'p',
      null,
      'MP3, FLAC, WAV, M4A/AAC, OGG and Opus all work, along with anything else your browser can decode. ',
      'Titles, artists and cover art are read from the files. Nothing is uploaded: files are played straight from disk.',
    ),
    h(
      'div',
      { class: 'actions' },
      h('button', { class: 'btn primary', type: 'button', onClick: () => app.openFilePicker() }, icon('file', 18), 'Open files'),
      h('button', { class: 'btn', type: 'button', onClick: () => void app.openFolderPicker() }, icon('folder', 18), 'Open a folder'),
    ),
    h('p', { class: 'note' }, 'You can also drag files or whole folders onto the window at any time. Folders are added in natural track order.'),
    h('h3', { text: 'No music to hand?' }),
    h('p', null, 'The built-in demo is a short synthesised track made for showing off the visualizers.'),
    h(
      'div',
      { class: 'actions' },
      h('button', { class: 'btn', type: 'button', onClick: () => void app.playDemo() }, icon('sparkles', 18), 'Play the demo track'),
    ),
  );
}

function capturePanel(app: App): HTMLElement {
  const { capture } = app;
  const advice = captureAdvice();
  const status = h('div');
  const devices = h('select', { class: 'input' }, h('option', { value: '', text: 'Default input' }));

  const renderStatus = () => {
    clear(status);
    if (capture.state.active) {
      status.append(
        h(
          'div',
          { class: 'note ok', style: 'display:flex;align-items:center;justify-content:space-between;gap:12px' },
          h('span', null, 'Listening to: ', h('strong', { text: capture.state.label })),
          h('button', { class: 'btn small', type: 'button', onClick: () => capture.stop() }, 'Stop'),
        ),
      );
    } else if (!capture.supported) {
      status.append(h('div', { class: 'note warn', text: 'This browser cannot capture audio. Use Chrome or Edge on a desktop computer.' }));
    }
  };
  const off = capture.on('change', renderStatus);
  renderStatus();

  const refreshDevices = async () => {
    try {
      const list = await capture.listInputs();
      const previous = devices.value;
      clear(devices);
      devices.append(h('option', { value: '', text: 'Default input' }));
      for (const d of list) {
        if (d.deviceId && d.deviceId !== 'default') devices.append(h('option', { value: d.deviceId, text: d.label || 'Audio input (name hidden until allowed)' }));
      }
      devices.value = previous;
    } catch {
      /* enumeration unavailable: the default input still works */
    }
  };
  void refreshDevices();

  const start = async (fn: () => Promise<void>) => {
    try {
      await fn();
      app.toast('Capturing. Whatever you shared now drives the visualizers.');
      app.closeSheet();
    } catch (error) {
      if (error instanceof CaptureError && error.reason === 'dismissed') return;
      app.toast(error instanceof Error ? error.message : String(error), 'error');
    }
    void refreshDevices();
  };

  const panel = h(
    'div',
    null,
    h('h3', { text: 'Visualize anything your computer is playing' }),
    h(
      'p',
      null,
      'Share audio with this page and it drives the visualizers: another tab, a streaming app, a game, anything. ',
      'The captured sound is only analysed, never played back, so you will not hear it twice.',
    ),
    status,
    h(
      'div',
      { class: 'actions' },
      h(
        'button',
        { class: 'btn primary', type: 'button', disabled: !capture.supported, onClick: () => void start(() => capture.startDisplay()) },
        icon('capture', 18),
        'Capture system or tab audio',
      ),
    ),
    h('h3', { text: 'What to pick in the share dialog' }),
    h('ol', null, advice.steps.map((s) => h('li', { text: s }))),
    advice.note ? h('p', { class: 'note', text: advice.note }) : null,
    h('p', null, 'The picture you share is discarded immediately; only the audio track is kept. Stop any time with the browser\'s "Stop sharing" button or the indicator at the top left.'),
    h('h3', { text: 'Audio input device' }),
    h(
      'p',
      null,
      'Alternatively, listen to an input device: a loopback driver, your sound server\'s monitor source, a mixer, or a microphone pointed at the speakers.',
    ),
    h(
      'div',
      { class: 'input-row', style: 'max-width:520px' },
      devices,
      h(
        'button',
        { class: 'btn', type: 'button', onClick: () => void start(() => capture.startInput(devices.value || undefined)) },
        icon('mic', 18),
        'Listen',
      ),
    ),
  );
  // Stop listening for capture changes once this panel is gone.
  (panel as HTMLElement & { cleanup?: () => void }).cleanup = off;
  return panel;
}

export function openSources(app: App, section?: string) {
  const tabs: { id: string; label: string; icon: IconName; build: () => HTMLElement; dot?: () => boolean }[] = [
    { id: 'files', label: 'Files', icon: 'file', build: () => filesPanel(app) },
    { id: 'capture', label: 'System audio', icon: 'capture', build: () => capturePanel(app), dot: () => app.capture.state.active },
    ...app.services.map((service) => ({
      id: service.id,
      label: service.name,
      icon: 'note' as IconName,
      build: () => createServicePanel(app, service),
      dot: () => service.status().connected,
    })),
  ];

  const nav = h('nav', { class: 'tabs' });
  const panel = h('div', { class: 'tab-panel' });
  let cleanup: (() => void) | undefined;

  const show = (id: string) => {
    const tab = tabs.find((t) => t.id === id) ?? tabs[0];
    cleanup?.();
    clear(panel);
    const content = tab.build();
    cleanup = (content as HTMLElement & { cleanup?: () => void }).cleanup;
    panel.append(content);
    panel.scrollTop = 0;
    nav.querySelectorAll('.tab').forEach((b) => b.classList.toggle('active', b.getAttribute('data-id') === tab.id));
  };

  // Status dots stay live while the sheet is open (connecting, capture starting...).
  const dots: (() => void)[] = [];
  for (const tab of tabs) {
    const dot = tab.dot ? h('i', { class: 'status-dot' }) : null;
    if (dot && tab.dot) {
      const lit = tab.dot;
      dots.push(() => dot.classList.toggle('on', lit()));
    }
    nav.append(
      h('button', { class: 'tab', type: 'button', 'data-id': tab.id, onClick: () => show(tab.id) }, icon(tab.icon, 18), tab.label, dot),
    );
  }
  const refreshDots = () => dots.forEach((update) => update());
  const unsubscribe = [app.capture.on('change', refreshDots), ...app.services.map((service) => service.onStatus(refreshDots))];
  refreshDots();
  show(section ?? 'files');

  return {
    body: h('div', null, nav, panel),
    onClose: () => {
      cleanup?.();
      unsubscribe.forEach((off) => off());
    },
  };
}
