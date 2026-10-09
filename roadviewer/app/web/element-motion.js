// Live-element geometry animation avoids the snapshot compositor on every screen.
(()=>{
 const animations=new WeakMap();
 const allowed=()=>!matchMedia('(prefers-reduced-motion: reduce)').matches;
 function capture(element){return element?.getBoundingClientRect()}
 function play(element,before,{uniform=false,visible=false}={}){
  if(!element||!before||!allowed())return;
  animations.get(element)?.cancel();const after=element.getBoundingClientRect();
  if(!before.width||!before.height||!after.width||!after.height)return;
  if(visible&&[before,after].some(r=>r.bottom<=0||r.top>=innerHeight||r.right<=0||r.left>=innerWidth))return;
  if(['left','top','width','height'].every(key=>Math.abs(before[key]-after[key])<.5))return;
  const sy=before.height/after.height,sx=uniform?sy:before.width/after.width;
  const animation=element.animate([
   {transformOrigin:'0 0',transform:`translate(${before.left-after.left}px,${before.top-after.top}px) scale(${sx},${sy})`},
   {transformOrigin:'0 0',transform:'none'}
  ],{duration:matchMedia('(hover:hover) and (pointer:fine)').matches?380:320,easing:'cubic-bezier(.4,0,.2,1)'});
  animation.id='rv-element-morph';animations.set(element,animation);
 }
 window.RoadViewerMotion={allowed,capture,play};
})();
