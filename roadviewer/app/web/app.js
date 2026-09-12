'use strict';
const $=id=>document.getElementById(id),v=$('video'),canvas=$('road'),ctx=canvas.getContext('2d');
let data=null,t=0,idx=0,playing=false,last=0,loading=false;
const checked=id=>$(id).checked;
function clock(n){n=Math.max(0,n);return `${Math.floor(n/60)}:${(n%60).toFixed(2).padStart(5,'0')}`}
function nearest(time){const f=data.frames;let a=0,b=f.length-1;while(a<b){const m=(a+b)>>1;if(f[m].t<time)a=m+1;else b=m}return a>0&&Math.abs(f[a-1].t-time)<Math.abs(f[a].t-time)?a-1:a}
function pause(){playing=false;v.pause();$('play').textContent='재생'}
let videoPlayPending=false;
function videoAvailable(){return !!data?.video&&t>=data.video.start&&t<data.video.start+data.video.duration}
function frameAvailable(f){return t>=(data.logStart??data.frames[0].t)&&t<=(data.logEnd??data.frames.at(-1).t)&&Math.abs(f.t-t)<.16}
function syncVideo(seek=false){
 const visible=videoAvailable(),wasHidden=v.hidden;
 v.hidden=!visible;$('noVideo').hidden=visible;
 $('noVideo').textContent=data?.video?'이 구간에 영상이 없습니다.':'이 로그에 동기화 가능한 영상이 없습니다.';
 if(!visible){v.pause();return}
 if(v.readyState>=1&&(seek||wasHidden||Math.abs(v.currentTime-(t-data.video.start))>.35))v.currentTime=Math.max(0,t-data.video.start);
 if(playing&&v.paused&&!videoPlayPending){
  videoPlayPending=true;
  v.play().catch(e=>{if(playing&&videoAvailable()){pause();showError('영상을 재생할 수 없습니다. '+e.message)}}).finally(()=>{videoPlayPending=false;if(!playing||!videoAvailable())v.pause()});
 }
}
function setTime(time,seekVideo=true){if(!data)return;t=Math.max(0,Math.min(time,data.duration));idx=nearest(t);$('seek').value=t;$('time').textContent=`${clock(t)} / ${clock(data.duration)}`;syncVideo(seekVideo);render()}
function step(n){pause();if(data)setTime(data.frames[Math.max(0,Math.min(data.frames.length-1,idx+n))].t)}
function toggle(){if(!data||loading)return;if(playing){pause();return}if(t>=data.duration-.05)setTime(0);playing=true;last=performance.now();$('play').textContent='일시정지';syncVideo(true)}
function tick(now){if(playing&&data){setTime(t+(now-last)/1000*Number($('speed').value),false);if(t>=data.duration-.001)pause()}last=now;requestAnimationFrame(tick)}
function showError(message){$('error').textContent=message;$('error').hidden=!message}
let dataRetryTimer=null;
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
 data=await res.json();showError('');$('route').textContent=data.route;$('details').textContent=`${data.frames.length.toLocaleString()} 모델 프레임 · ${data.video?'영상 있음':'영상 없음'}`;$('seek').max=data.duration;$('end').textContent=clock(data.duration);$('warnings').textContent=data.warnings.join('\n');$('warnings').hidden=!data.warnings.length;$('noVideo').hidden=!!data.video;v.hidden=!data.video;if(data.video){v.src='../../api/logs/'+id+'/video?v='+encodeURIComponent(data.key||Date.now());loading=true;$('play').disabled=true;$('status').textContent='영상 준비 중';v.load()}else{loading=false;$('play').disabled=false;$('status').textContent='재생 준비 완료'}setTime(0)}
