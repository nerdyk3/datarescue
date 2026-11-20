'use strict';
/**
 * Generate assets/icon.png (1024×1024) with no image libraries — a flat shield
 * mark on a rounded dark tile, matching the app's theme. electron-builder turns
 * this single PNG into .icns / .ico / Linux PNGs at build time.
 */
const fs = require('fs');
const zlib = require('zlib');
const path = require('path');

const W = 1024, H = 1024;
const buf = Buffer.alloc(W * H * 4); // RGBA

const set = (x, y, r, g, b, a) => {
  if (x < 0 || y < 0 || x >= W || y >= H) return;
  const i = (y * W + x) * 4;
  // simple alpha-over compositing onto existing pixel
  const ca = a / 255, ia = 1 - ca;
  buf[i] = Math.round(r * ca + buf[i] * ia);
  buf[i + 1] = Math.round(g * ca + buf[i + 1] * ia);
  buf[i + 2] = Math.round(b * ca + buf[i + 2] * ia);
  buf[i + 3] = Math.max(buf[i + 3], a);
};

// Rounded-rect background tile.
const roundedRectInside = (x, y, x0, y0, x1, y1, rad) => {
  if (x < x0 || x > x1 || y < y0 || y > y1) return false;
  const nx = x < x0 + rad ? x0 + rad : x > x1 - rad ? x1 - rad : x;
  const ny = y < y0 + rad ? y0 + rad : y > y1 - rad ? y1 - rad : y;
  return (x - nx) ** 2 + (y - ny) ** 2 <= rad * rad;
};

// Shield polygon (point-in-polygon) + a vertical gradient fill.
const shield = [
  [512, 150], [820, 270], [820, 560],
  [660, 760], [512, 858], [364, 760], [204, 560], [204, 270],
];
function inPoly(px, py, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if ((yi > py) !== (yj > py) &&
        px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

// Distance from point to segment, for the checkmark stroke.
function distSeg(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
  const cx = ax + t * dx, cy = ay + t * dy;
  return Math.hypot(px - cx, py - cy);
}

const check = [[398, 520], [478, 606], [648, 404]];

for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    // background tile
    if (roundedRectInside(x, y, 48, 48, W - 48, H - 48, 200)) {
      set(x, y, 11, 14, 20, 255); // #0b0e14
    }
    // shield (teal, subtle top-to-bottom shade)
    if (inPoly(x, y, shield)) {
      const f = (y - 150) / (858 - 150);
      const r = Math.round(45 + f * -10);
      const g = Math.round(212 + f * -40);
      const b = Math.round(191 + f * -30);
      set(x, y, r, g, b, 255);
    }
    // checkmark (white, antialiased edge)
    let d = Infinity;
    for (let k = 0; k < check.length - 1; k++) {
      d = Math.min(d, distSeg(x, y, check[k][0], check[k][1], check[k + 1][0], check[k + 1][1]));
    }
    const half = 26;
    if (d <= half + 1.5) {
      const a = d <= half ? 255 : Math.round(255 * (1 - (d - half) / 1.5));
      set(x, y, 11, 14, 20, a); // dark check cut into the shield
    }
  }
}

// ---- encode PNG ----
function crc32(bytes) {
  let c = ~0;
  for (let n = 0; n < bytes.length; n++) {
    c ^= bytes[n];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const t = Buffer.from(type, 'latin1');
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([t, data])), 0);
  return Buffer.concat([len, t, data, crc]);
}
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4);
ihdr[8] = 8; ihdr[9] = 6; // 8-bit, RGBA
// raw scanlines with filter byte 0
const raw = Buffer.alloc((W * 4 + 1) * H);
for (let y = 0; y < H; y++) {
  raw[y * (W * 4 + 1)] = 0;
  buf.copy(raw, y * (W * 4 + 1) + 1, y * W * 4, (y + 1) * W * 4);
}
const png = Buffer.concat([
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  chunk('IHDR', ihdr),
  chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);
const out = path.join(__dirname, '..', 'assets', 'icon.png');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, png);
console.log('wrote', out, `(${(png.length / 1024).toFixed(0)} KB, ${W}×${H})`);
