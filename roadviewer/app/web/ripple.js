'use strict';
// Press ripple (Material style) for buttons, tabs, menu items and disclosure headers. One delegated listener per event type;
// the wave lives in an absolutely positioned clipping layer, so hosts keep overflow visible and nothing shifts.
// Touch waits briefly before showing the wave and drops it when the finger starts scrolling, so a scroll that begins on
// a button neither flashes a ripple nor competes with the scroll. The wave grows while pressed and fades on release.
(()=>{
 if(window.rvRipple)return;window.rvRipple=true;
 const target='button,[role=menuitem],[role=tab],[role=option],summary';
 const reduce=matchMedia('(prefers-reduced-motion: reduce)');
 const TOUCH_DELAY=90,SLOP=10,FADE=320;
 const host=node=>{
  const el=node?.closest?.(target);
  return !el||el.disabled||el.getAttribute('aria-disabled')==='true'||el.closest('[data-no-ripple],.time-toggle')?null:el;
 };
 function spawn(el,x,y){
  if(reduce.matches){el.classList.add('rv-pressed');setTimeout(()=>el.classList.remove('rv-pressed'),150);return null}
  const box=el.getBoundingClientRect();if(!box.width||!box.height)return null;
  if(getComputedStyle(el).position==='static')el.classList.add('rv-ripple-host');
  const layer=document.createElement('span'),wave=document.createElement('span'),size=2*Math.hypot(Math.max(x,box.width-x),Math.max(y,box.height-y));
  // Bigger controls get a slower wave, so the edge travels at a similar, calm speed everywhere.
  const grow=Math.round(Math.min(650,Math.max(400,300+size*.8)));
  layer.className='rv-ripple';layer.setAttribute('aria-hidden','true');
  wave.style.cssText=`width:${size}px;height:${size}px;left:${x-size/2}px;top:${y-size/2}px;animation-duration:${grow}ms`;
  layer.append(wave);el.append(layer);
  const born=performance.now();let gone=false;
  const remove=()=>{if(!gone){gone=true;layer.remove()}};
  setTimeout(remove,8000);
  // Release: fade out while the wave keeps growing; removed once both have finished.
  return ()=>{if(gone||layer.classList.contains('is-out'))return;layer.classList.add('is-out');setTimeout(remove,Math.max(FADE,grow-(performance.now()-born))+20)};
 }
 let press=null;
 const settle=()=>{if(!press)return;const p=press;press=null;clearTimeout(p.timer);if(p.release)p.release();else if(p.tap){const r=spawn(p.el,p.x,p.y);r?.()}};
 const cancel=()=>{if(!press)return;clearTimeout(press.timer);press.release?.();press=null};
 document.addEventListener('pointerdown',e=>{
  if(e.button!==0)return;const el=host(e.target);if(!el)return;
  cancel();
  const box=el.getBoundingClientRect(),x=e.clientX-box.left,y=e.clientY-box.top;
  press={el,id:e.pointerId,x,y,sx:e.clientX,sy:e.clientY,release:null,tap:false,timer:0};
  if(e.pointerType==='touch'){const p=press;p.timer=setTimeout(()=>{if(press===p)p.release=spawn(el,x,y)},TOUCH_DELAY)}
  else press.release=spawn(el,x,y);
 },{capture:true,passive:true});
 document.addEventListener('pointermove',e=>{if(press&&e.pointerId===press.id&&!press.release&&Math.hypot(e.clientX-press.sx,e.clientY-press.sy)>SLOP)cancel()},{capture:true,passive:true});
 // A quick tap shorter than the touch delay still gets its wave, started on release.
 document.addEventListener('pointerup',e=>{if(press&&e.pointerId===press.id){press.tap=true;settle()}},{capture:true,passive:true});
 document.addEventListener('pointercancel',cancel,{capture:true,passive:true});
 addEventListener('scroll',()=>{if(press&&!press.release)cancel()},{capture:true,passive:true});
 document.addEventListener('keydown',e=>{
  if(e.repeat||(e.key!=='Enter'&&e.key!==' '))return;const el=host(e.target);
  if(el&&el===document.activeElement){const box=el.getBoundingClientRect();const release=spawn(el,box.width/2,box.height/2);setTimeout(()=>release?.(),120)}
 },true);
})();
