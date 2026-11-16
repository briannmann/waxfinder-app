/* Mini waveforms for track rows (library table + crate list). Local files only (/set/wave?mini=1).
   MiniWave.make(id, onSeek) -> <div class="wv"> with a canvas and a progress tint (<i>, scaleX like the old seek bars).
   Loads lazily when scrolled into view, 3 at a time; click or drag calls onSeek(fraction 0..1). */
(function () {
  const cache = new Map(), queue = [], live = new Set(), tries = new Map();
  let busy = 0;
  const css = `.wv{position:relative;height:30px;cursor:pointer;touch-action:none;border-radius:6px;overflow:hidden}
.wv canvas{position:absolute;inset:0;width:100%;height:100%;display:block}
.wv i{position:absolute;inset:0;background:rgba(255,46,136,.42);mix-blend-mode:screen;transform-origin:left;transform:scaleX(0);pointer-events:none}
.wv:hover canvas{filter:brightness(1.25)}
.wv.empty{cursor:default}
.wv.ph canvas{animation:wvph 1.8s ease-in-out infinite}
@keyframes wvph{50%{opacity:.55}}
@media (prefers-reduced-motion:reduce){.wv.ph canvas{animation:none}}`;
  // Placeholder while a waveform loads or when none exists: a flat, neutral line. It never invents musical structure (no fake breaks or drops).
  const TEMPLATE = { peaks: new Array(200).fill(.1), bass: new Array(200).fill(0), template: true };
  const st = document.createElement('style'); st.textContent = css; document.head.append(st);

  function pump() {
    while (busy < 3 && queue.length) {
      const { id, url, done } = queue.shift(); busy++;
      fetch(url || '/set/wave?mini=1&id=' + encodeURIComponent(id)).then(r => r.status === 202 ? 'wait' : r.ok ? r.json() : null).catch(() => null)
        .then(d => { busy--;
          if (d === 'wait') { const t = (tries.get(id) || 0) + 1; tries.set(id, t);   // still being made on the server: ask again shortly
            if (t < 40) setTimeout(() => { queue.push({ id, url, done }); pump(); }, 6000); else { cache.set(id, null); done(null); } }
          else { cache.set(id, d); done(d); }
          pump(); });
    }
  }
  function load(id, url) {
    return new Promise(res => {
      if (cache.has(id)) return res(cache.get(id));
      queue.push({ id, url, done: res }); pump();
    });
  }
  function draw(cv, d, col) {
    const w = cv.clientWidth, h = cv.clientHeight, dpr = devicePixelRatio || 1;
    if (!w || !h) return;
    cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr);
    const g = cv.getContext('2d'); g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, w, h);
    const ph = !d; if (ph) d = TEMPLATE; g.globalAlpha = ph ? .32 : 1;
    const P = d.peaks, B = d.bass, n = P.length;
    // loud masters sit near the top all the way through: stretch this track's own quiet..loud range so breaks and drops read
    const srt = [...P].sort((a, b) => a - b), lo = srt[Math.floor(n * .03)] || 0, hi = srt[n - 1] || 1;
    const shape = v => Math.pow(Math.max(0, (v - lo) / ((hi - lo) || 1)), 1.6);
    for (let x = 0; x < w; x += 2) {
      const a = Math.floor(x / w * n), b = Math.max(a + 1, Math.floor((x + 2) / w * n));
      let p = 0, q = 0; for (let i = a; i < b && i < n; i++) { if (P[i] > p) p = P[i]; if (B[i] > q) q = B[i]; }
      const ph = Math.max(1.5, shape(p) * h * .95), bh = Math.min(ph, shape(q) * h * .95);
      g.fillStyle = col.peak; g.fillRect(x, (h - ph) / 2, 1.5, ph);
      g.fillStyle = col.bass; g.fillRect(x, (h - bh) / 2, 1.5, bh);
    }
  }
  const io = new IntersectionObserver(es => es.forEach(e => {
    if (!e.isIntersecting) return; io.unobserve(e.target);
    const el = e.target, cv = el.firstChild;
    el.classList.add('ph'); draw(cv, null, el._col);   // template right away; the real one replaces it when it arrives
    load(el.dataset.id, el._url).then(d => { el._d = d; el.classList.remove('ph'); draw(cv, d, el._col); if (!d) { el.classList.add('empty'); el.title = 'Waveform not available'; } });
  }), { rootMargin: '200px' });
  addEventListener('resize', () => live.forEach(el => { if (!el.isConnected) { live.delete(el); return; } draw(el.firstChild, el._d, el._col); }));

  window.MiniWave = {
    // colours: {peak, bass}; default suits dark panels (library table)
    // url: where to fetch the waveform JSON (default: a library track's /set/wave)
    make(id, onSeek, col, url, opts) {
      const el = document.createElement('div'); el.className = 'wv'; el.dataset.id = id; el._url = url;
      el._col = col || { peak: 'rgba(255,255,255,.6)', bass: 'rgba(140,180,255,.95)' };
      el.setAttribute('role', 'slider'); el.setAttribute('aria-label', 'Seek within the track'); el.tabIndex = -1;
      el.append(document.createElement('canvas'), document.createElement('i'));
      // keyboard seek (opt-in with {key:true} so a long table does not get a tab stop per row): arrows ±5%, Home/End
      const frac = () => { const m = /scaleX\(([\d.e-]+)\)/.exec(el.lastChild.style.transform || ''); return m ? Math.min(1, +m[1]) : 0; };
      const aria = () => { const p = Math.round(frac() * 100); el.setAttribute('aria-valuemin', '0'); el.setAttribute('aria-valuemax', '100'); el.setAttribute('aria-valuenow', String(p)); el.setAttribute('aria-valuetext', p + '% through the track'); };
      aria();
      if (opts && opts.key) {
        el.tabIndex = 0;
        el.addEventListener('focus', aria);
        el.addEventListener('keydown', e => {
          const k = e.key, f = frac();
          const to = k === 'ArrowRight' || k === 'ArrowUp' ? f + .05 : k === 'ArrowLeft' || k === 'ArrowDown' ? f - .05 : k === 'Home' ? 0 : k === 'End' ? .999 : null;
          if (to === null) return;
          e.preventDefault(); e.stopPropagation(); onSeek(Math.min(.999, Math.max(0, to)), false); setTimeout(aria, 60);
        });
      }
      let drag = false;
      const at = e => { const r = el.getBoundingClientRect(); return Math.min(.999, Math.max(0, (e.clientX - r.left) / r.width)); };
      el.addEventListener('pointerdown', e => { if (e.button) return; e.preventDefault(); e.stopPropagation(); drag = true;
        try { el.setPointerCapture(e.pointerId); } catch (_) {} onSeek(at(e), false); });
      el.addEventListener('pointermove', e => { if (drag) onSeek(at(e), true); });
      el.addEventListener('pointerup', () => { drag = false; }); el.addEventListener('pointercancel', () => { drag = false; });
      el.addEventListener('click', e => e.stopPropagation()); el.addEventListener('dblclick', e => e.stopPropagation());
      io.observe(el); live.add(el);
      return el;
    },
    bar(el) { return el.lastChild; },   // the progress tint, used like a seek bar's <i>
    template: TEMPLATE                  // placeholder shape for other waveform drawers (Set page scrub)
  };
})();
