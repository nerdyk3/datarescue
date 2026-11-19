'use strict';

const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const os = require('os');

const carver = require('./engine/carver');
const trash = require('./engine/trash');
const scanner = require('./engine/scanner');
const android = require('./engine/android');
const ios = require('./engine/ios');

let win;
let stopFlag = false;
const shouldStop = () => stopFlag;

function createWindow() {
  win = new BrowserWindow({
    width: 1240,
    height: 820,
    minWidth: 960,
    minHeight: 640,
    backgroundColor: '#0b0e14',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.loadFile(path.join(__dirname, 'src', 'index.html'));
}

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

function defaultOutput(subdir) {
  return path.join(os.homedir(), 'DataRescue_Recovered', subdir, new Date().toISOString().replace(/[:.]/g, '-'));
}

/* ----------------------------- generic dialogs ---------------------------- */

ipcMain.handle('pick-source', async () => {
  const res = await dialog.showOpenDialog(win, {
    title: 'Select a disk image, device, or folder to scan',
    properties: ['openFile', 'openDirectory', 'showHiddenFiles', 'treatPackageAsDirectory'],
    message: 'Choose a .dd / .img disk image, a mounted volume, or a folder.',
  });
  return res.canceled ? null : res.filePaths[0];
});

ipcMain.handle('pick-folder', async () => {
  const res = await dialog.showOpenDialog(win, {
    properties: ['openDirectory', 'createDirectory'],
    title: 'Select a folder',
  });
  return res.canceled ? null : res.filePaths[0];
});

ipcMain.handle('open-path', async (_e, p) => {
  shell.showItemInFolder(p);
});

ipcMain.handle('stop', async () => {
  stopFlag = true;
  return true;
});

/* -------------------------------- carving --------------------------------- */

ipcMain.handle('carve-scan', async (_e, source) => {
  stopFlag = false;
  try {
    const { candidates, size } = await carver.scanHeaders(source, {
      shouldStop,
      onProgress: (p) => send('progress', { task: 'carve', ...p }),
    });
    send('progress', { task: 'carve', phase: 'describe', index: 0, total: candidates.length });
    const files = await carver.describe(source, candidates, size, {
      shouldStop,
      onProgress: (p) => send('progress', { task: 'carve', ...p }),
    });
    return { ok: true, files, size };
  } catch (err) {
    return { ok: false, error: String(err.message || err) };
  }
});

ipcMain.handle('carve-recover', async (_e, { source, files, outputDir }) => {
  stopFlag = false;
  const out = outputDir || defaultOutput('carved');
  try {
    const results = await carver.recover(source, files, out, {
      shouldStop,
      onProgress: (p) => send('progress', { task: 'carve', ...p }),
    });
    return { ok: true, results, outputDir: out };
  } catch (err) {
    return { ok: false, error: String(err.message || err) };
  }
});

/* --------------------------------- trash ---------------------------------- */

ipcMain.handle('trash-list', async () => {
  try {
    return { ok: true, ...(await trash.listTrash()) };
  } catch (err) {
    return { ok: false, error: String(err.message || err) };
  }
});

ipcMain.handle('trash-restore', async (_e, { files, outputDir }) => {
  const out = outputDir || defaultOutput('trash');
  try {
    const results = await trash.restore(files, out);
    return { ok: true, results, outputDir: out };
  } catch (err) {
    return { ok: false, error: String(err.message || err) };
  }
});

/* --------------------------------- folder --------------------------------- */

ipcMain.handle('folder-scan', async (_e, { root, kinds }) => {
  stopFlag = false;
  try {
    const res = await scanner.scanFolder(root, {
      kinds,
      shouldStop,
      onProgress: (p) => send('progress', { task: 'folder', ...p }),
    });
    return { ok: true, ...res };
  } catch (err) {
    return { ok: false, error: String(err.message || err) };
  }
});

ipcMain.handle('folder-copy', async (_e, { files, outputDir }) => {
  const out = outputDir || defaultOutput('folder');
  try {
    const results = await scanner.copyOut(files, out);
    return { ok: true, results, outputDir: out };
  } catch (err) {
    return { ok: false, error: String(err.message || err) };
  }
});

/* -------------------------------- android --------------------------------- */

ipcMain.handle('android-status', async () => {
  try {
    return { ok: true, ...(await android.status()) };
  } catch (err) {
    return { ok: false, error: String(err.message || err) };
  }
});

ipcMain.handle('android-scan', async (_e, { serial }) => {
  try {
    const res = await android.scan(serial, {
      onProgress: (p) => send('progress', { task: 'android', ...p }),
    });
    return { ok: true, ...res };
  } catch (err) {
    return { ok: false, error: String(err.message || err) };
  }
});

ipcMain.handle('android-pull', async (_e, { serial, files, outputDir }) => {
  const out = outputDir || defaultOutput('android');
  try {
    const results = await android.pull(serial, files, out, {
      onProgress: (p) => send('progress', { task: 'android', ...p }),
    });
    return { ok: true, results, outputDir: out };
  } catch (err) {
    return { ok: false, error: String(err.message || err) };
  }
});

/* ---------------------------------- ios ----------------------------------- */

ipcMain.handle('ios-backups', async () => {
  try {
    return { ok: true, ...(await ios.listBackups()) };
  } catch (err) {
    return { ok: false, error: String(err.message || err) };
  }
});

ipcMain.handle('ios-scan', async (_e, { udid, kinds }) => {
  try {
    const res = await ios.scanBackup(udid, { kinds });
    return { ok: true, ...res };
  } catch (err) {
    return { ok: false, error: String(err.message || err) };
  }
});

ipcMain.handle('ios-extract', async (_e, { udid, files, outputDir }) => {
  const out = outputDir || defaultOutput('ios');
  try {
    const results = await ios.extract(udid, files, out);
    return { ok: true, results, outputDir: out };
  } catch (err) {
    return { ok: false, error: String(err.message || err) };
  }
});
