const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const source=fs.readFileSync('roadviewer/app/web/library.js','utf8');
const functions=source.slice(source.indexOf('async function api('),source.indexOf("$('upload').onclick"));
let mode='timeout',calls=0,cleared=0;
const context=vm.createContext({AbortController,TypeError,Error,setTimeout:fn=>setTimeout(fn,5),clearTimeout:id=>{cleared++;clearTimeout(id)},fetch:async(url,options)=>{
 calls++;
 if(mode==='timeout')return new Promise((resolve,reject)=>options.signal.addEventListener('abort',()=>reject(Error('aborted'))));
 if(mode==='recover'&&calls===1)throw new TypeError('connection lost');
 return {ok:mode!=='conflict',status:mode==='conflict'?409:200,text:async()=>JSON.stringify(mode==='conflict'?{error:'offset conflict'}:{received:3})};
}});
vm.runInContext(functions,context);
(async()=>{
 await assert.rejects(vm.runInContext("uploadPart('api/uploads/a/files/0?offset=0','log')",context),/업로드 응답/);
 assert.equal(calls,3);assert.equal(cleared,3);
 calls=0;mode='recover';
 assert.equal((await vm.runInContext("uploadPart('api/uploads/a/files/0?offset=0','log')",context)).received,3);assert.equal(calls,2);
 calls=0;mode='conflict';
 await assert.rejects(vm.runInContext("uploadPart('api/uploads/a/files/0?offset=0','log')",context),/offset conflict/);assert.equal(calls,1);
 console.log('upload timeout and retry tests passed');
})().catch(e=>{console.error(e);process.exitCode=1});
