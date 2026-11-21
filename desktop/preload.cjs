const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('pos', {
  quit: (pin) => ipcRenderer.invoke('quit-with-pin', pin),
  minimise: () => ipcRenderer.invoke('win-minimise'),
  minimize: () => ipcRenderer.invoke('win-minimise'),
});
