'use strict';
const $=id=>document.getElementById(id),v=$('video'),canvas=$('road'),ctx=canvas.getContext('2d');
let data=null,t=0,idx=0,playing=false,last=0,loading=true,videoReadyPending=false;
const checked=id=>$(id).checked;
// Show the selected log name while replay data is loading.
try{
 const from=JSON.parse(sessionStorage.getItem('rv-route')||'null');sessionStorage.removeItem('rv-route');
 if(from?.id===location.pathname.split('/').filter(Boolean).at(-1))$('route').textContent=from.text;
}catch{}
function clock(n){n=Math.max(0,n);return `${Math.floor(n/60)}:${(n%60).toFixed(2).padStart(5,'0')}`}
function nearest(time){const f=data.frames;let a=0,b=f.length-1;while(a<b){const m=(a+b)>>1;if(f[m].t<time)a=m+1;else b=m}return a>0&&Math.abs(f[a-1].t-time)<Math.abs(f[a].t-time)?a-1:a}
function pause(){playing=false;pauseVideo();$('play').textContent='재생'}
let videoPlayPending=false,videoPauseRevision=0,videoSource=null,resumeAfterVideo=false;
const failedVideos=new Set();
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
  v.play().catch(e=>{if(pauseRevision===videoPauseRevision&&playing&&videoAvailable()&&!finalVideoFrame()){videoFailure('영상을 재생할 수 없습니다. '+e.message)}}).finally(()=>{videoPlayPending=false;if(!playing||!videoAvailable()||finalVideoFrame())pauseVideo()});
 }
}
function updateVideoBuffer(){
 const container=$('videoBuffered');container.replaceChildren();
 if(!data?.video||!(data.duration>0)||v.readyState===0)return;
 const ranges=v.buffered,offset=data.video.start;
 for(let i=0;i<ranges.length;i++){
  const start=Math.max(0,offset+ranges.start(i));
  const end=Math.min(data.duration,offset+data.video.duration,offset+ranges.end(i));
  if(end<=start)continue;
  const segment=document.createElement('span');
  segment.style.left=`${start/data.duration*100}%`;segment.style.width=`${(end-start)/data.duration*100}%`;
  container.append(segment);
 }
}
for(const event of ['progress','loadedmetadata','loadeddata','durationchange','emptied','seeked'])v.addEventListener(event,updateVideoBuffer);
function setTime(time,seekVideo=true,lazy=false){if(!data)return;t=Math.max(0,Math.min(time,data.duration));idx=nearest(t);$('seek').value=t;$('seekPlayed').style.width=`${data.duration>0?t/data.duration*100:0}%`;$('time').textContent=`${clock(t)} / ${clock(data.duration)}`;syncVideo(seekVideo);render(lazy)}
function step(n){if(loading)return;pause();if(data)setTime(data.frames[Math.max(0,Math.min(data.frames.length-1,idx+n))].t)}
function toggle(){if(!data||loading)return;if(playing){pause();return}if(t>=data.duration-.05)setTime(0);playing=true;last=performance.now();$('play').textContent='일시정지';syncVideo(true)}
function tick(now){now=Math.max(now,last);if(playing&&data){const next=t+(now-last)/1000*Number($('speed').value);setTime(next>=data.duration-.001?data.duration:next,false,true);if(t>=data.duration)pause()}else window.renderVideoOverlayMotion?.();last=now;requestAnimationFrame(tick)}
function setPlaybackState(ready,message){
 loading=!ready;$('play').disabled=!ready;
 $('playbackControls').hidden=!ready;$('playbackMessage').hidden=ready;
 $('playbackMessage').textContent=ready?'':message;$('status').textContent=message;
}
function playbackError(message){videoReadyPending=false;pause();setPlaybackState(false,message);$('status').textContent='재생 불가';showError(message)}
function showError(message){$('errorText').textContent=message;$('error').hidden=!message;if(message)document.body.classList.remove('replay-loading')}
$('errorRefresh').onclick=()=>location.reload();
// Replay files are stored as gzip. The browser inflates them itself, so no proxy needs to pass Content-Encoding.
const gzipReplay=typeof DecompressionStream==='function';
function replayUrl(url){return gzipReplay?url+(url.includes('?')?'&':'?')+'format=gzip':url}
async function readReplayJson(response){
 const bytes=new Uint8Array(await response.arrayBuffer());
 // Uncompressed answers (older conversions, or browsers without DecompressionStream) are plain JSON.
 if(bytes[0]!==0x1f||bytes[1]!==0x8b)return JSON.parse(new TextDecoder().decode(bytes));
 return new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'))).json();
}
// Undo compact.py: shared camera info, values derivable from others, and marker points.
// Derived geometry is bounded to recent frames (box fade needs short history).
const overlayGeometryCache=new Map(),wideBasisCache=new WeakMap();
function wideProjectionBasis(info){
 if(!info||!['calibrated','recalibrating'].includes(info.calibrationStatus)||![info.rpy,info.wideRpy].every(a=>Array.isArray(a)&&a.length===3&&a.every(Number.isFinite)))return null;
 if(wideBasisCache.has(info))return wideBasisCache.get(info);
 const sensor=info.wideSensor,device=info.device;
 const config=['ar0231','ox03c10'].includes(sensor)||(sensor==='unknown'&&['tici','pc'].includes(device))?[1928,1208,567]:sensor==='os04c10'&&['tici','tizi','mici'].includes(device)?[1344,760,425.25]:null;
 if(!config)return null;
 const rotation=([r,p,y])=>{const cr=Math.cos(r),sr=Math.sin(r),cp=Math.cos(p),sp=Math.sin(p),cy=Math.cos(y),sy=Math.sin(y);return [[cy*cp,cy*sp*sr-sy*cr,cy*sp*cr+sy*sr],[sy*cp,sy*sp*sr+cy*cr,sy*sp*cr-cy*sr],[-sp,cp*sr,cp*cr]]};
 // Same order as openpilot: view_from_device * wide_from_device * device_from_calib.
 const a=rotation(info.wideRpy),b=rotation(info.rpy),r=a.map(row=>[0,1,2].map(j=>row.reduce((sum,v,k)=>sum+v*b[k][j],0))),[w,h,f]=config;
 const basis=[0,1,2].map(i=>[.5*r[0][i]+f/w*r[1][i],.5*r[0][i]+f/h*r[2][i],r[0][i]]);
 wideBasisCache.set(info,basis);return basis;
}
function buildReplayOverlay(frame,g){
 const project=p=>p&&p.length===3&&p.every(Number.isFinite)?[0,1,2].map(k=>p.reduce((sum,v,i)=>sum+v*g.basis[i][k],0)):null;
 const screen=p=>{const q=project(p);if(!q||q[2]<=.1)return null;const uv=[q[0]/q[2],q[1]/q[2]];return uv.every(v=>Math.abs(v)<10)?uv:null};
 const sample=(points,x)=>{for(let i=1;i<points.length;i++){const a=points[i-1],b=points[i];if(a.length!==3||b.length!==3||![...a,...b].every(Number.isFinite))continue;if(a[0]<=x&&x<=b[0]&&b[0]>a[0]){const t=(x-a[0])/(b[0]-a[0]);return [x,a[1]+(b[1]-a[1])*t,a[2]+(b[2]-a[2])*t]}}return null};
 const normal=(points,i)=>{const a=points[Math.max(0,i-1)],b=points[Math.min(points.length-1,i+1)],dx=b[0]-a[0],dy=b[1]-a[1],n=Math.hypot(dx,dy);return n?[-dy/n,dx/n,0]:[0,1,0]};
 const band=(points,confidence)=>{const width=.15*Math.max(0,Math.min(1,Number.isFinite(confidence)?confidence:0));return [-1,1].map(sign=>points.map((p,i)=>{const n=normal(points,i);return screen(p.map((v,k)=>v+n[k]*width*sign))}))};
 const inner=g.lanes.slice(1,3),path=g.position,height=g.height;
 const ground=x=>{if(!path.length)return height;const p=sample(path,x);return (p||path.reduce((a,b)=>Math.abs(a[0]-x)<=Math.abs(b[0]-x)?a:b))[2]+height};
 const blindspotPaths=inner.map(points=>{if(points.length<2||!points.every(p=>Number.isFinite(p[0])))return [];const start=Math.max(0,points[0][0]),end=Math.min(40,points.at(-1)[0]);if(end<=start)return [];const xs=[start];for(let x=2;x<40;x+=2)if(start<x&&x<end)xs.push(x);xs.push(end);return xs.map(x=>project(sample(points,x)))});
 let targetLine=[];const targetSections=[],road=frame.ccncRoad||{},distance=road.distance||0;
 if([1,3].includes(road.target)&&distance>0&&distance<204.6)targetLine=inner.map(points=>screen(sample(points,distance)));
 if(targetLine.length===2&&targetLine.every(Boolean))for(let i=0;i<17;i++){
  const a=sample(inner[0],distance-i*.5),b=sample(inner[1],distance-i*.5);if(!a||!b||a[0]<=0)break;
  const width=Math.hypot(...a.map((v,k)=>v-b[k]));if(width<.1)break;
  const center=a.map((v,k)=>(v+b[k])/2),side=a.map((v,k)=>(b[k]-v)/width);
  if(![-1,1].every(sign=>screen(center.map((v,k)=>v+sign*.9*side[k]))))break;
  targetSections.push([project(center),project(side)]);
 }
 if(targetSections.length){const [center,side]=targetSections[0];targetLine=[-1,1].map(sign=>{const p=center.map((v,k)=>v+sign*.9*side[k]);return [p[0]/p[2],p[1]/p[2]]})}
 const markers=[];
 for(const [kind,targets] of [['model',frame.leads||[]],['selected',frame.selected?[frame.selected]:[]],['radar',frame.radarTargets||[]],['raw',frame.liveTracks||[]],['ccnc',frame.ccncTargets||[]]])targets.forEach((target,index)=>{
  const x=target.x,y=target.y??-target.yRel,p=[x,y,ground(x)],point=x>0?screen(p):null;if(!point)return;
  const marker={kind,index,point,projection:project(p)};
  if(kind==='ccnc'){
   let fx=1,fy=0;
   if(inner.length===2){const samples=inner.map(line=>[sample(line,x),sample(line,x+5)]);if(samples.every(pair=>pair.every(Boolean))){const lateral=samples.reduce((sum,[a,b])=>sum+b[1]-a[1],0)/2,length=Math.hypot(5,lateral);fx=5/length;fy=lateral/length}}
   marker.box=[];for(const up of [0,1.5])for(const dx of [0,4.5])for(const dy of [-.9,.9])marker.box.push(project([x+dx*fx-dy*fy,y+dx*fy+dy*fx,ground(x+dx*fx)-up]));
  }
  markers.push(marker);
 });
 return {lanes:g.lanes.map(line=>line.map(screen)),edges:g.edges.map(line=>line.map(screen)),path:path.map(([x,y,z])=>screen([x,y,z+height])),
  laneBands:g.lanes.map((line,i)=>band(line,Math.min(.75,frame.lp?.[i]))),edgeBands:g.edges.map((line,i)=>band(line,edgeConfidence(frame.es?.[i]))),
  blindspotPaths,pathProjection:path.map(([x,y,z])=>project([x,y,z+height])),pathSides:path.map((p,i)=>project(normal(path,i))),
  targetLine,targetSections,heightDirection:project([0,0,-1]),markers};
}
function frameOverlay(frame,source){
 if(!source?.geometry)return source;
 const wide=videoSource==='wide',cached=overlayGeometryCache.get(frame);
 if(cached&&cached.wide===wide)return cached.result;
 const basis=wide?wideProjectionBasis(frame.cameraInfo):source.geometry.basis;
 const result=basis?buildReplayOverlay(frame,{...source.geometry,basis}):null;
 if(result&&wide)result.wide=true;
 overlayGeometryCache.set(frame,{wide,result});
 if(overlayGeometryCache.size>32)overlayGeometryCache.delete(overlayGeometryCache.keys().next().value);
 return result;
}

