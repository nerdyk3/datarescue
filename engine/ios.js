'use strict';

/**
 * iOS recovery from local (iTunes / Finder) backups.
 *
 * When you back up an iPhone/iPad to this computer, iOS writes a full copy of
 * app data, photos, messages and contacts into:
 *   macOS : ~/Library/Application Support/MobileSync/Backup/<UDID>
 *   win   : %APPDATA%/Apple Computer/MobileSync/Backup/<UDID>
 *
 * Each backup has a Manifest.db (SQLite) that maps logical paths to the hashed
 * files on disk. We read that index and extract the real files back out with
 * their original names. Encrypted backups keep Manifest.db encrypted too — we
 * detect that and report it rather than failing silently.
 */

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { classify } = require('./categorize');

function backupRoot() {
  const home = os.homedir();
  if (process.platform === 'darwin') {
    return path.join(home, 'Library', 'Application Support', 'MobileSync', 'Backup');
  }
  if (process.platform === 'win32') {
    const appdata = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
    return path.join(appdata, 'Apple Computer', 'MobileSync', 'Backup');
  }
  return path.join(home, '.mobilesync', 'Backup'); // unlikely on Linux
}

function readPlistField(xml, key) {
  // Tiny, tolerant plist reader for the few Info.plist fields we show.
  const re = new RegExp(`<key>${key}</key>\\s*<(string|date|integer)>([^<]*)</`, 'i');
  const m = xml.match(re);
  return m ? m[2] : null;
}

async function listBackups() {
  const root = backupRoot();
  if (!fs.existsSync(root)) {
    return { root, supported: false, backups: [], reason: 'No local iOS backups found on this computer.' };
  }
  const udids = (await fsp.readdir(root, { withFileTypes: true }))
    .filter((e) => e.isDirectory())
    .map((e) => e.name);

  const backups = [];
  for (const udid of udids) {
    const dir = path.join(root, udid);
    const manifestDb = path.join(dir, 'Manifest.db');
    let info = {};
    try {
      const infoPath = path.join(dir, 'Info.plist');
      if (fs.existsSync(infoPath)) {
        const xml = await fsp.readFile(infoPath, 'utf8');
        info = {
          deviceName: readPlistField(xml, 'Device Name'),
          product: readPlistField(xml, 'Product Name') || readPlistField(xml, 'Product Type'),
          lastBackup: readPlistField(xml, 'Last Backup Date'),
          iosVersion: readPlistField(xml, 'Product Version'),
        };
      }
    } catch (_) {}

    let encrypted = false;
    try {
      const statusPath = path.join(dir, 'Status.plist');
      if (fs.existsSync(statusPath)) {
        const sx = await fsp.readFile(statusPath, 'utf8');
        encrypted = /IsEncrypted<\/key>\s*<true/.test(sx);
      }
    } catch (_) {}

    const manifestMbdb = path.join(dir, 'Manifest.mbdb');
    const hasMbdb = fs.existsSync(manifestMbdb);

    backups.push({
      udid,
      dir,
      hasManifest: fs.existsSync(manifestDb) || hasMbdb,
      legacy: !fs.existsSync(manifestDb) && hasMbdb,
      encrypted,
      deviceName: info.deviceName || 'iPhone / iPad',
      product: info.product || '',
      iosVersion: info.iosVersion || '',
      lastBackup: info.lastBackup || null,
    });
  }
  backups.sort((a, b) => new Date(b.lastBackup || 0) - new Date(a.lastBackup || 0));
  return { root, supported: true, backups };
}

function loadSqlite() {
  try {
    return require('better-sqlite3');
  } catch (e) {
    return null;
  }
}

