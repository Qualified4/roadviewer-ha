'use strict';
const motionAllowed=()=>!matchMedia('(prefers-reduced-motion: reduce)').matches;
// Small spring confirmation for icon swaps (copy done, copy failed).
function popIcon(icon){if(motionAllowed())icon.animate?.([{transform:'scale(.5)',opacity:.3},{transform:'none',opacity:1}],{duration:380,easing:'cubic-bezier(.34,1.56,.64,1)'})}
const COPY_ICON='<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><rect x="8" y="8" width="12" height="12" rx="2"/><path d="M15 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h3"/></svg>';
async function copyTextToClipboard(value,button){
 try{if(!navigator.clipboard?.writeText)throw Error('Clipboard unavailable');await navigator.clipboard.writeText(value)}
 catch{
  const input=document.createElement('textarea');input.value=value;input.className='clipboard-fallback';input.readOnly=true;
  (button.closest('dialog')||document.body).append(input);
  try{input.select();if(!document.execCommand('copy'))throw Error('Copy failed')}
  finally{input.remove();button.focus({preventScroll:true})}
 }
}
function recordingIdentity(name,files={}){
 const source=(files['rlog.zst']||'').replaceAll('\\','/').split('/').pop().replace(/--rlog\.zst$/,'');
 const parse=value=>/^([^-\s]+)--([^-\s]+)--(\d+)$/.exec(value||'');
 const human=/^([^-\s]+)--([^-\s]+)\s*\/\s*구간\s*(\d+)$/.exec(name||'');
 const match=parse(source)||parse(name)||human;
 if(!match)return {display:name||'—',original:name||''};
 return {display:`${match[1].replace(/^0+(?=.)/,'')} / 구간 ${match[3].replace(/^0+(?=.)/,'')}`,original:`${match[1]}--${match[2]}--${match[3]}`};
}
function renderRecordingName(container,name,files={}){
 const info=recordingIdentity(name,files);container.classList.add('recording-name');
 // Navigation and replay data can arrive in either order: keep the moving title alive.
 const text=container.querySelector('.recording-name-text')||document.createElement('span');
 for(const child of [...container.childNodes])if(child!==text)child.remove();
 text.className='recording-name-text';if(text.textContent!==info.display)text.textContent=info.display;text.title=info.original;
 const button=document.createElement('button');button.type='button';button.className='copy-recording';button.setAttribute('aria-label','로그 이름 복사');button.title=info.original+' 복사';button.disabled=!info.original;
 const icon=document.createElement('span');icon.setAttribute('aria-hidden','true');
 icon.innerHTML=COPY_ICON;
 const status=document.createElement('span');status.className='copy-announcement';status.setAttribute('role','status');
 button.append(icon,status);if(text.parentNode!==container)container.append(text);container.append(button);
 let timer;
 button.onclick=async e=>{
  e.stopPropagation();clearTimeout(timer);
  try{
   await copyTextToClipboard(info.original,button);
   icon.textContent='✓';popIcon(icon);status.textContent='복사했습니다.';button.title='복사했습니다.';
  }catch{icon.textContent='!';popIcon(icon);status.textContent='복사하지 못했습니다.';button.title='복사하지 못했습니다. 다시 시도해 주세요.'}
  timer=setTimeout(()=>{icon.innerHTML=COPY_ICON;status.textContent='';button.title=info.original+' 복사'},1800);
 };
 return text;
}
// Download choices for one log, shared by the list menu and the replay screen.
// A single video keeps one "영상 다운로드" entry; several cameras (f, e, q) are offered one by one.
const VIDEO_SOURCE_LABELS={front:['전방 영상','f'],wide:['광각 영상','e'],qcamera:['저화질 영상','q']};
function downloadSize(bytes){
 if(!Number.isFinite(bytes))return '';
 const units=['B','KB','MB','GB'];let value=bytes,unit=0;while(value>=1024&&unit<units.length-1){value/=1024;unit++}
 return (unit?value.toFixed(value<10?1:0):value)+' '+units[unit];
}
function recordingDownloads(log,base){
 if(log.download_options){
  const open=(mode)=>e=>{e.preventDefault();document.querySelectorAll('.recording-more[open],#replayDownload[open]').forEach(el=>el.open=false);openRecordingDownload([log],base,mode)};
  return [
   {href:'#',label:'모두 받기',detail:'로그 + 모든 영상 · ZIP',onclick:open('all')},
   {href:`${base}api/logs/${log.id}/original/rlog.zst`,label:'로그 다운로드',detail:'rlog.zst'},
   ...(log.download_options.length?[
    {href:'#',label:'영상 다운로드',detail:'MP4',video:true,onclick:open('videos')},
    {href:'#',label:'원본 형식 다운로드',detail:'HEVC · TS',video:true,onclick:open('original')}
   ]:[])
  ];
 }
 const items=[{href:`${base}api/logs/${log.id}/original/rlog.zst`,label:'로그 다운로드',detail:'rlog.zst'}];
 const videos=log.video_downloads||[];
 const format=kind=>kind.endsWith('.hevc')?'HEVC':kind.endsWith('.mp4')?'MP4':'TS';
 if(videos.length>1)for(const video of videos){
  const [label,letter]=VIDEO_SOURCE_LABELS[video.source]||[video.source,'?'];
  items.push({href:`${base}api/logs/${log.id}/original/${video.kind}`,label,detail:`${letter} · ${format(video.kind)} · ${downloadSize(video.bytes)}`,video:true});
 }else if(log.video)items.push({href:`${base}api/logs/${log.id}/download/video`,label:'영상 다운로드',detail:videos[0]?`${format(videos[0].kind)} · ${downloadSize(videos[0].bytes)}`:'',video:true});
 return items;
}
function downloadLink(item){
 const link=document.createElement('a');link.className='download-original';link.href=item.href;link.setAttribute('download','');if(item.onclick)link.onclick=item.onclick;
 const label=document.createElement('span');label.textContent=item.label;link.append(label);
 // The label alone stays the accessible name; the detail is visual context.
 if(item.detail){const detail=document.createElement('small');detail.className='download-detail';detail.textContent=item.detail;detail.setAttribute('aria-hidden','true');link.append(detail)}
 return link;
}
