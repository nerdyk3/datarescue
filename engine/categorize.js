'use strict';

/**
 * Shared file categorization for every recovery source.
 *
 * The goal is that a screenshot, a camera shot, a voice note, a chat-app backup,
 * or a file sitting in a recycle bin lands in the SAME category whether it was
 * carved off a disk image, walked in a folder, pulled from an Android phone, or
 * read from an iOS backup. Keeping this in one place is what gives the UI a
 * consistent set of filter chips across all tabs.
 *
 * `kind` is the user-facing category (the filter chip). `deleted` (tracked by the
 * callers) is orthogonal — a file can be a "screenshot" that also happens to be
 * deleted. In mixed scans (disk/folder/phone) a file found *inside* a recycle bin
 * is given kind 'trash' so the recoverable-deleted items group together; the
 * dedicated Trash tab instead keeps the type category since everything there is
 * already deleted.
 */

const path = require('path');

const EXT = {
  image: ['jpg', 'jpeg', 'png', 'gif', 'heic', 'heif', 'avif', 'bmp', 'tiff', 'tif',
          'webp', 'psd', 'svg', 'ico', 'raw', 'cr2', 'cr3', 'nef', 'dng', 'arw',
          'orf', 'rw2', 'raf', 'srw', 'pef'],
  video: ['mp4', 'mov', 'avi', 'mkv', 'webm', 'm4v', 'wmv', '3gp', '3g2', 'flv', 'mpg', 'mpeg', 'ts'],
  audio: ['mp3', 'wav', 'm4a', 'm4b', 'flac', 'aac', 'ogg', 'oga', 'opus', 'wma', 'aiff', 'aif', 'amr'],
  document: ['pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'txt', 'rtf', 'odt',
             'ods', 'odp', 'pages', 'numbers', 'key', 'csv', 'tsv', 'md', 'epub', 'mobi'],
  archive: ['zip', 'rar', '7z', 'tar', 'gz', 'tgz', 'bz2', 'xz', 'zst', 'jar', 'apk'],
  database: ['sqlite', 'sqlitedb', 'db', 'sql', 'mdb', 'accdb', 'realm'],
};

function normExt(ext) {
  return String(ext || '').toLowerCase().replace(/^\./, '');
}

/** Base category from the extension alone (no path heuristics). */
function typeFromExt(ext) {
  const e = normExt(ext);
  for (const kind of Object.keys(EXT)) {
    if (EXT[kind].includes(e)) return kind;
  }
  return 'other';
}

// Recycle-bin / trash locations across operating systems and apps:
//  - macOS ~/.Trash, per-volume /.Trashes
//  - Windows $Recycle.Bin / $Recycler
//  - Linux ~/.local/share/Trash
//  - Android stock file managers / gallery recycle bins, and the Android 11+
//    MediaStore ".trashed-<ts>-<name>" convention.
const TRASH_RE = /(^|[\/\\])(\.?trash(es)?|\$recycle\.bin|\$recycler|recycle(bin)?|retrash)([\/\\]|$)/i;

/** Is this path inside a recycle bin / trash can? */
function isTrash(p, base) {
  const b = base != null ? base : path.basename(String(p || ''));
  if (/^\.trashed-/i.test(b)) return true;        // Android 11+ MediaStore trash
  return TRASH_RE.test(String(p || ''));
}

// Empty marker / OS-junk files that are never recoverable content.
const NOISE = new Set(['.nomedia', '.ds_store', 'thumbs.db', 'desktop.ini', '.localized']);
function isNoise(base) {
  return NOISE.has(String(base || '').toLowerCase());
}

/**
 * Rich category from the full path + extension.
 *   classify('/sdcard/DCIM/Screenshots/Screenshot_1.jpg', 'jpg') -> 'screenshot'
 *   classify('/x/WhatsApp Voice Notes/PTT-1.opus', 'opus')       -> 'voice'
 *   classify('/x/Databases/msgstore.db.crypt14', 'crypt14')      -> 'backup'
 *   classify(anyPathInRecycleBin, ext, { trash: true })          -> 'trash'
 */
function classify(p, ext, { trash = false } = {}) {
  if (trash) return 'trash';
  const e = normExt(ext);
  if (/^crypt\d+$/.test(e) || e === 'bak' || e === 'backup') return 'backup';

  const lp = String(p || '').toLowerCase().replace(/\\/g, '/');
  const base = lp.split('/').pop() || '';

  if (/voice ?notes?|[\/]ptt[\/]|[\/]ptt-|call recordings?|voice recorder|voice memos?/.test(lp)) return 'voice';
  if (/screenshots?/.test(lp) || /^screenshot[_\- ]/.test(base)) return 'screenshot';

  const t = typeFromExt(e);
  if (t === 'image' && /[\/]dcim[\/]camera[\/]/.test(lp)) return 'camera';
  return t;
}

module.exports = { typeFromExt, classify, isTrash, isNoise };
