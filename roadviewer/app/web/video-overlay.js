'use strict';
(()=>{
 const layer=document.getElementById('videoOverlay'),context=layer.getContext('2d'),video=document.getElementById('video'),button=document.getElementById('videoOverlayToggle'),status=document.getElementById('overlayStatus');
 let boxOpacity=.3;
 const opacitySlider=document.getElementById('ccncOpacity'),opacityValue=document.getElementById('ccncOpacityValue');
 try{const saved=localStorage.getItem('roadviewer-ccnc-opacity');if(saved!==null&&Number.isFinite(Number(saved)))boxOpacity=Math.max(0,Math.min(1,Number(saved)))}catch{}
 const syncOpacity=()=>{opacitySlider.value=String(Math.round(boxOpacity*100));opacityValue.textContent=opacitySlider.value+'%'};
 syncOpacity();
 opacitySlider.oninput=()=>{boxOpacity=Number(opacitySlider.value)/100;syncOpacity();try{localStorage.setItem('roadviewer-ccnc-opacity',String(boxOpacity))}catch{}render()};
 let bsdHeight=.8;
 const bsdSlider=document.getElementById('bsdHeight'),bsdValue=document.getElementById('bsdHeightValue');
 try{const saved=localStorage.getItem('roadviewer-bsd-height');if(saved!==null&&Number.isFinite(Number(saved)))bsdHeight=Math.max(0,Math.min(3,Number(saved)))}catch{}
 const syncBsdHeight=()=>{bsdSlider.value=String(Math.round(bsdHeight*100));bsdValue.textContent=bsdHeight.toFixed(2)+' m'};
 syncBsdHeight();bsdSlider.oninput=()=>{bsdHeight=Number(bsdSlider.value)/100;syncBsdHeight();try{localStorage.setItem('roadviewer-bsd-height',String(bsdHeight))}catch{}render()};
 let boxHeight=1.3;
 const boxHeightSlider=document.getElementById('ccncBoxHeight'),boxHeightValue=document.getElementById('ccncBoxHeightValue');
 try{const saved=localStorage.getItem('roadviewer-ccnc-box-height');if(saved!==null&&Number.isFinite(Number(saved)))boxHeight=Math.max(0,Math.min(3,Number(saved)))}catch{}
 const syncBoxHeight=()=>{boxHeightSlider.value=String(Math.round(boxHeight*100));boxHeightValue.textContent=boxHeight.toFixed(2)+' m'};
 syncBoxHeight();boxHeightSlider.oninput=()=>{boxHeight=Number(boxHeightSlider.value)/100;syncBoxHeight();try{localStorage.setItem('roadviewer-ccnc-box-height',String(boxHeight))}catch{}render()};
 // The box height and opacity only shape the 3D box: disabled (still shown) while 차량 박스 is off.
 const boxSwitch=document.getElementById('vehicleBoxes'),syncBoxControls=()=>{for(const id of ['ccncBoxHeight','ccncOpacity'])for(const control of [document.getElementById(id),document.getElementById(id+'Reset')])control.disabled=!boxSwitch.checked};
 syncBoxControls();boxSwitch.addEventListener('change',syncBoxControls);
 let enabled=true,raised=true,heightCm=60;
 try{const saved=localStorage.getItem('roadviewer-overlay-height-cm');if(saved!==null&&Number.isFinite(Number(saved)))heightCm=Math.max(0,Math.min(200,Math.round(Number(saved))))}catch{}
 const heightButton=document.getElementById('overlayHeight');
 try{raised=localStorage.getItem('roadviewer-overlay-height')!=='false'}catch{}
 heightButton.setAttribute('aria-pressed',String(raised));
 try{enabled=localStorage.getItem('roadviewer-video-overlay')!=='false'}catch{}
 button.setAttribute('aria-pressed',String(enabled));
 // Fade stays on the compositor; height interpolation shares the existing replay tick.
 let fade=null,heightMotion=null,displayHeight=raised?heightCm:0;
 layer.style.opacity=enabled?'1':'0';
 function currentHeight(){
  if(heightMotion){
   const p=motionAllowed()?Math.min(1,(performance.now()-heightMotion.start)/250):1;
   const eased=p*p*(3-2*p);
   displayHeight=heightMotion.from+(heightMotion.to-heightMotion.from)*eased;
   if(p===1)heightMotion=null;
  }
  return displayHeight;
 }
 function moveHeight(){
  const from=currentHeight(),to=raised?heightCm:0;
  heightMotion=motionAllowed()&&enabled&&!video.hidden&&from!==to?{from,to,start:performance.now()}:null;
  if(!heightMotion)displayHeight=to;
  render();
 }
 let lastRoadMotion=0,boxAnimating=false;
 window.renderVideoOverlayMotion=()=>{
  if(!data)return;const frame=data.frames[idx],signals=frame.roadSignals??frame.ccncRoad;
  const animated=enabled&&playing&&motionAllowed()&&((on('ccncTargets')&&boxAnimating)||(on('ccncRoad')&&(signals?.blinkerLeft||signals?.blinkerRight))||(on('bsdWalls')&&bsdHeight>0&&blindspotLevels(data.frames,idx,frame.t).some(v=>v>0)));
  if(heightMotion||animated&&performance.now()-lastRoadMotion>=1000/30){lastRoadMotion=performance.now();window.renderVideoOverlay(frame,frameAvailable(frame))}
 };
 matchMedia('(prefers-reduced-motion: reduce)').addEventListener('change',()=>{
  if(!motionAllowed()){fade?.finish();currentHeight();render()}
 });
 const on=id=>document.getElementById(id).checked;
 function label(target){
  if(on('hideLabels'))return '';
  if(on('trackLabels'))return Number.isInteger(target.trackId)&&target.trackId>=0?String(target.trackId):'—';
  if(on('yRelLabels'))return (target.yRel??-target.y).toFixed(2)+'m';
  if(on('speedLabels')||on('relativeSpeedLabels')){
   const ego=data.frames[idx].egoSpeedKph,relative=Number.isFinite(target.vRel)?target.vRel*3.6:Number.isFinite(target.speedKph)&&Number.isFinite(ego)?target.speedKph-ego:null;
   const speed=Number.isFinite(target.speedKph)?target.speedKph:Number.isFinite(relative)&&Number.isFinite(ego)?ego+relative:null;
   const value=on('relativeSpeedLabels')?relative:speed;return Number.isFinite(value)?value.toFixed(1)+' km/h':'—';
  }
  return target.x.toFixed(1)+'m';
 }
 // The stage size, read when it changes (ResizeObserver below) rather than after the DOM writes of every draw.
 // On a phone or tablet the canvas is drawn at no more than OVERLAY_PIXELS: over a full-screen video on a large
 // high-density screen (a Fold's inner one: 933x704 at 2.6 = 4.5 million pixels) it halved the frame rate and dropped
 // video frames (measured on the device, full screen, 6 s each: 75 fps and 17 dropped frames at 4.5 MP, 105 and 1 at
 // 2.4 MP). Never under 1; mouse devices (desktop GPUs) keep the screen's own density.
 const OVERLAY_PIXELS=2.4e6,coarse=matchMedia('(pointer:coarse)');
 const overlayScale=(w,h)=>{const dpr=devicePixelRatio||1;return coarse.matches?Math.max(1,Math.min(dpr,Math.sqrt(OVERLAY_PIXELS/Math.max(1,w*h)))):dpr};
 let stageSize=null;const measureStage=()=>{const box=layer.parentElement;stageSize=[box.clientWidth,box.clientHeight]};
 window.renderVideoOverlay=(frame,available)=>{
  const height=currentHeight();boxAnimating=false;
  if(!stageSize)measureStage();const [w,h]=stageSize,dpr=overlayScale(w,h);
  if(layer.width!==Math.round(w*dpr)||layer.height!==Math.round(h*dpr)){layer.width=Math.round(w*dpr);layer.height=Math.round(h*dpr)}
  context.setTransform(dpr,0,0,dpr,0,0);context.clearRect(0,0,w,h);
  layer.hidden=(!enabled&&!fade)||video.hidden;status.textContent='';
  if(!enabled&&!fade)return;
  if(video.hidden){status.textContent='영상이 있는 구간에서 표시됩니다.';return}
  if(!available){status.textContent='이 구간에는 로그 데이터가 없습니다.';return}
  if(videoSource==='wide'&&!frame.overlay?.wide){layer.hidden=true;status.textContent='와이드 카메라 보정·센서 정보가 없습니다. 이전 변환 데이터는 로그 재분석이 필요합니다.';return}
  if(!frame.overlay){status.textContent='카메라 보정·센서 정보가 없어 겹쳐 표시할 수 없습니다.';return}
  if(!video.videoWidth||!video.videoHeight)return;
  const ratio=Math.min(w/video.videoWidth,h/video.videoHeight),vw=video.videoWidth*ratio,vh=video.videoHeight*ratio,left=(w-vw)/2,top=(h-vh)/2;
  const xy=p=>[left+p[0]*vw,top+p[1]*vh];
  context.save();context.beginPath();context.rect(left,top,vw,vh);context.clip();
  // 노면 투영: road graphics are light laid on the road, not paint. They add to the picture (canvas 'lighter' among
  // themselves, CSS mix-blend-mode:screen against the video), each line is a thin bright core over wider, much fainter
  // passes of the same shape, and everything dims with distance and fades out at its ends. Ground glows are wider ground
  // ribbons, so they narrow with perspective by themselves. No shadowBlur or canvas filter: this redraws at 20 fps on phones.
  const rgba=(hex,a)=>{const v=parseInt(hex.slice(1,7),16);return `rgba(${v>>16},${v>>8&255},${v&255},${Math.max(0,Math.min(1,a)).toFixed(3)})`};
  const proj=q=>q&&q.length===3&&q.every(Number.isFinite)&&q[2]>.1?xy([q[0]/q[2],q[1]/q[2]]):null;
  const extent=points=>{const ys=(points||[]).filter(Boolean).map(p=>p[1]);if(!ys.length)return null;const near=Math.min(Math.max(...ys),top+vh),far=Math.max(Math.min(...ys),top);return [near,far,far]};
  // Brightness by height on screen: full at the near end (bottom of the picture), none at the line's own far end; a cut
  // end (before a lead car, say) still fades out over its last part instead of stopping hard.
  function fadeStyle([near,end,full],color,tail=.12){
   if(near-end<1)end=near-1;const g=context.createLinearGradient(0,near,0,end),span=Math.max(1,near-full);
   for(let k=0;k<=8;k++){const pos=k/8,y=near+(end-near)*pos,c=Math.max(0,Math.min(1,(1-pos)/tail));g.addColorStop(pos,rgba(color,Math.max(0,Math.min(1,1-(near-y)/span))**.6*c*c*(3-2*c)))}
   return g;
  }
  function fillBand(left,right,style,alpha){
   context.fillStyle=style;context.globalAlpha=alpha;let a=[],b=[];
   const flush=()=>{if(a.length>1){context.beginPath();[...a,...b.reverse()].forEach(([x,y],i)=>i?context.lineTo(x,y):context.moveTo(x,y));context.closePath();context.fill()}a=[];b=[]};
   for(let i=0;i<Math.min(left.length,right.length);i++){if(left[i]&&right[i]){a.push(left[i]);b.push(right[i])}else flush()}flush();
  }
  // Line widths are tuned for a picture about 900 px wide; on a phone's small picture the same widths read as thick, bright lines.
  const thin=Math.max(.5,Math.min(1,vw/900));
  function strokeLine(points,style,width,alpha,dash=[],k=thin){
   context.beginPath();let connected=false;
   for(const p of points||[]){if(!p){connected=false;continue}if(connected)context.lineTo(...p);else context.moveTo(...p);connected=true}
   context.strokeStyle=style;context.lineWidth=width*k;context.globalAlpha=alpha;context.setLineDash(dash);context.lineCap='round';context.lineJoin='round';context.stroke();context.setLineDash([]);
  }
  // Same ribbon, k times as wide around its middle (screen space; a ribbon this narrow is locally affine).
  const widen=([l,r],k)=>[-1,1].map(sign=>l.map((a,i)=>{const b=r[i];if(!a||!b)return null;const c=[(a[0]+b[0])/2,(a[1]+b[1])/2];return [c[0]+sign*(a[0]-c[0])*k,c[1]+sign*(a[1]-c[1])*k]}));
  const middle=([l,r])=>l.map((a,i)=>a&&r[i]?[(a[0]+r[i][0])/2,(a[1]+r[i][1])/2]:null);
  // A line of light on the ground: nested ribbons, each wider and fainter (added up they fall off softly across the
  // line instead of showing flat stripes), the ribbon itself, then the 1 px core. `wide` is the outermost ribbon's width.
  // Eight thin steps: with four, the steps showed as separate lines where the ribbon is wide (next to the car). `slim`
  // narrows the ribbon first: the model's lane ribbon is wider than the paint, and filled whole it read as a painted bar.
  function lightBand(sides,core,color,alpha,range,{wide=3,body=.55,coreColor=color,coreWidth=1.6,slim=1,glow=.05,outline=0}={}){
   const style=fadeStyle(range,color);if(slim!==1)sides=widen(sides,slim);
   if(glow)for(let k=1;k<=8;k++)fillBand(...widen(sides,1+(wide-1)*k/8),style,glow*alpha);
   fillBand(...sides,style,body*alpha);if(outline){const l=sides[0].filter(Boolean),r=sides[1].filter(Boolean);if(l.length>1&&r.length>1){const ring=[...l,...r.reverse(),l[0]];strokeLine(ring,style,4.5,.13*outline*alpha);strokeLine(ring,style,2.2,.3*outline*alpha);strokeLine(ring,style,1,outline*alpha)}}if(coreWidth)strokeLine(core,coreColor===color?style:fadeStyle(range,coreColor),coreWidth,.95*alpha);
  }
  // Without ground ribbons (older data): the same passes as strokes.
  function lightLine(points,color,alpha=1,range=extent(points),dash=[],halo=true){if(!range)return;const style=fadeStyle(range,color);if(halo){strokeLine(points,style,9,.1*alpha,dash);strokeLine(points,style,3.6,.3*alpha,dash)}strokeLine(points,style,1.6,alpha,dash)}
  // A short mark at one distance (lead line or arc, vehicle mark, target bars): glow, halo and core, scaled by its size on screen.
  function lightMark(points,style,scale,alpha=1,dash=[]){strokeLine(points,style,16*scale,.06*alpha,dash);strokeLine(points,style,9*scale,.12*alpha,dash);strokeLine(points,style,4.5*scale,.3*alpha,dash);strokeLine(points,style,1.4+.8*scale,alpha,dash)}
  const sideFade=(points,color)=>{const xs=points.filter(Boolean).map(p=>p[0]),y=points.find(Boolean)?.[1]??0;return targetGradient(context,[Math.min(...xs)-1,y],[Math.max(...xs)+1,y],color)};
  // Ground labels (vehicles, lead distance) step down instead of overlapping each other.
  const placed=[];
  // Screen directions of the road plane at a ground point: one metre to the right, one metre towards the camera.
  const groundBasis=(C,S,F)=>{const p=proj(C),r=proj(C.map((v,k)=>v+S[k]*.3)),n=proj(C.map((v,k)=>v-F[k]*.3));if(!p||!r||!n)return null;
   const unit=(q,axis)=>{const d=[q[0]-p[0],q[1]-p[1]],l=Math.hypot(...d);return l<1e-3?null:d.map(v=>v/l*(d[axis]<0?-1:1))},u=unit(r,0),v=unit(n,1);if(!u||!v)return null;const lean=(d,along,limit)=>{const across=1-along,k=Math.max(-limit,Math.min(limit,d[across]/Math.max(1e-3,d[along]))),l=Math.hypot(1,k),out=[];out[along]=1/l;out[across]=k/l;return out};return [lean(u,0,.2),lean(v,1,.28)]};  // far to the side the plane is nearly edge-on: the lean is limited so the letters stay readable
  // Text lies on the road: its baseline runs across the lane and its uprights run along it (towards the vanishing point),
  // flattened as a mark on the ground is. Over one short line of text the road's perspective is close to this affine map.
  function groundLabel(text,x,y,color,alpha=1,size=13,basis=null){size*=1.25*Math.max(.62,Math.min(1,vw/900));  // a phone's picture is small: the same text would cover the road
   const font=`700 ${size.toFixed(1)}px "Pretendard Variable", system-ui`;context.save();context.font=font;const width=context.measureText(text).width+10;context.restore();
   for(let i=0;i<4&&placed.some(r=>Math.abs(r[0]-x)<(r[2]+width)/2&&Math.abs(r[1]-y)<size+4);i++)y+=size+4;
   x=Math.max(left+4+width/2,Math.min(left+vw-4-width/2,x));placed.push([x,y,width]);
   // Text of light on the road: a faint wide stroke as its glow, then the letters.
   context.save();context.globalCompositeOperation='lighter';const [u,v]=basis||[[1,0],[0,1]],flat=.86;context.translate(x,y);context.transform(u[0],u[1],v[0]*flat,v[1]*flat,0,0);context.translate(-x,-y);context.font=font;context.textAlign='center';context.textBaseline='middle';context.lineJoin='round';
   // A soft dark edge first: on bright paint or a lit road the light alone does not stand out.
   context.globalCompositeOperation='source-over';context.strokeStyle='rgba(3,9,16,.55)';context.lineWidth=size*.26;context.globalAlpha=alpha;context.strokeText(text,x,y);context.globalCompositeOperation='lighter';
   context.strokeStyle=color;context.lineWidth=size*.32;context.globalAlpha=.14*alpha;context.strokeText(text,x,y);context.fillStyle=color;context.globalAlpha=alpha;context.fillText(text,x,y);context.restore();
  }
  // Where the lead mark (앞차거리) was drawn this frame: the FF vehicle at that distance is the same car, so its own ground
  // mark is left out and only one distance text is written (the vehicle's, when vehicle labels are on).
  // While a car slides from one slot to another its mark changes shape too (vehicle ring <-> lead mark) instead of
  // switching at once. leadShape: this frame's lead mark; merge: the sliding FF mark becomes it (it was not shown before).
  const ccncEntries=on('ccncTargets')?ccncBoxTransitions(data.frames,idx,t):[],MARK=33;let leadShape=null;
  const wasLead=(i,x)=>{const r=on('ccncRoad')?data.frames[i]?.ccncRoad:null;return !!r&&[1,3].includes(r.target)&&r.distance>0&&Math.abs(r.distance-x)<3};
  const blend=(a,b,k)=>a.map((p,i)=>[p[0]+(b[i][0]-p[0])*k,p[1]+(b[i][1]-p[1])*k]);
  // Blinker morph: each side's progress (0..1) from path chevrons to the >>> arrows, whether it is settling back (blinker
  // off), and when that movement began. The three arrows each belong to one chevron, picked when the movement began and
  // followed as it flows along the road (slots: their 6-point outlines now, same order as BLINKER_SHAPE; null: none).
  const stateAt=(duration,settle)=>['blinkerLeft','blinkerRight'].map(key=>on('ccncRoad')?blinkerMorphState(data.frames,idx,t,key,duration,settle):{progress:0,settling:false,start:null});
  let states=stateAt(BLINKER_MORPH,BLINKER_SETTLE),morph=states.map(s=>s.progress),settling=states.map(s=>s.settling),slots=[null,null,null];
  // Settling back: the innermost arrow goes first, to the nearest chevron, the outermost last, to the farthest. Forming: the
  // nearest chevron goes first, to the outermost arrow. Arrow i (0 innermost) <-> chevron:
  const chevronOf=(i,side)=>settling[side]?i:2-i;
  // The k-th arrow to set off (k=0 is the outermost arrow, filled first, from the nearest chevron) starts after the ones
  // before it and eases in and out over its share of the progress. Settling back runs the other way.
  // Forming: a sine ease in and out (gentle start and finish, no sharp middle). Settling back: the arrow leaves gently and
  // spends longer slowing down before it lands (an ease that is quick through the middle and long at the landing end).
  const clamp01=v=>Math.max(0,Math.min(1,v)),inOut=v=>.5-.5*Math.cos(Math.PI*clamp01(v)),landing=v=>{const p=clamp01(v);return 1-Math.pow(1-(.5-.5*Math.cos(Math.PI*p)),1.6)};
  const ARROW_STAGGER=.18,arrowEase=(progress,i,back=false)=>{const p=(progress-i*ARROW_STAGGER)/(1-2*ARROW_STAGGER);return back?1-landing(1-p):inOut(p)};
  let leadMarkAt=null;const sameCar=t=>t?.slot==='FF'&&leadMarkAt!==null&&Math.abs((t.x||0)-leadMarkAt)<3;
  const road=on('ccncRoad')?frame.ccncRoad:null,o=frame.overlay,smooth=v=>{const c=Math.max(0,Math.min(1,v));return c*c*(3-2*c)};
  if(frame.valid){
   context.save();context.globalCompositeOperation='lighter';
   highlightBands(road).forEach((color,i)=>{if(!color)return;const l=(o.lanes[i]||[]).map(p=>p?xy(p):null),r=(o.lanes[i+1]||[]).map(p=>p?xy(p):null),range=extent(l.concat(r));if(range)fillBand(l,r,fadeStyle(range,color),.16)});
   function roadBands(bands,lines,confidence,baseColor,isLane=true){
    (lines||[]).forEach((points,i)=>{
     const style=laneAppearance(confidence(i),isLane);if(!style.width)return;
     const marking=isLane?laneMarkingStyle(frame,i):null,color=({'#4cd964':'#5fe0ae'})[marking?.color]||marking?.color||baseColor,dashes=marking?.type==='dashed'?o.laneDashBands?.[i]:null;
     const screen=(points||[]).map(p=>p?xy(p):null),range=extent(screen);if(!range)return;
     if(marking?.type==='hidden'){lightLine(screen,color,.3,range,[6,5],false);return}
     const wide=isLane?3:4.5;
     // Dashes keep a tight halo: a wide one around a short bar reads as a box.
     if(dashes){for(const dash of dashes){const sides=dash.map(side=>side.map(p=>p?xy(p):null));lightBand(sides,middle(sides),color,style.edge,range,{body:.34,slim:.8,glow:0,coreWidth:0,outline:.55})}return}
     const sides=bands?.[i];
     if(sides?.length===2)lightBand(sides.map(side=>side.map(p=>p?xy(p):null)),screen,color,style.edge,range,{wide:wide*1.4,slim:.6,body:.4,glow:isLane?0:.03,coreWidth:1.2,outline:isLane?.5:0});  // lanes: no light outside the line itself
     else lightLine(screen,color,style.edge,range,[],!isLane);
    });
   }
   if(on('lanes'))roadBands(o.laneBands,o.lanes,i=>frame.lp[i],'#57d9b0');
   if(on('edges'))roadBands(o.edgeBands,o.edges,i=>edgeConfidence(frame.es[i]),'#ff5c5c',false);
   // The cluster TARGET (앞차거리): today's line, an arc on the ground, or nothing (setting 'leadMark', app.js).
   const sections=o.targetSections,trail=sections?.map(section=>targetSectionPoints(section))||[],target=sections?trail[0]:horizontalTargetLine(o.targetLine);
   const lead=[1,3].includes(road?.target)&&road.distance>0&&road.distance<204.6&&target?.length===2&&target.every(Boolean)?road.distance:null;
   const leadDrawn=lead!==null&&leadMark!=='off',gapShown=leadDrawn&&on('gapTarget')&&Number.isFinite(frame.gapTarget)&&frame.gapTarget>0,tooClose=gapShown&&lead<.85*frame.gapTarget;
   // Model path: projective samples, so any distance along it (lead cut, chevrons, target marks) is exact.
   const xs=o.pathX,P=o.pathProjection,N=o.pathSides,half=modelPathWidth/2;
   const pathAt=d=>{if(!xs||!P)return null;for(let i=1;i<xs.length;i++){if(!(xs[i-1]<=d&&d<=xs[i]&&xs[i]>xs[i-1])||!P[i-1]||!P[i]||!N?.[i-1]||!N[i])continue;const r=(d-xs[i-1])/(xs[i]-xs[i-1]),mix=(a,b)=>a.map((v,k)=>v+(b[k]-v)*r);return {c:mix(P[i-1],P[i]),n:mix(N[i-1],N[i]),f:P[i].map((v,k)=>(v-P[i-1][k])/(xs[i]-xs[i-1]))}}return null};
   const ground=(s,lateral,forward=0)=>proj(s.c.map((v,k)=>v+s.n[k]*lateral+(s.f?.[k]||0)*forward));
   if(on('modelPath')){
    if(P?.length){
     // With a lead shown the carpet stops at it instead of running through the car.
     const cut=lead!==null&&xs?lead:Infinity,samples=[];
     P.forEach((c,i)=>{if(c&&N?.[i]&&(!xs||xs[i]<cut))samples.push({c,n:N[i]})});
     if(Number.isFinite(cut)){const s=pathAt(cut);if(s)samples.push(s)}
     const sides=[-1,1].map(sign=>samples.map(s=>ground(s,sign*half))),full=extent(P.map(proj)),range=extent(sides[0].concat(sides[1]));
     if(range&&full){
      range[2]=full[2];
      const carpet=fadeStyle(range,'#2f86e8',.2);fillBand(...sides,carpet,.2);
      // Edge: a thin crisp line with a narrow halo; a little of its light spreads inward over the carpet's outer part.
      for(const sign of [-1,1]){const edge=sides[(sign+1)/2];for(let k=1;k<=6;k++)fillBand(edge,samples.map(s=>ground(s,sign*half*(1-.045*k))),carpet,.022);strokeLine(edge,carpet,4.5,.2);strokeLine(edge,fadeStyle(range,'#cfe8ff',.2),1.3,.9)}
      // Chevrons pointing forward, fixed to the road (distance travelled) so they flow past like lane dashes. They also
      // carry the drive state, each part keyed to data the log has:
      //  - slowing down: the light turns amber from the apex, deeper the harder the car slows (the lead glow's level);
      //  - target following distance: beyond it they are dim; with the lead well inside it they are not drawn at all;
      //  - longitudinal control not active (from the vehicle data, once loaded): not drawn;
      //  - standing still: they breathe slowly instead of flowing.
      const step=2.5,end=Math.min(Number.isFinite(cut)?cut-3:Infinity,xs?.at(-1)??0,17),phase=motionAllowed()?(((-(frame.odometer||0)*.4)%step)+step)%step:1.5;  // flowing at 40% of the car's own speed: at full speed it raced
      const warm=targetBrakeLevel(data.frames,idx),control=window.rvControlAt?.(t)??null,still=Number.isFinite(frame.egoSpeedKph)&&frame.egoSpeedKph<.5;
      const gapAt=on('gapTarget')&&Number.isFinite(frame.gapTarget)&&frame.gapTarget>0?frame.gapTarget:null,crowded=gapAt!==null&&lead!==null&&lead<.85*gapAt;
      const breathe=still&&motionAllowed()?.55+.45*(.5+.5*Math.cos(t*Math.PI*2/2.4)):1;
      const tint=(base,k)=>mixColor(base,'#ffb257',Math.max(0,Math.min(1,k)));
      const radial=(c,r,stops)=>{const g=context.createRadialGradient(c[0],c[1],0,c[0],c[1],r);for(const [at,a,color] of stops)g.addColorStop(at,rgba(color,a));return g};
      // Slowing down tints the whole chevron, strongest at the apex but reaching the wing ends too.
      const fill=tint('#43e7e0',warm*1.5),fillOut=tint('#43e7e0',warm*1.15),edge=tint('#86fff0',warm*1.3),edgeOut=tint('#86fff0',warm*1.05);
      // One chevron at distance d: its outline on the road and how strongly it shows there.
      const chevronAt=d=>{
       const s=pathAt(d);if(!s)return null;
       let strength=d<end?smooth((d-5.5)/1.2)*smooth(end-d)*smooth((17-d)/6)*breathe:0;if(gapAt!==null&&d>gapAt)strength*=.35;
       // As on the concept board: a band of even thickness in a wide shallow V, about 40% of the path's width.
       const row=back=>[-1,0,1].map(u=>ground(s,u*half*.4,-.52*Math.abs(u)-back)),thick=.4,front=row(0),rear=row(thick);
       if(![...front,...rear].every(Boolean))return null;
       // The wing ends run parallel to the path's edge lines on screen: the lower corner spreads outwards as the edge does.
       for(const k of [0,2]){const a=ground(s,(k-1)*half,-.52),b=ground(s,(k-1)*half,-.52-thick);if(a&&b)rear[k]=[front[k][0]+b[0]-a[0],front[k][1]+b[1]-a[1]]}
       return {front,rear,strength,fill,edge,reach:Math.max(4,Math.hypot(front[2][0]-front[1][0],front[2][1]-front[1][1])),points:[rear[0],front[0],front[1],front[2],rear[2],rear[1]]};
      };
      // The arrows' chevrons, picked when the movement began and followed along the road since. Forming: the three nearest
      // chevrons then. Settling back: three chevrons in a row, the first being the one that will be about 7 m ahead when the
      // innermost arrow lands (the road keeps flowing meanwhile; landing time from the easing, distance from the speed then),
      // so the arrows land near, midway and far with no chevron skipped. Beyond the lead there is no place: that arrow comes
      // from (or goes into) the car instead.
      const odometerAt=time=>data.frames[nearest(time)]?.odometer||0,phaseOf=odometer=>motionAllowed()?(((-odometer*.4)%step)+step)%step:1.5;
      const active=morph[1]>morph[0]?1:0,start=morph[active]>0?states[active].start:null;
      const startAt=5.5+phaseOf(start===null?frame.odometer||0:odometerAt(start)),moved=start!==null&&motionAllowed()?((frame.odometer||0)-odometerAt(start))*.4:0;
      const reachable=Math.min(Number.isFinite(cut)?cut-1:Infinity,xs?.at(-1)??0);
      const speed=motionAllowed()&&start!==null?Math.max(0,(data.frames[nearest(start)]?.egoSpeedKph||0)/3.6*.4):0;
      const first=Math.round((7+speed*(1-2*ARROW_STAGGER)*BLINKER_SETTLE-startAt)/step),ids=settling[active]?[first,first+1,first+2]:[0,1,2];
      if(!crowded&&control!==false)slots=ids.map((id,i)=>{const placed=startAt+id*step,landing=settling[active]?7+2.5*i:placed;return landing<reachable?chevronAt(Math.max(1,placed-moved)):null});
      // (landing: roughly where it lands; only used against the lead)
      for(let d=5.5+phase;!crowded&&control!==false&&d<end;d+=step){
       const c=chevronAt(d);if(!c||c.strength<=.01)continue;
       const {front,rear,reach,strength}=c,n=Math.round((d+moved-startAt)/step);  // n: which of the movement's chevrons this is
       // A chevron whose arrow has set off is no longer on the road (it is that arrow now); chevrons that are not one of the
       // three go while the arrows are up. The others stay and flow until their turn.
       const going=morph[active],rank=ids.indexOf(n);if(going>0&&(rank<0?!settling[active]:arrowEase(going,2-chevronOf(rank,active),settling[active])>0))continue;  // settling: the others keep flowing
       // Fill: fainter than the edges. It holds its light from the apex over most of the wings (an eased curve, not a
       // straight fall) and eases down near the wing ends (about 0.87 of this radius) to a floor of a third, never clear.
       context.fillStyle=radial(front[1],reach*1.15,[[0,.9,fill],[.35,.87,fill],[.55,.8,fill],[.68,.66,fillOut],[.78,.5,fillOut],[.86,.38,fillOut],[.92,.32,fillOut],[1,.3,fillOut]]);context.globalAlpha=.32*strength;  // clearly fainter than the edges
       context.beginPath();[...front,...rear.slice().reverse()].forEach((p,i)=>i?context.lineTo(...p):context.moveTo(...p));context.closePath();context.fill();
       // Front edge: one line from tip to tip, falling to its lowest about 80% of the way out and holding it to the ends.
       const top=radial(front[1],reach*1.05,[[0,1,edge],[.4,.72,edge],[.76,.22,edgeOut],[1,.22,edgeOut]]);
       // Rear edge: lit at its middle, nearly gone a third of the way out, a faint trace beyond.
       const bottom=radial(rear[1],reach*1.05,[[0,.8,edge],[.33,.16,edgeOut],[1,.1,edgeOut]]);
       strokeLine(front,top,3.5,.07*strength);strokeLine(front,top,1.6,.17*strength);strokeLine(front,top,.9,.39*strength);
       strokeLine(rear,bottom,3,.05*strength);strokeLine(rear,bottom,1.4,.12*strength);strokeLine(rear,bottom,.8,.27*strength);
       for(const k of [0,2]){const end=[front[k],rear[k]];strokeLine(end,top,1.4,.1*strength);strokeLine(end,top,.8,.24*strength)}
      }
     }
    }else if(o.path?.length)lightLine(o.path.map(p=>p?xy(p):null),'#58b4ff');
   }
   if(leadDrawn){
    const color=tooClose?'#ff5f5f':road.target===3?'#edf7ff':'#7be5ff',length=8*targetBrakeLevel(data.frames,idx),a=xy(target[0]),b=xy(target[1]);
    const scale=Math.max(.45,Math.min(1.25,Math.abs(b[0]-a[0])/220));
    // 호: the near half of a ring of light on the ground around the lead car's rear, as on the concept board: about the
    // car's width, its ends curling away from us around the car. arcAt(o): that arc moved o metres towards the car along the
    // path (the sections are 0.5 m apart, following its curve).
    const arcAt=o=>{
     const i=Math.floor(o/.5),r=o/.5-i,A=sections?.[i],B=sections?.[i+1];if(!A?.every(Boolean)||!B?.every(Boolean))return null;
     const C=A[0].map((v,k)=>v+(B[0][k]-v)*r),S=A[1].map((v,k)=>v+(B[1][k]-v)*r),F=A[0].map((v,k)=>(v-B[0][k])/.5),w=1.3,depth=1.1;
     const arc=Array.from({length:33},(_,j)=>{const a=Math.PI*j/32;return proj(C.map((v,k)=>v-S[k]*w*Math.cos(a)+F[k]*depth*(1-Math.sin(a))))});
     return arc.every(Boolean)?arc:null;
    };
    let mark=[a,b];
    const arcMark=leadMark==='arc'?arcAt(0):null;if(arcMark)mark=arcMark;
    // The deceleration glow spreads from the mark towards the car, in the mark's own shape: copies of the arc stepping
    // towards the car (or, for the line, lane-following strips), fading with distance. No full-canvas blur.
    if(arcMark){
     for(let o=0;o<length;o+=.125){
      const near=arcAt(Math.min(o+.125,length)),far=arcAt(o);if(!near||!far)break;
      context.fillStyle=sideFade(far,color);context.globalAlpha=.4*(1-(o+.0625)/length)**2;
      context.beginPath();[...far,...near.slice().reverse()].forEach((v,k)=>k?context.lineTo(...v):context.moveTo(...v));context.closePath();context.fill();
     }
    }else for(let i=1;i<trail.length&&((i-1)*.5)<length;i++){
     if(!trail[i-1]||!trail[i])break;
     const mix=(side,r)=>trail[i-1][side].map((v,k)=>v+(trail[i][side][k]-v)*r);
     for(let j=0;j<4;j++){
      const start=(i-1)*.5+j*.125,end=Math.min(start+.125,length);if(end<=start)break;
      const lo=j/4,hi=(end-(i-1)*.5)/.5,p=xy(mix(0,lo)),q=xy(mix(1,lo)),r=xy(mix(1,hi)),s=xy(mix(0,hi));
      context.fillStyle=targetGradient(context,[(p[0]+s[0])/2,(p[1]+s[1])/2],[(q[0]+r[0])/2,(q[1]+r[1])/2],color);
      context.globalAlpha=.4*(1-(start+end)/2/length)**2;
      context.beginPath();[p,q,r,s].forEach((v,k)=>k?context.lineTo(...v):context.moveTo(...v));context.closePath();context.fill();
     }
    }
    // Target following distance: amber bars reaching in from both path edges and a faint dotted arc between them.
    if(gapShown&&!tooClose){
     const s=pathAt(frame.gapTarget),l=s&&ground(s,-half),r=s&&ground(s,half);
     if(l&&r){
      const k=Math.max(.45,Math.min(1.25,Math.abs(r[0]-l[0])/220)),bar=(p,q)=>[p,[p[0]+(q[0]-p[0])*.17,p[1]+(q[1]-p[1])*.17]];
      for(const pts of [bar(l,r),bar(r,l)])lightMark(pts,'#ffcc75',k);
      const dots=Array.from({length:13},(_,i)=>{const u=(i/6-1)*.62;return ground(s,u*half,-Math.max(.6,.2*frame.gapTarget)*u*u)});
      if(dots.every(Boolean))strokeLine(dots,'#ffcc75',1.1*k,.45,[2,5]);
     }
    }
    leadMarkAt=road.distance;
    const arriving=ccncEntries.find(e=>e.shift&&sameCar(e.target));
    leadShape={points:mark.length===MARK?mark:Array.from({length:MARK},(_,i)=>[a[0]+(b[0]-a[0])*i/(MARK-1),a[1]+(b[1]-a[1])*i/(MARK-1)]),color,scale,merge:!!arriving&&!wasLead(arriving.shift.index,arriving.shift.x)};
    if(!leadShape.merge)lightMark(mark,sideFade(mark,color),scale);
    if(on('targetLabels')&&!(on('ccncTargets')&&on('boxLabels')&&(frame.ccncTargets||[]).some(sameCar)))groundLabel(`TARGET · ${road.distance.toFixed(1)} m`,(a[0]+b[0])/2,Math.max(...mark.map(p=>p[1]))+10+9*scale,color,1,11+6*scale,sections?.[0]?.every(Boolean)&&sections[1]?.every(Boolean)?groundBasis(sections[0][0],sections[0][1],sections[0][0].map((v,k)=>(v-sections[1][0][k])/.5)):null);
   }
   context.restore();
  }
  if(frame.valid&&on('bsdWalls')&&bsdHeight>0&&frame.overlay.heightDirection){
   blindspotLevels(data.frames,idx,frame.t).forEach((amount,i)=>{
    if(!amount)return;
    const bottom=[],upper=[],direction=frame.overlay.heightDirection;
    (frame.overlay.blindspotPaths?.[i]||[]).forEach(p=>{
     const q=p?.map((v,k)=>v+direction[k]*bsdHeight*amount);
     const valid=p&&p.every(Number.isFinite)&&p[2]>.1&&q.every(Number.isFinite)&&q[2]>.1;
     bottom.push(valid?xy([p[0]/p[2],p[1]/p[2]]):null);upper.push(valid?xy([q[0]/q[2],q[1]/q[2]]):null);
    });paintBlindspotWall(context,bottom,upper,amount,t,true);
    const wanted=left+vw*(i?.8:.2);let anchor=null;
    // Clip continuous upper edges, then interpolate at the desired screen x.
    // Picking a vertex makes the label jump whenever the nearest sample changes.
    if(on('bsdLabels'))for(let j=1;j<upper.length;j++){
     const a=upper[j-1],b=upper[j];if(!a||!b)continue;
     let lo=0,hi=1;
     for(const [axis,min,max] of [[0,left+12,left+vw-12],[1,top+40,top+vh-12]]){
      const delta=b[axis]-a[axis];
      if(delta===0){if(a[axis]<min||a[axis]>max)hi=-1;continue}
      const t0=(min-a[axis])/delta,t1=(max-a[axis])/delta;
      lo=Math.max(lo,Math.min(t0,t1));hi=Math.min(hi,Math.max(t0,t1));
     }
     if(lo>hi)continue;
     const ratio=Math.max(lo,Math.min(hi,b[0]===a[0]?lo:(wanted-a[0])/(b[0]-a[0])));
     const point=a.map((v,k)=>v+(b[k]-v)*ratio);
     if(!anchor||Math.abs(point[0]-wanted)<Math.abs(anchor[0]-wanted))anchor=point;
    }
    if(anchor){
     context.save();context.globalAlpha=amount;context.strokeStyle='#ffdd76';context.fillStyle='#ffdd76';context.lineWidth=1;
     const labelX=Math.max(left+85,Math.min(left+vw-85,anchor[0]+(i?-65:65)));
     context.beginPath();context.moveTo(...anchor);context.lineTo(anchor[0]+(i?-24:24),anchor[1]-24);context.lineTo(labelX,anchor[1]-24);context.stroke();
     context.shadowColor='#ffd24f';context.shadowBlur=6;context.beginPath();context.arc(...anchor,3,0,Math.PI*2);context.fill();
     hudLabel(context,i?'우측 사각지대 감지':'좌측 사각지대 감지',labelX,anchor[1]-36,'#ffdd76',left+4,left+vw-4);context.restore();
    }
   });
  }
  // Blinker arrows (>>> / <<<), floating at a fixed place ahead of the car rather than on the lane lines. A fully formed side
  // is drawn as before, light running along the three arrows. While a side forms or settles back, each arrow morphs from its
  // own path chevron (the nearest to the outermost arrow, the next one coming in to the second, then the third) or, without
  // one (longitudinal control off, lead close), from a small chevron at the bottom of the picture as if coming out of the
  // car; with no chevron at all this runs more slowly.
  // The three arrows go one after another; each eases in and out on a straight path, outline and colour blending.
  {const arrowLeft=left+12,arrowRight=left+vw-12,arrowY=top+vh*.66,cx=left+vw/2,anchors=[[cx-vw*.16,arrowY],[cx+vw*.16,arrowY]];
   const spring=!slots.some(Boolean);if(spring){states=stateAt(1.3,1.6);morph=states.map(s=>s.progress);settling=states.map(s=>s.settling)}
   drawBlinkers(context,on('ccncRoad')?{blinkerLeft:morph[0]>=1,blinkerRight:morph[1]>=1}:null,t,arrowLeft,arrowRight,arrowY,anchors,true);
   const springFrom=()=>{const y=top+vh*.985,w=vw*.035;return [[cx-w,y+w*.3],[cx-w,y],[cx,y-w*.45],[cx+w,y],[cx+w,y+w*.3],[cx,y-w*.15]]};
   for(const side of [0,1]){
    const progress=morph[side];if(!(progress>0&&progress<1))continue;
    context.save();context.lineWidth=1.5;context.lineJoin='round';
    blinkerArrows(side,arrowLeft,arrowRight,arrowY,anchors).forEach((target,i)=>{
     const order=2-i,e=arrowEase(progress,order,settling[side]),pulse=blinkerPulse(t,i);if(e<=0)return;  // not set off yet: still a chevron on the road (or nothing)
     const source=slots[chevronOf(i,side)],from=source?.points||springFrom(),start=source?source.strength:0;
     // From the car the arrow first heads straight ahead and then curves out to its place: its centre follows a quadratic
     // curve whose control point lies straight ahead of the start, at the target's height; the outline blends on the way.
     // From a chevron it moves straight.
     const centre=q=>q.reduce((c,p)=>[c[0]+p[0]/q.length,c[1]+p[1]/q.length],[0,0]),a0=centre(from),a1=centre(target),bend=[a0[0],a1[1]];
     const path=source?[a0[0]+(a1[0]-a0[0])*e,a0[1]+(a1[1]-a0[1])*e]:[0,1].map(k=>(1-e)*(1-e)*a0[k]+2*(1-e)*e*bend[k]+e*e*a1[k]);
     const points=target.map((p,j)=>[path[0]+(from[j][0]-a0[0])*(1-e)+(p[0]-a1[0])*e,path[1]+(from[j][1]-a0[1])*(1-e)+(p[1]-a1[1])*e]),mix=(a,b)=>a+(b-a)*e;
     context.beginPath();points.forEach((p,j)=>j?context.lineTo(...p):context.moveTo(...p));context.closePath();
     context.shadowBlur=0;context.fillStyle=mixColor(source?.fill||'#43e7e0','#62edb9',e);context.globalAlpha=mix(.3*start,.24*pulse);context.fill();
     context.shadowColor='#a0ffe1';context.shadowBlur=e>=1?4:0;context.strokeStyle=mixColor(source?.edge||'#86fff0','#a0ffe1',e);context.globalAlpha=mix(.4*start,pulse);context.stroke();
    });
    context.restore();
   }}
  // A vehicle (LF · FF · RF): a short arc of light on the ground around its rear and its label on the ground; with
  // 차량 박스 on, the 3D box stands on that mark as light: 1 px edges, brightest at the ground and fading upward (the top
  // nearly invisible), far face and depth edges dimmer, faces almost clear. LF/RF are dimmer than FF.
  function drawBox(marker,color,target,growth=1,opacity=1,shift=null){
   const animatedHeight=boxHeight*growth,boxes=on('vehicleBoxes'),dim=target.slot==='FF'?1:.65;
   if(marker.box?.length!==8)return;
   const projected=marker.box.map((p,i)=>i<4?p:p.map((v,j)=>marker.box[i-4][j]+(v-marker.box[i-4][j])*animatedHeight/1.5));
   if(!projected.every(p=>p?.length===3&&p.every(Number.isFinite)&&p[2]>.1))return;
   const corners=projected.map(p=>xy([p[0]/p[2],p[1]/p[2]]));
   context.save();context.globalCompositeOperation='lighter';
   const [b0,b1,b2]=marker.box,F=b0.map((v,k)=>(b2[k]-v)/4.5),scale=Math.max(.4,Math.min(1.3,Math.hypot(corners[1][0]-corners[0][0],corners[1][1]-corners[0][1])/110));
   const ring=(w,depth,back)=>Array.from({length:MARK},(_,i)=>{const a=Math.PI*i/(MARK-1);return [0,1,2].map(k=>(b0[k]+b1[k])/2-(b1[k]-b0[k])/1.8*w*Math.cos(a)+F[k]*(depth*(1-Math.sin(a))-back))}).map(q=>q[2]>.1?xy([q[0]/q[2],q[1]/q[2]]):null),mark=ring(1.08,1,.3);
   const markAlpha=opacity*dim*(boxes?1:.4+.6*growth);
   let points=mark,tone=color,size=scale,strength=markAlpha,skip=sameCar(target);
   if(shift&&mark.every(Boolean)){
    if(skip&&leadShape){  // arriving at the lead: the ring grows into the lead mark (or dissolves into one already shown)
     points=blend(mark,leadShape.points,shift.k);tone=mixColor(color,leadShape.color,shift.k);size=scale+(leadShape.scale-scale)*shift.k;
     strength=leadShape.merge?markAlpha+(1-markAlpha)*shift.k:markAlpha*(1-shift.k);skip=false;
    }else if(shift.slot==='FF'&&wasLead(shift.index,shift.x)&&!skip){  // it was the lead and left: the lead mark's shape shrinks to the ring
     const wide=ring(1.3,1.1,0),k=1-shift.k;if(wide.every(Boolean)){points=blend(mark,wide,k);tone=mixColor(color,'#7be5ff',k);strength=markAlpha+(opacity-markAlpha)*k}
    }
   }
   if(points.every(Boolean)&&!skip)lightMark(points,sideFade(points,tone),size,strength);
   if(boxes){
    const faces=(animatedHeight===0?[[0,1,3,2]]:[[0,1,5,4],[4,5,7,6],[1,3,7,5],[2,0,4,6],[3,2,6,7],[0,2,3,1]]).map(face=>{
     const points=face.map(i=>corners[i]),area=points.reduce((sum,p,i)=>{const q=points[(i+1)%points.length];return sum+p[0]*q[1]-q[0]*p[1]},0);
     return {face,points,front:animatedHeight===0||area<0};
    });
    // Faces: a faint wash rising from the ground (the opacity slider), front faces only so nothing stacks up.
    for(const {points,front} of faces){
     if(!front||boxOpacity<=0||animatedHeight===0)continue;const ys=points.map(p=>p[1]),gradient=context.createLinearGradient(0,Math.max(...ys),0,Math.min(...ys)-1);
     gradient.addColorStop(0,rgba(color,.35*boxOpacity));gradient.addColorStop(1,rgba(color,0));context.fillStyle=gradient;context.globalAlpha=opacity*dim;
     context.beginPath();points.forEach(([x,y],i)=>i?context.lineTo(x,y):context.moveTo(x,y));context.closePath();context.fill();
    }
    const edges=new Map();
    for(const {face,front} of faces)face.forEach((a,i)=>{const b=face[(i+1)%face.length],key=[a,b].sort((a,b)=>a-b).join(':');edges.set(key,{a:Math.min(a,b),b:Math.max(a,b),front:front||edges.get(key)?.front})});
    for(const {a,b,front} of edges.values()){
     const base=opacity*dim*(front?1:.4*(1-.5*boxOpacity)),level=i=>i<4?.95:.1;
     const style=a<4&&b>=4?(()=>{const g=context.createLinearGradient(...corners[a],...corners[b]);g.addColorStop(0,rgba(color,level(a)));g.addColorStop(1,rgba(color,level(b)));return g})():rgba(color,level(a));
     if(b<4)strokeLine([corners[a],corners[b]],style,3,.2*base);
     strokeLine([corners[a],corners[b]],style,1,base,[],1);  // already a hairline: 1 px on every picture size
    }
   }
   context.restore();
   const text=label(target),below=!boxes||on('boxLabelsBelow');
   if(on('boxLabels')&&text){
    if(below)groundLabel(`${target.slot} · ${text}`,(corners[0][0]+corners[1][0])/2,Math.max(...(mark.every(Boolean)?mark:corners.slice(0,4)).map(p=>p[1]))+10+9*scale,color,opacity,11+6*scale,groundBasis(b0.map((v,k)=>(v+b1[k])/2),b0.map((v,k)=>(b1[k]-v)/1.8),F));
    else{context.save();context.globalAlpha=opacity;hudLabel(context,`${target.slot} · ${text}`,(corners[4][0]+corners[5][0])/2,Math.min(...corners.slice(4).map(p=>p[1]))-14,color,left+4,left+vw-4,true);context.restore()}
   }
  }
  context.font='11px "Pretendard Variable", system-ui';context.textAlign='center';
  if(on('ccncTargets')){
   const boxes=ccncEntries.slice().sort((a,b)=>b.target.x-a.target.x);
   boxAnimating=boxes.some(entry=>entry.animated);
   for(const entry of boxes)drawBox(entry.marker,entry.color,entry.target,entry.height,entry.alpha,entry.shift);
  }
  for(const marker of frame.overlay.markers){
   if(marker.kind==='ccnc')continue;
   let target,color='#81b5ff',shape='circle';
   if(marker.kind==='raw'){
    if(!on('liveTracks')||!frame.liveTracksValid)continue;
    target=frame.liveTracks[marker.index];
    if(on('hideScc')&&String(target?.source).toLowerCase()==='scc')continue;
    color='#78e9fa';shape='cross';
   }else{
    if(!frame.valid)continue;
    if(marker.kind==='radar'){
     target=frame.radarTargets[marker.index];const styles={center:['radarCenter','#d09aff'],left:['radarLeft','#ffda76'],right:['radarRight','#ff91b5']},style=styles[target?.group];
     if(!style||!on(style[0]))continue;color=style[1];shape='box';
    }else{
     if(!on('leads'))continue;
     target=marker.kind==='selected'?frame.selected:frame.leads[marker.index];
     if(marker.kind==='selected'){color='#eee7bc';shape='diamond'}
    }
   }
   if(!target)continue;
   let point=marker.point;
   if(height>0){
    if(!marker.projection||!frame.overlay.heightDirection)continue;
    const projected=marker.projection.map((v,i)=>v+frame.overlay.heightDirection[i]*height/100);
    if(projected[2]<=.1)continue;
    point=[projected[0]/projected[2],projected[1]/projected[2]];
   }
   if(!point)continue;
   const [x,y]=xy(point);
   if(x<left||x>left+vw||y<top||y>top+vh)continue;
   context.globalAlpha=target.p<.5?.45:1;context.strokeStyle=color;context.lineWidth=2;context.beginPath();
   if(shape==='box')context.rect(x-7,y-10,14,10);
   else if(shape==='diamond'){context.moveTo(x,y-10);context.lineTo(x+6,y-5);context.lineTo(x,y);context.lineTo(x-6,y-5);context.closePath()}
   else if(shape==='cross'){context.moveTo(x-4,y-4);context.lineTo(x+4,y+4);context.moveTo(x-4,y+4);context.lineTo(x+4,y-4)}
   else context.arc(x,y-5,5,0,Math.PI*2);
   context.stroke();
   if(height>0){const [gx,gy]=xy(marker.point);context.beginPath();context.moveTo(x,y);context.lineTo(gx,gy);context.stroke()}
   if(marker.kind!=='raw'||on('liveTrackLabels')){
    const text=label(target);if(text){context.lineWidth=3;context.strokeStyle='#000c';context.strokeText(text,x,y-15);context.fillStyle=color;context.fillText(text,x,y-15)}
   }
   context.globalAlpha=1;
  }
  context.restore();
  status.textContent='';
 };
 heightButton.onclick=()=>{raised=!raised;heightButton.setAttribute('aria-pressed',String(raised));try{localStorage.setItem('roadviewer-overlay-height',String(raised))}catch{}moveHeight()};
 button.onclick=()=>{
  const opacity=layer.hidden?0:Number(getComputedStyle(layer).opacity);
  if(fade){fade.onfinish=null;fade.cancel();fade=null}enabled=!enabled;
  button.setAttribute('aria-pressed',String(enabled));
  try{localStorage.setItem('roadviewer-video-overlay',String(enabled))}catch{}
  layer.style.opacity=enabled?'1':'0';
  if(motionAllowed()&&!video.hidden){
   fade=layer.animate([{opacity},{opacity:enabled?1:0}],{duration:200,easing:'cubic-bezier(.4,0,.2,1)'});
   fade.onfinish=()=>{fade=null;render()};
  }
  render();
 };
 const heightDialog=document.getElementById('overlayHeightDialog'),settings=document.getElementById('overlayHeightSettings'),slider=document.getElementById('overlayHeightRange'),value=document.getElementById('overlayHeightValue');
 let oldOverflow='';
 const syncHeight=()=>{slider.value=String(heightCm);value.textContent=heightCm+' cm';heightButton.title='차량 위치 표식을 지면에서 '+heightCm+'cm 높이고 바닥까지 연결합니다.'};
 const setHeight=cm=>{heightCm=Math.max(0,Math.min(200,Math.round(Number(cm)||0)));syncHeight();try{localStorage.setItem('roadviewer-overlay-height-cm',String(heightCm))}catch{}moveHeight()};
 slider.oninput=()=>setHeight(slider.value);document.getElementById('overlayHeightReset').onclick=()=>setHeight(60);
 settings.onclick=()=>{if(heightDialog.open)return;oldOverflow=document.body.style.overflow;document.body.style.overflow='hidden';heightDialog.showModal();document.getElementById('overlayHeightClose').focus({preventScroll:true})};
 const closeHeight=()=>heightDialog.close();document.getElementById('overlayHeightClose').onclick=closeHeight;
 heightDialog.addEventListener('cancel',e=>{e.preventDefault();closeHeight()});
 heightDialog.addEventListener('close',()=>{document.body.style.overflow=oldOverflow;settings.focus({preventScroll:true})});
 heightDialog.addEventListener('click',e=>{if(e.target!==heightDialog)return;const r=heightDialog.getBoundingClientRect();if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)closeHeight()});
 syncHeight();
 for(const id of ['ccncBoxHeight','ccncOpacity','modelPathWidth','bsdHeight'])document.getElementById(id+'Reset').onclick=()=>{
  const input=document.getElementById(id);input.value=input.defaultValue;input.dispatchEvent(new Event('input',{bubbles:true}));
 };
 new ResizeObserver(()=>{measureStage();render()}).observe(layer.parentElement);
 video.addEventListener('loadedmetadata',()=>render());
 render();
})();
