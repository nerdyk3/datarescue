'use strict';

/**
 * Signature-based file carving engine.
 *
 * This is the real heart of DataRescue. Given any readable byte source — a raw
 * disk image, a `.dd` dump, an unmounted device (with permission), or even a
 * large damaged file — it scans for known file headers and reconstructs the
 * files, independent of the filesystem. This is the same technique PhotoRec and
 * Recuva use to recover "deleted" data that still physically exists on disk.
 */

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const { SIGNATURES, MAX_HEADER_SPAN } = require('./signatures');

const CHUNK = 4 * 1024 * 1024; // 4 MiB read window

function matchAt(buf, pos, sig) {
  const at = pos + (sig.headerAt || 0);
  if (at + sig.header.length > buf.length) return false;
  for (let i = 0; i < sig.header.length; i++) {
    if (buf[at + i] !== sig.header[i]) return false;
  }
  return true;
}

async function sourceSize(fd, fallbackPath) {
  const st = await fd.stat();
  if (st.size && st.size > 0) return st.size;
  // Character/block devices report size 0 via fstat; try to seek to the end.
  try {
    const st2 = await fsp.stat(fallbackPath);
    if (st2.size > 0) return st2.size;
  } catch (_) {}
  return 0; // unknown — we'll scan until EOF
}

/**
 * Phase 1 — locate every candidate file header on the source.
 * Returns [{ offset, sig }] sorted by offset.
 */
async function scanHeaders(source, { onProgress, shouldStop } = {}) {
  const fd = await fsp.open(source, 'r');
  const size = await sourceSize(fd, source);
  const found = [];
  const overlap = Math.max(1, MAX_HEADER_SPAN - 1);

  let position = 0;
  let carry = Buffer.alloc(0);

  try {
    while (true) {
      if (shouldStop && shouldStop()) break;
      const buf = Buffer.alloc(CHUNK);
      const { bytesRead } = await fd.read(buf, 0, CHUNK, position);
      if (bytesRead === 0) break;

      const chunk = buf.subarray(0, bytesRead);
      const windowBase = position - carry.length;
      const search = carry.length ? Buffer.concat([carry, chunk]) : chunk;

      // Only scan up to the point where a full header could still fit,
      // except on the final chunk.
      const isLast = bytesRead < CHUNK;
      const limit = isLast ? search.length : search.length - overlap;

      for (let i = 0; i < limit; i++) {
        for (const sig of SIGNATURES) {
          if (matchAt(search, i, sig)) {
            found.push({ offset: windowBase + i, sig });
            break; // first matching signature wins at this byte
          }
        }
      }

      position += bytesRead;
      carry = isLast ? Buffer.alloc(0) : search.subarray(search.length - overlap);

      if (onProgress && size > 0) {
        onProgress({ phase: 'scan', bytes: position, total: size });
      } else if (onProgress) {
        onProgress({ phase: 'scan', bytes: position, total: 0 });
      }
      if (isLast) break;
    }
  } finally {
    await fd.close();
  }

  found.sort((a, b) => a.offset - b.offset);
  return { candidates: found, size };
}

function indexOfFrom(haystack, needle, start) {
  const idx = haystack.indexOf(needle, start);
  return idx;
}

/**
 * Determine the byte length of a single carved file starting at `offset`.
 * Uses the footer when the signature has one, otherwise caps at the next
 * candidate header or the signature's maxSize — whichever is smaller.
 */
async function measureFile(fd, offset, sig, nextOffset, sourceEnd) {
  const hardCap = Math.min(
    sig.maxSize,
    (sourceEnd && sourceEnd > offset ? sourceEnd - offset : sig.maxSize)
  );

  if (!sig.footer) {
    let len = hardCap;
    if (nextOffset && nextOffset > offset) {
      len = Math.min(len, nextOffset - offset);
    }
    return len;
  }

  // Search forward for the footer, reading in windows with overlap.
  const foot = sig.footer;
  const tail = sig.footerTail || 0;
  const overlap = foot.length - 1;
  let position = offset;
  let carry = Buffer.alloc(0);
  let scanned = 0;

  while (scanned < hardCap) {
    const want = Math.min(CHUNK, hardCap - scanned);
    const buf = Buffer.alloc(want);
    const { bytesRead } = await fd.read(buf, 0, want, position);
    if (bytesRead === 0) break;

    const chunk = buf.subarray(0, bytesRead);
    const search = carry.length ? Buffer.concat([carry, chunk]) : chunk;
    const base = position - carry.length;

    const idx = indexOfFrom(search, foot, 0);
    if (idx !== -1) {
      const end = base + idx + foot.length + tail;
      return end - offset;
    }

    position += bytesRead;
    scanned += bytesRead;
    carry = search.subarray(Math.max(0, search.length - overlap));
    if (bytesRead < want) break;
  }

  // Footer never found — fall back to a bounded chunk so we still return data.
  let len = Math.min(hardCap, 2 * 1024 * 1024);
  if (nextOffset && nextOffset > offset) len = Math.min(len, nextOffset - offset);
  return len;
}

/**
 * Phase 2 — turn candidates into a described list (type, size, preview hash)
 * without writing anything to disk yet. This is what the UI shows before the
 * user picks what to recover.
 */
async function describe(source, candidates, size, { onProgress, shouldStop } = {}) {
  const fd = await fsp.open(source, 'r');
  const out = [];
  try {
    for (let i = 0; i < candidates.length; i++) {
      if (shouldStop && shouldStop()) break;
      const c = candidates[i];
      const next = candidates[i + 1] ? candidates[i + 1].offset : null;
      const len = await measureFile(fd, c.offset, c.sig, next, size).catch(() => 0);
      out.push({
        id: crypto.randomUUID(),
        offset: c.offset,
        length: len,
        name: `${c.sig.kind}_${String(i + 1).padStart(5, '0')}.${c.sig.ext}`,
        ext: c.sig.ext,
        kind: c.sig.kind,
        type: c.sig.name,
      });
      if (onProgress) {
        onProgress({ phase: 'describe', index: i + 1, total: candidates.length });
      }
    }
  } finally {
    await fd.close();
  }
  return out.filter((f) => f.length > 0);
}

/**
 * Phase 3 — write selected carved files to the output directory.
 */
async function recover(source, files, outputDir, { onProgress, shouldStop } = {}) {
  await fsp.mkdir(outputDir, { recursive: true });
  const fd = await fsp.open(source, 'r');
  const results = [];
  try {
    for (let i = 0; i < files.length; i++) {
      if (shouldStop && shouldStop()) break;
      const f = files[i];
      const dest = path.join(outputDir, f.name);
      const ws = fs.createWriteStream(dest);
      let remaining = f.length;
      let position = f.offset;
      try {
        while (remaining > 0) {
          const want = Math.min(CHUNK, remaining);
          const buf = Buffer.alloc(want);
          const { bytesRead } = await fd.read(buf, 0, want, position);
          if (bytesRead === 0) break;
          ws.write(buf.subarray(0, bytesRead));
          position += bytesRead;
          remaining -= bytesRead;
        }
        await new Promise((res, rej) => ws.end((e) => (e ? rej(e) : res())));
        results.push({ ...f, path: dest, ok: true });
      } catch (err) {
        results.push({ ...f, path: dest, ok: false, error: String(err) });
      }
      if (onProgress) {
        onProgress({ phase: 'recover', index: i + 1, total: files.length, name: f.name });
      }
    }
  } finally {
    await fd.close();
  }
  return results;
}

module.exports = { scanHeaders, describe, recover, measureFile };
