/* On every page: (1) one plain notice when the music folder (USB or a folder on this computer) is not connected, instead of
   each page explaining it differently (it sits in the top bar, beside the logo); (2) a quiet footer with the tools that are not in the top nav.
   Other scripts read window.wfDrive ({ offline, path }) and listen for the 'wf-drive' event on document. Styles in /static/site.css. */
(function () {
  if (window.wfDrive) return;
  window.wfDrive = { offline: false, path: '', known: false };
  let bar = null;
  function filesPill() { try { return parent !== window ? parent.document.querySelector('.wfd-b') : null } catch (e) { return null } }
  function draw() {
    const d = window.wfDrive;
    if (!d.offline) { if (bar) { bar.remove(); bar = null } return }
    if (!bar) {
      bar = document.createElement('button'); bar.type = 'button'; bar.className = 'wf-drive';
      bar.append(Object.assign(document.createElement('i'), { ariaHidden: 'true' }), Object.assign(document.createElement('b'), { textContent: 'Music folder not connected' }), Object.assign(document.createElement('span'), { textContent: 'Tracks can’t play until it’s back' }));
      bar.onclick = () => { const p = filesPill(); if (p) p.click() };
      bar.setAttribute('aria-label', 'Music folder not connected. Open Files');
      const logo = document.querySelector('.nav .logo'); if (logo) logo.after(bar); else document.body.prepend(bar);   // in the top bar beside the logo: never over the page
    }
    bar.title = d.path || '';
  }
  async function check() {
    try {
      const r = await fetch('/dev/list', { cache: 'no-store' }).then(r => r.json()), lib = r.library || {};
      const next = { offline: !!lib.offline, path: lib.path || '', known: true }, was = window.wfDrive;
      const changed = !was.known || was.offline !== next.offline || was.path !== next.path;
      window.wfDrive = next; draw();
      if (changed) document.dispatchEvent(new CustomEvent('wf-drive', { detail: next }));
    } catch (e) { }
  }
  function foot() {
    if (document.querySelector('.wf-foot')) return;
    const f = document.createElement('footer'); f.className = 'wf-foot';
    for (const [t, u] of [['Clean up', '/clean'], ['Energy', '/energy']]) { const a = Object.assign(document.createElement('a'), { textContent: t, href: u }); if (location.pathname === u) a.setAttribute('aria-current', 'page'); f.append(a) }
    document.body.append(f);
  }
  const start = () => { foot(); check(); setInterval(() => { if (!document.hidden) check() }, 20000) };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
  document.addEventListener('visibilitychange', () => { if (!document.hidden) check() });
})();
