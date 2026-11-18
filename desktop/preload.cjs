// The bridge between Phosphor's page and the desktop app (main.mjs). The
// page reports what is playing and the music's levels, for the menu bar or
// tray visualizer and the mini player, and receives Play/Pause, Next and
// Previous from them. Nothing else of Electron or Node is exposed.

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
});
