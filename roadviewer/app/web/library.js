'use strict';const $=id=>document.getElementById(id);let selected=[],busy=false,cleaning=false,refreshing=false,progressRefreshing=false,listRevision=0,listRequest=null;const logRows=new Map(),logGroups=new Map();
// Every drive starts folded when the list opens; what was unfolded is not remembered (an older build saved it).
try{localStorage.removeItem('roadviewer-expanded-routes')}catch{}
let uploadController=null,networkRestarting=false;
let concurrencySaving=false,concurrencyRevision=0,savedConcurrency=1,savedAutoConvert=true;
const names={unconverted:'미변환',queued:'대기 중',processing:'처리 중',ready:'재생 가능',error:'변환 실패'};
let bulkSelection=null;
// Work-based weights: finish large writes at 100%, then show only the short summary/registration sweep.
const STAGE_PROGRESS={log_prepare:[0,.01],log_decompress:[.01,.04],log_read:[.04,.45],log_analysis:[.45,.60],video_read:[.60,.64],video_convert:[.64,.74],video_verify:[.74,.80],telemetry_build:[.80,.85],telemetry_encode:[.85,.86],telemetry_compress:[.86,.88],replay_compact:[.88,.92],replay_encode:[.92,.96],replay_compress:[.96,1],summary_save:[1,1],registering:[1,1],saving:[.8,.8]};
const FINAL_STAGE_LABELS={telemetry_build:'차량 그래프 생성 중',telemetry_encode:'차량 그래프 JSON 변환 중',telemetry_compress:'차량 그래프 압축·저장 중',replay_compact:'재생 데이터 정리 중',replay_encode:'재생 데이터 JSON 변환 중',replay_compress:'재생 데이터 압축·저장 중',summary_save:'요약 저장 중',registering:'결과 등록 중',saving:'결과 저장 중'};
function showState(state,m){
 const text=processingText(m);let bar=state.querySelector('.state-progress');
 if(m.status!=='processing'){state.textContent=text;return}
 if(!bar){bar=document.createElement('span');bar.className='state-progress';bar.setAttribute('role','progressbar');bar.setAttribute('aria-label','전체 변환 진행률');bar.setAttribute('aria-valuemin','0');bar.setAttribute('aria-valuemax','100');bar.append(document.createElement('span'));state.replaceChildren(document.createTextNode(text),bar)}
 else state.firstChild.nodeValue=text;
 const p=m.progress||{},aggregate=p.stage?.startsWith('video_')&&Number.isFinite(p.video_percent);
 let [from,to]=aggregate?[.60,.80]:STAGE_PROGRESS[p.stage]||[0,0];
 if(m.video===false){
  if(p.stage==='log_read')[from,to]=[.04,.55];
  else if(p.stage==='log_analysis')[from,to]=[.55,.75];
  else if(from>=.8)[from,to]=[from,to].map(v=>.75+(v-.8)*1.25);
 }
 const ratio=aggregate?p.video_percent/100:p.stage==='log_analysis'?(Number.isFinite(p.frames)&&Number.isFinite(p.total_frames)&&p.total_frames>0?p.frames/p.total_frames:0):(Number.isFinite(p.percent)?p.percent/100:0),part=Math.max(0,Math.min(1,ratio));
 const revision=String(m.conversion_revision??0),previous=bar.dataset.revision===revision?Number(bar.firstChild.style.getPropertyValue('--progress')):0;
 const value=Number(Math.min(1,Math.max(previous,from+(to-from)*part)).toFixed(6));
 bar.hidden=p.stage==='summary_save'||p.stage==='registering';state.firstChild.nodeValue=processingText(m,Math.floor(value*100));
 bar.dataset.revision=revision;bar.firstChild.style.setProperty('--progress',String(value));bar.setAttribute('aria-valuenow',String(Math.round(value*1000)/10));
}
function processingText(m,overallPercent=null){
 if(m.status!=='processing')return m.status==='unconverted'&&m.auto_excluded?'미변환 · 수동 변환 필요':names[m.status];
 const p=m.progress||{},frames=Number.isFinite(p.frames)?Math.max(0,Math.floor(p.frames)).toLocaleString():'0';
 const pct=overallPercent??(Number.isFinite(p.percent)?Math.max(0,Math.min(100,Math.floor(p.percent))):0);
 if(p.stage==='registering'||p.stage==='summary_save')return FINAL_STAGE_LABELS[p.stage];
 if(FINAL_STAGE_LABELS[p.stage])return `${FINAL_STAGE_LABELS[p.stage]} · ${pct}%`;
 switch(p.stage){
  case 'log_prepare':return '변환 준비 중';
  case 'log_decompress':return `로그 압축 해제 중 · ${pct}%`;
  case 'log_read':return p.frames==null?'로그 읽는 중':`로그 읽는 중 · ${frames}프레임 읽음`;
  case 'log_analysis':return `로그 분석 중 · ${frames}프레임 분석 완료`;
  case 'video_read':return `영상 읽는 중 · ${frames}프레임`;
  case 'video_convert':return `영상 변환 중 · ${pct}%`;
  case 'video_verify':return `영상 패킷 검증 중 · ${pct}%`;
  default:return m.status==='unconverted'&&m.auto_excluded?'미변환 · 수동 변환 필요':names[m.status];
 }
}
function storageSize(bytes){if(!Number.isFinite(bytes))return '—';const units=['B','KB','MB','GB','TB'];let i=0;while(bytes>=1024&&i<units.length-1){bytes/=1024;i++}return `${bytes.toFixed(i?1:0)} ${units[i]}`}
function error(message){$('error').textContent=message;$('error').hidden=!message}
const pickerIds=['files'];
function selectionChanged(){
 $('selection').textContent=selected.length?`${selected.length}개 파일 · ${(selected.reduce((a,f)=>a+f.size,0)/1048576).toFixed(1)} MB`:'선택한 파일 없음';
 $('upload').disabled=busy||cleaning||!selected.length;$('clearSelection').disabled=busy||!selected.length;
 $('selectedFiles').replaceChildren(...selected.map(f=>{const li=document.createElement('li');li.textContent=f.webkitRelativePath||f.name;return li}));
}
function addFiles(files,folders=[]){
 if(busy||cleaning||(!files.length&&!folders.length))return;
 const rejected=[];
 for(const file of files){
  const path=file.webkitRelativePath||file.name;
  if(!/(^|--)(rlog\.zst|qcamera\.ts|fcamera\.hevc|ecamera\.hevc|(?:qcamera|camera|fcamera|ecamera)\.mp4)$/.test(file.name)){rejected.push(file.name);continue}
  const index=selected.findIndex(f=>(f.webkitRelativePath||f.name)===path);
  if(index<0)selected.push(file);else selected[index]=file;
 }
 selectionChanged();
 const messages=[];
 if(rejected.length)messages.push('지원하지 않는 파일: '+rejected.join(', ')+'. rlog.zst와 qcamera.ts, fcamera.hevc, ecamera.hevc 또는 카메라 MP4 파일을 선택하세요.');
 if(folders.length)messages.push('폴더는 추가할 수 없습니다. 폴더 안의 rlog.zst와 영상 파일을 선택해 주세요.');
 error(messages.join(' '));
}
for(const id of pickerIds){
 // Keep the selected input alive while Android content-provider files are in use.
 const input=$(id);
 input.onchange=e=>addFiles(e.target.files);input.oncancel=selectionChanged;
}
const dropZone=document.querySelector('.picker-surface');
let dragDepth=0;
const isFileDrag=e=>Array.from(e.dataTransfer?.types||[]).includes('Files');
function resetDrop(){dragDepth=0;dropZone.classList.remove('is-dragover')}
dropZone.addEventListener('dragenter',e=>{
 if(!isFileDrag(e))return;
 dragDepth++;dropZone.classList.toggle('is-dragover',!busy&&!cleaning);
});
dropZone.addEventListener('dragleave',e=>{
 if(!isFileDrag(e))return;
 dragDepth=Math.max(0,dragDepth-1);if(!dragDepth)resetDrop();
});
// Prevent the browser from opening a dropped file, including outside the picker.
document.addEventListener('dragover',e=>{
 if(!isFileDrag(e))return;
 e.preventDefault();const allowed=dropZone.contains(e.target)&&!busy&&!cleaning;
 e.dataTransfer.dropEffect=allowed?'copy':'none';
 if(allowed)dropZone.classList.add('is-dragover');else resetDrop();
});
document.addEventListener('drop',e=>{
 if(!isFileDrag(e))return;
 e.preventDefault();resetDrop();
 if(!dropZone.contains(e.target)||busy||cleaning)return;
 const files=[],folders=[];
 if(e.dataTransfer.items?.length){
  for(const item of e.dataTransfer.items){
   if(item.kind!=='file')continue;
   const entry=item.webkitGetAsEntry?.();
   if(entry?.isDirectory){folders.push(entry.name);continue}
   const file=item.getAsFile();if(file)files.push(file);
  }
 }else files.push(...e.dataTransfer.files);
 addFiles(files,folders);
});
document.addEventListener('dragend',resetDrop);
window.addEventListener('blur',resetDrop);
$('clearSelection').onclick=()=>{if(busy)return;selected=[];pickerIds.forEach(id=>$(id).value='');selectionChanged();error('')};
// In-page tabs (not page navigation): an upload keeps running while another tab is shown.
const LIBRARY_TABS=['logs','upload','storage','devices','settings'],tabButtons=[...document.querySelectorAll('.lib-tab')];
let libraryTab=null;
function selectTab(tab,{focus=false,hash=true}={}){
 if(!LIBRARY_TABS.includes(tab))tab='logs';
 const changed=libraryTab!==null&&libraryTab!==tab;libraryTab=tab;
 for(const button of tabButtons){
  const on=button.dataset.tab===tab,panel=$(button.getAttribute('aria-controls'));
  button.setAttribute('aria-selected',String(on));button.tabIndex=on?0:-1;
  // Panels announce show/hide like a disclosure: storage-devices.js loads and polls only while its panel is shown.
  if(panel.hidden===on){panel.hidden=!on;panel.dispatchEvent(new Event('toggle'))}
 }
 try{sessionStorage.setItem('roadviewer-library-tab',tab)}catch{}
 if(hash&&window.location.hash!=='#'+tab){const url=new URL(window.location.href);url.hash=tab;history.replaceState(history.state,'',url)}
 if(focus)$('tab-'+tab).focus();
 if(changed&&scrollY>0)scrollTo(0,0);
}
document.querySelector('.lib-tabs').addEventListener('keydown',e=>{
 const index=LIBRARY_TABS.indexOf(libraryTab),next={ArrowLeft:index-1,ArrowRight:index+1,Home:0,End:LIBRARY_TABS.length-1}[e.key];
 if(next===undefined)return;e.preventDefault();selectTab(LIBRARY_TABS[(next+LIBRARY_TABS.length)%LIBRARY_TABS.length],{focus:true});
});
for(const button of tabButtons)button.onclick=()=>selectTab(button.dataset.tab);
document.addEventListener('click',e=>{const target=e.target.closest?.('[data-goto-tab]');if(target)selectTab(target.dataset.gotoTab)});
window.addEventListener('hashchange',()=>{const tab=window.location.hash.slice(1);if(LIBRARY_TABS.includes(tab)&&tab!==libraryTab)selectTab(tab,{hash:false})});
{
 let saved=null;try{saved=sessionStorage.getItem('roadviewer-library-tab')}catch{}
 const linked=window.location.hash.slice(1);
 selectTab(LIBRARY_TABS.includes(linked)?linked:saved,{hash:false});
}

