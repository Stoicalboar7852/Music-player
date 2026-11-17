// A local stand-in for MusicKit on the Web v3, used only by scripts/verify.cjs.
//
// Real Apple Music needs a paid developer membership and a subscription, so
// the tests run the integration against this simulation of MusicKit's
// documented surface: configure/authorize, the catalog and library API, the
// queue and transport, and its playback events. It checks the app's logic,
// not Apple's actual behaviour.

const path = require('node:path');

const SDK_SOURCE = `
(() => {
  const States = { none: 0, loading: 1, playing: 2, paused: 3, stopped: 4, ended: 5, seeking: 6, waiting: 8, stalled: 9, completed: 10 };
  const art = { url: 'https://is1-ssl.mzstatic.com/image/thumb/mock/{w}x{h}bb.jpg', width: 3000, height: 3000 };
  const song = (id, name, extra = {}) => ({ id: String(id), type: 'songs', attributes: { name, artistName: 'The Understudies', albumName: 'Dress Rehearsal', durationInMillis: 40672, artwork: art, playParams: { id: String(id), kind: 'song' }, ...extra } });
  const SONGS = [2001, 2002, 2003, 2004, 2005, 2006].map((id, i) => song(id, 'Stand-In Track ' + (i + 1)));
  const UNAVAILABLE = { id: '2999', type: 'songs', attributes: { name: 'Not In Your Country', artistName: 'Nobody', artwork: art } };
  const ALBUM = { id: '1001', type: 'albums', attributes: { name: 'Dress Rehearsal', artistName: 'The Understudies', artwork: art } };
  const PLAYLIST = { id: 'pl.mock1', type: 'playlists', attributes: { name: 'Understudy Essentials', curatorName: 'Apple Music Mock', artwork: art } };
  const LIB_PLAYLIST = { id: 'p.lib1', type: 'library-playlists', attributes: { name: 'My Library Mix' } };
  const LIB_SONGS = [{ id: 'i.aaa', type: 'library-songs', attributes: { name: 'Library Song A', artistName: 'Me', albumName: 'Mine', durationInMillis: 40672, playParams: { id: 'i.aaa', isLibrary: true } } }];
  window.__fakeAppleLog = { api: [], queue: [], config: null };

  class Instance {
    constructor(config) {
      this.config = config; this.listeners = {}; this.audio = new Audio(); this.isAuthorized = false;
      this.storefrontId = 'us'; this.playbackState = States.none; this.autoplayEnabled = true;
      this.audio.addEventListener('playing', () => this.setState(States.playing));
      this.audio.addEventListener('pause', () => { if (!this.audio.ended && this.playbackState !== States.stopped) this.setState(States.paused); });
      this.audio.addEventListener('durationchange', () => this.emit('playbackDurationDidChange', { duration: this.audio.duration }));
      this.audio.addEventListener('ended', () => { this.setState(States.ended); this.setState(States.completed); });
      this.api = { music: (path, params) => this.request(path, params) };
    }
    addEventListener(name, cb) { (this.listeners[name] ??= []).push(cb); }
    emit(name, payload) { for (const cb of this.listeners[name] ?? []) cb(payload); }
    setState(state) { const oldState = this.playbackState; if (state === oldState) return; this.playbackState = state; this.emit('playbackStateDidChange', { oldState, state }); }
    get currentPlaybackTime() { return this.audio.currentTime; }
    get currentPlaybackDuration() { return this.audio.duration || 0; }
    get volume() { return this.audio.volume; }
    set volume(v) { this.audio.volume = v; }
    async authorize() {
      if (window.__fakeAppleDecline) throw new Error('AUTHORIZATION_ERROR: user cancelled');
      this.isAuthorized = true; this.emit('authorizationStatusDidChange', { authorizationStatus: 3 }); return 'mock-music-user-token';
    }
    async unauthorize() { this.isAuthorized = false; this.emit('authorizationStatusDidChange', { authorizationStatus: 0 }); }
    async setQueue(options) {
      window.__fakeAppleLog.queue.push(options);
      const known = [...SONGS, ...LIB_SONGS].some((s) => s.attributes.playParams.id === options.song);
      if (!known) throw new Error('CONTENT_UNAVAILABLE');
      this.setState(States.loading);
      window.__fakeAppleBlob ??= URL.createObjectURL(await (await fetch('/.verify/audio/signal-check.mp3')).blob());
      this.audio.src = window.__fakeAppleBlob;
      if (options.startPlaying) await this.audio.play();
    }
    async play() { await this.audio.play(); }
    async pause() { this.audio.pause(); }
    async stop() { this.setState(States.stopped); this.audio.pause(); }
    async seekToTime(seconds) { this.audio.currentTime = seconds; }
    async request(path, params) {
      window.__fakeAppleLog.api.push(path + (params ? ' ' + JSON.stringify(params) : ''));
      if (!this.isAuthorized && path.includes('/me/')) throw new Error('403 Forbidden');
      const ok = (body) => ({ data: body });
      const url = new URL(path, 'https://api.music.apple.com');
      const p = url.pathname;
      if (p === '/v1/catalog/us/search') return ok({ results: { songs: { data: [...SONGS.slice(0, 4), UNAVAILABLE] }, albums: { data: [ALBUM] }, playlists: { data: [PLAYLIST] } } });
      // Two pages, to exercise the "next" link.
      if (p === '/v1/catalog/us/albums/1001/tracks') return url.searchParams.get('offset') ? ok({ data: SONGS.slice(2, 4) }) : ok({ data: SONGS.slice(0, 2), next: '/v1/catalog/us/albums/1001/tracks?offset=2' });
      if (p === '/v1/catalog/us/playlists/pl.mock1/tracks') return ok({ data: [SONGS[4], UNAVAILABLE, SONGS[5]] });
      if (p === '/v1/me/library/playlists') return ok({ data: [LIB_PLAYLIST] });
      if (p === '/v1/me/library/playlists/p.lib1/tracks') return ok({ data: LIB_SONGS });
      if (p === '/v1/catalog/gb/songs/2003') return ok({ data: [SONGS[2]] });
      if (p === '/v1/catalog/us/songs/2005') return ok({ data: [SONGS[4]] });
      if (p === '/v1/catalog/us/albums/1001') return ok({ data: [ALBUM] });
      if (p === '/v1/catalog/us/playlists/pl.mock1') return ok({ data: [PLAYLIST] });
      throw new Error('404 Not Found: ' + p);
    }
  }

  let instance = null;
  window.MusicKit = {
    PlaybackStates: States,
    async configure(config) {
      window.__fakeAppleLog.config = config;
      // Apple rejects tokens it cannot verify; the mock only knows one good signature.
      if (!config.developerToken.endsWith('.mock-signature')) throw new Error('INVALID_TOKEN');
      instance = new Instance(config);
      window.__fakeApple = instance;
      return instance;
    },
    getInstance() { return instance; },
  };
  document.dispatchEvent(new Event('musickitloaded'));
})();`;

/** A token shaped like a real developer token. `expired` and `signed` control how the mock treats it. */
function mockDeveloperToken({ expired = false, signed = true } = {}) {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const payload = { iss: 'MOCKTEAM01', iat: now - 100, exp: expired ? now - 10 : now + 86400 };
  return `${b64({ alg: 'ES256', kid: 'MOCKKEY001' })}.${b64(payload)}.${signed ? 'mock-signature' : 'wrong-signature'}`;
}

async function installAppleMock(context) {
  await context.route('https://js-cdn.music.apple.com/musickit/v3/musickit.js', (route) => route.fulfill({ contentType: 'application/javascript', body: SDK_SOURCE }));
  await context.route('https://*.mzstatic.com/**', (route) =>
    route.fulfill({ path: path.resolve('.verify/audio/cover.png'), headers: { 'access-control-allow-origin': '*' } }),
  );
}

module.exports = { installAppleMock, mockDeveloperToken };
