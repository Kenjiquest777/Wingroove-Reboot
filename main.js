'use strict';
/* WinGroove Reboot - Electron main process
 * Orchestrates classic Player window and standalone attached Instruments window
 * with magnetic docking, synchronization, and IPC message routing.
 */
const { app, BrowserWindow, ipcMain, dialog, Menu, shell } = require('electron');
const path = require('path');
const fs = require('fs/promises');
const fsSync = require('fs');

const OPENABLE = /\.(midi?|rmi|kar|sf2)$/i;
const MIDI_FILTER = { name: 'MIDI Files', extensions: ['mid', 'midi', 'rmi', 'kar'] };
const SF_FILTER = { name: 'SoundFont 2', extensions: ['sf2'] };

let win = null;
let instWin = null;
let rendererReady = false;
let isAttached = true;
let dockSide = 'bottom';
let lastPlayerBounds = null;
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

function updateAttachedPosition() {
  if (!win || !instWin || !isAttached || instWin.isDestroyed() || win.isDestroyed()) return;
  const pb = win.getBounds();
  const ib = instWin.getBounds();
  const targetX = pb.x;
  const targetY = dockSide === 'bottom' ? (pb.y + pb.height) : (pb.y - ib.height);
  if (ib.x !== targetX || ib.y !== targetY) {
    instWin.setPosition(targetX, targetY);
  }
}

