'use strict';
(()=>{
 const dialog=$('bulkDialog'),list=$('bulkList'),all=$('bulkAll'),convert=$('bulkConvert'),remove=$('bulkRemove'),del=$('bulkDelete'),close=$('bulkClose'),includePinned=$('bulkIncludePinned');
 let rows=[],running=false,loading=false,oldOverflow='',loadRevision=0;
 function sync(){
  const selected=rows.filter(row=>row.input.checked);
  all.checked=rows.length>0&&selected.length===rows.length;all.indeterminate=selected.length>0&&selected.length<rows.length;
  all.disabled=loading||running||!rows.length;
  for(const row of rows)row.input.disabled=running;
  const pinned=selected.filter(row=>row.log.pinned).length;
  $('bulkCount').textContent=`${selected.length} / ${rows.length}개 선택${pinned?` · 고정 ${pinned}개`:''}`;
  $('bulkTags').disabled=loading||running||!selected.length;
  convert.disabled=remove.disabled=del.disabled=loading||running||!selected.length;
  // Only pinned logs selected: removal is blocked by the protection, so say so next to the toggle that lifts it.
  const blocked=!loading&&!running&&!includePinned.checked&&selected.length>0&&pinned===selected.length;
  remove.disabled=del.disabled=remove.disabled||blocked;
  includePinned.disabled=loading||running;
  includePinned.closest('.bulk-pin-option').classList.toggle('needs-pinned',blocked);
  $('bulkPinHint').textContent=includePinned.checked?'선택한 고정 로그도 제거·완전 삭제에 포함됩니다.':blocked?`선택한 ${selected.length}개가 모두 고정 로그입니다. 제거·완전 삭제하려면 켜세요.`:'고정된 로그는 제거·완전 삭제에서 보호합니다.';
  close.disabled=running;
  download.disabled=loading||running||!selected.length;
  if(download.disabled)closeDownloads();
 }
 // Selected segments as one ZIP (server streams it): the logs, optionally with one file per camera.
 const download=$('bulkDownload'),downloadMenu=$('bulkDownloadMenu');
 const DOWNLOAD_CHOICES=[['rlog','로그만','rlog.zst'],['rlog,qcamera','로그 + 저화질 영상','rlog · qcamera'],['rlog,front,wide,qcamera','로그 + 모든 영상','rlog · 전방 · 와이드 · 저화질']];
 function closeDownloads(){downloadMenu.hidden=true;download.setAttribute('aria-expanded','false')}
 function openDownloads(){
  const modern=rows.filter(row=>row.input.checked).map(row=>row.log);
  if(modern.length&&modern.every(log=>log.download_options)){closeDownloads();openRecordingDownload(modern,'','all',true);return}
  const selected=rows.filter(row=>row.input.checked).map(row=>row.log),ids=selected.map(log=>log.id).join(',');
  const size=parts=>selected.reduce((sum,log)=>sum+(parts.includes('rlog')?log.log_bytes||0:0)+(log.video_downloads||[]).filter(v=>parts.includes(v.source)).reduce((a,v)=>a+v.bytes,0),0);
  const title=document.createElement('p');title.textContent=`선택한 ${selected.length}개 구간 · ZIP 하나`;
  let previous=-1;const items=[];
  for(const [parts,label,detail] of DOWNLOAD_CHOICES){
   const bytes=size(parts.split(','));if(!bytes||bytes===previous)continue;previous=bytes;
   const link=document.createElement('a');link.role='menuitem';link.href=`api/logs/download.zip?ids=${ids}&parts=${parts}`;link.download='';
   const name=document.createElement('span');name.textContent=label;const small=document.createElement('small');small.textContent=`${detail} · 약 ${storageSize(bytes)}`;
   link.append(name,small);link.onclick=()=>{closeDownloads();$('bulkStatus').textContent=`${selected.length}개 구간 다운로드를 시작했습니다. 받는 동안 이 화면을 닫아도 됩니다.`};items.push(link);
  }
  if(!items.length){const none=document.createElement('p');none.textContent='받을 수 있는 파일이 없습니다.';items.push(none)}
  // Very long selections exceed what a link can carry through Home Assistant Ingress.
  if(ids.length>6000){items.length=0;const many=document.createElement('p');many.textContent='한 번에 150개 구간까지 받을 수 있습니다. 선택을 나눠 주세요.';items.push(many)}
  downloadMenu.replaceChildren(title,...items);downloadMenu.hidden=false;download.setAttribute('aria-expanded','true');
  downloadMenu.querySelector('a')?.focus({preventScroll:true});
 }
 download.onclick=()=>downloadMenu.hidden?openDownloads():closeDownloads();
 dialog.addEventListener('keydown',e=>{if(e.key==='Escape'&&!downloadMenu.hidden){e.preventDefault();e.stopPropagation();closeDownloads();download.focus()}},true);
 dialog.addEventListener('pointerdown',e=>{if(!downloadMenu.hidden&&!e.target.closest('.bulk-download'))closeDownloads()});
 function addRow(log){
  const label=document.createElement('label');label.className='bulk-log';
  const input=document.createElement('input');input.type='checkbox';input.value=log.id;input.onchange=sync;
  const info=document.createElement('span'),title=document.createElement('span'),detail=document.createElement('small');
  const identity=recordingIdentity(log.name,log.files);title.textContent=identity.display;title.title=identity.original;
  title.className='bulk-log-title';const badge=document.createElement('span');badge.className='pin-badge';badge.textContent='고정';title.append(badge);
  info.append(title,detail);label.append(input,info);
  const row={log,input,label,detail,badge};updateRow(row);list.append(label);return row;
 }
 function updateRow(row){
  row.badge.hidden=!row.log.pinned;
  row.label.querySelector('.recording-tags')?.remove();row.badge.after(recordingTagBadges(row.log.tags));
  row.detail.replaceChildren(...[names[row.log.status]||row.log.status,`보관 ${storageSize(row.log.bytes)}`,`변환 ${storageSize(row.log.prepared_bytes)}`].map(text=>{const span=document.createElement('span');span.textContent=text;return span}));
 }
 $('bulkOpen').onclick=async()=>{
  if(dialog.open)return;
  const revision=++loadRevision;includePinned.checked=false;dialog.querySelector('.bulk-help').open=false;rows=[];list.replaceChildren();loading=true;sync();$('bulkFailures').hidden=true;$('bulkFailures').replaceChildren();
  $('bulkStatus').textContent='목록을 불러오는 중입니다.';
  oldOverflow=document.body.style.overflow;document.body.style.overflow='hidden';dialog.showModal();
  try{
   const data=await api('api/logs',{cache:'no-store'});
   if(!dialog.open||revision!==loadRevision)return;
   updateTagCatalog(data.logs);rows=data.logs.map(addRow);
   $('bulkStatus').textContent=rows.length?'작업할 로그를 선택하세요.':'저장된 로그가 없습니다.';
  }catch(e){if(dialog.open&&revision===loadRevision)$('bulkStatus').textContent=e.message}
  finally{if(revision===loadRevision){loading=false;sync()}}
 };
 includePinned.onchange=sync;
 all.onchange=()=>{for(const row of rows)row.input.checked=all.checked;sync()};
 close.onclick=()=>dialog.close();
 dialog.addEventListener('cancel',e=>{if(running)e.preventDefault()});
 dialog.addEventListener('close',()=>{loadRevision++;document.body.style.overflow=oldOverflow;$('bulkOpen').focus({preventScroll:true});void refresh()});
 async function perform(action){
  const complete=action==='delete',converting=action==='convert';
  if(running||loading)return;
  const selected=rows.filter(row=>row.input.checked);if(!selected.length)return;
  const protectPinned=!includePinned.checked;
  const protectedCount=converting||!protectPinned?0:selected.filter(row=>row.log.pinned).length,targetCount=selected.length-protectedCount;
  if(!targetCount)return;
  const protection=protectedCount?`고정된 ${protectedCount}개는 제외합니다. `:!protectPinned?'고정된 항목도 삭제 대상에 포함합니다. ':'';
  const message=protection+(complete?`선택한 ${targetCount}개 로그의 원본·영상·변환 데이터를 완전히 삭제할까요? 되돌릴 수 없습니다.`:`선택한 ${targetCount}개 로그의 변환 데이터를 제거할까요? 원본 로그와 보관 영상은 유지합니다. 대기 중인 변환은 취소하고 처리 중인 항목만 제외하며 자동 재변환하지 않습니다.`);
  if(!converting&&!confirm(message))return;
  running=true;sync();let succeeded=0,skipped=0;const failures=[];
  $('bulkFailures').hidden=true;$('bulkFailures').replaceChildren();
  try{
   for(const [index,row] of selected.entries()){
    $('bulkStatus').textContent=`${index+1} / ${selected.length}개 처리 중…`;
    if(!converting&&protectPinned&&row.log.pinned){skipped++;row.input.checked=false;sync();continue}
    if(converting&&['ready','queued','processing'].includes(row.log.status)){skipped++;row.input.checked=false;sync();continue}
    try{
     const result=await api(`api/logs/${row.log.id}${converting?'/convert':complete?'':'/prepared'}${converting||!protectPinned?'':'?skip_pinned=1'}`,{method:converting?'POST':'DELETE'});
     if(result.skipped==='pinned'){skipped++;row.log.pinned=true;row.input.checked=false;updateRow(row);sync();continue}
     if(converting&&result.status!=='queued')skipped++;else succeeded++;row.input.checked=false;
     if(complete){row.label.remove();rows=rows.filter(item=>item!==row);logRows.delete(row.log.id)}
     else if(converting){row.log={...row.log,status:result.status};updateRow(row)}
     else{row.log={...row.log,status:'unconverted',prepared_bytes:0,auto_excluded:true};updateRow(row)}
     if(!complete)recordingChanged(row.log);
    }catch(e){failures.push(`${row.log.name}: ${e.message}`)}
    sync();
   }
   $('bulkStatus').textContent=`${converting?'변환 요청':complete?'완전 삭제':'변환 데이터 제거'} ${succeeded}개 완료${skipped?` · 건너뜀 ${skipped}개`:''}${failures.length?` · 미완료 ${failures.length}개 (선택 유지)`:''}`;
   if(failures.length){
    for(const message of failures){const line=document.createElement('p');line.textContent=message;$('bulkFailures').append(line)}
    $('bulkFailures').hidden=false;
   }
  }finally{running=false;sync();void refresh()}
 }
 $('bulkTags').onclick=()=>editRecordingTags(rows.filter(row=>row.input.checked).map(row=>row.log),changes=>{for(const change of changes){const row=rows.find(row=>row.log.id===change.id);if(row){row.log.tags=change.tags;updateRow(row)}}void refresh()},true);
 convert.onclick=()=>perform('convert');remove.onclick=()=>perform('remove');del.onclick=()=>perform('delete');
})();
