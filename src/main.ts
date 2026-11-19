import './styles.css';

import type { App, SheetName } from './app/app';
import { detectBrowser } from './app/browser';
import { settings } from './app/settings';
import { CaptureError, CaptureManager, detectPlatform } from './audio/capture';
import { createDemoTrack } from './audio/demo';
import { AudioEngine } from './audio/engine';
import { BeatGrids } from './audio/grids';
import { connectDesktop, connectStage, desktop } from './app/desktop';
import { registerServiceWorker } from './app/install';
import { animateFavicon } from './ui/favicon';
import { planTransition } from './player/transitions';
import { createHarness } from './debug/harness';
import { PlaylistLibrary } from './library/playlists';
import { connectFeed } from './present/feed';
import { PresenterHost } from './present/host';
import { connectRemote } from './app/remote';
import { filesFromDrop, filesFromInput, LocalBackend, loadTagsInBackground, pickFiles, pickFolder, tracksFromFiles, type IncomingFile } from './player/local';
import { connectMediaSession } from './player/mediaSession';
import { Player } from './player/player';
import { SOURCE_NAMES, type Track } from './player/types';
import { AppleMusicService } from './services/apple';
import { handleSpotifyCallback, SpotifyService } from './services/spotify';
import { YouTubeService } from './services/youtube';
import type { MusicService } from './services/types';
import { createDock } from './ui/dock';
import { clear, h, icon } from './ui/dom';
import { openGallery } from './ui/gallery';
import { installShortcuts, openShortcuts } from './ui/keys';
import { openLibrary } from './ui/library';
import { openPlaylistMenu } from './ui/playlistMenu';
import { createPresenterPanel } from './ui/presenterPanel';
import { createQueue } from './ui/queue';
import { openSettings } from './ui/settingsSheet';
import { createSheets } from './ui/sheets';
import { openSources } from './ui/sources';
import { createToasts } from './ui/toast';
import { createTopbar } from './ui/topbar';
import { createWelcome } from './ui/welcome';
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
const library = new PlaylistLibrary();
const beatGrids = new BeatGrids(engine.context);
const capture = new CaptureManager(engine);
player.register(new LocalBackend(engine));
// Streaming services. Each brings its own official player as a backend; none
// of them is needed for local files or system audio.
const spotify = new SpotifyService();
// librespot (desktop app, optional): its audio plays through the engine, like a local file.
spotify.usePcm(() => engine.createPcmStream());
const services: MusicService[] = [spotify, new AppleMusicService(), new YouTubeService()];
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
  library,
  beatGrids,
  // Set just below, once the app exists (the presenter needs it).
  presenter: undefined as unknown as PresenterHost,

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
    } else if (name === 'library') {
      const l = openLibrary(app, section);
      sheets.open(name, l.body, { title: 'Library', split: true, onClose: l.onClose });
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
    // Saved playlists that lost track of these files (imported, or opened without a handle) get them back.
    void library.relink(tracks).then((n) => n > 0 && toasts.show(`Reconnected ${n} file${n === 1 ? '' : 's'} in your playlists`));
    sheets.close();
  },
  async openFilePicker() {
    const files = await pickFiles();
    if (files === null) fileInput.click();
    else if (files.length > 0) app.addFiles(files);
  },
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
  togglePresenter() {
    if (app.presenter.status === 'closed') {
      app.presenter.open();
      presenterPanel.show();
    } else presenterPanel.toggle();
  },
  async playPlaylist(id: string, opts = {}) {
    const playlist = library.get(id);
    if (!playlist) return;
    const { tracks, notes } = await library.resolve(id, services);
    for (const note of notes.slice(0, 3)) toasts.show(note, 'error');
    if (notes.length > 3) toasts.show(`…and ${notes.length - 3} more items were skipped.`, 'error');
    if (tracks.length === 0) {
      toasts.show(`"${playlist.name}" has nothing playable right now.`, 'error');
      return;
    }
    if (!opts.append) player.clear();
    player.add(tracks, { play: !opts.append || !player.playing });
    toasts.show(opts.append ? `Queued "${playlist.name}" (${tracks.length})` : `Playing "${playlist.name}"`);
    // Reopened local files get their tags and cover art back.
    const local = tracks.filter((t) => t.source === 'local' && !t.artworkUrl);
    if (local.length) loadTagsInBackground(local, new Map(), (tid, patch) => player.patch(tid, patch));
    sheets.close();
  },
  addToPlaylist(anchor, what) {
    openPlaylistMenu(app, anchor, what.label, async (playlistId) => {
      if (what.tracks?.length) await library.addTracks(playlistId, what.tracks);
      if (what.collection) await library.addCollection(playlistId, what.collection);
    });
  },
  setAutoCycle(on: boolean) {
    settings.set({ autoCycle: on });
    toasts.show(on ? `Auto-cycle on: a new visualizer every ${settings.get('cycleSeconds')} seconds` : 'Auto-cycle off');
  },
};

