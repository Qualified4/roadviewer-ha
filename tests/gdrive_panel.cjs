const fs=require('fs'),os=require('os'),path=require('path'),assert=require('node:assert/strict'),{spawn}=require('child_process'),{once}=require('events'),{chromium}=require('playwright');
// The storage panel with Google Drive (tests/fake_drive.py in the server's process): backend and mode, signing in with
// the device code, disconnecting, the per-recording retry; with the NAS, nothing of Drive exists.
const SERVER=`import os, sys, threading
sys.path.insert(0,'tests');sys.path.insert(0,'roadviewer/app')
from fake_drive import FakeDrive
drive=FakeDrive().start()
# Google answers "pending" until the test grants (a line "grant" on stdin); it asks to poll every second.
drive.scenario.device_interval=1
drive.scenario.device_poll_responses=['authorization_pending']*100000
os.environ.update(drive.env())
import server
from werkzeug.serving import make_server
from werkzeug.middleware.dispatcher import DispatcherMiddleware
http=make_server('127.0.0.1',0,DispatcherMiddleware(server.app,{'/api/hassio_ingress/test':server.app}),threaded=True)
threading.Thread(target=http.serve_forever,daemon=True).start()
print('READY '+str(http.server_port),flush=True)
for line in sys.stdin:
    if line.strip()=='grant':
        with drive.lock: drive.scenario.device_poll_responses.clear()
    print('DONE '+line.strip(),flush=True)`;
