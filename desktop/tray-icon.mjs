// The tray / menu bar icon: Phosphor's four bars, moving with the music.
// Pure Node (no Electron), so it can be tested on its own: levels in, PNG out.

import { deflateSync } from 'node:zlib';

// ------------------------------------------------------------------ PNG

const CRC_TABLE = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(bytes) {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'latin1');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

/** Encodes 8-bit RGBA pixels (row by row, top first) as a PNG. */
export function encodePng(width, height, rgba) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // RGBA
  const rows = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    rows[y * (width * 4 + 1)] = 0; // no filter
    Buffer.from(rgba.buffer, rgba.byteOffset + y * width * 4, width * 4).copy(rows, y * (width * 4 + 1) + 1);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(rows)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------------------------------------------------------------- drawing

/** Signed distance from (px, py) to a rounded rectangle. */
function roundedRect(px, py, x0, y0, x1, y1, r) {
  const cx = (x0 + x1) / 2;
  const cy = (y0 + y1) / 2;
  const hx = (x1 - x0) / 2 - r;
  const hy = (y1 - y0) / 2 - r;
  const qx = Math.abs(px - cx) - hx;
  const qy = Math.abs(py - cy) - hy;
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
}

/** Resting heights: the logo. */
export const RESTING = [0.55, 0.85, 0.7, 1];

const GRADIENT = [
  [255, 61, 129],
  [122, 92, 255],
  [33, 212, 253],
];

function gradient(t) {
  const s = Math.max(0, Math.min(1, t)) * (GRADIENT.length - 1);
  const i = Math.min(GRADIENT.length - 2, Math.floor(s));
  const f = s - i;
  return GRADIENT[i].map((a, k) => Math.round(a + (GRADIENT[i + 1][k] - a) * f));
}

/**
 * Draws the icon. `heights` are four values from 0 to 1.
 * - `template` (the macOS menu bar): black bars on transparent; macOS tints
 *   them to suit a light or dark menu bar.
 * - otherwise (the Windows tray): gradient bars on a dark rounded square.
 * `size` is in pixels (36 for an 18-point menu bar icon at 2x, 32 for a
 * 16-pixel tray icon at 2x).
 */
export function drawIcon(heights, { size = 36, template = true } = {}) {
  const rgba = new Uint8Array(size * size * 4);
  const s = size / 36; // designed on a 36-pixel grid
  const barWidth = 6 * s;
  const gap = 3 * s;
  const left = (size - (4 * barWidth + 3 * gap)) / 2;
  const bottom = template ? size - 3 * s : size - 6 * s;
  const tallest = template ? size - 6 * s : size - 12 * s;
  const shortest = 4 * s;
  const bars = heights.slice(0, 4).map((h, i) => {
    const height = shortest + (tallest - shortest) * Math.max(0, Math.min(1, h));
    const x0 = left + i * (barWidth + gap);
    return { x0, x1: x0 + barWidth, y0: bottom - height, y1: bottom };
  });
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const px = x + 0.5;
      const py = y + 0.5;
      let cover = 0;
      for (const b of bars) {
        const d = roundedRect(px, py, b.x0, b.y0, b.x1, b.y1, barWidth / 2);
        cover = Math.max(cover, Math.max(0, Math.min(1, 0.5 - d)));
      }
      const o = (y * size + x) * 4;
      if (template) {
        rgba[o + 3] = Math.round(cover * 255);
        continue;
      }
      // A dark rounded square behind gradient bars.
      const back = Math.max(0, Math.min(1, 0.5 - roundedRect(px, py, 0, 0, size, size, 7 * s)));
      const [r, g, b] = gradient((px + (size - py)) / (2 * size));
      const base = [11, 11, 18];
      const alpha = Math.max(back, cover);
      for (let k = 0; k < 3; k++) {
        const c = base[k] * (1 - cover) + [r, g, b][k] * cover;
        rgba[o + k] = Math.round(alpha > 0 ? c : 0);
      }
      rgba[o + 3] = Math.round(alpha * 255);
    }
  }
  return encodePng(size, size, rgba);
}

/**
 * Turns the analysis levels the window sends into four bar heights, with a
 * quick rise and a slower fall so the bars read as movement, not flicker.
 */
export function createMeter() {
  let heights = [...RESTING];
  return {
    get heights() {
      return heights;
    },
    update(levels, dt = 1 / 12) {
      const { bass = 0, mid = 0, treble = 0, pulse = 0 } = levels ?? {};
      const targets = [Math.max(bass, pulse), (bass + mid) / 2, mid, treble].map((v) => Math.min(1, 0.15 + v * 1.3));
      heights = heights.map((h, i) => {
        const t = targets[i];
        const rate = t > h ? 18 : 3.5; // per second: up fast, down gently
        return h + (t - h) * Math.min(1, rate * dt);
      });
      return heights;
    },
    rest() {
      heights = [...RESTING];
      return heights;
    },
  };
}

// ------------------------------------------------------------ button glyphs

/** Fraction of the pixel at (x, y) covered by the polygons, from 4x4 samples. */
function polygonCover(polygons, x, y) {
  let inside = 0;
  for (let sy = 0; sy < 4; sy++) {
    for (let sx = 0; sx < 4; sx++) {
      const px = x + (sx + 0.5) / 4;
      const py = y + (sy + 0.5) / 4;
      for (const points of polygons) {
        let hit = false;
        for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
          const [xi, yi] = points[i];
          const [xj, yj] = points[j];
          if (yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) hit = !hit;
        }
        if (hit) {
          inside++;
          break;
        }
      }
    }
  }
  return inside / 16;
}

const GLYPHS = {
  // Designed on a 16-pixel grid.
  play: [[[5, 3], [13, 8], [5, 13]]],
  pause: [
    [[4, 3], [7, 3], [7, 13], [4, 13]],
    [[9, 3], [12, 3], [12, 13], [9, 13]],
  ],
  next: [
    [[3, 3], [10, 8], [3, 13]],
    [[10.5, 3], [13, 3], [13, 13], [10.5, 13]],
  ],
  previous: [
    [[13, 3], [6, 8], [13, 13]],
    [[3, 3], [5.5, 3], [5.5, 13], [3, 13]],
  ],
};

/** A white transport glyph (play, pause, next, previous) as a PNG, for the Windows taskbar buttons. */
export function drawGlyph(kind, size = 32) {
  const scale = size / 16;
  const polygons = GLYPHS[kind].map((points) => points.map(([x, y]) => [x * scale, y * scale]));
  const rgba = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const o = (y * size + x) * 4;
      rgba[o] = rgba[o + 1] = rgba[o + 2] = 255;
      rgba[o + 3] = Math.round(polygonCover(polygons, x, y) * 255);
    }
  }
  return encodePng(size, size, rgba);
}
