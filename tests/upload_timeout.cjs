const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const source=fs.readFileSync('roadviewer/app/web/library.js','utf8');
const functions=source.slice(source.indexOf('function abortable('),source.indexOf("$('upload').onclick"));
let now=0,nextTimer=0,mode='idle',requests=[],reports=[],aborts=0;
const timers=new Map();
class UploadRequest{
 constructor(){this.upload={};requests.push(this)}
 open(method,url){this.method=method;this.url=url}
 setRequestHeader(){}
 send(body){
  this.body=body;
  queueMicrotask(()=>{
   if(mode==='idle')return;
   this.upload.onprogress({loaded:body.byteLength});this.upload.onload();
   if(mode==='lost-response'&&requests.length===1)return;
   if(mode==='proxy'&&requests.length===1)return this.respond(502,'<html>Bad gateway</html>');
   if(mode==='network'&&requests.length===1)return this.onerror();
   if(mode==='conflict')return this.respond(409,JSON.stringify({error:'offset conflict'}));
   this.respond(200,JSON.stringify({received:3}));
  });
 }
 respond(status,text){this.status=status;this.responseText=text;this.onload()}
 abort(){aborts++;this.onabort?.()}
}
const context=vm.createContext({AbortController,TypeError,Error,Blob,URL,Date:{now:()=>now},XMLHttpRequest:UploadRequest,location:{href:'https://rv.test/'},document:{visibilityState:'visible'},$:()=>({}),setTimeout:(fn,ms)=>{const id=++nextTimer;timers.set(id,{at:now+ms,fn});return id},clearTimeout:id=>timers.delete(id),fetch:async(url,options)=>{
 if(url.endsWith('/failure')){reports.push(JSON.parse(options.body));return {}}
 return new Promise((resolve,reject)=>options.signal.addEventListener('abort',()=>reject(Error('aborted'))));
}});
vm.runInContext(functions,context);
const flush=async()=>{for(let i=0;i<20;i++)await Promise.resolve()};
async function advance(ms){
 const until=now+ms;
 for(;;){const next=[...timers].sort((a,b)=>a[1].at-b[1].at)[0];if(!next||next[1].at>until)break;now=next[1].at;timers.delete(next[0]);next[1].fn();await flush()}
 now=until;await flush();
}
const url='api/uploads/'+ 'a'.repeat(32)+'/files/0?offset=0';
function run(expression){return vm.runInContext(expression,context).then(value=>({value}),error=>({error}))}
function reset(nextMode){assert.equal(timers.size,0);mode=nextMode;requests=[];reports=[];aborts=0}
const chunk=()=>run(`sendUploadChunk('${url}',new Uint8Array(3).buffer,undefined,()=>{})`);
const part=()=>run(`uploadPart('${url}',new Blob(['log']))`);
(async()=>{
 let result=chunk();await flush();await advance(14999);assert.equal(aborts,0);await advance(1);
 assert.equal((await result).error.code,'upload_idle_timeout');assert.equal(aborts,1);assert.equal((await result).error.stage,'chunk-send');
 // A transfer lasting over 60 seconds is healthy while bytes keep progressing.
 reset('idle');result=chunk();await flush();
 for(let bytes=1;bytes<=8;bytes++){await advance(10000);requests[0].upload.onprogress({loaded:bytes});assert.equal(aborts,0)}
 requests[0].upload.onload();await advance(5000);requests[0].respond(200,'{"received":8}');assert.equal((await result).value.received,8);
 // Fully sent, but no acknowledgement: retry the identical bytes and offset after 15s + 1s.
 reset('lost-response');result=part();await flush();await advance(15000);assert.equal(requests.length,1);await advance(1000);
 assert.equal((await result).value.received,3);assert.equal(requests.length,2);assert.strictEqual(requests[0].body,requests[1].body);assert.equal(requests[0].url,requests[1].url);
 assert.equal(reports[0].stage,'chunk-response');assert.equal(reports[0].errorCode,'upload_idle_timeout');assert.equal(reports[0].elapsedMs,15000);assert.equal(reports[0].loaded,3);
 for(const retryMode of ['proxy','network']){
  reset(retryMode);result=part();await flush();await advance(1000);assert.equal((await result).value.received,3);assert.equal(requests.length,2);
 }
 reset('conflict');result=part();await flush();assert.match((await result).error.message,/offset conflict/);assert.equal(requests.length,1);
 reset('idle');result=part();await flush();await advance(200000);assert.match((await result).error.message,/15초/);assert.equal(requests.length,6);assert.equal(reports.length,6);
 reset('idle');result=run(`uploadPart('${url}',{arrayBuffer:async()=>{throw Error('read failed')}})`);await flush();assert.match((await result).error.message,/파일을 읽을 수 없습니다/);assert.equal(requests.length,0);assert.equal(reports[0].stage,'file-read');
 reset('idle');context.controller=new AbortController();result=run(`uploadPart('${url}',new Blob(['log']),controller.signal)`);await flush();context.controller.abort();await flush();assert.equal((await result).error.name,'AbortError');assert.equal(aborts,1);assert.equal(reports.length,0);
 reset('idle');result=run("api('api/uploads')");await flush();await advance(60000);assert.match((await result).error.message,/응답이 지연/);
 reset('idle');result=run("api('api/uploads/id/finish')");await flush();await advance(179999);assert.equal(timers.size,1);await advance(1);assert.match((await result).error.message,/응답이 지연/);assert.equal(timers.size,0);
 console.log('PASS: 15s idle detection, slow progress, lost acknowledgement retry, errors, cancellation and unchanged registration timeout');
})().catch(e=>{console.error(e);process.exitCode=1});
