#!/usr/bin/env node
// End-to-end verification in a real Chromium, with audio actually playing.
//
//   node scripts/make-test-audio.mjs          (once: synthesises the test track)
//   npm run dev                               (in another terminal)
//   node scripts/verify.cjs [--only=part,...] [--url=http://127.0.0.1:5173/]
//
// On a machine without a display, wrap it:  xvfb-run -a node scripts/verify.cjs
//
// Parts:
//   visualizers  plays the test track through every visualizer, screenshots
//                each one (docs/screenshots, public/thumbs) and checks it animates
//   reaction     deterministic A/B runs proving each visualizer responds to
//                bass, mids, treble and beats separately
//   player       drives the real UI: files, tags, queue, transport, shortcuts,
//                auto-cycle, idle fade, drag and drop, error handling
//   playlists    Phosphor playlists: mixed sources, nesting, loops refused,
//                play modes, local files reopened after a reload, export/import
//   capture      real getDisplayMedia capture of another tab and of this tab
//   spotify      the Spotify integration against a local simulation of
//                Spotify (see scripts/mocks): sign-in, search, playback, queue
//   apple        the Apple Music integration against a local simulation of MusicKit
//   youtube      the YouTube integration against a local simulation of the
//                IFrame Player API and Data API
//
// Needs Playwright (`npm i -D playwright && npx playwright install chromium`)
// and ffmpeg on PATH for thumbnails. The browser runs headed because tab
// capture and fullscreen do not exist in headless mode.

const { chromium } = require('playwright');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const arg = (name, fallback) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};
const URL_ = arg('url', 'http://127.0.0.1:5173/');
const only = arg('only', 'visualizers,reaction,player,playlists,capture,spotify,apple,youtube').split(',');
const AUDIO = path.resolve('.verify/audio');
const SHOTS = path.resolve('docs/screenshots');
const THUMBS = path.resolve('public/thumbs');
const TRACK = path.join(AUDIO, 'signal-check.mp3');

const GL_ARGS = ['--autoplay-policy=no-user-gesture-required', '--ignore-gpu-blocklist'];
// No GPU here? Fall back to software GL so the run still works (slowly).
if (arg('gpu', 'auto') !== 'native') GL_ARGS.push('--use-angle=swiftshader', '--enable-unsafe-swiftshader');

const results = [];
let failures = 0;
// ------------------------------------------------------------- now playing
//
// Chromium publishes its media session (what macOS shows in Now Playing) on
// Linux over D-Bus as MPRIS. Run under `dbus-run-session` to enable these
// checks; without a session bus they are skipped.

function gdbus(args) {
  return execFileSync('gdbus', ['call', '--session', ...args], { env: { ...process.env, LC_ALL: 'C.UTF-8' } }).toString();
}

function mprisName() {
  if (!process.env.DBUS_SESSION_BUS_ADDRESS) return null;
  try {
    const names = gdbus(['--dest', 'org.freedesktop.DBus', '--object-path', '/org/freedesktop/DBus', '--method', 'org.freedesktop.DBus.ListNames']);
    return (names.match(/org\.mpris\.MediaPlayer2\.chromium[\w.]*/g) || []).pop() ?? null;
  } catch {
    return null;
  }
}

/** What the OS is told is playing: { title, artist, art, status }, or null without D-Bus. */
function nowPlaying() {
  const name = mprisName();
  if (!name) return null;
  const get = (prop) => gdbus(['--dest', name, '--object-path', '/org/mpris/MediaPlayer2', '--method', 'org.freedesktop.DBus.Properties.Get', 'org.mpris.MediaPlayer2.Player', prop]);
  const meta = get('Metadata');
  const field = (key) => (meta.match(new RegExp(`'${key}': <\\[?'((?:[^'\\\\]|\\\\.)*)'`)) || [])[1];
  return {
    title: field('xesam:title') ?? '',
    artist: field('xesam:artist') ?? '',
    art: /'mpris:artUrl': <'[^']+'/.test(meta),
    status: (get('PlaybackStatus').match(/'(\w+)'/) || [])[1] ?? '',
  };
}

/** Presses a media key the way the OS does (MPRIS Next, Previous, Play, Pause). */
function mediaKey(method) {
  const name = mprisName();
  if (name) gdbus(['--dest', name, '--object-path', '/org/mpris/MediaPlayer2', '--method', `org.mpris.MediaPlayer2.Player.${method}`]);
}

/** Polls until Now Playing satisfies `test`, for up to `timeout` ms. */
async function waitNowPlaying(test, timeout = 4000) {
  const end = Date.now() + timeout;
  let last = nowPlaying();
  while (last && !test(last) && Date.now() < end) {
    await new Promise((resolve) => setTimeout(resolve, 200));
    last = nowPlaying();
  }
  return last;
}

const describeNowPlaying = (np) => (np ? `"${np.title}" / "${np.artist}"${np.art ? ' + artwork' : ''} [${np.status}]` : 'no D-Bus session: skipped');

