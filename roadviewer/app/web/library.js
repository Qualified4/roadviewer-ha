'use strict';const $=id=>document.getElementById(id);let selected=[],busy=false,cleaning=false,refreshing=false,progressRefreshing=false,listRevision=0;const logRows=new Map();
let uploadController=null,networkRestarting=false;
let concurrencySaving=false,concurrencyRevision=0,savedConcurrency=1,savedAutoConvert=true,savedKeepOriginalVideo=true;
const names={unconverted:'미변환',queued:'대기 중',processing:'처리 중',ready:'재생 가능',error:'변환 실패'};
function processingText(m){
 if(m.status!=='processing')return m.status==='unconverted'&&m.auto_excluded?'미변환 · 수동 변환 필요':names[m.status];
 const p=m.progress||{},frames=Number.isFinite(p.frames)?Math.max(0,Math.floor(p.frames)).toLocaleString():'0';
 const pct=Number.isFinite(p.percent)?Math.max(0,Math.min(100,Math.floor(p.percent))):0;
 switch(p.stage){
  case 'log_read':return p.frames==null?'로그 읽는 중':`로그 읽는 중 · ${frames}프레임 읽음`;
  case 'log_analysis':return `로그 분석 중 · ${frames}프레임 분석 완료`;
  case 'video_read':return `영상 읽는 중 · ${frames}프레임`;
  case 'video_convert':return `영상 변환 중 · ${pct}%`;
  case 'video_verify':return `영상 검증 중 · ${pct}%`;
  case 'saving':return '마무리 중';
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
function filesChanged(e){
 if(busy||!e.target.files.length){return}
 const before=selected.length;const rejected=[];
 for(const file of e.target.files){
  const path=file.webkitRelativePath||file.name;
  if(!/(^|--)(rlog\.zst|qcamera\.ts)$/.test(file.name)){rejected.push(file.name);continue}
  const index=selected.findIndex(f=>(f.webkitRelativePath||f.name)===path);
  if(index<0)selected.push(file);else selected[index]=file;
 }
 // Keep the selected input alive while Android content-provider files are in use.
 selectionChanged();
 error(rejected.length?'지원하지 않는 파일: '+rejected.join(', ')+'. rlog.zst 또는 qcamera.ts 파일을 선택하세요.':'');
}
for(const id of pickerIds){
 const input=$(id);input.onchange=filesChanged;input.oncancel=selectionChanged;
}
$('clearSelection').onclick=()=>{if(busy)return;selected=[];pickerIds.forEach(id=>$(id).value='');selectionChanged();error('')};
function recordingActions(m){
 const actions=document.createElement('div');actions.className='actions';
 const more=document.createElement('details');more.className='recording-more';
 const toggle=document.createElement('summary');toggle.setAttribute('aria-label','추가 작업');
 toggle.title='추가 작업';toggle.innerHTML='<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d="m4 6 4 4 4-4" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';
 const menu=document.createElement('div');menu.className='recording-menu';
 more.append(toggle,menu);
 more.addEventListener('toggle',()=>{if(more.open)document.querySelectorAll('.recording-more[open]').forEach(other=>{if(other!==more)other.open=false})});
 menu.addEventListener('click',()=>{more.open=false});
 if(m.status==='ready'){
  const replay=document.createElement('a');replay.className='replay';replay.href=`view/${m.id}/`;replay.textContent='재생';actions.append(replay);
 }
 const waiting=m.status==='queued'||m.status==='processing',removing=m.status==='ready';
 const conversion=document.createElement('button');conversion.type='button';
 conversion.textContent=waiting?names[m.status]:removing?'제거':'변환';conversion.disabled=waiting;
 conversion.onclick=async()=>{
  if(removing&&!confirm(`${m.name}
변환된 분석·그래프와 재생용 임시 영상을 제거할까요? 원본 로그·TS 및 TS 없이 보관하는 MP4는 유지되며 자동으로 다시 변환되지 않습니다.`))return;
  conversion.disabled=true;
  try{await api(`api/logs/${m.id}/${removing?'prepared':'convert'}`,{method:removing?'DELETE':'POST'});logRows.delete(m.id);await refresh()}
  catch(e){error(e.message);conversion.disabled=false}
 };
 (removing?menu:actions).append(conversion);
 for(const [kind,label] of [['rlog.zst','로그 다운로드'],[m.video_download||'qcamera.ts','영상 다운로드']]){
  if(kind!=='rlog.zst'&&!m.video)continue;
  const link=document.createElement('a');link.className='download-original';link.href=kind==='rlog.zst'?`api/logs/${m.id}/original/rlog.zst`:`api/logs/${m.id}/download/video`;link.textContent=label;link.setAttribute('download','');menu.append(link);
 }
 const pin=document.createElement('button');pin.type='button';pin.className='pin-recording';
 pin.title=m.pinned?'구간 고정 해제':'구간 고정';pin.setAttribute('aria-label',pin.title);pin.setAttribute('aria-pressed',String(!!m.pinned));
 pin.innerHTML='<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path class="pin-head" d="M8 3h8l-1 7 4 4v2H5v-2l4-4z"/><path d="M12 16v6"/></svg>';
 pin.onclick=async()=>{pin.disabled=true;try{await api(`api/logs/${m.id}/pin`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({pinned:!m.pinned})});await refresh()}catch(e){error(e.message);pin.disabled=false}};actions.append(pin);
 const del=document.createElement('button');del.type='button';del.className='delete';del.textContent='완전 삭제';
 del.onclick=async()=>{
  if(!confirm(`${m.name}
원본 로그·영상과 변환 데이터를 완전히 삭제할까요? 이 작업은 되돌릴 수 없습니다.`))return;
  del.disabled=true;
  try{await api(`api/logs/${m.id}`,{method:'DELETE'});await refresh()}catch(e){error(e.message);del.disabled=false}
 };
 const separator=document.createElement('hr');menu.append(separator,del);actions.append(more);return actions;
}
document.addEventListener('click',e=>document.querySelectorAll('.recording-more[open]').forEach(more=>{if(!more.contains(e.target))more.open=false}));
document.addEventListener('keydown',e=>{if(e.key==='Escape')document.querySelectorAll('.recording-more[open]').forEach(more=>{more.open=false;more.querySelector('summary').focus()})});

async function refresh(){if(refreshing||busy||networkRestarting)return;refreshing=true;listRevision++;const settingsRevision=concurrencyRevision;try{const r=await fetch('api/logs',{cache:'no-store'});if(!r.ok)throw Error('로그 목록을 읽을 수 없습니다.');const data=await r.json();if(!concurrencySaving&&settingsRevision===concurrencyRevision){savedConcurrency=[1,2,3,4].includes(data.concurrency)?data.concurrency:1;const select=$('concurrency');select.value=String(savedConcurrency);select.disabled=false;select.dispatchEvent(new Event('rv:sync'));savedAutoConvert=data.auto_convert!==false;savedKeepOriginalVideo=data.keep_original_video!==false;syncAutoConvert()}$('summary').textContent=`${data.logs.length}개 로그 · 저장공간 ${storageSize(data.storage_used_bytes)} 사용 중`;$('uploadLimit').textContent=`한 번에 업로드할 파일 합계 최대 ${data.max_upload_mb} MB`;$('empty').hidden=!!data.logs.length;const rows=data.logs.map(m=>{const {progress,...details}=m,signature=JSON.stringify(details),cached=logRows.get(m.id);if(cached?.signature===signature){cached.state.textContent=processingText(m);return cached.row;}const row=document.createElement('div');row.className='log-row';const info=document.createElement('div'),title=document.createElement('div'),meta=document.createElement('div'),state=document.createElement('span');title.className='log-name';const name=document.createElement('span');renderRecordingName(name,m.name,m.files);title.append(name);if(m.pinned){const badge=document.createElement('span');badge.className='pin-badge';badge.textContent='고정';badge.title='이 구간을 자동 삭제에서 보호합니다.';title.append(badge)}state.className=m.status==='processing'?'state state-processing':'state';state.textContent=processingText(m);title.append(state);meta.className='log-meta';meta.textContent=`${new Date(m.uploaded*1000).toLocaleString()} · 보관 파일 ${storageSize(m.bytes)} · 변환 ${storageSize(m.prepared_bytes)} · ${m.video?'영상 있음':'영상 없음'}${m.duration!=null?' · '+m.duration.toFixed(1)+'초':''}`;info.append(title,meta);if(m.error){const e=document.createElement('div');e.className='log-error';e.textContent=m.error;info.append(e)}const actions=recordingActions(m);row.append(info,actions);logRows.set(m.id,{signature,row,state,status:m.status});return row});const list=$('list');rows.forEach((row,i)=>{if(list.children[i]!==row)list.insertBefore(row,list.children[i]||null)});while(list.children.length>rows.length)list.lastElementChild.remove();const ids=new Set(data.logs.map(m=>m.id));for(const id of logRows.keys())if(!ids.has(id))logRows.delete(id)}catch(e){error(e.message)}finally{refreshing=false}}
async function refreshProgress(){
 if(busy||networkRestarting||progressRefreshing||refreshing||![...logRows.values()].some(row=>row.status==='processing'||row.status==='queued'))return;
 progressRefreshing=true;const revision=listRevision;
 try{
  const response=await fetch('api/progress',{cache:'no-store'});
  if(!response.ok)return;
  const data=await response.json();
  // A newer full list owns status transitions and must not be overwritten.
  if(refreshing||revision!==listRevision)return;
  for(const [id,progress] of Object.entries(data.progress||{})){
   const cached=logRows.get(id);
   if(cached?.status==='processing')cached.state.textContent=processingText({status:'processing',progress});
  }
 }catch{}finally{progressRefreshing=false}
}
$('refresh').onclick=refresh;
function abortable(promise,signal){
 if(!signal)return promise;
 return new Promise((resolve,reject)=>{
  const abort=()=>reject(signal.reason);
  if(signal.aborted){abort();return}
  signal.addEventListener('abort',abort,{once:true});
  promise.then(resolve,reject).finally(()=>signal.removeEventListener('abort',abort));
 });
}
async function api(url,options={}){
 const signal=options.signal;
 signal?.throwIfAborted();
 const controller=new AbortController(),abort=()=>controller.abort();
 signal?.addEventListener('abort',abort,{once:true});
 const timeout=setTimeout(()=>controller.abort(),url.endsWith('/finish')?180000:60000);
 try{
  const response=await fetch(url,{...options,signal:controller.signal,headers:{'X-RoadViewer-Request':'1',...options.headers}});
  const text=await response.text();let result;
  try{result=JSON.parse(text)}catch{const e=Error(response.status===413?'Home Assistant 또는 원격 프록시의 업로드 크기 제한을 초과했습니다.':`서버 응답 오류 (${response.status}). 연결 상태를 확인해 주세요.`);e.status=response.status;e.retryable=response.status>=500||response.status===408||response.status===429;throw e}
  if(!response.ok){const e=Error(result.message||result.error||`요청 실패 (${response.status})`);e.retryable=response.status>=500||response.status===408||response.status===429;e.status=response.status;e.code=result.error;throw e}
  return result;
 }catch(e){
  if(signal?.aborted)throw signal.reason;
  if(controller.signal.aborted){const timeoutError=Error('업로드 응답이 지연되어 요청을 중단했습니다. 연결을 확인하고 다시 시도하세요.');timeoutError.retryable=true;throw timeoutError}
  if(e instanceof TypeError)e.retryable=true;
  throw e;
 }finally{clearTimeout(timeout);signal?.removeEventListener('abort',abort)}
}
async function reportUploadFailure(url,details){
 const match=url.match(/api\/uploads\/([a-f0-9]{32})/);
 if(!match)return;
 try{await fetch(`api/uploads/${match[1]}/failure`,{method:'POST',keepalive:true,headers:{'X-RoadViewer-Request':'1','Content-Type':'application/json'},body:JSON.stringify({...details,visibility:document.visibilityState})})}catch{}
}
async function uploadPart(url,part,signal){
 // Read the Android content-provider Blob once; retries send the same bytes.
 let body,readTimeout;
 try{body=await abortable(Promise.race([part.arrayBuffer(),new Promise((_,reject)=>{readTimeout=setTimeout(()=>reject(Error('file read timeout')),60000)})]),signal)}
 catch(e){signal.throwIfAborted();void reportUploadFailure(url,{stage:'file-read',errorName:e.name});throw Error('선택한 파일을 읽을 수 없습니다. 휴대폰에 저장된 파일을 다시 선택해 주세요.')}
 finally{clearTimeout(readTimeout)}
 for(let attempt=0;;attempt++){
  try{return await api(url,{method:'PUT',headers:{'Content-Type':'application/octet-stream'},body,signal})}
  catch(e){
   signal.throwIfAborted();
   void reportUploadFailure(url,{stage:'chunk',attempt:attempt+1,offset:new URL(url,location.href).searchParams.get('offset'),status:e.status,errorName:e.name});
   if(!e.retryable||attempt>=5)throw e;
   $('uploadStatus').textContent=`연결 재시도 ${attempt+1}/5 · 전송한 위치부터 계속합니다…`;
   await abortable(new Promise(resolve=>setTimeout(resolve,Math.min(1000*2**attempt,8000))),signal);
  }
 }
}
$('upload').onclick=async()=>{
 
 if(busy||cleaning||!selected.length)return;busy=true;document.body.classList.add('uploading');error('');$('upload').disabled=true;pickerIds.forEach(id=>$(id).disabled=true);$('clearSelection').disabled=true;$('progress').hidden=false;$('progress').value=0;
 uploadController=new AbortController();const signal=uploadController.signal;
 let session=null;let sent=0;const total=selected.reduce((sum,f)=>sum+f.size,0);
 try{
  $('uploadStatus').textContent='업로드 준비 중…';
  session=await api('api/uploads',{signal,method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({files:selected.map(f=>({name:f.webkitRelativePath||f.name,size:f.size}))})});
  for(let i=0;i<selected.length;i++){
   const file=selected[i];
   for(let offset=0;offset<file.size;offset+=session.chunk_size){
    const part=file.slice(offset,offset+session.chunk_size);
    await uploadPart(`api/uploads/${session.id}/files/${i}?offset=${offset}`,part,signal);
    sent+=part.size;const pct=Math.round(sent/total*100);$('progress').value=pct;$('uploadStatus').textContent=`업로드 ${pct}% · 파일 ${i+1}/${selected.length}`;
   }
  }
  $('uploadStatus').textContent='서버에서 파일을 등록하는 중…';
  const result=await api(`api/uploads/${session.id}/finish`,{method:'POST',signal});session=null;
  const duplicates=result.duplicates||[],updated=result.updated||[];
  
  $('uploadStatus').textContent=`새 로그 ${result.logs.length}개 등록 · 영상 추가 ${updated.length}개 · 중복 ${duplicates.length}개 건너뜀.${result.logs.length||updated.length?' 준비가 끝나면 재생할 수 있습니다.':''}`;
  if(duplicates.some(d=>d.video_differs))error('이미 저장된 로그와 영상 구성이 다른 항목이 있습니다. 기존 로그를 보존하고 건너뛰었습니다. 영상을 변경하려면 기존 로그를 삭제한 뒤 로그와 영상을 함께 업로드하세요.');selected=[];pickerIds.forEach(id=>$(id).value='');selectionChanged();await refresh();
 }catch(e){if(signal.aborted){$('uploadStatus').textContent='업로드를 중단했습니다. 이미 등록을 시작한 파일은 등록을 마칩니다.'}else{error(e.message);$('uploadStatus').textContent='업로드 실패. 오류를 확인하고 다시 시도하세요.'}}
 finally{
  if(session&&!signal.aborted)try{await api(`api/uploads/${session.id}`,{method:'DELETE'})}catch{}
  uploadController=null;busy=false;document.body.classList.remove('uploading');void refresh();pickerIds.forEach(id=>$(id).disabled=false);selectionChanged();$('progress').hidden=true;
 }
};
refresh();setInterval(refresh,3000);setInterval(refreshProgress,1000);


$('cleanupStorage').onclick=async()=>{
 const button=$('cleanupStorage');button.disabled=true;cleaning=true;selectionChanged();
 uploadController?.abort();
 try{const result=await api('api/storage/cleanup',{method:'POST'});$('cleanupStatus').textContent=`${storageSize(result.removed_bytes)} 정리했습니다. 등록된 로그는 보존합니다.`;await refresh()}
 catch(e){error(e.message)}finally{button.disabled=false;cleaning=false;selectionChanged()}
};

function syncAutoConvert(){
 $('keepOriginalVideo').checked=savedKeepOriginalVideo;$('keepOriginalVideo').disabled=concurrencySaving;
 $('keepOriginalVideoInfo').textContent=savedKeepOriginalVideo?'TS와 재생용 MP4를 함께 저장하고, TS를 다운로드합니다.':'MP4 생성·검증 성공 후 TS를 삭제하고 MP4만 보관·다운로드합니다. 변환 실패 시 TS는 보존합니다.';
 $('concurrencyStatus').textContent='개수를 높이면 CPU와 메모리 사용량이 증가합니다. 설정을 낮춰도 진행 중인 작업은 완료합니다.';
 $('autoConvertState').textContent=savedAutoConvert?'켜짐':'꺼짐';$('keepOriginalVideoState').textContent=savedKeepOriginalVideo?'켜짐':'꺼짐';

 $('autoConvert').checked=savedAutoConvert;$('autoConvert').disabled=concurrencySaving;
 $('autoConvertInfo').textContent=savedAutoConvert?'미변환 항목을 오래된 순서부터 처리합니다. 수동 제거한 항목과 실패한 항목은 직접 변환해 주세요.':'업로드는 저장만 합니다. 실행 중인 작업은 완료하고, 직접 누른 변환 작업은 계속 처리합니다.';
}
async function saveProcessingSettings(changes){
 if(concurrencySaving)return;
 concurrencySaving=true;concurrencyRevision++;$('autoConvert').disabled=true;$('keepOriginalVideo').disabled=true;$('concurrency').disabled=true;$('concurrency').dispatchEvent(new Event('rv:sync'));
 try{
  const result=await api('api/settings/processing',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(changes)});
  savedAutoConvert=result.auto_convert;savedConcurrency=result.concurrency;savedKeepOriginalVideo=result.keep_original_video!==false;
 }catch(e){error(e.message)}
 finally{concurrencySaving=false;syncAutoConvert();$('concurrency').value=String(savedConcurrency);$('concurrency').disabled=false;$('concurrency').dispatchEvent(new Event('rv:sync'));await refresh()}
}
$('autoConvert').onchange=()=>saveProcessingSettings({auto_convert:$('autoConvert').checked});
$('concurrency').onchange=()=>saveProcessingSettings({concurrency:Number($('concurrency').value)});
$('keepOriginalVideo').onchange=()=>saveProcessingSettings({keep_original_video:$('keepOriginalVideo').checked});

(()=>{
 for(const [selector,key] of [['.conversion-info','roadviewer-conversion-guide-open'],['.upload','roadviewer-upload-open']]){
  const guide=document.querySelector(selector);
  try{const saved=localStorage.getItem(key);if(saved!==null)guide.open=saved==='true'}catch{}
  guide.addEventListener('toggle',()=>{try{localStorage.setItem(key,String(guide.open))}catch{}});
 }
})();
