/* Crates "Analyse N tracks" control. Click it and it becomes a progress bar that fills as BPM/key, sound fingerprints and waveforms are made.
   Always visible, including when complete or unable to reach the server. Fires 'wf-analysed' when a run finishes. */
(function () {
  if (window.wfAnalyse) return;
  const box = document.getElementById('wf-analyse');
  if (!box) return;
  const css = `@property --p{syntax:'<number>';inherits:false;initial-value:0}
#wf-anl{position:fixed;right:max(16px,2vw);bottom:max(16px,2vw);z-index:60;display:inline-flex;font-family:inherit;max-width:calc(100vw - 32px)}
#wf-anl[hidden]{display:none}
#wf-anl button{height:52px;padding:0 26px;border:0;border-radius:999px;font:800 13px/1 inherit;font-family:inherit;letter-spacing:.06em;text-transform:uppercase;color:#fff;cursor:pointer;
  background:linear-gradient(135deg,#ff2e88,#ff7a2e);box-shadow:0 14px 34px rgba(255,46,136,.45);transition:transform .2s,box-shadow .2s}
#wf-anl button:hover:not(:disabled){transform:translateY(-2px);box-shadow:0 18px 40px rgba(255,46,136,.55)}
#wf-anl button:focus-visible{outline:3px solid #c6ff3d;outline-offset:3px}
#wf-anl button:disabled{cursor:default}
#wf-anl button.busy{--p:0;min-width:220px;cursor:default;background:linear-gradient(90deg,#ff2e88 calc(var(--p)*100%),rgba(20,6,46,.88) calc(var(--p)*100%));
  box-shadow:0 14px 34px rgba(20,6,46,.45),inset 0 0 0 2px rgba(255,255,255,.55);transition:--p .8s linear}
@media (prefers-reduced-motion:reduce){#wf-anl button,#wf-anl button.busy{transition:none}}`;
  const st = document.createElement('style'); st.textContent = css; document.head.append(st);
  box.id = 'wf-anl'; box.setAttribute('role', 'status');
  const btn = box.querySelector('button');
  let timer = 0, was = false, statusReady = false, checking = false;
  function failed(message) {
    statusReady = false; btn.disabled = false; btn.classList.remove('busy'); btn.style.removeProperty('--p');
    btn.textContent = message; btn.title = 'Click to check the analysis status again.';
    clearTimeout(timer); timer = setTimeout(check, 30000);
  }
  async function check() {
    if (checking) return;
    checking = true;
    clearTimeout(timer); let d;
    try {
      const response = await fetch('/library/pending', { cache: 'no-store', signal: AbortSignal.timeout(15000) });
      if (!response.ok) throw new Error('Status unavailable');
      d = await response.json();
    } catch (e) { failed('Retry analysis status'); return; }
    finally { checking = false; }
    statusReady = true;
    if (d.busy) {
      const j = d.jobs, parts = []; let done = 0, tot = 0;
      for (const [k, lab] of [['analysis', 'BPM & key'], ['sound', 'sound'], ['waves', 'waveforms'], ['genres', 'genres']]) { const x = j[k] || {}; if ((x.state === 'working' || x.busy) && x.total) { parts.push(lab + ' ' + x.done + '/' + x.total); done += x.done; tot += x.total; } }
      box.hidden = false; btn.disabled = true; btn.classList.add('busy'); btn.style.setProperty('--p', tot ? done / tot : 0);
      btn.textContent = 'Analysing ' + (tot ? done + ' / ' + tot : '…'); btn.title = parts.join(' · ');
      was = true; timer = setTimeout(check, 2500); return;
    }
    if (was) { was = false; document.dispatchEvent(new CustomEvent('wf-analysed')); }
    btn.classList.remove('busy'); btn.style.removeProperty('--p'); btn.disabled = false;
    if (!d.tracks) { box.hidden = true; btn.disabled = true; btn.textContent = 'Tracks analysed'; btn.title = 'All available tracks are analysed.'; timer = setTimeout(check, 60000); return; }
    box.hidden = false; btn.textContent = 'Analyse ' + d.tracks + (d.tracks === 1 ? ' track' : ' tracks');
    btn.title = [d.need.analysis && d.need.analysis + ' need BPM/key/energy', d.need.sound && d.need.sound + ' need a sound fingerprint', d.need.waves && d.need.waves + ' need a waveform', d.need.genres && d.need.genres + ' need genre tags', d.jobs.genres?.state === 'paused' && 'Genre lookup paused: ' + d.jobs.genres.error].filter(Boolean).join(', ');
    timer = setTimeout(check, 60000);
  }
  btn.addEventListener('click', async () => {
    if (!statusReady) { btn.disabled = true; btn.textContent = 'Checking tracks…'; await check(); return; }
    clearTimeout(timer);
    btn.disabled = true; btn.classList.add('busy'); btn.style.setProperty('--p', 0); btn.textContent = 'Starting…';
    try {
      const response = await fetch('/library/analyse', { method: 'POST', signal: AbortSignal.timeout(15000) });
      if (!response.ok) throw new Error('Could not start');
    } catch (e) { failed('Could not start — check status'); return; }
    timer = setTimeout(check, 600);
  });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) check(); });
  window.wfAnalyse = { check };
  check();
})();
