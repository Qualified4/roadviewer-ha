'use strict';
const $=id=>document.getElementById(id),v=$('video'),canvas=$('road'),ctx=canvas.getContext('2d');
let data=null,t=0,idx=0,playing=false,last=0,loading=false;
const checked=id=>$(id).checked;
function clock(n){n=Math.max(0,n);return `${Math.floor(n/60)}:${(n%60).toFixed(2).padStart(5,'0')}`}
function nearest(time){const f=data.frames;let a=0,b=f.length-1;while(a<b){const m=(a+b)>>1;if(f[m].t<time)a=m+1;else b=m}return a>0&&Math.abs(f[a-1].t-time)<Math.abs(f[a].t-time)?a-1:a}
function pause(){playing=false;pauseVideo();$('play').textContent='재생'}
let videoPlayPending=false,videoPauseRevision=0;
function pauseVideo(){videoPauseRevision++;v.pause()}
const LOG_EDGE_TOLERANCE=.1;
function recordingEndTolerance(cadence){
 return Math.min(.25,Math.max(LOG_EDGE_TOLERANCE,Number.isFinite(cadence)&&cadence>0?cadence*3:0));
}
function sampleEndTolerance(times){
 const recent=times.slice(-12),intervals=recent.slice(1).map((time,i)=>time-recent[i]).filter(dt=>dt>0);
 if(intervals.length<3)return LOG_EDGE_TOLERANCE;
 const cadence=[...intervals].sort((a,b)=>a-b)[Math.floor(intervals.length/2)];
 // Missing tail samples are not an end-time rounding error.
 if(intervals.slice(-3).some(dt=>dt>cadence*2+1e-6))return 0;
 return recordingEndTolerance(cadence);
}
function recordingEndAvailable(end,tolerance){
 const tail=data.duration-end;
 return Number.isFinite(end)&&t>=end-1e-6&&t<=data.duration+1e-6&&tail>=-1e-6&&tail<=tolerance+1e-6;
}
function finalVideoFrame(){
 if(!data?.video)return false;
 const video=data.video,cadence=video.frames>0?video.duration/video.frames:null;
 return recordingEndAvailable(video.start+video.duration,recordingEndTolerance(cadence));
}
function videoAvailable(){return !!data?.video&&t>=data.video.start&&(t<data.video.start+data.video.duration||finalVideoFrame())}
function finalModelFrame(){
 const frames=data.frames,last=frames.at(-1);
 return t>=last.t&&recordingEndAvailable(last.t,sampleEndTolerance(frames.slice(-12).map(f=>f.t)));
}
function frameAvailable(f){
 const start=data.logStart??data.frames[0].t,end=data.frames.at(-1).t;
 if(t>end)return f===data.frames.at(-1)&&finalModelFrame();
 return t>=start-LOG_EDGE_TOLERANCE-1e-6&&Math.abs(f.t-t)<.16;
}
function missingModelMessage(){
 const start=data.logStart??data.frames[0].t,end=data.frames.at(-1).t;
 if(t<start-LOG_EDGE_TOLERANCE-1e-6)return '아직 로그 데이터가 시작되지 않은 구간입니다.';
 if(t>end&&!finalModelFrame())return '로그 데이터가 종료된 구간입니다.';
 return '이 시점의 유효한 모델 데이터 없음';
}
function syncVideo(seek=false){
 const visible=videoAvailable(),wasHidden=v.hidden,hold=finalVideoFrame();
 v.hidden=!visible;$('noVideo').hidden=visible;
 $('noVideo').textContent=!data?.video?'이 로그에 동기화 가능한 영상이 없습니다.':t<data.video.start?'아직 영상이 시작되지 않은 구간입니다.':playing?'영상이 종료되었습니다. 로그 재생을 계속합니다.':'영상이 종료된 구간입니다.';
 if(!visible){pauseVideo();return}
 const duration=Number.isFinite(v.duration)?v.duration:data.video.duration;
 const target=Math.max(0,Math.min(hold?duration:t-data.video.start,duration-.001));
 if(v.readyState>=1&&(seek||wasHidden||hold&&Math.abs(v.currentTime-target)>.0005||Math.abs(v.currentTime-target)>.35))v.currentTime=target;
 if(hold){pauseVideo();return}
 if(playing&&v.paused&&!videoPlayPending){
  videoPlayPending=true;const pauseRevision=videoPauseRevision;
  v.play().catch(e=>{if(pauseRevision===videoPauseRevision&&playing&&videoAvailable()&&!finalVideoFrame()){pause();showError('영상을 재생할 수 없습니다. '+e.message)}}).finally(()=>{videoPlayPending=false;if(!playing||!videoAvailable()||finalVideoFrame())pauseVideo()});
 }
}
function setTime(time,seekVideo=true){if(!data)return;t=Math.max(0,Math.min(time,data.duration));idx=nearest(t);$('seek').value=t;$('time').textContent=`${clock(t)} / ${clock(data.duration)}`;syncVideo(seekVideo);render()}
function step(n){pause();if(data)setTime(data.frames[Math.max(0,Math.min(data.frames.length-1,idx+n))].t)}
function toggle(){if(!data||loading)return;if(playing){pause();return}if(t>=data.duration-.05)setTime(0);playing=true;last=performance.now();$('play').textContent='일시정지';syncVideo(true)}
function tick(now){if(playing&&data){setTime(t+(now-last)/1000*Number($('speed').value),false);if(t>=data.duration-.001)pause()}last=now;requestAnimationFrame(tick)}
function showError(message){$('errorText').textContent=message;$('error').hidden=!message}
$('errorRefresh').onclick=()=>location.reload();
let dataRetryTimer=null,recordingNameFiles={};
async function loadData(){const id=location.pathname.split('/').filter(Boolean).at(-1);clearTimeout(dataRetryTimer);const res=await fetch('../../api/logs/'+id+'/data',{cache:'no-store'});
 if(res.status===409){
  const state=await res.json();
  if(['queued','processing'].includes(state.status)){
   $('play').disabled=true;$('status').textContent='로그 준비 중 · 완료되면 자동으로 불러옵니다';
   dataRetryTimer=setTimeout(()=>loadData().catch(e=>showError(e.message)),2000);return;
  }
  throw Error(state.error||'로그 변환에 실패했습니다. 목록을 확인하세요.');
 }
 if(!res.ok)throw Error('로그를 불러오지 못했습니다. 목록을 확인하세요.');
 data=await res.json();showError('');renderRecordingName($('routeName'),data.route,recordingNameFiles).id='route';$('details').textContent=`${data.frames.length.toLocaleString()} 모델 프레임 · ${data.video?'영상 있음':'영상 없음'}`;$('seek').max=data.duration;$('end').textContent=clock(data.duration);$('warnings').textContent=data.warnings.join('\n');$('warnings').hidden=!data.warnings.length;$('noVideo').hidden=!!data.video;v.hidden=!data.video;if(data.video){v.src='../../api/logs/'+id+'/video?v='+encodeURIComponent(data.key||Date.now());loading=true;$('play').disabled=true;$('status').textContent='영상 준비 중';v.load()}else{loading=false;$('play').disabled=false;$('status').textContent='재생 준비 완료'}setTime(0)}
