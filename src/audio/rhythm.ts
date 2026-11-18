// Rhythm: what the music is doing, beyond how loud each band is.
//
// Fed one FFT frame at a time (the same frames the spectrum comes from), it
// works out:
//  - which energy is percussive and which is harmonic (median-filter
//    separation, made causal so it adds no delay),
//  - kick, snare and hi-hat onsets, from the percussive part only, so a
//    singer or a held synth chord doesn't fire them,
//  - the bassline, the vocals and leads (harmonic mid-range) and brightness,
//    from the harmonic part,
//  - tempo, where in the beat and the bar the music is, with a confidence
//    (autocorrelation of the onsets for the tempo, a comb template for the
//    phase, smoothed by a phase-locked loop so beats land on the grid even
//    through a breakdown),
//  - energy relative to the rest of the track, build-ups and drops.
// When a local file has been analysed ahead of time (beatgrid.ts), beats and
// bars come from that grid instead: exact, with no warm-up.
//
// Plain TypeScript with no browser APIs, so scripts/rhythm-test.mjs can run
// it in Node against signals with known beat times.

/** Beat times worked out ahead of time for a whole file. */
export interface BeatGrid {
  bpm: number;
  /** Beat times in seconds, ascending. */
  beats: number[];
  /** Index into `beats` of a downbeat; bars are four beats from there. */
  downbeat: number;
  /** 0..1: how regular the beat is. */
  confidence: number;
}

export type BeatSource = 'grid' | 'tracked' | 'onsets' | 'none';

export interface RhythmFrame {
  /** 1 on a kick, snare or hi-hat onset, decaying to 0 (kick ~0.25 s, snare ~0.2 s, hat ~0.08 s). */
  kick: number;
  snare: number;
  hat: number;
  /** True only on the frame each onset is detected. */
  kickHit: boolean;
  snareHit: boolean;
  hatHit: boolean;
  /** Harmonic low end (the bassline, not the kick), 0..1, continuous. */
  bassline: number;
  /** Harmonic mid-range: vocals, leads, chords. 0..1, continuous. */
  vocals: number;
  /** Spectral centroid on a log scale, 0 (dark) .. 1 (bright). */
  brightness: number;
  /** Loudness relative to the loudest recent part of the track, 0..1. */
  energy: number;
  /** Tempo in beats per minute, 0 while unknown. */
  bpm: number;
  /** 0..1: how sure the tempo and beat positions are. */
  tempoConfidence: number;
  /** True on the frame a beat lands. */
  beat: boolean;
  /** Position within the current beat, 0..1 (0 = on the beat). */
  beatPhase: number;
  /** Which beat of the bar this is, 0..3 (0 = downbeat). */
  beatInBar: number;
  /** Position within the bar, 0..1. */
  barPhase: number;
  /** True on the frame the first beat of a bar lands. */
  downbeat: boolean;
  /** 0..1: tension of a build-up (more hats and snares, brighter, less low end). */
  build: number;
  /** True on the frame a drop lands (the full low end coming back in). */
  drop: boolean;
  /** 1 on a drop, decaying over about two seconds. */
  dropPulse: number;
  /** Drops so far; visualizers change scene when it changes. */
  dropCount: number;
  /** Where the beats come from. */
  beatSource: BeatSource;
}

const MAX_HZ = 16000;
/** Past frames the harmonic estimate looks at (~150 ms at 60 fps). */
const H_FRAMES = 9;
/** Half-width, in FFT bins, of the across-frequency median for the percussive estimate. */
const P_HALF = 8;
/** The tempo grid: onset strength resampled at this rate. */
const GRID_HZ = 100;
const GRID_SECONDS = 8;
const GRID = GRID_HZ * GRID_SECONDS;
const MIN_BPM = 60;
const MAX_BPM = 190;
/** Delay between a beat in the audio and its showing up in a frame's window. */
const WINDOW_DELAY = 0.012;

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
function smooth(current: number, target: number, dt: number, attack: number, release: number) {
  const tau = target > current ? attack : release;
  return current + (target - current) * (1 - Math.exp(-dt / tau));
}

function median(values: Float32Array, n: number): number {
  // Insertion sort of a short prefix; n is at most ~17.
  for (let i = 1; i < n; i++) {
    const v = values[i];
    let j = i - 1;
    while (j >= 0 && values[j] > v) {
      values[j + 1] = values[j];
      j--;
    }
    values[j + 1] = v;
  }
  return n % 2 ? values[(n - 1) >> 1] : 0.5 * (values[n / 2 - 1] + values[n / 2]);
}

/**
 * Onset picking on one detection function: above an adaptive threshold (the
 * recent median plus a multiple of the median deviation, which the onsets
 * themselves barely move), on the rising edge, with a minimum gap. It re-arms
 * once the function falls back.
 */
