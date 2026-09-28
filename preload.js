'use strict';
/* WinGroove Reboot - safe bridge between the renderer and the main process */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('wgNative', {
  readDefaultSoundfont: () => ipcRenderer.invoke('wg:default-sf'),
  openMidi: () => ipcRenderer.invoke('wg:open', 'midi'),
  openSoundfont: () => ipcRenderer.invoke('wg:open', 'sf2'),
  saveFile: (name, data) => ipcRenderer.invoke('wg:save', name, data),
  onOpenFiles: (cb) => ipcRenderer.on('wg:files', (_e, files) => cb(files)),
  ready: () => ipcRenderer.send('wg:ready'),
});
