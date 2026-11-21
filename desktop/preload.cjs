const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('pos', { quit: (pin) => ipcRenderer.invoke('quit-with-pin', pin) });