class OnsetPicker {
  private values = new Float32Array(96);
  private sorted = new Float32Array(96);
  private index = 0;
  private count = 0;
  private last = -1e9;
  private armed = true;
  private readonly minGap: number;
  private readonly k: number;
  private readonly floor: number;
  /** The threshold used on the last frame. */
  threshold = 0;

  constructor(minGap: number, k: number, floor: number) {
    this.minGap = minGap;
    this.k = k;
    this.floor = floor;
  }

  push(value: number, time: number): boolean {
    const n = this.count;
    let med = 0;
    let mad = 0;
    if (n > 0) {
      const sorted = this.sorted;
      for (let i = 0; i < n; i++) sorted[i] = this.values[i];
      const view = sorted.subarray(0, n).sort();
      med = view[n >> 1];
      for (let i = 0; i < n; i++) view[i] = Math.abs(view[i] - med);
      view.sort();
      mad = view[n >> 1];
    }
    const threshold = med + this.k * mad + this.floor;
    this.threshold = threshold;
    let onset = false;
    if (n >= 12 && this.armed && value > threshold && time - this.last >= this.minGap) {
      onset = true;
      this.last = time;
      this.armed = false;
    } else if (!this.armed && value < med + 0.5 * (threshold - med)) {
      this.armed = true;
    }
    this.values[this.index] = value;
    this.index = (this.index + 1) % this.values.length;
    this.count = Math.min(this.count + 1, this.values.length);
    return onset;
  }
}

interface BandRange {
  lo: number;
  hi: number;
}

export class Rhythm {
  readonly out: RhythmFrame = {
    kick: 0,
    snare: 0,
    hat: 0,
    kickHit: false,
    snareHit: false,
    hatHit: false,
    bassline: 0,
    vocals: 0,
    brightness: 0,
    energy: 0,
    bpm: 0,
    tempoConfidence: 0,
    beat: false,
    beatPhase: 0,
    beatInBar: 0,
    barPhase: 0,
    downbeat: false,
    build: 0,
    drop: false,
    dropPulse: 0,
    dropCount: 0,
    beatSource: 'none',
  };

  /** Raw detection values of the last frame, for tests and tuning. */
  readonly debug = { kick: 0, lowMid: 0, snare: 0, body: 0, hat: 0, kickShare: 0, snareShare: 0, hatShare: 0, mid: 0, flat: 0 };
  private readonly binHz: number;
  private readonly bins: number;
  // Percussive / harmonic separation.
  private history: Float32Array;
  private historyIndex = 0;
  private historyCount = 0;
  private harmLog: Float32Array;
  /** Harmonic energy per pitch class since the last beat: the chord, for spotting changes. */
  private harmChroma: Float32Array;
  private pitchClass: Uint8Array;

  private scratch = new Float32Array(2 * P_HALF + 2);
  private ampRef = 1e-3;
  private powerRef = 1e-9;
  private pastKick = new Float32Array(2);
  private pastSnare = new Float32Array(2);
  private pastHat = new Float32Array(2);
  /** Bands, in FFT bins. */
  private bands: Record<'kick' | 'lowMid' | 'body' | 'snare' | 'hat' | 'bass' | 'vocal' | 'harmFlux', BandRange>;
  private kickPicker = new OnsetPicker(0.12, 3, 1.0);
  private snarePicker = new OnsetPicker(0.12, 3, 1.0);
  private hatPicker = new OnsetPicker(0.06, 3, 1.0);
  /** A rise whose checks haven't passed yet gets one more frame (its shape settles as it enters the window). */
  private kickPending = -1;
  private snarePending = -1;
  // Continuous features.
  private bassRef = 1e-4;
  private vocalRef = 1e-4;
  private loudFast = 0;
  private loudRef = 1e-4;
  // Tempo: onset strength on a fixed-rate grid.
  private grid = new Float32Array(GRID);
  private gridHead = -1;
  private lastStrength = 0;
  private lastGridTime = 0;
  private nextEstimate = 0;
  private acf = new Float32Array(2 * Math.ceil((60 / MIN_BPM) * GRID_HZ) + 4);
  private period = 0;
  private candidate = 0;
  private candidateVotes = 0;
  private acfConfidence = 0;
  // Beat tracking.
  private nextBeat = 0;
  private jumpError = 0;
  private jumpVotes = 0;
  private beatIndex = 0;
  private locked = false;
  /** How well recent kicks and snares fall on the predicted beats, 0..1. */
  private agreement = 0;
  private lastHitAt = -1e9;
  private silentFor = 0;
  /** When sound last started after silence: no drops are called right at the start. */
  private soundSince = 0;
  // Bars.
  private accents = new Float32Array(4);
  private downbeatSlot = 0;
  private chromaRing = [new Float32Array(12), new Float32Array(12), new Float32Array(12), new Float32Array(12)];
  private beatTimes = new Float64Array(4);
  private scratch12a = new Float32Array(12);
  private scratch12b = new Float32Array(12);
  /** Recent kick and snare times, for which beat of the bar they land on. */
  private kickTimes: number[] = [];
  private snareTimes: number[] = [];
  // Builds and drops.
  private lowAvg = 0;
  private lowRef = 0.05;
  private lowGoneFor = 0;
  private lastGap = 0;
  private percRateFast = 0;
  private percRateSlow = 0;
  private brightSlow = 0;
  private lastDrop = -1e9;
  // Ahead-of-time grid.
  private beatGrid: BeatGrid | null = null;
  private gridCursor = 0;
  private lastPosition = -1;

