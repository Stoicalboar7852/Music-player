// A small static file server for the built web app (desktop/web), on the
// loopback address only. The desktop app loads Phosphor from it rather than
// from files, so the page has the same address as `npm run dev`
// (http://127.0.0.1:5173/), and the sign-ins registered for that address
// with Spotify and Google work unchanged.

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';

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

/**
 * Serves `root` on 127.0.0.1. Resolves with the address once listening on
 * the first free port of `ports` (0 for any).
 */
export async function startServer(root, { ports = PORTS } = {}) {
  const base = path.resolve(root);
  let port = 0;
  const server = createServer(async (request, response) => {
    // Only this machine, under its own name: refuses pages elsewhere that
    // point a hostname at 127.0.0.1 (DNS rebinding).
    const host = request.headers.host ?? '';
    if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) {
      response.writeHead(403).end();
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
      return { url, origin: `http://127.0.0.1:${port}`, port, close: () => new Promise((r) => server.close(() => r(undefined))) };
    }
  }
  throw new Error(`No free port among ${ports.join(', ')}`);
}
