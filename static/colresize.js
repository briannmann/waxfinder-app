/* Drag-to-resize table columns. Widths are remembered per table (localStorage 'wf.cols.<key>').
   Double-click a column's edge to put it back to its default width. Off at phone width (<=640px).
   ColResize.table(tableEl, key)        real <table class="lt">; the c-title column stays flexible and soaks up spare room
   ColResize.grid(headEl, key, base, varName)  CSS-grid list (crate list view); writes the column template into a CSS variable */
(function(){
  const css='.cr-h{position:absolute;top:0;bottom:0;right:0;width:9px;cursor:col-resize;z-index:4;touch-action:none}'+
    '.cr-h::after{content:"";position:absolute;right:3px;top:28%;bottom:28%;width:2px;border-radius:2px;background:currentColor;opacity:0;transition:opacity .15s}'+
    'th:hover>.cr-h::after,.cr-gh>*:hover>.cr-h::after{opacity:.35}.cr-h:hover::after,.cr-h.on::after{opacity:.9}'+
    '.cr-gh>*{position:relative}.cr-gh .cr-h{right:-12px}'+
    'html.cr-drag,html.cr-drag *{cursor:col-resize!important;user-select:none!important}'+
    '@media (max-width:640px){.cr-h{display:none}}';
  document.head.append(Object.assign(document.createElement('style'),{textContent:css}));
  const phone=matchMedia('(max-width:640px)'),MIN=40,refresh=[];
  phone.addEventListener('change',()=>refresh.forEach(f=>f()));
  const load=k=>{try{return JSON.parse(localStorage.getItem('wf.cols.'+k)||'{}')||{}}catch(e){return{}}};
  const save=(k,v)=>{try{localStorage.setItem('wf.cols.'+k,JSON.stringify(v))}catch(e){}};
  /* one drag handle; onMove gets the new width in px, onEnd saves, onReset clears */
  function handle(startW,onMove,onEnd,onReset){
    const h=document.createElement('span');h.className='cr-h';h.setAttribute('aria-hidden','true');h.title='Drag to resize · double-click to reset';
    h.addEventListener('click',e=>{e.preventDefault();e.stopPropagation()});   // never sorts the column
    h.addEventListener('dblclick',e=>{e.preventDefault();e.stopPropagation();onReset()});
    h.addEventListener('pointerdown',e=>{if(e.button!==0)return;e.preventDefault();e.stopPropagation();
      const x0=e.clientX,w0=startW();h.setPointerCapture(e.pointerId);h.classList.add('on');document.documentElement.classList.add('cr-drag');
      const mv=ev=>onMove(Math.max(MIN,Math.round(w0+ev.clientX-x0)));
      const up=()=>{h.removeEventListener('pointermove',mv);h.removeEventListener('pointerup',up);h.removeEventListener('pointercancel',up);
        h.classList.remove('on');document.documentElement.classList.remove('cr-drag');onEnd()};
      h.addEventListener('pointermove',mv);h.addEventListener('pointerup',up);h.addEventListener('pointercancel',up)});
    return h}
  const colOf=th=>[...th.classList].find(c=>c.startsWith('c-'));
  const SKIP=new Set(['c-play','c-acts']);   // icon-only columns keep their size

  function table(tbl,key){
    if(!tbl||tbl._cr)return;tbl._cr=1;
    const row=tbl.tHead&&tbl.tHead.rows[0];if(!row)return;
    let w=load(key);
    const ths=()=>[...row.cells];
    function fit(){   // the table is never narrower than its fixed columns + the title's chosen width, so the panel scrolls sideways instead of squashing
      if(phone.matches||!Object.keys(w).length){tbl.style.minWidth='';return}
      let s=0;ths().forEach(th=>{if(getComputedStyle(th).display==='none')return;const c=colOf(th);s+=c==='c-title'?(w[c]||260):th.offsetWidth});
      tbl.style.minWidth=Math.max(s,0)+'px'}
    function decorate(){
      ths().forEach(th=>{const c=colOf(th);th.querySelectorAll(':scope>.cr-h').forEach(x=>x.remove());
        th.style.width=!phone.matches&&c!=='c-title'&&w[c]?w[c]+'px':'';
        if(!c||SKIP.has(c))return;
        if(getComputedStyle(th).position==='static')th.style.position='relative';
        th.append(handle(()=>th.offsetWidth,
          px=>{w[c]=px;if(c!=='c-title')th.style.width=px+'px';fit()},
          ()=>save(key,w),
          ()=>{delete w[c];th.style.width='';save(key,w);fit()}))});
      fit()}
    new MutationObserver(decorate).observe(row,{childList:true});   // header is rebuilt on every sort
    refresh.push(decorate);decorate()}

  function grid(head,key,base,varName){
    if(!head||head._cr)return;head._cr=1;head.classList.add('cr-gh');
    let w=load(key);
    const apply=()=>{if(phone.matches)document.documentElement.style.removeProperty(varName);
      else document.documentElement.style.setProperty(varName,base.map((b,i)=>w[i+1]?w[i+1]+'px':b).join(' '))};
    const cols=()=>getComputedStyle(head).gridTemplateColumns.split(' ').map(parseFloat);
    function decorate(){
      [...head.children].forEach(it=>{it.querySelectorAll(':scope>.cr-h').forEach(x=>x.remove());
        const cs=getComputedStyle(it),i=parseInt(cs.gridColumnStart),span=cs.gridColumnEnd;
        if(!i||i===1||(span&&span!=='auto'&&parseInt(span)>i+1))return;   // skip the disc column and the spanning actions header
        it.append(handle(()=>cols()[i-1]||it.offsetWidth,px=>{w[i]=px;apply()},()=>save(key,w),()=>{delete w[i];save(key,w);apply()}))})}
    new MutationObserver(decorate).observe(head,{childList:true});
    refresh.push(apply);apply();decorate()}

  window.ColResize={table,grid};
})();
