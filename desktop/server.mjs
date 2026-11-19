// A small static file server for the built web app (desktop/web), on the
// loopback address only. The desktop app loads Phosphor from it rather than
// from files, so the page has the same address as `npm run dev`
// (http://127.0.0.1:5173/), and the sign-ins registered for that address
// with Spotify and Google work unchanged.
//
// It also carries, for presentation software (see the README, Presenting
// with FreeShow or ProPresenter):
//  - /feed, a WebSocket over which the main window shares its analysis with
//    presenter pages elsewhere (present.html?feed, as a FreeShow web item or
//    an OBS browser source): they ask for frames, the main window answers;
//  - /api/command and /api/status, a small control API (with a key) that
//    FreeShow actions, Bitfocus Companion and the like can call.

import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { WebSocketServer } from 'ws';

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.wasm': 'application/wasm',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json',
};

/** The ports to try, in order: the development server's first, so registered sign-ins match. */
export const PORTS = [5173, 5199, 5198, 5197];

/** Length of a presenter's id (a UUID) at the start of each frame sent to it. */
const ID_LENGTH = 36;

/**
 * Serves `root` on 127.0.0.1. Resolves with the address once listening on
 * the first free port of `ports` (0 for any).
 *
 * @param {string} root
 * @param {{
 *   ports?: number[],
 *   apiKey?: string,
 *   hostKey?: string,
 *   onCommand?: (command: string, params: Record<string, string>) => unknown,
 *   status?: () => unknown,
 * }} [options]
 */