  constructor(sampleRate: number, fftSize: number) {
    this.binHz = sampleRate / fftSize;
    this.bins = Math.min(fftSize / 2 - 1, Math.floor(MAX_HZ / this.binHz));
    this.history = new Float32Array(H_FRAMES * this.bins);
    this.harmLog = new Float32Array(this.bins);
    const band = (lo: number, hi: number): BandRange => ({
      lo: Math.max(1, Math.round(lo / this.binHz)),
      hi: Math.min(this.bins, Math.max(Math.round(lo / this.binHz) + 1, Math.round(hi / this.binHz))),
    });
    this.bands = {
      kick: band(30, 140),
      lowMid: band(150, 600),
      body: band(150, 320),
      snare: band(1000, 5000),
      hat: band(7000, 16000),
      bass: band(35, 160),
      vocal: band(300, 3500),
      harmFlux: band(80, 2000),
    };
    // Pitch class of each bin, so chords are compared regardless of octave.
    this.pitchClass = new Uint8Array(this.bins);
    for (let k = 1; k < this.bins; k++) this.pitchClass[k] = ((Math.round(12 * Math.log2((k * this.binHz) / 440)) % 12) + 12) % 12;
    this.harmChroma = new Float32Array(12);
  }

  /** Beats and bars for the current track, worked out ahead of time; null to go back to live tracking. */
  setGrid(grid: BeatGrid | null) {
    this.beatGrid = grid && grid.beats.length > 1 ? grid : null;
    this.gridCursor = 0;
    this.lastPosition = -1;
  }

  get hasGrid() {
    return this.beatGrid !== null;
  }

