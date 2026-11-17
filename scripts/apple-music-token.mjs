#!/usr/bin/env node
// Generates an Apple Music developer token (an ES256-signed JWT) from the
// MusicKit private key in your Apple Developer account. Paste the output into
// Settings > Apple Music.
//
//   npm run apple-token -- --team-id ABCDE12345 --key-id 1A2B3C4D5E --key ./AuthKey_1A2B3C4D5E.p8
//
// Options:
//   --team-id   your 10-character Team ID (developer.apple.com > Membership details)
//   --key-id    the 10-character Key ID of your MusicKit key
//   --key       path to the downloaded AuthKey_XXXXXXXXXX.p8 file
//   --days      how long the token lasts; Apple's maximum is about 180 (default 180)
//   --origin    optional: restrict the token to a web origin, e.g. http://127.0.0.1:5173
//               (repeat the flag for more than one)
//
// The key never leaves your machine: this script only reads it to sign.

import { createPrivateKey, sign } from 'node:crypto';
import { readFileSync } from 'node:fs';

const args = process.argv.slice(2);
const values = (name) => args.flatMap((a, i) => (a === `--${name}` ? [args[i + 1]] : a.startsWith(`--${name}=`) ? [a.slice(name.length + 3)] : []));
const value = (name) => values(name)[0];

const teamId = value('team-id');
const keyId = value('key-id');
const keyPath = value('key');
const days = Number(value('days') ?? 180);
const origins = values('origin');

if (!teamId || !keyId || !keyPath) {
  console.error('Usage: npm run apple-token -- --team-id <TEAM_ID> --key-id <KEY_ID> --key <path to .p8> [--days 180] [--origin <url>]');
  process.exit(1);
}
if (!(days > 0 && days <= 183)) {
  console.error('--days must be between 1 and 183: Apple rejects developer tokens that last longer than about six months.');
  process.exit(1);
}

let key;
try {
  key = createPrivateKey(readFileSync(keyPath, 'utf8'));
} catch (error) {
  console.error(`Could not read a private key from ${keyPath}: ${error.message}`);
  process.exit(1);
}
if (key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails?.namedCurve !== 'prime256v1') {
  console.error('That key is not a P-256 key. Use the AuthKey_*.p8 file downloaded when creating a MusicKit key.');
  process.exit(1);
}

const b64 = (data) => Buffer.from(typeof data === 'string' ? data : JSON.stringify(data)).toString('base64url');
const now = Math.floor(Date.now() / 1000);
const header = { alg: 'ES256', kid: keyId };
const payload = { iss: teamId, iat: now, exp: now + Math.round(days * 86400), ...(origins.length ? { origin: origins } : {}) };
const signingInput = `${b64(header)}.${b64(payload)}`;
// JWTs use the raw r||s signature form, not the DER encoding OpenSSL defaults to.
const signature = sign('sha256', Buffer.from(signingInput), { key, dsaEncoding: 'ieee-p1363' }).toString('base64url');

console.log(`${signingInput}.${signature}`);
console.error(`\nDeveloper token for team ${teamId}, valid until ${new Date(payload.exp * 1000).toDateString()}.`);
