/* CDJ export progress pill. Lives in the SHELL (shell.html), like the audio player, so it keeps going while you change pages.
   Bottom centre, just above the player bar: "Exporting to MUSIC · 45%" with the progress filling the pill. Click it for details
   (stage, crates, and the list of left-out tracks when it finishes). Polls /cdj/active; the Crates page nudges it with
   postMessage({wfCdj:'poll'}) the moment an export starts. A finished/failed pill stays until you press x (remembered per job). */
(function () {
  if (window.__wfExportPill) return; window.__wfExportPill = true;
  const h = (t, p, ...k) => { const e = Object.assign(document.createElement(t), p || {}); e.append(...k); return e };
  const css = h('style', { textContent: `
.wfx{position:fixed;left:50%;bottom:calc(var(--wxp-h,0px) + 16px);transform:translateX(-50%);z-index:2147482000;display:flex;align-items:center;gap:6px;max-width:calc(100vw - 24px);font-family:Archivo,system-ui,sans-serif;transition:bottom .35s cubic-bezier(.2,.8,.2,1)}
.wfx[hidden]{display:none}
.wfx-main{position:relative;overflow:hidden;min-width:260px;height:44px;padding:0 22px;border-radius:999px;border:1.5px solid rgba(255,255,255,.4);background:rgba(20,6,46,.95);color:#fff;font:800 12px/1 Archivo,system-ui,sans-serif;letter-spacing:.07em;text-transform:uppercase;cursor:pointer;box-shadow:0 12px 34px rgba(20,6,46,.5);-webkit-backdrop-filter:blur(14px);backdrop-filter:blur(14px)}
.wfx-main i{position:absolute;inset:0;transform-origin:left;transform:scaleX(0);background:linear-gradient(90deg,#ff2e88,#ff7a2e);transition:transform .6s ease;pointer-events:none}
.wfx-main span{position:relative;display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.wfx.done .wfx-main{border-color:#c6ff3d;color:#14062e}.wfx.done .wfx-main i{background:#c6ff3d;transform:scaleX(1)!important}
.wfx.err .wfx-main{border-color:#ff5fa8;background:#5a1236}
.wfx-x{width:34px;height:34px;border-radius:50%;border:1.5px solid rgba(255,255,255,.4);background:rgba(20,6,46,.95);color:#fff;font:700 16px/1 Archivo,system-ui,sans-serif;cursor:pointer;display:grid;place-items:center;padding:0}
.wfx-x[hidden]{display:none}.wfx-x.run{width:auto;padding:0 14px;border-radius:99px;height:34px;font:800 11px Archivo,system-ui,sans-serif;letter-spacing:.06em;text-transform:uppercase}.wfx-x:hover,.wfx-main:hover{border-color:#fff}
.wfx-pop{position:absolute;left:50%;bottom:54px;transform:translateX(-50%);width:min(380px,calc(100vw - 24px));max-height:min(60vh,420px);overflow:auto;overscroll-behavior:contain;padding:14px 16px;border-radius:20px;background:rgba(20,6,46,.97);border:1px solid rgba(255,255,255,.25);box-shadow:0 18px 50px rgba(0,0,0,.5);color:#fff;font:600 13px/1.45 Archivo,system-ui,sans-serif;text-transform:none;letter-spacing:0}
.wfx-pop[hidden]{display:none}.wfx-pop h4{margin:0 0 6px;font:800 11px Archivo,system-ui,sans-serif;letter-spacing:.12em;text-transform:uppercase;opacity:.7}
.wfx-pop p{margin:0 0 8px}.wfx-pop ul{list-style:none;margin:6px 0 0;padding:0;display:grid;gap:6px}.wfx-pop li b{display:block;font-weight:800}.wfx-pop li span{opacity:.75;font-size:12px}
.wfx-pop summary{cursor:pointer;font-weight:800;color:#ffb23d}` });
  document.head.append(css);

  const fill = h('i'), label = h('span'), main = h('button', { type: 'button', className: 'wfx-main' }, fill, label), x = h('button', { type: 'button', className: 'wfx-x', textContent: '×', hidden: true });
  x.setAttribute('aria-label', 'Dismiss'); x.title = 'Dismiss';
  const pop = h('div', { className: 'wfx-pop', hidden: true, role: 'dialog' }); pop.setAttribute('aria-label', 'Export details');
  const box = h('div', { className: 'wfx', hidden: true, role: 'status' }, pop, main, x); box.setAttribute('aria-live', 'polite');
  document.body.append(box);

  let job = null, timer = 0, open = false, armed = 0, lost = 0, wasRunning = false;
  const seen = () => { try { return localStorage.getItem('wf.cdjdismissed') } catch (e) { return null } };
  // What this export actually put on the stick: files newly copied (not the stick's total, which includes everything from earlier exports).
  const added = r => r.new_files == null ? 'Exported to' : r.new_files === 0 ? 'No new tracks to copy; playlists updated on' : 'Copied ' + noun(r.new_files) + ' to';
  const noun = n => n + (n === 1 ? ' track' : ' tracks');
  // One line per playlist: what changed since the last export to this stick.
  const changeLine = c => c.first ? c.name + ': new playlist, ' + noun(c.count)
    : (() => { const b = []; if (c.added) b.push(noun(c.added) + ' added'); if (c.removed) b.push(noun(c.removed) + ' removed'); if (c.moved) b.push('order changed'); return c.name + ': ' + (b.length ? b.join(', ') : 'no changes') })();

  // Replacing a stick's library is its own deliberate action: two clicks, with what it does spelled out.
  function rebuildBox(j) {
    const b = h('button', { className: 'wfd-r', textContent: 'Rebuild this stick\'s library…', style: 'font:800 11px Archivo;padding:5px 12px;border-radius:99px;cursor:pointer' }), note = h('span');
    b.onclick = async () => {
      if (b.dataset.sure !== '1') { b.dataset.sure = '1'; b.textContent = 'Sure? Replace the library'; note.textContent = ' The stick\'s current library is set aside (not deleted) and rebuilt from only the crates you picked, so playlists not in this export will vanish from the CDJs until you restore it' + (j.will_vanish && j.will_vanish.length ? ' (' + j.will_vanish.slice(0, 8).join(', ') + (j.will_vanish.length > 8 ? ' and ' + (j.will_vanish.length - 8) + ' more' : '') + ')' : '') + '. If the rebuild fails, the old one is put back.'; return }
      b.disabled = true;
      try { await fetch('/crates/cdj', { method: 'POST', body: JSON.stringify({ crates: j.crate_ids || [], volume: j.volume, rebuild: true }) }); poll() } catch (e) { b.disabled = false }
    };
    return h('p', {}, b, note);
  }

  function details(j) {
    const out = [];
    const crates = (j.crates || []).join(', ');
    for (const o of j.others || []) out.push(h('p', {}, h('b', { textContent: o.stick + ' · ' + o.pct + '% ' }), h('button', { className: 'wfd-r', textContent: 'Cancel', style: 'font:800 10px Archivo;padding:3px 10px;border-radius:99px;border:1.5px solid rgba(255,255,255,.4);background:none;color:#fff;cursor:pointer;margin-left:6px', onclick: async e => { e.target.textContent = '…'; await fetch('/crates/cdj/cancel', { method: 'POST', body: JSON.stringify({ id: o.id }) }); poll() } })));
    if (j.state === 'running') out.push(h('p', { textContent: (j.stage || 'Working') + (j.total ? ' · ' + j.done + ' of ' + j.total + ' tracks' : '') + '…' }), h('p', { textContent: 'You can keep working. This carries on in the background, even if you change page.' }));
    if (crates) out.push(h('h4', { textContent: 'Crates' }), h('p', { textContent: crates }));
    if (j.state === 'done') {
      const r = j.report || {};
      out.unshift(h('p', { textContent: 'Done: ' + added(r) + ' ' + j.stick + '. ' + (r.tracks || 0) + ' tracks in ' + (r.playlists || 0) + ' playlists on the stick now. ' + (j.outcome === 'verified' ? 'Checked OK.' : j.outcome === 'omissions' ? 'Passed its check, but some tracks were left out.' : 'The check result was not recorded.') + (r.bytes_copied ? '' : ' Nothing needed copying.') + ' Eject the stick in Finder before pulling it out.' }));
      for (const c of r.changes || []) out.push(h('p', { textContent: changeLine(c) }));
      if (j.backup) out.push(h('p', { textContent: 'A copy of the stick\'s old library is in ' + j.backup.split('/').pop() + '.' }));
    }
    if (j.state === 'error') out.unshift(h('p', { textContent: j.error || 'Export failed.' }), j.detail && j.detail !== j.error ? h('details', {}, h('summary', { textContent: 'Details' }), h('p', { textContent: j.detail })) : h('span'), h('p', { textContent: j.backup ? 'The stick\'s previous library is in the folder ' + j.backup.split('/').pop() + '.' : j.outcome === 'verify_failed' || j.outcome === 'unknown' ? 'The stick may have been written. Check it before relying on it.' : '' }),
      j.needs_rebuild ? rebuildBox(j) : h('span'));
    const lo = j.left_out || [];
    if (lo.length) out.push(h('details', { open: j.state !== 'running' }, h('summary', { textContent: noun(lo.length) + (lo.length === 1 ? ' was' : ' were') + ' left out' }),
      h('ul', {}, ...lo.map(t => h('li', {}, h('b', { textContent: t.title }), h('span', { textContent: (t.crate ? 'in ' + t.crate + ' · ' : '') + t.why }))))));
    return out;
  }

  function render() { renderPill(); frameVar() }
  // tell the page in the frame how much room the pill takes at the bottom, so its toasts (static/toaststack.js) stack above it
  function frameVar() {
    try {
      const f = document.getElementById('page'), root = f && f.contentDocument && f.contentDocument.documentElement;
      if (!root) return;
      const v = box.hidden ? '0px' : (16 + box.offsetHeight) + 'px';
      if (root.style.getPropertyValue('--wfx-h') !== v) root.style.setProperty('--wfx-h', v);
    } catch (e) { }
  }
  { const f = document.getElementById('page'); if (f) f.addEventListener('load', frameVar) }
  function renderPill() {
    if (job && job.state === 'running') wasRunning = true; else if (job) wasRunning = false;
    if (lost > 1 && (wasRunning || (job && job.state === 'running'))) {   // the app stopped answering mid-export: say so, never leave a stale bar
      box.hidden = false; box.classList.remove('done'); box.classList.add('err'); fill.style.transform = 'scaleX(0)';
      label.textContent = 'Lost contact with Waxfinder · retrying'; x.hidden = true; return
    }
    if (!job || job.id === seen()) { box.hidden = true; return }
    box.hidden = false; box.classList.toggle('done', job.state === 'done'); box.classList.toggle('err', job.state === 'error');
    const lo = (job.left_out || []).length, pct = Math.max(0, Math.min(100, job.pct || 0));
    fill.style.transform = 'scaleX(' + pct / 100 + ')';
    label.textContent = job.state === 'running' ? 'Exporting to ' + job.stick + ' · ' + pct + '%' + ((job.others || []).length ? ' +' + job.others.length : '')
      : job.state === 'done' ? added(job.report || {}) + ' ' + job.stick + (lo ? ' · ' + lo + ' left out' : '') + (job.outcome === 'verified' || job.outcome === 'omissions' ? '' : ' · check not recorded')
      : job.error === 'Cancelled' ? 'Export cancelled' : job.outcome === 'verify_failed' ? 'Written, but the check failed · tap for details' : job.outcome === 'unknown' ? 'Export interrupted · check the stick' : 'Export failed · tap for details';
    x.hidden = false; if (!armed) x.textContent = job.state === 'running' ? 'Cancel' : '×'; x.classList.toggle('run', job.state === 'running');
    if (open) fillPop();
  }

  // Redraw the popup only when the job changed, and carry over which <details> the user opened/closed + the scroll position.
  // (Polling used to rebuild it every few seconds, which snapped any dropdown you had just clicked back to its default.)
  let popSig = '', popJob = '';
  function fillPop() {
    const sig = JSON.stringify(job);
    if (sig === popSig && pop.childNodes.length) return;
    const keep = popJob === job.id ? [...pop.querySelectorAll('details')].map(d => d.open) : null, top = pop.scrollTop;
    const lists = popJob === job.id ? [...pop.querySelectorAll('ul')].map(u => u.scrollTop) : [];
    pop.replaceChildren(h('h4', { textContent: 'CDJ export' }), ...details(job));
    if (keep) pop.querySelectorAll('details').forEach((d, i) => { if (i < keep.length) d.open = keep[i] });
    pop.querySelectorAll('ul').forEach((u, i) => { if (lists[i]) u.scrollTop = lists[i] });
    pop.scrollTop = top; popSig = sig; popJob = job.id;
  }

  async function poll() {
    clearTimeout(timer);
    try { job = (await fetch('/cdj/active', { cache: 'no-store' }).then(r => r.json())).job; lost = 0 } catch (e) { lost++ }
    render();
    timer = setTimeout(poll, (job && job.state === 'running') || lost ? 900 : 5000);
  }

  main.onclick = () => { open = !open; pop.hidden = !open; if (open && job) { popSig = ''; fillPop() } };
  x.onclick = async () => {
    if (job && job.state === 'running') {
      if (!armed) { armed = setTimeout(() => { armed = 0; x.textContent = 'Cancel' }, 3000); x.textContent = 'Sure?'; return }
      clearTimeout(armed); armed = 0; x.textContent = '…';
      const r = await fetch('/crates/cdj/cancel', { method: 'POST', body: JSON.stringify({ id: job.id }) }).then(r => r.json()).catch(() => ({}));
      if (r.error) { x.textContent = 'Cancel'; label.textContent = r.error } poll(); return
    }
    if (job) { try { localStorage.setItem('wf.cdjdismissed', job.id) } catch (e) { } } open = false; pop.hidden = true; render() };
  document.addEventListener('pointerdown', e => { if (open && !box.contains(e.target)) { open = false; pop.hidden = true } });
  addEventListener('blur', () => { if (open) { open = false; pop.hidden = true } });   // a click inside the page frame blurs the shell
  addEventListener('message', e => { if (e.data && e.data.wfCdj === 'poll') poll() });
  poll();
})();
