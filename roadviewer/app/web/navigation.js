import {pageScope} from './page-scope.js';
const host=document.getElementById('pageHost'),notice=document.getElementById('navigationStatus'),assets=new URL('./',import.meta.url),version=new URL(import.meta.url).search;
const base=new URL('../',assets),libraryStyle=document.getElementById('libraryStyle');
let current=null,revision=0,pending=null,transition=null,libraryScroll=0;
const route=url=>url.origin===base.origin&&(url.pathname===base.pathname?'library':new RegExp('^'+base.pathname.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'view/[^/]+/$').test(url.pathname)?'replay':null);
function saveScroll(){history.replaceState({...history.state,rvScroll:scrollY},'',location.href)}
async function navigate(to,{replace=false,pop=false}={}){
 const url=new URL(to,location.href),kind=route(url);if(!kind)return;
 if(current&&!current.api.canLeave()){
  notice.textContent='업로드 또는 정리 작업이 끝난 뒤 이동해 주세요.';
  if(pop)history.pushState({},'',current.url);return;
 }
 const ticket=++revision;pending?.abort();transition?.skipTransition();
 if(transition)await transition.updateCallbackDone.catch(()=>{});if(ticket!==revision)return;
 pending=new AbortController();notice.setAttribute('role','status');notice.textContent='화면을 불러오는 중입니다.';
 try{
  const request=new URL(url);request.searchParams.set('fragment','1');
  const [response,module]=await Promise.all([fetch(request,{signal:pending.signal,cache:'no-store'}),import(new URL('page-'+kind+'.js'+version,assets))]);
  if(!response.ok)throw Error('화면을 불러오지 못했습니다. 다시 시도해 주세요.');
  const html=new DOMParser().parseFromString(await response.text(),'text/html');if(ticket!==revision)return;
  if(!html.querySelector('main')||!html.body.classList.contains(kind==='library'?'library-page':'replay-page'))throw Error('예상하지 못한 응답입니다. 연결 상태를 확인해 주세요.');
  const root=document.createElement('div');root.className=html.body.className;
  html.querySelectorAll('script').forEach(s=>s.remove());root.append(...html.body.childNodes);
  for(const element of root.querySelectorAll('[href],[src]'))for(const attr of ['href','src'])if(element.hasAttribute(attr))element.setAttribute(attr,new URL(element.getAttribute(attr),url).href);
  const previous=current,fromId=previous?.url.pathname.split('/').filter(Boolean).at(-1),toId=url.pathname.split('/').filter(Boolean).at(-1);
  if(previous&&route(previous.url)==='library')libraryScroll=scrollY;
  const sharedName=container=>container.querySelector('#route')||container.querySelector('.log-row[data-id="'+CSS.escape(kind==='library'?fromId:toId)+'"] .recording-name-text');
  const named=[];
  const nameTitle=container=>{const element=sharedName(container);if(element){element.style.viewTransitionName='rv-route';named.push(element)}};
  // Snapshot only matched elements. The live document provides the dark backdrop throughout.
  const morph=previous&&document.startViewTransition&&!matchMedia('(prefers-reduced-motion: reduce)').matches&&!document.hidden;
  const update=async()=>{
   if(ticket!==revision)return;
   if(!pop){saveScroll();history[replace?'replaceState':'pushState']({},'',url)}
   const brand=previous&&host.querySelector('.app-brand');if(brand)root.querySelector('.app-brand')?.replaceWith(brand);
   previous?.scope.dispose();document.getElementById('pageBase').href=url.href;host.replaceChildren(root);libraryStyle.disabled=kind!=='library';
   const scope=pageScope(root,url,navigate);
   try{current={url,scope,api:module.mount(scope.env)}}catch(error){scope.dispose();throw error}
   document.title=html.title;notice.textContent='';
   // Bound the snapshot wait: unavailable APIs must never trap the user behind a transition.
   if(morph){let timer;await Promise.race([current.api.ready,new Promise(resolve=>timer=setTimeout(resolve,400))]);clearTimeout(timer)}
   if(ticket!==revision)return;
   scrollTo(0,pop?(history.state?.rvScroll||0):kind==='library'?libraryScroll:0);
   if(previous){const title=root.querySelector('h1');title.tabIndex=-1;title.focus({preventScroll:true})}
   dispatchEvent(new Event('pageshow'));
   if(morph){
    const target=sharedName(root);
    if(kind==='library'&&target){const box=target.getBoundingClientRect();if(box.bottom<0||box.top>innerHeight)target.scrollIntoView({block:'center'})}
    nameTitle(root);
   }
  };
  if(morph){
   nameTitle(host);document.documentElement.classList.add('rv-navigation-transition');
   const active=document.startViewTransition(update);transition=active;active.ready.catch(()=>{});
   const cleanup=()=>{named.forEach(element=>element.style.viewTransitionName='');if(transition===active){transition=null;document.documentElement.classList.remove('rv-navigation-transition')}};
   active.finished.then(cleanup,cleanup);await active.updateCallbackDone;
  }else await update();
 }catch(error){
  if(ticket!==revision||error.name==='AbortError')return;
  if(pop&&current)history.pushState({},'',current.url);
  notice.setAttribute('role','alert');notice.textContent=error.message||'화면을 불러오지 못했습니다.';
  const retry=document.createElement('button');retry.type='button';retry.textContent='다시 시도';retry.onclick=()=>navigate(url,{replace});notice.append(' ',retry);
 }
}
document.addEventListener('click',event=>{
 const link=event.target.closest('a[href]');if(!link||event.defaultPrevented||event.button!==0||event.ctrlKey||event.metaKey||event.shiftKey||event.altKey||link.target||link.hasAttribute('download'))return;
 const url=new URL(link.href);if(!route(url))return;event.preventDefault();void navigate(url);
});
addEventListener('popstate',()=>navigate(location.href,{pop:true}));
history.scrollRestoration='manual';
void navigate(location.href,{replace:true});