// Header summary: local usage against the limit, and the archive connection (filled by storage-devices.js).
const headerStorage={used:null,max:null,logs:null,archive:null};
const sameUnitSize=(used,max)=>{const a=storageSize(used),b=storageSize(max),unit=b.split(' ')[1];return a.split(' ')[1]===unit?`${a.split(' ')[0]}/${b}`:`${a} / ${b}`};
function syncHeaderStorage(){
 const {used,max}=headerStorage,known=Number.isFinite(used),percent=known&&max>0?used/max*100:null,meter=$('summary');
 $('headerStorageText').textContent=!known?'—':percent===null?storageSize(used):sameUnitSize(used,max);
 $('headerMeterFill').style.width=(percent===null?0:Math.max(0,Math.min(100,percent)))+'%';
 meter.classList.toggle('is-near-limit',percent!==null&&percent>=90);meter.classList.toggle('no-limit',percent===null);
 meter.setAttribute('aria-label',`로컬 저장공간 ${!known?'확인 중':percent===null?storageSize(used)+' 사용 · 한도 없음':`${storageSize(used)} / ${storageSize(max)} · ${Math.round(percent)}% 사용`} · 저장공간 탭으로 이동`);
 meter.title=(headerStorage.logs===null?'':`${headerStorage.logs}개 로그 · 저장공간 ${storageSize(used)} 사용 중\n`)+'Road Viewer 원본·변환·업로드 임시 파일의 총 파일 용량';
 $('storageWarning').hidden=!(percent>=90);
 if(percent>=90)$('storageWarningText').textContent=`로컬 저장공간 ${Math.round(percent)}% 사용 중`;
 const archive=headerStorage.archive,dot=$('headerArchive');dot.hidden=!archive;
 if(archive){$('headerArchiveText').textContent=archive.text;dot.dataset.state=archive.state}
}
function showUploadPill(percent){
 const pill=$('uploadPill');pill.hidden=percent===null;if(percent===null)return;
 $('uploadPillText').textContent=`업로드 ${percent}%`;pill.style.setProperty('--upload',String(percent/100));
 pill.setAttribute('aria-label',`업로드 ${percent}% 진행 중 · 업로드 탭으로 이동`);
}

const svgIcon=(d,size=18,fill=false)=>`<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="${fill?'currentColor':'none'}" stroke="${fill?'none':'currentColor'}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
// ⋯ that morphs into ✕ while its menu is open (the replay's ⋯, style.css/motion.css).
const MORE_ICON='<svg class="icon-more" viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><circle class="more-dot more-dot-l" cx="5" cy="12" r="1.8"/><circle class="more-dot" cx="12" cy="12" r="1.8"/><circle class="more-dot more-dot-r" cx="19" cy="12" r="1.8"/><g class="more-x"><line x1="12" y1="12" x2="4.15" y2="4.15" pathLength="1"/><line x1="12" y1="12" x2="19.85" y2="19.85" pathLength="1"/><line x1="12" y1="12" x2="19.85" y2="4.15" pathLength="1"/><line x1="12" y1="12" x2="4.15" y2="19.85" pathLength="1"/></g></svg>',PLAY_ICON=svgIcon('<path d="M7 4v16l13-8Z"/>',13,true);
const PIN_ICON='<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path class="pin-head" d="M9 4h6l-1 6 4 4H6l4-4Z"/><path d="M12 14v7"/></svg>';
const CAMERA_ICON=svgIcon('<path d="M4 8h3l2-3h6l2 3h3v11H4z"/><circle cx="12" cy="13" r="3.5"/>',20);
// A menu of further actions: only one is open at a time; Escape and outside clicks close it.
function moreMenu(label){
 const more=document.createElement('details');more.className='recording-more';
 const toggle=document.createElement('summary');toggle.setAttribute('aria-label',label);toggle.title=label;toggle.dataset.noRipple='';toggle.dataset.fill='';toggle.innerHTML=MORE_ICON;
 const menu=document.createElement('div');menu.className='recording-menu';
 more.append(toggle,menu);
 more.addEventListener('toggle',()=>{if(more.open)document.querySelectorAll('.recording-more[open]').forEach(other=>{if(other!==more)other.open=false})});
 // Opens downwards; upwards when it does not fit above the bottom tabs (or the window's edge) and there is more room
 // above, under the app bar. Inside a list that scrolls on its own (주행 지도's sheet), which clips it, the list's
 // edges count too: the list scrolls the menu clear when it fits on neither side.
 const place=()=>{
  more.classList.remove('opens-up');menu.style.removeProperty('--menu-shift');
  const box=menu.getBoundingClientRect(),anchor=toggle.getBoundingClientRect(),tabs=document.querySelector('.lib-tabs'),bar=document.querySelector('.lib-appbar'),list=more.closest('.drive-map-list');
  const tabsBox=tabs&&getComputedStyle(tabs).position==='fixed'?tabs.getBoundingClientRect():null,listBox=list?.getBoundingClientRect();
  const floor=Math.min((tabsBox?tabsBox.top:window.innerHeight)-8,listBox?listBox.bottom-6:Infinity),ceiling=Math.max((bar?Math.max(0,bar.getBoundingClientRect().bottom):0)+8,listBox?listBox.top+6:-Infinity);
  const below=floor-anchor.bottom-6,above=anchor.top-6-ceiling,h=box.height;
  let up=h>below&&above>below;
  if(list&&h>below&&h>above){
   // Fits on neither side: the side the list can scroll far enough for (down first), and scroll it there.
   const downRoom=below+list.scrollHeight-list.clientHeight-list.scrollTop,upRoom=above+list.scrollTop;
   up=h>downRoom&&upRoom>downRoom;
   list.scrollBy({top:up?above-h:h-below,behavior:'auto'});
  }
  more.classList.toggle('opens-up',up);
  // Still taller than the room (a low sheet): it slides inside the list, over its own button if need be.
  if(list){const a=toggle.getBoundingClientRect(),top=up?a.top-6-h:a.bottom+6,shift=Math.max(ceiling-top,Math.min(0,floor-top-h));if(Math.abs(shift)>.5)menu.style.setProperty('--menu-shift',Math.round(shift)+'px')}
 };
 more.addEventListener('rv:place',place);more.addEventListener('toggle',()=>{if(more.open&&!more._foldAnimation)place()});
 menu.addEventListener('click',e=>{if(e.target.closest('button,a'))more.open=false});
 return {more,menu};
}
function menuButton(menu,text,onclick,className=''){const button=document.createElement('button');button.type='button';button.textContent=text;if(className)button.className=className;button.onclick=onclick;menu.append(button);return button}
async function pinRecording(m,button){button.disabled=true;try{await api(`api/logs/${m.id}/pin`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({pinned:!m.pinned})});await refresh()}catch(e){error(e.message);button.disabled=false}}
// Segment row: one primary action (재생 / 변환 / 대기 중 / 처리 중) and the ⋯ menu with everything else.
function recordingActions(m){
 const actions=document.createElement('div');actions.className='actions';
 const {more,menu}=moreMenu('추가 작업');
 if(m.status==='ready'){
  const replay=document.createElement('a');replay.className='replay';replay.dataset.glow='';replay.href=`view/${m.id}/`;replay.innerHTML=PLAY_ICON;replay.append('재생');actions.append(replay);
 }
 const waiting=m.status==='processing',removing=m.status==='ready'||m.status==='queued';
 const conversion=document.createElement('button');conversion.type='button';
 conversion.textContent=waiting?names[m.status]:removing?'제거':'변환';conversion.disabled=waiting;if(waiting)conversion.className='recording-pending';
 conversion.onclick=async()=>{
  if(removing&&!confirm(`${m.name}
