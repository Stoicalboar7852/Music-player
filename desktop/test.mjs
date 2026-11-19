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
import { createNdiSender, loadNdi, ndiCandidates } from './ndi.mjs';
import { startServer } from './server.mjs';
import { createStageLink, jsonSplitter, parseNoteCommands } from './stagelink.mjs';
import { createMeter, drawGlyph, drawIcon, RESTING } from './tray-icon.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
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

console.log('\n== Desktop app: control API and presenter feed ==');
{
  const root = mkdtempSync(path.join(tmpdir(), 'phosphor-api-'));
  writeFileSync(path.join(root, 'index.html'), '<!doctype html><title>Phosphor</title>');
  const calls = [];
  const server = await startServer(root, {
    ports: [0],
    apiKey: 'k'.repeat(32),
    onCommand: async (name, params) => {
      calls.push({ name, params });
      if (name === 'visualizer' && params.id === 'nope') throw new Error('no visualizer "nope"');
      return { visualizer: params.id ?? 'radial', playing: true };
    },
    status: () => ({ title: 'A song', playing: true }),
  });
  const api = (pathname, init = {}) => fetch(`http://127.0.0.1:${server.port}${pathname}`, init).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));
  const key = 'k'.repeat(32);

  check('a command without the key is refused', (await api('/api/command?do=next')).status === 401);
  check('...and with a wrong key', (await api('/api/command?do=next&key=wrong')).status === 401);
  const done = await api(`/api/command?key=${key}&do=visualizer&id=aurora`);
  check('with the key, a command reaches the page with its parameters and answers with the state', done.status === 200 && done.body?.ok && done.body.visualizer === 'aurora' && calls.at(-1)?.name === 'visualizer' && calls.at(-1)?.params.id === 'aurora' && !('key' in calls.at(-1).params), JSON.stringify(done.body));
  const posted = await api('/api/command', { method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: JSON.stringify({ do: 'blackout', on: 'on' }) });
  check('POST with a JSON body and a Bearer key works too (FreeShow, Companion)', posted.status === 200 && calls.at(-1)?.name === 'blackout' && calls.at(-1)?.params.on === 'on');
  check('a command the page can not carry out answers 400 with its reason', (await api(`/api/command?key=${key}&do=visualizer&id=nope`)).body?.error === 'no visualizer "nope"');
  check('a malformed command is refused before reaching the page', (await api(`/api/command?key=${key}&do=../../etc`)).status === 400 && calls.length === 3);
  const status = await api(`/api/status?key=${key}`);
  check('/api/status reports what is playing', status.status === 200 && status.body?.title === 'A song');
  const noKeyServer = await startServer(root, { ports: [0] });
  check('with no key set up, the control API stays shut', (await fetch(`http://127.0.0.1:${noKeyServer.port}/api/command?do=next&key=`)).status === 401);
  await noKeyServer.close();

  // The feed: the main window (host) answers presenter pages elsewhere (viewers).
  const { WebSocket } = await import('ws');
  const open = (url, options) =>
    new Promise((resolve) => {
      const ws = new WebSocket(url, options);
      ws.once('open', () => resolve(ws));
      ws.once('error', () => resolve(null));
      ws.once('unexpected-response', () => resolve(null));
    });
  const next = (ws) => new Promise((resolve) => ws.once('message', (data, binary) => resolve({ data, binary })));
  check('a host without the feed key is refused', (await open(`${server.feedUrl}?role=host&key=wrong`)) === null);
  check('a page from another site can not watch the feed', (await open(`${server.feedUrl}?role=viewer`, { origin: 'https://evil.example' })) === null);
  const host = await open(`${server.feedUrl}?role=host&key=${encodeURIComponent(server.hostKey)}`);
  const viewer = await open(`${server.feedUrl}?role=viewer`, { origin: server.origin });
  check('the main window and a presenter page connect', Boolean(host && viewer));
  const id = '12345678-1234-1234-1234-123456789abc';
  const hello = next(host);
  viewer.send(JSON.stringify({ type: 'hello', id }));
  const greeting = JSON.parse(String((await hello).data));
  check('a presenter page’s hello reaches the main window', greeting.type === 'hello' && greeting.id === id && server.feed.viewers === 1);
  const frameArrives = next(viewer);
  host.send(Buffer.concat([Buffer.from(id, 'latin1'), Buffer.from([1, 2, 3, 4])]), { binary: true });
  const frame = await frameArrives;
  check('frames go to the page they are for, without the id in front', frame.binary && Buffer.from(frame.data).equals(Buffer.from([1, 2, 3, 4])));
  const stateArrives = next(viewer);
  host.send(JSON.stringify({ type: 'state', state: { visualizer: 'aurora' } }));
  check('state goes to every page', JSON.parse(String((await stateArrives).data)).state?.visualizer === 'aurora');
  const bye = next(host);
  viewer.close();
  const farewell = JSON.parse(String((await bye).data));
  check('when a page goes, the main window hears goodbye', farewell.type === 'bye' && farewell.id === id);
  host.close();
  await server.close();
}