function expandReplayData(replay){
 overlayGeometryCache.clear();
 const infos=replay.cameraInfos;
 for(const frame of replay.frames){
  if(infos&&typeof frame.cameraInfo==='number')frame.cameraInfo=infos[frame.cameraInfo];
  frame.liveTracks?.forEach((target,i)=>{target.index??=i;target.y??=-target.yRel});
  frame.radarTargets?.forEach(target=>{target.y??=-target.yRel});
  if(frame.overlay?.geometry){let source=frame.overlay;Object.defineProperty(frame,'overlay',{configurable:true,enumerable:true,get:()=>frameOverlay(frame,source),set:value=>{source=value;overlayGeometryCache.delete(frame)}});continue}
  for(const marker of frame.overlay?.markers||[])if(!marker.point&&marker.projection){const [a,b,c]=marker.projection;marker.point=[a/c,b/c]}
 }
 return replay;
}
const videoLabels={front:'고화질 전방',qcamera:'전방 · 저용량',wide:'와이드'};
function setupVideoSources(){
 failedVideos.clear();resumeAfterVideo=false;
 const choices=data.videos|| (data.video?{qcamera:data.video}:{}),select=$('videoSource');
 select.replaceChildren(...Object.keys(videoLabels).filter(key=>choices[key]).map(key=>new Option(videoLabels[key],key)));
 $('videoSourceControl').hidden=select.options.length<2;
 select.dispatchEvent(new Event('rv:sync'));
 return Object.keys(videoLabels).find(key=>choices[key])||null;
}
function selectVideo(source){
 const info=(data.videos||{qcamera:data.video})[source];if(!info)return;
 resumeAfterVideo=playing||resumeAfterVideo;pause();videoPlayPending=false;videoSource=source;data.video=info;
 $('videoSource').value=source;$('videoSource').dispatchEvent(new Event('rv:sync'));
 $('cameraTitle').textContent=source==='wide'?'와이드 카메라':'전방 카메라';
 v.setAttribute('aria-label',videoLabels[source]);
 videoReadyPending=true;
 const id=location.pathname.split('/').filter(Boolean).at(-1);
 const url=new URL('../../api/logs/'+id+'/video',location.href);
 url.searchParams.set('v',data.key||Date.now());if(data.videos)url.searchParams.set('source',source);
 v.src=url.href;setPlaybackState(false,'영상을 불러오는 중입니다. 잠시 기다려 주세요.');v.load();updateVideoBuffer();setTime(t);
}
function videoFailure(message){
 if(!data?.video)return;
 failedVideos.add(videoSource);
 const source=Object.keys(videoLabels).find(key=>data.videos?.[key]&&!failedVideos.has(key));
 if(source){selectVideo(source);showError('선택한 영상을 읽지 못해 '+videoLabels[source]+' 영상으로 전환했습니다.');return}
 resumeAfterVideo=false;playbackError(message);
}
$('videoSource').onchange=()=>{failedVideos.clear();selectVideo($('videoSource').value)};
let dataRetryTimer=null,recordingNameFiles={};
async function loadData(){const id=location.pathname.split('/').filter(Boolean).at(-1);clearTimeout(dataRetryTimer);const res=await fetch(replayUrl('../../api/logs/'+id+'/data'),{cache:'no-cache'});
 if(res.status===409){
  const state=await res.json();
  if(['queued','processing'].includes(state.status)){
   setPlaybackState(false,'로그 준비 중 · 완료되면 자동으로 불러옵니다');
   dataRetryTimer=setTimeout(()=>loadData().catch(e=>playbackError(e.message)),2000);return;
  }
  throw Error(state.error||'로그 변환에 실패했습니다. 목록을 확인하세요.');
 }
 if(!res.ok)throw Error('로그를 불러오지 못했습니다. 목록을 확인하세요.');
 data=expandReplayData(await readReplayJson(res));showError('');document.body.classList.remove('replay-loading');renderRecordingName($('routeName'),data.route,recordingNameFiles).id='route';$('details').textContent=`${data.frames.length.toLocaleString()} 모델 프레임 · ${data.video?'영상 있음':'영상 없음'}`;$('seek').max=data.duration;$('end').textContent=clock(data.duration);$('warnings').textContent=data.warnings.join('\n');$('warnings').hidden=!data.warnings.length;$('noVideo').hidden=!!data.video;v.hidden=!data.video;t=0;const source=setupVideoSources();if(source){selectVideo(source)}else{videoSource=null;setPlaybackState(true,'재생 준비 완료')}updateVideoBuffer();setTime(0)}
