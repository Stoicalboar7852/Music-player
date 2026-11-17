import './styles.css';

import type { App, SheetName } from './app/app';
import { settings } from './app/settings';
import { CaptureError, CaptureManager } from './audio/capture';
import { createDemoTrack } from './audio/demo';
import { AudioEngine } from './audio/engine';
import { createHarness } from './debug/harness';
import { filesFromDrop, filesFromInput, LocalBackend, loadTagsInBackground, pickFolder, tracksFromFiles, type IncomingFile } from './player/local';
import { connectMediaSession } from './player/mediaSession';
import { Player } from './player/player';
import { SOURCE_NAMES, type Track } from './player/types';
import { handleSpotifyCallback, SpotifyService } from './services/spotify';
import type { MusicService } from './services/types';
import { createDock } from './ui/dock';
import { h, icon } from './ui/dom';
import { openGallery } from './ui/gallery';
import { installShortcuts, openShortcuts } from './ui/keys';
import { createQueue } from './ui/queue';
import { openSettings } from './ui/settingsSheet';
import { createSheets } from './ui/sheets';
import { openSources } from './ui/sources';
import { createToasts } from './ui/toast';
import { createTopbar } from './ui/topbar';
import type { RGB } from './viz/palette';
import { Renderer } from './viz/renderer';

// Spotify only accepts http redirect URIs on the loopback IP, and settings are
// stored per origin, so keep to one canonical local address.
if (location.hostname === 'localhost') {
  location.replace(location.href.replace('//localhost', '//127.0.0.1'));
}

// If Spotify just redirected back here after sign-in, finish that first. In the
// sign-in popup that is all this page load is for, so stop before starting the app.
if (await handleSpotifyCallback()) await new Promise(() => {});

const canvas = document.getElementById('stage') as HTMLCanvasElement;
const root = document.getElementById('app') as HTMLElement;

function fatal(message: string): never {
  root.append(
    h('div', { class: 'welcome glass' }, h('h1', { text: "Phosphor can't start" }), h('p', { text: message }), h('small', { text: 'Use a current version of Chrome or Edge with hardware acceleration enabled.' })),
  );
  throw new Error(message);
}

let engine: AudioEngine;
let renderer: Renderer;
try {
  engine = new AudioEngine();
  renderer = new Renderer(canvas, engine);
} catch (error) {
  fatal(error instanceof Error ? error.message : String(error));
}

const player = new Player();
const capture = new CaptureManager(engine);
player.register(new LocalBackend(engine));
// Streaming services. Each brings its own official player as a backend; none
// of them is needed for local files or system audio.
const services: MusicService[] = [new SpotifyService()];
for (const service of services) player.register(service.backend);

// ------------------------------------------------------------------- shell

const toasts = createToasts();
const sheets = createSheets(root);
const hud = h('div', { class: 'hud' });

const fileInput = h('input', { type: 'file', id: 'file-input', multiple: true, accept: 'audio/*,.mp3,.flac,.wav,.m4a,.aac,.ogg,.oga,.opus,.weba,.webm', hidden: true });
const folderInput = h('input', { type: 'file', id: 'folder-input', webkitdirectory: true, multiple: true, hidden: true });
fileInput.addEventListener('change', () => {
  app.addFiles(filesFromInput(fileInput));
  fileInput.value = '';
});
folderInput.addEventListener('change', () => {
  app.addFiles(filesFromInput(folderInput));
  folderInput.value = '';
});

