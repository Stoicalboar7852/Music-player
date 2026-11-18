// Phosphor's service worker (built into sw.js by the plugin in vite.config.ts,
// which fills in the file list). It keeps the app itself (the page, scripts,
// styles, icons, thumbnails, the MilkDrop presets) available offline, so the
// installed app opens without a connection and plays local files and the demo.
// Music, sign-ins and the streaming services always go to the network:
// nothing from another site is ever cached.

const CACHE = 'phosphor-__VERSION__';
const FILES = self.__PRECACHE__;

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(FILES)));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key.startsWith('phosphor-') && key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin) return;

  // The page: from the network when online (so a new version arrives), the kept copy offline.
  if (request.mode === 'navigate') {
    event.respondWith(fetch(request).catch(() => caches.open(CACHE).then((cache) => cache.match('./', { ignoreVary: true }))));
    return;
  }

  // Everything else from this site: the kept copy (built files have hashed
  // names, so a kept one is never stale), or the network. Module scripts are
  // requested with an Origin header the kept copies were fetched without, so
  // a server's "Vary: Origin" must not stop them matching.
  event.respondWith(
    caches
      .open(CACHE)
      .then((cache) => cache.match(request, { ignoreSearch: true, ignoreVary: true }))
      .then((hit) => hit || fetch(request)),
  );
});
