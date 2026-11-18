// Ground-truth tests for the rhythm analysis (src/audio/analysis.ts +
// rhythm.ts, and the ahead-of-time grid in beatgrid.ts).
//
// Every signal is synthesised with known beat, downbeat, kick, snare, hi-hat
// and drop times. The live analysis is run exactly as the app runs it: one
// FFT frame at a time at about 60 frames a second (with uneven frame times),
// fed through the real Analysis class. Scores are precision, recall and
// F-measure with a ±70 ms tolerance for beats (±50 ms for drum onsets).
//
//   node scripts/rhythm-test.mjs
//
// The last section checks the mix planner (src/player/transitions.ts) on two
// copies of the demo track at different tempos.
//
// Exits non-zero if any target is missed. scripts/verify.cjs runs it too.

const { Analysis, FFT_SIZE } = await import('../src/audio/analysis.ts');
const { analyzeBeatGrid } = await import('../src/audio/beatgrid.ts');
const { synthesizeDemo } = await import('../src/audio/demoSynth.ts');
const { SR, loop, makeSignal, pad, vocal, score } = await import('./rhythm-signals.mjs');

let failures = 0;
const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  if (!ok) failures++;
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${name}${detail ? `  (${detail})` : ''}`);
}

/** Runs the live analysis over a mono signal; returns event times. */
function live(signal, { grid = null, jitter = 0.3, fps = 60 } = {}) {
  const analysis = new Analysis(SR);
  if (grid) analysis.setBeatGrid(grid);
  const left = new Float32Array(FFT_SIZE);
  let seed = 3;
  const rand = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296;
  const ev = { beats: [], downbeats: [], kicks: [], snares: [], hats: [], drops: [], bpm: 0 };
  let time = FFT_SIZE / SR;
  let last = time - 1 / fps;
  while (time * SR < signal.length) {
    const end = Math.floor(time * SR);
    for (let i = 0; i < FFT_SIZE; i++) left[i] = signal[end - FFT_SIZE + i];
    const f = analysis.process(left, left, time - last, grid ? time : undefined);
    last = time;
    if (f.beat) ev.beats.push(time);
    if (f.downbeat) ev.downbeats.push(time);
    if (f.kickHit) ev.kicks.push(time);
    if (f.snareHit) ev.snares.push(time);
    if (f.hatHit) ev.hats.push(time);
    if (f.drop) ev.drops.push(time);
    ev.bpm = f.bpm;
    time += (1 / fps) * (1 + (rand() - 0.5) * jitter);
  }
  return ev;
}

const within = (list, from, to = Infinity) => list.filter((t) => t >= from && t <= to);
const fmt = (s) => `F ${s.f.toFixed(2)}, P ${s.precision.toFixed(2)}, R ${s.recall.toFixed(2)}`;

console.log('\n== Rhythm: ground truth (synthesised signals with known beats) ==');

// ---- steady drum loops: the beat must be found
const loops = [
  { name: 'four-on-the-floor, 120 BPM', bpm: 120, bars: 16 },
  { name: 'backbeat with an off-beat kick, 95 BPM', bpm: 95, bars: 12, style: 'back' },
  { name: 'four-on-the-floor with a singer over it, 128 BPM', bpm: 128, bars: 16, vocals: true },
  { name: 'four-on-the-floor, 105 BPM', bpm: 105, bars: 14 },
];
const kickScores = [];
const snareScores = [];
for (const c of loops) {
  const { buffer, truth } = loop(c);
  const ev = live(buffer);
  const end = truth.beats.at(-1) + 0.3;
  const beats = score(within(ev.beats, 5, end), within(truth.beats, 5, end));
  check(`${c.name}: live beats F >= 0.9 after 5 s`, beats.f >= 0.9, `${fmt(beats)}, ${ev.bpm.toFixed(1)} BPM`);
  kickScores.push(score(within(ev.kicks, 1.5, end), within(truth.kicks, 1.5, end), 0.05));
  snareScores.push(score(within(ev.snares, 1.5, end), within(truth.snares, 1.5, end), 0.05));
  const grid = analyzeBeatGrid(buffer, SR);
  const g = score(within(grid?.beats ?? [], 0, end), truth.beats);
  check(`${c.name}: ahead-of-time grid F >= 0.9`, g.f >= 0.9, `${fmt(g)}, ${grid?.bpm.toFixed(1)} BPM`);
}
const mean = (list, key) => list.reduce((a, s) => a + s[key], 0) / list.length;
check('kicks are told from bass notes (precision >= 0.7, recall >= 0.8)', mean(kickScores, 'precision') >= 0.7 && mean(kickScores, 'recall') >= 0.8, `P ${mean(kickScores, 'precision').toFixed(2)}, R ${mean(kickScores, 'recall').toFixed(2)}`);
check('snares are told from hi-hats and kick clicks (precision >= 0.7, recall >= 0.7)', mean(snareScores, 'precision') >= 0.7 && mean(snareScores, 'recall') >= 0.7, `P ${mean(snareScores, 'precision').toFixed(2)}, R ${mean(snareScores, 'recall').toFixed(2)}`);

// ---- a breakdown and a drop
{
  const { buffer, truth } = loop({ bpm: 140, bars: 20, style: 'back', breakdown: [8, 12] });
  const ev = live(buffer);
  const end = truth.beats.at(-1) + 0.3;
  const beats = score(within(ev.beats, 5, end), within(truth.beats, 5, end));
  check('140 BPM with a four-bar breakdown: the beat carries through it (F >= 0.9)', beats.f >= 0.9, fmt(beats));
  const drop = truth.drops[0];
  check('...the drop is caught when the kick comes back, and nothing else is called a drop', ev.drops.length === 1 && Math.abs(ev.drops[0] - drop) < 0.5, `found ${ev.drops.map((t) => t.toFixed(2)).join(', ') || 'none'}, expected ${drop.toFixed(2)}`);
  const downbeats = score(within(ev.downbeats, 9), within(truth.downbeats, 9));
  check('...and bars are found (downbeats F >= 0.8)', downbeats.f >= 0.8, fmt(downbeats));
}

// ---- the demo track: a real mix with intro, build, breakdown and return
{
  const d = synthesizeDemo(SR);
  const mono = new Float32Array(d.left.length);
  for (let i = 0; i < mono.length; i++) mono[i] = 0.5 * (d.left[i] + d.right[i]);
  const BEAT = 60 / 124;
  const BAR = 4 * BEAT;
  const beats = Array.from({ length: 84 }, (_, i) => i * BEAT);
  const downbeats = beats.filter((_, i) => i % 4 === 0);
  const ev = live(mono);
  const from = 4 * BAR + 3; // the kick enters at bar 4
  const s = score(within(ev.beats, from), within(beats, from));
  check('demo track: live beats F >= 0.9 once the drums are in', s.f >= 0.9, `${fmt(s)}, ${ev.bpm.toFixed(1)} BPM`);
  check('demo track: the drop after the breakdown (bar 18) is caught', ev.drops.some((t) => Math.abs(t - 18 * BAR) < 0.5), `found ${ev.drops.map((t) => t.toFixed(2)).join(', ') || 'none'}, expected ${(18 * BAR).toFixed(2)}`);
  const t0 = performance.now();
  const grid = analyzeBeatGrid(mono, SR);
  const ms = performance.now() - t0;
  const g = score(grid?.beats ?? [], beats);
  check('demo track: the ahead-of-time grid finds the beat (F >= 0.95)', g.f >= 0.95, `${fmt(g)}, ${grid?.bpm.toFixed(2)} BPM, ${ms.toFixed(0)} ms`);
  check('...and where the bars start', Boolean(grid) && downbeats.some((t) => Math.abs(t - grid.beats[grid.downbeat]) < 0.07), grid ? `downbeat at ${grid.beats[grid.downbeat].toFixed(2)} s` : 'no grid');
  if (grid) {
    // (The beat at 0 s comes before the first full analysis window, so it can't be reported.)
    const withGrid = live(mono, { grid });
    const gs = score(within(withGrid.beats, 0.1), within(beats, 0.1));
    const gd = score(within(withGrid.downbeats, 0.1), within(downbeats, 0.1));
    check('demo track played with its grid: every beat and bar lands (F >= 0.98)', gs.f >= 0.98 && gd.f >= 0.98, `beats ${fmt(gs)}; downbeats ${fmt(gd)}`);
  }
}

// ---- no drums: nothing must be called a beat
{
  const v = makeSignal(20);
  vocal(v, 0.2, 19.5, 11);
  let peak = 0;
  for (const x of v) peak = Math.max(peak, Math.abs(x));
  for (let i = 0; i < v.length; i++) v[i] *= 0.8 / peak;
  const ev = live(v);
  check('a singer alone: no beats, kicks or snares', ev.beats.length === 0 && ev.kicks.length === 0 && ev.snares.length <= 1, `${ev.beats.length} beats, ${ev.kicks.length} kicks, ${ev.snares.length} snares`);
  check('...and no beat grid', analyzeBeatGrid(v, SR) === null);
  const p = makeSignal(16);
  const chords = [[57, 60, 64], [53, 57, 60], [55, 60, 64], [55, 59, 62]];
  for (let i = 0; i < 4; i++) pad(p, i * 4, chords[i], 4, 0.1);
  const pe = live(p);
  check('held synth chords alone: no beats, kicks or snares', pe.beats.length === 0 && pe.kicks.length === 0 && pe.snares.length <= 1, `${pe.beats.length} beats, ${pe.kicks.length} kicks, ${pe.snares.length} snares`);
}

// ---- planning a DJ mix between two songs (src/player/transitions.ts)
console.log('\n== Mixing: planning a transition from the beat grids ==');
{
  const { planTransition, camelot, keyDistance } = await import('../src/player/transitions.ts');
  const wheel = (tonic, minor) => {
    const c = camelot({ tonic, minor });
    return `${c.number}${c.letter}`;
  };
  // (Tonic pitch classes count up from A: C is 3, E is 7, G is 10.)
  const keys = [wheel(0, true), wheel(3, false), wheel(7, true), wheel(10, false), wheel(9, true), wheel(4, false)];
  check('keys land on the Camelot wheel (A minor 8A, C major 8B, E minor 9A, G major 9B, F# minor 11A, D-flat major 3B)', keys.join() === '8A,8B,9A,9B,11A,3B', keys.join(', '));
  const k = (tonic, minor) => ({ tonic, minor, confidence: 1 });
  check(
    'neighbouring keys mix (same key, a fifth, the relative major); far ones clash',
    keyDistance(k(0, true), k(0, true)) === 0 && keyDistance(k(0, true), k(7, true)) === 0 && keyDistance(k(0, true), k(3, false)) === 0 && keyDistance(k(0, true), k(6, true)) === 2,
  );

  const mono = (d) => {
    const m = new Float32Array(d.left.length);
    for (let i = 0; i < m.length; i++) m[i] = 0.5 * (d.left[i] + d.right[i]);
    return m;
  };
  const a = synthesizeDemo(SR, 124);
  const b = synthesizeDemo(SR, 118);
  const ga = analyzeBeatGrid(mono(a), SR);
  const gb = analyzeBeatGrid(mono(b), SR);
  const outDuration = a.left.length / SR;
  check('both songs get a grid and a key (the demo is in A minor)', Boolean(ga?.key && gb?.key) && wheel(ga.key.tonic, ga.key.minor) === '8A' && wheel(gb.key.tonic, gb.key.minor) === '8A', `${ga?.bpm.toFixed(2)} and ${gb?.bpm.toFixed(2)} BPM`);
  const near = (t, grid, tol) => grid.beats.some((x) => Math.abs(x - t) < tol);
  for (const style of ['fade', 'blend', 'rise']) {
    const plan = planTransition({ outDuration, outGrid: ga, inGrid: gb, crossfade: 0, mode: 'mix', style });
    if (!plan) {
      check(`${style}: a plan`, false, 'none');
      continue;
    }
    const outIndex = ga.beats.findIndex((t) => Math.abs(t - plan.outStart) < 1e-6);
    const phrase = outIndex >= 0 && (outIndex - ga.downbeat) % 16 === 0;
    const inBar = Math.abs(plan.inStart - gb.beats[gb.downbeat]) < 1e-6;
    // Over the overlap, every beat of the outgoing song must meet a beat of the incoming one.
    const entry = plan.outStart + plan.enterAt;
    const overlapBeats = ga.beats.filter((t) => t >= entry && t <= plan.outStart + plan.length);
    const locked = overlapBeats.filter((t) => near(plan.inStart + (t - entry) * plan.rate, gb, 0.02)).length;
    const beats = Math.round(plan.length / (60 / ga.bpm));
    check(
      `${style}: starts on a phrase of the outgoing song and a downbeat of the incoming one, beats locked, tempo matched`,
      phrase && inBar && locked >= overlapBeats.length - 1 && Math.abs(plan.rate - 124 / 118) < 0.003 && beats === (style === 'blend' ? 32 : 16),
      `${plan.why}; ${locked}/${overlapBeats.length} beats meet`,
    );
  }
  const clash = planTransition({ outDuration, outGrid: ga, inGrid: { ...gb, key: k(6, true) }, crossfade: 0, mode: 'mix', style: 'blend' });
  check('songs in clashing keys get half the overlap', Boolean(clash) && Math.round(clash.length / (60 / ga.bpm)) === 16, clash?.why ?? 'none');
  const slow = { ...gb, bpm: 90, beats: gb.beats.map((t) => t * (118 / 90)) };
  const far = planTransition({ outDuration, outGrid: ga, inGrid: slow, crossfade: 0, mode: 'mix', style: 'fade' });
  check('tempos too far apart: no stretching, just a short overlap on the downbeats', Boolean(far) && far.rate === 1 && far.aligned && Math.round(far.length / (60 / ga.bpm)) <= 8, far?.why ?? 'none');
  const fallback = planTransition({ outDuration, outGrid: ga, inGrid: null, crossfade: 0, mode: 'mix', style: 'blend' });
  check('no grid for the next song yet: a plain crossfade of at least 6 seconds', fallback?.style === 'crossfade' && fallback.length >= 6 && !fallback.aligned);
  const plain = planTransition({ outDuration, outGrid: ga, inGrid: gb, crossfade: 4, mode: 'crossfade', style: 'blend' });
  check('crossfade mode: exactly the chosen length, ending with the song', plain?.style === 'crossfade' && plain.length === 4 && Math.abs(plain.outStart + 4 - outDuration) < 1e-9);
  check('crossfade off: no plan', planTransition({ outDuration, outGrid: ga, inGrid: gb, crossfade: 0, mode: 'crossfade', style: 'fade' }) === null);
}

const passed = results.filter((r) => r.ok).length;
console.log(`\n${passed} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