const app: App = {
  engine,
  renderer,
  player,
  capture,
  services,

  toast: (message, kind) => toasts.show(message, kind),

  openSheet(name: SheetName, section?: string) {
    if (sheets.openName === name && !section) {
      sheets.close();
      return;
    }
    if (name === 'gallery') {
      const g = openGallery(app);
      sheets.open(name, g.body, { title: 'Visualizers', headerExtras: g.headerExtras });
    } else if (name === 'sources') {
      const s = openSources(app, section);
      sheets.open(name, s.body, { title: 'Add music', split: true, onClose: s.onClose });
    } else if (name === 'settings') {
      sheets.open(name, openSettings(app, section).body, { title: 'Settings', narrow: true });
    } else {
      sheets.open(name, openShortcuts().body, { title: 'Keyboard shortcuts', narrow: true });
    }
  },
  closeSheet: () => sheets.close(),
  toggleQueue: (force) => {
    const open = queue.toggle(force);
    dock.queueButton.classList.toggle('on', open);
  },

  addFiles(incoming: IncomingFile[], opts = {}) {
    const { tracks, folderCovers } = tracksFromFiles(incoming);
    if (tracks.length === 0) {
      if (incoming.length > 0) toasts.show('None of those files are audio this browser can play.', 'error');
      return;
    }
    player.add(tracks, { play: opts.play ?? !player.playing });
    toasts.show(tracks.length === 1 ? `Added "${tracks[0].title}"` : `Added ${tracks.length} tracks`);
    loadTagsInBackground(tracks, folderCovers, (id, patch) => player.patch(id, patch));
    sheets.close();
  },
  openFilePicker: () => fileInput.click(),
  async openFolderPicker() {
    const files = await pickFolder();
    if (files === null) folderInput.click();
    else if (files.length > 0) app.addFiles(files);
  },
  async playDemo() {
    toasts.show('Synthesising the demo track…');
    try {
      const track = await createDemoTrack();
      player.add([track], { play: true });
      sheets.close();
    } catch (error) {
      toasts.show(`The demo could not be created: ${(error as Error).message}`, 'error');
    }
  },
  async startCapture(opts = {}) {
    try {
      await capture.startDisplay(opts);
      toasts.show(`Capturing: ${capture.state.label.toLowerCase()} now drives the visualizers.`);
    } catch (error) {
      if (error instanceof CaptureError && error.reason === 'dismissed') return;
      toasts.show(error instanceof Error ? error.message : String(error), 'error');
      // Sharing without audio is the usual mistake; show what to pick.
      if (error instanceof CaptureError && error.reason === 'no-audio') app.openSheet('sources', 'capture');
    }
  },
  toggleFullscreen() {
    if (document.fullscreenElement) void document.exitFullscreen();
    else void document.documentElement.requestFullscreen().catch(() => toasts.show('Fullscreen was blocked by the browser.', 'error'));
  },
  setVisualizer(id: string) {
    if (!renderer.setVisualizer(id)) toasts.show("That visualizer couldn't start on this graphics hardware.", 'error');
  },
  stepVisualizer: (direction) => renderer.step(direction),
  setAutoCycle(on: boolean) {
    settings.set({ autoCycle: on });
    toasts.show(on ? `Auto-cycle on: a new visualizer every ${settings.get('cycleSeconds')} seconds` : 'Auto-cycle off');
  },
};

const topbar = createTopbar(app);
const dock = createDock(app);
const queue = createQueue(app);

// Shown instead of a silent black screen when there is nothing to visualize yet.
const welcome = h(
  'div',
  { class: 'welcome glass' },
  h('h1', { text: 'Put some music on' }),
  h('p', { text: 'Drop audio files anywhere on this window, or pick a source. Then press F and sit back.' }),
  h(
    'div',
    { class: 'actions' },
    h('button', { class: 'btn primary', type: 'button', onClick: () => app.openFilePicker() }, icon('file', 18), 'Open files'),
    h('button', { class: 'btn', type: 'button', onClick: () => void app.openFolderPicker() }, icon('folder', 18), 'Open folder'),
    h('button', { class: 'btn', type: 'button', onClick: () => app.openSheet('sources', 'capture') }, icon('capture', 18), 'System audio'),
    h('button', { class: 'btn', type: 'button', onClick: () => void app.playDemo() }, icon('sparkles', 18), 'Play demo'),
  ),
  h('small', null, 'Press ', h('kbd', { text: '?' }), ' for keyboard shortcuts'),
);