app.presenter = new PresenterHost(app);
const presenterPanel = createPresenterPanel(app, app.presenter);
const topbar = createTopbar(app);
const dock = createDock(app);
const queue = createQueue(app);

// Shown instead of a silent black screen when there is nothing to visualize yet.
const welcome = createWelcome(app);
// Saved playlists appear on the first screen, one click from playing.
const renderWelcomePlaylists = () => {
  clear(welcome.extra);
  if (library.playlists.length === 0) return;
  welcome.extra.append(
    h('div', { class: 'welcome-label', text: 'Your playlists' }),
    h(
      'div',
      { class: 'playlist-chips' },
      library.playlists.slice(0, 6).map((p) => h('button', { class: 'btn small', type: 'button', onClick: () => void app.playPlaylist(p.id) }, icon('play', 14), p.name)),
      h('button', { class: 'btn small', type: 'button', onClick: () => app.openSheet('library') }, icon('library', 14), 'Library'),
    ),
  );
};
library.on('change', renderWelcomePlaylists);

// Streaming services are DRM-protected: their audio only reaches the
// visualizers once the user shares this tab's sound.
// Phones and tablets can't share a tab's audio; there the microphone listens instead.
const bannerText = h('span');
const listen = () =>
  void capture.startInput().then(
    () => app.toast('Listening through the microphone.'),
    (error: unknown) => app.toast(error instanceof Error ? error.message : String(error), 'error'),
  );
const shareTab = desktop
  ? h('button', { class: 'btn primary small', type: 'button', onClick: () => void app.startCapture({ thisTab: false }) }, icon('capture', 16), 'Listen to this computer')
  : capture.supported
    ? h('button', { class: 'btn primary small', type: 'button', onClick: () => void app.startCapture({ thisTab: true }) }, "Share this tab's audio")
    : h('button', { class: 'btn primary small', type: 'button', onClick: listen }, icon('mic', 16), 'Listen');
// For music playing in another program (Spotify Connect), in a browser.
const shareSystem = capture.supported
  ? h('button', { class: 'btn primary small', type: 'button', hidden: true, onClick: () => void app.startCapture({ thisTab: false }) }, icon('capture', 16), 'Share system audio')
  : h('button', { class: 'btn primary small', type: 'button', hidden: true, onClick: listen }, icon('mic', 16), 'Listen');
const banner = h('div', { class: 'banner glass', hidden: true }, bannerText, shareTab, shareSystem);

const dropzone = h('div', { class: 'dropzone' }, 'Drop to add to the queue');

