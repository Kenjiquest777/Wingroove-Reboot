'use strict';
/* WinGroove Reboot - Electron main process */
const { app, BrowserWindow, ipcMain, dialog, Menu } = require('electron');
const path = require('path');
const fs = require('fs/promises');

const OPENABLE = /\.(midi?|rmi|kar|sf2)$/i;
const MIDI_FILTER = { name: 'MIDI Files', extensions: ['mid', 'midi', 'rmi', 'kar'] };
const SF_FILTER = { name: 'SoundFont 2', extensions: ['sf2'] };

let win = null;
let rendererReady = false;
const pending = [];

const argFiles = (argv) => argv.slice(1).filter((a) => !a.startsWith('-') && OPENABLE.test(a));

async function readItems(paths) {
  const out = [];
  for (const p of paths) {
    try {
      const buf = await fs.readFile(p);
      out.push({ name: path.basename(p), data: new Uint8Array(buf) });
    } catch (err) {
      console.error('Could not read', p, err.message);
    }
  }
  return out;
}

async function sendFiles(paths) {
  if (!paths.length) return;
  if (!win || !rendererReady) { pending.push(...paths); return; }
  win.webContents.send('wg:files', await readItems(paths));
}

function createWindow() {
  win = new BrowserWindow({
    width: 660,
    height: 760,
    minWidth: 520,
    minHeight: 560,
    title: 'WinGroove Reboot',
    backgroundColor: '#008080',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      autoplayPolicy: 'no-user-gesture-required',
    },
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.on('closed', () => { win = null; rendererReady = false; });
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', (_e, argv) => {
    if (win) { if (win.isMinimized()) win.restore(); win.focus(); }
    sendFiles(argFiles(argv));
  });

  // macOS: files opened from Finder / dock
  app.on('open-file', (e, p) => { e.preventDefault(); sendFiles([p]); });

  pending.push(...argFiles(process.argv));

  app.whenReady().then(() => {
    if (process.platform !== 'darwin') Menu.setApplicationMenu(null);

    ipcMain.on('wg:ready', () => {
      rendererReady = true;
      const files = pending.splice(0);
      if (files.length) sendFiles(files);
    });

    ipcMain.handle('wg:default-sf', async () => {
      try {
        const buf = await fs.readFile(path.join(__dirname, 'renderer', 'soundfonts', 'WinGroove.sf2'));
        return new Uint8Array(buf);
      } catch (_) {
        return null;
      }
    });

    ipcMain.handle('wg:open', async (_e, kind) => {
      const isSf = kind === 'sf2';
      const res = await dialog.showOpenDialog(win, {
        title: isSf ? 'Load SoundFont' : 'Open MIDI Files',
        properties: isSf ? ['openFile'] : ['openFile', 'multiSelections'],
        filters: [isSf ? SF_FILTER : MIDI_FILTER, { name: 'All Files', extensions: ['*'] }],
      });
      if (res.canceled) return [];
      return readItems(res.filePaths);
    });

    ipcMain.handle('wg:save', async (_e, name, data) => {
      const res = await dialog.showSaveDialog(win, {
        title: 'Save as WAV',
        defaultPath: path.join(app.getPath('music'), String(name || 'song.wav')),
        filters: [{ name: 'WAVE Audio', extensions: ['wav'] }],
      });
      if (res.canceled || !res.filePath) return null;
      await fs.writeFile(res.filePath, Buffer.from(data));
      return res.filePath;
    });

    createWindow();
    app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
  });

  app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
}
