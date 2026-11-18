import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { defineConfig, type Plugin } from 'vite';

/**
 * Writes the service worker (from src/service-worker.js) into the build with
 * the list of every file the app needs, so the installed app opens and plays
 * local files without a connection. The cache is named after a hash of that
 * list, so each new build replaces the previous one.
 */
function serviceWorker(): Plugin {
  let publicDir = '';
  let root = '';
  const walk = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);
      return statSync(path).isDirectory() ? walk(path) : [path];
    });
  return {
    name: 'phosphor-service-worker',
    apply: 'build',
    configResolved(config) {
      publicDir = config.publicDir;
      root = config.root;
    },
    generateBundle(_options, bundle) {
      const built = Object.keys(bundle).filter((file) => file !== 'index.html' && !file.endsWith('.map'));
      const copied = publicDir ? walk(publicDir).map((path) => relative(publicDir, path).split(sep).join('/')) : [];
      const files = ['./', ...[...built, ...copied].sort().map((file) => `./${file}`)];
      const version = createHash('sha256').update(files.join('\n')).digest('hex').slice(0, 12);
      const source = readFileSync(join(root, 'src/service-worker.js'), 'utf8')
        .replace('self.__PRECACHE__', JSON.stringify(files))
        .replace('__VERSION__', version);
      this.emitFile({ type: 'asset', fileName: 'sw.js', source });
    },
  };
}

// Spotify only accepts http redirect URIs on a loopback IP literal, so the dev
// server binds to 127.0.0.1 (not "localhost") and keeps a fixed port.
export default defineConfig({
  base: './',
  server: { host: '127.0.0.1', port: 5173, strictPort: true },
  preview: { host: '127.0.0.1', port: 5173, strictPort: true },
  build: { target: 'es2022', chunkSizeWarningLimit: 1500 },
  plugins: [serviceWorker()],
});