대기 중이면 변환을 취소하고, 변환된 분석·그래프와 재생용 임시 영상을 제거할까요? 원본 로그와 보관 영상은 유지되며 자동으로 다시 변환되지 않습니다.`))return;
  conversion.disabled=true;
  try{const result=await api(`api/logs/${m.id}/${removing?'prepared':'convert'}`,{method:removing?'DELETE':'POST'});if(removing&&result.status!=='unconverted')throw Error('변환 데이터 제거가 완료되지 않았습니다. 새로고침 후 상태를 확인해 주세요.');recordingChanged({...m,status:result.status,auto_excluded:removing});await refresh()}
  catch(e){error(e.message);conversion.disabled=false}
 };
 if(m.status==='queued'){const queued=document.createElement('button');queued.type='button';queued.textContent=names.queued;queued.disabled=true;queued.className='recording-pending';actions.append(queued)}
 (removing?menu:actions).append(conversion);
 if(m.download_options)menuButton(menu,'다운로드',()=>openRecordingDownload([m]));
 menuButton(menu,'태그 편집',()=>editRecordingTags([m],()=>refresh()),'tag-edit');
 if(m.has_track)menuButton(menu,'지도에서 보기',()=>window.rvMaps?.showSegment(m.id),'map-segment');
 menuButton(menu,'로그 이름 복사',()=>logRows.get(m.id)?.row.querySelector('.log-name .copy-recording')?.click(),'copy-name');
 const pin=menuButton(menu,m.pinned?'구간 고정 해제':'구간 고정',()=>pinRecording(m,pin),'pin-recording');pin.setAttribute('aria-pressed',String(!!m.pinned));
 if(!m.download_options)for(const item of recordingDownloads(m,''))menu.append(downloadLink(item));
 const del=document.createElement('button');del.type='button';del.className='delete';del.textContent='완전 삭제';
 del.onclick=async()=>{
  if(!confirm(`${m.name}
