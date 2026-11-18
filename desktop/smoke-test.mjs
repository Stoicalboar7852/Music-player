// Smoke test of the packaged desktop app, run in CI on macOS and Windows
// right after electron-builder (see .github/workflows/desktop.yml):
//
//   node smoke-test.mjs path/to/Phosphor(.exe)
//   node smoke-test.mjs node_modules/electron/dist/electron .   (unpackaged, for a local run)
//
// It drives the real app with Playwright: the window, the local server, the
// bridge to the page, the demo playing, the menu bar or tray icon animating,
// the commands, the mini player, the presenter window. A CI machine has no
// sound card and no screen recording permission, so whether system audio
// arrives is reported but not required. Writes release/smoke-report.json and
// screenshots next to it.

import { _electron as electron } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const executable = process.argv[2];
if (!executable) {
  console.error('Usage: node smoke-test.mjs path/to/the/packaged/app');
  process.exit(2);
}
const out = path.resolve('release');
mkdirSync(out, { recursive: true });

const results = [];
let failures = 0;
function check(name, ok, detail = '', { required = true } = {}) {
  results.push({ name, ok, detail, required });
  if (!ok && required) failures++;
  console.log(`${ok ? '  ok  ' : required ? ' FAIL ' : ' note '} ${name}${detail ? `  (${detail})` : ''}`);
}

