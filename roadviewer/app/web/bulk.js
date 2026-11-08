'use strict';
(()=>{
 const panel=$('panel-logs'),list=$('list'),dock=$('bulkDock'),bar=$('bulkBar'),all=$('bulkAll'),convert=$('bulkConvert'),remove=$('bulkRemove'),del=$('bulkDelete'),close=$('bulkClose'),includePinned=$('bulkIncludePinned'),download=$('bulkDownload'),downloadMenu=$('bulkDownloadMenu');
 const selected=new Set();let active=false,running=false,returnFocus=null,press=null,suppressClick=null,resultMessage='';
 const rows=()=>[...logRows.values()].filter(row=>row.row.isConnected),chosen=()=>rows().filter(row=>selected.has(row.log.id)),visible=()=>rows().filter(row=>!row.row.hidden);
 function setText(element,text){if(element.textContent!==text)element.textContent=text}
 function checkbox(className,name,value,onchange){
  const label=document.createElement('label'),input=document.createElement('input'),text=document.createElement('span');label.className=className;input.type='checkbox';input.value=value;input.onchange=onchange;text.className='selection-sr';text.textContent=name;label.append(input,text);return {label,input,text};
 }
 function sync(){
  const current=rows(),ids=new Set(current.map(row=>row.log.id));for(const id of selected)if(!ids.has(id))selected.delete(id);
  const picked=chosen(),shown=visible(),shownCount=shown.filter(row=>selected.has(row.log.id)).length,pinned=picked.filter(row=>row.log.pinned).length,hidden=picked.length-shownCount;
  all.checked=shown.length>0&&shownCount===shown.length;all.indeterminate=shownCount>0&&shownCount<shown.length;all.disabled=running||!shown.length;
  for(const row of current){
   if(active&&!row.selection){row.selection=checkbox('segment-select',`${recordingIdentity(row.log.name,row.log.files).display} 선택`,row.log.id,()=>{if(running)return;toggle([row.log.id],row.selection.input.checked)});row.row.prepend(row.selection.label)}
   // renderRow replaces its cache object, but keeps the row node and its selection label connected.
   if(active&&!row.selection?.label.isConnected){row.selection.label.remove();row.row.prepend(row.selection.label)}
   if(active){
    const existing=row.row.querySelectorAll('.segment-select');for(const label of existing)if(label!==row.selection.label)label.remove();
    row.selection.input.checked=selected.has(row.log.id);row.selection.input.disabled=running;
   }
   row.row.classList.toggle('is-selected',active&&selected.has(row.log.id));
  }
  for(const group of logGroups.values()){
   if(active&&!group.selection){
    group.selection=checkbox('route-select',`${group.route.segment===null?'기타 로그':group.route.key} 전체 구간 선택`,group.route.key,()=>{if(!running)toggle(group.logs.map(log=>log.id),group.selection.input.checked)});
    group.element.querySelector(':scope>summary').prepend(group.selection.label);
    group.selectionCount=document.createElement('small');group.selectionCount.className='route-selection-count';group.count.after(group.selectionCount);
   }
   const count=group.logs.filter(log=>selected.has(log.id)).length;
   if(group.selection){group.selection.input.checked=count===group.logs.length&&count>0;group.selection.input.indeterminate=count>0&&count<group.logs.length;group.selection.input.disabled=running;setText(group.selectionCount,`${count} / ${group.logs.length}개 구간`)}
   group.element.classList.toggle('has-selection',active&&count>0);
  }
  setText($('bulkCount'),`${picked.length}개 구간 선택${pinned?` · 고정 ${pinned}`:''}${hidden?` · 필터로 숨김 ${hidden}개`:''}`);
  $('bulkTags').disabled=download.disabled=$('bulkExport').disabled=running||!picked.length;
  convert.disabled=running||!picked.some(row=>!['ready','queued','processing'].includes(row.log.status));
  const targets=picked.filter(row=>includePinned.checked||!row.log.pinned),blocked=!running&&!includePinned.checked&&picked.length>0&&pinned===picked.length;
  remove.disabled=running||!targets.some(row=>row.log.status!=='processing');del.disabled=running||!targets.length;
  includePinned.disabled=running;includePinned.closest('.bulk-pin-option').classList.toggle('needs-pinned',blocked);
  setText($('bulkPinHint'),includePinned.checked?'선택한 고정 로그도 제거·완전 삭제에 포함됩니다.':blocked?`선택한 ${picked.length}개가 모두 고정 로그입니다. 제거·완전 삭제하려면 켜세요.`:'고정된 로그는 제거·완전 삭제에서 보호합니다.');
  close.disabled=$('bulkMore').disabled=running;
  for(const group of logGroups.values())group.element.querySelector('.log-route-chevron').disabled=running;
  $('bulkOpen').disabled=running;$('bulkOpen').setAttribute('aria-pressed',String(active));$('bulkOpen').textContent=active?'선택 중':'선택';
  const message=resultMessage||(active&&!current.length?'저장된 로그가 없습니다.':'');setText($('bulkStatus'),message);$('bulkFeedback').hidden=!message;
  bar.setAttribute('aria-busy',String(running));panel.classList.toggle('selection-running',running);
  if(download.disabled)closeDownloads();
 }
 function toggle(ids,checked){for(const id of ids)if(checked)selected.add(id);else selected.delete(id);sync()}
 function feedback(text){resultMessage=text;setText($('bulkStatus'),text);$('bulkFeedback').hidden=!text;if(text)dock.hidden=false}
 function clearFailures(){$('bulkFailures').hidden=true;$('bulkFailures').replaceChildren()}
 function enter(target=null){
  if(active)return;active=true;selected.clear();includePinned.checked=false;returnFocus=target||$('bulkOpen');panel.classList.add('selection-mode');bar.hidden=false;dock.hidden=false;clearFailures();
  $('bulkExtra').classList.remove('is-expanded');$('bulkMore').setAttribute('aria-expanded','false');document.querySelectorAll('.recording-more[open]').forEach(menu=>menu.open=false);
  resultMessage='';sync();
  if(target){const row=target.closest('.log-row'),group=target.closest('.log-route');toggle(row?[row.dataset.id]:logGroups.get(group?.dataset.route)?.logs.map(log=>log.id)||[],true)}
  const focus=target?.closest('.log-row')?.querySelector('.segment-select input')||target?.closest('.log-route')?.querySelector('.route-select input')||all;
  (focus.disabled?close:focus).focus({preventScroll:true});
 }
 function exit({keepResult=false}={}){
  if(!active||running)return;active=false;selected.clear();closeDownloads();bar.hidden=true;panel.classList.remove('selection-mode');sync();
  if(!keepResult){resultMessage='';dock.hidden=true;$('bulkFeedback').hidden=true;clearFailures()}
  const target=returnFocus?.isConnected&&!returnFocus.closest('[hidden]')?returnFocus:$('bulkOpen');
  // Row/card entries have a summary focus target; the header button is always a safe fallback.
  (target.matches('button,input')?target:target.closest('.log-route')?.querySelector(':scope>summary')||$('bulkOpen')).focus({preventScroll:true});
 }
 $('bulkOpen').onclick=()=>active?exit():enter();close.onclick=()=>exit();includePinned.onchange=sync;
 all.onchange=()=>{if(!running)toggle(visible().map(row=>row.log.id),all.checked)};
 $('bulkMore').onclick=()=>{$('bulkMore').setAttribute('aria-expanded',String($('bulkExtra').classList.toggle('is-expanded')))};
 $('bulkDismiss').onclick=()=>{resultMessage='';dock.hidden=true;$('bulkFeedback').hidden=true;clearFailures()};
 const reserve=()=>panel.style.setProperty('--bulk-space',dock.hidden?'0px':`${dock.getBoundingClientRect().height+24}px`);
 new ResizeObserver(reserve).observe(dock);
 new MutationObserver(reserve).observe(dock,{attributes:true,attributeFilter:['hidden']});
 bulkSelection={get active(){return active},get running(){return running},sync};
 // Real checkbox labels handle their native click; the rest of a row/card toggles the same selection.
 list.addEventListener('click',event=>{
  if(suppressClick){const target=suppressClick;suppressClick=null;if(target.contains(event.target)){event.preventDefault();event.stopImmediatePropagation();return}}
  if(!active)return;
  const row=event.target.closest('.log-row'),summary=event.target.closest('.log-route>summary');if(!row&&!summary)return;
  if(event.target.closest('.segment-select,.route-select')){if(running){event.preventDefault();event.stopImmediatePropagation()}return}
  if(event.target.closest('.log-route-chevron')&&!running)return;
  event.preventDefault();event.stopImmediatePropagation();if(running)return;
  const ids=row?[row.dataset.id]:logGroups.get(summary.parentElement.dataset.route).logs.map(log=>log.id);toggle(ids,!ids.every(id=>selected.has(id)));
 },true);
 function cancelPress(){if(press)clearTimeout(press.timer);press=null}
 list.addEventListener('pointerdown',event=>{
  cancelPress();suppressClick=null;if(active||event.pointerType!=='touch'||!event.isPrimary||event.target.closest('a,button,input,label,.recording-more'))return;
  const target=event.target.closest('.log-row,.log-route>summary');if(!target)return;
  press={id:event.pointerId,x:event.clientX,y:event.clientY,timer:setTimeout(()=>{press=null;suppressClick=target;enter(target)},500)};
 });
 list.addEventListener('pointermove',event=>{if(press&&(Math.hypot(event.clientX-press.x,event.clientY-press.y)>8))cancelPress()});
 list.addEventListener('pointerup',cancelPress);list.addEventListener('pointercancel',cancelPress);window.addEventListener('blur',cancelPress);window.addEventListener('scroll',cancelPress,true);
 list.addEventListener('contextmenu',event=>{if(press||active){event.preventDefault()}});
 // Selected segments as one ZIP (server streams it): logs, optionally with one file per camera.
 const DOWNLOAD_CHOICES=[['rlog','로그만','rlog.zst'],['rlog,qcamera','로그 + 저화질 영상','rlog · qcamera'],['rlog,front,wide,qcamera','로그 + 모든 영상','rlog · 전방 · 와이드 · 저화질']];
 function closeDownloads(){downloadMenu.hidden=true;download.setAttribute('aria-expanded','false')}
 function openDownloads(){
  const logs=chosen().map(row=>row.log);if(!logs.length||running)return;
  if(logs.length<=150&&logs.every(log=>log.download_options)){closeDownloads();openRecordingDownload(logs,'','all');return}
  const ids=logs.map(log=>log.id).join(','),size=parts=>logs.reduce((sum,log)=>sum+(parts.includes('rlog')?log.log_bytes||0:0)+(log.video_downloads||[]).filter(v=>parts.includes(v.source)).reduce((a,v)=>a+v.bytes,0),0);
  const title=document.createElement('p');title.textContent=`선택한 ${logs.length}개 구간 · ZIP 하나`;let previous=-1;const items=[];
  for(const [parts,label,detail] of DOWNLOAD_CHOICES){
   const bytes=size(parts.split(','));if(!bytes||bytes===previous)continue;previous=bytes;
   const link=document.createElement('a');link.role='menuitem';link.href=`api/logs/download.zip?ids=${ids}&parts=${parts}`;link.download='';
   const name=document.createElement('span');name.textContent=label;const small=document.createElement('small');small.textContent=`${detail} · 약 ${storageSize(bytes)}`;
   link.append(name,small);link.onclick=()=>{closeDownloads();feedback(`${logs.length}개 구간 다운로드를 시작했습니다. 받는 동안 이 화면을 닫아도 됩니다.`)};items.push(link);
  }
  if(!items.length){const none=document.createElement('p');none.textContent='받을 수 있는 파일이 없습니다.';items.push(none)}
  if(logs.length>150||ids.length>6000){items.length=0;const many=document.createElement('p');many.textContent='한 번에 150개 구간까지 받을 수 있습니다. 선택을 나눠 주세요.';items.push(many)}
  downloadMenu.replaceChildren(title,...items);downloadMenu.hidden=false;download.setAttribute('aria-expanded','true');downloadMenu.querySelector('a')?.focus({preventScroll:true});
 }
 download.onclick=()=>downloadMenu.hidden?openDownloads():closeDownloads();
 document.addEventListener('keydown',event=>{
  if(event.key!=='Escape'||!active||panel.hidden||document.querySelector('dialog[open]'))return;
  event.preventDefault();event.stopImmediatePropagation();if(running)return;
  if(!downloadMenu.hidden){closeDownloads();download.focus({preventScroll:true});return}
  if($('bulkExtra').classList.contains('is-expanded')){$('bulkMore').click();$('bulkMore').focus({preventScroll:true});return}
  exit();
 },true);
 document.addEventListener('pointerdown',event=>{if(!downloadMenu.hidden&&!event.target.closest('.bulk-download'))closeDownloads();if(!event.target.closest('#bulkExtra,#bulkMore')){$('bulkExtra').classList.remove('is-expanded');$('bulkMore').setAttribute('aria-expanded','false')}});
 async function perform(action){
  const complete=action==='delete',converting=action==='convert';if(running||!active)return;
  const picked=chosen();if(!picked.length)return;
  const protectPinned=!includePinned.checked,protectedCount=converting||!protectPinned?0:picked.filter(row=>row.log.pinned).length,targetCount=picked.length-protectedCount;if(!targetCount)return;
  const protection=protectedCount?`고정된 ${protectedCount}개는 제외합니다. `:!protectPinned?'고정된 항목도 삭제 대상에 포함합니다. ':'';
  const message=protection+(complete?`선택한 ${targetCount}개 로그의 원본·영상·변환 데이터를 완전히 삭제할까요? 되돌릴 수 없습니다.`:`선택한 ${targetCount}개 로그의 변환 데이터를 제거할까요? 원본 로그와 보관 영상은 유지합니다. 대기 중인 변환은 취소하고 처리 중인 항목만 제외하며 자동 재변환하지 않습니다.`);
  if(!converting&&!confirm(message))return;
  listRequest?.abort();listRevision++;refreshing=false;running=true;closeDownloads();$('bulkExtra').classList.remove('is-expanded');$('bulkMore').setAttribute('aria-expanded','false');sync();clearFailures();let succeeded=0,skipped=0;const failures=[];
  try{
   for(const [index,row] of picked.entries()){
    feedback(`${index+1} / ${picked.length}개 처리 중…`);
    if(!converting&&protectPinned&&row.log.pinned){skipped++;selected.delete(row.log.id);sync();continue}
    if(converting&&['ready','queued','processing'].includes(row.log.status)){skipped++;selected.delete(row.log.id);sync();continue}
    try{
     const result=await api(`api/logs/${row.log.id}${converting?'/convert':complete?'':'/prepared'}${converting||!protectPinned?'':'?skip_pinned=1'}`,{method:converting?'POST':'DELETE'});
     if(result.skipped==='pinned'){skipped++;row.log.pinned=true;selected.delete(row.log.id);recordingChanged(row.log);sync();continue}
     if(converting&&result.status!=='queued')skipped++;else succeeded++;selected.delete(row.log.id);
     if(complete){row.row.remove();logRows.delete(row.log.id)}
     else if(converting){row.log={...row.log,status:result.status};recordingChanged(row.log)}
     else{row.log={...row.log,status:'unconverted',prepared_bytes:0,auto_excluded:true};recordingChanged(row.log)}
    }catch(e){failures.push(`${row.log.name}: ${e.message}`)}
    sync();
   }
   feedback(`${converting?'변환 요청':complete?'완전 삭제':'변환 데이터 제거'} ${succeeded}개 완료${skipped?` · 건너뜀 ${skipped}개`:''}${failures.length?` · 미완료 ${failures.length}개 (선택 유지)`:''}`);
   if(failures.length){for(const message of failures){const line=document.createElement('p');line.textContent=message;$('bulkFailures').append(line)}$('bulkFailures').hidden=false}
  }finally{
   running=false;sync();if(!converting&&!failures.length)exit({keepResult:true});await refresh();
  }
 }
 // Selected segments as one export .tar (log-transfer.js); every segment selected exports the whole list.
 $('bulkExport').onclick=()=>{
  const logs=chosen().map(row=>row.log);if(!logs.length||running)return;
  $('bulkExtra').classList.remove('is-expanded');$('bulkMore').setAttribute('aria-expanded','false');
  const all=logs.length===rows().length;
  if(!all&&logs.length>150){feedback('한 번에 150개 구간까지 내보낼 수 있습니다. 전체를 선택하거나 선택을 나눠 주세요.');return}
  downloadExport(all?null:logs.map(log=>log.id));feedback(`${logs.length}개 구간 내보내기를 시작했습니다. 받는 동안 이 화면을 닫아도 됩니다.`);
 };
 $('bulkTags').onclick=()=>editRecordingTags(chosen().map(row=>row.log),changes=>{for(const change of changes){const row=logRows.get(change.id);if(row)recordingChanged({...row.log,tags:change.tags})}void refresh()},true);
 convert.onclick=()=>perform('convert');remove.onclick=()=>perform('remove');del.onclick=()=>perform('delete');
})();
