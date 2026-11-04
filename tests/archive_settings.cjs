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
  python=spawn(process.env.RV_PYTHON||'python',['-u','-c',SERVER],{env:{...process.env,RV_DATA:root,RV_INGRESS_ONLY:'0',RV_ARCHIVE_ALLOW_ANY_PATH:'1',RV_ARCHIVE_OPTIONS_JSON:JSON.stringify({archive_gdrive_client_id:'hidden-client-id',archive_gdrive_client_secret:'hidden-client-secret'})},stdio:['ignore','pipe','pipe']});
  python.stderr.on('data',x=>stderr+=x);
  const port=await new Promise((resolve,reject)=>{
   const timer=setTimeout(()=>reject(Error('Server timeout '+stderr)),15000);let stdout='';
   python.once('exit',code=>{clearTimeout(timer);reject(Error('Server exit '+code+stderr))});
   python.stdout.on('data',x=>{stdout+=x;const m=/READY (\d+)/.exec(stdout);if(m){clearTimeout(timer);resolve(Number(m[1]))}});
  });
  const base=`http://127.0.0.1:${port}/api/hassio_ingress/test/`;
  browser=await chromium.launch({headless:true});
  const page=await browser.newPage({viewport:{width:1280,height:900},reducedMotion:'reduce'}),errors=[];
  page.on('pageerror',e=>errors.push(e.message));
  const field=name=>page.locator(`#archiveForm [name="archive_${name}"]`);
  async function open(){await page.locator('#storageSettings summary').click();await page.waitForFunction(()=>!document.getElementById('archiveSave').disabled)}
  async function save(){await page.locator('#archiveSave').click();await page.waitForFunction(()=>document.getElementById('archiveSettingsStatus').textContent==='저장했습니다. 재시작 없이 적용되었습니다.')}
  await page.goto(base);await page.locator('.log-row').first().waitFor();await open();
  assert.equal(await field('enabled').isChecked(),false);
  assert(await field('path').isVisible());assert(await field('gdrive_folder_name').isHidden());assert(await field('allow_local_delete').isHidden());
  assert.match(await page.locator('#archiveWarning').textContent(),/NAS.*항상 이동/);
  await field('backend').selectOption('gdrive');
  assert(await field('path').isHidden());assert(await field('nas_max_mb').isHidden());assert(await field('nas_margin_mb').isHidden());
  assert(await field('gdrive_folder_name').isVisible());assert(await field('allow_local_delete').isVisible());
  await field('mode').selectOption('move');
  assert.match(await page.locator('#archiveWarning').textContent(),/COPY로 동작/);
  await field('allow_local_delete').check();
  assert.equal(await page.locator('#archiveWarning.archive-warning').textContent(),'이동 모드 + 로컬 원본 삭제 허용: Google Drive에 검증된 사본이 생기면 이 기기의 원본이 삭제됩니다');
  await field('mode').selectOption('copy');assert.equal(await page.locator('#archiveWarning.archive-warning').count(),0);
  await field('allow_local_delete').uncheck();await field('enabled').check();
  await field('interval_minutes').fill('37');await field('min_age_hours').fill('168');await field('batch').fill('2');await field('local_threshold_mb').fill('3072');
  await field('gdrive_folder_name').fill('UI archive folder');await save();
  await page.locator('#gdriveConnect').waitFor();await page.locator('#archiveRun').waitFor();
  let prefs=await page.evaluate(()=>fetch('api/settings/archive').then(r=>r.json()));
  assert.equal(prefs.archive_interval_minutes,37);assert.equal(prefs.archive_mode,'copy');assert.equal(prefs.effective_mode,'copy');assert.equal(prefs.archive_enabled,true);
  assert.equal(prefs.archive_gdrive_folder_name,'UI archive folder');assert(prefs.client_configured);
  await page.reload();await page.locator('.log-row').first().waitFor();await open();
  assert.equal(await field('backend').inputValue(),'gdrive');assert.equal(await field('interval_minutes').inputValue(),'37');assert.equal(await field('gdrive_folder_name').inputValue(),'UI archive folder');
  await field('backend').selectOption('smb');await field('path').fill(nas);await field('nas_max_mb').fill('8192');await field('nas_margin_mb').fill('2048');await save();
  assert.equal(await page.locator('#gdrivePanel').count(),0);assert(await field('path').isVisible());assert(await field('gdrive_folder_name').isHidden());
  prefs=JSON.parse(fs.readFileSync(path.join(root,'archive-settings.json'),'utf8'));
  assert.equal(prefs.archive_backend,'smb');assert.equal(prefs.archive_nas_max_mb,8192);assert.equal(prefs.archive_nas_margin_mb,2048);
  assert(!fs.existsSync(path.join(root,'.archive.json')),'saving must not activate a backend');
  for(const width of [320,390,1280]){await page.setViewportSize({width,height:900});assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'no overflow at '+width)}
  for(const secret of ['hidden-client-id','hidden-client-secret','archive_gdrive_client_id','archive_gdrive_client_secret'])assert(!(await page.content()).includes(secret));
  // Server errors are rendered as text, never markup.
  await page.route('**/api/settings/archive',route=>route.fulfill({status:409,json:{error:'archive_running'}}));
  await page.locator('#archiveSave').click();await page.waitForFunction(()=>document.getElementById('archiveSettingsStatus').textContent==='아카이빙이 실행 중입니다. 완료 후 저장하세요.');
  await page.route('**/api/settings/archive',route=>route.fulfill({status:400,json:{error:'<img src=x onerror=alert(1)>'}}));
  await page.locator('#archiveSave').click();await page.waitForFunction(()=>document.getElementById('archiveSettingsStatus').textContent.includes('<img'));
  assert.equal(await page.locator('#archiveSettingsStatus img').count(),0);assert.deepEqual(errors,[]);
  console.log('PASS: archive settings backend fields, COPY/MOVE deletion warning, live save, reload persistence, status refresh, no activation, no DOM secrets, errors as text, mobile layout');
 }finally{
  await browser?.close();if(python?.exitCode===null){python.kill();await once(python,'exit')}
  fs.rmSync(temp,{recursive:true,force:true});
 }
})().catch(error=>{console.error(error);process.exitCode=1});
