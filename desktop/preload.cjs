// The bridge between Phosphor's page and the desktop app (main.mjs). The
// page reports what is playing and the music's levels, for the menu bar or
// tray visualizer and the mini player, and receives Play/Pause, Next and
// Previous from them; it can also place the presenter window on a display.
// Nothing else of Electron or Node is exposed.

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('phosphorDesktop', {
  platform: process.platform,
  sendState: (state) => ipcRenderer.send('phosphor:state', state),
  sendLevels: (levels) => ipcRenderer.send('phosphor:levels', levels),
  onCommand: (callback) => {
    const listener = (_event, name) => callback(name);
    ipcRenderer.on('phosphor:command', listener);
    return () => ipcRenderer.removeListener('phosphor:command', listener);
  },
  // Spotify in the Spotify app (Spotify Connect): start it if it isn't running.
  openSpotify: () => ipcRenderer.send('phosphor:open-spotify'),
  // Widevine (for Spotify's web player in the app): ready yet, and a call when it becomes ready.
  widevine: () => ipcRenderer.invoke('phosphor:widevine'),
  onWidevine: (callback) => {
    const listener = () => callback();
    ipcRenderer.on('phosphor:widevine', listener);
    return () => ipcRenderer.removeListener('phosphor:widevine', listener);
  },
  // Optional Spotify playback through librespot (see librespot.mjs).
  spot: {
    available: () => ipcRenderer.invoke('phosphor:spot-available'),
    start: (options) => ipcRenderer.send('phosphor:spot-start', options),
    stop: () => ipcRenderer.send('phosphor:spot-stop'),
    onAudio: (callback) => {
      const listener = (_event, chunk) => callback(chunk);
      ipcRenderer.on('phosphor:spot-audio', listener);
      return () => ipcRenderer.removeListener('phosphor:spot-audio', listener);
    },
    onState: (callback) => {
      const listener = (_event, state) => callback(state);
      ipcRenderer.on('phosphor:spot-state', listener);
      return () => ipcRenderer.removeListener('phosphor:spot-state', listener);
    },
  },
  // Presentation software: the feed for presenter pages elsewhere, the control API.
  feed: () => ipcRenderer.invoke('phosphor:feed'),
  stageInfo: () => ipcRenderer.invoke('phosphor:stage-info'),
  onRemote: (callback) => {
    const listener = (_event, request) => {
      Promise.resolve(callback(request.name, request.params ?? {})).then(
        (result) => ipcRenderer.send('phosphor:remote-reply', { id: request.id, ...(result && typeof result === 'object' ? result : {}) }),
        (error) => ipcRenderer.send('phosphor:remote-reply', { id: request.id, error: String(error?.message ?? error) }),
      );
    };
    ipcRenderer.on('phosphor:remote', listener);
    return () => ipcRenderer.removeListener('phosphor:remote', listener);
  },
  // Presentation software: NDI output, ProPresenter and FreeShow cue sync.
  stage: {
    configure: (config) => ipcRenderer.send('phosphor:stage-configure', config),
    status: () => ipcRenderer.invoke('phosphor:stage-status'),
    onStatus: (callback) => {
      const listener = (_event, status) => callback(status);
      ipcRenderer.on('phosphor:stage-status', listener);
      return () => ipcRenderer.removeListener('phosphor:stage-status', listener);
    },
  },
  // The presenter window: which displays it can fill, and filling one.
  presenterDisplays: () => ipcRenderer.invoke('phosphor:presenter-displays'),
  presentOn: (id) => ipcRenderer.send('phosphor:present-on', id),
});
