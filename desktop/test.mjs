// Tests for the parts of the desktop app that don't need Electron: the local
// server for the web app, the menu bar / tray icon renderer, and the optional
// librespot launcher (with a stand-in for librespot, and the real binary's
// arguments when one has been built into desktop/bin).
//
//   node desktop/test.mjs
//
// (The packaged app itself is tested by smoke-test.mjs, in CI on macOS and
// Windows.)

import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { createServer, request } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { inflateSync } from 'node:zlib';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { BYTES_PER_SECOND, createLibrespot, librespotPath } from './librespot.mjs';
import { startServer } from './server.mjs';
import { createMeter, drawGlyph, drawIcon, RESTING } from './tray-icon.mjs';

let failures = 0;
function check(name, ok, detail = '') {
  if (!ok) failures++;
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${name}${detail ? `  (${detail})` : ''}`);
}

/** GET with an explicit Host header (fetch won't let a page set it). */
function get(port, pathname, host = `127.0.0.1:${port}`) {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path: pathname, headers: { host } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() }));
    });
    req.on('error', reject);
    req.end();
  });
}

/** Decodes the PNGs this module writes (8-bit RGBA, no filter): width, height, pixels. */
function decodePng(png) {
  if (png.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') throw new Error('not a PNG');
  let offset = 8;
  let width = 0;
  let height = 0;
  const idat = [];
  while (offset < png.length) {
    const length = png.readUInt32BE(offset);
    const type = png.toString('latin1', offset + 4, offset + 8);
    const data = png.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
    } else if (type === 'IDAT') idat.push(data);
    offset += 12 + length;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const rgba = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) raw.copy(rgba, y * width * 4, y * (width * 4 + 1) + 1, (y + 1) * (width * 4 + 1));
  return { width, height, rgba };
}

console.log('\n== Desktop app: local server ==');
{
  const root = mkdtempSync(path.join(tmpdir(), 'phosphor-web-'));
  mkdirSync(path.join(root, 'assets'));
  writeFileSync(path.join(root, 'index.html'), '<!doctype html><title>Phosphor</title>');
  writeFileSync(path.join(root, 'assets', 'app-1234.js'), 'console.log(1)');
  writeFileSync(path.join(root, 'sw.js'), '// worker');
  writeFileSync(path.join(path.dirname(root), 'outside.txt'), 'secret');

  // Something else already holds the first port: the server moves on to the next.
  const blocker = createServer().listen(0, '127.0.0.1');
  await new Promise((r) => blocker.once('listening', r));
  const taken = blocker.address().port;
  const server = await startServer(root, { ports: [taken, 0] });
  check('the first free port is used when the preferred one is taken', server.port !== taken && server.url === `http://127.0.0.1:${server.port}/`, server.url);

  const page = await get(server.port, '/');
  check('the page is served at /, not cached', page.status === 200 && page.body.includes('<title>Phosphor') && page.headers['cache-control'] === 'no-cache' && page.headers['content-type'].startsWith('text/html'));
  const js = await get(server.port, '/assets/app-1234.js?v=1');
  check('built files are served with their type and cached for good', js.status === 200 && js.headers['content-type'].startsWith('text/javascript') && js.headers['cache-control'].includes('immutable'));
  const worker = await get(server.port, '/sw.js');
  check('the service worker is served fresh', worker.status === 200 && worker.headers['cache-control'] === 'no-cache');
  check('a missing file is a 404', (await get(server.port, '/nope.png')).status === 404);
  const traversal = await get(server.port, '/../outside.txt');
  const encoded = await get(server.port, '/%2e%2e/outside.txt');
  check('nothing outside the web folder can be read', traversal.status !== 200 && encoded.status !== 200 && !traversal.body.includes('secret') && !encoded.body.includes('secret'), `${traversal.status}, ${encoded.status}`);
  check('requests under another host name are refused (DNS rebinding)', (await get(server.port, '/', 'evil.example:80')).status === 403);
  check('localhost is accepted as well as 127.0.0.1', (await get(server.port, '/', `localhost:${server.port}`)).status === 200);
  await server.close();
  blocker.close();
}

