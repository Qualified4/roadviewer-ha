// Screen mode (자동/라이트/다크): loaded blocking in <head> so the first paint already has the right theme.
(()=>{
 const key='roadviewer-theme',root=document.documentElement,system=matchMedia('(prefers-color-scheme: light)');
 const modes=[['auto','자동','M12 3a9 9 0 1 0 0 18Z M12 3a9 9 0 0 1 0 18'],['light','라이트','M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8Z M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4'],['dark','다크','M20 14.5A8 8 0 0 1 9.5 4 8 8 0 1 0 20 14.5Z']];
 const read=()=>{try{const value=localStorage.getItem(key);return value==='light'||value==='dark'?value:'auto'}catch{return 'auto'}};
 const theme=mode=>mode==='auto'?(system.matches?'light':'dark'):mode;
 let shown=null;
 function apply(){
  const mode=read();
  if(mode==='auto')delete root.dataset.theme;else root.dataset.theme=mode;
  for(const button of document.querySelectorAll('.theme-switch [data-theme-mode]'))button.setAttribute('aria-pressed',String(button.dataset.themeMode===mode));
  const next=mode+':'+theme(mode);if(shown!==null&&next!==shown)dispatchEvent(new CustomEvent('rv:themechange',{detail:{mode,theme:theme(mode)}}));shown=next;
 }
 function set(mode){
  try{if(mode==='auto')localStorage.removeItem(key);else localStorage.setItem(key,mode)}catch{}
  apply();
 }
 // One shared segmented control; every copy (library header, replay menu) stays in sync through apply().
 function control(){
  const group=document.createElement('div');group.className='theme-switch';group.setAttribute('role','group');group.setAttribute('aria-label','화면 모드');
  const mode=read();
  for(const [value,label,icon] of modes){
   const button=document.createElement('button');button.type='button';button.dataset.themeMode=value;button.setAttribute('aria-pressed',String(value===mode));
   button.innerHTML=`<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${icon}"/></svg><span>${label}</span>`;
   button.onclick=()=>set(value);group.append(button);
  }
  return group;
 }
 system.addEventListener('change',apply);
 addEventListener('storage',event=>{if(event.key===key||event.key===null)apply()});
 apply();
 window.RoadViewerTheme={mode:read,theme:()=>theme(read()),set,control};
})();
