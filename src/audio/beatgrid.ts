// Beat grid for a whole file, worked out before (or while) it plays.
//
// Live tracking has to guess from the last few seconds; with the whole file
// in hand the beat can be found exactly. Steps:
//  1. a compact spectrogram (64 log-spaced bands, ~11.6 ms frames),
//  2. median-filter separation, here non-causal (it can look ahead), keeping
//     the percussive part,
//  3. an onset strength curve from its rises, low bands weighted up,
//  4. the tempo from the curve's autocorrelation (with a mild preference for
//     common tempos),
//  5. the beats by dynamic programming: the best chain of onsets spaced about
//     one period apart (after D. Ellis, "Beat Tracking by Dynamic
//     Programming", 2007),
//  6. the downbeat: of the four ways to group beats into bars, the one where
//     bars start with chord changes (12-tone chroma, compared over two beats
//     either side) and kicks rather than backbeat snares.
// It returns null when there is no steady beat to find (no drums), so the
// live tracker, which handles that case, takes over.
//
// Plain TypeScript, no browser APIs: it runs in a Web Worker in the app
// (beatgridWorker.ts) and in Node in the tests.

import { Rhythm, type BeatGrid } from './rhythm.ts';

const FFT = 1024;
const BANDS = 64;
const F_MIN = 30;
const F_MAX = 11000;

function hann(n: number): Float32Array {
  const w = new Float32Array(n);
  for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1));
  return w;
}

/** In-place radix-2 FFT of a real frame (imaginary part starts at zero). */
function makeFft(size: number) {
  const bits = Math.log2(size);
  const rev = new Uint32Array(size);
  for (let i = 0; i < size; i++) {
    let r = 0;
    for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b);
    rev[i] = r;
  }
  const cos = new Float32Array(size / 2);
  const sin = new Float32Array(size / 2);
  for (let i = 0; i < size / 2; i++) {
    cos[i] = Math.cos((2 * Math.PI * i) / size);
    sin[i] = Math.sin((2 * Math.PI * i) / size);
  }
  const re = new Float32Array(size);
  const im = new Float32Array(size);
  return {
    re,
    im,
    run(input: Float32Array) {
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
    },
  };
}

function medianOf(buffer: Float32Array, n: number): number {
  for (let i = 1; i < n; i++) {
    const v = buffer[i];
    let j = i - 1;
    while (j >= 0 && buffer[j] > v) {
      buffer[j + 1] = buffer[j];
      j--;
    }
    buffer[j + 1] = v;
  }
  return n % 2 ? buffer[(n - 1) >> 1] : 0.5 * (buffer[n / 2 - 1] + buffer[n / 2]);
}

/**
 * Kicks and snares per second, from the same detectors the live analysis
 * uses, run over a few excerpts. Music without drums (a singer, a pad) has
 * almost none, and gets no grid.
 */
export function drumHitRate(mono: Float32Array, sampleRate: number): number {
  const size = 2048;
  const window = hann(size);
  const fft = makeFft(size);
  const input = new Float32Array(size);
  const amp = new Float32Array(size / 2);
  const excerpt = Math.round(12 * sampleRate);
  const starts =
    mono.length <= 3 * excerpt ? [0] : [0.25, 0.5, 0.75].map((f) => Math.round(f * (mono.length - excerpt)));
  let hits = 0;
  let seconds = 0;
  for (const start of starts) {
    const rhythm = new Rhythm(sampleRate, size);
    const end = Math.min(mono.length, start + (starts.length === 1 ? mono.length : excerpt));
    const step = sampleRate / 60;
    // The first two seconds settle the detectors' thresholds and aren't counted.
    for (let pos = start + size, n = 0; pos < end; pos += step, n++) {
      const at = Math.floor(pos);
      for (let i = 0; i < size; i++) input[i] = mono[at - size + i] * window[i];
      fft.run(input);
      for (let i = 0; i < size / 2; i++) amp[i] = Math.hypot(fft.re[i], fft.im[i]) * (4 / size);
      const out = rhythm.process(amp, 1 / 60, (pos - start) / sampleRate, 1);
      if (n >= 120) {
        if (out.kickHit) hits++;
        if (out.snareHit) hits++;
      }
    }
    seconds += Math.max(0, (end - start - size) / sampleRate - 2);
  }
  return seconds > 0 ? hits / seconds : 0;
}

