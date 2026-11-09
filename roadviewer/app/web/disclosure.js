// Animated <details> folding (Material 2 timing, see motion.css): the panel's height eases over 300 ms with the
// standard curve and clips its content, which moves with it in parallax: on expand it slides down into place from a
// little above (a quarter of the height change, at most 40px) while the growing edge reveals it; on collapse it slides
// back up as the edge closes over it. No fade. A closing panel stays open until the motion ends, and a second tap
// reverses from the current height and offset.
// Floating bodies (dropdown menus) do not change the layout: they fade in (120 ms) while growing from .8 (150 ms)
// out of the corner nearest their summary, and fade out in 75 ms.
(()=>{
 const STANDARD='cubic-bezier(0.4, 0, 0.2, 1)',DECELERATE='cubic-bezier(0, 0, 0.2, 1)',DURATION=300;
 const reduced=()=>matchMedia('(prefers-reduced-motion: reduce)').matches;
 const bodiesOf=details=>[...details.children].filter(node=>node.localName!=='summary');
 const floating=bodies=>bodies.length&&bodies.every(node=>['absolute','fixed'].includes(getComputedStyle(node).position));

 function settle(details){
  details._foldAnimation?.cancel();
  details.classList.remove('is-closing');details.style.overflow='';
  delete details._foldTarget;delete details._foldAnimation;
 }

 function animateDisclosure(details,opening=!(details._foldTarget??details.open)){
  if(opening===(details._foldTarget??details.open))return;
  const bodies=bodiesOf(details),summary=details.querySelector(':scope>summary');
  const from=details.getBoundingClientRect().height,shown=bodies.map(node=>Number(getComputedStyle(node).opacity));
  const offsets=bodies.map(node=>{const t=getComputedStyle(node).transform;return t&&t!=='none'?new DOMMatrixReadOnly(t).m42:0});
  details._foldAnimation?.cancel();
  details._foldTarget=opening;
  // Labels and chevrons follow the target right away; [open] itself only drops when the motion ends.
  details.classList.toggle('is-closing',!opening);
  if(!opening&&bodies.some(node=>node.contains(document.activeElement)))summary?.focus({preventScroll:true});
  const finish=()=>{details.open=opening;settle(details)};
  if(reduced()||!bodies.length){finish();return}

  details.open=true;
  let animation;
  let motions;
  if(floating(bodies)){
   const anchor=summary?.getBoundingClientRect();
   motions=bodies.flatMap((node,i)=>{
    if(!opening)return [node.animate([{opacity:shown[i]},{opacity:0}],{duration:75,easing:'linear',fill:'both'})];
    const box=node.getBoundingClientRect(),x=anchor&&Math.abs(box.right-anchor.right)<Math.abs(box.left-anchor.left)?'right':'left',y=anchor&&box.top>=anchor.top?'top':'bottom';
    return [node.animate([{opacity:0},{opacity:1}],{duration:120,easing:'linear',fill:'both'}),
     node.animate([{transform:'scale(.8)',transformOrigin:`${y} ${x}`},{transform:'none',transformOrigin:`${y} ${x}`}],{duration:150,easing:DECELERATE,fill:'both'})];
   });
  }else{
   details.style.overflow='hidden';
   details.open=false;const closed=details.getBoundingClientRect().height;details.open=true;const full=details.getBoundingClientRect().height,to=opening?full:closed;
   if(Math.abs(to-from)<1){finish();return}
   // The full travel sets the parallax distance, so a reversed fold keeps the same path.
   const lift=-Math.min(40,Math.max(0,full-closed)/4),start=i=>offsets[i]||(opening?lift:0);
   motions=[details.animate([{height:from+'px'},{height:to+'px'}],{duration:DURATION,easing:STANDARD}),
    // The part moved above its resting place is clipped, so the content never slides over the summary.
    ...bodies.map((node,i)=>{const frame=y=>({transform:`translateY(${y}px)`,clipPath:`inset(${-y}px 0 0 0)`});
     return node.animate([frame(start(i)),frame(opening?0:lift)],{duration:DURATION,easing:STANDARD,fill:'forwards'})})];
  }
  animation={cancel(){motions.forEach(motion=>motion.cancel())},finished:Promise.all(motions.map(motion=>motion.finished))};
  details._foldAnimation=animation;
  animation.finished.then(()=>{if(details._foldAnimation===animation)finish()}).catch(()=>{});
 }

 document.addEventListener('click',event=>{
  if(event.defaultPrevented||event.button)return;
  const summary=event.target.closest?.('summary'),details=summary?.parentElement;
  if(details?.localName!=='details'||details.querySelector(':scope>summary')!==summary)return;
  // Controls placed inside a summary keep their own click behaviour, as they do natively.
  if(event.target.closest('a,button,input,select,textarea,label')?.closest('summary')===summary)return;
  event.preventDefault();
  animateDisclosure(details);
 });

 window.addEventListener('toggle',event=>{
  const details=event.target;
  if(details?.localName!=='details')return;
  // Other code (outside clicks, Escape, menu actions) may close a panel directly; that wins over a running unfold.
  if(details._foldTarget===true&&!details.open)settle(details);
  // Measuring the closed height flips [open] twice in one task; the coalesced no-op event is not a real toggle.
  if(event.newState&&event.newState===event.oldState)event.stopImmediatePropagation();
 },true);

 window.rvDisclosure={animate:animateDisclosure};
})();
