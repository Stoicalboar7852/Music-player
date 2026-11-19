#!/usr/bin/env node
// Stands in for librespot in desktop/test.mjs: records its arguments, says it
// signed in, then writes eight seconds of a 220 Hz tone to stdout as fast as
// it can (as librespot's pipe backend does), and exits.
import { writeFileSync } from 'node:fs';

const out = process.env.FAKE_LIBRESPOT_ARGS;
if (out) writeFileSync(out, JSON.stringify(process.argv.slice(2)));
if (process.argv.includes('--access-token') && process.argv[process.argv.indexOf('--access-token') + 1] === 'bad') {
  process.stderr.write('[ERROR librespot_core::session] Authentication failed: Bad credentials\n');
  process.exit(1);
}
process.stderr.write('[INFO  librespot_core::session] Connected to AP "ap.fake:4070"\n[INFO  librespot_core::session] Authenticated as "tester" !\n');
const rate = 44100;
const seconds = 8;
const chunkFrames = 4096;
let frame = 0;
function write() {
  while (frame < rate * seconds) {
    const buf = Buffer.alloc(chunkFrames * 4);
    for (let i = 0; i < chunkFrames; i++) {
      const v = Math.round(Math.sin((2 * Math.PI * 220 * (frame + i)) / rate) * 12000);
      buf.writeInt16LE(v, i * 4);
      buf.writeInt16LE(v, i * 4 + 2);
    }
    frame += chunkFrames;
    if (!process.stdout.write(buf)) {
      process.stdout.once('drain', write);
      return;
    }
  }
  process.stdout.end();
}
write();
