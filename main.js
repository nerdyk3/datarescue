'use strict';

const { app, BrowserWindow, ipcMain, dialog, shell, nativeImage } = require('electron');
const path = require('path');
const os = require('os');
const fsp = require('fs/promises');
const crypto = require('crypto');
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

/* ------------------------------- preview ----------------------------------
 * Resolve a file to a real on-disk path the renderer can load in <img>/<video>.
 *   { path }                    -> already a file (folder/trash/iOS): use as-is.
 *   { source, offset, length }  -> a carved byte range: extract it to a temp file
 *                                  so the <video> element can stream & seek it.
 * Full-size images and playable video both work; large videos never go through
 * IPC as bytes — only the small temp path does.
 */
const previewTemps = new Set();
ipcMain.handle('preview-file', async (_e, req) => {
  try {
    if (req && req.path) return { ok: true, path: req.path, temp: false };
    if (req && req.source && req.length > 0) {
      const dir = path.join(os.tmpdir(), 'datarescue-preview');
      await fsp.mkdir(dir, { recursive: true });
      const ext = String(req.ext || 'bin').replace(/[^\w]/g, '') || 'bin';
      const dest = path.join(dir, `${crypto.randomUUID()}.${ext}`);
      const srcFd = await fsp.open(req.source, 'r');
      const dstFd = await fsp.open(dest, 'w');
      try {
        let remaining = req.length;
        let pos = req.offset;
        const buf = Buffer.alloc(Math.min(4 * 1024 * 1024, remaining));
        while (remaining > 0) {
          const want = Math.min(buf.length, remaining);
          const { bytesRead } = await srcFd.read(buf, 0, want, pos);
          if (!bytesRead) break;
          await dstFd.write(buf, 0, bytesRead);
          pos += bytesRead;
          remaining -= bytesRead;
        }
      } finally {
        await srcFd.close();
        await dstFd.close();
      }
      previewTemps.add(dest);
      return { ok: true, path: dest, temp: true };
    }
    return { ok: false, error: 'Nothing to preview.' };
  } catch (err) {
    return { ok: false, error: String(err.message || err) };
  }
});

ipcMain.handle('preview-cleanup', async (_e, p) => {
  if (p && previewTemps.has(p)) {
    await fsp.rm(p, { force: true }).catch(() => {});
    previewTemps.delete(p);
  }
  return { ok: true };
});

