'use strict';const $=id=>document.getElementById(id);let selected=[],busy=false,refreshing=false;const logRows=new Map();
const names={queued:'대기 중',processing:'준비 중',ready:'재생 가능',error:'변환 실패'};
function storageSize(bytes){if(!Number.isFinite(bytes))return '—';const units=['B','KB','MB','GB','TB'];let i=0;while(bytes>=1024&&i<units.length-1){bytes/=1024;i++}return `${bytes.toFixed(i?1:0)} ${units[i]}`}
function error(message){$('error').textContent=message;$('error').hidden=!message}
const pickerIds=['files'];
function selectionChanged(){
 $('selection').textContent=selected.length?`${selected.length}개 파일 · ${(selected.reduce((a,f)=>a+f.size,0)/1048576).toFixed(1)} MB`:'선택한 파일 없음';
 $('upload').disabled=busy||!selected.length;$('clearSelection').disabled=busy||!selected.length;
 $('selectedFiles').replaceChildren(...selected.map(f=>{const li=document.createElement('li');li.textContent=f.webkitRelativePath||f.name;return li}));
}
function filesChanged(e){
 if(busy||!e.target.files.length){window.pickerDiagnostics?.record('selection_ignored',{picker:e.target.id,busy,count:e.target.files.length});return}
 const before=selected.length;const rejected=[];
 for(const file of e.target.files){
  const path=file.webkitRelativePath||file.name;
  if(!/(^|--)(rlog\.zst|qcamera\.ts)$/.test(file.name)){rejected.push(file.name);continue}
  const index=selected.findIndex(f=>(f.webkitRelativePath||f.name)===path);
  if(index<0)selected.push(file);else selected[index]=file;
 }
 // Clear only after copying File objects; do not mutate the input during picker launch.
 window.pickerDiagnostics?.record('selection_processed',{picker:e.target.id,received:e.target.files.length,before,after:selected.length,rejected:rejected.slice(0,20).map(name=>name.slice(0,180))});
 e.target.value='';selectionChanged();
 error(rejected.length?'지원하지 않는 파일: '+rejected.join(', ')+'. rlog.zst 또는 qcamera.ts 파일을 선택하세요.':'');
}
for(const id of pickerIds){
 const input=$(id);input.onchange=filesChanged;input.oncancel=selectionChanged;
}
$('clearSelection').onclick=()=>{if(busy)return;selected=[];pickerIds.forEach(id=>$(id).value='');selectionChanged();error('')};
async function refresh(){if(refreshing)return;refreshing=true;try{const r=await fetch('api/logs',{cache:'no-store'});if(!r.ok)throw Error('로그 목록을 읽을 수 없습니다.');const data=await r.json();$('summary').textContent=`${data.logs.length}개 로그 · 저장공간 ${storageSize(data.storage_used_bytes)} 사용 중`;$('uploadLimit').textContent=`한 번에 업로드할 파일 합계 최대 ${data.max_upload_mb} MB`;$('empty').hidden=!!data.logs.length;const rows=data.logs.map(m=>{const signature=JSON.stringify(m),cached=logRows.get(m.id);if(cached?.signature===signature)return cached.row;const row=document.createElement('div');row.className='log-row';const info=document.createElement('div'),title=document.createElement('div'),meta=document.createElement('div'),state=document.createElement('span');title.className='log-name';title.textContent=m.name;state.className='state';state.textContent=names[m.status];title.append(state);meta.className='log-meta';meta.textContent=`${new Date(m.uploaded*1000).toLocaleString()} · ${(m.bytes/1048576).toFixed(1)} MB · ${m.video?'영상 있음':'영상 없음'}${m.duration!=null?' · '+m.duration.toFixed(1)+'초':''}`;info.append(title,meta);if(m.error){const e=document.createElement('div');e.className='log-error';e.textContent=m.error;info.append(e)}const actions=document.createElement('div');actions.className='actions';if(m.status==='ready'){const a=document.createElement('a');a.className='replay';a.href=`view/${m.id}/`;a.textContent='재생';actions.append(a)}const del=document.createElement('button');del.className='delete';del.textContent='삭제';del.onclick=async()=>{if(!confirm(`${m.name}\n원본 로그·영상과 변환 데이터를 모두 삭제할까요?`))return;del.disabled=true;try{const r=await fetch(`api/logs/${m.id}`,{method:'DELETE',headers:{'X-RoadViewer-Request':'1'}});if(!r.ok)throw Error('삭제하지 못했습니다.');await refresh()}catch(e){error(e.message);del.disabled=false}};actions.append(del);row.append(info,actions);logRows.set(m.id,{signature,row});return row});const list=$('list');rows.forEach((row,i)=>{if(list.children[i]!==row)list.insertBefore(row,list.children[i]||null)});while(list.children.length>rows.length)list.lastElementChild.remove();const ids=new Set(data.logs.map(m=>m.id));for(const id of logRows.keys())if(!ids.has(id))logRows.delete(id)}catch(e){error(e.message)}finally{refreshing=false}}
$('refresh').onclick=refresh;
async function api(url,options={}){
 const response=await fetch(url,{...options,headers:{'X-RoadViewer-Request':'1',...options.headers}});
 const text=await response.text();let result;
 try{result=JSON.parse(text)}catch{throw Error(response.status===413?'Home Assistant 또는 원격 프록시의 업로드 크기 제한을 초과했습니다.':`서버 응답 오류 (${response.status}). ${text.replace(/<[^>]*>/g,' ').slice(0,160)}`)}
 if(!response.ok)throw Error(result.error||`요청 실패 (${response.status})`);
 return result;
}
$('upload').onclick=async()=>{
 window.pickerDiagnostics?.record('upload_clicked',{busy,count:selected.length});
 if(busy||!selected.length)return;busy=true;error('');$('upload').disabled=true;pickerIds.forEach(id=>$(id).disabled=true);$('clearSelection').disabled=true;$('progress').hidden=false;$('progress').value=0;
 let session=null;let sent=0;const total=selected.reduce((sum,f)=>sum+f.size,0);
 try{
  $('uploadStatus').textContent='업로드 준비 중…';
  session=await api('api/uploads',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({files:selected.map(f=>({name:f.webkitRelativePath||f.name,size:f.size}))})});
  for(let i=0;i<selected.length;i++){
   const file=selected[i];
   for(let offset=0;offset<file.size;offset+=session.chunk_size){
    const part=file.slice(offset,offset+session.chunk_size);
    await api(`api/uploads/${session.id}/files/${i}?offset=${offset}`,{method:'PUT',headers:{'Content-Type':'application/octet-stream'},body:part});
    sent+=part.size;const pct=Math.round(sent/total*100);$('progress').value=pct;$('uploadStatus').textContent=`업로드 ${pct}% · 파일 ${i+1}/${selected.length}`;
   }
  }
  $('uploadStatus').textContent='서버에서 파일을 등록하는 중…';
  const result=await api(`api/uploads/${session.id}/finish`,{method:'POST'});session=null;
  const duplicates=result.duplicates||[],updated=result.updated||[];
  window.pickerDiagnostics?.record('upload_complete',{created:result.logs.length,updated:updated.length,duplicates:duplicates.length});
  $('uploadStatus').textContent=`새 로그 ${result.logs.length}개 등록 · 영상 추가 ${updated.length}개 · 중복 ${duplicates.length}개 건너뜀.${result.logs.length||updated.length?' 준비가 끝나면 재생할 수 있습니다.':''}`;
  if(duplicates.some(d=>d.video_differs))error('이미 저장된 로그와 영상 구성이 다른 항목이 있습니다. 기존 로그를 보존하고 건너뛰었습니다. 영상을 변경하려면 기존 로그를 삭제한 뒤 로그와 영상을 함께 업로드하세요.');selected=[];pickerIds.forEach(id=>$(id).value='');selectionChanged();await refresh();
 }catch(e){window.pickerDiagnostics?.record('upload_failed',{errorName:e.name});error(e.message);$('uploadStatus').textContent='업로드 실패. 오류를 확인하고 다시 시도하세요.'}
 finally{
  if(session)try{await api(`api/uploads/${session.id}`,{method:'DELETE'})}catch{}
  busy=false;pickerIds.forEach(id=>$(id).disabled=false);selectionChanged();$('progress').hidden=true;
 }
};
refresh();setInterval(refresh,3000);
