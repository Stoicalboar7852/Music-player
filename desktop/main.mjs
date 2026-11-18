// Phosphor's desktop app (Electron). It runs the same web app as the
// browser, served from a small local server on the development server's
// address (so Spotify and Google sign-ins registered for it keep working),
// and adds what a web page can't do:
//
//  - system audio for the visualizers without the share dialog (Windows; on
//    macOS where Chromium supports it, see the README),
//  - a live visualizer in the macOS menu bar or the Windows tray, with a mini
//    player under it and Play/Pause, Next and Previous,
//  - its own name and icon in Now Playing, the media keys and the Dock or
//    taskbar, plus Previous/Play/Next buttons on the Windows taskbar preview.
//
// The page reports what is playing and the music's levels through the bridge
// in preload.cjs; the tray and the mini player send their commands back.

import { app, BrowserWindow, desktopCapturer, ipcMain, Menu, nativeImage, nativeTheme, screen, session, shell, Tray } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from './server.mjs';
import { createMeter, drawGlyph, drawIcon, RESTING } from './tray-icon.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const isMac = process.platform === 'darwin';
const isWindows = process.platform === 'win32';

app.setName('Phosphor');
// macOS: let Chromium hand system audio to a screen capture (ScreenCaptureKit
// or Core Audio taps, depending on the macOS version). Unknown flags are ignored.
if (isMac) app.commandLine.appendSwitch('enable-features', 'MacLoopbackAudioForScreenShare,MacSckSystemAudioLoopbackOverride,MacCatapLoopbackAudioForScreenShare');
// The analysis keeps running while the window is hidden: the menu bar or tray
// visualizer and the mini player follow the music.
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-background-timer-throttling');

/** @type {BrowserWindow | null} */
let win = null;
/** @type {BrowserWindow | null} */
let mini = null;
/** @type {Tray | null} */
let tray = null;
/** @type {{ url: string, origin: string, port: number, close(): Promise<void> } | null} */
let server = null;
let quitting = false;

/** What the page last reported. */
let state = { title: '', artist: '', artwork: '', source: '', playing: false, listening: false };
let levels = null;
let levelsAt = 0;
let trayFrames = 0;
const meter = createMeter();

// ------------------------------------------------------------------ window

function showWindow() {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 640,
    minHeight: 480,
    title: 'Phosphor',
    backgroundColor: '#000000',
    show: false,
    titleBarStyle: isMac ? 'hiddenInset' : 'default',
    icon: isMac ? undefined : path.join(here, 'web', 'icons', 'icon-512.png'),
    webPreferences: {
      preload: path.join(here, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      backgroundThrottling: false,
    },
  });
  win.once('ready-to-show', () => {
    win?.show();
    if (isWindows) updateTaskbarButtons();
  });
  void win.loadURL(server.url);

  // Like other music players, closing the window keeps the music going; the
  // menu bar or tray icon, the Dock or the taskbar bring it back.
  win.on('close', (event) => {
    if (quitting) return;
    event.preventDefault();
    win?.hide();
  });

  // Sign-in pop-ups (Google for YouTube, Apple Music) open inside the app;
  // any other link opens in the browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    let host = '';
    try {
      host = new URL(url).hostname;
    } catch {
      return { action: 'deny' };
    }
    const signIn = ['accounts.google.com', 'authorize.music.apple.com', 'idmsa.apple.com', 'appleid.apple.com', 'accounts.spotify.com'];
    if (signIn.some((h) => host === h || host.endsWith(`.${h}`))) {
      return { action: 'allow', overrideBrowserWindowOptions: { width: 520, height: 720, autoHideMenuBar: true } };
    }
    if (url.startsWith('http:') || url.startsWith('https:')) void shell.openExternal(url);
    return { action: 'deny' };
  });
}

// -------------------------------------------------------- audio and access

function setUpSession() {
  const ses = session.defaultSession;
  const ours = (url) => {
    try {
      return new URL(url).origin === server.origin;
    } catch {
      return false;
    }
  };
  // The microphone or another audio input (Add music, System audio, Listen),
  // full screen, and the system-audio capture below: for Phosphor's own page only.
  ses.setPermissionRequestHandler((contents, permission, callback, details) => {
    const allowed = ['media', 'display-capture', 'fullscreen', 'clipboard-sanitized-write'];
    callback(allowed.includes(permission) && ours(details.requestingUrl || contents.getURL()));
  });
  ses.setPermissionCheckHandler((_contents, permission, origin) => ['media', 'display-capture', 'fullscreen'].includes(permission) && ours(origin));

  // System audio without the share dialog: a request to capture (the page
  // asks when you choose System audio, or start a streaming song) gets the
  // whole screen with the computer's sound. Only the sound is used; the page
  // stops the picture at once.
  ses.setDisplayMediaRequestHandler(
    async (request, callback) => {
      if (!ours(request.securityOrigin)) return callback(null);
      try {
        const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } });
        if (!sources.length) return callback(null);
        try {
          callback({ video: sources[0], audio: 'loopback' });
        } catch {
          // No system audio here (see the README): the page explains what to do instead.
          callback({ video: sources[0] });
        }
      } catch {
        callback(null);
      }
    },
    { useSystemPicker: false },
  );
}