$('play').onclick=toggle;$('prev').onclick=()=>step(-1);$('next').onclick=()=>step(1);$('seek').oninput=()=>{setTime(Number($('seek').value));last=performance.now()};$('speed').onchange=()=>v.playbackRate=Number($('speed').value);
v.onloadedmetadata=()=>{loading=false;$('play').disabled=false;$('status').textContent='재생 준비 완료';v.playbackRate=Number($('speed').value);setTime(t)};v.onended=()=>{if(playing&&data?.video){setTime(Math.max(t,data.video.start+data.video.duration),false);last=performance.now();if(t>=data.duration)pause()}};v.onerror=()=>{if(data?.video)showError('브라우저가 영상을 읽지 못했습니다. Home Assistant 연결을 확인하고 새로고침해 주세요.')};
for(const id of ['range','lanes','edges','leads','radarCenter','radarLeft','radarRight','liveTracks','hideScc','trackLabels','yRelLabels','distanceLabels','liveTrackLabels','speedLabels','relativeSpeedLabels','hideLabels'])$(id).onchange=render;
document.onkeydown=e=>{if(['INPUT','SELECT','BUTTON'].includes(document.activeElement.tagName))return;if(e.code==='Space'){e.preventDefault();toggle()}if(e.code==='ArrowLeft'){e.preventDefault();step(-1)}if(e.code==='ArrowRight'){e.preventDefault();step(1)}};
const targetStyle={center:{label:'중앙',color:'#d09aff',toggle:'radarCenter'},left:{label:'왼쪽',color:'#ffda76',toggle:'radarLeft'},right:{label:'오른쪽',color:'#ff91b5',toggle:'radarRight'}};
function renderSteering(f){
 const s=frameAvailable(f)?f.steering:null,labels={driver:'운전자 조향 개입',active:'조향 제어 중',inactive:'조향 제어 꺼짐',unknown:'상태 확인 불가'};
 const label=labels[s?.state]||labels.unknown;
 const detail=label+(s?.angle!=null?` · ${s.angle.toFixed(1)}°`:'')+(s?.torque==null?' · 토크 정보 없음':'')+(s?.critical?' · 핸들 조작 요청':'');
 $('steeringLabel').textContent=label;$('steeringStatus').title=detail;$('steeringIcon').setAttribute('aria-label',detail);
 const [r,g,b]=(s?.color||[148,165,184]).map(v=>v/255);
 $('wheelColor').setAttribute('values',`${r} 0 0 0 0 0 ${g} 0 0 0 0 0 ${b} 0 0 0 0 0 ${['driver','active'].includes(s?.state)?1:242/255} 0`);
 $('wheelRotate').setAttribute('transform',`translate(64 40) rotate(${-(s?.angle||0)}) scale(${s?.scale||1}) translate(-64 -40)`);
 $('wheelTexture').setAttribute('href',`../../assets/carrot_wheel${s?.critical?'_critical':''}.png`);
 $('wheelLane').setAttribute('visibility',s?.lane&&!s?.critical?'visible':'hidden');
 $('wheelCritical').setAttribute('visibility',s?.critical?'visible':'hidden');
}
function render(){
 window.renderTelemetry?.();
 const w=canvas.clientWidth,h=canvas.clientHeight,dpr=devicePixelRatio||1;if(canvas.width!==Math.round(w*dpr)||canvas.height!==Math.round(h*dpr)){canvas.width=Math.round(w*dpr);canvas.height=Math.round(h*dpr)}ctx.setTransform(dpr,0,0,dpr,0,0);ctx.clearRect(0,0,w,h);if(!data)return;
 const f=data.frames[idx],valid=f.valid&&frameAvailable(f);
 window.renderVideoOverlay?.(f,frameAvailable(f));
 const range=Number($('range').value),scale=(h-78)/range,lateral=Number($('lateralRange').value),manualLateral=Number.isFinite(lateral)&&lateral>0,cx=manualLateral?(38+w-12)/2:w/2,cy=h-48;
 const lateralScale=manualLateral?(w-50)/(2*lateral):scale;
 const X=y=>cx+y*lateralScale,Y=x=>cy-x*scale;
 ctx.font='11px system-ui';ctx.lineWidth=1;ctx.strokeStyle='#273646';ctx.fillStyle='#8fa3b8';
 for(let x=0;x<=range;x+=10){ctx.beginPath();ctx.moveTo(38,Y(x));ctx.lineTo(w-12,Y(x));ctx.stroke();ctx.fillText(x+' m',5,Y(x)+4)}
 for(let y=manualLateral?-lateral:-Math.floor((w/2-40)/scale/5)*5;y<=(manualLateral?lateral:(w/2-20)/scale);y+=5){ctx.beginPath();ctx.moveTo(X(y),24);ctx.lineTo(X(y),cy);ctx.stroke();ctx.textAlign='center';ctx.fillText(y,X(y),h-13)}ctx.textAlign='left';ctx.fillText('전방 x ↑',12,16);ctx.textAlign='right';ctx.fillText('좌우 y → (m)',w-10,16);ctx.textAlign='left';
 ctx.save();ctx.beginPath();ctx.rect(38,22,w-50,cy-20);ctx.clip();
 const labels=[];
 const targetValue=(target,lateral)=>{
  if(checked('trackLabels'))return Number.isInteger(target.trackId)&&target.trackId>=0?String(target.trackId):'—';
  if(checked('yRelLabels'))return Number.isFinite(lateral)?lateral.toFixed(2)+'m':'—';
  if(checked('speedLabels')||checked('relativeSpeedLabels')){
   const ego=f.egoSpeedKph;
   const relative=Number.isFinite(target.vRel)?target.vRel*3.6:Number.isFinite(target.speedKph)&&Number.isFinite(ego)?target.speedKph-ego:null;
   const speed=Number.isFinite(target.speedKph)?target.speedKph:Number.isFinite(relative)&&Number.isFinite(ego)?ego+relative:null;
   const value=checked('relativeSpeedLabels')?relative:speed;
   return Number.isFinite(value)?(checked('relativeSpeedLabels')&&value>0?'+':'')+value.toFixed(1)+' km/h':'—';
  }
  return target.x.toFixed(1)+'m';
 };
 function annotate(text,x,y,color,side=1){
  if(checked('hideLabels'))return;
  const lines=text.split('\n'),width=Math.max(...lines.map(line=>ctx.measureText(line).width)),height=lines.length*13;let box=null;
  for(const offset of [-8,12,-28,32,-48,52,-68,72]){
   const left=Math.max(42,Math.min(w-16-width,x+(side>0?12:-width-12))),top=Math.max(26,Math.min(cy-height-3,y+offset));
   const next={left,top,right:left+width,bottom:top+height};
   if(!labels.some(b=>next.left<b.right+4&&next.right>b.left-4&&next.top<b.bottom+3&&next.bottom>b.top-3)){box=next;break}
  }
  if(!box)return;labels.push(box);ctx.strokeStyle=color;ctx.lineWidth=.7;ctx.beginPath();ctx.moveTo(x,y);ctx.lineTo(side>0?box.left:box.right,box.top+6);ctx.stroke();ctx.fillStyle=color;ctx.textAlign='left';lines.forEach((line,i)=>ctx.fillText(line,box.left,box.top+10+i*13));
 }
 function path(points){ctx.beginPath();points.forEach(([x,y],i)=>i?ctx.lineTo(X(y),Y(x)):ctx.moveTo(X(y),Y(x)))}
 function line(points,color,dashed,alpha){path(points);ctx.strokeStyle=color;ctx.lineWidth=2;ctx.globalAlpha=alpha;ctx.setLineDash(dashed?[6,5]:[]);ctx.stroke();ctx.setLineDash([]);ctx.globalAlpha=1}
 if(valid){
  if(checked('lanes')){if(f.lanes[1]?.length&&f.lanes[2]?.length){path([...f.lanes[1],...f.lanes[2].slice().reverse()]);ctx.closePath();ctx.fillStyle='rgba(87,217,176,0.065)';ctx.fill()}f.lanes.forEach((l,i)=>line(l,'#57d9b0',f.lp[i]<.5,(i===1||i===2)?.9:.3))}
  if(checked('edges'))f.edges.forEach((l,i)=>line(l,'#ffa665',f.es[i]>1,.95));
  if(checked('modelPath')&&f.position?.length>1)line(f.position,'#c4a5ff',false,1);
  if(checked('leads')){
   f.leads.forEach((l,i)=>{if(l.x<0||l.x>range)return;ctx.globalAlpha=l.p<.5?.45:1;ctx.strokeStyle='#81b5ff';ctx.lineWidth=2;ctx.beginPath();ctx.arc(X(l.y),Y(l.x),7,0,Math.PI*2);ctx.stroke();annotate(`모델 ${i+1} · ${targetValue(l,-l.y)}`,X(l.y),Y(l.x),'#c5daff',i===0?1:-1);ctx.globalAlpha=1});
   const l=f.selected;if(l&&l.x>=0&&l.x<=range){const x=X(l.y),y=Y(l.x);ctx.strokeStyle='#eee7bc';ctx.lineWidth=2;ctx.beginPath();ctx.moveTo(x,y-7);ctx.lineTo(x+7,y);ctx.lineTo(x,y+7);ctx.lineTo(x-7,y);ctx.closePath();ctx.stroke();annotate(`선택 · ${targetValue(l,-l.y)}`,x,y,'#eee7bc')}
  }
  for(const target of f.radarTargets||[]){
   const style=targetStyle[target.group];if(!style||!checked(style.toggle)||target.x<0||target.x>range)continue;
   const x=X(target.y),y=Y(target.x);ctx.strokeStyle=style.color;ctx.lineWidth=2;ctx.strokeRect(x-5,y-8,10,16);
   annotate(`${style.label} ${target.index+1} · ${targetValue(target,target.yRel)}`,x,y,style.color,target.group==='left'?-1:1);
  }
 }
 const rawVisible=frameAvailable(f)&&f.liveTracksValid;
 const rawTargets=rawVisible?(f.liveTracks||[]).filter(target=>!checked('hideScc')||String(target.source).toLowerCase()!=='scc'):[];
 if(checked('liveTracks'))for(const target of rawTargets){
  if(target.x<0||target.x>range)continue;
  const x=X(target.y),y=Y(target.x);ctx.strokeStyle='#78e9fa';ctx.lineWidth=1.5;ctx.globalAlpha=target.measured?.9:.5;ctx.beginPath();
  if(target.measured){ctx.moveTo(x-4,y-4);ctx.lineTo(x+4,y+4);ctx.moveTo(x-4,y+4);ctx.lineTo(x+4,y-4)}else ctx.arc(x,y,4,0,Math.PI*2);
  ctx.stroke();ctx.globalAlpha=1;
  if(checked('liveTrackLabels'))annotate(targetValue(target,target.yRel),x,y,'#78e9fa',target.y<0?-1:1);
 }
 ctx.restore();
 ctx.fillStyle='#e6edf5';ctx.beginPath();ctx.moveTo(cx,cy-14);ctx.lineTo(cx-7,cy+4);ctx.lineTo(cx+7,cy+4);ctx.closePath();ctx.fill();ctx.textAlign='center';ctx.fillText('내 차량',cx,cy+20);ctx.textAlign='left';
 if(!valid){ctx.fillStyle='#ffd39f';ctx.fillText(missingModelMessage(),45,45)}
 const percent=n=>Number.isFinite(n)?(n*100).toFixed(1)+'%':'—';
 const distance=$('boundaryDistance').getAttribute('aria-pressed')==='true';
 const meters=value=>Number.isFinite(value)?(value>0?'+':'')+value.toFixed(3)+' m':'—';
 ['lane0','left','right','lane3'].forEach((id,i)=>{$(id).textContent=valid?(distance?meters(f.laneY0?.[i]):percent(f.lp[i])):'—'});
 ['edge0','edge1'].forEach((id,i)=>{$(id).textContent=valid?(distance?meters(f.edgeY0?.[i]):Number.isFinite(f.es[i])?f.es[i].toFixed(3)+' m':'—'):'—'});
 const targets=valid?(f.radarTargets||[]):[];
 $('radarRows').replaceChildren(...targets.map(target=>{const row=document.createElement('tr');const style=targetStyle[target.group];const values=[style.label+' '+(target.index+1),target.x.toFixed(2),target.yRel.toFixed(2),target.vRel.toFixed(2),target.radar?'예':'아니오',String(target.trackId)];for(const value of values){const cell=document.createElement('td');cell.textContent=value;row.append(cell)}row.firstChild.style.color=style.color;return row}));
 if(!targets.length){const row=document.createElement('tr'),cell=document.createElement('td');cell.colSpan=6;cell.textContent='이 시점에 유효한 중앙·좌우 차량이 없습니다.';row.append(cell);$('radarRows').append(row)}
 $('rawCount').textContent=`· ${rawTargets.length}개`;
 $('rawTiming').textContent=rawVisible?`메시지 시각 차이 ${f.liveTracksDeltaMs.toFixed(1)}ms`: '이 시점의 유효한 liveTracks 메시지가 없습니다.';
 $('rawRows').replaceChildren(...rawTargets.map(target=>{const row=document.createElement('tr');for(const value of [target.trackId,target.x.toFixed(2),target.yRel.toFixed(2),target.vRel.toFixed(2),target.measured?'예':'아니오',target.source,target.trackState]){const cell=document.createElement('td');cell.textContent=value;row.append(cell)}return row}));
 if(!rawTargets.length){const row=document.createElement('tr'),cell=document.createElement('td');cell.colSpan=7;cell.textContent='표시할 liveTracks 감지점이 없습니다.';row.append(cell);$('rawRows').append(row)}
 canvas.setAttribute('aria-label',`주행 상황. 현재 radarState 중앙·좌우 차량 ${targets.length}개. 전방 범위 ${range}m.`);
 renderSteering(f);
 $('egoSpeed').textContent=frameAvailable(f)&&Number.isFinite(f.egoSpeedKph)?f.egoSpeedKph.toFixed(1):'—';
 $('lead').textContent=valid&&f.selected?f.selected.x.toFixed(1)+' m':'앞차 미감지';$('lead').title=f.selected?(f.selected.radar?'레이더 사용':'비전 기반'):'';$('frame').textContent=frameAvailable(f)?'FRAME '+f.id:'FRAME —';
}
new ResizeObserver(render).observe(canvas);loadData().catch(e=>showError(e.message));requestAnimationFrame(tick);

