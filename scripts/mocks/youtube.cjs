// A local stand-in for the YouTube IFrame Player API and Data API v3, used
// only by scripts/verify.cjs. It simulates the documented player surface
// (states, errors, playlists) and the Data API responses the app reads, so
// the tests check the app's logic. It cannot vouch for YouTube itself.

const path = require('node:path');

const { FRAME_PLAYER_SOURCE, routeFramePlayer } = require('./frame-player.cjs');

const VIDEOS = {
  aaaaaaaaaaa: { title: 'Mock Clip A', author: 'Clip Makers - Topic' },
  bbbbbbbbbbb: { title: 'Mock Clip B', author: 'Clip Makers - Topic' },
  ccccccccccc: { title: 'Mock Clip C', author: 'Another Channel' },
  ddddddddddd: { title: 'Label Video (embedding off)', author: 'Big Label VEVO', blocked: true },
  // 8-second videos for tests that play to the end.
  shortclip01: { title: 'Short Clip 1', author: 'Clip Makers - Topic', short: true },
  shortclip02: { title: 'Short Clip 2', author: 'Clip Makers - Topic', short: true },
  shortclip03: { title: 'Short Clip 3', author: 'Clip Makers - Topic', short: true },
};
const PLAYLISTS = {
  OLAK5uy_mockalbum: ['aaaaaaaaaaa', 'bbbbbbbbbbb', 'ccccccccccc'],
  PLmockplaylist01: ['ccccccccccc', 'aaaaaaaaaaa'],
};

// The simulated IFrame Player API. Like the real one, each player is a
// cross-origin iframe on www.youtube.com; the page talks to it by postMessage.
// Test switch: window.__fakeYouTubeNoEnded = true makes the player never
// report the end of a video.
const API_SOURCE = `
(() => {
  ${FRAME_PLAYER_SOURCE}
  const VIDEOS = ${JSON.stringify(VIDEOS)};
  const PLAYLISTS = ${JSON.stringify(PLAYLISTS)};
  window.__fakeYouTubeLog = { players: 0, loads: [] };
  class Player {
    constructor(target, opts) {
      const el = typeof target === 'string' ? document.getElementById(target) : target;
      if (opts.playerVars?.origin !== location.origin) console.error('mock YT: origin playerVar missing');
      this.fp = new FramePlayer('https://www.youtube.com/embed/?enablejsapi=1&origin=' + encodeURIComponent(location.origin), { replace: el, style: 'width:100%;height:100%;border:0;display:block' });
      this.opts = opts; this.events = opts.events ?? {}; this.videoId = null; this.list = null; this.state = -1; this.volume = 100;
      this.fp.on('playing', () => this.setState(1));
      this.fp.on('pause', (m) => { if (!m.ended && this.state !== 0 && this.state !== 5) this.setState(2); });
      this.fp.on('ended', () => { if (!window.__fakeYouTubeNoEnded) this.setState(0); });
      window.__fakeYouTubeLog.players++;
      this.fp.ready.then(() => setTimeout(() => this.events.onReady?.({ target: this, data: null }), 10));
      window.__fakeYouTube ??= this;
    }
    get audio() { return this.fp.audio; }
    setState(s) { this.state = s; this.events.onStateChange?.({ target: this, data: s }); }
    async loadVideoById(id) {
      window.__fakeYouTubeLog.loads.push(id);
      this.videoId = id; this.setState(-1); this.setState(3);
      const v = VIDEOS[id];
      if (!v) { setTimeout(() => this.events.onError?.({ target: this, data: 100 }), 30); return; }
      if (v.blocked) { setTimeout(() => this.events.onError?.({ target: this, data: 150 }), 30); return; }
      await this.fp.send('load', { src: 'https://www.youtube.com/mock-audio/' + (v.short ? 'signal-check-short.mp3' : 'signal-check.mp3'), play: true });
    }
    cuePlaylist({ list }) { this.list = list; setTimeout(() => { if (PLAYLISTS[list]) this.setState(5); else this.events.onError?.({ target: this, data: 2 }); }, 30); }
    getPlaylist() { return this.list ? PLAYLISTS[this.list] ?? null : null; }
    playVideo() { void this.fp.send('play'); }
    pauseVideo() { void this.fp.send('pause'); }
    stopVideo() { this.setState(5); void this.fp.send('pause'); }
    seekTo(s) { void this.fp.send('seek', { t: s }); }
    setVolume(v) { this.volume = v; void this.fp.send('volume', { v: v / 100 }); }
    getVolume() { return this.volume; }
    unMute() {}
    getCurrentTime() { return this.fp.cached.t; }
    getDuration() { return this.fp.cached.d || 0; }
    getVideoData() { const v = VIDEOS[this.videoId] ?? {}; return { video_id: this.videoId, title: v.title, author: v.author }; }
    destroy() { this.fp.frame.remove(); }
  }
  window.YT = { Player, loaded: 1 };
  window.onYouTubeIframeAPIReady?.();
})();`;