// --------------------------------------------------- menu bar / tray icon

function iconImage(heights) {
  const image = nativeImage.createFromBuffer(drawIcon(heights, { size: isMac ? 36 : 32, template: isMac }), { scaleFactor: 2 });
  if (isMac) image.setTemplateImage(true);
  return image;
}

function describe() {
  if (!state.title) return state.listening ? 'Listening' : 'Nothing playing';
  const text = state.artist ? `${state.title} — ${state.artist}` : state.title;
  return text.length > 64 ? `${text.slice(0, 63)}…` : text;
}

function trayMenu() {
  return Menu.buildFromTemplate([
    { label: describe(), enabled: false },
    { type: 'separator' },
    { label: state.playing ? 'Pause' : 'Play', click: () => command('toggle') },
    { label: 'Next', click: () => command('next') },
    { label: 'Previous', click: () => command('previous') },
    { type: 'separator' },
    { label: 'Show Phosphor', click: showWindow },
    { label: 'Quit Phosphor', click: () => app.quit() },
  ]);
}

function createTray() {
  tray = new Tray(iconImage(RESTING));
  tray.setToolTip('Phosphor');
  if (isMac) tray.setIgnoreDoubleClickEvents(true);
  tray.on('click', toggleMini);
  tray.on('right-click', () => tray?.popUpContextMenu(trayMenu()));

  // About twelve frames a second while there is music; the logo otherwise.
  let resting = true;
  setInterval(() => {
    if (!tray) return;
    const live = (state.playing || state.listening) && performance.now() - levelsAt < 600;
    if (live) {
      tray.setImage(iconImage(meter.update(levels, 1 / 12)));
      trayFrames++;
      resting = false;
    } else if (!resting) {
      tray.setImage(iconImage(meter.rest()));
      resting = true;
    }
  }, 1000 / 12);
}

// ------------------------------------------------------------- mini player

