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
// The play button is an icon; its hidden text stays the accessible name.
function playLabel(on){const button=$('play');button.querySelector('.play-label').textContent=on?'일시정지':'재생';button.dataset.playing=String(on)}
function pause(){playing=false;pauseVideo();playLabel(false)}
let videoPlayPending=false,videoPauseRevision=0,videoSource=null,resumeAfterVideo=false;
const failedVideos=new Set();
let pendingVideoSeek=null,seekPointer=null,seekReleased=false;
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
function firstVideoFrame(){return !!data?.video&&data.video.start>0&&data.video.start<=LOG_EDGE_TOLERANCE+1e-6&&t>=0&&t<data.video.start}
function videoAvailable(){return !!data?.video&&(t>=data.video.start||firstVideoFrame())&&(t<data.video.start+data.video.duration||finalVideoFrame())}
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
 if(!visible){pendingVideoSeek=null;pauseVideo();return}
 const duration=Number.isFinite(v.duration)?v.duration:data.video.duration;
 const target=Math.max(0,Math.min(hold?duration:t-data.video.start,duration-.001));
 // Keep only the latest requested position until the current asynchronous seek finishes.
 if(seek||wasHidden)pendingVideoSeek=target;
 // Releasing the seek bar goes straight to the final position, replacing a preview seek still in flight: with a
 // video read over the network (Google Drive) waiting for that one first would cost another round trip.
 const released=seekReleased;seekReleased=false;
 if(v.readyState>=1&&(!v.seeking||released)){
  const requested=pendingVideoSeek;pendingVideoSeek=null;
  const next=requested??target,threshold=hold ? .002 : requested!==null ? .0005 : .35;
  if(Math.abs(v.currentTime-next)>threshold)v.currentTime=next;
 }
 // Hold boundary frames; play() on ended media would rewind it to frame zero.
 if(hold||firstVideoFrame()||t>=data.duration){pauseVideo();return}
 if(playing&&seekPointer===null&&v.paused&&!videoPlayPending&&!v.seeking&&pendingVideoSeek===null&&!v.ended&&v.readyState>=3){
  videoPlayPending=true;const pauseRevision=videoPauseRevision;
  v.play().catch(e=>{if(pauseRevision===videoPauseRevision&&playing&&videoAvailable()&&!finalVideoFrame()){videoFailure('영상을 재생할 수 없습니다. '+e.message)}}).finally(()=>{videoPlayPending=false;if(!playing||seekPointer!==null||!videoAvailable()||firstVideoFrame()||finalVideoFrame())pauseVideo()});
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
// The time readout is a toggle that swaps current time (default) for the total length in the same reserved width; the label carries both.
let timeTotal=false;try{timeTotal=localStorage.getItem('roadviewer-time-total')==='1'}catch{}
function renderTime(){const el=$('time'),full=`${clock(t)} / ${clock(data?.duration||0)}`,label=full+' · 눌러서 전체 길이 표시/숨기기';el.children[0].textContent=clock(t);el.children[1].textContent=clock(data?.duration||0);el.title=label;el.setAttribute('aria-label',label);el.setAttribute('aria-pressed',String(timeTotal))}
$('time').onclick=()=>{timeTotal=!timeTotal;try{timeTotal?localStorage.setItem('roadviewer-time-total','1'):localStorage.removeItem('roadviewer-time-total')}catch{}renderTime()};renderTime();
function setTime(time,seekVideo=true,lazy=false){if(!data)return;t=Math.max(0,Math.min(time,data.duration));idx=nearest(t);$('seek').value=t;$('seekPlayed').style.width=`${data.duration>0?t/data.duration*100:0}%`;renderTime();if(t>=data.duration&&seekPointer===null&&playing)pause();syncVideo(seekVideo);render(lazy);window.renderBookmarks?.()}
function step(n){if(loading)return;pause();if(data)setTime(data.frames[Math.max(0,Math.min(data.frames.length-1,idx+n))].t)}
function toggle(){if(!data||loading)return;if(playing){pause();return}if(t>=data.duration-.05)setTime(0);playing=true;last=performance.now();playLabel(true);syncVideo(true)}
function tick(now){
 now=Math.max(now,last);
 if(playing&&data){
  const waiting=seekPointer!==null||videoAvailable()&&!firstVideoFrame()&&!finalVideoFrame()&&(v.seeking||pendingVideoSeek!==null||v.readyState<3&&!v.ended);
  if(waiting)syncVideo();
  else{const next=t+(now-last)/1000*Number($('speed').value);setTime(next>=data.duration-.001?data.duration:next,false,true);if(t>=data.duration)pause()}
 }else window.renderVideoOverlayMotion?.();
 last=now;requestAnimationFrame(tick);
}
function setPlaybackState(ready,message){
 loading=!ready;$('play').disabled=!ready;
 $('playbackControls').hidden=!ready;$('playbackMessage').hidden=ready;
 $('playbackMessage').textContent=ready?'':message;$('status').textContent=message;$('status').dataset.state=ready?'ready':'busy';
}
function playbackError(message){pendingVideoSeek=null;seekPointer=null;videoReadyPending=false;pause();setPlaybackState(false,message);$('status').textContent='재생 불가';$('status').dataset.state='error';showError(message)}
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
 // Own-lane lines marked dashed: one ribbon per dash, sampled every 0.5 m (same width rule as band()).
 const period=LANE_DASH+LANE_GAP,phase=laneDashPhase(frame);
 const laneDashBands=g.lanes.map((points,i)=>{
  if(LANE_LINE_CODES[laneLineCode(frame,i)]?.type!=='dashed'||points.length<2||!points.every(p=>p.length===3&&p.every(Number.isFinite)))return null;
  const width=.15*Math.max(0,Math.min(1,Number.isFinite(frame.lp?.[i])?Math.min(.75,frame.lp[i]):0)),start=Math.max(0,points[0][0]),end=Math.min(120,points.at(-1)[0]),dashes=[];
  for(let from=Math.floor((start+phase)/period)*period-phase;from<end;from+=period){
   const a=Math.max(start,from),b=Math.min(end,from+LANE_DASH);if(b-a<.05)continue;
   const xs=[];for(let x=a;x<b;x+=.5)xs.push(x);xs.push(b);
   const ps=xs.map(x=>sample(points,x)).filter(Boolean);if(ps.length<2)continue;
   dashes.push([-1,1].map(sign=>ps.map((p,k)=>{const n=normal(ps,k);return screen(p.map((v,j)=>v+n[j]*width*sign))})));
  }
  return dashes;
 });
 return {lanes:g.lanes.map(line=>line.map(screen)),laneDashBands,edges:g.edges.map(line=>line.map(screen)),path:path.map(([x,y,z])=>screen([x,y,z+height])),
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

// ADRV_0x161 LANELINE_LEFT/RIGHT (frame.ccncRoad.laneLeft/laneRight): the own-lane lines as sent to the cluster.
// Undocumented codes keep the default lane style. The dash pattern is a symbol (3 m line, 4 m gap) anchored to
// the distance travelled, so it flows past like paint.
const LANE_LINE_CODES={0:{color:'#8b97a6',type:'solid',label:'회색'},1:{color:'#8b97a6',type:'hidden',label:'숨김'},2:{color:'#eef3f8',type:'solid',label:'흰색 실선'},
 4:{color:'#ff9f43',type:'solid',label:'주황 실선'},6:{color:'#4cd964',type:'solid',label:'녹색 실선'},8:{color:'#eef3f8',type:'dashed',label:'흰색 점선'},10:{color:'#4cd964',type:'dashed',label:'녹색 점선'}};
const LANE_DASH=3,LANE_GAP=4;
function laneLineCode(frame,i){const road=frame?.ccncRoad;return i===1?road?.laneLeft:i===2?road?.laneRight:undefined}
function laneMarkingStyle(frame,i){return $('laneMarking')?.checked&&LANE_LINE_CODES[laneLineCode(frame,i)]||null}
function laneDashPhase(frame){const period=LANE_DASH+LANE_GAP;return (((frame?.odometer||0)%period)+period)%period}
function expandReplayData(replay){
 overlayGeometryCache.clear();
 // Older conversions warned about skipped new event types; those never affect the replay.
 if(Array.isArray(replay.warnings))replay.warnings=replay.warnings.filter(w=>!String(w).startsWith('지원하지 않는 새 로그 이벤트'));
 const infos=replay.cameraInfos;let odometer=0,previous=null;
 for(const frame of replay.frames){
  // Distance travelled, for lane dashes that move with the road.
  if(previous&&Number.isFinite(previous.egoSpeedKph)&&frame.t>previous.t&&frame.t-previous.t<1)odometer+=previous.egoSpeedKph/3.6*(frame.t-previous.t);
  frame.odometer=odometer;previous=frame;
  if(infos&&typeof frame.cameraInfo==='number')frame.cameraInfo=infos[frame.cameraInfo];
  frame.liveTracks?.forEach((target,i)=>{target.index??=i;target.y??=-target.yRel});
  frame.radarTargets?.forEach(target=>{target.y??=-target.yRel});
  if(frame.overlay?.geometry){let source=frame.overlay;Object.defineProperty(frame,'overlay',{configurable:true,enumerable:true,get:()=>frameOverlay(frame,source),set:value=>{source=value;overlayGeometryCache.delete(frame)}});continue}
  for(const marker of frame.overlay?.markers||[])if(!marker.point&&marker.projection){const [a,b,c]=marker.projection;marker.point=[a/c,b/c]}
 }
 return replay;
}
const videoLabels={front:'고화질 전방',qcamera:'전방 · 저용량',wide:'와이드'};
// The camera a video opens on follows the per-browser choice for the connection in use (mobile data or Wi-Fi/wired).
// Only some browsers (Chromium on Android) report the connection type; elsewhere phones and tablets (touch, no hover)
// count as mobile data and other devices as Wi-Fi/wired.
const videoQuality={cellular:{key:'roadviewer-video-quality-cellular',default:'qcamera',label:'모바일 데이터'},wifi:{key:'roadviewer-video-quality-wifi',default:'front',label:'와이파이 · 유선'}};
function videoNetwork(){
 const type=navigator.connection?.type;
 if(type==='cellular')return {network:'cellular',known:true};
 if(['wifi','ethernet','wimax'].includes(type))return {network:'wifi',known:true};
 return {network:matchMedia('(hover:none),(pointer:coarse)').matches?'cellular':'wifi',known:false};
}
function preferredQuality(network){
 const choice=videoQuality[network];
 try{const saved=localStorage.getItem(choice.key);if(saved==='front'||saved==='qcamera')return saved}catch{}
 return choice.default;
}
const videoOrder=()=>preferredQuality(videoNetwork().network)==='qcamera'?['qcamera','front','wide']:['front','qcamera','wide'];
function setupVideoSources(){
 failedVideos.clear();resumeAfterVideo=false;
 const choices=data.videos|| (data.video?{qcamera:data.video}:{}),select=$('videoSource');
 select.replaceChildren(...Object.keys(videoLabels).filter(key=>choices[key]).map(key=>new Option(videoLabels[key],key)));
 $('videoSourceControl').hidden=select.options.length<2;
 select.dispatchEvent(new Event('rv:sync'));
 return videoOrder().find(key=>choices[key])||null;
}
function selectVideo(source){
 const info=(data.videos||{qcamera:data.video})[source];if(!info)return;
 pendingVideoSeek=null;seekPointer=null;
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
function videoFailure(message,keepLog=false){
 if(!data?.video)return;
 failedVideos.add(videoSource);
 const source=videoOrder().find(key=>data.videos?.[key]&&!failedVideos.has(key));
 if(source){selectVideo(source);showError('선택한 영상을 읽지 못해 '+videoLabels[source]+' 영상으로 전환했습니다.');return}
 resumeAfterVideo=false;
 if(!keepLog){playbackError(message);return}
 // The video store is unreachable: the log replays without video; choosing a camera again retries.
 data.video=null;videoReadyPending=false;v.removeAttribute('src');v.load();setPlaybackState(true,'재생 준비 완료');showError(message);setTime(t);
}
const STORAGE_FAILURE='영상 저장소에 연결할 수 없습니다. 저장소 연결을 확인하세요.',STORAGE_RETRIES=3;
let storageRetries=0,storageRetryTimer=null;
async function videoError(){
 // The <video> element hides the HTTP status; only after an error, one byte is requested to read it.
 if(!data?.video)return;
 const src=v.src;let status=0,body=null,after=5;
 try{
  const res=await fetch(src,{headers:{Range:'bytes=0-0'},cache:'no-store'});status=res.status;
  if(status===503){after=Number(res.headers.get('Retry-After'))||after;body=await res.json().catch(()=>null)}else res.body?.cancel();
 }catch{}
 if(v.src!==src||!data?.video)return;
 // The store was still being checked (first visit after a while): load the same video again shortly.
 if(status===503&&body?.error==='storage_checking'&&storageRetries<STORAGE_RETRIES){
  storageRetries++;setPlaybackState(false,'영상 저장소 연결을 확인하는 중입니다. 잠시 기다려 주세요.');
  clearTimeout(storageRetryTimer);storageRetryTimer=setTimeout(()=>{if(v.src===src&&data?.video)selectVideo(videoSource)},Math.min(after,10)*1000);return;
 }
 // The server names the store that failed (Google Drive or the NAS).
 if(status===503)videoFailure(typeof body?.message==='string'&&body.message?body.message:STORAGE_FAILURE,true);
 else videoFailure('브라우저가 영상을 읽지 못했습니다. Home Assistant 연결을 확인하고 새로고침해 주세요.');
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
$('seek').addEventListener('pointerdown',e=>{if(loading||e.button!==0)return;seekPointer=e.pointerId;pauseVideo()});
function finishSeekDrag(){if(seekPointer===null)return;seekPointer=null;seekReleased=true;setTime(Number($('seek').value));seekReleased=false;last=performance.now()}
for(const event of ['pointerup','pointercancel'])window.addEventListener(event,e=>{if(e.pointerId===seekPointer)finishSeekDrag()});
window.addEventListener('blur',finishSeekDrag);
v.addEventListener('seeked',()=>{last=performance.now();if(data)syncVideo()});
v.addEventListener('canplay',()=>{last=performance.now()});
v.onloadedmetadata=()=>{if(!data||v.error)return;v.playbackRate=Number($('speed').value);setTime(t)};v.oncanplay=()=>{if(data?.video&&!v.error&&videoReadyPending){videoReadyPending=false;storageRetries=0;setPlaybackState(true,'재생 준비 완료');if(resumeAfterVideo){resumeAfterVideo=false;playing=true;last=performance.now();playLabel(true);syncVideo(true)}}};v.onended=()=>{if(playing&&data?.video&&seekPointer===null&&pendingVideoSeek===null&&!v.seeking){setTime(Math.max(t,data.video.start+data.video.duration),false);last=performance.now();if(t>=data.duration)pause()}};v.onerror=videoError;
for(const id of ['range','rearView','lanes','edges','leads','radarCenter','radarLeft','radarRight','liveTracks','ccncTargets','ccncMotion','ccncRoad','laneMarking','boxLabels','boxLabelsBelow','bsdLabels','targetLabels','bsdWalls','hideScc','trackLabels','yRelLabels','distanceLabels','liveTrackLabels','speedLabels','relativeSpeedLabels','hideLabels'])$(id).onchange=render;
// Space and arrows keep their own meaning on focused controls, links and menus.
document.onkeydown=e=>{if(document.querySelector('dialog[open]')||['INPUT','TEXTAREA','SELECT','BUTTON','SUMMARY','A'].includes(document.activeElement.tagName))return;if(e.code==='Space'){e.preventDefault();toggle()}if(e.code==='ArrowLeft'){e.preventDefault();step(-1)}if(e.code==='ArrowRight'){e.preventDefault();step(1)}};
// The road map is not on the video, so its colours follow the screen mode. Dark values equal the original palette;
// literal colours shared with the video overlay are translated here only.
const MAP_TONES={'#57d9b0':'lane','#ff5c5c':'edge','#c4a5ff':'path','#81b5ff':'lead','#c5daff':'lead-text','#eee7bc':'selected','#78e9fa':'raw','#4aaaff':'ccnc','#8deeff':'ccnc-ff','#d09aff':'center','#ffda76':'left','#ff91b5':'right','#eef3f8':'white','#8b97a6':'gray','#ff9f43':'orange','#4cd964':'green','#62ed9e':'band','#edf7ff':'band-white','#55b9ff':'blue','#ffa65a':'band-orange','#ff6175':'red','#7be5ff':'target'};
let mapPalette={};
function readMapPalette(){const style=getComputedStyle(canvas);mapPalette={};for(const name of new Set([...Object.values(MAP_TONES),'grid','text','rear','axis','guide','ego','warn','lane-fill','asphalt','label']))mapPalette[name]=style.getPropertyValue('--map-'+name).trim()}
const mapInk=name=>mapPalette[name],tone=color=>mapPalette[MAP_TONES[color]]||color;
readMapPalette();
window.addEventListener('rv:themechange',()=>{readMapPalette();renderedFrame='';render()});
const targetStyle={center:{label:'중앙',color:'#d09aff',toggle:'radarCenter'},left:{label:'왼쪽',color:'#ffda76',toggle:'radarLeft'},right:{label:'오른쪽',color:'#ff91b5',toggle:'radarRight'}};
function renderSteering(f){
 const s=frameAvailable(f)?f.steering:null,labels={driver:'운전자 조향 개입',active:'조향 제어 중',inactive:'조향 제어 꺼짐',unknown:'상태 확인 불가'};
 const label=labels[s?.state]||labels.unknown;
 const detail=label+(s?.angle!=null?` · ${s.angle.toFixed(1)}°`:'')+(s?.torque==null?' · 토크 정보 없음':'')+(s?.critical?' · 핸들 조작 요청':'');
 $('steeringStatus').title=detail;$('steeringBadge').hidden=!(s?.state==='driver'&&s.active!==false);$('steeringIcon').setAttribute('aria-label',detail);
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
// New detections rise from the ground; a car that moves to another slot (e.g. FF -> LF on a lane change) slides
// there instead of fading out and rising again; positions glide between 20 Hz samples. A missing sample dims the
// box at once so brief dropouts stay visible. The "부드러운 움직임" setting turns the motion off.
const CCNC_SLOTS=['LF','FF','RF'];
function ccncSmoothMotion(){return motionAllowed()&&document.getElementById('ccncMotion')?.checked!==false}
function mixColor(a,b,k){
 const parse=c=>[1,3,5].map(i=>parseInt(c.slice(i,i+2),16)),[x,y]=[parse(a),parse(b)];
 return '#'+x.map((v,i)=>Math.round(v+(y[i]-v)*k).toString(16).padStart(2,'0')).join('');
}
function lerpBox(a,b,k){return a.map((p,i)=>p.map((v,j)=>v+(b[i][j]-v)*k))}
function ccncBoxTransitions(frames,index,time){
 const current=frames[index];if(!current?.valid)return [];
 // overlap: the old slot may still be sent for a moment after the new one starts.
 const rise=.45,slide=.3,fade=.6,overlap=.3,motion=ccncSmoothMotion();
 const find=(i,slot)=>{
  const frame=frames[i];if(!frame?.valid||!Array.isArray(frame.ccncTargets))return null;
  const targetIndex=frame.ccncTargets.findIndex(target=>target.slot===slot),target=frame.ccncTargets[targetIndex];
  if(!target)return null;
  const marker=frame.overlay?.markers?.find(marker=>marker.kind==='ccnc'&&marker.index===targetIndex);
  return target&&marker?.box?.length===8?{target,marker}:null;
 };
 const connected=i=>i>0&&frames[i-1].valid&&frames[i].t-frames[i-1].t<=.15;
 const ease=value=>{const p=Math.max(0,Math.min(1,value));return p*p*(3-2*p)};
 // The cluster message has no ID, so cars are followed by position: from one sample to the next a car moves
 // a few metres at most (more across a dropout); a different slot may differ by up to a lane sideways.
 const near=(a,b,dt)=>Math.abs(a.target.x-b.target.x)<=3+8*dt&&Math.abs((a.target.yRel??-a.target.y)-(b.target.yRel??-b.target.y))<=4;
 // Where the car shown in `slot` at sample i was just before: the same slot ('same'), another slot it moved
 // from ('other', e.g. FF -> LF while FF may already show the next car), nothing (a new car), or the log start.
 const origin=(i,slot)=>{
  const entry=find(i,slot);if(!connected(i))return {kind:'boundary'};
  let sameSeen=false;
  for(let j=i-1;j>=0&&connected(j+1)&&frames[i].t-frames[j].t<=fade;j--){
   const dt=frames[i].t-frames[j].t,same=find(j,slot);
   if(same&&!sameSeen){sameSeen=true;if(near(same,entry,dt))return {kind:'same',index:j}}
   for(const other of CCNC_SLOTS){
    if(other===slot)continue;const previous=find(j,other);if(!previous||!near(previous,entry,dt))continue;
    // That car must have left its slot: the slot is empty now or soon (both may be sent for a moment),
    // or it already shows another car.
    let left=false;
    for(let k=i;frames[k]?.valid&&frames[k].t-frames[i].t<=overlap&&(k===i||connected(k));k++){
     const now=find(k,other);if(!now||!near(previous,now,frames[k].t-frames[j].t)){left=true;break}
    }
    if(left)return {kind:'other',index:j,slot:other,...previous};
   }
   if(sameSeen)return {kind:'new'};
  }
  return {kind:'new'};
 };
 // First sample of the car's run in this slot (bridging dropouts) and where it came from; limited lookback.
 const runOf=(i,slot,limit)=>{
  let start=i,from=origin(i,slot);
  while(from.kind==='same'&&frames[i].t-frames[from.index].t<=limit){start=from.index;from=origin(start,slot)}
  return {start,from:from.kind==='same'?{kind:'boundary'}:from};
 };
 // A car that moved to another slot is drawn there only: its old slot neither lingers nor fades out.
 const movedAway=(slot,source)=>{
  for(const other of CCNC_SLOTS){
   if(other===slot||!find(index,other))continue;
   const run=runOf(index,other,fade+overlap+slide);
   if(run.from.kind!=='other'||run.from.slot!==slot||run.start>index)continue;
   // Still the same car in the old slot (or its fading copy), not a new car that has arrived there since.
   if(source<run.start||near(find(source,slot),run.from,Math.abs(frames[source].t-frames[run.from.index].t)))return true;
  }
  return false;
 };
 const entries=[];
 for(const slot of CCNC_SLOTS){
  let source=index,entry=find(source,slot);
  if(!entry&&motion)while(connected(source)&&time-frames[source].t<fade){
   entry=find(--source,slot);if(entry)break;
  }
  if(!entry)continue;
  const fading=source!==index;
  if(motion&&movedAway(slot,source))continue;
  // A missing sample is shown at once as a clear dip (40%), then the box fades out.
  const alpha=fading?.4*(1-ease((time-frames[source+1].t)/fade)):1;
  if(alpha<=0)continue;
  let height=1,marker=entry.marker,color=ccncTargetColor(entry.target),animated=fading;
  if(motion){
   const appearTime=fading?frames[source+1].t:time,run=runOf(source,slot,Math.max(rise,slide));
   // Glide between this sample and the next one while playing.
   if(!fading){
    const before=time<frames[index].t?index-1:index,after=before+1;
    const a=before===index?entry:find(before,slot),b=after===index?entry:find(after,slot);
    if(a&&b&&frames[after]&&connected(after)&&before>=0&&near(a,b,frames[after].t-frames[before].t)){
     const k=Math.max(0,Math.min(1,(time-frames[before].t)/(frames[after].t-frames[before].t)));
     if(k>0&&k<1){marker={...marker,box:lerpBox(a.marker.box,b.marker.box,k)};animated=true}
    }
   }
   // A target already present at a log boundary is not a new detection.
   if(run.from.kind!=='boundary'){
    const since=appearTime-frames[run.start].t,from=run.from;
    if(from.kind==='other'){
     const k=ease(since/slide);
     if(k<1){marker={...marker,box:lerpBox(from.marker.box,marker.box,k)};color=mixColor(ccncTargetColor(from.target),color,k);animated=true}
    }else{height=ease(since/rise);if(height<1)animated=true}
   }
  }
  entries.push({...entry,marker,color,height,alpha,animated});
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
 ctx.save();const opacity=ctx.globalAlpha;ctx.font='600 11px "Pretendard Variable", system-ui';ctx.textAlign='center';ctx.textBaseline='middle';ctx.shadowBlur=0;
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
 const range=Number($('range').value),rear=checked('rearView')?({25:5,50:10,80:20}[range]||0):0,bottom=h-48,scale=(h-78)/(range+rear),lateral=Number($('lateralRange').value),manualLateral=Number.isFinite(lateral)&&lateral>0,cx=manualLateral?(38+w-12)/2:w/2,cy=bottom-rear*scale;
 const lateralScale=manualLateral?(w-50)/(2*lateral):scale;
 const X=y=>cx+y*lateralScale,Y=x=>cy-x*scale;
 ctx.font='11px "Pretendard Variable", system-ui';ctx.lineWidth=1;ctx.strokeStyle=mapInk('grid');ctx.fillStyle=mapInk('text');
 if(rear){ctx.fillStyle=mapInk('rear');ctx.fillRect(38,cy,w-50,bottom-cy);ctx.fillStyle=mapInk('text')}
 for(const x of [...Array.from({length:rear/5},(_,i)=>-rear+i*5),...Array.from({length:Math.floor(range/10)+1},(_,i)=>i*10)]){ctx.beginPath();ctx.moveTo(38,Y(x));ctx.lineTo(w-12,Y(x));ctx.stroke();ctx.fillText(x+' m',5,Y(x)+4)}
 for(let y=manualLateral?-lateral:-Math.floor((w/2-40)/scale/5)*5;y<=(manualLateral?lateral:(w/2-20)/scale);y+=5){ctx.beginPath();ctx.moveTo(X(y),24);ctx.lineTo(X(y),bottom);ctx.stroke();ctx.textAlign='center';ctx.fillText(y,X(y),h-13)}ctx.textAlign='left';ctx.fillText('전방 x ↑',12,16);ctx.textAlign='right';ctx.fillText('좌우 y → (m)',w-10,16);ctx.textAlign='left';
 ctx.save();ctx.beginPath();ctx.rect(38,22,w-50,bottom-20);ctx.clip();
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
  return target.x<0?'후방 '+Math.abs(target.x).toFixed(1)+'m':target.x.toFixed(1)+'m';
 };
 function annotate(text,x,y,color,side=1){
  if(checked('hideLabels'))return;
  const lines=text.split('\n'),width=Math.max(...lines.map(line=>ctx.measureText(line).width)),height=lines.length*13;let box=null;
  for(const offset of [-8,12,-28,32,-48,52,-68,72]){
   const left=Math.max(42,Math.min(w-16-width,x+(side>0?12:-width-12))),top=Math.max(26,Math.min(bottom-height-3,y+offset));
   const next={left,top,right:left+width,bottom:top+height};
   if(!labels.some(b=>next.left<b.right+4&&next.right>b.left-4&&next.top<b.bottom+3&&next.bottom>b.top-3)){box=next;break}
  }
  if(!box)return;labels.push(box);ctx.fillStyle=mapInk('label');ctx.beginPath();ctx.roundRect(box.left-5,box.top-2,width+10,height+4,6);ctx.fill();ctx.fillStyle=color;ctx.textAlign='left';lines.forEach((line,i)=>ctx.fillText(line,box.left,box.top+10+i*13));
 }
 function path(points){ctx.beginPath();points.forEach(([x,y],i)=>i?ctx.lineTo(X(y),Y(x)):ctx.moveTo(X(y),Y(x)))}
 function line(points,color,dashed,alpha,width=2){path(points);ctx.strokeStyle=color;ctx.lineWidth=width;ctx.globalAlpha=alpha;ctx.setLineDash(dashed?[6,5]:[]);ctx.stroke();ctx.setLineDash([]);ctx.globalAlpha=1}
 function vehicle(x,y,color,width=10,height=17,selected=false){
  ctx.save();ctx.fillStyle=color;ctx.strokeStyle=color;ctx.lineWidth=selected?1.5:1;
  // Only the selected lead (radarState leadOne, the car the controller follows) gets a soft halo: a faint outer ring under a core ellipse.
  if(selected){const a=ctx.globalAlpha;ctx.globalAlpha=a*.08;ctx.beginPath();ctx.ellipse(x,y,width*1.25,height*1.15,0,0,Math.PI*2);ctx.fill();ctx.globalAlpha=a*.2;ctx.beginPath();ctx.ellipse(x,y,width,height*.9,0,0,Math.PI*2);ctx.fill();ctx.globalAlpha=a}
  ctx.beginPath();ctx.roundRect(x-width/2,y-height/2,width,height,3);ctx.globalAlpha*=.75;ctx.fill();ctx.globalAlpha/=.75;ctx.stroke();
  ctx.fillStyle=mapInk('label');ctx.globalAlpha*=.65;ctx.beginPath();ctx.roundRect(x-width/2+2,y-height/2+3,width-4,3,1);ctx.fill();ctx.restore();
 }
 if(rear&&checked('lanes')){
  // Straight reference guides only: no invented curvature behind the camera's model.
  ctx.save();ctx.strokeStyle=mapInk('guide');ctx.globalAlpha=.45;ctx.lineWidth=1;ctx.setLineDash([3,6]);
  const guides=[0,1,2,3].map(i=>valid&&Number.isFinite(f.laneY0?.[i])?f.laneY0[i]:[-5.4,-1.8,1.8,5.4][i]);
  for(const y of guides){ctx.beginPath();ctx.moveTo(X(y),cy);ctx.lineTo(X(y),bottom);ctx.stroke()}
  ctx.restore();
 }
 if(valid){
  const screen=points=>(points||[]).map(p=>p?[X(p[1]),Y(p[0])]:null);
  // The recorded road edges bound the asphalt; use recorded outer lanes only when edges are absent.
  const roadSides=checked('edges')&&f.edges?.[0]?.length&&f.edges?.[1]?.length?f.edges:checked('lanes')&&f.lanes?.length>1?[f.lanes[0],f.lanes.at(-1)]:null;
  if(roadSides)paintBand(ctx,screen(roadSides[0]),screen(roadSides[1]),mapInk('asphalt'),1);
  if(checked('ccncRoad')){
   highlightBands(f.ccncRoad).forEach((color,i)=>{if(color)paintBand(ctx,screen(f.lanes[i]),screen(f.lanes[i+1]),tone(color),.1,.55)});
   const road=f.ccncRoad;
   if([1,3].includes(road?.target)&&road.distance>0&&road.distance<204.6&&road.distance<=range){
    const a=targetAt(f.lanes[1],road.distance),b=targetAt(f.lanes[2],road.distance);
    if(a&&b){const center=(a[1]+b[1])/2;paintTargetLine(ctx,[X(center-modelPathWidth/2),Y(road.distance)],[X(center+modelPathWidth/2),Y(road.distance)],tone(road.target===3?'#edf7ff':'#7be5ff'));if(checked('targetLabels'))hudLabel(ctx,`TARGET · ${road.distance.toFixed(1)} m`,X((a[1]+b[1])/2),Y(road.distance)-17,'#d9faff')}
   }
  }
  if(checked('modelPath')&&f.position?.length>1)paintBand(ctx,...ribbonEdges(screen(f.position),Math.max(5,1.8*lateralScale)),tone('#c4a5ff'),.16);
  if(checked('lanes')){
   if(f.lanes[1]?.length&&f.lanes[2]?.length){path([...f.lanes[1],...f.lanes[2].slice().reverse()]);ctx.closePath();ctx.fillStyle=mapInk('lane-fill');ctx.fill()}
   f.lanes.forEach((l,i)=>{
    const p=Number.isFinite(f.lp[i])?Math.max(0,Math.min(1,f.lp[i])):0,marking=laneMarkingStyle(f,i),color=tone(marking?.color||'#57d9b0');
    if(!marking){line(l,color,p<.5,p*.65,.6+.8*p);return}
    // Cluster code: solid stays solid; dashed uses the metre pattern of the video overlay; hidden is a faint trace.
    if(marking.type==='hidden'){line(l,color,true,.3,1);return}
    path(l);ctx.strokeStyle=color;ctx.lineWidth=.6+.8*p;ctx.globalAlpha=Math.max(.25,p*.65);
    if(marking.type==='dashed'){const period=LANE_DASH+LANE_GAP;ctx.setLineDash([LANE_DASH*scale,LANE_GAP*scale]);ctx.lineDashOffset=(((l[0]?.[0]||0)+laneDashPhase(f))%period)*scale}
    ctx.stroke();ctx.setLineDash([]);ctx.lineDashOffset=0;ctx.globalAlpha=1;
   });
  }
  if(checked('edges'))f.edges.forEach((l,i)=>line(l,tone('#ff5c5c'),f.es[i]>1,.6*edgeConfidence(f.es[i]),1));

  if(checked('leads')){
   f.leads.forEach((l,i)=>{if(l.x<0||l.x>range)return;ctx.globalAlpha=l.p<.5?.45:1;vehicle(X(l.y),Y(l.x),tone('#81b5ff'));annotate(`모델 ${i+1} · ${targetValue(l,-l.y)}`,X(l.y),Y(l.x),tone('#c5daff'),i===0?1:-1);ctx.globalAlpha=1});
   const l=f.selected;if(l&&l.x>=0&&l.x<=range){const x=X(l.y),y=Y(l.x);vehicle(x,y,tone('#eee7bc'),12,19,true);annotate(`선택 · ${targetValue(l,-l.y)}`,x,y,tone('#eee7bc'))}
  }
  for(const target of f.radarTargets||[]){
   const style=targetStyle[target.group];if(!style||!checked(style.toggle)||target.x< -rear||target.x>range)continue;
   const x=X(target.y),y=Y(target.x);vehicle(x,y,tone(style.color));
   annotate(`${style.label} ${target.index+1} · ${targetValue(target,target.yRel)}`,x,y,tone(style.color),target.group==='left'?-1:1);
  }
 }
 if(checked('ccncTargets')&&frameAvailable(f))for(const target of f.ccncTargets||[]){
  if(target.x<0||target.x>range)continue;
  const x=X(target.y),y=Y(target.x),color=ccncTargetColor(target);
  vehicle(x,y,tone(color),12,20);
  if(checked('boxLabels')){
   const text=`${target.slot} · ${targetValue(target,target.yRel)}`;
   if(checked('boxLabelsBelow'))hudLabel(ctx,text,x,y+24,color,4,ctx.canvas.clientWidth||ctx.canvas.width,false);
   else annotate(text,x,y,tone(color),target.slot==='LF'?-1:1);
  }
 }
 if(rear&&valid)for(const target of f.ccncRearTargets||[]){
  if(target.x< -rear||target.x>0)continue;
  const x=X(target.y),y=Y(target.x),color=tone('#4aaaff');vehicle(x,y,color,12,20);
  if(checked('boxLabels'))annotate(`${target.slot} · ${targetValue(target,target.yRel)}`,x,y,color,target.slot==='LR'?-1:1);
 }
 $('rearStatus').textContent=rear&&f.ccncRearTargets===undefined?'기존 변환 데이터에 후방 정보가 없습니다. 로그를 다시 변환하면 기록된 LR·RR을 확인할 수 있습니다.':'';
 $('ccncStatus').textContent=checked('ccncTargets')&&(!frameAvailable(f)||f.ccncTargets==null)?'이 시점의 CCNC 송신 데이터가 없습니다.':'';
 const rawVisible=frameAvailable(f)&&f.liveTracksValid;
 const rawTargets=rawVisible?(f.liveTracks||[]).filter(target=>!checked('hideScc')||String(target.source).toLowerCase()!=='scc'):[];
 if(checked('liveTracks'))for(const target of rawTargets){
  if(target.x< -rear||target.x>range)continue;
  const x=X(target.y),y=Y(target.x);ctx.strokeStyle=tone('#78e9fa');ctx.lineWidth=1.5;ctx.globalAlpha=target.measured?.9:.5;ctx.beginPath();
  ctx.arc(x,y,3,0,Math.PI*2);if(target.measured){ctx.fillStyle=tone('#78e9fa');ctx.fill()}
  ctx.stroke();ctx.globalAlpha=1;
  if(checked('liveTrackLabels'))annotate(targetValue(target,target.yRel),x,y,tone('#78e9fa'),target.y<0?-1:1);
 }
 ctx.restore();
 if(valid&&checked('bsdWalls'))blindspotLevels(data.frames,idx,t).forEach((amount,i)=>paintBlindspotEdge(ctx,w,h,amount,i,t));
 if(checked('ccncRoad')&&frameAvailable(f))drawBlinkers(ctx,f.roadSignals??f.ccncRoad,f.t,42,w-16,(h-48)/2);
 vehicle(cx,cy,mapInk('ego'),12,22);ctx.fillStyle=mapInk('text');ctx.textAlign='center';ctx.fillText('내 차량',cx,cy+25);ctx.textAlign='left';
 if(!valid){ctx.fillStyle=mapInk('warn');ctx.fillText(missingModelMessage(),45,45)}
 const percent=n=>Number.isFinite(n)?(n*100).toFixed(1)+'%':'—';
 const distance=$('boundaryDistance').getAttribute('aria-pressed')==='true';
 const meters=value=>Number.isFinite(value)?(value>0?'+':'')+value.toFixed(3)+' m':'—';
 ['lane0','left','right','lane3'].forEach((id,i)=>{$(id).textContent=valid?(distance?meters(f.laneY0?.[i]):percent(f.lp[i])):'—'});
 // Cluster lane code next to the own-lane lines: LANELINE_LEFT/RIGHT raw value and its meaning.
 [['laneLineLeft',1],['laneLineRight',2]].forEach(([id,i])=>{const code=valid?laneLineCode(f,i):undefined,el=$(id);el.hidden=!Number.isInteger(code);if(!el.hidden)el.textContent=`${i===1?'LANELINE_LEFT':'LANELINE_RIGHT'} ${code} · ${LANE_LINE_CODES[code]?.label||'미정의'}`});
 ['edge0','edge1'].forEach((id,i)=>{$(id).textContent=valid?(distance?meters(f.edgeY0?.[i]):Number.isFinite(f.es[i])?f.es[i].toFixed(3)+' m':'—'):'—'});
 const targets=valid?(f.radarTargets||[]):[];
 $('radarRows').replaceChildren(...targets.map(target=>{const row=document.createElement('tr');const style=targetStyle[target.group];const values=[style.label+' '+(target.index+1),target.x.toFixed(2),target.yRel.toFixed(2),target.vRel.toFixed(2),target.radar?'예':'아니오',String(target.trackId)];for(const value of values){const cell=document.createElement('td');cell.textContent=value;row.append(cell)}row.firstChild.style.color=tone(style.color);return row}));
 if(!targets.length){const row=document.createElement('tr'),cell=document.createElement('td');cell.colSpan=6;cell.textContent='이 시점에 유효한 중앙·좌우 차량이 없습니다.';row.append(cell);$('radarRows').append(row)}
 $('rawCount').textContent=`· ${rawTargets.length}개`;
 $('rawTiming').textContent=rawVisible?`메시지 시각 차이 ${f.liveTracksDeltaMs.toFixed(1)}ms`: '이 시점의 유효한 liveTracks 메시지가 없습니다.';
 $('rawRows').replaceChildren(...rawTargets.map(target=>{const row=document.createElement('tr');for(const value of [target.trackId,target.x.toFixed(2),target.yRel.toFixed(2),target.vRel.toFixed(2),target.measured?'예':'아니오',target.source,target.trackState]){const cell=document.createElement('td');cell.textContent=value;row.append(cell)}return row}));
 if(!rawTargets.length){const row=document.createElement('tr'),cell=document.createElement('td');cell.colSpan=7;cell.textContent='표시할 liveTracks 감지점이 없습니다.';row.append(cell);$('rawRows').append(row)}
 canvas.setAttribute('aria-label',`주행 상황. 현재 radarState 중앙·좌우 차량 ${targets.length}개. 전방 범위 ${range}m, 후방 범위 ${rear}m.`);
 renderSteering(f);
 $('egoSpeed').textContent=frameAvailable(f)&&Number.isFinite(f.egoSpeedKph)?f.egoSpeedKph.toFixed(1):'—';
 $('lead').textContent=valid&&f.selected?f.selected.x.toFixed(1)+' m':'앞차 미감지';$('lead').title=f.selected?(f.selected.radar?'레이더 사용':'비전 기반'):'';$('frame').textContent=frameAvailable(f)?'FRAME '+f.id:'FRAME —';
}
new ResizeObserver(render).observe(canvas);loadData().catch(e=>playbackError(e.message));requestAnimationFrame(tick);

// The sticky video (phones) starts right below the app bar, whatever its wrapped height.
const appBar=document.querySelector('.app-bar');
function sizeAppBar(){document.body.style.setProperty('--app-bar-height',`${Math.ceil(appBar.getBoundingClientRect().height)}px`)}
const cameraPanel=document.querySelector('.camera-panel');
// Scrolling a control into view (focus, find, links) keeps it clear of the sticky app bar and, on phones, the video.
function sizeCamera(){
 const height=Math.ceil(cameraPanel.getBoundingClientRect().height),sticky=getComputedStyle(cameraPanel).position==='sticky';
 document.body.style.setProperty('--camera-height',`${height}px`);
 document.documentElement.style.setProperty('--replay-scroll-top',`${Math.ceil(appBar.getBoundingClientRect().height)+(sticky?height:0)+8}px`);
}
new ResizeObserver(()=>{sizeAppBar();sizeCamera()}).observe(appBar);sizeAppBar();new ResizeObserver(sizeCamera).observe(cameraPanel);sizeCamera();
// The floating transport bar: the page keeps this much room below its content so the bar never hides the end.
const transport=document.querySelector('.playback');
function sizeTransport(){document.documentElement.style.setProperty('--transport-height',`${Math.ceil(transport.getBoundingClientRect().height)}px`)}
new ResizeObserver(sizeTransport).observe(transport);sizeTransport();

// While playing, the controls over the video (title, camera/overlay, full screen) fade out and, on short or touch screens,
// the app bar folds away so the picture gets the room. A touch, mouse movement or keyboard focus on the video shows the video
// controls for a few seconds; pausing shows everything. Open menus and focused controls keep them up.
(()=>{
 const root=document.body,stage=$('videoStage'),short=matchMedia('(max-height:820px),(pointer:coarse)'),SHOW=3000;
 let timer=0;
 const playing=()=>$('play').dataset.playing==='true';
 const busy=()=>!!(appBar.querySelector('details[open]')||stage.querySelector(':focus-visible')||document.querySelector('.rv-choice-dialog[open]'));
 function sync(){
  const idle=playing()&&!root.classList.contains('hud-awake');
  root.classList.toggle('hud-idle',idle);
  // The bar stays folded for the whole playback (touches only bring back the video controls), so the picture does not
  // jump on every tap; keyboard focus in the bar unfolds it.
  root.classList.toggle('bar-folded',playing()&&short.matches&&!document.fullscreenElement&&!appBar.contains(document.activeElement));
 }
 function sleepLater(){clearTimeout(timer);timer=setTimeout(()=>{if(busy())return sleepLater();root.classList.remove('hud-awake');sync()},SHOW)}
 function wake(){root.classList.add('hud-awake');sleepLater();sync()}
 stage.addEventListener('pointerdown',wake,true);
 stage.addEventListener('pointermove',e=>{if(e.pointerType==='mouse')wake()});
 stage.addEventListener('focusin',wake);appBar.addEventListener('focusin',sync);appBar.addEventListener('focusout',()=>setTimeout(sync));
 new MutationObserver(()=>{if(!playing()){clearTimeout(timer);root.classList.remove('hud-awake')}sync()}).observe($('play'),{attributes:true,attributeFilter:['data-playing']});
 short.addEventListener?.('change',sync);document.addEventListener('fullscreenchange',sync);sync();
})();

// The video stays in view while the analysis scrolls: beside it (side by side) or above it (stacked). Stacked, scrolling down
// into the analysis shrinks the sticky video to 60% (narrower and centred on wide screens, letterboxed on phones), and on short
// phone screens (Fold cover display) the transport bar also folds into one row (play · seek · time). Scrolling back up
// restores the bar, the top of the page restores the video, and a tap on the folded bar's free area opens it again.
(()=>{
 const root=document.body,stage=$('videoStage'),road=document.querySelector('.road-panel'),shortPhone=matchMedia('(max-width:719px) and (max-height:720px)');
 function set(name,on){if(root.classList.contains(name)!==on)root.classList.toggle(name,on)}
 // Side by side (analysis to the right of the video) or stacked, from the actual layout; horizontal offsets ignore sticky shifts.
 function layout(){
  const stacked=road.offsetLeft<cameraPanel.offsetLeft+cameraPanel.offsetWidth-1;
  set('layout-stacked',stacked);set('layout-side',!stacked);
 }
 let lastY=scrollY,travel=0;
 function sizeVideo(){
  const width=stage.getBoundingClientRect().width;if(!width)return;
  root.style.setProperty('--video-full-h',`${Math.round(width*330/526)}px`);
 }
 function update(){
  const on=root.classList.contains('layout-stacked')&&!document.fullscreenElement;
  set('compact-media',on);
  if(!on){set('media-shrunk',false);set('transport-mini',false);return}
  const y=scrollY,delta=y-lastY;lastY=y;
  // An open menu or dialog keeps the layout still, so the menu it hangs from does not move under the pointer.
  if(appBar.querySelector('details[open]')||document.querySelector('dialog[open]')){travel=0;return}
  travel=Math.sign(delta)===Math.sign(travel)?travel+delta:delta;
  if(y<8){set('media-shrunk',false);set('transport-mini',false);travel=0;return}
  if(y>60)set('media-shrunk',true);
  if(travel>24&&y>80&&shortPhone.matches)set('transport-mini',true);
  else if(travel<-32)set('transport-mini',false);
 }
 addEventListener('scroll',update,{passive:true});shortPhone.addEventListener?.('change',update);document.addEventListener('fullscreenchange',update);
 new ResizeObserver(()=>{layout();update()}).observe(document.getElementById('replayViews'));
 new ResizeObserver(()=>{if(!root.classList.contains('media-shrunk'))sizeVideo()}).observe(stage);
 transport.addEventListener('pointerdown',e=>{if(root.classList.contains('transport-mini')&&!e.target.closest('button,input,select,label,a,.seekbar')){root.classList.remove('transport-mini');travel=0}});
 layout();sizeVideo();update();
})();

// Touch: a tapped button must not keep focus. On Android a focused control left behind by a tap can stop the next fling
// dead instead of letting it coast, so focus is dropped when the next touch starts (outside open dialogs and text fields).
// Keyboard and screen-reader focus are untouched: they do not start with a touch on the page.
document.addEventListener('touchstart',()=>{
 const el=document.activeElement;
 if(!el||el===document.body||document.querySelector('dialog[open]'))return;
 if(el.matches('button,summary,a,[role=tab],[role=option],[role=menuitem]')&&!el.closest('details[open]>:not(summary)'))el.blur();
},{capture:true,passive:true});

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
 $('edge0Label').textContent=enabled?'왼쪽 로드엣지 y[0]':'왼쪽 로드엣지';
 $('edge1Label').textContent=enabled?'오른쪽 로드엣지 y[0]':'오른쪽 로드엣지';
 render();
};

function logSegmentInfo(name){
 const match=/^(.+?)\s*\/\s*구간\s*(\d+)$/.exec(name||'')||/^(.{20})--(\d+)$/.exec(name||'');
 if(!match)return null;
 const number=Number(match[2]);
 return Number.isSafeInteger(number)?{route:match[1],number}:null;
}
const SEGMENT_STATES={unconverted:'미변환',queued:'대기 중',processing:'준비 중',error:'변환 실패'};
const goToLog=log=>location.assign('../'+encodeURIComponent(log.id)+'/');
// App bar title: when the route starts (its first segment's time, as in the log list), which segment this is and of how many.
function renderTitle(active,segments){
 const info=logSegmentInfo(active?.name),first=segments[0]?.log||active;
 // The recording's own start time when known; otherwise only the upload time, and it says so.
 const started=Number.isFinite(first?.started_at),seconds=started?first.started_at:first?.uploaded,when=Number.isFinite(seconds)?new Date(seconds*1000):null;
 const clock=when?.toLocaleTimeString('ko-KR',{hour:'numeric',minute:'2-digit'});
 const start=when?(started?clock+' 출발':'업로드 '+clock):info?'주행 '+info.route.split('--')[0].replace(/^0+(?=.)/,''):'로그 재생';
 $('titleText').title=when?(started?'출발 ':'업로드 ')+when.toLocaleString():'';
 const index=segments.findIndex(item=>item.log.id===active?.id);
 $('titleText').textContent=info?`${start} · 구간 ${info.number}`:start;
 $('titleCount').textContent=segments.length>1&&index>=0?` (${index+1}/${segments.length})`:'';
 $('titleDate').textContent=when?when.toLocaleDateString('ko-KR',{month:'long',day:'numeric',weekday:'short'}):'';
}
// Every segment of the route under the seek bar; another ready one is one click away (same as the segment chooser).
function renderSegmentStrip(segments,current,active){
 const items=segments.length?segments:active?[{log:active,info:logSegmentInfo(active.name)}]:[];
 $('segmentStrip').replaceChildren(...items.map(({log,info})=>{
  const button=document.createElement('button'),here=log.id===current,state=SEGMENT_STATES[log.status];
  button.type='button';button.className='segment-block';button.dataset.status=log.status||'';
  const label=(info?'구간 '+info.number:'이 구간')+(state?' · '+state:'')+(here?' · 재생 중':'');
  button.title=label;button.setAttribute('aria-label',label);
  if(here)button.setAttribute('aria-current','true');
  button.disabled=!here&&log.status!=='ready';
  if(!here)button.onclick=()=>goToLog(log);
  return button;
 }));
 fitSegmentStrip(current!==segmentStripCurrent);segmentStripCurrent=current;
}
// Long drives: when the blocks would get narrower than is comfortable, the strip becomes a horizontally scrollable
// row of fixed-width blocks (style.css .is-scrolling) with edge fades where more exists, kept centred on the current
// segment when it changes. Manual scrolling (touch, trackpad, shift+wheel, mouse drag) is left alone until then.
let segmentStripCurrent=null,segmentStripScrolled=false;
const SEGMENT_COMFORT=16,SEGMENT_GAP=3;
function segmentStripFades(){
 const strip=$('segmentStrip'),scrolling=strip.classList.contains('is-scrolling');
 strip.classList.toggle('fade-left',scrolling&&strip.scrollLeft>1);
 strip.classList.toggle('fade-right',scrolling&&strip.scrollLeft+strip.clientWidth<strip.scrollWidth-1);
}
function fitSegmentStrip(recentre=false){
 const strip=$('segmentStrip'),count=strip.children.length,was=strip.classList.contains('is-scrolling');
 const scrolling=count>1&&count*SEGMENT_COMFORT+(count-1)*SEGMENT_GAP>strip.clientWidth;
 strip.classList.toggle('is-scrolling',scrolling);
 if(scrolling&&(recentre||!was||!segmentStripScrolled)){
  const block=strip.querySelector('[aria-current]');
  if(block){const box=block.getBoundingClientRect(),frame=strip.getBoundingClientRect();
   strip.scrollTo({left:strip.scrollLeft+box.left+box.width/2-(frame.left+frame.width/2),behavior:recentre&&was&&motionAllowed()?'smooth':'instant'})}
  segmentStripScrolled=false;
 }
 segmentStripFades();
}
{
 const strip=$('segmentStrip');let drag=null,dragged=false;
 strip.addEventListener('scroll',()=>{segmentStripFades()},{passive:true});
 // A user gesture marks the position as theirs; the next segment change re-centres.
 for(const type of ['wheel','touchstart','keydown'])strip.addEventListener(type,()=>{segmentStripScrolled=true},{passive:true});
 // Mouse drag scrolls; a drag never counts as a click on a block.
 strip.addEventListener('pointerdown',e=>{if(e.pointerType==='mouse'&&e.button===0&&strip.classList.contains('is-scrolling')){drag={x:e.clientX,left:strip.scrollLeft};dragged=false}});
 addEventListener('pointermove',e=>{if(!drag)return;const dx=e.clientX-drag.x;if(Math.abs(dx)>4&&!dragged){dragged=true;segmentStripScrolled=true;strip.classList.add('is-dragging')}if(dragged)strip.scrollLeft=drag.left-dx});
 addEventListener('pointerup',()=>{drag=null;strip.classList.remove('is-dragging')});
 strip.addEventListener('click',e=>{if(dragged){e.preventDefault();e.stopPropagation();dragged=false}},true);
 new ResizeObserver(()=>fitSegmentStrip()).observe(strip);
}
function populateSegments(logs,current){
 const select=$('logSegment');select.replaceChildren();select.hidden=true;select.onchange=null;
 const active=logs.find(log=>log.id===current),info=logSegmentInfo(active?.name);
 const segments=info?logs.map(log=>({log,info:logSegmentInfo(log.name)})).filter(item=>item.info?.route===info.route).sort((a,b)=>a.info.number-b.info.number||a.log.id.localeCompare(b.log.id)):[];
 renderTitle(active,segments);renderSegmentStrip(segments,current,active);
 if(segments.length<2)return;
 for(const {log,info} of segments){
  const option=document.createElement('option');option.value=log.id;
  const status=SEGMENT_STATES[log.status];
  option.textContent=`구간 ${info.number}${status?' · '+status:''}`;
  option.disabled=log.status!=='ready'&&log.id!==current;
  // Long drives: the chooser shows a light header every 10 segments ("구간 0–9 · 오전 8:46").
  let parent=select;
  if(segments.length>20){
   const group=Math.floor(info.number/10);parent=select.lastElementChild;
   if(parent?.dataset.group!==String(group)){
    parent=document.createElement('optgroup');parent.dataset.group=group;parent.dataset.first=info.number;
    const when=Number.isFinite(log.started_at)?new Date(log.started_at*1000).toLocaleTimeString('ko-KR',{hour:'numeric',minute:'2-digit'}):'';
    parent.dataset.when=when;select.append(parent);
   }
   parent.label=`구간 ${parent.dataset.first}–${info.number}${parent.dataset.when?' · '+parent.dataset.when:''}`;
  }
  parent.append(option);
 }
 select.value=current;select.hidden=false;
 select.onchange=()=>{
  const target=segments.find(item=>item.log.id===select.value)?.log;
  if(target?.status==='ready'&&target.id!==current)goToLog(target);
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
// The ⋯ menu: remove the converted data, downloads, camera info, screen mode, recording info and delete for good.
// Downloads open the download dialog; recordings without download options list the log and each camera video.
// On phones the 보기 choices join this menu (the app bar has no room for a 보기 button).
const phoneLayout=matchMedia('(max-width:719px)');
let replayLog=null;
function replayMenuButton(text,className){const button=document.createElement('button');button.type='button';button.textContent=text;if(className)button.className=className;return button}
async function replayDelete(url,expected){
 const response=await fetch(url,{method:'DELETE',headers:{'X-RoadViewer-Request':'1'}});
 const body=await response.json().catch(()=>({}));
 if(!response.ok)throw Error(body.message||'요청을 처리하지 못했습니다. 다시 시도해 주세요.');
 if(expected&&body.status!==expected)throw Error('변환 데이터 제거가 완료되지 않았습니다. 로그 목록에서 상태를 확인해 주세요.');
}
function renderReplayDownloads(log){
 replayLog=log;
 const details=$('replayDownload'),menu=$('replayDownloadMenu'),view=$('viewOptions');
 details.classList.toggle('is-empty',!log);
 const nodes=[],id=log&&encodeURIComponent(log.id);
 // Both remove the replay's data, so a confirmed one returns to the log list.
 const destructive=(text,className,message,url,expected)=>{
  const button=replayMenuButton(text,className);
  button.onclick=async()=>{
   details.open=false;if(!confirm(`${log.name}\n${message}`))return;
   button.disabled=true;
   try{await replayDelete(url,expected);location.assign('../../')}catch(e){showError(e.message);button.disabled=false}
  };
  return button;
 };
 if(log?.status==='ready'||log?.status==='queued')nodes.push(destructive('제거','','대기 중이면 변환을 취소하고, 변환된 분석·그래프와 재생용 임시 영상을 제거할까요? 원본 로그와 보관 영상은 유지되며 자동으로 다시 변환되지 않습니다.','../../api/logs/'+id+'/prepared','unconverted'));
 if(log?.download_options){const download=replayMenuButton('다운로드');download.onclick=()=>{details.open=false;openRecordingDownload([log],'../../','all')};nodes.push(download)}
 else if(log){
  const items=recordingDownloads(log,'../../'),videos=items.filter(item=>item.video);
  nodes.push(...items.filter(item=>!item.video).map(downloadLink));
  if(videos.length>1){const heading=document.createElement('p');heading.textContent='영상 선택';nodes.push(heading)}
  nodes.push(...videos.map(downloadLink));
 }
 if(phoneLayout.matches)nodes.push(view);else if(view.parentElement!==$('viewMenuPanel'))$('viewMenuPanel').append(view);
 nodes.push($('cameraInfoButton'));
 if(window.RoadViewerTheme){const theme=document.createElement('div');theme.className='menu-theme';const label=document.createElement('span');label.textContent='화면 모드';theme.append(label,window.RoadViewerTheme.control());nodes.push(theme)}
 nodes.push($('details'),menu.querySelector('.menu-version'));
 if(log)nodes.push(document.createElement('hr'),destructive('완전 삭제','delete','원본 로그·영상과 변환 데이터를 완전히 삭제할까요? 이 작업은 되돌릴 수 없습니다.','../../api/logs/'+id));
 menu.replaceChildren(...nodes);
}
renderReplayDownloads(null);
// Phones show 이전/다음 as large labelled buttons below the content, as in the app bar's place on wider screens.
const logNeighbors=document.querySelector('.log-neighbors');
function placeNeighbors(){const target=phoneLayout.matches?$('phoneNeighbors'):$('logNavigation');if(logNeighbors.parentElement!==target)target.prepend(logNeighbors)}
placeNeighbors();
phoneLayout.addEventListener('change',()=>{$('viewMenu').open=false;renderReplayDownloads(replayLog);placeNeighbors()});
$('replayDownloadMenu').addEventListener('click',e=>{if(e.target.closest('a,#cameraInfoButton,#layoutWidthButton'))$('replayDownload').open=false});
$('viewMenuPanel').addEventListener('click',e=>{if(e.target.closest('#layoutWidthButton'))$('viewMenu').open=false});
// App bar and layer menus: one open at a time, placed on the roomier side and scrolled within the viewport.
const replayMenus=[...document.querySelectorAll('details.replay-menu')];
function placeReplayMenu(details){
 const menu=details.querySelector('.replay-download-menu');
 if(!details.open||!menu)return;
 menu.style.left='';menu.style.top='';menu.style.bottom='';menu.style.maxHeight='';
 // Measure the button, not the menu's animated translateY position.
 const box=details.getBoundingClientRect(),gap=6,margin=12,width=document.documentElement.clientWidth;
 // Menus open toward the side with room: end-aligned when the button sits in the right half.
 let left=box.left+box.width/2>width/2?box.width-menu.offsetWidth:0;
 left=Math.max(margin-box.left,Math.min(left,width-margin-box.left-menu.offsetWidth));
 menu.style.left=left+'px';
 // Menus below the app bar must not open underneath it (or under the sticky video on phones).
 const ceiling=details.closest('.app-bar')?margin:(parseFloat(getComputedStyle(document.documentElement).scrollPaddingTop)||margin);
 // ...nor reach under the floating transport bar at the bottom.
 const floor=details.closest('.app-bar')?8:Math.max(8,innerHeight-transport.getBoundingClientRect().top+8);
 const below=Math.max(0,innerHeight-floor-box.bottom-gap),above=Math.max(0,box.top-gap-ceiling);
 const opensAbove=menu.offsetHeight>below&&above>below;
 if(opensAbove){menu.style.top='auto';menu.style.bottom='calc(100% + 6px)'}
 menu.style.maxHeight=(opensAbove?above:below)+'px';
}
const placeReplayMenus=()=>replayMenus.forEach(placeReplayMenu);
for(const details of replayMenus)details.addEventListener('toggle',()=>{if(details.open)for(const other of replayMenus)if(other!==details)other.open=false;placeReplayMenu(details)});
window.addEventListener('resize',placeReplayMenus);
window.addEventListener('scroll',placeReplayMenus,{passive:true});
document.addEventListener('click',e=>{for(const details of replayMenus)if(details.open&&!details.contains(e.target))details.open=false});
document.addEventListener('keydown',e=>{const details=replayMenus.find(d=>d.open);if(e.key==='Escape'&&details&&!document.querySelector('dialog[open]')){details.open=false;details.querySelector('summary').focus()}});
async function loadLogNavigation(){
 const buttons=[$('previousLog'),$('nextLog')];
 const label=(button,text,title)=>{button.querySelector('.neighbor-label').textContent=text;button.setAttribute('aria-label',text);button.title=title};
 try{
  const response=await fetch('../../api/logs');
  if(!response.ok)throw Error('로그 목록을 불러오지 못했습니다.');
  const {logs}=await response.json(),current=location.pathname.split('/').filter(Boolean).at(-1);
  const active=logs.find(log=>log.id===current);
  recordingNameFiles=active?.files||{};
  updateTagCatalog(logs);
  const tagButton=$('editReplayTags');tagButton.disabled=!active;
  tagButton.innerHTML=RECORDING_TAG_ICON;
  const tags=$('replayTags');tags.replaceChildren(...recordingTagBadges(active?.tags).childNodes);tags.hidden=!active?.tags?.length;
  tagButton.onclick=()=>editRecordingTags([active],()=>loadLogNavigation());
  syncReplayPin(!!active?.pinned);$('pinLog').disabled=!active;
  renderReplayDownloads(active);
  if(data||active)renderRecordingName($('routeName'),data?.route||active.name,recordingNameFiles).id='route';
  populateSegments(logs,current);
  const index=logs.findIndex(log=>log.id===current);
  const neighbors=index<0?[]:[logs.slice(index+1).find(log=>log.status==='ready'),logs.slice(0,index).reverse().find(log=>log.status==='ready')];
  buttons.forEach((button,i)=>{
   const log=neighbors[i];button.disabled=!log;
   const route=logSegmentInfo(active?.name)?.route,sameRoute=route&&logSegmentInfo(log?.name)?.route===route;
   const text=(i===0?'이전 ':'다음 ')+(sameRoute?'구간':'로그');
   label(button,text,log?text+' · '+log.name:'이동할 재생 가능한 로그가 없습니다.');
   button.onclick=log?()=>goToLog(log):null;
  });
 }catch{buttons.forEach(button=>{button.disabled=true;button.title='로그 목록을 불러오지 못했습니다. 새로고침해 주세요.'})}
}
const pageReady=loadLogNavigation();

// Full screen keeps the video and its transport bar together; hidden where the browser cannot do it (iPhone).
(()=>{
 const stage=document.querySelector('.camera-panel'),button=$('fullscreenButton');
 button.hidden=!(document.fullscreenEnabled&&stage.requestFullscreen);
 button.onclick=()=>{if(document.fullscreenElement)document.exitFullscreen().catch(()=>{});else stage.requestFullscreen().catch(()=>showError('전체 화면으로 전환하지 못했습니다.'))};
 stage.addEventListener('fullscreenchange',()=>{
  const on=document.fullscreenElement===stage,text=on?'전체 화면 종료':'전체 화면';
  button.setAttribute('aria-label',text);button.title=text;button.classList.toggle('is-active',on);render();
 });
})();

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

// A dialog opened from a menu item returns focus to the (now closed) menu's button.
function menuFocusTarget(element){return element?.closest?.('details:not([open])')?.querySelector('summary')||element}
function settingsDialog(dialog,button,closeButton,focus,onOpen){
 let oldOverflow='',returnTo=null;
 const open=()=>{if(dialog.open)return;onOpen?.();returnTo=button||document.activeElement;oldOverflow=document.body.style.overflow;document.body.style.overflow='hidden';dialog.showModal();focus().focus({preventScroll:true})};
 if(button)button.onclick=open;
 const close=()=>dialog.close();
 closeButton.onclick=close;
 dialog.addEventListener('close',()=>{document.body.style.overflow=oldOverflow;menuFocusTarget(returnTo)?.focus?.({preventScroll:true})});
 dialog.addEventListener('cancel',e=>{e.preventDefault();close()});
 dialog.addEventListener('click',e=>{if(e.target!==dialog)return;const r=dialog.getBoundingClientRect();if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)close()});
 return open;
}
settingsDialog($('layoutWidthDialog'),$('layoutWidthButton'),$('layoutWidthClose'),()=>layoutWidth);
(()=>{
 const groups={cellular:'qualityCellular',wifi:'qualityWifi'};
 const sync=()=>{
  for(const [network,name] of Object.entries(groups)){const value=preferredQuality(network);for(const input of document.getElementsByName(name))input.checked=input.value===value}
  const {network,known}=videoNetwork();
  $('videoQualityNetwork').textContent=known?`현재 연결: ${videoQuality[network].label}`:`현재 연결을 확인할 수 없어 ${videoQuality[network].label} 설정을 따릅니다.`;
 };
 for(const [network,name] of Object.entries(groups))for(const input of document.getElementsByName(name))input.onchange=()=>{try{localStorage.setItem(videoQuality[network].key,input.value)}catch{}};
 navigator.connection?.addEventListener?.('change',()=>{if($('videoQualityDialog').open)sync()});
 // Opened from the camera choice list's 기본 화질 button (choices.js).
 const open=settingsDialog($('videoQualityDialog'),null,$('videoQualityClose'),()=>document.querySelector(`input[name="${groups[videoNetwork().network]}"]:checked`),sync);
 $('videoSource').addEventListener('rv:choice-action',open);
})();

// Web fonts may finish after the first paused canvas frame.
document.fonts.ready.then(()=>{if(canvas.isConnected)render()});