async function installYouTubeMock(context) {
  const log = { data: [] };
  const json = (route, status, body) => route.fulfill({ status, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(body) });
  await context.route('https://www.youtube.com/iframe_api', (route) => route.fulfill({ contentType: 'application/javascript', body: API_SOURCE }));
  await routeFramePlayer(context, 'https://www.youtube.com', '/embed/');
  await context.route('https://i.ytimg.com/**', (route) => route.fulfill({ path: path.resolve('.verify/audio/cover.png'), headers: { 'access-control-allow-origin': '*' } }));
  await context.route('https://www.googleapis.com/youtube/v3/**', (route) => {
    const url = new URL(route.request().url());
    const q = Object.fromEntries(url.searchParams);
    const endpoint = url.pathname.split('/').pop();
    log.data.push({ endpoint, ...q });
    if (q.key === 'exhausted-key') return json(route, 403, { error: { code: 403, message: 'quota', errors: [{ reason: 'quotaExceeded' }] } });
    if (q.key !== 'mock-api-key') return json(route, 400, { error: { code: 400, message: 'API key not valid', errors: [{ reason: 'keyInvalid' }] } });
    if (endpoint === 'search' && q.type === 'video') {
      return json(route, 200, { items: ['aaaaaaaaaaa', 'bbbbbbbbbbb', 'ccccccccccc'].map((id) => ({ id: { kind: 'youtube#video', videoId: id }, snippet: { title: VIDEOS[id].title, channelTitle: VIDEOS[id].author } })) });
    }
    if (endpoint === 'search' && q.type === 'playlist') {
      return json(route, 200, { items: [{ id: { kind: 'youtube#playlist', playlistId: 'PLmockplaylist01' }, snippet: { title: 'Rock &amp; Roll Mix', channelTitle: 'Mixer', thumbnails: { medium: { url: 'https://i.ytimg.com/vi/x/mqdefault.jpg' } } } }] });
    }
    if (endpoint === 'videos') {
      const items = q.id.split(',').filter((id) => VIDEOS[id]).map((id) => ({ id, snippet: { title: VIDEOS[id].title, channelTitle: VIDEOS[id].author }, contentDetails: { duration: 'PT40S' } }));
      return json(route, 200, { items });
    }
    if (endpoint === 'playlistItems') {
      const ids = PLAYLISTS[q.playlistId] ?? [];
      // Two pages, to exercise pageToken.
      const page = q.pageToken ? ids.slice(2) : ids.slice(0, 2);
      return json(route, 200, { items: page.map((videoId) => ({ contentDetails: { videoId } })), ...(q.pageToken || ids.length <= 2 ? {} : { nextPageToken: 'p2' }) });
    }
    if (endpoint === 'playlists') return json(route, 200, { items: [{ snippet: { title: q.id === 'OLAK5uy_mockalbum' ? 'Mock Album' : 'Mock Playlist', channelTitle: 'Clip Makers' } }] });
    return json(route, 404, { error: { code: 404, message: 'not mocked' } });
  });
  return { log };
}

module.exports = { installYouTubeMock };
