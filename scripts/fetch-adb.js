'use strict';
/**
 * Download the official Android platform-tools for the CURRENT OS and extract
 * just the adb binary (plus the two USB DLLs on Windows) into vendor/adb/.
 * electron-builder bundles that folder into the installer as resources/
 * platform-tools, so Android recovery works out of the box with no separate
 * `brew install android-platform-tools` step.
 *
 * Idempotent: skips the download if adb is already present. Run before packaging
 * (`npm run bundle:adb`); the dist scripts do this automatically.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const { execFileSync } = require('child_process');

const PLATFORM = process.platform; // 'darwin' | 'win32' | 'linux'
const URL_OS = { darwin: 'darwin', win32: 'windows', linux: 'linux' }[PLATFORM];
if (!URL_OS) {
  console.error(`Unsupported platform: ${PLATFORM}`);
  process.exit(1);
}
const URL = `https://dl.google.com/android/repository/platform-tools-latest-${URL_OS}.zip`;

const vendorDir = path.join(__dirname, '..', 'vendor', 'adb');
const adbName = PLATFORM === 'win32' ? 'adb.exe' : 'adb';
const adbDest = path.join(vendorDir, adbName);

if (fs.existsSync(adbDest)) {
  console.log(`adb already bundled at ${adbDest} — skipping download.`);
  process.exit(0);
}

function download(url, dest, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 5) return reject(new Error('Too many redirects'));
    https.get(url, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return resolve(download(res.headers.location, dest, redirects + 1));
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
      }
      const file = fs.createWriteStream(dest);
      res.pipe(file);
      file.on('finish', () => file.close(resolve));
      file.on('error', reject);
    }).on('error', reject);
  });
}

(async () => {
  fs.mkdirSync(vendorDir, { recursive: true });
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'adb-dl-'));
  const zip = path.join(tmp, 'platform-tools.zip');
  console.log(`Downloading ${URL} …`);
  await download(URL, zip);
  console.log(`Downloaded ${(fs.statSync(zip).size / 1024 / 1024).toFixed(1)} MB; extracting adb …`);

  // Files we need from the archive (paths are prefixed with "platform-tools/").
  const wanted = PLATFORM === 'win32'
    ? ['platform-tools/adb.exe', 'platform-tools/AdbWinApi.dll', 'platform-tools/AdbWinUsbApi.dll']
    : ['platform-tools/adb'];

  const extractDir = path.join(tmp, 'ex');
  fs.mkdirSync(extractDir, { recursive: true });
  if (PLATFORM === 'win32') {
    // PowerShell Expand-Archive is available on all supported Windows.
    execFileSync('powershell', ['-NoProfile', '-Command',
      `Expand-Archive -LiteralPath '${zip}' -DestinationPath '${extractDir}' -Force`], { stdio: 'inherit' });
  } else {
    execFileSync('unzip', ['-o', zip, ...wanted, '-d', extractDir], { stdio: 'inherit' });
  }

  for (const rel of wanted) {
    const from = path.join(extractDir, rel);
    const to = path.join(vendorDir, path.basename(rel));
    fs.copyFileSync(from, to);
    if (PLATFORM !== 'win32') fs.chmodSync(to, 0o755);
    console.log(`  bundled ${path.basename(rel)}`);
  }

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`\nadb bundled into ${vendorDir}`);
})().catch((e) => {
  console.error('Failed to bundle adb:', e.message);
  console.error('You can still ship without it — the app falls back to a system adb.');
  process.exit(1);
});
