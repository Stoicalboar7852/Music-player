// Test signals with known beat and onset times, for scripts/rhythm-test.mjs.
// Everything is synthesised (with deterministic noise), so there is exact ground truth.

export const SR = 44100;

function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return (s / 4294967296) * 2 - 1;
  };
}

export function makeSignal(seconds) {
  return new Float32Array(Math.floor(seconds * SR));
}

function add(buffer, start, length, fn) {
  const s0 = Math.floor(start * SR);
  const n = Math.floor(length * SR);
  for (let i = 0; i < n && s0 + i < buffer.length; i++) buffer[s0 + i] += fn(i / SR);
}

const TAU = Math.PI * 2;

/** Two-pole band-pass (RBJ), as a sample-by-sample filter. */
function bandpass(f, q) {
  const w = (TAU * f) / SR;
  const alpha = Math.sin(w) / (2 * q);
  const a0 = 1 + alpha;
  const b0 = alpha / a0, b2 = -alpha / a0, a1 = (-2 * Math.cos(w)) / a0, a2 = (1 - alpha) / a0;
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  return (x) => {
    const y = b0 * x + b2 * x2 - a1 * y1 - a2 * y2;
    x2 = x1; x1 = x; y2 = y1; y1 = y;
    return y;
  };
}

/** Two-pole high-pass (RBJ). */
function highpass(f, q = 0.707) {
  const w = (TAU * f) / SR;
  const alpha = Math.sin(w) / (2 * q);
  const a0 = 1 + alpha;
  const c = Math.cos(w);
  const b0 = (1 + c) / 2 / a0, b1 = -(1 + c) / a0, b2 = (1 + c) / 2 / a0, a1 = (-2 * c) / a0, a2 = (1 - alpha) / a0;
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  return (x) => {
    const y = b0 * x + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
    x2 = x1; x1 = x; y2 = y1; y1 = y;
    return y;
  };
}

/** A kick: a pitch-swept sine thump with a short beater click. */
export function kick(buffer, at, gain = 0.9) {
  const click = bandpass(3500, 1);
  let seed = Math.floor(at * 1000) + 1;
  const white = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296) * 2 - 1;
  add(buffer, at, 0.4, (t) => {
    const body = Math.sin(TAU * (45 * t + (110 / 28) * (1 - Math.exp(-28 * t)))) * Math.exp(-t * 7.5);
    const c = t < 0.006 ? click(white()) * 0.6 * (1 - t / 0.006) : 0;
    return (body + c) * gain;
  });
}

/** A snare: a pitched body around 180 Hz and a band of noise centred near 2 kHz. */
export function snare(buffer, at, noise, gain = 0.5) {
  const crack = bandpass(2000, 0.6);
  const sizzle = highpass(5000);
  add(buffer, at, 0.25, (t) => {
    const n = noise();
    const body = Math.sin(TAU * (160 * t + (25 / 30) * (1 - Math.exp(-30 * t)))) * Math.exp(-t * 22) * 0.6;
    const noisy = (crack(n) * 1.4 + sizzle(n) * 0.35) * Math.exp(-t * 17);
    return (body + noisy) * Math.min(1, t / 0.002) * gain;
  });
}

/** A hi-hat: noise above about 7 kHz; `open` rings longer. */
export function hat(buffer, at, noise, gain = 0.2, open = false) {
  const hp1 = highpass(7000);
  const hp2 = highpass(7000);
  add(buffer, at, open ? 0.3 : 0.08, (t) => hp2(hp1(noise())) * Math.exp(-t * (open ? 14 : 60)) * gain * 1.6);
}

const midi = (n) => 440 * Math.pow(2, (n - 69) / 12);

export function bass(buffer, at, note, length, gain = 0.35) {
  const f = midi(note);
  let lp = 0;
  add(buffer, at, length, (t) => {
    const saw = 2 * ((t * f) % 1) - 1;
    lp += (saw - lp) * (0.03 + 0.1 * Math.exp(-t * 9));
    const env = Math.min(1, t * 200) * Math.min(1, (length - t) * 60);
    return (lp * 0.9 + Math.sin(TAU * f * t) * 0.5) * env * gain;
  });
}

export function pad(buffer, at, notes, length, gain = 0.06) {
  notes.forEach((note, k) => {
    for (const detune of [-0.07, 0.06]) {
      const f = midi(note + detune);
      let lp = 0;
      add(buffer, at, length, (t) => {
        const saw = 2 * ((t * f + k * 0.37) % 1) - 1;
        lp += (saw - lp) * 0.09;
        return lp * Math.min(1, t * 2.5) * Math.min(1, (length - t) * 3) * gain;
      });
    }
  });
}

/**
 * A singer, roughly: a glottal pulse train with vibrato and drifting pitch,
 * through three vowel formants, in syllables with soft attacks, plus the odd
 * sibilant. No drums at all.
 */