원본 로그·영상과 변환 데이터를 완전히 삭제할까요? 이 작업은 되돌릴 수 없습니다.`))return;
  del.disabled=true;
  try{await api(`api/logs/${m.id}`,{method:'DELETE'});await refresh()}catch(e){error(e.message);del.disabled=false}
 };
 menu.append(document.createElement('hr'),del);actions.append(more);return actions;
}
// Route card: 재생 (first ready segment, else the first segment's own action), group pin and the ⋯ menu.
// The lowest-numbered ready segment of a route (the server's order may differ once segments arrive later).
const firstReady=group=>group.logs.filter(log=>log.status==='ready').sort((a,b)=>(logRoute(a).segment??0)-(logRoute(b).segment??0))[0];
function routeActions(group){
 const actions=document.createElement('div');actions.className='actions';
 const ready=firstReady(group);
 if(ready){const replay=document.createElement('a');replay.className='replay';replay.dataset.glow='';replay.href=`view/${ready.id}/`;replay.innerHTML=PLAY_ICON;replay.append('재생');actions.append(replay)}
 else{const own=recordingActions(group.firstLog),primary=own.querySelector(':scope>button');if(primary)actions.append(primary)}
 const pin=document.createElement('button');pin.type='button';pin.className='pin-recording';pin.dataset.noRipple='';pin.dataset.fill='';
 const allPinned=group.logs.every(log=>log.pinned),pinnedCount=group.logs.filter(log=>log.pinned).length,partial=!allPinned&&pinnedCount>0;
 pin.title=partial?`${pinnedCount}/${group.logs.length}개 구간 고정됨 · 전체 구간 고정`:allPinned?'전체 구간 고정 해제':'전체 구간 고정';pin.setAttribute('aria-label',pin.title);pin.setAttribute('aria-pressed',partial?'mixed':String(allPinned));pin.disabled=!!group.pinning;
 pin.innerHTML=PIN_ICON;pin.onclick=()=>pinLogGroup(group,!allPinned);actions.append(pin);
 const {more,menu}=moreMenu('주행 관리 메뉴');
 menuButton(menu,'전체 구간 다운로드',()=>openRecordingDownload(group.logs.map(log=>({...log,download_options:log.download_options||[]}))));
 menuButton(menu,'전체 구간 태그 편집',()=>editRecordingTags(group.logs,()=>refresh(),true));
 actions.append(more);return actions;
}
// Apply acknowledged changes even when the next list request is slow or fails.
function recordingChanged(m){
 listRequest?.abort();listRevision++;refreshing=false;
 const cached=logRows.get(m.id);if(!cached)return;
 cached.signature=null;cached.status=m.status;cached.log={...cached.log,...m};
 cached.state.className=m.status==='processing'?'state state-processing':'state';cached.state.dataset.status=m.status;showState(cached.state,m);
 const actions=recordingActions(m);cached.actions.replaceWith(actions);cached.actions=actions;
 for(const group of logGroups.values()){const index=group.logs.findIndex(log=>log.id===m.id);if(index<0)continue;group.logs[index]={...group.logs[index],...m};if(group.firstLog.id===m.id)group.firstLog=group.logs[index];syncGroupActions(group)}
}
document.addEventListener('click',e=>document.querySelectorAll('.recording-more[open]').forEach(more=>{if(!more.contains(e.target))more.open=false}));
// A touch outside an open menu only closes it: the row, button or card under the finger is not activated as well.
let touchPress=false;document.addEventListener('pointerdown',e=>{touchPress=e.pointerType==='touch'},true);
document.addEventListener('click',e=>{
 if(!touchPress||e.target.closest?.('.recording-more'))return;
 const open=[...document.querySelectorAll('.recording-more[open]')];if(!open.length)return;
 e.preventDefault();e.stopPropagation();open.forEach(more=>{more.open=false});
},true);
document.addEventListener('keydown',e=>{if(e.key==='Escape')document.querySelectorAll('.recording-more[open]').forEach(more=>{more.open=false;more.querySelector('summary').focus()})});

// Hand off the selected name so the replay title is available immediately.
document.addEventListener('click',e=>{
 const link=e.target.closest?.('a.replay'),id=link?.getAttribute('href').split('/').filter(Boolean).at(-1),cached=id&&logRows.get(id);if(!cached)return;
 try{sessionStorage.setItem('rv-route',JSON.stringify({id,text:cached.display}))}catch{}
});
// Phones: a ready segment row plays when tapped anywhere outside its own controls.
document.addEventListener('click',e=>{
 const row=e.target.closest?.('.log-row'),control=row&&e.target.closest('a,button,summary,details,input,label');if(bulkSelection?.active||!row||!matchMedia('(max-width:719px)').matches||(control&&row.contains(control)))return;
 row.querySelector('.actions>a.replay')?.click();
});
window.addEventListener('pageshow',()=>document.querySelectorAll('.recording-name-text').forEach(name=>name.style.viewTransitionName=''));
const MEDIA_STATE_LABELS={corrupt:'영상 읽기 오류',storage_unavailable:'저장소 연결 불가',checking:'영상 확인 중',available:'영상 있음',missing:'영상 없음'};
// Only recordings touched by the archive carry video_state (per camera); the row shows the worst one.
// Where each part of a recording is kept: the log and each stored camera. Rows untouched by the archive carry no
// storage_locations, so everything they list is local.
const STORAGE_PARTS=[['rlog','로그'],['front','고화질'],['qcamera','저용량'],['wide','와이드']],STORAGE_PLACES={local:'로컬',gdrive:'Drive',nas:'NAS',removed:'삭제됨'};
const STORAGE_PLACE_NAMES={local:'Home Assistant',gdrive:'Google Drive',nas:'NAS',removed:'삭제됨'};
const storageIcon=d=>`<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
const STORAGE_ICONS={local:storageIcon('<rect x="3" y="6" width="18" height="12" rx="2"/><path d="M7 14h.01M11 14h6"/>'),gdrive:storageIcon('<path d="M7 18h10a4 4 0 0 0 .6-7.96A6 6 0 0 0 6.1 9.2 4.5 4.5 0 0 0 7 18z"/>'),nas:storageIcon('<rect x="4" y="4" width="16" height="7" rx="1.5"/><rect x="4" y="13" width="16" height="7" rx="1.5"/><path d="M8 7.5h.01M8 16.5h.01"/>'),removed:storageIcon('<path d="M5 12h14"/>')};
// Each part of one recording and where it is kept; nothing for a recording that is still uploading.
function storagePlaces(m){
 if(m.status==='uploading')return [];
 const known=m.storage_locations||{},present=new Set([...Object.keys(known),'rlog',...(m.video_downloads||[]).map(video=>video.source)]);
 return STORAGE_PARTS.filter(([part])=>present.has(part)).map(([part,label])=>({part,label,place:STORAGE_PLACES[known[part]]?known[part]:'local'}));
}
// One line for where a recording is kept: "모두 로컬", "로그 로컬 · 영상 Drive", or "혼합" when the cameras differ.
function storageSummary(m){
 const parts=storagePlaces(m);if(!parts.length)return '';
 const places=new Set(parts.map(p=>p.place));if(places.size===1)return '모두 '+STORAGE_PLACES[parts[0].place];
 const log=parts.find(p=>p.part==='rlog'),videos=new Set(parts.filter(p=>p.part!=='rlog').map(p=>p.place));
 return log&&videos.size===1?`로그 ${STORAGE_PLACES[log.place]} · 영상 ${STORAGE_PLACES[[...videos][0]]}`:'혼합';
}
function storageParts(m){
 const parts=storagePlaces(m);if(!parts.length)return null;
 const box=document.createElement('div');box.className='storage-parts';box.setAttribute('aria-label','저장 위치');
 for(const {label,place} of parts){
  const chip=document.createElement('span');
  chip.className='storage-part storage-part-'+place;chip.title=`${label}: ${STORAGE_PLACE_NAMES[place]}`;
  chip.innerHTML=STORAGE_ICONS[place];const name=document.createElement('span'),where=document.createElement('b');
  name.textContent=label;where.textContent=STORAGE_PLACES[place];chip.append(name,where);box.append(chip);
 }
 return box;
}
const storageTone=text=>text.includes('Drive')?'gdrive':text.includes('NAS')?'nas':text==='혼합'?'mixed':'local';
function storageLine(text,title=''){
 const line=document.createElement('span');line.className='storage-summary';line.dataset.place=storageTone(text);if(title)line.title=title;
 line.innerHTML=STORAGE_ICONS[{gdrive:'gdrive',nas:'nas'}[storageTone(text)]||'local'];line.append(text);return line;
}
function mediaState(states){const values=Object.values(states||{});return Object.keys(MEDIA_STATE_LABELS).find(state=>values.includes(state))||null}
// Only rows whose remote copy did not verify carry archive_error; the local file is kept and the next cycle uploads again.
function archiveRetry(m){
 const box=document.createElement('div'),text=document.createElement('span'),retry=document.createElement('button');
 box.className='log-archive-error';text.textContent='원격 사본 검증에 실패했습니다. 로컬 파일은 유지됩니다.';
 retry.type='button';retry.className='archive-retry';retry.textContent='재시도';
 retry.onclick=async()=>{
  retry.disabled=true;
  try{await api(`api/logs/${m.id}/archive/retry`,{method:'POST'});await refresh()}
  catch(e){if(e.code==='no_archive_error'||e.code==='no_remote_mismatch')await refresh();else{error(e.message);retry.disabled=false}}
 };
 box.append(text,retry);return box;
}
// Group by the complete route, never the shortened display name (route hashes can differ).
function logRoute(log){
 const identity=recordingIdentity(log.name,log.files),source=(log.files?.['rlog.zst']||'').replaceAll('\\','/').split('/').pop().replace(/--rlog\.zst$/,''),pattern=/^(.*?)(?:--|\s*\/\s*구간\s*)(\d+)$/,match=pattern.exec(source)||pattern.exec(identity.original);
 return match?{key:match[1],segment:Number(match[2]),title:'주행 '+match[1].split('--')[0].replace(/^0+(?=.)/,'')}:{key:'log:'+log.id,segment:null,title:identity.display};
}
function reconcileLogs(parent,children){
 children.forEach((child,i)=>{if(parent.children[i]!==child)parent.insertBefore(child,parent.children[i]||null)});
 while(parent.children.length>children.length)parent.lastElementChild.remove();
}
// started_at is when the recording began (absent when unknown); uploaded is only when the file arrived, and is labelled so.
const epochDate=seconds=>{const date=Number.isFinite(seconds)?new Date(seconds*1000):null;return date&&!Number.isNaN(date.getTime())?date:null};
const startDate=m=>epochDate(m?.started_at),uploadDate=m=>epochDate(m?.uploaded),logDate=m=>startDate(m)||uploadDate(m);
// toLocale*String builds a new formatter on every call, which dominated rendering a long list on phones; the same
// formats are made once. localeText/localeDate equal toLocaleString()/toLocaleDateString('ko-KR').
const dateFormat=(locale,options)=>{const format=new Intl.DateTimeFormat(locale,options);return date=>format.format(date)};
const clockText=dateFormat('ko-KR',{hour:'numeric',minute:'2-digit'}),shortClock=dateFormat('ko-KR',{hour:'2-digit',minute:'2-digit',hour12:false});
const fullDay=dateFormat('ko-KR',{month:'long',day:'numeric',weekday:'long'}),localeDate=dateFormat('ko-KR');
const localeText=dateFormat(undefined,{year:'numeric',month:'numeric',day:'numeric',hour:'numeric',minute:'numeric',second:'numeric'});
const dayKey=date=>date?`${date.getFullYear()}-${date.getMonth()+1}-${date.getDate()}`:'none';
function dayLabel(date){
 if(!date)return ['날짜 없음',''];
 const today=new Date(),yesterday=new Date(today.getFullYear(),today.getMonth(),today.getDate()-1),full=fullDay(date);
 return [dayKey(date)===dayKey(today)?'오늘':dayKey(date)===dayKey(yesterday)?'어제':'',(date.getFullYear()===today.getFullYear()?'':date.getFullYear()+'년 ')+full];
}
const durationText=seconds=>{const s=Math.max(0,Math.round(seconds)),h=Math.floor(s/3600),m=Math.floor(s%3600/60);return h?`${h}:${String(m).padStart(2,'0')}:${String(s%60).padStart(2,'0')}`:`${m}:${String(s%60).padStart(2,'0')}`};
// A thumbnail not made yet (the backfill makes it from the archive) has its own URL: once the list reports it made,
// the URL changes and the image is fetched again instead of staying on the failed first try.
const thumbnailUrl=m=>m&&(m.thumbnail||m.thumbnail_available)?`api/logs/${m.id}/thumbnail?v=${m.conversion_revision??0}${m.thumbnail?'':'&pending=1'}`:null;
// The camera placeholder stays underneath; a loaded image covers it and a failed one is removed.
function setThumbnail(box,url){
 if(box.dataset.src===(url||''))return;box.dataset.src=url||'';
 box.querySelector('img')?.remove();box.classList.remove('has-thumb');if(!url)return;
 // Once a picture shows, the placeholder goes: a fold re-paints the card and an async-decoded picture could leave a
 // frame without it, flashing the camera icon (phones and tablets). Sync decoding keeps re-paints whole too.
 const img=document.createElement('img');img.alt='';img.loading='lazy';img.decoding='sync';
 img.onload=()=>{if(img.isConnected)box.classList.add('has-thumb')};img.onerror=()=>{img.remove();box.classList.remove('has-thumb')};img.src=url;box.prepend(img);
}
// The card shows the drive's first picture: the lowest-numbered ready segment that has (or will have) a thumbnail,
// whatever order the server lists the segments in.
function cardThumbnail(group){
 let best=null,bestSegment=Infinity;
 for(const log of group.logs){if(log.status!=='ready'||!thumbnailUrl(log))continue;const n=logRoute(log).segment??Infinity;if(n<bestSegment){best=log;bestSegment=n}}
 return best;
}
function thumbnailBox(className){const box=document.createElement('div');box.className=className;box.insertAdjacentHTML('beforeend',`<span class="thumb-placeholder">${CAMERA_ICON}</span>`);return box}
const STATUS_BUCKETS=[['ready','재생 가능'],['processing','처리 중'],['queued','대기 중'],['unconverted','미변환'],['error','변환 실패']];
const ROUTE_BAR_BLOCKS=20;
function routeStatusText(logs){
 const counts=STATUS_BUCKETS.map(([status,label])=>[label,logs.filter(log=>log.status===status).length]).filter(([,count])=>count);
 return counts.length===1&&logs.length>1?`모두 ${counts[0][0]}`:counts.map(([label,count])=>logs.length>1?`${label} ${count}`:label).join(' · ');
}
// Duration-weighted share of automatic control and summed takeovers, over the segments that have a summary.
function routeDrive(logs){
 const known=logs.filter(log=>log.drive_summary&&Number.isFinite(log.drive_summary.engaged_ratio));if(!known.length)return null;
 const weight=log=>Number.isFinite(log.duration)&&log.duration>0?log.duration:0,total=known.reduce((sum,log)=>sum+weight(log),0);
 const ratio=total>0?known.reduce((sum,log)=>sum+log.drive_summary.engaged_ratio*weight(log),0)/total:known.reduce((sum,log)=>sum+log.drive_summary.engaged_ratio,0)/known.length;
 return {ratio,takeovers:known.reduce((sum,log)=>sum+(Number(log.drive_summary.takeovers)||0),0)};
}
function driveLine(drive){
 const line=document.createElement('span');line.className='route-drive';
 const percent=document.createElement('b'),count=document.createElement('b');percent.textContent=Math.round(drive.ratio*100)+'%';count.textContent=String(drive.takeovers);
 line.append('자동 제어 ',percent,' · 개입 ',count,'회');return line;
}
function unionTags(logs){const tags=new Map();for(const log of logs)for(const tag of log.tags||[])if(!tags.has(tagKey(tag.name)))tags.set(tagKey(tag.name),tag);return [...tags.values()]}
const segmentProgress=id=>logRows.get(id)?.state.querySelector('.state-progress>span')?.style.getPropertyValue('--progress')||'0';
function syncRouteBar(group){
 for(const block of group.bar.children)if(block.dataset.status==='processing'&&block.dataset.id)block.style.setProperty('--progress',segmentProgress(block.dataset.id));
}
// The route card summarises its segments; only changed parts are rebuilt so polling never flickers.
function syncRouteCard(group,route){
 const logs=group.logs,thumb=cardThumbnail(group),duration=logs.reduce((sum,log)=>sum+(Number.isFinite(log.duration)?log.duration:0),0);
 const statusSignature=JSON.stringify([route.title,group.firstLog.id,group.firstLog.started_at,group.firstLog.uploaded,logs.map(log=>[log.id,log.status,log.duration,log.tags,log.drive_summary,log.storage_locations,log.video_downloads?.length,log.name])]);
 setThumbnail(group.thumb,thumbnailUrl(thumb));
 if(group.cardSignature!==statusSignature){
  group.cardSignature=statusSignature;
  const started=startDate(group.firstLog),uploaded=uploadDate(group.firstLog),when=started?clockText(started)+' 출발':uploaded?'업로드 '+clockText(uploaded):null;
  group.time.textContent=route.segment===null?route.title:when||route.title;
  group.time.title=`첫 구간${group.firstSegment===null?'':' '+group.firstSegment}${started?' · 출발 '+started.toLocaleString():''} · 업로드 ${uploaded?uploaded.toLocaleString():'일시 없음'}`;
  group.name.textContent=route.segment===null?when||'기타 로그':route.title;
  group.duration.hidden=!duration;group.duration.textContent=durationText(duration);
  group.tags.replaceWith(group.tags=recordingTagBadges(unionTags(logs),3));group.tags.classList.add('route-tags');
  // Up to 20 segments: one block each. Longer drives show their first 20 blocks and a "+" in the colour of the most
  // urgent status among the rest (failed, processing, queued, unconverted, ready), so a long drive never looks like a
  // single segment and work still running further on stays visible. The card's title already gives the exact count.
  const more=logs.length>ROUTE_BAR_BLOCKS,rest=logs.slice(ROUTE_BAR_BLOCKS);group.bar.classList.toggle('has-more',more);
  const blocks=logs.slice(0,ROUTE_BAR_BLOCKS).map(log=>{
   const block=document.createElement('span'),k=logRoute(log).segment;block.className='route-seg';block.dataset.status=log.status;block.dataset.id=log.id;
   block.title=`${k===null?recordingIdentity(log.name,log.files).display:'구간 '+k} · ${processingText(log)}`;return block;
  });
  if(more){
   const plus=document.createElement('span');plus.className='route-more';plus.dataset.status=['error','processing','queued','unconverted'].find(status=>rest.some(log=>log.status===status))||'ready';
   plus.title=`나머지 ${rest.length}개 구간 · ${routeStatusText(rest)}`;plus.innerHTML='<svg aria-hidden="true" viewBox="0 0 10 10" width="10" height="10" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M5 1.5v7M1.5 5h7"/></svg>';blocks.push(plus);
  }
  group.bar.replaceChildren(...blocks);
  group.bar.setAttribute('aria-label',`${logs.length}개 구간: ${routeStatusText(logs)}`);group.bar.title=more?`${logs.length}개 구간 · ${routeStatusText(logs)}`:'';
  const facts=[Object.assign(document.createElement('span'),{className:'route-status',textContent:routeStatusText(logs)})],drive=routeDrive(logs);
  if(drive)facts.push(driveLine(drive));
  const summaries=[...new Set(logs.map(storageSummary).filter(Boolean))];
  if(summaries.length)facts.push(storageLine(summaries.length===1?summaries[0]:'혼합',summaries.length>1?'구간마다 저장 위치가 다릅니다. 펼쳐서 확인하세요.':''));
  group.facts.replaceChildren(...facts);
 }
 syncRouteBar(group);
}
// The route header has group play/pin/menu actions; individual row actions stay unchanged.
function syncGroupActions(group){
 if(group.pinning)return;
 const ready=firstReady(group),primary=ready||group.firstLog;
 const signature=JSON.stringify([primary.id,primary.name,primary.status,!!ready,group.logs.map(log=>[log.id,!!log.pinned])]);if(group.actionSignature===signature)return;
 // maps.js's 지도 button (a drive with GPS) stays first in the row.
 group.actions.replaceChildren(...group.actions.querySelectorAll(':scope>.route-map-button'),routeActions(group));group.actionSignature=signature;
}
async function pinLogGroup(group,pinned){
 if(group.pinning)return;
 const targets=group.logs.filter(log=>!!log.pinned!==pinned);let done=0;
 group.pinning=true;group.element.querySelectorAll('.pin-recording').forEach(button=>button.disabled=true);
 try{
  for(const log of targets){
   await api(`api/logs/${log.id}/pin`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({pinned})});
   done++;recordingChanged({...(group.logs.find(current=>current.id===log.id)||log),pinned});
  }
 }catch(e){error(`전체 구간 고정${pinned?'':' 해제'}: ${done}/${targets.length}개 변경 완료. ${e.message}`)}
 finally{group.pinning=false;group.element.querySelectorAll('.pin-recording').forEach(button=>button.disabled=false);syncGroupActions(group);await refresh()}
}
function createLogGroup(route){
 const element=document.createElement('details'),summary=document.createElement('summary'),main=document.createElement('div'),heading=document.createElement('div'),time=document.createElement('h3'),meta=document.createElement('span'),name=document.createElement('span'),count=document.createElement('span'),bar=document.createElement('div'),facts=document.createElement('div'),chevron=document.createElement('button'),body=document.createElement('div'),actions=document.createElement('div');
 const thumb=thumbnailBox('route-thumb'),duration=document.createElement('span');duration.className='route-duration';thumb.append(duration);
 element.className='log-route';element.dataset.route=route.key;element.open=false;
 time.className='route-time';meta.className='route-meta';name.className='log-route-name';name.title=route.key;count.className='log-route-count';meta.append(name,' · ',count);
 const tags=document.createElement('span');heading.className='route-heading';heading.append(time,meta,tags);
 bar.className='route-bar';bar.setAttribute('role','img');facts.className='route-facts';main.className='route-main';main.append(heading,bar,facts);
 chevron.className='log-route-chevron';chevron.type='button';chevron.setAttribute('aria-label','구간 펼치기');chevron.setAttribute('aria-expanded',String(element.open));chevron.innerHTML='<svg aria-hidden="true" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="m6 9 6 6 6-6"/></svg>';
 // Rows shown by unfolding are not new: they skip the new-row entrance (motion.css) and only follow the fold.
 chevron.onclick=event=>{event.preventDefault();event.stopPropagation();group.rows?.forEach(row=>row.classList.add('is-update'));window.rvDisclosure.animate(element)};
 element.addEventListener('toggle',()=>{chevron.setAttribute('aria-expanded',String(element.open));chevron.setAttribute('aria-label',element.open?'구간 접기':'구간 펼치기')});
 actions.className='log-route-actions';summary.append(thumb,main,actions,chevron);body.className='log-route-segments';element.append(summary,body);
 const group={element,body,count,actions,thumb,duration,time,name,tags,bar,facts};
 summary.addEventListener('click',event=>{
  // Menus and buttons in the header act on their own; a click on a menu's padding must not fold the card. The empty
  // rest of the actions row (beside the buttons, e.g. under the thumbnail on phones) folds it like the rest of the card.
  const onActions=event.target.closest('.log-route-actions .actions');
  if(onActions&&event.target.closest('a,button,summary,input,label')===summary){event.preventDefault();return}
  if(!onActions)group.rows.forEach(row=>row.classList.add('is-update'));
 });
 return group;
}
const listDays=new Map();
function arrangeLogGroups(logs,rows){
 const groups=new Map();
 logs.forEach((log,i)=>{
  const route=logRoute(log);let group=groups.get(route.key);
  if(!group){group=logGroups.get(route.key);if(!group){group=createLogGroup(route);logGroups.set(route.key,group)}
   group.logs=[];group.rows=[];group.firstLog=log;group.firstSegment=route.segment;group.route=route;groups.set(route.key,group)}
  if(route.segment!==null&&(group.firstSegment===null||route.segment<group.firstSegment)){group.firstLog=log;group.firstSegment=route.segment}
  group.logs.push(log);group.rows.push(rows[i]);
 });
 for(const group of groups.values()){reconcileLogs(group.body,group.rows);syncRouteCard(group,group.route);syncGroupActions(group)}
 // Date sections in the server's order (newest routes first); a day collects its routes where it first appears.
 const days=new Map();
 for(const group of groups.values()){const date=logDate(group.firstLog),key=dayKey(date);if(!days.has(key))days.set(key,{date,groups:[]});days.get(key).groups.push(group.element)}
 const sections=[...days].map(([key,{date,groups}])=>{
  let day=listDays.get(key);
  if(!day){const element=document.createElement('section'),title=document.createElement('h3'),list=document.createElement('div');element.className='log-day';element.dataset.day=key;title.className='log-day-title';list.className='log-day-routes';element.append(title,list);day={element,title,list};listDays.set(key,day)}
  const [relative,full]=dayLabel(date),label=relative+'|'+full;
  if(day.label!==label){day.label=label;day.title.replaceChildren(...[relative,full].filter(Boolean).map(text=>Object.assign(document.createElement('span'),{textContent:text})))}
  reconcileLogs(day.list,groups);return day.element;
 });
 reconcileLogs($('list'),sections);
 for(const key of listDays.keys())if(!days.has(key))listDays.delete(key);
 for(const key of logGroups.keys())if(!groups.has(key))logGroups.delete(key);
 $('logCounts').textContent=`주행 ${groups.size}번 · 구간 ${logs.length}개 · 재생 가능 ${logs.filter(log=>log.status==='ready').length}개`;
}
function renderRow(m,cached){
 const row=cached?.row||document.createElement('div');row.className=cached?'log-row is-update':'log-row';row.dataset.id=m.id;row.dataset.status=m.status;
 const thumb=cached?.thumb||thumbnailBox('log-thumb'),info=cached?.info||document.createElement('div'),title=cached?.title||document.createElement('div'),state=cached?.state||document.createElement('span');
 info.className='log-info';title.className='log-name';
 for(const child of [...title.children])if(child!==state)child.remove();
 const route=logRoute(m),date=startDate(m),name=document.createElement('span'),before=state.parentNode===title?state:null;
 renderRecordingName(name,m.name,m.files,route.segment===null?null:'구간 '+route.segment);title.insertBefore(name,before);
 if(date){const time=document.createElement('span');time.className='log-time';const end=Number.isFinite(m.duration)?new Date(date.getTime()+m.duration*1000):null;time.textContent=shortClock(date)+(end?'–'+shortClock(end):'');title.insertBefore(time,before)}
 state.className=(m.status==='processing'?'state state-processing':'state')+(cached?' is-update':'');state.dataset.status=m.status;showState(state,m);if(!before)title.append(state);
 // After the name and time: the state, then 고정; the tags take the line below (library.css) however few they are.
 if(m.pinned){const badge=document.createElement('span');badge.className='pin-badge';badge.innerHTML=PIN_ICON;badge.append('고정');badge.title='이 구간을 자동 삭제에서 보호합니다.';title.append(badge)}
 title.append(recordingTagBadges(m.tags));
 setThumbnail(thumb,m.status==='ready'?thumbnailUrl(m):null);
 const meta=document.createElement('div');meta.className='log-meta';
 const cameras=(m.video_downloads||[]).length,videoText=m.video?(cameras>1?`영상 ${cameras}종`:'영상 있음'):'영상 없음';
 const metaStart=(m.duration!=null?m.duration.toFixed(1)+'초 · ':'')+`보관 파일 ${storageSize(m.bytes)} · 변환 ${storageSize(m.prepared_bytes)} · `,videoState=mediaState(m.video_state);
 if(videoState){const badge=document.createElement('span');badge.className='media-state media-state-'+videoState;badge.textContent=MEDIA_STATE_LABELS[videoState];meta.append(metaStart,badge)}else meta.textContent=metaStart+videoText;
 const lines=[title,meta],where=storageSummary(m);
 if(where){const line=document.createElement('div');line.className='log-storage';line.append(storageLine(where,storagePlaces(m).map(p=>`${p.label}: ${STORAGE_PLACE_NAMES[p.place]}`).join('\n')));if(where==='혼합')line.append(storageParts(m));lines.push(line)}
 if(m.error){const e=document.createElement('div');e.className='log-error';e.textContent=m.error;lines.push(e)}
 if(m.archive_error)lines.push(archiveRetry(m));
 // The title (and its processing badge) stays connected so its animations keep their timeline.
 for(const child of [...info.children])if(child!==title)child.remove();if(title.parentNode!==info)info.prepend(title);info.append(...lines.slice(1));
 const actions=recordingActions(m);if(cached)cached.actions.replaceWith(actions);else row.append(thumb,info,actions);
 return {row,thumb,info,title,state,actions,selection:cached?.selection};
}
// Keep the row/title/state connected when metadata changes so CSS animations retain their live timeline.
const listError='로그 목록을 읽을 수 없습니다.';let listFailures=0,listErrorShown=null,listBody=null;
async function refresh({poll=false}={}){
 if(busy||networkRestarting||bulkSelection?.running||document.hidden||(poll&&refreshing))return;
 // A user action supersedes any list snapshot taken before that action completed.
 listRequest?.abort();const request=listRequest=new AbortController(),revision=++listRevision;
 refreshing=true;const settingsRevision=concurrencyRevision;$('refresh').classList.add('is-loading');
 try{
  // The server answers 304 when the list is the one this page already holds: the kept text is read again, so an
  // unchanged list is handled exactly as a received one, without sending it.
  const r=await fetch('api/logs',{cache:'no-store',signal:request.signal,headers:listBody?{'If-None-Match':listBody.tag}:{}});
  let text;if(r.status===304&&listBody)text=listBody.text;else{if(!r.ok)throw Error(listError);text=await r.text();const tag=r.headers.get('ETag');listBody=tag?{tag,text}:null}
  const data=JSON.parse(text);if(revision!==listRevision)return;
  // A list that reads again clears its own earlier failure (other messages stay).
  listFailures=0;if(listErrorShown!==null&&$('error').textContent===listErrorShown)error('');listErrorShown=null;
  if(!concurrencySaving&&settingsRevision===concurrencyRevision){savedConcurrency=[1,2,3,4].includes(data.concurrency)?data.concurrency:1;const select=$('concurrency');select.value=String(savedConcurrency);select.disabled=false;select.dispatchEvent(new Event('rv:sync'));savedAutoConvert=data.auto_convert!==false;syncAutoConvert()}
  updateTagCatalog(data.logs);
  headerStorage.used=data.storage_used_bytes;headerStorage.logs=data.logs.length;syncHeaderStorage();
  // Uploads from a device or another browser show in the header chip too (this page's own upload drives it itself).
  if(!busy){const u=data.uploads;showUploadPill(u&&u.total_bytes>0?Math.min(100,Math.floor(u.received_bytes/u.total_bytes*100)):null)}
  $('uploadLimit').textContent=`한 번에 업로드할 파일 합계 최대 ${data.max_upload_mb} MB`;$('empty').hidden=!!data.logs.length;
  const rows=data.logs.map(m=>{
   const {progress,...details}=m,signature=JSON.stringify(details),cached=logRows.get(m.id),identity=recordingIdentity(m.name,m.files);
   if(cached?.signature===signature){showState(cached.state,m);cached.log=m;return cached.row}
   const parts=renderRow(m,cached);
   logRows.set(m.id,{...parts,signature,status:m.status,tags:m.tags||[],video:m.video,conversion_revision:m.conversion_revision,log:m,display:identity.display,search:searchText(m,identity)});
   return parts.row;
  });
  // Only rows in an open card can move on screen; rows of folded cards (most of a long list) are not measured.
  const motion=window.RoadViewerMotion,before=new Map([...logRows].filter(([,cached])=>cached.row.parentNode?.parentNode?.open).map(([id,cached])=>[id,motion.capture(cached.row)]));
  const ids=new Set(data.logs.map(m=>m.id));for(const id of logRows.keys())if(!ids.has(id))logRows.delete(id);
  arrangeLogGroups(data.logs,rows);renderChips();applyFilters();window.rvMaps?.listed(data.logs);if(motion.allowed())rows.forEach(row=>before.has(row.dataset.id)&&motion.play(row,before.get(row.dataset.id)));
 }catch(e){
  // Back from a long time in the background, the first request can fail before Home Assistant renews the ingress
  // session or the connection wakes up: one failure retries in a second, only a repeated one is shown.
  if(!request.signal.aborted){if(++listFailures>1){error(e.message);listErrorShown=e.message}else setTimeout(()=>refresh(),1000)}
 }finally{if(revision===listRevision){refreshing=false;$('refresh').classList.remove('is-loading')}}
}
async function refreshProgress(){
 if(document.hidden||busy||networkRestarting||progressRefreshing||refreshing||![...logRows.values()].some(row=>row.status==='processing'||row.status==='queued'))return;
 progressRefreshing=true;const revision=listRevision;
 try{
  const response=await fetch('api/progress',{cache:'no-store'});
  if(!response.ok)return;
  const data=await response.json();
  // A newer full list owns status transitions and must not be overwritten.
  if(refreshing||revision!==listRevision)return;
  for(const [id,progress] of Object.entries(data.progress||{})){
   const cached=logRows.get(id);
   if(cached?.status==='processing')showState(cached.state,{status:'processing',progress,video:cached.video,conversion_revision:cached.conversion_revision});
  }
  for(const group of logGroups.values())syncRouteBar(group);
 }catch{}finally{progressRefreshing=false}
}

