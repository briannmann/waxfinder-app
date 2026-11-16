/* Hover a headline and it becomes a track waveform under a magnifier: the words split into thin vertical bars, and the bars
   under the pointer grow and spread like icons in the macOS Dock. The pointer is the playhead: everything left of it fades to
   lime (played, like the player bar). Leave and the bars ease back into the plain words.
   Elements: [data-wave]. Lines = its block children (e.g. the hero's two spans), or the element itself.
   Light: a canvas over the headline, drawn only while hovered or easing out (~300 drawImage calls a frame); nothing at
   rest; skipped for reduced motion and touch-only screens. */
(function () {
  if (matchMedia('(prefers-reduced-motion: reduce)').matches || !matchMedia('(hover: hover)').matches) return;
  const STEP = 6, BAR = 3.5;          // css px per bar slot, and the bar's width once fully open (the rest is gap)
  const LIME = '#c6ff3d';
  document.querySelectorAll('[data-wave]').forEach(el => {
    if (getComputedStyle(el).position === 'static') el.style.position = 'relative';
    for (const n of [...el.childNodes]) if (n.nodeType === 3 && n.textContent.trim()) { const s = document.createElement('span'); s.className = 'wv-t'; n.replaceWith(s); s.append(n) }
    let cv = null, ctx = null, offW = null, offL = null, lines = [], pad = 0, padX = 0, W = 0, H = 0, dpr = 1;
    let k = 0, target = 0, px = -1e4, raf = 0, t0 = 0, built = false;
    const ink = getComputedStyle(el).color;   // read before the words are hidden (a rebuild mid-hover would see transparent)
    const played = el.getAttribute('data-wave') || LIME;   // the "played" colour: data-wave="#hex" (Crates page: pink), else lime
    function paintText(color) {   // the words, drawn the same way the page draws them, at each line's place
      const c = document.createElement('canvas'); c.width = Math.ceil(W * dpr); c.height = Math.ceil(H * dpr);
      const g = c.getContext('2d'); g.scale(dpr, dpr); g.fillStyle = color;
      for (const L of lines) {   // every glyph at the exact spot the browser drew it, on the browser's own baseline
        g.font = L.font; if ('fontStretch' in g) g.fontStretch = L.stretch; if ('letterSpacing' in g) g.letterSpacing = '0px';
        g.textBaseline = 'alphabetic';
        for (const G of L.glyphs) g.fillText(G.ch, G.x, L.base + pad);
      }
      return c;
    }
    function build() {
      const r = el.getBoundingClientRect(); dpr = Math.min(2, devicePixelRatio || 1);
      padX = Math.round(parseFloat(getComputedStyle(el).fontSize) * .5);   // side room for the lens spread (set before the lines use it)
      const kids = [...el.children].filter(c => !c.matches('canvas') && getComputedStyle(c).display === 'block');
      const src = kids.length ? kids : [el];
      lines = src.map(n => {
        const cs = getComputedStyle(n), nr = n.getBoundingClientRect(), up = cs.textTransform === 'uppercase';
        // where the browser put each letter (Range rect per character) and its baseline (a zero-size inline-block probe)
        const glyphs = [], range = document.createRange(), walker = document.createTreeWalker(n, NodeFilter.SHOW_TEXT);
        for (let t; (t = walker.nextNode());) for (let i = 0; i < t.length; i++) {
          const ch = t.data[i]; if (!ch.trim()) continue;
          range.setStart(t, i); range.setEnd(t, i + 1); const cr = range.getBoundingClientRect();
          glyphs.push({ ch: up ? ch.toUpperCase() : ch, x: cr.left - r.left + padX });
        }
        const probe = document.createElement('wv-probe'); probe.style.cssText = 'display:inline-block;width:0;height:0;vertical-align:baseline;animation:none;transform:none';   /* not a span: page rules like ".hero h1 span{animation:rise}" moved it */
        (n === el ? el.querySelector('.wv-t') || el : n).append(probe); const base = probe.getBoundingClientRect().top - r.top; probe.remove();
        return { glyphs, base, top: nr.top - r.top, h: nr.height,
                 font: `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`, stretch: cs.fontStretch === '125%' ? 'expanded' : 'normal' };
      });
      // room around the words: bars grow to 1.55x and spikes add up to half a line more above and below, and the lens
      // pushes bars sideways, so the canvas must be bigger than the headline's box ("Picked for you" fills its box exactly)
      // each line's ink box (glyph tops/bottoms from the font, on the measured baseline): the bars are cut from here
      const mc = document.createElement('canvas').getContext('2d');
      for (const L of lines) {
        mc.font = L.font; if ('fontStretch' in mc) mc.fontStretch = L.stretch;
        let a = 0, d = 0; for (const G of L.glyphs) { const m = mc.measureText(G.ch); a = Math.max(a, m.actualBoundingBoxAscent); d = Math.max(d, m.actualBoundingBoxDescent) }
        L.st = L.base - a - 2; L.sh = a + d + 4;
      }
      const maxH = Math.max(...lines.map(L => Math.max(L.h, L.sh)));
      pad = Math.round(maxH * .85);
      W = Math.ceil(r.width) + padX * 2; H = Math.ceil(r.height) + pad * 2;
      if (!cv) { cv = document.createElement('canvas'); cv.setAttribute('aria-hidden', 'true'); cv.style.cssText = 'position:absolute;left:0;pointer-events:none;opacity:0'; el.append(cv) }
      cv.style.top = -pad + 'px'; cv.style.left = -padX + 'px'; cv.style.width = W + 'px'; cv.style.height = H + 'px'; cv.width = Math.ceil(W * dpr); cv.height = Math.ceil(H * dpr);
      ctx = cv.getContext('2d');
      offW = paintText(ink); offL = paintText(played);
      // where the ink starts and ends in each bar's column: the spikes sprout from there (measured once, at idle)
      const px8 = offW.getContext('2d').getImageData(0, 0, offW.width, offW.height).data, OW = offW.width;
      for (const L of lines) {
        L.t = []; L.b = []; const y0 = Math.floor((L.st + pad) * dpr), y1 = Math.ceil((L.st + pad + L.sh) * dpr);
        for (let x = 0, i = 0; x < W; x += STEP, i++) {
          const cx = Math.min(OW - 1, Math.floor((x + BAR / 2) * dpr)); let t = -1, b = -1;
          for (let y = y0; y < y1; y++) if (px8[(y * OW + cx) * 4 + 3] > 140) { if (t < 0) t = y; b = y }
          L.t[i] = t < 0 ? null : t / dpr - (L.st + pad); L.b[i] = t < 0 ? null : (b + 1) / dpr - (L.st + pad);
        }
      }
      built = true;
    }
    // A lens like the macOS Dock: bars under the pointer grow taller and spread apart, the ring just outside is squeezed
    // to make room, and beyond R nothing moves. Still bars (no bouncing); the lens glides after the pointer.
    // p walks 0 -> 1 in IN s (out: OUT s) by real elapsed time; k = smoothstep(p): eases in from rest, settles back to rest.
    const IN = .45, OUT = .7, R = 230, MAG = .55, SPREAD = .32, SPIKE = .5;   // SPIKE: tallest spike, as a share of the line height
    const hash = n => { const v = Math.sin(n * 127.1) * 43758.5453; return v - Math.floor(v) };   // stable 0..1 per bar
    // a fixed jagged level per bar (not animated): peaky like audio, a few tall, most short
    const level = i => { const v = hash(i * 1.37 + 3.1); return .12 + .88 * v * v };
    function spike(x, base, h, w, up) {   // a pointed bar growing up (or down) from base
      ctx.beginPath(); ctx.moveTo(x, base); ctx.lineTo(x + w, base); ctx.lineTo(x + w / 2, base + (up ? -h : h)); ctx.closePath(); ctx.fill();
    }
    let p = 0, last = 0, lx = null;
    function rest() {   // the words as one image, exactly as the page shows them: the frame both hand-overs happen on
      ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, cv.width, cv.height); ctx.globalAlpha = 1; ctx.drawImage(offW, 0, 0);
    }
    function draw(now) {
      raf = 0;
      const dt = Math.min(.25, (now - (last || now)) / 1000); last = now;
      p = Math.max(0, Math.min(1, p + (target ? dt / IN : -dt / OUT)));
      k = p * p * (3 - 2 * p);
      if (!target && p <= 0) { k = 0; last = 0; lx = null; rest(); cv.style.opacity = 0; el.classList.remove('wv-on'); return }   // back at rest: hand over
      if (lx == null) lx = px;
      lx += (px - lx) * Math.min(1, dt * 14);                 // the lens follows the pointer smoothly
      if (k < .004) { rest(); raf = requestAnimationFrame(draw); return }   // effectively at rest: the clean words
      ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, cv.width, cv.height); ctx.scale(dpr, dpr);
      const bw = STEP - (STEP - BAR) * k;                    // gaps open as it turns into bars
      for (const L of lines) {
        const cy = L.st + pad + L.sh / 2, sy = (L.st + pad) * dpr;
        for (let x = 0, i = 0; x < W; x += STEP, i++) {
          const d = x - lx, ad = Math.abs(d), inside = ad < R;
          const f = inside ? Math.cos(Math.PI / 2 * ad / R) ** 2 : 0;                     // 1 at the pointer, 0 at R
          const h = L.sh * (1 + k * MAG * f);
          const shift = inside ? Math.sign(d) * k * SPREAD * R / Math.PI * Math.sin(Math.PI * ad / R) : 0;   // lens: spread, then squeeze
          const w = bw * (1 + (inside ? k * SPREAD * Math.cos(Math.PI * ad / R) : 0));
          const dx = x + shift, dy = cy - h / 2;
          ctx.globalAlpha = 1;
          ctx.drawImage(offW, x * dpr, sy, STEP * dpr * (bw / STEP), L.sh * dpr, dx, dy, w, h);
          if (x < lx) { ctx.globalAlpha = k; ctx.drawImage(offL, x * dpr, sy, bw * dpr, L.sh * dpr, dx, dy, w, h) }   // played = lime, fades with the effect
          // waveform spikes sprout out of the bar's top and bottom inside the lens (between letters: a small bar on the midline)
          const sp = k * f * f * L.sh * SPIKE * level(i + L.st);
          if (sp > .6) {
            const sc = h / L.sh, sw = Math.max(1.5, w * .8), sx = dx + (w - sw) / 2;
            ctx.globalAlpha = 1; ctx.fillStyle = ink;
            const draw2 = () => {
              if (L.t[i] != null) { spike(sx, dy + L.t[i] * sc + .5, sp, sw, true); spike(sx, dy + L.b[i] * sc - .5, sp, sw, false) }
              else { spike(sx, cy, sp * .55, sw, true); spike(sx, cy, sp * .55, sw, false) }
            };
            draw2();
            if (x < lx) { ctx.globalAlpha = k; ctx.fillStyle = played; draw2() }
          }
        }
      }
      ctx.globalAlpha = 1;
      raf = requestAnimationFrame(draw);
    }
    let ready = false;   // the heading has finished any entrance animation (letters are where they'll stay)
    function start() {
      if (!built || Math.abs(el.getBoundingClientRect().width + padX * 2 - W) > 2) build();
      if (!raf) { t0 = t0 || performance.now(); rest(); cv.style.opacity = 1; el.classList.add('wv-on'); raf = requestAnimationFrame(draw) }   // swap at rest: nothing moves
    }
    el.addEventListener('pointerenter', e => {
      px = e.clientX - el.getBoundingClientRect().left + (padX || 0); target = 1;
      if (ready) start(); else settled().then(() => { ready = true; built = false; if (target) start() });   // hovered during the entrance: wait for it
    });
    el.addEventListener('pointermove', e => { px = e.clientX - el.getBoundingClientRect().left + padX });
    // test hook: pin the canvas on its resting frame (to compare it with the page's own text), and release it
    el.__wv = { pin() { if (!built) build(); rest(); cv.style.opacity = 1; el.classList.add('wv-on') }, unpin() { cv.style.opacity = 0; el.classList.remove('wv-on') } };
    el.addEventListener('pointerleave', () => { target = 0; if (!raf && el.classList.contains('wv-on')) raf = requestAnimationFrame(draw) });
    addEventListener('resize', () => { built = false }, { passive: true });
    // the words changed (e.g. the Set page's set name): measure again on the next hover. Our own probe/canvas don't count.
    new MutationObserver(ms => { if (ms.some(m => m.type === 'characterData' || [...m.addedNodes, ...m.removedNodes].some(n => !/^(WV-PROBE|CANVAS)$/.test(n.nodeName)))) built = false })
      .observe(el, { subtree: true, childList: true, characterData: true });
    // draw the two text copies ahead of time, when the browser is idle, so the first hover doesn't stall (~200 ms)
    // measure only once the heading is still: an entrance animation (e.g. the Set page's 'rise') moves the letters, and
    // positions taken mid-animation drew the waveform ~30px off the real words
    const settled = () => Promise.all(el.getAnimations({ subtree: true }).filter(a => a.effect && a.effect.getComputedTiming().iterations !== Infinity).map(a => a.finished.catch(() => { })));
    const prebuild = () => settled().then(() => { ready = true; (window.requestIdleCallback || (f => setTimeout(f, 1200)))(() => { if (!raf) build() }, { timeout: 4000 }) });
    if (document.fonts) document.fonts.ready.then(prebuild); else prebuild();
  });
  // while the waveform shows, the real words hide underneath (they stay in the page for screen readers + selection)
  const st = document.createElement('style');
  // while active the headline sits above neighbouring cards (their blur/animation layers were drawn over the spikes), below the nav (5)
  st.textContent = '[data-wave].wv-on>:not(canvas){opacity:0!important}[data-wave].wv-on{z-index:4!important}[data-wave] span.wv-t{display:inline}';   // !important: beats entrance animations
  document.head.append(st);
})();