export function vocal(buffer, start, seconds, seed = 7) {
  const noise = rng(seed);
  const vowels = [
    [730, 1090, 2440],
    [270, 2290, 3010],
    [570, 840, 2410],
    [300, 870, 2240],
    [530, 1840, 2480],
  ];
  // Two-pole resonators, one per formant.
  const res = (f, bw) => {
    const r = Math.exp((-Math.PI * bw) / SR);
    return { a1: 2 * r * Math.cos((TAU * f) / SR), a2: -r * r, g: 1 - r, y1: 0, y2: 0 };
  };
  let t = 0;
  let syllable = 0;
  while (t < seconds - 0.3) {
    const length = 0.22 + ((syllable * 37) % 5) * 0.09;
    const vowel = vowels[syllable % vowels.length];
    const f0 = 200 + 70 * Math.sin(syllable * 1.3) + 30 * ((syllable * 13) % 3);
    const filters = vowel.map((f, i) => res(f, 80 + i * 40));
    let phase = 0;
    const s0 = Math.floor((start + t) * SR);
    const n = Math.floor(length * SR);
    for (let i = 0; i < n && s0 + i < buffer.length; i++) {
      const time = i / SR;
      const vib = 1 + 0.02 * Math.sin(TAU * 5.5 * time);
      phase += (f0 * vib) / SR;
      if (phase >= 1) phase -= 1;
      const glottal = phase < 0.4 ? Math.sin((Math.PI * phase) / 0.4) : 0;
      const src = glottal + noise() * 0.02;
      let out = 0;
      for (const fl of filters) {
        const y = fl.g * src + fl.a1 * fl.y1 + fl.a2 * fl.y2;
        fl.y2 = fl.y1;
        fl.y1 = y;
        out += y;
      }
      // Soft attack and release, as sung.
      const env = Math.min(1, time / 0.06) * Math.min(1, (length - time) / 0.08);
      buffer[s0 + i] += out * env * 0.5;
    }
    // A sibilant now and then ("s"), a short burst of high noise.
    if (syllable % 4 === 3) {
      let prev = 0;
      add(buffer, start + t + length, 0.07, (x) => {
        const v = noise();
        const hp = v - prev;
        prev = v;
        return hp * 0.05 * Math.min(1, x / 0.02) * Math.min(1, (0.07 - x) / 0.02);
      });
    }
    t += length + 0.1 + ((syllable * 7) % 3) * 0.05;
    syllable++;
  }
}

/**
 * A four-on-the-floor or backbeat loop with bass and chords. Returns the
 * signal and the ground truth: beats, downbeats, kicks, snares, hats.
 */
export function loop({ bpm, bars, style = 'four', seed = 1, from = 0, breakdown = null, vocals = false }) {
  const beat = 60 / bpm;
  const bar = beat * 4;
  const seconds = from + bars * bar + 1;
  const buffer = makeSignal(seconds);
  const noise = rng(seed);
  const truth = { beats: [], downbeats: [], kicks: [], snares: [], hats: [], drops: [] };
  const chords = [
    [57, 60, 64],
    [53, 57, 60],
    [55, 60, 64],
    [55, 59, 62],
  ];
  const roots = [33, 29, 36, 31];
  for (let b = 0; b < bars; b++) {
    const t0 = from + b * bar;
    const quiet = breakdown && b >= breakdown[0] && b < breakdown[1];
    if (breakdown && b === breakdown[1]) truth.drops.push(t0);
    pad(buffer, t0, chords[b % 4], bar);
    for (let s = 0; s < 16; s++) {
      const t = t0 + s * (beat / 4);
      if (s % 4 === 0) {
        truth.beats.push(t);
        if (s === 0) truth.downbeats.push(t);
      }
      if (quiet) {
        // Breakdown: a rising hat and snare roll, no kick, no bass.
        if (s % 2 === 0) hat(buffer, t, noise, 0.08 + 0.12 * (s / 16));
        if (b === breakdown[1] - 1 && s >= 8 && s % 2 === 0) {
          snare(buffer, t, noise, 0.25 + 0.03 * s);
          truth.snares.push(t);
        }
        continue;
      }
      const kickHere = style === 'four' ? s % 4 === 0 : s === 0 || s === 10;
      if (kickHere) {
        kick(buffer, t);
        truth.kicks.push(t);
      }
      if (s === 4 || s === 12) {
        snare(buffer, t, noise);
        truth.snares.push(t);
      }
      if (s % 2 === 0) {
        hat(buffer, t, noise, s % 4 === 2 ? 0.22 : 0.12, s % 4 === 2);
        truth.hats.push(t);
      }
      if (s % 4 === 2) bass(buffer, t, roots[b % 4] + (s === 6 ? 12 : 0), beat / 2 - 0.02);
    }
  }
  if (vocals) vocal(buffer, from, bars * bar, seed + 3);
  // Normalise.
  let peak = 0;
  for (const v of buffer) peak = Math.max(peak, Math.abs(v));
  for (let i = 0; i < buffer.length; i++) buffer[i] *= 0.85 / peak;
  return { buffer, truth, seconds };
}

/** Greedy one-to-one matching within a tolerance. */
export function score(detected, truth, tolerance = 0.07) {
  const used = new Set();
  let hits = 0;
  for (const t of truth) {
    let best = -1;
    let bestDist = tolerance;
    detected.forEach((d, i) => {
      const dist = Math.abs(d - t);
      if (!used.has(i) && dist <= bestDist) {
        best = i;
        bestDist = dist;
      }
    });
    if (best >= 0) {
      used.add(best);
      hits++;
    }
  }
  const precision = detected.length ? hits / detected.length : truth.length ? 0 : 1;
  const recall = truth.length ? hits / truth.length : 1;
  const f = precision + recall ? (2 * precision * recall) / (precision + recall) : 0;
  return { precision, recall, f, hits, detected: detected.length, truth: truth.length };
}