  /**
   * One frame. `amp` holds linear FFT magnitudes (a full-scale sine reads
   * about 1), `time` is seconds of audio time, `position` the playback
   * position of the current track when a grid is set.
   */
  process(amp: Float32Array, dt: number, time: number, presence: number, position?: number): RhythmFrame {
    const o = this.out;
    dt = Math.max(1e-4, dt);

    // ---- level reference, so thresholds don't depend on volume
    let framePeak = 0;
    for (let k = 1; k < this.bins; k++) if (amp[k] > framePeak) framePeak = amp[k];
    this.ampRef = Math.max(1e-4, framePeak, this.ampRef * Math.exp(-dt / 6));

    // ---- harmonic / percussive separation (causal median filtering)
    const bins = this.bins;
    const hist = this.history;
    const row = this.historyIndex * bins;
    for (let k = 0; k < bins; k++) hist[row + k] = amp[k];
    this.historyIndex = (this.historyIndex + 1) % H_FRAMES;
    this.historyCount = Math.min(this.historyCount + 1, H_FRAMES);
    const nh = this.historyCount;
    const s = this.scratch;
    const b = this.bands;
    let harmFlux = 0;
    let pKick = 0;
    let pLowMid = 0;
    let pBody = 0;
    let pSnare = 0;
    let logSnare = 0;
    let pHat = 0;
    let bassEnergy = 0;
    let vocalEnergy = 0;
    let centroidNum = 0;
    let loud = 0;
    for (let k = 1; k < bins; k++) {
      // Harmonic: what this bin has held over the last few frames.
      for (let i = 0; i < nh; i++) s[i] = hist[i * bins + k];
      const harmonic = median(s, nh);
      // Percussive: what the neighbouring bins are doing right now (a hit is broadband).
      const lo = Math.max(1, k - P_HALF);
      const hi = Math.min(bins - 1, k + P_HALF);
      let n = 0;
      for (let j = lo; j <= hi; j++) s[n++] = amp[j];
      const percussive = median(s, n);
      const x = amp[k];
      const p2 = percussive * percussive;
      const mask = p2 / (p2 + harmonic * harmonic + 1e-12);
      const perc = x * mask;
      const harm = x - perc;
      const pp = perc * perc;
      if (k < b.kick.hi) {
        if (k >= b.kick.lo) pKick += pp;
      } else if (k < b.lowMid.hi) {
        pLowMid += pp;
        if (k >= b.body.lo && k < b.body.hi) pBody += pp;
      } else if (k >= b.snare.lo && k < b.snare.hi) {
        pSnare += pp;
        // Flatness of the percussive part here: noise (a snare) is flat, overtones (a bass note's attack) are peaky.
        logSnare += Math.log(pp + 1e-20);
      }
      else if (k >= b.hat.lo && k < b.hat.hi) pHat += pp;

      const hl = harm > 1e-7 ? Math.log(harm * 1e7) : 0;
      if (k >= b.harmFlux.lo && k < b.harmFlux.hi) {
        const dh = hl - this.harmLog[k];
        if (dh > 0) harmFlux += dh;
        this.harmChroma[this.pitchClass[k]] += harm;
      }
      this.harmLog[k] = hl;
      if (k >= b.bass.lo && k < b.bass.hi) bassEnergy += harm * harm;
      if (k >= b.vocal.lo && k < b.vocal.hi) vocalEnergy += harm * harm;
      const power = x * x;
      centroidNum += power * k;
      loud += power;
    }
    harmFlux /= b.harmFlux.hi - b.harmFlux.lo;

    // ---- onsets: rises in percussive band power, against two frames back
    this.powerRef = Math.max(1e-12, loud, this.powerRef * Math.exp(-dt / 8));
    const eps = this.powerRef * 1e-5; // 50 dB under the loudest recent frame
    const rise = (now: number, past: Float32Array) => {
      const before = Math.max(past[0], past[1]);
      past[1] = past[0];
      past[0] = now;
      return Math.max(0, Math.log((now + eps) / (before + eps)));
    };
    const kickOdf = rise(pKick, this.pastKick);
    const snareOdf = rise(pSnare, this.pastSnare);
    const hatOdf = rise(pHat, this.pastHat);
    const total = loud + eps;
    // A kick's start is mostly percussive low end with little above 150 Hz;
    // a bass note is mostly harmonic and brings its overtones along.
    const kickShare = pKick / total;
    const lowMidRatio = pLowMid / (pKick + eps);
    // A snare is broadband, with plenty between 1 and 5 kHz; a hi-hat is mostly highs.
    const midHighRatio = pSnare / (pHat + eps);
    const snareShare = (pSnare + pHat + pBody) / total;
    const snareBins = b.snare.hi - b.snare.lo;
    const flatness = pSnare > 0 ? Math.exp(logSnare / snareBins) / (pSnare / snareBins) : 0;
    Object.assign(this.debug, { kick: kickOdf, lowMid: lowMidRatio, snare: snareOdf, body: pBody / total, hat: hatOdf, kickShare, snareShare: midHighRatio, hatShare: pHat / total, mid: pSnare / total, flat: flatness });

    const kickLooks = kickShare > 0.18 && lowMidRatio < 0.85;
    // A snare has both a crack (1-5 kHz) and a body (150-320 Hz); a clap is nearly all crack.
    const bodyShare = pBody / total;
    // A kick's beater click also lands in the crack band, but it is quiet next to the kick itself.
    const crackOverKick = pSnare / (pKick + eps);
    // And it is noise: flat across the band, where a plucked note's overtones are peaks.
    const snareLooks = snareShare > 0.01 && crackOverKick > 0.08 && flatness > 0.25 && (midHighRatio > 0.11 || (midHighRatio > 0.07 && bodyShare > 0.06));
    // When a hit is confirmed on its second frame, it started on the first.
    const kickRise = this.kickPicker.push(kickOdf, time);
    let kickHit = false;
    let kickAt = time;
    if (kickRise) {
      kickHit = kickLooks;
      this.kickPending = kickHit ? -1 : time;
    } else if (this.kickPending >= 0) {
      kickHit = kickLooks && kickOdf > 0.3 * this.kickPicker.threshold;
      kickAt = this.kickPending;
      this.kickPending = -1;
    }
    const snareRise = this.snarePicker.push(snareOdf, time);
    let snareHit = false;
    let snareAt = time;
    if (snareRise) {
      snareHit = snareLooks;
      this.snarePending = snareHit ? -1 : time;
    } else if (this.snarePending >= 0) {
      snareHit = snareLooks && snareOdf > 0.3 * this.snarePicker.threshold;
      snareAt = this.snarePending;
      this.snarePending = -1;
    }
    const hatHit = this.hatPicker.push(hatOdf, time) && pHat / total > 0.002;
    o.kickHit = kickHit;
    o.snareHit = snareHit;
    o.hatHit = hatHit;
    o.kick = kickHit ? 1 : o.kick * Math.exp(-dt * 9);
    o.snare = snareHit ? 1 : o.snare * Math.exp(-dt * 11);
    o.hat = hatHit ? 1 : o.hat * Math.exp(-dt * 26);
    const centroidDen = loud;

    // ---- continuous features
    const bass = Math.sqrt(bassEnergy);
    this.bassRef = Math.max(1e-5, bass, this.bassRef * Math.exp(-dt / 12));
    o.bassline = smooth(o.bassline, clamp01(Math.pow(bass / this.bassRef, 0.8)), dt, 0.05, 0.3);
    const vocal = Math.sqrt(vocalEnergy);
    this.vocalRef = Math.max(1e-5, vocal, this.vocalRef * Math.exp(-dt / 12));
    o.vocals = smooth(o.vocals, clamp01(Math.pow(vocal / this.vocalRef, 0.9)), dt, 0.06, 0.35);
    const centroidHz = centroidDen > 0 ? (centroidNum / centroidDen) * this.binHz : 0;
    const bright = centroidHz > 0 ? clamp01((Math.log2(centroidHz) - Math.log2(250)) / (Math.log2(6000) - Math.log2(250))) : 0;
    o.brightness = smooth(o.brightness, bright, dt, 0.1, 0.4);
    const level = Math.sqrt(loud);
    this.loudFast = smooth(this.loudFast, level, dt, 0.15, 0.6);
    this.loudRef = Math.max(1e-5, this.loudFast, this.loudRef * Math.exp(-dt / 40));
    o.energy = clamp01(this.loudFast / this.loudRef);

    // ---- silence: forget the beat
    this.silentFor = presence < 0.2 ? this.silentFor + dt : 0;
    if (this.silentFor > 2) {
      this.loseLock();
      this.soundSince = time;
    }

    // ---- onset strength for the tempo, on a fixed-rate grid. Kicks and
    // snares count fully; rises that failed their checks (bass notes, hats on
    // their own) count a little, so they can't pull the beat off the drums.
    const capped = (v: number) => Math.min(6, v);
    this.pushGrid(0.15 * capped(kickOdf) + 0.1 * capped(snareOdf) + 0.05 * capped(hatOdf), time);
    // Snares count double: they almost always land on a beat (two and four),
    // where kicks often fall between beats.
    if (kickHit) this.addToGrid(kickAt, 3);
    if (snareHit) this.addToGrid(snareAt, 6);
    if (kickHit || snareHit) this.lastHitAt = time;
    // Recent kicks and snares: evidence for which beat starts the bar.
    if (kickHit) this.kickTimes.push(kickAt);
    if (snareHit) this.snareTimes.push(snareAt);
    while (this.kickTimes.length && this.kickTimes[0] < time - 4) this.kickTimes.shift();
    while (this.snareTimes.length && this.snareTimes[0] < time - 4) this.snareTimes.shift();
    void harmFlux;

    // Tempo and phase are only re-estimated while drums are playing; through
    // a breakdown the beat carries on as it was.
    if (time >= this.nextEstimate && this.gridHead > GRID_HZ * 3 && time - this.lastHitAt < 1.5) {
      this.nextEstimate = time + 0.25;
      this.estimateTempo();
      if (this.period > 0) this.estimatePhase(time);
    }

    // ---- beats
    o.beat = false;
    o.downbeat = false;
    if (this.beatGrid && position !== undefined) {
      this.gridBeats(position, kickHit || snareHit);
    } else {
      this.trackBeats(time, dt, kickHit, snareHit, presence);
    }

    // ---- builds and drops
    this.buildsAndDrops(time, dt, kickHit, snareHit, hatHit);
    return o;
  }

