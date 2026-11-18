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

// The same synth the app ships as its demo track (Node strips the types on import).
const { synthesizeDemo, encodeWav } = await import('../src/audio/demoSynth.ts');
const wav = join(outDir, 'signal-check.wav');
writeFileSync(wav, encodeWav(synthesizeDemo(44100)));

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
// An 8-second excerpt for end-of-track tests, so they don't wait 40 s per song.
ff(['-ss', '15.5', '-t', '8', '-i', wav, '-af', 'afade=t=in:d=0.05,afade=t=out:st=7.5:d=0.5', '-c:a', 'libmp3lame', '-b:a', '160k', join(outDir, 'signal-check-short.mp3')]);
console.log(`Wrote test audio to ${outDir}`);
