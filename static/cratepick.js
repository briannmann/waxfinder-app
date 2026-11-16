/* Crate picker: a circled + button that drops down your crates (tick = already in it) and a "New crate" field.
   WaxCrates.button(trackId) -> <button>. Shared by the main page library and anywhere else that lists tracks. */
(function(){
  const css=`
.cpk-btn{flex:none;width:30px;height:30px;padding:0;border-radius:50%;border:2px solid currentColor;background:transparent;color:inherit;display:inline-grid;place-items:center;transition:background-color .2s,color .2s,transform .2s}
.cpk-btn svg{width:14px;height:14px}
.cpk-btn:hover,.cpk-btn[aria-expanded=true]{background:var(--lime,#c6ff3d);border-color:var(--lime,#c6ff3d);color:#14062e}
.cpk-btn.has{background:#fff;border-color:#fff;color:#14062e}
.cpk{position:fixed;z-index:50;min-width:220px;max-width:min(300px,calc(100vw - 32px));max-height:min(420px,calc(100dvh - 32px));box-sizing:border-box;display:flex;flex-direction:column;padding:8px;border-radius:18px;background:rgba(20,6,46,.92);color:#fff;
  border:1px solid rgba(255,255,255,.2);-webkit-backdrop-filter:blur(18px);backdrop-filter:blur(18px);box-shadow:0 24px 60px rgba(0,0,0,.45);font:600 14px/1.3 "Archivo",system-ui,sans-serif}
.cpk button.it{display:flex;align-items:center;gap:10px;width:100%;padding:10px 12px;border:0;border-radius:12px;background:transparent;color:inherit;font:inherit;text-align:left}
.cpk button.it:hover,.cpk button.it:focus-visible{background:rgba(255,255,255,.12);outline:0}
.cpk .sw{flex:none;width:14px;height:14px;border-radius:4px}
.cpk .nm{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.cpk .ck{flex:none;width:16px;color:var(--lime,#c6ff3d)}
.cpk-list{min-height:0;overflow-y:auto;overscroll-behavior:contain;scrollbar-width:thin;scrollbar-color:rgba(255,255,255,.45) transparent}
.cpk form{flex:none;display:flex;gap:6px;padding:6px 4px 2px;border-top:1px solid rgba(255,255,255,.14);margin-top:4px}
.cpk input{flex:1;min-width:0;height:36px;padding:0 12px;border-radius:999px;border:1.5px solid rgba(255,255,255,.35);background:transparent;color:#fff;font:inherit}
.cpk input:focus{border-color:var(--lime,#c6ff3d);outline:0}
.cpk form button{height:36px;padding:0 14px;border-radius:999px;border:0;background:var(--lime,#c6ff3d);color:#14062e;font:800 13px/1 inherit}
.cpk .empty{padding:8px 12px 4px;color:rgba(255,255,255,.6);font-weight:500}`;
  const st=document.createElement('style');st.textContent=css;document.head.append(st);
  const SW={purple:'#7b3fe4',sky:'#8ec5f0',sage:'#79b47e',pink:'#ff5fa8',amber:'#ffb23d',lime:'#c6ff3d'};
  const PLUS='<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 3v10M3 8h10" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/></svg>';
  let data=null,pending=null,open=null;const btns=new Set();
  const post=(u,b)=>fetch(u,{method:'POST',body:JSON.stringify(b)}).then(r=>r.json());
  async function load(force){if(force||!data){pending=pending||fetch('/crates/data').then(r=>r.json()).then(d=>{data=d;pending=null;mark();document.dispatchEvent(new CustomEvent('waxcrates',{detail:d}));return d});await pending}return data}
  const inCrates=id=>(data?data.crates:[]).filter(c=>c.tracks.some(t=>t.id===id));
  function mark(){btns.forEach(b=>{if(!b.isConnected){btns.delete(b);return}const n=inCrates(b.dataset.id);b.classList.toggle('has',n.length>0);
    b.title=n.length?'In '+n.map(c=>c.name).join(', '):'Add to a crate';b.setAttribute('aria-label',b.title)})}
  function close(){if(!open)return;open.pop.remove();open.btn.setAttribute('aria-expanded','false');const b=open.btn;open=null;b.focus({preventScroll:true})}
  function place(pop,btn){const r=btn.getBoundingClientRect(),w=pop.offsetWidth,h=pop.offsetHeight;
    let x=Math.min(Math.max(16,r.right-w),innerWidth-w-16),y=r.bottom+8;if(y+h>innerHeight-16)y=Math.max(16,r.top-h-8);pop.style.left=x+'px';pop.style.top=y+'px'}
  async function show(btn){if(open&&open.btn===btn){close();return}close();await load(true);
    const id=btn.dataset.id,pop=document.createElement('div');pop.className='cpk';pop.setAttribute('role','menu');
    const draw=()=>{const scroll=pop.querySelector('.cpk-list')?.scrollTop||0;pop.replaceChildren();
      const list=document.createElement('div');list.className='cpk-list';list.setAttribute('data-lenis-prevent','');pop.append(list);
      if(!data.crates.length)pop.append(Object.assign(document.createElement('div'),{className:'empty',textContent:'No crates yet'}));
      data.crates.forEach(c=>{const on=c.tracks.some(t=>t.id===id),b=document.createElement('button');b.type='button';b.className='it';b.setAttribute('role','menuitemcheckbox');b.setAttribute('aria-checked',on);
        b.innerHTML='<span class="sw" style="background:'+(SW[c.colour]||c.colour||'#fff')+'"></span><span class="nm"></span><span class="ck">'+(on?'✓':'')+'</span>';b.querySelector('.nm').textContent=c.name;
        b.onclick=async()=>{await post('/crates/edit',on?{crate:c.id,remove:id}:{crate:c.id,add:id});await load(true);draw()};list.append(b)});
      const f=document.createElement('form'),inp=document.createElement('input'),go=document.createElement('button');
      inp.placeholder='New crate';inp.maxLength=60;inp.setAttribute('aria-label','New crate name');go.type='submit';go.textContent='Add';f.append(inp,go);
      f.onsubmit=async e=>{e.preventDefault();const n=inp.value.trim();if(!n)return;await post('/crates/new',{name:n,id});await load(true);draw()};
      pop.append(f);list.scrollTop=scroll;requestAnimationFrame(()=>place(pop,btn))};
    draw();document.body.append(pop);open={pop,btn};btn.setAttribute('aria-expanded','true');place(pop,btn);
    (pop.querySelector('button.it')||pop.querySelector('input')).focus({preventScroll:true})}
  document.addEventListener('pointerdown',e=>{if(open&&!open.pop.contains(e.target)&&!open.btn.contains(e.target))close()},true);
  document.addEventListener('keydown',e=>{if(e.key==='Escape'&&open)close()});
  addEventListener('scroll',e=>{if(open&&!open.pop.contains(e.target))place(open.pop,open.btn)},{passive:true,capture:true});
  addEventListener('resize',()=>open&&place(open.pop,open.btn));
  window.WaxCrates={button(id){const b=document.createElement('button');b.type='button';b.className='cpk-btn';b.dataset.id=id;b.innerHTML=PLUS;
      b.setAttribute('aria-haspopup','menu');b.setAttribute('aria-expanded','false');b.setAttribute('aria-label','Add to a crate');b.onclick=e=>{e.stopPropagation();show(b)};
      btns.add(b);if(data)mark();else load();return b},refresh:()=>load(true),get:()=>load(false),
    keep(b){btns.add(b);if(data)mark()}};   /* re-register a reused button (the library table keeps one per track across redraws) */   /* 'waxcrates' event on document after every load */
})();
