// An original, procedurally synthesised track: kick, snare, hats, bass, pads
// and a plucked arpeggio in A minor at 124 BPM. It is the app's built-in demo
// and also the signal the verification scripts play, so testing never depends
// on anyone's music files.
//
// This file is plain TypeScript with no browser APIs, so the Node script in
// scripts/make-test-audio.mjs can import it directly.

export interface DemoAudio {
  sampleRate: number;
  left: Float32Array;
  right: Float32Array;
}

export const DEMO_TITLE = 'Signal Check';
export const DEMO_ARTIST = 'Phosphor';

export function synthesizeDemo(sampleRate = 44100): DemoAudio {
  const SR = sampleRate;
  const BEAT = 60 / 124;
  const BAR = BEAT * 4;
  const BARS = 21;
  const total = Math.floor(BARS * BAR * SR);
  const L = new Float32Array(total);
  const R = new Float32Array(total);
  const TAU = Math.PI * 2;

  let seed = 12345;
  const noise = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return (seed / 4294967296) * 2 - 1;
  };
  const midi = (n: number) => 440 * Math.pow(2, (n - 69) / 12);

  const add = (start: number, length: number, fn: (t: number) => number, pan = 0) => {
    const s0 = Math.floor(start * SR);
    const n = Math.floor(length * SR);
    const gl = Math.cos((pan + 1) * Math.PI * 0.25);
    const gr = Math.sin((pan + 1) * Math.PI * 0.25);
    for (let i = 0; i < n && s0 + i < total; i++) {
      const v = fn(i / SR);
      L[s0 + i] += v * gl;
      R[s0 + i] += v * gr;
    }
  };

  const kick = (at: number) =>
    add(at, 0.42, (t) => {
      const phase = TAU * (44 * t + (110 / 28) * (1 - Math.exp(-28 * t)));
      return Math.sin(phase) * Math.exp(-t * 7.5) * 0.95 + (t < 0.004 ? noise() * 0.3 : 0);
    });

  // Two-pole filters (RBJ cookbook), each call making a fresh filter state.
  const biquad = (b0: number, b1: number, b2: number, a0: number, a1: number, a2: number) => {
    let x1 = 0;
    let x2 = 0;
    let y1 = 0;
    let y2 = 0;
    return (x: number) => {
      const y = (b0 * x + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2) / a0;
      x2 = x1;
      x1 = x;
      y2 = y1;
      y1 = y;
      return y;
    };
  };
  const bandpass = (f: number, q: number) => {
    const w = (TAU * f) / SR;
    const alpha = Math.sin(w) / (2 * q);
    return biquad(alpha, 0, -alpha, 1 + alpha, -2 * Math.cos(w), 1 - alpha);
  };
  const highpass = (f: number) => {
    const w = (TAU * f) / SR;
    const alpha = Math.sin(w) / (2 * Math.SQRT1_2);
    const c = Math.cos(w);
    return biquad((1 + c) / 2, -(1 + c), (1 + c) / 2, 1 + alpha, -2 * c, 1 - alpha);
  };

  // A pitched body around 170 Hz with a band of noise centred near 2 kHz (the crack) and some sizzle.
  const snare = (at: number) => {
    const crack = bandpass(2000, 0.6);
    const sizzle = highpass(5000);
    add(at, 0.28, (t) => {
      const n = noise();
      const body = Math.sin(TAU * (160 * t + (25 / 30) * (1 - Math.exp(-30 * t)))) * Math.exp(-t * 22) * 0.5;
      const noisy = (crack(n) * 1.2 + sizzle(n) * 0.3) * Math.exp(-t * 17);
      return (body + noisy) * Math.min(1, t / 0.002) * 0.62;
    });
  };

  // Noise above about 7 kHz.
  const hat = (at: number, gain: number, pan: number) => {
    const hp1 = highpass(7000);
    const hp2 = highpass(7000);
    add(at, 0.09, (t) => hp2(hp1(noise())) * Math.exp(-t * 70) * gain * 1.6, pan);
  };

  const bass = (at: number, note: number, length: number) => {
    const f = midi(note);
    let lp = 0;
    add(at, length, (t) => {
      const saw = 2 * ((t * f) % 1) - 1;
      lp += (saw - lp) * (0.03 + 0.1 * Math.exp(-t * 9));
      const env = Math.min(1, t * 200) * Math.min(1, (length - t) * 60);
      return (lp * 0.9 + Math.sin(TAU * f * t) * 0.5) * env * 0.5;
    });
  };

  const pad = (at: number, notes: number[], length: number) => {
    notes.forEach((note, k) => {
      for (const detune of [-0.07, 0.06]) {
        const f = midi(note + detune);
        let lp = 0;
        add(
          at,
          length,
          (t) => {
            const saw = 2 * ((t * f + k * 0.37) % 1) - 1;
            lp += (saw - lp) * 0.09;
            return lp * Math.min(1, t * 2.5) * Math.min(1, (length - t) * 3) * 0.085;
          },
          detune < 0 ? -0.5 : 0.5,
        );
      }
    });
  };

  const pluck = (at: number, note: number, pan: number) => {
    const f = midi(note);
    add(
      at,
      0.3,
      (t) => {
        const tri = Math.abs(4 * ((t * f) % 1) - 2) - 1;
        return (tri * 0.7 + Math.sin(TAU * f * 2 * t) * 0.3) * Math.exp(-t * 11) * 0.16;
      },
      pan,
    );
  };

  // Am - F - C - G, one bar each.
  const chords = [
    { root: 33, tones: [57, 60, 64, 69] },
    { root: 29, tones: [53, 57, 60, 65] },
    { root: 36, tones: [55, 60, 64, 67] },
    { root: 31, tones: [55, 59, 62, 67] },
  ];
  const arp = [0, 1, 2, 3, 2, 1, 2, 3, 0, 1, 2, 3, 3, 2, 1, 2];

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
      if ((build || full) && step % 2 === 0 && step % 4 !== 0) {
        bass(t, chord.root + (step % 8 === 6 ? 12 : 0), BEAT / 2 - 0.02);
      }
      if (full || breakdown) pluck(t, chord.tones[arp[step]] + 12, step % 2 ? 0.6 : -0.6);
    }
  }

  // Normalise and fade the edges.
  let peak = 0;
  for (let i = 0; i < total; i++) peak = Math.max(peak, Math.abs(L[i]), Math.abs(R[i]));
  const gain = 0.89 / peak;
  const fadeOut = SR * 0.4;
  for (let i = 0; i < total; i++) {
    const g = gain * Math.min(1, i / 200, (total - i) / fadeOut);
    L[i] *= g;
    R[i] *= g;
  }
  return { sampleRate: SR, left: L, right: R };
}

/** 16-bit stereo PCM WAV. */
export function encodeWav({ sampleRate, left, right }: DemoAudio): Uint8Array<ArrayBuffer> {
  const frames = left.length;
  const bytes = new Uint8Array(44 + frames * 4);
  const view = new DataView(bytes.buffer);
  const text = (offset: number, s: string) => {
    for (let i = 0; i < s.length; i++) bytes[offset + i] = s.charCodeAt(i);
  };
  text(0, 'RIFF');
  view.setUint32(4, 36 + frames * 4, true);
  text(8, 'WAVEfmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 2, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 4, true);
  view.setUint16(32, 4, true);
  view.setUint16(34, 16, true);
  text(36, 'data');
  view.setUint32(40, frames * 4, true);
  for (let i = 0; i < frames; i++) {
    view.setInt16(44 + i * 4, Math.round(Math.max(-1, Math.min(1, left[i])) * 32767), true);
    view.setInt16(46 + i * 4, Math.round(Math.max(-1, Math.min(1, right[i])) * 32767), true);
  }
  return bytes;
}
