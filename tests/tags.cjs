const fs=require('fs'),os=require('os'),path=require('path'),assert=require('node:assert/strict'),{spawn}=require('child_process'),{once}=require('events'),{chromium}=require('playwright');
const {settleLayout}=require('./browser-helpers.cjs');
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
  browser=await chromium.launch({headless:true});require('./browser-helpers.cjs').openRouteGroups(browser);const context=await browser.newContext({viewport:{width:390,height:844},hasTouch:true,isMobile:true,reducedMotion:'reduce'}),page=await context.newPage(),errors=[];
  page.on('pageerror',error=>errors.push(error.message));
  const base=`http://127.0.0.1:${port}/api/hassio_ingress/test/`,read=id=>JSON.parse(fs.readFileSync(path.join(dir,id,'meta.json')));
  await page.goto(base);await page.locator('.log-row').first().waitFor();
  await page.evaluate(()=>document.fonts.ready);
  assert(await page.evaluate(()=>[...document.fonts].some(face=>face.family==='Pretendard Variable'&&face.status==='loaded')),'bundled Korean font loads through Ingress');
  assert((await page.locator('body').evaluate(e=>getComputedStyle(e).fontFamily)).includes('Pretendard Variable'));
  const row=id=>page.locator(`.log-row[data-id="${id}"]`),dialog=page.locator('.tag-dialog');
  // An unchanged list is answered 304 on the poll and stays as it was; a change made elsewhere arrives on the next poll.
  {const unchanged=await page.waitForResponse(r=>r.url().endsWith('/api/logs')&&r.status()===304);assert(unchanged.request().headers()['if-none-match'],'the poll names the list it holds');
   assert.equal(await page.locator('.log-row').count(),2);assert.equal(await page.locator('#error').textContent(),'');
   const tag=tags=>page.request.post(base+'api/logs/'+ids[1]+'/tags',{headers:{'X-RoadViewer-Request':'1'},data:{tags}});
   assert((await tag([{name:'다른 기기',color:'cyan'}])).ok());await row(ids[1]).getByText('다른 기기',{exact:true}).waitFor();
   assert((await tag([])).ok());await row(ids[1]).getByText('다른 기기',{exact:true}).waitFor({state:'detached'})}
  // 태그 편집 lives in each segment's ⋯ menu.
  const open=async id=>{await row(id).locator('.recording-more>summary').click();await row(id).getByRole('button',{name:'태그 편집',exact:true}).click();await dialog.waitFor();assert(await dialog.locator('#tagNameInput').evaluate(e=>e!==document.activeElement),'opening the picker does not raise the keyboard')};
  const add=async(name,color)=>{await dialog.locator('#tagNameInput').fill(name);if(color)await dialog.getByRole('button',{name:color,exact:true}).click();await dialog.locator('.tag-add').click()};
  const save=async()=>{await dialog.locator('.tag-save').click();await dialog.waitFor({state:'detached'})};
  await open(ids[0]);await page.keyboard.press('Escape');await dialog.waitFor({state:'detached'});assert.equal(await page.evaluate(()=>document.body.style.overflow),'');
  await open(ids[0]);await page.mouse.click(1,1);await dialog.waitFor({state:'detached'});assert.equal(await page.evaluate(()=>document.body.style.overflow),'');
  await open(ids[0]);await add('  야간   주행  ','파랑');await add('검토 필요','보라');await add('<img src=x onerror=alert(1)>','분홍');
  assert.equal(await dialog.locator('.tag-draft-chip').count(),3);assert.equal(await dialog.locator('.tag-draft img').count(),0,'names are text, never HTML');
  for(const [width,height] of [[320,568],[768,844],[1440,900],[844,390]]){
   await page.setViewportSize({width,height});await settleLayout(page,'.tag-dialog');const box=await dialog.boundingBox();assert(box.x>=0&&box.y>=0&&box.x+box.width<=width&&box.y+box.height<=height);assert(await dialog.evaluate(e=>e.scrollWidth<=e.clientWidth),'no dialog overflow');assert(await dialog.locator('.tag-save').isVisible());
  }
  await page.setViewportSize({width:390,height:844});
  if(process.env.RV_TAG_SCREENSHOT)await page.screenshot({path:process.env.RV_TAG_SCREENSHOT});
  await save();assert.deepEqual(read(ids[0]).tags.map(t=>t.name),['야간 주행','검토 필요','<img src=x onerror=alert(1)>']);assert.equal(read(ids[0]).tags[0].color,'blue');
  await row(ids[0]).locator('.recording-tags').waitFor();await page.reload();await row(ids[0]).locator('.recording-tags').waitFor();
  // The title line reads name, time, state and then 고정; the tags always take the line below it, however few.
  {const pin=await page.request.post(base+'api/logs/'+ids[0]+'/pin',{headers:{'X-RoadViewer-Request':'1'},data:{pinned:true}});
   assert(pin.ok());await row(ids[0]).locator('.pin-badge').waitFor();
   const line=await row(ids[0]).locator('.log-name').evaluate(title=>{const box=s=>title.querySelector(s)?.getBoundingClientRect(),name=box('.recording-name'),state=box('.state'),pin=box('.pin-badge'),tags=box('.recording-tags');
    return {order:[...title.children].map(e=>e.className.split(' ')[0]),stateOnTitleLine:state.top<name.bottom,pinAfterState:pin.left>=state.right&&pin.top<name.bottom,tagsBelow:tags.top>=Math.max(name.bottom,state.bottom)-1,tagsAtStart:Math.abs(tags.left-name.left)<1}});
   assert.deepEqual(line.order.filter(c=>c!=='log-time'&&c!=='pin-badge'),['recording-name','state','recording-tags']);assert.deepEqual([line.stateOnTitleLine,line.pinAfterState,line.tagsBelow,line.tagsAtStart],[true,true,true,true],JSON.stringify(line));
   await page.request.post(base+'api/logs/'+ids[0]+'/pin',{headers:{'X-RoadViewer-Request':'1'},data:{pinned:false}})}
  // The card header does the same: its tags sit under the title line even when there is only one and it would fit beside.
  {const head=await page.locator('.log-route .route-heading').first().evaluate(heading=>{const tags=heading.querySelector('.route-tags'),first=tags.firstElementChild.getBoundingClientRect(),title=heading.querySelector('.route-time').getBoundingClientRect(),box=heading.getBoundingClientRect();
    return {shown:!tags.hidden,below:first.top>=title.bottom-1,atStart:Math.abs(first.left-box.left)<1}});
   assert.deepEqual(head,{shown:true,below:true,atStart:true})}
  // The ⋯ menu opens downwards while it fits above the bottom tabs and upwards when it does not; a touch outside it only
  // closes it (the row under the finger is not opened as well).
  {const more=row(ids[1]).locator('.recording-more'),menu=more.locator('.recording-menu');
   const measure=()=>more.evaluate(d=>{const m=d.querySelector('.recording-menu').getBoundingClientRect(),a=d.querySelector('summary').getBoundingClientRect(),tabs=document.querySelector('.lib-tabs').getBoundingClientRect();
    return {up:d.classList.contains('opens-up'),menuTop:m.top,menuBottom:m.bottom,anchorTop:a.top,anchorBottom:a.bottom,tabsTop:tabs.top,tabsHeight:tabs.height}});
   const openMenu=async()=>{await more.locator('summary').tap();await menu.waitFor();await settleLayout(page,'.log-row[data-id="'+ids[1]+'"] .recording-more')};
   const closeMenu=async()=>{await page.keyboard.press('Escape');await page.waitForFunction(()=>!document.querySelector('.recording-more[open]'))};
   await page.setViewportSize({width:390,height:1200});await page.evaluate(()=>scrollTo(0,0));await openMenu();const down=await measure();
   assert(!down.up&&down.menuTop>=down.anchorBottom&&down.menuBottom<=down.tabsTop,'fits below: '+JSON.stringify(down));await closeMenu();
   await page.setViewportSize({width:390,height:Math.ceil(down.anchorBottom+down.tabsHeight+60)});await page.evaluate(()=>scrollTo(0,0));await openMenu();const up=await measure();
   assert(up.up&&up.menuBottom<=up.anchorTop&&up.menuBottom<=up.tabsTop,'no room below, so it opens upwards: '+JSON.stringify(up));
   const before=page.url();await row(ids[0]).locator('.log-meta').tap();await page.waitForFunction(()=>!document.querySelector('.recording-more[open]'));
   await page.waitForTimeout(300);assert.equal(page.url(),before,'the outside touch closed the menu without opening the row');
   await page.setViewportSize({width:390,height:844})}
  // +N shows every tag in a popup: the card neither folds nor plays, the popup stays on screen, and an outside touch or
  // Escape closes it without activating what is underneath.
  {const five=['하나','둘','셋','넷','다섯'].map(name=>({name,color:'cyan'})),set=tags=>page.request.post(base+'api/logs/'+ids[1]+'/tags',{headers:{'X-RoadViewer-Request':'1'},data:{tags}});
   assert((await set(five)).ok());const rowMore=row(ids[1]).locator('.tag-overflow'),headMore=page.locator('.log-route .route-heading .tag-overflow').first(),pop=page.locator('.tag-popover');
   await rowMore.waitFor();assert.equal(await rowMore.textContent(),'+1');await headMore.waitFor();
   const union=await page.evaluate(async()=>{const logs=(await (await fetch('api/logs')).json()).logs;return new Set(logs.flatMap(log=>(log.tags||[]).map(tag=>tag.name.toLowerCase()))).size});
   const group=page.locator('.log-route').first(),url=page.url();assert(await group.evaluate(g=>g.open));
   await headMore.tap();await pop.waitFor();await settleLayout(page,'.tag-popover');
   assert.equal(await pop.locator('.recording-tag').count(),union);assert.equal(await headMore.getAttribute('aria-expanded'),'true');assert(await group.evaluate(g=>g.open),'the card stays unfolded');assert.equal(page.url(),url);
   const fit=await pop.evaluate(p=>{const b=p.getBoundingClientRect(),tabs=document.querySelector('.lib-tabs').getBoundingClientRect(),bar=document.querySelector('.lib-appbar').getBoundingClientRect();return b.left>=8&&b.right<=innerWidth-8&&b.top>=bar.bottom&&b.bottom<=tabs.top});assert(fit,'the popup is clear of the screen edges, the app bar and the bottom tabs');
   await row(ids[0]).locator('.log-meta').tap();await pop.waitFor({state:'detached'});await page.waitForTimeout(300);assert.equal(page.url(),url,'an outside touch only closes the popup');
   await rowMore.tap();await pop.waitFor();assert.deepEqual(await pop.locator('.recording-tag').allTextContents(),five.map(tag=>tag.name));assert.equal(page.url(),url,'the row is not played');
   await page.keyboard.press('Escape');await pop.waitFor({state:'detached'});
   await rowMore.tap();await pop.waitFor();await rowMore.tap();await pop.waitFor({state:'detached'});
   assert((await set([])).ok());await rowMore.waitFor({state:'detached'})}
  // Web-owned filter works in the Ingress shell and remains applied during polling.
  const chip=name=>page.locator('#logChips .filter-chip').filter({hasText:name});
  await chip('야간 주행').click();assert.equal(await chip('야간 주행').getAttribute('aria-pressed'),'true');assert(await row(ids[0]).isVisible());assert(await row(ids[1]).isHidden());
  await Promise.all([page.waitForResponse(r=>r.url().endsWith('/api/logs')),page.locator('#refresh').click()]);await page.waitForFunction(()=>!document.getElementById('refresh').disabled);assert(await row(ids[1]).isHidden());
  await chip('태그 없음').click();assert(await row(ids[0]).isHidden());assert(await row(ids[1]).isVisible());
  await chip('전체').click();assert(await row(ids[0]).isVisible());assert(await row(ids[1]).isVisible());
  // Existing tags are searchable and selecting one reuses its color.
  await open(ids[1]);await dialog.locator('#tagNameInput').fill('야간');await dialog.locator('.tag-suggestions').getByRole('button',{name:'야간 주행',exact:true}).click();await save();assert.equal(read(ids[1]).tags[0].color,'blue');
  // The replay editor updates the same metadata and survives navigation back.
  await row(ids[0]).locator('.replay').click();await page.locator('#editReplayTags:enabled').waitFor();await page.locator('#editReplayTags').click();
  await dialog.getByRole('button',{name:'검토 필요 선택 해제',exact:true}).click();await add('급제동','주황');await save();
  assert(read(ids[0]).tags.some(t=>t.name==='급제동'));assert(!read(ids[0]).tags.some(t=>t.name==='검토 필요'));
  // The replay title is one line: only tags that fit in full are shown there (none on a phone), never a chip cut to "…";
  // the number beside them opens every tag, and the line has no 고정 chip (the pin button shows it).
  {const tags=page.locator('#replayTags'),more=tags.locator('.tag-overflow'),pop=page.locator('.tag-popover');await more.waitFor();
   await page.waitForFunction(()=>document.querySelector('.tag-popover')===null&&/^\+?\d+$/.test(document.querySelector('#replayTags .tag-overflow').textContent));
   const line=await tags.evaluate(box=>({cut:[...box.querySelectorAll('.recording-tag')].filter(chip=>chip.scrollWidth>chip.clientWidth).length,shown:box.querySelectorAll('.recording-tag').length,label:box.querySelector('.tag-overflow').textContent,inside:box.getBoundingClientRect().right<=document.querySelector('.app-subtitle').getBoundingClientRect().right+1,pin:document.querySelectorAll('.app-subtitle .pin-badge').length}));
   const total=read(ids[0]).tags.length;assert.deepEqual([line.cut,line.inside,line.pin],[0,true,0],JSON.stringify(line));assert.equal(line.label,(line.shown?'+':'')+(total-line.shown));
   const url=page.url();await more.tap();await pop.waitFor();assert.equal(await pop.locator('.recording-tag').count(),total);await pop.getByText('급제동',{exact:true}).waitFor();
   assert(await pop.evaluate(p=>{const b=p.getBoundingClientRect();return b.left>=8&&b.right<=innerWidth-8&&b.top>=0}));
   await page.keyboard.press('Escape');await pop.waitFor({state:'detached'});assert.equal(page.url(),url)}
  await page.locator('.back').click();await row(ids[0]).waitFor();
  await page.locator('#bulkOpen').click();await page.locator('.segment-select').first().waitFor();await page.locator('#bulkAll').check();await page.locator('#bulkTags').click();
  await add('인식 오류','보라');
  let failSecond=true;await page.route('**/api/logs/'+ids[1]+'/tags',route=>failSecond?route.fulfill({status:503,json:{error:'test retry'}}):route.continue());
  await dialog.locator('.tag-save').click();await dialog.getByText(/1개 저장 · 1개 미완료/).waitFor();assert(read(ids[0]).tags.some(t=>t.name==='인식 오류'));assert(!read(ids[1]).tags.some(t=>t.name==='인식 오류'));
  failSecond=false;await save();assert(read(ids[1]).tags.some(t=>t.name==='인식 오류'));assert(read(ids[0]).tags.some(t=>t.name==='급제동'),'bulk addition preserves unrelated tags');
  assert(await page.locator('#bulkBar').isVisible());assert.equal(await page.evaluate(()=>document.body.style.overflow),'','closing tag editor restores library scrolling');
  await page.locator('#bulkTags').click();await dialog.getByLabel('태그 제거',{exact:true}).check();await add('인식 오류');await save();
  for(const id of ids){assert(!read(id).tags.some(t=>t.name==='인식 오류'));assert(read(id).tags.some(t=>t.name==='야간 주행'))}
  await page.locator('#bulkClose').click();await page.waitForFunction(()=>document.body.style.overflow==='');
  // Removing playback data must not remove the user's tags.
  page.on('dialog',d=>d.accept());await row(ids[0]).locator('.recording-more>summary').click();await row(ids[0]).getByRole('button',{name:'제거',exact:true}).click();await row(ids[0]).getByRole('button',{name:'변환',exact:true}).waitFor();
  assert(read(ids[0]).tags.some(t=>t.name==='급제동'));await page.reload();await row(ids[0]).getByText('급제동',{exact:true}).waitFor();assert.deepEqual(errors,[]);
  // Existing-tag suggestions must not silently stop at twelve items.
  const catalog=Array.from({length:30},(_,i)=>({name:'기존 태그 '+String(i).padStart(2,'0'),color:'cyan'}));
  const seeded=await page.request.post(base+'api/logs/'+ids[0]+'/tags',{headers:{'X-RoadViewer-Request':'1'},data:{tags:catalog}});assert(seeded.ok());
  await page.reload();await row(ids[1]).waitFor();await open(ids[1]);
  assert.equal(await dialog.locator('.tag-suggestions button').count(),30);
  for(const [width,height] of [[320,568],[1440,900]]){
   await page.setViewportSize({width,height});
   const last=dialog.locator('.tag-suggestions button').last();await last.scrollIntoViewIfNeeded();assert(await last.isVisible());
   assert(await dialog.locator('.tag-save').isVisible());assert(await dialog.evaluate(e=>e.scrollWidth<=e.clientWidth));
  }
  // Android WebView can leave innerHeight unchanged while the keyboard reduces/pans visualViewport.
  await page.setViewportSize({width:390,height:844});
  await page.evaluate(()=>{
   Object.defineProperty(visualViewport,'height',{configurable:true,get:()=>400});
   Object.defineProperty(visualViewport,'offsetTop',{configurable:true,get:()=>64});
   visualViewport.dispatchEvent(new Event('resize'));
  });
  await dialog.locator('#tagNameInput').focus();
  await page.waitForFunction(()=>{const d=document.querySelector('.tag-dialog').getBoundingClientRect(),input=document.getElementById('tagNameInput').getBoundingClientRect(),save=document.querySelector('.tag-save').getBoundingClientRect();return d.top>=64&&d.bottom<=464&&input.top>=d.top&&input.bottom<=save.top&&save.bottom<=464});
  for(const colorScheme of ['dark','light']){await page.emulateMedia({colorScheme});await settleLayout(page,'.tag-dialog');if(process.env.RV_MOBILE_SHOTS){fs.mkdirSync(process.env.RV_MOBILE_SHOTS,{recursive:true});await page.screenshot({path:path.join(process.env.RV_MOBILE_SHOTS,`tags-keyboard-${colorScheme}.png`)})}}
  const last=dialog.locator('.tag-suggestions').getByRole('button',{name:'기존 태그 29',exact:true});await last.scrollIntoViewIfNeeded();await last.click();
  assert(await dialog.locator('#tagNameInput').evaluate(e=>e!==document.activeElement),'selecting an existing tag never refocuses the text field');
  assert((await dialog.locator('.tag-save').boundingBox()).y+(await dialog.locator('.tag-save').boundingBox()).height<=464,'save stays above the keyboard');
  await save();
  assert(read(ids[1]).tags.some(tag=>tag.name==='기존 태그 29'),'last existing tag remains selectable');
  console.log('PASS: tag editing, colors, text safety, persistence, filters, replay/Ingress, bulk add/remove/retry, responsive dialog and prepared-data removal');
 }finally{await browser?.close();if(python.exitCode===null){python.kill();await once(python,'exit')}fs.rmSync(dir,{recursive:true,force:true})}
})().catch(error=>{console.error(error);process.exitCode=1});
