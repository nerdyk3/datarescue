'use strict';

/* ======================================================================== *
 *  DataRescue — renderer (plain JS). Drives the UI and talks to the engine
 *  through window.api (see preload.js).
 * ======================================================================== */

const api = window.api;

const KIND_ICON = {
  image: '🖼️', video: '🎬', audio: '🎵', document: '📄',
  archive: '🗜️', database: '🗃️', messages: '💬', contacts: '👤',
  calls: '📞', other: '📦',
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

function selectSource(src) {
  if (state.busy) { toast('Scan in progress', 'Stop the current task first.', 'warn'); return; }
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
        const p = await api.pickSource();
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
        const p = await api.pickFolder();
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
    setup.appendChild(sectionList('androidDevices'));
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

api.onProgress((p) => {
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
  await api.stop();
  toast('Stopping…', 'The current task will halt shortly.', 'warn');
};

/* ------------------------------- tasks ---------------------------------- */

async function startCarve() {
  showProgress('Scanning raw bytes for recoverable files…', false);
  const res = await api.carveScan(state.ctx.source);
  hideProgress();
  if (!res.ok) { toast('Scan failed', res.error, 'err'); return; }
  state.files = res.files;
  toast('Deep scan complete', `${res.files.length} recoverable files found.`, 'ok');
  renderResults();
}

async function startTrash() {
  showProgress('Reading the trash…');
  const res = await api.trashList();
  hideProgress();
  if (!res.ok) { toast('Could not read trash', res.error, 'err'); return; }
  if (!res.supported) { toast('No trash found', 'No trash folder on this system.', 'warn'); }
  state.files = res.files;
  renderResults();
}

async function startFolder() {
  showProgress('Indexing folder…');
  const res = await api.folderScan({ root: state.ctx.root, kinds: null });
  hideProgress();
  if (!res.ok) { toast('Scan failed', res.error, 'err'); return; }
  state.files = res.files;
  toast('Folder indexed', `${res.count} files found in ${state.ctx.root}`, 'ok');
  renderResults();
}

async function startAndroidDetect() {
  const list = $('#androidDevices');
  list.innerHTML = '<p style="color:var(--muted)"><span class="spinner"></span> Looking for devices…</p>';
  const res = await api.androidStatus();
  if (!res.ok) { list.innerHTML = `<p class="chip bad">${res.error}</p>`; return; }
  if (!res.available) {
    list.innerHTML = `<div><p class="chip warn">ADB not installed</p>
      <p style="margin-top:10px;color:var(--muted);font-size:13px">${res.reason}</p>
      <p style="margin-top:6px;color:var(--muted-2);font-size:12px;font-family:ui-monospace">${res.install}</p></div>`;
    return;
  }
  if (!res.devices.length) {
    list.innerHTML = `<p class="chip warn">No device connected</p>
      <p style="margin-top:10px;color:var(--muted);font-size:13px">Connect your phone by USB, then tap “Allow USB debugging” on it and detect again.</p>`;
    return;
  }
  list.innerHTML = '';
  res.devices.forEach((d) => {
    const row = el('div', 'devrow');
    const ready = d.state === 'device';
    row.innerHTML = `<div class="dev-ic">📱</div>
      <div class="dev-main"><strong>${d.model}</strong><span>${d.serial} · ${d.state}</span></div>
      <button class="btn ${ready ? 'primary' : ''} sm">${ready ? 'Scan media' : d.state}</button>`;
    if (ready) row.querySelector('button').onclick = () => startAndroidScan(d.serial);
    list.appendChild(row);
  });
}

async function startAndroidScan(serial) {
  state.ctx.serial = serial;
  showProgress('Reading shared storage over ADB…');
  const res = await api.androidScan({ serial });
  hideProgress();
  if (!res.ok) { toast('Scan failed', res.error, 'err'); return; }
  state.files = res.files;
  toast('Device scanned', `${res.count} files found on the phone.`, 'ok');
  renderResults();
}

async function startIosDetect() {
  const list = $('#iosBackups');
  list.innerHTML = '<p style="color:var(--muted)"><span class="spinner"></span> Searching for backups…</p>';
  const res = await api.iosBackups();
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
  const res = await api.iosScan({ udid, kinds: null });
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

function fileCard(f) {
  const card = el('div', `fcard k-${f.kind} ${state.selected.has(f.id) ? 'selected' : ''}`);
  const sub = f.modified || f.deletedAt
    ? new Date(f.modified || f.deletedAt).toLocaleDateString()
    : (f.type || f.ext || '');
  card.innerHTML = `
    <div class="check">✓</div>
    <div class="thumb">${KIND_ICON[f.kind] || '📦'}</div>
    <div class="meta">
      <div class="fname" title="${f.name}">${f.name}</div>
      <div class="fsub"><span>${fmtSize(f.size != null ? f.size : f.length)}</span><span>${sub}</span></div>
    </div>`;
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
      res = await api.carveRecover({ source: state.ctx.source, files: chosen });
    } else if (state.source === 'trash') {
      res = await api.trashRestore({ files: chosen });
    } else if (state.source === 'folder') {
      res = await api.folderCopy({ files: chosen });
    } else if (state.source === 'android') {
      res = await api.androidPull({ serial: state.ctx.serial, files: chosen });
    } else if (state.source === 'ios') {
      res = await api.iosExtract({ udid: state.ctx.udid, files: chosen });
    }
  } catch (err) {
    hideProgress(); toast('Recovery error', String(err), 'err'); return;
  }
  hideProgress();
  if (!res || !res.ok) { toast('Recovery failed', res ? res.error : 'Unknown error', 'err'); return; }
  const ok = res.results.filter((r) => r.ok).length;
  toast('Recovery complete', `${ok}/${res.results.length} files saved. Click to open the folder.`, 'ok', 7000);
  const last = $('#toasts').lastChild;
  if (last) { last.style.cursor = 'pointer'; last.onclick = () => api.openPath(res.outputDir); }
};

/* -------------------------------- boot ---------------------------------- */
selectSource('carve');
