'use strict';
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
 const info=recordingIdentity(name,files);container.classList.add('recording-name');container.replaceChildren();
 const text=document.createElement('span');text.className='recording-name-text';text.textContent=info.display;text.title=info.original;
 const button=document.createElement('button');button.type='button';button.className='copy-recording';button.setAttribute('aria-label','로그 이름 복사');button.title=info.original+' 복사';button.disabled=!info.original;
 const icon=document.createElement('span');icon.setAttribute('aria-hidden','true');
 icon.innerHTML=COPY_ICON;
 const status=document.createElement('span');status.className='copy-announcement';status.setAttribute('role','status');
 button.append(icon,status);container.append(text,button);
 let timer;
 button.onclick=async e=>{
  e.stopPropagation();clearTimeout(timer);
  try{
   await copyTextToClipboard(info.original,button);
   icon.textContent='✓';status.textContent='복사했습니다.';button.title='복사했습니다.';
  }catch{icon.textContent='!';status.textContent='복사하지 못했습니다.';button.title='복사하지 못했습니다. 다시 시도해 주세요.'}
  timer=setTimeout(()=>{icon.innerHTML=COPY_ICON;status.textContent='';button.title=info.original+' 복사'},1800);
 };
 return text;
}