function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  if (!ok) failures++;
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${name}${detail ? `  (${detail})` : ''}`);
}

function watch(page, label) {
  page.on('pageerror', (e) => check(`${label}: no uncaught page errors`, false, e.message.slice(0, 300)));
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    const text = m.text();
    // Expected: the deliberately broken file, and blocked third-party hosts in sandboxes.
    if (/Failed to load resource|net::ERR|broken/.test(text)) return;
    console.log(`  [${label} console error] ${text.slice(0, 300)}`);
  });
}

async function open(context, label = 'app') {
  if (!context.__audioRouted) {
    context.__audioRouted = true;
    // Test audio is served from disk whichever server (dev or preview) hosts the app.
    await context.route('**/.verify/audio/**', (route) => route.fulfill({ path: path.join(AUDIO, path.basename(new URL(route.request().url()).pathname)) }));
  }
  const page = await context.newPage();
  watch(page, label);
  // Record every Web Audio connection so tests can inspect the real graph.
  await page.addInitScript(() => {
    window.__audioEdges = [];
    const connect = AudioNode.prototype.connect;
    AudioNode.prototype.connect = function (destination, ...rest) {
      window.__audioEdges.push([this, destination]);
      return connect.call(this, destination, ...rest);
    };
  });
  await page.goto(URL_);
  await page.waitForFunction(() => window.__phosphor);
  return page;
}

const state = (page) =>
  page.evaluate(() => {
    const { player, renderer, engine, capture } = window.__phosphor;
    const a = renderer.audio;
    return {
      playing: player.playing,
      position: player.position,
      duration: player.duration,
      index: player.currentIndex,
      queue: player.queue.map((t) => ({ title: t.title, artist: t.artist, album: t.album, art: Boolean(t.artworkUrl) })),
      volume: player.volume,
      muted: player.muted,
      shuffle: player.shuffle,
      repeat: player.repeat,
      viz: renderer.currentId,
      input: engine.analysisInput,
      capture: capture.state,
      level: a.level,
      bass: a.bass,
      beats: a.beatCount,
      fps: renderer.stats.fps,
      idle: document.body.classList.contains('idle'),
    };
  });

// ---------------------------------------------------------------- visualizers

async function visualizers(browser) {
  console.log('\n== Visualizers: real audio, one screenshot each ==');
  fs.mkdirSync(SHOTS, { recursive: true });
  fs.mkdirSync(THUMBS, { recursive: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const page = await open(context);
  await page.evaluate(() => window.__phosphor.settings.set({ quality: 'high', autoCycle: false, crossfadeSeconds: 0 }));
  await page.setInputFiles('#file-input', TRACK);
  await page.waitForFunction(() => window.__phosphor.player.playing && window.__phosphor.player.current?.artworkUrl);
  await page.evaluate(() => window.__phosphor.player.setRepeat('one'));
  const hide = await page.addStyleTag({ content: '.hud, .toasts { display: none !important; }' });

  const ids = await page.evaluate(() => window.__phosphor.renderer.defs.map((d) => d.id));
  check('at least twelve visualizers are registered', ids.length >= 12, `${ids.length}`);
  const families = await page.evaluate(() => window.__phosphor.renderer.defs.map((d) => d.family));
  const classic = families.filter((f) => f === 'classic').length;
  check('both families are represented roughly equally', classic >= 5 && ids.length - classic >= 5, `${classic} classic, ${ids.length - classic} modern`);

  for (const id of ids) {
    // Start each one from the same busy passage of the track.
    await page.evaluate((id) => {
      const { player, renderer } = window.__phosphor;
      void player.seek(15.5);
      renderer.setVisualizer(id, { immediate: true });
    }, id);
    // MilkDrop loads its presets on demand; simulations need a moment to develop.
    await page.waitForTimeout(id === 'milkdrop' ? 9000 : 6500);
    const a = await page.screenshot();
    await page.waitForTimeout(450);
    const b = await page.screenshot();
    const s = await state(page);
    const file = path.join(SHOTS, `${id}.png`);
    fs.writeFileSync(file, b);
    execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', file, '-vf', 'scale=480:270:flags=lanczos', '-q:v', '4', path.join(THUMBS, `${id}.jpg`)]);
    check(`${id}: renders and animates with audio playing`, s.viz === id && s.playing && s.level > 0.05 && !a.equals(b), `level ${s.level.toFixed(2)}, ${s.fps.toFixed(0)} fps here`);
  }
  await hide.evaluate((el) => el.remove());
  await context.close();
}

// ------------------------------------------------------------------- reaction

async function reaction(browser) {
  console.log('\n== Reaction: each visualizer vs. isolated bass / mid / treble / beat ==');
  const context = await browser.newContext({ viewport: { width: 640, height: 360 } });
  const page = await open(context);

  // First make sure the stimuli isolate what they claim to.
  const an = {};
  for (const s of ['bass', 'mid', 'treble']) an[s] = await page.evaluate((s) => window.__phosphor.harness.analyse(s), s);
  check('analysis: kick drum registers as bass only, with beats', an.bass.bass > 0.05 && an.bass.treble < 0.01 && an.bass.beatCount >= 3, JSON.stringify(an.bass, (k, v) => (typeof v === 'number' ? +v.toFixed(3) : v)));
  check('analysis: chord registers as mid only, no beats', an.mid.mid > 0.05 && an.mid.bass < 0.01 && an.mid.treble < 0.01 && an.mid.beatCount === 0);
  check('analysis: hi-hat registers as treble only, no beats', an.treble.treble > 0.05 && an.treble.bass < 0.01 && an.treble.beatCount === 0);

  const ids = await page.evaluate(() => window.__phosphor.renderer.defs.map((d) => d.id));
  const table = [];
  console.log(`  ${'visualizer'.padEnd(11)} ${['bass', 'mid', 'treble', 'beat', 'motion'].map((h) => h.padStart(7)).join(' ')}   (mean pixel change vs. silence, 0-255)`);
  for (const id of ids) {
    const row = { id };
    for (const s of ['bass', 'mid', 'treble', 'full']) {
      const r = await page.evaluate(([id, s]) => window.__phosphor.harness.reaction(id, s, 150), [id, s]);
      row[s] = r.difference;
      if (s === 'full') row.motion = r.motion;
    }
    row.beat = (await page.evaluate((id) => window.__phosphor.harness.beatReaction(id, 143), id)).difference;
    table.push(row);
    console.log(`  ${id.padEnd(11)} ${[row.bass, row.mid, row.treble, row.beat, row.motion].map((v) => v.toFixed(2).padStart(7)).join(' ')}`);
    check(`${id}: reacts to bass, mids and treble individually`, row.bass > 0.8 && row.mid > 0.8 && row.treble > 0.8);
    // MilkDrop presets do their own beat analysis on the waveform they are given,
    // so withholding our beat flag changes nothing; its bass response covers it.
    if (id !== 'milkdrop') check(`${id}: reacts to beats beyond the bass level itself`, row.beat > 0.5, row.beat.toFixed(2));
    check(`${id}: moves while audio plays`, row.motion > 0.5, row.motion.toFixed(2));
  }
  fs.mkdirSync('.verify', { recursive: true });
  fs.writeFileSync('.verify/reaction.json', JSON.stringify(table, null, 2));
  await context.close();
}

// --------------------------------------------------------------------- player

async function player(browser) {
  console.log('\n== Player and interface ==');
  const context = await browser.newContext({ viewport: { width: 1440, height: 810 }, deviceScaleFactor: 2 });
  const page = await open(context);
  await page.evaluate(() => window.__phosphor.settings.set({ quality: 'medium', autoHide: 'fullscreen', autoCycle: false, visualizer: 'bars' }));
  await page.evaluate(() => window.__phosphor.renderer.setVisualizer('bars', { immediate: true }));
  const key = async (k, wait = 250) => {
    await page.keyboard.press(k);
    await page.waitForTimeout(wait);
  };

  check('starts on the welcome card with nothing playing', await page.isVisible('.welcome:not(.gone)'));
  const tiles = await page.$$eval('.service-tile', (els) => els.map((e) => `${e.dataset.service}: ${e.querySelector('.service-state').textContent}`));
  check('the first screen offers Spotify, Apple Music and YouTube with their state', tiles.join() === 'spotify: Set up (needs Premium),apple: Set up,youtube: Paste a link', tiles.join(' | '));
  await page.click('.service-tile[data-service="spotify"]');
  await page.waitForTimeout(500);
  check('an unconfigured service tile opens its setup', await page.isVisible('.sheet[aria-label="Settings"] >> text=Client ID'));
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
  await page.click('.service-tile[data-service="youtube"]');
  await page.waitForTimeout(500);
  check('a ready service tile opens that service', await page.isVisible('.tab.active[data-id="youtube"]'));
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
  await page.evaluate(() => (document.activeElement instanceof HTMLElement ? document.activeElement.blur() : undefined));
  await page.screenshot({ path: path.join(SHOTS, 'ui-welcome.png') });

  // ---- files, tags and artwork
  const files = ['mp3', 'flac', 'ogg', 'wav', 'm4a'].map((ext) => path.join(AUDIO, `signal-check.${ext}`)).filter((f) => fs.existsSync(f));
  await page.setInputFiles('#file-input', files);
  await page.waitForFunction(() => window.__phosphor.player.playing && window.__phosphor.player.position > 0.5, null, { timeout: 15000 });
  // Tags load in the background, two files at a time; wait for every tagged file (all but the WAV).
  const tagged = files.filter((f) => !f.endsWith('.wav')).length;
  await page.waitForFunction((n) => window.__phosphor.player.queue.filter((t) => t.artist).length >= n, tagged, { timeout: 15000 }).catch(() => {});
  let s = await state(page);
  check('picked files are queued and the first starts playing', s.queue.length === files.length && s.playing && s.index === 0, `${s.queue.length} tracks`);
  const mp3 = s.queue.find((t) => /MP3/.test(t.title));
  check('MP3 tags and embedded cover art are read', Boolean(mp3 && mp3.artist === 'Phosphor Test Signal' && mp3.album === 'Verification Suite' && mp3.art));
  const flac = s.queue.find((t) => /FLAC/.test(t.title));
  check('FLAC tags and embedded cover art are read', Boolean(flac && flac.artist && flac.art));
  check('OGG tags are read', s.queue.some((t) => /OGG/.test(t.title) && t.artist));
  check('untagged WAV falls back to its file name', s.queue.some((t) => t.title === 'signal-check'));
  check('audio reaches the analysers', s.level > 0.05 && s.input === 'local', `level ${s.level.toFixed(2)}`);
  const accent = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--accent').trim());
  check('interface accent colour is taken from the artwork', accent !== 'rgb(255 61 129)' && accent !== '#ff3d81', accent);
  check('media session shows the current track', await page.evaluate(() => navigator.mediaSession.metadata?.title === window.__phosphor.player.current.title));
  {
    const title = await page.evaluate(() => window.__phosphor.player.current.title);
    const np = await waitNowPlaying((n) => n.title === title);
    if (np) check('Now Playing (as the OS sees it) shows the local track', np.title === title && np.artist === 'Phosphor Test Signal' && np.art, describeNowPlaying(np));
  }

  // Each format must actually decode and play in this browser.
  for (let i = 0; i < files.length; i++) {
    await page.evaluate((i) => void window.__phosphor.player.playTrack(window.__phosphor.player.queue[i].id), i);
    const ok = await page
      .waitForFunction((i) => window.__phosphor.player.currentIndex === i && window.__phosphor.player.position > 0.4 && window.__phosphor.renderer.audio.level > 0.02, i, { timeout: 8000 })
      .then(() => true, () => false);
    const title = (await state(page)).queue[i]?.title;
    const ext = /\((\w+)\)/.exec(title)?.[1] ?? 'WAV';
    // Chromium (unlike Chrome and Edge) ships without the AAC decoder.
    if (!ok && ext === 'M4A') console.log('   --   M4A did not decode here: this Chromium build has no AAC decoder (Chrome and Edge do)');
    else check(`${ext} decodes and plays`, ok);
    if (!ok) await page.waitForTimeout(800);
  }
  await page.evaluate(() => void window.__phosphor.player.playTrack(window.__phosphor.player.queue[0].id));
  await page.waitForFunction(() => window.__phosphor.player.currentIndex === 0 && window.__phosphor.player.position > 0.3);
  await page.mouse.move(720, 420);
  await page.waitForTimeout(700);
  await page.screenshot({ path: path.join(SHOTS, 'ui-playing.png') });

  // ---- transport by keyboard
  await key('Space');
  check('Space pauses', !(await state(page)).playing);
  await key('Space');
  check('Space resumes', (await state(page)).playing);
  await key('n', 900);
  check('N goes to the next track', (await state(page)).index === 1);
  await key('p', 900);
  check('P goes back to the previous track', (await state(page)).index === 0);
  const before = (await state(page)).position;
  await key('l', 500);
  check('L seeks forward ten seconds', (await state(page)).position - before > 8);
  await key('p', 500);
  check('P restarts the track when more than 3s in', (await state(page)).position < 3 && (await state(page)).index === 0);
  const v0 = (await state(page)).volume;
  await key('ArrowDown');
  await key('ArrowDown');
  check('Arrow down lowers the volume', (await state(page)).volume < v0 - 0.05);
  await key('ArrowUp');
  await key('ArrowUp');
  await key('m');
  check('M mutes', (await state(page)).muted);
  await key('m');
  await key('s');
  check('S turns shuffle on', (await state(page)).shuffle);
  await key('s');
  await key('r');
  check('R cycles repeat', (await state(page)).repeat === 'all');
  await key('r');
  await key('r');
  check('repeat returns to off', (await state(page)).repeat === 'off');

  // ---- seek bar and auto-advance
  await page.evaluate(() => void window.__phosphor.player.seek(window.__phosphor.player.duration - 1.5));
  await page.waitForFunction(() => window.__phosphor.player.currentIndex === 1 && window.__phosphor.player.position > 0.2, null, { timeout: 8000 }).catch(() => {});
  check('the next track starts when one ends', (await state(page)).index === 1 && (await state(page)).playing);

  // ---- visualizer switching
  await page.evaluate(() => window.__phosphor.settings.set({ crossfadeSeconds: 0.8 }));
  const viz0 = (await state(page)).viz;
  await key('ArrowRight', 300);
  const mid = await page.evaluate(() => window.__phosphor.renderer['fade']);
  const viz1 = (await state(page)).viz;
  check('Arrow right switches to the next visualizer', viz1 !== viz0, `${viz0} -> ${viz1}`);
  check('the switch crossfades rather than cutting', mid > 0 && mid < 1, `fade ${Number(mid).toFixed(2)} mid-transition`);
  await page.waitForTimeout(1200);
  await key('ArrowLeft', 1200);
  check('Arrow left switches back', (await state(page)).viz === viz0);
  await key('5', 1200);
  check('number keys jump to a visualizer', (await state(page)).viz === 'kaleido');
  await key('g', 600);
  const cards = await page.locator('.card').count();
  check('the gallery lists every visualizer', cards >= 12, `${cards} cards`);
  await page.screenshot({ path: path.join(SHOTS, 'ui-gallery.png') });
  await page.click('.card[data-id="bars"]');
  await key('Escape', 1200);
  check('picking from the gallery switches visualizer', (await state(page)).viz === 'bars');

  // ---- auto-cycle
  await page.evaluate(() => window.__phosphor.settings.set({ cycleSeconds: 5 }));
  await key('a', 200);
  await page.waitForFunction(() => window.__phosphor.renderer.currentId !== 'bars', null, { timeout: 12000 }).catch(() => {});
  check('auto-cycle moves on by itself', (await state(page)).viz !== 'bars', (await state(page)).viz);
  await key('a', 1200);
  await page.evaluate(() => window.__phosphor.renderer.setVisualizer('bars', { immediate: true }));

  // ---- queue
  await key('q', 600);
  check('Q opens the queue', await page.isVisible('.drawer.open'));
  await page.screenshot({ path: path.join(SHOTS, 'ui-queue.png') });
  const n0 = (await state(page)).queue.length;
  await page.hover('.drawer .row:last-child');
  await page.click('.drawer .row:last-child .row-end .icon-btn');
  check('a track can be removed from the queue', (await state(page)).queue.length === n0 - 1);
  const firstTitle = (await state(page)).queue[0].title;
  await page.evaluate(() => window.__phosphor.player.move(0, 2));
  check('tracks can be reordered', (await state(page)).queue[2].title === firstTitle);
  await page.click('.drawer .row:nth-child(1)');
  await page.waitForTimeout(700);
  check('clicking a queue row plays it', (await state(page)).index === 0 && (await state(page)).playing);
  await key('q', 500);

  // ---- a file that cannot be decoded
  fs.writeFileSync(path.join(AUDIO, 'broken.mp3'), Buffer.from(Array.from({ length: 4000 }, (_, i) => (i * 37) % 251)));
  await page.setInputFiles('#file-input', path.join(AUDIO, 'broken.mp3'));
  await page.evaluate(() => {
    const { player } = window.__phosphor;
    void player.playTrack(player.queue[player.queue.length - 1].id);
  });
  await page.waitForTimeout(1800);
  const toast = await page.locator('.toast.error').first().textContent().catch(() => '');
  check('an undecodable file reports an error instead of hanging', /Couldn't play/.test(toast ?? ''), (toast ?? '').slice(0, 80));
  await page.evaluate(() => {
    const { player } = window.__phosphor;
    player.remove(player.queue[player.queue.length - 1].id);
    void player.playTrack(player.queue[0].id);
  });
  await page.waitForTimeout(600);

  // ---- drag and drop
  const n1 = (await state(page)).queue.length;
  const dt = await page.evaluateHandle(async () => {
    const data = new DataTransfer();
    const blob = await (await fetch('/.verify/audio/signal-check.ogg')).blob();
    data.items.add(new File([blob], 'Dropped Track.ogg', { type: 'audio/ogg' }));
    return data;
  });
  await page.dispatchEvent('body', 'dragenter', { dataTransfer: dt });
  check('dragging files over the window shows the drop target', await page.isVisible('.dropzone.show'));
  await page.dispatchEvent('body', 'drop', { dataTransfer: dt });
  await page.waitForTimeout(800);
  check('dropped files join the queue', (await state(page)).queue.length === n1 + 1);

  // ---- a folder, with a cover image beside untagged files
  const album = path.resolve('.verify/album');
  fs.rmSync(album, { recursive: true, force: true });
  fs.mkdirSync(album, { recursive: true });
  fs.copyFileSync(path.join(AUDIO, 'signal-check.wav'), path.join(album, '10 - Tenth.wav'));
  fs.copyFileSync(path.join(AUDIO, 'signal-check.wav'), path.join(album, '2 - Second.wav'));
  fs.copyFileSync(path.join(AUDIO, 'cover.png'), path.join(album, 'cover.png'));
  const n2 = (await state(page)).queue.length;
  await page.setInputFiles('#folder-input', album);
  await page.waitForFunction((n) => window.__phosphor.player.queue.length === n + 2 && window.__phosphor.player.queue.slice(-2).every((t) => t.artworkUrl), n2, { timeout: 8000 }).catch(() => {});
  s = await state(page);
  const added = s.queue.slice(-2);
  check('a folder is added in natural order (2 before 10)', added.length === 2 && added[0].title === 'Second' && added[1].title === 'Tenth', added.map((t) => t.title).join(', '));
  check("the folder's cover image is used for files without embedded art", added.every((t) => t.art));

  // ---- idle fade
  await page.evaluate(() => window.__phosphor.settings.set({ autoHide: 'always' }));
  await page.mouse.move(700, 300);
  await page.waitForTimeout(400);
  check('the interface is visible right after moving the mouse', !(await state(page)).idle);
  await page.waitForTimeout(4200);
  check('the interface fades out when the mouse rests', (await state(page)).idle);
  await page.screenshot({ path: path.join(SHOTS, 'ui-idle.png') });
  await page.mouse.move(720, 320);
  await page.waitForTimeout(300);
  check('moving the mouse brings it back', !(await state(page)).idle);
  await page.mouse.move(720, 770);
  await page.waitForTimeout(4200);
  check('it stays while the pointer is over the controls', !(await state(page)).idle);

  // ---- fullscreen
  await page.evaluate(() => window.__phosphor.settings.set({ autoHide: 'fullscreen' }));
  await page.mouse.move(700, 300);
  await key('f', 1200);
  const fs1 = await page.evaluate(() => Boolean(document.fullscreenElement));
  check('F enters fullscreen', fs1);
  if (fs1) {
    await page.waitForTimeout(4000);
    check('in fullscreen the interface fades out when idle', (await state(page)).idle);
    await key('f', 800);
    check('F leaves fullscreen', !(await page.evaluate(() => Boolean(document.fullscreenElement))));
  }

  // ---- sheets
  await key('o', 500);
  await page.click('.tab[data-id="capture"]');
  await page.waitForTimeout(300);
  check('the capture panel explains what to pick in the share dialog', (await page.locator('.tab-panel ol li').count()) >= 1);
  await page.screenshot({ path: path.join(SHOTS, 'ui-capture.png') });
  await key('Escape', 300);
  await key(',', 500);
  check('settings open', await page.isVisible('.sheet'));
  await page.screenshot({ path: path.join(SHOTS, 'ui-settings.png') });
  await key('Escape', 300);

  // ---- demo track
  await page.evaluate(() => window.__phosphor.player.clear());
  await page.waitForTimeout(300);
  await page.click('.welcome >> text=Play demo');
  await page.waitForFunction(() => window.__phosphor.player.playing && window.__phosphor.player.position > 0.5, null, { timeout: 20000 }).catch(() => {});
  s = await state(page);
  check('the built-in demo track synthesises and plays', s.playing && s.queue[0]?.title === 'Signal Check' && s.queue[0].art);

  // ---- settings persist
  await page.evaluate(() => window.__phosphor.settings.set({ visualizer: 'terrain', volume: 0.42 }));
  await page.reload();
  await page.waitForFunction(() => window.__phosphor);
  s = await state(page);
  check('settings survive a reload', s.viz === 'terrain' && Math.abs(s.volume - 0.42) < 0.01, `${s.viz}, volume ${s.volume}`);
  await context.close();
}

// ------------------------------------------------------------------ playlists

async function playlists(browser) {
  console.log('\n== Phosphor playlists ==');
  const { installYouTubeMock } = require('./mocks/youtube.cjs');
  const context = await browser.newContext({ viewport: { width: 1440, height: 810 }, deviceScaleFactor: 2, acceptDownloads: true });
  await installYouTubeMock(context);
  // This test browser crashes when a file handle is read back from IndexedDB
  // (real Chrome doesn't). Phosphor lets tests swap its handle store, so here
  // handles are found again by name in the browser's private file system,
  // which survives the reload below just the same.
  await context.addInitScript(() => {
    const load = () => JSON.parse(localStorage.getItem('test.handles') || '{}');
    window.__phosphorHandleStore = {
      async put(record) {
        const map = load();
        map[record.key] = { name: record.handle.name, fileName: record.name, size: record.size };
        localStorage.setItem('test.handles', JSON.stringify(map));
      },
      async get(key) {
        const entry = load()[key];
        if (!entry) return undefined;
        const root = await navigator.storage.getDirectory();
        return { key, handle: await root.getFileHandle(entry.name), name: entry.fileName, size: entry.size };
      },
    };
  });
  const page = await open(context);
  page.on('dialog', (d) => void d.accept());
  await page.evaluate(() => {
    window.__phosphor.settings.set({ quality: 'low', autoShare: false });
    window.__phosphor.renderer.setVisualizer('bars', { immediate: true });
  });
  const lib = (fn, arg) =>
    page.evaluate(([fn, arg]) => new Function('lib', 'app', 'arg', `return (${fn})(lib, app, arg)`)(window.__phosphor.app.library, window.__phosphor.app, arg), [fn.toString(), arg]);

  // Three files opened the plain way (no handle), two stored in the browser's
  // private file system, which gives real reopenable handles like Chrome's pickers do.
  await page.setInputFiles('#file-input', ['mp3', 'flac', 'wav'].map((e) => path.join(AUDIO, `signal-check.${e}`)));
  await page.waitForFunction(() => window.__phosphor.player.queue.length === 3);
  await page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    const put = async (name, url) => {
      const handle = await root.getFileHandle(name, { create: true });
      const writable = await handle.createWritable();
      await writable.write(await (await fetch(url)).blob());
      await writable.close();
      return handle;
    };
    const handles = [await put('opfs-one.mp3', '/.verify/audio/signal-check-short.mp3'), await put('opfs-two.ogg', '/.verify/audio/signal-check.ogg')];
    window.__opfsHandles = handles;
    const files = await Promise.all(handles.map(async (handle) => ({ file: await handle.getFile(), path: handle.name, handle })));
    window.__phosphor.app.addFiles(files, { play: false });
  });
  await page.waitForFunction(() => window.__phosphor.player.queue.length === 5);

  // ---- make a playlist through the Library sheet
  await page.keyboard.press('b');
  await page.waitForTimeout(400);
  check('B opens the Library', await page.isVisible('.sheet[aria-label="Library"]'));
  await page.click('.library-nav .library-new');
  await page.waitForFunction(() => document.querySelector('.playlist-name')?.value.startsWith('New playlist'));
  await page.fill('.playlist-name', 'Everything');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(200);
  await page.click('.tab-panel button:has-text("Whole queue")');
  await page.waitForFunction(() => document.querySelectorAll('.library-items .row').length >= 5, null, { timeout: 8000 }).catch(() => {});
  const rows = await page.locator('.library-items .row').count();
  check('a new playlist takes the whole queue', rows === 5, `${rows} items`);
  const missing = await page.locator('.library-items .row-sub', { hasText: 'needs adding again' }).count();
  check("files that can't be reopened later are flagged (no handle from the browser)", missing === 3, `${missing} flagged`);

  // ---- nesting, and loops refused
  await page.click('.library-nav .library-new');
  await page.waitForFunction(() => document.querySelector('.playlist-name')?.value.startsWith('New playlist'));
  await page.fill('.playlist-name', 'Outer');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(200);
  await page.click('.tab-panel button:has-text("Add playlist inside")');
  await page.waitForTimeout(400);
  check('a playlist can contain another playlist', await page.isVisible('.library-items .row-title >> text=Everything'));
  const loop = await lib(async (lib) => {
    const everything = lib.playlists.find((p) => p.name === 'Everything');
    const outer = lib.playlists.find((p) => p.name === 'Outer');
    try {
      await lib.addPlaylist(everything.id, outer.id);
      return 'allowed';
    } catch (e) {
      return e.message;
    }
  });
  check('putting a playlist inside one it already contains is refused', /would loop/.test(loop), loop);
  await page.click('.library-nav .playlist-tab >> text=Everything');
  await page.waitForTimeout(200);
  const nestOptions = await page.locator('.tab-panel select.compact option').count();
  check('...and the Library only offers playlists that would not loop', nestOptions === 0, `${nestOptions} offered`);

  // ---- play modes
  const order = await lib(async (lib, app) => {
    const p = await lib.create('Mixed');
    const local = app.player.queue.filter((t) => t.handle);
    await lib.addTracks(p.id, [local[0], local[1], { id: 'y1', source: 'youtube', ref: 'aaaaaaaaaaa', title: 'Clip A' }, { id: 'y2', source: 'youtube', ref: 'bbbbbbbbbbb', title: 'Clip B' }]);
    await lib.setMode(p.id, 'interleave');
    const alternate = (await lib.resolve(p.id, app.services)).tracks.map((t) => t.source[0]).join('');
    await lib.setMode(p.id, 'shuffle');
    const shuffled = (await lib.resolve(p.id, app.services)).tracks.length;
    return { alternate, shuffled };
  });
  check('"Alternate sources" takes turns between sources', order.alternate === 'lyly', order.alternate);
  check('"Shuffled" keeps every song', order.shuffled === 4);
  await page.click('.library-nav .playlist-tab >> text=Everything');
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(SHOTS, 'ui-library.png') });

  // ---- after a reload: still there, and local files reopen
  await page.keyboard.press('Escape');
  await page.reload();
  await page.waitForFunction(() => window.__phosphor);
  await page.evaluate(() => window.__phosphor.renderer.setVisualizer('bars', { immediate: true }));
  await page.waitForTimeout(800);
  const names = await lib((lib) => lib.playlists.map((p) => `${p.name}:${p.items.length}`).join(','));
  check('playlists survive a reload', names === 'Everything:5,Outer:1,Mixed:4', names);
  check('saved playlists appear on the first screen', await page.isVisible('.playlist-chips >> text=Everything'));
  await page.keyboard.press('b');
  await page.click('.library-nav .playlist-tab >> text=Outer');
  await page.click('.tab-panel .actions button:has-text("Play")');
  await page.waitForFunction(() => window.__phosphor.player.playing && window.__phosphor.player.position > 0.4, null, { timeout: 10000 }).catch(() => {});
  const s = await state(page);
  const queueNames = await page.evaluate(() => window.__phosphor.player.queue.map((t) => t.file?.name).join(','));
  check('playing a playlist expands the playlists inside it and reopens local files after a reload', s.playing && queueNames === 'opfs-one.mp3,opfs-two.ogg', queueNames);
  const skipped = await page.locator('.toast.error', { hasText: 'needs adding again' }).count();
  check("files Phosphor can't reopen are explained, not silently dropped", skipped >= 1, `${skipped} notes`);

  // ---- add from the queue's playlist button
  await page.keyboard.press('q');
  await page.waitForTimeout(300);
  await page.hover('.drawer .row >> nth=0');
  await page.click('.drawer .row >> nth=0 >> [title="Add to a playlist"]');
  await page.waitForSelector('.menu');
  await page.click('.menu-item >> text=Mixed');
  await page.waitForTimeout(400);
  check("the playlist button on a queue row adds the song", (await lib((lib) => lib.playlists.find((p) => p.name === 'Mixed').items.length)) === 5);
  await page.keyboard.press('q');

  // ---- export, import, and reconnecting files by name and size
  await page.keyboard.press('b');
  await page.click('.library-nav .playlist-tab >> text=Everything');
  const [download] = await Promise.all([page.waitForEvent('download'), page.click('.library-foot button:has-text("Export") >> nth=0')]);
  const exported = fs.readFileSync(await download.path(), 'utf8');
  const data = JSON.parse(exported);
  check('a playlist exports as a portable JSON file', data.format === 'phosphor-playlists' && data.playlists[0].items.length === 5 && !exported.includes('"handleKey": "'), `${data.playlists?.[0]?.items?.length} items`);
  const exportPath = path.resolve('.verify/everything.phosphor.json');
  fs.writeFileSync(exportPath, exported);
  await page.setInputFiles('.library input[type=file]', exportPath);
  await page.waitForTimeout(800);
  const imported = await lib((lib) => lib.playlists.map((p) => p.name).join(','));
  check('importing it creates a copy alongside', imported.includes('Everything (2)'), imported);
  const relinked = await lib(async (lib, app) => {
    const copy = lib.playlists.find((p) => p.name === 'Everything (2)');
    const before = (await lib.resolve(copy.id, app.services)).tracks.length;
    const root = await navigator.storage.getDirectory();
    const opfs = [await root.getFileHandle('opfs-one.mp3'), await root.getFileHandle('opfs-two.ogg')];
    const files = await Promise.all(opfs.map(async (handle) => ({ file: await handle.getFile(), path: handle.name, handle })));
    app.addFiles(files, { play: false });
    await new Promise((r) => setTimeout(r, 800));
    const after = (await lib.resolve(copy.id, app.services)).tracks.length;
    return { before, after };
  });
  check('opening the same files again reconnects an imported playlist', relinked.before === 0 && relinked.after === 2, JSON.stringify(relinked));

  // ---- delete
  await page.keyboard.press('Escape');
  await page.keyboard.press('b');
  await page.click('.library-nav .playlist-tab >> text=Mixed');
  await page.click('.library-foot button:has-text("Delete")');
  await page.waitForTimeout(500);
  const left = await lib((lib) => lib.playlists.map((p) => p.name).join(','));
  check('a playlist can be deleted', !left.split(',').includes('Mixed'), left);
  await context.close();
}

// -------------------------------------------------------------------- capture

async function capture() {
  console.log('\n== System audio capture (real getDisplayMedia) ==');

  // 1. Another tab is playing; share it and check the visualizers follow it.
  {
    const browser = await chromium.launch({ headless: false, args: [...GL_ARGS, '--auto-select-tab-capture-source-by-title=Tone Source'] });
    const context = await browser.newContext({ viewport: { width: 1100, height: 650 } });
    const tone = await open(context, 'source tab');
    await tone.setInputFiles('#file-input', TRACK);
    await tone.waitForFunction(() => window.__phosphor.player.playing);
    await tone.evaluate(() => {
      window.__phosphor.player.setRepeat('one');
      void window.__phosphor.player.seek(15.5);
      setInterval(() => (document.title = 'Tone Source'), 50);
    });
    const page = await open(context);
    // A cheap visualizer keeps the frame rate up under software rendering, so
    // the analysis smoothing runs in real time.
    await page.evaluate(() => {
      window.__phosphor.settings.set({ quality: 'low' });
      window.__phosphor.renderer.setVisualizer('bars', { immediate: true });
    });
    await page.bringToFront();
    await page.waitForTimeout(600);
    let s = await state(page);
    check('before sharing, the other tab is inaudible to the visualizers', s.level < 0.01, `level ${s.level.toFixed(3)}`);
    await page.click('.welcome >> text=System audio');
    await page.click('text=Capture system or tab audio');
    await page.waitForFunction(() => window.__phosphor.capture.state.active, null, { timeout: 10000 }).catch(() => {});
    await page.waitForTimeout(3500);
    s = await state(page);
    check('sharing a tab with audio starts the capture', s.capture.active && s.capture.label === 'Tab audio', JSON.stringify(s.capture));
    check('captured audio drives the analysis', s.input === 'capture' && s.level > 0.05 && s.beats > 0, `level ${s.level.toFixed(2)}, ${s.beats} beats`);
    const tracks = await page.evaluate(() => window.__phosphor.capture['stream'].getTracks().map((t) => `${t.kind}:${t.readyState}:${t.enabled ? 'on' : 'off'}`).sort().join());
    check('the capture keeps its video track alive but disabled (macOS ties system audio to it)', tracks === 'audio:live:on,video:live:off', tracks);
    // "Don't play it back": walk the live Web Audio graph (recorded by the init
    // script below) from the capture source and make sure the speakers cannot be
    // reached except through the permanently silent node that keeps the analysers running.
    const leak = await page.evaluate(() => {
      const { engine } = window.__phosphor;
      const edges = window.__audioEdges;
      const seen = new Set();
      const stack = [engine['captureNode']];
      while (stack.length) {
        const node = stack.pop();
        if (seen.has(node)) continue;
        seen.add(node);
        if (node === engine.context.destination) return true;
        // A gain node held at exactly zero passes nothing on.
        if (node instanceof GainNode && node !== engine['captureTap'] && node.gain.value === 0) continue;
        for (const [from, to] of edges) if (from === node) stack.push(to);
      }
      return false;
    });
    check('captured audio has no audible path to the speakers', leak === false);
    await page.screenshot({ path: path.join(SHOTS, 'ui-capturing.png') });
    await page.click('.chip .icon-btn');
    await page.waitForTimeout(2500);
    s = await state(page);
    check('stopping from the indicator ends the capture', !s.capture.active && s.level < 0.05, `active ${s.capture.active}, level ${s.level.toFixed(3)}, input ${s.input}`);
    await browser.close();
  }

  // 2. Sound made inside this tab but outside the app's own audio graph, which
  //    is exactly how the streaming services' players behave.
  {
    const browser = await chromium.launch({ headless: false, args: [...GL_ARGS, '--auto-accept-this-tab-capture'] });
    const context = await browser.newContext({ viewport: { width: 1100, height: 650 } });
    const page = await open(context);
    await page.evaluate(async () => {
      const blob = await (await fetch('/.verify/audio/signal-check.mp3')).blob();
      const external = new Audio(URL.createObjectURL(blob));
      external.loop = true;
      await external.play();
      external.currentTime = 15.5;
    });
    await page.waitForTimeout(1000);
    let s = await state(page);
    check('a foreign player in the tab is invisible to the analysers on its own', s.level < 0.01, `level ${s.level.toFixed(3)}`);
    const started = await page.evaluate(() => window.__phosphor.capture.startDisplay({ thisTab: true }).then(() => 'ok', (e) => `${e.reason}: ${e.message}`));
    await page.waitForTimeout(3500);
    s = await state(page);
    check("sharing this tab's own audio works", started === 'ok' && s.capture.label === "This tab's audio", started);
    check("this tab's audio then drives the visualizers", s.input === 'capture' && s.level > 0.05, `level ${s.level.toFixed(2)}`);
    await browser.close();
  }
}


// -------------------------------------------------------------------- spotify

async function spotify() {
  console.log('\n== Spotify (against the local simulation in scripts/mocks/spotify.cjs) ==');
  const { installSpotifyMock } = require('./mocks/spotify.cjs');
  const browser = await chromium.launch({ headless: false, args: [...GL_ARGS, '--auto-accept-this-tab-capture'] });
  const context = await browser.newContext({ viewport: { width: 1440, height: 810 } });
  const mock = await installSpotifyMock(context);
  const page = await open(context);
  await page.evaluate(() => {
    window.__phosphor.settings.set({ quality: 'low', autoShare: false });
    window.__phosphor.renderer.setVisualizer('bars', { immediate: true });
  });
  const fake = (fn) => page.evaluate(fn);
  const svc = () => page.evaluate(() => window.__phosphor.app.services.find((s) => s.id === 'spotify').status());

  // ---- before any credentials
  await page.keyboard.press('o');
  await page.click('.tab[data-id="spotify"]');
  check('without a Client ID the panel says setup is needed', await page.isVisible('.tab-panel >> text=needs credentials'));
  check('...and the rest of the app is unaffected', (await svc()).configured === false && (await page.locator('.tab').count()) >= 3);

  // ---- sign in through the real UI: popup -> redirect -> PKCE exchange
  await page.evaluate(() => window.__phosphor.settings.set({ spotifyClientId: 'mock-client-id' }));
  await page.waitForSelector('.tab-panel >> text=Connect Spotify');
  await page.click('.tab-panel >> text=Connect Spotify');
  await page.waitForFunction(() => window.__phosphor.app.services.find((s) => s.id === 'spotify').status().connected, null, { timeout: 15000 }).catch(() => {});
  let st = await svc();
  check('sign-in completes and the player device comes up', st.connected, JSON.stringify(st));
  check("the first screen's Spotify tile shows the connection", (await page.textContent('.service-tile[data-service="spotify"] .service-state')) === 'Connected as Mock Listener');
  check('the authorize request is well formed (PKCE S256, loopback redirect, streaming scope)', mock.log.authorize && mock.log.authorizeProblems.length === 0, JSON.stringify(mock.log.authorizeProblems));
  check('the code verifier matches the challenge (checked the way the server does)', mock.log.pkceVerified);
  check('no client secret is ever sent', mock.log.tokenRequests.every((r) => !('client_secret' in r)));
  check('the signed-in account is shown', st.account === 'Mock Listener' && (await page.isVisible('.tab-panel >> text=Mock Listener')));
  check('the sign-in popup closed itself', context.pages().length === 1, `${context.pages().length} pages open`);
  check('the one-time code is not left in the address bar', !(await page.url()).includes('code='));

  // ---- search
  await page.fill('input[type=search]', 'simulators');
  await page.keyboard.press('Enter');
  await page.waitForSelector('.results .row');
  const rows = await page.locator('.results .row').count();
  check('search lists tracks, albums and playlists (null entries skipped)', rows === 12, `${rows} rows`);
  check('search asks for at most 10 results, as development mode requires', mock.log.apiCalls.some((c) => c.startsWith('GET /search') && c.includes('limit=10')));
  await page.waitForFunction(() => [...document.querySelectorAll('.results .thumb img')].some((img) => img.naturalWidth > 0), null, { timeout: 5000 }).catch(() => {});
  check('result rows show cover art from the service', (await page.locator('.results .thumb img').count()) >= 10);
  check('the tab shows a connected indicator', await page.isVisible('.tab[data-id="spotify"] .status-dot.on'));
  await page.screenshot({ path: path.join(SHOTS, 'ui-spotify.png') });

  // ---- a Phosphor playlist linked to a Spotify playlist stays up to date
  await page.hover('.results .row:has-text("Mock Mix")');
  await page.click('.results .row:has-text("Mock Mix") [title^="Link to a Phosphor playlist"]');
  await page.waitForSelector('.menu');
  await page.click('.menu-item.new');
  await page.waitForTimeout(600);
  const linked = () =>
    page.evaluate(async () => {
      const { library, services } = window.__phosphor.app;
      const p = library.playlists.find((x) => x.items.some((i) => i.kind === 'remote'));
      const { tracks, notes } = await library.resolve(p.id, services);
      return { titles: tracks.map((t) => t.title), notes };
    });
  const before = await linked();
  const undoAdd = mock.addToMockMix(7);
  const after = await linked();
  undoAdd();
  check('a linked Spotify playlist plays its current songs', before.titles.join() === 'Mock Song 4,Mock Song 6', before.titles.join());
  check('...and a song added to it on Spotify shows up the next time it plays', after.titles.join() === 'Mock Song 4,Mock Song 6,Mock Song 8', after.titles.join());

  // ---- play
  await page.click('.results .row:nth-child(2) [title="Play now"]');
  await page.waitForFunction(() => window.__phosphor.player.playing && window.__phosphor.player.position > 0.5, null, { timeout: 10000 }).catch(() => {});
  let s = await state(page);
  const current = await page.evaluate(() => window.__phosphor.player.current);
  check('a Spotify track plays through the SDK device', s.playing && current?.source === 'spotify' && mock.log.playRequests.at(-1)?.device === 'mock-device-1', JSON.stringify(mock.log.playRequests.at(-1)));
  check('title, artist, duration and artwork come from Spotify', current.title === 'Mock Song 1' && current.artist === 'The Simulators' && Math.abs(s.duration - 40.67) < 0.5 && Boolean(current.artworkUrl));
  await page.keyboard.press('Escape');

  // ---- visuals: nothing until the tab is shared
  await page.waitForTimeout(800);
  s = await state(page);
  check('protected audio does not reach the analysers by itself', s.level < 0.01, `level ${s.level.toFixed(3)}`);
  check('the app asks to share this tab', await page.isVisible('.banner:not([hidden])'));
  await page.click(".banner >> text=Share this tab's audio");
  await page.waitForFunction(() => window.__phosphor.capture.state.active, null, { timeout: 10000 }).catch(() => {});
  await page.waitForTimeout(3000);
  s = await state(page);
  check("after sharing, Spotify's audio drives the visualizers", s.capture.active && s.input === 'capture' && s.level > 0.05, `level ${s.level.toFixed(2)}`);
  check('the prompt goes away once sharing', !(await page.isVisible('.banner:not([hidden])')));

  // ---- transport
  await page.keyboard.press('Space');
  await page.waitForTimeout(500);
  check('pause reaches the Spotify player', (await fake(() => window.__fakeSpotify.audio.paused)) && !(await state(page)).playing);
  await page.keyboard.press('Space');
  await page.waitForTimeout(500);
  check('resume reaches the Spotify player', !(await fake(() => window.__fakeSpotify.audio.paused)) && (await state(page)).playing);
  await page.evaluate(() => void window.__phosphor.player.seek(20));
  await page.waitForTimeout(600);
  const pos = await state(page);
  check('seeking moves Spotify and the seek bar agrees', Math.abs((await fake(() => window.__fakeSpotify.audio.currentTime)) - pos.position) < 0.6 && pos.position > 19.5, `position ${pos.position.toFixed(1)}`);
  await page.evaluate(() => window.__phosphor.player.setVolume(0.3));
  await page.waitForTimeout(200);
  check('volume is applied to the Spotify player', Math.abs((await fake(() => window.__fakeSpotify.audio.volume)) - 0.3) < 0.01);
  await page.evaluate(() => window.__phosphor.player.setVolume(0.8));

  // ---- albums, playlists, links
  const added = await page.evaluate(async () => {
    const { app, player } = window.__phosphor;
    const service = app.services.find((s) => s.id === 'spotify');
    const found = await service.search('x');
    const album = await service.tracksOf(found.collections.find((c) => c.kind === 'album'));
    const playlist = await service.tracksOf(found.collections.find((c) => c.kind === 'playlist'));
    const link = await service.resolveLink('https://open.spotify.com/intl-de/track/mock7?si=abc');
    const uri = await service.resolveLink('spotify:album:album1');
    const other = await service.resolveLink('https://example.com/track/1');
    const library = await service.library();
    player.add([...album, ...playlist]);
    return { album: album.map((t) => [t.title, Boolean(t.artworkUrl), t.album]), playlist: playlist.map((t) => t.title), link: link?.tracks[0]?.title, uri: uri?.collections[0]?.title, other, library: library.map((c) => c.title) };
  });
  check('album tracks load, inheriting the album cover', added.album.length === 3 && added.album.every(([, art, album]) => art && album === 'Stand-In Sessions'));
  check('playlist tracks load from the 2026 "items" shape, skipping removed and local entries', added.playlist.join() === 'Mock Song 4,Mock Song 6', added.playlist.join());
  check('pasted track links and spotify: URIs resolve; other links are refused', added.link === 'Mock Song 8' && added.uri === 'Stand-In Sessions' && added.other === null);
  check('the library lists Liked Songs and the user\'s playlists', added.library.join() === 'Liked Songs,Mock Mix', added.library.join());

  // ---- end of track -> next in the shared queue
  await page.evaluate(() => void window.__phosphor.player.seek(window.__phosphor.player.duration - 1.2));
  await page.waitForFunction(() => window.__phosphor.player.currentIndex === 1 && window.__phosphor.player.position > 0.3, null, { timeout: 10000 }).catch(() => {});
  s = await state(page);
  check('when a Spotify track ends the queue advances', s.index === 1 && s.playing, `index ${s.index}`);

  // ---- songs that play all the way to the end, the way they really do
  const queueSpotify = (ids, setup = {}) =>
    page.evaluate(async ([ids, setup]) => {
      Object.assign(window, { __fakeSpotifyAutoplay: false, __fakeSpotifyRelink: false, __fakeSpotifySilentEnd: false, __fakeSpotifyRadioStarted: false }, setup);
      const { app, player } = window.__phosphor;
      const service = app.services.find((x) => x.id === 'spotify');
      const tracks = [];
      for (const id of ids) tracks.push(...(await service.resolveLink('https://open.spotify.com/track/' + id)).tracks);
      player.clear();
      player.add(tracks, { play: true });
    }, [ids, setup]);
  const reachesIndex = (i, timeout = 25000) =>
    page
      .waitForFunction((i) => window.__phosphor.player.currentIndex === i && window.__phosphor.player.playing && window.__phosphor.player.position > 0.3, i, { timeout })
      .then(() => true, () => false);
  const fakeTrack = () => page.evaluate(() => window.__fakeSpotify.track?.uri);

  await queueSpotify(['short1', 'short2', 'short3']);
  await reachesIndex(0, 10000);
  let advanced = await reachesIndex(1);
  await page.waitForTimeout(2500);
  s = await state(page);
  check('a Spotify song that plays to its end by itself starts the next song', advanced && (await fakeTrack()) === 'spotify:track:short2');
  check('...and only once, though Spotify reports the end twice', s.index === 1, `index ${s.index}`);

  await queueSpotify(['short1', 'short2'], { __fakeSpotifyAutoplay: true });
  advanced = await reachesIndex(1);
  await page.waitForTimeout(1500);
  check('with Spotify autoplay on, the next song is still Phosphor\'s', advanced && (await fakeTrack()) === 'spotify:track:short2');

  await queueSpotify(['short1', 'short2'], { __fakeSpotifyAutoplay: 'direct' });
  advanced = await reachesIndex(1);
  await page.waitForTimeout(1500);
  check('if Spotify jumps straight to its own pick, Phosphor stops it and plays its next song', advanced && (await page.evaluate(() => window.__fakeSpotifyRadioStarted)) && (await fakeTrack()) === 'spotify:track:short2');

  await queueSpotify(['short1', 'short2'], { __fakeSpotifyRelink: true });
  const relinkedPlaying = await reachesIndex(0, 10000);
  advanced = await reachesIndex(1);
  check('a relinked copy of a song (different Spotify ID) is followed and still advances', relinkedPlaying && advanced);

  await queueSpotify(['short1', 'short2'], { __fakeSpotifySilentEnd: true });
  advanced = await reachesIndex(1);
  check('even if Spotify says nothing at the end, Phosphor notices and moves on', advanced);

  // ---- Now Playing and media keys, with the audio playing inside Spotify's iframe
  await queueSpotify(['short1', 'short2', 'short3']);
  await reachesIndex(0, 10000);
  let np = await waitNowPlaying((n) => n.title === 'Short Song 1');
  if (np) {
    check('Now Playing shows the Spotify song\'s title, artist and artwork, not the tab title', np.title === 'Short Song 1' && np.artist === 'The Simulators' && np.art, describeNowPlaying(np));
    mediaKey('Next');
    check('the Next media key skips to the next song in Phosphor\'s queue', await reachesIndex(1, 6000));
    np = await waitNowPlaying((n) => n.title === 'Short Song 2');
    check('...and Now Playing follows it', np.title === 'Short Song 2', describeNowPlaying(np));
    mediaKey('Pause');
    await page.waitForTimeout(800);
    np = await waitNowPlaying((n) => n.status === 'Paused');
    check('the Pause media key pauses, and Now Playing still shows the song as paused', !(await state(page)).playing && np.title === 'Short Song 2' && np.status === 'Paused', describeNowPlaying(np));
    mediaKey('Play');
    await page.waitForTimeout(800);
    check('the Play media key resumes', (await state(page)).playing && !(await page.evaluate(() => window.__fakeSpotify.audio.paused)));
  } else {
    console.log('   --   Now Playing checks skipped: run under dbus-run-session to include them');
  }

  // ---- expired access token
  mock.expireTokens();
  const refreshed = await page.evaluate(() => window.__phosphor.app.services.find((s) => s.id === 'spotify').search('again').then((r) => r.tracks.length, (e) => String(e)));
  check('an expired token is refreshed and the request retried', refreshed === 10 && mock.log.tokenRequests.some((r) => r.grant_type === 'refresh_token'), String(refreshed));

  // ---- one queue across sources
  await page.setInputFiles('#file-input', TRACK);
  await page.evaluate(() => {
    const { player } = window.__phosphor;
    void player.playTrack(player.queue[player.queue.length - 1].id);
  });
  await page.waitForFunction(() => window.__phosphor.player.current?.source === 'local' && window.__phosphor.player.position > 0.5, null, { timeout: 8000 }).catch(() => {});
  s = await state(page);
  check('switching to a local track stops Spotify and analyses the file directly', s.input === 'local' && (await fake(() => window.__fakeSpotify.audio.paused)) && s.level > 0.05);
  await page.keyboard.press('p');
  await page.waitForFunction(() => window.__phosphor.player.current?.source === 'spotify' && window.__phosphor.player.position > 0.5, null, { timeout: 8000 }).catch(() => {});
  s = await state(page);
  check('...and back to Spotify hands the visuals to the shared tab audio again', s.input === 'capture' && !(await fake(() => window.__fakeSpotify.audio.paused)));

  // ---- staying signed in, and signing out
  await page.reload();
  await page.waitForFunction(() => window.__phosphor?.app.services.find((s) => s.id === 'spotify').status().connected, null, { timeout: 15000 }).catch(() => {});
  check('the session is restored after a reload without signing in again', (await svc()).connected && mock.log.tokenRequests.filter((r) => r.grant_type === 'authorization_code').length === 1);
  await page.evaluate(() => window.__phosphor.app.services.find((s) => s.id === 'spotify').disconnect());
  check('disconnect forgets the tokens', !(await svc()).connected && (await page.evaluate(() => localStorage.getItem('phosphor.spotify.tokens'))) === null);
  const offline = await page.evaluate(async () => {
    const { library, services } = window.__phosphor.app;
    const p = library.playlists.find((x) => x.items.some((i) => i.kind === 'remote'));
    return (await library.resolve(p.id, services)).notes.join(' ');
  });
  check('while Spotify is disconnected, a linked playlist explains what is missing', /Connect Spotify to include "Mock Mix"/.test(offline), offline);
  await context.close();

  // ---- a free account
  const context2 = await browser.newContext({ viewport: { width: 1100, height: 650 } });
  await installSpotifyMock(context2);
  const page2 = await open(context2);
  await page2.addInitScript(() => (window.__fakeSpotifyFree = true));
  await page2.reload();
  await page2.waitForFunction(() => window.__phosphor);
  await page2.evaluate(() => window.__phosphor.settings.set({ spotifyClientId: 'mock-client-id' }));
  await page2.keyboard.press('o');
  await page2.click('.tab[data-id="spotify"]');
  await page2.click('.tab-panel >> text=Connect Spotify');
  await page2.waitForSelector('.toast.error', { timeout: 15000 }).catch(() => {});
  const message = (await page2.locator('.toast.error').first().textContent().catch(() => '')) ?? '';
  check('a non-Premium account gets a plain explanation', /Premium/.test(message), message.slice(0, 90));
  await browser.close();
}


// ---------------------------------------------------------------- apple music

async function apple() {
  console.log('\n== Apple Music (against the local simulation in scripts/mocks/apple.cjs) ==');
  const { installAppleMock, mockDeveloperToken } = require('./mocks/apple.cjs');
  const browser = await chromium.launch({ headless: false, args: [...GL_ARGS, '--auto-accept-this-tab-capture'] });
  const context = await browser.newContext({ viewport: { width: 1440, height: 810 } });
  await installAppleMock(context);
  const page = await open(context);
  await page.evaluate(() => {
    window.__phosphor.settings.set({ quality: 'low', autoShare: false });
    window.__phosphor.renderer.setVisualizer('bars', { immediate: true });
  });
  const svc = () => page.evaluate(() => window.__phosphor.app.services.find((s) => s.id === 'apple').status());
  const setToken = (token) => page.evaluate((t) => window.__phosphor.settings.set({ appleDeveloperToken: t }), token);
  const toastText = async () => ((await page.locator('.toast.error').last().textContent().catch(() => '')) ?? '');

  // ---- token handling
  await page.keyboard.press('o');
  await page.click('.tab[data-id="apple"]');
  check('without a developer token the panel says setup is needed', await page.isVisible('.tab-panel >> text=needs credentials'));
  await setToken('not-a-token');
  check('a malformed token is explained before anything is sent to Apple', /not a developer token/.test((await svc()).problem ?? ''), (await svc()).problem);
  await setToken(mockDeveloperToken({ expired: true }));
  check('an expired token is called out with its expiry date', /expired on/.test((await svc()).problem ?? ''), (await svc()).problem);
  await setToken(mockDeveloperToken({ signed: false }));
  await page.click('.tab-panel >> text=Connect Apple Music');
  await page.waitForSelector('.toast.error');
  check('a token Apple rejects produces a clear message', /rejected the developer token/.test(await toastText()), (await toastText()).slice(0, 90));
  check('the SDK was configured with the app name and the pasted token', await page.evaluate(() => window.__fakeAppleLog.config?.app?.name === 'Phosphor'));

  // ---- sign in (a fresh page: MusicKit is configured once per load)
  await page.reload();
  await page.waitForFunction(() => window.__phosphor);
  await page.evaluate(() => window.__phosphor.renderer.setVisualizer('bars', { immediate: true }));
  await setToken(mockDeveloperToken());
  await page.keyboard.press('o');
  await page.click('.tab[data-id="apple"]');
  await page.click('.tab-panel >> text=Connect Apple Music');
  await page.waitForFunction(() => window.__phosphor.app.services.find((s) => s.id === 'apple').status().connected, null, { timeout: 10000 }).catch(() => {});
  check('with a good token, sign-in connects', (await svc()).connected, JSON.stringify(await svc()));

  // ---- search and play
  await page.fill('input[type=search]', 'understudies');
  await page.keyboard.press('Enter');
  await page.waitForSelector('.results .row');
  const rows = await page.locator('.results .row').count();
  check('search lists songs, albums and playlists, hiding songs that cannot be played', rows === 6, `${rows} rows`);
  await page.waitForFunction(() => [...document.querySelectorAll('.results .thumb img')].some((img) => img.naturalWidth > 0), null, { timeout: 5000 }).catch(() => {});
  await page.screenshot({ path: path.join(SHOTS, 'ui-apple.png') });
  await page.click('.results .row:nth-child(2) [title="Play now"]');
  await page.waitForFunction(() => window.__phosphor.player.playing && window.__phosphor.player.position > 0.5, null, { timeout: 10000 }).catch(() => {});
  let s = await state(page);
  const current = await page.evaluate(() => window.__phosphor.player.current);
  check('an Apple Music song plays through MusicKit', s.playing && current?.source === 'apple' && (await page.evaluate(() => window.__fakeAppleLog.queue.at(-1)?.song)) === '2001');
  check('title, artist, duration and sized artwork come from Apple', current.title === 'Stand-In Track 1' && current.artist === 'The Understudies' && Math.abs(s.duration - 40.67) < 0.5 && /600x600/.test(current.artworkUrl));
  check("Apple's own autoplay is turned off so the shared queue stays in charge", await page.evaluate(() => window.__fakeApple.autoplayEnabled === false));
  await page.keyboard.press('Escape');

  // ---- visuals through tab sharing
  await page.waitForTimeout(800);
  check('protected audio does not reach the analysers by itself', (await state(page)).level < 0.01);
  await page.click(".banner >> text=Share this tab's audio");
  await page.waitForFunction(() => window.__phosphor.capture.state.active, null, { timeout: 10000 }).catch(() => {});
  await page.waitForTimeout(3000);
  s = await state(page);
  check("after sharing, Apple Music's audio drives the visualizers", s.input === 'capture' && s.level > 0.05, `level ${s.level.toFixed(2)}`);

  // ---- transport
  await page.keyboard.press('Space');
  await page.waitForTimeout(500);
  check('pause reaches MusicKit', (await page.evaluate(() => window.__fakeApple.audio.paused)) && !(await state(page)).playing);
  await page.keyboard.press('Space');
  await page.waitForTimeout(500);
  check('resume reaches MusicKit', !(await page.evaluate(() => window.__fakeApple.audio.paused)) && (await state(page)).playing);
  await page.evaluate(() => void window.__phosphor.player.seek(20));
  await page.waitForTimeout(600);
  check('seeking moves MusicKit and the seek bar agrees', Math.abs((await state(page)).position - 20.6) < 0.8, `position ${(await state(page)).position.toFixed(1)}`);
  await page.evaluate(() => window.__phosphor.player.setVolume(0.3));
  check('volume is applied to MusicKit', Math.abs((await page.evaluate(() => window.__fakeApple.volume)) - 0.3) < 0.01);
  await page.evaluate(() => window.__phosphor.player.setVolume(0.8));

  // ---- albums, playlists, library, links
  const data = await page.evaluate(async () => {
    const { app, player } = window.__phosphor;
    const service = app.services.find((s) => s.id === 'apple');
    const found = await service.search('x');
    const album = await service.tracksOf(found.collections.find((c) => c.kind === 'album'));
    const playlist = await service.tracksOf(found.collections.find((c) => c.kind === 'playlist'));
    const library = await service.library();
    const libraryTracks = await service.tracksOf(library[0]);
    const links = {
      songInAlbum: (await service.resolveLink('https://music.apple.com/gb/album/dress-rehearsal/1001?i=2003'))?.tracks[0]?.title,
      song: (await service.resolveLink('https://music.apple.com/us/song/stand-in-track-5/2005'))?.tracks[0]?.title,
      album: (await service.resolveLink('https://music.apple.com/us/album/dress-rehearsal/1001'))?.collections[0]?.title,
      playlist: (await service.resolveLink('https://music.apple.com/us/playlist/understudy-essentials/pl.mock1'))?.collections[0]?.title,
      other: await service.resolveLink('https://open.spotify.com/track/abc'),
    };
    player.add(album);
    return { album: album.map((t) => t.title), playlist: playlist.map((t) => t.title), library: library.map((c) => c.title), libraryTracks: libraryTracks.map((t) => [t.title, t.ref]), links };
  });
  check('album tracks load across pages', data.album.length === 4, data.album.join(', '));
  check('playlist tracks load, skipping unavailable songs', data.playlist.join() === 'Stand-In Track 5,Stand-In Track 6', data.playlist.join());
  check('library playlists and their songs load', data.library.join() === 'My Library Mix' && data.libraryTracks[0]?.[1] === 'i.aaa', JSON.stringify(data.libraryTracks));
  check('pasted song, album and playlist links resolve (honouring the storefront in the link)', data.links.songInAlbum === 'Stand-In Track 3' && data.links.song === 'Stand-In Track 5' && data.links.album === 'Dress Rehearsal' && data.links.playlist === 'Understudy Essentials', JSON.stringify(data.links));
  check('links to other services are refused', data.links.other === null);

  // ---- end of track -> next
  await page.evaluate(() => void window.__phosphor.player.seek(window.__phosphor.player.duration - 1.2));
  await page.waitForFunction(() => window.__phosphor.player.currentIndex === 1 && window.__phosphor.player.position > 0.3, null, { timeout: 10000 }).catch(() => {});
  s = await state(page);
  check('when an Apple Music song ends the queue advances', s.index === 1 && s.playing, `index ${s.index}`);

  // ---- songs that play all the way to the end by themselves
  await page.evaluate(async () => {
    const { app, player } = window.__phosphor;
    const service = app.services.find((x) => x.id === 'apple');
    const tracks = [];
    for (const id of ['3001', '3002', '3003']) tracks.push(...(await service.resolveLink(`https://music.apple.com/us/song/short/${id}`)).tracks);
    player.clear();
    player.add(tracks, { play: true });
  });
  const appleAdvanced = await page
    .waitForFunction(() => window.__phosphor.player.currentIndex === 1 && window.__phosphor.player.playing && window.__phosphor.player.position > 0.3, null, { timeout: 25000 })
    .then(() => true, () => false);
  await page.waitForTimeout(2500);
  s = await state(page);
  check('an Apple Music song that plays to its end by itself starts the next one, once', appleAdvanced && s.index === 1, `index ${s.index}`);

  // ---- sign out
  await page.evaluate(() => window.__phosphor.app.services.find((s) => s.id === 'apple').disconnect());
  await page.waitForTimeout(300);
  check('disconnect signs out and stops playback', !(await svc()).connected && (await page.evaluate(() => window.__fakeApple.audio.paused)));

  // ---- declining Apple's sign-in window
  await page.evaluate(() => (window.__fakeAppleDecline = true));
  await page.keyboard.press('o');
  await page.click('.tab[data-id="apple"]');
  await page.click('.tab-panel >> text=Connect Apple Music');
  await page.waitForTimeout(800);
  check('cancelling the Apple sign-in is reported, not swallowed', /sign-in did not complete/.test(await toastText()), (await toastText()).slice(0, 90));
  await browser.close();
}


