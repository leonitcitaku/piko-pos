const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('pos', {
  quit: (pin) => ipcRenderer.invoke('quit-with-pin', pin),
  minimise: () => ipcRenderer.invoke('win-minimise'),
  minimize: () => ipcRenderer.invoke('win-minimise'),
  getAutostart: () => ipcRenderer.invoke('autostart-get'),
  setAutostart: (on) => ipcRenderer.invoke('autostart-set', on),
  getPower: () => ipcRenderer.invoke('power-get'),
  setPower: (on) => ipcRenderer.invoke('power-set', on),
});
