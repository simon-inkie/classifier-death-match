// Presentation gate: no match work is released until the countdown finishes or is skipped.
// Injectable timers keep timing and cancellation testable without a browser or real delays.
export function createCountdown({ show, sound = () => {}, onStart, schedule = setTimeout, cancel = clearTimeout }) {
  const labels = ['3', '2', '1', 'FIGHT!'];
  let active = false, timer = null, generation = 0;
  function clear() { if (timer !== null) cancel(timer); timer = null; }
  function finish() {
    if (!active) return;
    active = false; generation++; clear(); show(null); onStart();
  }
  return {
    get active() { return active; },
    start() {
      this.cancel(); active = true;
      const run = generation;
      function advance(i) {
        if (!active || run !== generation) return;
        if (i === labels.length) { finish(); return; }
        show(labels[i]); sound(i === labels.length - 1);
        timer = schedule(() => advance(i + 1), i === labels.length - 1 ? 350 : 1000);
      }
      advance(0);
    },
    skip: finish,
    cancel() { active = false; generation++; clear(); show(null); },
  };
}

// Render at a small native resolution and enlarge with nearest-neighbour CSS, using the
// winner celebration's bold monospace headline and offset black shadow.
export function drawCountdownHeadline(ctx, label) {
  const { width, height } = ctx.canvas;
  ctx.clearRect(0, 0, width, height);
  if (label === null) return;
  ctx.save();
  ctx.imageSmoothingEnabled = false;
  ctx.font = 'bold 64px monospace';
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.lineJoin = 'miter'; ctx.lineWidth = 4;
  const x = width / 2, y = height / 2;
  ctx.strokeStyle = '#000'; ctx.strokeText(label, x, y);
  ctx.fillStyle = '#000'; ctx.fillText(label, x + 4, y + 4);
  if (label === 'FIGHT!') {
    const ink = ctx.createLinearGradient(0, y - 32, 0, y + 32);
    ink.addColorStop(0, '#ffe14d'); ink.addColorStop(1, '#ff982d');
    ctx.fillStyle = ink;
  } else ctx.fillStyle = '#ffe14d';
  ctx.fillText(label, x, y);
  ctx.restore();
}
