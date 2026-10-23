'use strict';
// One native modal for the compact list menu, replay menu and bulk selection.
function openRecordingDownload(logs,base='',mode='all'){
 if(logs.length>150){alert('한 번에 150개 구간까지 받을 수 있습니다. 선택을 나눠 주세요.');return}
 const dialog=document.createElement('dialog');dialog.className='rv-download-dialog';
 dialog.setAttribute('aria-label','로그 및 영상 다운로드');
 dialog.innerHTML='<div class="rv-download-head"><h2>다운로드</h2><button type="button" class="rv-download-close">닫기</button></div><p class="rv-download-context"></p><div class="rv-download-body"><span class="rv-download-label">영상 파일 형식</span><div class="rv-download-formats" role="group" aria-label="영상 파일 형식"><button type="button" data-format="mp4">MP4<small>저장된 영상 그대로</small></button><button type="button" data-format="original">원본 형식<small>f·e HEVC / q TS</small></button></div><div class="rv-download-file-heading"><span>포함할 파일</span><button type="button" class="rv-download-all">전체 선택</button></div><div class="rv-download-files"></div><p class="rv-download-notice"></p><p class="rv-download-hint">없는 카메라는 제외됩니다. 여러 파일은 ZIP 하나로 받습니다.</p></div><div class="rv-download-footer"><span class="rv-download-total"></span><a class="rv-download-start primary" download>모두 받기</a></div><p class="rv-download-status" role="status"></p>';
 const find=selector=>dialog.querySelector(selector),files=find('.rv-download-files');
 find('.rv-download-context').textContent=logs.length===1?recordingIdentity(logs[0].name,logs[0].files).display:`선택한 ${logs.length}개 구간`;
 let format=mode==='original'?'original':'mp4';
 const definitions=[['rlog','주행 로그','rlog.zst','rlog.zst'],['front','전방 영상','fcamera.mp4','fcamera.hevc'],['wide','와이드 영상','ecamera.mp4','ecamera.hevc'],['qcamera','저화질 영상','qcamera.mp4','qcamera.ts']];
 const rows=definitions.map(([key,label,mp4,original])=>{
  const options=logs.map(log=>key==='rlog'?{mp4:true,original:true,bytes:log.log_bytes||0}:log.download_options.find(row=>row.source===key)).filter(Boolean);
  if(!options.length)return null;
  const row=document.createElement('label');row.className='rv-download-file';
  const input=document.createElement('input');input.type='checkbox';input.checked=mode==='all'||(mode==='log'?key==='rlog':key!=='rlog');
  const text=document.createElement('span'),title=document.createElement('b'),detail=document.createElement('small');title.textContent=label;text.append(title,detail);
  row.append(input,text);files.append(row);input.onchange=update;
  return {key,input,detail,mp4,original,options};
 }).filter(Boolean);
 function update(){
  for(const row of rows){
   row.input.disabled=row.options.some(option=>!option[format]);
   row.detail.textContent=(format==='mp4'?row.mp4:row.original)+(row.input.disabled?' · 준비된 파일 없음':'');
  }
  for(const button of dialog.querySelectorAll('[data-format]'))button.setAttribute('aria-pressed',String(button.dataset.format===format));
  find('.rv-download-notice').textContent=format==='mp4'?'재압축하지 않은 보관 MP4를 받습니다.':'영상은 재압축 없이 원본 형식으로 만듭니다. 화질은 같지만 업로드한 파일과 바이트까지 동일하지는 않습니다.';
  const selected=rows.filter(row=>row.input.checked&&!row.input.disabled),count=selected.reduce((n,row)=>n+row.options.length,0),bytes=selected.reduce((n,row)=>n+row.options.reduce((sum,v)=>sum+v.bytes,0),0),link=find('.rv-download-start');
  find('.rv-download-total').textContent=`${count}개 파일 · 약 ${downloadSize(bytes)}`;
  const all=selected.length===rows.length,zip=count>1||all;
  link.textContent=all?'모두 받기 · ZIP':zip?'선택 파일 받기 · ZIP':'파일 받기';
  if(!count){link.removeAttribute('href');link.setAttribute('aria-disabled','true');return}
  link.removeAttribute('aria-disabled');
  const params=new URLSearchParams({format});
  if(zip){params.set('ids',logs.map(log=>log.id).join(','));params.set('parts',selected.map(row=>row.key).join(','));link.href=`${base}api/logs/download.zip?${params}`}
  else{const row=selected[0],log=logs.find(log=>row.key==='rlog'||log.download_options.some(v=>v.source===row.key));params.set('source',row.key);link.href=`${base}api/logs/${log.id}/download?${params}`}
 }
 dialog.querySelectorAll('[data-format]').forEach(button=>button.onclick=()=>{format=button.dataset.format;update()});
 find('.rv-download-all').onclick=()=>{rows.forEach(row=>row.input.checked=true);update()};
 find('.rv-download-close').onclick=()=>dialog.close();
 find('.rv-download-start').onclick=event=>{if(!event.currentTarget.hasAttribute('href')){event.preventDefault();return}find('.rv-download-status').textContent='다운로드를 시작합니다. 원본 형식은 파일을 준비하는 동안 잠시 기다려 주세요.'};
 const overflow=document.body.style.overflow,focus=document.activeElement;
 dialog.addEventListener('close',()=>{document.body.style.overflow=overflow;dialog.remove();focus?.focus({preventScroll:true})},{once:true});
 document.body.append(dialog);document.body.style.overflow='hidden';update();dialog.showModal();
}
