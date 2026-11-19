'use strict';

/**
 * Android recovery via the Android Debug Bridge (adb).
 *
 * With USB debugging enabled on the phone, adb gives read access to shared
 * storage (/sdcard). We can enumerate media and pull it off the device. True
 * recovery of *deleted* Android data needs root; without root we recover
 * everything still present in shared storage, which covers the common case of
 * "my photos vanished from the gallery but are still on the phone".
 */

const { spawn, execFile } = require('child_process');
const path = require('path');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');

const EXE = process.platform === 'win32' ? 'adb.exe' : 'adb';

/**
 * Candidate directories where adb commonly lives, so detection works even when
 * the app is launched from Finder/Dock (which gives a GUI app a stripped PATH
 * that contains none of Homebrew, the Android SDK, or the user's shell PATH).
 */
function candidateDirs() {
  const home = os.homedir();
  const dirs = [];
  const sdks = [
    process.env.ANDROID_HOME,
    process.env.ANDROID_SDK_ROOT,
    path.join(home, 'Library', 'Android', 'sdk'),      // macOS Android Studio
    path.join(home, 'Android', 'Sdk'),                 // Linux Android Studio
    path.join(process.env.LOCALAPPDATA || '', 'Android', 'Sdk'), // Windows
  ].filter(Boolean);
  for (const s of sdks) dirs.push(path.join(s, 'platform-tools'));

  dirs.push(
    '/opt/homebrew/bin',            // Apple-silicon Homebrew
    '/usr/local/bin',               // Intel Homebrew
    '/usr/bin', '/bin',
    path.join(home, 'platform-tools'),
    'C:\\platform-tools',
    'C:\\Android\\platform-tools'
  );
  // Anything already on PATH, too.
  (process.env.PATH || '').split(path.delimiter).forEach((d) => d && dirs.push(d));
  return [...new Set(dirs)];
}

let _adbCache;
function findAdb() {
  if (_adbCache !== undefined) return _adbCache;
  for (const dir of candidateDirs()) {
    const full = path.join(dir, EXE);
    try {
      if (fs.existsSync(full) && fs.statSync(full).isFile()) {
        _adbCache = full;
        return full;
      }
    } catch (_) {}
  }
  _adbCache = null;
  return null;
}

// Back-compat shim: resolve adb regardless of the name requested.
async function which(cmd) {
  if (cmd === 'adb') return findAdb();
  return new Promise((resolve) => {
    execFile(process.platform === 'win32' ? 'where' : 'which', [cmd], (err, out) => {
      resolve(err ? null : out.toString().trim().split(/\r?\n/)[0]);
    });
  });
}

function run(bin, args, { timeout = 120000 } = {}) {
  return new Promise((resolve) => {
    let out = '';
    let err = '';
    // Make sure the binary's own directory is on PATH for any helper it spawns.
    const env = { ...process.env };
    try {
      const dir = path.dirname(bin);
      env.PATH = `${dir}${path.delimiter}${env.PATH || ''}`;
    } catch (_) {}
    const p = spawn(bin, args, { env });
    const timer = setTimeout(() => p.kill(), timeout);
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    p.on('error', (e) => {
      clearTimeout(timer);
      resolve({ code: -1, out, err: String(e) });
    });
    p.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, out, err });
    });
  });
}

async function status() {
  const adb = await which('adb');
  if (!adb) {
    return {
      available: false,
      reason: 'Could not find the adb binary (searched Homebrew, the Android SDK, ANDROID_HOME and PATH).',
      install: process.platform === 'darwin'
        ? 'Install with: brew install android-platform-tools'
        : process.platform === 'win32'
          ? 'Install Android SDK Platform Tools and add them to PATH, or drop adb.exe in C:\\platform-tools.'
          : 'Install Android SDK Platform Tools from developer.android.com.',
      devices: [],
    };
  }
  const res = await run(adb, ['devices', '-l']);
  const devices = res.out
    .split(/\r?\n/)
    .slice(1)
    .map((l) => l.trim())
    .filter(Boolean)
    .filter((l) => !l.startsWith('*'))
    .map((l) => {
      const [serial, state, ...rest] = l.split(/\s+/);
      const model = (rest.find((r) => r.startsWith('model:')) || '').replace('model:', '');
      return { serial, state, model: model || 'Android device' };
    });
  return { available: true, adb, devices };
}

const MEDIA_DIRS = [
  '/sdcard/DCIM',
  '/sdcard/Pictures',
  '/sdcard/Movies',
  '/sdcard/Music',
  '/sdcard/Download',
  '/sdcard/WhatsApp',
  '/sdcard/Documents',
];

function kindFromExt(ext) {
  ext = ext.toLowerCase();
  if (['jpg', 'jpeg', 'png', 'gif', 'heic', 'webp'].includes(ext)) return 'image';
  if (['mp4', 'mov', '3gp', 'mkv'].includes(ext)) return 'video';
  if (['mp3', 'm4a', 'wav', 'ogg'].includes(ext)) return 'audio';
  if (['pdf', 'doc', 'docx', 'txt'].includes(ext)) return 'document';
  return 'other';
}

async function scan(serial, { onProgress } = {}) {
  const adb = await which('adb');
  if (!adb) throw new Error('adb not found');
  const base = serial ? ['-s', serial] : [];
  const files = [];
  for (const dir of MEDIA_DIRS) {
    if (onProgress) onProgress({ phase: 'scan', current: dir });
    // `find` with printf gives us size + mtime in one shot.
    const res = await run(adb, [
      ...base, 'shell', 'find', dir, '-type', 'f',
      '-printf', '%s\\t%T@\\t%p\\n',
    ]);
    let lines = res.out.split(/\r?\n/).filter(Boolean);
    // Some busybox builds lack -printf; fall back to plain find.
    if (res.code !== 0 || (lines.length && !lines[0].includes('\t'))) {
      const res2 = await run(adb, [...base, 'shell', 'find', dir, '-type', 'f']);
      lines = res2.out.split(/\r?\n/).filter(Boolean).map((p) => `0\t0\t${p}`);
    }
    for (const line of lines) {
      const [size, mtime, ...pathParts] = line.split('\t');
      const p = pathParts.join('\t');
      if (!p) continue;
      const ext = path.extname(p).replace('.', '').toLowerCase();
      files.push({
        id: p,
        name: path.basename(p),
        path: p,
        size: parseInt(size, 10) || 0,
        ext,
        kind: kindFromExt(ext),
        modified: mtime && mtime !== '0'
          ? new Date(parseFloat(mtime) * 1000).toISOString()
          : null,
      });
    }
  }
  return { files, count: files.length };
}

async function pull(serial, files, outputDir, { onProgress } = {}) {
  const adb = await which('adb');
  if (!adb) throw new Error('adb not found');
  await fsp.mkdir(outputDir, { recursive: true });
  const base = serial ? ['-s', serial] : [];
  const results = [];
  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    const dest = path.join(outputDir, f.name);
    const res = await run(adb, [...base, 'pull', f.path, dest]);
    results.push({ ...f, restoredTo: dest, ok: res.code === 0, error: res.code === 0 ? null : res.err });
    if (onProgress) onProgress({ phase: 'pull', index: i + 1, total: files.length, name: f.name });
  }
  return results;
}

module.exports = { status, scan, pull };
