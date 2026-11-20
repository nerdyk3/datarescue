'use strict';

/* ======================================================================== *
 *  DataRescue — renderer (plain JS). Drives the UI and talks to the engine
 *  through window.api (see preload.js).
 * ======================================================================== */

// NOTE: must NOT be named `api` — contextBridge exposes a non-configurable
// `api` property on window, and a top-level `const api` would collide and throw
// a SyntaxError that kills the whole script.
const rescue = window.api;

const KIND_ICON = {
  image: '🖼️', video: '🎬', audio: '🎵', document: '📄',
  archive: '🗜️', database: '🗃️', messages: '💬', contacts: '👤',
  calls: '📞', other: '📦',
  screenshot: '📸', camera: '📷', voice: '🎙️', backup: '🔐', trash: '🗑️',
};

const PANELS = {
  carve: {
    title: 'PC Drive / Image',
    subtitle: 'Reconstruct files from a raw disk, device, or forensic image — even without a filesystem.',
  },
  trash: {
    title: 'Trash / Recycle Bin',
    subtitle: 'Recover fully-intact files still sitting in the OS trash.',
  },
  folder: {
    title: 'Folder / Volume',
    subtitle: 'Index a mounted drive or folder and rescue files by type and recency.',
  },
  android: {
    title: 'Android Phone',
    subtitle: 'Pull photos, videos and media off an Android device over ADB.',
  },
  ios: {
    title: 'iPhone / iPad',
    subtitle: 'Extract photos, messages and contacts from a local iOS backup.',
  },
};

const state = {
  source: 'carve',
  files: [],
  selected: new Set(),
  filter: 'all',
  ctx: {},        // source path / serial / udid
  busy: false,
};

/* ------------------------------- helpers -------------------------------- */

const $ = (sel) => document.querySelector(sel);
const el = (tag, cls, html) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (html != null) n.innerHTML = html;
  return n;
};

