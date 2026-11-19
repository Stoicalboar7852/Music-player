// Optional, off by default: Spotify through librespot, an open-source
// Spotify client (https://github.com/librespot-org/librespot, MIT licence).
// Spotify's terms don't allow unofficial clients, which is why this is a
// setting the user has to turn on, with a warning.
//
// librespot runs as a Spotify Connect device named "Phosphor" and writes the
// decoded audio to its standard output (--backend pipe: signed 16-bit,
// 44.1 kHz stereo). The page controls it through the Web API like any Connect
// device, and plays (and visualizes) the audio itself, so no capture is needed.

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

/** Signed 16-bit stereo at 44.1 kHz. */
export const BYTES_PER_SECOND = 44100 * 2 * 2;
/** How far ahead of real time the audio may be read. */
const LEAD_SECONDS = 0.5;

/** Where the binary is: in the app's resources when packaged, desktop/bin/<os>-<arch> (mac-arm64, win-x64, linux-x64) when not. */
export function librespotPath(resourcesPath, here) {
  const exe = process.platform === 'win32' ? 'librespot.exe' : 'librespot';
  const os = { darwin: 'mac', win32: 'win' }[process.platform] ?? process.platform;
  const candidates = [
    process.env.PHOSPHOR_LIBRESPOT,
    resourcesPath && path.join(resourcesPath, 'bin', exe),
    path.join(here, 'bin', `${os}-${process.arch}`, exe),
  ].filter(Boolean);
  return candidates.find((p) => existsSync(p)) ?? null;
}

/**
 * @param {{ binary: string | null, cacheDir: string, onAudio(chunk: Buffer): void, onState(state: object): void }} options
 */
export function createLibrespot({ binary, cacheDir, onAudio, onState }) {
  /** @type {import('node:child_process').ChildProcess | null} */
  let child = null;
  let log = '';
  let stopping = false;

  const report = (status, extra = {}) => onState({ status, available: Boolean(binary), log: log.slice(-2000), ...extra });

  return {
    get available() {
      return Boolean(binary);
    },
    get running() {
      return Boolean(child);
    },
    /** Starts librespot signed in with the page's Spotify access token (it needs the streaming scope). */
    start({ token, name = 'Phosphor', bitrate = 320 }) {
      if (!binary) {
        report('missing');
        return;
      }
      this.stop();
      stopping = false;
      log = '';
      const args = [
        '--name', name,
        '--device-type', 'computer',
        '--backend', 'pipe',
        '--format', 'S16',
        '--bitrate', String(bitrate),
        '--initial-volume', '100',
        '--volume-ctrl', 'fixed',
        '--autoplay', 'off',
        '--disable-discovery',
        '--disable-audio-cache',
        '--cache', cacheDir,
      ];
      if (token) args.push('--access-token', token);
      const proc = spawn(binary, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
      child = proc;
      report('starting');
      // The pipe backend writes as fast as it can decode, and librespot counts
      // what it has written as played. Read at the speed it plays (half a
      // second ahead at most), so songs and positions keep real time.
      let sent = 0;
      let clock = 0;
      let lastData = 0;
      let holding = false;
      proc.stdout.on('data', (chunk) => {
        const now = performance.now();
        // A gap that wasn't ours (paused, or between songs): start the clock again.
        if (!clock || (!holding && now - lastData > 400)) {
          clock = now;
          sent = 0;
        }
        holding = false;
        lastData = now;
        sent += chunk.length;
        onAudio(chunk);
        const ahead = sent / BYTES_PER_SECOND - (now - clock) / 1000;
        if (ahead > LEAD_SECONDS) {
          holding = true;
          proc.stdout.pause();
          setTimeout(() => proc.stdout.resume(), (ahead - LEAD_SECONDS / 2) * 1000);
        }
      });
      proc.stderr.on('data', (data) => {
        log += String(data);
        if (log.length > 20000) log = log.slice(-10000);
        // librespot logs when it has signed in and is ready for Connect.
        if (/Authenticated as|Connected to AP/i.test(String(data))) report('ready');
        if (/Bad credentials|Login failed|Authentication failed|authentication error|PermissionDenied/i.test(String(data))) report('auth-failed');
        else if (/could not initialize spirc|Tried too many access points/i.test(String(data))) report('unreachable');
      });
      proc.on('error', (error) => {
        log += `\n${error.message}`;
        if (child === proc) child = null;
        report('failed', { error: error.message });
      });
      // 'close', not 'exit': the audio still in the pipe has been read by then.
      proc.on('close', (code, signal) => {
        if (child === proc) child = null;
        report(stopping ? 'stopped' : 'exited', { code, signal });
      });
    },
    stop() {
      if (!child) return;
      stopping = true;
      child.kill();
      child = null;
    },
  };
}
