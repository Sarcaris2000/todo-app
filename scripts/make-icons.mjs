// Draws the app icons and writes them as PNGs.
//
// There is no image library here on purpose - the icons are simple enough to
// rasterize by hand (signed distance fields, 3x supersampled) and encode with
// a minimal PNG writer, which keeps the project dependency-free apart from
// wrangler itself.

import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'icons');

// --- PNG encoding ----------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let c = 0xffffffff;
  for (let i = 0; i < buffer.length; i++) c = CRC_TABLE[(c ^ buffer[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([length, body, crc]);
}

function encodePng(width, height, rgba) {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter type 0 (none)
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // colour type: RGBA
  ihdr[10] = 0; // deflate
  ihdr[11] = 0; // adaptive filtering
  ihdr[12] = 0; // no interlace

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// --- geometry --------------------------------------------------------------

/** Signed distance to a rounded rectangle centred in the unit square. */
function roundedRectDistance(x, y, half, radius) {
  const qx = Math.abs(x - 0.5) - (half - radius);
  const qy = Math.abs(y - 0.5) - (half - radius);
  const outside = Math.hypot(Math.max(qx, 0), Math.max(qy, 0));
  return outside + Math.min(Math.max(qx, qy), 0) - radius;
}

/** Distance from a point to a line segment. */
function segmentDistance(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const lengthSq = dx * dx + dy * dy;
  const t = lengthSq === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lengthSq));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

const CHECK = { ax: 0.275, ay: 0.515, bx: 0.435, by: 0.672, cx: 0.735, cy: 0.335 };

function checkDistance(x, y) {
  return Math.min(
    segmentDistance(x, y, CHECK.ax, CHECK.ay, CHECK.bx, CHECK.by),
    segmentDistance(x, y, CHECK.bx, CHECK.by, CHECK.cx, CHECK.cy),
  );
}

// --- drawing ---------------------------------------------------------------

const BG = [47, 111, 79];      // --accent green
const BG_TOP = [63, 134, 97];  // slightly lighter, for a soft vertical gradient
const FG = [255, 255, 255];

const SAMPLES = 3; // per axis, so 9 samples per pixel

/**
 * @param {number} size          output size in px
 * @param {object} options
 * @param {number} options.half      half-width of the tile (0.5 = full bleed)
 * @param {number} options.radius    corner radius, in unit-square terms
 * @param {number} options.stroke    checkmark stroke width
 * @param {number} options.scale     checkmark scale about the centre
 * @param {boolean} options.transparentBackground  draw only the check
 */
function drawIcon(size, options) {
  const {
    half = 0.5, radius = 0.115, stroke = 0.082, scale = 1,
    transparentBackground = false,
  } = options;

  const rgba = Buffer.alloc(size * size * 4);
  const step = 1 / (size * SAMPLES);

  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let bgCoverage = 0;
      let fgCoverage = 0;

      for (let sy = 0; sy < SAMPLES; sy++) {
        for (let sx = 0; sx < SAMPLES; sx++) {
          const x = (px + (sx + 0.5) / SAMPLES) / size;
          const y = (py + (sy + 0.5) / SAMPLES) / size;

          if (!transparentBackground && roundedRectDistance(x, y, half, radius) < 0) bgCoverage++;

          // Scale the checkmark about the icon centre for the maskable variant.
          const cx = 0.5 + (x - 0.5) / scale;
          const cy = 0.5 + (y - 0.5) / scale;
          if (checkDistance(cx, cy) < stroke / 2 / scale) fgCoverage++;
        }
      }

      const total = SAMPLES * SAMPLES;
      const bgAlpha = bgCoverage / total;
      const fgAlpha = fgCoverage / total;

      // Gentle top-to-bottom gradient on the tile.
      const t = py / size;
      const tile = BG.map((c, i) => Math.round(BG_TOP[i] + (c - BG_TOP[i]) * t));

      // Composite: checkmark over tile over transparency.
      const alpha = bgAlpha + fgAlpha * (1 - bgAlpha);
      const outAlpha = Math.min(1, Math.max(bgAlpha, fgAlpha));

      let r; let g; let b;
      if (outAlpha === 0) {
        r = g = b = 0;
      } else {
        const fgWeight = fgAlpha;
        const bgWeight = bgAlpha * (1 - fgAlpha);
        const sum = fgWeight + bgWeight || 1;
        r = Math.round((FG[0] * fgWeight + tile[0] * bgWeight) / sum);
        g = Math.round((FG[1] * fgWeight + tile[1] * bgWeight) / sum);
        b = Math.round((FG[2] * fgWeight + tile[2] * bgWeight) / sum);
      }

      const offset = (py * size + px) * 4;
      rgba[offset] = r;
      rgba[offset + 1] = g;
      rgba[offset + 2] = b;
      rgba[offset + 3] = Math.round(outAlpha * 255);
      void alpha;
    }
  }

  return encodePng(size, size, rgba);
}

// --- output ----------------------------------------------------------------

mkdirSync(OUT_DIR, { recursive: true });

const files = [
  ['icon-192.png', drawIcon(192, {})],
  ['icon-512.png', drawIcon(512, {})],
  // Apple touch icons are composited on an opaque tile, so square it off.
  ['icon-180.png', drawIcon(180, { radius: 0.0 })],
  // Maskable: full bleed, artwork pulled into the 80% safe zone.
  ['icon-maskable-512.png', drawIcon(512, { radius: 0.0, scale: 0.72 })],
  // Badge: monochrome silhouette on transparency (Android status bar).
  ['badge-72.png', drawIcon(72, { transparentBackground: true, stroke: 0.1 })],
];

for (const [name, buffer] of files) {
  writeFileSync(join(OUT_DIR, name), buffer);
  console.log(`  ${name}  ${(buffer.length / 1024).toFixed(1)} KB`);
}

console.log(`\nWrote ${files.length} icons to public/icons/`);
