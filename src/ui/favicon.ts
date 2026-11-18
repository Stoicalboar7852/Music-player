// The tab's icon comes alive while music plays: the logo's four bars bounce
// with the bass, the mids and the treble, so you can tell at a glance which
// tab is playing. Otherwise it rests as the plain logo.

interface Levels {
  bass: number;
  mid: number;
  treble: number;
  presence: number;
}

export function animateFavicon(levels: () => Levels, active: () => boolean) {
  const link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
  if (!link) return;
  const resting = link.href;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 32;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const gradient = ctx.createLinearGradient(0, 32, 32, 0);
  gradient.addColorStop(0, '#ff3d81');
  gradient.addColorStop(0.5, '#7a5cff');
  gradient.addColorStop(1, '#21d4fd');
  let heights = [0.55, 0.85, 0.7, 1];
  let animating = false;

  const bar = (x: number, h: number) => {
    const height = Math.max(4, h * 22);
    ctx.beginPath();
    ctx.roundRect(x, 27 - height, 4.5, height, 2.25);
    ctx.fill();
  };

  window.setInterval(() => {
    const a = levels();
    if (!active() || a.presence < 0.2) {
      if (animating) {
        link.href = resting;
        animating = false;
      }
      return;
    }
    animating = true;
    const targets = [a.bass, (a.bass + a.mid) / 2, a.mid, a.treble].map((v) => 0.2 + 0.8 * Math.min(1, v * 1.5));
    heights = heights.map((h, i) => h + (targets[i] - h) * 0.6);
    ctx.clearRect(0, 0, 32, 32);
    ctx.fillStyle = '#0b0b12';
    ctx.beginPath();
    ctx.roundRect(0, 0, 32, 32, 7);
    ctx.fill();
    ctx.fillStyle = gradient;
    heights.forEach((h, i) => bar(5 + i * 6, h));
    link.href = canvas.toDataURL('image/png');
  }, 125);
}