// Streaming services are DRM-protected: their audio only reaches the
// visualizers once the user shares this tab's sound.
const bannerText = h('span');
const banner = h(
  'div',
  { class: 'banner glass', hidden: true },
  bannerText,
  h('button', { class: 'btn primary small', type: 'button', onClick: () => void app.startCapture({ thisTab: true }) }, "Share this tab's audio"),
);

const dropzone = h('div', { class: 'dropzone' }, 'Drop to add to the queue');

hud.append(h('div', { class: 'scrim-top' }), h('div', { class: 'scrim-bottom' }), topbar.el, welcome, queue.el, banner, dock.el);
root.append(hud, toasts.el, dropzone, fileInput, folderInput);

// --------------------------------------------------------------- behaviour

const DEFAULT_ACCENT: RGB[] = [
  [1, 0.24, 0.51],
  [0.48, 0.36, 1],
];
function setAccent(palette: RGB[] | null) {
  const [a, b] = palette ?? DEFAULT_ACCENT;
  const css = (c: RGB) => `rgb(${c.map((v) => Math.round(v * 255)).join(' ')})`;
  document.documentElement.style.setProperty('--accent', css(a));
  document.documentElement.style.setProperty('--accent-2', css(b ?? a));
}

let artworkUrl: string | undefined;
let artworkToken = 0;
function syncArtwork(track: Track | null) {
  const url = track?.artworkUrl;
  if (url === artworkUrl) return;
  artworkUrl = url;
  const token = ++artworkToken;
  if (!url) {
    setAccent(renderer.setArtwork(null));
    return;
  }
  const image = new Image();
  // Remote covers must be CORS-readable to be used as a texture.
  if (!url.startsWith('blob:') && !url.startsWith('data:')) image.crossOrigin = 'anonymous';
  image.onload = () => {
    if (token === artworkToken) setAccent(renderer.setArtwork(image));
  };
  image.onerror = () => {
    if (token === artworkToken) setAccent(renderer.setArtwork(null));
  };
  image.src = url;
}

/** Decides what the visualizers listen to, and whether to ask for tab audio. */
function route() {
  const track = player.current;
  const localPlaying = track?.source === 'local' && player.playing;
  engine.setAnalysisInput(capture.state.active && !localPlaying ? 'capture' : 'local');

  const needsCapture = Boolean(track && track.source !== 'local' && !capture.state.active);
  banner.hidden = !needsCapture;
  if (needsCapture && track) {
    bannerText.replaceChildren(
      h('strong', { text: `${SOURCE_NAMES[track.source]} audio is protected, ` }),
      'so the visualizers listen to this tab instead. Share its audio to bring them to life.',
    );
  }
  welcome.classList.toggle('gone', player.queue.length > 0 || capture.state.active);
  document.title = track ? `${track.title}${track.artist ? ` · ${track.artist}` : ''} — Phosphor` : 'Phosphor';
}

player.on('track', (track) => {
  syncArtwork(track);
  route();
});
player.on('change', () => {
  route();
  // Remember transport preferences.
  const s = settings.all;
  if (s.volume !== player.volume || s.shuffle !== player.shuffle || s.repeat !== player.repeat) {
    settings.set({ volume: player.volume, shuffle: player.shuffle, repeat: player.repeat });
  }
});
player.on('error', (message) => toasts.show(message, 'error'));
capture.on('change', (state) => {
  route();
  if (!state.active) toasts.show('Audio capture stopped.');
});

renderer.onChange = (def) => {
  topbar.render();
  if (settings.get('visualizer') !== def.id) settings.set({ visualizer: def.id });
};
renderer.onError = (def) => {
  toasts.show(`${def.name} hit a problem on this graphics hardware and was skipped.`, 'error');
  if (renderer.currentId === def.id) renderer.step(1);
};
renderer.onVariant = (name) => toasts.show(name);

