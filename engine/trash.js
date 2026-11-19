'use strict';

/**
 * Recover files that are still sitting in the OS trash / recycle bin.
 * These are fully intact — recovery is just a safe copy back out.
 */

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const os = require('os');

function trashLocations() {
  const home = os.homedir();
  if (process.platform === 'darwin') {
    return [path.join(home, '.Trash')];
  }
  if (process.platform === 'win32') {
    // Each drive has a hidden $Recycle.Bin. We surface the per-user folders.
    const roots = ['C:\\$Recycle.Bin'];
    return roots;
  }
  // Linux
  return [
    path.join(home, '.local', 'share', 'Trash', 'files'),
    path.join(home, '.Trash'),
  ];
}

function categorise(ext) {
  ext = ext.toLowerCase().replace('.', '');
  if (['jpg', 'jpeg', 'png', 'gif', 'heic', 'bmp', 'tiff', 'webp'].includes(ext)) return 'image';
  if (['mp4', 'mov', 'avi', 'mkv', 'm4v', 'wmv'].includes(ext)) return 'video';
  if (['mp3', 'wav', 'm4a', 'flac', 'aac'].includes(ext)) return 'audio';
  if (['pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'txt', 'rtf', 'pages'].includes(ext)) return 'document';
  if (['zip', 'rar', '7z', 'tar', 'gz'].includes(ext)) return 'archive';
  return 'other';
}

async function walk(dir, acc, depth = 0) {
  if (depth > 6) return;
  let entries;
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch (_) {
    return;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    try {
      if (e.isDirectory()) {
        await walk(full, acc, depth + 1);
      } else if (e.isFile()) {
        const st = await fsp.stat(full);
        const ext = path.extname(e.name);
        acc.push({
          id: `${st.ino}-${st.size}`,
          name: e.name,
          path: full,
          size: st.size,
          ext: ext.replace('.', '').toLowerCase(),
          kind: categorise(ext),
          deletedAt: st.mtime.toISOString(),
        });
      }
    } catch (_) {}
  }
}

async function listTrash() {
  const files = [];
  const roots = [];
  for (const loc of trashLocations()) {
    if (fs.existsSync(loc)) {
      roots.push(loc);
      await walk(loc, files);
    }
  }
  files.sort((a, b) => new Date(b.deletedAt) - new Date(a.deletedAt));
  return { roots, files, supported: roots.length > 0 };
}

async function restore(files, outputDir) {
  await fsp.mkdir(outputDir, { recursive: true });
  const results = [];
  for (const f of files) {
    const dest = path.join(outputDir, f.name);
    try {
      await fsp.copyFile(f.path, dest);
      results.push({ ...f, restoredTo: dest, ok: true });
    } catch (err) {
      results.push({ ...f, ok: false, error: String(err) });
    }
  }
  return results;
}

module.exports = { listTrash, restore, trashLocations };
