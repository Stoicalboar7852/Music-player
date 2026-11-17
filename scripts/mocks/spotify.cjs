// A local stand-in for Spotify, used only by scripts/verify.cjs.
//
// Real Spotify needs a Premium account and app credentials, so the test suite
// exercises the integration against this simulation of the documented
// behaviour instead: the accounts service (authorize + PKCE token exchange +
// refresh), the Web API endpoints the app calls, and the Web Playback SDK.
// It proves the app's own logic end to end. It cannot prove that the real
// service behaves the way the documentation says.

const crypto = require('node:crypto');

const TRACKS = Array.from({ length: 12 }, (_, i) => ({
  uri: `spotify:track:mock${i}`,
  id: `mock${i}`,
  name: `Mock Song ${i + 1}`,
  type: 'track',
  duration_ms: 40672,
  artists: [{ name: 'The Simulators' }],
  album: { name: 'Stand-In Sessions', images: [{ url: 'https://i.scdn.co/image/mock-cover' }] },
}));

// The fake Web Playback SDK, served in place of sdk.scdn.co/spotify-player.js.
// It plays a local file through a plain <audio> element, which, like the real
// SDK's protected stream, never touches the app's Web Audio graph.
const SDK_SOURCE = `
(() => {
  class Player {
    constructor(opts) { this.opts = opts; this.listeners = {}; this.audio = new Audio(); this.audio.volume = opts.volume ?? 1; this.track = null; this.loading = false;
      const emit = () => this.emit('player_state_changed', this.state());
      for (const e of ['playing', 'pause', 'seeked']) this.audio.addEventListener(e, emit);
      // The real SDK reports a finished track as paused at position 0.
      this.audio.addEventListener('ended', () => { this.audio.pause(); this.audio.currentTime = 0; emit(); });
      window.__fakeSpotify = this;
    }
    addListener(name, cb) { (this.listeners[name] ??= []).push(cb); return true; }
    emit(name, payload) { for (const cb of this.listeners[name] ?? []) cb(payload); }
    state() {
      if (!this.track) return null;
      return { paused: this.audio.paused, loading: this.loading, position: Math.round(this.audio.currentTime * 1000),
        duration: Math.round((this.audio.duration || 40.672) * 1000), timestamp: Date.now(),
        track_window: { current_track: this.track, previous_tracks: [], next_tracks: [] } };
    }
    async connect() {
      const token = await new Promise((resolve) => this.opts.getOAuthToken(resolve));
      if (!token) { setTimeout(() => this.emit('authentication_error', { message: 'no token' }), 0); return true; }
      if (window.__fakeSpotifyFree) { setTimeout(() => this.emit('account_error', { message: 'premium required' }), 0); return true; }
      setTimeout(() => this.emit('ready', { device_id: 'mock-device-1' }), 30);
      return true;
    }
    disconnect() { this.audio.pause(); }
    async activateElement() {}
    async pause() { this.audio.pause(); }
    async resume() { await this.audio.play(); }
    async seek(ms) { this.audio.currentTime = ms / 1000; }
    async setVolume(v) { this.audio.volume = v; }
    async getVolume() { return this.audio.volume; }
    async getCurrentState() { return this.state(); }
    // Called by the mock Web API when the app asks Spotify to play a URI on this device.
    async __play(track) {
      this.track = track; this.loading = true; this.emit('player_state_changed', this.state());
      // A blob URL is fully seekable, like the SDK's own stream.
      window.__fakeSpotifyBlob ??= URL.createObjectURL(await (await fetch('/.verify/audio/signal-check.mp3')).blob());
      this.audio.src = window.__fakeSpotifyBlob;
      await this.audio.play(); this.loading = false; this.emit('player_state_changed', this.state());
    }
  }
  window.Spotify = { Player };
  window.onSpotifyWebPlaybackSDKReady?.();
})();`;

/**
 * Installs the mock on a browser context. Returns a log of what the app sent,
 * so the test can assert on real requests rather than on internal state.
 */
