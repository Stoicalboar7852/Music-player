// The mini player's bridge: what is playing, the music's levels, and its
// buttons (Previous, Play/Pause, Next, Open Phosphor).

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('phosphorMini', {
  platform: process.platform,
  command: (name) => ipcRenderer.send('mini:command', name),
  onState: (callback) => ipcRenderer.on('mini:state', (_event, state) => callback(state)),
  onLevels: (callback) => ipcRenderer.on('mini:levels', (_event, levels) => callback(levels)),
});