export interface BeatGridOptions {
  /** Called now and then with 0..1, for long files. */
  progress?: (fraction: number) => void;
}

/** Finds the beats of a mono signal. Returns null when there is no steady beat to find. */
export function analyzeBeatGrid(mono: Float32Array, sampleRate: number, options: BeatGridOptions = {}): BeatGrid | null {
  const hop = Math.round(sampleRate * 0.0116);
  const frames = Math.floor((mono.length - FFT) / hop);
  if (frames < 300) return null; // under ~3.5 s: nothing to go on
  // No drums, no grid: the live tracker handles music without a beat.
  if (drumHitRate(mono, sampleRate) < 0.5) return null;
  const frameRate = sampleRate / hop;
  const window = hann(FFT);
  const fft = makeFft(FFT);
  const input = new Float32Array(FFT);

  // ---- 1. log-band spectrogram (log-compressed magnitudes)
  const binHz = sampleRate / FFT;
  const top = Math.min(F_MAX, sampleRate / 2 - binHz);
  const bandLo = new Uint16Array(BANDS);
  const bandHi = new Uint16Array(BANDS);
  for (let b = 0; b < BANDS; b++) {
    const f0 = F_MIN * Math.pow(top / F_MIN, b / BANDS);
    const f1 = F_MIN * Math.pow(top / F_MIN, (b + 1) / BANDS);
    bandLo[b] = Math.max(1, Math.floor(f0 / binHz));
    bandHi[b] = Math.max(bandLo[b] + 1, Math.ceil(f1 / binHz));
  }
  const spec = new Float32Array(frames * BANDS);
  let peak = 1e-9;
  for (let t = 0; t < frames; t++) {
    const offset = t * hop;
    for (let i = 0; i < FFT; i++) input[i] = mono[offset + i] * window[i];
    fft.run(input);
    const { re, im } = fft;
    for (let b = 0; b < BANDS; b++) {
      let sum = 0;
      for (let k = bandLo[b]; k < bandHi[b]; k++) sum += re[k] * re[k] + im[k] * im[k];
      const v = Math.sqrt(sum / (bandHi[b] - bandLo[b]));
      spec[t * BANDS + b] = v;
      if (v > peak) peak = v;
    }
    if (options.progress && t % 2000 === 0) options.progress((0.6 * t) / frames);
  }
  const gain = 1000 / peak;
  for (let i = 0; i < spec.length; i++) spec[i] = Math.log1p(spec[i] * gain);

  // 12-tone chroma every fourth frame, from a longer window so low notes resolve.
  const CHROMA_FFT = 4096;
  const CHROMA_STEP = 4;
  const chromaFrames = Math.floor(frames / CHROMA_STEP);
  const chroma = new Float32Array(chromaFrames * 12);
  {
    const cw = hann(CHROMA_FFT);
    const cfft = makeFft(CHROMA_FFT);
    const cin = new Float32Array(CHROMA_FFT);
    const cbin = sampleRate / CHROMA_FFT;
    const kLo = Math.max(1, Math.round(50 / cbin));
    const kHi = Math.round(1000 / cbin);
    const pc = new Uint8Array(kHi + 1);
    for (let k = kLo; k <= kHi; k++) pc[k] = ((Math.round(12 * Math.log2((k * cbin) / 440)) % 12) + 12) % 12;
    for (let c = 0; c < chromaFrames; c++) {
      const centre = c * CHROMA_STEP * hop + FFT / 2;
      const start = centre - CHROMA_FFT / 2;
      for (let i = 0; i < CHROMA_FFT; i++) {
        const idx = start + i;
        cin[i] = idx >= 0 && idx < mono.length ? mono[idx] * cw[i] : 0;
      }
      cfft.run(cin);
      for (let k = kLo; k <= kHi; k++) chroma[c * 12 + pc[k]] += Math.hypot(cfft.re[k], cfft.im[k]);
    }
  }

  // ---- 2 + 3. percussive part, and onset strength from its rises
  const H_HALF = 8;
  const P_HALF = 4;
  const scratch = new Float32Array(2 * H_HALF + 2);
  const percussive = new Float32Array(frames * BANDS);
  const harmonic = new Float32Array(frames * BANDS);
  for (let t = 0; t < frames; t++) {
    for (let b = 0; b < BANDS; b++) {
      let n = 0;
      for (let u = Math.max(0, t - H_HALF); u <= Math.min(frames - 1, t + H_HALF); u++) scratch[n++] = spec[u * BANDS + b];
      const h = medianOf(scratch, n);
      n = 0;
      for (let c = Math.max(0, b - P_HALF); c <= Math.min(BANDS - 1, b + P_HALF); c++) scratch[n++] = spec[t * BANDS + c];
      const p = medianOf(scratch, n);
      const x = spec[t * BANDS + b];
      const mask = (p * p) / (p * p + h * h + 1e-9);
      percussive[t * BANDS + b] = x * mask;
      harmonic[t * BANDS + b] = x * (1 - mask);
    }
    if (options.progress && t % 2000 === 0) options.progress(0.6 + (0.25 * t) / frames);
  }
  const strength = new Float32Array(frames);
  const lowOnset = new Float32Array(frames);
  const midOnset = new Float32Array(frames);
  const lowTop = Math.round((Math.log(160 / F_MIN) / Math.log(top / F_MIN)) * BANDS);
  const midLo = Math.round((Math.log(1200 / F_MIN) / Math.log(top / F_MIN)) * BANDS);
  const midHi = Math.round((Math.log(5000 / F_MIN) / Math.log(top / F_MIN)) * BANDS);
  for (let t = 1; t < frames; t++) {
    let sum = 0;
    let low = 0;
    let mid = 0;
    for (let b = 0; b < BANDS; b++) {
      const d = percussive[t * BANDS + b] - percussive[(t - 1) * BANDS + b];
      if (d > 0) {
        // Low bands carry the beat in most music: weight them up.
        sum += d * (b < lowTop ? 2 : 1);
        if (b < lowTop) low += d;
        if (b >= midLo && b < midHi) mid += d;
      }
    }
    strength[t] = sum;
    lowOnset[t] = low;
    midOnset[t] = mid;
  }
  // Remove the slow trend, keep the peaks.
  const detrended = new Float32Array(frames);
  {
    const half = Math.round(frameRate * 0.4);
    let acc = 0;
    let count = 0;
    let lo = 0;
    let hi = -1;
    for (let t = 0; t < frames; t++) {
      while (hi < Math.min(frames - 1, t + half)) acc += strength[++hi], count++;
      while (lo < t - half) acc -= strength[lo++], count--;
      detrended[t] = Math.max(0, strength[t] - acc / count);
    }
    let sd = 0;
    for (let t = 0; t < frames; t++) sd += detrended[t] * detrended[t];
    sd = Math.sqrt(sd / frames) || 1;
    for (let t = 0; t < frames; t++) detrended[t] /= sd;
  }

  // ---- 4. tempo: autocorrelation with a mild prior around 120 BPM
  const minLag = Math.floor((frameRate * 60) / 190);
  const maxLag = Math.ceil((frameRate * 60) / 60);
  const acf = new Float32Array(2 * maxLag + 2);
  for (let lag = 1; lag < acf.length && lag < frames; lag++) {
    let sum = 0;
    for (let t = lag; t < frames; t++) sum += detrended[t] * detrended[t - lag];
    acf[lag] = sum / (frames - lag);
  }
  let bestLag = 0;
  let best = -Infinity;
  let mean = 0;
  for (let lag = minLag; lag <= maxLag; lag++) {
    const bpm = (60 * frameRate) / lag;
    const prior = Math.exp(-0.5 * (Math.log2(bpm / 120) / 0.9) ** 2);
    const score = (acf[lag] + 0.5 * acf[Math.min(acf.length - 1, 2 * lag)] + 0.25 * acf[lag >> 1]) * prior;
    mean += score;
    if (score > best) {
      best = score;
      bestLag = lag;
    }
  }
  mean /= maxLag - minLag + 1;
  if (!(best > 0) || bestLag === 0) return null;
  const y0 = acf[bestLag - 1];
  const y1 = acf[bestLag];
  const y2 = acf[bestLag + 1];
  const denom = y0 - 2 * y1 + y2;
  const period = denom < 0 ? bestLag + (0.5 * (y0 - y2)) / denom : bestLag;

  // ---- 5. beats by dynamic programming
  const tightness = 400;
  const score = new Float32Array(frames);
  const back = new Int32Array(frames).fill(-1);
  const lo = Math.round(period * 0.5);
  const hi = Math.round(period * 2);
  for (let t = 0; t < frames; t++) {
    let bestPrev = -1;
    let bestValue = 0;
    for (let tau = Math.max(0, t - hi); tau <= t - lo; tau++) {
      const gap = Math.log((t - tau) / period);
      const v = score[tau] - tightness * gap * gap;
      if (bestPrev < 0 || v > bestValue) {
        bestValue = v;
        bestPrev = tau;
      }
    }
    score[t] = detrended[t] + (bestPrev >= 0 ? Math.max(0, bestValue) : 0);
    back[t] = bestPrev >= 0 && bestValue > 0 ? bestPrev : -1;
  }
  // Best end point within the last period, then trace back.
  let end = frames - 1;
  for (let t = Math.max(0, frames - Math.round(period)); t < frames; t++) if (score[t] > score[end]) end = t;
  const beatFrames: number[] = [];
  for (let t = end; t >= 0; t = back[t]) {
    beatFrames.push(t);
    if (back[t] < 0) break;
  }
  beatFrames.reverse();
  if (beatFrames.length < 8) return null;
  options.progress?.(0.95);

  // ---- 6. which beat starts the bar
  const near = (curve: Float32Array, t: number) => {
    let m = 0;
    for (let u = Math.max(0, t - 3); u <= Math.min(frames - 1, t + 3); u++) m = Math.max(m, curve[u]);
    return m;
  };
  // Chroma per beat interval.
  const beatChroma = beatFrames.map((t, i) => {
    const v = new Float32Array(12);
    const end = i + 1 < beatFrames.length ? beatFrames[i + 1] : Math.min(frames, t + Math.round(period));
    for (let c = Math.floor(t / CHROMA_STEP); c < Math.min(chromaFrames, Math.ceil(end / CHROMA_STEP)); c++) {
      for (let p = 0; p < 12; p++) v[p] += chroma[c * 12 + p];
    }
    return v;
  });
  const lowMedian = [...lowOnset].sort((a, b) => a - b)[frames >> 1] + 1e-6;
  const midMedian = [...midOnset].sort((a, b) => a - b)[frames >> 1] + 1e-6;
  const accents = [0, 0, 0, 0];
  for (let i = 2; i + 1 < beatFrames.length; i++) {
    let dot = 0;
    let na = 0;
    let nb = 0;
    for (let p = 0; p < 12; p++) {
      const after = beatChroma[i][p] + beatChroma[i + 1][p];
      const before = beatChroma[i - 2][p] + beatChroma[i - 1][p];
      dot += after * before;
      na += after * after;
      nb += before * before;
    }
    const change = na > 0 && nb > 0 ? 1 - dot / Math.sqrt(na * nb) : 0;
    const t = beatFrames[i];
    const kick = near(lowOnset, t) > 4 * lowMedian ? 1 : 0;
    const snare = near(midOnset, t) > 4 * midMedian ? 1 : 0;
    accents[i % 4] += change * 4 + kick * 0.4 - snare * 0.6;
  }
  let downbeat = 0;
  for (let i = 1; i < 4; i++) if (accents[i] > accents[downbeat]) downbeat = i;

  // Times: a frame's rise is centred half a window in.
  const offset = FFT / 2 / sampleRate;
  const beats = beatFrames.map((t) => t / frameRate + offset);
  // How sure: the tempo's autocorrelation peak against the rest, and how many
  // beats have a drum hit (a strong percussive rise, low or mid) on them.
  let drumBeats = 0;
  for (const t of beatFrames) if (near(lowOnset, t) > 6 * lowMedian || near(midOnset, t) > 6 * midMedian) drumBeats++;
  const drumShare = drumBeats / beatFrames.length;
  const sharpness = Math.max(0, Math.min(1, ((best - mean) / (Math.abs(best) + 1e-9)) * 1.25));
  const confidence = Math.max(0, Math.min(1, sharpness * Math.min(1, drumShare * 1.6)));
  if (confidence < 0.3) return null;
  // Tempo from a straight-line fit through all the beats: far finer than one frame's interval.
  const n = beats.length;
  let sumI = 0, sumT = 0, sumII = 0, sumIT = 0;
  beats.forEach((t, i) => {
    sumI += i;
    sumT += t;
    sumII += i * i;
    sumIT += i * t;
  });
  const slope = (n * sumIT - sumI * sumT) / (n * sumII - sumI * sumI);
  const bpm = 60 / slope;
  options.progress?.(1);
  return { bpm, beats, downbeat, confidence };
}