  // ------------------------------------------------------------ tempo

  private pushGrid(strength: number, time: number) {
    const cell = Math.floor(time * GRID_HZ);
    if (this.gridHead < 0) {
      this.gridHead = 0;
      this.lastGridTime = cell;
      this.lastStrength = strength;
      return;
    }
    const steps = Math.min(GRID, cell - this.lastGridTime);
    // Fill the cells since the last frame, interpolating, so frame rate doesn't matter.
    for (let i = 1; i <= steps; i++) {
      const v = this.lastStrength + ((strength - this.lastStrength) * i) / steps;
      this.grid[(this.gridHead + i) % GRID] = v;
    }
    if (steps > 0) {
      this.gridHead += steps;
      this.lastGridTime = cell;
      this.lastStrength = strength;
    } else {
      // Two frames in one cell: keep the stronger.
      const at = this.gridHead % GRID;
      this.grid[at] = Math.max(this.grid[at], strength);
      this.lastStrength = Math.max(this.lastStrength, strength);
    }
  }

  /** Adds a hit to the grid at the time it happened (which may be a frame back). */
  private addToGrid(time: number, value: number) {
    const back = Math.max(0, this.lastGridTime - Math.floor(time * GRID_HZ));
    if (this.gridHead < 0 || back >= GRID - 1) return;
    const at = (((this.gridHead - back) % GRID) + GRID) % GRID;
    this.grid[at] += value;
  }

