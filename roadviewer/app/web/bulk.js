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
  convert.disabled=remove.disabled=del.disabled=loading||running||!selected.length;
  remove.disabled=del.disabled=remove.disabled||(!includePinned.checked&&pinned===selected.length);
  includePinned.disabled=loading||running;
  $('bulkPinHint').textContent=includePinned.checked?'선택한 고정 로그도 제거·완전 삭제에 포함됩니다.':'고정된 로그는 제거·완전 삭제에서 보호합니다.';
  close.disabled=running;
 }
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
   rows=data.logs.map(addRow);
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
  const message=protection+(complete?`선택한 ${targetCount}개 로그의 원본·영상·변환 데이터를 완전히 삭제할까요? 되돌릴 수 없습니다.`:`선택한 ${targetCount}개 로그의 변환 데이터를 제거할까요? 보관 로그·TS와 유일한 MP4는 유지합니다. 대기·처리 중인 항목은 제외하며 자동 재변환하지 않습니다.`);
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
     if(converting&&result.status!=='queued')skipped++;else succeeded++;row.input.checked=false;logRows.delete(row.log.id);
     if(complete){row.label.remove();rows=rows.filter(item=>item!==row)}
     else if(converting){row.log={...row.log,status:result.status};updateRow(row)}
     else{row.log={...row.log,status:'unconverted',prepared_bytes:0};updateRow(row)}
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
 convert.onclick=()=>perform('convert');remove.onclick=()=>perform('remove');del.onclick=()=>perform('delete');
})();