// Filters: one built-in chip, one tag chip (or 태그 없음) and the search text, combined with AND.
const FILTERS=[['all','전체',()=>true],['pinned','고정',m=>!!m.pinned],['unconverted','미변환',m=>m.status==='unconverted'||m.status==='error'],['processing','처리 중',m=>m.status==='queued'||m.status==='processing'],
 ['gdrive','Drive',m=>Object.values(m.storage_locations||{}).includes('gdrive')],['nas','NAS',m=>Object.values(m.storage_locations||{}).includes('nas')]];
let logFilter='all',tagFilter='',logQuery='';
function searchText(m,identity){
 const date=logDate(m),uploaded=uploadDate(m),route=logRoute(m);
 return [identity.display,identity.original,route.key,route.title,...(m.tags||[]).map(tag=>tag.name),...(uploaded?[localeText(uploaded)]:[]),...(date?[localeText(date),fullDay(date),dayLabel(date)[0],localeDate(date),clockText(date)]:[])].join('\n').toLowerCase();
}
const tagMatches=(tags,value)=>!value||(value==='untagged'?!tags.length:tags.some(tag=>'tag:'+tagKey(tag.name)===value));
function chip(value,label,count,pressed,color){
 const button=document.createElement('button');button.type='button';button.className='filter-chip';button.dataset.filter=value;button.setAttribute('aria-pressed',String(pressed));
 if(color){const dot=document.createElement('i');dot.className='chip-dot';dot.dataset.color=color;dot.setAttribute('aria-hidden','true');button.append(dot)}
 const text=document.createElement('span');text.textContent=label;button.append(text);
 if(count!==null){const number=document.createElement('span');number.className='chip-count';number.textContent=String(count);button.append(number)}
 return button;
}
function renderChips(){
 const logs=[...logRows.values()].map(cached=>cached.log).filter(Boolean),box=$('logChips');
 const items=FILTERS.filter(([value,,test])=>value==='all'||value===logFilter||!['gdrive','nas'].includes(value)||logs.some(test)).map(([value,label,test])=>chip('filter:'+value,label,value==='all'?null:logs.filter(test).length,value==='all'?logFilter==='all'&&!tagFilter:logFilter===value));
 const tags=[...recordingTagCatalog];
 // A selected tag that no log carries any more stays visible with (0) so it can be cleared.
 if(tagFilter.startsWith('tag:')&&!tags.some(tag=>'tag:'+tagKey(tag.name)===tagFilter))tags.push({name:tagFilter.slice(4),color:'slate',missing:true});
 const tagChips=[chip('tag:untagged','태그 없음',logs.filter(m=>!(m.tags||[]).length).length,tagFilter==='untagged'),...tags.map(tag=>chip('tag:tag:'+tagKey(tag.name),tag.name,tag.missing?0:logs.filter(m=>tagMatches(m.tags||[],'tag:'+tagKey(tag.name))).length,tagFilter==='tag:'+tagKey(tag.name),Object.hasOwn(TAG_PALETTE,tag.color)?tag.color:'mint'))];
 const separator=document.createElement('span');separator.className='chip-separator';separator.setAttribute('aria-hidden','true');
 // Folded to two rows, a selected tag comes first among the tags so it is never folded away.
 if(!chipsExpanded){const picked=tagChips.findIndex(c=>c.getAttribute('aria-pressed')==='true');if(picked>0)tagChips.unshift(...tagChips.splice(picked,1))}
 const more=document.createElement('button');more.type='button';more.className='filter-chip chip-more';more.dataset.more='';more.setAttribute('aria-expanded',String(chipsExpanded));more.hidden=true;
 const next=[...items,separator,...tagChips,more],signature=JSON.stringify([chipsExpanded,next.map(e=>[e.dataset.filter,e.textContent,e.getAttribute('aria-pressed')])]);
 if(box.dataset.signature===signature)return;
 const active=document.activeElement?.closest?.('#logChips')?document.activeElement:null,focused=active&&(active.classList.contains('chip-more')?'.chip-more':`[data-filter="${CSS.escape(active.dataset.filter)}"]`);
 box.dataset.signature=signature;box.replaceChildren(...next);fitChips();
 if(focused)box.querySelector(focused)?.focus({preventScroll:true});
}
// Tablets and desktops wrap the chips: past two rows the rest fold behind a "+N개 더보기" chip at the end of the second
// row, which unfolds them all (then reads 접기). Phones scroll one row sideways instead and never fold.
let chipsExpanded=false;
const MORE_CHEVRON='<svg aria-hidden="true" viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>';
function fitChips(){
 const box=$('logChips'),more=box.querySelector('.chip-more');if(!more)return;
 // The toggle is only hidden when nothing folds: hiding it while measuring would drop its keyboard focus.
 const tags=[...box.querySelectorAll('.filter-chip[data-filter^="tag:"]')];tags.forEach(c=>c.hidden=false);
 if(!box.offsetParent||getComputedStyle(box).flexWrap==='nowrap'){more.hidden=true;return}
 const first=box.firstElementChild,top=first.offsetTop,pitch=first.offsetHeight+(parseFloat(getComputedStyle(box).rowGap)||0);
 const row=el=>Math.round((el.offsetTop-top)/pitch),last=[...box.children].filter(e=>e!==more).at(-1);
 if(row(last)<2){more.hidden=true;return}
 more.hidden=false;
 if(chipsExpanded){more.innerHTML='접기 '+MORE_CHEVRON;more.setAttribute('aria-label','태그 접기');return}
 // Fold tags from the end until the more chip itself fits on the second row.
 let folded=0;const label=()=>{more.innerHTML=`+${folded}개 더보기 `+MORE_CHEVRON;more.setAttribute('aria-label',`태그 ${folded}개 더보기`)};
 for(let i=tags.length-1;i>=0&&(folded===0||row(more)>1);i--){if(tags[i].getAttribute('aria-pressed')==='true')continue;tags[i].hidden=true;folded++;label()}
}
new ResizeObserver(()=>fitChips()).observe($('logChips'));
$('logChips').addEventListener('click',e=>{
 if(e.target.closest('.chip-more')){chipsExpanded=!chipsExpanded;renderChips();return}
 const button=e.target.closest('.filter-chip');if(!button)return;
 const [kind,...rest]=button.dataset.filter.split(':'),value=rest.join(':');
 if(kind==='filter'){if(value==='all'){logFilter='all';tagFilter=''}else logFilter=logFilter===value?'all':value}
 else tagFilter=tagFilter===value?'':value;
 renderChips();applyFilters();
 // The chip that just became selected gives a tiny spring pop (motion.css); re-renders do not.
 const picked=$('logChips').querySelector(`[data-filter="${CSS.escape(button.dataset.filter)}"][aria-pressed=true]`);
 if(picked){picked.classList.add('is-selected-pop');picked.addEventListener('animationend',()=>picked.classList.remove('is-selected-pop'),{once:true})}
});
$('logSearch').addEventListener('input',()=>{logQuery=$('logSearch').value.trim().toLowerCase();applyFilters()});
function applyFilters(){
 const test=FILTERS.find(([value])=>value===logFilter)?.[2]||(()=>true),query=logQuery.replace(/\s+/g,' '),active=logFilter!=='all'||!!tagFilter||!!query;let shown=0;
 for(const cached of logRows.values()){
  const matches=test(cached.log||{})&&tagMatches(cached.tags||[],tagFilter)&&(!query||!!cached.search?.includes(query));
  cached.row.hidden=!matches;if(matches&&cached.row.isConnected)shown++;
 }
 for(const group of logGroups.values()){const visible=group.rows.filter(row=>!row.hidden).length;group.element.hidden=!visible;group.count.textContent=active?`${visible} / ${group.rows.length}개 구간`:`${group.rows.length}개 구간`}
 for(const day of listDays.values())day.element.hidden=![...day.list.children].some(route=>!route.hidden);
 $('tagFilterStatus').hidden=!active;$('tagFilterStatus').textContent=shown?`${shown}개 로그 표시 중`:tagFilter&&logFilter==='all'&&!query?'선택한 태그에 해당하는 로그가 없습니다.':'조건에 맞는 로그가 없습니다.';
 bulkSelection?.sync();window.rvMaps?.filtered();
}
// Refresh-style buttons turn their arrow once per press (restarted when pressed again mid-turn).
const spinOnce=button=>{button.classList.remove('spin-once');void button.offsetWidth;button.classList.add('spin-once')};
for(const id of ['refresh','pairRenew'])$(id).addEventListener('animationend',e=>{if(e.animationName==='rv-refresh-turn')$(id).classList.remove('spin-once')});
$('refresh').onclick=()=>{spinOnce($('refresh'));refresh()};
function abortable(promise,signal){
 if(!signal)return promise;
 return new Promise((resolve,reject)=>{
  const abort=()=>reject(signal.reason);
  if(signal.aborted){abort();return}
  signal.addEventListener('abort',abort,{once:true});
  promise.then(resolve,reject).finally(()=>signal.removeEventListener('abort',abort));
 });
}
function apiResult(status,text){
 let result;
 try{result=JSON.parse(text)}catch{
  const e=Error(status===413?'Home Assistant 또는 원격 프록시의 업로드 크기 제한을 초과했습니다.':`서버 응답 오류 (${status}). 연결 상태를 확인해 주세요.`);
  e.status=status;e.retryable=status>=500||status===408||status===429;throw e;
 }
 if(status<200||status>=300){const e=Error(result.message||result.error||`요청 실패 (${status})`);e.retryable=status>=500||status===408||status===429;e.status=status;e.code=result.error;if(typeof result.reason==='string')e.reason=result.reason;throw e}
 return result;
}
async function api(url,options={}){
 const signal=options.signal;
 signal?.throwIfAborted();
 const controller=new AbortController(),abort=()=>controller.abort();
 signal?.addEventListener('abort',abort,{once:true});
 const timeout=setTimeout(()=>controller.abort(),url.endsWith('/finish')?180000:60000);
 try{
  const response=await fetch(url,{...options,signal:controller.signal,headers:{'X-RoadViewer-Request':'1',...options.headers}});
  return apiResult(response.status,await response.text());
 }catch(e){
  if(signal?.aborted)throw signal.reason;
  if(controller.signal.aborted){const timeoutError=Error('업로드 응답이 지연되어 요청을 중단했습니다. 연결을 확인하고 다시 시도하세요.');timeoutError.retryable=true;throw timeoutError}
  if(e instanceof TypeError)e.retryable=true;
  throw e;
 }finally{clearTimeout(timeout);signal?.removeEventListener('abort',abort)}
}
// Native upload progress distinguishes a slow transfer from an idle connection.
function sendUploadChunk(url,body,signal,onState){
 return new Promise((resolve,reject)=>{
  signal?.throwIfAborted();
  const xhr=new XMLHttpRequest(),started=Date.now();
  let timer,notice,settled=false,loaded=0,received=0,stage='chunk-send';
  function finish(error,result){
   if(settled)return;settled=true;clearTimeout(timer);clearTimeout(notice);signal?.removeEventListener('abort',abort);
   if(error){Object.assign(error,{stage,elapsedMs:Date.now()-started,loaded,total:body.byteLength});reject(error)}else resolve(result);
  }
  function abort(){finish(signal.reason);xhr.abort()}
  function watch(){
   if(settled)return;
   clearTimeout(timer);clearTimeout(notice);
   notice=setTimeout(()=>onState(stage==='chunk-response'?'서버 응답 대기 중…':'전송 확인 중…'),3000);
   timer=setTimeout(()=>{
    const e=Error('15초 동안 업로드 진척이 없어 연결을 다시 시도합니다.');e.code='upload_idle_timeout';e.retryable=true;
    finish(e);xhr.abort();
   },15000);
  }
  xhr.open('PUT',url);xhr.setRequestHeader('Content-Type','application/octet-stream');xhr.setRequestHeader('X-RoadViewer-Request','1');
  xhr.upload.onprogress=e=>{if(e.loaded>loaded){loaded=e.loaded;watch()}};
  xhr.upload.onload=()=>{stage='chunk-response';watch()};
  xhr.onprogress=e=>{if(e.loaded>received){received=e.loaded;watch()}};
  xhr.onload=()=>{try{finish(null,apiResult(xhr.status,xhr.responseText))}catch(e){finish(e)}};
  xhr.onerror=()=>{const e=Error('업로드 연결이 끊겼습니다.');e.code='upload_network_error';e.retryable=true;finish(e)};
  xhr.onabort=()=>{if(!settled)finish(signal?.reason||Error('업로드를 중단했습니다.'))};
  signal?.addEventListener('abort',abort,{once:true});
  watch();
  try{xhr.send(body)}catch(e){finish(e)}
 });
}
async function reportUploadFailure(url,details){
 const match=url.match(/api\/uploads\/([a-f0-9]{32})/);
 if(!match)return;
 try{await fetch(`api/uploads/${match[1]}/failure`,{method:'POST',keepalive:true,headers:{'X-RoadViewer-Request':'1','Content-Type':'application/json'},body:JSON.stringify({...details,visibility:document.visibilityState})})}catch{}
}
async function uploadPart(url,part,signal,onState=message=>$('uploadStatus').textContent=message){
 // Read the Android content-provider Blob once; retries send the same bytes.
 let body,readTimeout;const readStarted=Date.now();
 const readNotice=setTimeout(()=>onState('선택한 파일을 읽는 중…'),3000);
 try{body=await abortable(Promise.race([part.arrayBuffer(),new Promise((_,reject)=>{readTimeout=setTimeout(()=>reject(Error('file read timeout')),60000)})]),signal)}
 catch(e){signal?.throwIfAborted();void reportUploadFailure(url,{stage:'file-read',errorName:e.name,elapsedMs:Date.now()-readStarted});throw Error('선택한 파일을 읽을 수 없습니다. 휴대폰에 저장된 파일을 다시 선택해 주세요.')}
 finally{clearTimeout(readTimeout);clearTimeout(readNotice)}
 for(let attempt=0;;attempt++){
  try{return await sendUploadChunk(url,body,signal,onState)}
  catch(e){
   signal?.throwIfAborted();
   void reportUploadFailure(url,{stage:e.stage,attempt:attempt+1,offset:new URL(url,location.href).searchParams.get('offset'),status:e.status,errorName:e.name,errorCode:e.code,elapsedMs:e.elapsedMs,loaded:e.loaded,total:e.total});
   if(!e.retryable||attempt>=5)throw e;
   const delay=Math.min(1000*2**attempt,4000);
   onState(`연결 재시도 ${attempt+1}/5 · ${delay/1000}초 후 이어서 전송합니다…`);
   await abortable(new Promise(resolve=>setTimeout(resolve,delay)),signal);
  }
 }
}
const UPLOAD_PARALLEL=4;  // the server answers 8 requests at a time (start.py): half stay free for the pages' own requests
$('upload').onclick=async()=>{
 
 if(busy||cleaning||!selected.length)return;busy=true;document.body.classList.add('uploading');showUploadPill(0);error('');$('upload').disabled=true;pickerIds.forEach(id=>$(id).disabled=true);$('clearSelection').disabled=true;$('progress').hidden=false;$('progress').value=0;
 uploadController=new AbortController();const signal=uploadController.signal;
 let session=null;let sent=0;const total=selected.reduce((sum,f)=>sum+f.size,0);
 try{
  $('uploadStatus').textContent='업로드 준비 중…';
  session=await api('api/uploads',{signal,method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({files:selected.map(f=>({name:f.webkitRelativePath||f.name,size:f.size}))})});
  // Several files at once (each file's chunks stay in order: the server appends at the offset it expects). One chunk at a
  // time spent most of its time waiting for the server's answer.
  const files=selected,notes=new Map(),stop=new AbortController(),halt=()=>stop.abort(signal.reason);let next=0,failure=null;
  signal.addEventListener('abort',halt,{once:true});
  const show=()=>{const pct=Math.round(sent/total*100),note=[...notes.values()].find(Boolean);$('progress').value=pct;showUploadPill(pct);$('uploadStatus').textContent=`업로드 ${pct}% · 파일 ${Math.min(next,files.length)}/${files.length}`+(note?` · ${note}`:'')};
  const worker=async()=>{
   while(next<files.length&&!stop.signal.aborted){
    const i=next++,file=files[i];
    try{
     for(let offset=0;offset<file.size;offset+=session.chunk_size){
      const part=file.slice(offset,offset+session.chunk_size);
      await uploadPart(`api/uploads/${session.id}/files/${i}?offset=${offset}`,part,stop.signal,message=>{notes.set(i,message);show()});
      sent+=part.size;notes.delete(i);show();
     }
    }catch(e){if(!failure)failure=e;stop.abort(e);return}
   }
  };
  try{await Promise.all(Array.from({length:Math.min(UPLOAD_PARALLEL,files.length)},worker))}finally{signal.removeEventListener('abort',halt)}
  signal.throwIfAborted();if(failure)throw failure;
  $('uploadStatus').textContent='서버에서 파일을 등록하는 중…';
  const result=await api(`api/uploads/${session.id}/finish`,{method:'POST',signal});session=null;
  const duplicates=result.duplicates||[],updated=result.updated||[],restored=updated.filter(m=>m.original_restored).length,added=updated.length-restored;
  
  $('uploadStatus').textContent=`새 로그 ${result.logs.length}개 등록 · 영상 추가 ${added}개${restored?' · 원본 영상 복원 '+restored+'개':''} · 중복 ${duplicates.length}개 건너뜀.${result.logs.length||added?' 준비가 끝나면 재생할 수 있습니다.':''}`;
  if(duplicates.some(d=>d.video_differs))error('이미 저장된 로그와 영상 구성이 다른 항목이 있습니다. 기존 로그를 보존하고 건너뛰었습니다. 영상을 변경하려면 기존 로그를 삭제한 뒤 로그와 영상을 함께 업로드하세요.');selected=[];pickerIds.forEach(id=>$(id).value='');selectionChanged();await refresh();
 }catch(e){if(signal.aborted){$('uploadStatus').textContent='업로드를 중단했습니다. 이미 등록을 시작한 파일은 등록을 마칩니다.'}else{error(e.message);$('uploadStatus').textContent='업로드 실패. 오류를 확인하고 다시 시도하세요.'}}
 finally{
  if(session&&!signal.aborted)try{await api(`api/uploads/${session.id}`,{method:'DELETE'})}catch{}
  uploadController=null;busy=false;document.body.classList.remove('uploading');showUploadPill(null);void refresh();pickerIds.forEach(id=>$(id).disabled=false);selectionChanged();$('progress').hidden=true;
 }
};
// Screen mode lives in the 설정 tab (theme.js owns the state).
{const theme=window.RoadViewerTheme?.control();if(theme)document.getElementById('themeControl').append(theme)}
const pageReady=refresh();setInterval(()=>refresh({poll:true}),3000);setInterval(refreshProgress,1000);
// A hidden tab stops polling (each list request scans storage); catch up as soon as it is shown again.
document.addEventListener('visibilitychange',()=>{if(!document.hidden)refresh()});