$('play').onclick=toggle;$('prev').onclick=()=>step(-1);$('next').onclick=()=>step(1);$('seek').oninput=()=>{pause();setTime(Number($('seek').value))};$('speed').onchange=()=>v.playbackRate=Number($('speed').value);
v.onloadedmetadata=()=>{loading=false;$('play').disabled=false;$('status').textContent='재생 준비 완료';v.playbackRate=Number($('speed').value);setTime(t)};v.onended=()=>{if(playing&&data?.video){setTime(Math.max(t,data.video.start+data.video.duration),false);last=performance.now();if(t>=data.duration)pause()}};v.onerror=()=>{if(data?.video)showError('브라우저가 영상을 읽지 못했습니다. Home Assistant 연결을 확인하고 새로고침해 주세요.')};
for(const id of ['range','lanes','edges','leads','radarCenter','radarLeft','radarRight','liveTracks','trackLabels','yRelLabels','distanceLabels','liveTrackLabels','speedLabels','relativeSpeedLabels','hideLabels'])$(id).onchange=render;
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
 const w=canvas.clientWidth,h=canvas.clientHeight,dpr=devicePixelRatio||1;if(canvas.width!==Math.round(w*dpr)||canvas.height!==Math.round(h*dpr)){canvas.width=Math.round(w*dpr);canvas.height=Math.round(h*dpr)}ctx.setTransform(dpr,0,0,dpr,0,0);ctx.clearRect(0,0,w,h);if(!data)return;
 const f=data.frames[idx],valid=f.valid&&frameAvailable(f);const range=Number($('range').value),scale=(h-78)/range,cx=w/2,cy=h-48;
 const X=y=>cx+y*scale,Y=x=>cy-x*scale;
 ctx.font='11px system-ui';ctx.lineWidth=1;ctx.strokeStyle='#273646';ctx.fillStyle='#8fa3b8';
 for(let x=0;x<=range;x+=10){ctx.beginPath();ctx.moveTo(38,Y(x));ctx.lineTo(w-12,Y(x));ctx.stroke();ctx.fillText(x+' m',5,Y(x)+4)}
 for(let y=-Math.floor((w/2-40)/scale/5)*5;y<(w/2-20)/scale;y+=5){ctx.beginPath();ctx.moveTo(X(y),24);ctx.lineTo(X(y),cy);ctx.stroke();ctx.textAlign='center';ctx.fillText(y,X(y),h-13)}ctx.textAlign='left';ctx.fillText('전방 x ↑',12,16);ctx.textAlign='right';ctx.fillText('좌우 y → (m)',w-10,16);ctx.textAlign='left';
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
 const rawTargets=rawVisible?(f.liveTracks||[]):[];
 if(checked('liveTracks'))for(const target of rawTargets){
  if(target.x<0||target.x>range)continue;
  const x=X(target.y),y=Y(target.x);ctx.strokeStyle='#78e9fa';ctx.lineWidth=1.5;ctx.globalAlpha=target.measured?.9:.5;ctx.beginPath();
  if(target.measured){ctx.moveTo(x-4,y);ctx.lineTo(x+4,y);ctx.moveTo(x,y-4);ctx.lineTo(x,y+4)}else ctx.arc(x,y,4,0,Math.PI*2);
  ctx.stroke();ctx.globalAlpha=1;
  if(checked('liveTrackLabels'))annotate(targetValue(target,target.yRel),x,y,'#78e9fa',target.y<0?-1:1);
 }
 ctx.restore();
 ctx.fillStyle='#e6edf5';ctx.beginPath();ctx.moveTo(cx,cy-14);ctx.lineTo(cx-7,cy+4);ctx.lineTo(cx+7,cy+4);ctx.closePath();ctx.fill();ctx.textAlign='center';ctx.fillText('내 차량',cx,cy+20);ctx.textAlign='left';
 if(!valid){ctx.fillStyle='#ffd39f';ctx.fillText('이 시점의 유효한 모델 데이터 없음',45,45)}
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
 canvas.setAttribute('aria-label',`차량 중심 도로. 현재 radarState 중앙·좌우 차량 ${targets.length}개. 전방 범위 ${range}m.`);
 renderSteering(f);
 $('egoSpeed').textContent=frameAvailable(f)&&Number.isFinite(f.egoSpeedKph)?f.egoSpeedKph.toFixed(1):'—';
 $('lead').textContent=valid&&f.selected?f.selected.x.toFixed(1)+' m':'미선택';$('lead').title=f.selected?(f.selected.radar?'레이더 사용':'비전 기반'):'';$('frame').textContent=frameAvailable(f)?'FRAME '+f.id:'FRAME —';
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

async function loadLogNavigation(){
 const buttons=[$('previousLog'),$('nextLog')];
 try{
  const response=await fetch('../../api/logs');
  if(!response.ok)throw Error('로그 목록을 불러오지 못했습니다.');
  const {logs}=await response.json(),current=location.pathname.split('/').filter(Boolean).at(-1);
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
