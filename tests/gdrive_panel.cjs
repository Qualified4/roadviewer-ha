const fs=require('fs'),os=require('os'),path=require('path'),assert=require('node:assert/strict'),{spawn}=require('child_process'),{once}=require('events'),{chromium}=require('playwright');
const {showTab,reopenTab}=require('./browser-helpers.cjs');
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
 if(await page.locator('#storageSettings').evaluate(el=>!el.hidden))await page.locator('#tab-logs').click();
 await page.evaluate(()=>document.querySelectorAll('#archiveUsage>.archive-metric').forEach(row=>row.remove()));
 await showTab(page,'storage');await page.waitForFunction(()=>document.getElementById('archiveForm').dataset.loaded==='true'&&document.querySelector('#archiveUsage>.archive-metric'));
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
  browser=await chromium.launch({headless:true});require('./browser-helpers.cjs').openRouteGroups(browser);
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
  // A usage measured in the background (opening the panel starts one) shows as such, then settles without reopening.
  let usageCalls=0;
  await page.route('**/api/settings/storage',async route=>{const response=await route.fetch(),body=await response.json();if(++usageCalls===1)Object.assign(body.archive,{usage_measuring:true,usage_known:false});await route.fulfill({response,json:body})});
  await openPanel(page);
  await page.waitForFunction(()=>[...document.querySelectorAll('#archiveUsage .archive-metric')].some(row=>row.querySelector('dt').textContent==='Drive 여유'&&row.querySelector('dd').textContent==='측정 중'));
  await waitForStorageRefresh(page,()=>page.clock.runFor(2500));
  assert.equal((await metrics(page))['Drive 여유'],'할당량 확인 불가');
  assert(usageCalls>=2);await page.unroute('**/api/settings/storage');
  assert.equal(await page.locator('#archiveMode').textContent(),'복제 모드: 로컬 파일은 보존됩니다');
  // COPY: the manual run says copy, and its confirmation that nothing local is deleted.
  assert.equal(await page.locator('#archiveRun').textContent(),'복사 가능한 데이터 모두 복사');
  await page.locator('#archiveRun').click();await page.locator('#archiveAllDialog').waitFor({state:'visible'});
  assert.match(await page.locator('#archiveAllDelete').textContent(),/로컬 파일은 삭제되지 않/);
  assert.equal(await page.locator('#archiveAllSummary dt',{hasText:'예상 로컬 확보 용량'}).count(),0);
  await page.locator('#archiveAllCancel').click();await page.locator('#archiveAllDialog').waitFor({state:'hidden'});
  assert.equal(await page.locator('#archiveMode.archive-warning').count(),0);
  // 'Drive 로그 지도 채우기': a switch saved with the form (off by default), the progress line and its run-once button.
  assert(await page.locator('#trackFill').isVisible());assert.equal(await page.locator('#trackFillEnabled').isChecked(),false);
  assert.match(await page.locator('#trackFillHelp').textContent(),/13 MB/);
  assert.equal(await page.locator('#trackFillStatus').textContent(),'Drive 로그 지도 채우기: 0 / 0');
  assert.equal(await page.locator('#trackFillRun').textContent(),'한 번 실행');assert(await page.locator('#trackFillRun').isDisabled(),'nothing to fill');
  // Everything filled and nothing running: the line says so and the bar (a full one looked unfinished) goes.
  await page.route('**/api/settings/storage',async route=>{const response=await route.fetch(),body=await response.json();Object.assign(body.archive.track_fill,{total:598,done:598,pending:0,failed:0,last_error:null,running:false,manual:false,finished_at:null});await route.fulfill({response,json:body})});
  await openPanel(page);
  assert.equal(await page.locator('#trackFillStatus').textContent(),'Drive 로그 지도 채우기: 모두 채움 · 598개');
  assert(await page.locator('#trackFillMeter').isHidden(),'no bar once everything is filled');assert(await page.locator('#trackFillRun').isDisabled());
  await page.unroute('**/api/settings/storage');
  await page.route('**/api/settings/storage',async route=>{const response=await route.fetch(),body=await response.json();Object.assign(body.archive.track_fill,{total:406,done:120,pending:286,failed:0,last_error:'auth_expired'});await route.fulfill({response,json:body})});
  await openPanel(page);
  assert.equal(await page.locator('#trackFillStatus').textContent(),'Drive 로그 지도 채우기: 120 / 406\nGoogle Drive 인증이 만료되어 멈췄습니다. 다시 연결하면 이어서 채웁니다.');
  assert.equal(await page.locator('#trackFillStatus').getAttribute('data-state'),'error');
  const fillShot=async name=>{const dir=process.env.RV_FILL_SHOTS;if(!dir)return;const box=page.locator('#trackFill');await box.scrollIntoViewIfNeeded();
   for(const scheme of ['light','dark'])for(const [w,tag] of [[1280,'pc'],[390,'phone']]){await page.emulateMedia({colorScheme:scheme});await page.setViewportSize({width:w,height:900});await page.waitForTimeout(150);await box.scrollIntoViewIfNeeded();
    const b=await box.boundingBox();await page.screenshot({path:path.join(dir,`${name}-${tag}-${scheme}.png`),clip:{x:0,y:Math.max(0,b.y-150),width:w,height:Math.min(b.height+300,900)}})}
   await page.emulateMedia({colorScheme:'light'});await page.setViewportSize({width:1280,height:900})};
  await fillShot('error');
  assert(await page.locator('#trackFillRun').isEnabled());
  await page.locator('#trackFillRun').click();
  await page.waitForFunction(()=>document.getElementById('trackFillRun').textContent==='중지');
  await fillShot('running');
  assert(await page.locator('#trackFillRun').isEnabled(),'a running pass can be stopped');
  await page.unroute('**/api/settings/storage');
  await page.locator('#trackFillRun').click();
  await page.waitForFunction(()=>document.getElementById('trackFillRun').textContent==='한 번 실행');
  // The switch is saved like the other archive settings.
  await page.locator('#trackFillEnabled').check({force:true});
  await page.locator('#storageSave').click();
  await page.waitForFunction(()=>document.getElementById('archiveSettingsStatus').textContent==='저장했습니다. 재시작 없이 적용되었습니다.');
  assert.equal(JSON.parse(fs.readFileSync(path.join(driveDir,'.archive-settings.json'),'utf8')).archive_gdrive_fill_tracks,true);
  assert.equal((await (await page.request.get(drive.base+'api/settings/storage')).json()).archive.track_fill.enabled,true);
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
  // Leaving the tab or hiding the page stops it; reopening or returning resumes it after a fresh fetch.
  await page.locator('#tab-logs').click();
  // The panel's 3 s polling stops; the library header still asks every 10 s (3 s only while it reads 'checking').
  let mark=polls.length;await page.clock.runFor(9000);await settle(page);assert(polls.length-mark<=1,'no panel polling with the panel closed: '+(polls.length-mark));
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
  // The account and its disconnect button belong to the Drive card, not the local storage one.
  assert(await page.locator('#archiveSummary > #gdrivePanel').isVisible());assert.equal(await page.locator('.storage-local #gdrivePanel').count(),0);assert(await page.locator('#gdriveHeading').isHidden());
  // Polling stops with the code gone.
  const settled=polls.length;await page.clock.runFor(3500);await settle(page);assert.equal(polls.length,settled,'no polling once nothing waits');
  assert(fs.existsSync(path.join(driveDir,'.gdrive-auth.json')));
  await page.locator('#gdriveDisconnect').click();
  await page.waitForFunction(()=>document.getElementById('gdriveStatus').textContent==='Google Drive 연결을 해제했습니다.');
  m=await metrics(page);assert.equal(m['Drive 상태'],'연결 안 됨');
  assert(await page.locator('#gdriveDisconnect').isHidden());assert(await page.locator('#gdriveConnect').isVisible());assert.equal(await page.locator('#gdriveConnect').textContent(),'Google Drive 연결');
  assert(!fs.existsSync(path.join(driveDir,'.gdrive-auth.json')));
  // Retry clears the recording's error: its button goes and the panel's count drops.
  await showTab(page,'logs');
  await page.locator(`.log-row[data-id="${ids[0]}"] .archive-retry`).click();
  await page.waitForFunction(id=>!document.querySelector(`.log-row[data-id="${id}"] .archive-retry`),ids[0]);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(driveDir,ids[0],'meta.json'))).storage||{},{},'the error entry is gone');
  await openPanel(page);m=await metrics(page);assert.equal(m['검증 실패'],'0개');
  for(const [url,header] of posts)assert.equal(header,'1',url);
  assert.deepEqual([...new Set(posts.map(([url])=>url))].sort(),['/api/logs/'+ids[0]+'/archive/retry','/api/settings/archive','/api/settings/archive/gdrive/connect','/api/settings/archive/gdrive/disconnect','/api/settings/archive/tracks/run','/api/settings/archive/tracks/stop']);
  // The move-mode warning and an unconfigured client, from a block the panel is handed.
  await page.route('**/api/settings/storage',async route=>{const response=await route.fetch(),body=await response.json();Object.assign(body.archive,{mode:'move',effective_mode:'move',local_delete_allowed:true});Object.assign(body.archive.gdrive,{configured:false,connected:true,last_auth_error:'something_new'});await route.fulfill({response,json:body})});
  await openPanel(page);
  assert.equal(await page.locator('#archiveMode.archive-warning').textContent(),'이동 모드: 검증된 원격 사본이 있으면 로컬 원본이 삭제됩니다');
  assert.equal(await page.locator('#archiveRun').textContent(),'이동 가능한 데이터 모두 이동');
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
  await page.locator('#tab-logs').click();
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
  await showTab(offPage,'storage');await offPage.locator('#gdrivePanel').waitFor();
  // With archiving off the Drive card is hidden: the account is a card of its own, still outside local storage.
  assert(await offPage.locator('.storage-overview > #gdrivePanel').isVisible());assert.equal(await offPage.locator('#gdriveHeading').textContent(),'Google Drive');assert(await offPage.locator('#gdriveHeading').isVisible());
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
  await showTab(smbOff,'storage');await smbOff.waitForFunction(()=>document.getElementById('archiveForm').dataset.loaded==='true');
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
  assert(await plain.locator('#trackFill').isHidden(),'the Drive maps switch is for Drive only');
  assert.equal(await plain.locator('.archive-retry').count(),0);
  assert.deepEqual(errors,[]);
  console.log('PASS: Drive panel (backend, mode, connect errors, device code, grant, disconnect), sign-in with archiving off, per-recording retry, NAS panel without Drive elements');
 }finally{await browser?.close();await stop(drive);await stop(off);await stop(smb);fs.rmSync(temp,{recursive:true,force:true})}
})().catch(error=>{console.error(error);process.exitCode=1});
