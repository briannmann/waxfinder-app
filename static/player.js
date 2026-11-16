/* One player for the whole site: a bar at the bottom that keeps playing while you move between pages.
   The shell (shell.html, served for every top-level page visit) owns the real <audio>; pages run inside its iframe.
   Pages use WaxPlayer.audio(opts): an Audio-like handle (src, play(), pause(), currentTime, duration, paused,
   on<event> / addEventListener) so their own preview code keeps working. Only the handle that started the current
   track gets its events; when anything else plays, the old handle gets 'emptied' (its row resets).
   handle.meta = {title, artist, from, wave} before play(): wave = URL of {peaks:[...]} for the bar's waveform.
   opts.next / opts.prev: page callbacks (play the neighbouring row). opts.queue(): [{src, meta}] snapshot, used for
   next/prev/auto-advance once the page that started the track has been left.
   Opened outside the shell (no iframe), the page makes its own bar with the same code. */
(function () {
  if (window.WaxPlayer) return;
  try {
    const top = window.top;
    if (top !== window && top.WaxPlayer && top.WaxPlayer.host) {
      const hostP = top.WaxPlayer;
      window.WaxPlayer = { host: false, audio: o => hostP.audio(o, window), pause: () => hostP.pause(), state: () => hostP.state(), listen: fn => hostP.listen(fn, window) };
      addEventListener('pagehide', () => hostP.release(window));
      return;
    }
  } catch (e) { /* cross-origin parent: fall through to a local player */ }

  const KEY = 'wxp:v1';
  const store = { get() { try { return JSON.parse(localStorage.getItem(KEY) || 'null') } catch (e) { return null } },
                  set(v) { try { localStorage.setItem(KEY, JSON.stringify(v)) } catch (e) { } } };
  const A = new Audio(); A.preload = 'metadata';
  /* Shuffle (Spotify style): ON = next / auto-advance picks a random track from the list you are playing through (the Library table's current
     filter). A uniform random order of everything else in that list, no weighting by BPM, key, energy or plays; the list is played through once,
     then reshuffled. Back goes to what actually played before. Needs the page to hand over a queue (the Library does). */
  let shuf = false; try { shuf = localStorage.getItem('wf.shuffle') === '1' } catch (e) { }
  let bag = [], played = [], shufStep = false, done = new Set(), qsig = '';   // done = heard this round; qsig = which list the round belongs to
  let owner = null, meta = null, queue = null, pendingSeek = null, peaks = null, waveFor = '';
  const EV = ['play', 'playing', 'pause', 'timeupdate', 'loadedmetadata', 'durationchange', 'ended', 'error', 'waiting'];

  function emit(h, type) {
    if (!h || !h.alive) return;
    const e = { type, target: h, currentTarget: h };
    try { const f = h['on' + type]; if (typeof f === 'function') f.call(h, e) } catch (x) { console.error(x) }
    (h._ls[type] || []).slice().forEach(fn => { try { fn.call(h, e) } catch (x) { console.error(x) } });
  }
  EV.forEach(t => A.addEventListener(t, () => emit(owner, t)));
  let onPlay = [];   // [{fn, win}]: told whenever the bar starts playing (the Set page pauses its decks)
  A.addEventListener('play', () => onPlay.forEach(l => { try { l.fn() } catch (e) { } }));

  function abs(src, win) { try { return new URL(src, (win || window).location.href).href } catch (e) { return src } }

  function take(h, src, m) {
    const old = owner; owner = h;
    if (A.src !== src) { A.src = src; peaks = null; waveFor = '' }
    meta = Object.assign({}, m || {});
    try { const q = h && h.opts.queue && h.opts.queue(); queue = Array.isArray(q) ? q.map(x => ({ src: abs(x.src, h.win), meta: Object.assign({}, x.meta) })) : queue && h ? null : queue }
    catch (e) { queue = null }
    /* the round belongs to the LIST: clicking a song inside the same list carries on (it counts as heard); moving to another crate / filter starts afresh */
    const sig = queue ? queue.length + ':' + hash(queue.map(x => x.src).sort().join('|')) : '';
    if (sig !== qsig) { qsig = sig; bag = []; played = []; done = new Set() }
    done.add(A.src)
    if (old && old !== h) emit(old, 'emptied');
    show(); paint(); loadWave(); save();
  }

  function makeHandle(opts, win) {
    const h = { _src: '', _ls: {}, meta: null, opts: opts || {}, win: win || window, alive: true, preload: 'none' };
    Object.defineProperties(h, {
      src: { get() { return h._src }, set(v) { h._src = v || '' } },
      currentTime: { get() { return owner === h ? A.currentTime : 0 }, set(v) { if (owner === h && isFinite(v)) A.currentTime = v } },
      duration: { get() { return owner === h ? A.duration : NaN } },
      paused: { get() { return owner === h ? A.paused : true } },
      ended: { get() { return owner === h ? A.ended : false } },
      readyState: { get() { return owner === h ? A.readyState : 0 } },
      error: { get() { return owner === h ? A.error : null } },
    });
    h.play = () => {
      if (!h._src) return Promise.reject(new Error('no source'));
      const src = abs(h._src, h.win);
      if (owner !== h || A.src !== src) take(h, src, h.meta);
      else if (h.meta) { meta = Object.assign({}, h.meta); paint() }
      return A.play();
    };
    h.pause = () => { if (owner === h) A.pause() };
    h.load = () => { };
    h.addEventListener = (t, fn) => { (h._ls[t] = h._ls[t] || []).push(fn) };
    h.removeEventListener = (t, fn) => { h._ls[t] = (h._ls[t] || []).filter(f => f !== fn) };
    handles.add(h);
    return h;
  }
  const handles = new Set();

  /* ---------- the bar ---------- */
  const css = `
.wxp{position:fixed;left:0;right:0;bottom:0;z-index:2147483000;height:var(--wxp-h);display:grid;grid-template-columns:minmax(0,3fr) minmax(0,4fr) minmax(0,3fr);
  align-items:center;gap:24px;padding:12px 24px;box-sizing:border-box;background:#100a2c;border-top:1px solid rgba(255,255,255,.1);color:#fff;
  font:500 13px/1.3 "Archivo",ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;transform:translateY(100%);transition:transform .35s cubic-bezier(.2,.8,.2,1)}
.wxp *,.wxp *::before,.wxp *::after{box-sizing:border-box}   /* the shell page has no global box-sizing: padding must not add to --wxp-h */
.wxp.on{transform:none}
.wxp[hidden]{display:none}
.wxp button{font:inherit;color:inherit;background:none;border:0;padding:0;cursor:pointer;display:grid;place-items:center;border-radius:999px}
.wxp button:disabled{opacity:.3;cursor:default}
.wxp :focus-visible{outline:2px solid #c6ff3d;outline-offset:2px}
.wxp svg{width:18px;height:18px;display:block}
.wxp-l{display:flex;align-items:center;gap:12px;min-width:0}
.wxp-disc{flex:none;width:52px;height:52px;border-radius:50%;background:radial-gradient(circle,hsl(var(--h,270) 90% 62%) 0 17%,#0b0716 18% 21%,#1b1430 22% 31%,#0d0a1c 32% 41%,#1b1430 42% 52%,#0d0a1c 53% 63%,#1b1430 64% 100%);
  box-shadow:0 0 0 1px rgba(255,255,255,.12);animation:wxpspin 2.4s linear infinite;animation-play-state:paused}
.wxp.playing .wxp-disc{animation-play-state:running}
.wxp-disc.hasart{border-radius:10px;background-size:cover!important;background-position:center!important;animation:none!important}
@keyframes wxpspin{to{transform:rotate(360deg)}}
.wxp-t{min-width:0;display:grid;gap:2px}
.wxp-title{font-weight:800;font-size:14px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.wxp-sub{font-size:12px;opacity:.7;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.wxp-c{display:grid;gap:12px;justify-items:center;min-width:0;width:100%;max-width:720px;justify-self:center}
.wxp-btns{display:flex;align-items:center;gap:20px}
.wxp-btns button{width:32px;height:32px;opacity:.85}
.wxp-btns button:hover:not(:disabled){opacity:1}
.wxp-btns .wxp-shuf{opacity:.4}.wxp-btns .wxp-shuf.on{opacity:1;color:#c6ff3d}.wxp-btns .wxp-shuf:hover:not(:disabled){opacity:.8}.wxp-btns .wxp-shuf.on:hover:not(:disabled){opacity:1}
.wxp .wxp-pp{width:36px;height:36px;background:#c6ff3d;color:#14062e;opacity:1}
.wxp .wxp-pp:hover{transform:scale(1.06)}
.wxp-pp svg{width:16px;height:16px}
.wxp-seek{display:grid;grid-template-columns:44px minmax(0,1fr) 44px;align-items:center;gap:10px;width:100%;font-variant-numeric:tabular-nums;font-size:12px}
.wxp-seek span{opacity:.7}.wxp-seek span:first-child{text-align:right}
.wxp-bar{position:relative;height:22px;cursor:pointer;touch-action:none}
.wxp-bar canvas{position:absolute;inset:0;width:100%;height:100%;display:block}
.wxp-r{display:flex;align-items:center;justify-content:flex-end;gap:10px}
.wxp-r button{width:32px;height:32px;opacity:.8}.wxp-r button:hover{opacity:1}
.wxp-vol{width:96px;accent-color:#c6ff3d;cursor:pointer}
.wxp .spin{animation:wxpspin .9s linear infinite}
@media (max-width:760px){
  .wxp{grid-template-columns:minmax(0,1fr) auto;gap:10px;padding:0 12px}
  .wxp-disc{width:42px;height:42px}
  .wxp-c{display:contents}
  .wxp-seek{position:absolute;left:0;right:0;top:-1px;display:block;width:auto}
  .wxp-seek span{display:none}
  .wxp-bar{height:4px}
  .wxp-btns{gap:6px}.wxp-btns .wxp-prev{display:none}
  .wxp-r .wxp-vol,.wxp-r .wxp-mute{display:none}
  .wxp-r{position:absolute;right:8px;top:6px}
  .wxp-r button{width:24px;height:24px}
  .wxp-btns{margin-right:28px}
}
@media (prefers-reduced-motion:reduce){.wxp{transition:none}.wxp-disc,.wxp .spin{animation:none}}`;
  const I = {
    play: '<svg viewBox="0 0 16 16"><path d="M4.5 2.8v10.4L13 8z" fill="currentColor"/></svg>',
    pause: '<svg viewBox="0 0 16 16"><rect x="3.5" y="3" width="3" height="10" rx="1" fill="currentColor"/><rect x="9.5" y="3" width="3" height="10" rx="1" fill="currentColor"/></svg>',
    load: '<svg viewBox="0 0 16 16" class="spin"><circle cx="8" cy="8" r="5.3" fill="none" stroke="currentColor" stroke-width="2" stroke-dasharray="20 14" stroke-linecap="round"/></svg>',
    prev: '<svg viewBox="0 0 16 16"><rect x="3" y="3" width="2" height="10" rx="1" fill="currentColor"/><path d="M13 3v10L6 8z" fill="currentColor"/></svg>',
    next: '<svg viewBox="0 0 16 16"><rect x="11" y="3" width="2" height="10" rx="1" fill="currentColor"/><path d="M3 3v10l7-5z" fill="currentColor"/></svg>',
    shuf: '<svg viewBox="0 0 16 16"><path d="M2 4.5h2.2c1.6 0 2.4.7 3.4 2.2l1.2 1.9c1 1.5 1.8 2.2 3.4 2.2H14M2 11.5h2.2c1.1 0 1.8-.4 2.5-1.2M9.3 5.4c.7-.6 1.5-.9 2.5-.9H14" stroke="currentColor" stroke-width="1.5" fill="none" stroke-linecap="round"/><path d="M12.3 2.2L14.8 4.5l-2.5 2.3zM12.3 9.2l2.5 2.3-2.5 2.3z" fill="currentColor"/></svg>',
    vol: '<svg viewBox="0 0 16 16"><path d="M2 6h3l4-3v10l-4-3H2z" fill="currentColor"/><path d="M11 5.5a3.5 3.5 0 0 1 0 5" stroke="currentColor" stroke-width="1.6" fill="none" stroke-linecap="round"/></svg>',
    mute: '<svg viewBox="0 0 16 16"><path d="M2 6h3l4-3v10l-4-3H2z" fill="currentColor"/><path d="M11 6l4 4M15 6l-4 4" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>',
    x: '<svg viewBox="0 0 16 16"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>',
  };
  let bar, ui = {};
  function build() {
    if (bar) return;
    const st = document.createElement('style'); st.textContent = css; document.head.append(st);
    bar = document.createElement('div'); bar.className = 'wxp'; bar.hidden = true; bar.setAttribute('role', 'region'); bar.setAttribute('aria-label', 'Player');
    bar.innerHTML = `<div class="wxp-l"><span class="wxp-disc" aria-hidden="true"></span><div class="wxp-t"><span class="wxp-title"></span><span class="wxp-sub"></span></div></div>
<div class="wxp-c"><div class="wxp-btns"><button type="button" class="wxp-shuf" aria-label="Shuffle" aria-pressed="false">${I.shuf}</button><button type="button" class="wxp-prev" aria-label="Previous">${I.prev}</button><button type="button" class="wxp-pp" aria-label="Play">${I.play}</button><button type="button" class="wxp-next" aria-label="Next">${I.next}</button></div>
<div class="wxp-seek"><span class="wxp-cur">0:00</span><div class="wxp-bar" role="slider" tabindex="0" aria-label="Seek" aria-valuemin="0"><canvas></canvas></div><span class="wxp-dur"></span></div></div>
<div class="wxp-r"><button type="button" class="wxp-mute" aria-label="Mute">${I.vol}</button><input class="wxp-vol" type="range" min="0" max="1" step="0.01" aria-label="Volume"><button type="button" class="wxp-x" aria-label="Close player">${I.x}</button></div>`;
    document.body.append(bar);
    const q = s => bar.querySelector(s);
    ui = { disc: q('.wxp-disc'), title: q('.wxp-title'), sub: q('.wxp-sub'), pp: q('.wxp-pp'), prev: q('.wxp-prev'), next: q('.wxp-next'), shuf: q('.wxp-shuf'),
           cur: q('.wxp-cur'), dur: q('.wxp-dur'), seek: q('.wxp-bar'), cv: q('canvas'), vol: q('.wxp-vol'), mute: q('.wxp-mute'), x: q('.wxp-x') };
    ui.pp.onclick = toggle;
    ui.next.onclick = () => step(1); ui.prev.onclick = () => step(-1);
    ui.shuf.onclick = () => { shuf = !shuf; bag = []; played = []; done = new Set(A.src ? [A.src] : []); try { localStorage.setItem('wf.shuffle', shuf ? '1' : '0') } catch (e) { } paintShuf(); paint() };
    paintShuf();
    ui.x.onclick = close;
    ui.vol.value = A.volume; ui.vol.oninput = () => { A.volume = +ui.vol.value; A.muted = false; save() };
    ui.mute.onclick = () => { A.muted = !A.muted };
    A.addEventListener('volumechange', () => { ui.mute.innerHTML = A.muted || !A.volume ? I.mute : I.vol; ui.vol.value = A.muted ? 0 : A.volume });
    let drag = false;
    const seekAt = e => { const r = ui.seek.getBoundingClientRect(); seekFrac(Math.min(1, Math.max(0, (e.clientX - r.left) / r.width))) };
    ui.seek.onpointerdown = e => { drag = true; ui.seek.setPointerCapture(e.pointerId); seekAt(e) };
    ui.seek.onpointermove = e => { if (drag) seekAt(e) };
    ui.seek.onpointerup = ui.seek.onpointercancel = () => { drag = false };
    ui.seek.onkeydown = e => { const d = e.key === 'ArrowRight' ? 5 : e.key === 'ArrowLeft' ? -5 : 0; if (!d || !isFinite(A.duration)) return; e.preventDefault(); A.currentTime = Math.max(0, Math.min(A.duration, A.currentTime + d)) };
    new ResizeObserver(draw).observe(ui.seek);
  }
  function seekFrac(f) { if (isFinite(A.duration) && A.duration) A.currentTime = f * A.duration; else pendingSeek = f; draw() }
  function toggle() { if (!A.src) return; if (A.paused) A.play().catch(() => { }); else A.pause() }
  function close() { A.pause(); const o = owner; owner = null; if (o) emit(o, 'emptied'); A.removeAttribute('src'); A.load(); meta = null; queue = null; store.set(null); hide() }
  function show() {
    build(); if (!bar.hidden && bar.classList.contains('on')) return;
    bar.hidden = false; requestAnimationFrame(() => { bar.classList.add('on'); layout() });
  }
  function hide() { if (!bar) return; bar.classList.remove('on'); document.documentElement.style.setProperty('--wxp-h', '0px'); setTimeout(() => { if (!bar.classList.contains('on')) bar.hidden = true }, 400) }
  function layout() { document.documentElement.style.setProperty('--wxp-h', bar && bar.classList.contains('on') ? (matchMedia('(max-width:760px)').matches ? '64px' : '96px') : '0px') }
  addEventListener('resize', layout);
  document.documentElement.style.setProperty('--wxp-h', '0px');

  const mmss = s => { s = Math.max(0, Math.floor(s || 0)); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0') };
  function hue(s) { let h = 0; for (const c of s || '?') h = (h * 31 + c.charCodeAt(0)) % 360; return h }
  function paint() {
    if (!bar) return;
    const m = meta || {};
    ui.title.textContent = m.title || 'Unknown track';
    ui.sub.textContent = [m.artist, m.from].filter(Boolean).join(' · ');
    ui.disc.style.setProperty('--h', hue(m.title));
    ui.disc.classList.toggle('hasart', !!m.art); ui.disc.style.backgroundImage = m.art ? 'url("' + m.art + '")' : '';   // album art replaces the vinyl
    const can = n => !!((owner && owner.alive && owner.opts[n > 0 ? 'next' : 'prev']) || idx(n) != null);
    const sh = shuf && queue && queue.length > 1;
    ui.next.disabled = !can(1) && !sh; ui.prev.disabled = !can(-1) && !(A.currentTime > 3) && !(sh && played.length);
    state();
    if ('mediaSession' in navigator) {
      try { navigator.mediaSession.metadata = new MediaMetadata({ title: m.title || '', artist: m.artist || '', album: m.from || 'Waxfinder', artwork: m.art ? [{ src: new URL(m.art, location.href).href, sizes: '300x300', type: 'image/jpeg' }] : [] }) } catch (e) { }
    }
  }
  function state() {
    if (!bar) return;
    const busy = !A.paused && A.readyState < 3;
    ui.pp.innerHTML = busy ? I.load : A.paused ? I.play : I.pause;
    ui.pp.setAttribute('aria-label', A.paused ? 'Play' : 'Pause');
    bar.classList.toggle('playing', !A.paused && !busy);
    tick();
  }
  function tick() {
    if (!bar) return;
    const d = isFinite(A.duration) ? A.duration : 0;
    ui.cur.textContent = mmss(A.currentTime); ui.dur.textContent = d ? mmss(d) : (meta && meta.duration ? mmss(meta.duration) : '');
    ui.seek.setAttribute('aria-valuemax', Math.round(d)); ui.seek.setAttribute('aria-valuenow', Math.round(A.currentTime));
    draw();
  }
  function draw() {
    if (!bar || bar.hidden) return;
    const cv = ui.cv, r = ui.seek.getBoundingClientRect(), dpr = Math.min(2, devicePixelRatio || 1);
    if (!r.width) return;
    if (cv.width !== Math.round(r.width * dpr) || cv.height !== Math.round(r.height * dpr)) { cv.width = Math.round(r.width * dpr); cv.height = Math.round(r.height * dpr) }
    const g = cv.getContext('2d'), W = cv.width, H = cv.height, d = isFinite(A.duration) && A.duration ? A.duration : 0;
    const f = d ? A.currentTime / d : (pendingSeek || 0);
    g.clearRect(0, 0, W, H);
    if (peaks && peaks.length && H > 8 * dpr) {
      const n = peaks.length, bw = W / n, gap = bw > 3 * dpr ? dpr : 0;
      for (let i = 0; i < n; i++) {
        const h = Math.max(2 * dpr, peaks[i] * H), x = i * bw;
        g.fillStyle = (i + .5) / n <= f ? '#c6ff3d' : 'rgba(255,255,255,.32)';
        g.fillRect(x, (H - h) / 2, Math.max(1, bw - gap), h);
      }
    } else {
      const lh = Math.max(2, Math.min(4 * dpr, H)), y = (H - lh) / 2;
      g.fillStyle = 'rgba(255,255,255,.22)'; g.fillRect(0, y, W, lh);
      g.fillStyle = '#c6ff3d'; g.fillRect(0, y, W * f, lh);
    }
  }
  function loadWave() {
    const url = meta && meta.wave; if (!url || waveFor === url) { draw(); return }
    waveFor = url; const want = A.src;
    fetch(url).then(r => r.ok && r.status !== 202 ? r.json() : null).then(j => {
      if (A.src !== want || !j || !Array.isArray(j.peaks)) return;
      const mx = Math.max(.05, ...j.peaks); peaks = j.peaks.map(p => p / mx); draw();
    }).catch(() => { });
  }
  A.addEventListener('timeupdate', tick);
  ['play', 'playing', 'pause', 'waiting', 'canplay', 'loadedmetadata', 'durationchange'].forEach(t => A.addEventListener(t, state));
  A.addEventListener('loadedmetadata', () => { if (pendingSeek != null && isFinite(A.duration)) { A.currentTime = pendingSeek * A.duration; pendingSeek = null } });
  A.addEventListener('error', () => { if (bar && meta) ui.sub.textContent = 'Can’t play this track'; state() });
  A.addEventListener('ended', () => { state(); setTimeout(() => { if (A.ended) step(1, true) }, 0) });

  /* next / previous: the page that started the track picks its neighbour; once that page is gone, the snapshot queue */
  function idx(n) {
    if (!queue || !queue.length) return null;
    const i = queue.findIndex(x => x.src === A.src); if (i < 0) return null;
    const j = i + n; return j >= 0 && j < queue.length ? j : null;
  }
  const rnd = n => { const a = new Uint32Array(1), lim = Math.floor(4294967296 / n) * n; do crypto.getRandomValues(a); while (a[0] >= lim); return a[0] % n };   // no modulo bias
  function hash(t) { let h = 2166136261; for (let i = 0; i < t.length; i++) { h ^= t.charCodeAt(i); h = Math.imul(h, 16777619) } return (h >>> 0).toString(36) }
  function shuffled(arr) { for (let i = arr.length - 1; i > 0; i--) { const j = rnd(i + 1); [arr[i], arr[j]] = [arr[j], arr[i]] } return arr }
  function paintShuf() { if (!ui.shuf) return; ui.shuf.classList.toggle('on', shuf); ui.shuf.setAttribute('aria-pressed', String(shuf)) }
  function goTo(it) {   // play one queue item: through the page that owns the list when it can (keeps its row highlight), else straight on the bar
    if (owner && owner.alive && owner.opts.go) { shufStep = true; let ok; try { ok = owner.opts.go(it.src) } catch (e) { ok = false } finally { shufStep = false } if (ok !== false) return }
    const o = owner; owner = null; if (o) emit(o, 'emptied');
    A.src = it.src; meta = Object.assign({}, it.meta); peaks = null; waveFor = '';
    paint(); loadWave(); A.play().catch(() => { }); save();
  }
  function shuffleStep(n) {
    if (!shuf || !queue || queue.length < 2) return false;
    const have = new Set(queue.map(x => x.src));
    if (n > 0) {
      done.add(A.src);
      bag = bag.filter(s => have.has(s) && !done.has(s));
      if (!bag.length) {   // nothing queued: pick from what has NOT played this round; when everything has, start a new round (never straight back to the song that just played)
        let left = queue.map(x => x.src).filter(s => !done.has(s));
        if (!left.length) { done = new Set([A.src]); left = queue.map(x => x.src).filter(s => s !== A.src) }
        bag = shuffled(left);
      }
      const s = bag.pop(), it = queue.find(x => x.src === s); if (!it) return false;
      played.push(A.src); if (played.length > 300) played.shift(); done.add(s); goTo(it); return true;
    }
    while (played.length) { const s = played.pop(), it = queue.find(x => x.src === s); if (it) { goTo(it); return true } }
    return false;
  }
  function step(n, auto) {
    if (n < 0 && A.currentTime > 3) { A.currentTime = 0; return }
    if (shuffleStep(n)) return;
    if (owner && owner.alive && owner.opts[n > 0 ? 'next' : 'prev']) {
      try { if (owner.opts[n > 0 ? 'next' : 'prev']() !== false) return } catch (e) { console.error(e) }
    }
    const j = idx(n); if (j == null) { if (auto) state(); return }
    const it = queue[j], o = owner; owner = null; if (o) emit(o, 'emptied');
    A.src = it.src; meta = Object.assign({}, it.meta); peaks = null; waveFor = '';
    paint(); loadWave(); A.play().catch(() => { }); save();
  }

  /* survive a reload: remember the track + position (paused on return; browsers block autoplay anyway) */
  let lastSave = 0;
  function save() { if (!A.src) return; lastSave = Date.now(); store.set({ src: A.src, meta, t: A.currentTime || 0, vol: A.volume }) }
  A.addEventListener('timeupdate', () => { if (Date.now() - lastSave > 4000) save() });
  A.addEventListener('pause', save);
  addEventListener('pagehide', save);
  function restore() {
    const s = store.get(); if (!s) return;
    if (typeof s.vol === 'number') A.volume = s.vol;
    if (!s.src) return;
    A.preload = 'none'; A.src = s.src; meta = s.meta || {}; build();
    const t = +s.t || 0; if (t) A.addEventListener('loadedmetadata', function once() { A.removeEventListener('loadedmetadata', once); if (A.currentTime < 1) A.currentTime = Math.min(t, A.duration || t) });
    show(); paint(); loadWave(); A.preload = 'metadata';
  }

  if ('mediaSession' in navigator) {
    const ms = navigator.mediaSession;
    try {
      ms.setActionHandler('play', () => A.play().catch(() => { })); ms.setActionHandler('pause', () => A.pause());
      ms.setActionHandler('nexttrack', () => step(1)); ms.setActionHandler('previoustrack', () => step(-1));
    } catch (e) { }
  }

  window.WaxPlayer = {
    host: true,
    audio: (opts, win) => makeHandle(opts, win),
    pause: () => A.pause(),
    state: () => ({ src: A.src, paused: A.paused, meta }),
    listen: (fn, win) => { onPlay.push({ fn, win: win || window }) },
    release(win) {   // a page in the shell's iframe is going away: drop its handles, keep the music
      handles.forEach(h => { if (h.win === win) { h.alive = false; h._ls = {}; handles.delete(h); if (owner === h) owner = null } });
      onPlay = onPlay.filter(l => l.win !== win);
      paint();
    },
  };
  const boot = () => { build(); restore() };
  if (document.body) boot(); else addEventListener('DOMContentLoaded', boot);
})();
