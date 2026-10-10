'use strict';
(()=>{
 const layer=document.getElementById('videoOverlay'),context=layer.getContext('2d'),video=document.getElementById('video'),button=document.getElementById('videoOverlayToggle'),status=document.getElementById('overlayStatus');
 let boxOpacity=.3;
 const opacitySlider=document.getElementById('ccncOpacity'),opacityValue=document.getElementById('ccncOpacityValue');
 try{const saved=localStorage.getItem('roadviewer-ccnc-opacity');if(saved!==null&&Number.isFinite(Number(saved)))boxOpacity=Math.max(0,Math.min(1,Number(saved)))}catch{}
 const syncOpacity=()=>{opacitySlider.value=String(Math.round(boxOpacity*100));opacityValue.textContent=opacitySlider.value+'%'};
 syncOpacity();
 opacitySlider.oninput=()=>{boxOpacity=Number(opacitySlider.value)/100;syncOpacity();try{localStorage.setItem('roadviewer-ccnc-opacity',String(boxOpacity))}catch{}render()};
 let boxHeight=1.5;
 const boxHeightSlider=document.getElementById('ccncBoxHeight'),boxHeightValue=document.getElementById('ccncBoxHeightValue');
 try{const saved=localStorage.getItem('roadviewer-ccnc-box-height');if(saved!==null&&Number.isFinite(Number(saved)))boxHeight=Math.max(0,Math.min(3,Number(saved)))}catch{}
 const syncBoxHeight=()=>{boxHeightSlider.value=String(Math.round(boxHeight*100));boxHeightValue.textContent=boxHeight.toFixed(2)+' m'};
 syncBoxHeight();boxHeightSlider.oninput=()=>{boxHeight=Number(boxHeightSlider.value)/100;syncBoxHeight();try{localStorage.setItem('roadviewer-ccnc-box-height',String(boxHeight))}catch{}render()};
 let enabled=false,raised=true,heightCm=60;
 try{const saved=localStorage.getItem('roadviewer-overlay-height-cm');if(saved!==null&&Number.isFinite(Number(saved)))heightCm=Math.max(0,Math.min(200,Math.round(Number(saved))))}catch{}
 const heightButton=document.getElementById('overlayHeight');
 try{raised=localStorage.getItem('roadviewer-overlay-height')!=='false'}catch{}
 heightButton.setAttribute('aria-pressed',String(raised));
 try{enabled=localStorage.getItem('roadviewer-video-overlay')==='true'}catch{}
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
 window.renderVideoOverlayMotion=()=>{if(heightMotion&&data)window.renderVideoOverlay(data.frames[idx],frameAvailable(data.frames[idx]))};
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
 window.renderVideoOverlay=(frame,available)=>{
  const height=currentHeight();
  const w=layer.parentElement.clientWidth,h=layer.parentElement.clientHeight,dpr=devicePixelRatio||1;
  if(layer.width!==Math.round(w*dpr)||layer.height!==Math.round(h*dpr)){layer.width=Math.round(w*dpr);layer.height=Math.round(h*dpr)}
  context.setTransform(dpr,0,0,dpr,0,0);context.clearRect(0,0,w,h);
  layer.hidden=(!enabled&&!fade)||video.hidden;status.textContent='';
  if(!enabled&&!fade)return;
  if(video.hidden){status.textContent='영상이 있는 구간에서 표시됩니다.';return}
  if(!available){status.textContent='이 구간에는 로그 데이터가 없습니다.';return}
  if(!frame.overlay){status.textContent='카메라 보정·센서 정보가 없어 겹쳐 표시할 수 없습니다.';return}
  if(!video.videoWidth||!video.videoHeight)return;
  const ratio=Math.min(w/video.videoWidth,h/video.videoHeight),vw=video.videoWidth*ratio,vh=video.videoHeight*ratio,left=(w-vw)/2,top=(h-vh)/2;
  const xy=p=>[left+p[0]*vw,top+p[1]*vh];
  context.save();context.beginPath();context.rect(left,top,vw,vh);context.clip();
  function line(points,color,dashed=false,alpha=1,width=2){
   context.beginPath();let connected=false;
   for(const point of points||[]){if(!point){connected=false;continue}const [x,y]=xy(point);if(connected)context.lineTo(x,y);else context.moveTo(x,y);connected=true}
   context.strokeStyle=color;context.lineWidth=width;context.globalAlpha=alpha;context.setLineDash(dashed?[6,5]:[]);context.stroke();context.setLineDash([]);context.globalAlpha=1;
  }
  const road=on('ccncRoad')?frame.ccncRoad:null;
  if(frame.valid){
   highlightBands(road).forEach((color,i)=>{if(color)paintBand(context,(frame.overlay.lanes[i]||[]).map(p=>p?xy(p):null),(frame.overlay.lanes[i+1]||[]).map(p=>p?xy(p):null),color,.1,.55,true)});
   if(on('modelPath')){
    if(frame.overlay.pathProjection?.length){
     const sides=[-1,1].map(sign=>frame.overlay.pathProjection.map((p,i)=>{
      const normal=frame.overlay.pathSides[i];if(!p||!normal)return null;
      const q=p.map((v,j)=>v+normal[j]*modelPathWidth/2*sign);
      return q.every(Number.isFinite)&&q[2]>.1?xy([q[0]/q[2],q[1]/q[2]]):null;
     }));paintBand(context,...sides,'#c4a5ff',.1,.6);
    }else line(frame.overlay.path,'#c4a5ff');
   }
   if(on('lanes'))frame.overlay.lanes.forEach((points,i)=>paintLane(context,points.map(p=>p?xy(p):null),frame.lp[i]));
   if(on('edges'))frame.overlay.edges.forEach((points,i)=>line(points,'#ffa665',frame.es[i]>1));
   const target=frame.overlay.targetLine;
   if([1,3].includes(road?.target)&&road.distance>0&&road.distance<204.6&&road.distance<=Number(document.getElementById('range').value)&&target?.length===2&&target.every(Boolean)){
    const color=road.target===3?'#edf7ff':'#7be5ff';context.save();context.shadowColor=color;context.shadowBlur=7;line(target,color,false,.95,3);context.restore();
    const a=xy(target[0]),b=xy(target[1]);hudLabel(context,`TARGET · ${road.distance.toFixed(1)} m`,(a[0]+b[0])/2,Math.min(a[1],b[1])-18,color,left+4,left+vw-4);
   }
  }
  if(frame.valid&&on('ccncRoad')&&frame.overlay.heightDirection){
   blindspotLevels(data.frames,idx,frame.t).forEach((amount,i)=>{
    if(!amount)return;
    const bottom=[],upper=[],depths=frame.overlay.laneDepths?.[i]||[],direction=frame.overlay.heightDirection;
    (frame.overlay.lanes[i+1]||[]).forEach((p,j)=>{
     const depth=depths[j],q=p&&Number.isFinite(depth)&&depth>.1?[p[0]*depth,p[1]*depth,depth].map((v,k)=>v+direction[k]*1.2*amount):null;
     const valid=q&&q.every(Number.isFinite)&&q[2]>.1;
     bottom.push(valid?xy(p):null);upper.push(valid?xy([q[0]/q[2],q[1]/q[2]]):null);
    });paintBlindspotWall(context,bottom,upper,amount,frame.t);
    const candidates=upper.filter(p=>p&&p[0]>left+12&&p[0]<left+vw-12&&p[1]>top+40&&p[1]<top+vh-12);
    if(candidates.length){
     const wanted=left+vw*(i?.8:.2),anchor=candidates.reduce((a,b)=>Math.abs(a[0]-wanted)<Math.abs(b[0]-wanted)?a:b);
     context.save();context.globalAlpha=amount;context.strokeStyle='#ffdd76';context.fillStyle='#ffdd76';context.lineWidth=1;
     context.beginPath();context.moveTo(...anchor);context.lineTo(anchor[0],anchor[1]-24);context.stroke();
     context.shadowColor='#ffd24f';context.shadowBlur=6;context.beginPath();context.arc(...anchor,2,0,Math.PI*2);context.fill();
     hudLabel(context,i?'우측 사각지대 감지':'좌측 사각지대 감지',anchor[0],anchor[1]-36,'#ffdd76',left+4,left+vw-4);context.restore();
    }
   });
  }
  drawBlinkers(context,on('ccncRoad')?(frame.roadSignals??road):null,frame.t,left+12,left+vw-12,top+vh*.72,blinkerLaneAnchors(frame.valid?frame.overlay.lanes:null).map(xy));
  function drawBox(marker,color,target){
   if(marker.box?.length!==8)return;
   const projected=marker.box.map((p,i)=>i<4?p:p.map((v,j)=>marker.box[i-4][j]+(v-marker.box[i-4][j])*boxHeight/1.5));
   if(!projected.every(p=>p?.length===3&&p.every(Number.isFinite)&&p[2]>.1))return;
   const corners=projected.map(p=>xy([p[0]/p[2],p[1]/p[2]]));
   const faces=(boxHeight===0?[[0,1,3,2]]:[[0,1,5,4],[4,5,7,6],[1,3,7,5],[2,0,4,6],[3,2,6,7],[0,2,3,1]]).map(face=>{
    const points=face.map(i=>corners[i]),area=points.reduce((sum,p,i)=>{const q=points[(i+1)%points.length];return sum+p[0]*q[1]-q[0]*p[1]},0);
    return {face,points,front:boxHeight===0||area<0,depth:face.reduce((sum,i)=>sum+projected[i][2],0)/face.length};
   }).sort((a,b)=>b.depth-a.depth);
   context.save();context.fillStyle=color;context.strokeStyle=color;context.lineWidth=1;
   for(const {points} of faces){
    const ys=points.map(p=>p[1]),gradient=context.createLinearGradient(0,Math.min(...ys),0,Math.max(...ys)+1);
    gradient.addColorStop(0,color);gradient.addColorStop(1,'#246a9f');context.fillStyle=gradient;
    context.beginPath();points.forEach(([x,y],i)=>i?context.lineTo(x,y):context.moveTo(x,y));context.closePath();
    context.globalAlpha=boxHeight===0?boxOpacity:1-Math.sqrt(1-boxOpacity);context.fill();
   }
   const edges=new Map();
   for(const {face,front} of faces)face.forEach((a,i)=>{const b=face[(i+1)%face.length],key=[a,b].sort((a,b)=>a-b).join(':');edges.set(key,{a,b,front:front||edges.get(key)?.front})});
   for(const {a,b,front} of edges.values()){
    context.shadowColor=color;context.shadowBlur=front?5:2;context.globalAlpha=front?.95:.4*(1-boxOpacity);context.beginPath();context.moveTo(...corners[a]);context.lineTo(...corners[b]);context.stroke();
   }
   context.fillStyle=color;context.globalAlpha=.9;
   const visibleCorners=new Set([...edges.values()].filter(e=>e.front||boxOpacity<1).flatMap(e=>[e.a,e.b]));
   for(const i of visibleCorners){context.beginPath();context.arc(...corners[i],1.5,0,Math.PI*2);context.fill()}
   context.shadowBlur=0;context.globalAlpha=1;
   const text=label(target),x=(corners[4][0]+corners[5][0])/2,y=Math.min(...corners.slice(4).map(p=>p[1]))-8;
   if(text)hudLabel(context,`${target.slot} · ${text}`,x,y-6,color,left+4,left+vw-4);
   context.restore();
  }
  context.font='11px system-ui';context.textAlign='center';
  for(const marker of [...frame.overlay.markers].sort((a,b)=>a.kind==='ccnc'&&b.kind==='ccnc'?(frame.ccncTargets[b.index].x-frame.ccncTargets[a.index].x):a.kind==='ccnc'?-1:b.kind==='ccnc'?1:0)){
   let target,color='#81b5ff',shape='circle';
   if(marker.kind==='ccnc'){
    if(!on('ccncTargets'))continue;
    target=frame.ccncTargets?.[marker.index];color=target?.detect%2?'#4aaaff':'#8deeff';shape='box';
   }else if(marker.kind==='raw'){
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
   if(!target||target.x>Number(document.getElementById('range').value))continue;
   if(marker.kind==='ccnc'){drawBox(marker,color,target);continue}
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
  status.textContent=on('ccncTargets')?'LF · FF · RF 박스는 지면에 고정됩니다. 크기는 추정값입니다.':'차량은 위치 표식으로 표시됩니다.';
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
 settings.onclick=()=>{if(heightDialog.open)return;oldOverflow=document.body.style.overflow;document.body.style.overflow='hidden';heightDialog.showModal();slider.focus({preventScroll:true})};
 const closeHeight=()=>heightDialog.close();document.getElementById('overlayHeightClose').onclick=closeHeight;
 heightDialog.addEventListener('cancel',e=>{e.preventDefault();closeHeight()});
 heightDialog.addEventListener('close',()=>{document.body.style.overflow=oldOverflow;settings.focus({preventScroll:true})});
 heightDialog.addEventListener('click',e=>{if(e.target!==heightDialog)return;const r=heightDialog.getBoundingClientRect();if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)closeHeight()});
 syncHeight();
 new ResizeObserver(()=>render()).observe(layer.parentElement);
 video.addEventListener('loadedmetadata',()=>render());
 render();
})();
