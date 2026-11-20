'use strict';

/**
 * File signature database used by the carving engine.
 *
 * Each signature describes how to recognise the start (and optionally the end)
 * of a file on a raw device / disk image when the filesystem metadata is gone.
 *
 *   header      Buffer / array of bytes that must appear at the start of the file.
 *   headerAt    Offset within the candidate where `header` is expected (default 0).
 *   footer      Optional Buffer that marks the end of the file (inclusive).
 *   footerTail  Extra bytes to keep after the footer match (e.g. PDF %%EOF\r\n).
 *   maxSize     Hard cap on carved length when there is no footer, or a safety
 *               cap when the footer is never found.
 *   ext         File extension given to recovered files.
 *   kind        Human category used for grouping / filtering in the UI.
 *
 * Optional "deep search" hooks — these are what let the carver fetch the WHOLE
 * file instead of a truncated guess:
 *
 *   measure(reader, offset, ctx) -> Promise<number|null>
 *               Return the exact byte length of the file by reading its own
 *               internal size fields / structure. Return null to fall back to
 *               the footer / maxSize heuristic. `reader(pos, len)` resolves to a
 *               Buffer (possibly short at EOF). `ctx` = { nextOffset, sourceEnd, sig }.
 *               A measured length is authoritative: the carver trusts it even
 *               past the next candidate header (false headers often sit *inside*
 *               a video or archive), clamped only to the end of the source.
 *
 *   classify(reader, offset) -> Promise<{ext,kind,name}|null>
 *               Refine a generic container signature into the real subtype by
 *               peeking a few bytes (RIFF -> wav/avi/webp, ftyp -> mp4/mov/heic…).
 */

const hex = (s) => Buffer.from(s.replace(/\s+/g, ''), 'hex');
const ascii = (s) => Buffer.from(s, 'latin1');

/* ------------------------------------------------------------------ *
 *  Length resolvers — read a file's own size metadata so we recover
 *  every byte and nothing from the next file.
 * ------------------------------------------------------------------ */

// RIFF containers (WAV / AVI / WebP): bytes 4..8 hold the little-endian size
// of everything after the 8-byte RIFF header.
async function riffMeasure(reader, offset) {
  const b = await reader(offset, 12);
  if (b.length < 8 || b.toString('latin1', 0, 4) !== 'RIFF') return null;
  const size = b.readUInt32LE(4);
  if (size <= 0) return null;
  return 8 + size;
}
async function riffClassify(reader, offset) {
  const b = await reader(offset, 12);
  if (b.length < 12) return null;
  const form = b.toString('latin1', 8, 12);
  if (form === 'WAVE') return { ext: 'wav', kind: 'audio', name: 'WAV audio' };
  if (form === 'AVI ') return { ext: 'avi', kind: 'video', name: 'AVI video' };
  if (form === 'WEBP') return { ext: 'webp', kind: 'image', name: 'WebP image' };
  return { ext: 'riff', kind: 'other', name: 'RIFF container' };
}

// IFF / AIFF containers (FORM....AIFF / AIFC): big-endian size at bytes 4..8.
async function iffMeasure(reader, offset) {
  const b = await reader(offset, 12);
  if (b.length < 8 || b.toString('latin1', 0, 4) !== 'FORM') return null;
  const size = b.readUInt32BE(4);
  if (size <= 0) return null;
  return 8 + size;
}
async function iffClassify(reader, offset) {
  const b = await reader(offset, 12);
  if (b.length < 12) return null;
  const form = b.toString('latin1', 8, 12);
  if (form === 'AIFF' || form === 'AIFC') return { ext: 'aiff', kind: 'audio', name: 'AIFF audio' };
  return null;
}

// BMP: little-endian file size at bytes 2..6.
async function bmpMeasure(reader, offset) {
  const b = await reader(offset, 6);
  if (b.length < 6) return null;
  const size = b.readUInt32LE(2);
  // Some writers leave this zero; fall back to the heuristic in that case.
  if (size <= 54) return null;
  return size;
}

