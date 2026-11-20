'use strict';

/**
 * Deep filesystem scan. Walks a mounted volume or folder, indexes every file,
 * and surfaces them by type and recency. Useful for recovering from a drive
 * that still mounts but whose files you can no longer find, or from the raw
 * mount of a card reader / external disk.
 */

const fsp = require('fs/promises');
const path = require('path');
const { classify, typeFromExt, isTrash, isNoise } = require('./categorize');

// Kept for back-compat with any caller importing kindOf.
const kindOf = typeFromExt;

// Pseudo / volatile directories that are never user data and can loop or hang a
// walk. We deliberately do NOT skip dot-directories any more — hidden folders
// (.thumbnails, .Trash, app data, DCIM/.pending…) are exactly where "missing"
// files hide — only these true system mounts and build-noise dirs.
const SKIP_ABS = ['/proc', '/sys', '/dev'];
const SKIP_NAMES = new Set(['node_modules', '.git', '.svn', '.hg']);

async function scanFolder(root, { onProgress, shouldStop, kinds = null, maxDepth = 40 } = {}) {
  const files = [];
  let seen = 0;

  async function walk(dir, depth) {
    if (depth > maxDepth) return;
    if (shouldStop && shouldStop()) return;
    if (SKIP_ABS.some((p) => dir === p || dir.startsWith(p + path.sep))) return;
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch (_) {
      return;
    }
    for (const e of entries) {
      if (shouldStop && shouldStop()) return;
      const full = path.join(dir, e.name);
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) {
        if (SKIP_NAMES.has(e.name)) continue; // noise, not user data
        await walk(full, depth + 1);
      } else if (e.isFile()) {
        if (isNoise(e.name)) continue; // .DS_Store, Thumbs.db, .nomedia…
        const ext = path.extname(e.name).replace('.', '').toLowerCase();
        const deleted = isTrash(full, e.name);
        const kind = classify(full, ext, { trash: deleted });
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
          deleted: deleted || undefined,
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
