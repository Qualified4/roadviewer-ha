const fs=require('fs'),os=require('os'),path=require('path'),assert=require('node:assert/strict'),{spawn}=require('child_process'),{once}=require('events'),{chromium}=require('playwright');
// Media state badges, the NAS block of the storage panel and the replay notice, against the real server.
const SERVER=`import sys
sys.path.insert(0,'roadviewer/app')
import server
from werkzeug.serving import make_server
from werkzeug.middleware.dispatcher import DispatcherMiddleware
http=make_server('127.0.0.1',0,DispatcherMiddleware(server.app,{'/api/hassio_ingress/test':server.app}),threaded=True)
print('READY '+str(http.server_port),flush=True)
http.serve_forever()`;
const videos={front:{start:0,duration:2,frames:20}};
function recording(dir,id,i,{storage,video}={}){
 const folder=path.join(dir,id);fs.mkdirSync(path.join(folder,'prepared'),{recursive:true});
 fs.writeFileSync(path.join(folder,'rlog.zst'),'fixture-'+i);
 if(video)fs.copyFileSync(process.env.RV_TEST_VIDEO||'/tmp/roadviewer-test.mp4',path.join(folder,'fcamera.mp4'));
 fs.writeFileSync(path.join(folder,'meta.json'),JSON.stringify({id,status:'ready',name:`00000395--0d0eda17c5 / 구간 ${i}`,uploaded:2-i,files:{},video:!!(video||storage),decoder_version:'v28-runtime-geometry',...(storage?{storage}:{})}));
 fs.writeFileSync(path.join(folder,'prepared/data.json'),JSON.stringify({route:'아카이브 테스트',key:'archive',duration:2,warnings:[],video:storage||video?videos.front:null,videos:storage||video?videos:undefined,defaultVideo:storage||video?'front':undefined,frames:Array.from({length:41},(_,f)=>({t:f/20,id:f,valid:true,lanes:[],edges:[],lp:[],es:[],leads:[]}))}));
}
async function serve(dir,env){
 const python=spawn(process.env.RV_PYTHON||'python',['-u','-c',SERVER],{env:{...process.env,RV_DATA:dir,RV_INGRESS_ONLY:'0',...env},stdio:['ignore','pipe','pipe']});
 let stderr='';python.stderr.on('data',x=>stderr+=x);
 const port=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('Server timeout '+stderr)),15000);python.once('exit',code=>{clearTimeout(timer);reject(Error('Server exit '+code+stderr))});python.stdout.on('data',x=>{const m=/READY (\d+)/.exec(String(x));if(m){clearTimeout(timer);resolve(Number(m[1]))}})});
 return {python,base:`http://127.0.0.1:${port}/api/hassio_ingress/test/`,stderr:()=>stderr};
}
async function stop(server){if(server?.python.exitCode===null){server.python.kill();await once(server.python,'exit')}}
(async()=>{
 const temp=fs.mkdtempSync(path.join(os.tmpdir(),'rv-archive-ui-')),onDir=path.join(temp,'on'),offDir=path.join(temp,'off'),nas=path.join(temp,'nas-share-secret');
 for(const dir of [onDir,offDir,nas])fs.mkdirSync(dir);
 const ids=['a'.repeat(32),'b'.repeat(32)];
 for(const dir of [onDir,offDir])fs.writeFileSync(path.join(dir,'.processing-settings.json'),JSON.stringify({auto_convert:false}));
 // A local copy of the storage id but no sentinel on the share: the archive must read as unreachable, never be re-claimed.
 fs.writeFileSync(path.join(onDir,'.archive.json'),JSON.stringify({storage_id:'c'.repeat(32)}));
 recording(onDir,ids[0],0,{storage:{'fcamera.mp4':{location:'nas',bytes:9}}});recording(onDir,ids[1],1);
 recording(offDir,ids[0],0,{video:true});recording(offDir,ids[1],1);
 let on,off,browser;
 try{
  on=await serve(onDir,{RV_ARCHIVE_OPTIONS_JSON:JSON.stringify({archive_enabled:true,archive_path:nas}),RV_ARCHIVE_ALLOW_ANY_PATH:'1'});
  browser=await chromium.launch({headless:true});
  const context=await browser.newContext({viewport:{width:1280,height:900},reducedMotion:'reduce'}),page=await context.newPage(),errors=[],runs=[];
  page.on('pageerror',error=>errors.push(error.message));
  page.on('response',response=>{if(response.url().endsWith('/api/settings/archive/run'))runs.push([response.request().method(),response.request().headers()['x-roadviewer-request'],response.status()])});
  const row=id=>page.locator(`.log-row[data-id="${id}"] .log-meta`);
  await page.goto(on.base);await page.locator('.log-row').first().waitFor();
  assert.match(await row(ids[0]).textContent(),/ · 저장소 연결 불가$/);
  assert.equal(await row(ids[0]).locator('span.media-state.media-state-storage_unavailable').textContent(),'저장소 연결 불가');
  assert.match(await row(ids[1]).textContent(),/ · 영상 없음$/);assert.equal(await row(ids[1]).locator('.media-state').count(),0,'local-only rows keep the plain text');
  await page.locator('#storageSettings summary').click();await page.locator('#storageUsage>.archive-metric').nth(3).waitFor();
  const metrics=await page.locator('#storageUsage>div').evaluateAll(rows=>rows.map(row=>[row.querySelector('dt').textContent,row.querySelector('dd').textContent]));
  assert.equal(metrics.length,8);assert.deepEqual(metrics.slice(4).map(([label])=>label),['NAS 상태','NAS 사용 중','NAS 여유','마지막 아카이브']);
  assert.deepEqual(metrics[4],['NAS 상태','연결 불가']);assert.deepEqual(metrics[7],['마지막 아카이브','—']);
  assert(await page.locator('#archiveRun').isEnabled());
  await page.getByRole('button',{name:'지금 아카이브',exact:true}).click();
  await page.waitForFunction(()=>document.getElementById('storageStatus').textContent==='아카이브를 시작했습니다.');
  assert.deepEqual(runs,[['POST','1',202]]);
  assert(!(await page.content()).includes('nas-share-secret'),'the share path never reaches the page');
  // Replay: the front video is on the unreachable share; the notice shows and the log still plays.
  await page.goto(on.base+'view/'+ids[0]+'/');
  await page.waitForFunction(()=>document.getElementById('errorText')?.textContent==='영상 저장소에 연결할 수 없습니다. NAS 연결을 확인하세요.'&&!document.getElementById('error').hidden);
  await page.waitForFunction(()=>!document.getElementById('play').disabled&&!document.getElementById('playbackControls').hidden);
  assert(await page.locator('#noVideo').isVisible());assert(await page.locator('#video').isHidden());
  await page.locator('#play').click();await page.waitForFunction(()=>Number(document.getElementById('seek').value)>.3);
  assert(!(await page.content()).includes('nas-share-secret'));
  assert.deepEqual(errors,[]);
  await stop(on);on=null;
  // Archiving off (no test options): the list text and the four storage metrics are exactly as before.
  off=await serve(offDir,{});
  const plain=await context.newPage();plain.on('pageerror',error=>errors.push(error.message));
  await plain.goto(off.base);await plain.locator('.log-row').first().waitFor();
  const plainRow=id=>plain.locator(`.log-row[data-id="${id}"] .log-meta`);
  assert.match(await plainRow(ids[0]).textContent(),/ · 영상 있음$/);assert.match(await plainRow(ids[1]).textContent(),/ · 영상 없음$/);
  assert.equal(await plain.locator('.media-state').count(),0);
  assert.equal(await plainRow(ids[0]).evaluate(meta=>meta.childElementCount),0,'meta stays a single text node');
  await plain.locator('#storageSettings summary').click();await plain.waitForFunction(()=>!document.getElementById('storageSave').disabled);
  assert.deepEqual(await plain.locator('#storageUsage>div dt').allTextContents(),['사용 중','설정 한도','디스크 여유','업로드 예약']);
  assert.equal(await plain.locator('#archiveRun').count(),0);assert.equal(await plain.locator('#storageStatus').textContent(),'');
  assert.deepEqual(errors,[]);
  console.log('PASS: media state badges, NAS status panel with manual archive run, replay storage notice, archiving-off UI unchanged');
 }finally{await browser?.close();await stop(on);await stop(off);fs.rmSync(temp,{recursive:true,force:true})}
})().catch(error=>{console.error(error);process.exitCode=1});
