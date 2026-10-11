const fs=require('fs'),os=require('os'),path=require('path'),assert=require('node:assert/strict'),{spawn}=require('child_process'),{once}=require('events'),{chromium}=require('playwright');
(async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'rv-tags-')),ids=['a'.repeat(32),'b'.repeat(32)];
 fs.writeFileSync(path.join(dir,'.processing-settings.json'),JSON.stringify({auto_convert:false}));
 for(const [i,id] of ids.entries()){
  const folder=path.join(dir,id);fs.mkdirSync(folder);fs.mkdirSync(path.join(folder,'prepared'));
  fs.writeFileSync(path.join(folder,'rlog.zst'),'fixture-'+i);
  fs.writeFileSync(path.join(folder,'meta.json'),JSON.stringify({id,status:'ready',name:`00000395--0d0eda17c5 / 구간 ${i}`,uploaded:2-i,files:{},video:false,decoder_version:'v28-runtime-geometry'}));
  fs.writeFileSync(path.join(folder,'prepared/data.json'),JSON.stringify({route:'태그 테스트',key:'tags',duration:10,warnings:[],video:null,frames:[{t:0,id:0,valid:true,lanes:[],edges:[],lp:[],es:[],leads:[]}]}));
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
  await page.locator('.log-row').first().locator('.replay').click();await page.locator('#play:enabled').waitFor();
  const open=async()=>{await page.locator('#bookmarkOpen').click();await page.locator('.bookmark-title:enabled').waitFor()},modal=page.locator('.bookmark-dialog');
  const seek=async time=>page.locator('#seek').evaluate((e,time)=>{e.value=time;e.dispatchEvent(new Event('input',{bubbles:true}))},time);
  const save=async()=>{await modal.locator('.bookmark-save').click();await modal.locator('.bookmark-result').getByText('북마크를 저장했습니다.',{exact:true}).waitFor()};
  await open();await page.keyboard.press('Escape');await modal.waitFor({state:'hidden'});await page.waitForFunction(()=>document.body.style.overflow==='');
  await open();await page.mouse.click(1,1);await modal.waitFor({state:'hidden'});await page.waitForFunction(()=>document.body.style.overflow==='');
  await seek(2.5);await open();assert.equal(await modal.locator('.bookmark-time').textContent(),'0:02.50');
  await modal.locator('.bookmark-title').fill('앞차 확인');await modal.locator('.bookmark-note').fill('<img src=x>\n상세 메모');await save();
  assert.equal(read(ids[0]).bookmarks[0].time,2.5);assert.equal(await modal.locator('.bookmark-list img').count(),0);
  for(const [width,height] of [[320,568],[768,844],[1440,900],[844,390]]){await page.setViewportSize({width,height});const box=await modal.boundingBox();assert(box.x>=0&&box.y>=0&&box.x+box.width<=width&&box.y+box.height<=height);assert(await modal.evaluate(e=>e.scrollWidth<=e.clientWidth))}
  await page.setViewportSize({width:390,height:844});if(process.env.RV_BOOKMARK_SCREENSHOT)await page.screenshot({path:process.env.RV_BOOKMARK_SCREENSHOT});await modal.locator('.bookmark-close').click();await seek(6);await open();
  await modal.locator('.bookmark-title').fill('두 번째');await save();assert.equal(read(ids[0]).bookmarks.length,2);
  await modal.getByRole('button',{name:'앞차 확인 수정',exact:true}).click();await modal.locator('.bookmark-title').fill('수정된 장면');await save();assert.equal(read(ids[0]).bookmarks[0].title,'수정된 장면');
  await modal.getByRole('button',{name:/0:02.50 수정된 장면/}).click();assert.equal(await page.locator('#seek').inputValue(),'2.5');assert.equal(await page.locator('#play').textContent(),'재생');
  await page.locator('#play').click();await open();await modal.getByRole('button',{name:/0:06.00 두 번째/}).click();assert.equal(await page.locator('#play').textContent(),'일시정지');assert(Number(await page.locator('#seek').inputValue())>=6);await page.locator('#play').click();
  assert((await page.locator('.playback').boundingBox()).height<130,'bookmarks keep playback compact');await page.locator('.bookmark-marker').first().click();assert.equal(await page.locator('#seek').inputValue(),'2.5');
  await page.reload();await page.locator('#play:enabled').waitFor();await page.locator('.bookmark-marker').first().waitFor();assert.equal(await page.locator('.bookmark-marker').count(),2);
  await open();await modal.locator('.bookmark-note').focus();await page.keyboard.press('Space');await page.keyboard.press('ArrowRight');assert.equal(await page.locator('#play').textContent(),'재생');assert.equal(await page.locator('#seek').inputValue(),'0');
  let failed=true;await page.route('**/bookmarks',route=>route.request().method()==='POST'&&failed?route.fulfill({status:503,json:{error:'저장 테스트 오류'}}):route.continue());
  await modal.locator('.bookmark-title').fill('재시도');await modal.locator('.bookmark-save').click();await modal.getByText('저장 테스트 오류',{exact:true}).waitFor();assert.equal(await modal.locator('.bookmark-title').inputValue(),'재시도');failed=false;await save();assert.equal(read(ids[0]).bookmarks.length,3);
  page.once('dialog',d=>d.accept());await modal.getByRole('button',{name:'수정된 장면 삭제',exact:true}).click();await modal.getByText('북마크를 삭제했습니다.',{exact:true}).waitFor();assert.equal(read(ids[0]).bookmarks.length,2);assert.equal(await page.locator('.bookmark-marker').count(),2);
  await modal.locator('.bookmark-close').click();await page.locator('.back').click();await page.locator('.log-row').first().waitFor();await page.locator('.log-row').nth(1).locator('.replay').click();await page.locator('#play:enabled').waitFor();await open();await modal.getByText('저장된 장면이 없습니다.',{exact:true}).waitFor();assert.equal(await page.locator('.bookmark-marker').count(),0);assert.deepEqual(errors,[]);
  console.log('PASS: bookmark capture/edit/delete, safe notes, responsive dialog, pause/play-preserving synchronized seeks, markers, reload, failure retry and segment isolation');
 }finally{await browser?.close();if(python.exitCode===null){python.kill();await once(python,'exit')}fs.rmSync(dir,{recursive:true,force:true})}
})().catch(error=>{console.error(error);process.exitCode=1});