  /** The grid value `back` cells before the newest, linearly interpolated. */
  private gridAt(back: number): number {
    const i = Math.floor(back);
    const f = back - i;
    const head = this.gridHead;
    const a = this.grid[(((head - i) % GRID) + GRID) % GRID];
    const b = this.grid[(((head - i - 1) % GRID) + GRID) % GRID];
    return a + (b - a) * f;
  }

  private estimateTempo() {
    const n = Math.min(GRID, this.gridHead);
    let mean = 0;
    for (let i = 0; i < n; i++) mean += this.gridAt(i);
    mean /= n;
    let energy = 0;
    for (let i = 0; i < n; i++) energy += (this.gridAt(i) - mean) ** 2;
    if (energy < 1e-6) {
      this.acfConfidence = 0;
      return;
    }
    const minLag = Math.floor((60 / MAX_BPM) * GRID_HZ);
    const maxLag = Math.ceil((60 / MIN_BPM) * GRID_HZ);
    const top = Math.min(this.acf.length - 1, 2 * maxLag);
    for (let lag = minLag >> 1; lag <= top; lag++) {
      let sum = 0;
      for (let i = 0; i + lag < n; i++) sum += (this.gridAt(i) - mean) * (this.gridAt(i + lag) - mean);
      this.acf[lag] = sum / energy;
    }
    // Score each tempo with its double and half (a beat's period lines up with
    // its bars and its eighth notes too), weighted towards common tempos.
    let best = -1e9;
    let bestLag = 0;
    let total = 0;
    let count = 0;
    for (let lag = minLag; lag <= maxLag; lag++) {
      const bpm = (60 * GRID_HZ) / lag;
      const prior = Math.exp(-0.5 * (Math.log2(bpm / 120) / 0.6) ** 2);
      const score = (this.acf[lag] + 0.5 * this.acf[Math.min(top, 2 * lag)] + 0.25 * this.acf[lag >> 1]) * prior;
      total += score;
      count++;
      if (score > best) {
        best = score;
        bestLag = lag;
      }
    }
    const average = total / count;
    // Parabolic refinement around the peak.
    const y0 = this.acf[bestLag - 1] ?? 0;
    const y1 = this.acf[bestLag];
    const y2 = this.acf[bestLag + 1] ?? 0;
    const denom = y0 - 2 * y1 + y2;
    const refined = denom < 0 ? bestLag + (0.5 * (y0 - y2)) / denom : bestLag;
    const period = refined / GRID_HZ;
    this.acfConfidence = clamp01((best - average) / (Math.abs(best) + 0.15) * 1.4);
    if (this.acfConfidence < 0.15) return;

    // Hold on to the current tempo unless another wins several times running.
    if (this.period === 0) {
      this.period = period;
      return;
    }
    const ratio = period / this.period;
    if (Math.abs(ratio - 1) < 0.04) {
      this.period += (period - this.period) * 0.2;
      this.candidateVotes = 0;
    } else if (this.candidate && Math.abs(period / this.candidate - 1) < 0.04) {
      if (++this.candidateVotes >= 4) {
        this.period = period;
        this.candidateVotes = 0;
        this.locked = false;
      }
    } else {
      this.candidate = period;
      this.candidateVotes = 1;
    }
  }

  /** Where the last beat was, from a comb template over the last few seconds. */
  private estimatePhase(time: number) {
    const lag = this.period * GRID_HZ;
    const span = Math.min(this.gridHead, GRID - 2);
    const teeth = Math.max(2, Math.floor(span / lag) - 1);
    let best = -1;
    let bestPhase = 0;
    for (let phase = 0; phase < lag; phase += 1) {
      let score = 0;
      for (let k = 0; k < teeth; k++) {
        // Each tooth takes the best of +-2 cells (onsets jitter by a frame); recent bars count more.
        const at = phase + k * lag;
        const v = Math.max(this.gridAt(at), this.gridAt(Math.max(0, at - 1)), this.gridAt(at + 1), 0.7 * this.gridAt(Math.max(0, at - 2)), 0.7 * this.gridAt(at + 2));
        score += v * (1 - (0.5 * k) / teeth);
      }
      if (score > best) {
        best = score;
        bestPhase = phase;
      }
    }
    // The newest grid cell is "now" minus the analysis window's delay.
    const lastBeat = time - WINDOW_DELAY - bestPhase / GRID_HZ;
    const period = this.period;
    if (!this.locked) {
      this.nextBeat = lastBeat + period;
      while (this.nextBeat < time) this.nextBeat += period;
      this.locked = true;
      return;
    }
    const expectedLast = this.nextBeat - period;
    let error = lastBeat - expectedLast;
    error -= Math.round(error / period) * period;
    // Phase-locked loop: small errors are nudged away; a big one has to be
    // seen three times running before the beat jumps to it.
    if (Math.abs(error) < period * 0.12) {
      this.nextBeat += error * 0.25;
      this.jumpVotes = 0;
    } else if (this.jumpVotes > 0 && Math.abs(error - this.jumpError) < period * 0.1) {
      if (++this.jumpVotes >= 3) {
        this.nextBeat += error;
        this.jumpVotes = 0;
      }
    } else {
      this.jumpError = error;
      this.jumpVotes = 1;
    }
  }

