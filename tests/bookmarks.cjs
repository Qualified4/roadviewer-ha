const fs=require('fs'),os=require('os'),path=require('path'),assert=require('node:assert/strict'),{spawn}=require('child_process'),{once}=require('events'),{chromium}=require('playwright');
const {settleLayout}=require('./browser-helpers.cjs');
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
  browser=await chromium.launch({headless:true});require('./browser-helpers.cjs').openRouteGroups(browser);const context=await browser.newContext({viewport:{width:390,height:844},hasTouch:true,isMobile:true,reducedMotion:'reduce'}),page=await context.newPage(),errors=[];
  page.on('pageerror',error=>errors.push(error.message));
  const base=`http://127.0.0.1:${port}/api/hassio_ingress/test/`,read=id=>JSON.parse(fs.readFileSync(path.join(dir,id,'meta.json')));
  await page.goto(base);await page.locator('.log-row').first().waitFor();
  await page.evaluate(()=>document.fonts.ready);
  assert(await page.evaluate(()=>[...document.fonts].some(face=>face.family==='Pretendard Variable'&&face.status==='loaded')),'bundled Korean font loads through Ingress');
  assert((await page.locator('body').evaluate(e=>getComputedStyle(e).fontFamily)).includes('Pretendard Variable'));
  await page.locator(`.log-row[data-id="${ids[0]}"] .replay`).click();await page.locator('#play:enabled').waitFor();
  const modal=page.locator('.bookmark-dialog'),panel=page.locator('#bookmarkView');
  const open=async()=>{
   const tab=await page.locator('[role=tab][aria-selected=true]').getAttribute('id');
   await page.locator('#bookmarkOpen').click();await modal.locator('.bookmark-title:enabled').waitFor();
   assert.equal(await page.locator('[role=tab][aria-selected=true]').getAttribute('id'),tab,'recording never moves away from the video/analysis tab');
   assert(await modal.locator('.bookmark-title').evaluate(e=>e!==document.activeElement),'touch recording does not automatically open the keyboard');
  };
  const seek=async time=>page.locator('#seek').evaluate((e,time)=>{e.value=time;e.dispatchEvent(new Event('input',{bubbles:true}))},time);
  const save=async()=>{await modal.locator('.bookmark-save').click();await modal.waitFor({state:'hidden'});await page.waitForFunction(()=>document.body.style.overflow==='')};
  const showList=async()=>{await page.locator('#bookmarkTab').click();await panel.waitFor()};
  // One-tap capture: no required title or keyboard, and the timestamp freezes when the editor opens.
  await seek(1);await open();await seek(3);assert.equal(await modal.locator('.bookmark-time').textContent(),'0:01.00');
  await modal.locator('.bookmark-now').click();assert.equal(await modal.locator('.bookmark-time').textContent(),'0:03.00');
  await save();assert.deepEqual(read(ids[0]).bookmarks.map(b=>[b.time,b.title]),[[3,'장면 0:03.00']]);
  await showList();page.once('dialog',d=>d.accept());await panel.getByRole('button',{name:'장면 0:03.00 삭제',exact:true}).click();await panel.getByText('북마크를 삭제했습니다.',{exact:true}).waitFor();
  await page.locator('#roadTab').click();await seek(2.5);await open();
  await modal.locator('.bookmark-title').fill('앞차 확인');await modal.locator('.bookmark-note').fill('<img src=x>\n상세 메모');await seek(3);assert.equal(await modal.locator('.bookmark-time').textContent(),'0:02.50');await save();
  assert.equal(read(ids[0]).bookmarks[0].time,2.5);await showList();assert.equal(await panel.locator('.bookmark-list img').count(),0);
  await seek(6);await open();
  for(const [width,height] of [[320,568],[768,844],[1440,900],[844,390]]){await page.setViewportSize({width,height});await settleLayout(page,'.bookmark-dialog');const box=await modal.boundingBox();assert(box.x>=0&&box.y>=0&&box.x+box.width<=width&&box.y+box.height<=height,'bookmark editor fits at '+width);assert(await modal.evaluate(e=>e.scrollWidth<=e.clientWidth))}
  await page.setViewportSize({width:390,height:844});await modal.locator('.bookmark-title').fill('두 번째');
  await page.evaluate(()=>{
   Object.defineProperty(visualViewport,'height',{configurable:true,get:()=>400});
   Object.defineProperty(visualViewport,'offsetTop',{configurable:true,get:()=>64});
   visualViewport.dispatchEvent(new Event('resize'));
  });
  await modal.locator('.bookmark-note').fill('키보드를 닫지 않고 저장합니다.');
  assert(await page.locator('.playback').isHidden(),'the transport bar cannot cover mobile text entry');
  await page.waitForFunction(()=>{const d=document.querySelector('.bookmark-dialog').getBoundingClientRect(),input=document.querySelector('.bookmark-note').getBoundingClientRect(),save=document.querySelector('.bookmark-save').getBoundingClientRect();return d.top>=64&&d.bottom<=464&&input.top>=d.top&&input.bottom<=save.top&&save.bottom<=464});
  for(const colorScheme of ['dark','light']){await page.emulateMedia({colorScheme});await settleLayout(page,'.bookmark-dialog');if(process.env.RV_MOBILE_SHOTS){fs.mkdirSync(process.env.RV_MOBILE_SHOTS,{recursive:true});await page.screenshot({path:path.join(process.env.RV_MOBILE_SHOTS,`bookmark-keyboard-${colorScheme}.png`)})}}
  await save();assert.equal(read(ids[0]).bookmarks.length,2);await page.locator('.playback').waitFor({state:'visible'});
  await page.evaluate(()=>{delete visualViewport.height;delete visualViewport.offsetTop;visualViewport.dispatchEvent(new Event('resize'))});
  await panel.getByRole('button',{name:'앞차 확인 수정',exact:true}).click();await modal.locator('.bookmark-title').fill('수정된 장면');await save();assert.equal(read(ids[0]).bookmarks[0].title,'수정된 장면');
  await panel.getByRole('button',{name:/0:02.50 수정된 장면/}).click();assert.equal(await page.locator('#seek').inputValue(),'2.5');assert.equal(await page.locator('#play').textContent(),'재생');
  await page.locator('#play').click();await panel.getByRole('button',{name:/0:06.00 두 번째/}).click();assert.equal(await page.locator('#play').textContent(),'일시정지');assert(Number(await page.locator('#seek').inputValue())>=6);await page.locator('#play').click();
  assert((await page.locator('.playback').boundingBox()).height<150,'bookmarks keep playback compact');assert.equal(await page.locator('#bookmarkCount').textContent(),'2');await page.locator('.bookmark-marker').first().click();assert.equal(await page.locator('#seek').inputValue(),'2.5');
  await page.reload();await page.locator('#play:enabled').waitFor();await page.locator('.bookmark-marker').first().waitFor();assert.equal(await page.locator('.bookmark-marker').count(),2);
  await open();await modal.locator('.bookmark-note').focus();await page.keyboard.press('Space');await page.keyboard.press('ArrowRight');assert.equal(await page.locator('#play').textContent(),'재생');assert.equal(await page.locator('#seek').inputValue(),'0');
  // Closing keeps an unfinished draft, including the captured time.
  await modal.locator('.bookmark-title').fill('초안');await modal.locator('.bookmark-close').click();await modal.waitFor({state:'hidden'});await seek(4);await open();assert.equal(await modal.locator('.bookmark-title').inputValue(),'초안');assert.equal(await modal.locator('.bookmark-time').textContent(),'0:00.00');
  let failed=true;await page.route('**/bookmarks',route=>route.request().method()==='POST'&&failed?route.fulfill({status:503,json:{error:'저장 테스트 오류'}}):route.continue());
  await modal.locator('.bookmark-title').fill('재시도');await modal.locator('.bookmark-save').click();await modal.getByText('저장 테스트 오류',{exact:true}).waitFor();assert.equal(await modal.locator('.bookmark-title').inputValue(),'재시도');failed=false;await save();assert.equal(read(ids[0]).bookmarks.length,3);
  await showList();page.once('dialog',d=>d.accept());await panel.getByRole('button',{name:'수정된 장면 삭제',exact:true}).click();await panel.getByText('북마크를 삭제했습니다.',{exact:true}).waitFor();assert.equal(read(ids[0]).bookmarks.length,2);assert.equal(await page.locator('.bookmark-marker').count(),2);
  // Escape and outside taps dismiss the editor without changing a bookmark.
  await open();await page.keyboard.press('Escape');await modal.waitFor({state:'hidden'});assert.equal(read(ids[0]).bookmarks.length,2);
  await open();await page.mouse.click(1,1);await modal.waitFor({state:'hidden'});
  // Disposing a SPA page while an editor is open restores scroll and discards page-local resources.
  await open();await page.evaluate(()=>document.querySelector('.back').click());await page.locator('.log-row').first().waitFor();assert.equal(await page.evaluate(()=>document.body.style.overflow),'');
  await page.locator(`.log-row[data-id="${ids[1]}"] .replay`).click();await page.locator('#play:enabled').waitFor();await showList();await panel.getByText('저장된 장면이 없습니다.',{exact:true}).waitFor();assert.equal(await page.locator('.bookmark-marker').count(),0);assert.deepEqual(errors,[]);
  console.log('PASS: quick bookmark capture without keyboard or tab switch, optional title, frozen timestamp/draft, keyboard-safe editor, edit/delete/retry, markers and SPA disposal');
 }finally{await browser?.close();if(python.exitCode===null){python.kill();await once(python,'exit')}fs.rmSync(dir,{recursive:true,force:true})}
})().catch(error=>{console.error(error);process.exitCode=1});
