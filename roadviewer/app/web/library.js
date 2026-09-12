'use strict';const $=id=>document.getElementById(id);let selected=[],busy=false;
const names={queued:'대기 중',processing:'준비 중',ready:'재생 가능',error:'변환 실패'};
function error(message){$('error').textContent=message;$('error').hidden=!message}
function filesChanged(e){if(!e.target.files.length)return;selected=[...e.target.files].filter(f=>/(^|--)(rlog\.zst|qcamera\.ts)$/.test(f.name));$('selection').textContent=selected.length?`${selected.length}개 파일 · ${(selected.reduce((a,f)=>a+f.size,0)/1048576).toFixed(1)} MB`:'지원하는 파일이 없습니다';$('upload').disabled=busy||!selected.length}
for(const id of ['files','folder']){
 const input=$(id);
 input.onchange=filesChanged;
 // Keep selected File objects separately; allow choosing the same files again.
 input.onclick=()=>{if(!busy)input.value=''};
 input.oncancel=()=>{$('upload').disabled=busy||!selected.length};
}
async function refresh(){try{const r=await fetch('api/logs');if(!r.ok)throw Error('로그 목록을 읽을 수 없습니다.');const data=await r.json();$('summary').textContent=`${data.logs.length}개 로그 · 업로드 최대 ${data.max_upload_mb} MB`;$('empty').hidden=!!data.logs.length;const rows=data.logs.map(m=>{const row=document.createElement('div');row.className='log-row';const info=document.createElement('div'),title=document.createElement('div'),meta=document.createElement('div'),state=document.createElement('span');title.className='log-name';title.textContent=m.name;state.className='state';state.textContent=names[m.status];title.append(state);meta.className='log-meta';meta.textContent=`${new Date(m.uploaded*1000).toLocaleString()} · ${(m.bytes/1048576).toFixed(1)} MB · ${m.video?'영상 있음':'영상 없음'}${m.duration!=null?' · '+m.duration.toFixed(1)+'초':''}`;info.append(title,meta);if(m.error){const e=document.createElement('div');e.className='log-error';e.textContent=m.error;info.append(e)}const actions=document.createElement('div');actions.className='actions';if(m.status==='ready'){const a=document.createElement('a');a.className='replay';a.href=`view/${m.id}/`;a.textContent='재생';actions.append(a)}const del=document.createElement('button');del.className='delete';del.textContent='삭제';del.onclick=async()=>{if(!confirm(`${m.name}\n원본 로그·영상과 변환 데이터를 모두 삭제할까요?`))return;del.disabled=true;try{const r=await fetch(`api/logs/${m.id}`,{method:'DELETE',headers:{'X-RoadViewer-Request':'1'}});if(!r.ok)throw Error('삭제하지 못했습니다.');await refresh()}catch(e){error(e.message);del.disabled=false}};actions.append(del);row.append(info,actions);return row});$('list').replaceChildren(...rows)}catch(e){error(e.message)}}
$('refresh').onclick=refresh;
async function api(url,options={}){
 const response=await fetch(url,{...options,headers:{'X-RoadViewer-Request':'1',...options.headers}});
 const text=await response.text();let result;
 try{result=JSON.parse(text)}catch{throw Error(response.status===413?'Home Assistant 또는 원격 프록시의 업로드 크기 제한을 초과했습니다.':`서버 응답 오류 (${response.status}). ${text.replace(/<[^>]*>/g,' ').slice(0,160)}`)}
 if(!response.ok)throw Error(result.error||`요청 실패 (${response.status})`);
 return result;
}
$('upload').onclick=async()=>{
 if(busy||!selected.length)return;busy=true;error('');$('upload').disabled=true;$('files').disabled=true;$('folder').disabled=true;$('progress').hidden=false;$('progress').value=0;
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
  $('uploadStatus').textContent=`${result.logs.length}개 로그 등록 완료. 준비가 끝나면 재생할 수 있습니다.`;selected=[];$('files').value='';$('folder').value='';$('selection').textContent='선택한 파일 없음';await refresh();
 }catch(e){error(e.message);$('uploadStatus').textContent='업로드 실패. 오류를 확인하고 다시 시도하세요.'}
 finally{
  if(session)try{await api(`api/uploads/${session.id}`,{method:'DELETE'})}catch{}
  busy=false;$('files').disabled=false;$('folder').disabled=false;$('upload').disabled=!selected.length;$('progress').hidden=true;
 }
};
refresh();setInterval(refresh,3000);