export async function startServer(root, { ports = PORTS, apiKey = '', hostKey = randomUUID(), onCommand, status } = {}) {
  const base = path.resolve(root);
  let port = 0;
  const ours = (host) => host === `127.0.0.1:${port}` || host === `localhost:${port}`;
  const server = createServer(async (request, response) => {
    // Only this machine, under its own name: refuses pages elsewhere that
    // point a hostname at 127.0.0.1 (DNS rebinding).
    const host = request.headers.host ?? '';
    if (!ours(host)) {
      response.writeHead(403).end();
      return;
    }
    if ((request.url ?? '').startsWith('/api/')) {
      await api(request, response);
      return;
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      response.writeHead(405, { allow: 'GET, HEAD' }).end();
      return;
    }
    let pathname;
    try {
      pathname = decodeURIComponent(new URL(request.url ?? '/', 'http://x').pathname);
    } catch {
      response.writeHead(400).end();
      return;
    }
    const file = path.resolve(base, `.${pathname.endsWith('/') ? `${pathname}index.html` : pathname}`);
    if (file !== base && !file.startsWith(base + path.sep)) {
      response.writeHead(403).end();
      return;
    }
    try {
      const info = await stat(file);
      if (!info.isFile()) throw new Error('not a file');
      const body = await readFile(file);
      const name = path.basename(file);
      response.writeHead(200, {
        'content-type': TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream',
        'content-length': body.length,
        // Built files have hashed names; the page and the service worker must stay fresh.
        'cache-control': pathname.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache',
        'x-content-type-options': 'nosniff',
        ...(name === 'sw.js' ? { 'service-worker-allowed': '/' } : {}),
      });
      response.end(request.method === 'HEAD' ? undefined : body);
    } catch {
      response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('Not found');
    }
  });

  // ---- the control API
  const json = (response, code, body) => {
    response.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    response.end(JSON.stringify(body));
  };
  async function api(request, response) {
    if (request.method !== 'GET' && request.method !== 'POST') return json(response, 405, { error: 'GET or POST' });
    const url = new URL(request.url ?? '/', 'http://x');
    const params = Object.fromEntries(url.searchParams);
    if (request.method === 'POST') {
      // A JSON body (FreeShow's REST command, Companion) adds to the query.
      const chunks = [];
      for await (const chunk of request) {
        chunks.push(chunk);
        if (chunks.reduce((n, c) => n + c.length, 0) > 16384) return json(response, 413, { error: 'too big' });
      }
      const text = Buffer.concat(chunks).toString();
      if (text.trim()) {
        try {
          Object.assign(params, JSON.parse(text));
        } catch {
          return json(response, 400, { error: 'the body must be JSON' });
        }
      }
    }
    const given = params.key ?? (request.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
    if (!apiKey || given !== apiKey) return json(response, 401, { error: 'missing or wrong key (Settings, Presentation software)' });
    delete params.key;
    if (url.pathname === '/api/status') return json(response, 200, (await status?.()) ?? {});
    if (url.pathname === '/api/command') {
      const command = String(params.do ?? params.command ?? '');
      delete params.do;
      delete params.command;
      if (!/^[a-z][a-z-]{1,40}$/.test(command)) return json(response, 400, { error: 'say what to do: ?do=next (see the README for the list)' });
      try {
        const result = await onCommand?.(command, Object.fromEntries(Object.entries(params).map(([k, v]) => [k, String(v).slice(0, 200)])));
        return json(response, 200, { ok: true, ...(result && typeof result === 'object' ? result : {}) });
      } catch (error) {
        return json(response, 400, { error: String(error?.message ?? error) });
      }
    }
    return json(response, 404, { error: 'no such endpoint: /api/command or /api/status' });
  }

  // ---- the feed: the main window's analysis, to presenter pages elsewhere
  const wss = new WebSocketServer({ noServer: true, maxPayload: 1 << 20 });
  /** @type {import('ws').WebSocket | null} */
  let feedHost = null;
  /** @type {Map<string, import('ws').WebSocket>} */
  const viewers = new Map();
  const feed = { viewers: 0 };
  server.on('upgrade', (request, socket, head) => {
    const url = new URL(request.url ?? '/', 'http://x');
    const origin = request.headers.origin;
    // Only Phosphor's own pages (or programs that send no Origin) may connect.
    const sameOrigin = !origin || origin === `http://127.0.0.1:${port}` || origin === `http://localhost:${port}`;
    const role = url.searchParams.get('role');
    if (url.pathname !== '/feed' || !ours(request.headers.host ?? '') || !sameOrigin || (role === 'host' && url.searchParams.get('key') !== hostKey) || (role !== 'host' && role !== 'viewer')) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(request, socket, head, (ws) => (role === 'host' ? acceptHost(ws) : acceptViewer(ws)));
  });
  function acceptHost(ws) {
    feedHost?.close();
    feedHost = ws;
    // Presenters already waiting say hello again.
    for (const id of viewers.keys()) ws.send(JSON.stringify({ type: 'hello', id }));
    ws.on('message', (data, binary) => {
      if (binary) {
        // A frame: the presenter's id, then the frame.
        const buffer = Buffer.isBuffer(data) ? data : Buffer.concat(/** @type {Buffer[]} */ (data));
        const viewer = viewers.get(buffer.subarray(0, ID_LENGTH).toString('latin1'));
        if (viewer?.readyState === 1) viewer.send(buffer.subarray(ID_LENGTH), { binary: true });
        return;
      }
      // State and close go to every presenter.
      for (const viewer of viewers.values()) if (viewer.readyState === 1) viewer.send(String(data));
    });
    ws.on('close', () => {
      if (feedHost === ws) feedHost = null;
    });
  }
  function acceptViewer(ws) {
    let id = '';
    ws.on('message', (data, binary) => {
      if (binary) return;
      let message;
      try {
        message = JSON.parse(String(data));
      } catch {
        return;
      }
      if (typeof message?.id !== 'string' || message.id.length !== ID_LENGTH) return;
      if (!id) {
        id = message.id;
        viewers.set(id, ws);
        feed.viewers = viewers.size;
      }
      if (message.id !== id) return;
      if (feedHost?.readyState === 1) feedHost.send(JSON.stringify(message));
    });
    ws.on('close', () => {
      if (!id) return;
      viewers.delete(id);
      feed.viewers = viewers.size;
      if (feedHost?.readyState === 1) feedHost.send(JSON.stringify({ type: 'bye', id }));
    });
  }

  for (const candidate of ports) {
    const ok = await new Promise((resolve) => {
      const onError = () => resolve(false);
      server.once('error', onError);
      server.listen(candidate, '127.0.0.1', () => {
        server.off('error', onError);
        resolve(true);
      });
    });
    if (ok) {
      port = /** @type {import('node:net').AddressInfo} */ (server.address()).port;
      const url = `http://127.0.0.1:${port}/`;
      return {
        url,
        origin: `http://127.0.0.1:${port}`,
        port,
        /** Where the main window connects to share its analysis (with hostKey). */
        feedUrl: `ws://127.0.0.1:${port}/feed`,
        hostKey,
        feed,
        close: () =>
          new Promise((r) => {
            for (const ws of wss.clients) ws.terminate();
            server.close(() => r(undefined));
          }),
      };
    }
  }
  throw new Error(`No free port among ${ports.join(', ')}`);
}