  private loseLock() {
    this.locked = false;
    this.period = 0;
    this.candidate = 0;
    this.candidateVotes = 0;
    this.acfConfidence = 0;
    this.agreement = 0;
    this.gridHead = -1;
    this.grid.fill(0);
    this.accents.fill(0);
  }

  // ------------------------------------------------------------ beats

  private trackBeats(time: number, dt: number, kickHit: boolean, snareHit: boolean, presence: number) {
    const o = this.out;
    const period = this.period;
    // How well kicks and snares line up with the predicted beats (or half-beats).
    if (this.locked && (kickHit || snareHit)) {
      const sinceBeat = time - (this.nextBeat - period);
      const offset = Math.abs(sinceBeat - Math.round(sinceBeat / (period / 2)) * (period / 2));
      this.agreement += ((offset < 0.07 ? 1 : 0) - this.agreement) * 0.15;
    }
    // Without drums the beat fades out after a few bars (a breakdown keeps it for a while).
    if (time - this.lastHitAt > 2 * Math.max(period, 0.4)) this.agreement *= Math.exp(-dt / 7);
    const confidence = this.locked ? clamp01(Math.min(this.acfConfidence * 1.5, 1) * this.agreement * 1.3) : 0;
    o.tempoConfidence = smooth(o.tempoConfidence, confidence, dt, 0.4, 0.4);
    o.bpm = this.locked ? 60 / period : 0;

    if (this.locked && o.tempoConfidence > 0.35 && presence > 0.2) {
      o.beatSource = 'tracked';
      if (time >= this.nextBeat) {
        // Skip beats lost to a stall rather than firing them all at once.
        while (this.nextBeat + period <= time) this.nextBeat += period;
        this.nextBeat += period;
        this.onBeat(time);
      }
      o.beatPhase = clamp01(1 - (this.nextBeat - time) / period);
    } else {
      // Not sure of the tempo: kicks are the beats.
      o.beatSource = presence > 0.2 ? 'onsets' : 'none';
      if (this.locked && time >= this.nextBeat) {
        while (this.nextBeat + period <= time) this.nextBeat += period;
        this.nextBeat += period;
      }
      if (kickHit && presence > 0.2) this.onBeat(time);
      o.beatPhase = this.locked ? clamp01(1 - (this.nextBeat - time) / period) : 0;
    }
    o.barPhase = (o.beatInBar + o.beatPhase) / 4;
  }

  /**
   * Counts a beat and learns which beat of the bar is the first: bars start
   * where the harmony changes (chords move on the bar) and with a kick rather
   * than a backbeat snare. Harmony is compared over two beats either side,
   * which copes with slow attacks, so the evidence for a beat is complete two
   * beats later and is credited then.
   */
  private onBeat(time: number) {
    const o = this.out;
    const j = this.beatIndex;
    // The interval that just ended, [beat j-1, beat j).
    const ring = this.chromaRing;
    ring[j % 4].set(this.harmChroma);
    this.harmChroma.fill(0);
    this.beatTimes[j % 4] = time;
    if (j >= 4) {
      const after = this.scratch12a;
      const before = this.scratch12b;
      for (let i = 0; i < 12; i++) {
        after[i] = ring[(j - 1) % 4][i] + ring[j % 4][i];
        before[i] = ring[(j - 3) % 4][i] + ring[(j - 2) % 4][i];
      }
      let dot = 0;
      let na = 0;
      let nb = 0;
      for (let i = 0; i < 12; i++) {
        dot += after[i] * before[i];
        na += after[i] * after[i];
        nb += before[i] * before[i];
      }
      const change = na > 0 && nb > 0 ? 1 - dot / Math.sqrt(na * nb) : 0;
      // The beat between those two windows, two beats ago.
      const target = j - 2;
      const at = this.beatTimes[target % 4];
      const near = (times: number[]) => times.some((t) => Math.abs(t - at) < 0.15 * this.period);
      const accent = change * 4 + (near(this.kickTimes) ? 0.4 : 0) - (near(this.snareTimes) ? 0.6 : 0);
      const slot = target % 4;
      this.accents[slot] = this.accents[slot] * 0.8 + accent;
    }
    let best = this.downbeatSlot;
    for (let i = 0; i < 4; i++) if (this.accents[i] > this.accents[best] * 1.1 + 0.05) best = i;
    this.downbeatSlot = best;
    this.beatIndex++;
    o.beat = true;
    o.beatInBar = (((j - this.downbeatSlot) % 4) + 4) % 4;
    o.downbeat = o.beatInBar === 0;
  }

