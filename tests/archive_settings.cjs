const fs=require('fs'),os=require('os'),path=require('path'),assert=require('node:assert/strict'),{spawn}=require('child_process'),{once}=require('events'),{chromium}=require('playwright');
// A local server, fake Drive and temporary files only. No archiver cycle is started.
const SERVER=`import sys,os,threading
sys.path.insert(0,'tests');sys.path.insert(0,'roadviewer/app')
from fake_drive import FakeDrive
drive=FakeDrive().start();os.environ.update(drive.env())
import server
from werkzeug.serving import make_server
from werkzeug.middleware.dispatcher import DispatcherMiddleware
http=make_server('127.0.0.1',0,DispatcherMiddleware(server.app,{'/api/hassio_ingress/test':server.app}),threaded=True)
print('READY '+str(http.server_port),flush=True)
http.serve_forever()`;
(async()=>{
 const temp=fs.mkdtempSync(path.join(os.tmpdir(),'rv-archive-settings-')),root=path.join(temp,'data'),nas=path.join(temp,'nas');
 fs.mkdirSync(root);fs.mkdirSync(nas);
 fs.writeFileSync(path.join(root,'.processing-settings.json'),JSON.stringify({auto_convert:false}));
 const id='a'.repeat(32),record=path.join(root,id);fs.mkdirSync(record);
 fs.writeFileSync(path.join(record,'rlog.zst'),'temporary fixture');
 fs.writeFileSync(path.join(record,'meta.json'),JSON.stringify({id,status:'uploaded',name:'archive settings fixture',uploaded:1,files:{}}));
 let python,browser,stderr='';
 try{
  python=spawn(process.env.RV_PYTHON||'python',['-u','-c',SERVER],{env:{...process.env,RV_DATA:root,RV_INGRESS_ONLY:'0',RV_ARCHIVE_ALLOW_ANY_PATH:'1',RV_ARCHIVE_OPTIONS_JSON:JSON.stringify({archive_gdrive_client_id:'hidden-client-id',archive_gdrive_client_secret:'hidden-client-secret',archive_mode:'copy',archive_min_age_hours:49,archive_interval_minutes:37,archive_local_threshold_mb:3333,archive_nas_max_mb:8192,archive_nas_margin_mb:2048})},stdio:['ignore','pipe','pipe']});
  python.stderr.on('data',x=>stderr+=x);
  const port=await new Promise((resolve,reject)=>{
   const timer=setTimeout(()=>reject(Error('Server timeout '+stderr)),15000);let stdout='';
   python.once('exit',code=>{clearTimeout(timer);reject(Error('Server exit '+code+stderr))});
   python.stdout.on('data',x=>{stdout+=x;const m=/READY (\d+)/.exec(stdout);if(m){clearTimeout(timer);resolve(Number(m[1]))}});
  });
  const base=`http://127.0.0.1:${port}/api/hassio_ingress/test/`;
  browser=await chromium.launch({headless:true});require('./browser-helpers.cjs').openRouteGroups(browser);
  const page=await browser.newPage({viewport:{width:1280,height:900},reducedMotion:'reduce'}),errors=[];
  page.on('pageerror',e=>errors.push(e.message));
  const field=name=>page.locator(`#archiveForm [name="archive_${name}"]`);
  async function open(){await page.locator('#storageSettings > summary').click();await page.locator('#archiveForm[data-loaded=true]').waitFor();await page.locator('#archiveAdvanced > summary').click()}
  async function save(){await page.locator('#storageSave').click();await page.waitForFunction(()=>document.getElementById('archiveSettingsStatus').textContent==='저장했습니다. 재시작 없이 적용되었습니다.')}
  await page.goto(base);await page.locator('.log-row').first().waitFor();await open();
  assert.equal(await field('enabled').isChecked(),false);
  assert.equal(await field('min_age_hours').inputValue(),'49');assert.equal(await field('interval_minutes').inputValue(),'37');assert.equal(await field('local_threshold_mb').inputValue(),'3333');
  assert.equal(await page.locator('#archiveAgePreset').inputValue(),'custom');assert.equal(await page.locator('#archiveIntervalPreset').inputValue(),'custom');assert.equal(await page.locator('#archiveThresholdPreset').inputValue(),'custom');
  assert(await page.locator('#storageSave').isDisabled(),'unchanged values do not trigger a write');
  assert(await field('path').isVisible());assert(await field('gdrive_folder_name').isHidden());assert(await field('allow_local_delete').isHidden());
  assert.match(await page.locator('#archiveNasMode').textContent(),/NAS.*항상 이동/);
  await page.getByRole('radio',{name:/Google Drive/}).check();
  assert(await field('path').isHidden());assert(await field('nas_max_mb').isHidden());assert(await field('nas_margin_mb').isHidden());
  assert(await field('gdrive_folder_name').isVisible());assert(await field('allow_local_delete').isHidden());
  await page.getByRole('radio',{name:/이동 · MOVE/}).check();
  assert.match(await page.locator('#archiveWarning').textContent(),/COPY로 동작/);
  await field('allow_local_delete').check();
  assert.match(await page.locator('#storagePolicyInfo').textContent(),/소프트 리밋/);assert.match(await page.locator('#storageBehaviorSummary').textContent(),/로컬 원본만 삭제/);
  await page.getByRole('radio',{name:/복제 · COPY/}).check();assert.equal(await page.locator('#archiveWarning.archive-warning').count(),0);
  await page.getByRole('radio',{name:/이동 · MOVE/}).check();await field('allow_local_delete').uncheck();await page.getByRole('radio',{name:/복제 · COPY/}).check();await field('enabled').check();
  await page.locator('#archiveIntervalPresetChoice').click();await page.getByRole('option',{name:'직접 입력',exact:true}).click();await field('interval_minutes').fill('37');await page.locator('#archiveAgePresetChoice').click();await page.getByRole('option',{name:'7일',exact:true}).click();await field('batch').fill('2');await page.locator('#archiveThresholdPresetChoice').click();await page.getByRole('option',{name:'3 GB',exact:true}).click();
  await field('gdrive_folder_name').fill('UI archive folder');await save();
  await page.locator('#gdriveConnect').waitFor();await page.locator('#archiveRun').waitFor();
  let prefs=await page.evaluate(()=>fetch('api/settings/archive').then(r=>r.json()));
  assert.equal(prefs.archive_interval_minutes,37);assert.equal(prefs.archive_mode,'copy');assert.equal(prefs.effective_mode,'copy');assert.equal(prefs.archive_enabled,true);
  assert.equal(prefs.archive_gdrive_folder_name,'UI archive folder');assert(prefs.client_configured);
  await page.reload();await page.locator('.log-row').first().waitFor();await open();
  assert(await page.getByRole('radio',{name:/Google Drive/}).isChecked());assert.equal(await field('interval_minutes').inputValue(),'37');assert.equal(await field('gdrive_folder_name').inputValue(),'UI archive folder');
  let draftWrites=0,draftRuns=0;
  const watch=request=>{if(request.method()==='POST'){if(/api\/settings\/(archive|storage)$/.test(request.url()))draftWrites++;if(request.url().endsWith('/api/settings/archive/run'))draftRuns++}};
  page.on('request',watch);
  await page.getByRole('radio',{name:/이동 · MOVE/}).check();await field('allow_local_delete').check();
  await page.locator('#storageLimitChoice').click();await page.getByRole('option',{name:'직접 입력',exact:true}).click();await page.locator('#storageCustom').fill('1');
  assert.match(await page.locator('#storageBehaviorSummary').textContent(),/7일.*Google Drive로 이동/);
  assert.match(await page.locator('#storageBehaviorDetail').textContent(),/1(?:\.0)? GB부터 MOVE/);
  assert.match(await page.locator('#storagePreviewState').textContent(),/미저장/);assert(await page.locator('#archiveRun').isDisabled());
  await page.locator('#storageSettings > summary').click();await page.locator('#storageSettings > summary').click();
  assert.equal(await page.locator('#storageCustom').inputValue(),'1');assert(await field('allow_local_delete').isChecked());
  assert.equal(draftWrites,0);assert.equal(draftRuns,0,'drafts never execute archiving');
  await page.locator('#storageReset').click();assert(await page.getByRole('radio',{name:/복제 · COPY/}).isChecked());assert(await page.locator('#storageSave').isDisabled());assert(await page.locator('#archiveRun').isEnabled());
  await page.getByRole('radio',{name:/Google Drive/}).focus();await page.keyboard.press('ArrowRight');assert(await page.getByRole('radio',{name:/NAS · 네트워크 저장소/}).isChecked());await page.keyboard.press('ArrowLeft');
  assert(await page.getByRole('radio',{name:/Google Drive/}).isChecked());assert(await page.locator('#storageSave').isDisabled(),'keyboard round trip preserves all values');
  page.off('request',watch);
  await page.getByRole('radio',{name:/NAS · 네트워크 저장소/}).check();await field('path').fill(nas);await field('nas_max_mb').fill('8192');await field('nas_margin_mb').fill('2048');await save();
  assert.equal(await page.locator('#gdrivePanel').count(),0);assert(await field('path').isVisible());assert(await field('gdrive_folder_name').isHidden());
  prefs=JSON.parse(fs.readFileSync(path.join(root,'.archive-settings.json'),'utf8'));
  assert.equal(prefs.archive_backend,'smb');assert.equal(prefs.archive_nas_max_mb,8192);assert.equal(prefs.archive_nas_margin_mb,2048);
  assert(!fs.existsSync(path.join(root,'.archive.json')),'saving must not activate a backend');
  for(const width of [320,390,768,1280,1920]){await page.setViewportSize({width,height:900});assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'no overflow at '+width)}
  for(const secret of ['hidden-client-id','hidden-client-secret','archive_gdrive_client_id','archive_gdrive_client_secret'])assert(!(await page.content()).includes(secret));
  await page.setViewportSize({width:1280,height:900});
  // Server errors are rendered as text, never markup.
  await field('batch').fill('3');
  await page.route('**/api/settings/archive',route=>route.fulfill({status:409,json:{error:'archive_running'}}));
  await page.locator('#storageSave').click();await page.waitForFunction(()=>document.getElementById('archiveSettingsStatus').textContent==='아카이빙이 실행 중입니다. 완료 후 저장하세요.');
  await page.route('**/api/settings/archive',route=>route.fulfill({status:400,json:{error:'<img src=x onerror=alert(1)>'}}));
  await page.locator('#storageSave').click();await page.waitForFunction(()=>document.getElementById('archiveSettingsStatus').textContent.includes('<img'));
  assert.equal(await page.locator('#archiveSettingsStatus img').count(),0);
  await page.unroute('**/api/settings/archive');
  // A two-endpoint save reports partial persistence without resetting the remaining draft.
  await page.getByRole('radio',{name:/Google Drive/}).check();
  await page.locator('#storageLimitChoice').click();await page.getByRole('option',{name:'직접 입력',exact:true}).click();await page.locator('#storageCustom').fill('4');
  let partialWrites=0;
  const countPartial=request=>{if(request.method()==='POST'&&request.url().endsWith('/api/settings/archive'))partialWrites++};page.on('request',countPartial);
  await page.route('**/api/settings/storage',route=>route.request().method()==='POST'?route.fulfill({status:503,json:{error:'quota_unavailable',message:'용량 설정 저장 실패'}}):route.continue());
  await page.locator('#storageSave').click();await page.waitForFunction(()=>document.getElementById('archiveSettingsStatus').dataset.state==='error');
  assert.match(await page.locator('#archiveSettingsStatus').textContent(),/아카이빙 설정은 저장됐지만/);assert.equal(await page.locator('#storageCustom').inputValue(),'4');assert(await page.locator('#storageSave').isEnabled());assert(await page.locator('#archiveRun').isDisabled());
  prefs=JSON.parse(fs.readFileSync(path.join(root,'.archive-settings.json'),'utf8'));assert.equal(prefs.archive_backend,'gdrive');assert.equal(prefs.archive_batch,3);assert.equal(prefs.archive_path,nas);assert.equal(prefs.archive_nas_max_mb,8192);assert.equal(prefs.archive_nas_margin_mb,2048);
  await page.unroute('**/api/settings/storage');await save();assert.equal(partialWrites,1,'retry saves only the remaining quota change');page.off('request',countPartial);
  assert.equal((await page.evaluate(()=>fetch('api/settings/storage').then(r=>r.json()))).max_bytes,4*1024**3);
  assert(!fs.existsSync(path.join(root,'.archive.json')),'editing and saving still never activate or MOVE data');
  // Saving is visibly in progress and the editor is locked until the response settles.
  let held;await page.route('**/api/settings/archive',route=>{if(route.request().method()==='POST')held=route;else route.continue()});
  await field('gdrive_folder_name').fill('Saved folder');await page.locator('#storageSave').click();await page.waitForFunction(()=>document.getElementById('archiveSettingsStatus').dataset.state==='saving');
  assert(await field('gdrive_folder_name').isDisabled());assert(await page.locator('#storageEditorFields').evaluate(el=>el.disabled));assert(await page.locator('#storageSave').isDisabled());
  assert(held);await held.continue();await page.waitForFunction(()=>document.getElementById('archiveSettingsStatus').dataset.state==='saved');await page.unroute('**/api/settings/archive');
  assert.deepEqual(errors,[]);
  console.log('PASS: archive settings backend fields, COPY/MOVE deletion warning, live save, reload persistence, status refresh, no activation, no DOM secrets, errors as text, mobile layout');
 }finally{
  await browser?.close();if(python?.exitCode===null){python.kill();await once(python,'exit')}
  fs.rmSync(temp,{recursive:true,force:true});
 }
})().catch(error=>{console.error(error);process.exitCode=1});
