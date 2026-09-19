const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const source=fs.readFileSync('roadviewer/app/web/library.js','utf8');
const functions=source.slice(source.indexOf('async function api('),source.indexOf("$('upload').onclick"));
let mode='timeout',calls=0,cleared=0;
const context=vm.createContext({AbortController,TypeError,Error,Blob,URL,location:{href:"https://rv.test/"},document:{visibilityState:"visible"},$:()=>({}),setTimeout:fn=>setTimeout(fn,5),clearTimeout:id=>{cleared++;clearTimeout(id)},fetch:async(url,options)=>{
 calls++;
 if(mode==='timeout')return new Promise((resolve,reject)=>options.signal.addEventListener('abort',()=>reject(Error('aborted'))));
 if(mode==='recover'&&calls===1)throw new TypeError('connection lost');
 if(mode==='proxy'&&calls===1)return {ok:false,status:502,text:async()=>'<html>Bad Gateway</html>'};
 return {ok:mode!=='conflict',status:mode==='conflict'?409:200,text:async()=>JSON.stringify(mode==='conflict'?{error:'offset conflict'}:{received:3})};
}});
vm.runInContext(functions,context);
(async()=>{
 await assert.rejects(vm.runInContext("uploadPart('api/uploads/a/files/0?offset=0',new Blob(['log']))",context),/업로드 응답/);
 assert.equal(calls,6);assert.equal(cleared,7);
 calls=0;mode='recover';
 assert.equal((await vm.runInContext("uploadPart('api/uploads/a/files/0?offset=0',new Blob(['log']))",context)).received,3);assert.equal(calls,2);
 calls=0;mode='proxy';
 assert.equal((await vm.runInContext("uploadPart('api/uploads/a/files/0?offset=0',new Blob(['log']))",context)).received,3);assert.equal(calls,2);
 calls=0;mode='conflict';
 await assert.rejects(vm.runInContext("uploadPart('api/uploads/a/files/0?offset=0',new Blob(['log']))",context),/offset conflict/);assert.equal(calls,1);
 await assert.rejects(vm.runInContext("uploadPart('api/uploads/a/files/0?offset=0',{arrayBuffer:async()=>{throw Error('read failed')}})",context),/파일을 읽을 수 없습니다/);
 console.log('upload timeout and retry tests passed');
})().catch(e=>{console.error(e);process.exitCode=1});