app.on('before-quit', async () => {
  for (const p of previewTemps) { try { await fsp.rm(p, { force: true }); } catch (_) {} }
  previewTemps.clear();
  try { await fsp.rm(path.join(os.tmpdir(), 'datarescue-android'), { recursive: true, force: true }); } catch (_) {}
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

const gb = (n) => (n / 1e9).toFixed(2) + ' GB';

/** Total byte size of a device node (the slice we're imaging), or 0 if unknown. */
async function deviceSizeBytes(devNode) {
  try {
    if (process.platform === 'darwin') {
      const { out } = await execP('diskutil', ['info', devNode]);
      const m = out.match(/(?:Disk Size|Total Size|Volume Total Space):[^(]*\((\d+) Bytes\)/);
      return m ? parseInt(m[1], 10) : 0;
    }
    if (process.platform === 'linux') {
      const { out } = await execP('blockdev', ['--getsize64', devNode]);
      const n = parseInt(out.trim(), 10);
      return Number.isFinite(n) ? n : 0;
    }
  } catch (_) {}
  return 0;
}

/** Free bytes available on the filesystem that holds `dir`, or 0 if unknown. */
async function freeBytes(dir) {
  try {
    const { out } = await execP('df', ['-k', dir]);
    const lines = out.trim().split('\n');
    if (lines.length < 2) return 0;
    const cols = lines[lines.length - 1].trim().split(/\s+/);
    const availKb = parseInt(cols[3], 10); // df -k: Filesystem 1k-blocks Used Avail ...
    return Number.isFinite(availKb) ? availKb * 1024 : 0;
  } catch (_) { return 0; }
}

/** Is `name` an executable on PATH? */
async function hasCmd(name) {
  const { err } = await execP(process.platform === 'win32' ? 'where' : 'which', [name]);
  return !err;
}

/** Can we image a backing device in-app on this platform? (needs an elevation UI) */
async function canElevate() {
  if (process.platform === 'darwin') return true;          // osascript admin prompt
  if (process.platform === 'linux') return hasCmd('pkexec'); // polkit prompt
  return false;
}

/** Marks a rejection as a user-cancelled elevation prompt, so callers can message it. */
function cancelledError(e) {
  const m = String((e && e.message) || e);
  const code = e && e.code;
  return /User canceled|-128|cancell?ed|dismiss|not authoriz/i.test(m) || code === 126 || code === 127;
}

/**
 * Image a raw device to `img` using a one-time elevation prompt, then hand the
 * file back to the current user. Raw device reads need root, which a normal-user
 * GUI app doesn't have — so we elevate just this `dd`, not the whole app.
 * Progress is derived by polling the growing output file against the known
 * device size. macOS uses osascript; Linux uses pkexec.
 *
 * `node` is the buffered device (/dev/disk6s1) used for unmount/remount on macOS:
 * a *mounted* volume's raw slice is "Operation not permitted" even to root, so we
 * unmount it, image it, then remount so the card reappears for the user. Linux
 * lets root read a mounted block device directly, so it just dd's.
 */
function imageDevice({ raw, node, img, total, onProgress }) {
  const user = os.userInfo().username;
  // Single-quote every path for the shell; chown only runs if dd succeeds, so a
  // read error surfaces as a non-zero exit (with stderr in the rejection).
  let cmd, args;
  if (process.platform === 'darwin') {
    // Unmount (force if needed) → image → always remount → chown on success.
    const sh =
      `(diskutil unmount '${node}' || diskutil unmount force '${node}') && ` +
      `dd if='${raw}' of='${img}' bs=4m; rc=$?; ` +
      `diskutil mount '${node}' >/dev/null 2>&1; ` +
      `if [ $rc -eq 0 ]; then chown '${user}' '${img}'; fi; exit $rc`;
    const script =
      `do shell script "${sh.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}" ` +
      `with prompt "DataRescue needs administrator access to read this SD card / device." ` +
      `with administrator privileges`;
    cmd = 'osascript'; args = ['-e', script];
  } else {
    // Linux: root can read the mounted block device directly via a polkit prompt.
    const sh = `dd if='${raw}' of='${img}' bs=4M && chown '${user}' '${img}'`;
    cmd = 'pkexec'; args = ['sh', '-c', sh];
  }

  return new Promise((resolve, reject) => {
    let done = false;
    const timer = setInterval(async () => {
      if (done) return;
      try {
        const s = await fsp.stat(img);
        onProgress && onProgress({ phase: 'image', bytes: s.size, total: total || 0 });
      } catch (_) {}
    }, 500);

    execFile(cmd, args, { timeout: 0, maxBuffer: 1 << 20 }, (err) => {
      done = true;
      clearInterval(timer);
      if (err) return reject(err);
      resolve();
    });
  });
}

ipcMain.handle('carve-scan', async (_e, source) => {
  stopFlag = false;
  let scanSource = source; // what we actually carve (may become an image path)
  let imagedFrom = null;   // the volume we imaged, if any
  try {
    // A mounted volume (e.g. /Volumes/NO NAME) is a directory — you can't read
    // it as raw bytes, and the backing device needs admin. Image it to a file
    // first (one admin prompt), then carve the image.
    let st = null;
    try { st = await fsp.stat(source); } catch (_) {}
    if (st && st.isDirectory()) {
      const dev = await backingDevice(source);

      // Platforms / setups without an in-app elevation path: keep manual guidance.
      if (!dev || !(await canElevate())) {
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

      // Enough room for the image? The slice size is our best estimate.
      const total = await deviceSizeBytes(dev.dev);
      const imgDir = path.join(os.homedir(), 'DataRescue_Recovered', 'images');
      const free = await freeBytes(imgDir.replace(/\/images$/, '')) || await freeBytes(os.homedir());
      if (total && free && free < total + 64 * 1024 * 1024) {
        return {
          ok: false,
          kind: 'no-space',
          error:
            `Not enough free space to image this card. It is about ${gb(total)}, but only ` +
            `${gb(free)} is free on your home disk. Free up space, then try the deep scan again.`,
        };
      }

      // Image the backing device to a file we own, then carve that file.
      await fsp.mkdir(imgDir, { recursive: true });
      const base = (path.basename(source) || 'card').replace(/[^\w.-]+/g, '_');
      const img = path.join(imgDir, `${base}-${new Date().toISOString().replace(/[:.]/g, '-')}.img`);

      send('progress', { task: 'carve', phase: 'image', bytes: 0, total: total || 0 });
      try {
        await imageDevice({
          raw: dev.raw,
          node: dev.dev,
          img,
          total,
          onProgress: (p) => send('progress', { task: 'carve', ...p }),
        });
      } catch (e) {
        // Clean up a partial image so a cancel doesn't leave a huge stub behind.
        await fsp.rm(img, { force: true }).catch(() => {});
        if (cancelledError(e)) {
          return { ok: false, kind: 'cancelled', error: 'Imaging was cancelled. Deep scanning a card needs one-time administrator access to read it.' };
        }
        return { ok: false, error: `Couldn’t image “${source}”: ${String((e && e.message) || e)}` };
      }

      scanSource = img;
      imagedFrom = source;
    }

    const { candidates, size } = await carver.scanHeaders(scanSource, {
      shouldStop,
      onProgress: (p) => send('progress', { task: 'carve', ...p }),
    });
    send('progress', { task: 'carve', phase: 'describe', index: 0, total: candidates.length });
    const files = await carver.describe(scanSource, candidates, size, {
      shouldStop,
      onProgress: (p) => send('progress', { task: 'carve', ...p }),
    });
    // When we imaged first, tell the renderer to use the image for recover/thumbs.
    return { ok: true, files, size, source: scanSource, imagedFrom };
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

/**
 * Delete a disk image DataRescue created while deep-scanning a mounted card, to
 * reclaim space once recovery is done. Guarded to our own images folder so a bad
 * path can never remove anything else.
 */
ipcMain.handle('carve-cleanup', async (_e, imgPath) => {
  try {
    const imagesDir = path.join(os.homedir(), 'DataRescue_Recovered', 'images');
    const resolved = path.resolve(String(imgPath || ''));
    if (resolved !== imagesDir && !resolved.startsWith(imagesDir + path.sep)) {
      return { ok: false, error: 'Refusing to delete a file outside the DataRescue images folder.' };
    }
    let freed = 0;
    try { freed = (await fsp.stat(resolved)).size; } catch (_) {}
    await fsp.rm(resolved, { force: true });
    return { ok: true, freed };
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

/**
 * Pull one device file to a temp path (cached) so the UI can thumbnail/preview
 * Android media. The bytes aren't locally readable otherwise.
 */
const androidTempByPath = new Map(); // device path -> local temp path
ipcMain.handle('android-fetch', async (_e, { serial, path: devPath }) => {
  try {
    const cached = androidTempByPath.get(devPath);
    if (cached) {
      try { await fsp.access(cached); return { ok: true, path: cached }; }
      catch (_) { androidTempByPath.delete(devPath); }
    }
    const local = await android.fetchOne(serial, devPath);
    androidTempByPath.set(devPath, local);
    return { ok: true, path: local };
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
