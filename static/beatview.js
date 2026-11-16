/* Scrolling beat view for the mix panel: deck A on top, deck B underneath, both moving under one fixed line,
   like the stacked waveforms on an all-in-one controller. Kicks show in ember, beats as ticks, bar downbeats bright.
   Time runs in real seconds (each deck scaled by its playback speed), so synced beats sit exactly above each other.
   Local files only (/set/wave?hi=1). */
(function () {
  const SPAN = 6;            // seconds shown across the panel (3 behind, 3 ahead)
  const cache = {};          // track id -> hi-res wave
  let cv, g, visible = true, dpr = 1, observer, cleanupInput = () => {};
  const clock = s => { s = Math.max(0, s || 0); return Math.floor(s / 60) + ':' + (s % 60).toFixed(2).padStart(5, '0'); };

  let running = false;
  /* Put the stacked waveforms into any element (it fills it). Calling again moves it to the new element. */
  function mountInto(el) {
    if (!el) return false;
    let box = el.querySelector('.wax-beatview');
    if (!box) {
      box = document.createElement('div'); box.className = 'wax-beatview';
      box.innerHTML = '<canvas aria-hidden="true"></canvas>' + ['A', 'B'].map(side =>
        `<div class="wax-wave-drag" data-waveform-side="${side}" role="slider" tabindex="-1" aria-label="Waveform position, deck ${side}" aria-orientation="horizontal" aria-valuemin="0" aria-valuemax="0" aria-valuenow="0" aria-disabled="true" title="Drag to position the track; press CUE while paused to save"></div>`).join('');
      el.append(box);
    }
    if (cv === box.querySelector('canvas')) return true;
    cleanupInput(); observer?.disconnect();
    cv = box.querySelector('canvas'); g = cv.getContext('2d');
    cleanupInput = bindScrubbing(box);
    observer = new IntersectionObserver(es => { visible = es[0].isIntersecting; }); observer.observe(cv);
    if (!running) { running = true; requestAnimationFrame(frame); }
    return true;
  }
  function mount() {                                   // old card layout: drop it into the mix panel
    const mix = document.querySelector('.wax-mix'); if (!mix) return false;
    if (mix.querySelector('.wax-beatview')) return true;
    const ok = mountInto(mix); const box = mix.querySelector('.wax-beatview'), fb = mix.querySelector('.wax-fader-block');
    if (box && fb) mix.insertBefore(box, fb); return ok;
  }
  function bindScrubbing(box) {
    const events = new AbortController(), controls = box.querySelectorAll('[data-waveform-side]');
    let drag = null;
    const E = () => window.DeckEngine;
    const sameTrack = d => E().state(d.side).ready && E()._decks[d.side].buffer === d.buffer;
    const on = (el, type, fn) => el.addEventListener(type, fn, { signal: events.signal });
    function finish(cancelled = false) {
      if (!drag) return;
      const d = drag; drag = null; d.control.classList.remove('is-dragging');
      if (sameTrack(d)) {
        if (cancelled) E().seek(d.side, d.time);
        if (d.playing) E().play(d.side);
      }
      if (d.control.hasPointerCapture(d.id)) d.control.releasePointerCapture(d.id);
    }
    function move(event) {
      if (!drag || drag.id !== event.pointerId) return;
      if (!sameTrack(drag)) { finish(); return; }
      const seconds = drag.time + (drag.x - event.clientX) / drag.width * SPAN * drag.rate;
      E().seek(drag.side, seconds);
    }
    controls.forEach(control => {
      const side = control.dataset.waveformSide;
      on(control, 'pointerdown', event => {
        if (event.button !== 0 || drag || !E()?.state(side).ready) return;
        event.preventDefault(); control.focus({ preventScroll: true });
        const playing = E().state(side).playing;
        E().pause(side);
        const state = E().state(side), width = control.getBoundingClientRect().width;
        drag = { side, control, id: event.pointerId, x: event.clientX, width: Math.max(1, width),
          time: state.time, rate: state.rate || 1, playing, buffer: E()._decks[side].buffer };
        control.setPointerCapture(event.pointerId); control.classList.add('is-dragging');
      });
      on(control, 'pointermove', move);
      on(control, 'pointerup', event => { if (drag?.id === event.pointerId) { move(event); finish(); } });
      on(control, 'pointercancel', event => { if (drag?.id === event.pointerId) finish(true); });
      on(control, 'lostpointercapture', event => { if (drag?.id === event.pointerId) finish(); });
      on(control, 'keydown', event => {
        if (drag || !E()?.state(side).ready) return;
        const state = E().state(side), step = event.shiftKey ? 1 : .01;
        const delta = { ArrowLeft: -step, ArrowRight: step, PageUp: SPAN, PageDown: -SPAN }[event.key];
        let target;
        if (delta !== undefined) target = state.time + delta;
        else if (event.key === 'Home') target = 0;
        else if (event.key === 'End') target = state.duration;
        else return;
        event.preventDefault(); E().seek(side, target);
      });
    });
    return () => { finish(true); events.abort(); };
  }
  function want(track) {
    if (!track || cache[track.id] !== undefined) return cache[track && track.id];
    cache[track.id] = null;
    fetch('/set/wave?hi=1&id=' + encodeURIComponent(track.id)).then(r => r.ok ? r.json() : null).then(w => {
      cache[track.id] = w || false;
      // The engine/library owns the grid. A late waveform fetch must not move beat 1 during a mix.
    }).catch(() => { cache[track.id] = false; });
    return null;
  }
  function lane(y0, h, side, label) {
    const E = window.DeckEngine, d = E._decks[side], t = d.track, W = cv.width;
    const control = cv.parentElement.querySelector(`[data-waveform-side="${side}"]`), state = E.state(side);
    control.setAttribute('aria-disabled', String(!state.ready)); control.tabIndex = state.ready ? 0 : -1;
    control.setAttribute('aria-valuemax', String(state.duration));
    control.setAttribute('aria-valuenow', String(Math.max(0, Math.min(state.duration, state.time))));
    control.setAttribute('aria-valuetext', clock(state.time) + ' of ' + clock(state.duration));
    g.fillStyle = 'rgba(0,0,0,.28)'; g.fillRect(0, y0, W, h);
    g.fillStyle = 'rgba(255,255,255,.55)'; g.font = `800 ${10 * dpr}px Archivo, sans-serif`; g.fillText(label, 6 * dpr, y0 + 13 * dpr);
    if (!t) return;
    const w = want(t), now = d.a.currentTime, rate = state.rate || 1;
    const pps = W / SPAN, cx = W / 2, mid = y0 + h / 2;
    if (w) {
      const P = w.peaks, B = w.bass, R = w.rate;
      for (let x = 0; x < W; x++) {
        const tt = now + ((x - cx) / pps) * rate, i = Math.floor(tt * R);
        if (i < 0 || i >= P.length) continue;
        const p = P[i] / 99 * (h / 2 - 3), b = B[i] / 99 * (h / 2 - 3);
        g.fillStyle = x < cx ? 'rgba(255,255,255,.28)' : 'rgba(255,255,255,.55)'; g.fillRect(x, mid - p, 1, p * 2);
        g.fillStyle = x < cx ? 'rgba(255,77,46,.55)' : 'rgba(255,77,46,.95)'; g.fillRect(x, mid - b, 1, b * 2);
      }
    }
    // beat grid
    const bl = t.beat_len || 60 / t.bpm, fb = state.firstBeat ?? t.first_beat ?? 0;
    const k0 = Math.ceil((now - SPAN / 2 * rate - fb) / bl), k1 = Math.floor((now + SPAN / 2 * rate - fb) / bl);
    for (let k = k0; k <= k1; k++) {
      const x = cx + ((fb + k * bl - now) / rate) * pps, down = ((k % 4) + 4) % 4 === 0;
      g.fillStyle = down ? 'rgba(198,255,61,.95)' : 'rgba(255,255,255,.35)';
      g.fillRect(Math.round(x), down ? y0 : y0 + h * .72, down ? 2 * dpr : 1 * dpr, down ? h : h * .28);
      if (down && k >= 0) { g.fillStyle = 'rgba(198,255,61,.9)'; g.font = `700 ${9 * dpr}px Archivo, sans-serif`; g.fillText(String(Math.floor(k / 4) + 1), x + 3 * dpr, y0 + h - 4 * dpr); }
    }
    if (state.cuePoint !== null && state.cuePoint !== undefined) {
      const x = cx + (state.cuePoint - now) / rate * pps;
      if (x >= 0 && x <= W) {
        g.fillStyle = '#ffb23d'; g.fillRect(Math.round(x), y0, 2 * dpr, h);
        g.beginPath(); g.moveTo(x, y0); g.lineTo(x + 7 * dpr, y0); g.lineTo(x, y0 + 7 * dpr); g.fill();
        g.font = `800 ${9 * dpr}px Archivo, sans-serif`; g.fillText('CUE', Math.min(x + 5 * dpr, W - 25 * dpr), y0 + 12 * dpr);
      }
    }
    if (d.synced) { g.fillStyle = '#c6ff3d'; g.font = `800 ${10 * dpr}px Archivo, sans-serif`; g.fillText('Synced', W - 52 * dpr, y0 + 13 * dpr); }
  }
  function frame() {
    requestAnimationFrame(frame);
    if (!cv || !visible || document.hidden || !window.DeckEngine) return;
    dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = Math.round(cv.clientWidth * dpr), h = Math.round(cv.clientHeight * dpr);
    if (!w || !h) return;
    if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; }
    g.clearRect(0, 0, w, h);
    const lh = (h - 6 * dpr) / 2;
    lane(0, lh, 'A', 'A'); lane(lh + 6 * dpr, lh, 'B', 'B');
    g.fillStyle = '#fff'; g.fillRect(Math.round(w / 2) - dpr, 0, 2 * dpr, h);   // the play line
  }
  let tries = 0;
  const tryMount = () => { if (cv || window.__waxNoAutoBeatView) return; if (!mount() && ++tries < 40) setTimeout(tryMount, 300); };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', tryMount); else tryMount();
  window.WaxBeatView = { cache, mount: mountInto };
})();
