'use strict';
// Press ripple (Material style) for buttons, tabs, menu items and disclosure headers. One delegated listener per event type;
// the wave lives in an absolutely positioned clipping layer, so hosts keep overflow visible and nothing shifts.
(()=>{
 if(window.rvRipple)return;window.rvRipple=true;
 const target='button,[role=menuitem],[role=tab],[role=option],summary';
 const reduce=matchMedia('(prefers-reduced-motion: reduce)');
 const host=node=>{
  const el=node?.closest?.(target);
  return !el||el.disabled||el.getAttribute('aria-disabled')==='true'||el.closest('[data-no-ripple],.time-toggle')?null:el;
 };
 function spawn(el,x,y){
  if(reduce.matches){el.classList.add('rv-pressed');setTimeout(()=>el.classList.remove('rv-pressed'),150);return}
  const box=el.getBoundingClientRect();if(!box.width||!box.height)return;
  if(getComputedStyle(el).position==='static')el.classList.add('rv-ripple-host');
  const layer=document.createElement('span'),wave=document.createElement('span'),size=2*Math.hypot(Math.max(x,box.width-x),Math.max(y,box.height-y));
  layer.className='rv-ripple';layer.setAttribute('aria-hidden','true');
  wave.style.cssText=`width:${size}px;height:${size}px;left:${x-size/2}px;top:${y-size/2}px`;
  layer.append(wave);el.append(layer);
  const done=()=>layer.remove();wave.addEventListener('animationend',done,{once:true});setTimeout(done,1000);
 }
 document.addEventListener('pointerdown',e=>{
  if(e.button!==0)return;const el=host(e.target);if(!el)return;
  const box=el.getBoundingClientRect();spawn(el,e.clientX-box.left,e.clientY-box.top);
 },{capture:true,passive:true});
 document.addEventListener('keydown',e=>{
  if(e.repeat||(e.key!=='Enter'&&e.key!==' '))return;const el=host(e.target);
  if(el&&el===document.activeElement){const box=el.getBoundingClientRect();spawn(el,box.width/2,box.height/2)}
 },true);
})();