// ISO Base Media (MP4 / MOV / M4A / M4V / 3GP / HEIC / AVIF): walk the top-level
// box chain (ftyp, moov, mdat, free, meta…) summing box sizes until we hit a
// box whose 4-char type isn't printable ASCII — i.e. the end of the file.
const ISOBMFF_TOP = new Set([
  'ftyp', 'moov', 'mdat', 'free', 'skip', 'wide', 'uuid', 'meta', 'mfra',
  'moof', 'pdin', 'sidx', 'ssix', 'styp', 'prft', 'emsg', 'pnot',
]);
async function isobmffMeasure(reader, offset, { sourceEnd, sig }) {
  const limit = sourceEnd && sourceEnd > offset ? sourceEnd : offset + sig.maxSize;
  let pos = offset;
  let sawFtyp = false;
  let guard = 0;
  while (pos + 8 <= limit && guard++ < 100000) {
    const hdr = await reader(pos, 16);
    if (hdr.length < 8) break;
    const type = hdr.toString('latin1', 4, 8);
    if (!/^[\x20-\x7e]{4}$/.test(type)) break; // not a box -> end of file
    if (pos === offset) {
      if (type !== 'ftyp') return null; // must open with ftyp
      sawFtyp = true;
    }
    // Only trust recognised top-level box types; an unknown-but-ascii type is
    // almost certainly data from the next file, so stop cleanly before it.
    if (!ISOBMFF_TOP.has(type)) break;
    let size = hdr.readUInt32BE(0);
    let headerLen = 8;
    if (size === 1) {
      if (hdr.length < 16) break;
      const hi = hdr.readUInt32BE(8);
      const lo = hdr.readUInt32BE(12);
      size = hi * 2 ** 32 + lo;
      headerLen = 16;
    } else if (size === 0) {
      // Box runs to EOF.
      return sourceEnd && sourceEnd > offset ? sourceEnd - offset : null;
    }
    if (size < headerLen) break;
    pos += size;
  }
  const total = pos - offset;
  return sawFtyp && total > 0 ? total : null;
}
async function ftypClassify(reader, offset) {
  const b = await reader(offset, 12);
  if (b.length < 12) return null;
  const brand = b.toString('latin1', 8, 12).replace(/\s+$/, '').toLowerCase();
  const map = {
    heic: { ext: 'heic', kind: 'image', name: 'HEIC image' },
    heix: { ext: 'heic', kind: 'image', name: 'HEIC image' },
    heif: { ext: 'heic', kind: 'image', name: 'HEIF image' },
    mif1: { ext: 'heic', kind: 'image', name: 'HEIF image' },
    msf1: { ext: 'heic', kind: 'image', name: 'HEIF sequence' },
    avif: { ext: 'avif', kind: 'image', name: 'AVIF image' },
    avis: { ext: 'avif', kind: 'image', name: 'AVIF sequence' },
    'm4a': { ext: 'm4a', kind: 'audio', name: 'M4A audio' },
    'm4b': { ext: 'm4b', kind: 'audio', name: 'M4B audiobook' },
    'm4v': { ext: 'm4v', kind: 'video', name: 'M4V video' },
    qt: { ext: 'mov', kind: 'video', name: 'QuickTime video' },
    '3gp': { ext: '3gp', kind: 'video', name: '3GP video' },
    '3g2': { ext: '3g2', kind: 'video', name: '3G2 video' },
    crx: { ext: 'cr3', kind: 'image', name: 'Canon CR3 raw' },
  };
  if (map[brand]) return map[brand];
  if (brand.startsWith('3g')) return { ext: '3gp', kind: 'video', name: '3GP video' };
  // isom / mp41 / mp42 / dash / iso2 / avc1 … -> generic MP4 video.
  return { ext: 'mp4', kind: 'video', name: 'MP4 video' };
}

