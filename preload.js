'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('wgNative', {
  // App / File IO
  onFileDrop: (fn) => ipcRenderer.on('open-files', (_e, files) => fn(files)),
  loadDefaultSoundfont: () => ipcRenderer.invoke('load-default-soundfont'),
  openFileDialog: () => ipcRenderer.invoke('open-file-dialog'),
  openSoundfontDialog: () => ipcRenderer.invoke('open-soundfont-dialog'),
  openSoundfontsFolder: () => ipcRenderer.invoke('open-soundfonts-folder'),
  saveWavDialog: (suggested) => ipcRenderer.invoke('save-wav-dialog', suggested),
  saveWavFile: (filePath, data) => ipcRenderer.invoke('save-wav-file', filePath, data),

  // Multi-window & Attached Instruments Window
  toggleInstrumentsWindow: (show) => ipcRenderer.send('toggle-instruments-window', show),
  setInstrumentsAttached: (attached, dockPos) => ipcRenderer.send('set-instruments-attached', attached, dockPos),
  setInstrumentsHeight: (h) => ipcRenderer.send('set-instruments-height', h),
  sendInstrumentsCmd: (cmd) => ipcRenderer.send('instruments-cmd', cmd),
  onInstrumentsCmd: (fn) => ipcRenderer.on('instruments-cmd', (_e, cmd) => fn(cmd)),
  relayInstrumentsState: (state) => ipcRenderer.send('relay-instruments-state', state),
  onInstrumentsState: (fn) => ipcRenderer.on('instruments-state', (_e, state) => fn(state)),
  onInstrumentsWinStatus: (fn) => ipcRenderer.on('instruments-win-status', (_e, st) => fn(st)),
  onPlayerWindowMoved: (fn) => ipcRenderer.on('player-window-moved', (_e, b) => fn(b))
});
