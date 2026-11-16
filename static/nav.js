/* Top nav: the page you're on is green; a white capsule follows your pointer along the links (it slides out from the
   current page's tab and fades away when you move off). On Home the green follows the scroll (Download -> Picks);
   on Crates it switches to Library when the Library comes up. Styles in /static/site.css (.has-ind). */
(function () {
  const pill = document.querySelector('.nav .pill'); if (!pill) return;
  const links = [...pill.querySelectorAll('a')], ind = document.createElement('span');
  ind.className = 'pill-ind'; ind.setAttribute('aria-hidden', 'true'); pill.prepend(ind); pill.classList.add('has-ind');
  // phone strip scrolls sideways: fade the edge that has more links, and bring the current page into view
  const edges = () => { pill.classList.toggle('more-r', pill.scrollLeft + pill.clientWidth < pill.scrollWidth - 2); pill.classList.toggle('more-l', pill.scrollLeft > 2) };
  pill.addEventListener('scroll', edges, { passive: true }); addEventListener('resize', edges);
  const named = n => links.find(a => a.textContent.trim().toLowerCase() === n);
  const P = location.pathname;
  // [link name, section id that turns it on once it reaches 45% down the screen (null = on from the top)]
  const SECTIONS = P === '/' ? [['discover', null], ['picks', 'picks']] : P === '/crates' ? [['crates', null], ['library', 'library']] : P === '/set' ? [['set', null]] : [];
  let cur = null, shown = false;
  const at = a => { const p = pill.getBoundingClientRect(), r = a.getBoundingClientRect(); return { x: r.left - p.left - pill.clientLeft + pill.scrollLeft, w: r.width } };
  // phone strip: centre the current page's link. Runs again whenever the strip changes width (fonts arriving, the
  // "music folder not connected" dot appearing beside the logo), which used to leave the current link off the edge.
  const keep = () => { const on = pill.querySelector('a.on'); if (on && pill.scrollWidth > pill.clientWidth) { const g = at(on); pill.scrollLeft = g.x - (pill.clientWidth - g.w) / 2 } edges() };
  requestAnimationFrame(keep); if (window.ResizeObserver) new ResizeObserver(keep).observe(pill);
  function jump(a) {   // move without animating (while hidden)
    const g = at(a); ind.style.transition = 'none'; ind.style.width = g.w + 'px'; ind.style.transform = 'translateX(' + g.x + 'px)'; void ind.offsetWidth; ind.style.transition = '';
  }
  function show(a) {
    if (!shown) jump(cur || a);                   // appear on the current tab, then slide to the one under the pointer
    shown = true;                                 // (jump() already flushed layout, so the slide starts this frame: no lag)
    const g = at(a); ind.style.width = g.w + 'px'; ind.style.transform = 'translateX(' + g.x + 'px)'; ind.style.opacity = 1;
    links.forEach(x => x.classList.toggle('hot', x === a));
  }
  function hide() { shown = false; ind.style.opacity = 0; links.forEach(x => x.classList.remove('hot')) }
  function active() {
    let name = null;
    for (const [n, id] of SECTIONS) { if (!id) { name = n; continue } const e = document.getElementById(id); if (e && e.getBoundingClientRect().top < innerHeight * .45) name = n }
    const a = name ? named(name) : null;
    if (a === cur) return;
    cur = a;
    links.forEach(x => { x.classList.toggle('on', x === a); if (x === a) x.setAttribute('aria-current', 'page'); else x.removeAttribute('aria-current') });
    if (cur && pill.scrollWidth > pill.clientWidth) cur.scrollIntoView({ block: 'nearest', inline: 'nearest' });   // phone strip: keep it in view
  }
  links.forEach(a => { a.addEventListener('pointerenter', e => { if (e.pointerType !== 'touch') show(a) }); a.addEventListener('focus', () => { if (a.matches(':focus-visible')) show(a) }) });
  pill.addEventListener('pointerleave', hide);
  pill.addEventListener('focusout', e => { if (!pill.contains(e.relatedTarget)) hide() });
  addEventListener('scroll', active, { passive: true });
  addEventListener('resize', hide);
  active();
})();
