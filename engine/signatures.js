'use strict';

/**
 * File signature database used by the carving engine.
 *
 * Each signature describes how to recognise the start (and optionally the end)
 * of a file on a raw device / disk image when the filesystem metadata is gone.
 *
 *   header      Buffer / array of bytes that must appear at the start of the file.
 *   headerAt    Offset within the candidate where `header` is expected (default 0).
 *   prefix      Optional bytes that must appear at offset 0 (used by MP4 etc.
 *               where the real magic sits a few bytes in).
 *   footer      Optional Buffer that marks the end of the file (inclusive).
 *   footerTail  Extra bytes to keep after the footer match (e.g. PDF %%EOF\r\n).
 *   maxSize     Hard cap on carved length when there is no footer, or a safety
 *               cap when the footer is never found.
 *   ext         File extension given to recovered files.
 *   kind        Human category used for grouping / filtering in the UI.
 */

const hex = (s) => Buffer.from(s.replace(/\s+/g, ''), 'hex');

const SIGNATURES = [
  {
    name: 'JPEG image',
    ext: 'jpg',
    kind: 'image',
    header: hex('FFD8FF'),
    footer: hex('FFD9'),
    maxSize: 30 * 1024 * 1024,
  },
  {
    name: 'PNG image',
    ext: 'png',
    kind: 'image',
    header: hex('89504E470D0A1A0A'),
    footer: hex('49454E44AE426082'),
    maxSize: 60 * 1024 * 1024,
  },
  {
    name: 'GIF image',
    ext: 'gif',
    kind: 'image',
    header: hex('474946383961'),
    footer: hex('003B'),
    maxSize: 20 * 1024 * 1024,
  },
  {
    name: 'GIF image',
    ext: 'gif',
    kind: 'image',
    header: hex('474946383761'),
    footer: hex('003B'),
    maxSize: 20 * 1024 * 1024,
  },
  {
    name: 'BMP image',
    ext: 'bmp',
    kind: 'image',
    header: hex('424D'),
    maxSize: 20 * 1024 * 1024,
  },
  {
    name: 'HEIC / HEIF image',
    ext: 'heic',
    kind: 'image',
    prefix: null,
    header: hex('6674797068656963'), // 'ftypheic'
    headerAt: 4,
    maxSize: 40 * 1024 * 1024,
  },
  {
    name: 'PDF document',
    ext: 'pdf',
    kind: 'document',
    header: hex('255044462D'), // %PDF-
    footer: hex('2525454F46'), // %%EOF
    footerTail: 2,
    maxSize: 100 * 1024 * 1024,
  },
  {
    name: 'ZIP / Office (docx, xlsx, pptx)',
    ext: 'zip',
    kind: 'archive',
    header: hex('504B0304'),
    footer: hex('504B0506'), // end of central directory record
    footerTail: 18,
    maxSize: 200 * 1024 * 1024,
  },
  {
    name: 'RAR archive',
    ext: 'rar',
    kind: 'archive',
    header: hex('526172211A0700'),
    maxSize: 500 * 1024 * 1024,
  },
  {
    name: 'MP4 / MOV video',
    ext: 'mp4',
    kind: 'video',
    header: hex('66747970'), // 'ftyp'
    headerAt: 4,
    maxSize: 2 * 1024 * 1024 * 1024,
  },
  {
    name: 'MP3 audio (ID3)',
    ext: 'mp3',
    kind: 'audio',
    header: hex('494433'), // 'ID3'
    maxSize: 50 * 1024 * 1024,
  },
  {
    name: 'WAV audio',
    ext: 'wav',
    kind: 'audio',
    header: hex('52494646'), // 'RIFF'
    maxSize: 200 * 1024 * 1024,
  },
  {
    name: 'SQLite database',
    ext: 'sqlite',
    kind: 'database',
    header: hex('53514C69746520666F726D6174203300'), // 'SQLite format 3\0'
    maxSize: 500 * 1024 * 1024,
  },
];

// Pre-compute the largest header length so the carver can keep the right overlap
// between chunk reads.
const MAX_HEADER_SPAN = SIGNATURES.reduce(
  (m, s) => Math.max(m, (s.headerAt || 0) + s.header.length),
  0
);

module.exports = { SIGNATURES, MAX_HEADER_SPAN };
