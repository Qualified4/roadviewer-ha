'use strict';
(()=>{
 const colors=['#57d9b0','#bda0ff','#ffac70','#78c7ff'];
 const line=(topic,key,label)=>({topic,key,label});
 const cs=(key,label)=>line('carState',key,label),cc=(key,label)=>line('carControl',key,label),out=(key,label)=>line('carOutput',key,label),ctl=(key,label)=>line('controlsState',key,label);
 const fallback=(primary,secondary)=>({...primary,fallback:secondary});
 const graphs=[
  {id:'speed',title:'속도',unit:'km/h',lines:[cs('speed','실제'),cs('clusterSpeed','계기판'),cs('cruiseSpeed','크루즈')]},
  {id:'acceleration',title:'가속도',unit:'m/s²',note:'요청은 자동 가감속 명령, 출력은 차량 제어기가 기록한 최종 명령입니다. 실제 차량 가속도와 구분합니다.',lines:[cs('acceleration','실제'),cc('targetAcceleration','요청'),out('outputAcceleration','출력 기록')]},
  {id:'pedals',title:'운전자 페달 입력량',unit:'%',bounds:[0,100],checkZero:true,note:'운전자 입력입니다. 자동 가감속 명령과 별개이며 브레이크 값은 차량에 따라 압력 등으로 기록됩니다.',lines:[cs('gas','액셀'),cs('brake','브레이크')]},
  {id:'angle',title:'조향각',unit:'°',checkZero:true,note:'목표는 제어기에 기록된 값이며 모델 경로 자체와 다릅니다. 토크 제어 차량의 목표각도 포함합니다. 출력 기록 지원은 차량마다 다릅니다.',lines:[cs('steeringAngle','실제'),fallback(cc('targetAngle','목표'),ctl('desiredAngle','목표')),out('outputAngle','출력 기록')]},
  {id:'steeringRate',title:'핸들 회전 속도',unit:'°/s',lines:[cs('steeringRate','실제')]},
  {id:'torque',title:'조향 토크',unit:'차량 원시값',lines:[cs('driverTorque','운전자'),cs('epsTorque','EPS')]},
  {id:'command',title:'자동 조향 토크 명령',unit:'정규화 값',checkZero:true,lines:[cc('commandTorque','요청'),out('outputTorque','출력 기록')]},
  {id:'rpm',title:'회전수 (RPM)',unit:'RPM',checkZero:true,note:'engineRpm 필드의 기록값입니다. 차량 구현에 따라 엔진 또는 구동계 회전수이며, 필드를 채우지 않는 차량도 있습니다.',lines:[cs('rpm','기록값')]},
  {id:'pedalState',title:'운전자 페달 조작 상태',binary:true,note:'운전자가 조작했는지 나타냅니다. 자동 감속·회생제동 명령을 의미하지 않습니다.',lines:[cs('gasPressed','액셀'),cs('brakePressed','브레이크'),cs('regenBraking','회생제동')]},
  {id:'intervention',title:'운전자 조향 개입',binary:true,lines:[cs('steeringPressed','조향 개입')]},
  {id:'control',title:'자동 제어 상태',binary:true,lines:[cc('enabled','시스템 켜짐'),cc('latActive','자동 조향'),cc('longActive','자동 가감속')]},
  {id:'autoPedals',title:'자동 가스·브레이크 출력',unit:'%',bounds:[0,100],checkZero:true,note:'차량에 보내는 출력 기록이며 실제 페달 이동량이 아닙니다. 가속도 명령을 사용하는 차량에서는 이 필드가 0으로 남을 수 있습니다.',lines:[out('outputGas','가스 출력'),out('outputBrake','브레이크 출력')]},
  {id:'accelPlan',title:'자동 목표 가속도',unit:'m/s²',lines:[cc('plannedAcceleration','제어 목표'),cc('targetAcceleration','요청 명령')]},
  {id:'jerk',title:'자동 가감속 저크',unit:'m/s³',lines:[cc('jerk','요청')]},
  {id:'accelRequest',title:'자동 가속·감속 요청',binary:true,note:'자동 가감속이 활성화된 동안 가속도 명령의 부호를 표시합니다. 감속 요청이 곧 브레이크 페달 조작이라는 뜻은 아닙니다.',lines:[cc('accelRequested','가속 요청'),cc('decelRequested','감속 요청'),cc('longActive','제어 활성')]},
  {id:'longState',title:'자동 가감속 제어 단계',binary:true,lines:['off','pid','stopping','starting'].map((state,i)=>fallback(cc('long_'+state,['꺼짐','속도 제어','정지 중','출발 중'][i]),ctl('long_'+state,['꺼짐','속도 제어','정지 중','출발 중'][i])))},
  {id:'curvature',title:'주행 곡률',unit:'1/m',precision:5,checkZero:true,note:'실제 추정 곡률·제어 목표·차량 명령입니다. 각도·토크 방식에서는 곡률 명령을 사용하지 않을 수 있습니다.',lines:[ctl('actualCurvature','실제 추정'),ctl('desiredCurvature','목표'),cc('commandCurvature','요청'),out('outputCurvature','출력 기록')]},
  {id:'lateralAccel',title:'횡가속도 제어',unit:'m/s²',note:'토크 제어기의 실제 추정값과 목표값입니다.',lines:[ctl('actualLateralAccel','실제 추정'),ctl('desiredLateralAccel','목표')]},
  {id:'cruiseState',title:'크루즈 상태',binary:true,note:'차량의 크루즈 상태입니다. 순정 ACC 작동과 openpilot 자동 가감속 활성 여부는 다를 수 있습니다.',lines:[cs('cruiseEnabled','작동'),cs('cruiseAvailable','사용 가능'),cc('longActive','자동 가감속')]},
  {id:'stop',title:'정차·브레이크 홀드',binary:true,lines:[cs('standstill','정차'),cs('parkingBrake','주차브레이크'),cs('brakeHoldActive','브레이크 홀드')]},
 ];
 const key='roadviewer-vehicle-graphs',tabKey='roadviewer-analysis-tab',orderKey='roadviewer-graph-order';
 let selected=new Set(['speed','acceleration','pedals','angle','intervention','control']),tab='road';
 try{const saved=JSON.parse(localStorage.getItem(key));if(Array.isArray(saved))selected=new Set(saved.filter(id=>graphs.some(g=>g.id===id)));if(localStorage.getItem(tabKey)==='telemetry')tab='telemetry'}catch{}
 try{const saved=JSON.parse(localStorage.getItem(orderKey));if(Array.isArray(saved)){const order=[...new Set(saved.filter(id=>graphs.some(g=>g.id===id))),...graphs.map(g=>g.id).filter(id=>!saved.includes(id))];graphs.sort((a,b)=>order.indexOf(a.id)-order.indexOf(b.id))}}catch{}
 const roadTab=$('roadTab'),telemetryTab=$('telemetryTab'),roadView=$('roadView'),view=$('telemetryView'),scroll=$('telemetryGraphs'),status=$('telemetryStatus');
 let payload=null,loadedKey=null,loadingKey=null,failedKey=null,requestId=0,span=null,start=0,gesture=null;
 const cards=new Map(),seriesCache=new Map();
 const summaries=[['속도',cs('speed'),'km/h'],['가속도',cs('acceleration'),'m/s²'],['조향각',cs('steeringAngle'),'°'],['조향 개입',cs('steeringPressed'),'']].map(([label,series,unit])=>{
  const cell=document.createElement('div'),name=document.createElement('span'),value=document.createElement('strong');name.textContent=label;value.textContent='—';cell.append(name,value);$('telemetrySummary').append(cell);return {series,unit,value};
 });
 function lowerBound(times,value){let a=0,b=times.length;while(a<b){const m=(a+b)>>1;if(times[m]<value)a=m+1;else b=m}return a}
 function series(source){
  const cacheKey=source.topic+'.'+source.key;if(seriesCache.has(cacheKey))return seriesCache.get(cacheKey);
  const stream=payload?.streams?.[source.topic];let result={times:stream?.times||[],values:stream?.values?.[source.key]||[]};
  if(source.fallback&&!result.values.some(valid))result=series(source.fallback);
  if(payload)seriesCache.set(cacheKey,result);return result;
 }
 const valid=value=>typeof value==='boolean'||Number.isFinite(value);
 const initialPreviewTimes=new Set();
 function currentSample(source){
  const {times,values}=series(source);
  // Match the road panel's start tolerance without filling missing samples inside the log.
  if(t<times[0])return times[0]-t<=LOG_EDGE_TOLERANCE+1e-6&&valid(values[0])?values[0]:null;
  if(t>times.at(-1))return recordingEndAvailable(times.at(-1),sampleEndTolerance(times))&&valid(values.at(-1))?values.at(-1):null;
  let i=lowerBound(times,t);if(times[i]!==t)i--;
  return i>=0&&t-times[i]<(payload?.maxGap||.15)&&valid(values[i])?values[i]:null;
 }
 function current(source){
  const value=currentSample(source);
  if(value!==null||playing||t>1e-6)return value;
  const {times,values}=series(source),first=values.findIndex(valid);
  // Preview only the leading valid sample near zero, never an interior gap or a later control activation.
  if(first<0||times[first]<=t||times[first]>.25+1e-6||times[first]>data.duration)return null;
  initialPreviewTimes.add(times[first]);return values[first];
 }
 function format(value,unit='',precision=2){return value===null?'—':typeof value==='boolean'?(value?'켜짐':'꺼짐'):value.toFixed(precision)+(unit?' '+unit:'')}
 async function load(){
  if(!data||tab!=='telemetry')return;
  const version=data.key||location.pathname;
  if(loadedKey===version||loadingKey===version||failedKey===version)return;
  payload=null;seriesCache.clear();loadingKey=version;status.textContent='차량 정보를 불러오는 중…';$('retryTelemetry').hidden=true;
  const ticket=++requestId,controller=new AbortController(),timeout=setTimeout(()=>controller.abort(),30000);
  try{
   const id=location.pathname.split('/').filter(Boolean).at(-1),r=await fetch('../../api/logs/'+encodeURIComponent(id)+'/telemetry?v='+encodeURIComponent(version),{cache:'no-store',signal:controller.signal});
   if(!r.ok){let message='차량 정보를 불러오지 못했습니다.';try{message=(await r.json()).error||message}catch{}throw Error(message)}
   const result=await r.json();if(!result.streams||!Number.isFinite(result.duration))throw Error('차량 정보 형식이 올바르지 않습니다. 로그 목록에서 제거 후 변환해 주세요.');
   if(ticket!==requestId)return;
   payload=result;seriesCache.clear();loadedKey=version;failedKey=null;span=null;start=0;status.textContent='';
   for(const card of cards.values())card.cache='';
  }catch(e){if(ticket===requestId){failedKey=version;status.textContent=controller.signal.aborted?'차량 정보 응답이 지연되었습니다. 다시 불러오기를 눌러 주세요.':e.message;$('retryTelemetry').hidden=false}}
  finally{clearTimeout(timeout);if(ticket===requestId){loadingKey=null;update()}}
 }
 function selectTab(next,save=true){
  tab=next;const show=tab==='telemetry';roadView.hidden=show;view.hidden=!show;document.querySelector('.road-ranges').hidden=show;
  roadTab.setAttribute('aria-selected',String(!show));telemetryTab.setAttribute('aria-selected',String(show));roadTab.tabIndex=show?-1:0;telemetryTab.tabIndex=show?0:-1;
  if(save)try{localStorage.setItem(tabKey,tab)}catch{}
  void load();render();
 }
 roadTab.onclick=()=>selectTab('road');telemetryTab.onclick=()=>selectTab('telemetry');
 for(const button of [roadTab,telemetryTab])button.onkeydown=e=>{if(!['ArrowLeft','ArrowRight','Home','End'].includes(e.key))return;e.preventDefault();const next=e.key==='Home'?'road':e.key==='End'?'telemetry':tab==='road'?'telemetry':'road';selectTab(next);(next==='road'?roadTab:telemetryTab).focus()};
 function domain(){const duration=Math.max(.001,data?.duration||payload?.duration||1),width=Math.min(span??duration,duration);start=Math.max(0,Math.min(start,duration-width));return [start,start+width]}
 function seekFrom(event,canvas,range){const r=canvas.getBoundingClientRect(),left=48,right=Math.max(left+1,r.width-8),fraction=Math.max(0,Math.min(1,(event.clientX-r.left-left)/(right-left)));setTime(range[0]+fraction*(range[1]-range[0]));last=performance.now()}
 function installSeeking(canvas){
  canvas.addEventListener('pointerdown',e=>{if(!payload||e.button!==0)return;gesture={canvas,id:e.pointerId,x:e.clientX,y:e.clientY,range:domain(),horizontal:false,touch:e.pointerType==='touch'};canvas.setPointerCapture(e.pointerId);if(!gesture.touch)seekFrom(e,canvas,gesture.range)});
  canvas.addEventListener('pointermove',e=>{if(!gesture||gesture.canvas!==canvas||gesture.id!==e.pointerId)return;const dx=Math.abs(e.clientX-gesture.x),dy=Math.abs(e.clientY-gesture.y);if(dx>6&&dx>dy)gesture.horizontal=true;if(!gesture.touch||gesture.horizontal)seekFrom(e,canvas,gesture.range)});
  canvas.addEventListener('pointerup',e=>{if(!gesture||gesture.id!==e.pointerId)return;const g=gesture;gesture=null;if(!g.touch||g.horizontal||Math.hypot(e.clientX-g.x,e.clientY-g.y)<6)seekFrom(e,canvas,g.range);if(canvas.hasPointerCapture(e.pointerId))canvas.releasePointerCapture(e.pointerId);update()});
  canvas.addEventListener('pointercancel',()=>{gesture=null;update()});canvas.addEventListener('lostpointercapture',()=>{if(gesture?.canvas===canvas){gesture=null;update()}});
  canvas.addEventListener('keydown',e=>{if(!data||!['ArrowLeft','ArrowRight','Home','End'].includes(e.key))return;e.preventDefault();e.stopPropagation();const range=domain();setTime(e.key==='Home'?range[0]:e.key==='End'?range[1]:t+(e.key==='ArrowRight'?1:-1)*(e.shiftKey?1:.1));last=performance.now()});
 }
 function rebuild(){
  scroll.replaceChildren();cards.clear();
  for(const graph of graphs.filter(g=>selected.has(g.id))){
   const card=document.createElement('section');card.className='telemetry-chart';card.dataset.graph=graph.id;
   const title=document.createElement('h3');title.textContent=graph.title+(graph.unit?' · '+graph.unit:'');
   const legend=document.createElement('div');legend.className='telemetry-legend';const labels=graph.lines.map((s,i)=>{const label=document.createElement('span');label.style.color=colors[i%colors.length];legend.append(label);return label});
   const plot=document.createElement('div');plot.className='telemetry-plot';const canvas=document.createElement('canvas');canvas.tabIndex=0;canvas.setAttribute('role','img');canvas.setAttribute('aria-label',graph.title+' 시간축 그래프. 클릭 또는 좌우 방향키로 재생 위치 이동');
   const cursor=document.createElement('div');cursor.className='telemetry-cursor';cursor.setAttribute('aria-hidden','true');plot.append(canvas,cursor);const note=document.createElement('p');note.className='telemetry-source-note';note.hidden=true;card.append(title,legend,plot,note);scroll.append(card);cards.set(graph.id,{graph,card,canvas,cursor,labels,note,noteKey:null,cache:''});installSeeking(canvas);
  }
  if(!selected.size){const empty=document.createElement('p');empty.textContent='선택된 그래프가 없습니다. 그래프 선택에서 항목을 켜 주세요.';scroll.append(empty)}
  update();
 }
 function draw(card,range,width){
  const {canvas,graph}=card,h=110,dpr=devicePixelRatio||1;canvas.width=Math.round(width*dpr);canvas.height=Math.round(h*dpr);
  const c=canvas.getContext('2d');c.setTransform(dpr,0,0,dpr,0,0);c.clearRect(0,0,width,h);
  const left=48,right=Math.max(left+1,width-8),top=8,bottom=88,X=time=>left+(time-range[0])/(range[1]-range[0])*(right-left);
  const sets=graph.lines.map(s=>{const row=series(s);return {...row,begin:Math.max(0,lowerBound(row.times,range[0])-1),end:Math.min(row.times.length,lowerBound(row.times,range[1])+1)}});
  let low=0,high=0,hasData=false;
  const gap=payload?.maxGap||.15;
  for(const s of sets)for(let i=s.begin;i<s.end;i++)if(valid(s.values[i])&&s.times[i]<=range[1]&&s.times[i]+gap>=range[0]){hasData=true;if(!graph.binary){low=Math.min(low,s.values[i]);high=Math.max(high,s.values[i])}}
  if(graph.bounds)[low,high]=graph.bounds;else{const pad=Math.max((high-low)*.08,graph.precision?10**(-graph.precision):.1);low-=pad;high+=pad}
  const Y=value=>bottom-(value-low)/(high-low)*(bottom-top);
  c.font='10px system-ui';c.lineWidth=1;c.strokeStyle='#29394a';c.fillStyle='#94a5b8';
  for(let i=0;i<=4;i++){const x=left+(right-left)*i/4;c.beginPath();c.moveTo(x,top);c.lineTo(x,bottom);c.stroke();c.textAlign=i===0?'left':i===4?'right':'center';c.fillText((range[0]+(range[1]-range[0])*i/4).toFixed(1)+'s',x,104)}
  if(!graph.binary)for(let i=0;i<=2;i++){const value=low+(high-low)*i/2,y=Y(value);c.beginPath();c.moveTo(left,y);c.lineTo(right,y);c.stroke();c.textAlign='right';c.fillText(graph.precision?value.toFixed(graph.precision):Math.abs(value)>=100?value.toFixed(0):value.toFixed(1),left-5,y+3)}
  c.save();c.beginPath();c.rect(left,top,right-left,bottom-top);c.clip();
  sets.forEach((s,j)=>{
   const color=colors[j%colors.length];c.strokeStyle=color;c.fillStyle=color;c.lineWidth=1.5;
   if(graph.binary){
    const band=(bottom-top)/sets.length,y=top+j*band+3;
    for(let i=s.begin;i<s.end;i++){if(typeof s.values[i]!=='boolean')continue;const end=Math.min(s.times[i]+gap,s.times[i+1]??s.times[i]+gap,range[1]);if(end<range[0])continue;const x=X(Math.max(range[0],s.times[i])),w=Math.max(s.values[i]?1:0,X(end)-x);c.globalAlpha=s.values[i]?1:.14;c.fillRect(x,y,w,Math.max(4,band-6))}c.globalAlpha=1;
   }else{
    // Retain every original sample and reuse paths while the displayed range stays unchanged.
    c.beginPath();let connected=false,previous=null;
    for(let i=s.begin;i<s.end;i++){const value=s.values[i],time=s.times[i];if(!Number.isFinite(value)){connected=false;previous=null;continue}const x=X(time),y=Y(value);if(connected&&time-previous<=gap)c.lineTo(x,y);else{c.moveTo(x,y);c.fillRect(x-.8,y-.8,1.6,1.6)}connected=true;previous=time}c.stroke();
   }
  });c.restore();
  if(!hasData){c.fillStyle='#94a5b8';c.textAlign='center';c.fillText('이 구간에 기록된 값 없음',(left+right)/2,48)}
 }
 function update(){
  if(tab!=='telemetry')return;
  if(data&&loadedKey!==(data.key||location.pathname)){void load();return}
  initialPreviewTimes.clear();
  for(const summary of summaries){const value=current(summary.series);summary.value.textContent=summary.series.key==='steeringPressed'?(value===null?'확인 불가':value?'개입':'없음'):format(value,summary.unit)}
  if(!payload)return;
  let range=domain();
  if(!gesture&&(span!==null||t<range[0]||t>range[1])){start=t-(range[1]-range[0])/2;range=domain()}
  $('graphTime').textContent=clock(t)+' · '+range[0].toFixed(1)+'–'+range[1].toFixed(1)+'s';
  const bounds=scroll.getBoundingClientRect();
  for(const card of cards.values()){
   card.graph.lines.forEach((s,i)=>{card.labels[i].textContent=s.label+' '+format(current(s),'',card.graph.precision||2)});
   if(card.noteKey!==loadedKey){
    const missing=[],zero=[];
    for(const source of card.graph.lines){const samples=series(source).values.filter(valid);if(!samples.length)missing.push(source.label);else if(card.graph.checkZero&&samples.every(value=>value===0))zero.push(source.label)}
    card.note.textContent=[card.graph.note,missing.length?missing.join('·')+': 이 로그에 유효한 기록 없음':null,zero.length?zero.join('·')+': 기록값이 모두 0입니다. 실제 0인지 미기록 기본값인지 구분할 수 없습니다.':null].filter(Boolean).join(' ');card.note.hidden=!card.note.textContent;card.noteKey=loadedKey;
   }
   const r=card.canvas.getBoundingClientRect();if(r.bottom<bounds.top||r.top>bounds.bottom||r.width<1)continue;
   const cache=[r.width,devicePixelRatio,range[0],range[1]].join(':');if(cache!==card.cache){draw(card,range,r.width);card.cache=cache}
   card.cursor.hidden=t<range[0]||t>range[1];card.cursor.style.left=(48+(t-range[0])/(range[1]-range[0])*Math.max(1,r.width-56))+'px';
  }
  const preview=[...initialPreviewTimes];
  status.textContent=preview.length?'시작 데이터 미리보기 · '+Math.min(...preview).toFixed(3)+(preview.length>1?'–'+Math.max(...preview).toFixed(3):'')+'초의 첫 유효값':'';
 }
 function zoom(factor){if(!payload)return;const range=domain(),duration=data.duration;span=Math.min(duration,Math.max(.5,(range[1]-range[0])*factor));start=t-span/2;update()}
 $('graphZoomIn').onclick=()=>zoom(.5);$('graphZoomOut').onclick=()=>zoom(2);$('graphReset').onclick=()=>{span=null;start=0;update()};
 $('retryTelemetry').onclick=()=>{failedKey=null;void load()};
 scroll.addEventListener('scroll',update,{passive:true});new ResizeObserver(update).observe(scroll);
 const dialog=$('graphDialog'),opener=$('chooseGraphs');let oldOverflow='',dialogOpen=false;
 const options=$('graphOptions'),rows=new Map();let drag=null,dragFrame=0;
 function arrangeOptions(){
  for(const graph of graphs)options.append(rows.get(graph.id));
 }
 function moveGraph(id,to){
  const from=graphs.findIndex(g=>g.id===id);if(from===to||to<0||to>=graphs.length)return;
  graphs.splice(to,0,graphs.splice(from,1)[0]);
  try{localStorage.setItem(orderKey,JSON.stringify(graphs.map(g=>g.id)))}catch{}
  arrangeOptions();rebuild();$('graphOrderStatus').textContent=graphs[to].title+' · '+(to+1)+'번째로 이동했습니다.';
 }
 function dragTarget(){
  if(!drag)return;
  drag.row.style.transform=`translate3d(${drag.x-drag.grabX}px,${drag.y-drag.grabY}px,0)`;
  const others=[...options.querySelectorAll('.graph-option')].filter(row=>row!==drag.row);
  const index=others.findIndex(row=>{const r=row.getBoundingClientRect();return drag.y<r.top+r.height/2});
  const target=index<0?others.length:index;
  if(target!==drag.target){drag.target=target;options.insertBefore(drag.placeholder,others[target]||null)}
 }
 function dragScroll(){
  if(!drag)return;
  const r=dialog.getBoundingClientRect(),top=r.top+dialog.querySelector('.rv-choice-header').offsetHeight;
  if(drag.y<top+32)dialog.scrollTop-=8;else if(drag.y>r.bottom-32)dialog.scrollTop+=8;
  dragTarget();dragFrame=requestAnimationFrame(dragScroll);
 }
 function finishDrag(commit=false){
  if(!drag)return;const current=drag;drag=null;cancelAnimationFrame(dragFrame);
  if(current.handle.hasPointerCapture(current.pointer))current.handle.releasePointerCapture(current.pointer);
  current.row.classList.remove('graph-dragging');current.row.style.removeProperty('width');current.row.style.removeProperty('transform');current.placeholder.remove();dialog.classList.remove('graph-sorting');
  if(commit)moveGraph(current.id,current.target);
  current.handle.focus({preventScroll:true});
 }
 for(const graph of graphs){
  const row=document.createElement('div');row.className='graph-option';row.dataset.graph=graph.id;
  const label=document.createElement('label'),input=document.createElement('input');input.type='checkbox';input.value=graph.id;input.checked=selected.has(graph.id);
  input.onchange=()=>{input.checked?selected.add(graph.id):selected.delete(graph.id);try{localStorage.setItem(key,JSON.stringify([...selected]))}catch{}rebuild()};label.append(input,document.createTextNode(graph.title));
  const handle=document.createElement('button');handle.type='button';handle.className='graph-handle';handle.textContent='⠿';handle.setAttribute('aria-label',graph.title+' 드래그하여 순서 변경');
  handle.onpointerdown=e=>{
   if(e.button!==0||drag)return;e.preventDefault();
   const r=row.getBoundingClientRect(),placeholder=document.createElement('div');placeholder.className='graph-placeholder';placeholder.style.height=r.height+'px';placeholder.setAttribute('aria-hidden','true');
   row.before(placeholder);row.style.width=r.width+'px';row.classList.add('graph-dragging');dialog.classList.add('graph-sorting');
   drag={id:graph.id,target:graphs.findIndex(g=>g.id===graph.id),pointer:e.pointerId,handle,row,placeholder,grabX:e.clientX-r.left,grabY:e.clientY-r.top,x:e.clientX,y:e.clientY};
   handle.setPointerCapture(e.pointerId);dragTarget();dragFrame=requestAnimationFrame(dragScroll);
  };
  handle.onpointermove=e=>{if(drag?.pointer!==e.pointerId)return;drag.x=e.clientX;drag.y=e.clientY;dragTarget()};
  handle.onpointerup=e=>{if(drag?.pointer===e.pointerId){drag.x=e.clientX;drag.y=e.clientY;dragTarget();finishDrag(true)}};
  handle.onpointercancel=()=>finishDrag();handle.onlostpointercapture=()=>finishDrag();
  row.append(label,handle);
  rows.set(graph.id,row);
 }
 arrangeOptions();
 opener.onclick=()=>{if(dialog.open)return;oldOverflow=document.body.style.overflow;document.body.style.overflow='hidden';dialogOpen=true;dialog.showModal();$('graphDialogClose').focus({preventScroll:true})};
 function finishClose(){if(!dialogOpen)return;dialogOpen=false;document.body.style.overflow=oldOverflow;opener.focus({preventScroll:true})}
 function close(){finishDrag();dialog.close();finishClose()}
 $('graphDialogClose').onclick=close;dialog.addEventListener('cancel',e=>{e.preventDefault();close()});dialog.addEventListener('close',()=>{if(!dialog.open)finishClose()});
 dialog.onclick=e=>{if(e.target!==dialog)return;const r=dialog.getBoundingClientRect();if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)close()};
 window.renderTelemetry=update;rebuild();selectTab(tab,false);
})();
