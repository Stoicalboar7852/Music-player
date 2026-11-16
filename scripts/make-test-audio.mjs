#!/usr/bin/env node
// Synthesises an original test track and encodes it into the formats the app
// claims to support, with tags and embedded cover art, so verification never
// depends on anyone's music files.
//
//   node scripts/make-test-audio.mjs [outDir]     (needs ffmpeg on PATH)

import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const outDir = process.argv[2] ?? '.verify/audio';
mkdirSync(outDir, { recursive: true });

const SR = 44100;
const BPM = 124;
const BEAT = 60 / BPM;
const BAR = BEAT * 4;
const BARS = 21;
const total = Math.floor(BARS * BAR * SR);
const L = new Float32Array(total);
const R = new Float32Array(total);
const TAU = Math.PI * 2;

let seed = 12345;
const rand = () => {
  seed = (seed * 1664525 + 1013904223) >>> 0;
  return seed / 4294967296;
};
const noise = () => rand() * 2 - 1;
const midi = (n) => 440 * Math.pow(2, (n - 69) / 12);

function add(start, length, fn, pan = 0) {
  const s0 = Math.floor(start * SR);
  const n = Math.floor(length * SR);
  const gl = Math.cos((pan + 1) * Math.PI * 0.25);
  const gr = Math.sin((pan + 1) * Math.PI * 0.25);
  for (let i = 0; i < n && s0 + i < total; i++) {
    const v = fn(i / SR, i);
    L[s0 + i] += v * gl;
    R[s0 + i] += v * gr;
  }
}

const kick = (at) =>
  add(at, 0.42, (t) => {
    const phase = TAU * (44 * t + (110 / 28) * (1 - Math.exp(-28 * t)));
    return Math.sin(phase) * Math.exp(-t * 7.5) * 0.95 + (t < 0.004 ? noise() * 0.3 : 0);
  });

const snare = (at) => {
  let lp = 0;
  add(at, 0.28, (t) => {
    const n = noise();
    lp += (n - lp) * 0.35;
    return ((n - lp) * 0.55 + Math.sin(TAU * 190 * t) * 0.35 * Math.exp(-t * 30)) * Math.exp(-t * 16);
  });
};

const hat = (at, gain, pan) => {
  let prev = 0;
  add(at, 0.09, (t) => {
    const n = noise();
    const hp = n - prev;
    prev = n;
    return hp * Math.exp(-t * 70) * gain;
  }, pan);
};

const bass = (at, note, length) => {
  const f = midi(note);
  let lp = 0;
  add(at, length, (t) => {
    const saw = 2 * ((t * f) % 1) - 1;
    const cutoff = 0.03 + 0.1 * Math.exp(-t * 9);
    lp += (saw - lp) * cutoff;
    const env = Math.min(1, t * 200) * Math.min(1, (length - t) * 60);
    return (lp * 0.9 + Math.sin(TAU * f * t) * 0.5) * env * 0.5;
  });
};

const pad = (at, notes, length) => {
  for (const [k, note] of notes.entries()) {
    for (const detune of [-0.07, 0.06]) {
      const f = midi(note + detune);
      let lp = 0;
      add(at, length, (t) => {
        const saw = 2 * ((t * f + k * 0.37) % 1) - 1;
        lp += (saw - lp) * 0.09;
        const env = Math.min(1, t * 2.5) * Math.min(1, (length - t) * 3);
        return lp * env * 0.085;
      }, detune < 0 ? -0.5 : 0.5);
    }
  }
};

const pluck = (at, note, pan) => {
  const f = midi(note);
  add(at, 0.3, (t) => {
    const tri = Math.abs(4 * ((t * f) % 1) - 2) - 1;
    return (tri * 0.7 + Math.sin(TAU * f * 2 * t) * 0.3) * Math.exp(-t * 11) * 0.16;
  }, pan);
};

// A minor: Am - F - C - G, one bar each.
const chords = [
  { root: 33, tones: [57, 60, 64, 69] },
  { root: 29, tones: [53, 57, 60, 65] },
  { root: 36, tones: [55, 60, 64, 67] },
  { root: 31, tones: [55, 59, 62, 67] },
];

