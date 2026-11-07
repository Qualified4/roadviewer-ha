import {pageScope} from './page-scope.js';
const host=document.getElementById('pageHost'),notice=document.getElementById('navigationStatus'),assets=new URL('./',import.meta.url),version=new URL(import.meta.url).search;
const base=new URL('../',assets),libraryStyle=document.getElementById('libraryStyle');
let current=null,revision=0,pending=null,libraryScroll=0;
// The library's page shell is static per version: fetch it ahead (when idle on a replay) so going back skips a round trip.
const shells=new Map();
function shell(url,kind,signal){
 const request=new URL(url);request.searchParams.set('fragment','1');
 if(kind!=='library')return fetch(request,{signal,cache:'no-store'}).then(r=>{if(!r.ok)throw Error('화면을 불러오지 못했습니다. 다시 시도해 주세요.');return r.text()});
 const key=request.pathname+request.search;
 if(!shells.has(key))shells.set(key,fetch(request,{cache:'no-store'}).then(r=>{if(!r.ok)throw Error('화면을 불러오지 못했습니다. 다시 시도해 주세요.');return r.text()}).catch(e=>{shells.delete(key);throw e}));
 return shells.get(key);
}
function prefetchLibrary(){const idle=window.requestIdleCallback||(f=>setTimeout(f,800));idle(()=>{shell(base,'library').catch(()=>{});import(new URL('page-library.js'+version,assets)).catch(()=>{})})}
// A slim progress line shows that a tap started a page change when it takes more than a moment.
let busyTimer=0;
function busy(on){clearTimeout(busyTimer);if(on)busyTimer=setTimeout(()=>document.documentElement.classList.add('rv-navigating'),120);else document.documentElement.classList.remove('rv-navigating')}
// Library tabs live in the hash (#upload, #storage …): a hash-only change stays on the mounted page.
const samePage=url=>!!current&&url.origin===current.url.origin&&url.pathname===current.url.pathname&&url.search===current.url.search;
const route=url=>url.origin===base.origin&&(url.pathname===base.pathname?'library':new RegExp('^'+base.pathname.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'view/[^/]+/$').test(url.pathname)?'replay':null);
function saveScroll(){history.replaceState({...history.state,rvScroll:scrollY},'',location.href)}
async function navigate(to,{replace=false,pop=false}={}){
 const url=new URL(to,location.href),kind=route(url);if(!kind)return;
 if(current&&!current.api.canLeave()){
  notice.textContent='업로드 또는 정리 작업이 끝난 뒤 이동해 주세요.';
  if(pop)history.pushState({},'',current.url);return;
 }
 const ticket=++revision;pending?.abort();
 pending=new AbortController();notice.setAttribute('role','status');notice.textContent='';
 try{
  busy(true);
  const [text,module]=await Promise.all([shell(url,kind,pending.signal),import(new URL('page-'+kind+'.js'+version,assets))]);
  const html=new DOMParser().parseFromString(text,'text/html');if(ticket!==revision)return;
  if(!html.querySelector('main')||!html.body.classList.contains(kind==='library'?'library-page':'replay-page'))throw Error('예상하지 못한 응답입니다. 연결 상태를 확인해 주세요.');
  const root=document.createElement('div');root.className=html.body.className;
  html.querySelectorAll('script').forEach(s=>s.remove());root.append(...html.body.childNodes);
  for(const element of root.querySelectorAll('[href],[src]'))for(const attr of ['href','src'])if(element.hasAttribute(attr))element.setAttribute(attr,new URL(element.getAttribute(attr),url).href);
  const previous=current;
  if(previous&&route(previous.url)==='library')libraryScroll=scrollY;
  // Prepare the next page out of view while the current page remains painted.
  root.hidden=true;host.append(root);
  const scope=pageScope(root,url,navigate);let api;
  try{
   api=module.mount(scope.env);
   if(previous){let timer;try{await Promise.race([api.ready,new Promise(resolve=>timer=setTimeout(resolve,400))])}finally{clearTimeout(timer)}}
   if(ticket!==revision){scope.dispose();root.remove();return}
  }catch(error){scope.dispose();root.remove();throw error}
  const brand=previous&&host.querySelector('.app-brand');
  if(!pop){saveScroll();history[replace?'replaceState':'pushState']({},'',url)}
  if(brand)root.querySelector('.app-brand')?.replaceWith(brand);
  previous?.scope.dispose();document.getElementById('pageBase').href=url.href;
  host.replaceChildren(root);root.hidden=false;libraryStyle.disabled=kind!=='library';current={url,scope,api};
  document.title=html.title;notice.textContent='';
  scrollTo(0,pop?(history.state?.rvScroll||0):kind==='library'?libraryScroll:0);
  if(previous){const title=root.querySelector('h1');title.tabIndex=-1;title.focus({preventScroll:true})}
  dispatchEvent(new Event('pageshow'));busy(false);
  if(kind==='replay')prefetchLibrary();

 }catch(error){
  if(ticket!==revision||error.name==='AbortError')return;
  busy(false);
  if(pop&&current)history.pushState({},'',current.url);
  notice.setAttribute('role','alert');notice.textContent=error.message||'화면을 불러오지 못했습니다.';
  const retry=document.createElement('button');retry.type='button';retry.textContent='다시 시도';retry.onclick=()=>navigate(url,{replace});notice.append(' ',retry);
 }
}
document.addEventListener('click',event=>{
 const link=event.target.closest('a[href]');if(!link||event.defaultPrevented||event.button!==0||event.ctrlKey||event.metaKey||event.shiftKey||event.altKey||link.target||link.hasAttribute('download'))return;
 const url=new URL(link.href);if(!route(url)||(url.hash&&samePage(url)))return;event.preventDefault();void navigate(url);
});
addEventListener('popstate',()=>{if(location.hash&&samePage(new URL(location.href)))return;void navigate(location.href,{pop:true})});
history.scrollRestoration='manual';
void navigate(location.href,{replace:true});
