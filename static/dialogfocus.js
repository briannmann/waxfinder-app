/* Modal dialogs on the Crates page (crate panel, side by side, CDJ export, rename, remove): when one opens, focus moves into it and Tab stays
   inside; when it closes, focus goes back to what opened it. Escape handling stays with each dialog. Pure keyboard/focus layer: no visual change. */
(function () {
  if (window.__wfDialogFocus) return; window.__wfDialogFocus = true;
  const SEL = '#open,#cmp,#cdj,section[role=dialog][aria-modal=true]';
  const FOCUSABLE = 'a[href],button:not([disabled]),input:not([disabled]):not([type=hidden]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';
  const shown = d => d.isConnected && !d.hidden && d.getClientRects().length > 0;
  const items = d => [...d.querySelectorAll(FOCUSABLE)].filter(x => x.getClientRects().length > 0 && getComputedStyle(x).visibility !== 'hidden');
  let top = null, opener = null, raf = 0;
  function scan() {
    raf = 0;
    const open = [...document.querySelectorAll(SEL)].filter(shown), now = open[open.length - 1] || null;   // the last one in the page sits on top
    if (now === top) return;
    const was = top; top = now;
    if (now && !was) {   // opened: remember who had focus, then move in
      opener = document.activeElement && document.activeElement !== document.body ? document.activeElement : null;
      if (!now.contains(document.activeElement)) {
        const f = items(now).find(x => x.matches('input:not([type=checkbox]),textarea')) || items(now)[0];
        if (f) f.focus({ preventScroll: true }); else { now.tabIndex = -1; now.focus({ preventScroll: true }) }
      }
    } else if (!now && was) {   // closed: give focus back (only when it would otherwise be lost)
      const o = opener; opener = null;
      if (o && o.isConnected && o.getClientRects().length && (!document.activeElement || document.activeElement === document.body || was.contains(document.activeElement))) o.focus({ preventScroll: true });
    }
  }
  const queue = () => { if (!raf) raf = requestAnimationFrame(scan) };
  new MutationObserver(queue).observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['hidden'] });
  document.addEventListener('keydown', e => {
    if (e.key !== 'Tab' || !top || !shown(top)) return;
    const f = items(top); if (!f.length) { e.preventDefault(); return }
    const a = document.activeElement, first = f[0], last = f[f.length - 1];
    if (!top.contains(a)) { e.preventDefault(); first.focus(); return }
    if (e.shiftKey && a === first) { e.preventDefault(); last.focus() } else if (!e.shiftKey && a === last) { e.preventDefault(); first.focus() }
  }, true);
  queue();
})();