$('play').onclick=toggle;$('prev').onclick=()=>step(-1);$('next').onclick=()=>step(1);$('seek').oninput=()=>{setTime(Number($('seek').value));last=performance.now()};$('speed').onchange=()=>v.playbackRate=Number($('speed').value);
v.onloadedmetadata=()=>{if(!data||v.error)return;v.playbackRate=Number($('speed').value);setTime(t)};v.oncanplay=()=>{if(data?.video&&!v.error&&videoReadyPending){videoReadyPending=false;setPlaybackState(true,'재생 준비 완료');if(resumeAfterVideo){resumeAfterVideo=false;playing=true;last=performance.now();$('play').textContent='일시정지';syncVideo(true)}}};v.onended=()=>{if(playing&&data?.video){setTime(Math.max(t,data.video.start+data.video.duration),false);last=performance.now();if(t>=data.duration)pause()}};v.onerror=()=>{if(data?.video)videoFailure('브라우저가 영상을 읽지 못했습니다. Home Assistant 연결을 확인하고 새로고침해 주세요.')};
for(const id of ['range','lanes','edges','leads','radarCenter','radarLeft','radarRight','liveTracks','ccncTargets','ccncRoad','boxLabels','boxLabelsBelow','bsdLabels','targetLabels','bsdWalls','hideScc','trackLabels','yRelLabels','distanceLabels','liveTrackLabels','speedLabels','relativeSpeedLabels','hideLabels'])$(id).onchange=render;
document.onkeydown=e=>{if(['INPUT','SELECT','BUTTON'].includes(document.activeElement.tagName))return;if(e.code==='Space'){e.preventDefault();toggle()}if(e.code==='ArrowLeft'){e.preventDefault();step(-1)}if(e.code==='ArrowRight'){e.preventDefault();step(1)}};
const targetStyle={center:{label:'중앙',color:'#d09aff',toggle:'radarCenter'},left:{label:'왼쪽',color:'#ffda76',toggle:'radarLeft'},right:{label:'오른쪽',color:'#ff91b5',toggle:'radarRight'}};
function renderSteering(f){
 const s=frameAvailable(f)?f.steering:null,labels={driver:'운전자 조향 개입',active:'조향 제어 중',inactive:'조향 제어 꺼짐',unknown:'상태 확인 불가'};
 const label=labels[s?.state]||labels.unknown;
 const detail=label+(s?.angle!=null?` · ${s.angle.toFixed(1)}°`:'')+(s?.torque==null?' · 토크 정보 없음':'')+(s?.critical?' · 핸들 조작 요청':'');
 $('steeringLabel').textContent=label;$('steeringStatus').title=detail;$('steeringIcon').setAttribute('aria-label',detail);
 const [r,g,b]=(s?.color||[148,165,184]).map(v=>v/255);
 $('wheelColor').setAttribute('values',`${r} 0 0 0 0 0 ${g} 0 0 0 0 0 ${b} 0 0 0 0 0 ${['driver','active'].includes(s?.state)?1:242/255} 0`);
 // A CSS transform (not the SVG attribute) so motion.css can glide between 20 Hz samples.
 $('wheelRotate').style.transform=`rotate(${-(s?.angle||0)}deg) scale(${s?.scale||1})`;
 $('wheelTexture').setAttribute('href',new URL(`../../assets/carrot_wheel${s?.critical?'_critical':''}.png`,location.href).href);
 $('wheelLane').setAttribute('visibility',s?.lane&&!s?.critical?'visible':'hidden');
 $('wheelCritical').setAttribute('visibility',s?.critical?'visible':'hidden');
}
function laneAppearance(value,isLane=true){const p=Number.isFinite(value)?Math.max(0,Math.min(1,value)):0;return {width:15*(isLane?Math.min(.75,p):p),alpha:isLane&&p>.75?.075+(p-.75)*.5:.1*p,edge:p}}
function ribbonEdges(points,width){
 const left=[],right=[];
 points.forEach((p,i)=>{
  if(!p){left.push(null);right.push(null);return}
  const a=points[i-1]||p,b=points[i+1]||p,dx=b[0]-a[0],dy=b[1]-a[1],length=Math.hypot(dx,dy)||1;
  const nx=-dy/length*width/2,ny=dx/length*width/2;
  left.push([p[0]+nx,p[1]+ny]);right.push([p[0]-nx,p[1]-ny]);
 });return [left,right];
}
function paintBand(ctx,left,right,color,alpha,edge=0,glow=false){
 ctx.save();ctx.fillStyle=color;ctx.strokeStyle=color;ctx.lineWidth=1;ctx.setLineDash([]);
 let a=[],b=[];
 function flush(){
  if(a.length>1){
   ctx.beginPath();[...a,...b.slice().reverse()].forEach(([x,y],i)=>i?ctx.lineTo(x,y):ctx.moveTo(x,y));ctx.closePath();ctx.globalAlpha=alpha;ctx.fill();
   if(edge>0){ctx.shadowColor=color;ctx.shadowBlur=glow?3:0;ctx.globalAlpha=edge;for(const line of [a,b]){ctx.beginPath();line.forEach(([x,y],i)=>i?ctx.lineTo(x,y):ctx.moveTo(x,y));ctx.stroke()}ctx.shadowBlur=0}
  }a=[];b=[];
 }
 for(let i=0;i<Math.min(left.length,right.length);i++){if(left[i]&&right[i]){a.push(left[i]);b.push(right[i])}else flush()}flush();ctx.restore();
}
function edgeConfidence(std){return Number.isFinite(std)?1/(1+Math.max(0,std)):0}
function paintLane(ctx,points,probability,color='#57d9b0'){const s=laneAppearance(probability);if(s.width>0)paintBand(ctx,...ribbonEdges(points,s.width),color,s.alpha,s.edge)}
function limitRoadPoints(points,limit=40){const result=(points||[]).filter(p=>p&&p.every(Number.isFinite)&&p[0]>=0&&p[0]<limit);const end=targetAt(points,limit);if(end)result.push(end);return result}
const highlightColors=[null,'#62ed9e','#edf7ff','#55b9ff','#ffa65a','#ff6175'];
function highlightBands(road){return [road?.left===1?'#62ed9e':null,highlightColors[road?.highlight]||null,road?.right===1?'#62ed9e':null]}
function targetAt(points,x){for(let i=1;i<(points?.length||0);i++){const a=points[i-1],b=points[i];if(a[0]<=x&&x<=b[0]&&b[0]>a[0])return [x,a[1]+(b[1]-a[1])*(x-a[0])/(b[0]-a[0])]}return null}
function blinkerLaneAnchors(lanes){
 // Sample the visible road at a common image depth; float just outside the ego lane.
 return [1,2].map((lane,side)=>{
  const points=lanes?.[lane]||[];let x=side?.68:.32;
  for(let i=1;i<points.length;i++){
   const a=points[i-1],b=points[i];if(!a||!b||!a.every(Number.isFinite)||!b.every(Number.isFinite))continue;
   if((a[1]-.74)*(b[1]-.74)<=0&&a[1]!==b[1]){x=a[0]+(b[0]-a[0])*(.74-a[1])/(b[1]-a[1])+(side?.045:-.045);break}
  }
  return [Math.max(.15,Math.min(.85,x)),.72];
 });
}
function drawBlinkers(ctx,road,time,left,right,centerY,anchors=null,glow=false){
 if(!road)return;
 const size=Math.max(10,Math.min(24,(right-left)/18)),phase=motionAllowed()?((time%1.2)+1.2)%1.2:0;
 ctx.save();ctx.lineWidth=1.5;ctx.lineJoin='round';ctx.strokeStyle='#a0ffe1';ctx.fillStyle='#62edb9';
 for(const [side,active,direction,fallback] of [[0,road.blinkerLeft,-1,left+size*3.8],[1,road.blinkerRight,1,right-size*3.8]]){
  const anchor=anchors?.[side],origin=anchor?anchor[0]-direction*size*1.85:fallback;
  if(!active)continue;
  for(let i=0;i<3;i++){
   const pulse=motionAllowed()?.25+.75*Math.max(0,1-Math.abs(phase-(.2+i*.25))/.35):1;
   const x=origin+direction*i*size*1.1,y=anchor?anchor[1]:centerY;
   ctx.beginPath();[[0,-1],[.65,-1],[1.5,0],[.65,1],[0,1],[.85,0]].forEach(([px,py],j)=>j?ctx.lineTo(x+direction*px*size,y+py*size):ctx.moveTo(x+direction*px*size,y+py*size));ctx.closePath();
   ctx.shadowBlur=0;ctx.globalAlpha=.24*pulse;ctx.fill();ctx.shadowColor='#a0ffe1';ctx.shadowBlur=glow?4:0;ctx.globalAlpha=pulse;ctx.stroke();
  }
 }ctx.restore();
}
// Derive easing from log time, so pause, reverse seeks and repeated playback are deterministic.
function blindspotLevels(frames,index,time){
 const current=frames[index];if(!current?.valid||!current.roadSignals)return [0,0];
 return ['blindspotLeft','blindspotRight'].map(key=>{
  if(!motionAllowed())return current.roadSignals[key]?1:0;
  let start=index;while(start>0&&time-frames[start].t<1.2)start--;
  let level=frames[start].roadSignals?.[key]?1:0;
  for(let i=start+1;i<=index;i++){
   const dt=Math.max(0,frames[i].t-frames[i-1].t),target=frames[i].roadSignals?.[key]?1:0;
   level=target+(level-target)*Math.exp(-dt/.15);
  }
  return level<.01?0:level>.99?1:level;
 });
}
// Slot transitions use log time: pause/seek/replay cannot leave a stale animation behind.
function ccncBoxTransitions(frames,index,time){
 const current=frames[index];if(!current?.valid)return [];
 const rise=.45,fade=.6,motion=motionAllowed();
 const find=(i,slot)=>{
  const frame=frames[i];if(!frame?.valid||!Array.isArray(frame.ccncTargets))return null;
  const targetIndex=frame.ccncTargets.findIndex(target=>target.slot===slot),target=frame.ccncTargets[targetIndex];
  if(!target)return null;
  const marker=frame.overlay?.markers?.find(marker=>marker.kind==='ccnc'&&marker.index===targetIndex);
  return target&&marker?.box?.length===8?{target,marker}:null;
 };
 const connected=i=>i>0&&frames[i-1].valid&&frames[i].t-frames[i-1].t<=.15;
 const ease=value=>{const p=Math.max(0,Math.min(1,value));return p*p*(3-2*p)};
 const entries=[];
 for(const slot of ['LF','FF','RF']){
  let source=index,entry=find(source,slot);
  if(!entry&&motion)while(connected(source)&&time-frames[source].t<fade){
   entry=find(--source,slot);if(entry)break;
  }
  if(!entry)continue;
  const fading=source!==index,alpha=fading?1-ease((time-frames[source+1].t)/fade):1;
  if(alpha<=0)continue;
  let height=1;
  if(motion){
   const growthTime=fading?frames[source+1].t:time;let start=source;
   // Reuse the visible slot across brief dropouts, including stale CAN samples.
   // Only inspect enough history to establish a fully grown box, never the whole log.
   while(growthTime-frames[start].t<rise){
    let previous=start;
    while(connected(previous)&&frames[start].t-frames[previous-1].t<=fade){
     previous--;if(find(previous,slot))break;
    }
    if(previous===start||!find(previous,slot))break;
    start=previous;
   }
   // A target already present at a log boundary is not a new detection.
   if(connected(start))height=ease((growthTime-frames[start].t)/rise);
  }
  entries.push({...entry,height,alpha,animated:fading||height<1});
 }
 return entries;
}
function horizontalTargetLine(points){
 if(points?.length!==2||!points.every(p=>p?.length===2&&p.every(Number.isFinite)))return null;
 const y=(points[0][1]+points[1][1])/2;
 return points.map(p=>[p[0],y]);
}
function targetSectionPoints(section,width=modelPathWidth){
 if(!section?.every(p=>p?.length===3&&p.every(Number.isFinite)))return null;
 const [center,side]=section,points=[-1,1].map(sign=>center.map((v,k)=>v+sign*width/2*side[k]));
 return points.every(p=>p[2]>.1)?horizontalTargetLine(points.map(p=>[p[0]/p[2],p[1]/p[2]])):null;
}
function targetBrakeLevel(frames,index){
 const current=frames[index];if(!current?.valid||!Number.isFinite(current.roadSignals?.acceleration))return 0;
 let sum=0,weights=0;
 for(let i=index;i>=0;i--){
  const frame=frames[i],age=current.t-frame.t;if(age>.25||!frame.valid||!Number.isFinite(frame.roadSignals?.acceleration))break;
  const weight=1-age/.3;sum+=Math.max(0,-frame.roadSignals.acceleration)*weight;weights+=weight;
 }
 return Math.min(1,sum/weights/3);
}
function targetGradient(ctx,a,b,color){
 const gradient=ctx.createLinearGradient(...a,...b);
 for(const [position,alpha] of [[0,'00'],[.18,'cc'],[.5,'ff'],[.82,'cc'],[1,'00']])gradient.addColorStop(position,color+alpha);
 return gradient;
}
function paintTargetLine(ctx,a,b,color,glow=false){
 ctx.save();ctx.strokeStyle=targetGradient(ctx,a,b,color);ctx.lineWidth=glow?3:2;ctx.setLineDash([]);ctx.lineCap='round';
 if(glow){ctx.shadowColor=color;ctx.shadowBlur=7}
 ctx.beginPath();ctx.moveTo(...a);ctx.lineTo(...b);ctx.stroke();ctx.restore();
}
function ccncTargetColor(target){return target?.slot==='FF'?'#8deeff':'#4aaaff'}
function hudLabel(ctx,text,x,y,color,left=4,right=ctx.canvas.clientWidth||ctx.canvas.width,background=true){
 ctx.save();const opacity=ctx.globalAlpha;ctx.font='600 11px system-ui';ctx.textAlign='center';ctx.textBaseline='middle';ctx.shadowBlur=0;
 const width=ctx.measureText(text).width+18,height=23;
 x=Math.max(left+width/2,Math.min(right-width/2,x));y=Math.max(height/2+4,y);
 if(background){ctx.beginPath();ctx.roundRect(x-width/2,y-height/2,width,height,5);ctx.globalAlpha=.7*opacity;ctx.fillStyle='#071b2d';ctx.fill();
 ctx.strokeStyle=color;ctx.lineWidth=.7;ctx.globalAlpha=.65*opacity;ctx.stroke()}ctx.fillStyle=color;ctx.globalAlpha=opacity;ctx.fillText(text,x,y);ctx.restore();
}
// Smooth, repeatable irregular movement along the road; never randomize each frame.
function blindspotStreakPosition(index,time,count=10){
 const base=(index+1)/(count+1),amplitude=Math.min(.10,base*.8,(1-base)*.8),phase=index*2.39996;
 return base+amplitude*(.65*Math.sin(time*(.75+index*.037)+phase)+.35*Math.sin(time*.43+phase*1.7));
}
function paintBlindspotEdge(ctx,w,h,amount,side,time){
 if(amount<=0)return;
 ctx.save();
 const pulse=motionAllowed()?.88+.12*Math.sin(time*2):1;
 ctx.globalAlpha=amount*pulse;
 // An elliptical glow fades both toward the road and toward the top/bottom.
 ctx.translate(side?w:0,(h+22)/2);ctx.scale(Math.min(30,w*.06),Math.max(1,(h-30)/2));
 const glow=ctx.createRadialGradient(0,0,0,0,0,1);
 glow.addColorStop(0,'#ffce55b0');glow.addColorStop(.25,'#ffc53675');glow.addColorStop(.65,'#ffbd2928');glow.addColorStop(1,'#ffbd2900');
 ctx.fillStyle=glow;ctx.fillRect(side?-1:0,-1,1,2);ctx.restore();
 ctx.save();ctx.globalAlpha=amount*pulse;
 const rim=ctx.createLinearGradient(0,22,0,h-8);
 rim.addColorStop(0,'#ffda7000');rim.addColorStop(.15,'#ffda70b0');rim.addColorStop(.5,'#ffe59be6');rim.addColorStop(.85,'#ffda70b0');rim.addColorStop(1,'#ffda7000');
 ctx.fillStyle=rim;ctx.fillRect(side?w-2:0,22,2,Math.max(0,h-30));ctx.restore();
}

