// A local stand-in for Spotify, used only by scripts/verify.cjs.
//
// Real Spotify needs a Premium account and app credentials, so the test suite
// exercises the integration against this simulation of the documented
// behaviour instead: the accounts service (authorize + PKCE token exchange +
// refresh), the Web API endpoints the app calls, and the Web Playback SDK.
// It proves the app's own logic end to end. It cannot prove that the real
// service behaves the way the documentation says.

const crypto = require('node:crypto');

const { FRAME_PLAYER_SOURCE, routeFramePlayer } = require('./frame-player.cjs');

const TRACKS = Array.from({ length: 12 }, (_, i) => ({
  uri: `spotify:track:mock${i}`,
  id: `mock${i}`,
  name: `Mock Song ${i + 1}`,
  type: 'track',
  duration_ms: 40672,
  artists: [{ name: 'The Simulators' }],
  album: { name: 'Stand-In Sessions', images: [{ url: 'https://i.scdn.co/image/mock-cover' }] },
}));

// 8-second songs for tests that let a track play all the way to its end.
const SHORT = [1, 2, 3].map((n) => ({
  uri: `spotify:track:short${n}`,
  id: `short${n}`,
  name: `Short Song ${n}`,
  type: 'track',
  duration_ms: 8046,
  artists: [{ name: 'The Simulators' }],
  album: { name: 'Quick Takes', images: [{ url: 'https://i.scdn.co/image/mock-cover' }] },
}));