function fmtSize(bytes) {
  if (!bytes || bytes < 0) return '—';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0, n = bytes;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(n < 10 && i > 0 ? 1 : 0)} ${u[i]}`;
}

function toast(title, body, kind = 'ok', ms = 4200) {
  const t = el('div', `toast ${kind}`);
  t.innerHTML = `<div><strong>${title}</strong>${body ? `<div class="t-body">${body}</div>` : ''}</div>`;
  $('#toasts').appendChild(t);
  setTimeout(() => { t.style.opacity = '0'; t.style.transform = 'translateX(20px)'; }, ms - 300);
  setTimeout(() => t.remove(), ms);
}

/* ------------------------------ navigation ------------------------------ */

document.querySelectorAll('.nav-item').forEach((b) => {
  b.addEventListener('click', () => selectSource(b.dataset.source));
});

let androidPoll = null;
function stopAndroidPoll() { if (androidPoll) { clearInterval(androidPoll); androidPoll = null; } }

function selectSource(src) {
  if (state.busy) { toast('Scan in progress', 'Stop the current task first.', 'warn'); return; }
  stopAndroidPoll();
  state.source = src;
  state.files = [];
  state.selected.clear();
  state.filter = 'all';
  state.ctx = {};

  document.querySelectorAll('.nav-item').forEach((b) =>
    b.classList.toggle('active', b.dataset.source === src));

  $('#panelTitle').textContent = PANELS[src].title;
  $('#panelSubtitle').textContent = PANELS[src].subtitle;
  $('#results').hidden = true;
  $('#progressWrap').hidden = true;
  $('#tbActions').innerHTML = '';
  renderSetup(src);
}

/* ------------------------------ setup cards ----------------------------- */

function renderSetup(src) {
  const setup = $('#setup');
  setup.innerHTML = '';

  if (src === 'carve') {
    setup.appendChild(heroCard({
      art: '🖥️',
      h2: 'Deep signature carving',
      p: 'Point DataRescue at a whole disk, an external drive, an SD card, or a <code>.dd</code>/<code>.img</code> image. It scans the raw bytes for file signatures and rebuilds photos, videos, documents and archives — independent of any filesystem. This recovers data even after formatting or deletion.',
      meta: ['JPEG · PNG · HEIC', 'MP4 · MOV', 'PDF · DOCX · XLSX', 'ZIP · SQLite'],
      cta: primaryPick('Select disk / image', async () => {
        const p = await rescue.pickSource();
        if (!p) return;
        state.ctx.source = p;
        $('#srcPath').textContent = p;
        $('#srcPath').hidden = false;
        $('#startCarve').disabled = false;
      }),
    }));
    const path = el('div', 'src-path');
    path.id = 'srcPath'; path.hidden = true;
    const start = el('button', 'btn primary lg', 'Start deep scan');
    start.id = 'startCarve'; start.disabled = true;
    start.onclick = startCarve;
    const hero = setup.querySelector('.hero-cta');
    hero.appendChild(path); hero.appendChild(start);
  }

  if (src === 'trash') {
    setup.appendChild(heroCard({
      art: '🗑️',
      h2: 'Scan the Trash / Recycle Bin',
      p: 'Files you deleted recently are usually still intact in the system trash. DataRescue lists them and copies any you choose back out to a safe folder.',
      meta: ['macOS .Trash', 'Windows $Recycle.Bin', 'Linux Trash'],
      cta: primaryPick('Scan trash now', startTrash),
    }));
  }

  if (src === 'folder') {
    setup.appendChild(heroCard({
      art: '📁',
      h2: 'Index a folder or mounted volume',
      p: 'Great for a drive that still mounts but whose files you can’t find. Pick a folder or volume and DataRescue indexes everything, grouped by type and sorted by most-recently-modified.',
      meta: ['External drives', 'SD cards', 'Network shares', 'Any folder'],
      cta: primaryPick('Choose folder & scan', async () => {
        const p = await rescue.pickFolder();
        if (!p) return;
        state.ctx.root = p;
        startFolder();
      }),
    }));
  }

  if (src === 'android') {
    setup.appendChild(heroCard({
      art: '🤖',
      h2: 'Connect an Android phone',
      p: 'Enable <strong>Developer Options → USB debugging</strong> on the phone, connect it by USB, and DataRescue will read your shared storage (DCIM, WhatsApp, Downloads…) over ADB and pull files off safely.',
      meta: ['Photos & videos', 'WhatsApp media', 'Downloads', 'No root needed'],
      cta: primaryPick('Detect device', startAndroidDetect),
    }));
    setup.appendChild(wifiCard());
    setup.appendChild(sectionList('androidDevices'));
    // Detect automatically on open, then keep watching so a USB or Wi-Fi phone
    // appears on its own — no button press, wireless connected invisibly.
    startAndroidDetect();
    stopAndroidPoll();
    androidPoll = setInterval(() => {
      if (state.source === 'android' && !state.busy) startAndroidDetect({ silent: true });
    }, 6000);
  }

  if (src === 'ios') {
    setup.appendChild(heroCard({
      art: '📱',
      h2: 'Read a local iPhone backup',
      p: 'If you’ve ever backed up this iPhone/iPad to this computer, a full copy lives here. DataRescue parses the backup index and extracts your photos, messages and contacts with their real names.',
      meta: ['Camera roll', 'Messages', 'Contacts', 'App data'],
      cta: primaryPick('Find backups', startIosDetect),
    }));
    setup.appendChild(sectionList('iosBackups'));
  }
}

function wifiCard() {
  const card = el('div', 'card');
  card.style.marginTop = '14px';
  card.innerHTML = `
    <h2 style="font-size:15px;margin-bottom:6px">📶 Connect over Wi-Fi (wireless debugging)</h2>
    <p style="color:var(--muted);font-size:13px;line-height:1.55;max-width:66ch">
      Same Wi-Fi as this computer. On the phone: <strong>Developer options → Wireless debugging</strong>.
      For the first pairing, use “Pair device with pairing code” and enter that
      <em>IP:port</em> + 6-digit code below. After that, just connect to the
      phone's main <em>IP:port</em> shown under Wireless debugging.
    </p>
    <div style="display:flex;flex-wrap:wrap;gap:10px;margin-top:14px;align-items:flex-end">
      <label style="font-size:12px;color:var(--muted-2)">Pair address &amp; code (first time only)
        <div style="display:flex;gap:8px;margin-top:5px">
          <input id="pairAddr" placeholder="192.168.1.42:37123" class="wifi-in" />
          <input id="pairCode" placeholder="123456" class="wifi-in" style="width:90px" />
          <button class="btn sm" id="pairBtn">Pair</button>
        </div>
      </label>
      <label style="font-size:12px;color:var(--muted-2)">Connect address
        <div style="display:flex;gap:8px;margin-top:5px">
          <input id="wifiAddr" placeholder="192.168.1.42:5555" class="wifi-in" />
          <button class="btn primary sm" id="wifiBtn">Connect</button>
        </div>
      </label>
    </div>
    <div id="wifiMsg" style="margin-top:10px;font-size:12px;font-family:ui-monospace;color:var(--muted-2);min-height:14px"></div>`;

  card.querySelector('#wifiBtn').onclick = async () => {
    const addr = card.querySelector('#wifiAddr').value.trim();
    if (!addr) return;
    const msg = card.querySelector('#wifiMsg');
    msg.textContent = 'Connecting…';
    const res = await rescue.androidConnect({ hostPort: addr });
    msg.textContent = res.ok ? `✓ ${res.message}` : `✗ ${res.message || res.error}`;
    if (res.ok) { toast('Connected', res.message, 'ok'); startAndroidDetect(); }
    else toast('Connect failed', res.message || res.error, 'err');
  };
  card.querySelector('#pairBtn').onclick = async () => {
    const addr = card.querySelector('#pairAddr').value.trim();
    const code = card.querySelector('#pairCode').value.trim();
    if (!addr || !code) return;
    const msg = card.querySelector('#wifiMsg');
    msg.textContent = 'Pairing…';
    const res = await rescue.androidPair({ hostPort: addr, code });
    msg.textContent = res.ok ? `✓ ${res.message}` : `✗ ${res.message || res.error}`;
    toast(res.ok ? 'Paired' : 'Pair failed', res.message || res.error, res.ok ? 'ok' : 'err');
  };
  return card;
}

function heroCard({ art, h2, p, meta, cta }) {
  const card = el('div', 'card hero');
  card.innerHTML = `
    <div class="hero-art">${art}</div>
    <div class="hero-body">
      <h2>${h2}</h2>
      <p>${p}</p>
      <div class="hero-meta">${meta.map((m) => `<span class="chip">${m}</span>`).join('')}</div>
    </div>
    <div class="hero-cta"></div>`;
  card.querySelector('.hero-cta').appendChild(cta);
  return card;
}

function primaryPick(label, handler) {
  const b = el('button', 'btn primary lg', label);
  b.onclick = handler;
  return b;
}

function sectionList(id) {
  const wrap = el('div', 'card');
  wrap.style.marginTop = '14px';
  wrap.innerHTML = `<div class="devlist" id="${id}"><p style="color:var(--muted-2);font-size:13px">No devices detected yet.</p></div>`;
  return wrap;
}

/* ------------------------------- progress ------------------------------- */

let unsubProgress = null;

function showProgress(label, indeterminate = true) {
  state.busy = true;
  $('#progressWrap').hidden = false;
  $('#progressLabel').textContent = label;
  $('#progressDetail').textContent = '';
  const bar = $('#progressBar');
  bar.classList.toggle('indeterminate', indeterminate);
  if (indeterminate) bar.style.width = '35%'; else bar.style.width = '0%';
}

function setProgress(pct, detail) {
  const bar = $('#progressBar');
  bar.classList.remove('indeterminate');
  bar.style.width = `${Math.min(100, Math.max(0, pct))}%`;
  if (detail != null) $('#progressDetail').textContent = detail;
}

function hideProgress() {
  state.busy = false;
  $('#progressWrap').hidden = true;
}

rescue.onProgress((p) => {
  if (p.phase === 'scan' && p.total > 0) {
    setProgress((p.bytes / p.total) * 100, `Scanned ${fmtSize(p.bytes)} of ${fmtSize(p.total)}`);
  } else if (p.phase === 'scan' && p.current) {
    $('#progressDetail').textContent = p.current;
  } else if (p.phase === 'scan' && p.count) {
    $('#progressDetail').textContent = `${p.count} files indexed…`;
  } else if (p.phase === 'describe' && p.total) {
    setProgress((p.index / p.total) * 100, `Analysing candidate ${p.index} / ${p.total}`);
  } else if (p.phase === 'recover' || p.phase === 'pull') {
    setProgress((p.index / p.total) * 100, `Recovering ${p.name || ''} (${p.index}/${p.total})`);
  }
});

$('#stopBtn').onclick = async () => {
  await rescue.stop();
  toast('Stopping…', 'The current task will halt shortly.', 'warn');
};

/* ------------------------------- tasks ---------------------------------- */

async function startCarve() {
  showProgress('Scanning raw bytes for recoverable files…', false);
  const res = await rescue.carveScan(state.ctx.source);
  hideProgress();
  if (!res.ok) { toast('Scan failed', res.error, 'err'); return; }
  state.files = res.files;
  toast('Deep scan complete', `${res.files.length} recoverable files found.`, 'ok');
  renderResults();
}

async function startTrash() {
  showProgress('Reading the trash…');
  const res = await rescue.trashList();
  hideProgress();
  if (!res.ok) { toast('Could not read trash', res.error, 'err'); return; }
  if (!res.supported) { toast('No trash found', 'No trash folder on this system.', 'warn'); }
  state.files = res.files;
  renderResults();
}

async function startFolder() {
  showProgress('Indexing folder…');
  const res = await rescue.folderScan({ root: state.ctx.root, kinds: null });
  hideProgress();
  if (!res.ok) { toast('Scan failed', res.error, 'err'); return; }
  state.files = res.files;
  toast('Folder indexed', `${res.count} files found in ${state.ctx.root}`, 'ok');
  renderResults();
}

let androidDetecting = false;
let lastWireless = '';

async function startAndroidDetect(opts = {}) {
  const { silent = false } = opts;
  const list = $('#androidDevices');
  if (!list) return; // user navigated away
  if (androidDetecting) return;
  androidDetecting = true;
  if (!silent) {
    list.innerHTML = '<p style="color:var(--muted)"><span class="spinner"></span> Looking for devices (USB + Wi-Fi)…</p>';
  }
  let res;
  try {
    res = await rescue.androidStatus();
  } finally {
    androidDetecting = false;
  }
  if (!$('#androidDevices')) return; // navigated away during the await
  if (!res.ok) { if (!silent) list.innerHTML = `<p class="chip bad">${res.error}</p>`; return; }
  if (res.recovered && !silent) toast('adb server restarted', 'Recovered a stuck adb server and re-scanned.', 'warn');
  // Announce newly auto-connected wireless phones (once per address set).
  if (res.wirelessConnected && res.wirelessConnected.length) {
    const key = res.wirelessConnected.slice().sort().join(',');
    if (key !== lastWireless) {
      lastWireless = key;
      toast('Wi-Fi device connected', `Auto-connected over the network: ${res.wirelessConnected.join(', ')}`, 'ok');
    }
  }
  if (!res.available) {
    list.innerHTML = `<div><p class="chip warn">ADB not installed</p>
      <p style="margin-top:10px;color:var(--muted);font-size:13px">${res.reason}</p>
      <p style="margin-top:6px;color:var(--muted-2);font-size:12px;font-family:ui-monospace">${res.install}</p></div>`;
    return;
  }
  if (!res.devices.length) {
    list.innerHTML = `<p class="chip warn">adb is ready — but no device is visible</p>
      <p style="margin-top:12px;color:var(--muted);font-size:13px">Work through this checklist, then press <strong>Detect device</strong> again:</p>
      <ol style="margin:10px 0 2px 18px;color:var(--muted);font-size:13px;line-height:1.9">
        <li>Connect the phone with a <strong>data</strong> USB cable (charge-only cables won’t work).</li>
        <li>On the phone: Settings → About phone → tap <strong>Build number</strong> 7× to unlock Developer options.</li>
        <li>Settings → System → <strong>Developer options → enable USB debugging</strong>.</li>
        <li>Set the USB mode to <strong>File Transfer / MTP</strong> (not “charge only”).</li>
        <li>When the phone shows <em>“Allow USB debugging?”</em>, tap <strong>Allow</strong> (tick “always”).</li>
      </ol>
      <p style="margin-top:8px;color:var(--muted-2);font-size:12px">A device stuck on <code>unauthorized</code> means step 5 wasn’t accepted yet.</p>`;
    return;
  }
  list.innerHTML = '';
  res.devices.forEach((d) => {
    const row = el('div', 'devrow');
    const ready = d.state === 'device';
    const hint = d.state === 'unauthorized'
      ? 'Tap “Allow USB debugging” on the phone'
      : d.state === 'offline' ? 'Reconnect the cable' : d.state;
    row.innerHTML = `<div class="dev-ic">📱</div>
      <div class="dev-main"><strong>${d.model}</strong><span>${d.serial} · ${ready ? 'ready' : hint}</span></div>
      <button class="btn ${ready ? 'primary' : ''} sm" ${ready ? '' : 'disabled'}>${ready ? 'Scan media' : d.state}</button>`;
    if (ready) row.querySelector('button').onclick = () => startAndroidScan(d.serial);
    list.appendChild(row);
  });
}

async function startAndroidScan(serial) {
  state.ctx.serial = serial;
  showProgress('Reading shared storage over ADB…');
  const res = await rescue.androidScan({ serial });
  hideProgress();
  if (!res.ok) { toast('Scan failed', res.error, 'err'); return; }
  state.files = res.files;
  toast('Device scanned', `${res.count} files found on the phone.`, 'ok');
  renderResults();
}

async function startIosDetect() {
  const list = $('#iosBackups');
  list.innerHTML = '<p style="color:var(--muted)"><span class="spinner"></span> Searching for backups…</p>';
  const res = await rescue.iosBackups();
  if (!res.ok) { list.innerHTML = `<p class="chip bad">${res.error}</p>`; return; }
  if (!res.supported || !res.backups.length) {
    list.innerHTML = `<p class="chip warn">No local backups found</p>
      <p style="margin-top:10px;color:var(--muted);font-size:13px">Back up this device in Finder/iTunes first (uncheck “Encrypt” for full access), then search again.</p>`;
    return;
  }
  list.innerHTML = '';
  res.backups.forEach((b) => {
    const row = el('div', 'devrow');
    const when = b.lastBackup ? new Date(b.lastBackup).toLocaleString() : 'date unknown';
    const enc = b.encrypted ? '<span class="chip bad" style="margin-left:8px">encrypted</span>' : '';
    row.innerHTML = `<div class="dev-ic">📱</div>
      <div class="dev-main"><strong>${b.deviceName} ${enc}</strong>
        <span>iOS ${b.iosVersion || '?'} · backed up ${when}</span></div>
      <button class="btn ${b.encrypted ? '' : 'primary'} sm">${b.encrypted ? 'Locked' : 'Extract'}</button>`;
    if (!b.encrypted) row.querySelector('button').onclick = () => startIosScan(b.udid);
    list.appendChild(row);
  });
}

async function startIosScan(udid) {
  state.ctx.udid = udid;
  showProgress('Parsing backup index…');
  const res = await rescue.iosScan({ udid, kinds: null });
  hideProgress();
  if (!res.ok) { toast('Could not read backup', res.error, 'err'); return; }
  state.files = res.files;
  toast('Backup parsed', `${res.count} items extracted from the index.`, 'ok');
  renderResults();
}

/* ------------------------------- results -------------------------------- */

function renderResults() {
  $('#results').hidden = false;
  const grid = $('#grid');
  const files = state.files;

  if (!files.length) {
    $('#emptyState').hidden = false;
    grid.innerHTML = '';
    $('#filters').innerHTML = '';
    $('#resultCount').textContent = '0 files';
    $('#recoverBtn').disabled = true;
    return;
  }
  $('#emptyState').hidden = true;

  // filters by kind
  const counts = {};
  files.forEach((f) => { counts[f.kind] = (counts[f.kind] || 0) + 1; });
  const kinds = Object.keys(counts).sort((a, b) => counts[b] - counts[a]);
  const filters = $('#filters');
  filters.innerHTML = '';
  const allBtn = el('button', `filter ${state.filter === 'all' ? 'active' : ''}`,
    `All <span class="fcount">${files.length}</span>`);
  allBtn.onclick = () => { state.filter = 'all'; renderResults(); };
  filters.appendChild(allBtn);
  kinds.forEach((k) => {
    const b = el('button', `filter ${state.filter === k ? 'active' : ''}`,
      `${KIND_ICON[k] || '📦'} ${k} <span class="fcount">${counts[k]}</span>`);
    b.onclick = () => { state.filter = k; renderResults(); };
    filters.appendChild(b);
  });

  const visible = state.filter === 'all' ? files : files.filter((f) => f.kind === state.filter);

  grid.innerHTML = '';
  visible.forEach((f) => grid.appendChild(fileCard(f)));

  updateCount();
  $('#selectAll').checked = visible.length > 0 && visible.every((f) => state.selected.has(f.id));
}

// Thumbnail plumbing -------------------------------------------------------
const PREVIEWABLE = new Set(['jpg', 'jpeg', 'png', 'gif', 'bmp']);
const thumbCache = new Map(); // id -> dataURL | null (null = tried, undecodable)

// Build the main-process request that yields this file's pixels, or null if
// this source/type can't be previewed (e.g. Android remote files, HEIC/RAW).
function thumbReqFor(f) {
  if (!PREVIEWABLE.has((f.ext || '').toLowerCase())) return null;
  if (state.source === 'folder' || state.source === 'trash') return { path: f.path };
  if (state.source === 'ios') return { path: f.diskPath };
  if (state.source === 'carve') {
    return { source: state.ctx.source, offset: f.offset, length: f.length };
  }
  return null; // android: file is on the device, not locally readable
}

function paintThumb(thumbEl, url) {
  thumbEl.style.backgroundImage = `url("${url}")`;
  thumbEl.classList.add('has-img');
  thumbEl.textContent = '';
}

const thumbObserver = ('IntersectionObserver' in window)
  ? new IntersectionObserver((entries, obs) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        const thumbEl = e.target;
        obs.unobserve(thumbEl);
        loadThumb(thumbEl);
      }
    }, { rootMargin: '300px' })
  : null;

async function loadThumb(thumbEl) {
  const id = thumbEl.dataset.id;
  if (thumbCache.has(id)) {
    const cached = thumbCache.get(id);
    if (cached) paintThumb(thumbEl, cached);
    return;
  }
  const f = state.files.find((x) => String(x.id) === id);
  if (!f) return;
  const req = thumbReqFor(f);
  if (!req) { thumbCache.set(id, null); return; }
  const url = await rescue.thumb(req).catch(() => null);
  thumbCache.set(id, url || null);
  if (url && thumbEl.isConnected) paintThumb(thumbEl, url);
}

function fileCard(f) {
  const card = el('div', `fcard k-${f.kind} ${state.selected.has(f.id) ? 'selected' : ''}`);
  const sub = f.modified || f.deletedAt
    ? new Date(f.modified || f.deletedAt).toLocaleDateString()
    : (f.type || f.ext || '');
  const canPreview = !!thumbReqFor(f);
  card.innerHTML = `
    <div class="check">✓</div>
    <div class="thumb" data-id="${f.id}">${KIND_ICON[f.kind] || '📦'}</div>
    <div class="meta">
      <div class="fname" title="${f.name}">${f.name}</div>
      <div class="fsub"><span>${fmtSize(f.size != null ? f.size : f.length)}</span><span>${sub}</span></div>
    </div>`;
  if (canPreview) {
    const thumbEl = card.querySelector('.thumb');
    if (thumbObserver) thumbObserver.observe(thumbEl);
    else loadThumb(thumbEl); // no IO support: load immediately
  }
  card.onclick = () => {
    if (state.selected.has(f.id)) state.selected.delete(f.id);
    else state.selected.add(f.id);
    card.classList.toggle('selected');
    updateCount();
  };
  return card;
}

function updateCount() {
  const n = state.selected.size;
  $('#resultCount').textContent = `${n} selected · ${state.files.length} files`;
  $('#recoverBtn').disabled = n === 0;
}

$('#selectAll').onchange = (e) => {
  const visible = state.filter === 'all'
    ? state.files : state.files.filter((f) => f.kind === state.filter);
  if (e.target.checked) visible.forEach((f) => state.selected.add(f.id));
  else visible.forEach((f) => state.selected.delete(f.id));
  renderResults();
};

/* ------------------------------- recover -------------------------------- */

$('#recoverBtn').onclick = async () => {
  const chosen = state.files.filter((f) => state.selected.has(f.id));
  if (!chosen.length) return;
  showProgress(`Recovering ${chosen.length} file(s)…`, false);
  let res;
  try {
    if (state.source === 'carve') {
      res = await rescue.carveRecover({ source: state.ctx.source, files: chosen });
    } else if (state.source === 'trash') {
      res = await rescue.trashRestore({ files: chosen });
    } else if (state.source === 'folder') {
      res = await rescue.folderCopy({ files: chosen });
    } else if (state.source === 'android') {
      res = await rescue.androidPull({ serial: state.ctx.serial, files: chosen });
    } else if (state.source === 'ios') {
      res = await rescue.iosExtract({ udid: state.ctx.udid, files: chosen });
    }
  } catch (err) {
    hideProgress(); toast('Recovery error', String(err), 'err'); return;
  }
  hideProgress();
  if (!res || !res.ok) { toast('Recovery failed', res ? res.error : 'Unknown error', 'err'); return; }
  const ok = res.results.filter((r) => r.ok).length;
  toast('Recovery complete', `${ok}/${res.results.length} files saved. Click to open the folder.`, 'ok', 7000);
  const last = $('#toasts').lastChild;
  if (last) { last.style.cursor = 'pointer'; last.onclick = () => rescue.openPath(res.outputDir); }
};

/* -------------------------------- boot ---------------------------------- */
selectSource('carve');
