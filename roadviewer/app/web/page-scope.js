// Resources belong to one mounted page; old asynchronous work must never address the next page.
export function pageScope(root,url,navigate){
 const controller=new AbortController(),timers=new Set(),intervals=new Set(),frames=new Set(),observers=new Set(),requests=new Set(),transitions=new Set();
 let active=true;
 const live=callback=>(...args)=>{if(active)return callback(...args)};
 const listen=(target,type,callback,options)=>target.addEventListener(type,callback,{...(typeof options==='boolean'?{capture:options}:options),signal:controller.signal});
 const scopedWindow=Object.create(null);
 const windowProxy=new Proxy(window,{
  get(target,key){
   if(key in scopedWindow)return scopedWindow[key];
   if(key==='addEventListener')return (...args)=>listen(window,...args);
   const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;
  },
  set(target,key,value){scopedWindow[key]=value;return true}
 });
 // Overflow locks still belong to the viewport, while classes and CSS variables belong to this page.
 const bodyStyle=new Proxy(root.style,{get(target,key){if(key==='overflow')return document.body.style.overflow;const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value},set(target,key,value){if(key==='overflow'){if(active)document.body.style.overflow=value}else target[key]=value;return true}});
 const body=new Proxy(root,{get(target,key){if(key==='style')return bodyStyle;const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value}});
 const doc=new Proxy(document,{
  get(target,key){
   if(key==='startViewTransition'&&target.startViewTransition)return update=>{const transition=target.startViewTransition(update);transitions.add(transition);transition.finished.then(()=>transitions.delete(transition),()=>transitions.delete(transition));return transition};
   if(key==='body')return body;
   if(key==='hidden')return !active||target.hidden;
   if(key==='getElementById')return id=>root.querySelector('#'+CSS.escape(id));
   if(key==='querySelector'||key==='querySelectorAll')return root[key].bind(root);
   if(key==='addEventListener')return (type,...args)=>listen(type==='visibilitychange'?document:root,type,...args);
   const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;
  },
  set(target,key,value){if(String(key).startsWith('on'))root[key]=value;return true}
 });
 const timer=(repeat,callback,delay,...args)=>{
  if(!active)return 0;const set=repeat?intervals:timers;
  const id=(repeat?setInterval:setTimeout)(()=>{if(!repeat)set.delete(id);if(active)callback(...args)},delay);set.add(id);return id;
 };
 const observer=Type=>class extends Type{constructor(callback){super(live(callback));observers.add(this)}};
 const env={window:windowProxy,document:doc,location:{href:url.href,pathname:url.pathname,origin:url.origin,search:url.search,assign:to=>navigate(new URL(to,url)),reload:()=>navigate(url,{replace:true})},
  fetch:(input,options={})=>fetch(new URL(input,url),{...options,signal:options.signal?AbortSignal.any([controller.signal,options.signal]):controller.signal}),
  setTimeout:(...args)=>timer(false,...args),clearTimeout:id=>{timers.delete(id);clearTimeout(id)},
  setInterval:(...args)=>timer(true,...args),clearInterval:id=>{intervals.delete(id);clearInterval(id)},
  requestAnimationFrame:callback=>{if(!active)return 0;const id=requestAnimationFrame(time=>{frames.delete(id);if(active)callback(time)});frames.add(id);return id},
  cancelAnimationFrame:id=>{frames.delete(id);cancelAnimationFrame(id)},
  ResizeObserver:observer(ResizeObserver),MutationObserver:observer(MutationObserver),
  XMLHttpRequest:class extends XMLHttpRequest{constructor(){super();requests.add(this);this.addEventListener('loadend',()=>requests.delete(this))}open(method,path,...rest){super.open(method,new URL(path,url).href,...rest)}},
  matchMedia:query=>{const media=matchMedia(query);return new Proxy(media,{get(target,key){if(key==='addEventListener')return (...args)=>listen(target,...args);const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value}})}
 };
 return {env,dispose(){
  active=false;transitions.forEach(t=>t.skipTransition());controller.abort();timers.forEach(clearTimeout);intervals.forEach(clearInterval);frames.forEach(cancelAnimationFrame);observers.forEach(o=>o.disconnect());requests.forEach(r=>r.abort());
  root.getAnimations({subtree:true}).forEach(a=>a.cancel());
  for(const v of root.querySelectorAll('video')){v.pause();v.removeAttribute('src');v.load()}
  for(const d of root.querySelectorAll('dialog[open]'))d.close();
  document.body.style.overflow='';document.documentElement.classList.remove('rv-layout-transition');
 }};
}
