const fs=require('fs'),os=require('os'),path=require('path'),assert=require('node:assert/strict'),{spawn}=require('child_process'),{once}=require('events'),{chromium}=require('playwright');
(async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'rv-tags-')),ids=['a'.repeat(32),'b'.repeat(32)];
 fs.writeFileSync(path.join(dir,'.processing-settings.json'),JSON.stringify({auto_convert:false}));
 for(const [i,id] of ids.entries()){
  const folder=path.join(dir,id);fs.mkdirSync(folder);fs.mkdirSync(path.join(folder,'prepared'));
  fs.writeFileSync(path.join(folder,'rlog.zst'),'fixture-'+i);
  fs.writeFileSync(path.join(folder,'meta.json'),JSON.stringify({id,status:'ready',name:`00000395--0d0eda17c5 / 구간 ${i}`,uploaded:2-i,files:{},video:false,decoder_version:'v28-runtime-geometry'}));
  fs.writeFileSync(path.join(folder,'prepared/data.json'),JSON.stringify({route:'태그 테스트',key:'tags',duration:1,warnings:[],video:null,frames:[{t:0,id:0,valid:true,lanes:[],edges:[],lp:[],es:[],leads:[]}]}));
 }
 const python=spawn(process.env.RV_PYTHON||'python',['-u','-c',`import sys
sys.path.insert(0,'roadviewer/app')
import server
from werkzeug.serving import make_server
from werkzeug.middleware.dispatcher import DispatcherMiddleware
http=make_server('127.0.0.1',0,DispatcherMiddleware(server.app,{'/api/hassio_ingress/test':server.app}),threaded=True)
print('READY '+str(http.server_port),flush=True)
http.serve_forever()`],{env:{...process.env,RV_DATA:dir,RV_INGRESS_ONLY:'0'},stdio:['ignore','pipe','pipe']});
 let stderr='',browser;python.stderr.on('data',x=>stderr+=x);
 try{
  const port=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('Server timeout '+stderr)),15000);python.once('exit',code=>{clearTimeout(timer);reject(Error('Server exit '+code+stderr))});python.stdout.on('data',x=>{const m=/READY (\d+)/.exec(String(x));if(m){clearTimeout(timer);resolve(Number(m[1]))}})});
  browser=await chromium.launch({headless:true});const context=await browser.newContext({viewport:{width:390,height:844},reducedMotion:'reduce'}),page=await context.newPage(),errors=[];
  page.on('pageerror',error=>errors.push(error.message));
  const base=`http://127.0.0.1:${port}/api/hassio_ingress/test/`,read=id=>JSON.parse(fs.readFileSync(path.join(dir,id,'meta.json')));
  await page.goto(base);await page.locator('.log-row').first().waitFor();
  await page.evaluate(()=>document.fonts.ready);
  assert(await page.evaluate(()=>[...document.fonts].some(face=>face.family==='Pretendard Variable'&&face.status==='loaded')),'bundled Korean font loads through Ingress');
  assert((await page.locator('body').evaluate(e=>getComputedStyle(e).fontFamily)).includes('Pretendard Variable'));
  const row=id=>page.locator(`.log-row[data-id="${id}"]`),dialog=page.locator('.tag-dialog');
  const open=async id=>{await row(id).getByRole('button',{name:'태그 편집',exact:true}).click();await dialog.waitFor()};
  const add=async(name,color)=>{await dialog.locator('#tagNameInput').fill(name);if(color)await dialog.getByRole('button',{name:color,exact:true}).click();await dialog.locator('.tag-add').click()};
  const save=async()=>{await dialog.locator('.tag-save').click();await dialog.waitFor({state:'detached'})};
  await open(ids[0]);await add('  야간   주행  ','파랑');await add('검토 필요','보라');await add('<img src=x onerror=alert(1)>','분홍');
  assert.equal(await dialog.locator('.tag-draft-chip').count(),3);assert.equal(await dialog.locator('.tag-draft img').count(),0,'names are text, never HTML');
  for(const [width,height] of [[320,568],[768,844],[1440,900],[844,390]]){
   await page.setViewportSize({width,height});const box=await dialog.boundingBox();assert(box.x>=0&&box.y>=0&&box.x+box.width<=width&&box.y+box.height<=height);assert(await dialog.evaluate(e=>e.scrollWidth<=e.clientWidth),'no dialog overflow');assert(await dialog.locator('.tag-save').isVisible());
  }
  await page.setViewportSize({width:390,height:844});
  if(process.env.RV_TAG_SCREENSHOT)await page.screenshot({path:process.env.RV_TAG_SCREENSHOT});
  await save();assert.deepEqual(read(ids[0]).tags.map(t=>t.name),['야간 주행','검토 필요','<img src=x onerror=alert(1)>']);assert.equal(read(ids[0]).tags[0].color,'blue');
  await row(ids[0]).locator('.recording-tags').waitFor();await page.reload();await row(ids[0]).locator('.recording-tags').waitFor();
  // Web-owned filter works in the Ingress shell and remains applied during polling.
  await page.locator('#tagFilterChoice').click();await page.getByRole('option',{name:'야간 주행',exact:true}).click();assert(await row(ids[0]).isVisible());assert(await row(ids[1]).isHidden());
  await page.locator('#refresh').click();await page.waitForResponse(r=>r.url().endsWith('/api/logs'));assert(await row(ids[1]).isHidden());
  await page.locator('#tagFilterChoice').click();await page.getByRole('option',{name:'태그 없음',exact:true}).click();assert(await row(ids[0]).isHidden());assert(await row(ids[1]).isVisible());
  await page.locator('#tagFilterChoice').click();await page.getByRole('option',{name:'전체 태그',exact:true}).click();
  // Existing tags are searchable and selecting one reuses its color.
  await open(ids[1]);await dialog.locator('#tagNameInput').fill('야간');await dialog.locator('.tag-suggestions').getByRole('button',{name:'야간 주행',exact:true}).click();await save();assert.equal(read(ids[1]).tags[0].color,'blue');
  // The replay editor updates the same metadata and survives navigation back.
  await row(ids[0]).locator('.replay').click();await page.locator('#editReplayTags:enabled').waitFor();await page.locator('#editReplayTags').click();
  await dialog.getByRole('button',{name:'검토 필요 선택 해제',exact:true}).click();await add('급제동','주황');await save();
  assert(read(ids[0]).tags.some(t=>t.name==='급제동'));assert(!read(ids[0]).tags.some(t=>t.name==='검토 필요'));
  await page.locator('#replayTags').getByText('급제동',{exact:true}).waitFor();await page.locator('.back').click();await row(ids[0]).waitFor();
  await page.locator('#bulkOpen').click();await page.locator('.bulk-log').first().waitFor();await page.locator('#bulkAll').check();await page.locator('#bulkTags').click();
  await add('인식 오류','보라');
  let failSecond=true;await page.route('**/api/logs/'+ids[1]+'/tags',route=>failSecond?route.fulfill({status:503,json:{error:'test retry'}}):route.continue());
  await dialog.locator('.tag-save').click();await dialog.getByText(/1개 저장 · 1개 미완료/).waitFor();assert(read(ids[0]).tags.some(t=>t.name==='인식 오류'));assert(!read(ids[1]).tags.some(t=>t.name==='인식 오류'));
  failSecond=false;await save();assert(read(ids[1]).tags.some(t=>t.name==='인식 오류'));assert(read(ids[0]).tags.some(t=>t.name==='급제동'),'bulk addition preserves unrelated tags');
  assert(await page.locator('#bulkDialog').evaluate(e=>e.open));assert.equal(await page.evaluate(()=>document.body.style.overflow),'hidden','nested editor keeps bulk scroll lock');
  await page.locator('#bulkTags').click();await dialog.getByLabel('태그 제거',{exact:true}).check();await add('인식 오류');await save();
  for(const id of ids){assert(!read(id).tags.some(t=>t.name==='인식 오류'));assert(read(id).tags.some(t=>t.name==='야간 주행'))}
  await page.locator('#bulkClose').click();await page.waitForFunction(()=>document.body.style.overflow==='');
  // Removing playback data must not remove the user's tags.
  page.on('dialog',d=>d.accept());await row(ids[0]).locator('.recording-more>summary').click();await row(ids[0]).getByRole('button',{name:'제거',exact:true}).click();await row(ids[0]).getByRole('button',{name:'변환',exact:true}).waitFor();
  assert(read(ids[0]).tags.some(t=>t.name==='급제동'));await page.reload();await row(ids[0]).getByText('급제동',{exact:true}).waitFor();assert.deepEqual(errors,[]);
  console.log('PASS: tag editing, colors, text safety, persistence, filters, replay/Ingress, bulk add/remove/retry, responsive dialog and prepared-data removal');
 }finally{await browser?.close();if(python.exitCode===null){python.kill();await once(python,'exit')}fs.rmSync(dir,{recursive:true,force:true})}
})().catch(error=>{console.error(error);process.exitCode=1});