hud.append(h('div', { class: 'scrim-top' }), h('div', { class: 'scrim-bottom' }), topbar.el, presenterPanel.el, welcome.el, queue.el, banner, dock.el);
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
  // librespot's audio plays in this page: the visualizers hear it like a local file.
  const inPage = Boolean(track && app.services.find((s) => s.id === track.source)?.audioInPage);
  const localPlaying = (track?.source === 'local' || inPage) && player.playing;
  engine.setAnalysisInput(capture.state.active && !localPlaying ? 'capture' : 'local');

  const needsCapture = Boolean(track && track.source !== 'local' && !inPage && !capture.state.active);
  banner.hidden = !needsCapture;
  const elsewhere = Boolean(track && app.services.find((s) => s.id === track.source)?.playsOutsidePage);
  shareTab.hidden = elsewhere && !desktop;
  shareSystem.hidden = !(elsewhere && !desktop);
  if (needsCapture && track && elsewhere && !desktop) {
    // Spotify Connect in the browser: the sound comes from the Spotify app, not this tab.
    bannerText.replaceChildren(
      h('strong', { text: `${SOURCE_NAMES[track.source]} plays in its own app, ` }),
      capture.supported
        ? "so the visualizers need this computer's sound: share your entire screen with system audio switched on."
        : 'so the visualizers can listen through the microphone.',
    );
  } else if (needsCapture && track) {
    bannerText.replaceChildren(
      h('strong', { text: `${SOURCE_NAMES[track.source]} audio is protected, ` }),
      desktop
        ? 'so the visualizers listen to what this computer plays instead.'
        : capture.supported
          ? 'so the visualizers listen to this tab instead. Share its audio to bring them to life.'
          : "and this browser can't share a tab's audio, so the visualizers can listen through the microphone instead.",
    );
  }
  welcome.hidden = player.queue.length > 0 || capture.state.active;
  document.title = track ? `${track.title}${track.artist ? ` · ${track.artist}` : ''} — Phosphor` : 'Phosphor';
}

// Streaming songs can only be visualized from shared tab audio. When one is
// started or resumed by a click (and the browser still counts that click as
// recent), open the share dialog straight away instead of leaving the user to
// find the banner. Only once per session: if they cancel, the banner stays.
let autoShareTried = false;
function maybeAutoShare() {
  const track = player.current;
  if (!track || track.source === 'local' || !player.playing || capture.state.active || autoShareTried) return;
  if (app.services.find((s) => s.id === track.source)?.audioInPage) return;
  if (!settings.get('autoShare') || !capture.supported) return;
  const activation = (navigator as Navigator & { userActivation?: { isActive: boolean } }).userActivation;
  if (!activation?.isActive) return;
  autoShareTried = true;
  // The desktop app hears the whole computer, without a dialog. Music playing
  // in another program (Spotify Connect) needs the computer's sound too.
  const elsewhere = Boolean(app.services.find((s) => s.id === track.source)?.playsOutsidePage);
  void app.startCapture({ thisTab: !desktop && !elsewhere });
}

player.on('track', (track) => {
  syncArtwork(track);
  route();
});
// Where Spotify plays can change (Widevine ready, librespot chosen): listen accordingly.
spotify.onStatus(() => route());

// Installable as an app; the tab icon dances while music plays.
registerServiceWorker();
// Inside the desktop app: the menu bar or tray visualizer, the mini player,
// presenter pages in other programs (the feed) and the control API.
const reportToDesktop = connectDesktop({ player, renderer, capture, presenter: app.presenter });
connectFeed(app.presenter);
connectRemote(app);
connectStage();
animateFavicon(() => renderer.audio, () => player.playing || capture.state.active);

// A local file gets a beat grid worked out in the background; until it
// arrives (and for everything else) the beat is tracked live. When songs
// are mixed, the next song's grid is worked out too.
let gridFor: string | null = null;
player.on('track', (track) => {
  const id = track?.id ?? null;
  if (id === gridFor) return;
  gridFor = id;
  renderer.setBeatGrid(null);
  const next = player.upNext;
  if (settings.get('transitionMode') === 'mix' && next?.source === 'local' && next.file) void beatGrids.forFile(next.file);
  if (track?.source !== 'local' || !track.file) return;
  void beatGrids.forFile(track.file).then((grid) => {
    if (grid && gridFor === id) renderer.setBeatGrid(grid);
  });
});

