'use strict';
(()=>{
 const layer=document.getElementById('videoOverlay'),context=layer.getContext('2d'),video=document.getElementById('video'),button=document.getElementById('videoOverlayToggle'),status=document.getElementById('overlayStatus');
 let boxOpacity=.3;
 const opacitySlider=document.getElementById('ccncOpacity'),opacityValue=document.getElementById('ccncOpacityValue');
 try{const saved=localStorage.getItem('roadviewer-ccnc-opacity');if(saved!==null&&Number.isFinite(Number(saved)))boxOpacity=Math.max(0,Math.min(1,Number(saved)))}catch{}
 const syncOpacity=()=>{opacitySlider.value=String(Math.round(boxOpacity*100));opacityValue.textContent=opacitySlider.value+'%'};
 syncOpacity();
 opacitySlider.oninput=()=>{boxOpacity=Number(opacitySlider.value)/100;syncOpacity();try{localStorage.setItem('roadviewer-ccnc-opacity',String(boxOpacity))}catch{}render()};
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
  if(frame.valid){
   if(on('lanes'))frame.overlay.lanes.forEach((points,i)=>{const style=laneAppearance(frame.lp[i]);line(points,'#57d9b0',false,style.alpha,style.width)});
   if(on('edges'))frame.overlay.edges.forEach((points,i)=>line(points,'#ffa665',frame.es[i]>1));
   if(on('modelPath'))line(frame.overlay.path,'#c4a5ff');
  }
  function drawBox(marker,color,target){
   if(marker.box?.length!==8||!marker.box.every(p=>p?.length===3&&p.every(Number.isFinite)&&p[2]>.1))return;
   const corners=marker.box.map(p=>xy([p[0]/p[2],p[1]/p[2]]));
   const faces=[[0,1,5,4],[4,5,7,6],[1,3,7,5],[2,0,4,6],[3,2,6,7]];
   context.save();context.fillStyle=color;context.strokeStyle=color;context.lineWidth=1.2;
   for(const face of faces){
    const points=face.map(i=>corners[i]);
    const area=points.reduce((sum,p,i)=>{const q=points[(i+1)%points.length];return sum+p[0]*q[1]-q[0]*p[1]},0);
    if(area>=0)continue; // Only camera-facing surfaces: no doubled alpha through the box.
    context.beginPath();points.forEach(([x,y],i)=>i?context.lineTo(x,y):context.moveTo(x,y));context.closePath();
    context.globalAlpha=boxOpacity;context.fill();context.globalAlpha=.85;context.stroke();
   }
   context.globalAlpha=1;
   const text=label(target),x=(corners[4][0]+corners[5][0])/2,y=Math.min(...corners.slice(4).map(p=>p[1]))-8;
   if(text){context.lineWidth=3;context.strokeStyle='#000c';context.strokeText(`${target.slot} · ${text}`,x,y);context.fillStyle=color;context.fillText(`${target.slot} · ${text}`,x,y)}
   context.restore();
  }
  context.font='11px system-ui';context.textAlign='center';
  for(const marker of [...frame.overlay.markers].sort((a,b)=>a.kind==='ccnc'&&b.kind==='ccnc'?(frame.ccncTargets[b.index].x-frame.ccncTargets[a.index].x):a.kind==='ccnc'?-1:b.kind==='ccnc'?1:0)){
   let target,color='#81b5ff',shape='circle';
   if(marker.kind==='ccnc'){
    if(!on('ccncTargets'))continue;
    target=frame.ccncTargets?.[marker.index];color=target?.detect%2?'#94a5b8':'#f4f7fb';shape='box';
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