// The simulated Web Playback SDK, served in place of sdk.scdn.co/spotify-player.js.
// Like the real one, it plays inside a cross-origin iframe and reports state
// only when something changes (never on a timer). At the end of a one-track
// context it moves the track into previous_tracks, pauses back at 0 and
// reports that, usually twice. Test switches on window:
//   __fakeSpotifyAutoplay = true      after the end, start Spotify's own pick a moment later
//   __fakeSpotifyAutoplay = 'direct'  at the end, jump straight to Spotify's pick (no paused report)
//   __fakeSpotifyRelink = true        play a relinked copy (different URI, same song)
//   __fakeSpotifySilentEnd = true     report nothing at the end (only getCurrentState knows)
const SDK_SOURCE = `
(() => {
  ${FRAME_PLAYER_SOURCE}
  const RADIO = ${JSON.stringify(TRACKS[11])};
  class Player {
    constructor(opts) {
      this.opts = opts; this.listeners = {}; this.track = null; this.loading = false; this.previous = []; this.vol = opts.volume ?? 1;
      this.fp = new FramePlayer('https://sdk.scdn.co/embedded/index.html');
      this.fp.on('playing', () => { if (!this.loading) this.report(); });
      this.fp.on('pause', (m) => { if (!m.ended) this.report(); });
      this.fp.on('seeked', () => this.report());
      this.fp.on('ended', () => void this.finishTrack());
      window.__fakeSpotify = this;
    }
    get audio() { return { ...this.fp.audio, volume: this.vol }; }
    addListener(name, cb) { (this.listeners[name] ??= []).push(cb); return true; }
    emit(name, payload) { for (const cb of this.listeners[name] ?? []) cb(payload); }
    snapshot(over = {}) {
      if (!this.track) return null;
      const c = this.fp.cached;
      // After the end, the real SDK reports the track paused back at 0.
      return { paused: c.paused || c.ended, loading: this.loading, position: c.ended ? 0 : Math.round(c.t * 1000),
        duration: Math.round((c.d || this.track.duration_ms / 1000) * 1000), timestamp: Date.now(),
        track_window: { current_track: this.track, previous_tracks: this.previous.slice(), next_tracks: [] }, ...over };
    }
    report(over) { const s = this.snapshot(over); if (s) this.emit('player_state_changed', s); }
    async finishTrack() {
      const done = this.track;
      if (window.__fakeSpotifyAutoplay === 'direct') { this.previous = [done]; await this.startRadio(done); return; }
      this.previous = [done];
      if (window.__fakeSpotifySilentEnd) return;
      // The report describes the moment the track ended, including the repeat.
      const ended = this.snapshot({ paused: true, position: 0 });
      this.emit('player_state_changed', ended);
      setTimeout(() => this.emit('player_state_changed', { ...ended, timestamp: Date.now() }), 120);
      if (window.__fakeSpotifyAutoplay) setTimeout(() => { if (this.track === done) void this.startRadio(done); }, 900);
    }
    async startRadio(after) {
      window.__fakeSpotifyRadioStarted = true;
      this.track = RADIO; this.previous = [after]; this.loading = true; this.report({ paused: false });
      await this.fp.send('load', { src: 'https://sdk.scdn.co/mock-audio/signal-check.mp3', play: true });
      this.loading = false; this.report();
    }
    async connect() {
      const token = await new Promise((resolve) => this.opts.getOAuthToken(resolve));
      if (!token) { setTimeout(() => this.emit('authentication_error', { message: 'no token' }), 0); return true; }
      if (window.__fakeSpotifyFree) { setTimeout(() => this.emit('account_error', { message: 'premium required' }), 0); return true; }
      setTimeout(() => this.emit('ready', { device_id: 'mock-device-1' }), 30);
      return true;
    }
    disconnect() { void this.fp.send('pause'); }
    async activateElement() {}
    async pause() { await this.fp.send('pause'); }
    async resume() { await this.fp.send('play'); }
    async seek(ms) { await this.fp.send('seek', { t: ms / 1000 }); }
    async setVolume(v) { this.vol = v; await this.fp.send('volume', { v }); }
    async getVolume() { return this.vol; }
    async getCurrentState() { return this.snapshot(); }
    // Called by the simulated Web API when the app asks Spotify to play a URI on this device.
    async __play(track) {
      this.previous = [];
      this.track = window.__fakeSpotifyRelink ? { ...track, uri: track.uri.replace(':track:', ':track:relinked-'), id: 'relinked-' + track.id } : track;
      this.loading = true; this.report({ paused: false });
      const file = track.duration_ms <= 10000 ? 'signal-check-short.mp3' : 'signal-check.mp3';
      await this.fp.send('load', { src: 'https://sdk.scdn.co/mock-audio/' + file, play: true });
      this.loading = false; this.report();
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
  // "Mock Mix": removed and local entries included, as real playlists have. Tests add to it.
  const pl1Items = [{ item: TRACKS[3] }, { item: null }, { item: { ...TRACKS[4], is_local: true } }, { item: TRACKS[5] }];
  const json = (route, status, body) => route.fulfill({ status, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(body) });
  const preflight = (route) =>
    route.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'GET,PUT,POST,DELETE,OPTIONS' } });

  await context.route('https://sdk.scdn.co/spotify-player.js', (route) => route.fulfill({ contentType: 'application/javascript', body: SDK_SOURCE }));
  await routeFramePlayer(context, 'https://sdk.scdn.co', '/embedded/index.html');
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
    if (path === '/playlists/pl1/items') return json(route, 200, page(pl1Items));
    if (path === '/playlists/pl1/tracks') return json(route, 404, { error: { status: 404, message: 'Not found' } });
    if (path === '/playlists/pl1') return json(route, 200, { id: 'pl1', name: 'Mock Mix', owner: { display_name: 'Mock Listener' } });
    if (path === '/albums/album1/tracks') return json(route, 200, page(TRACKS.slice(6, 9).map(({ album, ...t }) => t)));
    if (path === '/albums/album1') return json(route, 200, { id: 'album1', name: 'Stand-In Sessions', artists: [{ name: 'The Simulators' }], images: [{ url: 'https://i.scdn.co/image/mock-cover' }] });
    if (path.startsWith('/tracks/')) {
      const t = [...TRACKS, ...SHORT].find((x) => x.id === path.slice(8));
      return t ? json(route, 200, t) : json(route, 404, { error: { status: 404, message: 'Not found' } });
    }
    if (path === '/me/player/play' && req.method() === 'PUT') {
      const body = JSON.parse(req.postData() ?? '{}');
      log.playRequests.push({ device: url.searchParams.get('device_id'), uris: body.uris });
      if (url.searchParams.get('device_id') !== 'mock-device-1') return json(route, 404, { error: { status: 404, message: 'Device not found' } });
      const track = [...TRACKS, ...SHORT].find((t) => t.uri === body.uris?.[0]);
      if (!track) return json(route, 400, { error: { status: 400, message: 'Invalid track uri' } });
      // Like the real service: accept the command, then the device starts playing.
      req.frame().page().evaluate((t) => void window.__fakeSpotify.__play(t), track).catch(() => {});
      return route.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*' } });
    }
    return json(route, 404, { error: { status: 404, message: `mock has no ${path}` } });
  });

  return {
    log,
    expireTokens: () => validTokens.clear(),
    /** Adds a song to "Mock Mix" on the simulated Spotify side, as if the user did it in Spotify. */
    addToMockMix: (index) => {
      const entry = { item: TRACKS[index] };
      pl1Items.push(entry);
      return () => pl1Items.splice(pl1Items.indexOf(entry), 1);
    },
  };
}

module.exports = { installSpotifyMock, SPOTIFY_TRACKS: TRACKS, SPOTIFY_SHORT: SHORT };