// JPEG: walk the marker segments (skipping the EXIF/APP1 thumbnail, which is a
// self-contained JPEG whose stray FFD9 would otherwise truncate the real photo),
// then scan the entropy-coded scan data for the terminating FFD9 (EOI).
async function jpegMeasure(reader, offset, { sourceEnd, sig }) {
  const limit = sourceEnd && sourceEnd > offset ? sourceEnd : offset + sig.maxSize;
  let pos = offset + 2; // past SOI (FFD8)
  let guard = 0;
  while (pos + 2 <= limit && guard++ < 100000) {
    const m = await reader(pos, 4);
    if (m.length < 2 || m[0] !== 0xff) return null; // desync -> give up to heuristic
    const marker = m[1];
    if (marker === 0xd9) return pos + 2 - offset; // EOI
    // Markers with no length payload.
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { pos += 2; continue; }
    if (m.length < 4) return null;
    const segLen = m.readUInt16BE(2);
    if (segLen < 2) return null;
    if (marker === 0xda) {
      // Start of Scan: entropy data follows until the next real marker.
      return await jpegScanToEOI(reader, pos + 2 + segLen, limit, offset);
    }
    pos += 2 + segLen;
  }
  return null;
}
async function jpegScanToEOI(reader, start, limit, offset) {
  const WIN = 1 << 20; // 1 MiB
  let pos = start;
  let prevFF = false;
  while (pos < limit) {
    const want = Math.min(WIN, limit - pos);
    const buf = await reader(pos, want);
    if (buf.length === 0) break;
    for (let i = 0; i < buf.length; i++) {
      const byte = buf[i];
      if (prevFF) {
        // FF00 (stuffed) and FFD0-D7 (restart) are part of the scan data.
        if (byte === 0xd9) return pos + i + 1 - offset; // EOI
        prevFF = byte === 0xff; // allow runs of FF
      } else {
        prevFF = byte === 0xff;
      }
    }
    pos += buf.length;
    if (buf.length < want) break;
  }
  return null;
}

// PDF: pick the LAST %%EOF (incrementally-updated PDFs have several); the first
// one would hand back a stale, partial document.
async function pdfMeasure(reader, offset, { nextOffset, sourceEnd, sig }) {
  let hardEnd = offset + sig.maxSize;
  if (sourceEnd && sourceEnd > offset) hardEnd = Math.min(hardEnd, sourceEnd);
  if (nextOffset && nextOffset > offset) hardEnd = Math.min(hardEnd, nextOffset);
  const WIN = 1 << 20;
  const needle = ascii('%%EOF');
  let pos = offset;
  let carry = Buffer.alloc(0);
  let last = -1;
  while (pos < hardEnd) {
    const want = Math.min(WIN, hardEnd - pos);
    const chunk = await reader(pos, want);
    if (chunk.length === 0) break;
    const search = carry.length ? Buffer.concat([carry, chunk]) : chunk;
    const base = pos - carry.length;
    let from = 0;
    for (;;) {
      const idx = search.indexOf(needle, from);
      if (idx === -1) break;
      last = base + idx + needle.length;
      from = idx + 1;
    }
    pos += chunk.length;
    carry = search.subarray(Math.max(0, search.length - (needle.length - 1)));
    if (chunk.length < want) break;
  }
  if (last === -1) return null;
  // Keep a trailing EOL after %%EOF if present.
  const tail = await reader(last, 2);
  let extra = 0;
  if (tail[0] === 0x0d) extra = tail[1] === 0x0a ? 2 : 1;
  else if (tail[0] === 0x0a) extra = 1;
  return last + extra - offset;
}

// ZIP (incl. docx/xlsx/pptx/jar/apk/epub): find the LAST End Of Central Directory
// record and honour its trailing-comment length so the whole archive comes out.
async function zipMeasure(reader, offset, { nextOffset, sourceEnd, sig }) {
  let hardEnd = offset + sig.maxSize;
  if (sourceEnd && sourceEnd > offset) hardEnd = Math.min(hardEnd, sourceEnd);
  if (nextOffset && nextOffset > offset) hardEnd = Math.min(hardEnd, nextOffset);
  const WIN = 1 << 20;
  const eocd = hex('504B0506');
  let pos = offset;
  let carry = Buffer.alloc(0);
  let best = -1;
  while (pos < hardEnd) {
    const want = Math.min(WIN, hardEnd - pos);
    const chunk = await reader(pos, want);
    if (chunk.length === 0) break;
    const search = carry.length ? Buffer.concat([carry, chunk]) : chunk;
    const base = pos - carry.length;
    let from = 0;
    for (;;) {
      const idx = search.indexOf(eocd, from);
      if (idx === -1) break;
      best = base + idx;
      from = idx + 1;
    }
    pos += chunk.length;
    carry = search.subarray(Math.max(0, search.length - (eocd.length - 1)));
    if (chunk.length < want) break;
  }
  if (best === -1) return null;
  const rec = await reader(best, 22);
  if (rec.length < 22) return best + rec.length - offset;
  const commentLen = rec.readUInt16LE(20);
  return best + 22 + commentLen - offset;
}