console.log('\n== Desktop app: cue sync with ProPresenter and FreeShow (stand-ins for both) ==');
{
  check('notes commands are read from lines that start with "phosphor"', JSON.stringify(parseNoteCommands('Sing softly\nPhosphor: visualizer Black hole\nphosphor blackout off; qr on\nphosphor: do=overlay&name=title&on=1')) === JSON.stringify([
    { name: 'visualizer', params: { id: 'Black hole' } },
    { name: 'blackout', params: { on: 'off' } },
    { name: 'qr', params: { on: 'on' } },
    { name: 'overlay', params: { name: 'title', on: '1' } },
  ]));
  check('...and nothing else is taken for one', parseNoteCommands('phosphorescent paint\nphosphor: ../x\nphosphor:').length === 0);
  const pieces = [];
  const feed = jsonSplitter((v) => pieces.push(v));
  feed('{"url":"status/slide","data":{"current":{"notes":"a{b}"}}}\r\n\r\n{"cur');
  feed('rent":{"uuid":"2"}}\r\n');
  check('streamed updates are split however they are cut up', pieces.length === 2 && pieces[0].data.current.notes === 'a{b}' && pieces[1].current.uuid === '2');

  // ProPresenter: GET /version, a chunked /v1/status/slide stream, macros and messages.
  const proLog = [];
  let streamResponse = null;
  const pro = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      proLog.push(`${req.method} ${req.url}${body ? ` ${body}` : ''}`);
      if (req.url === '/version') return res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ name: 'Booth', platform: 'mac', os_version: '15', host_description: 'ProPresenter 7.16', api_version: 'v1' }));
      if (req.url === '/v1/status/slide?chunked=true') {
        res.writeHead(200, { 'content-type': 'application/json' });
        streamResponse = res;
        res.write(`${JSON.stringify({ current: { text: 'Welcome', notes: '', uuid: 'A' }, next: { text: '', notes: '', uuid: '' } })}\r\n\r\n`);
        return;
      }
      if (req.url === '/v1/macro/Song%20starts/trigger') return res.writeHead(204).end();
      if (req.url === '/v1/message/Now%20playing/trigger' && req.method === 'POST') return res.writeHead(204).end();
      res.writeHead(404).end();
    });
  }).listen(0, '127.0.0.1');
  await new Promise((r) => pro.once('listening', r));

  // FreeShow: one REST endpoint for every action.
  const freeLog = [];
  let live = { id: 'show1', layout: 'L1', index: 0 };
  const show = {
    name: 'Sunday',
    settings: { activeLayout: 'L1' },
    slides: {
      s1: { group: 'Intro', notes: '', children: ['c1'] },
      c1: { group: '', notes: 'phosphor: visualizer galaxy' },
      s2: { group: 'Verse', notes: 'Phosphor: freeze on' },
    },
    layouts: { L1: { slides: [{ id: 's1' }, { id: 'missing' }, { id: 's2' }] } },
  };
  const free = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      if (req.headers.authorization !== 'Bearer letmein') return res.writeHead(401).end(JSON.stringify({ status: 401, error: 'Unauthorized' }));
      const data = JSON.parse(body || '{}');
      freeLog.push(data);
      const reply = (value) => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ...data, data: value }));
      if (data.action === 'get_variables') return reply([{ id: 'v1', name: 'Phosphor title', type: 'text' }, { id: 'v2', name: 'phosphor_artist', type: 'text' }, { id: 'v3', name: 'Phosphor titles', type: 'text' }]);
      if (data.action === 'get_output') return reply({ slide: live });
      if (data.action === 'get_show') return reply(show);
      res.writeHead(204).end();
    });
  }).listen(0, '127.0.0.1');
  await new Promise((r) => free.once('listening', r));

  const ran = [];
  const statuses = [];
  const link = createStageLink({
    onCommand: async (name, params) => ran.push({ name, params }),
    onStatus: (s) => statuses.push(s),
    pollMs: 100,
    retryMs: 200,
  });
  const until = async (test, ms = 4000) => {
    const end = Date.now() + ms;
    while (Date.now() < end && !test()) await new Promise((r) => setTimeout(r, 25));
    return test();
  };
  link.configure({
    propresenter: { enabled: true, host: '127.0.0.1', port: pro.address().port, notes: true, macro: 'Song starts', message: 'Now playing' },
    freeshow: { enabled: true, host: '127.0.0.1', port: free.address().port, password: 'letmein', notes: true, variables: true, action: 'Visuals on' },
  });
  check('ProPresenter: connects and says which version', await until(() => link.status.propresenter.state === 'connected' && link.status.propresenter.detail.includes('ProPresenter 7.16')), JSON.stringify(link.status.propresenter));
  await until(() => streamResponse);
  streamResponse.write(`${JSON.stringify({ current: { text: 'Verse 1', notes: 'Pastor notes\nphosphor: visualizer aurora', uuid: 'B' } })}\r\n\r\n`);
  check('...a live slide’s notes commands run when the slide goes live', await until(() => ran.some((c) => c.name === 'visualizer' && c.params.id === 'aurora')), JSON.stringify(ran));
  const before = ran.length;
  streamResponse.write(`${JSON.stringify({ current: { text: 'Verse 1', notes: 'Pastor notes\nphosphor: visualizer aurora', uuid: 'B' } })}\r\n\r\n`);
  await new Promise((r) => setTimeout(r, 200));
  check('...and only once per slide (an update for the same slide does not run them again)', ran.filter((c) => c.params.id === 'aurora').length === 1 && ran.length >= before);

  check('FreeShow: connects with its password', await until(() => link.status.freeshow.state === 'connected'), JSON.stringify(link.status.freeshow));
  live = { id: 'show1', layout: 'L1', index: 1 };
  check('...follows the live slide, counting child slides as FreeShow does, and runs its notes', await until(() => ran.some((c) => c.name === 'visualizer' && c.params.id === 'galaxy')), JSON.stringify(ran));
  live = { id: 'show1', layout: 'L1', index: 2 };
  check('...(a missing slide in a layout is skipped, as FreeShow does)', await until(() => ran.some((c) => c.name === 'freeze' && c.params.on === 'on')));

  link.update({ title: 'Song {1}', artist: 'Band', visualizer: 'aurora' });
  check('a new song triggers the ProPresenter macro', await until(() => proLog.includes('GET /v1/macro/Song%20starts/trigger')), proLog.slice(-3).join(' | '));
  const message = proLog.find((l) => l.startsWith('POST /v1/message/Now%20playing/trigger'));
  check('...and fills the ProPresenter message’s Title and Artist tokens', await until(() => proLog.some((l) => l.startsWith('POST /v1/message/Now%20playing/trigger'))) && JSON.stringify(JSON.parse((message ?? proLog.find((l) => l.startsWith('POST /v1/message')) ?? '').split(' ').slice(2).join(' ') || 'null')) === JSON.stringify([{ name: 'Title', text: { text: 'Song {1}' } }, { name: 'Artist', text: { text: 'Band' } }]));
  check('...sets FreeShow’s phosphor_title and phosphor_artist variables, by exact name only', await until(() => freeLog.some((d) => d.action === 'change_variable' && d.id === 'v2')) && freeLog.some((d) => d.action === 'change_variable' && d.id === 'v1' && d.key === 'text' && d.value === 'Song (1)') && !freeLog.some((d) => d.action === 'change_variable' && d.id === 'v3'), JSON.stringify(freeLog.filter((d) => d.action === 'change_variable')));
  check('...and runs the FreeShow action by name', await until(() => freeLog.some((d) => d.action === 'name_run_action' && d.value === 'Visuals on')));

  link.configure({ propresenter: { enabled: false }, freeshow: { enabled: true, host: '127.0.0.1', port: free.address().port, password: 'wrong' } });
  check('a wrong FreeShow password is reported as such', await until(() => link.status.freeshow.state === 'error' && /password/.test(link.status.freeshow.detail)), JSON.stringify(link.status.freeshow));
  check('turning ProPresenter off stops it', link.status.propresenter.state === 'off');
  const closed = createServer().listen(0, '127.0.0.1');
  await new Promise((r) => closed.once('listening', r));
  const closedPort = closed.address().port;
  await new Promise((r) => closed.close(r));
  link.configure({ freeshow: { enabled: true, host: '127.0.0.1', port: closedPort, password: '' } });
  check('a FreeShow that is not running is reported plainly', await until(() => link.status.freeshow.state === 'error' && /not answering/.test(link.status.freeshow.detail)), JSON.stringify(link.status.freeshow));
  link.stop();
  streamResponse?.end();
  pro.closeAllConnections?.();
  pro.close();
  free.close();
}

