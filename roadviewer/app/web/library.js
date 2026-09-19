'use strict';const $=id=>document.getElementById(id);let selected=[],busy=false,refreshing=false,progressRefreshing=false,listRevision=0;const logRows=new Map();
let concurrencySaving=false,concurrencyRevision=0,savedConcurrency=1,savedAutoConvert=true;
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
 $('upload').disabled=busy||!selected.length;$('clearSelection').disabled=busy||!selected.length;
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
async function refresh(){if(refreshing||busy)return;refreshing=true;listRevision++;const settingsRevision=concurrencyRevision;try{const r=await fetch('api/logs',{cache:'no-store'});if(!r.ok)throw Error('로그 목록을 읽을 수 없습니다.');const data=await r.json();if(!concurrencySaving&&settingsRevision===concurrencyRevision){savedConcurrency=data.concurrency===2?2:1;const select=$('concurrency');select.value=String(savedConcurrency);select.disabled=false;select.dispatchEvent(new Event('rv:sync'));savedAutoConvert=data.auto_convert!==false;syncAutoConvert()}$('summary').textContent=`${data.logs.length}개 로그 · 저장공간 ${storageSize(data.storage_used_bytes)} 사용 중`;$('uploadLimit').textContent=`한 번에 업로드할 파일 합계 최대 ${data.max_upload_mb} MB`;$('empty').hidden=!!data.logs.length;const rows=data.logs.map(m=>{const {progress,...details}=m,signature=JSON.stringify(details),cached=logRows.get(m.id);if(cached?.signature===signature){cached.state.textContent=processingText(m);return cached.row;}const row=document.createElement('div');row.className='log-row';const info=document.createElement('div'),title=document.createElement('div'),meta=document.createElement('div'),state=document.createElement('span');title.className='log-name';title.textContent=m.name;state.className=m.status==='processing'?'state state-processing':'state';state.textContent=processingText(m);title.append(state);meta.className='log-meta';meta.textContent=`${new Date(m.uploaded*1000).toLocaleString()} · 원본 ${storageSize(m.bytes)} · 변환 ${storageSize(m.prepared_bytes)} · ${m.video?'영상 있음':'영상 없음'}${m.duration!=null?' · '+m.duration.toFixed(1)+'초':''}`;info.append(title,meta);if(m.error){const e=document.createElement('div');e.className='log-error';e.textContent=m.error;info.append(e)}const actions=document.createElement('div');actions.className='actions';if(m.status==='ready'){const a=document.createElement('a');a.className='replay';a.href=`view/${m.id}/`;a.textContent='재생';actions.append(a)}const conversion=document.createElement('button');const waiting=m.status==='queued'||m.status==='processing';conversion.textContent=waiting?names[m.status]:m.status==='ready'?'제거':'변환';conversion.disabled=waiting;conversion.onclick=async()=>{const removing=m.status==='ready';if(removing&&!confirm(`${m.name}\n변환된 영상·분석·그래프 데이터를 제거할까요? 원본은 보관되며 자동으로 다시 변환되지 않습니다.`))return;conversion.disabled=true;try{await api(`api/logs/${m.id}/${removing?'prepared':'convert'}`,{method:removing?'DELETE':'POST'});logRows.delete(m.id);await refresh()}catch(e){error(e.message);conversion.disabled=false}};actions.append(conversion);const del=document.createElement('button');del.className='delete';del.textContent='완전 삭제';del.onclick=async()=>{if(!confirm(`${m.name}\n원본 로그·영상과 변환 데이터를 완전히 삭제할까요? 이 작업은 되돌릴 수 없습니다.`))return;del.disabled=true;try{const r=await fetch(`api/logs/${m.id}`,{method:'DELETE',headers:{'X-RoadViewer-Request':'1'}});if(!r.ok)throw Error('삭제하지 못했습니다.');await refresh()}catch(e){error(e.message);del.disabled=false}};actions.append(del);row.append(info,actions);logRows.set(m.id,{signature,row,state,status:m.status});return row});const list=$('list');rows.forEach((row,i)=>{if(list.children[i]!==row)list.insertBefore(row,list.children[i]||null)});while(list.children.length>rows.length)list.lastElementChild.remove();const ids=new Set(data.logs.map(m=>m.id));for(const id of logRows.keys())if(!ids.has(id))logRows.delete(id)}catch(e){error(e.message)}finally{refreshing=false}}
async function refreshProgress(){
 if(busy||progressRefreshing||refreshing||![...logRows.values()].some(row=>row.status==='processing'||row.status==='queued'))return;
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
async function api(url,options={}){
 const controller=new AbortController(),timeout=setTimeout(()=>controller.abort(),url.endsWith('/finish')?180000:60000);
 try{
  const response=await fetch(url,{...options,signal:controller.signal,headers:{'X-RoadViewer-Request':'1',...options.headers}});
  const text=await response.text();let result;
  try{result=JSON.parse(text)}catch{const e=Error(response.status===413?'Home Assistant 또는 원격 프록시의 업로드 크기 제한을 초과했습니다.':`서버 응답 오류 (${response.status}). 연결 상태를 확인해 주세요.`);e.status=response.status;e.retryable=response.status>=500||response.status===408||response.status===429;throw e}
  if(!response.ok){const e=Error(result.error||`요청 실패 (${response.status})`);e.retryable=response.status>=500||response.status===408||response.status===429;e.status=response.status;throw e}
  return result;
 }catch(e){
  if(controller.signal.aborted){const timeoutError=Error('업로드 응답이 지연되어 요청을 중단했습니다. 연결을 확인하고 다시 시도하세요.');timeoutError.retryable=true;throw timeoutError}
  if(e instanceof TypeError)e.retryable=true;
  throw e;
 }finally{clearTimeout(timeout)}
}
async function reportUploadFailure(url,details){
 const match=url.match(/api\/uploads\/([a-f0-9]{32})/);
 if(!match)return;
 try{await fetch(`api/uploads/${match[1]}/failure`,{method:'POST',keepalive:true,headers:{'X-RoadViewer-Request':'1','Content-Type':'application/json'},body:JSON.stringify({...details,visibility:document.visibilityState})})}catch{}
}
async function uploadPart(url,part){
 // Read the Android content-provider Blob once; retries send the same bytes.
 let body,readTimeout;
 try{body=await Promise.race([part.arrayBuffer(),new Promise((_,reject)=>{readTimeout=setTimeout(()=>reject(Error('file read timeout')),60000)})])}
 catch(e){void reportUploadFailure(url,{stage:'file-read',errorName:e.name});throw Error('선택한 파일을 읽을 수 없습니다. 휴대폰에 저장된 파일을 다시 선택해 주세요.')}
 finally{clearTimeout(readTimeout)}
 for(let attempt=0;;attempt++){
  try{return await api(url,{method:'PUT',headers:{'Content-Type':'application/octet-stream'},body})}
  catch(e){
   void reportUploadFailure(url,{stage:'chunk',attempt:attempt+1,offset:new URL(url,location.href).searchParams.get('offset'),status:e.status,errorName:e.name});
   if(!e.retryable||attempt>=5)throw e;
   $('uploadStatus').textContent=`연결 재시도 ${attempt+1}/5 · 전송한 위치부터 계속합니다…`;
   await new Promise(resolve=>setTimeout(resolve,Math.min(1000*2**attempt,8000)));
  }
 }
}
$('upload').onclick=async()=>{
 
 if(busy||!selected.length)return;busy=true;document.body.classList.add('uploading');error('');$('upload').disabled=true;pickerIds.forEach(id=>$(id).disabled=true);$('clearSelection').disabled=true;$('progress').hidden=false;$('progress').value=0;
 let session=null;let sent=0;const total=selected.reduce((sum,f)=>sum+f.size,0);
 try{
  $('uploadStatus').textContent='업로드 준비 중…';
  session=await api('api/uploads',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({files:selected.map(f=>({name:f.webkitRelativePath||f.name,size:f.size}))})});
  for(let i=0;i<selected.length;i++){
   const file=selected[i];
   for(let offset=0;offset<file.size;offset+=session.chunk_size){
    const part=file.slice(offset,offset+session.chunk_size);
    await uploadPart(`api/uploads/${session.id}/files/${i}?offset=${offset}`,part);
    sent+=part.size;const pct=Math.round(sent/total*100);$('progress').value=pct;$('uploadStatus').textContent=`업로드 ${pct}% · 파일 ${i+1}/${selected.length}`;
   }
  }
  $('uploadStatus').textContent='서버에서 파일을 등록하는 중…';
  const result=await api(`api/uploads/${session.id}/finish`,{method:'POST'});session=null;
  const duplicates=result.duplicates||[],updated=result.updated||[];
  
  $('uploadStatus').textContent=`새 로그 ${result.logs.length}개 등록 · 영상 추가 ${updated.length}개 · 중복 ${duplicates.length}개 건너뜀.${result.logs.length||updated.length?' 준비가 끝나면 재생할 수 있습니다.':''}`;
  if(duplicates.some(d=>d.video_differs))error('이미 저장된 로그와 영상 구성이 다른 항목이 있습니다. 기존 로그를 보존하고 건너뛰었습니다. 영상을 변경하려면 기존 로그를 삭제한 뒤 로그와 영상을 함께 업로드하세요.');selected=[];pickerIds.forEach(id=>$(id).value='');selectionChanged();await refresh();
 }catch(e){error(e.message);$('uploadStatus').textContent='업로드 실패. 오류를 확인하고 다시 시도하세요.'}
 finally{
  if(session)try{await api(`api/uploads/${session.id}`,{method:'DELETE'})}catch{}
  busy=false;document.body.classList.remove('uploading');void refresh();pickerIds.forEach(id=>$(id).disabled=false);selectionChanged();$('progress').hidden=true;
 }
};
refresh();setInterval(refresh,3000);setInterval(refreshProgress,1000);