// Follow wrapped controls, font scaling and safe-area changes without hiding the last rows.
const playback=document.querySelector('.playback');
function sizePlayback(){document.body.style.setProperty('--playback-height',`${Math.ceil(playback.getBoundingClientRect().height)}px`)}
new ResizeObserver(sizePlayback).observe(playback);sizePlayback();

// Layout changes leave the video element and playback state intact.
const splitView=$('splitView'),stackView=$('stackView'),layoutPreferenceKey='roadviewer-replay-layout';
function setReplayLayout(mode){
 document.body.classList.toggle('split-view',mode==='split');
 document.body.classList.toggle('stack-view',mode==='stack');
 splitView.setAttribute('aria-pressed',String(mode==='split'));
 stackView.setAttribute('aria-pressed',String(mode==='stack'));
}
try{
 const saved=localStorage.getItem(layoutPreferenceKey);
 const mode=saved===null?(localStorage.getItem('roadviewer-replay-split-view')==='true'?'split':'auto'):saved;
 setReplayLayout(['split','stack'].includes(mode)?mode:'auto');
}catch{setReplayLayout('auto')}
function toggleReplayLayout(button,mode){
 const next=button.getAttribute('aria-pressed')==='true'?'auto':mode;
 setReplayLayout(next);
 try{localStorage.setItem(layoutPreferenceKey,next)}catch{}
}
splitView.onclick=()=>toggleReplayLayout(splitView,'split');
stackView.onclick=()=>toggleReplayLayout(stackView,'stack');

