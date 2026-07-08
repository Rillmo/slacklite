const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('slacklite', {
  isElectron: true,
  setBadge: (count) => ipcRenderer.send('badge', Number(count) || 0),
  focusWindow: () => ipcRenderer.send('focus-window'),
  onNewChannel: (callback) => ipcRenderer.on('new-channel', () => callback()),
});
