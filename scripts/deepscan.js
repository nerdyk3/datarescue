'use strict';
/**
 * Standalone DEEP SCAN (raw signature carving) of a device or image, using the
 * exact same engine the app uses. This recovers DELETED / formatted files that
 * a filesystem scan can't see.
 *
 *   sudo node scripts/deepscan.js /dev/rdiskN            # scan a whole device
 *   node scripts/deepscan.js ~/card.img                  # or a .dd/.img image
 *   sudo node scripts/deepscan.js /dev/rdisk4 ~/out      # custom output folder
 *
 * Raw device access needs admin (hence sudo); an image file does not. The raw
 * device (/dev/rdiskN, not /dev/diskN) is much faster to read.
 */
const path = require('path');
const os = require('os');
const carver = require('../engine/carver');

const human = (n) => (n / 1e9).toFixed(2) + ' GB';

(async () => {
  const src = process.argv[2];
  if (!src) {
    console.error('usage: sudo node scripts/deepscan.js <device-or-image> [outputDir]');
    process.exit(1);
  }
  const outDir = process.argv[3] ||
    path.join(os.homedir(), 'DataRescue_Recovered',
      'carved-' + new Date().toISOString().replace(/[:.]/g, '-'));

  let lastPct = -1;
  const onProgress = (p) => {
    if (p.phase === 'scan' && p.total) {
      const pct = Math.floor((p.bytes / p.total) * 100);
      if (pct !== lastPct) {
        lastPct = pct;
        process.stdout.write(`\r  scanning ${pct}%  (${human(p.bytes)} / ${human(p.total)})        `);
      }
    } else if (p.phase === 'describe') {
      process.stdout.write(`\r  measuring ${p.index}/${p.total}                         `);
    } else if (p.phase === 'recover') {
      process.stdout.write(`\r  recovering ${p.index}/${p.total}: ${p.name}             `);
    }
  };

  console.log('Deep scan of:', src);
  const { candidates, size } = await carver.scanHeaders(src, { onProgress });
  console.log(`\n  ${candidates.length} candidate file headers across ${human(size || 0)}`);

  const files = await carver.describe(src, candidates, size, { onProgress });
  const byKind = {};
  for (const f of files) byKind[f.kind] = (byKind[f.kind] || 0) + 1;
  console.log(`\n  ${files.length} recoverable files  ${JSON.stringify(byKind)}`);

  if (!files.length) { console.log('\nNothing to recover.'); return; }

  const results = await carver.recover(src, files, outDir, { onProgress });
  const ok = results.filter((r) => r.ok).length;
  console.log(`\n\nRecovered ${ok}/${results.length} files to:\n  ${outDir}`);
})().catch((e) => {
  const m = String(e.message || e);
  if (/EACCES|EPERM|operation not permitted/i.test(m)) {
    console.error(`\nPermission denied reading "${process.argv[2]}". Re-run with sudo:\n  sudo node ${__filename} ${process.argv[2] || '/dev/rdiskN'}`);
  } else {
    console.error('\nERROR:', m);
  }
  process.exit(1);
});