$('boundaryDistance').onclick=()=>{
 const enabled=$('boundaryDistance').getAttribute('aria-pressed')!=='true';
 $('boundaryDistance').setAttribute('aria-pressed',String(enabled));
 $('boundaryMode').textContent=enabled?'첫 점 y[0] · 왼쪽 − / 오른쪽 + · m':'차선 확률 · 로드엣지 표준편차';
 $('edge0Label').textContent=enabled?'왼쪽 로드엣지 y[0]':'왼쪽 로드엣지 Std';
 $('edge1Label').textContent=enabled?'오른쪽 로드엣지 y[0]':'오른쪽 로드엣지 Std';
 render();
};

function logSegmentInfo(name){
 const match=/^(.+?)\s*\/\s*구간\s*(\d+)$/.exec(name||'')||/^(.{20})--(\d+)$/.exec(name||'');
 if(!match)return null;
 const number=Number(match[2]);
 return Number.isSafeInteger(number)?{route:match[1],number}:null;
}
function populateSegments(logs,current){
 const select=$('logSegment');select.replaceChildren();select.hidden=true;select.onchange=null;
 const active=logs.find(log=>log.id===current),info=logSegmentInfo(active?.name);
 if(!info)return;
 const segments=logs.map(log=>({log,info:logSegmentInfo(log.name)})).filter(item=>item.info?.route===info.route).sort((a,b)=>a.info.number-b.info.number||a.log.id.localeCompare(b.log.id));
 if(segments.length<2)return;
 for(const {log,info} of segments){
  const option=document.createElement('option');option.value=log.id;
  const status={unconverted:'미변환',queued:'대기 중',processing:'준비 중',error:'변환 실패'}[log.status];
  option.textContent=`구간 ${info.number}${status?' · '+status:''}`;
  option.disabled=log.status!=='ready'&&log.id!==current;
  select.append(option);
 }
 select.value=current;select.hidden=false;
 select.onchange=()=>{
  const target=segments.find(item=>item.log.id===select.value)?.log;
  if(target?.status==='ready'&&target.id!==current)location.assign('../'+encodeURIComponent(target.id)+'/');
 };
}
function syncReplayPin(pinned){
 $('routePin').hidden=!pinned;
 const button=$('pinLog');button.setAttribute('aria-pressed',String(pinned));
 button.title=pinned?'구간 고정 해제':'구간 고정';button.setAttribute('aria-label',button.title);
}
$('pinLog').onclick=async()=>{
 const button=$('pinLog'),current=location.pathname.split('/').filter(Boolean).at(-1);
 button.disabled=true;
 try{
  const response=await fetch('../../api/logs/'+encodeURIComponent(current)+'/pin',{method:'POST',headers:{'Content-Type':'application/json','X-RoadViewer-Request':'1'},body:JSON.stringify({pinned:button.getAttribute('aria-pressed')!=='true'})});
  if(!response.ok)throw Error('구간 고정 설정을 저장하지 못했습니다. 다시 시도해 주세요.');
  const result=await response.json();syncReplayPin(result.pinned);
 }catch(e){showError(e.message)}finally{button.disabled=false}
};
async function loadLogNavigation(){
 const buttons=[$('previousLog'),$('nextLog')];
 try{
  const response=await fetch('../../api/logs');
  if(!response.ok)throw Error('로그 목록을 불러오지 못했습니다.');
  const {logs}=await response.json(),current=location.pathname.split('/').filter(Boolean).at(-1);
  const active=logs.find(log=>log.id===current);
  recordingNameFiles=active?.files||{};
  syncReplayPin(!!active?.pinned);$('pinLog').disabled=!active;
  if(data)renderRecordingName($('routeName'),data.route,recordingNameFiles).id='route';
  populateSegments(logs,current);
  const index=logs.findIndex(log=>log.id===current);
  const neighbors=index<0?[]:[logs.slice(index+1).find(log=>log.status==='ready'),logs.slice(0,index).reverse().find(log=>log.status==='ready')];
  buttons.forEach((button,i)=>{
   const log=neighbors[i];button.disabled=!log;
   button.title=log?log.name:'이동할 재생 가능한 로그가 없습니다.';
   button.onclick=log?()=>location.assign('../'+encodeURIComponent(log.id)+'/'):null;
  });
 }catch{buttons.forEach(button=>{button.disabled=true;button.title='로그 목록을 불러오지 못했습니다. 새로고침해 주세요.'})}
}
loadLogNavigation();