for (let bar = 0; bar < BARS; bar++) {
  const t0 = bar * BAR;
  const chord = chords[bar % 4];
  const intro = bar < 4;
  const build = bar >= 4 && bar < 8;
  const breakdown = bar === 16 || bar === 17;
  const full = !intro && !build && !breakdown;

  pad(t0, chord.tones, BAR);
  for (let step = 0; step < 16; step++) {
    const t = t0 + step * (BEAT / 4);
    if (!breakdown) {
      if (step % 4 === 2) hat(t, 0.34, 0.25);
      else if (step % 2 === 0 || full) hat(t, step % 2 ? 0.1 : 0.17, -0.25);
    }
    if ((build || full) && step % 4 === 0) kick(t);
    if (full && (step === 4 || step === 12)) snare(t);
    if ((build || full) && step % 2 === 0 && step % 4 !== 0) bass(t, chord.root + (step % 8 === 6 ? 12 : 0), BEAT / 2 - 0.02);
    if (full || breakdown) {
      const pattern = [0, 1, 2, 3, 2, 1, 2, 3, 0, 1, 2, 3, 3, 2, 1, 2];
      pluck(t, chord.tones[pattern[step]] + 12, step % 2 ? 0.6 : -0.6);
    }
  }
}

// Normalise, fade the edges, write 16-bit stereo WAV.
let peak = 0;
for (let i = 0; i < total; i++) peak = Math.max(peak, Math.abs(L[i]), Math.abs(R[i]));
const gain = 0.89 / peak;
const pcm = Buffer.alloc(44 + total * 4);
pcm.write('RIFF', 0);
pcm.writeUInt32LE(36 + total * 4, 4);
pcm.write('WAVEfmt ', 8);
pcm.writeUInt32LE(16, 16);
pcm.writeUInt16LE(1, 20);
pcm.writeUInt16LE(2, 22);
pcm.writeUInt32LE(SR, 24);
pcm.writeUInt32LE(SR * 4, 28);
pcm.writeUInt16LE(4, 32);
pcm.writeUInt16LE(16, 34);
pcm.write('data', 36);
pcm.writeUInt32LE(total * 4, 40);
const fadeLen = SR * 0.4;
for (let i = 0; i < total; i++) {
  const fade = Math.min(1, i / 200, (total - i) / fadeLen);
  pcm.writeInt16LE(Math.round(Math.max(-1, Math.min(1, L[i] * gain * fade)) * 32767), 44 + i * 4);
  pcm.writeInt16LE(Math.round(Math.max(-1, Math.min(1, R[i] * gain * fade)) * 32767), 46 + i * 4);
}
const wav = join(outDir, 'signal-check.wav');
writeFileSync(wav, pcm);

const ff = (args) => execFileSync('ffmpeg', ['-y', '-loglevel', 'error', ...args], { stdio: 'inherit' });

// Cover art: a warm-to-teal gradient with a disc, so palette extraction has something to find.
const cover = join(outDir, 'cover.png');
ff([
  '-f', 'lavfi', '-i',
  "color=c=black:s=600x600,format=rgb24,geq=r='255*pow(1-hypot(X-420,Y-170)/700,2)+40*lt(hypot(X-300,Y-300),150)':g='70+110*(Y/600)*(X/600)+90*lt(hypot(X-300,Y-300),150)':b='60+190*pow(hypot(X-420,Y-170)/700,1.3)'",
  '-frames:v', '1', cover,
]);

const tags = (title) => [
  '-metadata', `title=${title}`,
  '-metadata', 'artist=Phosphor Test Signal',
  '-metadata', 'album=Verification Suite',
  '-metadata', 'track=1',
  '-metadata', 'date=2026',
];

ff(['-i', wav, '-i', cover, '-map', '0:a', '-map', '1:v', '-c:a', 'libmp3lame', '-b:a', '192k', '-c:v', 'mjpeg', '-id3v2_version', '3', '-disposition:v', 'attached_pic', ...tags('Signal Check (MP3)'), join(outDir, 'signal-check.mp3')]);
ff(['-i', wav, '-i', cover, '-map', '0:a', '-map', '1:v', '-c:a', 'flac', '-c:v', 'mjpeg', '-disposition:v', 'attached_pic', ...tags('Signal Check (FLAC)'), join(outDir, 'signal-check.flac')]);
ff(['-i', wav, '-c:a', 'libvorbis', '-q:a', '5', ...tags('Signal Check (OGG)'), join(outDir, 'signal-check.ogg')]);
try {
  ff(['-i', wav, '-i', cover, '-map', '0:a', '-map', '1:v', '-c:a', 'aac', '-b:a', '192k', '-c:v', 'mjpeg', '-disposition:v', 'attached_pic', ...tags('Signal Check (M4A)'), join(outDir, 'signal-check.m4a')]);
} catch {
  console.warn('m4a encode skipped');
}
console.log(`Wrote test audio to ${outDir}`);