// An unpackaged run passes the app's folder. On Linux (a local run), as root
// it needs --no-sandbox, and without a GPU, software WebGL.
const appDir = process.argv[3];
const linux = process.platform === 'linux';
const args = [
  ...(linux && process.getuid?.() === 0 ? ['--no-sandbox'] : []),
  ...(linux ? ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] : []),
  ...(appDir ? [path.resolve(appDir)] : []),
];
const app = await electron.launch({ executablePath: path.resolve(executable), args, timeout: 120_000 });
try {
  const page = await app.firstWindow();
  page.on('pageerror', (error) => console.log(`  page error: ${error.message}`));
  await page.waitForFunction(() => window.__phosphor, null, { timeout: 60_000 });
  const info = await page.evaluate(() => ({ url: location.href, platform: window.phosphorDesktop?.platform, desktop: document.documentElement.dataset.desktop }));
  check('the window opens Phosphor from its local server', /^http:\/\/127\.0\.0\.1:\d+\/$/.test(info.url), info.url);
  check('the page has the desktop bridge', info.platform === process.platform && Boolean(info.desktop), JSON.stringify(info));
  check('the menu bar or tray icon exists', await app.evaluate(() => globalThis.__phosphorDesktop.hasTray));
  const spotifyApp = await page.evaluate(() => window.__phosphor.app.services.find((s) => s.id === 'spotify').connectMode);
  check('Spotify is set to play through the Spotify app (no Widevine here)', spotifyApp === true);

  // The demo is synthesised in the page, so it needs no files and no network.
  await page.click('.welcome >> text=Play demo');
  const playing = await page.waitForFunction(() => window.__phosphor.player.playing, null, { timeout: 60_000 }).then(() => true, () => false);
  check('the demo starts', playing);
  await page.waitForTimeout(3000);
  const audio = await page.evaluate(() => ({ context: window.__phosphor.engine.context.state, position: window.__phosphor.player.position, level: window.__phosphor.renderer.audio.level }));
  check('...and plays (an audio device is needed for this)', audio.context === 'running' && audio.position > 1, JSON.stringify(audio), { required: false });
  const frames = await app.evaluate(() => globalThis.__phosphorDesktop.trayFrames);
  check('the menu bar or tray icon animates while music plays', frames >= 10, `${frames} frames`);
  const state = await app.evaluate(() => globalThis.__phosphorDesktop.state);
  check('the app knows what is playing', state.playing && state.title === 'Signal Check', JSON.stringify({ ...state, artwork: state.artwork.slice(0, 22) }));

  await app.evaluate(() => globalThis.__phosphorDesktop.command('toggle'));
  const paused = await page.waitForFunction(() => !window.__phosphor.player.playing, null, { timeout: 5000 }).then(() => true, () => false);
  await app.evaluate(() => globalThis.__phosphorDesktop.command('toggle'));
  const resumed = await page.waitForFunction(() => window.__phosphor.player.playing, null, { timeout: 5000 }).then(() => true, () => false);
  check('Play/Pause from the menu bar or tray reaches the player', paused && resumed);

  await app.evaluate(() => globalThis.__phosphorDesktop.toggleMini());
  const miniPage = await app.waitForEvent('window', { timeout: 15_000 }).catch(() => app.windows().find((w) => w.url().includes('mini')));
  const mini = miniPage ?? app.windows().find((w) => w.url().includes('mini'));
  if (mini) {
    await mini.waitForLoadState();
    await mini.waitForFunction(() => document.getElementById('title').textContent === 'Signal Check', null, { timeout: 10_000 }).catch(() => {});
    const title = await mini.evaluate(() => document.getElementById('title').textContent);
    const visible = await app.evaluate(() => globalThis.__phosphorDesktop.miniVisible);
    check('the mini player opens with the song', visible && title === 'Signal Check', title);
    await mini.screenshot({ path: path.join(out, 'smoke-mini.png') }).catch(() => {});
  } else check('the mini player opens with the song', false, 'no window');

  // The presenter window: opened from the page, placed by the app (with one
  // display, as in CI, as a window; with two, full screen on the other).
  await page.click('.present-btn');
  let presenter = null;
  for (let i = 0; i < 60 && !presenter; i++) {
    presenter = app.windows().find((w) => w.url().includes('present.html')) ?? null;
    if (!presenter) await page.waitForTimeout(250);
  }
  if (presenter) {
    await presenter.waitForLoadState();
    const drawing = await presenter.waitForFunction(() => window.__presenter?.renderer.adopted, null, { timeout: 15_000 }).then(() => true, () => false);
    const placed = await app.evaluate(() => globalThis.__phosphorDesktop.presenter);
    check('the presenter window opens and draws the visuals from the main window', drawing && /present\.html$/.test(placed?.url ?? ''), JSON.stringify(placed));
    await page.waitForTimeout(2000);
    const behind = await presenter.evaluate(() => {
      const l = [...window.__presenter.latencies].sort((a, b) => a - b);
      return l.length ? l[Math.floor(l.length / 2)] : null;
    });
    check('...in step with it (median under 50 ms behind the main window)', behind !== null && behind < 50, `${behind} ms`);
    await presenter.screenshot({ path: path.join(out, 'smoke-presenter.png') }).catch(() => {});
    // Fill a screen: with one display the app fills that one.
    await page.click('.presenter-panel >> text=Fill a screen');
    const full = await app
      .evaluate(async () => {
        for (let i = 0; i < 40; i++) {
          if (globalThis.__phosphorDesktop.presenter?.fullScreen) return true;
          await new Promise((r) => setTimeout(r, 250));
        }
        return false;
      })
      .catch(() => false);
    check('Fill a screen makes the app put the presenter full screen', full, '', { required: false });
    await page.click('.presenter-panel >> text=Close presenter');
    const closed = await app
      .evaluate(async () => {
        for (let i = 0; i < 40; i++) {
          if (!globalThis.__phosphorDesktop.presenter) return true;
          await new Promise((r) => setTimeout(r, 250));
        }
        return false;
      })
      .catch(() => false);
    check('Close presenter closes it', closed);
  } else check('the presenter window opens and draws the visuals from the main window', false, 'no window');

  // System audio, asked for the way the page asks: from a click (Playwright's
  // click counts as the user's).
  await page.evaluate(() => {
    const button = document.createElement('button');
    button.id = 'smoke-capture';
    button.textContent = 'capture';
    button.style.cssText = 'position:fixed;left:0;top:0;z-index:99999';
    button.onclick = async () => {
      try {
        const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
        window.__smokeCapture = { audio: stream.getAudioTracks().length, video: stream.getVideoTracks().length };
        stream.getTracks().forEach((t) => t.stop());
      } catch (error) {
        window.__smokeCapture = { error: `${error.name}: ${error.message}` };
      }
      button.remove();
    };
    document.body.append(button);
  });
  await page.click('#smoke-capture');
  const capture = await page
    .waitForFunction(() => window.__smokeCapture, null, { timeout: 30_000 })
    .then((handle) => handle.jsonValue(), () => ({ error: 'no answer within 30 s' }));
  check('system audio capture without a dialog (needs a sound device, and on macOS the recording permission)', !capture.error && capture.audio > 0, JSON.stringify(capture), { required: false });
  await page.screenshot({ path: path.join(out, 'smoke-window.png') }).catch(() => {});
} catch (error) {
  check('the smoke test ran to the end', false, String(error?.stack ?? error));
} finally {
  writeFileSync(path.join(out, 'smoke-report.json'), JSON.stringify({ platform: process.platform, arch: process.arch, results }, null, 2));
  await app.close().catch(() => {});
}
console.log(`\n${failures ? `${failures} failed` : 'smoke test passed'}`);
process.exit(failures ? 1 : 0);
