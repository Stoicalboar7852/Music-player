// The presenter window: only the visuals, for a screen an audience sees.
//
// It has no controls. It draws the same visualizer as the main window from
// that window's analysis (asking for a frame every animation frame), and
// shows whatever overlays the main window switches on: a QR code for the
// song, the title, a logo, blackout, freeze. Double-click or F fills the
// screen; the main window can also make it fill a chosen screen.

import './present.css';

import type { RGB } from '../viz/palette';
import { Renderer, type RendererAudio } from '../viz/renderer';
import {
  CHANNEL,
  SOURCE_PROPERTY,
  screenDetails,
  screenPermission,
  type ControllerMessage,
  type FrameSource,
  type FullscreenRequest,
  type PresenterMessage,
  type PresenterState,
  type ScreenDetails,
} from './protocol';
import { qrSvg } from './qr';

const canvas = document.getElementById('stage') as HTMLCanvasElement;
const layer = document.getElementById('overlays') as HTMLElement;
const id = crypto.randomUUID();
const channel = new BroadcastChannel(CHANNEL);
/**
 * present.html?feed: a page in another program (a FreeShow web item, an OBS
 * browser source) gets its frames through the desktop app's local server
 * instead of the BroadcastChannel, which only reaches this browser's windows.
 */
const feedMode = new URLSearchParams(location.search).has('feed');
let socket: WebSocket | null = null;
const send = (message: PresenterMessage) => {
  if (!feedMode) channel.postMessage(message);
  else if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
};

/** This window never reads audio; frames arrive from the main window. */
const noAudio: RendererAudio = {
  context: { sampleRate: 48000 },
  analysisInput: 'none',
  element: { currentTime: 0 },
  read(left, right) {
    left.fill(0);
    right.fill(0);
  },
};

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, parent: HTMLElement = layer): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  parent.append(node);
  return node;
}

// ------------------------------------------------------------------ overlays

const logo = el('div', 'ov ov-logo');
const logoImg = el('img', '', logo);
logoImg.alt = '';
const logoMark = el('div', 'mark', logo);
for (let i = 0; i < 4; i++) el('i', '', logoMark);
el('span', 'word', logo).textContent = 'Phosphor';

const title = el('div', 'ov ov-title');
const titleArt = el('img', 'art', title);
titleArt.alt = '';
const titleText = el('div', 'text', title);
const titleName = el('b', '', titleText);
const titleArtist = el('span', '', titleText);

const qr = el('div', 'ov ov-qr');
const qrCode = el('div', 'code', qr);
const qrCaption = el('span', 'caption', qr);
qrCaption.textContent = 'Scan for this song';
const qrSource = el('small', 'source', qr);

const black = el('div', 'ov ov-black');
const waiting = el('div', 'ov ov-hint ov-waiting');
waiting.textContent = feedMode ? 'Waiting for the Phosphor app…' : 'Waiting for Phosphor… (press Present in the main window)';
const hint = el('div', 'ov ov-hint ov-fullscreen-hint');
hint.textContent = 'Double-click or press F to fill the screen';

let renderer: Renderer;
try {
  renderer = new Renderer(canvas, noAudio, { follower: true });
} catch (error) {
  waiting.textContent = `This window can't draw the visuals: ${(error as Error).message}`;
  waiting.classList.add('show', 'error');
  throw error;
}

let state: PresenterState | null = null;
let qrFor = '';
let artworkFor = '';
let blackTimer = 0;
/** Blackout has finished fading in: nothing underneath needs drawing. */
let blackedOut = false;

function updateFrozen() {
  renderer.frozen = Boolean(state?.overlays.freeze) || blackedOut;
}

