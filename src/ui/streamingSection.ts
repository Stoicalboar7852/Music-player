// Settings → Streaming audio: what the visualizers listen to when a
// streaming song plays in a browser. This tab (Chrome's share dialog, once a
// session) or a loopback device (set up once, then no asking at all).

import type { App } from '../app/app';
import { androidBridge, androidCapabilities } from '../app/android';
import { desktop } from '../app/desktop';
import { settings } from '../app/settings';
import { detectPlatform } from '../audio/capture';
import { findLoopbacks, loopbackGuide } from '../audio/loopback';
import { clear, h, icon } from './dom';
import { segmented, toggle } from './gallery';

function field(label: string, control: Node, hint?: string | Node): HTMLElement {
  return h('div', { class: 'field' }, h('label', { text: label }), control, hint ? h('p', { class: 'hint' }, hint) : null);
}

const TAB_HINT =
  'Streaming services protect their audio, so the visualizers listen to this tab. When you start a streaming song, Chrome asks once to share the tab; click Allow.';

export function streamingSection(app: App): HTMLElement {
  const box = h('div', { class: 'streaming-section' });
  const autoShare = () =>
    field('Ask to share this tab automatically', toggle(settings.get('autoShare'), 'Ask to share this tab automatically', (on) => settings.set({ autoShare: on })), desktop ? 'The desktop app listens to the whole computer without asking.' : TAB_HINT);

  if (androidBridge) {
    const caps = androidCapabilities();
    box.append(
      field(
        'Listen to this phone with',
        segmented<'visualizer' | 'capture'>(
          [
            ['visualizer', 'The visualizer way'],
            ['capture', 'Playback capture'],
          ],
          settings.get('phoneListen'),
          (phoneListen) => settings.set({ phoneListen }),
        ),
        "Streaming songs play in their own apps on a phone (the Spotify app, YouTube Music). Phosphor hears them without the microphone. The visualizer way: Android's visualizer feed of everything playing; Android asks once, then Phosphor listens by itself whenever a song plays. Playback capture: full-quality sound; Android asks each time, and an app can refuse to be captured. Both need Android's \"record audio\" permission, though neither uses the microphone.",
      ),
      h('p', { class: 'hint' }, caps?.permission ? 'Android has allowed it.' : "Android hasn't been asked yet: it asks the first time Phosphor listens."),
    );
    return box;
  }
  if (desktop || !navigator.mediaDevices?.enumerateDevices) {
    box.append(autoShare());
    return box;
  }

  const devicesBox = h('div');
  const render = () => {
    clear(box);
    const mode = settings.get('streamingListen');
    box.append(
      field(
        'The visualizers listen to',
        segmented<'tab' | 'loopback'>(
          [
            ['tab', 'This tab'],
            ['loopback', 'A loopback device'],
          ],
          mode,
          (streamingListen) => settings.set({ streamingListen }),
        ),
        'This tab: Chrome asks to share it when a streaming song starts. A loopback device: a virtual sound device that carries everything the computer plays. Set one up once and Phosphor listens to it by itself, with no asking, also to music playing in other apps.',
      ),
    );
    if (mode === 'tab') box.append(autoShare());
    else box.append(devicesBox);
  };

  let inputs: MediaDeviceInfo[] = [];
  let note = '';
  const renderDevices = () => {
    clear(devicesBox);
    const chosen = settings.get('loopbackDevice');
    const loopbacks = findLoopbacks(inputs);
    const named = inputs.filter((d) => d.label && d.deviceId !== 'default' && d.deviceId !== 'communications');
    const find = h('button', { class: 'btn small', type: 'button', 'data-find-devices': '' }, icon('search', 16), named.length ? 'Look again' : 'Find devices');
    find.addEventListener('click', () => void refresh(true));
    const picker = h('select', { class: 'input', 'aria-label': 'Loopback device' });
    picker.append(h('option', { value: '', text: named.length ? 'Choose a device…' : 'Press Find devices' }));
    const loopbackIds = new Set(loopbacks.map((l) => l.deviceId));
    const groups: [string, MediaDeviceInfo[]][] = [
      ['Loopback devices', named.filter((d) => loopbackIds.has(d.deviceId))],
      ['Other inputs (microphones…)', named.filter((d) => !loopbackIds.has(d.deviceId))],
    ];
    for (const [label, list] of groups) {
      if (!list.length) continue;
      const group = h('optgroup', { label });
      for (const d of list) group.append(h('option', { value: d.deviceId, text: d.label, selected: chosen?.id === d.deviceId || (!chosen?.id && false) }));
      picker.append(group);
    }
    if (chosen && !named.some((d) => d.deviceId === chosen.id)) picker.append(h('option', { value: chosen.id, text: `${chosen.label} (not found right now)`, selected: true }));
    picker.addEventListener('change', () => {
      const d = named.find((x) => x.deviceId === picker.value);
      settings.set({ loopbackDevice: d ? { id: d.deviceId, label: d.label } : null });
      renderDevices();
    });

    let status: string;
    if (chosen) status = `Phosphor listens to ${chosen.label} when a streaming song plays.`;
    else if (!named.length) status = 'Press Find devices: the browser asks once to let this site use audio inputs (that is how it shows their names).';
    else if (loopbacks.length) status = `Found ${loopbacks.map((l) => l.label).join(', ')}. Choose one.`;
    else status = 'No loopback device found. Set one up (below), then press Look again.';
    devicesBox.append(
      field('Device', h('div', { class: 'input-row' }, picker, find), h('span', { 'data-loopback-status': '' }, note || status)),
    );

    const guide = loopbackGuide(detectPlatform());
    if (guide && !loopbacks.some((l) => l.deviceId === chosen?.id)) {
      const steps = h('ol', { class: 'guide' });
      for (const step of guide.steps) {
        steps.append(h('li', null, ...step.map((part) => (typeof part === 'string' ? part : h('a', { href: part.href, target: '_blank', rel: 'noopener', text: part.text })))));
      }
      devicesBox.append(h('div', { class: 'field stack' }, h('label', { text: 'Setting one up' }), steps, guide.note ? h('p', { class: 'hint', text: guide.note }) : null));
    } else if (!guide) {
      devicesBox.append(h('p', { class: 'hint warn', text: "This system has no loopback devices to offer, so share the tab's audio instead." }));
    }
  };

  const refresh = async (ask: boolean) => {
    note = '';
    try {
      inputs = ask ? await app.capture.namedInputs() : await app.capture.listInputs();
      // Nothing chosen yet: take the loopback device it recognises.
      if (!settings.get('loopbackDevice')) {
        const best = findLoopbacks(inputs)[0];
        if (best) settings.set({ loopbackDevice: { id: best.deviceId, label: best.label } });
      }
    } catch (error) {
      note = error instanceof Error ? error.message : String(error);
    }
    renderDevices();
  };

  render();
  void refresh(false);
  settings.on('change', (patch) => {
    if (!box.isConnected && box.dataset.shown) return;
    box.dataset.shown = '1';
    if ('streamingListen' in patch) render();
  });
  return box;
}