// How one song gives way to the next (Settings, Between songs).
let lastPlan: { key: string; plan: ReturnType<typeof planTransition> } | null = null;
player.setTransitionPlanner((current, next, duration) => {
  const crossfade = settings.get('songCrossfade');
  const local = current.source === 'local' && next.source === 'local';
  const mode = local ? settings.get('transitionMode') : 'crossfade';
  if (crossfade <= 0 && mode !== 'mix') return null;
  const outGrid = local && current.file ? beatGrids.peek(current.file) : null;
  const inGrid = local && next.file ? beatGrids.peek(next.file) : null;
  // The queue may have changed since the song started: work out the new next song's grid now.
  if (mode === 'mix' && next.file && inGrid === undefined) void beatGrids.forFile(next.file);
  const key = `${current.id}>${next.id}|${crossfade}|${mode}|${settings.get('mixStyle')}|${Math.round(duration)}|${Boolean(outGrid)}|${Boolean(inGrid)}`;
  if (lastPlan?.key !== key) {
    lastPlan = { key, plan: planTransition({ outDuration: duration, outGrid, inGrid, crossfade, mode, style: settings.get('mixStyle') }) };
  }
  return lastPlan.plan;
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
// A capture that hears nothing is usually a permission problem on macOS, or
// simply nothing playing yet. Say which to check rather than leaving it silent.
let silenceTimer = 0;
player.on('change', maybeAutoShare);
player.on('track', maybeAutoShare);

capture.on('change', (state) => {
  route();
  window.clearInterval(silenceTimer);
  if (!state.active) {
    toasts.show('Audio capture stopped.');
    return;
  }
  let loudest = 0;
  let checks = 0;
  silenceTimer = window.setInterval(() => {
    if (engine.analysisInput !== 'capture') return; // a local file is playing instead
    loudest = Math.max(loudest, renderer.audio.level);
    if (++checks < 32) return; // ~8 seconds
    window.clearInterval(silenceTimer);
    if (loudest > 0.01) return;
    const mac = detectPlatform() === 'mac' && state.kind === 'display' && state.label.startsWith('System');
    toasts.show(
      mac
        ? 'Nothing heard from the capture yet. If something is playing: open System Settings → Privacy & Security → Screen & System Audio Recording, switch Chrome on, then quit Chrome (Cmd+Q) and reopen it.'
        : 'Nothing heard from the capture yet. Start something playing in what you shared; if it stays silent, stop and share again with the audio switch on.',
      'error',
    );
  }, 250);
});

renderer.onChange = (def) => {
  topbar.render();
  if (settings.get('visualizer') !== def.id) settings.set({ visualizer: def.id });
  reportToDesktop?.();
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
    document.querySelector('.dock:hover, .topbar:hover, .drawer.open:hover, .banner:hover, .presenter-panel:hover') !== null ||
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
// Browsers only allow sound to start inside a user gesture, and Safari only
// counts some kinds of event, so unlock on all of them, synchronously.
for (const type of ['pointerdown', 'pointerup', 'mousedown', 'click', 'keydown', 'touchend'] as const) {
  window.addEventListener(type, () => engine.unlock(), { capture: true, passive: true });
}
engine.onBlocked = () =>
  toasts.show(
    detectBrowser().kind === 'safari'
      ? 'Safari is keeping the sound off. Click anywhere on the page to turn it on.'
      : 'The browser is keeping the sound off. Click anywhere on the page to turn it on.',
    'error',
  );

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
renderWelcomePlaylists();

window.setInterval(() => dock.tick(), 200);
window.setInterval(() => topbar.tick(), 50);

// Hooks for the automated verification scripts (see scripts/verify.cjs).
Object.assign(window, { __phosphor: { app, engine, renderer, player, capture, settings, presenter: app.presenter, harness: createHarness(renderer) } });
