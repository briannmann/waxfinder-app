/* Top-nav quick action: a circled + that opens a small panel to add tracks from any page.
   Paste a link (downloads as MP3 via /start), or add files / a folder (uploads via /import), or drop audio files on the panel.
   Loaded on every page; it moves the nav pill into a right-hand group and puts the + beside it. */
(function () {
  const nav = document.querySelector('.nav'), pill = nav && nav.querySelector('.pill'); if (!nav || !pill || nav.querySelector('.navplus')) return;
  const AUD = /\.(mp3|wav|flac|aiff?|m4a)$/i, $ = (s, r = document) => r.querySelector(s);
  const h = (tag, props, ...kids) => { const e = Object.assign(document.createElement(tag), props || {}); e.append(...kids); return e };

  const css = h('style', { textContent: `
.navR{display:flex;align-items:center;gap:10px}
.navplus{flex:none;box-sizing:border-box;width:44px;height:44px;border:2px solid #fff;border-radius:50%;background:transparent;color:#fff;padding:0;margin:0;display:grid;place-items:center;line-height:0;cursor:pointer;transition:background-color .2s,color .2s,transform .2s}
.navplus svg{width:18px;height:18px}
.navplus:hover,.navplus[aria-expanded=true]{background:#fff;color:#14062e}
.navplus:focus-visible{outline:2px solid #c6ff3d;outline-offset:3px}
.navplus[aria-expanded=true] svg{transform:rotate(45deg)}.navplus svg{transition:transform .2s}
.atpop{position:fixed;z-index:70;width:min(380px,calc(100vw - 24px));padding:14px;border-radius:22px;background:rgba(20,6,46,.95);border:1px solid rgba(255,255,255,.2);box-shadow:0 18px 50px rgba(0,0,0,.45);-webkit-backdrop-filter:blur(18px);backdrop-filter:blur(18px);color:#fff;font:600 14px/1.35 Archivo,system-ui,sans-serif;text-transform:none;letter-spacing:0}
.atpop[hidden]{display:none}.atpop.drop{outline:2px dashed #c6ff3d;outline-offset:-6px}
.atpop h3{margin:0 0 10px;font-size:12px;font-weight:800;letter-spacing:.12em;text-transform:uppercase;opacity:.7}
.atpop form{display:flex;gap:8px}
.atpop input[type=url]{flex:1;min-width:0;height:40px;border-radius:999px;border:1.5px solid rgba(255,255,255,.35);background:rgba(255,255,255,.08);color:#fff;padding:0 14px;font:inherit;outline:0}
.atpop input[type=url]:focus{border-color:#c6ff3d}
.atpop input::placeholder{color:rgba(255,255,255,.55)}
.atpop button.at{height:40px;padding:0 16px;border-radius:999px;border:1.5px solid rgba(255,255,255,.4);background:transparent;color:#fff;font:800 12px Archivo,system-ui,sans-serif;letter-spacing:.08em;text-transform:uppercase;cursor:pointer;white-space:nowrap}
.atpop button.at:hover{border-color:#fff}.atpop button.go{background:#c6ff3d;border-color:#c6ff3d;color:#14062e}
.atrow{display:flex;gap:8px;margin-top:10px;align-items:center;flex-wrap:wrap}.atrow span{font-size:12px;opacity:.6}
.atlist{list-style:none;margin:10px 0 0;padding:0;max-height:220px;overflow:auto;overscroll-behavior:contain}
.atlist:empty{display:none}
.atlist li{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:2px 12px;padding:6px 2px;font-size:13px}
.atlist .n{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-weight:700}.atlist .s{font-size:12px;opacity:.75;white-space:nowrap}
.atlist .b{grid-column:1/-1;height:3px;border-radius:3px;background:rgba(255,255,255,.14);overflow:hidden}.atlist .b i{display:block;height:100%;background:#ff5fa8;transform-origin:left;transform:scaleX(0);transition:transform .2s}
.atdest{margin:-4px 0 10px;font-size:12px;opacity:.75;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.atdest.off{color:#ff9cc6;opacity:1}.atlist .rt{grid-column:1/-1;justify-self:start;height:28px;padding:0 12px;border-radius:999px;border:1.5px solid rgba(255,255,255,.4);background:transparent;color:#fff;font:800 11px Archivo,system-ui,sans-serif;letter-spacing:.06em;text-transform:uppercase;cursor:pointer}.atlist .rt:hover{border-color:#fff}
.atlist li.ok .b,.atlist li.dup .b,.atlist li.err .b{display:none}.atlist li.err .s{color:#ff9cc6;opacity:1}.atlist li.dup{opacity:.6}
` });
  document.head.append(css);

  const grp = h('div', { className: 'navR' }); nav.insertBefore(grp, pill); grp.append(pill);
  const btn = h('button', { type: 'button', className: 'navplus', title: 'Add tracks', ariaLabel: 'Add tracks' });
  btn.setAttribute('aria-haspopup', 'true'); btn.setAttribute('aria-expanded', 'false');
  btn.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4v16M4 12h16" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/></svg>';
  grp.append(btn);
  /* a true circle exactly as tall as the nav pill (the pill's height differs a little per page); 40px when the pill is hidden on phones */
  const fit = () => { const h = Math.round(pill.getBoundingClientRect().height) || 40; btn.style.width = btn.style.height = h + 'px' };
  fit(); if (window.ResizeObserver) new ResizeObserver(fit).observe(pill); addEventListener('resize', fit); if (document.fonts && document.fonts.ready) document.fonts.ready.then(fit);

  const url = h('input', { type: 'url', placeholder: 'Paste a track link (YouTube, SoundCloud…)', required: true, autocomplete: 'off' }); url.setAttribute('aria-label', 'Track link');
  const form = h('form', {}, url, h('button', { type: 'submit', className: 'at go', textContent: 'Download' }));
  const fFiles = h('input', { type: 'file', multiple: true, accept: '.mp3,.wav,.flac,.aif,.aiff,.m4a', hidden: true });
  const fDir = h('input', { type: 'file', hidden: true }); fDir.multiple = true; fDir.webkitdirectory = true;
  const bFiles = h('button', { type: 'button', className: 'at', textContent: 'Add files' }), bDir = h('button', { type: 'button', className: 'at', textContent: 'Add folder' });
  const list = h('ul', { className: 'atlist' }); list.setAttribute('aria-live', 'polite');
  const dest = h('p', { className: 'atdest' });
  const pop = h('div', { className: 'atpop', hidden: true, role: 'dialog' }, h('h3', { textContent: 'Add tracks' }), dest, form,
    h('div', { className: 'atrow' }, bFiles, bDir, h('span', { textContent: 'or drop audio files here' }), fFiles, fDir), list);
  pop.setAttribute('aria-label', 'Add tracks'); document.body.append(pop);

  function place() { const r = btn.getBoundingClientRect(); pop.style.top = (r.bottom + 10) + 'px'; pop.style.right = Math.max(12, innerWidth - r.right) + 'px' }
  async function showDest() {   // where the next track will be saved
    try {
      const d = await fetch('/dest').then(x => x.json()), name = d.path.split('/').filter(Boolean).slice(-2).join(' / ') || d.path;
      dest.classList.toggle('off', !!d.offline); dest.title = d.path;
      dest.textContent = d.offline ? 'Music folder not connected. Tracks can\u2019t be saved yet.' : 'Saves to ' + (d.kind === 'laptop' ? 'this computer' : name);
    } catch (e) { dest.textContent = '' }
  }
  function open(v) { pop.hidden = !v; btn.setAttribute('aria-expanded', String(v)); if (v) { place(); showDest(); url.focus({ preventScroll: true }) } }
  btn.onclick = () => open(pop.hidden);
  addEventListener('resize', () => { if (!pop.hidden) place() });
  document.addEventListener('pointerdown', e => { if (!pop.hidden && !pop.contains(e.target) && !btn.contains(e.target)) open(false) });
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && !pop.hidden) { open(false); btn.focus() } });

  /* a row per job: name, state text, progress bar */
  function row(name) {
    const n = h('span', { className: 'n', textContent: name, title: name }), s = h('span', { className: 's' }), i = h('i'), rt = h('button', { type: 'button', className: 'rt', textContent: 'Retry', hidden: true }), bar = h('span', { className: 'b' }, i), li = h('li', {}, n, s, bar, rt);
    list.prepend(li);
    return { set(state, text, pct) { li.className = state; s.textContent = text || ''; if (pct != null) i.style.transform = 'scaleX(' + pct + ')'; bar.hidden = state === 'ok' || state === 'dup' || state === 'err'; rt.hidden = true },
      retry(fn) { rt.hidden = false; rt.onclick = () => { rt.hidden = true; fn() } }, n };
  }
  const tell = () => { try { window.wfReloadCrates && window.wfReloadCrates() } catch (e) {} };

  /* link -> /start, then poll /status */
  form.onsubmit = async e => {
    e.preventDefault(); const link = url.value.trim(); if (!link) return; url.value = '';
    const r = row(link.replace(/^https?:\/\/(www\.)?/, '')); r.set('', 'Starting…', 0);
    try {
      const { id } = await fetch('/start', { method: 'POST', body: JSON.stringify({ url: link, fmt: 'mp3' }) }).then(x => x.json());
      const t = setInterval(async () => {
        try {
          const j = await fetch('/status?id=' + id).then(x => x.json());
          if (j.status === 'done') { clearInterval(t); r.n.textContent = j.title || r.n.textContent; r.set('ok', 'Added', 1); tell() }
          else if (j.status === 'error') { clearInterval(t); r.set('err', 'Failed: ' + (j.error || 'error')) }
          else r.set('', j.status === 'finding' ? 'Finding…' : j.status === 'converting' ? 'Converting…' : 'Downloading ' + j.pct + '%', (j.pct || 0) / 100);
        } catch (x) { clearInterval(t); r.set('err', 'Lost contact with the app') }
      }, 800);
    } catch (x) { r.set('err', 'Could not start') }
  };

  /* files / folders / drops -> /import (two at a time), then /import/status until analysed */
  const Q = []; let active = 0, polling = 0;
  function pollStatus() {
    if (polling) return; polling = setTimeout(async () => {
      polling = 0; const w = Q.filter(q => q.st === 'analysing'); if (!w.length) return;
      try { const r = await fetch('/import/status?ids=' + w.map(q => q.id).join(',')).then(x => x.json()); w.forEach(q => { if (r.ready.includes(q.id)) { q.st = 'ready'; q.r.set('ok', 'Added', 1); tell() } else if (r.failed && r.failed[q.id]) { q.st = 'failed'; q.r.set('err', 'Added, but its analysis failed'); q.r.retry(() => retry(q)) } }) } catch (x) {}
      if (Q.some(q => q.st === 'analysing')) pollStatus();
    }, 3000);
  }
  async function retry(q) {
    q.r.set('', 'Analysing…', 1); q.st = 'analysing';
    try { await fetch('/import/retry', { method: 'POST', body: JSON.stringify({ id: q.id }) }) } catch (e) { q.st = 'failed'; q.r.set('err', 'Added, but its analysis failed'); q.r.retry(() => retry(q)); return }
    pollStatus();
  }
  function next() { while (active < 2) { const q = Q.find(x => x.st === 'wait'); if (!q) break; send(q) } }
  function send(q) {
    q.st = 'up'; active++; q.r.set('', '0%', 0);
    const x = new XMLHttpRequest(), fin = () => { active--; next() };
    x.open('POST', '/import'); x.setRequestHeader('X-Filename', encodeURIComponent(q.name.split('/').pop()));
    x.upload.onprogress = e => { if (e.lengthComputable) q.r.set('', Math.round(e.loaded / e.total * 100) + '%', e.loaded / e.total) };
    x.onload = () => {
      let r = {}; try { r = JSON.parse(x.responseText) } catch (e) {}
      if (r.status === 'added') { q.st = 'analysing'; q.id = r.id; if (r.title) q.r.n.textContent = r.title; q.r.set('', 'Analysing…', 1); pollStatus() }
      else if (r.status === 'duplicate') { q.st = 'dup'; q.r.set('dup', 'Already in library') }
      else { q.st = 'err'; q.r.set('err', r.error || 'Failed') }
      fin();
    };
    x.onerror = () => { q.st = 'err'; q.r.set('err', 'Upload failed'); fin() };
    x.send(q.file);
  }
  function addFiles(files) {
    const audio = [...files].filter(f => !f.name.startsWith('.') && AUD.test(f.name));
    if (!audio.length) { const r = row('No audio files there'); r.set('err', 'MP3, WAV, FLAC, AIFF or M4A'); return }
    for (const f of audio) { const name = f.webkitRelativePath || f.name; Q.push({ file: f, name, st: 'wait', r: row(name) }) }
    next();
  }
  bFiles.onclick = () => fFiles.click(); bDir.onclick = () => fDir.click();
  fFiles.onchange = () => { addFiles(fFiles.files); fFiles.value = '' }; fDir.onchange = () => { addFiles(fDir.files); fDir.value = '' };
  const isFiles = e => e.dataTransfer && [...e.dataTransfer.types].includes('Files');
  pop.addEventListener('dragover', e => { if (isFiles(e)) { e.preventDefault(); pop.classList.add('drop') } });
  pop.addEventListener('dragleave', () => pop.classList.remove('drop'));
  pop.addEventListener('drop', async e => {
    if (!isFiles(e)) return; e.preventDefault(); e.stopPropagation(); pop.classList.remove('drop');
    const ents = [...e.dataTransfer.items].map(i => i.webkitGetAsEntry && i.webkitGetAsEntry()).filter(Boolean), out = [];   // entries first, before any await
    if (!ents.length) return addFiles(e.dataTransfer.files);
    const walk = async en => { if (en.isFile) { try { out.push(await new Promise((a, b) => en.file(a, b))) } catch (x) {} } else if (en.isDirectory) { const rd = en.createReader(); let b; do { b = await new Promise((a, c) => rd.readEntries(a, c)); for (const c of b) await walk(c) } while (b.length) } };
    for (const en of ents) await walk(en); addFiles(out);
  });
  addEventListener('beforeunload', e => { if (Q.some(q => q.st === 'up' || q.st === 'wait')) { e.preventDefault(); e.returnValue = '' } });
})();