async function installSpotifyMock(context, { clientId = 'mock-client-id' } = {}) {
  const log = { authorize: null, tokenRequests: [], apiCalls: [], pkceVerified: false, playRequests: [] };
  let challenge = null;
  let accessCounter = 0;
  const validTokens = new Set();
  const json = (route, status, body) => route.fulfill({ status, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(body) });
  const preflight = (route) =>
    route.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'GET,PUT,POST,DELETE,OPTIONS' } });

  await context.route('https://sdk.scdn.co/spotify-player.js', (route) => route.fulfill({ contentType: 'application/javascript', body: SDK_SOURCE }));
  await context.route('https://i.scdn.co/**', (route) =>
    route.fulfill({ path: require('node:path').resolve('.verify/audio/cover.png'), headers: { 'access-control-allow-origin': '*' } }),
  );

  await context.route('https://accounts.spotify.com/authorize**', (route) => {
    const q = new URL(route.request().url()).searchParams;
    log.authorize = Object.fromEntries(q);
    challenge = q.get('code_challenge');
    const problems = [];
    if (q.get('client_id') !== clientId) problems.push('client_id');
    if (q.get('response_type') !== 'code') problems.push('response_type');
    if (q.get('code_challenge_method') !== 'S256') problems.push('code_challenge_method');
    if (!/^http:\/\/127\.0\.0\.1[:/]|^https:/.test(q.get('redirect_uri') ?? '')) problems.push('redirect_uri');
    if (!(q.get('scope') ?? '').split(' ').includes('streaming')) problems.push('scope');
    log.authorizeProblems = problems;
    const back = new URL(q.get('redirect_uri'));
    if (problems.length) back.searchParams.set('error', 'invalid_request');
    else back.searchParams.set('code', 'mock-auth-code');
    back.searchParams.set('state', q.get('state'));
    return route.fulfill({ status: 302, headers: { location: back.href } });
  });

  await context.route('https://accounts.spotify.com/api/token', (route) => {
    const req = route.request();
    if (req.method() === 'OPTIONS') return preflight(route);
    const body = Object.fromEntries(new URLSearchParams(req.postData() ?? ''));
    log.tokenRequests.push(body);
    if (body.client_id !== clientId) return json(route, 400, { error: 'invalid_client' });
    if (body.grant_type === 'authorization_code') {
      // What the real server does with PKCE: hash the verifier, compare with the challenge.
      const expected = crypto.createHash('sha256').update(body.code_verifier ?? '').digest('base64url');
      log.pkceVerified = expected === challenge && body.code === 'mock-auth-code';
      if (!log.pkceVerified) return json(route, 400, { error: 'invalid_grant', error_description: 'code_verifier was incorrect' });
    } else if (body.grant_type === 'refresh_token') {
      if (body.refresh_token !== 'mock-refresh') return json(route, 400, { error: 'invalid_grant' });
    } else return json(route, 400, { error: 'unsupported_grant_type' });
    const access = `mock-access-${++accessCounter}`;
    validTokens.add(access);
    return json(route, 200, { access_token: access, token_type: 'Bearer', expires_in: 3600, refresh_token: 'mock-refresh', scope: 'streaming' });
  });

  await context.route('https://api.spotify.com/v1/**', async (route) => {
    const req = route.request();
    if (req.method() === 'OPTIONS') return preflight(route);
    const url = new URL(req.url());
    const path = url.pathname.replace('/v1', '');
    const token = (req.headers().authorization ?? '').replace('Bearer ', '');
    log.apiCalls.push(`${req.method()} ${path}${url.search}`);
    if (!validTokens.has(token)) return json(route, 401, { error: { status: 401, message: 'The access token expired' } });
    const page = (items) => ({ items, next: null, total: items.length });

    if (path === '/me') return json(route, 200, { id: 'mockuser', display_name: 'Mock Listener', product: 'premium' });
    if (path === '/search') {
      if (Number(url.searchParams.get('limit')) > 10) return json(route, 400, { error: { status: 400, message: 'Invalid limit' } });
      return json(route, 200, {
        tracks: page(TRACKS.slice(0, 10)),
        albums: page([{ id: 'album1', name: 'Stand-In Sessions', artists: [{ name: 'The Simulators' }], images: [{ url: 'https://i.scdn.co/image/mock-cover' }] }]),
        // Real search results contain nulls for unavailable playlists.
        playlists: page([null, { id: 'pl1', name: 'Mock Mix', owner: { display_name: 'Mock Listener' }, images: null }]),
      });
    }
    if (path === '/me/playlists') {
      if (Number(url.searchParams.get('limit')) > 10) return json(route, 400, { error: { status: 400, message: 'Invalid limit' } });
      return json(route, 200, page([{ id: 'pl1', name: 'Mock Mix', owner: { display_name: 'Mock Listener' }, images: [] }]));
    }
    // Post-February-2026 shape: /items, and each entry carries the track under "item".
    if (path === '/playlists/pl1/items') return json(route, 200, page([{ item: TRACKS[3] }, { item: null }, { item: { ...TRACKS[4], is_local: true } }, { item: TRACKS[5] }]));
    if (path === '/playlists/pl1/tracks') return json(route, 404, { error: { status: 404, message: 'Not found' } });
    if (path === '/playlists/pl1') return json(route, 200, { id: 'pl1', name: 'Mock Mix', owner: { display_name: 'Mock Listener' } });
    if (path === '/albums/album1/tracks') return json(route, 200, page(TRACKS.slice(6, 9).map(({ album, ...t }) => t)));
    if (path === '/albums/album1') return json(route, 200, { id: 'album1', name: 'Stand-In Sessions', artists: [{ name: 'The Simulators' }], images: [{ url: 'https://i.scdn.co/image/mock-cover' }] });
    if (path.startsWith('/tracks/')) {
      const t = TRACKS.find((x) => x.id === path.slice(8));
      return t ? json(route, 200, t) : json(route, 404, { error: { status: 404, message: 'Not found' } });
    }
    if (path === '/me/player/play' && req.method() === 'PUT') {
      const body = JSON.parse(req.postData() ?? '{}');
      log.playRequests.push({ device: url.searchParams.get('device_id'), uris: body.uris });
      if (url.searchParams.get('device_id') !== 'mock-device-1') return json(route, 404, { error: { status: 404, message: 'Device not found' } });
      const track = TRACKS.find((t) => t.uri === body.uris?.[0]);
      if (!track) return json(route, 400, { error: { status: 400, message: 'Invalid track uri' } });
      // Like the real service: accept the command, then the device starts playing.
      req.frame().page().evaluate((t) => void window.__fakeSpotify.__play(t), track).catch(() => {});
      return route.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*' } });
    }
    return json(route, 404, { error: { status: 404, message: `mock has no ${path}` } });
  });

  return { log, expireTokens: () => validTokens.clear() };
}

module.exports = { installSpotifyMock, SPOTIFY_TRACKS: TRACKS };
