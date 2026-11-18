// Shared audio analysis. Every visualizer reads the same AudioFrame, so none of
// them needs to know where the audio comes from or how to interpret an FFT.
//
// Input is raw time-domain PCM (left/right), which keeps this module a pure
// function of its input: the live path feeds it from AnalyserNodes, the test
// harness feeds it synthetic signals, and scripts/rhythm-test.mjs runs it in
// Node against signals with known beats.
//
// The spectrum, band levels and waveform are worked out here; drums, tempo,
// bars, the bassline, vocals, builds and drops come from rhythm.ts.

import { Rhythm, type BeatGrid, type RhythmFrame } from './rhythm.ts';

export const FFT_SIZE = 2048;
/** Number of log-spaced spectrum bands exposed to visualizers. */
export const BANDS = 128;
export const WAVE_SIZE = 1024;
const F_MIN = 32;
const F_MAX = 16000;

/** dB per octave of high-frequency boost, so treble is as visible as bass. */
const TILT_DB_PER_OCTAVE = 4.2;
/** How far below the recent peak a band may sit before it reads as zero. */
const RANGE_DB = 36;
const REF_FLOOR_DB = -58;

/**
 * Everything a visualizer gets from the audio. The rhythm fields (kick,
 * snare, hat, bassline, vocals, brightness, energy, bpm, beatPhase, barPhase,
 * downbeat, build, drop, ...) are documented in rhythm.ts.
 */
export interface AudioFrame extends RhythmFrame {
  /** Seconds of visual time elapsed. */
  time: number;
  dt: number;
  /** Overall loudness, 0..1, auto-gained so quiet sources still register. */
  level: number;
  /** Smoothed band energies, 0..1. */
  bass: number;
  mid: number;
  treble: number;
  /** Transient emphasis per band: jumps on hits, decays within ~150ms. */
  bassHit: number;
  midHit: number;
  trebleHit: number;
  /** 1 on a beat, decaying exponentially to 0. */
  beatPulse: number;
  /** Total beats seen; handy for switching things every N beats. */
  beatCount: number;
  /** 0..1, fades toward 0 when the input is silent. */
  presence: number;
  /** BANDS log-spaced magnitudes, 0..1, with fast attack and slow release. */
  spectrum: Float32Array;
  /** WAVE_SIZE mono samples, -1..1, gain-normalised and trigger-aligned. */
  waveform: Float32Array;
  waveL: Float32Array;
  waveR: Float32Array;
}

class FFT {
  private rev: Uint32Array;
  private cos: Float32Array;
  private sin: Float32Array;
  readonly re: Float32Array;
  readonly im: Float32Array;

  readonly size: number;

  constructor(size: number) {
    this.size = size;
    const bits = Math.log2(size);
    this.rev = new Uint32Array(size);
    for (let i = 0; i < size; i++) {
      let r = 0;
      for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b);
      this.rev[i] = r;
    }
    this.cos = new Float32Array(size / 2);
    this.sin = new Float32Array(size / 2);
    for (let i = 0; i < size / 2; i++) {
      this.cos[i] = Math.cos((2 * Math.PI * i) / size);
      this.sin[i] = Math.sin((2 * Math.PI * i) / size);
    }
    this.re = new Float32Array(size);
    this.im = new Float32Array(size);
  }

  /** In-place forward transform of `input` into `re`/`im`. */
  forward(input: Float32Array) {
    const { size, rev, cos, sin, re, im } = this;
    for (let i = 0; i < size; i++) {
      re[i] = input[rev[i]];
      im[i] = 0;
    }
    for (let half = 1; half < size; half <<= 1) {
      const step = size / (half << 1);
      for (let start = 0; start < size; start += half << 1) {
        for (let k = 0, t = 0; k < half; k++, t += step) {
          const a = start + k;
          const b = a + half;
          const tr = re[b] * cos[t] + im[b] * sin[t];
          const ti = im[b] * cos[t] - re[b] * sin[t];
          re[b] = re[a] - tr;
          im[b] = im[a] - ti;
          re[a] += tr;
          im[a] += ti;
        }
      }
    }
  }
}

function smoothTowards(current: number, target: number, dt: number, attack: number, release: number): number {
  const tau = target > current ? attack : release;
  return current + (target - current) * (1 - Math.exp(-dt / tau));
}

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

interface BandTracker {
  lo: number;
  hi: number;
  value: number;
  average: number;
  hit: number;
}

export class Analysis {
  readonly frame: AudioFrame;
  /** 8-bit copies of the spectrum and waveform, ready to upload as textures. */
  readonly spectrumBytes = new Uint8Array(BANDS);
  readonly waveBytes = new Uint8Array(WAVE_SIZE * 4);