// Keep the navigation in normal flow; the chosen row determines where sticking starts.
const replayHeading=document.querySelector('.replay-heading');
if(replayHeading){
 const preference='roadviewer-heading-collapsed';let headingFrame=0,headingCollapsed=false;
 try{headingCollapsed=localStorage.getItem(preference)==='true'}catch{}
 const fold=$('foldHeading'),navigation=$('logNavigation'),title=replayHeading.querySelector('.route');
 const anchor=document.createElement('div');anchor.className='heading-anchor';replayHeading.before(anchor);
 const updateHeading=()=>{
  headingFrame=0;
  const offset=headingCollapsed?title.offsetTop:0;
  replayHeading.style.top=(10-offset)+'px';
  const stuck=window.scrollY>0&&anchor.getBoundingClientRect().top+offset<=10;
  replayHeading.classList.toggle('is-stuck',stuck);
  replayHeading.classList.toggle('is-collapsed',headingCollapsed);
  navigation.inert=stuck&&headingCollapsed;fold.hidden=!stuck;
  fold.setAttribute('aria-expanded',String(!headingCollapsed));
  fold.setAttribute('aria-label',headingCollapsed?'상단 이동 버튼 펼치기':'상단 이동 버튼 접기');
 };
 const scheduleHeading=()=>{if(!headingFrame)headingFrame=requestAnimationFrame(updateHeading)};
 // Clear press feedback on release, cancellation, or leaving the row.
 fold.addEventListener('pointerdown',e=>{if(e.button!==0)return;fold.classList.add('is-pressed')});
 for(const event of ['pointerup','pointercancel','pointerleave','lostpointercapture'])fold.addEventListener(event,()=>fold.classList.remove('is-pressed'));
 fold.onclick=()=>{headingCollapsed=!headingCollapsed;try{localStorage.setItem(preference,String(headingCollapsed))}catch{}updateHeading()};
 window.addEventListener('scroll',scheduleHeading,{passive:true});
 window.addEventListener('resize',scheduleHeading);
 window.addEventListener('pageshow',scheduleHeading);
 new ResizeObserver(scheduleHeading).observe(navigation);
 updateHeading();
}

