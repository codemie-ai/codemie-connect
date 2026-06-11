// Procedural animated avatar (analysis §11) rendered from the CodeMie logo SVG.
// States: idle | working | warning | success | error | victory.

const RING = {
  idle: 'rgba(139,92,246,0.55)',
  working: 'rgba(88,166,255,0.85)',
  warning: 'rgba(210,153,34,0.85)',
  success: 'rgba(63,185,80,0.85)',
  error: 'rgba(255,107,107,0.9)',
  victory: 'rgba(126,231,135,0.95)',
};
const TINT = {
  idle: 'rgba(139,92,246,0.0)',
  working: 'rgba(88,166,255,0.10)',
  warning: 'rgba(210,153,34,0.12)',
  success: 'rgba(63,185,80,0.12)',
  error: 'rgba(255,107,107,0.16)',
  victory: 'rgba(126,231,135,0.10)',
};
const SHAKE = [0, -5, 5, -3, 3, 0];

const SIZE = 168;
const BOX = 128;
const OFF = (SIZE - BOX) / 2;
const RADIUS = 30;

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

export function initSprite(canvas, logoPath) {
  const ctx = canvas.getContext('2d');
  const img = new Image();
  let imgReady = false;
  img.onload = () => {
    imgReady = true;
  };
  img.src = `file://${logoPath}`;

  let state = 'idle';
  let idx = 0;
  let confetti = [];

  function makeConfetti() {
    const colors = ['#8b5cf6', '#58a6ff', '#3fb950', '#d29922', '#a78bfa'];
    confetti = Array.from({ length: 22 }, () => ({
      x: Math.random() * SIZE,
      y: Math.random() * SIZE,
      c: colors[Math.floor(Math.random() * colors.length)],
      s: 2 + Math.random() * 3,
    }));
  }

  function frame() {
    idx += 1;
    ctx.clearRect(0, 0, SIZE, SIZE);

    const breathe = 0.5 + 0.5 * Math.sin(idx / 6);
    const shakeX = state === 'error' ? SHAKE[idx % SHAKE.length] : 0;

    // Breathing glow behind the avatar (working / victory).
    if (state === 'working' || state === 'victory') {
      const glow = ctx.createRadialGradient(SIZE / 2, SIZE / 2, 30, SIZE / 2, SIZE / 2, 95);
      glow.addColorStop(0, RING[state].replace(/[\d.]+\)$/, `${0.35 * breathe})`));
      glow.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = glow;
      ctx.fillRect(0, 0, SIZE, SIZE);
    }

    ctx.save();
    ctx.translate(shakeX, 0);

    // Masked avatar.
    ctx.save();
    roundRect(ctx, OFF, OFF, BOX, BOX, RADIUS);
    ctx.fillStyle = '#ffffff';
    ctx.fill();
    ctx.clip();
    if (imgReady) ctx.drawImage(img, OFF, OFF, BOX, BOX);
    // State tint over the avatar.
    ctx.fillStyle = TINT[state];
    ctx.fillRect(OFF, OFF, BOX, BOX);
    ctx.restore();

    // Accent ring outline.
    ctx.lineWidth = 3;
    ctx.strokeStyle = RING[state];
    roundRect(ctx, OFF, OFF, BOX, BOX, RADIUS);
    ctx.stroke();

    ctx.restore();

    // Victory confetti.
    if (state === 'victory') {
      for (const p of confetti) {
        ctx.fillStyle = p.c;
        ctx.fillRect(p.x, p.y, p.s, p.s);
      }
    }
  }

  const timer = setInterval(frame, 83); // ~12 fps

  return {
    setState(next) {
      if (next === state) return;
      state = next;
      if (next === 'victory') makeConfetti();
    },
    stop() {
      clearInterval(timer);
    },
  };
}