function createMini() {
  mini = new BrowserWindow({
    width: 320,
    height: 404,
    show: false,
    frame: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    transparent: isMac,
    backgroundColor: isMac ? '#00000000' : '#0e0e16',
    vibrancy: isMac ? 'popover' : undefined,
    visualEffectState: isMac ? 'active' : undefined,
    roundedCorners: true,
    webPreferences: {
      preload: path.join(here, 'mini-preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      backgroundThrottling: false,
    },
  });
  void mini.loadFile(path.join(here, 'mini', 'index.html'));
  mini.on('blur', () => {
    if (!mini?.webContents.isDevToolsOpened()) mini?.hide();
  });
  mini.webContents.on('did-finish-load', () => mini?.webContents.send('mini:state', state));
}

function positionMini() {
  if (!mini || !tray) return;
  const t = tray.getBounds();
  const { width, height } = mini.getBounds();
  const area = screen.getDisplayNearestPoint({ x: Math.round(t.x + t.width / 2), y: Math.round(t.y + t.height / 2) }).workArea;
  let x = Math.round(t.x + t.width / 2 - width / 2);
  // Under the menu bar icon on a Mac; above (or beside) the tray icon on Windows, wherever the taskbar is.
  let y = isMac || t.y < area.y + area.height / 2 ? Math.round(t.y + t.height + 6) : Math.round(t.y - height - 6);
  if (!isMac && t.x + t.width <= area.x) x = area.x + 6; // taskbar on the left
  if (!isMac && t.x >= area.x + area.width) x = area.x + area.width - width - 6; // on the right
  x = Math.max(area.x + 6, Math.min(x, area.x + area.width - width - 6));
  y = Math.max(area.y + 6, Math.min(y, area.y + area.height - height - 6));
  mini.setPosition(x, y, false);
}

function toggleMini() {
  if (!mini) createMini();
  if (mini.isVisible()) {
    mini.hide();
    return;
  }
  positionMini();
  mini.show();
  mini.focus();
  mini.webContents.send('mini:state', state);
}

// -------------------------------------------------- Windows taskbar buttons

let glyphs = null;
function updateTaskbarButtons() {
  if (!win || !isWindows) return;
  glyphs ??= Object.fromEntries(['previous', 'play', 'pause', 'next'].map((k) => [k, nativeImage.createFromBuffer(drawGlyph(k, 32), { scaleFactor: 2 })]));
  win.setThumbarButtons([
    { tooltip: 'Previous', icon: glyphs.previous, click: () => command('previous') },
    { tooltip: state.playing ? 'Pause' : 'Play', icon: state.playing ? glyphs.pause : glyphs.play, click: () => command('toggle') },
    { tooltip: 'Next', icon: glyphs.next, click: () => command('next') },
  ]);
}

// ---------------------------------------------------------------- the page

/** Play/Pause, Next and Previous go to the player in the page. */
function command(name) {
  if (['toggle', 'next', 'previous'].includes(name)) win?.webContents.send('phosphor:command', name);
}

const text = (value, max = 300) => (typeof value === 'string' ? value.slice(0, max) : '');

/**
 * Messages count only from Phosphor's own page in the main window. (A
 * sign-in page from Spotify, Google or Apple can be shown in the window or a
 * pop-up for a moment, and gets the same preload.)
 */
function fromPhosphor(event) {
  if (event.sender !== win?.webContents) return false;
  try {
    return new URL(event.senderFrame?.url ?? '').origin === server?.origin;
  } catch {
    return false;
  }
}

function setUpMessages() {
  ipcMain.on('phosphor:state', (event, next) => {
    if (!fromPhosphor(event) || !next || typeof next !== 'object') return;
    const before = state.playing;
    state = {
      title: text(next.title),
      artist: text(next.artist),
      // A small data: URL (or a web address) for the mini player's artwork.
      artwork: text(next.artwork, 400_000),
      source: text(next.source, 40),
      playing: Boolean(next.playing),
      listening: Boolean(next.listening),
    };
    tray?.setToolTip(`Phosphor — ${describe()}`);
    if (isWindows && before !== state.playing) updateTaskbarButtons();
    mini?.webContents.send('mini:state', state);
  });

  ipcMain.on('phosphor:levels', (event, next) => {
    if (!fromPhosphor(event) || !next || typeof next !== 'object') return;
    levels = next;
    levelsAt = performance.now();
    if (mini?.isVisible()) mini.webContents.send('mini:levels', next);
  });

  ipcMain.on('phosphor:open-spotify', (event) => {
    if (fromPhosphor(event)) void shell.openExternal('spotify:').catch(() => {});
  });

  ipcMain.on('mini:command', (event, name) => {
    if (event.sender !== mini?.webContents) return;
    if (name === 'show') {
      showWindow();
      mini?.hide();
    } else if (name === 'hide') mini?.hide();
    else command(name);
  });
}

// -------------------------------------------------------------------- menu

function buildMenu() {
  const playback = {
    label: 'Playback',
    submenu: [
      { label: 'Play/Pause', click: () => command('toggle') },
      { label: 'Next', click: () => command('next') },
      { label: 'Previous', click: () => command('previous') },
    ],
  };
  /** @type {Electron.MenuItemConstructorOptions[]} */
  const template = [
    ...(isMac ? [/** @type {Electron.MenuItemConstructorOptions} */ ({ role: 'appMenu' })] : []),
    { role: 'fileMenu' },
    { role: 'editMenu' },
    playback,
    { role: 'viewMenu' },
    { role: 'windowMenu' },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ------------------------------------------------------------------- start

// For the smoke test (desktop/smoke-test.mjs), which drives the packaged app.
globalThis.__phosphorDesktop = {
  get server() {
    return server?.url ?? null;
  },
  get trayFrames() {
    return trayFrames;
  },
  get hasTray() {
    return Boolean(tray);
  },
  get state() {
    return state;
  },
  get miniVisible() {
    return Boolean(mini?.isVisible());
  },
  command,
  toggleMini,
};

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', showWindow);
  app.on('activate', showWindow);
  app.on('before-quit', () => {
    quitting = true;
  });
  app.on('window-all-closed', () => {
    if (!isMac) app.quit();
  });

  app.whenReady().then(async () => {
    nativeTheme.themeSource = 'dark';
    server = await startServer(path.join(here, 'web'));
    setUpSession();
    setUpMessages();
    buildMenu();
    createWindow();
    createTray();
  });

  app.on('will-quit', () => {
    void server?.close();
  });
}
