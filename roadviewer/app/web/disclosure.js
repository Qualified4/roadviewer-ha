// Animated <details> folding, modelled on the 매거진 홈 dashboard: the panel's height eases over 250 ms,
// a closing panel stays open until the motion ends, and a second tap reverses from the current height.
// Floating bodies (dropdown menus) do not change the layout, so they fade and slide 4 px instead.
(()=>{
 const EASING='cubic-bezier(0.4, 0, 0.2, 1)',DURATION=250,FLOAT_DURATION=180;
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
  const from=details.getBoundingClientRect().height;
  details._foldAnimation?.cancel();
  details._foldTarget=opening;
  // Labels and chevrons follow the target right away; [open] itself only drops when the motion ends.
  details.classList.toggle('is-closing',!opening);
  if(!opening&&bodies.some(node=>node.contains(document.activeElement)))summary?.focus({preventScroll:true});
  const finish=()=>{details.open=opening;settle(details)};
  if(reduced()||!bodies.length){finish();return}

  details.open=true;
  let animation;
  if(floating(bodies)){
   const motions=bodies.map(node=>node.animate(opening?
    [{opacity:0,transform:'translateY(-4px)'},{opacity:1,transform:'translateY(0)'}]:
    [{opacity:1,transform:'translateY(0)'},{opacity:0,transform:'translateY(-4px)'}],
    {duration:FLOAT_DURATION,easing:EASING,fill:'both'}));
   animation={cancel(){motions.forEach(motion=>motion.cancel())},finished:Promise.all(motions.map(motion=>motion.finished))};
  }else{
   details.style.overflow='hidden';
   details.open=opening;const to=details.getBoundingClientRect().height;details.open=true;
   if(Math.abs(to-from)<1){finish();return}
   const motion=details.animate([{height:from+'px'},{height:to+'px'}],{duration:DURATION,easing:EASING});
   animation={cancel(){motion.cancel()},finished:motion.finished};
  }
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
