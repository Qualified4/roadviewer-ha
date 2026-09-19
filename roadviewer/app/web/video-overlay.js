'use strict';
(()=>{
 const layer=document.getElementById('videoOverlay'),context=layer.getContext('2d'),video=document.getElementById('video'),button=document.getElementById('videoOverlayToggle'),status=document.getElementById('overlayStatus');
 let enabled=false,raised=true,heightCm=30;
 try{const saved=localStorage.getItem('roadviewer-overlay-height-cm');if(saved!==null&&Number.isFinite(Number(saved)))heightCm=Math.max(0,Math.min(200,Math.round(Number(saved))))}catch{}
 const heightButton=document.getElementById('overlayHeight');
 try{raised=localStorage.getItem('roadviewer-overlay-height')!=='false'}catch{}
 heightButton.setAttribute('aria-pressed',String(raised));
 try{enabled=localStorage.getItem('roadviewer-video-overlay')==='true'}catch{}
 button.setAttribute('aria-pressed',String(enabled));
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
  const w=layer.parentElement.clientWidth,h=layer.parentElement.clientHeight,dpr=devicePixelRatio||1;
  if(layer.width!==Math.round(w*dpr)||layer.height!==Math.round(h*dpr)){layer.width=Math.round(w*dpr);layer.height=Math.round(h*dpr)}
  context.setTransform(dpr,0,0,dpr,0,0);context.clearRect(0,0,w,h);
  layer.hidden=!enabled||video.hidden;status.textContent='';
  if(!enabled)return;
  if(video.hidden){status.textContent='영상이 있는 구간에서 표시됩니다.';return}
  if(!available){status.textContent='이 구간에는 로그 데이터가 없습니다.';return}
  if(!frame.overlay){status.textContent='카메라 보정·센서 정보가 없어 겹쳐 표시할 수 없습니다.';return}
  if(!video.videoWidth||!video.videoHeight)return;
  const ratio=Math.min(w/video.videoWidth,h/video.videoHeight),vw=video.videoWidth*ratio,vh=video.videoHeight*ratio,left=(w-vw)/2,top=(h-vh)/2;
  const xy=p=>[left+p[0]*vw,top+p[1]*vh];
  context.save();context.beginPath();context.rect(left,top,vw,vh);context.clip();
  function line(points,color,dashed=false,alpha=1){
   context.beginPath();let connected=false;
   for(const point of points||[]){if(!point){connected=false;continue}const [x,y]=xy(point);if(connected)context.lineTo(x,y);else context.moveTo(x,y);connected=true}
   context.strokeStyle=color;context.lineWidth=2;context.globalAlpha=alpha;context.setLineDash(dashed?[6,5]:[]);context.stroke();context.setLineDash([]);context.globalAlpha=1;
  }
  if(frame.valid){
   if(on('lanes'))frame.overlay.lanes.forEach((points,i)=>line(points,'#57d9b0',frame.lp[i]<.5,frame.lp[i]<.5?.4:.9));
   if(on('edges'))frame.overlay.edges.forEach((points,i)=>line(points,'#ffa665',frame.es[i]>1));
   if(on('modelPath'))line(frame.overlay.path,'#c4a5ff');
  }
  context.font='11px system-ui';context.textAlign='center';
  for(const marker of frame.overlay.markers){
   let target,color='#81b5ff',shape='circle';
   if(marker.kind==='raw'){
    if(!on('liveTracks')||!frame.liveTracksValid)continue;
    target=frame.liveTracks[marker.index];color='#78e9fa';shape='cross';
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
   let point=marker.point;
   if(raised&&heightCm>0){
    if(!marker.projection||!frame.overlay.heightDirection)continue;
    const projected=marker.projection.map((v,i)=>v+frame.overlay.heightDirection[i]*heightCm/100);
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
   if(raised&&heightCm>0){const [gx,gy]=xy(marker.point);context.beginPath();context.moveTo(x,y);context.lineTo(gx,gy);context.stroke()}
   if(marker.kind!=='raw'||on('liveTrackLabels')){
    const text=label(target);if(text){context.lineWidth=3;context.strokeStyle='#000c';context.strokeText(text,x,y-15);context.fillStyle=color;context.fillText(text,x,y-15)}
   }
   context.globalAlpha=1;
  }
  context.restore();
  status.textContent='차량은 위치 표식으로 표시됩니다.';
 };
 heightButton.onclick=()=>{raised=!raised;heightButton.setAttribute('aria-pressed',String(raised));try{localStorage.setItem('roadviewer-overlay-height',String(raised))}catch{}render()};
 button.onclick=()=>{enabled=!enabled;button.setAttribute('aria-pressed',String(enabled));try{localStorage.setItem('roadviewer-video-overlay',String(enabled))}catch{}render()};
 const heightDialog=document.getElementById('overlayHeightDialog'),settings=document.getElementById('overlayHeightSettings'),slider=document.getElementById('overlayHeightRange'),value=document.getElementById('overlayHeightValue');
 let oldOverflow='';
 const syncHeight=()=>{slider.value=String(heightCm);value.textContent=heightCm+' cm';heightButton.title='차량 위치 표식을 지면에서 '+heightCm+'cm 높이고 바닥까지 연결합니다.'};
 const setHeight=cm=>{heightCm=Math.max(0,Math.min(200,Math.round(Number(cm)||0)));syncHeight();try{localStorage.setItem('roadviewer-overlay-height-cm',String(heightCm))}catch{}render()};
 slider.oninput=()=>setHeight(slider.value);document.getElementById('overlayHeightReset').onclick=()=>setHeight(30);
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
