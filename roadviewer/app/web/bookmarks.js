'use strict';
(()=>{
 const opener=$('bookmarkOpen'),markers=$('bookmarkMarkers'),id=location.pathname.split('/').filter(Boolean).at(-1),url='../../api/logs/'+encodeURIComponent(id)+'/bookmarks';
 opener.innerHTML='<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="M6 3h12v18l-6-4-6 4z"/></svg><span>북마크</span>';
 let items=[],duration=null,dialog=null,busy=false,loadError='',ready=false,editing=null,captured=0,oldOverflow='';
 const find=selector=>dialog.querySelector(selector);
 async function request(method='GET',suffix='',body){
  const response=await fetch(url+suffix,{method,headers:{'Content-Type':'application/json','X-RoadViewer-Request':'1'},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(20000)});
  const result=await response.json();if(!response.ok)throw Error(result.error||'북마크를 저장하지 못했습니다.');return result.bookmarks;
 }
 function jump(item){if(!data||loading)return;if(dialog?.open)dialog.close();setTime(item.time);last=performance.now()}
 function renderMarkers(force=false){
  if(!force&&duration===data?.duration)return;duration=data?.duration;markers.replaceChildren();
  if(!(duration>0))return;
  for(const item of items){
   if(item.time>duration)continue;
   const button=document.createElement('button');button.type='button';button.className='bookmark-marker';button.style.left=(item.time/duration*100)+'%';button.title=clock(item.time)+' · '+item.title;button.setAttribute('aria-label',button.title);button.onclick=()=>jump(item);markers.append(button);
  }
 }
 function resetEditor(){editing=null;captured=t;find('form').reset();find('.bookmark-editor-title').textContent='현재 장면 추가';find('.bookmark-time').textContent=clock(captured);find('.bookmark-save').textContent='저장';find('.bookmark-cancel').hidden=true}
 function renderList(){
  if(!dialog)return;const list=find('.bookmark-list');list.replaceChildren();
  for(const item of items){
   const row=document.createElement('div');row.className='bookmark-row';
   const go=document.createElement('button');go.type='button';go.className='bookmark-go';
   const time=document.createElement('span');time.className='bookmark-at';time.textContent=clock(item.time);
   const title=document.createElement('span');title.textContent=item.title;go.append(time,title);go.disabled=busy||!data||loading||item.time>data.duration;go.onclick=()=>jump(item);
   const edit=document.createElement('button');edit.type='button';edit.textContent='수정';edit.disabled=busy;edit.setAttribute('aria-label',item.title+' 수정');edit.onclick=()=>{editing=item.id;captured=item.time;find('.bookmark-title').value=item.title;find('.bookmark-note').value=item.note;find('.bookmark-time').textContent=clock(captured);find('.bookmark-editor-title').textContent='북마크 수정';find('.bookmark-save').textContent='수정 저장';find('.bookmark-cancel').hidden=false;find('.bookmark-title').focus()};
   const remove=document.createElement('button');remove.type='button';remove.className='bookmark-delete';remove.textContent='삭제';remove.disabled=busy;remove.setAttribute('aria-label',item.title+' 삭제');remove.onclick=()=>{if(confirm('이 북마크를 삭제할까요?'))mutate('DELETE','/'+item.id)};
   row.append(go,edit,remove);if(item.note){const note=document.createElement('p');note.textContent=item.note;row.append(note)}list.append(row);
  }
  if(!items.length){const empty=document.createElement('p');empty.textContent=ready?'저장된 장면이 없습니다.':loadError||'북마크를 불러오는 중입니다.';list.append(empty)}
  find('.bookmark-retry').hidden=!loadError;find('.bookmark-retry').disabled=busy;
 }
 function lockEditor(value){busy=value;find('fieldset').disabled=value||!ready;find('.bookmark-close').disabled=value;renderList()}
 async function load(){
  if(busy)return;busy=true;
  try{items=await request();ready=true;loadError='';renderMarkers(true)}catch(error){loadError='북마크를 불러오지 못했습니다. 다시 시도해 주세요.'}
  finally{busy=false;if(dialog){find('fieldset').disabled=!ready;renderList()}}
 }
 async function mutate(method,suffix='',body){
  if(busy)return;lockEditor(true);find('.bookmark-result').textContent='저장 중…';
  try{items=await request(method,suffix,body);renderMarkers(true);resetEditor();find('.bookmark-result').textContent=method==='DELETE'?'북마크를 삭제했습니다.':'북마크를 저장했습니다.'}
  catch(error){find('.bookmark-result').textContent=error.name==='TimeoutError'?'응답이 지연되고 있습니다. 목록을 다시 확인한 뒤 시도해 주세요.':error.message;loadError='목록을 다시 확인해 주세요.'}
  finally{lockEditor(false)}
 }
 opener.onclick=()=>{
  if(!data||loading)return;
  if(!dialog){
   dialog=document.createElement('dialog');dialog.className='tag-dialog bookmark-dialog';dialog.setAttribute('aria-labelledby','bookmarkHeading');
   dialog.innerHTML=`<div class="tag-dialog-head"><div><span class="tag-eyebrow">SCENE BOOKMARKS</span><h2 id="bookmarkHeading">장면 북마크</h2></div><button class="bookmark-close" type="button">닫기</button></div><p class="tag-dialog-description">로그 시간을 기준으로 저장합니다. 시간을 누르면 영상과 그래프가 함께 이동합니다.</p><div class="bookmark-body"><form><fieldset><legend class="bookmark-editor-title">현재 장면 추가</legend><div class="bookmark-editor-time"><output class="bookmark-time"></output><button class="bookmark-now" type="button">현재 시각으로</button></div><label>제목<input class="bookmark-title" required maxlength="80" placeholder="예: 앞차 인식 오류"></label><label>메모 (선택)<textarea class="bookmark-note" maxlength="1000" rows="2" placeholder="나중에 확인할 내용을 적어 주세요."></textarea></label><div class="bookmark-editor-actions"><button class="bookmark-cancel" type="button" hidden>새 북마크</button><button class="primary bookmark-save" type="submit">저장</button></div></fieldset></form><p class="bookmark-result" role="status"></p><button class="bookmark-retry" type="button" hidden>목록 다시 불러오기</button><div class="bookmark-list" aria-label="저장된 장면"></div></div>`;
   document.body.append(dialog);find('.bookmark-close').onclick=()=>dialog.close();find('.bookmark-cancel').onclick=resetEditor;find('.bookmark-now').onclick=()=>{captured=t;find('.bookmark-time').textContent=clock(captured)};find('.bookmark-retry').onclick=load;
   find('form').onsubmit=event=>{event.preventDefault();const title=find('.bookmark-title').value.trim();if(!title){find('.bookmark-title').focus();return}mutate(editing?'PUT':'POST',editing?'/'+editing:'',{time:captured,title,note:find('.bookmark-note').value})};
   dialog.addEventListener('cancel',event=>{if(busy)event.preventDefault()});dialog.addEventListener('close',()=>{document.body.style.overflow=oldOverflow;opener.focus({preventScroll:true})});
  }
  oldOverflow=document.body.style.overflow;document.body.style.overflow='hidden';resetEditor();find('.bookmark-result').textContent='';find('fieldset').disabled=busy||!ready;renderList();dialog.showModal();find('.bookmark-title').focus();void load();
 };
 window.renderBookmarks=renderMarkers;void load();
})();