function paintBlindspotWall(ctx,bottom,top,amount,time,glow=false){
 if(amount<=0)return;ctx.save();ctx.strokeStyle='#ffd367';ctx.lineWidth=.7;ctx.setLineDash([]);
 const grid=new Path2D(),rim=new Path2D(),base=new Path2D(),surface=new Path2D();
 // Fill each continuous wall once: per-segment gradients create visible broad bands.
 if(glow){
  let run=[];
  const flush=()=>{if(run.length>1){surface.moveTo(...bottom[run[0]]);for(const j of run.slice(1))surface.lineTo(...bottom[j]);for(const j of run.slice().reverse())surface.lineTo(...top[j]);surface.closePath()}run=[]};
  for(let j=0;j<bottom.length;j++){if(bottom[j]&&top[j])run.push(j);else flush()}flush();
  const points=bottom.concat(top).filter(Boolean);
  if(points.length){const ys=points.map(p=>p[1]),gradient=ctx.createLinearGradient(0,Math.min(...ys),0,Math.max(...ys)+1);gradient.addColorStop(0,'#ffc94718');gradient.addColorStop(.55,'#ffcd4930');gradient.addColorStop(1,'#ffb92852');ctx.fillStyle=gradient;ctx.globalAlpha=amount;ctx.fill(surface)}
 }
 for(let i=1;i<bottom.length;i++){
  const a=bottom[i-1],b=bottom[i],c=top[i],d=top[i-1];if(!a||!b||!c||!d)continue;
  if(!glow){const gradient=ctx.createLinearGradient(a[0],a[1],d[0],d[1]);gradient.addColorStop(0,glow?'#e99b286e':'#ffbd3840');gradient.addColorStop(.45,glow?'#b9792938':'#ffd84d18');gradient.addColorStop(1,glow?'#ffd65a45':'#ffdd5510');ctx.fillStyle=gradient;
  ctx.beginPath();[a,b,c,d].forEach((p,j)=>j?ctx.lineTo(...p):ctx.moveTo(...p));ctx.closePath();ctx.globalAlpha=amount;ctx.fill()}
  if(!glow){grid.moveTo(...a);grid.lineTo(...d)}
  if(!glow)for(const ratio of [.25,.5,.75]){grid.moveTo(a[0]+(d[0]-a[0])*ratio,a[1]+(d[1]-a[1])*ratio);grid.lineTo(b[0]+(c[0]-b[0])*ratio,b[1]+(c[1]-b[1])*ratio)}
  for(const [p,q] of [[a,b],[d,c]]){rim.moveTo(...p);rim.lineTo(...q)}
  base.moveTo(...a);base.lineTo(...b);
  if(i===1||!bottom[i-2]||!top[i-2]){rim.moveTo(...a);rim.lineTo(...d)}
  if(i===bottom.length-1||!bottom[i+1]||!top[i+1]){rim.moveTo(...b);rim.lineTo(...c)}
 }
 if(!glow){ctx.globalAlpha=amount*.3;ctx.stroke(grid)}
 if(glow){
  const clock=motionAllowed()?time:0;
  const at=(points,position)=>{const x=position*(points.length-1),i=Math.min(points.length-2,Math.floor(x)),a=points[i],b=points[i+1];return a&&b?a.map((v,k)=>v+(b[k]-v)*(x-i)):null};
  for(let i=0;i<64;i++){
   const position=blindspotStreakPosition(i,clock,64),a=at(bottom,position),b=at(top,position);if(!a||!b)continue;
   const lit=i%2===0,strong=i%8===0;
   ctx.beginPath();ctx.moveTo(...a);ctx.lineTo(...b);
   if(strong){ctx.strokeStyle='#ffc64b';ctx.lineWidth=2.5;ctx.globalAlpha=amount*.16;ctx.shadowColor='#ffc13e';ctx.shadowBlur=5;ctx.stroke()}
   ctx.strokeStyle=strong?'#ffe9a0':'#ffd368';ctx.lineWidth=strong?1.2:(lit?.7:.45);ctx.globalAlpha=amount*(strong?.8:(lit?.32:.12)+.08*(.5+.5*Math.sin(clock*.65+i*1.7)));ctx.shadowColor='#ffc83d';ctx.shadowBlur=lit?2:0;
   ctx.stroke();ctx.shadowBlur=0;
  }
  // Perimeter styling is independent of the thin moving vertical streaks.
  ctx.strokeStyle='#ffbc35';ctx.lineWidth=5;ctx.globalAlpha=amount*.22;ctx.shadowColor='#ffc13e';ctx.shadowBlur=10;ctx.stroke(rim);
  ctx.lineWidth=7;ctx.globalAlpha=amount*.25;ctx.shadowBlur=14;ctx.stroke(base);
  ctx.lineWidth=2;ctx.globalAlpha=amount*.9;ctx.shadowBlur=5;ctx.stroke(base);
 }
 ctx.strokeStyle='#ffe18a';ctx.lineWidth=glow?1.8:1.4;ctx.globalAlpha=amount*.95;ctx.shadowColor='#ffc83d';ctx.shadowBlur=glow?4:0;ctx.stroke(rim);ctx.restore();
}