// Share layer and label preferences between recordings on this browser.
const displayPreferenceKey='roadviewer-display-preferences';
const displayControls=[...document.querySelectorAll('.road-panel .layers input')];
try{
 const saved=JSON.parse(localStorage.getItem(displayPreferenceKey)||'null');
 if(saved&&typeof saved==='object'){
  for(const control of displayControls){
   if(control.type==='checkbox'&&typeof saved.checks?.[control.id]==='boolean')control.checked=saved.checks[control.id];
  }
  const label=displayControls.find(control=>control.type==='radio'&&control.value===saved.labelMode);
  if(label)label.checked=true;
 }
}catch{}
function saveDisplayPreferences(){
 const checks=Object.fromEntries(displayControls.filter(control=>control.type==='checkbox').map(control=>[control.id,control.checked]));
 const labelMode=displayControls.find(control=>control.type==='radio'&&control.checked)?.value||'trackId';
 try{localStorage.setItem(displayPreferenceKey,JSON.stringify({checks,labelMode}))}catch{}
}
for(const control of displayControls)control.addEventListener('change',saveDisplayPreferences);
$('modelPath').addEventListener('change',render);
render();

try{const saved=localStorage.getItem('roadviewer-lateral-range');if([...$('lateralRange').options].some(option=>option.value===saved))$('lateralRange').value=saved}catch{}
$('lateralRange').onchange=()=>{try{localStorage.setItem('roadviewer-lateral-range',$('lateralRange').value)}catch{}render()};
render();