// -------------------------------------------------------------------- youtube

async function youtube() {
  console.log('\n== YouTube (against the local simulation in scripts/mocks/youtube.cjs) ==');
  const { installYouTubeMock } = require('./mocks/youtube.cjs');
  const browser = await chromium.launch({ headless: false, args: [...GL_ARGS, '--auto-accept-this-tab-capture'] });
  const context = await browser.newContext({ viewport: { width: 1440, height: 810 } });
  const mock = await installYouTubeMock(context);
  const page = await open(context);
  await page.evaluate(() => {
    window.__phosphor.settings.set({ quality: 'low', youtubeApiKey: '' });
    window.__phosphor.renderer.setVisualizer('bars', { immediate: true });
  });
  const yt = (fn, arg) => page.evaluate(([fn, arg]) => new Function('service', 'arg', `return (${fn})(service, arg)`)(window.__phosphor.app.services.find((s) => s.id === 'youtube'), arg), [fn.toString(), arg]);
  const toastText = async () => ((await page.locator('.toast.error').last().textContent().catch(() => '')) ?? '');

  // ---- no setup needed
  await page.keyboard.press('o');
  await page.click('.tab[data-id="youtube"]');
  check('works with no credentials: the panel is ready for links', await page.isVisible('.tab-panel >> text=Ready: paste links'));
  check('without an API key, search explains what it needs instead of failing', await page.isVisible('.tab-panel >> text=Search needs a YouTube Data API key'));

  // ---- link parsing
  const links = await yt(async (service) => {
    const r = async (u) => {
      try {
        const x = await service.resolveLink(u);
        return x ? [...x.tracks.map((t) => `v:${t.ref}`), ...x.collections.map((c) => `l:${c.id}:${c.subtitle}`)].join(' ') : null;
      } catch (e) {
        return `error:${e.message.slice(0, 40)}`;
      }
    };
    return {
      watch: await r('https://www.youtube.com/watch?v=aaaaaaaaaaa&t=42s'),
      short: await r('https://youtu.be/bbbbbbbbbbb?si=xyz'),
      shorts: await r('https://youtube.com/shorts/ccccccccccc'),
      music: await r('https://music.youtube.com/watch?v=aaaaaaaaaaa&list=OLAK5uy_mockalbum'),
      album: await r('https://music.youtube.com/playlist?list=OLAK5uy_mockalbum'),
      browse: await r('https://music.youtube.com/browse/MPREb_abc'),
      other: await r('https://open.spotify.com/track/x'),
    };
  });
  check('watch, youtu.be and shorts links resolve to the video', links.watch === 'v:aaaaaaaaaaa' && links.short === 'v:bbbbbbbbbbb' && links.shorts === 'v:ccccccccccc', JSON.stringify([links.watch, links.short, links.shorts]));
  check('YouTube Music links give both the song and its album playlist', links.music === 'v:aaaaaaaaaaa l:OLAK5uy_mockalbum:YouTube Music album' && links.album === 'l:OLAK5uy_mockalbum:YouTube Music album', links.music);
  check('album/artist "browse" pages get an explanation of what to paste instead', /^error:That is a YouTube Music album/.test(links.browse ?? ''), links.browse);
  check('links to other services are refused', links.other === null);

  // ---- paste a link through the UI and play it
  await page.fill('input[type=url]', 'https://music.youtube.com/watch?v=aaaaaaaaaaa');
  await page.keyboard.press('Enter');
  await page.waitForSelector('.results .row');
  await page.click('.results .row >> nth=0 >> [title="Play now"]');
  await page.waitForFunction(() => window.__phosphor.player.playing && window.__phosphor.player.position > 0.5, null, { timeout: 10000 }).catch(() => {});
  let s = await state(page);
  const current = await page.evaluate(() => window.__phosphor.player.current);
  check('a pasted video plays in the YouTube player', s.playing && current?.source === 'youtube');
  {
    const np = await waitNowPlaying((n) => n.title === 'Mock Clip A');
    if (np) check('Now Playing shows the YouTube video\'s title and artist, not the tab title', np.title === 'Mock Clip A' && np.artist === 'Clip Makers', describeNowPlaying(np));
  }
  check('without a key, the title and artist fill in from the player once it loads ("- Topic" removed)', current.title === 'Mock Clip A' && current.artist === 'Clip Makers', `${current.title} / ${current.artist}`);
  check('the video thumbnail is used as artwork', /i\.ytimg\.com\/vi\/aaaaaaaaaaa/.test(current.artworkUrl ?? ''));
  await page.keyboard.press('Escape');
  const box = await page.locator('.yt-frame').boundingBox();
  check('the YouTube player is visible and at least 200x200, as YouTube requires', Boolean(box && box.width >= 200 && box.height >= 200), box ? `${box.width}x${box.height}` : 'hidden');

  // ---- visuals: the click on Play opened the share dialog straight away
  // (accepted automatically in this test run), with no banner to find.
  await page.waitForFunction(() => window.__phosphor.capture.state.active, null, { timeout: 10000 }).catch(() => {});
  s = await state(page);
  check('starting a streaming song with a click opens the share dialog at once', s.capture.active && s.capture.label === "This tab's audio" && !(await page.isVisible('.banner:not([hidden])')), JSON.stringify(s.capture));
  await page.waitForTimeout(3000);
  s = await state(page);
  check("after sharing, YouTube's audio drives the visualizers", s.input === 'capture' && s.level > 0.05, `level ${s.level.toFixed(2)}`);
  await page.screenshot({ path: path.join(SHOTS, 'ui-youtube.png') });

  // ---- transport
  await page.keyboard.press('Space');
  await page.waitForTimeout(500);
  check('pause reaches the YouTube player', (await page.evaluate(() => window.__fakeYouTube.audio.paused)) && !(await state(page)).playing);
  await page.keyboard.press('Space');
  await page.waitForTimeout(500);
  check('resume reaches the YouTube player', !(await page.evaluate(() => window.__fakeYouTube.audio.paused)) && (await state(page)).playing);
  await page.evaluate(() => void window.__phosphor.player.seek(20));
  await page.waitForTimeout(500);
  check('seeking moves the YouTube player', Math.abs((await state(page)).position - 20.4) < 0.8, (await state(page)).position.toFixed(1));
  await page.evaluate(() => window.__phosphor.player.setVolume(0.3));
  check('volume is applied to the YouTube player (0-100 scale)', (await page.evaluate(() => window.__fakeYouTube.volume)) === 30);
  await page.evaluate(() => window.__phosphor.player.setVolume(0.8));

  // ---- the player stays visible when the interface fades
  await page.evaluate(() => window.__phosphor.settings.set({ autoHide: 'always' }));
  await page.mouse.move(700, 300);
  await page.waitForTimeout(4200);
  const idleBox = await page.locator('.yt-frame').boundingBox();
  check('when the interface fades, the YouTube player stays on screen', (await state(page)).idle && Boolean(idleBox && idleBox.width >= 200 && (await page.isVisible('.yt-frame'))));
  await page.mouse.move(720, 320);
  await page.evaluate(() => window.__phosphor.settings.set({ autoHide: 'fullscreen' }));

  // ---- a playlist without a key, a blocked video, end of track
  const expanded = await yt(async (service) => {
    const found = await service.resolveLink('https://music.youtube.com/playlist?list=OLAK5uy_mockalbum');
    const tracks = await service.tracksOf(found.collections[0]);
    return tracks.map((t) => t.ref);
  });
  check('without a key, a playlist is expanded by the player itself', expanded.join() === 'aaaaaaaaaaa,bbbbbbbbbbb,ccccccccccc', expanded.join());
  await page.evaluate(() => {
    const { player, app } = window.__phosphor;
    const service = app.services.find((s) => s.id === 'youtube');
    player.add([service['videoTrack']('ddddddddddd'), service['videoTrack']('bbbbbbbbbbb')]);
    void player.playTrack(player.queue[1].id);
  });
  await page.waitForFunction(() => window.__phosphor.player.current?.ref === 'bbbbbbbbbbb' && window.__phosphor.player.playing, null, { timeout: 10000 }).catch(() => {});
  check('a video whose owner blocks embedding is explained and skipped', /outside YouTube/.test(await toastText()) && (await page.evaluate(() => window.__phosphor.player.current?.ref)) === 'bbbbbbbbbbb', (await toastText()).slice(0, 80));
  await page.evaluate(() => {
    const { player, app } = window.__phosphor;
    player.add([app.services.find((s) => s.id === 'youtube')['videoTrack']('ccccccccccc')]);
    void player.seek(player.duration - 1.2);
  });
  await page.waitForFunction(() => window.__phosphor.player.current?.ref === 'ccccccccccc' && window.__phosphor.player.position > 0.3, null, { timeout: 10000 }).catch(() => {});
  check('when a video ends the queue advances', (await page.evaluate(() => window.__phosphor.player.current?.ref)) === 'ccccccccccc');

  // ---- videos that play all the way to the end by themselves
  const queueVideos = (ids, noEnded = false) =>
    page.evaluate(async ([ids, noEnded]) => {
      window.__fakeYouTubeNoEnded = noEnded;
      const { app, player } = window.__phosphor;
      const service = app.services.find((x) => x.id === 'youtube');
      player.clear();
      player.add(ids.map((id) => service['videoTrack'](id)), { play: true });
    }, [ids, noEnded]);
  const videoAt = (i, timeout = 25000) =>
    page
      .waitForFunction((i) => window.__phosphor.player.currentIndex === i && window.__phosphor.player.playing && window.__phosphor.player.position > 0.3, i, { timeout })
      .then(() => true, () => false);
  await queueVideos(['shortclip01', 'shortclip02', 'shortclip03']);
  const videoAdvanced = await videoAt(1);
  await page.waitForTimeout(2500);
  check('a video that plays to its end by itself starts the next one, once', videoAdvanced && (await state(page)).index === 1, `index ${(await state(page)).index}`);
  await queueVideos(['shortclip02', 'shortclip03'], true);
  check('if a player never reports the end, the safety net moves on a few seconds later', await videoAt(1, 30000));
  await page.evaluate(() => (window.__fakeYouTubeNoEnded = false));

  // ---- once per session: after the user stops sharing, a click doesn't reopen the dialog
  await page.click('.chip .icon-btn');
  await page.waitForTimeout(800);
  await page.keyboard.press('q');
  await page.waitForTimeout(400);
  await page.click('.drawer .row >> nth=0');
  await page.waitForTimeout(1500);
  check('after the user stops sharing, playing another song shows the banner instead of asking again', !(await state(page)).capture.active && (await page.isVisible('.banner:not([hidden])')));
  await page.keyboard.press('q');

  // ---- with an API key
  await page.evaluate(() => window.__phosphor.settings.set({ youtubeApiKey: 'mock-api-key' }));
  const searched = await yt(async (service) => {
    const r = await service.search('clips');
    const list = await service.tracksOf(r.collections[0]);
    return { tracks: r.tracks.map((t) => [t.title, t.artist, t.duration]), playlists: r.collections.map((c) => c.title), list: list.map((t) => t.title) };
  });
  check('with a key, search finds music videos with titles, artists and durations', searched.tracks.length === 3 && searched.tracks[0][0] === 'Mock Clip A' && searched.tracks[0][1] === 'Clip Makers' && searched.tracks[0][2] === 40, JSON.stringify(searched.tracks[0]));
  check('search is limited to the Music category', mock.log.data.some((d) => d.endpoint === 'search' && d.videoCategoryId === '10'));
  check('escaped playlist titles are decoded', searched.playlists[0] === 'Rock & Roll Mix', searched.playlists[0]);
  check('with a key, playlist tracks are fetched across pages with their names', searched.list.join() === 'Mock Clip C,Mock Clip A', searched.list.join());
  await page.evaluate(() => window.__phosphor.settings.set({ youtubeApiKey: 'exhausted-key' }));
  const quota = await yt((service) => service.search('x').then(() => 'ok', (e) => e.message));
  check('an exhausted daily quota is explained plainly', /quota is used up/.test(quota), quota);
  await page.evaluate(() => window.__phosphor.settings.set({ youtubeApiKey: 'wrong' }));
  const bad = await yt((service) => service.search('x').then(() => 'ok', (e) => e.message));
  check('a wrong key is reported as such', /rejected the API key/.test(bad), bad);

  // ---- leaving YouTube hides the player
  await page.setInputFiles('#file-input', TRACK);
  await page.evaluate(() => {
    const { player } = window.__phosphor;
    void player.playTrack(player.queue[player.queue.length - 1].id);
  });
  await page.waitForTimeout(1500);
  check('playing a local file stops YouTube and hides its frame', (await page.evaluate(() => window.__fakeYouTube.audio.paused)) && !(await page.isVisible('.yt-frame')));
  await browser.close();
}

// ----------------------------------------------------------------------- main

(async () => {
  if (!fs.existsSync(TRACK)) {
    console.error('Test audio is missing. Run: node scripts/make-test-audio.mjs');
    process.exit(2);
  }
  const browser = await chromium.launch({ headless: false, args: GL_ARGS });
  try {
    if (only.includes('visualizers')) await visualizers(browser);
    if (only.includes('reaction')) await reaction(browser);
    if (only.includes('player')) await player(browser);
    if (only.includes('playlists')) await playlists(browser);
  } finally {
    await browser.close();
  }
  if (only.includes('capture')) await capture();
  if (only.includes('spotify')) await spotify();
  if (only.includes('apple')) await apple();
  if (only.includes('youtube')) await youtube();

  const passed = results.filter((r) => r.ok).length;
  console.log(`\n${passed} passed, ${failures} failed`);
  fs.mkdirSync('.verify', { recursive: true });
  fs.writeFileSync('.verify/report.json', JSON.stringify(results, null, 2));
  process.exit(failures ? 1 : 0);
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