console.log('\n== Desktop app: menu bar and tray icon ==');
{
  const rest = decodePng(drawIcon(RESTING, { size: 36, template: true }));
  check('the menu bar icon is a 36-pixel PNG (18 points at 2x)', rest.width === 36 && rest.height === 36);
  const alphaAt = (img, x, y) => img.rgba[(y * img.width + x) * 4 + 3];
  const black = [...Array(36 * 36).keys()].every((i) => rest.rgba[i * 4] === 0 && rest.rgba[i * 4 + 1] === 0 && rest.rgba[i * 4 + 2] === 0);
  check('...black and transparent, so macOS can tint it for a light or dark menu bar', black && alphaAt(rest, 0, 0) === 0 && alphaAt(rest, 35, 35) === 0);
  // Bar centres on the 36-pixel grid: x = 6, 15, 24, 33 minus the margin; columns of the 4 bars.
  const column = (img, x) => [...Array(img.height).keys()].filter((y) => alphaAt(img, x, y) > 128).length;
  const bars = [7, 16, 25, 34].map((x) => column(rest, Math.min(35, x - 1)));
  check('...at rest it shows the logo: four bars, the last the tallest', bars.every((h) => h > 6) && bars[3] > bars[0] && bars[1] > bars[0], bars.join(', '));
  const loud = decodePng(drawIcon([1, 0.2, 0.6, 0.1], { size: 36, template: true }));
  const loudBars = [7, 16, 25, 34].map((x) => column(loud, Math.min(35, x - 1)));
  check('...and its bars follow the levels', loudBars[0] > loudBars[1] && loudBars[2] > loudBars[3] && loudBars[0] >= 28, loudBars.join(', '));

  const tray = decodePng(drawIcon(RESTING, { size: 32, template: false }));
  const centre = (tray.rgba[(16 * 32 + 16) * 4 + 3]);
  const corner = tray.rgba[3];
  const colours = new Set();
  for (let i = 0; i < 32 * 32; i++) if (tray.rgba[i * 4 + 3] === 255) colours.add(tray.rgba.slice(i * 4, i * 4 + 3).join());
  check('the Windows tray icon is 32 pixels (16 at 2x), a dark rounded square with coloured bars', tray.width === 32 && centre === 255 && corner < 128 && colours.size > 20, `${colours.size} colours`);

  const meter = createMeter();
  let h = meter.heights;
  for (let i = 0; i < 3; i++) h = meter.update({ bass: 1, mid: 0, treble: 0 }, 1 / 12);
  const up = h[0];
  for (let i = 0; i < 3; i++) h = meter.update({ bass: 0, mid: 0, treble: 0 }, 1 / 12);
  const down = h[0];
  check('the bars rise quickly and fall slowly (they read as movement, not flicker)', up > 0.95 && down > 0.35 && down < up, `up ${up.toFixed(2)}, a quarter second later ${down.toFixed(2)}`);
  check('...and come back to the logo when the music stops', meter.rest().join() === RESTING.join());

  const glyphs = ['play', 'pause', 'next', 'previous'].map((k) => decodePng(drawGlyph(k, 32)));
  const covered = glyphs.map((g) => [...Array(32 * 32).keys()].filter((i) => g.rgba[i * 4 + 3] > 128).length);
  check('the Windows taskbar buttons get play, pause, next and previous glyphs', glyphs.every((g) => g.width === 32) && covered.every((c) => c > 120 && c < 600), covered.join(', '));
}

