// The mini player under the menu bar (macOS) or tray (Windows) icon: what is
// playing, a live visualizer, and the transport buttons.

const bridge = window.phosphorMini;
const $ = (id) => document.getElementById(id);
const BANDS = 24;
const PLAY = 'M5 3l8 5-8 5z';
const PAUSE = 'M4 3h3v10H4zM9 3h3v10H9z';
const SOURCES = { local: 'Local file', spotify: 'Spotify', apple: 'Apple Music', youtube: 'YouTube', capture: 'Listening' };

if (bridge?.platform !== 'darwin') document.body.classList.add('solid');

let playing = false;
const heights = new Float32Array(BANDS);
let targets = new Float32Array(BANDS);
let levelsAt = 0;

function render(state) {
  playing = Boolean(state.playing);
  $('title').textContent = state.title || (state.listening ? 'Listening' : 'Nothing playing');
  $('artist').textContent = state.title ? state.artist || '' : state.listening ? 'to what this computer plays' : 'Open Phosphor to put some music on';
  $('source').textContent = SOURCES[state.source] ?? '';
  $('art').style.backgroundImage = state.artwork ? `url("${state.artwork.replace(/"/g, '%22')}")` : '';
  $('toggle-icon').firstElementChild.setAttribute('d', playing ? PAUSE : PLAY);
  $('toggle').title = $('toggle').ariaLabel = playing ? 'Pause' : 'Play';
}

bridge?.onState(render);
bridge?.onLevels((levels) => {
  if (Array.isArray(levels?.bands)) targets = Float32Array.from(levels.bands.slice(0, BANDS), (v) => Math.max(0, Math.min(1, Number(v) || 0)));
  levelsAt = performance.now();
});

for (const name of ['previous', 'toggle', 'next']) $(name).addEventListener('click', () => bridge?.command(name));
$('open').addEventListener('click', () => bridge?.command('show'));
document.addEventListener('keydown', (event) => {
  if (event.key === ' ') bridge?.command('toggle');
  else if (event.key === 'ArrowRight') bridge?.command('next');
  else if (event.key === 'ArrowLeft') bridge?.command('previous');
  else if (event.key === 'Escape') bridge?.command('hide');
  else return;
  event.preventDefault();
});

// The visualizer: mirrored bars that rise fast and fall slowly.
const canvas = $('bars');
const ctx = canvas.getContext('2d');
let last = performance.now();
function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  const fresh = now - levelsAt < 500;
  const { width, height } = canvas;
  ctx.clearRect(0, 0, width, height);
  const gap = 6;
  const bar = (width - gap * (BANDS + 1)) / BANDS;
  const gradient = ctx.createLinearGradient(0, height, width, 0);
  gradient.addColorStop(0, '#ff3d81');
  gradient.addColorStop(0.5, '#7a5cff');
  gradient.addColorStop(1, '#21d4fd');
  ctx.fillStyle = gradient;
  for (let i = 0; i < BANDS; i++) {
    const target = fresh ? targets[i] : 0;
    const rate = target > heights[i] ? 22 : 5;
    heights[i] += (target - heights[i]) * Math.min(1, rate * dt);
    const h = Math.max(6, heights[i] * (height - 24));
    const x = gap + i * (bar + gap);
    ctx.beginPath();
    ctx.roundRect(x, (height - h) / 2, bar, h, bar / 2);
    ctx.fill();
  }
}
requestAnimationFrame(frame);