function applyState(next: PresenterState) {
  const before = state;
  state = next;
  if (next.visualizer && next.visualizer !== renderer.currentId) {
    renderer.crossfadeSeconds = before ? next.crossfadeSeconds : 0;
    renderer.setVisualizer(next.visualizer, { immediate: !before });
  }
  renderer.crossfadeSeconds = next.crossfadeSeconds;
  if (next.quality !== before?.quality) renderer.setQuality(next.quality);
  if (next.variant && next.variant !== renderer.variant) renderer.setVariant(next.variant);

  if (next.artwork !== artworkFor) {
    artworkFor = next.artwork;
    if (!next.artwork) {
      renderer.setArtwork(null);
      setPalette(next.palette);
    } else {
      const image = new Image();
      image.onload = () => {
        if (artworkFor !== next.artwork) return;
        renderer.setArtwork(image);
        setPalette(state?.palette ?? next.palette);
      };
      image.src = next.artwork;
    }
  } else {
    setPalette(next.palette);
  }

  const o = next.overlays;
  // Title: lower third.
  const track = next.track;
  titleName.textContent = track?.title ?? '';
  titleArtist.textContent = [track?.artist, track?.album].filter(Boolean).join(' · ');
  titleArt.hidden = !next.artwork;
  if (next.artwork) titleArt.src = next.artwork;
  title.classList.toggle('show', o.title && Boolean(track?.title));

  // QR code: the song's own link, hidden for songs without one.
  if (next.link && next.link !== qrFor) {
    qrFor = next.link;
    qrCode.innerHTML = qrSvg(next.link);
    qr.dataset.link = next.link;
  }
  qrSource.textContent = track ? `${track.title}${track.artist ? ` — ${track.artist}` : ''} · ${track.sourceName}` : '';
  qr.dataset.size = next.qrSize;
  qr.classList.toggle('show', o.qr && Boolean(next.link));

  // Logo: the chosen image, or Phosphor's mark.
  logo.classList.toggle('custom', Boolean(next.logo));
  if (next.logo && logoImg.src !== next.logo) logoImg.src = next.logo;
  logo.classList.toggle('show', o.logo);

  // Blackout fades; once it is black, stop drawing underneath.
  black.classList.toggle('show', o.blackout);
  if (o.blackout && !blackTimer && !blackedOut) {
    blackTimer = window.setTimeout(() => {
      blackTimer = 0;
      blackedOut = Boolean(state?.overlays.blackout);
      updateFrozen();
    }, 800);
  } else if (!o.blackout) {
    window.clearTimeout(blackTimer);
    blackTimer = 0;
    blackedOut = false;
  }
  updateFrozen();
  document.body.classList.toggle('frozen', o.freeze);
}

let paletteKey = '';
function setPalette(values: number[]) {
  const key = values.map((v) => v.toFixed(3)).join(',');
  if (key === paletteKey || values.length < 12) return;
  paletteKey = key;
  const colors: RGB[] = [0, 1, 2, 3].map((i) => [values[i * 3], values[i * 3 + 1], values[i * 3 + 2]]);
  renderer.setPalette(colors, !state);
}

// ------------------------------------------------------------------- frames

let lastFrameAt = 0;
/** Age of each frame when drawn, and when it arrived (ms since the main window read the audio). */
const latencies: number[] = [];
const arrivals: number[] = [];
let frames = 0;
let fps = 0;
let fpsSince = performance.now();

/** Takes a frame from the main window: its audio, as analysed there. */
function adopt(buffer: ArrayBuffer) {
  const decoded = renderer.adoptFrame(buffer);
  if (!decoded) return;
  lastFrameAt = performance.now();
  arrivals.push(Math.max(0, performance.timeOrigin + lastFrameAt - decoded.readAt));
  if (arrivals.length > 240) arrivals.shift();
  waiting.classList.remove('show');
  document.body.classList.remove('no-signal');
}

/** The main window that opened this one, if it can be called directly (see FrameSource). */
function directSource(): FrameSource | null {
  try {
    const source = (window.opener as Record<string, unknown> | null)?.[SOURCE_PROPERTY] as FrameSource | undefined;
    return source && typeof source.pull === 'function' ? source : null;
  } catch {
    return null;
  }
}

// Right before each frame: the newest analysis, straight from the main window.
renderer.beforeFrame = () => {
  const source = directSource();
  if (!source) return;
  try {
    adopt(source.pull(id));
  } catch {
    /* the main window is closing or reloading; the channel takes over */
  }
};

function handle(message: ControllerMessage) {
  if (!message || typeof message !== 'object') return;
  if (message.type === 'frame') {
    if (message.to === id) adopt(message.frame);
  } else if (message.type === 'state') {
    applyState(message.state);
  } else if (message.type === 'close') {
    // A window Phosphor opened closes; a page in another program goes dark until it's back.
    if (feedMode) lastFrameAt = 0;
    else window.close();
  }
}