console.log('\n== Desktop app: NDI output (with a stand-in for the NDI runtime) ==');
{
  const win = ndiCandidates({ env: { NDI_RUNTIME_DIR_V6: 'C:\\Program Files\\NDI\\NDI 6 Runtime\\v6' }, platform: 'win32', arch: 'x64' });
  check('on Windows the runtime is looked for where its installer says first (NDI_RUNTIME_DIR_V6)', win[0] === 'C:\\Program Files\\NDI\\NDI 6 Runtime\\v6\\Processing.NDI.Lib.x64.dll', win[0]);
  const mac = ndiCandidates({ env: {}, platform: 'darwin' });
  check('on a Mac, /usr/local/lib/libndi.dylib first (where NDI Tools puts it)', mac[0] === '/usr/local/lib/libndi.dylib', mac[0]);
  const missing = await loadNdi({ env: {}, exists: () => false }).catch((e) => e);
  check('without the runtime, turning NDI on says to install NDI Tools', missing?.code === 'NDI_MISSING' && /NDI Tools/.test(missing.message), missing?.message);

  let compiler = null;
  for (const cc of ['cc', 'clang', 'gcc']) {
    try {
      execFileSync(cc, ['--version'], { stdio: 'ignore' });
      compiler = cc;
      break;
    } catch {
      /* next */
    }
  }
  if (process.platform === 'win32' || !compiler) {
    console.log('  note  no C compiler here (or Windows): the NDI calls were not checked against a stand-in runtime');
  } else {
    const dir = mkdtempSync(path.join(tmpdir(), 'phosphor-ndi-'));
    const library = path.join(dir, process.platform === 'darwin' ? 'libfake-ndi.dylib' : 'libfake-ndi.so');
    execFileSync(compiler, ['-shared', '-fPIC', '-O1', '-o', library, path.join(here, 'test-fixtures', 'fake-ndi.c')]);
    const sender = await createNdiSender({ name: 'Phosphor (test)', env: { PHOSPHOR_NDI_LIBRARY: library } });
    const frame = (value) => new Uint8Array(4 * 2 * 4).fill(value);
    sender.send(frame(1), 4, 2, 30);
    sender.send(frame(2), 4, 2, 30);
    sender.send(frame(3), 4, 2, 30);
    const { default: koffi } = await import('koffi');
    const fake = koffi.load(library);
    const statsOf = fake.func('void fake_ndi_stats(int64_t *out)');
    const nameOf = fake.func('const char *fake_ndi_name(void)');
    const read = () => {
      const out = koffi.alloc('int64_t', 19);
      statsOf(out);
      const values = Array.from(koffi.decode(out, 'int64_t', 19), Number);
      koffi.free(out);
      return values;
    };
    let s = read();
    check('the source is created under its name, with NDI left to pace nothing (Phosphor paces frames)', nameOf() === 'Phosphor (test)' && s[1] === 1 && s[16] === 0, `${nameOf()}, clock_video=${s[16]}`);
    check('frames arrive as progressive BGRA with the right size, stride and rate', s[2] === 3 && s[5] === 4 && s[6] === 2 && s[7] === 0x41524742 && s[8] === 16 && s[9] / s[10] === 30 && s[11] === 1 && s[14] === 2000, s.slice(2, 15).join(','));
    check('...with timecodes left to NDI and no metadata', s[12] === Number(9223372036854775807n) && s[17] === 1);
    check('...and the pixels of the frame sent', s[15] === 0x03030303, s[15].toString(16));
    check('a frame’s memory is left alone while NDI may still be reading it (no corrupt frames)', s[4] === 0, `${s[4]} corrupt`);
    sender.send(new Uint8Array(8 * 4 * 4).fill(9), 8, 4, 60);
    s = read();
    check('a new size works (NDI finishes with the old memory first)', s[5] === 8 && s[6] === 4 && s[3] >= 1 && s[4] === 0);
    check('receivers are counted', sender.connections() === 2);
    sender.close();
    s = read();
    check('closing flushes and destroys the source', s[13] === 1 && s[3] >= 2);
  }
}

console.log(`\n${failures ? `${failures} failed` : 'all passed'}`);
process.exit(failures ? 1 : 0);