$('concurrency').onchange=async()=>{
 if(concurrencySaving)return;
 const select=$('concurrency'),next=Number(select.value);
 concurrencySaving=true;concurrencyRevision++;select.disabled=true;$('autoConvert').disabled=true;
 try{
  const result=await api('api/settings/processing',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({concurrency:next})});
  savedConcurrency=result.concurrency;
  $('concurrencyStatus').textContent=savedConcurrency===2?'최대 2개씩 처리합니다.':'최대 1개씩 처리합니다. 이미 진행 중인 작업은 완료될 때까지 계속됩니다.';
  $('concurrencyStatus').hidden=false;
 }catch(e){error(e.message)}
 finally{select.value=String(savedConcurrency);select.disabled=false;concurrencySaving=false;syncAutoConvert();select.dispatchEvent(new Event('rv:sync'))}
};

$('cleanupStorage').onclick=async()=>{
 const button=$('cleanupStorage');button.disabled=true;
 try{const result=await api('api/storage/cleanup',{method:'POST'});$('cleanupStatus').textContent=`${storageSize(result.removed_bytes)} 정리했습니다. 최근 15분 이내 업로드와 등록된 로그는 보존합니다.`;await refresh()}
 catch(e){error(e.message)}finally{button.disabled=false}
};

function syncAutoConvert(){
 $('autoConvert').checked=savedAutoConvert;$('autoConvert').disabled=concurrencySaving;
 $('autoConvertInfo').textContent=savedAutoConvert?'자동 변환 켜짐 · 미변환 항목을 오래된 순서부터 처리합니다. 수동 제거한 항목과 실패한 항목은 직접 변환해 주세요.':'자동 변환 꺼짐 · 업로드는 저장만 합니다. 실행 중인 작업은 완료하고, 직접 누른 변환 작업은 계속 처리합니다.';
}
$('autoConvert').onchange=async()=>{
 if(concurrencySaving)return;
 const next=$('autoConvert').checked;
 concurrencySaving=true;concurrencyRevision++;$('autoConvert').disabled=true;$('concurrency').disabled=true;$('concurrency').dispatchEvent(new Event('rv:sync'));
 try{
  const result=await api('api/settings/processing',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({auto_convert:next})});
  savedAutoConvert=result.auto_convert;
 }catch(e){error(e.message)}
 finally{concurrencySaving=false;syncAutoConvert();$('concurrency').disabled=false;$('concurrency').dispatchEvent(new Event('rv:sync'));await refresh()}
};