if (feedMode) {
  const connect = () => {
    const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/feed?role=viewer`);
    ws.binaryType = 'arraybuffer';
    socket = ws;
    ws.onopen = () => send({ type: 'hello', id });
    ws.onmessage = (event) => {
      if (typeof event.data === 'string') {
        try {
          handle(JSON.parse(event.data) as ControllerMessage);
        } catch {
          /* not ours */
        }
      } else adopt(event.data as ArrayBuffer);
    };
    ws.onclose = () => window.setTimeout(connect, 1000);
  };
  connect();
} else {
  channel.onmessage = (event: MessageEvent<ControllerMessage>) => handle(event.data);
}

// How far behind the main window: from it reading the audio to this window
// starting to draw that frame (the main window draws what it reads at once;
// drawing and getting it on screen take the same time in both).
renderer.onDrawn = (now) => {
  frames++;
  const adopted = renderer.adopted;
  if (adopted) {
    latencies.push(Math.max(0, performance.timeOrigin + now - adopted.readAt));
    if (latencies.length > 240) latencies.shift();
  }
};

// Without a direct line to the main window: ask over the channel once per
// animation frame, timed to arrive just before the next one is drawn (rather
// than a whole frame early).
let interval = 1000 / 60;
let lastRaf = 0;
let pullTimer = 0;
const pull = () => {
  if (!directSource()) send({ type: 'pull', id });
};
requestAnimationFrame(function frame(now) {
  if (lastRaf) interval += (Math.min(100, now - lastRaf) - interval) * 0.1;
  lastRaf = now;
  window.clearTimeout(pullTimer);
  const lead = Math.min(interval - 2, Math.max(4, interval * 0.35));
  pullTimer = window.setTimeout(pull, Math.max(0, interval - lead - (performance.now() - now)));
  requestAnimationFrame(frame);
});

// No frames for a while: the main window closed or reloaded. Fade out.
window.setInterval(() => {
  const silent = performance.now() - lastFrameAt > 3000;
  document.body.classList.toggle('no-signal', silent);
  waiting.classList.toggle('show', silent);
}, 500);

let screenLabel = '';
let screens: ScreenDetails | null = null;
void screenPermission().then(async (permission) => {
  if (permission !== 'granted') return;
  screens = await screenDetails();
  screenLabel = screens?.currentScreen.label ?? '';
  screens?.addEventListener('currentscreenchange', () => (screenLabel = screens?.currentScreen.label ?? ''));
});

// A report for the main window twice a second.
window.setInterval(() => {
  const now = performance.now();
  fps = (frames * 1000) / Math.max(1, now - fpsSince);
  frames = 0;
  fpsSince = now;
  const sorted = [...latencies].sort((a, b) => a - b);
  const mean = sorted.length ? sorted.reduce((s, v) => s + v, 0) / sorted.length : 0;
  send({
    type: 'stats',
    id,
    stats: {
      fps: Math.round(fps * 10) / 10,
      latency: {
        mean: Math.round(mean * 10) / 10,
        p95: Math.round((sorted[Math.floor(sorted.length * 0.95)] ?? 0) * 10) / 10,
        max: Math.round((sorted[sorted.length - 1] ?? 0) * 10) / 10,
      },
      width: canvas.width,
      height: canvas.height,
      fullscreen: Boolean(document.fullscreenElement),
      screen: screenLabel,
      frozen: renderer.frozen,
    },
  });
}, 500);

send({ type: 'hello', id });
window.addEventListener('pagehide', () => send({ type: 'bye', id }));
renderer.start();

// --------------------------------------------------------------- full screen

async function fillScreen(target: { left: number; top: number } | null): Promise<void> {
  const screen = target ? screens?.screens.find((s) => s.left === target.left && s.top === target.top) : undefined;
  const options = screen ? ({ screen } as FullscreenOptions) : undefined;
  await document.documentElement.requestFullscreen(options);
}

function toggleFullscreen() {
  if (document.fullscreenElement) void document.exitFullscreen();
  else void fillScreen(null).catch(() => {});
}

// From the main window's Present panel, with its click handed over.
window.addEventListener('message', (event: MessageEvent<FullscreenRequest>) => {
  if (event.origin !== location.origin || event.data?.type !== 'phosphor-fullscreen') return;
  const target = event.data.screen;
  void fillScreen(target).then(
    () => send({ type: 'fullscreen-result', id, ok: true }),
    (error: Error) => send({ type: 'fullscreen-result', id, ok: false, error: error?.message ?? String(error) }),
  );
});

canvas.addEventListener('dblclick', toggleFullscreen);
layer.addEventListener('dblclick', toggleFullscreen);
window.addEventListener('keydown', (e) => {
  if (e.key === 'f' || e.key === 'F') toggleFullscreen();
});

// The cursor and the hints show only while the mouse moves.
let idle = 0;
function wake() {
  document.body.classList.add('awake');
  window.clearTimeout(idle);
  idle = window.setTimeout(() => document.body.classList.remove('awake'), 2200);
}
// Inside other programs (a FreeShow web item, an NDI frame) nothing shows but the visuals.
if (!feedMode) window.addEventListener('mousemove', wake);
document.addEventListener('fullscreenchange', () => {
  document.body.classList.toggle('fullscreen', Boolean(document.fullscreenElement));
});

Object.assign(window, { __presenter: { renderer, id, get state() { return state; }, latencies, arrivals } });
