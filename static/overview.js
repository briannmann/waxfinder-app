/* Overview waveform + scrubber for one deck: draws the whole track (bass in ember, sections shaded, played part lit)
   on a <canvas>, and turns an <input type=range> laid over it into a scrubber that jumps (snapped to the beat).
   Local files only (/set/wave). Usage: WaxOverview.attach(canvasEl, rangeInputEl, 'A', { onPreview(seconds) })  */
(function () {
  const WORDS = { intro: 'Intro', break: 'Break', build: 'Build', outro: 'Outro' };
  const clock = s => { s = Math.max(0, Math.floor(s || 0)); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); };
  function art(W, w, h, dpr) {
    const make = lit => {
      const c = document.createElement('canvas'); c.width = w; c.height = h; const g = c.getContext('2d'), mid = h / 2, n = W.peaks.length;
      for (const s of W.sections || []) {
        if (!WORDS[s.label]) continue;
        const x0 = s.start / W.duration * w, x1 = s.end / W.duration * w;
        g.fillStyle = s.label === 'break' || s.label === 'build' ? `rgba(198,255,61,${lit ? .16 : .09})` : `rgba(255,255,255,${lit ? .07 : .04})`;
        g.fillRect(x0, 0, x1 - x0, h);
        if (x1 - x0 > 34 * dpr) { g.fillStyle = `rgba(255,255,255,${lit ? .85 : .55})`; g.font = `700 ${9 * dpr}px Archivo, sans-serif`; g.fillText(WORDS[s.label], x0 + 4 * dpr, 11 * dpr); }
      }
      for (let x = 0; x < w; x++) {
        const i = Math.min(n - 1, Math.floor(x / w * n)), p = W.peaks[i] * (mid - 2), b = Math.min(W.peaks[i], W.bass[i] * 0.5) * (mid - 2);
        g.fillStyle = `rgba(255,255,255,${lit ? .9 : .32})`; g.fillRect(x, mid - p, 1, p * 2);
        g.fillStyle = lit ? 'rgba(255,77,46,1)' : 'rgba(255,77,46,.5)'; g.fillRect(x, mid - b, 1, b * 2);
      }
      return c;
    };
    return { w, h, dim: make(false), lit: make(true) };
  }
  function attach(cv, input, side, opts = {}) {
    const E = () => window.DeckEngine;
    let id = null, data = null, pic = null, scrubbing = false, dead = false;
    input.min = 0; input.max = 1000; input.step = 1;
    const target = () => { const st = E().state(side); return Number(input.value) / 1000 * (st.duration || 0); };
    const on = (t, f) => input.addEventListener(t, f);
    on('pointerdown', () => { scrubbing = true; });
    on('input', () => { scrubbing = true; opts.onPreview && opts.onPreview(target(), clock(target())); draw(); });
    on('change', () => { E().seek(side, target()); scrubbing = false; });
    on('pointerup', () => setTimeout(() => { scrubbing = false; }, 150));
    function draw() {
      const st = E() && E().state(side);
      const dpr = Math.min(2, window.devicePixelRatio || 1), w = Math.round(cv.clientWidth * dpr), h = Math.round(cv.clientHeight * dpr);
      if (!w || !h) return;
      if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; pic = null; }
      const g = cv.getContext('2d'); g.clearRect(0, 0, w, h);
      if (st && st.track && st.track.id !== id) {
        id = st.track.id; data = null; pic = null;
        fetch('/set/wave?id=' + encodeURIComponent(id)).then(r => r.ok ? r.json() : null).then(wv => { if (wv && id === st.track.id) { data = wv; pic = null; } }).catch(() => {});
      }
      input.disabled = !(st && st.ready);
      const frac = scrubbing ? Number(input.value) / 1000 : (st && st.duration ? st.time / st.duration : 0);
      if (!scrubbing) input.value = Math.round(frac * 1000);
      if (!data) { g.fillStyle = 'rgba(255,255,255,.12)'; g.fillRect(0, h / 2 - 1, w, 2); return; }
      if (!pic || pic.w !== w) pic = art(data, w, h, dpr);
      const px = Math.max(0, Math.min(w, frac * w));
      g.drawImage(pic.dim, 0, 0); if (px > 0) g.drawImage(pic.lit, 0, 0, px, h, 0, 0, px, h);
      if (st && st.cuePoint != null && st.duration) {
        const cueX = Math.max(0, Math.min(w - 2 * dpr, st.cuePoint / st.duration * w));
        g.fillStyle = '#ffb23d'; g.fillRect(cueX, 0, 2 * dpr, h);
        g.beginPath(); g.moveTo(cueX, 0); g.lineTo(cueX + 7 * dpr, 0); g.lineTo(cueX, 7 * dpr); g.fill();
      }
    }
    // Only redraw while the strip is on screen (it was measuring + repainting 10x/s even when scrolled away).
    let seen = true;
    if (window.IntersectionObserver) new IntersectionObserver(es => { seen = es[es.length - 1].isIntersecting; if (seen && !dead) draw(); }).observe(cv);
    const tick = () => { if (dead) return; if (!document.hidden && seen) draw(); setTimeout(tick, 100); };
    tick();
    return { destroy() { dead = true; }, isScrubbing: () => scrubbing };
  }
  window.WaxOverview = { attach, clock };
})();
