import { defineConfig } from 'vite';

// Spotify only accepts http redirect URIs on a loopback IP literal, so the dev
// server binds to 127.0.0.1 (not "localhost") and keeps a fixed port.
export default defineConfig({
  base: './',
  server: { host: '127.0.0.1', port: 5173, strictPort: true },
  preview: { host: '127.0.0.1', port: 5173, strictPort: true },
  build: { target: 'es2022', chunkSizeWarningLimit: 1500 },
});
