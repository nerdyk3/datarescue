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
const { classify, isTrash, isNoise } = require('./categorize');

const EXE = process.platform === 'win32' ? 'adb.exe' : 'adb';

/**
 * Candidate directories where adb commonly lives, so detection works even when
 * the app is launched from Finder/Dock (which gives a GUI app a stripped PATH
 * that contains none of Homebrew, the Android SDK, or the user's shell PATH).
 */
function candidateDirs() {
  const home = os.homedir();
  const dirs = [];
  // Prefer adb bundled inside the packaged app (resources/platform-tools), then
  // the dev-time vendored copy from `npm run bundle:adb`, so Android recovery
  // works with no separate adb install.
  if (process.resourcesPath) dirs.push(path.join(process.resourcesPath, 'platform-tools'));
  dirs.push(path.join(__dirname, '..', 'vendor', 'adb'));
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
    let done = false;
    const finish = (code) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ code, out, err });
    };
    const timer = setTimeout(() => { try { p.kill(); } catch (_) {} finish(-2); }, timeout);
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    p.on('error', (e) => { err += String(e); finish(-1); });
    // Resolve on 'exit' (the adb CLI process has terminated), NOT 'close'.
    // adb forks a background daemon that inherits our stdio pipes and holds
    // them open, so 'close' (stdio EOF) never fires until the timeout — which
    // made every adb call block for the full timeout. 'exit' fires as soon as
    // the CLI finishes; a tiny delay lets the last stdout chunk flush.
    p.on('exit', (code) => setTimeout(() => finish(code), 40));
  });
}

function parseDevices(out) {
  return out
    .split(/\r?\n/)
    .slice(1) // drop "List of devices attached"
    .map((l) => l.trim())
    .filter(Boolean)
    .filter((l) => !l.startsWith('*') && !l.startsWith('adb '))
    .map((l) => {
      const [serial, state, ...rest] = l.split(/\s+/);
      const model = (rest.find((r) => r.startsWith('model:')) || '')
        .replace('model:', '').replace(/_/g, ' ');
      const network = /:\d+$/.test(serial || '');
      return { serial, state, model: model || (network ? 'Wi-Fi device' : 'Android device'), network };
    })
    .filter((d) => d.serial);
}

/**
 * Kill and restart the adb server with OUR binary. This recovers from a server
 * left wedged by a different adb version (e.g. Android Studio's) fighting over
 * port 5037 — the usual cause of `adb devices` hanging with no output.
 */
async function resetServer(adb) {
  await run(adb, ['kill-server'], { timeout: 8000 });
  await run(adb, ['start-server'], { timeout: 15000 });
}

/**
 * Discover Android phones advertising wireless debugging on the LAN via mDNS,
 * and silently connect to any we've paired with before. This is what makes
 * Wi-Fi "just work" with no IP typing — adb reuses the stored TLS pairing, so
 * `adb connect` succeeds invisibly for a known phone.
 */