let modelPathWidth=1.86;
try{const saved=localStorage.getItem('roadviewer-path-width');if(saved!==null&&Number.isFinite(Number(saved)))modelPathWidth=Math.max(1,Math.min(3,Number(saved)))}catch{}
let renderedFrame='';
function render(lazy){
 window.renderTelemetry?.();
 // Playback ticks at the display rate (60 Hz+) but model frames change at 20 Hz: redraw only on a new frame.
 const frameKey=data?`${idx}|${frameAvailable(data.frames[idx])}|${v.hidden}`:'';
 if(lazy===true&&frameKey===renderedFrame){window.renderVideoOverlayMotion?.();return;}
 renderedFrame=frameKey;
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
 function line(points,color,dashed,alpha,width=2){path(points);ctx.strokeStyle=color;ctx.lineWidth=width;ctx.globalAlpha=alpha;ctx.setLineDash(dashed?[6,5]:[]);ctx.stroke();ctx.setLineDash([]);ctx.globalAlpha=1}
 if(valid){
  const screen=points=>(points||[]).map(p=>p?[X(p[1]),Y(p[0])]:null);
  if(checked('ccncRoad')){
   highlightBands(f.ccncRoad).forEach((color,i)=>{if(color)paintBand(ctx,screen(f.lanes[i]),screen(f.lanes[i+1]),color,.1,.55)});
   const road=f.ccncRoad;
   if([1,3].includes(road?.target)&&road.distance>0&&road.distance<204.6&&road.distance<=range){
    const a=targetAt(f.lanes[1],road.distance),b=targetAt(f.lanes[2],road.distance);
    if(a&&b){const center=(a[1]+b[1])/2;paintTargetLine(ctx,[X(center-modelPathWidth/2),Y(road.distance)],[X(center+modelPathWidth/2),Y(road.distance)],road.target===3?'#edf7ff':'#7be5ff');if(checked('targetLabels'))hudLabel(ctx,`TARGET · ${road.distance.toFixed(1)} m`,X((a[1]+b[1])/2),Y(road.distance)-17,'#d9faff')}
   }
  }
  if(checked('modelPath')&&f.position?.length>1)line(f.position,'#c4a5ff',false,.9,2);
  if(checked('lanes')){
   if(f.lanes[1]?.length&&f.lanes[2]?.length){path([...f.lanes[1],...f.lanes[2].slice().reverse()]);ctx.closePath();ctx.fillStyle='rgba(87,217,176,0.065)';ctx.fill()}
   f.lanes.forEach((l,i)=>{const p=Number.isFinite(f.lp[i])?Math.max(0,Math.min(1,f.lp[i])):0;line(l,'#57d9b0',p<.5,p,1+3*p)});
  }
  if(checked('edges'))f.edges.forEach((l,i)=>line(l,'#ffa665',f.es[i]>1,.95));

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
 if(checked('ccncTargets')&&frameAvailable(f))for(const target of f.ccncTargets||[]){
  if(target.x<0||target.x>range)continue;
  const x=X(target.y),y=Y(target.x),color=ccncTargetColor(target);
  ctx.strokeStyle=color;ctx.lineWidth=2;ctx.strokeRect(x-8,y-11,16,22);
  if(checked('boxLabels')){
   const text=`${target.slot} · ${targetValue(target,target.yRel)}`;
   if(checked('boxLabelsBelow'))hudLabel(ctx,text,x,y+24,color,4,ctx.canvas.clientWidth||ctx.canvas.width,false);
   else annotate(text,x,y,color,target.slot==='LF'?-1:1);
  }
 }
 $('ccncStatus').textContent=checked('ccncTargets')&&(!frameAvailable(f)||f.ccncTargets==null)?'이 시점의 CCNC 송신 데이터가 없습니다.':'';
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
 if(valid&&checked('bsdWalls'))blindspotLevels(data.frames,idx,t).forEach((amount,i)=>paintBlindspotEdge(ctx,w,h,amount,i,t));
 if(checked('ccncRoad')&&frameAvailable(f))drawBlinkers(ctx,f.roadSignals??f.ccncRoad,f.t,42,w-16,(h-48)/2);
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
new ResizeObserver(render).observe(canvas);loadData().catch(e=>playbackError(e.message));requestAnimationFrame(tick);

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
  if(data||active)renderRecordingName($('routeName'),data?.route||active.name,recordingNameFiles).id='route';
  populateSegments(logs,current);
  const index=logs.findIndex(log=>log.id===current);
  const neighbors=index<0?[]:[logs.slice(index+1).find(log=>log.status==='ready'),logs.slice(0,index).reverse().find(log=>log.status==='ready')];
  buttons.forEach((button,i)=>{
   const log=neighbors[i];button.disabled=!log;
   const route=logSegmentInfo(active?.name)?.route,sameRoute=route&&logSegmentInfo(log?.name)?.route===route;
   button.textContent=(i===0?'이전 ':'다음 ')+(sameRoute?'구간':'로그');
   button.title=log?log.name:'이동할 재생 가능한 로그가 없습니다.';
   button.onclick=log?()=>location.assign('../'+encodeURIComponent(log.id)+'/'):null;
  });
 }catch{buttons.forEach(button=>{button.disabled=true;button.title='로그 목록을 불러오지 못했습니다. 새로고침해 주세요.'})}
}
const pageReady=loadLogNavigation();

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
 // Fold with the 매거진 홈 timing: the pinned bar slides from where it is to its new sticky offset while the
 // navigation row fades. Only transform and opacity move, so the content underneath never shifts.
 let foldMotion=null;
 const stopFold=()=>{if(!foldMotion)return;foldMotion.forEach(motion=>motion.cancel());foldMotion=null;replayHeading.classList.remove('is-folding')};
 fold.onclick=()=>{
  const from=replayHeading.getBoundingClientRect().top,fade=Number(getComputedStyle(navigation).opacity);
  stopFold();
  headingCollapsed=!headingCollapsed;try{localStorage.setItem(preference,String(headingCollapsed))}catch{}updateHeading();
  const shift=from-replayHeading.getBoundingClientRect().top;
  if(!replayHeading.classList.contains('is-stuck')||Math.abs(shift)<1||matchMedia('(prefers-reduced-motion: reduce)').matches)return;
  const options={duration:250,easing:'cubic-bezier(0.4, 0, 0.2, 1)'};
  replayHeading.classList.add('is-folding');
  const motions=[replayHeading.animate([{transform:`translateY(${shift}px)`},{transform:'translateY(0)'}],options),
   navigation.animate([{opacity:fade},{opacity:headingCollapsed?0:1}],options)];
  foldMotion=motions;
  Promise.all(motions.map(motion=>motion.finished)).then(()=>{if(foldMotion===motions)stopFold()}).catch(()=>{});
 };
 window.addEventListener('scroll',()=>{stopFold();scheduleHeading()},{passive:true});
 window.addEventListener('resize',scheduleHeading);
 window.addEventListener('pageshow',scheduleHeading);
 const headingResize=new ResizeObserver(scheduleHeading);
 headingResize.observe(navigation);
 // Loading/status text can move the sticky anchor without a scroll or navigation resize.
 headingResize.observe(document.querySelector('main>header'));
 updateHeading();
}

// Share layer and label preferences between recordings on this browser.
const displayPreferenceKey='roadviewer-display-preferences';
const displayControls=[...document.querySelectorAll('.road-panel .layers input, .overlay-settings-body input')];
try{
 const saved=JSON.parse(localStorage.getItem(displayPreferenceKey)||'null');
 if(saved&&typeof saved==='object'){
  // Preserve the previous combined box/BSD choice; TARGET was always visible.
  if(typeof saved.checks?.boxBsdLabels==='boolean')for(const id of ['boxLabels','bsdLabels']){
   if(typeof saved.checks[id]!=='boolean')saved.checks[id]=saved.checks.boxBsdLabels;
  }
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
const pathWidthSlider=$('modelPathWidth'),pathWidthValue=$('modelPathWidthValue');
const syncPathWidth=()=>{pathWidthSlider.value=String(Math.round(modelPathWidth*100));pathWidthValue.textContent=modelPathWidth.toFixed(2)+' m'};
syncPathWidth();pathWidthSlider.oninput=()=>{modelPathWidth=Number(pathWidthSlider.value)/100;syncPathWidth();try{localStorage.setItem('roadviewer-path-width',String(modelPathWidth))}catch{}render()};
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
