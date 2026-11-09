// Animated <details> folding (Material 2 timing, see motion.css): the panel's height eases over 300 ms with the
// standard curve and clips its content, which moves with it in parallax: on expand it slides down into place from a
// little above (48px, whatever the panel's length) while the growing edge reveals it; on collapse it slides
// back up as the edge closes over it. No fade. A closing panel stays open until the motion ends, and a second tap
// reverses from the current height and offset.
// Floating bodies (dropdown menus) do not change the layout: they fade in (120 ms) while growing from .8 (150 ms)
// out of the corner nearest their summary, and fade out in 75 ms.
(()=>{
 const STANDARD='cubic-bezier(0.4, 0, 0.2, 1)',DECELERATE='cubic-bezier(0, 0, 0.2, 1)',DURATION=300,LIFT=48;
 // CSS cubic-bezier as a function of progress, to sample values that follow the height's curve.
 const bezier=(x1,y1,x2,y2)=>{const at=(a,b,s)=>3*a*s*(1-s)**2+3*b*s*s*(1-s)+s**3;
  return x=>{let lo=0,hi=1;for(let i=0;i<30;i++){const mid=(lo+hi)/2;if(at(x1,x2,mid)<x)lo=mid;else hi=mid}return at(y1,y2,(lo+hi)/2)}};
 const reduced=()=>matchMedia('(prefers-reduced-motion: reduce)').matches;
 const bodiesOf=details=>[...details.children].filter(node=>node.localName!=='summary');
 const floating=bodies=>bodies.length&&bodies.every(node=>['absolute','fixed'].includes(getComputedStyle(node).position));

 function settle(details){
  details._foldAnimation?.cancel();
  details.classList.remove('is-closing','is-folding');details.style.overflow='';
  delete details._foldTarget;delete details._foldAnimation;
 }

 function animateDisclosure(details,opening=!(details._foldTarget??details.open)){
  if(opening===(details._foldTarget??details.open))return;
  const bodies=bodiesOf(details),summary=details.querySelector(':scope>summary');
  const from=details.getBoundingClientRect().height,shown=bodies.map(node=>Number(getComputedStyle(node).opacity));
  const offsets=bodies.map(node=>{const t=getComputedStyle(node).transform;return t&&t!=='none'?new DOMMatrixReadOnly(t).m42:0});
  // Where an interrupted fold left the shade and the summary's lower corners, so a reversal continues from there.
  const cornerNow=summary?Number.parseFloat(getComputedStyle(summary).borderBottomLeftRadius)||0:0;
  const midway=Boolean(details._foldAnimation),shadeNow=midway&&summary?Number(getComputedStyle(summary,'::before').opacity):opening?1:0;
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
   // Panels that opt in (--fold-shadow: 1) draw the moving edge themselves (see below); others are clipped by the panel.
   const drawn=Boolean(summary)&&getComputedStyle(details).getPropertyValue('--fold-shadow').trim()==='1';
   details.classList.add('is-folding');if(!drawn)details.style.overflow='hidden';
   details.open=false;const closed=details.getBoundingClientRect().height;details.open=true;const full=details.getBoundingClientRect().height,to=opening?full:closed;
   if(Math.abs(to-from)<1){finish();return}
   // The list slides the same distance whatever its length: proportional offsets made long lists race by hundreds of
   // pixels as if they were scrolling.
   const lift=-LIFT,start=i=>offsets[i]||(opening?lift:0);
   // The height holds its end until [open] changes: without fill, a folded panel showed its full height for a frame
   // between the motion ending and the promise that closes it.
   motions=[details.animate([{height:from+'px'},{height:to+'px'}],{duration:DURATION,easing:STANDARD,fill:'forwards'})];
   if(!drawn){
    // The part moved above its resting place is clipped, so the content never slides over the summary.
    motions.push(...bodies.map((node,i)=>{const frame=y=>({transform:`translateY(${y}px)`,clipPath:`inset(${-y}px 0 0 0)`});
     return node.animate([frame(start(i)),frame(opening?0:lift)],{duration:DURATION,easing:STANDARD,fill:'forwards'})}));
   }else{
    // The list is a panel behind the summary that rolls out from under it and back. Nothing is clipped by the card:
    // - the list clips itself to the panel's moving edge, rounded like the card, and the edge leads the card's height by
    //   up to 8px at the closed end, so the panel tucks fully behind the summary before the card closes (and comes out
    //   from behind it as an unfold starts) instead of its edge merging into the summary's;
    // - the card's own outline and shadow move to summary::after, which spans the summary and the visible panel, so
    //   they always wrap what is seen and become the closed card's outline exactly;
    // - the summary casts a soft shadow onto the panel (::before, with a fine edge along its lower curve) and the panel
    //   carries the same shade inside its moving edge (list::after). Both shrink with the visible panel so they are never
    //   cut off, and last the whole motion: a fold darkens them to the end, an unfold clears them as it finishes;
    // - the summary's lower corners ease between the card's radius and square over the same 300 ms.
    const ease=bezier(.4,0,.2,1),steps=24,head=summary.offsetHeight,radius=Number.parseFloat(getComputedStyle(summary).borderTopLeftRadius)||0;
    const css=getComputedStyle(details),tone=css.getPropertyValue('--fold-shade').trim()||'transparent',edge=css.getPropertyValue('--fold-edge').trim()||'transparent';
    const span=Array.from({length:steps+1},(_,k)=>k/steps),eased=span.map(ease);
    const lead=p=>8*(opening?(1-p)**2:p**2),bottom=span.map((p,k)=>from+(to-from)*eased[k]-lead(p)),strip=bottom.map(b=>Math.max(0,b-head));
    const size=strip.map(s=>Math.min(1,s/18)),shade=span.map(p=>opening?shadeNow*(1-p*p):shadeNow+(1-shadeNow)*(1-(1-p)**2));
    const corner=r=>({borderBottomLeftRadius:`${r}px`,borderBottomRightRadius:`${r}px`});
    for(const [i,node] of bodies.entries()){
     const top=node.offsetTop,tall=node.offsetHeight,y0=start(i),y1=opening?0:lift,y=eased.map(e=>y0+(y1-y0)*e);
     motions.push(node.animate(y.map((yy,k)=>({transform:`translateY(${yy}px)`,clipPath:`inset(${-yy}px 0 ${Math.max(0,tall-(bottom[k]-top-yy))}px 0 round 0 0 ${radius}px ${radius}px)`})),{duration:DURATION,easing:'linear',fill:'forwards'}),
      node.animate(y.map((yy,k)=>({opacity:shade[k],top:`${-yy}px`,height:`${Math.max(0,bottom[k]-top)}px`,boxShadow:`inset 0 ${-10*size[k]}px ${16*size[k]}px ${-8*size[k]}px ${tone}`})),{duration:DURATION,easing:'linear',fill:'forwards',pseudoElement:'::after'}));
    }
    motions.push(summary.animate(bottom.map(b=>({height:`${Math.max(head,b)}px`})),{duration:DURATION,easing:'linear',fill:'forwards',pseudoElement:'::after'}),
     summary.animate(size.map((s,k)=>({opacity:shade[k],boxShadow:`0 ${s}px 0 ${edge},0 ${10*s}px ${16*s}px ${-8*s}px ${tone}`})),{duration:DURATION,easing:'linear',fill:'forwards',pseudoElement:'::before'}),
     summary.animate([corner(cornerNow),corner(opening?0:radius)],{duration:DURATION,easing:STANDARD,fill:'forwards'}));
   }
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
