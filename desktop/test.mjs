// Tests for the parts of the desktop app that don't need Electron: the local
// server for the web app, and the menu bar / tray icon renderer.
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

console.log(`\n${failures ? `${failures} failed` : 'all passed'}`);
process.exit(failures ? 1 : 0);