$('cleanupStorage').onclick=async()=>{
 const button=$('cleanupStorage');button.disabled=true;cleaning=true;selectionChanged();
 uploadController?.abort();
 try{const result=await api('api/storage/cleanup',{method:'POST'});$('cleanupStatus').textContent=`${storageSize(result.removed_bytes)} 정리했습니다. 등록된 로그는 보존합니다.`;await refresh()}
 catch(e){error(e.message)}finally{button.disabled=false;cleaning=false;selectionChanged()}
};

function syncAutoConvert(){
 $('concurrencyStatus').textContent='개수를 높이면 CPU와 메모리 사용량이 증가합니다. 설정을 낮춰도 진행 중인 작업은 완료합니다.';
 $('autoConvertState').textContent=savedAutoConvert?'켜짐':'꺼짐';

 $('autoConvert').checked=savedAutoConvert;$('autoConvert').disabled=concurrencySaving;
 $('autoConvertInfo').textContent=savedAutoConvert?'미변환 항목을 오래된 순서부터 처리합니다. 수동 제거한 항목과 실패한 항목은 직접 변환해 주세요.':'업로드는 저장만 합니다. 실행 중인 작업은 완료하고, 직접 누른 변환 작업은 계속 처리합니다.';
}
async function saveProcessingSettings(changes){
 if(concurrencySaving)return;
 concurrencySaving=true;concurrencyRevision++;$('autoConvert').disabled=true;$('concurrency').disabled=true;$('concurrency').dispatchEvent(new Event('rv:sync'));
 try{
  const result=await api('api/settings/processing',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(changes)});
  savedAutoConvert=result.auto_convert;savedConcurrency=result.concurrency;
 }catch(e){error(e.message)}
 finally{concurrencySaving=false;syncAutoConvert();$('concurrency').value=String(savedConcurrency);$('concurrency').disabled=false;$('concurrency').dispatchEvent(new Event('rv:sync'));await refresh()}
}
$('autoConvert').onchange=()=>saveProcessingSettings({auto_convert:$('autoConvert').checked});
$('concurrency').onchange=()=>saveProcessingSettings({concurrency:Number($('concurrency').value)});