settings.on('change', (patch) => {
  if ('quality' in patch) renderer.setQuality(settings.get('quality'));
  if ('crossfadeSeconds' in patch) renderer.crossfadeSeconds = settings.get('crossfadeSeconds');
  if ('autoCycle' in patch || 'cycleSeconds' in patch || 'cycleShuffle' in patch) {
    renderer.setAutoCycle(settings.get('autoCycle'), settings.get('cycleSeconds'), settings.get('cycleShuffle'));
  }
});

// ---- drag and drop
let dragDepth = 0;
const hasFiles = (e: DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes('Files');
window.addEventListener('dragenter', (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  dragDepth++;
  dropzone.classList.add('show');
});
window.addEventListener('dragover', (e) => {
  if (hasFiles(e)) e.preventDefault();
});
window.addEventListener('dragleave', (e) => {
  if (!hasFiles(e)) return;
  dragDepth = Math.max(0, dragDepth - 1);
  if (dragDepth === 0) dropzone.classList.remove('show');
});
window.addEventListener('drop', (e) => {
  if (!hasFiles(e) || !e.dataTransfer) return;
  e.preventDefault();
  dragDepth = 0;
  dropzone.classList.remove('show');
  void filesFromDrop(e.dataTransfer).then((files) => app.addFiles(files));
});

// ---- idle: fade the interface out when the mouse rests
let idleTimer = 0;
let lastX = -1;
let lastY = -1;
function mayHide(): boolean {
  const mode = settings.get('autoHide');
  const allowed = mode === 'always' || (mode === 'fullscreen' && Boolean(document.fullscreenElement));
  const active = player.playing || capture.state.active;
  const busy =
    sheets.isOpen ||
    dragDepth > 0 ||
    document.querySelector('.dock:hover, .topbar:hover, .drawer.open:hover, .banner:hover') !== null ||
    document.activeElement instanceof HTMLInputElement;
  return allowed && active && !busy;
}
function wake() {
  document.body.classList.remove('idle');
  clearTimeout(idleTimer);
  idleTimer = window.setTimeout(function check() {
    if (mayHide()) document.body.classList.add('idle');
    else idleTimer = window.setTimeout(check, 1200);
  }, 2600);
}
window.addEventListener('mousemove', (e) => {
  // Browsers send synthetic mousemoves when the page changes under a still cursor.
  if (e.screenX === lastX && e.screenY === lastY) return;
  lastX = e.screenX;
  lastY = e.screenY;
  wake();
});
for (const type of ['mousedown', 'keydown', 'wheel', 'touchstart'] as const) window.addEventListener(type, wake, { passive: true });
document.addEventListener('fullscreenchange', wake);
wake();

canvas.addEventListener('dblclick', () => app.toggleFullscreen());
// Autoplay policy: the audio context can only start from a gesture.
for (const type of ['pointerdown', 'keydown'] as const) window.addEventListener(type, () => void engine.resume());

installShortcuts(app, { sheetOpen: () => sheets.isOpen, queueOpen: () => queue.isOpen });
connectMediaSession(player);

// ------------------------------------------------------------------ start

player.volume = settings.get('volume');
player.shuffle = settings.get('shuffle');
player.repeat = settings.get('repeat');
player.setVolume(player.volume);
renderer.setQuality(settings.get('quality'));
renderer.crossfadeSeconds = settings.get('crossfadeSeconds');
renderer.setAutoCycle(settings.get('autoCycle'), settings.get('cycleSeconds'), settings.get('cycleShuffle'));
if (!renderer.setVisualizer(settings.get('visualizer'), { immediate: true })) renderer.step(1);
renderer.start();
route();
topbar.render();

window.setInterval(() => dock.tick(), 200);
window.setInterval(() => topbar.tick(), 50);

// Hooks for the automated verification scripts (see scripts/verify.cjs).
Object.assign(window, { __phosphor: { app, engine, renderer, player, capture, settings, harness: createHarness(renderer) } });
