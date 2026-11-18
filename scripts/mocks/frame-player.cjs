// A media player that runs in a cross-origin iframe, the way Spotify's Web
// Playback SDK and the YouTube IFrame player really do. Used by the Spotify
// and YouTube simulations. Two things only show up with this arrangement:
//  - the page cannot read the iframe's audio (only tab capture can), and
//  - Chrome's media session (Now Playing, media keys) can pick the iframe's
//    session instead of the page's, because the iframe registers media-key
//    handlers of its own, as the real players do.

const path = require('node:path');

/** HTML served as the player iframe. It plays audio and answers postMessage commands. */
const FRAME_HTML = `<!doctype html><html><body style="margin:0;background:#1a0606;color:#a55;font:12px system-ui;display:grid;place-items:center;height:100vh">
<audio id="a" preload="auto"></audio><span>simulated player</span>
<script>
const a = document.getElementById('a');
const blobs = {};
const snap = (type, extra) => ({ __mockFrame: true, type, t: a.currentTime, d: a.duration || 0, paused: a.paused, ended: a.ended, volume: a.volume, ...extra });
const post = (type, extra) => parent.postMessage(snap(type, extra), '*');
for (const e of ['playing', 'pause', 'seeked', 'ended', 'durationchange', 'timeupdate', 'waiting']) a.addEventListener(e, () => post(e));
// Like the real embedded players: media keys handled here, but no track info.
for (const k of ['play', 'pause', 'nexttrack', 'previoustrack']) {
  try { navigator.mediaSession.setActionHandler(k, () => post('mediakey', { key: k })); } catch {}
}
addEventListener('message', async (event) => {
  const m = event.data;
  if (!m || !m.__mockCmd) return;
  let error = null;
  try {
    if (m.cmd === 'load') {
      // A blob URL is fully seekable, like the real players' streams.
      blobs[m.src] ??= URL.createObjectURL(await (await fetch(m.src)).blob());
      a.src = blobs[m.src];
      await new Promise((resolve, reject) => { a.onloadedmetadata = resolve; a.onerror = () => reject(new Error('could not load ' + m.src)); });
      if (m.play) await a.play();
    } else if (m.cmd === 'play') await a.play();
    else if (m.cmd === 'pause') a.pause();
    else if (m.cmd === 'seek') a.currentTime = m.t;
    else if (m.cmd === 'volume') a.volume = m.v;
  } catch (e) { error = String((e && e.message) || e); }
  post('reply', { id: m.id, error });
});
post('ready');
</script></body></html>`;

/** Page-side controller for a FRAME_HTML iframe (injected into the page as source text). */
const FRAME_PLAYER_SOURCE = `
class FramePlayer {
  constructor(src, { replace, style } = {}) {
    const frame = document.createElement('iframe');
    frame.src = src;
    frame.allow = 'autoplay; encrypted-media';
    frame.style.cssText = style ?? 'position:fixed;left:-20px;top:-20px;width:10px;height:10px;border:0;opacity:0';
    if (replace) { frame.id = replace.id; replace.replaceWith(frame); } else document.body.append(frame);
    this.frame = frame;
    this.cached = { t: 0, d: 0, paused: true, ended: false, volume: 1 };
    this.handlers = {};
    this.seq = 0;
    this.waiting = new Map();
    this.ready = new Promise((resolve) => (this.markReady = resolve));
    window.addEventListener('message', (event) => {
      const m = event.data;
      if (event.source !== frame.contentWindow || !m || !m.__mockFrame) return;
      Object.assign(this.cached, { t: m.t, d: m.d, paused: m.paused, ended: m.ended, volume: m.volume });
      if (m.type === 'ready') this.markReady();
      if (m.type === 'reply') { this.waiting.get(m.id)?.(m); this.waiting.delete(m.id); }
      for (const cb of this.handlers[m.type] ?? []) cb(m);
    });
  }
  on(type, cb) { (this.handlers[type] ??= []).push(cb); }
  async send(cmd, args = {}) {
    await this.ready;
    if (!this.frame.contentWindow) return null; // destroyed
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.waiting.set(id, (m) => (m.error ? reject(new Error(m.error)) : resolve(m)));
      this.frame.contentWindow.postMessage({ __mockCmd: true, id, cmd, ...args }, '*');
    });
  }
  /** Shaped like an <audio> element, so tests can see what the player is doing. */
  get audio() { const c = this.cached; return { paused: c.paused, currentTime: c.t, duration: c.d, volume: c.volume, ended: c.ended }; }
}
`;

/** Serves the player iframe and its audio files from an origin. */
async function routeFramePlayer(context, origin, framePath) {
  await context.route(`${origin}${framePath}*`, (route) => route.fulfill({ contentType: 'text/html', body: FRAME_HTML }));
  await context.route(`${origin}/mock-audio/**`, (route) =>
    route.fulfill({ path: path.resolve('.verify/audio', path.basename(new URL(route.request().url()).pathname)) }),
  );
}

module.exports = { FRAME_HTML, FRAME_PLAYER_SOURCE, routeFramePlayer };
