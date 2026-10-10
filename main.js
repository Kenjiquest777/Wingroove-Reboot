'use strict';
/* WinGroove Reboot - Electron main process */
const { app, BrowserWindow, ipcMain, dialog, Menu, shell } = require('electron');
const path = require('path');
const fs = require('fs/promises');
const fsSync = require('fs');

const OPENABLE = /\.(midi?|rmi|kar|sf2)$/i;
const MIDI_FILTER = { name: 'MIDI Files', extensions: ['mid', 'midi', 'rmi', 'kar'] };
const SF_FILTER = { name: 'SoundFont 2', extensions: ['sf2'] };

let win = null;
let rendererReady = false;
const pending = [];

const argFiles = (argv) => argv.slice(1).filter((a) => !a.startsWith('-') && OPENABLE.test(a));

function getSoundfontsDir() {
  const candidates = [
    path.join(path.dirname(app.getPath('exe')), 'soundfonts'),
    path.join(process.resourcesPath, 'soundfonts'),
    path.join(__dirname, 'soundfonts'),
    path.join(__dirname, 'renderer', 'soundfonts'),
  ];
  for (const c of candidates) {
    try {
      if (fsSync.existsSync(c)) return c;
    } catch (_) {}
  }
  return path.join(__dirname, 'soundfonts');
}

async function findDefaultSoundfont() {
  const candidates = [
    path.join(path.dirname(app.getPath('exe')), 'soundfonts', 'WinGroove.sf2'),
    path.join(process.resourcesPath, 'soundfonts', 'WinGroove.sf2'),
    path.join(__dirname, 'soundfonts', 'WinGroove.sf2'),
    path.join(__dirname, 'renderer', 'soundfonts', 'WinGroove.sf2'),
  ];
  for (const c of candidates) {
    try {
      const buf = await fs.readFile(c);
      if (buf && buf.length > 100) return new Uint8Array(buf);
    } catch (_) {}
  }
  return null;
}

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
      return await findDefaultSoundfont();
    });

    ipcMain.handle('wg:open-sf-folder', async () => {
      const dir = getSoundfontsDir();
      try {
        await fs.mkdir(dir, { recursive: true });
      } catch (_) {}
      return shell.openPath(dir);
    });

    ipcMain.handle('wg:open', async (_e, kind) => {
      const isSf = kind === 'sf2';
      const opts = {
        title: isSf ? 'Load SoundFont' : 'Open MIDI Files',
        properties: isSf ? ['openFile'] : ['openFile', 'multiSelections'],
        filters: [isSf ? SF_FILTER : MIDI_FILTER, { name: 'All Files', extensions: ['*'] }],
      };
      if (isSf) {
        opts.defaultPath = getSoundfontsDir();
      }
      const res = await dialog.showOpenDialog(win, opts);
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
