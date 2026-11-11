'use strict';
(()=>{
 // Record a scene without leaving the video; the analysis tab remains the list of saved scenes.
 const opener=$('bookmarkOpen'),markers=$('bookmarkMarkers'),view=$('bookmarkView'),count=$('bookmarkCount'),id=location.pathname.split('/').filter(Boolean).at(-1),url='../../api/logs/'+encodeURIComponent(id)+'/bookmarks';
 opener.innerHTML='<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" aria-hidden="true"><path d="M6 3h12v18l-6-4-6 4z"/></svg><span>북마크</span>';
 view.innerHTML=`<p class="bookmark-help">시간을 누르면 영상과 그래프가 함께 이동합니다. 기록 버튼을 누른 순간의 로그 시간을 저장합니다.</p><button class="bookmark-new" type="button">현재 장면 기록</button><p class="bookmark-result" role="status"></p><button class="bookmark-retry" type="button" hidden>목록 다시 불러오기</button><div class="bookmark-list" aria-label="저장된 장면"></div>`;
 const dialog=document.createElement('dialog');dialog.className='editor-dialog bookmark-dialog';dialog.setAttribute('aria-labelledby','bookmarkEditorTitle');
 dialog.innerHTML=`<div class="tag-dialog-head"><h2 id="bookmarkEditorTitle" class="bookmark-editor-title">현재 장면 기록</h2><button class="bookmark-close" type="button">닫기</button></div><form class="bookmark-editor"><fieldset disabled><div class="bookmark-editor-time"><output class="bookmark-time">0:00.00</output><button class="bookmark-now" type="button">현재 시각으로</button></div><label>제목 (선택)<input class="bookmark-title" maxlength="80" autocomplete="off" enterkeyhint="done" placeholder="예: 앞차 인식 오류"></label><label>메모 (선택)<textarea class="bookmark-note" maxlength="1000" rows="2" placeholder="나중에 확인할 내용"></textarea></label><p class="bookmark-help">제목 없이 저장하면 시간으로 이름을 붙입니다. 입력 중에도 선택한 장면 시간은 유지됩니다.</p></fieldset><div class="tag-dialog-footer"><p class="bookmark-result" role="status"></p><div class="bookmark-editor-actions"><button class="bookmark-cancel" type="button" hidden>새 북마크</button><button class="primary bookmark-save" type="submit" disabled>저장</button></div></div></form>`;
 document.body.append(dialog);
 let listLoading=null,items=[],duration=null,busy=false,loadError='',ready=false,editing=null,captured=0,follow=true,overflow='',returnFocus=null;
 const find=selector=>dialog.querySelector(selector)||view.querySelector(selector);
 const message=text=>{for(const root of [view,dialog])root.querySelector('.bookmark-result').textContent=text};
 async function request(method='GET',suffix='',body){
  const response=await fetch(url+suffix,{method,headers:{'Content-Type':'application/json','X-RoadViewer-Request':'1'},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(20000)});
  const result=await response.json();if(!response.ok)throw Error(result.error||'북마크를 저장하지 못했습니다.');return result.bookmarks;
 }
 function jump(item){if(!data||loading)return;setTime(item.time);last=performance.now()}
 function capture(time){captured=time;find('.bookmark-time').textContent=clock(captured)}
 // Following playback (called every frame) with the editor closed, the unseen time text is written once a second;
 // opening the editor (or any other capture) writes it exactly.
 function renderMarkers(force=false){
  if(follow&&!editing&&captured!==t){if(dialog.open||Math.floor(captured)!==Math.floor(t))capture(t);else captured=t}
  if(listLoading!==loading){listLoading=loading;renderList()}
  if(!force&&duration===data?.duration)return;duration=data?.duration;markers.replaceChildren();renderList();
  if(!(duration>0))return;
  for(const item of items){
   if(item.time>duration)continue;
   const button=document.createElement('button');button.type='button';button.className='bookmark-marker';button.style.left=(item.time/duration*100)+'%';button.title=clock(item.time)+' · '+item.title;button.setAttribute('aria-label',button.title);button.onclick=()=>jump(item);markers.append(button);
  }
 }
 function resetEditor(){editing=null;follow=false;find('form').reset();capture(t);find('.bookmark-editor-title').textContent='현재 장면 기록';find('.bookmark-save').textContent='저장';find('.bookmark-cancel').hidden=true}
 function openEditor(){
  if(!data||loading||dialog.open)return;
  if(!editing&&!find('.bookmark-title').value.trim()&&!find('.bookmark-note').value.trim()){follow=false;capture(t)}
  message('');returnFocus=document.activeElement;overflow=document.body.style.overflow;document.body.style.overflow='hidden';dialog.showModal();fitEditorViewport(dialog);
  (matchMedia('(pointer:coarse)').matches?find('.bookmark-close'):find('.bookmark-title')).focus({preventScroll:true});
  if(!ready)void load();
 }
 const dismiss=()=>{if(!busy)dialog.close()};find('.bookmark-close').onclick=dismiss;
 dialog.addEventListener('cancel',event=>{event.preventDefault();dismiss()});
 dialog.addEventListener('click',event=>{if(event.target!==dialog)return;const r=dialog.getBoundingClientRect();if(event.clientX<r.left||event.clientX>r.right||event.clientY<r.top||event.clientY>r.bottom)dismiss()});
 dialog.addEventListener('close',()=>{document.body.style.overflow=overflow;if(returnFocus?.isConnected)returnFocus.focus({preventScroll:true})});
 function renderList(){
  const list=view.querySelector('.bookmark-list');list.replaceChildren();count.textContent=items.length?String(items.length):'';
  for(const item of items){
   const row=document.createElement('div');row.className='bookmark-row';
   const go=document.createElement('button');go.type='button';go.className='bookmark-go';
   const time=document.createElement('span');time.className='bookmark-at';time.textContent=clock(item.time);
   const title=document.createElement('span');title.textContent=item.title;go.append(time,title);go.disabled=busy||!data||loading||item.time>data.duration;go.onclick=()=>jump(item);
   const edit=document.createElement('button');edit.type='button';edit.textContent='수정';edit.disabled=busy;edit.setAttribute('aria-label',item.title+' 수정');edit.onclick=()=>{editing=item.id;follow=false;capture(item.time);find('.bookmark-title').value=item.title;find('.bookmark-note').value=item.note;find('.bookmark-editor-title').textContent='북마크 수정';find('.bookmark-save').textContent='수정 저장';find('.bookmark-cancel').hidden=false;openEditor()};
   const remove=document.createElement('button');remove.type='button';remove.className='bookmark-delete';remove.textContent='삭제';remove.disabled=busy;remove.setAttribute('aria-label',item.title+' 삭제');remove.onclick=()=>{if(confirm('이 북마크를 삭제할까요?'))mutate('DELETE','/'+item.id)};
   row.append(go,edit,remove);if(item.note){const note=document.createElement('p');note.textContent=item.note;row.append(note)}list.append(row);
  }
  if(!items.length){const empty=document.createElement('p');empty.textContent=ready?'저장된 장면이 없습니다.':loadError||'북마크를 불러오는 중입니다.';list.append(empty)}
  view.querySelector('.bookmark-retry').hidden=!loadError;view.querySelector('.bookmark-retry').disabled=busy;
 }
 function lockEditor(value){busy=value;find('fieldset').disabled=value||!ready;find('.bookmark-save').disabled=value||!ready;find('.bookmark-close').disabled=value;renderList()}
 async function load(){
  if(busy)return;lockEditor(true);
  try{items=await request();ready=true;loadError='';renderMarkers(true)}catch(error){loadError='북마크를 불러오지 못했습니다. 다시 시도해 주세요.';message(loadError)}
  finally{lockEditor(false)}
 }
 async function mutate(method,suffix='',body){
  if(busy)return;lockEditor(true);message('저장 중…');
  try{items=await request(method,suffix,body);renderMarkers(true);resetEditor();follow=true;message(method==='DELETE'?'북마크를 삭제했습니다.':'북마크를 저장했습니다.');if(dialog.open)dialog.close()}
  catch(error){message(error.name==='TimeoutError'?'응답이 지연되고 있습니다. 다시 저장을 눌러 주세요.':error.message);loadError='목록을 다시 확인해 주세요.'}
  finally{lockEditor(false)}
 }
 find('.bookmark-cancel').onclick=resetEditor;find('.bookmark-now').onclick=()=>{follow=false;capture(t)};view.querySelector('.bookmark-retry').onclick=load;
 for(const field of [find('.bookmark-title'),find('.bookmark-note')])field.addEventListener('input',()=>{follow=false});
 find('form').onsubmit=event=>{event.preventDefault();const title=find('.bookmark-title').value.trim()||'장면 '+clock(captured);mutate(editing?'PUT':'POST',editing?'/'+editing:'',{time:captured,title,note:find('.bookmark-note').value})};
 opener.onclick=openEditor;view.querySelector('.bookmark-new').onclick=openEditor;
 window.renderBookmarks=renderMarkers;renderList();void load();
})();
