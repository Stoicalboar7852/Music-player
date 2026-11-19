// The presenter as an NDI source: a hidden, offscreen window shows the same
// page FreeShow or OBS would (present.html?feed, fed by the main window over
// the local server), and each frame it paints goes to NDI (see ndi.mjs).

import { createNdiSender } from './ndi.mjs';

const SIZES = { '1280x720': [1280, 720], '1920x1080': [1920, 1080], '3840x2160': [3840, 2160] };

/**
 * @param {{ BrowserWindow: typeof import('electron').BrowserWindow, pageUrl: () => string | null,
 *           onStatus: (status: object) => void, log?: (...args: unknown[]) => void }} options
 */
export function createNdiOutput({ BrowserWindow, pageUrl, onStatus, log = () => {} }) {
  let settings = { enabled: false, name: 'Phosphor', size: '1920x1080', fps: 30 };
  let win = null;
  let sender = null;
  let timer = null;
  let generation = 0;
  let last = null;
  let lastAt = 0;
  let status = { state: 'off', detail: '', receivers: 0 };

  const report = (next) => {
    status = { ...status, ...next };
    onStatus({ ...status });
  };

  function stop() {
    generation++;
    clearInterval(timer);
    timer = null;
    if (win && !win.isDestroyed()) win.destroy();
    win = null;
    sender?.close();
    sender = null;
    last = null;
  }

  async function start() {
    const mine = ++generation;
    const url = pageUrl();
    if (!url) return report({ state: 'error', detail: 'Phosphor is still starting', receivers: 0 });
    const [width, height] = SIZES[settings.size] ?? SIZES['1920x1080'];
    const fps = settings.fps === 60 ? 60 : 30;
    report({ state: 'starting', detail: '', receivers: 0 });
    let created;
    try {
      created = await createNdiSender({ name: settings.name || 'Phosphor' });
    } catch (error) {
      if (mine === generation) report({ state: error.code === 'NDI_MISSING' ? 'missing' : 'error', detail: error.message, receivers: 0 });
      return;
    }
    if (mine !== generation) return created.close();
    sender = created;

    win = new BrowserWindow({
      show: false,
      width,
      height,
      useContentSize: true,
      frame: false,
      paintWhenInitiallyHidden: true,
      webPreferences: { offscreen: true, backgroundThrottling: false, sandbox: true, contextIsolation: true, nodeIntegration: false },
    });
    const contents = win.webContents;
    contents.setFrameRate(fps);
    contents.setAudioMuted(true);
    // The offscreen page may paint at the screen's scale (2× on a Retina
    // display): size the window so the frames come out at the size chosen.
    let fitted = false;
    contents.on('paint', (_event, _dirty, image) => {
      if (!sender) return;
      const size = image.getSize();
      if (!fitted && (size.width !== width || size.height !== height) && size.width > 0) {
        fitted = true;
        const scale = size.width / win.getContentSize()[0];
        if (scale && Math.abs(scale - 1) > 0.01) {
          win.setContentSize(Math.round(width / scale), Math.round(height / scale));
          return;
        }
      }
      last = { bitmap: image.toBitmap(), width: size.width, height: size.height };
      lastAt = Date.now();
      try {
        sender.send(last.bitmap, last.width, last.height, fps);
      } catch (error) {
        log('NDI send failed', error);
      }
    });
    contents.on('render-process-gone', () => {
      if (mine === generation) report({ state: 'error', detail: 'the NDI page stopped; turn NDI off and on again' });
    });
    contents.setWindowOpenHandler(() => ({ action: 'deny' }));
    contents.on('will-navigate', (event) => event.preventDefault());
    await win.loadURL(`${url}present.html?feed&ndi`).catch((error) => log('NDI page failed to load', error));
    if (mine !== generation) return;

    report({ state: 'running', detail: `"${sender.name}" at ${width}×${height}, ${fps} fps`, receivers: sender.connections(), runtime: sender.version });
    timer = setInterval(() => {
      if (!sender) return;
      // A still picture (blackout, freeze) paints nothing: send the last frame
      // again now and then so receivers know the source is alive.
      if (last && Date.now() - lastAt > 1000) {
        lastAt = Date.now();
        sender.send(last.bitmap, last.width, last.height, fps);
      }
      const receivers = sender.connections();
      if (receivers !== status.receivers) report({ receivers });
    }, 1000);
  }

  return {
    /** New settings from the page: { enabled, name, size, fps }. */
    configure(next) {
      const merged = { ...settings, ...(next && typeof next === 'object' ? next : {}) };
      merged.name = String(merged.name ?? 'Phosphor').slice(0, 60) || 'Phosphor';
      const changed = JSON.stringify(merged) !== JSON.stringify(settings);
      settings = merged;
      if (!changed && (settings.enabled ? win : !win)) return;
      stop();
      if (settings.enabled) void start();
      else report({ state: 'off', detail: '', receivers: 0 });
    },
    get status() {
      return { ...status };
    },
    /** How many frames have gone out (for the smoke test). */
    get frames() {
      return sender?.frames ?? 0;
    },
    stop,
  };
}
