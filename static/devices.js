/* Files chip (was Devices). Lives in the SHELL next to the export pill and the player, so it is on every page. Bottom-left: "MUSIC" (or "Devices").
   Click it: plugged-in sticks with free space and what is on them (CDJ library / Waxfinder / Rekordbox), a folder browser, Eject, Show in
   Finder and "Export crates here". Read-only apart from Eject. Same look as exportpill.js. */
(function () {
  if (window.__wfDevices) return; window.__wfDevices = true;
  const h = (t, p, ...k) => { const e = Object.assign(document.createElement(t), p || {}); e.append(...k); return e };
  const gb = n => n >= 2 ** 30 ? (n / 2 ** 30).toFixed(1) + ' GB' : Math.round(n / 2 ** 20) + ' MB';
  document.head.append(h('style', { textContent: `
.wfd{position:fixed;left:16px;bottom:calc(var(--wxp-h,0px) + 16px);z-index:2147481900;font-family:Archivo,system-ui,sans-serif;transition:bottom .35s cubic-bezier(.2,.8,.2,1)}
.wfd[hidden]{display:none}
.wfd-b{height:44px;min-width:44px;justify-content:center;padding:0 12px;border-radius:999px;border:1.5px solid rgba(255,255,255,.4);background:rgba(20,6,46,.95);color:#fff;font:800 12px/1 Archivo,system-ui,sans-serif;letter-spacing:.07em;text-transform:uppercase;cursor:pointer;display:flex;align-items:center;gap:8px;box-shadow:0 12px 34px rgba(20,6,46,.45)}
.wfd-b:hover{border-color:#fff}.wfd-b i{width:9px;height:9px;border-radius:50%;background:#c6ff3d;box-shadow:0 0 0 3px rgba(198,255,61,.22)}.wfd-b.none i{display:none}.wfd-b.off i{display:block;background:#ff9f2e;box-shadow:0 0 0 3px rgba(255,159,46,.25)}
.wfd-b svg{width:18px;height:18px;flex:none}.wfd-b span{max-width:0;overflow:hidden;white-space:nowrap;margin-left:-8px;transition:max-width .25s,margin .25s}
.wfd-b:hover span,.wfd-b:focus-visible span,.wfd:has(.wfd-p:not([hidden])) .wfd-b span{max-width:90px;margin-left:0}.wfd-b:focus-visible{outline:3px solid #c6ff3d;outline-offset:3px}
.wfd-warn{color:#ffb35c;opacity:1}.wfd-path{margin:0;overflow-wrap:anywhere}
@media (prefers-reduced-motion:reduce){.wfd-b span{transition:none}}
.wfd-p{position:absolute;left:0;bottom:54px;width:min(400px,calc(100vw - 32px));max-height:min(70vh,520px);overflow:auto;overscroll-behavior:contain;padding:14px 16px;border-radius:20px;background:rgba(20,6,46,.97);border:1px solid rgba(255,255,255,.25);box-shadow:0 18px 50px rgba(0,0,0,.5);color:#fff;font:600 13px/1.4 Archivo,system-ui,sans-serif}
.wfd-p[hidden]{display:none}.wfd-p h4{margin:0 0 8px;font:800 11px Archivo,system-ui,sans-serif;letter-spacing:.12em;text-transform:uppercase;opacity:.7}
.wfd-v{padding:10px 12px;border-radius:16px;border:1.5px solid rgba(255,255,255,.22);margin-bottom:8px}.wfd-v.cur{border-color:#c6ff3d}
.wfd-t{display:flex;align-items:center;gap:8px}.wfd-t b{flex:1;font-weight:800;font-size:15px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.wfd-t small,.wfd-s{opacity:.7;font-size:12px}
.wfd-bar{height:5px;border-radius:5px;background:rgba(255,255,255,.15);margin:7px 0 4px;overflow:hidden}.wfd-bar i{display:block;height:100%;background:linear-gradient(90deg,#ff2e88,#ff7a2e)}
.wfd-tag{display:inline-block;margin:2px 4px 0 0;padding:2px 8px;border-radius:99px;font:800 10px Archivo,system-ui,sans-serif;letter-spacing:.06em;text-transform:uppercase;background:rgba(255,255,255,.12)}.wfd-tag.g{background:#c6ff3d;color:#14062e}
.wfd-a{display:flex;gap:6px;flex-wrap:wrap;margin-top:8px}
.wfd-a button,.wfd-r{font:800 11px Archivo,system-ui,sans-serif;letter-spacing:.05em;text-transform:uppercase;padding:6px 12px;border-radius:99px;border:1.5px solid rgba(255,255,255,.35);background:transparent;color:#fff;cursor:pointer}.wfd-a button:hover,.wfd-r:hover{border-color:#fff}
.wfd-a .go{background:#c6ff3d;border-color:#c6ff3d;color:#14062e}
.wfd-crumb{display:flex;flex-wrap:wrap;gap:2px;margin:10px 0 6px;font-weight:800}.wfd-crumb button{background:none;border:0;color:#c6ff3d;font:800 12px Archivo,system-ui,sans-serif;cursor:pointer;padding:0 2px}
.wfd-hd{display:flex;align-items:center;gap:8px;padding:8px 10px;border-radius:10px;background:rgba(255,255,255,.12);font:800 15px Archivo,system-ui,sans-serif;margin-bottom:4px}.wfd-hd span{flex:1}.wfd-hd .wfd-r{padding:4px 10px}
.wfd-n{display:flex;align-items:center;gap:8px;padding:5px 8px;border-radius:8px;cursor:pointer;min-height:36px}.wfd-n:hover{background:rgba(255,255,255,.08)}
.wfd-ch{font-style:normal;width:12px;flex:none;font-size:10px;opacity:.85}.wfd-usb{width:14px;height:22px;flex:none;color:#aaa}
.wfd-nm{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:14px}.wfd-nm.top{font-weight:800;font-size:16px}
.wfd-n small{opacity:.55;font-size:11px;white-space:nowrap}
.wfd-tr{display:flex;gap:8px;align-items:baseline;padding:2px 8px 2px 62px;font-size:13px;font-weight:600;opacity:.9}.wfd-tr i{font-style:normal;opacity:.45;font-size:11px;min-width:24px;text-align:right}.wfd-tr span{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.wfd-na{display:flex;gap:6px;align-items:center;flex:none}.wfd-na button{font:800 10px Archivo,system-ui,sans-serif;letter-spacing:.05em;text-transform:uppercase;padding:4px 9px;border-radius:99px;border:1.5px solid rgba(255,255,255,.35);background:transparent;color:#fff;cursor:pointer}.wfd-na button:hover{border-color:#fff}.wfd-na .go{background:#c6ff3d;border-color:#c6ff3d;color:#14062e}
.wfd-na .ic{width:24px;height:24px;padding:0;display:grid;place-items:center;font-size:12px;letter-spacing:0}
.wfd-l{list-style:none;margin:0;padding:0}.wfd-l li{display:flex;gap:8px;padding:5px 6px;border-radius:10px;align-items:center}.wfd-l li.d{cursor:pointer}.wfd-l li.d:hover{background:rgba(255,255,255,.1)}
.wfd-l li span{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.wfd-l li small{opacity:.6;font-size:11px}.wfd-l li.f{opacity:.9;cursor:pointer}.wfd-l li.f:hover{background:rgba(255,255,255,.08)}.wfd-l input{accent-color:#c6ff3d;width:16px;height:16px;flex:none}` }));
  const label = h('span', { textContent: 'Files' }), dot = h('i'), ico = h('b', { innerHTML: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" aria-hidden="true"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>', style: 'display:grid' }), btn = h('button', { type: 'button', className: 'wfd-b none' }, ico, dot, label); btn.setAttribute('aria-label', 'Files');
  const pop = h('div', { className: 'wfd-p', hidden: true, role: 'dialog' }); pop.setAttribute('aria-label', 'Devices');
  const box = h('div', { className: 'wfd' }, pop, btn); document.body.append(box);
  let lib = null, places = [], sel = new Set(), vols = [], open = false, cur = null, path = null, timer = 0, sig = '';
  const go = u => { const f = document.getElementById('page'); if (f) f.src = u; open = false; pop.hidden = true };
  const post = (u, b) => fetch(u, { method: 'POST', body: JSON.stringify(b) }).then(r => r.json());

  async function list() {
    try { const d = await fetch('/dev/list', { cache: 'no-store' }).then(r => r.json()); vols = d.volumes || []; places = d.places || []; lib = d.library || null } catch (e) { return }
    const s = JSON.stringify(vols.map(v => [v.name, v.free])); const changed = s !== sig; sig = s;
    const first = vols.find(v => v.ours || v.pioneer) || vols[0];
    const off = !!(lib && lib.offline); btn.classList.toggle('none', !vols.length && !off); btn.classList.toggle('off', off); label.textContent = 'Files';
    btn.title = off ? 'Your music folder is not connected' : vols.length ? vols.map(v => v.name).join(', ') + ' plugged in' : 'Your music folder and USBs'; btn.setAttribute('aria-label', 'Files' + (off ? ': music folder not connected' : ''));
    if (cur && !vols.some(v => v.name === cur)) { cur = null; path = null }
    if (open && changed && !path) draw();
  }
  /* Rekordbox-style device list: a "Devices" header, one expandable row per stick (name, Export, eject). */
  const openSet = new Set(), kids = new Map(), USB = '<svg viewBox="0 0 14 22" fill="currentColor"><rect x="3" y="0" width="8" height="6" rx="1"/><rect x="5" y="1.5" width="1.6" height="2"/><rect x="7.6" y="1.5" width="1.6" height="2"/><rect x="1" y="7" width="12" height="15" rx="2"/></svg>';
  async function load(p) {
    if (kids.has(p)) return; kids.set(p, 'loading');
    try { const r = await fetch('/dev/playlists?path=' + encodeURIComponent(p), { cache: 'no-store' }).then(r => r.json()); kids.set(p, r.error ? { error: r.error } : (r.playlists || [])) } catch (e) { kids.set(p, { error: 'Could not read' }) }
    if (open && !path) draw();
  }
  /* A stick expands to its crates and sets (the playlists Waxfinder exported to it): nothing else on the drive is listed. */
  function node(top, name, p, depth, note, acts, usb) {
    const isOpen = openSet.has(p), sub = kids.get(p);
    const row = h('div', { className: 'wfd-n', style: 'padding-left:' + (8 + depth * 18) + 'px' }, h('i', { className: 'wfd-ch', textContent: isOpen ? '▼' : '▶' }), usb ? h('span', { className: 'wfd-usb', innerHTML: USB }) : '',
      h('span', { className: 'wfd-nm' + (depth ? '' : ' top'), textContent: name }), note ? h('small', { textContent: note }) : '', h('div', { className: 'wfd-na' }, ...(acts || [])));
    row.onclick = () => { if (isOpen) openSet.delete(p); else { openSet.add(p); load(p) } draw() };
    const out = [row], msg = t => h('div', { className: 'wfd-s', style: 'padding:3px 8px 3px 34px', textContent: t });
    if (isOpen) {
      if (!sub || sub === 'loading') out.push(msg('Loading…'));
      else if (sub.error) out.push(msg(sub.error));
      else if (!sub.length) out.push(msg('No crates or sets on this stick yet'));
      else for (const d of sub) {   // each crate expands to the tracks on the stick from that crate
        const key = p + '\u0000' + d.name, on = openSet.has(key), n = d.tracks.length;
        const cr = h('div', { className: 'wfd-n', style: 'padding-left:30px' }, h('i', { className: 'wfd-ch', textContent: on ? '▼' : '▶' }), h('span', { className: 'wfd-nm', textContent: d.name }), h('small', { textContent: n + (n === 1 ? ' track' : ' tracks') }),
          h('div', { className: 'wfd-na' }, h('button', { textContent: 'Open', title: 'Show these tracks in the Library', onclick: e => { e.stopPropagation(); go('/crates?stick=' + encodeURIComponent(top) + '&pl=' + encodeURIComponent(d.name)) } })));
        cr.onclick = () => { on ? openSet.delete(key) : openSet.add(key); draw() };
        out.push(cr);
        if (on) { if (!n) out.push(h('div', { className: 'wfd-s', style: 'padding:3px 8px 3px 62px', textContent: 'Empty' })); else out.push(...d.tracks.map((t, i) => h('div', { className: 'wfd-tr', title: (t.artist ? t.artist + ' – ' : '') + t.title }, h('i', { textContent: i + 1 }), h('span', { textContent: (t.artist ? t.artist + ' – ' : '') + t.title })))) }
      }
    }
    return out;
  }
  function draw() {
    const rf = h('button', { className: 'wfd-r', textContent: '↻', title: 'Refresh' });
    rf.onclick = async () => { rf.disabled = true; await list(); await post('/dev/refresh', {}); for (;;) { const s = await fetch('/dev/refresh', { cache: 'no-store' }).then(r => r.json()); if (s.state !== 'working') break; rf.textContent = 'Scanning ' + (s.done || 0) + '/' + (s.total || '…'); await new Promise(r => setTimeout(r, 700)) } rf.textContent = '✓'; rf.disabled = false; try { document.getElementById('page').contentWindow.location.reload() } catch (e) { } };
    const volRows = vols.flatMap(v => node(v.name, v.name, v.path, 0, gb(v.free) + ' free', [
      h('button', { className: 'go', textContent: 'Export', title: 'Export crates to this stick', onclick: e => { e.stopPropagation(); go('/crates?export=' + encodeURIComponent(v.name)) } }),
      h('button', { className: 'ic', textContent: '⏏', title: 'Eject', onclick: async e => { e.stopPropagation(); const b = e.currentTarget; b.textContent = '…'; const r = await post('/dev/eject', { path: v.path }); b.textContent = r.error ? '!' : '✓'; b.title = r.error || 'Ejected'; setTimeout(list, 1200) } })], true));
    /* where new songs are saved: a plugged-in USB (into its Waxfinder folder) or any folder on this computer */
    const here = lib && lib.chosen ? vols.find(v => lib.path === v.path || lib.path.startsWith(v.path + '/')) : null;
    const setLib = async (url, body, e) => { const b = e.currentTarget; b.textContent = '…'; b.disabled = true; try { const x = await post(url, body); if (x && x.path) lib = { path: x.path, chosen: true } } catch (err) { } draw() };
    const saveBox = h('div', { className: 'wfd-save' }, h('h4', { textContent: 'Music folder' }),
      h('div', { className: 'wfd-a', style: 'margin:0 0 6px' }, ...vols.map(v => h('button', { className: here && here.name === v.name ? 'go' : '', textContent: (here && here.name === v.name ? '✓ ' : '') + 'USB · ' + v.name, onclick: e => setLib('/dev/library', { path: v.path, sub: 'Waxfinder' }, e) })),
        h('button', { textContent: lib && lib.chosen ? 'Change folder…' : 'Choose a folder…', title: 'Pick the folder your music lives in', onclick: e => setLib('/dev/pick', { as_library: true, prompt: 'Choose a folder to save songs in' }, e) })),
      h('p', { className: 'wfd-s wfd-path', textContent: lib && lib.path ? lib.path : 'Not set yet' }),
      lib && lib.offline ? h('p', { className: 'wfd-s wfd-warn', style: 'margin:4px 0 0', textContent: 'Not connected. Plug the drive in, or choose the folder again if it moved.' }) : '');
    pop.replaceChildren(saveBox, h('div', { className: 'wfd-hd', style: 'margin-top:14px' }, h('span', { textContent: '▼ Devices' }), rf),
      ...(vols.length ? volRows : [h('p', { className: 'wfd-s', style: 'margin:6px 8px', textContent: 'No USB connected' })]),
      h('div', { className: 'wfd-a', style: 'margin:10px 0 0' }, h('button', { textContent: 'Browse a folder…', title: 'Look inside any folder. This does not change your music folder.', onclick: async e => { e.target.textContent = 'Choose…'; const x = await post('/dev/pick', { prompt: 'Choose a folder' }); if (x.path) browse(x.path.split('/').filter(Boolean).pop() || 'Folder', x.path, x.path); else draw() } })));
  }
  async function browse(name, p, root) {
    cur = name; path = p; const v = root ? { path: root, name } : (vols.find(x => x.name === name) || places.find(x => x.name === name)); sel = new Set();
    let r; try { r = await fetch('/dev/ls?path=' + encodeURIComponent(p)).then(r => r.json()) } catch (e) { r = { error: 'could not read' } }
    const parts = p.slice(v.path.length).split('/').filter(Boolean); let acc = v.path;
    const crumb = h('div', { className: 'wfd-crumb' }, h('button', { textContent: '← Devices', onclick: () => { path = null; draw() } }), h('span', { textContent: '·' }), h('button', { textContent: name, onclick: () => browse(name, v.path, root) }),
      ...parts.map(x => { acc += '/' + x; const a = acc; return [h('span', { textContent: '/' }), h('button', { textContent: x, onclick: () => browse(name, a, root) })] }).flat());
    const rows = r.error ? [h('li', { textContent: r.error })] : [
      ...r.dirs.map(d => h('li', { className: 'd', onclick: () => browse(name, p + '/' + d.name, root) }, h('span', { textContent: '▸ ' + d.name }), h('small', { textContent: d.tag || '' }))),
      ...r.files.map(f => { const k = h('input', { type: 'checkbox', onchange: () => { k.checked ? sel.add(p + '/' + f.name) : sel.delete(p + '/' + f.name); upd() } }); return h('li', { className: 'f', onclick: e => { if (e.target !== k) { k.checked = !k.checked; k.onchange() } } }, k, h('span', { textContent: f.name }), h('small', { textContent: gb(f.size) })) })];
    if (!r.error && !rows.length) rows.push(h('li', { textContent: 'Empty folder' }));
    const files = r.files || [], add = h('button', { className: 'go', textContent: 'Add to library', disabled: true }), all = h('button', { textContent: files.length ? 'Select all ' + files.length : 'No songs here', disabled: !files.length }), msg = h('div', { className: 'wfd-s' });
    const upd = () => { add.disabled = !sel.size; add.textContent = sel.size ? 'Add ' + sel.size + ' to library' : 'Add to library' };
    all.onclick = () => { const on = sel.size < files.length; sel = new Set(on ? files.map(f => p + '/' + f.name) : []); pop.querySelectorAll('.wfd-l input').forEach(k => k.checked = on); upd() };
    add.onclick = async () => { const list = [...sel]; let ok = 0, dup = 0, bad = 0; add.disabled = all.disabled = true;
      for (let i = 0; i < list.length; i++) { msg.textContent = 'Adding ' + (i + 1) + ' of ' + list.length + '…'; try { const s = (await post('/dev/import', { path: list[i] })).status; s === 'exists' || s === 'duplicate' ? dup++ : s === 'error' || s === 'skipped' ? bad++ : ok++ } catch (e) { bad++ } }
      msg.textContent = 'Added ' + ok + (dup ? ' · ' + dup + ' already there' : '') + (bad ? ' · ' + bad + ' failed' : ''); sel = new Set(); pop.querySelectorAll('.wfd-l input').forEach(k => k.checked = false); all.disabled = !files.length; upd();
      try { document.getElementById('page').contentWindow.postMessage({ wfLibraryChanged: 1 }, '*') } catch (e) { } };
    const mk = h('button', { textContent: lib && lib.path === p ? 'Saving here' : 'Save songs here', disabled: !!(lib && lib.path === p) });
    mk.onclick = async () => { const x = await post('/dev/library', { path: p }); msg.textContent = x.error || 'Saved. New songs go here.'; if (!x.error) { lib = { path: x.path, chosen: true }; mk.textContent = 'Saving here'; mk.disabled = true } };
    pop.replaceChildren(crumb, h('div', { className: 'wfd-a', style: 'margin:0 0 8px' }, all, add, mk), msg, h('ul', { className: 'wfd-l' }, ...rows), r.more ? h('p', { className: 'wfd-s', textContent: r.more + ' more not shown' }) : h('span'));
  }
  btn.onclick = () => { open = !open; pop.hidden = !open; if (open) { list(); path ? browse(cur, path) : draw() } };
  document.addEventListener('pointerdown', e => { if (open && !box.contains(e.target)) { open = false; pop.hidden = true } });
  addEventListener('blur', () => { if (open) { open = false; pop.hidden = true } });
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && open) { open = false; pop.hidden = true } });
  list(); setInterval(list, 4000);
})();
