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

    backups.push({
      udid,
      dir,
      hasManifest: fs.existsSync(manifestDb),
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
  const r = (rel || '').toLowerCase();
  if (domain.includes('CameraRollDomain') || /\.(jpg|jpeg|png|heic|mov|mp4|gif)$/.test(r)) {
    return /\.(mov|mp4)$/.test(r) ? 'video' : 'image';
  }
  if (r.endsWith('sms.db') || domain.includes('SMS')) return 'messages';
  if (r.endsWith('addressbook.sqlitedb') || domain.includes('AddressBook')) return 'contacts';
  if (r.endsWith('call_history.db') || domain.includes('CallHistory')) return 'calls';
  if (/\.(pdf|doc|docx|txt|pages)$/.test(r)) return 'document';
  if (/\.(mp3|m4a|wav)$/.test(r)) return 'audio';
  if (/\.(sqlitedb|db|sqlite)$/.test(r)) return 'database';
  return 'other';
};

async function scanBackup(udid, { kinds = null } = {}) {
  const Database = loadSqlite();
  if (!Database) {
    throw new Error('better-sqlite3 is not built. Run: npm run rebuild');
  }
  const root = backupRoot();
  const dir = path.join(root, udid);
  const manifestDb = path.join(dir, 'Manifest.db');
  if (!fs.existsSync(manifestDb)) throw new Error('Manifest.db not found for this backup.');

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

module.exports = { listBackups, scanBackup, extract, backupRoot };
