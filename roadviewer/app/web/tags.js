'use strict';
const RECORDING_TAG_ICON='<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 3h8l10 10-8 8L3 11z"/><circle cx="7.5" cy="7.5" r="1"/></svg>';
const TAG_PALETTE={mint:'민트',blue:'파랑',violet:'보라',amber:'주황',rose:'분홍',slate:'회색'};
let recordingTagCatalog=[];
const tagKey=name=>name.normalize('NFC').trim().replace(/\s+/gu,' ').toLowerCase();
function updateTagCatalog(logs){
 const tags=new Map();for(const log of logs)for(const tag of log.tags||[])if(!tags.has(tagKey(tag.name)))tags.set(tagKey(tag.name),tag);
 recordingTagCatalog=[...tags.values()].sort((a,b)=>a.name.localeCompare(b.name,'ko'));
}
function recordingTagBadges(tags=[],limit=4){
 const group=document.createElement('div');group.className='recording-tags';group.hidden=!tags.length;
 for(const tag of tags.slice(0,limit)){
  const badge=document.createElement('span');badge.className='recording-tag';badge.dataset.color=Object.hasOwn(TAG_PALETTE,tag.color)?tag.color:'mint';badge.textContent=tag.name;badge.title=tag.name;group.append(badge);
 }
 if(tags.length>limit){const more=document.createElement('span');more.className='tag-overflow';more.textContent='+'+(tags.length-limit);more.title=tags.slice(limit).map(tag=>tag.name).join(', ');group.append(more)}
 return group;
}
function recordingTagButton(log,onSaved){
 const button=document.createElement('button');button.type='button';button.className='tag-edit';button.innerHTML=RECORDING_TAG_ICON;button.title='태그 편집';button.setAttribute('aria-label','태그 편집');
 button.onclick=()=>editRecordingTags([log],onSaved);return button;
}
function editRecordingTags(logs,onSaved,bulk=false){
 if(!logs.length||document.querySelector('.tag-dialog[open]'))return;
 const opener=document.activeElement,overflow=document.body.style.overflow,dialog=document.createElement('dialog');dialog.className='tag-dialog';dialog.setAttribute('aria-labelledby','tagDialogTitle');
 dialog.innerHTML=`<div class="tag-dialog-head"><div><span class="tag-eyebrow">LOG TAGS</span><h2 id="tagDialogTitle">${bulk?'선택한 구간의 태그':'구간 태그 편집'}</h2></div><button type="button" class="tag-close">닫기</button></div>
 <p class="tag-dialog-description"></p><form class="tag-form"><fieldset class="tag-fields"><legend class="tag-sr-only">태그 편집</legend>
 <div class="tag-mode" ${bulk?'':'hidden'}><label><input type="radio" name="tagAction" value="add" checked> 태그 추가</label><label><input type="radio" name="tagAction" value="remove"> 태그 제거</label></div>
 <label class="tag-input-label" for="tagNameInput">태그 이름</label><div class="tag-input-row"><input id="tagNameInput" type="text" placeholder="예: 급제동, 인식 오류, 야간" autocomplete="off" aria-describedby="tagHelp"><button class="tag-add" type="submit">추가</button></div>
 <div class="tag-colors" role="group" aria-label="태그 색상"></div><p id="tagHelp">이름은 최대 32자, 구간당 최대 20개입니다. 배지를 누르면 이름과 색상을 바꿀 수 있습니다.</p>
 <div class="tag-draft" aria-label="선택한 태그"></div><div class="tag-suggestions" aria-label="기존 태그 추천"></div>
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
  suggestions.replaceChildren();const query=tagKey(input.value),matches=recordingTagCatalog.filter(tag=>(!query||tagKey(tag.name).includes(query))&&!draft.some(d=>tagKey(d.name)===tagKey(tag.name))).slice(0,12);
  if(matches.length){const label=document.createElement('p');label.textContent=query?'일치하는 태그':'기존 태그';suggestions.append(label)}
  for(const tag of matches){const button=document.createElement('button');button.type='button';button.textContent=tag.name;button.dataset.color=tag.color;button.className='recording-tag';button.onclick=()=>{input.value=tag.name;color=tag.color;syncColors();addDraft()};suggestions.append(button)}
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
 function addDraft(){
  const name=input.value.normalize('NFC').trim().replace(/\s+/gu,' '),key=tagKey(name);
  if(!name||Array.from(name).length>32||/\p{C}/u.test(name)){result.textContent='태그 이름은 1~32자의 표시 가능한 문자로 입력해 주세요.';return false}
  const next=draft.filter(tag=>tagKey(tag.name)!==key&&tagKey(tag.name)!==editing);
  if(next.length>=20){result.textContent='태그는 최대 20개까지 선택할 수 있습니다.';return false}
  draft=[...next,{name,color}];input.value='';editing=null;find('.tag-add').textContent='추가';result.textContent='';renderDraft();input.focus();return true;
 }
 find('form').onsubmit=event=>{event.preventDefault();addDraft()};input.oninput=suggest;
 for(const radio of dialog.querySelectorAll('[name=tagAction]'))radio.onchange=()=>{palette.hidden=radio.value==='remove'&&radio.checked;save.textContent=dialog.querySelector('[name=tagAction]:checked').value==='remove'?'태그 제거':'태그 추가'};
 close.onclick=()=>dialog.close();dialog.addEventListener('cancel',event=>{if(saving)event.preventDefault()});
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
 document.body.append(dialog);document.body.style.overflow='hidden';syncColors();renderDraft();dialog.showModal();input.focus();
}
