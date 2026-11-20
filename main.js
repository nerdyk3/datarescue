'use strict';

const { app, BrowserWindow, ipcMain, dialog, shell, nativeImage } = require('electron');
const path = require('path');
const os = require('os');
const fsp = require('fs/promises');
const { execFile } = require('child_process');

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

/* --------------------------- image thumbnails ----------------------------
 * Returns a small data-URL thumbnail for an image, or null if it can't be
 * decoded. Two modes:
 *   { path }                     -> read an on-disk file (folder/trash/iOS)
 *   { source, offset, length }   -> read a carved byte range from a device/image
 * nativeImage decodes PNG/JPEG/GIF/BMP; anything else (HEIC, RAW…) returns null
 * and the UI keeps its type icon.
 */
const MAX_THUMB_BYTES = 48 * 1024 * 1024; // don't decode absurdly large blobs
ipcMain.handle('thumb', async (_e, req) => {
  try {
    let img;
    if (req && req.path) {
      img = nativeImage.createFromPath(req.path);
    } else if (req && req.source && req.length && req.length <= MAX_THUMB_BYTES) {
      const fd = await fsp.open(req.source, 'r');
      try {
        const buf = Buffer.alloc(req.length);
        await fd.read(buf, 0, req.length, req.offset);
        img = nativeImage.createFromBuffer(buf);
      } finally {
        await fd.close();
      }
    }
    if (!img || img.isEmpty()) return null;
    const { width } = img.getSize();
    const thumb = width > 320 ? img.resize({ width: 320, quality: 'good' }) : img;
    return thumb.toDataURL();
  } catch (_) {
    return null;
  }
});

/* -------------------------------- carving --------------------------------- */

/**
 * Resolve a mounted volume path to its backing block device, so we can tell the
 * user the exact device to image/carve. macOS: `diskutil info`; Linux: `findmnt`.
 */
function execP(cmd, args, timeout = 8000) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout }, (err, stdout) => resolve({ err, out: String(stdout || '') }));
  });
}
async function backingDevice(mountPath) {
  try {
    if (process.platform === 'darwin') {
      const { out } = await execP('diskutil', ['info', mountPath]);
      const m = out.match(/Device Node:\s*(\/dev\/\S+)/);
      if (m) {
        const dev = m[1];
        // The raw device (/dev/rdiskN) carves much faster than the buffered one.
        const raw = dev.replace(/^\/dev\/disk/, '/dev/rdisk');
        return { dev, raw };
      }
    } else if (process.platform === 'linux') {
      const { out } = await execP('findmnt', ['-no', 'SOURCE', mountPath]);
      const dev = out.trim();
      if (dev) return { dev, raw: dev };
    }
  } catch (_) {}
  return null;
}

ipcMain.handle('carve-scan', async (_e, source) => {
  stopFlag = false;
  try {
    // A mounted volume (e.g. /Volumes/NO NAME) is a directory — you can't read
    // it as raw bytes. Detect that and guide the user instead of failing with a
    // cryptic EISDIR.
    let st = null;
    try { st = await fsp.stat(source); } catch (_) {}
    if (st && st.isDirectory()) {
      const dev = await backingDevice(source);
      const imgCmd = dev
        ? `sudo dd if=${dev.raw} of=~/card.img bs=4m`
        : 'sudo dd if=/dev/rdiskN of=~/card.img bs=4m';
      const error = [
        `“${source}” is a mounted volume (a folder), not a raw device or disk image.`,
        dev ? `Its underlying device is ${dev.dev}.` : '',
        '',
        '• Files still on it (including items in its trash) — use the “Folder / Volume” tab on this same path.',
        '• Deleted or formatted data — raw carving needs the device, which requires admin. Image it first:',
        `    ${imgCmd}`,
        '  then run a deep scan on card.img.',
      ].filter(Boolean).join('\n');
      return { ok: false, error, kind: 'not-carvable', suggestFolder: true, device: dev && dev.dev };
    }

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
    let msg = String(err.message || err);
    if (/EISDIR/.test(msg)) {
      msg = `“${source}” is a folder. Use the “Folder / Volume” tab to scan a mounted drive, or pick a .dd/.img image or disk device to carve.`;
    } else if (/EACCES|EPERM|operation not permitted/i.test(msg)) {
      msg = `Permission denied reading “${source}”. Raw device access needs admin rights — image it first with sudo dd, or launch the app elevated.`;
    }
    return { ok: false, error: msg };
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

ipcMain.handle('android-connect', async (_e, { hostPort }) => {
  try {
    return { ok: true, ...(await android.connect(hostPort)) };
  } catch (err) {
    return { ok: false, error: String(err.message || err) };
  }
});

ipcMain.handle('android-pair', async (_e, { hostPort, code }) => {
  try {
    return { ok: true, ...(await android.pair(hostPort, code)) };
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