async function discoverWireless(adb) {
  const res = await run(adb, ['mdns', 'services'], { timeout: 6000 });
  const connected = [];
  const lines = (res.out || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  for (const line of lines) {
    if (!line.includes('_adb-tls-connect')) continue;
    // e.g. "adb-abc123-xyz  _adb-tls-connect._tcp  192.168.1.42:37000"
    const m = line.match(/(\d{1,3}(?:\.\d{1,3}){3}:\d+)/);
    if (!m) continue;
    const target = m[1];
    const c = await run(adb, ['connect', target], { timeout: 8000 });
    if (/connected to/i.test(c.out + c.err)) connected.push(target);
  }
  return connected;
}

async function status({ wireless = true } = {}) {
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

  // First attempt with a short timeout so a wedged server can't freeze the UI.
  let res = await run(adb, ['devices', '-l'], { timeout: 12000 });
  let recovered = false;

  // Timed out (-2) or errored, or emitted a version-mismatch restart notice →
  // reset the server and try once more.
  const mismatch = /version|killing|out of date|cannot connect|daemon/i.test(res.err || '');
  if (res.code === -2 || res.code !== 0 || mismatch) {
    await resetServer(adb);
    res = await run(adb, ['devices', '-l'], { timeout: 15000 });
    recovered = true;
  }

  // Auto-discover + silently connect wireless phones, then re-list if any joined.
  let wirelessFound = [];
  if (wireless) {
    try {
      wirelessFound = await discoverWireless(adb);
      if (wirelessFound.length) {
        res = await run(adb, ['devices', '-l'], { timeout: 12000 });
      }
    } catch (_) {}
  }

  return {
    available: true,
    adb,
    devices: parseDevices(res.out),
    recovered,
    wirelessConnected: wirelessFound,
  };
}

/** Connect to a phone over the network (wireless debugging / adb tcpip). */
async function connect(hostPort) {
  const adb = await which('adb');
  if (!adb) throw new Error('adb not found');
  const target = /:\d+$/.test(hostPort) ? hostPort : `${hostPort}:5555`;
  const res = await run(adb, ['connect', target], { timeout: 15000 });
  const text = (res.out + res.err).trim();
  const ok = /connected to/i.test(text) && !/cannot|failed|refused/i.test(text);
  return { ok, message: text || 'No response from adb connect.', target };
}

/** Pair with a phone using Android 11+ Wireless debugging (IP:PORT + 6-digit code). */
async function pair(hostPort, code) {
  const adb = await which('adb');
  if (!adb) throw new Error('adb not found');
  const res = await run(adb, ['pair', hostPort, code], { timeout: 20000 });
  const text = (res.out + res.err).trim();
  const ok = /successfully paired/i.test(text);
  return { ok, message: text || 'No response from adb pair.' };
}

/**
 * Discover every shared-storage root on the phone: primary (/sdcard) plus any
 * removable SD card / USB-OTG volume mounted under /storage (e.g. "1A2B-3C4D").
 *
 * We deliberately keep "/sdcard" (a symlink to the primary volume) and skip the
 * /storage aliases that point back at the same files — "self", "emulated" and
 * OEM encrypted mirrors like Samsung's "enc_emulated" — so files aren't listed
 * twice under two paths.
 */
async function storageRoots(adb, base) {
  const roots = ['/sdcard'];
  const res = await run(adb, [...base, 'shell', 'ls', '/storage'], { timeout: 8000 });
  if (res.code === 0) {
    for (const raw of res.out.split(/\r?\n/)) {
      const name = raw.trim();
      if (!name) continue;
      if (name === 'self' || name === 'emulated' || name.startsWith('enc_')) continue;
      roots.push(`/storage/${name}`);
    }
  }
  return [...new Set(roots)];
}

/**
 * Enumerate every regular file under one storage root.
 *
 * Two device realities shaped this:
 *   1. /sdcard is a SYMLINK (-> /storage/self/primary). Android's toybox `find`
 *      will NOT descend into a symlink given as the start path, so `find /sdcard`
 *      returns nothing. `find -L` follows it and lists the whole tree.
 *   2. toybox `find` has no `-printf`. We get size + mtime by batching the paths
 *      into `stat -c` via `-exec … {} +` (one extra process, not one per file).
 * If `stat`/`-exec +` aren't available (very old busybox), we fall back to a
 * bare `find -L` that still returns every path (size/mtime unknown).
 */
async function listRoot(adb, base, root) {
  // Fields are size|mtime|path. Path is last, so splitting on the first two
  // pipes is safe even if a filename itself contains a pipe (size/mtime are
  // always plain digits). A pipe delimiter avoids escaping entirely — toybox
  // stat does NOT expand '\t', it would print it literally.
  const parse = (lines, hasMeta) => lines.map((line) => {
    if (hasMeta) {
      const b1 = line.indexOf('|');
      const b2 = line.indexOf('|', b1 + 1);
      if (b1 === -1 || b2 === -1) return null;
      return { size: line.slice(0, b1), mtime: line.slice(b1 + 1, b2), p: line.slice(b2 + 1) };
    }
    return { size: '0', mtime: '0', p: line };
  }).filter(Boolean);

  // Pass the whole pipeline as ONE shell string so our quoting survives. If we
  // handed adb separate argv tokens, adb would re-join them unquoted and the
  // device shell would treat the pipe as a real pipe. Single-quoting the format
  // keeps '%s|%Y|%n' as one literal argument to stat.
  const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

  // Primary: find -L (follow the /sdcard symlink) + batched stat for
  // size|mtime|path. '-exec … {} +' batches all paths into one stat process.
  const cmd = `find -L ${q(root)} -type f -exec stat -c '%s|%Y|%n' {} + 2>/dev/null`;
  const res = await run(adb, [...base, 'shell', cmd], { timeout: 300000 });
  let rows = parse(res.out.split(/\r?\n/).filter(Boolean), true);

  // Fallback for very old busybox without stat/-exec +: bare path list only.
  if (!rows.length) {
    const cmd2 = `find -L ${q(root)} -type f 2>/dev/null`;
    const res2 = await run(adb, [...base, 'shell', cmd2], { timeout: 300000 });
    rows = parse(res2.out.split(/\r?\n/).filter(Boolean), false);
  }
  return rows;
}

async function scan(serial, { onProgress } = {}) {
  const adb = await which('adb');
  if (!adb) throw new Error('adb not found');
  const base = serial ? ['-s', serial] : [];

  const roots = await storageRoots(adb, base);
  const files = [];
  const seen = new Set();

  for (const root of roots) {
    if (onProgress) onProgress({ phase: 'scan', current: root });
    const rows = await listRoot(adb, base, root);
    for (const { size, mtime, p } of rows) {
      if (!p || seen.has(p)) continue;
      const base2 = path.basename(p);
      // `.nomedia` markers and OS junk are empty flags, not recoverable content.
      if (isNoise(base2)) continue;
      const trash = isTrash(p, base2);
      // App sandboxes under Android/data and Android/obb are mostly caches and
      // usually permission-denied without root — skip them UNLESS the file sits
      // in a recycle bin there (deleted user files we DO want), e.g. Samsung My
      // Files trash. Android/media (real user media) is not under /data and is
      // always kept.
      if (/\/Android\/(data|obb)\//.test(p) && !trash) continue;
      seen.add(p);
      const ext = path.extname(p).replace('.', '').toLowerCase();
      files.push({
        id: p,
        name: base2,
        path: p,
        size: parseInt(size, 10) || 0,
        ext,
        kind: classify(p, ext, { trash }),
        deleted: trash || undefined,
        modified: mtime && mtime !== '0'
          ? new Date(parseInt(mtime, 10) * 1000).toISOString()
          : null,
      });
    }
  }
  files.sort((a, b) => new Date(b.modified || 0) - new Date(a.modified || 0));
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

module.exports = { status, scan, pull, connect, pair, resetServer };
