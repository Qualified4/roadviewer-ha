'use strict';
(()=>{
 const dialog=$('bulkDialog'),list=$('bulkList'),all=$('bulkAll'),remove=$('bulkRemove'),del=$('bulkDelete'),close=$('bulkClose');
 let rows=[],running=false,loading=false,oldOverflow='',loadRevision=0;
 function sync(){
  const selected=rows.filter(row=>row.input.checked);
  all.checked=rows.length>0&&selected.length===rows.length;all.indeterminate=selected.length>0&&selected.length<rows.length;
  all.disabled=loading||running||!rows.length;
  for(const row of rows)row.input.disabled=running;
  $('bulkCount').textContent=`${selected.length} / ${rows.length}개 선택`;
  remove.disabled=del.disabled=loading||running||!selected.length;
  close.disabled=running;
 }
 function addRow(log){
  const label=document.createElement('label');label.className='bulk-log';
  const input=document.createElement('input');input.type='checkbox';input.value=log.id;input.onchange=sync;
  const info=document.createElement('span'),title=document.createElement('span'),detail=document.createElement('small');
  title.textContent=log.name;info.append(title,detail);label.append(input,info);
  const row={log,input,label,detail};updateRow(row);list.append(label);return row;
 }
 function updateRow(row){row.detail.textContent=`${names[row.log.status]||row.log.status} · 보관 파일 ${storageSize(row.log.bytes)} · 변환 ${storageSize(row.log.prepared_bytes)}`}
 $('bulkOpen').onclick=async()=>{
  if(dialog.open)return;
  const revision=++loadRevision;rows=[];list.replaceChildren();loading=true;sync();$('bulkFailures').hidden=true;$('bulkFailures').replaceChildren();
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
 all.onchange=()=>{for(const row of rows)row.input.checked=all.checked;sync()};
 close.onclick=()=>dialog.close();
 dialog.addEventListener('cancel',e=>{if(running)e.preventDefault()});
 dialog.addEventListener('close',()=>{loadRevision++;document.body.style.overflow=oldOverflow;$('bulkOpen').focus({preventScroll:true});void refresh()});
 async function perform(complete){
  if(running||loading)return;
  const selected=rows.filter(row=>row.input.checked);if(!selected.length)return;
  const message=complete?`선택한 ${selected.length}개 로그의 원본·영상·변환 데이터를 완전히 삭제할까요? 되돌릴 수 없습니다.`:`선택한 ${selected.length}개 로그의 변환 데이터를 제거할까요? 보관 로그·TS와 유일한 MP4는 유지합니다. 대기·처리 중인 항목은 제외하며 자동 재변환하지 않습니다.`;
  if(!confirm(message))return;
  running=true;sync();let succeeded=0;const failures=[];
  $('bulkFailures').hidden=true;$('bulkFailures').replaceChildren();
  try{
   for(const [index,row] of selected.entries()){
    $('bulkStatus').textContent=`${index+1} / ${selected.length}개 처리 중…`;
    try{
     await api(`api/logs/${row.log.id}${complete?'':'/prepared'}`,{method:'DELETE'});
     succeeded++;row.input.checked=false;logRows.delete(row.log.id);
     if(complete){row.label.remove();rows=rows.filter(item=>item!==row)}
     else{row.log={...row.log,status:'unconverted',prepared_bytes:0};updateRow(row)}
    }catch(e){failures.push(`${row.log.name}: ${e.message}`)}
    sync();
   }
   $('bulkStatus').textContent=`${complete?'완전 삭제':'변환 데이터 제거'} ${succeeded}개 완료${failures.length?` · 미완료 ${failures.length}개 (선택 유지)`:''}`;
   if(failures.length){
    for(const message of failures){const line=document.createElement('p');line.textContent=message;$('bulkFailures').append(line)}
    $('bulkFailures').hidden=false;
   }
  }finally{running=false;sync();void refresh()}
 }
 remove.onclick=()=>perform(false);del.onclick=()=>perform(true);
})();
