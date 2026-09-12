/* Bounded diagnostic metadata only: never reads file contents or ingress URLs. */
'use strict';
window.pickerDiagnostics=(()=>{
 const version='0.2.37',queueKey='roadviewer-picker-events-v1',pendingKey='roadviewer-picker-pending-v1';
 const uuid=()=>globalThis.crypto?.randomUUID?.()||`${Date.now()}-${Math.random().toString(36).slice(2)}`;
 const page=uuid();let memory=[],sending=false,attempt=null,lastAttempt=null;
 const read=(key,fallback)=>{try{return JSON.parse(localStorage.getItem(key))||fallback}catch{return fallback}};
 const write=(key,value)=>{try{localStorage.setItem(key,JSON.stringify(value))}catch{}};
 const load=()=>{const q=read(queueKey,[]);return Array.isArray(q)?q:[]};
 const clean=s=>String(s||'').replace(/https?:\/\/[^\s]+/g,'[URL]').slice(0,300);
 function record(event,details={}){
  try{
   const item={id:uuid(),page,version,time:new Date().toISOString(),event,attempt:attempt?.id||lastAttempt,details};
   memory=[...memory,item].slice(-100);const q=load();write(queueKey,[...q,item].slice(-100));
   console.info('[RoadViewer picker]',item);void flush();
  }catch{}
 }
 async function flush(){
  if(sending||!navigator.onLine)return;sending=true;
  try{
   const combined=new Map([...load(),...memory].map(e=>[e.id,e]));const batch=[];let size=0;
   for(const item of combined.values()){const n=new TextEncoder().encode(JSON.stringify(item)).length;if(size+n>24000)break;batch.push(item);size+=n}
   if(!batch.length)return;
   const response=await fetch('api/diagnostics',{method:'POST',headers:{'Content-Type':'application/json','X-RoadViewer-Request':'1'},body:JSON.stringify({events:batch}),keepalive:true});
   if(!response.ok)throw Error('diagnostics '+response.status);
   const ids=new Set(batch.map(e=>e.id));memory=memory.filter(e=>!ids.has(e.id));write(queueKey,load().filter(e=>!ids.has(e.id)));
   const label=document.getElementById('diagnosticStatus');if(label)label.textContent='진단 기록이 서버에 저장되었습니다.';
  }catch{const label=document.getElementById('diagnosticStatus');if(label)label.textContent='서버 전송 대기 중 · 이 기기에 진단 기록을 보관합니다.'}
  finally{sending=false}
 }
 const describe=input=>({picker:input.id,multiple:input.multiple,accept:input.accept,directory:input.webkitdirectory===true,disabled:input.disabled});
 for(const id of ['files']){
  const input=document.getElementById(id);
  input.addEventListener('pointerdown',e=>record('picker_pointerdown',{...describe(input),pointerType:e.pointerType}));
  input.addEventListener('click',e=>{
   attempt={id:uuid(),picker:id,time:Date.now()};lastAttempt=attempt.id;write(pendingKey,{...attempt,page});
   record('picker_open',{...describe(input),trusted:e.isTrusted,userActive:navigator.userActivation?.isActive??null});
  },true);
  for(const event of ['change','cancel'])input.addEventListener(event,()=>{
   const files=Array.from(input.files||[]);
   record('picker_'+event,{...describe(input),elapsedMs:attempt?Date.now()-attempt.time:null,count:files.length,filesTruncated:files.length>20,files:files.slice(0,20).map(f=>({name:f.name.slice(0,180),size:f.size,type:f.type.slice(0,100),hasRelativePath:!!f.webkitRelativePath}))});
   write(pendingKey,null);attempt=null;
  },true);
 }
 const previous=read(pendingKey,null);
 record('page_load',{userAgent:navigator.userAgent.slice(0,400),platform:navigator.platform,embedded:window!==window.top,navigation:performance.getEntriesByType('navigation')[0]?.type||'unknown',previousAttempt:previous,visibility:document.visibilityState});
 for(const event of ['focus','blur','pageshow','pagehide','online'])window.addEventListener(event,e=>{
  record(event,{visibility:document.visibilityState,persisted:e.persisted??null,pending:attempt?.picker||null});
  if(event==='focus')setTimeout(()=>{if(attempt)record('picker_result_pending',{picker:attempt.picker,elapsedMs:Date.now()-attempt.time})},1500);
 });
 document.addEventListener('visibilitychange',()=>record('visibility',{state:document.visibilityState,pending:attempt?.picker||null}));
 window.addEventListener('error',e=>record('script_error',{message:clean(e.message),line:e.lineno||null}));
 window.addEventListener('unhandledrejection',e=>record('unhandled_rejection',{message:clean(e.reason?.message||e.reason)}));
 setInterval(flush,5000);
 document.getElementById('diagnosticExport').addEventListener('click',()=>record('export_requested'));
 return {record,flush};
})();
