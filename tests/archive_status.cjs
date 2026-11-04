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
 const ids=['a'.repeat(32),'b'.repeat(32),'d'.repeat(32),'e'.repeat(32)];
 for(const dir of [onDir,offDir])fs.writeFileSync(path.join(dir,'.processing-settings.json'),JSON.stringify({auto_convert:false}));
 // A local copy of the storage id but no sentinel on the share: the archive must read as unreachable, never be re-claimed.
 fs.writeFileSync(path.join(onDir,'.archive.json'),JSON.stringify({storage_id:'c'.repeat(32)}));
 recording(onDir,ids[0],0,{storage:{'fcamera.mp4':{location:'nas',bytes:9}}});recording(onDir,ids[1],1);
 // Mixed (front available locally, low-res removed by NAS cleanup) and all removed.
 recording(onDir,ids[2],2,{video:true,storage:{'camera.mp4':{location:'removed',removed_at:1,reason:'nas_full'}}});
 recording(onDir,ids[3],3,{storage:{'fcamera.mp4':{location:'removed',removed_at:1,reason:'nas_full'}}});
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
  assert.equal(await row(ids[2]).locator('span.media-state.media-state-available').textContent(),'영상 있음','an available camera outranks a missing one');
  assert.equal(await row(ids[3]).locator('span.media-state.media-state-missing').textContent(),'영상 없음','every camera missing');
  await page.locator('#storageSettings > summary').click();await page.locator('#archiveUsage>.archive-metric').first().waitFor();
  const metrics=await page.locator('#storageUsage>div,#archiveUsage>div,#archiveSecondaryUsage>div').evaluateAll(rows=>rows.map(row=>[row.querySelector('dt').textContent,row.querySelector('dd').textContent]));
  assert.equal(metrics.length,9);assert.deepEqual(metrics.slice(4).map(([label])=>label),['NAS 상태','NAS 사용 중','NAS 여유','마지막 아카이브','최근 실행 결과']);
  assert.deepEqual(metrics[4],['NAS 상태','연결 불가']);assert.deepEqual(metrics[7],['마지막 아카이브','—']);
  assert(await page.locator('#archiveRun').isEnabled());
  // 'Move everything': a confirmation with the server's plan first; cancelling changes nothing.
  await page.getByRole('button',{name:'이동 가능한 데이터 모두 이동',exact:true}).click();
  const dialog=page.locator('#archiveAllDialog');await dialog.waitFor({state:'visible'});
  const plan=await page.locator('#archiveAllSummary>div').evaluateAll(rows=>Object.fromEntries(rows.map(row=>[row.querySelector('dt').textContent,row.querySelector('dd').textContent])));
  assert.equal(plan['처리할 파일'],'5개');assert.equal(plan['주행 구간'],'4개');assert.equal(plan['로컬 원본 삭제'],'검증 후 삭제');assert(plan['예상 로컬 확보 용량']);
  assert.match(await page.locator('#archiveAllDelete').textContent(),/이 기기에서 삭제됩니다/);
  assert.equal(await page.locator('#archiveAllConfirm').textContent(),'5개 파일 이동');
  await page.locator('#archiveAllCancel').click();await dialog.waitFor({state:'hidden'});
  assert.deepEqual(runs,[['GET','1',200]]);
  // Confirmed: the run starts, and the unreachable share stops it safely with the files kept.
  await page.locator('#archiveRun').click();await dialog.waitFor({state:'visible'});await page.locator('#archiveAllConfirm').click();
  await page.waitForFunction(()=>/^중단됨: NAS에 연결할 수 없습니다\./.test(document.getElementById('archiveJobText').textContent));
  assert.deepEqual(runs.slice(1),[['GET','1',200],['POST','1',202]]);
  assert(fs.existsSync(path.join(onDir,ids[1],'rlog.zst')),'nothing moved while the share is unreachable');
  // While a run is active (as the server reports it), progress shows and the settings are locked.
  await page.route('**/api/settings/storage',async route=>{const response=await route.fetch(),body=await response.json();body.archive={...body.archive,running:true,manual_active:true,manual:{state:'running',mode:'move',total_files:5,processed:2,succeeded:2,failed:0,freed_bytes:0,waiting:null}};await route.fulfill({response,json:body})});
  await page.locator('#storageSettings > summary').click();await page.locator('#storageSettings > summary').click();
  await page.waitForFunction(()=>document.getElementById('archiveJobText').textContent.startsWith('이동 중 · 2/5개 파일 처리'));
  assert(await page.locator('#storageEditorFields').evaluate(f=>f.disabled));assert(await page.locator('#archiveIntervalPreset').isDisabled());assert(await page.locator('#archiveRun').isDisabled());
  assert.equal(await page.locator('#archiveJobProgress').evaluate(bar=>[bar.value,bar.max].join('/')),'2/5');
  await page.unroute('**/api/settings/storage');
  await page.locator('#storageSettings > summary').click();await page.locator('#storageSettings > summary').click();
  await page.waitForFunction(()=>!document.getElementById('storageEditorFields').disabled&&document.getElementById('archiveRun')&&!document.getElementById('archiveRun').disabled);
  // A run already in progress (409) is explained in Korean and the button is usable again.
  await page.route('**/api/settings/archive/run',route=>route.fulfill({status:409,json:{error:'archive_running'}}));
  await page.locator('#archiveRun').click();
  await page.waitForFunction(()=>document.getElementById('storageStatus').textContent==='아카이빙이 이미 실행 중입니다. 끝난 뒤 다시 시도하세요.');
  assert(await page.locator('#archiveRun').isEnabled());await page.unroute('**/api/settings/archive/run');
  // 'checking' (the server probing in the background) is not left on screen: the panel asks again until it settles.
  let storageCalls=0;
  await page.route('**/api/settings/storage',async route=>{const response=await route.fetch(),body=await response.json();if(++storageCalls===1)body.archive={...body.archive,state:'checking',reason:'probe_pending'};await route.fulfill({response,json:body})});
  await page.locator('#storageSettings > summary').click();await page.locator('#storageSettings > summary').click();
  await page.waitForFunction(()=>document.querySelector('#archiveUsage .archive-metric[data-kind="state"] dd')?.textContent==='확인 중');
  await page.waitForFunction(()=>document.querySelector('#archiveUsage .archive-metric[data-kind="state"] dd')?.textContent==='연결 불가',null,{timeout:10000});
  assert(storageCalls>=2);await page.unroute('**/api/settings/storage');
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
  await plain.locator('#storageSettings > summary').click();await plain.waitForFunction(()=>document.getElementById('archiveForm').dataset.loaded==='true');
  assert.deepEqual(await plain.locator('#storageUsage>div dt').allTextContents(),['사용 중','설정 한도','디스크 여유','업로드 예약']);
  assert.equal(await plain.locator('#archiveRun').count(),0);assert.equal(await plain.locator('#storageStatus').textContent(),'');
  assert.deepEqual(errors,[]);
  console.log('PASS: media state badges, NAS status panel with confirmed move-all run and progress, settled checking state, replay storage notice, archiving-off UI unchanged');
 }finally{await browser?.close();await stop(on);await stop(off);fs.rmSync(temp,{recursive:true,force:true})}
})().catch(error=>{console.error(error);process.exitCode=1});