  private fft = new FFT(FFT_SIZE);
  private window = new Float32Array(FFT_SIZE);
  private mono = new Float32Array(FFT_SIZE);
  private windowed = new Float32Array(FFT_SIZE);
  private amp = new Float32Array(FFT_SIZE / 2);
  private bandLo = new Float32Array(BANDS);
  private bandHi = new Float32Array(BANDS);
  private bandTilt = new Float32Array(BANDS);
  private instant = new Float32Array(BANDS);
  private refDb = REF_FLOOR_DB;
  private wavePeak = 0.05;

  private bass: BandTracker;
  private mid: BandTracker;
  private treble: BandTracker;


  private readonly sampleRate: number;
  private readonly rhythm: Rhythm;

  constructor(sampleRate: number) {
    this.sampleRate = sampleRate;
    this.rhythm = new Rhythm(sampleRate, FFT_SIZE);
    for (let i = 0; i < FFT_SIZE; i++) this.window[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (FFT_SIZE - 1));

    const binHz = sampleRate / FFT_SIZE;
    const top = Math.min(F_MAX, sampleRate / 2 - binHz);
    for (let i = 0; i < BANDS; i++) {
      const f0 = F_MIN * Math.pow(top / F_MIN, i / BANDS);
      const f1 = F_MIN * Math.pow(top / F_MIN, (i + 1) / BANDS);
      this.bandLo[i] = f0 / binHz;
      this.bandHi[i] = f1 / binHz;
      this.bandTilt[i] = TILT_DB_PER_OCTAVE * Math.log2(Math.sqrt(f0 * f1) / 1000);
    }

    const bandOf = (hz: number) =>
      Math.max(0, Math.min(BANDS - 1, Math.round((Math.log(hz / F_MIN) / Math.log(top / F_MIN)) * BANDS)));
    const tracker = (loHz: number, hiHz: number): BandTracker => ({
      lo: bandOf(loHz),
      hi: Math.max(bandOf(loHz) + 1, bandOf(hiHz)),
      value: 0,
      average: 0,
      hit: 0,
    });
    this.bass = tracker(32, 150);
    this.mid = tracker(300, 2600);
    this.treble = tracker(4500, 16000);

    this.frame = {
      ...this.rhythm.out,
      time: 0,
      dt: 0,
      level: 0,
      bass: 0,
      mid: 0,
      treble: 0,
      bassHit: 0,
      midHit: 0,
      trebleHit: 0,
      beatPulse: 0,
      beatCount: 0,
      presence: 0,
      spectrum: new Float32Array(BANDS),
      waveform: new Float32Array(WAVE_SIZE),
      waveL: new Float32Array(WAVE_SIZE),
      waveR: new Float32Array(WAVE_SIZE),
    };
  }

  /**
   * Advances the analysis by one visual frame.
   * `left`/`right` hold the most recent FFT_SIZE samples of each channel.
   * `position` is the playback position of the current track, used with a
   * beat grid (setBeatGrid) so beats land exactly.
   */
  process(left: Float32Array, right: Float32Array, dt: number, position?: number): AudioFrame {
    const f = this.frame;
    const { mono, windowed, amp } = this;
    dt = Math.max(1e-4, dt);
    f.dt = dt;
    f.time += dt;

    let peak = 0;
    for (let i = 0; i < FFT_SIZE; i++) {
      const m = 0.5 * (left[i] + right[i]);
      mono[i] = m;
      windowed[i] = m * this.window[i];
      const a = m < 0 ? -m : m;
      if (a > peak) peak = a;
    }

    this.fft.forward(windowed);
    const { re, im } = this.fft;
    const norm = 4 / FFT_SIZE;
    for (let i = 0; i < FFT_SIZE / 2; i++) amp[i] = Math.sqrt(re[i] * re[i] + im[i] * im[i]) * norm;

    this.updateSpectrum(dt);
    this.updateBands(dt);
    const rhythm = this.rhythm.process(amp, dt, f.time, f.presence, position);
    Object.assign(f, rhythm);
    if (rhythm.beat) {
      f.beatPulse = 1;
      f.beatCount++;
    } else {
      f.beatPulse *= Math.exp(-dt * 5.5);
    }
    this.updateWaveform(left, right, dt, peak);

    f.presence = smoothTowards(f.presence, peak > 0.002 ? 1 : 0, dt, 0.15, 0.8);
    return f;
  }

