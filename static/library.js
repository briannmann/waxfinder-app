/* Library on /crates: every track (downloads, Rekordbox-linked, scanned USB files) in one sortable, filterable table,
   under the crates. Drag rows (or a ticked selection) onto the crate dock: up to 4 crates you pin, which pops up while
   you drag or while tracks are ticked (tap a docked crate to add the ticked tracks: works on touch too).
   Loads only when scrolled near (or opened via /crates#library). Talks to crates.html through:
     'wf-crates' (document event, detail = /crates/data)   window.wfReloadCrates()   'wf-lib-play' / 'wf-crate-play' (window). */
(function () {
  const root = document.getElementById('library'); if (!root) return;
  const $ = id => document.getElementById(id);
  const el = (t, p, ...k) => { const e = document.createElement(t); Object.assign(e, p || {}); k.forEach(c => c != null && e.append(c)); return e };
  const post = (u, b) => fetch(u, { method: 'POST', body: JSON.stringify(b) }).then(r => r.json());
  const PAGE = 120;

  const css = `
.lib{margin-top:clamp(40px,7vh,90px)}
.lib .lhead{display:flex;align-items:flex-end;gap:16px;flex-wrap:wrap;margin-bottom:14px}
.lib .lhead h2{margin:0;font:900 clamp(56px,9vw,128px)/.86 var(--font);font-stretch:125%;letter-spacing:-.02em;text-transform:uppercase}
.lib .lcount{font-size:13px;font-weight:800;letter-spacing:.05em;text-transform:uppercase;opacity:.85;margin-bottom:10px}
.lib .lhead .sp{flex:1}
.lib .ltools{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-bottom:12px}
.lib .ltools input,.lib .ltools select{height:40px;border-radius:999px;border:1.5px solid rgba(255,255,255,.55);background:rgba(20,34,110,.28);color:#fff;font:600 14px var(--font);padding:0 14px;min-width:0}
.lib .ltools input::placeholder{color:rgba(255,255,255,.7)}
.lib .ltools input:focus,.lib .ltools select:focus{outline:0;border-color:var(--lime)}
.lib .ltools select option{color:#14062e}
.lib .ltools select{-webkit-appearance:none;appearance:none;padding:0 40px 0 16px;cursor:pointer;
  background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 12 12'%3E%3Cpath d='M2.5 4.5 6 8l3.5-3.5' fill='none' stroke='%23fff' stroke-width='1.8' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E");
  background-repeat:no-repeat;background-position:right 16px center;background-size:12px}
.lib .ltools .lq{flex:1 1 220px}
.lib .ltools .lb{width:78px}
.lib .ltools .dash{opacity:.7}
.lib .ltools .lclr{height:40px;padding:0 16px;border-radius:999px;border:0;background:#fff;color:var(--ink);font:800 12px var(--font);letter-spacing:.05em;text-transform:uppercase}
.lib .ltools .sp{flex:1}
.lib .ltools{scroll-margin-top:84px}
.lib .lfbtn{height:40px;padding:0 16px;border-radius:999px;border:1.5px solid #fff;background:transparent;color:#fff;font:800 12px var(--font);letter-spacing:.05em;text-transform:uppercase;display:inline-flex;align-items:center;gap:8px;cursor:pointer}
.lib a.lfbtn{text-decoration:none}.lib .lhead .lclean{margin-bottom:10px}
.lib .lfbtn:hover,.lib .lfbtn[aria-expanded=true]{background:#fff;color:var(--ink)}
.lib .lfbtn b{min-width:20px;height:20px;padding:0 6px;border-radius:999px;background:var(--lime);color:var(--ink);font-size:11px;display:inline-grid;place-items:center}
.cdj .rnf{display:grid;grid-template-columns:64px minmax(0,1fr);align-items:center;gap:10px 12px}
.cdj .rnf label{font-size:11px;font-weight:800;letter-spacing:.12em;text-transform:uppercase;opacity:.7}
.cdj .rnf input{height:44px;min-width:0;border-radius:12px;border:1.5px solid rgba(255,255,255,.35);background:rgba(255,255,255,.08);color:#fff;padding:0 14px;font:700 15px Archivo,system-ui,sans-serif}
.cdj .rnf input:focus{outline:none;border-color:#c6ff3d}
.cdj .bcl{display:grid;gap:8px;margin:12px 0 8px}
.cdj .bcr{display:grid;grid-template-columns:96px 70px 52px auto;align-items:center;gap:10px;margin-top:8px}
.cdj .bcr.bcf{grid-template-columns:96px 84px auto}
.cdj .bcw{display:grid;grid-template-columns:minmax(0,1fr) 200px;gap:28px;align-items:start}
.cdj .bct{display:grid;justify-items:center;gap:8px;margin-top:12px;padding-left:24px;border-left:1px solid rgba(255,255,255,.14)}
.cdj .bctap{width:150px;height:150px;border-radius:50%;border:2px solid #c6ff3d;background:rgba(198,255,61,.1);color:#c6ff3d;font:800 22px Archivo,system-ui,sans-serif;letter-spacing:.14em;cursor:pointer;touch-action:manipulation;user-select:none;transition:background .08s}
.cdj .bctap:active,.cdj .bctap.hit{background:rgba(198,255,61,.35)}
.cdj .bctv{font:800 28px Archivo,system-ui,sans-serif;font-variant-numeric:tabular-nums}
.cdj .bct .bcb{justify-content:center}
.cdj .bcd{font:700 12px Archivo,system-ui,sans-serif;font-variant-numeric:tabular-nums;opacity:.55}
.cdj .bcd.ok{color:#c6ff3d;opacity:1}
@media(max-width:620px){.cdj .bcw{grid-template-columns:1fr}.cdj .bct{border-left:0;padding-left:0}}
.cdj .bcl .bcr{margin-top:0}
.cdj .bcn{font-size:11px;font-weight:800;letter-spacing:.12em;text-transform:uppercase;opacity:.7}
.cdj .bcv{font:800 18px Archivo,system-ui,sans-serif;font-variant-numeric:tabular-nums}
.cdj .bcb{display:flex;gap:8px}
.cdj .bcm{height:34px;padding:0 14px;min-width:0;justify-self:start}
.cdj .bcr input{height:44px;min-width:0;border-radius:12px;border:1.5px solid rgba(255,255,255,.35);background:rgba(255,255,255,.08);color:#fff;padding:0 14px;font:700 15px Archivo,system-ui,sans-serif}
.cdj .bcr input:focus{outline:none;border-color:#c6ff3d}
.lib .lfpanel{display:flex;flex-wrap:wrap;gap:8px;align-items:center;padding:12px;margin-bottom:12px;border-radius:22px;background:rgba(14,22,70,.32);border:1px solid var(--glass-line)}
.lib .lfpanel[hidden]{display:none}
.lib .lcol{display:inline-flex;align-items:center;gap:8px;height:40px;padding:0 14px;border-radius:999px;border:1.5px solid rgba(255,255,255,.35);font:700 13px var(--font);color:#fff;cursor:pointer}
.lib #lcolpanel .lclr{height:40px;padding:0 16px;border-radius:999px;border:0;background:#fff;color:var(--ink);font:800 12px var(--font);letter-spacing:.05em;text-transform:uppercase;cursor:pointer}
@media (max-width:760px){.lib #lcolbtn,.lib #lcolpanel{display:none}}
.lib .lfpanel input,.lib .lfpanel select{height:40px;border-radius:999px;border:1.5px solid rgba(255,255,255,.55);background:rgba(20,34,110,.28);color:#fff;font:600 14px var(--font);padding:0 14px}
.lib .lfpanel input::placeholder{color:rgba(255,255,255,.7)}
.lib .lfpanel input:focus,.lib .lfpanel select:focus{outline:0;border-color:var(--lime)}
.lib .lfpanel select option{color:#14062e}
.lib .lfpanel select{-webkit-appearance:none;appearance:none;padding:0 40px 0 16px;cursor:pointer;
  background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 12 12'%3E%3Cpath d='M2.5 4.5 6 8l3.5-3.5' fill='none' stroke='%23fff' stroke-width='1.8' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E");
  background-repeat:no-repeat;background-position:right 16px center;background-size:12px}
.lib .lfpanel .lb{width:78px}
.lib .lfpanel .dash{opacity:.7}
.lib .lchips{display:contents}
.lib .lchip{height:32px;padding:0 6px 0 12px;border-radius:999px;border:0;background:rgba(255,255,255,.92);color:var(--ink);font:700 12px var(--font);display:inline-flex;align-items:center;gap:6px;cursor:pointer}
.lib .lchip i{font-style:normal;width:20px;height:20px;border-radius:50%;display:grid;place-items:center;background:rgba(20,6,46,.1);font-size:13px}
.lib .lchip:hover i{background:var(--ink);color:#fff}
.lib .lselbar{display:flex;align-items:center;gap:8px;height:44px;padding:0 6px 0 18px;border-radius:999px;background:rgba(14,22,70,.72);-webkit-backdrop-filter:blur(14px);backdrop-filter:blur(14px);border:1.5px solid rgba(255,255,255,.4);color:#fff;font:800 13px var(--font);white-space:nowrap}
.lib .lselbar[hidden]{display:none}
.lib .lselbar button{height:32px;padding:0 14px;border-radius:999px;border:1.5px solid rgba(255,255,255,.55);background:transparent;color:#fff;font:800 11px var(--font);letter-spacing:.06em;text-transform:uppercase;cursor:pointer;transition:background-color .15s,border-color .15s}
.lib .lselbar button:hover{border-color:#fff;background:rgba(255,255,255,.14)}
.lib .lselbar button.pri{background:var(--lime);border-color:var(--lime);color:var(--ink)}.lib .lselbar button.pri:hover{background:#d6ff6b;border-color:#d6ff6b}
.lib .lselbar .lsb-x{width:32px;padding:0;border-color:transparent;font-size:18px}
.lib .lselbar button.dng{border-color:rgba(255,156,198,.7);color:#ff9cc6}.lib .lselbar button.dng:hover{background:rgba(255,95,168,.22);border-color:#ff9cc6}
.cdj .go.del{background:#ff5fa8;color:#14062e}.cdj .titles{display:grid;gap:2px}.cdj .titles b{font-weight:800;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.cdj .titles span{opacity:.7;font-size:12.5px}
.lib .lws{display:grid;grid-template-columns:220px minmax(0,1fr);height:calc(100dvh - 84px - var(--toolsh,56px) - 18px);min-height:340px;border-radius:24px;overflow:hidden;background:var(--glass);border:1px solid var(--glass-line);-webkit-backdrop-filter:blur(18px) saturate(1.2);backdrop-filter:blur(18px) saturate(1.2);box-shadow:0 24px 60px rgba(0,0,0,.2)}
.lib .lwrap{min-width:0;overflow:auto;overscroll-behavior:contain;scrollbar-gutter:stable}
.lib .lws{position:relative}
.lib .lws::after{content:'';position:absolute;top:0;right:0;width:10px;height:44px;background:rgba(14,22,70,.9);-webkit-backdrop-filter:blur(14px);backdrop-filter:blur(14px);pointer-events:none;z-index:3}   /* the scrollbar gutter takes the header colour, so the header fills the rounded corner */
.lib .lwrap::-webkit-scrollbar,.lib .lrail::-webkit-scrollbar{width:10px;height:10px}.lib .lwrap::-webkit-scrollbar-thumb,.lib .lrail::-webkit-scrollbar-thumb{background:rgba(255,255,255,.35);border-radius:999px;border:2px solid transparent;background-clip:padding-box}
.lib .lwrap,.lib .lrail{scrollbar-width:thin;scrollbar-color:rgba(255,255,255,.4) transparent}
.lib .lrail{overflow:auto;overscroll-behavior:contain;padding:10px 8px 68px;background:rgba(14,22,70,.38);border-right:1px solid rgba(255,255,255,.14)}
.lib .lrail h3{margin:8px 10px 6px;font-size:11px;font-weight:800;letter-spacing:.12em;text-transform:uppercase;opacity:.7}
.lib .lrail hr{border:0;border-top:1px solid rgba(255,255,255,.14);margin:10px 6px}
.lib .lrh{display:flex;align-items:center;justify-content:space-between;gap:8px;margin:8px 6px 6px 0}.lib .lrh h3{margin:0 10px}
.lib .lrx{height:26px;padding:0 12px;border-radius:999px;border:1.5px solid rgba(255,255,255,.4);background:transparent;color:#fff;font:800 11px Archivo,system-ui,sans-serif;letter-spacing:.08em;text-transform:uppercase;cursor:pointer;white-space:nowrap}.lib .lrx:hover{border-color:#fff;background:rgba(255,255,255,.12)}
.lib .lri{display:flex;align-items:center;gap:10px;width:100%;height:38px;padding:0 10px;border:0;border-radius:12px;background:transparent;color:#fff;font:700 14px var(--font);text-align:left;cursor:pointer;transition:background-color .15s,transform .2s cubic-bezier(.2,.9,.25,1.2)}
.lib .lri:hover{background:rgba(255,255,255,.1)}
.lib .lri[aria-current=true]{background:#fff;color:var(--ink)}
.lib .lri .sw{width:12px;height:12px;border-radius:4px;flex:none;background:var(--c,rgba(255,255,255,.45))}
.lib .lri .nm{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.lib .lri .ct{font-size:12px;font-weight:700;opacity:.65;font-variant-numeric:tabular-nums}
.lib .lrail.drag .lri[data-crate]:not([data-crate=""]):not([data-crate=none]){box-shadow:inset 0 0 0 1.5px rgba(255,255,255,.22)}
.lib .lri.over{background:color-mix(in srgb,var(--c,#c6ff3d) 55%,rgba(14,22,70,.6));transform:translateX(6px)}
.lib .lri.hit{animation:lrihit .55s ease}
@keyframes lrihit{35%{transform:translateX(6px) scale(1.04)}}
.lib .lrnew{margin:2px 0 8px;width:100%;height:38px;border-radius:12px;border:1.5px dashed rgba(255,255,255,.45);background:transparent;color:#fff;font:800 12px var(--font);letter-spacing:.05em;text-transform:uppercase;cursor:pointer}
.lib .lrnew:hover,.lib .lrnew.over{border-color:var(--lime);color:var(--lime)}
.lib .lrform{display:flex;gap:6px;margin-top:6px}
.lib .lrform input{flex:1;min-width:0;height:36px;border-radius:999px;border:1.5px solid var(--lime);background:transparent;color:#fff;font:600 13px var(--font);padding:0 12px;outline:0}
.lib .lrform button{height:36px;padding:0 12px;border-radius:999px;border:0;background:var(--lime);color:var(--ink);font:800 11px var(--font);text-transform:uppercase;cursor:pointer}
.lib tbody tr:focus{outline:0}
.lib tbody tr:focus-visible{box-shadow:inset 3px 0 0 var(--lime);background:rgba(255,255,255,.1)}
.lpick{position:fixed;z-index:41;width:260px;max-height:min(380px,60vh);overflow:auto;padding:8px;border-radius:18px;background:rgba(14,22,70,.97);border:1px solid var(--glass-line);box-shadow:0 24px 60px rgba(0,0,0,.45)}
.lpick button{display:flex;align-items:center;gap:10px;width:100%;padding:9px 10px;border:0;border-radius:12px;background:transparent;color:#fff;font:700 14px var(--font);text-align:left;cursor:pointer}
.lpick button:hover{background:rgba(255,255,255,.1)}
.lpick i{width:14px;height:14px;border-radius:4px;flex:none}
.lcrtip{position:fixed;z-index:42;min-width:160px;max-width:260px;max-height:min(320px,50vh);overflow:auto;padding:6px;border-radius:14px;background:rgba(14,22,70,.97);border:1px solid var(--glass-line);box-shadow:0 18px 44px rgba(0,0,0,.45);pointer-events:none;font:700 13px var(--font);color:#fff}
.lcrtip[hidden]{display:none}.lcrtip h4{margin:2px 8px 4px;font-size:10px;font-weight:800;letter-spacing:.09em;text-transform:uppercase;opacity:.65}
.lcrtip div{display:flex;align-items:center;gap:8px;padding:5px 8px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.lcrtip i{width:12px;height:12px;border-radius:3px;flex:none}
.lpick form{display:flex;gap:6px;padding:4px 4px 8px;margin-bottom:4px;border-bottom:1px solid rgba(255,255,255,.14)}
.lpick form input{flex:1;min-width:0;height:36px;border-radius:999px;border:1.5px solid rgba(255,255,255,.45);background:transparent;color:#fff;font:600 13px var(--font);padding:0 12px;outline:0}
.lpick form input:focus{border-color:var(--lime)}
.lpick form button{width:auto;flex:none;height:36px;padding:0 14px;border-radius:999px;background:var(--lime);color:var(--ink);font:800 12px var(--font);text-transform:uppercase}
.lib table{width:100%;min-width:980px;border-collapse:collapse;table-layout:fixed;font-size:14px}
.lib thead th{position:sticky;top:0;z-index:2;background:rgba(14,22,70,.9);-webkit-backdrop-filter:blur(14px);backdrop-filter:blur(14px);text-align:left;font-size:11px;font-weight:800;letter-spacing:.09em;text-transform:uppercase;padding:0 8px;height:44px;color:rgba(255,255,255,.8)}
.lib thead th button{all:unset;cursor:pointer;display:inline-flex;align-items:center;gap:5px}
.lib thead th button:hover{color:#fff}
.lib thead th .ar{width:9px;height:9px;opacity:0;transition:transform .2s}
.lib thead th[aria-sort=ascending] .ar,.lib thead th[aria-sort=descending] .ar{opacity:1}
.lib thead th[aria-sort=descending] .ar{transform:rotate(180deg)}
.lib td{padding:0 8px;height:48px;border-top:1px solid rgba(255,255,255,.1);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.lib tbody tr{transition:background-color .15s}
.lib tbody tr:hover{background:rgba(255,255,255,.07)}
.lib tbody tr.sel{background:rgba(198,255,61,.13)}
.lib tbody tr.on{background:rgba(255,46,136,.16)}
.lib tbody tr.off{opacity:.45}.lib.driveoff tbody tr.off{opacity:.8}
.lib tbody tr[draggable=true]{cursor:grab}
.lib tbody tr.dragging{opacity:.4}
.lib .c-sel{width:40px;padding-left:16px}.lib .c-play{width:46px}.lib .c-title{width:auto}.lib .c-wave{width:124px}
.lib .c-style.est{opacity:.55;font-style:italic}
.lib .c-artist{width:150px}.lib .c-bpm{width:64px;text-align:right}.lib .c-key{width:62px}.lib .c-time{width:60px;text-align:right}
.lib .c-en{width:86px}.lib .c-style{width:120px;color:rgba(255,255,255,.8)}.lib .c-src{width:88px}.lib .c-cr{width:70px}
.lib .c-add{width:66px;text-align:right}
@media (max-width:1600px){.lib:not(.colpref) .c-src,.lib:not(.colpref) .c-add{display:none}}
@media (max-width:1180px){.lib:not(.colpref) .c-style{display:none}}   /* keep Title readable (the Source filter still works) */
@media (min-width:761px) and (max-width:1600px){.lib table{table-layout:auto;min-width:1180px}.lib .c-title{width:100%;max-width:0;min-width:240px}.lib .c-artist{max-width:190px}.lib .c-style{max-width:170px}}.lib .c-acts{width:52px;padding-right:14px}
@media (min-width:761px) and (max-width:1500px){.lib table{min-width:1040px}.lib .c-title{min-width:190px}.lib .c-artist{max-width:150px}.lib .c-style{max-width:120px}.lib .c-wave{width:104px}}   /* a 1440-wide laptop shows every column without scrolling sideways */
.lib .c-title b{font-weight:700}
.lib .c-title .ct{display:flex;align-items:center;gap:12px;min-width:0}.lib .c-title .cx{flex:1;min-width:0}
.lib .c-title .cx b{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.lib .c-title .cov{flex:none;display:block;width:36px;height:36px;border-radius:8px;object-fit:cover;background:rgba(255,255,255,.1)}
@media (max-width:760px){.lib .c-title .cov{width:32px;height:32px;border-radius:7px}.lib .c-title .ct{gap:9px}}
.lib .c-title .cov.none{background:radial-gradient(circle,rgba(255,255,255,.35) 0 9%,transparent 10%),repeating-radial-gradient(circle,rgba(255,255,255,.1) 0 2px,transparent 2px 5px),rgba(255,255,255,.07)}
.lib .c-title small{display:none;font-size:12px;font-weight:600;opacity:.75;margin-top:1px}
.lib .ck{width:18px;height:18px;accent-color:var(--lime);cursor:pointer;vertical-align:middle}
.lib .lp{width:32px;height:32px;border-radius:50%;border:2px solid #fff;background:transparent;color:#fff;display:grid;place-items:center;padding:0}
.lib .lp svg{width:12px;height:12px}
.lib .lp[data-s=play]{background:var(--magenta);border-color:var(--magenta)}
.lib .lp:disabled{opacity:.35;cursor:default}
.lib .kc{display:inline-block;min-width:38px;text-align:center;padding:3px 8px;border-radius:999px;font-size:12px;font-weight:800;background:hsl(calc(var(--h,0)*1deg) 70% 42% / .55);box-shadow:inset 0 0 0 1px hsl(calc(var(--h,0)*1deg) 80% 75% / .6)}
.lib .kc.unsure{opacity:.7}
.lib .en{display:inline-flex;align-items:center;gap:8px;font-weight:700;font-variant-numeric:tabular-nums}
.lib .en i{display:block;width:46px;height:6px;border-radius:999px;background:rgba(255,255,255,.18);overflow:hidden}
.lib .en b{display:block;height:100%;border-radius:999px;background:linear-gradient(90deg,var(--amber),var(--magenta))}
.lib .sb{font-size:11px;font-weight:800;padding:3px 9px;border-radius:999px;background:rgba(10,20,70,.32);letter-spacing:.02em}
.lib .sb.usb{box-shadow:inset 0 0 0 1.5px rgba(255,255,255,.55);background:transparent}
.lib .sb.download{background:var(--lime);color:var(--ink)}
.lib .dots{display:inline-flex;gap:4px;vertical-align:middle;padding:6px 0;cursor:default}.lib .dots i{width:10px;height:10px;border-radius:3px;box-shadow:inset 0 0 0 1px rgba(0,0,0,.2)}
.lib .simb{width:30px;height:30px;border-radius:50%;border:1.5px solid rgba(255,255,255,.6);background:transparent;color:#fff;display:grid;place-items:center;padding:0}
.lib .simb svg{width:15px;height:15px}.lib .simb:hover{background:#fff;color:var(--ink)}
.lib .na{font-size:11px;font-weight:700;opacity:.7}
.lib .lempty td{text-align:center;height:90px;opacity:.85;white-space:normal}
.lib .lempty-add{display:inline-block;margin-left:14px;height:36px;padding:0 18px;border:0;border-radius:999px;background:var(--lime);color:var(--ink);font:800 12px var(--font);letter-spacing:.05em;text-transform:uppercase;cursor:pointer;vertical-align:middle}
.lib .lempty-add:focus-visible{outline:3px solid #fff;outline-offset:3px}
.lib .lsk td i{display:block;height:12px;width:60%;border-radius:999px;background:rgba(255,255,255,.22)}
.lib .lmore td{height:56px;text-align:center;font-size:12px;font-weight:800;letter-spacing:.06em;text-transform:uppercase;opacity:.7}
.lib .wv{height:28px;min-width:104px}
.ldrag{position:fixed;top:-200px;left:0;padding:8px 16px;border-radius:999px;background:var(--lime);color:var(--ink);font:800 13px var(--font);letter-spacing:.04em;text-transform:uppercase;pointer-events:none}
.ltoast{position:fixed;left:50%;bottom:24px;z-index:45;transform:translateX(-50%);display:flex;align-items:center;justify-content:center;gap:14px;width:max-content;max-width:min(92vw,900px);box-sizing:border-box;padding:8px 8px 8px 22px;border-radius:999px;background:rgba(14,22,70,.95);border:1px solid var(--glass-line);box-shadow:0 20px 50px rgba(0,0,0,.4);font-weight:700;font-size:14px}
.ltoast[hidden]{display:none}
.ltoast.noact{padding:12px 24px;text-align:center}   /* no button: even padding so the text sits in the middle of the pill */
.ltoast span{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ltoast button,.ltoast a{flex:none;height:38px;padding:0 18px;border:0;border-radius:999px;background:var(--lime);color:var(--ink);font:800 13px var(--font);letter-spacing:.04em;text-transform:uppercase;display:inline-flex;align-items:center;text-decoration:none}
@media (max-width:760px){
  .lib .lws::after{display:none}
  .lib .lws{height:calc(100dvh - 84px - 18px);min-height:0;grid-template-columns:1fr;grid-template-rows:auto minmax(0,1fr)}   /* phone: crates become a strip above the table */
  .lib .lrail{display:flex;gap:6px;overflow-x:auto;overflow-y:hidden;padding:8px;border-right:0;border-bottom:1px solid rgba(255,255,255,.14)}
  .lib .lrail h3,.lib .lrail hr{display:none}.lib .lri{width:auto;flex:none;height:34px}.lib .lrnew,.lib .lrform{flex:none;width:auto;margin:0;padding:0 12px}
  .lib table{min-width:0;table-layout:auto}   /* fixed layout still reserves the hidden columns' widths */
  .lib .c-wave,.lib .c-style,.lib .c-src,.lib .c-add,.lib .c-en,.lib .c-cr,.lib .c-time,.lib .c-acts{display:none}
  .lib .c-artist{display:none}.lib .c-bpm{width:64px}.lib .c-key{width:54px}.lib .c-sel{width:34px;padding-left:10px}.lib .c-play{width:42px}
  .lib .c-title{white-space:normal;width:100%;max-width:0;min-width:0}.lib .c-title b,.lib .c-title small{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .lib .c-title small{display:block!important}
  .lib .ltools .lb{width:64px}
}`;
  document.head.append(el('style', { textContent: css }));

  const ICON = { play: '<svg viewBox="0 0 16 16"><path d="M4 2.5v11l9-5.5z" fill="currentColor"/></svg>', stop: '<svg viewBox="0 0 16 16"><rect x="3.5" y="3.5" width="9" height="9" rx="1.5" fill="currentColor"/></svg>',
    sim: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M1.5 8c1.2-3 2.4-3 3.6 0s2.4 3 3.6 0 2.4-3 3.6 0 1.2 1.5 1.8 1.5" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/><circle cx="12.6" cy="3.6" r="1.6" fill="currentColor"/></svg>',
    ar: '<svg class="ar" viewBox="0 0 10 10" aria-hidden="true"><path d="M2 6.5l3-3 3 3" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>' };
  // a little milk crate in the crate's colour (front face: rim, handle slot, grid of holes)
  const crateSvg = c => `<svg class="dk-crate" viewBox="0 0 64 50" aria-hidden="true" style="--c:${c}"><path d="M6 8h52l-3 40H9z" fill="${c}"/><path d="M6 8h52v6H6z" fill="${c}" opacity=".9"/><path d="M6 8h52v6H6z" fill="#fff" opacity=".18"/>` +
    `<rect x="24" y="10" width="16" height="3" rx="1.5" fill="#000" opacity=".35"/>` +
    [0, 1, 2].map(r => [0, 1, 2, 3, 4].map(k => `<rect x="${13 + k * 8}" y="${19 + r * 9}" width="5" height="6" rx="1.2" fill="#000" opacity=".28"/>`).join('')).join('') +
    `<text x="32" y="47" text-anchor="middle" font-family="Archivo,system-ui" font-weight="900" font-size="5" fill="#fff" opacity=".85">wax·finder</text></svg>`;

  const KEYS = [...Array(12)].flatMap((_, i) => [i + 1 + 'A', i + 1 + 'B']);
  const camN = k => k ? parseInt(k) * 2 + (k.slice(-1) === 'B' ? 1 : 0) : null;
  const mixes = k => { const n = parseInt(k), l = k.slice(-1), w = x => ((x - 1 + 12) % 12) + 1; return new Set([k, w(n + 1) + l, w(n - 1) + l, n + (l === 'A' ? 'B' : 'A')]) };
  const mmss = s => { s = Math.round(s || 0); return s ? Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0') : '' };
  const fmtH = s => { s = Math.round(s || 0); const h = Math.floor(s / 3600), m = Math.round(s % 3600 / 60); return h ? h + 'h ' + String(m).padStart(2, '0') + 'm' : m + 'm' };
  const fmtAdded = t => { if (!t) return ''; const d = new Date(t * 1000), y = d.getFullYear() !== new Date().getFullYear(); return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', ...(y ? { year: '2-digit' } : {}) }) };
  const SRC = { download: 'Download', rekordbox: 'Rekordbox', usb: 'USB scan' };

  const COLS = [{ k: 'sel', c: 'c-sel' }, { k: 'play', c: 'c-play' }, { k: 'title', l: 'Title', s: 1, c: 'c-title' }, { k: 'wave', c: 'c-wave' }, { k: 'artist', l: 'Artist', s: 1, c: 'c-artist' },
    { k: 'bpm', l: 'BPM', s: 1, c: 'c-bpm' }, { k: 'key', l: 'Key', s: 1, c: 'c-key' }, { k: 'dur', l: 'Time', s: 1, c: 'c-time' }, { k: 'energy', l: 'Energy', s: 1, c: 'c-en' },
    { k: 'style', l: 'Style', s: 1, c: 'c-style' }, { k: 'crates', l: 'Crates', c: 'c-cr' }, { k: 'added', l: 'Added', s: 1, c: 'c-add' }, { k: 'acts', c: 'c-acts' }];
  const F0 = { q: '', b0: '', b1: '', key: '', en: '', style: '', crate: '', ext: '', added: '', af: '', at: '', st: '', x: '' };   // added: '' | days | 'c' (custom range af..at, YYYY-MM-DD)
  const S = { rows: [], crates: [], memb: new Map(), sort: 'added', dir: -1, f: { ...F0 }, shown: PAGE, sel: new Set(), last: null, loaded: false, view: [], pl: null, corder: true };   // corder: inside a crate, show (and drag-reorder) the crate's own order until a column is clicked
   // pl: a crate on a stick shown in the table (opened from the Files pill)
  try { const v = JSON.parse(localStorage.getItem('wf.libtable') || '{}'); if (v.sort) { S.sort = v.sort; S.dir = v.dir || 1 } if (v.f) Object.assign(S.f, v.f) } catch (e) { }
  const COLPICK = [['wave', 'Waveform', 'c-wave'], ['artist', 'Artist', 'c-artist'], ['bpm', 'BPM', 'c-bpm'], ['key', 'Key', 'c-key'], ['dur', 'Time', 'c-time'], ['energy', 'Energy', 'c-en'], ['style', 'Style', 'c-style'], ['crates', 'Crates', 'c-cr'], ['added', 'Added', 'c-add']];
  let colHide = null;   // null = no choice made yet (screen-width defaults apply); else an array of hidden column keys
  try { const v = JSON.parse(localStorage.getItem('wf.libcols') || 'null'); if (Array.isArray(v)) colHide = v } catch (e) { }
  function applyCols() {
    root.classList.toggle('colpref', colHide !== null);
    let st = document.getElementById('lcolstyle'); if (!st) { st = document.createElement('style'); st.id = 'lcolstyle'; document.head.append(st) }
    st.textContent = (colHide || []).map(k => { const c = COLPICK.find(x => x[0] === k); return c ? '.lib .' + c[2] + '{display:none}' : '' }).join('');
  }
  const save = () => { try { localStorage.setItem('wf.libtable', JSON.stringify({ sort: S.sort, dir: S.dir, f: S.f })) } catch (e) { } };

  /* ---------- markup ---------- */
  const sel = (id, label, opts) => { const s = el('select', { id, className: 'lf' }); s.setAttribute('aria-label', label); s.append(...opts.map(([v, t]) => el('option', { value: v, textContent: t }))); return s };
  root.className = 'lib'; root.setAttribute('aria-label', 'Library');
  root.append(
    el('div', { className: 'lhead' }, el('h2', { textContent: 'Library', id: 'lheadline' }), el('span', { className: 'lcount', id: 'lcount' }), el('span', { className: 'sp' }), el('a', { className: 'lfbtn lclean', href: '/clean', textContent: 'Clean up', title: 'Duplicates, junk names, missing artists' })),
    el('div', { className: 'ltop' },
      el('div', { className: 'ltools' },
        el('input', { type: 'search', id: 'lq', className: 'lq', placeholder: 'Search title, artist, label', autocomplete: 'off' }),
        el('button', { type: 'button', className: 'lfbtn', id: 'lfbtn', innerHTML: 'Filters' }),
        el('button', { type: 'button', className: 'lfbtn', id: 'lcolbtn', textContent: 'Columns' }),
        el('button', { type: 'button', className: 'lfbtn', id: 'lanalyse', textContent: 'Analyse', disabled: true, title: 'Work out BPM, key, energy, waveforms and genres for tracks that need it' }),
        el('div', { className: 'lchips', id: 'lchips' }),
        el('button', { type: 'button', className: 'lclr', id: 'lclr', textContent: 'Clear', hidden: true }),
        el('button', { type: 'button', className: 'lfbtn', id: 'lsmart', textContent: '\u26A1 Save as smart crate', hidden: true, title: 'Keep these filters as a crate that updates by itself' }),
        el('span', { className: 'sp' }),
        el('div', { className: 'lselbar', id: 'lselbar', hidden: true })),
      el('div', { className: 'lfpanel', id: 'lcolpanel', hidden: true }),
      el('div', { className: 'lfpanel', id: 'lfpanel', hidden: true },
        el('input', { type: 'number', id: 'lb0', className: 'lb', placeholder: 'BPM', min: 40, max: 220, step: 1 }), el('span', { className: 'dash', textContent: '–' }),
        el('input', { type: 'number', id: 'lb1', className: 'lb', placeholder: 'BPM', min: 40, max: 220, step: 1 }),
        el('select', { id: 'lkey', className: 'lf' }),
        sel('len', 'Energy', [['', 'Any energy'], ['m', 'Mellow (1–4)'], ['d', 'Medium (5–7)'], ['h', 'High (8–10)']]),
        el('select', { id: 'lstyle', className: 'lf' }),
        sel('lext', 'Format', [['', 'All formats'], ['mp3', 'MP3'], ['wav', 'WAV'], ['flac', 'FLAC'], ['aiff', 'AIFF'], ['m4a', 'M4A']]),
        sel('ladded', 'Added', [['', 'Added any time'], ['7', 'Last 7 days'], ['30', 'Last 30 days'], ['90', 'Last 3 months'], ['365', 'Last year'], ['c', 'Custom'], ['pick', 'Custom range…']]),
        sel('lst', 'Status', [['', 'Any status'], ['ana', 'Analysed'], ['noana', 'Not analysed yet']]),
        sel('lx', 'Filing', [['', 'Any filing'], ['nocrate', 'In no crate'], ['noexp', 'Not on a stick yet'], ['bpm', 'BPM to check']]))),
    el('div', { className: 'lws' }, el('nav', { className: 'lrail', id: 'lrail' }),
      el('div', { className: 'lwrap', id: 'lwrap' }, el('table', {}, el('thead', {}, el('tr', { id: 'lhead' })), el('tbody', { id: 'lbody' })))));
  $('lheadline').setAttribute('data-wave', '#ff2e88');   // hover waveform (static/wave.js), pink like the Crates page
  $('lq').setAttribute('aria-label', 'Search the library'); $('lb0').setAttribute('aria-label', 'BPM from'); $('lb1').setAttribute('aria-label', 'BPM to');
  $('lrail').setAttribute('aria-label', 'Crates'); $('lfbtn').setAttribute('aria-expanded', 'false'); $('lfbtn').setAttribute('aria-controls', 'lfpanel');
  const toastEl = el('div', { className: 'ltoast', hidden: true, role: 'status' }); document.body.append(toastEl);
  $('lbody').append(...[0, 1, 2, 3, 4, 5].map(() => el('tr', { className: 'lsk' }, el('td', { colSpan: COLS.length }, el('i')))));

  /* ---------- one preview player shared with the crate cards (never two at once) ---------- */
  /* previews play in the site-wide player bar (static/player.js). next/prev = neighbouring row in the current sort + filter;
     once you leave this page the bar carries on through a snapshot of that same list. */
  /* album art thumbnail (art/ cache, 300px). No cover: a quiet tile of the same size, so every title lines up. */
  const cover = r => r.art ? el('img', { className: 'cov', src: '/art/' + r.art + '.jpg', alt: '', loading: 'lazy', decoding: 'async', draggable: false }) : el('span', { className: 'cov none', 'aria-hidden': 'true' });
  const metaOf = r => ({ title: r.title, artist: r.artist, from: 'Library', art: r.art ? '/art/' + r.art + '.jpg' : '', wave: '/set/wave?mini=1&id=' + encodeURIComponent(r.id) });
  function libStep(n) {
    if (!cur) return false; const v = (S.view || []).filter(r => r.here), i = v.findIndex(r => r.id === cur.id), r = v[i + n];
    const b = r && $('lbody').querySelector('tr[data-id="' + CSS.escape(r.id) + '"] .lp'); if (!b) return false; b.click(); return true
  }
  const libGo = src => { try { const id = new URL(src, location.href).searchParams.get('id'), b = $('lbody').querySelector('tr[data-id="' + CSS.escape(id) + '"] .lp'); if (!b) return false; b.click(); return true } catch (e) { return false } };   // shuffle asks for a row by its track
  const aud = WaxPlayer.audio({ next: () => libStep(1), prev: () => libStep(-1), go: libGo,
    queue: () => (S.view || []).filter(r => r.here).map(r => ({ src: '/play?id=' + encodeURIComponent(r.id), meta: metaOf(r) })) }); let cur = null;
  function stop() { if (!cur) return; aud.pause(); cur.btn.innerHTML = ICON.play; cur.btn.dataset.s = ''; cur.tr.classList.remove('on'); if (cur.wv) MiniWave.bar(cur.wv).style.transform = 'scaleX(0)'; cur = null }
  function play(r, btn, tr, wv, at) {
    if (cur && cur.id === r.id) { if (at != null && aud.duration) aud.currentTime = at * aud.duration; else if (at == null) { if (aud.paused) aud.play().catch(() => { }); else stop() } return }
    stop(); window.dispatchEvent(new Event('wf-lib-play'));
    aud.meta = metaOf(r); aud.src = '/play?id=' + encodeURIComponent(r.id); cur = { id: r.id, btn, tr, wv, seekTo: at }; aud.play().catch(() => { });
    btn.innerHTML = ICON.stop; btn.dataset.s = 'play'; tr.classList.add('on')
  }
  aud.onloadedmetadata = () => { if (cur && cur.seekTo != null && aud.duration) { aud.currentTime = cur.seekTo * aud.duration; cur.seekTo = null } };
  aud.ontimeupdate = () => { if (cur && cur.wv && aud.duration) MiniWave.bar(cur.wv).style.transform = 'scaleX(' + aud.currentTime / aud.duration + ')' };
  aud.onended = stop; window.addEventListener('wf-crate-play', stop);
  aud.onemptied = () => { if (!cur) return; cur.btn.innerHTML = ICON.play; cur.btn.dataset.s = ''; cur.tr.classList.remove('on'); if (cur.wv) MiniWave.bar(cur.wv).style.transform = 'scaleX(0)'; cur = null };
  aud.onpause = () => { if (cur && !aud.ended) { cur.btn.innerHTML = ICON.play; cur.btn.dataset.s = '' } };
  aud.onplaying = () => { if (cur) { cur.btn.innerHTML = ICON.stop; cur.btn.dataset.s = 'play' } };

  /* ---------- filters + sort ---------- */
  function options() {
    const k = $('lkey'); k.replaceChildren(el('option', { value: '', textContent: 'All keys' }), el('optgroup', { label: 'Key' }, ...KEYS.map(x => el('option', { value: x, textContent: x }))),
      el('optgroup', { label: 'Mixes with' }, ...KEYS.map(x => el('option', { value: '~' + x, textContent: 'Mixes with ' + x })))); k.setAttribute('aria-label', 'Key');
    const n = new Map(); S.rows.forEach(r => sty(r).forEach(x => n.set(x, (n.get(x) || 0) + 1)));
    const st = $('lstyle'); st.replaceChildren(el('option', { value: '', textContent: 'All styles' }), ...[...n.keys()].sort((a, b) => n.get(b) - n.get(a) || a.localeCompare(b)).map(x => el('option', { value: x, textContent: x + ' (' + n.get(x) + ')' }))); st.setAttribute('aria-label', 'Style');
    const map = { lq: 'q', lb0: 'b0', lb1: 'b1', lkey: 'key', len: 'en', lstyle: 'style', lext: 'ext', ladded: 'added', lst: 'st', lx: 'x' };
    const co = [...$('ladded').options].find(o => o.value === 'c'); if (co) { co.textContent = S.f.added === 'c' ? 'Custom: ' + WaxDatePicker.human(S.f.af) + ' → ' + WaxDatePicker.human(S.f.at) : 'Custom'; co.hidden = S.f.added !== 'c' }
    Object.entries(map).forEach(([id, f]) => { $(id).value = S.f[f]; if ($(id).value !== S.f[f]) S.f[f] = '' })
  }
  function sty(r) { return r.styles.length ? r.styles : (r.est_styles || []) }   // real listing styles, else the sound-based estimates (shown muted): both take part in the style filter, search and sort
  function filtered(f = S.f) {   // f: another filter set (a smart crate's) counts without touching the table
    const words = f.q.toLowerCase().split(/\s+/).filter(Boolean), b0 = parseFloat(f.b0), b1 = parseFloat(f.b1);
    const ks = f.key ? (f.key[0] === '~' ? mixes(f.key.slice(1)) : new Set([f.key])) : null, since = f.added && f.added !== 'c' ? Date.now() / 1000 - +f.added * 86400 : 0, cf = f.added === 'c' && f.af ? new Date(f.af + 'T00:00:00').getTime() / 1000 : 0, ct = f.added === 'c' && f.at ? new Date(f.at + 'T00:00:00').getTime() / 1000 + 86400 : 0;
    const inc = f.crate && f.crate !== 'none' ? new Set(((S.crates.find(c => c.id === f.crate) || {}).tracks || []).map(t => t.id)) : null;
    return S.rows.filter(r => {
      if (words.length) { const h = (r.title + ' ' + r.artist + ' ' + r.channel + ' ' + sty(r).join(' ')).toLowerCase(); if (!words.every(w => h.includes(w))) return false }
      if (!isNaN(b0) || !isNaN(b1)) { if (!r.bpm) return false; if (!isNaN(b0) && r.bpm < b0 - .05) return false; if (!isNaN(b1) && r.bpm > b1 + .05) return false }
      if (ks && !(r.key && ks.has(r.key))) return false;
      if (f.en) { if (r.energy == null) return false; const e = Math.round(r.energy); if (f.en === 'm' ? e > 4 : f.en === 'd' ? e < 5 || e > 7 : e < 8) return false }
      if (f.style && !sty(r).includes(f.style)) return false;
      if (f.crate === 'none' ? (S.memb.get(r.id) || []).length : inc && !inc.has(r.id)) return false;
      if (f === S.f && S.pl && !S.pl.ids.has(r.id)) return false;
      if (f.ext && (f.ext === 'aiff' ? !['aif', 'aiff'].includes(r.ext) : r.ext !== f.ext)) return false;
      if (since && !(r.added >= since)) return false;
      if (f.added === 'c' && (!(r.added >= cf) || (ct && !(r.added < ct)))) return false;   // custom range: from the start of the first day to the end of the last
      if (f.st === 'ana' && !r.analysed || f.st === 'noana' && r.analysed) return false;
      if (f.x === 'nocrate' && (S.memb.get(r.id) || []).length) return false;
      if (f.x === 'noexp' && r.exp) return false;
      if (f.x === 'bpm' && !r.bpm_flag) return false;
      return true
    })
  }
  const crateOrder = () => !!(S.corder && S.f.crate && S.f.crate !== 'none' && S.crates.some(c => c.id === S.f.crate));
  function sorted(rows) {
    const cr = S.f.crate && S.f.crate !== 'none' && S.corder ? S.crates.find(c => c.id === S.f.crate) : null;
    if (cr) { const ix = new Map(cr.tracks.map((t, i) => [t.id, i])); return rows.sort((a, b) => (ix.has(a.id) ? ix.get(a.id) : 1e9) - (ix.has(b.id) ? ix.get(b.id) : 1e9)) }
    const k = S.sort, d = S.dir;
    const v = r => k === 'key' ? camN(r.key) : k === 'style' ? (sty(r)[0] || '').toLowerCase() || null : k === 'title' || k === 'artist' || k === 'src' ? (r[k] || '').toLowerCase() || null : r[k];
    return rows.sort((a, b) => { const x = v(a), y = v(b); if (x == null && y == null) return 0; if (x == null) return 1; if (y == null) return -1; return (typeof x === 'string' ? x.localeCompare(y) : x - y) * d })
  }
  function head() {
    $('lhead').replaceChildren(...COLS.map(c => {
      const th = el('th', { className: c.c, scope: 'col' });
      if (c.k === 'sel') { const ck = el('input', { type: 'checkbox', className: 'ck', id: 'lckall' }); const lab = () => { const t = ck.title = 'Tick all ' + (S.view || []).length + ' matching tracks'; ck.setAttribute('aria-label', t) }; lab(); ck.onpointerenter = ck.onfocus = lab; ck.onchange = () => { S.view.forEach(r => ck.checked ? S.sel.add(r.id) : S.sel.delete(r.id)); draw(false); selbar() }; th.append(ck); return th }
      if (!c.s) { if (c.l) { th.textContent = c.l; return th } th.append(el('span', { className: 'vh', textContent: c.k })); th.firstChild.style.cssText = 'position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)'; return th }
      th.setAttribute('aria-sort', S.sort === c.k && !crateOrder() ? (S.dir > 0 ? 'ascending' : 'descending') : 'none');
      const b = el('button', { type: 'button', innerHTML: '<span></span>' + ICON.ar }); b.firstChild.textContent = c.l;
      b.onclick = () => { if (crateOrder()) { S.corder = false; S.sort = c.k; S.dir = ['added', 'energy'].includes(c.k) ? -1 : 1 } else if (S.sort === c.k) S.dir = -S.dir; else { S.sort = c.k; S.dir = ['added', 'energy'].includes(c.k) ? -1 : 1 } save(); head(); draw(true) };
      th.append(b); return th
    }))
  }

  /* ---------- rows ---------- */
  function dots(id) {
    const cr = (S.memb.get(id) || []).map(cid => S.crates.find(c => c.id === cid)).filter(Boolean);
    const s = el('span', { className: 'dots' }, ...cr.slice(0, 6).map(c => { const d = el('i'); d.style.background = c.colour; return d })); return s
  }
  const driveOff = () => !!(window.wfDrive && window.wfDrive.offline);
  document.addEventListener('wf-drive', () => { if (S.loaded) draw() });   /* folder unplugged or back: relabel the rows */
  function row(r) {
    const tr = el('tr', { tabIndex: -1 }); tr.dataset.id = r.id; if (!r.here) tr.classList.add('off'); if (S.sel.has(r.id)) tr.classList.add('sel');
    tr.draggable = r.here;
    tr.addEventListener('contextmenu', e => trackMenu(r, e));
    const ck = el('input', { type: 'checkbox', className: 'ck', checked: S.sel.has(r.id) }); ck.setAttribute('aria-label', 'Tick ' + r.title);
    ck.onclick = e => tick(r.id, ck.checked, e.shiftKey);
    const pb = el('button', { type: 'button', className: 'lp', innerHTML: ICON.play }); pb.setAttribute('aria-label', 'Preview ' + r.title);
    if (!r.here) { pb.disabled = true; pb.title = driveOff() ? 'Music folder not connected' : 'File not found' }
    const wv = r.here && window.MiniWave ? MiniWave.make(r.id, f => play(r, pb, tr, wv, f), { peak: 'rgba(255,255,255,.75)', bass: 'rgba(20,34,110,.95)' }) : null;
    pb.onclick = () => play(r, pb, tr, wv, null);
    if (cur && cur.id === r.id) { cur.btn = pb; cur.tr = tr; cur.wv = wv; pb.innerHTML = ICON.stop; pb.dataset.s = 'play'; tr.classList.add('on') }
    const key = el('td', { className: 'c-key' }); if (r.key) { const kc = el('span', { className: 'kc' + (r.key_sure ? '' : ' unsure'), textContent: (r.key_sure ? '' : '~') + r.key, title: r.key_sure ? 'Key (Rekordbox)' : 'Key is a best guess' }); kc.style.setProperty('--h', (parseInt(r.key) - 1) * 30 + (r.key.slice(-1) === 'B' ? 12 : 0)); key.append(kc) }
    const en = el('td', { className: 'c-en' }); if (r.energy != null) { const i = el('i', {}, el('b')); i.firstChild.style.width = r.energy * 10 + '%'; en.append(el('span', { className: 'en', title: 'Energy ' + r.energy + ' of 10' }, i, String(Math.round(r.energy)))) }
    const acts = el('td', { className: 'c-acts' });
    if (r.sound) { const sb = el('button', { type: 'button', className: 'simb', innerHTML: ICON.sim, title: 'Your next Picks will sound like this song' }); sb.setAttribute('aria-label', 'Find tracks like ' + r.title); sb.onclick = () => similar(r); acts.append(sb) }
    const fmt = (r.ext || '').toUpperCase() + (r.kbps ? ' · ' + r.kbps + ' kbps' : '');
    tr.append(el('td', { className: 'c-sel' }, ck), el('td', { className: 'c-play' }, pb),
      el('td', { className: 'c-title' }, el('div', { className: 'ct' }, cover(r), el('div', { className: 'cx' }, el('b', { textContent: r.title || 'Untitled' }), el('small', { textContent: r.artist || '' })))),   /* artist under the title on phones */
      el('td', { className: 'c-wave' }, wv || (r.here || driveOff() ? '' : el('span', { className: 'na', textContent: 'File not found' }))),
      el('td', { className: 'c-artist', textContent: r.artist || '' }),
      el('td', { className: 'c-bpm', textContent: r.bpm ? ((r.bpm_confidence === 'low' ? '~' : '') + Number(r.bpm).toFixed(1)) : '', title: (r.bpm ? Number(Number(r.bpm).toFixed(2)) + ' BPM. ' : '') + (r.bpm_confidence === 'low' ? 'Tempo needs checking: sections disagree' : r.bpm_confidence === 'unverified' ? 'Saved tempo needs the updated BPM analysis' : 'Measured from the audio') }), key,
      el('td', { className: 'c-time', textContent: mmss(r.dur) }), en,
      r.styles.length || !(r.est_styles || []).length ? el('td', { className: 'c-style', textContent: r.styles.join(', '), title: r.styles.join(', ') }) : el('td', { className: 'c-style est', textContent: '~ ' + r.est_styles.join(', ') }),
      el('td', { className: 'c-cr' }, dots(r.id)), el('td', { className: 'c-add', textContent: fmtAdded(r.added) }), acts);
    /* click anywhere on the row that isn't already a control (play, waveform, tick box, similar-music button, links) ticks it, like the tick box */
    const IGN = 'a,button,input,select,.wv';
    let ign = false; tr.addEventListener('pointerdown', e => { ign = !!e.target.closest(IGN) });   // a scrub that starts on the waveform and ends elsewhere must not tick
    tr.addEventListener('click', e => { if (ign || e.target.closest(IGN) || (getSelection() + '')) return; ck.checked = !ck.checked; tick(r.id, ck.checked, e.shiftKey) });
    tr.ondblclick = e => { if (!e.target.closest('a,button,input,.wv') && r.here) pb.click() };
    tr.addEventListener('dragstart', e => dragStart(e, r, tr));
    tr.addEventListener('dragend', dragEnd);
    return tr
  }
  let io = null;
  function draw(reset) {
    if (!S.loaded) return;
    if (reset) S.shown = PAGE;
    const all = S.rows, rows = sorted(filtered()); S.view = rows;
    const f = S.f, any = Object.keys(F0).some(k => f[k] !== ''), crate = S.crates.find(c => c.id === f.crate);
    $('lclr').hidden = !FKEYS.some(k => f[k] !== '');
    $('lcount').textContent = rows.length.toLocaleString() + (rows.length === 1 ? ' track' : ' tracks') + ' · ' + fmtH(rows.reduce((s, r) => s + (r.dur || 0), 0)) + (driveOff() ? ' · music folder not connected' : '');
    chips(); rail(); smartBtn(); { const L = document.querySelector('.lib'); if (L) L.classList.toggle('driveoff', driveOff()) }
    const body = $('lbody'), page = rows.slice(0, S.shown);
    if (reset) $('lwrap').scrollTop = 0;
    body.replaceChildren(...page.map(row));
    /* the playing song keeps playing when the table changes; its row re-attaches (row()) if it comes back into view */
    if (!rows.length) { const none = !(S.pl && !S.pl.ids.size) && !all.length, td = el('td', { colSpan: COLS.length, textContent: S.pl && !S.pl.ids.size ? 'None of this crate\'s tracks are in your Library yet.' : all.length ? 'No tracks match these filters.' : 'No music yet.' });
      if (none) { const b = el('button', { type: 'button', className: 'lempty-add', textContent: 'Add music' }); b.onclick = () => { const p = document.querySelector('.navplus'); if (p) p.click() }; td.append(b) }
      body.append(el('tr', { className: 'lempty' }, td)) }
    if (rows.length > S.shown) {   // draw the next page when this row scrolls near
      const more = el('tr', { className: 'lmore' }, el('td', { colSpan: COLS.length, textContent: 'Showing ' + S.shown + ' of ' + rows.length.toLocaleString() + ' · more as you scroll' })); body.append(more);
      if (io) io.disconnect(); io = new IntersectionObserver(es => { if (es.some(x => x.isIntersecting)) { io.disconnect(); S.shown += PAGE; drawMore() } }, { rootMargin: '600px' }); io.observe(more)
    }
    const all2 = $('lckall'); if (all2) { const n = rows.filter(r => S.sel.has(r.id)).length; all2.checked = !!rows.length && n === rows.length; all2.indeterminate = n > 0 && n < rows.length }
  }
  function drawMore() {   // append the next page without rebuilding the rows above (keeps waveforms + previews)
    const body = $('lbody'), rows = S.view, start = body.querySelectorAll('tr[data-id]').length;
    body.querySelector('.lmore')?.remove();
    body.append(...rows.slice(start, S.shown).map(row));
    if (rows.length > S.shown) {
      const more = el('tr', { className: 'lmore' }, el('td', { colSpan: COLS.length, textContent: 'Showing ' + S.shown + ' of ' + rows.length.toLocaleString() + ' · more as you scroll' })); body.append(more);
      io = new IntersectionObserver(es => { if (es.some(x => x.isIntersecting)) { io.disconnect(); S.shown += PAGE; drawMore() } }, { rootMargin: '600px' }); io.observe(more)
    }
  }
  function syncSel() {   // ticks + row highlight + header box follow S.sel
    document.querySelectorAll('#lbody tr[data-id]').forEach(tr => { const s = S.sel.has(tr.dataset.id); tr.classList.toggle('sel', s); const c = tr.querySelector('.ck'); if (c) c.checked = s });
    const all2 = $('lckall'), n = S.view.filter(r => S.sel.has(r.id)).length; if (all2) { all2.checked = !!S.view.length && n === S.view.length; all2.indeterminate = n > 0 && n < S.view.length }
  }
  function tick(id, on, range) {
    if (range && S.last) { const ids = S.view.map(r => r.id), a = ids.indexOf(S.last), b = ids.indexOf(id); if (a >= 0 && b >= 0) ids.slice(Math.min(a, b), Math.max(a, b) + 1).forEach(x => on ? S.sel.add(x) : S.sel.delete(x)) }
    else on ? S.sel.add(id) : S.sel.delete(id);
    S.last = id; syncSel(); selbar()
  }

  /* ---------- the crate rail (left of the table): click a crate to browse it, drop tracks on one to add them ---------- */
  let dragIds = null;
  const FKEYS = ['b0', 'b1', 'key', 'en', 'style', 'ext', 'added', 'st', 'x'];   // the folded filters (search + crate live outside the panel)
  /* smart crates: saved filter sets (server: smart_crates.json). One is 'open' while the table's filters match it exactly. */
  const sameF = (a, b) => Object.keys(F0).every(k => (a[k] || '') === (b[k] || ''));
  const activeSmart = () => (S.smart || []).find(sm => sameF(S.f, { ...F0, ...sm.f }));
  async function loadSmart() { try { S.smart = await fetch('/smart/data').then(r => r.json()); if (!Array.isArray(S.smart)) S.smart = [] } catch (e) { S.smart = S.smart || [] } if (S.loaded) { rail(); smartBtn() } }
  function smartBtn() {   // "Save as smart crate" shows while some filter is set that isn't already saved
    const b = $('lsmart'); if (!b) return;
    const f = S.f; b.hidden = !(f.q || FKEYS.some(k => f[k])) || f.crate !== '' || !!activeSmart() || !!S.pl
  }
  function smartSave(btn) {
    const nm = el('input', { placeholder: 'Smart crate name', maxLength: 60, autocomplete: 'off' }), go = el('button', { type: 'submit', className: 'lclr', textContent: 'Save' }), no = el('button', { type: 'button', className: 'lclr', textContent: 'Cancel' });
    const form = el('form', { className: 'lrform' }, nm, go, no); nm.setAttribute('aria-label', 'Smart crate name'); btn.replaceWith(form); nm.focus();
    no.onclick = () => form.replaceWith(btn);
    form.onsubmit = async e => { e.preventDefault(); const f = {}; Object.keys(F0).forEach(k => { if (k !== 'crate' && S.f[k]) f[k] = S.f[k] });
      const r = await post('/smart/save', { name: nm.value, f }); if (r.error) { toast(r.error); nm.focus(); return }
      form.replaceWith(btn); await loadSmart(); toast('Saved smart crate "' + r.name + '"') }
  }
  function rail() {
    const R = $('lrail'), f = S.f.crate, none = S.rows.filter(r => !(S.memb.get(r.id) || []).length).length;
    if (f && f !== 'none' && S.cratesIn && !S.crates.some(c => c.id === f)) { S.f.crate = ''; save() }   // that crate was deleted
    const item = (id, name, count, colour) => {
      const b = el('button', { type: 'button', className: 'lri' }); b.dataset.crate = id; if (colour) b.style.setProperty('--c', colour);
      b.append(el('span', { className: 'sw' }), el('span', { className: 'nm', textContent: name, title: name }), el('span', { className: 'ct', textContent: count.toLocaleString() }));
      b.setAttribute('aria-current', String((S.f.crate || '') === id && !(id === '' && activeSmart())));
      b.onclick = () => { if ((S.f.crate || '') === id && !(id === '' && activeSmart())) return; S.f.crate = id; S.corder = true; save(); head(); draw(true) };
      return b
    };
    const crateItems = S.crates.map(c => { const b = item(c.id, c.name, c.tracks.length, c.colour); dropOn(b, ids => addTo(c, ids, b));
      b.addEventListener('contextmenu', e => { if (window.WaxCrateMenu) { e.preventDefault(); window.WaxCrateMenu(c.id, e, false) } }); return b });
    const nb = el('button', { type: 'button', className: 'lrnew', textContent: '+ New crate', title: 'New crate (drop tracks here to start one with them)' });
    nb.onclick = () => newCrate(nb, [...S.sel]); dropOn(nb, ids => newCrate(nb, ids));
    const keep = R.scrollTop, act = activeSmart();
    const smartItems = (S.smart || []).map(sm => {
      const b = el('button', { type: 'button', className: 'lri', title: 'Smart crate: updates by itself. Right-click to delete' });
      b.append(el('span', { className: 'sw', textContent: '\u26A1', style: 'background:none;width:auto;font-size:13px' }), el('span', { className: 'nm', textContent: sm.name }), el('span', { className: 'ct', textContent: filtered(sm.f ? { ...F0, ...sm.f } : F0).length.toLocaleString() }));
      b.setAttribute('aria-current', String(!!act && act.id === sm.id));
      b.onclick = () => { S.f = { ...F0, ...sm.f }; S.corder = false; save(); options(); head(); draw(true) };
      b.addEventListener('contextmenu', e => { e.preventDefault(); toast('Delete smart crate "' + sm.name + '"?', 'Delete', async () => { await post('/smart/delete', { id: sm.id }); await loadSmart(); toast('Deleted', 'Undo', async () => { await post('/smart/save', { name: sm.name, f: sm.f }); await loadSmart() }) }) });
      return b
    });
    R.replaceChildren(el('h3', { textContent: 'Collection' }), item('', 'All tracks', S.rows.length), item('none', 'In no crate', none), ...(smartItems.length ? [el('hr'), el('h3', { textContent: 'Smart' }), ...smartItems] : []), el('hr'),
      el('div', { className: 'lrh' }, el('h3', { textContent: 'Crates' }), exportBtn()), nb, ...crateItems);
    R.scrollTop = keep; R.classList.toggle('drag', !!dragIds)
  }
  function exportBtn() {   // opens the CDJ export dialog (crates.html) with every crate to tick; the crate you're browsing starts ticked
    const b = el('button', { type: 'button', className: 'lrx', textContent: 'Export…', title: 'Put several crates on a CDJ stick at once' });
    b.onclick = () => { const f = S.f.crate; if (window.WaxCrateExportMany) window.WaxCrateExportMany(f && f !== 'none' ? [f] : []) };
    return b
  }
  function dropOn(b, fn) {
    b.addEventListener('dragover', e => { if (!dragIds) return; e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; b.classList.add('over') });
    b.addEventListener('dragleave', () => b.classList.remove('over'));
    b.addEventListener('drop', e => { e.preventDefault(); b.classList.remove('over'); const ids = dragIds || (e.dataTransfer.getData('text/plain') || '').split(',').filter(Boolean); dragIds = null; if (ids.length) fn(ids) })
  }
  function newCrate(btn, ids) {   // "+ New crate" turns into a name field; ids = tracks to start it with
    const form = el('form', { className: 'lrform' }), nm = el('input', { placeholder: 'Crate name', maxLength: 60, autocomplete: 'off' }), go = el('button', { type: 'submit', textContent: 'Add' });
    nm.setAttribute('aria-label', 'New crate name'); form.append(nm, go); btn.replaceWith(form); nm.focus();
    const back = () => { if (form.isConnected) rail() };
    nm.onkeydown = e => { if (e.key === 'Escape') back() };
    nm.onblur = () => setTimeout(() => { if (!form.contains(document.activeElement) && !nm.value.trim()) back() }, 150);
    form.onsubmit = async e => {
      e.preventDefault(); const name = nm.value.trim(); if (!name) { nm.focus(); return }
      go.disabled = true; let c = null; try { c = await post('/crates/new', { name, ids }) } catch (x) { }
      if (!c || !c.id) { go.disabled = false; toast('Could not create that crate'); return }
      if (ids.length) { S.sel.clear(); S.last = null; syncSel(); selbar() }
      await refreshCrates(); toast('Made ' + c.name + (ids.length ? ' with ' + ids.length + (ids.length === 1 ? ' track' : ' tracks') : ''))
    }
  }
  function selbar() {
    const B = $('lselbar'), n = S.sel.size; B.hidden = !n; if (!n) { closePick(); return }
    const c = S.crates.find(x => x.id === S.f.crate);
    const add = el('button', { type: 'button', className: 'pri', textContent: 'Add to crate' }); add.onclick = () => pickCrate(add);
    const rm = c ? el('button', { type: 'button', textContent: 'Remove from ' + (c.name.length > 18 ? c.name.slice(0, 17) + '…' : c.name), title: 'Take the ticked tracks out of ' + c.name }) : null;
    if (rm) rm.onclick = () => removeFrom(c, [...S.sel]);
    const x = el('button', { type: 'button', className: 'lsb-x', textContent: '×', title: 'Untick all' }); x.setAttribute('aria-label', 'Untick all');
    x.onclick = () => { S.sel.clear(); S.last = null; syncSel(); selbar() };
    const del = el('button', { type: 'button', className: 'dng', textContent: 'Delete', title: 'Remove the ticked tracks from Waxfinder, or off the stick too' }); del.onclick = () => deleteDialog([...S.sel]);
    B.replaceChildren(el('span', { textContent: n + (n === 1 ? ' track' : ' tracks') }), add, rm || '', del, x)
  }
  let pickEl = null;
  function closePick() { if (pickEl) { pickEl.remove(); pickEl = null } }
  function pickCrate(anchor) {
    if (pickEl) { closePick(); return }
    pickEl = el('div', { className: 'lpick', role: 'dialog' }); pickEl.setAttribute('aria-label', 'Add to crate');
    const form = el('form'), nm = el('input', { placeholder: 'New crate', maxLength: 60, autocomplete: 'off' }); nm.setAttribute('aria-label', 'New crate name');
    form.append(nm, el('button', { type: 'submit', textContent: 'Make' }));
    form.onsubmit = async e => {
      e.preventDefault(); const name = nm.value.trim(); if (!name) { nm.focus(); return }
      const ids = [...S.sel]; let c = null; try { c = await post('/crates/new', { name, ids }) } catch (x) { }
      if (!c || !c.id) { toast('Could not create that crate'); return }
      closePick(); S.sel.clear(); S.last = null; syncSel(); selbar(); await refreshCrates(); toast('Made ' + c.name + ' with ' + ids.length + (ids.length === 1 ? ' track' : ' tracks'))
    };
    pickEl.append(form, ...S.crates.map(c => {
      const b = el('button', { type: 'button' }), i = el('i'); i.style.background = c.colour; b.append(i, el('span', { textContent: c.name }));
      b.onclick = () => { closePick(); addTo(c, [...S.sel]) }; return b
    }));
    document.body.append(pickEl);
    const r = anchor.getBoundingClientRect(); pickEl.style.left = Math.max(12, Math.min(innerWidth - 272, r.left)) + 'px';
    const below = innerHeight - r.bottom > 300; pickEl.style[below ? 'top' : 'bottom'] = (below ? r.bottom + 8 : innerHeight - r.top + 8) + 'px';
    setTimeout(() => document.addEventListener('pointerdown', function off(e) { if (pickEl && !pickEl.contains(e.target) && e.target !== anchor) { closePick(); document.removeEventListener('pointerdown', off) } }), 0)
  }
  function dragStart(e, r, tr) {
    if (e.target.closest && e.target.closest('button,a,input,.wv,.cr-h')) { e.preventDefault(); return }
    dragIds = S.sel.has(r.id) ? S.view.filter(x => S.sel.has(x.id) && x.here).map(x => x.id) : [r.id];
    e.dataTransfer.effectAllowed = 'copyMove'; e.dataTransfer.setData('text/plain', dragIds.join(','));
    RO = S.f.crate && S.f.crate !== 'none' ? { crate: S.f.crate, commit: false, start: [...document.querySelectorAll('#lbody tr[data-id]')] } : null;
    const g = el('div', { className: 'ldrag', textContent: dragIds.length === 1 ? (r.title || 'Track').slice(0, 40) : dragIds.length + ' tracks' }); document.body.append(g);
    try { e.dataTransfer.setDragImage(g, 16, 16) } catch (x) { } setTimeout(() => g.remove(), 0);
    document.querySelectorAll('#lbody tr[data-id]').forEach(t => { if (dragIds.includes(t.dataset.id)) t.classList.add('dragging') });
    $('lrail').classList.add('drag')
  }
  /* drag rows inside a crate to reorder it: rows move live, the order is saved on drop (RO = the reorder in progress) */
  let RO = null;
  document.addEventListener('dragover', e => {
    if (!RO || !dragIds || !e.target.closest || !e.target.closest('#lbody')) return;
    e.preventDefault(); e.dataTransfer.dropEffect = 'move';
    const t = e.target.closest('tr[data-id]'); if (!t || dragIds.includes(t.dataset.id)) return;
    const r = t.getBoundingClientRect(), before = e.clientY < r.top + r.height / 2;
    const mv = [...document.querySelectorAll('#lbody tr[data-id]')].filter(x => dragIds.includes(x.dataset.id)); if (!mv.length) return;
    if (before ? mv[mv.length - 1].nextElementSibling !== t : t.nextElementSibling !== mv[0]) { if (before) t.before(...mv); else t.after(...mv) }
  });
  document.addEventListener('drop', e => { if (RO && e.target.closest && e.target.closest('#lbody')) { e.preventDefault(); RO.commit = true } });
  async function saveCrateOrder(ro) {
    const rows = [...document.querySelectorAll('#lbody tr[data-id]')].map(t => t.dataset.id), c = S.crates.find(x => x.id === ro.crate); if (!c) return;
    const was = ro.start.map(t => t.dataset.id); if (rows.join() === was.join()) return;
    const set = new Set(rows), by = new Map(c.tracks.map(t => [t.id, t])), slots = []; c.tracks.forEach((t, i) => { if (set.has(t.id)) slots.push(i) });
    const next = c.tracks.slice(); slots.forEach((at, k) => { next[at] = by.get(rows[k]) }); c.tracks = next;   // the shown rows swap among their own slots; unseen tracks stay put
    S.corder = true; head(); S.view = sorted(filtered()); selbar();
    try { await fetch('/crates/reorder', { method: 'POST', body: JSON.stringify({ crate: ro.crate, ids: rows }) }) } catch (x) { }
  }
  function dragEnd() { const ro = RO; RO = null; if (ro) { if (ro.commit) saveCrateOrder(ro); else if (ro.start.some((t, i) => t !== document.querySelectorAll('#lbody tr[data-id]')[i])) draw(false) }
    dragIds = null; document.querySelectorAll('#lbody tr.dragging').forEach(t => t.classList.remove('dragging')); $('lrail').classList.remove('drag') }
  async function addTo(c, ids) {
    const have = new Set(c.tracks.map(t => t.id)), add = ids.filter(id => !have.has(id));
    dragIds = null;
    if (!add.length) { toast(ids.length === 1 ? 'Already in ' + c.name : 'All already in ' + c.name); return }
    let ok = false; try { ok = (await post('/crates/edit', { crate: c.id, add })).ok } catch (e) { }
    if (!ok) { toast('Could not add to ' + c.name + '. Try again.'); return }
    S.sel.clear(); S.last = null; syncSel(); selbar(); await refreshCrates();
    const t = $('lrail').querySelector('[data-crate="' + CSS.escape(c.id) + '"]'); if (t) { t.classList.remove('hit'); void t.offsetWidth; t.classList.add('hit') }
    toast('Added ' + add.length + (add.length === 1 ? ' track' : ' tracks') + ' to ' + c.name + (add.length < ids.length ? ' (' + (ids.length - add.length) + ' already in it)' : ''), 'Undo',
      async () => { await post('/crates/edit', { crate: c.id, remove: add }); await refreshCrates(); toast('Taken back out of ' + c.name) })
  }
  async function removeFrom(c, ids) {
    let ok = false; try { ok = (await post('/crates/edit', { crate: c.id, remove: ids })).ok } catch (e) { }
    if (!ok) { toast('Could not change ' + c.name + '. Try again.'); return }
    S.sel.clear(); S.last = null; syncSel(); selbar(); await refreshCrates();
    toast('Took ' + ids.length + (ids.length === 1 ? ' track' : ' tracks') + ' out of ' + c.name, 'Undo',
      async () => { await post('/crates/edit', { crate: c.id, add: ids }); await refreshCrates(); toast('Put back in ' + c.name) })
  }
  /* active filters as chips (x clears one); the Filters button shows how many are on */
  function chips() {
    const f = S.f, out = [], lab = id => { const o = $(id).selectedOptions[0]; return o ? o.textContent : '' };
    const chip = (text, keys) => {
      const b = el('button', { type: 'button', className: 'lchip', title: 'Remove this filter' }); b.append(el('span', { textContent: text }), el('i', { textContent: '×' }));
      b.setAttribute('aria-label', 'Remove filter: ' + text); b.onclick = () => { keys.forEach(k => S.f[k] = ''); save(); options(); draw(true) }; out.push(b)
    };
    if (S.pl) { const b = el('button', { type: 'button', className: 'lchip', title: 'Show the whole library again' }); b.append(el('span', { textContent: S.pl.label }), el('i', { textContent: '×' })); b.onclick = () => { S.pl = null; const u = new URLSearchParams(location.search); u.delete('stick'); u.delete('pl'); history.replaceState(null, '', location.pathname + (u.toString() ? '?' + u : '') + location.hash); draw(true) }; out.push(b) }   // dropping the URL params means a reload does not bring the crate filter back
    if (f.b0 || f.b1) chip(f.b0 && f.b1 ? f.b0 + '–' + f.b1 + ' BPM' : f.b0 ? f.b0 + '+ BPM' : 'Up to ' + f.b1 + ' BPM', ['b0', 'b1']);
    [['key', 'lkey'], ['en', 'len'], ['style', 'lstyle'], ['ext', 'lext'], ['added', 'ladded'], ['st', 'lst'], ['x', 'lx']].forEach(([k, id]) => { if (f[k]) chip(lab(id).replace(/ \(\d+\)$/, ''), k === 'added' ? ['added', 'af', 'at'] : [k]) });
    $('lchips').replaceChildren(...out);
    const n = FKEYS.filter(k => f[k] !== '').length - (f.b0 && f.b1 ? 1 : 0);
    $('lfbtn').innerHTML = 'Filters' + (n ? ' <b>' + n + '</b>' : '')
  }
  (() => {
    const p = $('lcolpanel'), b = $('lcolbtn');
    const dflt = () => COLPICK.filter(([, , c]) => { const e = root.querySelector('thead .' + c); return e && getComputedStyle(e).display === 'none' }).map(x => x[0]);   // what the screen width hides today
    const draw = () => p.replaceChildren(...COLPICK.map(([k, l]) => { const ck = el('input', { type: 'checkbox', className: 'ck' }); ck.checked = !(colHide || dflt()).includes(k); ck.onchange = () => { const h = new Set(colHide || dflt()); ck.checked ? h.delete(k) : h.add(k); colHide = [...h]; try { localStorage.setItem('wf.libcols', JSON.stringify(colHide)) } catch (e) { } applyCols() }; return el('label', { className: 'lcol' }, ck, el('span', { textContent: l })) }), el('button', { type: 'button', className: 'lclr', textContent: 'Reset', onclick: () => { colHide = null; try { localStorage.removeItem('wf.libcols') } catch (e) { } applyCols(); draw() } }));
    b.onclick = () => { const open = p.hidden; if (open) draw(); p.hidden = !open; b.setAttribute('aria-expanded', String(open)) };
    b.setAttribute('aria-expanded', 'false'); applyCols();
  })();
  $('lfbtn').onclick = () => { const p = $('lfpanel'), open = p.hidden; p.hidden = !open; $('lfbtn').setAttribute('aria-expanded', String(open)); if (open) $('lb0').focus() };
  /* keyboard: up/down moves between rows, Space or Enter plays the row */
  $('lwrap').addEventListener('keydown', e => {
    const tr = e.target.closest && e.target.closest('tr[data-id]'); if (!tr) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); let n = tr; do n = e.key === 'ArrowDown' ? n.nextElementSibling : n.previousElementSibling; while (n && !n.dataset.id); if (n) { n.focus({ preventScroll: true }); n.scrollIntoView({ block: 'nearest' }) } }
    else if ((e.key === ' ' || e.key === 'Enter') && e.target === tr) { e.preventDefault(); const b = tr.querySelector('.lp'); if (b && !b.disabled) b.click() }
  });
  /* hover the crate dots: drop a list of every crate the track is in (fixed, so the clipped cell and scrolling table can't cut it off) */
  const ctip = el('div', { className: 'lcrtip', hidden: true }); document.body.append(ctip);
  const hideTip = () => { ctip.hidden = true };
  $('lbody').addEventListener('mouseover', e => {
    const d = e.target.closest && e.target.closest('.dots'); if (!d) return;
    const tr = d.closest('tr[data-id]'); const cr = tr ? (S.memb.get(tr.dataset.id) || []).map(cid => S.crates.find(c => c.id === cid)).filter(Boolean) : [];
    if (!cr.length) { hideTip(); return }
    ctip.replaceChildren(el('h4', { textContent: cr.length === 1 ? 'In 1 crate' : 'In ' + cr.length + ' crates' }), ...cr.map(c => { const i = el('i'); i.style.background = c.colour; return el('div', {}, i, el('span', { textContent: c.name })) }));
    ctip.hidden = false;
    const b = d.getBoundingClientRect(), w = ctip.offsetWidth, h = ctip.offsetHeight;
    ctip.style.left = Math.max(8, Math.min(b.left, innerWidth - w - 8)) + 'px';
    ctip.style.top = (b.bottom + 6 + h > innerHeight - 8 ? Math.max(8, b.top - h - 6) : b.bottom + 6) + 'px';
  });
  $('lbody').addEventListener('mouseout', e => { const d = e.target.closest && e.target.closest('.dots'); if (d && !d.contains(e.relatedTarget)) hideTip() });
  $('lwrap').addEventListener('scroll', hideTip, { passive: true });
  document.addEventListener('dragstart', hideTip);
  $('lbody').addEventListener('mousedown', e => { const tr = e.target.closest('tr[data-id]'); if (tr && !e.target.closest('button,a,input,.wv')) tr.focus({ preventScroll: true }) });

  /* ---------- toast, find similar ---------- */
  let tT = 0;
  function toast(msg, act, fn, href) {
    clearTimeout(tT); toastEl.replaceChildren(el('span', { textContent: msg, title: msg })); toastEl.classList.toggle('noact', !act);
    if (act) { const b = href ? el('a', { href, textContent: act }) : el('button', { type: 'button', textContent: act }); if (fn) b.onclick = () => { toastEl.hidden = true; fn() }; toastEl.append(b) }
    toastEl.hidden = false; tT = setTimeout(() => toastEl.hidden = true, act ? 7000 : 3500)
  }
  async function similar(r) {
    let res, j; try { res = await fetch('/discover/like', { method: 'POST', body: JSON.stringify({ id: r.id }) }); j = await res.json() } catch (e) { toast('Could not reach the local server'); return }
    if (!res.ok) { toast(j.error || 'Could not start the search'); return }
    toast('Picks will now sound like ' + (r.title || 'this song'), 'Open Picks', null, '/#picks')
  }

  /* ---------- delete tracks: right-click a row (or tick several first), or the Delete button in the selection bar ---------- */
  let tmenu = null;
  function closeTrackMenu() { if (tmenu) { tmenu.remove(); tmenu = null } }
  function trackMenu(r, e) {
    e.preventDefault(); closeTrackMenu();
    if (!S.sel.has(r.id)) { S.sel.clear(); S.sel.add(r.id); S.last = r.id; syncSel(); selbar() }   // right-click on an unticked row = just that row
    const ids = [...S.sel], n = ids.length;
    const m = tmenu = el('div', { className: 'cmenu glass', role: 'menu' });
    const del = el('button', { type: 'button', role: 'menuitem', className: 'danger', textContent: n === 1 ? 'Delete track…' : 'Delete ' + n + ' tracks…' });
    del.onclick = () => { closeTrackMenu(); deleteDialog(ids) };
    if (n === 1) { const rn = el('button', { type: 'button', role: 'menuitem', textContent: 'Rename…' }); rn.onclick = () => { closeTrackMenu(); renameDialog(r) };
      const bc = el('button', { type: 'button', role: 'menuitem', textContent: 'Check BPM…' }); bc.onclick = () => { closeTrackMenu(); bpmDialog(r) }; m.append(rn, bc, el('hr')) }
    m.append(del); document.body.append(m);
    const w = m.offsetWidth, h = m.offsetHeight;
    m.style.left = Math.max(8, Math.min(e.clientX, innerWidth - w - 8)) + 'px'; m.style.top = Math.max(8, Math.min(e.clientY, innerHeight - h - 8)) + 'px';
    m.querySelector('button').focus({ preventScroll: true });
    const away = ev => { if (ev.type === 'keydown' && ev.key !== 'Escape') return; if (ev.type === 'pointerdown' && m.contains(ev.target)) return; closeTrackMenu(); off() };
    const off = () => { document.removeEventListener('pointerdown', away, true); document.removeEventListener('keydown', away, true); removeEventListener('scroll', away, true); removeEventListener('resize', away) };
    setTimeout(() => { document.addEventListener('pointerdown', away, true); document.addEventListener('keydown', away, true); addEventListener('scroll', away, true); addEventListener('resize', away) })
  }
  /* ---------- rename: right-click a track > Rename. Title and artist, aligned; saved as a name override (+ the file's tags when it can) ---------- */
  function renameDialog(r) {
    const scrim = el('div', { className: 'scrim cdj-scrim' }), dlg = el('section', { className: 'cdj glass', role: 'dialog' }); dlg.setAttribute('aria-label', 'Rename track'); dlg.setAttribute('aria-modal', 'true');
    const esc = e => { if (e.key === 'Escape') { e.stopPropagation(); close() } };
    const close = () => { scrim.remove(); dlg.remove(); document.removeEventListener('keydown', esc, true) };
    document.addEventListener('keydown', esc, true); scrim.onclick = close;
    const ti = el('input', { type: 'text', id: 'lrn-t', value: r.title || '', maxLength: 200, autocomplete: 'off', spellcheck: false });
    const ar = el('input', { type: 'text', id: 'lrn-a', value: r.artist || '', maxLength: 150, autocomplete: 'off', spellcheck: false });
    const go = el('button', { type: 'button', className: 'go', textContent: 'Save' }), cancel = el('button', { type: 'button', className: 'ghost', textContent: 'Cancel' }), out = el('div', { className: 'note' });
    const rst = r.renamed ? el('button', { type: 'button', className: 'linkb', textContent: 'Reset name' }) : null;
    cancel.onclick = close;
    const upd = () => { go.disabled = !ti.value.trim() || (ti.value.trim() === (r.title || '') && ar.value.trim() === (r.artist || '')) };
    const call = async (url, body) => {
      go.disabled = true; out.textContent = 'Saving…';
      try {
        const x = await fetch(url, { method: 'POST', body: JSON.stringify(body) });
        if (x.status === 404) { out.textContent = 'Restart Waxfinder to use Rename.'; return null }
        const j = await x.json(); if (j.error) { out.textContent = j.error; upd(); return null } return j
      } catch (e) { out.textContent = 'Could not save. Is Waxfinder running?'; upd(); return null }
    };
    const done = (j, renamed) => {
      r.title = j.title; r.artist = j.artist; r.renamed = renamed; const t = S.rows.find(x => x.id === r.id); if (t) { t.title = j.title; t.artist = j.artist; t.renamed = renamed }
      draw(true);
      if (j.note) { out.textContent = 'Saved. ' + j.note + '.'; go.remove(); if (rst) rst.remove(); cancel.textContent = 'Close' } else close()
    };
    go.onclick = async () => { const j = await call('/lib/rename', { id: r.id, artist: ar.value, title: ti.value, was: { artist: r.artist, title: r.title } }); if (j) done(j, true) };
    if (rst) rst.onclick = async () => { const j = await call('/lib/rename/reset', { id: r.id }); if (j) done(j, false) };
    for (const i of [ti, ar]) { i.oninput = upd; i.onkeydown = e => { if (e.key === 'Enter' && !go.disabled) go.click() } }
    dlg.append(el('div', { className: 'cdj-h' }, el('h2', { textContent: 'Rename track' })),
      el('div', { className: 'cdj-b' },
        el('div', { className: 'rnf' }, el('label', { textContent: 'Title', htmlFor: 'lrn-t' }), ti, el('label', { textContent: 'Artist', htmlFor: 'lrn-a' }), ar),
        out, el('div', { className: 'acts' }, go, cancel, el('span', { className: 'sp' }), rst || '')));
    document.body.append(scrim, dlg); upd(); ti.focus({ preventScroll: true }); ti.select();
  }
  /* ---------- check BPM: right-click a track > Check BPM. Every reading side by side; pick one, halve/double, or type your own ---------- */
  function bpmDialog(r) {
    const scrim = el('div', { className: 'scrim cdj-scrim' }), dlg = el('section', { className: 'cdj glass', role: 'dialog' }); dlg.setAttribute('aria-label', 'Check BPM'); dlg.setAttribute('aria-modal', 'true');
    const esc = e => { if (e.key === 'Escape') { e.stopPropagation(); close() } };
    const close = () => { scrim.remove(); dlg.remove(); document.removeEventListener('keydown', esc, true); document.removeEventListener('keydown', tapKey, true) };
    document.addEventListener('keydown', esc, true); scrim.onclick = close;
    const fmt = b => (b % 1 ? b.toFixed(2) : String(b));
    const inp = el('input', { type: 'number', id: 'lbc-v', min: 40, max: 220, step: 0.01, value: r.bpm ? fmt(r.bpm) : '', autocomplete: 'off' });
    const go = el('button', { type: 'button', className: 'go', textContent: 'Save' }), cancel = el('button', { type: 'button', className: 'ghost', textContent: 'Close' }), out = el('div', { className: 'note' });
    const rst = el('button', { type: 'button', className: 'linkb', textContent: 'Reset', hidden: !r.bpm_manual });
    const nxt = el('button', { type: 'button', className: 'linkb' });
    const web = el('button', { type: 'button', className: 'linkb', textContent: 'Search BPM online ↗' });
    web.onclick = () => window.open('https://www.google.com/search?q=' + encodeURIComponent(((r.artist || '') + ' ' + (r.title || '') + ' bpm').trim()), '_blank', 'noopener');
    const list = el('div', { className: 'bcl' });
    const pending = () => S.rows.filter(x => x.bpm_flag && !x.bpm_manual);
    const nextRow = () => { const p = pending(); if (!p.length) return null; const i = p.findIndex(x => x.id === r.id); return p[(i + 1) % p.length] };
    const upd = () => { const v = parseFloat(inp.value); go.disabled = !(v >= 40 && v <= 220) || Math.abs(v - (r.bpm || 0)) < 0.005; const p = pending(); nxt.textContent = p.length ? 'Next to check (' + p.length + ') ›' : 'Nothing else to check'; nxt.disabled = !nextRow() || (p.length === 1 && p[0].id === r.id) };
    const call = async (url, body) => {
      go.disabled = true; out.textContent = 'Saving…';
      try {
        const x = await fetch(url, { method: 'POST', body: JSON.stringify(body) });
        if (x.status === 404) { out.textContent = 'Restart Waxfinder to use Check BPM.'; return null }
        const j = await x.json(); if (j.error) { out.textContent = j.error; upd(); return null } return j
      } catch (e) { out.textContent = 'Could not save. Is Waxfinder running?'; upd(); return null }
    };
    const sync = async note => {   // pull the track's real state back after a save/reset
      try { const i = await (await fetch('/lib/bpm/info?id=' + encodeURIComponent(r.id))).json(); for (const t of [r, S.rows.find(x => x.id === r.id)]) if (t) { t.bpm = i.bpm; t.bpm_manual = i.manual; t.bpm_flag = i.manual ? null : i.flag; t.bpm_confidence = i.manual ? 'manual' : t.bpm_confidence } } catch (e) { }
      inp.value = r.bpm ? fmt(r.bpm) : ''; rst.hidden = !r.bpm_manual; out.textContent = note; draw(true); upd()
    };
    cancel.onclick = close;
    go.onclick = async () => { const j = await call('/lib/bpm/override', { id: r.id, bpm: parseFloat(inp.value) }); if (j) sync('Saved: ' + fmt(j.bpm)) };
    rst.onclick = async () => { const j = await call('/lib/bpm/reset', { id: r.id }); if (j) sync('Back to the detected BPM') };
    nxt.onclick = () => { const t = nextRow(); if (t) { close(); bpmDialog(t) } };
    inp.oninput = upd; inp.onkeydown = e => { if (e.key === 'Enter' && !go.disabled) go.click() };
    const half = el('button', { type: 'button', className: 'ghost bcm', textContent: '÷2' }), dbl = el('button', { type: 'button', className: 'ghost bcm', textContent: '×2' });
    half.onclick = () => { inp.value = fmt(+(parseFloat(inp.value) / 2).toFixed(2)); upd() }; dbl.onclick = () => { inp.value = fmt(+(parseFloat(inp.value) * 2).toFixed(2)); upd() };
    /* tap pad: tap along to the track; shows the tempo you tapped and how far each reading is from it */
    let taps = [], tapBpm = null;
    const tapBig = el('button', { type: 'button', className: 'bctap', textContent: 'TAP' }), tapVal = el('div', { className: 'bctv', textContent: '–' }), tapSub = el('div', { className: 'note', textContent: 'Tap along to the beat' });
    const tapUse = el('button', { type: 'button', className: 'ghost bcm', textContent: 'Use', disabled: true }), tapClr = el('button', { type: 'button', className: 'linkb', textContent: 'Clear', hidden: true });
    const tapPlay = el('button', { type: 'button', className: 'ghost bcm', textContent: '▶ Play' });
    function tapMark() { list.querySelectorAll('.bcd').forEach(d => { const b = parseFloat(d.dataset.b); if (!b || tapBpm == null || taps.length < 4) { d.textContent = ''; d.className = 'bcd'; return } const x = b - tapBpm; d.textContent = (x > 0 ? '+' : '') + x.toFixed(1); d.className = 'bcd' + (Math.abs(x) <= 1 ? ' ok' : '') }) }
    function tapIn() {
      const t = performance.now(); if (taps.length && t - taps[taps.length - 1] > 2500) taps = []; taps.push(t); if (taps.length > 16) taps.shift();
      tapBig.classList.remove('hit'); void tapBig.offsetWidth; tapBig.classList.add('hit');
      if (taps.length >= 2) { tapBpm = 60000 * (taps.length - 1) / (t - taps[0]); tapVal.textContent = tapBpm.toFixed(1) } else tapBpm = null;
      tapSub.textContent = taps.length < 4 ? (taps.length + (taps.length === 1 ? ' tap' : ' taps') + ' · keep going') : taps.length + ' taps'; tapUse.disabled = taps.length < 4; tapClr.hidden = false; tapMark()
    }
    const tapReset = () => { taps = []; tapBpm = null; tapVal.textContent = '–'; tapSub.textContent = 'Tap along to the beat'; tapUse.disabled = true; tapClr.hidden = true; tapMark() };
    tapBig.onpointerdown = e => { e.preventDefault(); tapIn() }; tapClr.onclick = tapReset; tapUse.onclick = () => { inp.value = fmt(+tapBpm.toFixed(1)); upd(); inp.focus() };
    tapPlay.onclick = () => { const b = $('lbody').querySelector('tr[data-id="' + CSS.escape(r.id) + '"] .lp'); if (b) b.click() };
    tapPlay.disabled = !r.here;
    const tapKey = e => { if ((e.key === ' ' || e.key.toLowerCase() === 't') && !e.repeat && document.activeElement !== inp) { e.preventDefault(); e.stopPropagation(); tapIn() } };
    document.addEventListener('keydown', tapKey, true);
    const paint = rs => { list.replaceChildren(...rs.map(x => {
      const use = el('button', { type: 'button', className: 'ghost bcm', textContent: 'Use', disabled: !x.bpm }); use.onclick = () => { inp.value = fmt(x.bpm); upd(); inp.focus() };
      return el('div', { className: 'bcr' }, el('span', { className: 'bcn', textContent: x.name }), el('span', { className: 'bcv', textContent: x.bpm ? fmt(x.bpm) : x.wait ? '…' : '–' }), (() => { const d = el('span', { className: 'bcd' }); d.dataset.b = x.bpm || ''; return d })(), use)
    })); tapMark() };
    paint([{ name: 'Waxfinder', bpm: null, wait: 1 }, { name: 'Rekordbox', bpm: null, wait: 1 }, { name: 'Quick check', bpm: null, wait: 1 }, { name: 'Fast check', bpm: null, wait: 1 }]);
    const nm = (r.artist ? r.artist + ' – ' : '') + (r.title || '');
    dlg.append(el('div', { className: 'cdj-h' }, el('h2', { textContent: 'Check BPM' })),
      el('div', { className: 'cdj-b' }, el('div', { className: 'note', textContent: nm, style: 'white-space:normal' }),
        el('div', { className: 'bcw' },
          el('div', { className: 'bcc' }, list, el('div', { className: 'bcr bcf' }, el('label', { className: 'bcn', textContent: 'BPM', htmlFor: 'lbc-v' }), inp, el('span', { className: 'bcb' }, half, dbl))),
          el('div', { className: 'bct' }, tapBig, tapVal, tapSub, el('div', { className: 'bcb' }, tapUse, tapPlay), tapClr)),
        out, el('div', { className: 'acts' }, go, cancel, el('span', { className: 'sp' }), rst, web, nxt)));
    document.body.append(scrim, dlg); upd(); inp.focus({ preventScroll: true }); inp.select();
    fetch('/lib/bpm/info?id=' + encodeURIComponent(r.id) + '&quick=1').then(x => x.ok ? x.json() : null).then(i => { if (i) paint(i.readings) }).catch(() => paint([]));
  }
  function deleteDialog(ids) {
    const m = new Map(S.rows.map(r => [r.id, r])), rows = ids.map(i => m.get(i)).filter(Boolean), n = rows.length; if (!n) return;
    const here = rows.filter(r => r.here).length, away = n - here, noun = k => k + (k === 1 ? ' track' : ' tracks');
    const scrim = el('div', { className: 'scrim cdj-scrim' }), dlg = el('section', { className: 'cdj glass', role: 'dialog' }); dlg.setAttribute('aria-label', 'Delete tracks'); dlg.setAttribute('aria-modal', 'true');
    const esc = e => { if (e.key === 'Escape') { e.stopPropagation(); close() } };
    const close = () => { scrim.remove(); dlg.remove(); document.removeEventListener('keydown', esc, true) };
    document.addEventListener('keydown', esc, true); scrim.onclick = close;
    let mode = 'forget';
    const radio = (val, title, lines, tag) => {
      const r = el('input', { type: 'radio', name: 'lrmmode', checked: val === mode }); r.onchange = () => { mode = val; upd() };
      const body = el('div', { style: 'min-width:0;display:grid;gap:4px' }, el('div', { className: 'nm', textContent: title, style: 'white-space:normal' }), ...lines.map(t => el('div', { className: 'note', textContent: t })));
      if (tag) body.prepend(el('span', { className: 'tagl warn', textContent: tag, style: 'justify-self:start' }));
      return el('label', { className: 'opt', style: 'align-items:flex-start' }, r, body)
    };
    const titles = el('div', { className: 'titles' }, ...rows.slice(0, 4).map(r => el('b', { textContent: (r.artist ? r.artist + ' – ' : '') + (r.title || 'Untitled') })), n > 4 ? el('span', { textContent: 'and ' + (n - 4) + ' more' }) : '');
    const go = el('button', { type: 'button', className: 'go del' }), cancel = el('button', { type: 'button', className: 'ghost', textContent: 'Cancel' }), out = el('div');
    cancel.onclick = close;
    const upd = () => { go.textContent = mode === 'trash' ? 'Delete from the stick' : 'Remove from Waxfinder' };
    dlg.append(el('div', { className: 'cdj-h' }, el('h2', { textContent: n === 1 ? 'Delete this track?' : 'Delete ' + n + ' tracks?' })),
      el('div', { className: 'cdj-b' }, titles,
        radio('forget', 'Remove from Waxfinder only', ['The files stay exactly where they are on the drive. Nothing is erased.',
          'They disappear from your Library, every crate and Picks, and a rescan will not bring them back.']),
        radio('trash', 'Delete from the stick too', ['Also moves the files off the stick into its _Waxfinder Trash folder, so they are gone from Waxfinder, Rekordbox and your CDJs.',
          'They are not erased: Undo (right after, or on the Clean up page) puts them back. The space is only freed when you empty that trash folder.'
          + (away ? ' ' + noun(away) + ' of these ' + (away === 1 ? 'is' : 'are') + ' not on the stick right now, so ' + (away === 1 ? 'it' : 'they') + ' will not be touched.' : '')], 'Takes the files off the stick'),
        el('div', { className: 'acts' }, go, cancel), out));
    document.body.append(scrim, dlg); upd(); go.focus({ preventScroll: true });
    go.onclick = async () => {
      go.disabled = cancel.disabled = true; go.textContent = 'Working…';
      let r; try { r = await post('/lib/remove', { ids, mode }) } catch (x) { r = { error: 'The server did not answer' } }
      if (r.error) { out.replaceChildren(el('div', { className: 'bad', textContent: r.error })); go.disabled = cancel.disabled = false; upd(); return }
      close(); S.sel.clear(); S.last = null; syncSel(); selbar();
      await Promise.all([window.wfLibReload(), refreshCrates()]);
      const left = (r.untouched || []).length, said = mode === 'trash'
        ? 'Moved ' + noun(r.trashed) + ' to the stick\'s trash folder' + (left ? ' · ' + left + ' not touched (' + r.untouched[0].why + ')' : '')
        : 'Removed ' + noun(r.removed) + ' from Waxfinder · files left on the drive';
      toast(said, 'Undo', async () => { await post('/lib/remove/undo', { batch: r.batch, paths: r.paths, memb: r.memb }); await Promise.all([window.wfLibReload(), refreshCrates()]); toast('Put back') })
    }
  }

  /* ---------- data ---------- */
  function membership() { S.memb = new Map(); S.crates.forEach(c => c.tracks.forEach(t => { const a = S.memb.get(t.id) || []; a.push(c.id); S.memb.set(t.id, a) })) }
  async function refreshCrates() { if (window.wfReloadCrates) await window.wfReloadCrates(); else { const d = await fetch('/crates/data').then(r => r.json()); setCrates(d.crates) } }
  function setCrates(list) {
    S.crates = list || []; S.cratesIn = !!list; membership();
    if (S.loaded) { document.querySelectorAll('#lbody tr[data-id]').forEach(tr => { const td = tr.querySelector('.c-cr'); if (td) td.replaceChildren(dots(tr.dataset.id)) }); if (S.f.crate) draw(false); else rail() }
    selbar()
  }
  document.addEventListener('wf-crates', e => setCrates((e.detail || {}).crates));
  async function load() {
    if (S.loading) return; S.loading = true;
    try { S.rows = await fetch('/library/rows').then(r => r.json()) } catch (e) { $('lbody').replaceChildren(el('tr', { className: 'lempty' }, el('td', { colSpan: COLS.length, textContent: 'Could not load your library. Is the server running?' }))); S.loading = false; return }
    if (!S.cratesIn && window.wfCrates && window.wfCrates().crates.length) { S.crates = window.wfCrates().crates; S.cratesIn = true; membership() }
    if (S.f.st === 'here' || S.f.st === 'gone') S.f.st = '';   // those two options were removed; an old saved choice must not keep filtering
    await loadSmart();
    S.loaded = true; options(); head(); draw(true); selbar()
    openStickCrate()
  }
  /* /crates?stick=NAME&pl=CRATE (the Files pill's Open button): show the tracks of that crate on the stick, from this library.
     The match is fetched at once (in parallel with the library), the page stays hidden (html.wf-plw) until the table is filtered and
     snapped into place, then it is revealed: no visible scrolling. */
  const wasReload = (() => { try { return top !== window ? !!top.__wfReload : (performance.getEntriesByType('navigation')[0] || {}).type === 'reload' } catch (e) { return false } })();   // read now, while the shell still says so
  const plQ = new URLSearchParams(location.search), plStick = plQ.get('stick'), plName = plQ.get('pl');
  const plFetch = plStick && plName ? fetch('/dev/playlist-match?stick=' + encodeURIComponent(plStick) + '&name=' + encodeURIComponent(plName), { cache: 'no-store' }).then(r => r.json()).catch(() => ({ error: 'Could not open that crate' })) : null;
  const reveal = () => document.documentElement.classList.remove('wf-plw');
  let stickDone = false;
  async function openStickCrate() {
    if (stickDone || !plFetch) return; stickDone = true;
    const j = await plFetch;
    if (j.error) { reveal(); toast(j.error); return }
    S.pl = { ids: new Set(j.ids), label: plStick + ' › ' + plName + ' · ' + j.matched + (j.matched === j.total ? '' : ' of ' + j.total) + ' tracks' };
    /* a crate opened from the stick shows in full: old saved filters must not hide its tracks. A reload (F5 / hard refresh) is NOT a fresh
       open: keep the filters as the user left them, so a filter they cleared stays cleared and one they kept stays on */
    if (!wasReload) { S.f = { ...F0 }; save(); $('lq').value = '' }
    options();
    draw(true);
    /* the crate cards above keep settling for a moment after load, which moves the Library down: keep snapping (page still hidden) until it
       has held still for 400 ms, then reveal; for 2 s more keep it pinned unless you scroll yourself */
    const snap = () => { const d = root.getBoundingClientRect().top - 70; if (Math.abs(d) > 1) scrollTo({ top: scrollY + d, behavior: 'instant' }); return Math.abs(d) <= 1 };
    let mine = false; for (const ev of ['wheel', 'touchstart', 'keydown', 'pointerdown']) addEventListener(ev, () => { mine = true }, { once: true, passive: true });
    const t0 = performance.now(); let still = 0;
    const pin = () => { if (mine || performance.now() - t0 > 6500) return; snap(); requestAnimationFrame(pin) };
    const tick = () => { const now = performance.now(); if (snap()) still = still || now; else still = 0; if ((still && now - still > 400) || now - t0 > 4000) { reveal(); pin(); return } requestAnimationFrame(tick) };
    tick();
  }
  window.wfLibReload = () => { S.loading = false; return load() };
  document.addEventListener('wf-analysed', () => { if (S.loaded) window.wfLibReload() });
  /* Analyse button (top line, beside Filters): starts the same run as the corner pill, and mirrors its progress */
  const anlBtn = $('lanalyse');
  function anlDraw(d) {
    if (!anlBtn || !d) return;
    anlBtn.disabled = false;   // always clickable: while it runs (or when nothing is left) it just reopens the status panel
    anlBtn.textContent = d.busy ? 'Analysing ' + (d.total ? d.done + ' / ' + d.total : '…') : d.paused ? 'Genres paused' : d.tracks ? 'Analyse ' + d.tracks : 'Analysed ✓';
    anlBtn.title = d.tip || 'Work out BPM, key, energy, waveforms and genres for tracks that need it';
  }
  if (anlBtn) { anlBtn.onclick = () => { const a = window.wfAnalyse; if (!a) return; const d = window.__wfAnlLast || {}; if (!d.busy && d.tracks && !d.paused) a.start(); a.show() }; /* start it (if there is something to do) and open the bottom-right status panel */ document.addEventListener('wf-anl-status', e => anlDraw(e.detail)); anlDraw(window.__wfAnlLast); }
  let tq = 0; const bind = (id, k, now) => $(id).addEventListener(now ? 'change' : 'input', e => { S.f[k] = e.target.value; save(); clearTimeout(tq); if (now) draw(true); else tq = setTimeout(() => draw(true), 140) });
  bind('lq', 'q'); bind('lb0', 'b0'); bind('lb1', 'b1');
  [['lkey', 'key'], ['len', 'en'], ['lstyle', 'style'], ['lext', 'ext'], ['lst', 'st'], ['lx', 'x']].forEach(([id, k]) => bind(id, k, 1));
  /* Added: last 7 / 30 days / 3 months / year, or Custom range: the two-month calendar (same picker as Ads Studio) */
  $('ladded').addEventListener('change', e => {
    const v = e.target.value;
    if (v === 'pick') {
      WaxDatePicker.open($('ladded'), { start: S.f.af, end: S.f.at,
        onApply: (a, b) => { S.f.added = 'c'; S.f.af = a; S.f.at = b; save(); options(); draw(true) },
        onCancel: () => options() });   // cancel: the dropdown goes back to what it was
      return
    }
    S.f.added = v; S.f.af = S.f.at = ''; save(); draw(true)
  });
  $('lsmart').onclick = () => smartSave($('lsmart'));
  $('lclr').onclick = () => { FKEYS.forEach(k => S.f[k] = ''); S.f.af = S.f.at = ''; save(); options(); draw(true); $('lq').focus() };   // search + crate stay
  head();
  const tools = root.querySelector('.ltop'), fitH = () => root.style.setProperty('--toolsh', tools.offsetHeight + 'px');
  fitH(); if (window.ResizeObserver) new ResizeObserver(fitH).observe(tools);
  // soft lock: scrolling DOWN past the filters settles them just under the nav (CSS scroll-snap pulled you back when scrolling up)
  let lastY = scrollY, goingDown = false, settleT = 0;
  addEventListener('scroll', () => {
    goingDown = scrollY > lastY; lastY = scrollY; clearTimeout(settleT);
    if (!goingDown) return;
    settleT = setTimeout(() => { const off = tools.getBoundingClientRect().top - 84; if (Math.abs(off) > 2 && Math.abs(off) < 160) scrollTo({ top: scrollY + off, behavior: 'smooth' }) }, 160)
  }, { passive: true });
  // load only when the Library is near the screen (or the page was opened at #library)
  const near = new IntersectionObserver(es => { if (es.some(x => x.isIntersecting)) { near.disconnect(); load() } }, { rootMargin: '700px' });
  near.observe(root);
  if (location.hash === '#library') { load(); setTimeout(() => tools.scrollIntoView({ block: 'start' }), 700) }
  addEventListener('hashchange', () => { if (location.hash === '#library') { load(); tools.scrollIntoView({ behavior: 'smooth', block: 'start' }) } });   // nav Library while already on /crates
})();