// TIFF-based raws: distinguish Canon CR2 from plain TIFF/NEF by the "CR" marker.
async function tiffClassify(reader, offset) {
  const b = await reader(offset, 12);
  if (b.length >= 10 && b.toString('latin1', 8, 10) === 'CR') {
    return { ext: 'cr2', kind: 'image', name: 'Canon CR2 raw' };
  }
  return { ext: 'tiff', kind: 'image', name: 'TIFF / RAW image' };
}

/* ------------------------------------------------------------------ *
 *  Signature table
 * ------------------------------------------------------------------ */

const SIGNATURES = [
  // ---- Images ----
  {
    name: 'JPEG image', ext: 'jpg', kind: 'image',
    header: hex('FFD8FF'), footer: hex('FFD9'),
    maxSize: 60 * 1024 * 1024, measure: jpegMeasure,
  },
  {
    name: 'PNG image', ext: 'png', kind: 'image',
    header: hex('89504E470D0A1A0A'), footer: hex('49454E44AE426082'),
    maxSize: 100 * 1024 * 1024,
  },
  {
    name: 'GIF image', ext: 'gif', kind: 'image',
    header: hex('474946383961'), footer: hex('003B'), maxSize: 40 * 1024 * 1024,
  },
  {
    name: 'GIF image', ext: 'gif', kind: 'image',
    header: hex('474946383761'), footer: hex('003B'), maxSize: 40 * 1024 * 1024,
  },
  {
    name: 'BMP image', ext: 'bmp', kind: 'image',
    header: hex('424D'), maxSize: 40 * 1024 * 1024, measure: bmpMeasure,
  },
  {
    name: 'TIFF / RAW image (LE)', ext: 'tiff', kind: 'image',
    header: hex('49492A00'), maxSize: 200 * 1024 * 1024, classify: tiffClassify,
  },
  {
    name: 'TIFF / RAW image (BE)', ext: 'tiff', kind: 'image',
    header: hex('4D4D002A'), maxSize: 200 * 1024 * 1024,
  },
  {
    name: 'Canon CR3 / ISO raw', ext: 'cr3', kind: 'image',
    header: ascii('ftyp'), headerAt: 4,
    maxSize: 200 * 1024 * 1024, measure: isobmffMeasure, classify: ftypClassify,
  },
  {
    name: 'Photoshop PSD', ext: 'psd', kind: 'image',
    header: hex('38425053'), maxSize: 500 * 1024 * 1024,
  },
  {
    name: 'HEIC / MP4 / MOV (ISO-BMFF)', ext: 'mp4', kind: 'video',
    header: ascii('ftyp'), headerAt: 4,
    maxSize: 4 * 1024 * 1024 * 1024, measure: isobmffMeasure, classify: ftypClassify,
  },

  // ---- Documents ----
  {
    name: 'PDF document', ext: 'pdf', kind: 'document',
    header: hex('255044462D'), footer: hex('2525454F46'), footerTail: 2,
    maxSize: 200 * 1024 * 1024, measure: pdfMeasure,
  },
  {
    name: 'Legacy Office (doc/xls/ppt)', ext: 'ole', kind: 'document',
    header: hex('D0CF11E0A1B11AE1'), maxSize: 300 * 1024 * 1024,
  },
  {
    name: 'RTF document', ext: 'rtf', kind: 'document',
    header: ascii('{\\rtf'), maxSize: 50 * 1024 * 1024,
  },

  // ---- Archives / Office (OOXML) ----
  {
    name: 'ZIP / Office (docx, xlsx, pptx)', ext: 'zip', kind: 'archive',
    header: hex('504B0304'), footer: hex('504B0506'), footerTail: 18,
    maxSize: 1024 * 1024 * 1024, measure: zipMeasure,
  },
  {
    name: 'RAR archive', ext: 'rar', kind: 'archive',
    header: hex('526172211A0700'), maxSize: 1024 * 1024 * 1024,
  },
  {
    name: 'RAR5 archive', ext: 'rar', kind: 'archive',
    header: hex('526172211A070100'), maxSize: 2 * 1024 * 1024 * 1024,
  },
  {
    name: '7-Zip archive', ext: '7z', kind: 'archive',
    header: hex('377ABCAF271C'), maxSize: 2 * 1024 * 1024 * 1024,
  },
  {
    name: 'GZIP archive', ext: 'gz', kind: 'archive',
    header: hex('1F8B08'), maxSize: 1024 * 1024 * 1024,
  },
  {
    name: 'BZIP2 archive', ext: 'bz2', kind: 'archive',
    header: hex('425A68'), maxSize: 1024 * 1024 * 1024,
  },
  {
    name: 'XZ archive', ext: 'xz', kind: 'archive',
    header: hex('FD377A585A00'), maxSize: 1024 * 1024 * 1024,
  },
  {
    name: 'TAR archive', ext: 'tar', kind: 'archive',
    header: ascii('ustar'), headerAt: 257, maxSize: 2 * 1024 * 1024 * 1024,
  },

  // ---- Audio ----
  {
    name: 'MP3 audio (ID3)', ext: 'mp3', kind: 'audio',
    header: hex('494433'), maxSize: 100 * 1024 * 1024,
  },
  {
    name: 'FLAC audio', ext: 'flac', kind: 'audio',
    header: hex('664C6143'), maxSize: 500 * 1024 * 1024,
  },
  {
    name: 'OGG audio/video', ext: 'ogg', kind: 'audio',
    header: hex('4F676753'), maxSize: 500 * 1024 * 1024,
  },
  {
    name: 'RIFF container (WAV / AVI / WebP)', ext: 'wav', kind: 'audio',
    header: hex('52494646'), maxSize: 2 * 1024 * 1024 * 1024,
    measure: riffMeasure, classify: riffClassify,
  },
  {
    name: 'IFF container (AIFF)', ext: 'aiff', kind: 'audio',
    header: hex('464F524D'), maxSize: 500 * 1024 * 1024,
    measure: iffMeasure, classify: iffClassify,
  },

  // ---- Video ----
  {
    name: 'Matroska / WebM video', ext: 'mkv', kind: 'video',
    header: hex('1A45DFA3'), maxSize: 8 * 1024 * 1024 * 1024,
  },
  {
    name: 'FLV video', ext: 'flv', kind: 'video',
    header: hex('464C5601'), maxSize: 2 * 1024 * 1024 * 1024,
  },
  {
    name: 'MPEG program stream', ext: 'mpg', kind: 'video',
    header: hex('000001BA'), maxSize: 2 * 1024 * 1024 * 1024,
  },

  // ---- Databases ----
  {
    name: 'SQLite database', ext: 'sqlite', kind: 'database',
    header: hex('53514C69746520666F726D6174203300'), maxSize: 1024 * 1024 * 1024,
  },

  // ---- Executables / other ----
  {
    name: 'Windows executable (PE)', ext: 'exe', kind: 'other',
    header: hex('4D5A'), maxSize: 300 * 1024 * 1024,
  },
  {
    name: 'ELF binary', ext: 'elf', kind: 'other',
    header: hex('7F454C46'), maxSize: 300 * 1024 * 1024,
  },
];

// Pre-compute the largest header span so the carver keeps the right overlap
// between chunk reads (TAR's 'ustar' lives 257 bytes in).
const MAX_HEADER_SPAN = SIGNATURES.reduce(
  (m, s) => Math.max(m, (s.headerAt || 0) + s.header.length),
  0
);

/**
 * Bucket signatures by (headerAt, firstByte) so the scanner tests only the
 * handful of signatures that could possibly start at a given byte instead of
 * all ~35 on every byte of the disk. Returns:
 *   { headerAts: [n…], byHeaderAt: Map<n, Uint-indexed array of sig lists> }
 */
function buildIndex(signatures) {
  const byHeaderAt = new Map();
  const headerAts = [];
  for (const sig of signatures) {
    const ha = sig.headerAt || 0;
    if (!byHeaderAt.has(ha)) {
      byHeaderAt.set(ha, Array.from({ length: 256 }, () => []));
      headerAts.push(ha);
    }
    byHeaderAt.get(ha)[sig.header[0]].push(sig);
  }
  headerAts.sort((a, b) => a - b);
  return { headerAts, byHeaderAt };
}

module.exports = { SIGNATURES, MAX_HEADER_SPAN, buildIndex };
