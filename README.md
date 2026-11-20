# 🛡️ DataRescue — Recovery Studio

A cross-platform **data recovery** desktop app for **PC, Android and iOS**, with a polished UI.
The interface is plain HTML/CSS/JS (Electron's renderer); the recovery engine is real
Node.js code that reads raw devices, drives `adb`, and parses iOS backups.

> **Safe by design:** DataRescue only ever *reads* your source and *copies* recovered
> files out to a separate folder. It never writes to the device you're recovering from.

---

## ✨ What it recovers

| Source | How it works | Recovers |
|--------|--------------|----------|
| **🖥️ PC Drive / Image** | Signature-based **file carving** — scans raw bytes of a disk, device, SD card or `.dd`/`.img` image for file headers/footers and rebuilds files with no filesystem needed (how PhotoRec/Recuva work). | Photos, videos, PDFs, Office docs, ZIPs, SQLite DBs — even after **formatting or deletion** |
| **🗑️ Trash / Recycle Bin** | Lists intact files still in the OS trash and copies them back out. | Anything recently deleted |
| **📁 Folder / Volume** | Indexes a mounted drive/folder, grouped by type and recency. | Files on a drive that mounts but you "can't find" |
| **🤖 Android** | Reads shared storage over **ADB** (USB debugging) and pulls files. | DCIM, WhatsApp media, Downloads, documents |
| **📱 iPhone / iPad** | Parses the local iTunes/Finder backup's `Manifest.db` and extracts files by their real names. | Camera roll, Messages, Contacts, app data |

---

## 📦 Install (prebuilt)

Grab an installer for your OS from the [Releases page](https://github.com/nerdyk3/datarescue/releases):

| OS | File | Notes |
|----|------|-------|
| **macOS** | `DataRescue-<ver>.dmg` | Universal (Apple Silicon + Intel). Unsigned — right-click → **Open** the first time. |
| **Windows** | `DataRescue-<ver>-Setup.exe` | NSIS installer, choose-your-folder. |
| **Linux** | `DataRescue-<ver>.AppImage` / `.deb` | AppImage: `chmod +x` then run. |

`adb` is **bundled inside the app**, so Android recovery works with nothing extra to install.

## 🚀 Run from source

```bash
cd datarescue
npm install            # installs Electron + better-sqlite3
npm run rebuild        # builds better-sqlite3 against Electron (needed for iOS)
npm start              # launches the app
```

### Optional tooling (feature-dependent)

- **Android:** requires `adb`.
  macOS: `brew install android-platform-tools` · others: Android SDK Platform Tools.
  The app detects whether it's installed and guides you if not.
- **iOS:** needs an existing **unencrypted** local backup (Finder/iTunes → "Back Up Now").
  Encrypted backups are detected and reported (their index is encrypted).

---

## 🧭 How to use

1. Pick a **source** in the left sidebar.
2. Select the disk/image/folder/device (or scan the trash/backups).
3. Browse results — filter by **type** (images, video, audio, docs…), select what you want.
4. Click **Recover selected**. Files are saved to `~/DataRescue_Recovered/…`, and a toast
   lets you jump straight to the folder.

---

## 🏗️ Architecture

```
datarescue/
├── main.js            Electron main process + IPC handlers
├── preload.js         Secure context bridge (window.api)
├── engine/            Pure-Node recovery engine (no Electron deps — unit-testable)
│   ├── signatures.js  File signature database (magic headers/footers)
│   ├── carver.js      Signature-based carving: scan → describe → recover
│   ├── trash.js       OS trash / recycle bin
│   ├── scanner.js     Deep folder/volume indexing
│   ├── android.js     ADB device detection, scan, pull
│   └── ios.js         Local iOS backup discovery + Manifest.db extraction
└── src/               Renderer UI (plain HTML/CSS/JS)
    ├── index.html
    ├── styles.css     Polished dark theme
    └── renderer.js    UI logic
```

The engine is deliberately decoupled from Electron so it can be tested from plain Node.

---

## ⚠️ Notes & limits

- **Raw whole-disk access** (e.g. `/dev/rdisk3`) needs elevated privileges — the safest
  workflow is to image the disk first (`sudo dd if=/dev/rdiskN of=disk.img bs=1m`) and carve the image.
- Carving recovers file **contents**; original filenames aren't stored on disk, so carved
  files get sequential names by type.
- Deleted-Android recovery of data *outside* shared storage needs root; without root,
  DataRescue recovers everything still present in `/sdcard`.

---

## 🏭 Building installers yourself

Each OS is built on its own machine (you can't cross-build the native
`better-sqlite3` module or the platform installers reliably from another OS).

```bash
npm install
npm run dist:mac      # → dist/DataRescue-<ver>.dmg + .zip   (run on macOS)
npm run dist:win      # → dist/DataRescue-<ver>-Setup.exe    (run on Windows)
npm run dist:linux    # → dist/DataRescue-<ver>.AppImage/.deb (run on Linux)
```

Every `dist:*` script first runs `npm run bundle:adb`, which downloads the
official Android platform-tools for that OS and bundles `adb` into the app
(`scripts/fetch-adb.js`). The app icon is generated from code by
`npm run make:icon` (`assets/icon.png`).

### All three at once (CI)

`.github/workflows/build.yml` builds macOS, Windows and Linux in parallel on
GitHub-hosted runners:

- **Manually:** Actions → *Build installers* → **Run workflow** → download the
  artifacts.
- **On a tag:** `git tag v1.0.0 && git push --tags` builds all three and
  attaches the installers to a GitHub Release automatically.

### Signing / notarization

CI builds are **unsigned** (`CSC_IDENTITY_AUTO_DISCOVERY=false`). To ship signed
builds, provide the usual electron-builder secrets (Apple `CSC_LINK` /
`CSC_KEY_PASSWORD` + notarization creds on macOS, a code-signing cert on Windows).

## 📄 License

MIT