  private gridBeats(position: number, hit: boolean) {
    const o = this.out;
    const grid = this.beatGrid!;
    const beats = grid.beats;
    // A jump (seek) re-finds the place; otherwise walk forward.
    if (this.lastPosition < 0 || position < this.lastPosition - 0.05 || position > this.lastPosition + 1) {
      let lo = 0;
      let hi = beats.length - 1;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (beats[mid] <= position) lo = mid;
        else hi = mid - 1;
      }
      this.gridCursor = beats[lo] <= position ? lo : -1;
      this.lastPosition = position;
    }
    while (this.gridCursor + 1 < beats.length && beats[this.gridCursor + 1] <= position) {
      this.gridCursor++;
      o.beat = true;
    }
    this.lastPosition = position;
    const i = this.gridCursor;
    const start = i >= 0 ? beats[i] : 0;
    const end = i + 1 < beats.length ? beats[i + 1] : start + 60 / grid.bpm;
    o.beatPhase = i >= 0 ? clamp01((position - start) / Math.max(1e-3, end - start)) : 0;
    o.beatInBar = i >= 0 ? (((i - grid.downbeat) % 4) + 4) % 4 : 0;
    o.downbeat = o.beat && o.beatInBar === 0;
    o.barPhase = (o.beatInBar + o.beatPhase) / 4;
    o.bpm = grid.bpm;
    o.tempoConfidence = grid.confidence;
    o.beatSource = 'grid';
    if (o.beat) this.beatIndex++;
    void hit;
  }

  // ---------------------------------------------------- builds, drops

  private buildsAndDrops(time: number, dt: number, kickHit: boolean, snareHit: boolean, hatHit: boolean) {
    const o = this.out;
    // Low end: the bassline plus kicks, averaged over about a quarter second.
    const low = o.bassline * 0.6 + o.kick * 0.6;
    this.lowAvg = smooth(this.lowAvg, low, dt, 0.25, 0.25);
    this.lowRef = Math.max(0.05, this.lowAvg, this.lowRef * Math.exp(-dt / 40));
    // How long the low end has been mostly gone (a breakdown), with hysteresis.
    if (this.lowAvg < 0.22 * this.lowRef) this.lowGoneFor += dt;
    else if (this.lowAvg > 0.45 * this.lowRef) {
      if (this.lowGoneFor > 0) this.lastGap = this.lowGoneFor;
      this.lowGoneFor = 0;
    }
    // Snares and hats per second, recent against usual: they pile up in a build.
    const perc = (snareHit ? 1 : 0) + (hatHit ? 0.5 : 0);
    this.percRateFast = smooth(this.percRateFast, perc / dt, dt, 1.5, 1.5);
    this.percRateSlow = smooth(this.percRateSlow, perc / dt, dt, 12, 12);
    this.brightSlow = smooth(this.brightSlow, o.brightness, dt, 10, 10);
    const lowRatio = this.lowAvg / this.lowRef;
    const rising = (this.percRateFast / (this.percRateSlow + 0.5) - 1) * 0.7 + (o.brightness - this.brightSlow) * 3;
    const tension = clamp01(rising + Math.min(1, this.lowGoneFor / 8) * 0.5) * clamp01(1.3 - lowRatio);
    o.build = smooth(o.build, tension, dt, 1.2, 0.35);

    // A drop: the first kick after the low end was gone for a couple of seconds or more.
    o.drop = false;
    const gap = this.lowGoneFor > 0 ? this.lowGoneFor : this.lastGap;
    if (kickHit && gap >= 2 && time - this.lastDrop > 8 && time - this.soundSince > 6) {
      o.drop = true;
      o.dropCount++;
      this.lastDrop = time;
      this.lowGoneFor = 0;
      this.lastGap = 0;
      o.dropPulse = 1;
      o.build = 0;
    } else {
      o.dropPulse *= Math.exp(-dt * 1.6);
      // A gap only counts for the kick that ends it.
      if (this.lowGoneFor === 0) this.lastGap = Math.max(0, this.lastGap - dt * 4);
    }
  }
}
