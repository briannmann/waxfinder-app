/* Two-month calendar for picking a date range: ported from Ads Studio's datepicker.js (same behaviour: click a start then an end,
   hover previews the range, Monday-first, future days shown but not selectable, DD-MM-YY readout, Apply / Cancel).
   NEVER use toISOString() on a picked date: it converts to UTC and shifts the day. Dates are built in local time and formatted by hand. */
(function () {
  'use strict';
  const DOW = ['M', 'T', 'W', 'T', 'F', 'S', 'S'], MON = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const p2 = n => (n < 10 ? '0' : '') + n;
  const iso = d => d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate());
  const parse = s => { const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s || ''); return m ? new Date(+m[1], +m[2] - 1, +m[3]) : null };
  const same = (a, b) => a && b && a.getTime() === b.getTime();
  const addMonths = (d, n) => new Date(d.getFullYear(), d.getMonth() + n, 1);
  const human = d => p2(d.getDate()) + '-' + p2(d.getMonth() + 1) + '-' + String(d.getFullYear()).slice(2);

  const css = document.createElement('style');
  css.textContent = `
.wdp{position:fixed;z-index:2147481800;background:rgba(20,6,46,.98);border:1px solid rgba(255,255,255,.28);border-radius:18px;padding:14px;width:max-content;max-width:min(96vw,560px);box-sizing:border-box;color:#fff;box-shadow:0 18px 50px rgba(0,0,0,.5);font:600 12px Archivo,system-ui,sans-serif}
.wdp[hidden]{display:none}
.wdp-top{display:flex;align-items:flex-start;gap:6px}.wdp-cals{display:flex;gap:18px;flex:1;min-width:0}
.wdp-nav{flex:none;width:28px;height:28px;display:grid;place-items:center;border:0;border-radius:8px;background:transparent;color:rgba(255,255,255,.75);cursor:pointer;font-size:20px;line-height:1}
.wdp-nav:hover{background:rgba(255,255,255,.12);color:#fff}
.wdp-mon{text-align:center;font-size:13px;font-weight:800;margin-bottom:9px}
.wdp-dow,.wdp-grid{display:grid;grid-template-columns:repeat(7,28px);gap:2px}
.wdp-dow span{text-align:center;font-size:10px;font-weight:800;color:rgba(255,255,255,.5);letter-spacing:.06em;padding-bottom:4px}
.wdp-day,.wdp-pad{height:28px;display:grid;place-items:center;border:0;background:transparent;border-radius:8px;font:700 12px Archivo,system-ui,sans-serif;color:rgba(255,255,255,.85);cursor:pointer;font-variant-numeric:tabular-nums}
.wdp-day:hover:not(.off):not(.a):not(.b){background:rgba(255,255,255,.14);color:#fff}
.wdp-day.in{background:rgba(198,255,61,.2);color:#fff;border-radius:0}
.wdp-day.a,.wdp-day.b{background:#c6ff3d;color:#14062e;font-weight:900}
.wdp-day.a{border-radius:8px 0 0 8px}.wdp-day.b{border-radius:0 8px 8px 0}.wdp-day.a.b{border-radius:8px}
.wdp-day.today{box-shadow:inset 0 0 0 1px rgba(255,255,255,.55)}.wdp-day.a.today,.wdp-day.b.today{box-shadow:none}
.wdp-day.off{opacity:.3;cursor:default}
.wdp-foot{display:flex;align-items:center;gap:8px;margin-top:13px;padding-top:11px;border-top:1px solid rgba(255,255,255,.16)}
.wdp-sel{flex:1;min-width:0;font-size:12px;color:rgba(255,255,255,.75);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.wdp-btn{height:32px;padding:0 14px;border-radius:999px;border:1.5px solid rgba(255,255,255,.35);background:transparent;color:#fff;font:800 11px Archivo,system-ui,sans-serif;letter-spacing:.06em;text-transform:uppercase;cursor:pointer}
.wdp-btn:hover:not(:disabled){border-color:#fff}
.wdp-apply{background:#c6ff3d;border-color:#c6ff3d;color:#14062e}.wdp-btn:disabled{opacity:.4;cursor:default}
@media (max-width:520px){.wdp-cals .wdp-cal+.wdp-cal{display:none}}`;
  document.head.appendChild(css);

  let el = null, st = null;
  function build() {
    el = document.createElement('div'); el.className = 'wdp'; el.hidden = true; el.setAttribute('role', 'dialog'); el.setAttribute('aria-label', 'Pick a date range');
    el.innerHTML = '<div class="wdp-top"><button type="button" class="wdp-nav" data-d="-1" aria-label="Previous month">‹</button><div class="wdp-cals"></div><button type="button" class="wdp-nav" data-d="1" aria-label="Next month">›</button></div>' +
      '<div class="wdp-foot"><span class="wdp-sel"></span><button type="button" class="wdp-btn wdp-cancel">Cancel</button><button type="button" class="wdp-btn wdp-apply">Apply</button></div>';
    document.body.appendChild(el);
    el.addEventListener('click', e => {
      const nav = e.target.closest('.wdp-nav'); if (nav) { st.view = addMonths(st.view, +nav.dataset.d); return render() }
      const cell = e.target.closest('.wdp-day'); if (cell && !cell.classList.contains('off')) return pick(parse(cell.dataset.d));
      if (e.target.closest('.wdp-cancel')) return close(true); if (e.target.closest('.wdp-apply')) return commit()
    });
    el.addEventListener('mouseover', e => { const c = e.target.closest('.wdp-day'); if (!c || !st.start || st.end) return; st.hover = parse(c.dataset.d); paint() });
    document.addEventListener('keydown', e => { if (!el.hidden && e.key === 'Escape') { e.stopPropagation(); close(true) } }, true);
    document.addEventListener('mousedown', e => { if (!el.hidden && !el.contains(e.target) && e.target !== st.anchor) close(true) });
    addEventListener('resize', () => { if (!el.hidden) place() });
  }
  function pick(d) {
    if (!st.start || st.end) { st.start = d; st.end = null } else if (d < st.start) st.start = d; else st.end = d;
    st.hover = null; paint(); foot()
  }
  function grid(first) {
    const y = first.getFullYear(), m = first.getMonth(), lead = (new Date(y, m, 1).getDay() + 6) % 7, days = new Date(y, m + 1, 0).getDate();
    let h = '<div class="wdp-cal"><div class="wdp-mon">' + MON[m] + ' ' + y + '</div><div class="wdp-dow">' + DOW.map(d => '<span>' + d + '</span>').join('') + '</div><div class="wdp-grid">';
    for (let i = 0; i < lead; i++) h += '<span class="wdp-pad"></span>';
    for (let n = 1; n <= days; n++) { const d = new Date(y, m, n), fut = d > st.max; h += '<button type="button" class="wdp-day' + (fut ? ' off' : '') + '"' + (fut ? ' disabled' : '') + ' data-d="' + iso(d) + '">' + n + '</button>' }
    return h + '</div></div>'
  }
  function render() { el.querySelector('.wdp-cals').innerHTML = grid(st.view) + grid(addMonths(st.view, 1)); paint(); foot() }
  function paint() {
    const a = st.start, b = st.end || st.hover; let lo = a, hi = b; if (a && b && b < a) { lo = b; hi = a }
    el.querySelectorAll('.wdp-day').forEach(c => { const d = parse(c.dataset.d); c.classList.toggle('a', same(d, a)); c.classList.toggle('b', same(d, st.end)); c.classList.toggle('in', !!(lo && hi && d > lo && d < hi)); c.classList.toggle('today', same(d, st.today)) })
  }
  function foot() {
    el.querySelector('.wdp-sel').textContent = st.start ? human(st.start) + ' → ' + (st.end ? human(st.end) : '…') : 'Pick a start date';
    el.querySelector('.wdp-apply').disabled = !(st.start && st.end)
  }
  function place() {
    const r = st.anchor.getBoundingClientRect(), w = el.offsetWidth, h = el.offsetHeight, pad = 10;
    let left = Math.min(Math.max(pad, r.left), innerWidth - w - pad), top = r.bottom + 8;
    if (top + h > innerHeight - pad) top = Math.max(pad, r.top - h - 8);
    el.style.left = Math.round(left) + 'px'; el.style.top = Math.round(top) + 'px'
  }
  function close(revert) { el.hidden = true; if (revert && st && st.onCancel) st.onCancel() }
  function commit() { if (!st.start || !st.end) return; let a = st.start, b = st.end; if (b < a) [a, b] = [b, a]; el.hidden = true; st.onApply(iso(a), iso(b)) }

  /* WaxDatePicker.open(anchor, {start:'YYYY-MM-DD', end:'YYYY-MM-DD', onApply(a, b), onCancel()}); WaxDatePicker.human('YYYY-MM-DD') -> 'DD-MM-YY' */
  window.WaxDatePicker = {
    human: s => { const d = parse(s); return d ? human(d) : '' },
    open(anchor, opt) {
      if (!el) build();
      let today = new Date(); today = new Date(today.getFullYear(), today.getMonth(), today.getDate());
      const s = parse(opt.start), e = parse(opt.end);
      st = { anchor, start: s, end: e, hover: null, today, max: today, view: addMonths(e || today, -1), onApply: opt.onApply, onCancel: opt.onCancel || (() => {}) };
      el.hidden = false; render(); place()
    }
  };
})();
