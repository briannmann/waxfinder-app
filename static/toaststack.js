/* Toast stacking. Page toasts (.ctoast on Crates, .ltoast in the Library, .toast on Clean-up) all sit bottom-centre. Without this they
   land on top of each other and on the CDJ export pill (exportpill.js, in the shell), hiding messages and Undo buttons.
   Here every VISIBLE toast gets its own row: the first one shown stays lowest, later ones stack above it. The shell pill publishes
   its height as --wfx-h on this page's root element, so the lowest toast also clears the pill. */
(function () {
  if (window.__wfToastStack) return; window.__wfToastStack = true;
  const SEL = '.ctoast,.ltoast,.toast', GAP = 10, BASE = 24;
  const seq = new Map(); let n = 0, raf = 0;
  const st = document.createElement('style'); st.textContent = SEL.split(',').map(s => s + '{transition:bottom .25s cubic-bezier(.2,.8,.2,1)}').join('');
  document.head.append(st);
  function layout() {
    raf = 0;
    const all = [...document.querySelectorAll(SEL)], vis = all.filter(e => !e.hidden);
    for (const e of all) if (e.hidden) seq.delete(e); else if (!seq.has(e)) seq.set(e, ++n);
    vis.sort((a, b) => seq.get(a) - seq.get(b));
    const pill = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--wfx-h')) || 0;
    let b = pill > 0 ? pill + GAP : BASE;
    for (const e of vis) { e.style.bottom = b + 'px'; b += e.offsetHeight + GAP }
  }
  const soon = () => { if (!raf) raf = requestAnimationFrame(layout) };
  new MutationObserver(soon).observe(document.documentElement, { attributes: true, attributeFilter: ['style'] });   // --wfx-h changed
  const watch = () => new MutationObserver(soon).observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['hidden'] });   // shown/hidden/added
  document.body ? watch() : addEventListener('DOMContentLoaded', watch);
  addEventListener('resize', soon); soon();
})();
