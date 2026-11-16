/* Shared lava-lamp blobs (same code as the main page's count labels): goo bodies + buoyant droplets, one scroll-accelerated clock.
   Hosts: .blob and .blobby elements. Add class 'ember' (or 'pink') to a host for that gradient; class 'tint' reads --blob-a/b/c from the host (live). */
(function(){
  const NS='http://www.w3.org/2000/svg',motion=matchMedia('(prefers-reduced-motion: reduce)'),TAU=Math.PI*2;
  /* Order: Download, Picked for you, Library, Liked. Different silhouettes, not just different delays.
     Each droplet has its own period, phase, side, mass, travel, drift and elongation. */
  const profiles=[
    {period:22.7,phase:1.2,round:2.5,folds:2,shape:[.48,.25,-.28],roll:.7,
      drops:[{period:19.3,phase:1.8,x:144,dir:-1,r:15,reach:63,drift:-17,sway:7,stretch:.46},
             {period:29.9,phase:4.1,x:46,dir:1,r:10,reach:48,drift:12,sway:4,stretch:.22}]},
    {period:18.9,phase:3.8,round:2.3,folds:3,shape:[-.35,-.32,.52],roll:1.1,
      drops:[{period:14.7,phase:.6,x:58,dir:-1,r:12,reach:65,drift:19,sway:10,stretch:.65},
             {period:23.1,phase:3.4,x:145,dir:-1,r:9,reach:57,drift:-11,sway:6,stretch:.4}]},
    {period:33.1,phase:5.2,round:2.9,folds:2,shape:[.62,-.4,-.18],roll:.4,
      drops:[{period:32.3,phase:2.7,x:65,dir:1,r:17,reach:58,drift:-13,sway:5,stretch:.2},
             {period:21.7,phase:5.6,x:149,dir:-1,r:11,reach:53,drift:9,sway:4,stretch:.35}]},
    {period:26.3,phase:2.6,round:2.6,folds:3,shape:[-.25,.5,-.6],roll:.85,
      drops:[{period:24.7,phase:4.8,x:130,dir:-1,r:14,reach:64,drift:23,sway:8,stretch:.5},
             {period:17.9,phase:1.3,x:49,dir:1,r:12,reach:59,drift:-15,sway:9,stretch:.38}]}
  ];
  const blobs=[];
  const point=p=>p.map(v=>v.toFixed(2)).join(' ');
  function outline(pts){
    let d='M'+point(pts[0]);
    for(let k=0,n=pts.length;k<n;k++){
      const a=pts[(k+n-1)%n],b=pts[k],c=pts[(k+1)%n],e=pts[(k+2)%n];
      d+='C'+point([b[0]+(c[0]-a[0])/6,b[1]+(c[1]-a[1])/6])+' '
        +point([c[0]-(e[0]-b[0])/6,c[1]-(e[1]-b[1])/6])+' '+point(c);
    }
    return d+'Z';
  }
  function droplet(d,t){
    /* Smooth phase warping gives a long attached dwell, accelerating release and a slower return.
       The extra slow phase drifts independently, so a reunion never repeats the same body pose. */
    const phase=t*TAU/d.period+d.phase+.19*Math.sin(t*TAU/(d.period*2.173)+d.phase);
    const wave=phase+.32*(1-Math.cos(phase)),h=(1-Math.cos(wave))/2;
    const lift=Math.pow(h,1.45),flow=Math.sin(wave)*Math.pow(h,.45);
    const stretch=1+d.stretch*flow*flow,ry=d.r*stretch,rx=d.r/Math.sqrt(stretch);
    const x=d.x+lift*(d.drift+d.sway*Math.sin(wave-.8)+3*Math.sin(t*TAU/(d.period*1.731)+d.phase));
    const y=50+d.dir*(24+d.reach*lift);
    /* The trailing tip holds a neck until the goo separates; it rounds off in free flight.
       Cross-section shrinks as length grows, avoiding an inflating/deflating bead. */
    const neck=Math.exp(-Math.pow((lift-.42)/.23,2)),tail=1+.85*neck;
    return {x,y,lift,neck,tail,rx:rx/Math.sqrt(1+.3*neck),ry,
      tilt:d.dir*(d.drift*.5*flow+6*Math.sin(wave-.5)*lift)};
  }
  function draw(b,t){
    const p=b.profile,drops=p.drops.map(d=>droplet(d,t)),phase=t*TAU/p.period+p.phase;
    const slow=t*TAU/(p.period*1.618)+p.phase*.7,pts=[];
    drops.forEach((d,j)=>{
      d.direction=Math.atan2((d.y-50)/43,(d.x-100)/94);
      d.wake=.025*Math.sin(phase-p.drops[j].phase-.8);
    });
    for(let k=0;k<24;k++){
      const a=k/24*TAU,c=Math.cos(a),s=Math.sin(a);
      const vocabulary=p.shape[0]*s+p.shape[1]*Math.cos(2*a)+p.shape[2]*Math.sin(3*a);
      const fold=.65*Math.sin(p.folds*a-phase)+.32*Math.sin(3*a+slow)+.2*c*Math.sin(slow*.73);
      let radius=1+.065*Math.tanh(vocabulary+fold)-.01*(drops[0].lift+drops[1].lift);
      drops.forEach(d=>{
        const angle=Math.atan2(Math.sin(a-d.direction),Math.cos(a-d.direction));
        /* A local shoulder follows the departing mass; its delayed wake relaxes after re-entry. */
        radius+=.13*d.neck*Math.exp(-Math.pow(angle/.48,2));
        radius+=d.wake*Math.exp(-Math.pow(angle/.8,2));
      });
      /* Broad rounded core keeps the text covered. Only the outer shoulders can neck or split. */
      const power=2/p.round;
      pts.push([100+94*Math.sign(c)*Math.pow(Math.abs(c),power)*radius+1.3*Math.sin(slow),
        50+43*Math.sign(s)*Math.pow(Math.abs(s),power)*radius+p.roll*Math.sin(slow-.7)]);
    }
    b.body.setAttribute('d',outline(pts));
    drops.forEach((d,j)=>{
      const a=d.tilt*Math.PI/180,c=Math.cos(a),s=Math.sin(a),ry=-p.drops[j].dir*d.ry;
      /* World-space points keep the shared lime gradient continuous through every neck. */
      const at=(x,y)=>point([d.x+x*d.rx*c-y*ry*s,d.y+x*d.rx*s+y*ry*c]);
      b.drops[j].setAttribute('d','M'+at(0,-1)+'C'+at(.62,-1)+' '+at(1,-.56)+' '+at(1,0)
        +'C'+at(1,.55)+' '+at(.32,d.tail)+' '+at(0,d.tail)
        +'C'+at(-.32,d.tail)+' '+at(-1,.55)+' '+at(-1,0)
        +'C'+at(-1,-.56)+' '+at(-.62,-1)+' '+at(0,-1)+'Z');
    });
  }
  const visibility=window.IntersectionObserver?new IntersectionObserver(entries=>{
    entries.forEach(e=>{const b=blobs.find(b=>b.host===e.target);if(b)b.visible=e.isIntersecting});
  },{rootMargin:'180px'}):null;
  document.querySelectorAll('.blob, .blobby').forEach((host,idx)=>{
    const svg=document.createElementNS(NS,'svg');svg.setAttribute('viewBox','0 0 200 100');svg.setAttribute('preserveAspectRatio','none');svg.setAttribute('aria-hidden','true');
    const gid='bg'+idx,fid='goo'+idx;
    const stops=host.classList.contains('tint')?'<stop offset="0" style="stop-color:var(--blob-a,#efffad)"/><stop offset=".5" style="stop-color:var(--blob-b,#c6ff3d)"/><stop offset="1" style="stop-color:var(--blob-c,#97d915)"/>':host.classList.contains('pink')?'<stop offset="0" stop-color="#ffd1e6"/><stop offset=".5" stop-color="#ff2e88"/><stop offset="1" stop-color="#c4126a"/>':host.classList.contains('ember')?'<stop offset="0" stop-color="#ffd3c4"/><stop offset=".5" stop-color="#ff4d2e"/><stop offset="1" stop-color="#c42b12"/>':'<stop offset="0" stop-color="#efffad"/><stop offset=".45" stop-color="#c6ff3d"/><stop offset="1" stop-color="#97d915"/>';
    svg.innerHTML='<defs><radialGradient id="'+gid+'" gradientUnits="userSpaceOnUse" cx="64" cy="22" r="190">'+stops+'</radialGradient>'
      +'<filter id="'+fid+'" x="-25%" y="-90%" width="150%" height="280%" color-interpolation-filters="sRGB"><feGaussianBlur in="SourceGraphic" stdDeviation="6" result="b"/>'
      +'<feColorMatrix in="b" values="1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 22 -10" result="g"/><feBlend in="SourceGraphic" in2="g"/></filter></defs>'
      +'<g filter="url(#'+fid+')" fill="url(#'+gid+')"><path/><path/><path/></g>';
    const paths=svg.querySelectorAll('g>path');
    const b={host,profile:profiles[idx%profiles.length],body:paths[0],drops:[paths[1],paths[2]],visible:true};
    blobs.push(b);draw(b,0);host.prepend(svg);if(visibility)visibility.observe(host);
  });
  /* One scroll clock still drives every SVG/icon. Wax geometry consumes the SAME accelerated t.
     No per-frame layout reads: offscreen bodies sleep, and visible wax updates at at most 30fps. */
  const seen=new WeakSet();let list=[],t=0,speed=1,lastY=scrollY,lt=performance.now(),acc=1,paint=0,raf=0;
  const collect=()=>{list=[...document.querySelectorAll('.blob>svg,.blobby>svg,.art svg')];list.forEach(s=>{
    if(!seen.has(s)&&s.pauseAnimations){seen.add(s);s.pauseAnimations()}
  })};
  const tick=now=>{
    const dt=Math.min(.1,(now-lt)/1000);lt=now;
    const v=Math.abs(scrollY-lastY)/Math.max(dt,.001);lastY=scrollY;
    const target=1+Math.min(v/220,7);speed+=(target-speed)*(target>speed?.3:.035);t+=dt*speed;
    if((acc+=dt)>1){acc=0;collect()}
    for(const s of list)if(s.setCurrentTime)s.setCurrentTime(t);
    if((paint+=dt)>=1/30){paint%=1/30;blobs.forEach(b=>{if(b.visible)draw(b,t)})}
    raf=requestAnimationFrame(tick);
  };
  function setMotion(){
    cancelAnimationFrame(raf);collect();
    if(motion.matches){
      blobs.forEach(b=>draw(b,0));list.forEach(s=>{if(s.setCurrentTime)s.setCurrentTime(0)});
    }else{
      lt=performance.now();lastY=scrollY;speed=1;paint=0;
      raf=requestAnimationFrame(tick);
    }
  }
  motion.addEventListener('change',setMotion);setMotion();
})();