  private updateSpectrum(dt: number) {
    const { amp, instant, bandLo, bandHi, bandTilt } = this;
    const spectrum = this.frame.spectrum;
    let framePeakDb = -200;
    for (let i = 0; i < BANDS; i++) {
      const lo = bandLo[i];
      const hi = bandHi[i];
      let a: number;
      if (hi - lo < 1) {
        // Narrower than one FFT bin: interpolate so low bands don't stair-step.
        const c = (lo + hi) * 0.5;
        const i0 = Math.floor(c);
        const t = c - i0;
        a = amp[i0] * (1 - t) + amp[Math.min(i0 + 1, amp.length - 1)] * t;
      } else {
        a = 0;
        const end = Math.min(amp.length - 1, Math.ceil(hi));
        for (let b = Math.floor(lo); b < end; b++) if (amp[b] > a) a = amp[b];
      }
      const db = 20 * Math.log10(a + 1e-9) + bandTilt[i];
      instant[i] = db;
      if (db > framePeakDb) framePeakDb = db;
    }

    // Auto-gain: the loudest recent band defines the top of the scale, so a
    // quiet capture and a loud master both fill the display.
    this.refDb = Math.max(REF_FLOOR_DB, framePeakDb, this.refDb - 2.5 * dt);
    const bottom = this.refDb - RANGE_DB;
    let sum = 0;
    for (let i = 0; i < BANDS; i++) {
      let v = clamp01((instant[i] - bottom) / RANGE_DB);
      v = Math.pow(v, 1.55); // contrast: typical content sits low, peaks still reach 1
      instant[i] = v;
      const s = smoothTowards(spectrum[i], v, dt, 0.012, 0.16);
      spectrum[i] = s;
      sum += s;
      this.spectrumBytes[i] = (s * 255) | 0;
    }
    this.frame.level = smoothTowards(this.frame.level, clamp01((sum / BANDS) * 1.6), dt, 0.03, 0.25);
  }

  private trackBand(t: BandTracker, dt: number) {
    let sum = 0;
    for (let i = t.lo; i < t.hi; i++) sum += this.instant[i];
    const inst = sum / (t.hi - t.lo);
    t.value = smoothTowards(t.value, inst, dt, 0.018, 0.2);
    t.average = smoothTowards(t.average, inst, dt, 0.9, 0.9);
    const jump = clamp01((inst - t.average) * 3.2);
    t.hit = Math.max(jump, t.hit * Math.exp(-dt * 7));
  }

  private updateBands(dt: number) {
    const f = this.frame;
    this.trackBand(this.bass, dt);
    this.trackBand(this.mid, dt);
    this.trackBand(this.treble, dt);
    f.bass = this.bass.value;
    f.mid = this.mid.value;
    f.treble = this.treble.value;
    f.bassHit = this.bass.hit;
    f.midHit = this.mid.hit;
    f.trebleHit = this.treble.hit;
  }

  private updateWaveform(left: Float32Array, right: Float32Array, dt: number, peak: number) {
    const f = this.frame;
    const mono = this.mono;
    this.wavePeak = Math.max(0.02, peak, this.wavePeak * Math.exp(-dt / 3));
    const gain = Math.min(40, 0.92 / this.wavePeak);

    // Start at a rising zero crossing so periodic signals hold still.
    let start = 0;
    const limit = FFT_SIZE - WAVE_SIZE - 4;
    for (let i = 2; i < limit; i++) {
      const a = mono[i - 2] + mono[i - 1];
      const b = mono[i] + mono[i + 1];
      if (a < 0 && b >= 0) {
        start = i;
        break;
      }
    }

    const bytes = this.waveBytes;
    for (let i = 0; i < WAVE_SIZE; i++) {
      const j = start + i;
      const m = Math.max(-1, Math.min(1, mono[j] * gain));
      const l = Math.max(-1, Math.min(1, left[j] * gain));
      const r = Math.max(-1, Math.min(1, right[j] * gain));
      f.waveform[i] = m;
      f.waveL[i] = l;
      f.waveR[i] = r;
      const o = i * 4;
      bytes[o] = (m * 0.5 + 0.5) * 255;
      bytes[o + 1] = (l * 0.5 + 0.5) * 255;
      bytes[o + 2] = (r * 0.5 + 0.5) * 255;
      bytes[o + 3] = 255;
    }
  }

  get rate() {
    return this.sampleRate;
  }

  /** Beats and bars worked out ahead of time for the current track (local files), or null. */
  setBeatGrid(grid: BeatGrid | null) {
    this.rhythm.setGrid(grid);
  }

  get hasBeatGrid() {
    return this.rhythm.hasGrid;
  }
}
