'use strict';
// One native modal for the compact list menu, replay menu and bulk selection.
async function openRecordingDownload(logs,base='',mode='all',selectSegments=false){
 const initialIds=new Set(logs.map(log=>log.id));
 if(selectSegments)try{const response=await fetch(`${base}api/logs`);if(response.ok){const data=await response.json();const available=data.logs.filter(log=>Array.isArray(log.download_options));logs=[...logs,...available.filter(log=>!initialIds.has(log.id))]}}catch{/* Keep the original selection available when refreshing the list fails. */}
 const dialog=document.createElement('dialog');dialog.className='rv-download-dialog'+(selectSegments?' has-segments':'');
 dialog.setAttribute('aria-label','로그 및 영상 다운로드');
 dialog.innerHTML='<div class="rv-download-head"><h2>다운로드</h2><button type="button" class="rv-download-close">닫기</button></div><p class="rv-download-context"></p><div class="rv-download-segment-heading"><label><input type="checkbox" class="rv-download-segments-all"> 전체 구간 선택</label><span class="rv-download-segment-count" role="status"></span></div><div class="rv-download-segments"><div class="rv-download-groups"></div></div><div class="rv-download-body"><span class="rv-download-label">영상 파일 형식</span><div class="rv-download-formats" role="group" aria-label="영상 파일 형식"><button type="button" data-format="mp4">MP4<small>저장된 영상 그대로</small></button><button type="button" data-format="original">원본 형식<small>f·e HEVC / q TS</small></button></div><div class="rv-download-file-heading"><span>포함할 파일</span><span><button type="button" class="rv-download-all">전체 선택</button> <button type="button" class="rv-download-clear">선택 해제</button></span></div><div class="rv-download-files"></div><p class="rv-download-notice"></p><p class="rv-download-hint">각 파일 옆의 받기로 개별 다운로드하거나, 선택한 파일을 ZIP으로 묶어 받을 수 있습니다. 없는 카메라는 제외됩니다.</p></div><div class="rv-download-footer"><span class="rv-download-total"></span><a class="rv-download-start primary" download>모두 받기</a></div><p class="rv-download-status" role="status"></p>';
 const find=selector=>dialog.querySelector(selector),files=find('.rv-download-files');
 find('.rv-download-context').textContent=logs.length===1?recordingIdentity(logs[0].name,logs[0].files).display:`선택한 ${logs.length}개 구간`;
 const segmentInputs=new Map(),groups=new Map();
 if(selectSegments){
  for(const log of logs){
   const identity=recordingIdentity(log.name,log.files),match=/^(.*)--(\d+)$/.exec(identity.original),key=match?match[1]:identity.original;
   if(!groups.has(key)){
    const group=document.createElement('details');group.className='rv-download-group';group.open=true;
    const summary=document.createElement('summary'),label=document.createElement('label'),input=document.createElement('input'),title=document.createElement('span');input.type='checkbox';input.setAttribute('aria-label',`${key} 전체 구간 선택`);title.textContent=match?identity.display.split(' / ')[0]:identity.display;title.title=key;label.append(input,title);summary.append(label);group.append(summary);find('.rv-download-groups').append(group);label.onclick=event=>event.stopPropagation();input.onchange=()=>{for(const item of groups.get(key).inputs)item.checked=input.checked;update()};groups.set(key,{group,input,inputs:[]});
   }
   const group=groups.get(key),label=document.createElement('label'),input=document.createElement('input'),text=document.createElement('span'),title=document.createElement('b'),detail=document.createElement('small');
   label.className='rv-download-segment';input.type='checkbox';input.checked=initialIds.has(log.id);input.setAttribute('aria-label',identity.display);title.textContent=match?`구간 ${Number(match[2])}`:identity.display;detail.textContent=['로그',...log.download_options.map(option=>({front:'전방',wide:'와이드',qcamera:'저화질'})[option.source]||option.source)].join(' · ');text.append(title,detail);label.append(input,text);group.group.append(label);group.inputs.push(input);segmentInputs.set(log.id,input);input.onchange=update;
  }
  find('.rv-download-segments-all').onchange=event=>{for(const input of segmentInputs.values())input.checked=event.target.checked;update()};
 }else{find('.rv-download-segment-heading').remove();find('.rv-download-segments').remove()}
 let format=mode==='original'?'original':'mp4';
 const definitions=[['rlog','주행 로그','rlog.zst','rlog.zst'],['front','전방 영상','fcamera.mp4','fcamera.hevc'],['wide','와이드 영상','ecamera.mp4','ecamera.hevc'],['qcamera','저화질 영상','qcamera.mp4','qcamera.ts']];
 const rows=definitions.map(([key,label,mp4,original])=>{
  const options=logs.flatMap(log=>{const option=key==='rlog'?{mp4:true,original:true,bytes:log.log_bytes||0}:log.download_options.find(row=>row.source===key);return option?[{...option,log}]:[]});
  if(!options.length)return null;
  const row=document.createElement('div');row.className='rv-download-file';
  const select=document.createElement('label');select.className='rv-download-select';
  const input=document.createElement('input');input.type='checkbox';input.checked=mode==='all'||(mode==='log'?key==='rlog':key!=='rlog');
  const text=document.createElement('span'),title=document.createElement('b'),detail=document.createElement('small');title.textContent=label;text.append(title,detail);
  select.append(input,text);row.append(select);files.append(row);input.onchange=update;
  const individual=document.createElement(options.length>1?'details':'span');individual.className='rv-download-individual';
  if(options.length>1){const summary=document.createElement('summary');summary.textContent=`개별 받기 · ${options.length}개`;individual.append(summary)}
  for(const option of options){const link=document.createElement('a');link.className='rv-download-one';link.setAttribute('download','');link.textContent=options.length>1?recordingIdentity(option.log.name,option.log.files).display:'받기';link.setAttribute('aria-label',`${label} · ${recordingIdentity(option.log.name,option.log.files).display} 받기`);option.link=link;individual.append(link)}row.append(individual);
  return {key,input,detail,mp4,original,options};
 }).filter(Boolean);
 function update(){
  const chosen=selectSegments?logs.filter(log=>segmentInputs.get(log.id).checked):logs,ids=new Set(chosen.map(log=>log.id));
  find('.rv-download-context').textContent=chosen.length===1?recordingIdentity(chosen[0].name,chosen[0].files).display:`선택한 ${chosen.length}개 구간`;
  if(selectSegments){
  const allSegments=find('.rv-download-segments-all');allSegments.checked=chosen.length===logs.length;allSegments.indeterminate=chosen.length>0&&chosen.length<logs.length;
  find('.rv-download-segment-count').textContent=`선택 ${chosen.length}개 / 최대 150개`;
  for(const group of groups.values()){const count=group.inputs.filter(input=>input.checked).length;group.input.checked=count===group.inputs.length;group.input.indeterminate=count>0&&count<group.inputs.length}
  }
  for(const row of rows){
   row.active=row.options.filter(option=>ids.has(option.log.id)&&option[format]);
   row.input.disabled=!row.active.length;
   const individual=row.options[0].link.parentElement,summary=individual.querySelector('summary'),available=row.options.filter(option=>ids.has(option.log.id));individual.hidden=!available.length;if(summary){summary.textContent=`개별 받기 · ${available.length}개`;summary.hidden=available.length<2;if(available.length===1)individual.open=true}
   row.detail.textContent=(format==='mp4'?row.mp4:row.original)+(row.input.disabled?' · 준비된 파일 없음':'');
   for(const option of row.options){option.link.hidden=!ids.has(option.log.id);if(option[format]){option.link.href=`${base}api/logs/${option.log.id}/download?${new URLSearchParams({format,source:row.key})}`;option.link.removeAttribute('aria-disabled')}else{option.link.removeAttribute('href');option.link.setAttribute('aria-disabled','true')}}
  }
  for(const button of dialog.querySelectorAll('[data-format]'))button.setAttribute('aria-pressed',String(button.dataset.format===format));
  find('.rv-download-notice').textContent=format==='mp4'?'재압축하지 않은 보관 MP4를 받습니다.':'영상은 재압축 없이 원본 형식으로 만듭니다. 화질은 같지만 업로드한 파일과 바이트까지 동일하지는 않습니다.';
  const selected=rows.filter(row=>row.input.checked&&!row.input.disabled),count=selected.reduce((n,row)=>n+row.active.length,0),bytes=selected.reduce((n,row)=>n+row.active.reduce((sum,v)=>sum+(v.bytes||0),0),0),link=find('.rv-download-start');
  find('.rv-download-total').textContent=`${count}개 파일 · 약 ${downloadSize(bytes)}`;
  const all=selected.length===rows.length,zip=count>1;
  link.textContent=zip?(all?'모두 받기 · ZIP':'선택 파일 받기 · ZIP'):'파일 받기';
  if(!count||chosen.length>150){link.removeAttribute('href');link.setAttribute('aria-disabled','true');return}
  link.removeAttribute('aria-disabled');
  const params=new URLSearchParams({format});
  if(zip){params.set('ids',chosen.map(log=>log.id).join(','));params.set('parts',selected.map(row=>row.key).join(','));link.href=`${base}api/logs/download.zip?${params}`}
  else{const row=selected[0],log=row.active[0].log;params.set('source',row.key);link.href=`${base}api/logs/${log.id}/download?${params}`}
 }
 dialog.querySelectorAll('[data-format]').forEach(button=>button.onclick=()=>{format=button.dataset.format;update()});
 find('.rv-download-all').onclick=()=>{rows.forEach(row=>row.input.checked=true);update()};
 find('.rv-download-clear').onclick=()=>{rows.forEach(row=>row.input.checked=false);update()};
 find('.rv-download-close').onclick=()=>dialog.close();
 find('.rv-download-start').onclick=event=>{if(!event.currentTarget.hasAttribute('href')){event.preventDefault();return}find('.rv-download-status').textContent='다운로드를 시작합니다. 원본 형식은 파일을 준비하는 동안 잠시 기다려 주세요.'};
 const overflow=document.body.style.overflow,focus=document.activeElement;
 const headerSize=selectSegments?new ResizeObserver(()=>dialog.style.setProperty('--download-head-height',`${find('.rv-download-head').offsetHeight}px`)):null;
 dialog.addEventListener('close',()=>{headerSize?.disconnect();document.body.style.overflow=overflow;dialog.remove();focus?.focus({preventScroll:true})},{once:true});
 document.body.append(dialog);document.body.style.overflow='hidden';update();dialog.showModal();headerSize?.observe(find('.rv-download-head'));
}