function recording(dir,id,i,storage){
 const folder=path.join(dir,id);fs.mkdirSync(path.join(folder,'prepared'),{recursive:true});
 fs.writeFileSync(path.join(folder,'rlog.zst'),'fixture-'+i);
 fs.writeFileSync(path.join(folder,'meta.json'),JSON.stringify({id,status:'ready',name:`00000395--0d0eda17c5 / 구간 ${i}`,uploaded:2-i,files:{},video:false,decoder_version:'v28-runtime-geometry',...(storage?{storage}:{})}));
 fs.writeFileSync(path.join(folder,'prepared/data.json'),JSON.stringify({route:'Drive 테스트',key:'drive',duration:2,warnings:[],video:null,frames:Array.from({length:41},(_,f)=>({t:f/20,id:f,valid:true,lanes:[],edges:[],lp:[],es:[],leads:[]}))}));
}
async function serve(dir,env){
 const python=spawn(process.env.RV_PYTHON||'python',['-u','-c',SERVER],{env:{...process.env,RV_DATA:dir,RV_INGRESS_ONLY:'0',...env},stdio:['pipe','pipe','pipe']});
 let stderr='',stdout='';python.stderr.on('data',x=>stderr+=x);python.stdout.on('data',x=>stdout+=x);
 const port=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('Server timeout '+stderr)),15000);python.once('exit',code=>{clearTimeout(timer);reject(Error('Server exit '+code+stderr))});python.stdout.on('data',()=>{const m=/READY (\d+)/.exec(stdout);if(m){clearTimeout(timer);resolve(Number(m[1]))}})});
 const command=async line=>{const before=stdout.length;python.stdin.write(line+'\n');const deadline=Date.now()+5000;while(!stdout.slice(before).includes('DONE '+line)){if(Date.now()>deadline)throw Error('No answer to '+line);await new Promise(r=>setTimeout(r,20))}};
 return {python,command,base:`http://127.0.0.1:${port}/api/hassio_ingress/test/`,stderr:()=>stderr};
}
async function stop(server){if(server?.python.exitCode===null){server.python.kill();await once(server.python,'exit')}}
const metrics=page=>page.locator('#storageUsage>div,#archiveUsage>div,#archiveSecondaryUsage>div').evaluateAll(rows=>Object.fromEntries(rows.map(row=>[row.querySelector('dt').textContent,row.querySelector('dd').textContent])));
async function openPanel(page){
 // (Re)opens the panel and waits for a fresh rendering: the archive rows are cleared first and come back with it.
 if(await page.locator('#storageSettings').evaluate(el=>el.open))await page.locator('#storageSettings > summary').click();
 await page.evaluate(()=>document.querySelectorAll('#archiveUsage>.archive-metric').forEach(row=>row.remove()));
 await page.locator('#storageSettings > summary').click();await page.waitForFunction(()=>document.getElementById('archiveForm').dataset.loaded==='true'&&document.querySelector('#archiveUsage>.archive-metric'));
}
async function settle(page){
 // An absence check: a fetch a fake timer started may not have reached the request event yet, so wait in real time.
 await page.waitForTimeout(500);
}
async function waitForStorageRefresh(page,action){
 // A timer starts an async fetch; wait for its rendering, not just the clock advance.
 const row=await page.locator('#archiveUsage>.archive-metric').first().elementHandle();
 await action();await page.waitForFunction(row=>!row.isConnected,row);await row.dispose();
}
(async()=>{
 const temp=fs.mkdtempSync(path.join(os.tmpdir(),'rv-gdrive-ui-')),driveDir=path.join(temp,'drive'),offDir=path.join(temp,'off'),nasDir=path.join(temp,'nas'),nas=path.join(temp,'nas-share');
 for(const dir of [driveDir,offDir,nasDir,nas])fs.mkdirSync(dir);
 for(const dir of [driveDir,offDir,nasDir])fs.writeFileSync(path.join(dir,'.processing-settings.json'),JSON.stringify({auto_convert:false}));
 const ids=['a'.repeat(32),'b'.repeat(32)];
 // One recording whose Drive copy did not verify (the local file is kept), one plain.
 recording(driveDir,ids[0],0,{'rlog.zst':{location:'local',error:'remote_mismatch'}});recording(driveDir,ids[1],1);
 recording(nasDir,ids[0],0);recording(offDir,ids[1],1);
 let drive,off,smb,browser;
 try{
  drive=await serve(driveDir,{RV_ARCHIVE_OPTIONS_JSON:JSON.stringify({archive_enabled:true,archive_backend:'gdrive',archive_mode:'copy',archive_gdrive_client_id:'client-id',archive_gdrive_client_secret:'shh-client-secret',archive_min_age_hours:8760})});
  browser=await chromium.launch({headless:true});
  const context=await browser.newContext({viewport:{width:1280,height:900},reducedMotion:'reduce'}),page=await context.newPage(),errors=[],posts=[];
  page.on('pageerror',error=>errors.push(error.message));page.on('dialog',dialog=>dialog.accept());
  page.on('request',request=>{if(request.method()==='POST')posts.push([new URL(request.url()).pathname.replace('/api/hassio_ingress/test',''),request.headers()['x-roadviewer-request']])});
  // runFor fires every one-second tick (fastForward would coalesce them). Pause before
  // navigation so only explicit advances can poll; Python's OAuth clock stays real.
  const clockTime=Date.now();await page.clock.install({time:clockTime});await page.clock.pauseAt(clockTime+1000);
  await page.goto(drive.base);await page.locator('.log-row').first().waitFor();
  // Per recording: the retry shows only where the copy did not verify.
  assert.equal(await page.locator(`.log-row[data-id="${ids[0]}"] .archive-retry`).textContent(),'재시도');
  assert.equal(await page.locator(`.log-row[data-id="${ids[1]}"] .archive-retry`).count(),0);
  await openPanel(page);await page.locator('#gdriveConnect').waitFor();
  let m=await metrics(page);
  assert.equal(m['저장소'],'Google Drive');assert.equal(m['Drive 상태'],'연결 안 됨');assert.equal(m['Drive 여유'],'할당량 확인 불가');
  assert.equal(m['복제 사본'],'0개');assert.equal(m['검증 실패'],'1개');assert.equal(Object.keys(m).length,13);
  assert.equal(await page.locator('#archiveMode').textContent(),'복제 모드: 로컬 파일은 보존됩니다');
  assert.equal(await page.locator('#archiveMode.archive-warning').count(),0);
  assert.equal(await page.locator('#gdriveConnect').textContent(),'Google Drive 연결');assert(await page.locator('#gdriveConnect').isEnabled());
  assert(await page.locator('#gdriveDisconnect').isHidden());assert(await page.locator('#gdriveCode').isHidden());assert(await page.locator('#gdriveSetup').isHidden());
  // Connect failures are explained in Korean; nothing is waiting afterwards.
  await page.route('**/api/settings/archive/gdrive/connect',route=>route.fulfill({status:503,json:{error:'gdrive_unavailable'}}));
  await page.locator('#gdriveConnect').click();
  await page.waitForFunction(()=>document.getElementById('gdriveStatus').textContent==='Google에 연결할 수 없습니다. 잠시 후 다시 시도하세요.');
  await page.unroute('**/api/settings/archive/gdrive/connect');
  await page.route('**/api/settings/archive/gdrive/connect',route=>route.fulfill({status:502,json:{error:'gdrive_auth_failed',reason:'invalid_client'}}));
  await page.locator('#gdriveConnect').click();
  await page.waitForFunction(()=>document.getElementById('gdriveStatus').textContent==='클라이언트 ID/비밀키가 올바르지 않습니다');
  await page.unroute('**/api/settings/archive/gdrive/connect');
  assert(await page.locator('#gdriveCode').isHidden());assert(await page.locator('#gdriveConnect').isEnabled());
  // The waiting sign-in: only the code and the address are shown, even if the block carried more.
  await page.route('**/api/settings/storage',async route=>{const response=await route.fetch(),body=await response.json();if(body.archive?.gdrive?.pending)body.archive.gdrive.pending.device_code='dc-secret-not-shown';await route.fulfill({response,json:body})});
  await page.locator('#gdriveConnect').click();
  await page.locator('#gdriveCode').waitFor();
  assert.equal(await page.locator('#gdriveUserCode').textContent(),'ABCD-EFGH');
  assert.equal(await page.locator('#gdriveUrl').textContent(),'https://www.google.com/device');assert.equal(await page.locator('#gdriveUrl').getAttribute('href'),'https://www.google.com/device');
  assert.match(await page.locator('#gdriveCountdown').textContent(),/^코드 유효 시간 (29:5\d|30:00) 남음$/);
  assert(await page.locator('#gdriveConnect').isHidden());
  assert(!(await page.content()).includes('dc-secret-not-shown'));
  for(const width of [320,390]){await page.setViewportSize({width,height:844});assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'no overflow at '+width)}
  await page.setViewportSize({width:1280,height:900});
  const first=await page.locator('#gdriveCountdown').textContent();
  await page.clock.runFor(1000);
  await page.waitForFunction(text=>document.getElementById('gdriveCountdown').textContent!==text,first);
  // The panel follows the sign-in (every 3 s) until Google grants it.
  const polls=[];page.on('request',request=>{if(request.url().endsWith('/api/settings/storage'))polls.push(Date.now())});
  await waitForStorageRefresh(page,()=>page.clock.runFor(3500));assert(polls.length>=1,'polls while the code waits');
  // Closing the panel or hiding the page stops it; reopening or returning resumes it after a fresh fetch.
  await page.locator('#storageSettings > summary').click();
  let mark=polls.length;await page.clock.runFor(4000);await settle(page);assert.equal(polls.length,mark,'no polling with the panel closed');
  await openPanel(page);await page.locator('#gdriveCode').waitFor();
  mark=polls.length;await waitForStorageRefresh(page,()=>page.clock.runFor(3500));assert(polls.length>mark,'polling resumes on reopen');
  await page.evaluate(()=>{Object.defineProperty(document,'hidden',{configurable:true,get:()=>true});document.dispatchEvent(new Event('visibilitychange'))});
  mark=polls.length;await page.clock.runFor(4000);await settle(page);assert.equal(polls.length,mark,'no polling while the page is hidden');
  // The return fetch must finish before advancing: it restarts the polling interval.
  await waitForStorageRefresh(page,()=>page.evaluate(()=>{delete document.hidden;document.dispatchEvent(new Event('visibilitychange'))}));
  await waitForStorageRefresh(page,()=>page.clock.runFor(3500));assert(polls.length>=mark+2,'a fresh fetch on return, then polling again');
  await page.unroute('**/api/settings/storage');
  await drive.command('grant');
  // OAuth still polls on Python's real clock. Give it real time to finish, while advancing
  // browser polls instead of waiting another three real seconds for each status update.
  const grantDeadline=Date.now()+15000;
  while(!await page.locator('#gdriveCode').evaluate(el=>el.hidden)&&Date.now()<grantDeadline){
   await new Promise(resolve=>setTimeout(resolve,100));
   await waitForStorageRefresh(page,()=>page.clock.runFor(3000));
  }
  await page.waitForFunction(()=>document.getElementById('gdriveCode').hidden,null,{timeout:15000});
  await page.waitForFunction(()=>[...document.querySelectorAll('#storageUsage>div,#archiveUsage>div,#archiveSecondaryUsage>div')].some(row=>row.querySelector('dt').textContent==='Drive 상태'&&row.querySelector('dd').textContent==='연결됨'),null,{timeout:15000});
  assert(await page.locator('#gdriveDisconnect').isVisible());assert(await page.locator('#gdriveConnect').isHidden());assert(await page.locator('#gdriveAuthError').isHidden());
  // Polling stops with the code gone.
  const settled=polls.length;await page.clock.runFor(3500);await settle(page);assert.equal(polls.length,settled,'no polling once nothing waits');
  assert(fs.existsSync(path.join(driveDir,'.gdrive-auth.json')));
  await page.locator('#gdriveDisconnect').click();
  await page.waitForFunction(()=>document.getElementById('gdriveStatus').textContent==='Google Drive 연결을 해제했습니다.');
  m=await metrics(page);assert.equal(m['Drive 상태'],'연결 안 됨');
  assert(await page.locator('#gdriveDisconnect').isHidden());assert(await page.locator('#gdriveConnect').isVisible());assert.equal(await page.locator('#gdriveConnect').textContent(),'Google Drive 연결');
  assert(!fs.existsSync(path.join(driveDir,'.gdrive-auth.json')));
  // Retry clears the recording's error: its button goes and the panel's count drops.
  await page.locator(`.log-row[data-id="${ids[0]}"] .archive-retry`).click();
  await page.waitForFunction(id=>!document.querySelector(`.log-row[data-id="${id}"] .archive-retry`),ids[0]);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(driveDir,ids[0],'meta.json'))).storage||{},{},'the error entry is gone');
  await openPanel(page);m=await metrics(page);assert.equal(m['검증 실패'],'0개');
  for(const [url,header] of posts)assert.equal(header,'1',url);
  assert.deepEqual([...new Set(posts.map(([url])=>url))].sort(),['/api/logs/'+ids[0]+'/archive/retry','/api/settings/archive/gdrive/connect','/api/settings/archive/gdrive/disconnect']);
  // The move-mode warning and an unconfigured client, from a block the panel is handed.
  await page.route('**/api/settings/storage',async route=>{const response=await route.fetch(),body=await response.json();Object.assign(body.archive,{mode:'move',effective_mode:'move',local_delete_allowed:true});Object.assign(body.archive.gdrive,{configured:false,connected:true,last_auth_error:'something_new'});await route.fulfill({response,json:body})});
  await openPanel(page);
  assert.equal(await page.locator('#archiveMode.archive-warning').textContent(),'이동 모드: 검증된 원격 사본이 있으면 로컬 원본이 삭제됩니다');
  assert.equal(await page.locator('#gdriveSetup').textContent(),'애드온 옵션에서 Google Drive 클라이언트 ID를 설정하세요');
  assert.equal(await page.locator('#gdriveAuthError').textContent(),'인증 오류 (something_new)');
  assert.equal((await metrics(page))['Drive 상태'],'인증 만료');
  assert.equal(await page.locator('#gdriveConnect').textContent(),'다시 연결');assert(await page.locator('#gdriveConnect').isDisabled());
  await page.unroute('**/api/settings/storage');
  // A waiting code from a handed block. The server's clock (Date header) is an hour behind the browser's.
  const handed=(code,url,left)=>page.route('**/api/settings/storage',async route=>{const response=await route.fetch(),body=await response.json(),server=Date.now()/1000-3600;body.archive.gdrive.pending={user_code:code,verification_url:url,expires_at:server+left};await route.fulfill({response,json:body,headers:{...response.headers(),date:new Date(server*1000).toUTCString()}})});
  const markup='<img src=x onerror="window.__x=1"><b>X</b>';
  await handed(markup,'javascript:alert(1)',600);await openPanel(page);await page.locator('#gdriveCode').waitFor();
  // Markup stays text and a script address is not a link.
  assert.equal(await page.locator('#gdriveUserCode').textContent(),markup);
  assert.equal(await page.locator('#gdriveUserCode').evaluate(el=>el.childElementCount),0);
  assert.equal(await page.locator('#gdriveCode img, #gdriveCode b').count(),0);
  assert.equal(await page.evaluate(()=>window.__x),undefined);
  assert.equal(await page.locator('#gdriveUrl').textContent(),'javascript:alert(1)');assert.equal(await page.locator('#gdriveUrl').getAttribute('href'),null);
  // The countdown follows the server's clock, not the browser's (which would read 50 minutes past expiry).
  await waitForStorageRefresh(page,()=>page.clock.runFor(3000));
  // The HTTP Date header rounds down to seconds; allow the next countdown tick as before.
  await page.clock.runFor(1000);
  await page.waitForFunction(()=>/^코드 유효 시간 (9:5\d|10:00) 남음$/.test(document.getElementById('gdriveCountdown').textContent),null,{timeout:8000});
  await page.unroute('**/api/settings/storage');
  // A plain-http address is text too; a code the server still reports is never called expired.
  await handed('WXYZ-1234','http://www.google.com/device',-5);await openPanel(page);await page.locator('#gdriveCode').waitFor();
  assert.equal(await page.locator('#gdriveUrl').textContent(),'http://www.google.com/device');assert.equal(await page.locator('#gdriveUrl').getAttribute('href'),null);
  await waitForStorageRefresh(page,()=>page.clock.runFor(3500));
  assert.equal(await page.locator('#gdriveCountdown').textContent(),'코드 유효 시간을 확인하는 중입니다');
  assert(!(await page.locator('#gdriveCode').textContent()).includes('만료'));
  await page.locator('#storageSettings > summary').click();
  await page.unroute('**/api/settings/storage');
  assert.deepEqual(errors,[]);
  await stop(drive);drive=null;
  // Clock installation is context-wide; the remaining backends use an ordinary clock.
  await context.close();
  const otherContext=await browser.newContext({viewport:{width:1280,height:900},reducedMotion:'reduce'});
  // Drive selected with archiving off: the sign-in panel alone, with a note; no run button and no archive rows.
  off=await serve(offDir,{RV_ARCHIVE_OPTIONS_JSON:JSON.stringify({archive_enabled:false,archive_backend:'gdrive',archive_gdrive_client_id:'client-id',archive_gdrive_client_secret:'shh-client-secret'})});
  const offPage=await otherContext.newPage(),offPosts=[];offPage.on('pageerror',error=>errors.push(error.message));offPage.on('dialog',dialog=>dialog.accept());
  offPage.on('request',request=>{if(request.method()==='POST')offPosts.push(new URL(request.url()).pathname.replace('/api/hassio_ingress/test',''))});
  await offPage.goto(off.base);await offPage.locator('.log-row').first().waitFor();
  await offPage.locator('#storageSettings > summary').click();await offPage.locator('#gdrivePanel').waitFor();
  assert.deepEqual(await offPage.locator('#storageUsage>div dt').allTextContents(),['사용 중','설정 한도','디스크 여유','업로드 예약']);
  assert.equal(await offPage.locator('#archiveRun').count(),0);assert.equal(await offPage.locator('.archive-metric').count(),0);
  assert.equal(await offPage.locator('#gdriveArchiveOff').textContent(),'아카이빙이 꺼져 있습니다. 여기서는 Google Drive 계정 연결만 관리하며 파일은 복사하지 않습니다.');
  assert.equal(await offPage.locator('#gdriveAccount').textContent(),'Drive 계정: 연결 안 됨');
  assert(await offPage.locator('#archiveMode').isHidden());
  assert(await offPage.locator('#gdriveConnect').isEnabled());assert(await offPage.locator('#gdriveDisconnect').isHidden());
  await offPage.locator('#gdriveConnect').click();await offPage.locator('#gdriveCode').waitFor();
  assert.equal(await offPage.locator('#gdriveUserCode').textContent(),'ABCD-EFGH');
  assert.equal(await offPage.locator('#gdriveAccount').textContent(),'Drive 계정: 연결 대기 중');
  await off.command('grant');
  await offPage.waitForFunction(()=>document.getElementById('gdriveCode').hidden&&document.getElementById('gdriveAccount').textContent==='Drive 계정: 연결됨',null,{timeout:15000});
  assert(await offPage.locator('#gdriveDisconnect').isVisible());assert(await offPage.locator('#gdriveConnect').isHidden());
  assert(fs.existsSync(path.join(offDir,'.gdrive-auth.json')));
  assert.equal(await offPage.locator('#archiveRun').count(),0);assert.equal(await offPage.locator('.archive-metric').count(),0);
  await offPage.locator('#gdriveDisconnect').click();
  await offPage.waitForFunction(()=>document.getElementById('gdriveStatus').textContent==='Google Drive 연결을 해제했습니다.');
  assert.equal(await offPage.locator('#gdriveAccount').textContent(),'Drive 계정: 연결 안 됨');
  assert(!fs.existsSync(path.join(offDir,'.gdrive-auth.json')));
  assert.deepEqual([...new Set(offPosts)].sort(),['/api/settings/archive/gdrive/connect','/api/settings/archive/gdrive/disconnect']);
  assert.deepEqual(errors,[]);
  await offPage.close();await stop(off);off=null;
  // The NAS with archiving off: the four local rows and nothing of Drive.
  smb=await serve(nasDir,{RV_ARCHIVE_OPTIONS_JSON:JSON.stringify({archive_enabled:false,archive_path:nas}),RV_ARCHIVE_ALLOW_ANY_PATH:'1'});
  const smbOff=await otherContext.newPage();smbOff.on('pageerror',error=>errors.push(error.message));
  await smbOff.goto(smb.base);await smbOff.locator('.log-row').first().waitFor();
  await smbOff.locator('#storageSettings > summary').click();await smbOff.waitForFunction(()=>document.getElementById('archiveForm').dataset.loaded==='true');
  assert.deepEqual(await smbOff.locator('#storageUsage>div dt').allTextContents(),['사용 중','설정 한도','디스크 여유','업로드 예약']);
  for(const id of ['archiveRun','gdrivePanel','gdriveConnect','gdriveDisconnect','gdriveCode','archiveMode','gdriveArchiveOff','gdriveAccount'])assert.equal(await smbOff.locator('#'+id).count(),0,id);
  await smbOff.close();await stop(smb);smb=null;
  // The NAS: its four rows as before and no Drive element at all.
  // Explicit UI save: options.json is ignored after the first migration.
  const prefs=JSON.parse(fs.readFileSync(path.join(nasDir,'.archive-settings.json'),'utf8'));prefs.archive_enabled=true;
  fs.writeFileSync(path.join(nasDir,'.archive-settings.json'),JSON.stringify(prefs));
  smb=await serve(nasDir,{RV_ARCHIVE_OPTIONS_JSON:JSON.stringify({archive_enabled:true,archive_path:nas}),RV_ARCHIVE_ALLOW_ANY_PATH:'1'});
  const plain=await otherContext.newPage();plain.on('pageerror',error=>errors.push(error.message));
  await plain.goto(smb.base);await plain.locator('.log-row').first().waitFor();
  await openPanel(plain);await plain.locator('#archiveRun').waitFor();
  assert.deepEqual(await plain.locator('#storageUsage>div dt,#archiveUsage>div dt,#archiveSecondaryUsage>div dt').allTextContents(),['사용 중','설정 한도','디스크 여유','업로드 예약','NAS 상태','NAS 사용 중','NAS 여유','마지막 아카이브','최근 실행 결과']);
  for(const id of ['gdrivePanel','gdriveConnect','gdriveDisconnect','gdriveCode','archiveMode'])assert.equal(await plain.locator('#'+id).count(),0,id);
  assert.equal(await plain.locator('.archive-retry').count(),0);
  assert.deepEqual(errors,[]);
  console.log('PASS: Drive panel (backend, mode, connect errors, device code, grant, disconnect), sign-in with archiving off, per-recording retry, NAS panel without Drive elements');
 }finally{await browser?.close();await stop(drive);await stop(off);await stop(smb);fs.rmSync(temp,{recursive:true,force:true})}
})().catch(error=>{console.error(error);process.exitCode=1});
