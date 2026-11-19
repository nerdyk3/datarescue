'use strict';

/**
 * Deep filesystem scan. Walks a mounted volume or folder, indexes every file,
 * and surfaces them by type and recency. Useful for recovering from a drive
 * that still mounts but whose files you can no longer find, or from the raw
 * mount of a card reader / external disk.
 */

const fsp = require('fs/promises');
const path = require('path');

const KIND_MAP = {
  image: ['jpg', 'jpeg', 'png', 'gif', 'heic', 'bmp', 'tiff', 'tif', 'webp', 'raw', 'cr2', 'nef', 'dng'],
  video: ['mp4', 'mov', 'avi', 'mkv', 'm4v', 'wmv', '3gp', 'flv'],
  audio: ['mp3', 'wav', 'm4a', 'flac', 'aac', 'ogg', 'wma'],
  document: ['pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'txt', 'rtf', 'pages', 'numbers', 'key', 'csv', 'md'],
  archive: ['zip', 'rar', '7z', 'tar', 'gz', 'bz2'],
  database: ['sqlite', 'db', 'sql'],
};

function kindOf(ext) {
  ext = ext.toLowerCase().replace('.', '');
  for (const [kind, list] of Object.entries(KIND_MAP)) {
    if (list.includes(ext)) return kind;
  }
  return 'other';
}

async function scanFolder(root, { onProgress, shouldStop, kinds = null, maxDepth = 12 } = {}) {
  const files = [];
  let seen = 0;

  async function walk(dir, depth) {
    if (depth > maxDepth) return;
    if (shouldStop && shouldStop()) return;
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch (_) {
      return;
    }
    for (const e of entries) {
      if (shouldStop && shouldStop()) return;
      if (e.name.startsWith('.') && e.isDirectory()) continue; // skip dot-dirs
      const full = path.join(dir, e.name);
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) {
        await walk(full, depth + 1);
      } else if (e.isFile()) {
        const ext = path.extname(e.name).replace('.', '').toLowerCase();
        const kind = kindOf(ext);
        if (kinds && kinds.length && !kinds.includes(kind)) continue;
        let st;
        try {
          st = await fsp.stat(full);
        } catch (_) {
          continue;
        }
        files.push({
          id: `${st.ino}-${st.size}`,
          name: e.name,
          path: full,
          size: st.size,
          ext,
          kind,
          modified: st.mtime.toISOString(),
        });
        seen++;
        if (onProgress && seen % 200 === 0) {
          onProgress({ phase: 'scan', count: seen, current: full });
        }
      }
    }
  }

  await walk(root, 0);
  files.sort((a, b) => new Date(b.modified) - new Date(a.modified));
  return { root, files, count: files.length };
}

async function copyOut(files, outputDir) {
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

module.exports = { scanFolder, copyOut, kindOf };