const DOMAIN_KIND = (domain, rel) => {
  const d = String(domain || '');
  const r = String(rel || '');
  const rl = r.toLowerCase();
  const ext = rl.includes('.') ? rl.split('.').pop() : '';

  // iOS-specific app databases (no equivalent on other platforms).
  if (rl.endsWith('sms.db') || /SMS/i.test(d)) return 'messages';
  if (rl.endsWith('addressbook.sqlitedb') || /AddressBook/i.test(d)) return 'contacts';
  if (rl.endsWith('call_history.db') || rl.endsWith('callhistory.storedata') || /CallHistory/i.test(d)) return 'calls';
  if (/VoiceMemos/i.test(d) || /(^|\/)recordings\//.test(rl)) return 'voice';

  // Camera roll: on iOS, PNGs are overwhelmingly screenshots; stills vs clips.
  if (/CameraRoll/i.test(d) || /(^|\/)dcim\//.test(rl)) {
    if (ext === 'png') return 'screenshot';
    if (['mov', 'mp4', 'm4v'].includes(ext)) return 'video';
    if (['jpg', 'jpeg', 'heic', 'heif', 'gif', 'dng'].includes(ext)) return 'camera';
  }

  // Fall back to the shared path/extension classifier for everything else.
  return classify(r, ext);
};

/**
 * Parse a legacy (iOS 5–9) Manifest.mbdb binary index. These backups predate
 * Manifest.db (SQLite) and would otherwise recover nothing. The on-disk file for
 * each entry is named by SHA1("<domain>-<relativePath>") and stored flat in the
 * backup folder (no 2-char subdirectories).
 *
 * Record layout (all integers big-endian), after the 6-byte "mbdb\x05\x00" magic:
 *   domain, path, linkTarget, dataHash, encKey  (length-prefixed strings)
 *   mode u16, unknown u32, unknown u32, uid u32, gid u32,
 *   mtime u32, atime u32, ctime u32, fileLen u64, flag u8, nProps u8,
 *   then nProps × (name, value) strings.
 */
function parseMbdb(buf) {
  if (buf.length < 6 || buf.toString('latin1', 0, 4) !== 'mbdb') return [];
  let off = 6;
  const out = [];
  const readStr = () => {
    if (off + 2 > buf.length) { off = buf.length; return null; }
    const len = buf.readUInt16BE(off);
    off += 2;
    if (len === 0xffff) return Buffer.alloc(0); // nil
    const s = buf.subarray(off, off + len);
    off += len;
    return s;
  };
  const readInt = (n) => {
    let v = 0;
    for (let i = 0; i < n; i++) v = v * 256 + (buf[off + i] || 0);
    off += n;
    return v;
  };
  while (off < buf.length) {
    const domain = readStr();
    const rel = readStr();
    if (domain === null || rel === null) break;
    readStr(); readStr(); readStr();          // linkTarget, dataHash, encKey
    const mode = readInt(2);
    readInt(4); readInt(4); readInt(4); readInt(4); // unknown, unknown, uid, gid
    const mtime = readInt(4);
    readInt(4); readInt(4);                    // atime, ctime
    const fileLen = readInt(8);
    readInt(1);                                // flag
    const nProps = readInt(1);
    for (let i = 0; i < nProps; i++) { readStr(); readStr(); }
    if (off > buf.length) break;
    // Regular files only (S_IFREG = 0x8000).
    if ((mode & 0xf000) !== 0x8000) continue;
    const fileID = crypto.createHash('sha1')
      .update(Buffer.concat([domain, Buffer.from('-'), rel]))
      .digest('hex');
    out.push({
      fileID,
      domain: domain.toString('utf8'),
      relativePath: rel.toString('utf8'),
      size: fileLen,
      mtime: mtime ? new Date(mtime * 1000).toISOString() : null,
    });
  }
  return out;
}

function scanLegacyBackup(dir, { kinds = null } = {}) {
  const mbdbPath = path.join(dir, 'Manifest.mbdb');
  const buf = fs.readFileSync(mbdbPath);
  const rows = parseMbdb(buf);
  const files = rows.map((r) => {
    const kind = DOMAIN_KIND(r.domain, r.relativePath);
    // Legacy backups store the hashed file flat in the backup directory.
    let diskPath = path.join(dir, r.fileID);
    if (!fs.existsSync(diskPath)) {
      // A few late iOS 9 backups already use the 2-char subdir layout.
      const nested = path.join(dir, r.fileID.slice(0, 2), r.fileID);
      if (fs.existsSync(nested)) diskPath = nested;
    }
    let size = r.size || 0;
    if (!size) { try { size = fs.statSync(diskPath).size; } catch (_) {} }
    return {
      id: r.fileID,
      name: path.basename(r.relativePath || r.fileID),
      relativePath: r.relativePath,
      domain: r.domain,
      diskPath,
      size,
      kind,
    };
  }).filter((f) => (kinds && kinds.length ? kinds.includes(f.kind) : true));
  return { files, count: files.length };
}

async function scanBackup(udid, { kinds = null } = {}) {
  const root = backupRoot();
  const dir = path.join(root, udid);
  const manifestDb = path.join(dir, 'Manifest.db');

  // Legacy (iOS 5–9) backups: no SQLite manifest, parse Manifest.mbdb instead.
  if (!fs.existsSync(manifestDb)) {
    if (fs.existsSync(path.join(dir, 'Manifest.mbdb'))) {
      return scanLegacyBackup(dir, { kinds });
    }
    throw new Error('No Manifest.db or Manifest.mbdb found for this backup.');
  }

  const Database = loadSqlite();
  if (!Database) {
    throw new Error('better-sqlite3 is not built. Run: npm run rebuild');
  }

  let db;
  try {
    db = new Database(manifestDb, { readonly: true, fileMustExist: true });
  } catch (e) {
    throw new Error('Could not open Manifest.db (the backup may be encrypted).');
  }

  let rows;
  try {
    rows = db.prepare(
      'SELECT fileID, domain, relativePath, flags FROM Files WHERE flags = 1'
    ).all();
  } catch (e) {
    db.close();
    throw new Error('Manifest.db is unreadable (likely an encrypted backup).');
  }
  db.close();

  const files = rows.map((r) => {
    const kind = DOMAIN_KIND(r.domain, r.relativePath);
    const diskPath = path.join(dir, r.fileID.slice(0, 2), r.fileID);
    let size = 0;
    try { size = fs.statSync(diskPath).size; } catch (_) {}
    return {
      id: r.fileID,
      name: path.basename(r.relativePath || r.fileID),
      relativePath: r.relativePath,
      domain: r.domain,
      diskPath,
      size,
      kind,
    };
  }).filter((f) => (kinds && kinds.length ? kinds.includes(f.kind) : true));

  return { files, count: files.length };
}

async function extract(udid, files, outputDir) {
  await fsp.mkdir(outputDir, { recursive: true });
  const results = [];
  for (const f of files) {
    const safe = (f.relativePath || f.name).replace(/[\/\\]/g, '_');
    const dest = path.join(outputDir, safe);
    try {
      await fsp.copyFile(f.diskPath, dest);
      results.push({ ...f, restoredTo: dest, ok: true });
    } catch (err) {
      results.push({ ...f, ok: false, error: String(err) });
    }
  }
  return results;
}

module.exports = { listBackups, scanBackup, extract, backupRoot, parseMbdb };
