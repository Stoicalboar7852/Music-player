// Builds the built-in demo track in the browser: synthesise, wrap as a WAV
// File, draw some cover art for it.

import { newTrackId, type Track } from '../player/types';
import { DEMO_ARTIST, DEMO_TITLE, encodeWav, synthesizeDemo } from './demoSynth';

function drawCover(): Promise<string | undefined> {
  const size = 600;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const c = canvas.getContext('2d');
  if (!c) return Promise.resolve(undefined);
  const bg = c.createLinearGradient(0, size, size, 0);
  bg.addColorStop(0, '#12062e');
  bg.addColorStop(0.55, '#5b1a8f');
  bg.addColorStop(1, '#ff5a3c');
  c.fillStyle = bg;
  c.fillRect(0, 0, size, size);
  // A sun and a stack of waveforms: a small picture of what the track does.
  const sun = c.createRadialGradient(410, 190, 10, 410, 190, 190);
  sun.addColorStop(0, '#ffe08a');
  sun.addColorStop(0.5, '#ff8a4c');
  sun.addColorStop(1, 'rgba(255, 90, 60, 0)');
  c.fillStyle = sun;
  c.beginPath();
  c.arc(410, 190, 190, 0, Math.PI * 2);
  c.fill();
  for (let row = 0; row < 9; row++) {
    const y = 330 + row * 30;
    c.beginPath();
    for (let x = 0; x <= size; x += 6) {
      const envelope = Math.exp(-(((x - 300) / 190) ** 2));
      const v = Math.sin(x * 0.045 + row * 1.3) * Math.sin(x * 0.011 + row) * 38 * envelope;
      if (x === 0) c.moveTo(x, y - v);
      else c.lineTo(x, y - v);
    }
    c.strokeStyle = `hsla(${185 + row * 9}, 95%, ${72 - row * 3}%, ${0.95 - row * 0.07})`;
    c.lineWidth = 3;
    c.stroke();
  }
  return new Promise((resolve) => canvas.toBlob((blob) => resolve(blob ? URL.createObjectURL(blob) : undefined), 'image/png'));
}

/** Synthesis takes a moment, so yield to the browser first to let any "loading" UI paint. */
export async function createDemoTrack(): Promise<Track> {
  await new Promise((resolve) => setTimeout(resolve, 30));
  const audio = synthesizeDemo(44100);
  const file = new File([encodeWav(audio)], 'signal-check.wav', { type: 'audio/wav' });
  return {
    id: newTrackId('demo'),
    source: 'local',
    title: DEMO_TITLE,
    artist: DEMO_ARTIST,
    album: 'Built-in demo',
    duration: audio.left.length / audio.sampleRate,
    artworkUrl: await drawCover(),
    file,
  };
}