// Screen-width profiles keep phone, tablet and desktop preferences separate.
const layoutWidth=$('layoutWidth'),layoutWidthValue=$('layoutWidthValue'),mobileLayout=matchMedia('(max-width:600px)'),tabletLayout=matchMedia('(max-width:1280px)');
function widthProfile(){
 if(mobileLayout.matches)return {key:'roadviewer-layout-width-mobile',min:50,max:100,step:1,default:100,unit:'%',label:'모바일 화면 폭'};
 if(tabletLayout.matches)return {key:'roadviewer-layout-width-tablet',min:320,max:1280,step:20,default:1280,unit:'px',label:'태블릿 화면 폭'};
 return {key:'roadviewer-layout-width',min:720,max:1920,step:20,default:1420,unit:'px',label:'최대 화면 폭'};
}
function syncLayoutWidth(){
 const profile=widthProfile();let saved;try{saved=Number(localStorage.getItem(profile.key))}catch{}
 const width=Math.max(profile.min,Math.min(profile.max,saved||profile.default));
 layoutWidth.min=String(profile.min);layoutWidth.max=String(profile.max);layoutWidth.step=String(profile.step);layoutWidth.value=String(width);
 $('layoutWidthLabel').textContent=profile.label;
 $('layoutWidthMin').textContent=profile.min+profile.unit;$('layoutWidthMax').textContent=profile.max+profile.unit;
 applyLayoutWidth(width);
}
function applyLayoutWidth(value){
 const profile=widthProfile(),width=Number(value);
 document.body.style.setProperty('--layout-width',profile.unit==='%'?'100%':width+'px');
 document.body.style.setProperty('--mobile-layout-width',profile.unit==='%'?width+'%':'100%');
 layoutWidthValue.textContent=width+(profile.unit==='%'?'%':' px');
}
syncLayoutWidth();mobileLayout.addEventListener('change',syncLayoutWidth);tabletLayout.addEventListener('change',syncLayoutWidth);
layoutWidth.oninput=()=>{applyLayoutWidth(layoutWidth.value);try{localStorage.setItem(widthProfile().key,layoutWidth.value)}catch{}};
$('resetLayoutWidth').onclick=()=>{const profile=widthProfile();layoutWidth.value=String(profile.default);applyLayoutWidth(layoutWidth.value);try{localStorage.removeItem(profile.key)}catch{}};

(()=>{
 const dialog=$('layoutWidthDialog'),button=$('layoutWidthButton');let oldOverflow='';
 button.onclick=()=>{if(dialog.open)return;oldOverflow=document.body.style.overflow;document.body.style.overflow='hidden';dialog.showModal();layoutWidth.focus({preventScroll:true})};
 const close=()=>dialog.close();
 $('layoutWidthClose').onclick=close;
 dialog.addEventListener('close',()=>{document.body.style.overflow=oldOverflow;button.focus({preventScroll:true})});
 dialog.addEventListener('cancel',e=>{e.preventDefault();close()});
 dialog.addEventListener('click',e=>{if(e.target!==dialog)return;const r=dialog.getBoundingClientRect();if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)close()});
})();