(()=>{
 for(const [selector,key] of [['.conversion-info','roadviewer-conversion-guide-open']]){
  const guide=document.querySelector(selector);
  try{const saved=localStorage.getItem(key);if(saved!==null)guide.open=saved==='true'}catch{}
  guide.addEventListener('toggle',()=>{try{localStorage.setItem(key,String(guide.open))}catch{}});
 }
})();
// Phone app bar fit: the wordmark's size follows its free width in CSS (cqi). When even its 14px minimum would not fit,
// the storage text yields first (.is-tight), and only then the wordmark text (.is-cramped). Re-checked when the bar
// resizes or its right group changes (upload pill shown/hidden, texts updated).
{
 const inner=document.querySelector('.lib-appbar-inner'),h1=inner?.querySelector('.app-brand h1');
 const fits=()=>{const size=parseFloat(getComputedStyle(h1).fontSize);return h1.scrollWidth*Math.min(1,14/size)<=h1.clientWidth+.5};
 const fitAppBar=()=>{
  inner.classList.remove('is-tight','is-cramped');
  if(!matchMedia('(max-width:719px)').matches||fits())return;
  inner.classList.add('is-tight');if(!fits())inner.classList.add('is-cramped');
 };
 if(h1){
  // The right group's own size also changes when the upload pill finishes fading out.
  const sizes=new ResizeObserver(fitAppBar);sizes.observe(inner);sizes.observe(inner.querySelector('.lib-status'));
  new MutationObserver(fitAppBar).observe(inner.querySelector('.lib-status'),{subtree:true,childList:true,characterData:true,attributes:true,attributeFilter:['hidden']});
  document.fonts?.ready.then(fitAppBar);
 }
}
