'use strict';
(()=>{
 const labels={storageLimit:'최대 사용량',storagePolicy:'공간 부족 시',lateralRange:'좌우 표시 범위',concurrency:'동시 처리 개수',logSegment:'구간 선택',speed:'재생 속도',range:'전방 표시 거리'};
 const dialog=document.createElement('dialog');dialog.className='rv-choice-dialog';
 dialog.setAttribute('aria-labelledby','rv-choice-title');
 const header=document.createElement('div');header.className='rv-choice-header';
 const title=document.createElement('h2');title.id='rv-choice-title';
 const close=document.createElement('button');close.type='button';close.className='rv-choice-close';close.textContent='닫기';
 const list=document.createElement('div');list.className='rv-choice-list';list.setAttribute('role','listbox');list.setAttribute('aria-labelledby',title.id);
 header.append(title,close);dialog.append(header,list);document.body.append(dialog);
 let active=null,opener=null,oldOverflow='';
 const mobile=()=>matchMedia('(max-width:600px)').matches;
 function position(){
  if(!dialog.open)return;
  if(mobile()){dialog.style.left='';dialog.style.top='';dialog.style.width='';return}
  const rect=opener.getBoundingClientRect(),width=Math.min(Math.max(224,rect.width),innerWidth-24);
  dialog.style.width=width+'px';
  dialog.style.left=Math.max(12,Math.min(rect.left,innerWidth-width-12))+'px';
  const height=dialog.getBoundingClientRect().height;
  dialog.style.top=Math.max(12,rect.bottom+height+8<=innerHeight-12?rect.bottom+8:rect.top-height-8)+'px';
 }
 function open(select,button){
  if(dialog.open||select.disabled)return;
  active=select;opener=button;title.textContent=labels[select.id];
  list.replaceChildren();
  for(const option of select.options){
   const item=document.createElement('button');item.type='button';item.className='rv-choice-option';
   item.setAttribute('role','option');item.setAttribute('aria-selected',String(option.selected));
   item.disabled=option.disabled||option.parentElement.disabled===true;
   item.tabIndex=-1;
   const text=document.createElement('span');text.textContent=option.textContent;
   const check=document.createElement('span');check.className='rv-choice-check';check.setAttribute('aria-hidden','true');check.textContent=option.selected?'✓':'';
   item.append(text,check);
   item.onclick=()=>{
    select.value=option.value;
    select.dispatchEvent(new Event('input',{bubbles:true}));
    select.dispatchEvent(new Event('change',{bubbles:true}));
    closeChoice();
   };
   list.append(item);
  }
  oldOverflow=document.body.style.overflow;document.body.style.overflow='hidden';
  button.setAttribute('aria-expanded','true');dialog.showModal();position();
  const initial=list.querySelector('[aria-selected="true"]:not(:disabled)')||list.querySelector('button:not(:disabled)');
  if(initial){initial.tabIndex=0;initial.focus({preventScroll:true});initial.scrollIntoView({block:'nearest'})}
 }
 list.onkeydown=e=>{
  const items=[...list.querySelectorAll('button:not(:disabled)')],index=items.indexOf(document.activeElement);
  let next;
  if(e.key==='ArrowDown')next=(index+1)%items.length;
  else if(e.key==='ArrowUp')next=(index+items.length-1)%items.length;
  else if(e.key==='Home')next=0;
  else if(e.key==='End')next=items.length-1;
  else return;
  e.preventDefault();
  if(items[next]){items.forEach(item=>item.tabIndex=-1);items[next].tabIndex=0;items[next].focus()}
 };
 close.onclick=()=>closeChoice();
 dialog.onclick=e=>{if(e.target===dialog){const r=dialog.getBoundingClientRect();if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)closeChoice()}};
 function finishClose(){
  if(!active)return;
  document.body.style.overflow=oldOverflow;
  opener?.setAttribute('aria-expanded','false');
  const previous=opener;active=null;
  previous?.focus({preventScroll:true});
 }
 function closeChoice(){dialog.close();finishClose()}
 dialog.addEventListener('cancel',e=>{e.preventDefault();closeChoice()});
 dialog.addEventListener('close',()=>{if(!dialog.open)finishClose()});
 window.addEventListener('resize',position);
 for(const [id,label] of Object.entries(labels)){
  const select=document.getElementById(id);if(!select)continue;
  const button=document.createElement('button');button.id=id+'Choice';button.type='button';button.className='rv-choice-trigger';
  button.setAttribute('aria-haspopup','dialog');button.setAttribute('aria-expanded','false');button.setAttribute('aria-label',label);
  select.classList.add('rv-choice-native');select.setAttribute('aria-hidden','true');select.tabIndex=-1;select.after(button);
  const sync=()=>{
   button.hidden=select.hidden;button.disabled=select.disabled;
   button.textContent=select.selectedOptions[0]?.textContent||label;
   button.title=label+' · '+button.textContent;
   if(active===select&&(select.hidden||select.disabled))closeChoice();
  };
  button.onclick=()=>open(select,button);
  button.onkeydown=e=>{if(e.key==='ArrowDown'||e.key==='ArrowUp'){e.preventDefault();open(select,button)}};
  select.addEventListener('change',sync);
  select.addEventListener('rv:sync',sync);
  new MutationObserver(sync).observe(select,{childList:true,subtree:true,attributes:true,characterData:true});
  sync();
 }
})();
