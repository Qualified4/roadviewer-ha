'use strict';
const RECORDING_TAG_ICON='<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 3h8l10 10-8 8L3 11z"/><circle cx="7.5" cy="7.5" r="1"/></svg>';
const TAG_PALETTE={mint:'민트',blue:'파랑',violet:'보라',amber:'주황',rose:'분홍',slate:'회색',red:'빨강',coral:'산호',lime:'라임',yellow:'노랑',cyan:'하늘',indigo:'남색'};
let recordingTagCatalog=[];
const tagKey=name=>name.normalize('NFC').trim().replace(/\s+/gu,' ').toLowerCase();
function updateTagCatalog(logs){
 const tags=new Map();for(const log of logs)for(const tag of log.tags||[])if(!tags.has(tagKey(tag.name)))tags.set(tagKey(tag.name),tag);
 recordingTagCatalog=[...tags.values()].sort((a,b)=>a.name.localeCompare(b.name,'ko'));
}
function recordingTagBadges(tags=[],limit=4){
 const group=document.createElement('span');group.className='recording-tags';group.hidden=!tags.length;
 for(const tag of tags.slice(0,limit)){
  const badge=document.createElement('span');badge.className='recording-tag';badge.dataset.color=Object.hasOwn(TAG_PALETTE,tag.color)?tag.color:'mint';badge.textContent=tag.name;badge.title=tag.name;group.append(badge);
 }
 if(tags.length>limit){
  const more=document.createElement('button');more.type='button';more.className='tag-overflow';more.dataset.noRipple='';more.textContent=(limit?'+':'')+(tags.length-limit);more.title=tags.slice(limit).map(tag=>tag.name).join(', ');
  more.setAttribute('aria-label',`태그 ${tags.length}개 모두 보기`);more.setAttribute('aria-haspopup','dialog');more.setAttribute('aria-expanded','false');
  // Inside a card header or a row: the press shows the tags and does nothing else (no fold, no playback).
  more.addEventListener('click',event=>{event.preventDefault();event.stopPropagation();toggleTagPopover(more,tags)});group.append(more);
 }
 return group;
}
// +N: every tag of the log (or route) in a small popup beside the button. It opens downwards, or upwards when it does
// not fit above the bottom tabs; a press outside, Escape, scrolling or resizing closes it. The list replaces its tag
// chips on every poll, so the popup stands on its own once shown.
let tagPopover=null,tagTouch=false;
function closeTagPopover(focus=false){
 if(!tagPopover)return;const {pop,button}=tagPopover;tagPopover=null;pop.remove();
 if(button.isConnected){button.setAttribute('aria-expanded','false');if(focus)button.focus({preventScroll:true})}
}
function toggleTagPopover(button,tags){
 const same=tagPopover?.button===button;closeTagPopover();if(same)return;
 const pop=document.createElement('div');pop.className='tag-popover';pop.setAttribute('role','dialog');pop.setAttribute('aria-label','모든 태그');
 for(const tag of tags){const badge=document.createElement('span');badge.className='recording-tag';badge.dataset.color=Object.hasOwn(TAG_PALETTE,tag.color)?tag.color:'mint';badge.textContent=tag.name;pop.append(badge)}
 (button.closest('.lib-panel')||document.body).append(pop);
 const anchor=button.getBoundingClientRect(),width=pop.offsetWidth,height=pop.offsetHeight,margin=8,view=document.documentElement.clientWidth;
 const tabs=document.querySelector('.lib-tabs'),bar=document.querySelector('.lib-appbar,.app-bar');
 const floor=(tabs&&getComputedStyle(tabs).position==='fixed'?tabs.getBoundingClientRect().top:window.innerHeight)-margin,ceiling=(bar?Math.max(0,bar.getBoundingClientRect().bottom):0)+margin;
 const below=floor-anchor.bottom-6,above=anchor.top-6-ceiling,up=height>below&&above>below;
 const left=Math.max(margin,Math.min(anchor.left+anchor.width/2-width/2,view-margin-width)),top=up?anchor.top-6-height:anchor.bottom+6;
 pop.style.left=left+'px';pop.style.top=top+'px';pop.style.transformOrigin=`${Math.round(anchor.left+anchor.width/2-left)}px ${up?'100%':'0'}`;pop.dataset.side=up?'up':'down';
 button.setAttribute('aria-expanded','true');tagPopover={pop,button};
}
document.addEventListener('pointerdown',event=>{tagTouch=event.pointerType==='touch'},true);
document.addEventListener('click',event=>{
 if(!tagPopover||tagPopover.pop.contains(event.target)||event.target.closest?.('.tag-overflow'))return;
 // A touch outside only closes the popup; with a mouse the click also does what it landed on.
 if(tagTouch){event.preventDefault();event.stopPropagation()}closeTagPopover();
},true);
document.addEventListener('keydown',event=>{if(event.key==='Escape'&&tagPopover){event.stopPropagation();closeTagPopover(true)}},true);
window.addEventListener('scroll',()=>closeTagPopover(),{capture:true,passive:true});window.addEventListener('resize',()=>closeTagPopover());
function recordingTagButton(log,onSaved){
 const button=document.createElement('button');button.type='button';button.className='tag-edit';button.innerHTML=RECORDING_TAG_ICON;button.title='태그 편집';button.setAttribute('aria-label','태그 편집');
 button.onclick=()=>editRecordingTags([log],onSaved);return button;
}
// The keyboard can shrink the visual viewport without resizing the layout viewport in Android WebView.
// Keep the editor and its fixed footer inside that visible area; release listeners when the page closes it.
function fitEditorViewport(dialog){
 const viewport=window.visualViewport;let frame=0;
 const fit=()=>{
  frame=0;if(!dialog.open)return;
  dialog.style.setProperty('--editor-top',(viewport?.offsetTop||0)+'px');
  dialog.style.setProperty('--editor-height',(viewport?.height||innerHeight)+'px');
  const input=document.activeElement;
  if(dialog.contains(input)&&input.matches('input,textarea'))input.scrollIntoView({block:'nearest',inline:'nearest'});
 };
 const schedule=()=>{if(!frame)frame=requestAnimationFrame(fit)};
 dialog.classList.add('keyboard-editor');viewport?.addEventListener('resize',schedule);viewport?.addEventListener('scroll',schedule);
 window.addEventListener('resize',schedule);dialog.addEventListener('focusin',schedule);
 dialog.addEventListener('close',()=>{viewport?.removeEventListener('resize',schedule);viewport?.removeEventListener('scroll',schedule);window.removeEventListener('resize',schedule);dialog.removeEventListener('focusin',schedule);cancelAnimationFrame(frame)},{once:true});
 fit();
}
function editRecordingTags(logs,onSaved,bulk=false){
 if(!logs.length||document.querySelector('.tag-dialog[open]'))return;
 const opener=document.activeElement,overflow=document.body.style.overflow,dialog=document.createElement('dialog');dialog.className='tag-dialog editor-dialog';dialog.setAttribute('aria-labelledby','tagDialogTitle');
 dialog.innerHTML=`<div class="tag-dialog-head"><div><span class="tag-eyebrow">LOG TAGS</span><h2 id="tagDialogTitle">${bulk?'선택한 구간의 태그':'구간 태그 편집'}</h2></div><button type="button" class="tag-close">닫기</button></div>
 <p class="tag-dialog-description"></p><form class="tag-form"><fieldset class="tag-fields"><legend class="tag-sr-only">태그 편집</legend>
 <div class="tag-mode" ${bulk?'':'hidden'}><label><input type="radio" name="tagAction" value="add" checked> 태그 추가</label><label><input type="radio" name="tagAction" value="remove"> 태그 제거</label></div>
 <div class="tag-draft" aria-label="선택한 태그"></div>
 <label class="tag-input-label" for="tagNameInput">태그 검색 또는 새로 만들기</label><div class="tag-input-row"><input id="tagNameInput" type="text" placeholder="태그를 선택하거나 새 이름 입력" autocomplete="off" enterkeyhint="done" aria-describedby="tagHelp"><button class="tag-add" type="submit">추가</button></div>
 <div class="tag-colors" role="group" aria-label="태그 색상" hidden></div><p id="tagHelp">기존 태그를 누르면 선택됩니다. 새 이름은 최대 32자, 구간당 최대 100개입니다. 선택한 태그를 누르면 수정할 수 있습니다.</p>
 <div class="tag-suggestions" aria-label="기존 태그 추천"></div>
 </fieldset></form><div class="tag-dialog-footer"><p class="tag-result" role="status"></p><button type="button" class="primary tag-save">저장</button></div>`;
 const find=selector=>dialog.querySelector(selector),input=find('input[type=text]'),fields=find('fieldset'),draftArea=find('.tag-draft'),suggestions=find('.tag-suggestions'),result=find('.tag-result'),save=find('.tag-save'),close=find('.tag-close');
 find('.tag-dialog-description').textContent=bulk?`${logs.length}개 구간에 선택한 태그만 추가하거나 제거합니다. 다른 태그와 고정 상태는 유지됩니다.`:recordingIdentity(logs[0].name,logs[0].files).display+' · 재변환 없이 저장됩니다.';
 let draft=bulk?[]:(logs[0].tags||[]).map(tag=>({...tag})),color='mint',editing=null,saving=false;
 const palette=find('.tag-colors');
 for(const [key,name] of Object.entries(TAG_PALETTE)){
  const button=document.createElement('button');button.type='button';button.dataset.color=key;button.title=name;button.setAttribute('aria-label',name);button.onclick=()=>{color=key;syncColors()};palette.append(button);
 }
 function syncColors(){for(const button of palette.children)button.setAttribute('aria-pressed',String(button.dataset.color===color))}
 function updateSave(){save.disabled=saving||(bulk&&!draft.length&&!input.value.trim())}
 function suggest(){
  palette.hidden=!input.value.trim()||dialog.querySelector('[name=tagAction]:checked').value==='remove';
  suggestions.replaceChildren();const query=tagKey(input.value),matches=recordingTagCatalog.filter(tag=>(!query||tagKey(tag.name).includes(query))&&!draft.some(d=>tagKey(d.name)===tagKey(tag.name)));
  if(matches.length){const label=document.createElement('p');label.textContent=query?'일치하는 태그':'기존 태그';suggestions.append(label)}
  for(const tag of matches){const button=document.createElement('button');button.type='button';button.textContent=tag.name;button.dataset.color=tag.color;button.className='recording-tag';button.onclick=()=>{input.blur();input.value=tag.name;color=tag.color;syncColors();addDraft()};suggestions.append(button)}
  updateSave();
 }
 function renderDraft(){
  draftArea.replaceChildren();
  for(const tag of draft){
   const chip=document.createElement('span');chip.className='tag-draft-chip';chip.dataset.color=tag.color;
   const edit=document.createElement('button');edit.type='button';edit.textContent=tag.name;edit.title=tag.name+' 편집';edit.onclick=()=>{editing=tagKey(tag.name);input.value=tag.name;color=tag.color;syncColors();find('.tag-add').textContent='적용';suggest();input.focus()};
   const remove=document.createElement('button');remove.type='button';remove.textContent='×';remove.setAttribute('aria-label',tag.name+' 선택 해제');remove.onclick=()=>{draft=draft.filter(d=>tagKey(d.name)!==tagKey(tag.name));if(editing===tagKey(tag.name)){editing=null;input.value='';find('.tag-add').textContent='추가'}renderDraft()};chip.append(edit,remove);draftArea.append(chip);
  }
  if(!draft.length){const empty=document.createElement('p');empty.textContent=bulk?'추가하거나 제거할 태그를 선택하세요.':'등록된 태그가 없습니다.';draftArea.append(empty)}
  suggest();
 }
 function addDraft(refocus=false){
  const name=input.value.normalize('NFC').trim().replace(/\s+/gu,' '),key=tagKey(name);
  if(!name||Array.from(name).length>32||/\p{C}/u.test(name)){result.textContent='태그 이름은 1~32자의 표시 가능한 문자로 입력해 주세요.';return false}
  const next=draft.filter(tag=>tagKey(tag.name)!==key&&tagKey(tag.name)!==editing);
  if(next.length>=100){result.textContent='태그는 최대 100개까지 선택할 수 있습니다.';return false}
  draft=[...next,{name,color}];input.value='';editing=null;find('.tag-add').textContent='추가';result.textContent='';renderDraft();if(refocus)input.focus();return true;
 }
 find('form').onsubmit=event=>{event.preventDefault();addDraft(document.activeElement===input)};input.oninput=suggest;
 for(const radio of dialog.querySelectorAll('[name=tagAction]'))radio.onchange=()=>{suggest();save.textContent=dialog.querySelector('[name=tagAction]:checked').value==='remove'?'태그 제거':'태그 추가'};
 const dismiss=()=>{if(!saving)dialog.close()};close.onclick=dismiss;
 dialog.addEventListener('cancel',event=>{event.preventDefault();dismiss()});
 dialog.onclick=event=>{if(event.target!==dialog)return;const r=dialog.getBoundingClientRect();if(event.clientX<r.left||event.clientX>r.right||event.clientY<r.top||event.clientY>r.bottom)dismiss()};
 dialog.addEventListener('close',()=>{document.body.style.overflow=overflow;dialog.remove();if(opener?.isConnected)opener.focus({preventScroll:true})});
 save.onclick=async()=>{
  if(saving||(input.value.trim()&&!addDraft()))return;
  saving=true;fields.disabled=true;close.disabled=true;updateSave();const changes=[],failures=[];
  const action=bulk?dialog.querySelector('[name=tagAction]:checked').value:'set',prefix=document.body.classList.contains('replay-page')?'../../api/logs/':'api/logs/';
  try{
   for(const [index,log] of logs.entries()){
    result.textContent=`${index+1} / ${logs.length}개 구간 저장 중…`;
    try{
     const response=await fetch(prefix+encodeURIComponent(log.id)+'/tags',{method:'POST',headers:{'Content-Type':'application/json','X-RoadViewer-Request':'1'},body:JSON.stringify({action,tags:draft})});
     const data=await response.json();if(!response.ok)throw Error(data.error||'저장하지 못했습니다.');
     changes.push({id:log.id,tags:data.tags});
    }catch(error){failures.push(recordingIdentity(log.name,log.files).display+': '+error.message)}
   }
   if(changes.length)await onSaved(changes);
   if(!failures.length)dialog.close();
   else{logs=logs.filter(log=>!changes.some(change=>change.id===log.id));result.textContent=`${changes.length}개 저장 · ${failures.length}개 미완료\n${failures.join('\n')}\n저장을 누르면 미완료 항목만 다시 시도합니다.`}
  }finally{saving=false;fields.disabled=false;close.disabled=false;updateSave()}
 };
 document.body.append(dialog);document.body.style.overflow='hidden';syncColors();renderDraft();dialog.showModal();fitEditorViewport(dialog);
 (matchMedia('(pointer:coarse)').matches?close:input).focus({preventScroll:true});
}