function createInstrumentsWindow() {
  if (instWin && !instWin.isDestroyed()) {
    instWin.show();
    instWin.focus();
    return;
  }

  const pb = win ? win.getBounds() : { x: 100, y: 100, width: 768, height: 400 };
  const targetX = pb.x;
  const targetY = pb.y + pb.height;

  instWin = new BrowserWindow({
    width: pb.width || 768,
    height: 380,
    x: targetX,
    y: targetY,
    minWidth: 700,
    minHeight: 280,
    frame: false,
    resizable: true,
    show: false,
    backgroundColor: '#c0c0c0',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  instWin.loadFile(path.join(__dirname, 'renderer', 'instruments.html'));

  instWin.once('ready-to-show', () => {
    instWin.show();
    instWin.webContents.send('instruments-win-status', { attached: isAttached });
    updateAttachedPosition();
  });

  instWin.on('move', () => {
    if (!win || win.isDestroyed()) return;
    const pb = win.getBounds();
    const ib = instWin.getBounds();
    const snapThreshold = 30;

    // Check bottom snap
    const bottomDist = Math.abs(ib.y - (pb.y + pb.height));
    const topDist = Math.abs((ib.y + ib.height) - pb.y);
    const xDist = Math.abs(ib.x - pb.x);

    if (xDist < snapThreshold && bottomDist < snapThreshold) {
      isAttached = true;
      dockSide = 'bottom';
      instWin.setPosition(pb.x, pb.y + pb.height);
      instWin.webContents.send('instruments-win-status', { attached: true });
    } else if (xDist < snapThreshold && topDist < snapThreshold) {
      isAttached = true;
      dockSide = 'top';
      instWin.setPosition(pb.x, pb.y - ib.height);
      instWin.webContents.send('instruments-win-status', { attached: true });
    } else {
      if (isAttached) {
        isAttached = false;
        instWin.webContents.send('instruments-win-status', { attached: false });
      }
    }
  });

  instWin.on('close', (e) => {
    // Hide instead of destroy so state remains intact
    if (win && !win.isDestroyed() && !app.isQuitting) {
      e.preventDefault();
      instWin.hide();
    }
  });
}

function createWindow() {
  win = new BrowserWindow({
    width: 772,
    height: 420,
    minWidth: 760,
    minHeight: 380,
    resizable: true,
    useContentSize: true,
    backgroundColor: '#008080',
    title: 'WinGroove Reboot',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  win.on('move', () => {
    updateAttachedPosition();
  });

  win.on('resize', () => {
    if (instWin && !instWin.isDestroyed() && isAttached) {
      const pb = win.getBounds();
      instWin.setSize(pb.width, instWin.getBounds().height);
      updateAttachedPosition();
    }
  });

  win.on('minimize', () => {
    if (instWin && !instWin.isDestroyed() && instWin.isVisible()) {
      instWin.minimize();
    }
  });

  win.on('restore', () => {
    if (instWin && !instWin.isDestroyed()) {
      instWin.restore();
      updateAttachedPosition();
    }
  });

  win.on('closed', () => {
    win = null;
    if (instWin && !instWin.isDestroyed()) {
      instWin.destroy();
      instWin = null;
    }
  });

  win.webContents.on('did-finish-load', async () => {
    rendererReady = true;
    while (pending.length) {
      const items = pending.shift();
      win.webContents.send('open-files', items);
    }
  });
}

// IPC Handlers
ipcMain.handle('load-default-soundfont', async () => {
  return await findDefaultSoundfont();
});

ipcMain.handle('open-file-dialog', async () => {
  const res = await dialog.showOpenDialog(win, {
    title: 'Open MIDI or SoundFont File',
    filters: [MIDI_FILTER, SF_FILTER, { name: 'All Files', extensions: ['*'] }],
    properties: ['openFile', 'multiSelections'],
  });
  if (res.canceled || !res.filePaths.length) return [];
  return await readItems(res.filePaths);
});

ipcMain.handle('open-soundfont-dialog', async () => {
  const res = await dialog.showOpenDialog(win, {
    title: 'Select SoundFont 2.0 (.sf2)',
    filters: [SF_FILTER],
    properties: ['openFile'],
  });
  if (res.canceled || !res.filePaths.length) return null;
  const items = await readItems([res.filePaths[0]]);
  return items[0] || null;
});

ipcMain.handle('open-soundfonts-folder', async () => {
  const dir = getSoundfontsDir();
  try {
    await fs.mkdir(dir, { recursive: true });
    await shell.openPath(dir);
    return true;
  } catch (err) {
    console.error('Could not open soundfonts folder', err);
    return false;
  }
});

ipcMain.handle('save-wav-dialog', async (_e, suggestedName) => {
  const res = await dialog.showSaveDialog(win, {
    title: 'Save Rendered WAV File',
    defaultPath: suggestedName || 'wingroove-output.wav',
    filters: [{ name: 'WAV Audio', extensions: ['wav'] }],
  });
  if (res.canceled) return null;
  return res.filePath;
});

ipcMain.handle('save-wav-file', async (_e, filePath, data) => {
  try {
    await fs.writeFile(filePath, Buffer.from(data));
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.on('toggle-instruments-window', (_e, show) => {
  if (!instWin || instWin.isDestroyed()) {
    if (show !== false) createInstrumentsWindow();
  } else {
    if (show === false || instWin.isVisible()) {
      instWin.hide();
    } else {
      instWin.show();
      instWin.focus();
      updateAttachedPosition();
    }
  }
});

ipcMain.on('set-instruments-attached', (_e, attached, dockPos) => {
  isAttached = !!attached;
  if (dockPos) dockSide = dockPos;
  if (instWin && !instWin.isDestroyed()) {
    instWin.webContents.send('instruments-win-status', { attached: isAttached });
    if (isAttached) updateAttachedPosition();
  }
});

ipcMain.on('set-instruments-height', (_e, h) => {
  if (instWin && !instWin.isDestroyed()) {
    const b = instWin.getBounds();
    instWin.setSize(b.width, h);
    updateAttachedPosition();
  }
});

ipcMain.on('instruments-cmd', (_e, cmd) => {
  if (win && !win.isDestroyed()) {
    win.webContents.send('instruments-cmd', cmd);
  }
});

ipcMain.on('relay-instruments-state', (_e, state) => {
  if (instWin && !instWin.isDestroyed()) {
    instWin.webContents.send('instruments-state', state);
  }
});

app.whenReady().then(async () => {
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('before-quit', () => {
  app.isQuitting = true;
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