// ---------------------------------------------------------------- librespot
{
  const here = path.dirname(fileURLToPath(import.meta.url));
  const dir = mkdtempSync(path.join(tmpdir(), 'phosphor-spot-'));
  const argsFile = path.join(dir, 'args.json');
  // The stand-in is a Node script: run it through a tiny shell wrapper (or a .cmd on Windows).
  const fake = path.join(here, 'test-fixtures', 'fake-librespot.mjs');
  let binary = path.join(dir, process.platform === 'win32' ? 'librespot.cmd' : 'librespot');
  writeFileSync(binary, process.platform === 'win32' ? `@echo off\r\n"${process.execPath}" "${fake}" %*\r\n` : `#!/bin/sh\nexec "${process.execPath}" "${fake}" "$@"\n`, { mode: 0o755 });
  process.env.FAKE_LIBRESPOT_ARGS = argsFile;

  const run = (token) =>
    new Promise((resolve) => {
      const states = [];
      let bytes = 0;
      let first = 0;
      let last = 0;
      const spot = createLibrespot({
        binary,
        cacheDir: path.join(dir, 'cache'),
        onAudio: (chunk) => {
          const now = performance.now();
          first ||= now;
          last = now;
          bytes += chunk.length;
        },
        onState: (state) => {
          states.push(state.status);
          if (['exited', 'stopped', 'failed', 'auth-failed'].includes(state.status) && state.status !== 'auth-failed') resolve({ states, bytes, seconds: (last - first) / 1000 });
          if (state.status === 'auth-failed') setTimeout(() => resolve({ states, bytes, seconds: 0 }), 300);
        },
      });
      spot.start({ token, name: 'Phosphor (librespot)' });
    });

  if (process.platform !== 'win32') {
    const good = await run('a-token');
    const args = JSON.parse(readFileSync(argsFile, 'utf8'));
    const has = (flag, value) => args.includes(flag) && (value === undefined || args[args.indexOf(flag) + 1] === value);
    check(
      'librespot is started as a Connect device writing raw audio to its output, signed in with the page\'s token',
      has('--name', 'Phosphor (librespot)') && has('--backend', 'pipe') && has('--format', 'S16') && has('--access-token', 'a-token') && has('--disable-discovery') && has('--volume-ctrl', 'fixed'),
      args.join(' '),
    );
    check('...its sign-in is noticed, and its audio passed on', good.states.includes('ready') && good.bytes === Math.ceil((44100 * 8) / 4096) * 4096 * 4, `${good.states.join(' → ')}, ${good.bytes} bytes`);
    // Written as fast as possible, read at the speed it plays (half a second ahead at most).
    check('...read at real time, not as fast as it is written (so Spotify sees songs play at their speed)', good.seconds > 7 && good.seconds < 9, `8 s of audio arrived over ${good.seconds.toFixed(2)} s (${(good.bytes / BYTES_PER_SECOND).toFixed(1)} s of audio)`);
    const bad = await run('bad');
    check('a refused sign-in is reported as such', bad.states.includes('auth-failed'), bad.states.join(' → '));
  } else {
    check('librespot launcher (skipped on Windows: the stand-in needs a shell)', true);
  }
  const missing = createLibrespot({ binary: null, cacheDir: dir, onAudio() {}, onState: (s) => (missing.last = s) });
  missing.start({ token: 'x' });
  check('without a bundled librespot the page is told it is missing', missing.last?.status === 'missing' && !missing.available);

  // The real binary, when one has been built (CI builds it into desktop/bin before packaging).
  const real = librespotPath(null, here);
  if (real && existsSync(real)) {
    const version = execFileSync(real, ['--version'], { encoding: 'utf8' }).trim();
    let log = '';
    try {
      execFileSync(real, ['--name', 'Phosphor (librespot)', '--device-type', 'computer', '--backend', 'pipe', '--format', 'S16', '--bitrate', '320', '--initial-volume', '100', '--volume-ctrl', 'fixed', '--autoplay', 'off', '--disable-discovery', '--disable-audio-cache', '--cache', path.join(dir, 'real-cache'), '--access-token', 'not-a-real-token', '--ap-port', '1'], { encoding: 'utf8', timeout: 20000, stdio: ['ignore', 'ignore', 'pipe'] });
    } catch (error) {
      log = String(error.stderr ?? '');
    }
    check(`the bundled librespot (${version}) accepts every argument the app passes`, /Using StdoutSink \(pipe\) with format: S16/.test(log) && !/Unrecognized|unexpected argument|Invalid/i.test(log), log.trim().split('\n').slice(-1)[0]);
  } else {
    console.log('  note  no librespot binary in desktop/bin here: its arguments were not checked against the real thing');
  }
}

console.log(`\n${failures ? `${failures} failed` : 'all passed'}`);
process.exit(failures ? 1 : 0);
