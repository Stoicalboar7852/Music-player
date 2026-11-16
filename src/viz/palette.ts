// Pulls a four-colour palette out of cover art so the modern visualizers can
// take their colours from whatever is playing.

export type RGB = [number, number, number];

/** Used when a track has no artwork. */
export const DEFAULT_PALETTE: RGB[] = [
  [1.0, 0.24, 0.51],
  [0.48, 0.36, 1.0],
  [0.13, 0.83, 0.99],
  [1.0, 0.7, 0.28],
];

function saturation(r: number, g: number, b: number): number {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  return max === 0 ? 0 : (max - min) / max;
}

function hueOf(r: number, g: number, b: number): number {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  if (d < 1e-5) return 0;
  let h: number;
  if (max === r) h = ((g - b) / d) % 6;
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return (h / 6 + 1) % 1;
}

function hsvToRgb(h: number, s: number, v: number): RGB {
  const f = (n: number) => {
    const k = (n + h * 6) % 6;
    return v - v * s * Math.max(0, Math.min(k, 4 - k, 1));
  };
  return [f(5), f(3), f(1)];
}

/** Lifts a colour so it reads well as emitted light on a dark background. */
function vivid([r, g, b]: RGB): RGB {
  const max = Math.max(r, g, b, 1e-4);
  const s = saturation(r, g, b);
  const h = hueOf(r, g, b);
  // Keep the hue; push brightness up and saturation into a usable range.
  const v = Math.max(max, 0.82);
  const sat = s < 0.08 ? s : Math.min(1, Math.max(0.45, s * 1.15));
  return hsvToRgb(h, sat, v);
}

/**
 * Extracts four distinct, vivid colours from RGBA pixel data.
 * Colours are scored by how much of the image they cover and how saturated
 * they are, then picked greedily to stay apart from each other.
 */
export function extractPalette(pixels: Uint8ClampedArray): RGB[] {
  const SHIFT = 4; // 16 levels per channel
  const size = 1 << (3 * (8 - SHIFT));
  const count = new Float32Array(size);
  const sumR = new Float32Array(size);
  const sumG = new Float32Array(size);
  const sumB = new Float32Array(size);
  for (let i = 0; i < pixels.length; i += 4) {
    if (pixels[i + 3] < 128) continue;
    const r = pixels[i];
    const g = pixels[i + 1];
    const b = pixels[i + 2];
    const key = ((r >> SHIFT) << 8) | ((g >> SHIFT) << 4) | (b >> SHIFT);
    count[key]++;
    sumR[key] += r;
    sumG[key] += g;
    sumB[key] += b;
  }

  interface Candidate {
    color: RGB;
    score: number;
  }
  const candidates: Candidate[] = [];
  for (let k = 0; k < size; k++) {
    if (count[k] === 0) continue;
    const n = count[k];
    const color: RGB = [sumR[k] / n / 255, sumG[k] / n / 255, sumB[k] / n / 255];
    const s = saturation(...color);
    const v = Math.max(...color);
    // Favour colourful, reasonably bright bins; sqrt keeps one big flat
    // background from drowning out everything else.
    const score = Math.sqrt(n) * (0.15 + s * 1.6) * (0.25 + Math.min(1, v * 1.4));
    candidates.push({ color, score });
  }
  if (candidates.length === 0) return DEFAULT_PALETTE;
  candidates.sort((a, b) => b.score - a.score);
  const pool = candidates.slice(0, 64);

  const picked: RGB[] = [];
  while (picked.length < 4 && pool.length > 0) {
    let best = 0;
    let bestScore = -1;
    for (let i = 0; i < pool.length; i++) {
      let minDist = 1;
      for (const p of picked) {
        const d = Math.hypot(p[0] - pool[i].color[0], p[1] - pool[i].color[1], p[2] - pool[i].color[2]);
        if (d < minDist) minDist = d;
      }
      const s = pool[i].score * (picked.length === 0 ? 1 : minDist * minDist);
      if (s > bestScore) {
        bestScore = s;
        best = i;
      }
    }
    picked.push(pool[best].color);
    pool.splice(best, 1);
  }

  // Monochrome or near-monochrome art: synthesise companions around the main hue.
  const base = picked[0];
  const baseHue = hueOf(...base);
  const baseSat = saturation(...base);
  while (picked.length < 4) {
    const shift = [0.08, -0.1, 0.5][picked.length - 1] ?? 0.3;
    picked.push(hsvToRgb((baseHue + shift + 1) % 1, Math.max(0.35, baseSat), 0.9));
  }

  const result = picked.map(vivid);
  // If the whole image is grey, tint it instead of rendering pure white.
  if (result.every((c) => saturation(...c) < 0.12)) {
    return [
      [0.92, 0.94, 1.0],
      [0.55, 0.68, 1.0],
      [0.8, 0.86, 1.0],
      [1.0, 0.86, 0.7],
    ];
  }
  return result;
}

/** Reads a small copy of an image and extracts its palette. */
export function paletteFromImage(image: CanvasImageSource): RGB[] {
  const size = 48;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return DEFAULT_PALETTE;
  ctx.drawImage(image, 0, 0, size, size);
  try {
    return extractPalette(ctx.getImageData(0, 0, size, size).data);
  } catch {
    // Cross-origin image without CORS headers: pixels are unreadable.
    return DEFAULT_PALETTE;
  }
}
