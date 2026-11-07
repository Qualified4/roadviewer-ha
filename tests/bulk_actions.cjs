const fs=require('fs'),path=require('path'),assert=require('node:assert/strict'),{chromium}=require('playwright');
const {settleLayout}=require('./browser-helpers.cjs');
(async()=>{
 const browser=await chromium.launch({headless:true});require('./browser-helpers.cjs').openRouteGroups(browser);
 try{
  const page=await browser.newPage({viewport:{width:390,height:844},hasTouch:true}),errors=[],calls=[],conversions=[];
  page.on('pageerror',e=>errors.push(e.message));
  let deleteGate=null,releaseDelete,failLoad=false,failConvert=true,expectPinProtection=true;
  let logs=Array.from({length:30},(_,i)=>({id:String(i),name:`00000395--${i<15?'aaaaaaaaaa':'bbbbbbbbbb'}--${i%15}`,status:i===0?'processing':'ready',bytes:10,prepared_bytes:20,uploaded:i,video:true,log_bytes:1048576,video_downloads:i%2?[{source:'qcamera',kind:'qcamera.ts',bytes:2097152},{source:'front',kind:'fcamera.hevc',bytes:52428800}]:[]}));
  await page.route('**/*',async route=>{
   const p=new URL(route.request().url()).pathname,request=route.request();
   if(p==='/api/logs')return failLoad?route.fulfill({status:500,json:{error:'목록 실패'}}):route.fulfill({json:{logs,concurrency:1,auto_convert:false,max_upload_mb:512,storage_used_bytes:logs.reduce((sum,log)=>sum+log.bytes+log.prepared_bytes,0)}});
   if(p==='/api/progress')return route.fulfill({json:{progress:{}}});
   if(request.method()==='POST'&&p.endsWith('/convert')){
    const id=p.split('/')[3];conversions.push(id);
    if(id==='2'&&failConvert)return route.fulfill({status:409,json:{error:'변환 요청 실패'}});
    const row=logs.find(row=>row.id===id);row.status='queued';return route.fulfill({json:{status:'queued'}});
   }
   if(request.method()==='DELETE'){
    calls.push(p);if(deleteGate){const gate=deleteGate;deleteGate=null;await gate}
    const id=p.split('/')[3],row=logs.find(row=>row.id===id);
    assert.equal(new URL(request.url()).searchParams.get('skip_pinned'),expectPinProtection?'1':null);
    if(row.pinned&&expectPinProtection)return route.fulfill({json:{skipped:'pinned'}});
    if(p.endsWith('/prepared')){
     if(row.status==='processing')return route.fulfill({status:409,json:{error:'처리 중에는 제거할 수 없습니다.'}});
     row.status='unconverted';row.prepared_bytes=0;
    }else logs=logs.filter(row=>row.id!==id);
    return route.fulfill({json:{ok:true}});
   }
   if(p.startsWith('/api/'))return route.fulfill({status:404,json:{error:'not_found'}});
   const name=p==='/'?'library.html':p.replace('/assets/',''),file='roadviewer/app/web/'+name;
   if(!fs.existsSync(file))return route.abort();
   return route.fulfill({body:fs.readFileSync(file),contentType:name.endsWith('.js')?'application/javascript':name.endsWith('.css')?'text/css':name.endsWith('.html')?'text/html':name.endsWith('.svg')?'image/svg+xml':name.endsWith('.woff2')?'font/woff2':'application/octet-stream'});
  });
  await page.goto('https://rv.test/');await page.waitForSelector('.log-row');
  const inputs=page.locator('.segment-select input'),routeSelects=page.locator('.route-select input'),bar=page.locator('#bulkBar');
  const selected=()=>inputs.evaluateAll(els=>els.filter(e=>e.checked).map(e=>e.value));
  const enter=async()=>{await page.locator('#bulkOpen').click();await bar.waitFor()};
  const exit=async()=>{await page.locator('#bulkClose').click();await bar.waitFor({state:'hidden'})};
  const act=async id=>{if(!(await page.locator('#'+id).isVisible()))await page.locator('#bulkMore').click();await page.locator('#'+id).click()};
  const result=async text=>{await page.waitForFunction(text=>document.getElementById('bulkStatus').textContent.includes(text)&&!document.getElementById('bulkClose').disabled,text)};
  const replace=async items=>{logs=items;await page.evaluate(()=>refresh())};
  failLoad=true;await page.locator('#refresh').click();await page.waitForFunction(()=>document.getElementById('error').textContent==='로그 목록을 읽을 수 없습니다.');failLoad=false;
  await enter();assert.equal(await page.locator('#bulkDialog').count(),0,'the old dialog is removed');assert.equal(await inputs.count(),30);
  assert(await page.locator('#bulkAll').evaluate(e=>e===document.activeElement));assert(await page.locator('#bulkRemove').isDisabled());assert.equal(await routeSelects.count(),2,'full route hashes stay separate');
  assert(await page.locator('#bulkFeedback').isHidden(),'no result panel without a message');assert(await page.locator('#bulkOpen').isEnabled());assert.equal(await page.locator('#bulkOpen').getAttribute('aria-pressed'),'true');
  await routeSelects.first().check();assert.equal((await selected()).length,15);assert(await page.locator('#bulkAll').evaluate(e=>e.indeterminate));
  await inputs.nth(1).uncheck();assert(await routeSelects.first().evaluate(e=>e.indeterminate));assert.equal(await page.locator('.route-selection-count').first().textContent(),'14 / 15개 구간');
  await routeSelects.first().check();await routeSelects.first().uncheck();assert.deepEqual(await selected(),[]);
  await page.locator('.log-route>summary .route-time').first().click();assert.equal((await selected()).length,15,'card click selects its segments');
  await page.locator('.log-row .log-meta').first().click();assert.equal((await selected()).length,14,'row click toggles without playing');assert.equal(page.url(),'https://rv.test/');
  await page.locator('.log-route-chevron').first().click();await settleLayout(page,'#panel-logs');assert(!(await page.locator('.log-route').first().evaluate(e=>e.open)),'segments can fold in selection mode');
  await page.locator('.log-route-chevron').first().click();await settleLayout(page,'#panel-logs');
  assert(await page.locator('.log-row .actions').first().isHidden());assert(await page.locator('.log-route-actions').first().isHidden());
  // Search + global tri-state operate on filtered segments. Hidden selections survive filter changes.
  await page.locator('#bulkAll').check();await page.locator('#bulkAll').uncheck();await inputs.nth(0).check();
  await page.locator('#logSearch').fill('bbbbbbbbbb');assert((await page.locator('#bulkCount').textContent()).includes('필터로 숨김 1개'));
  await page.locator('#bulkAll').check();assert.equal((await selected()).length,16);assert(await page.locator('#bulkAll').isChecked());
  await page.locator('#bulkAll').uncheck();assert.deepEqual(await selected(),['0'],'unselect-all also changes only visible segments');
  await page.locator('#logSearch').fill('');await page.locator('#logChips [data-filter="filter:processing"]').click();await page.locator('#bulkAll').uncheck();await page.locator('#bulkAll').check();assert.deepEqual(await selected(),['0']);
  await page.locator('#logChips [data-filter="filter:all"]').click();await page.locator('#bulkAll').check();assert.equal((await selected()).length,30);
  // Legacy ZIP: all variants, exact IDs, sizes, anchored above the bar, Escape and outside click.
  await page.locator('#bulkDownload').click();
  const menu=await page.$$eval('#bulkDownloadMenu a',els=>els.map(a=>({label:a.querySelector('span').textContent,href:a.getAttribute('href'),size:a.querySelector('small').textContent,download:a.hasAttribute('download')})));
  assert.deepEqual(menu.map(m=>m.label),['로그만','로그 + 저화질 영상','로그 + 모든 영상']);assert.deepEqual(menu.map(m=>m.size.split('약 ')[1]),['30.0 MB','60.0 MB','810.0 MB']);
  assert(menu.every(m=>m.download&&m.href.startsWith('api/logs/download.zip?ids='+logs.map(l=>l.id).join(','))));assert.deepEqual(menu.map(m=>m.href.split('parts=')[1]),['rlog','rlog,qcamera','rlog,front,wide,qcamera']);
  const menuBox=await page.locator('#bulkDownloadMenu').boundingBox();assert(menuBox.x>=0&&menuBox.x+menuBox.width<=390&&menuBox.y>=0);
  await page.keyboard.press('Escape');assert(await page.locator('#bulkDownloadMenu').isHidden());assert(await bar.isVisible(),'first Escape closes the menu');
  await page.locator('#bulkDownload').click();await page.locator('#bulkCount').click();assert(await page.locator('#bulkDownloadMenu').isHidden());
  page.once('dialog',d=>d.dismiss());await act('bulkDelete');assert.equal(calls.length,0);
  deleteGate=new Promise(resolve=>releaseDelete=resolve);page.once('dialog',d=>d.accept());await act('bulkRemove');
  await page.waitForFunction(()=>document.getElementById('bulkClose').disabled);assert(await routeSelects.first().isDisabled());assert(await inputs.first().isDisabled());assert(await page.locator('#bulkIncludePinned').isDisabled());assert.match(await page.locator('#bulkStatus').textContent(),/1 \/ 30개 처리 중/);
  await page.keyboard.press('Escape');assert(await bar.isVisible());releaseDelete();await result('29개 완료');
  assert.equal(calls.length,30);assert.equal(logs.length,30);assert.equal(logs.filter(l=>l.prepared_bytes===0).length,29);assert((await page.locator('#bulkFailures').textContent()).includes('처리 중'));assert.deepEqual(await selected(),['0']);
  page.once('dialog',d=>d.accept());await act('bulkDelete');await result('완전 삭제 1개 완료');await bar.waitFor({state:'hidden'});assert.equal(calls.at(-1),'/api/logs/0');assert.equal(logs.length,29);assert(await page.locator('#bulkFeedback').isVisible(),'successful result remains after exiting');
  await enter();await page.locator('#bulkAll').check();await act('bulkConvert');await result('변환 요청 28개 완료');assert.equal(conversions.length,29);assert.deepEqual(await selected(),['2']);assert((await page.locator('#bulkFailures').textContent()).includes('변환 요청 실패'));
  failConvert=false;await act('bulkConvert');await result('변환 요청 1개 완료');assert.equal(conversions.at(-1),'2');
  await page.locator('#bulkAll').check();assert(await page.locator('#bulkConvert').isDisabled(),'queued-only selection cannot resubmit');
  await page.keyboard.press('Escape');await bar.waitFor({state:'hidden'});assert(await page.locator('#bulkOpen').evaluate(e=>e===document.activeElement));assert.equal(await page.evaluate(()=>document.body.style.overflow),'');
  const log=(id,status='ready',extra={})=>({id,name:id,status,bytes:10,prepared_bytes:20,uploaded:1,...extra});
  await replace([log('pinned','unconverted',{pinned:true}),log('free'),log('late')]);await enter();
  assert(await page.locator('.log-row .pin-badge').first().isVisible());assert(!(await page.locator('#bulkIncludePinned').isChecked()));await inputs.nth(0).check();
  assert(await page.locator('#bulkRemove').isDisabled());assert(await page.locator('#bulkDelete').isDisabled());assert(await page.locator('#bulkConvert').isEnabled());
  assert((await page.locator('#bulkPinHint').textContent()).includes('모두 고정 로그'));
  logs[2].pinned=true; // The server protects a segment pinned after this list snapshot, too.
  await page.locator('#bulkAll').check();const beforePinned=calls.length;
  page.once('dialog',d=>{assert(d.message().includes('고정된 1개는 제외'));d.accept()});await act('bulkRemove');await result('변환 데이터 제거 1개 완료 · 건너뜀 2개');await bar.waitFor({state:'hidden'});
  assert.equal(calls.length-beforePinned,2);assert.equal(logs[0].prepared_bytes,20);assert.equal(logs[2].prepared_bytes,20);
  await enter();await page.locator('#bulkAll').check();page.once('dialog',d=>d.accept());await act('bulkDelete');await result('완전 삭제 1개 완료 · 건너뜀 2개');await bar.waitFor({state:'hidden'});assert.deepEqual(logs.map(row=>row.id),['pinned','late']);
  await enter();await page.locator('#bulkAll').check();await act('bulkConvert');await result('변환 요청 1개 완료 · 건너뜀 1개');assert.equal(conversions.at(-1),'pinned');await exit();
  // All conversion skip states, including pinned eligible logs and a server-side non-queued result.
  await replace([log('ready'),log('queued','queued'),log('processing','processing'),log('eligible','error',{pinned:true})]);await enter();await page.locator('#bulkAll').check();const beforeConvert=conversions.length;
  await act('bulkConvert');await result('변환 요청 1개 완료 · 건너뜀 3개');assert.deepEqual(conversions.slice(beforeConvert),['eligible']);assert.deepEqual(await selected(),[]);await exit();
  await replace([log('protected','ready',{name:'00000395--0d0eda17c5 / 구간 9',pinned:true})]);await enter();await page.locator('#bulkAll').check();
  assert((await page.locator('.log-row .log-name').textContent()).includes('구간 9'));if(!(await page.locator('#bulkIncludePinned').isVisible()))await page.locator('#bulkMore').click();await page.locator('#bulkIncludePinned').check();
  assert(await page.locator('#bulkRemove').isEnabled());assert(await page.locator('#bulkDelete').isEnabled());
  const beforeOverride=calls.length;page.once('dialog',d=>{assert(d.message().includes('고정된 항목도 삭제 대상에 포함'));d.dismiss()});await act('bulkDelete');assert.equal(calls.length,beforeOverride);
  expectPinProtection=false;deleteGate=new Promise(resolve=>releaseDelete=resolve);page.once('dialog',d=>d.accept());await act('bulkRemove');await page.waitForFunction(()=>document.getElementById('bulkClose').disabled);assert(await page.locator('#bulkIncludePinned').isDisabled());releaseDelete();
  await result('변환 데이터 제거 1개 완료');await bar.waitFor({state:'hidden'});assert.equal(logs[0].prepared_bytes,0);assert(logs[0].pinned);
  await enter();assert(!(await page.locator('#bulkIncludePinned').isChecked()),'override resets at each entry');await page.locator('#bulkAll').check();assert(await page.locator('#bulkDelete').isDisabled());
  if(!(await page.locator('#bulkIncludePinned').isVisible()))await page.locator('#bulkMore').click();await page.locator('#bulkIncludePinned').check();
  // Desktop is one 56px row; smaller screens have at most two rows, with less frequent actions in a popover.
  for(const [width,height] of [[320,568],[390,844],[768,844],[1300,900],[844,390]]){
   await page.setViewportSize({width,height});await page.locator('#bulkExtra').evaluate(e=>e.classList.remove('is-expanded'));await settleLayout(page,'#bulkBar');
   const barBox=await bar.boundingBox();assert(barBox.height<=(width>=1100?58:100),'compact bar '+width+'x'+height);
   if(width>=1100){const items=await page.locator('#bulkCount,#bulkAll,#bulkTags,#bulkDownload,#bulkConvert,#bulkRemove,#bulkDelete,#bulkIncludePinned,#bulkClose').evaluateAll(es=>es.map(e=>{const r=e.getBoundingClientRect();return r.y+r.height/2}));assert(Math.max(...items)-Math.min(...items)<2,'desktop actions align on a single row')}
   else{await page.locator('#bulkMore').click();assert(await page.locator('#bulkRemove').isVisible());assert.equal((await bar.boundingBox()).height,barBox.height,'More opens above the bar');await page.keyboard.press('Escape');assert(await bar.isVisible(),'first Escape closes More');assert(await page.locator('#bulkIncludePinned').isHidden())}
   const box=await page.locator('#bulkDock').boundingBox();assert(box.x>=0&&box.y>=0&&box.x+box.width<=width&&box.y+box.height<=height,'dock fits '+width+'x'+height);
   assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'no horizontal overflow');
   assert(await page.locator('#panel-logs').evaluate(e=>parseFloat(getComputedStyle(e).paddingBottom)>document.getElementById('bulkDock').getBoundingClientRect().height),'padding tracks dock height');
  }
  page.once('dialog',d=>d.accept());await act('bulkDelete');await result('완전 삭제 1개 완료');await bar.waitFor({state:'hidden'});assert.equal(logs.length,0);expectPinProtection=true;
  await replace([]);await enter();assert.equal(await page.locator('#bulkStatus').textContent(),'저장된 로그가 없습니다.');assert(await page.locator('#bulkAll').isDisabled());assert(await page.locator('#bulkDownload').isDisabled());await exit();
  // Download limit also applies to short IDs (not only a very long URL).
  await replace(Array.from({length:151},(_,i)=>log('limit'+i,'ready',{log_bytes:10})));await enter();await page.locator('#bulkAll').check();await act('bulkDownload');assert.equal(await page.locator('#bulkDownloadMenu a').count(),0);assert((await page.locator('#bulkDownloadMenu').textContent()).includes('150개 구간'));await page.keyboard.press('Escape');await exit();
  await replace([log('no-files')]);await enter();await page.locator('#bulkAll').check();await act('bulkDownload');assert((await page.locator('#bulkDownloadMenu').textContent()).includes('받을 수 있는 파일이 없습니다.'));await page.keyboard.press('Escape');await exit();
  // Touch long press: movement cancels; 500ms enters/selects; the release click cannot play or undo selection.
  await page.setViewportSize({width:390,height:844});await page.evaluate(()=>scrollTo(0,0));const row=page.locator('.log-row').first();await row.scrollIntoViewIfNeeded();
  const pointer={pointerType:'touch',isPrimary:true,pointerId:1,clientX:80,clientY:300};
  await row.dispatchEvent('pointerdown',pointer);await row.dispatchEvent('pointermove',{...pointer,clientY:320});await page.waitForTimeout(550);await row.dispatchEvent('pointerup',pointer);assert(await bar.isHidden(),'moving cancels long press');
  await row.dispatchEvent('pointerdown',pointer);await page.waitForTimeout(550);await row.dispatchEvent('pointerup',pointer);await row.locator('.log-meta').dispatchEvent('click');assert(await bar.isVisible());assert.deepEqual(await selected(),['no-files']);assert.equal(page.url(),'https://rv.test/');await page.keyboard.press('Escape');assert(await bar.isHidden());
  const summary=page.locator('.log-route>summary').first();await summary.dispatchEvent('pointerdown',pointer);await page.waitForTimeout(550);await summary.dispatchEvent('pointerup',pointer);assert(await bar.isVisible());assert.deepEqual(await selected(),['no-files']);await page.keyboard.press('Escape');
  // Mixed route + segment + ungrouped selection for four review screenshots.
  await page.evaluate(()=>error(''));
  const now=new Date().setHours(10,0,0,0)/1000;
  await replace(Array.from({length:10},(_,i)=>log('shot'+i,i===2?'processing':i===4?'unconverted':'ready',{name:`0000041b--${i<5?'a1b2c3d4e5':'b2c3d4e5f6'}--${i%5}`,uploaded:now+600+i,started_at:now-Math.floor(i/5)*3600+(i%5)*60,duration:60,pinned:i===0||i===6,tags:i<3?[{name:'고속도로',color:'blue'}]:[],log_bytes:1048576,video:true,bytes:65*1048576,prepared_bytes:24*1048576,video_downloads:[{source:'qcamera',kind:'qcamera.ts',bytes:2097152}],drive_summary:{engaged_ratio:.92,takeovers:1}})).concat(log('loose','error',{name:'기타 주행 로그',uploaded:now,error:'영상 파일을 확인해 주세요.'})));
  await enter();await inputs.nth(0).check();await inputs.nth(1).check();await inputs.last().check();
  assert.equal(await routeSelects.count(),3,'logs without routes remain selectable');assert(await routeSelects.first().evaluate(e=>e.indeterminate));
  await page.evaluate(()=>refresh());assert.deepEqual((await selected()).sort(),['loose','shot0','shot1'],'polling preserves selection');
  assert(await page.locator('#bulkFeedback').isHidden(),'selecting segments never leaves the empty-selection prompt visible');
  const ranges=await page.locator('.log-route').first().locator('.log-time').allTextContents();assert.deepEqual(ranges,['10:00–10:01','10:01–10:02','10:02–10:03','10:03–10:04','10:04–10:05'],'fixture segments run forward from the route departure');
  for(const [width,height] of [[1300,900],[390,844]]){
   await page.setViewportSize({width,height});await page.evaluate(()=>scrollTo(0,document.documentElement.scrollHeight));await page.waitForTimeout(100);
   const last=await page.locator('.log-row').last().boundingBox(),dockBox=await page.locator('#bulkDock').boundingBox();assert(last.y+last.height<=dockBox.y,'the final row scrolls above the action bar');
   if(width===390){const tabs=await page.locator('.lib-tabs').boundingBox();assert(dockBox.y+dockBox.height<=tabs.y,'selection bar is above phone tabs')}
   if(process.env.RV_SELECTION_SHOTS)for(const theme of ['dark','light']){
    await page.evaluate(theme=>document.documentElement.dataset.theme=theme,theme);await page.evaluate(()=>scrollTo(0,0));await settleLayout(page,'#panel-logs');
    fs.mkdirSync(process.env.RV_SELECTION_SHOTS,{recursive:true});await page.screenshot({path:path.join(process.env.RV_SELECTION_SHOTS,`selection-${theme}-${width}.png`)});
   }
  }
  assert.deepEqual(errors,[]);
  console.log('PASS: in-list tri-state/route/ungrouped selection, filtered select-all and hidden count, legacy ZIP sizes/150 limit, confirms/pin protection and override, skip rules, partial failures/retry, current status, disabled running/progress, success exit/results, Esc/focus, touch long press/movement, compact rows/More, forward time ranges, safe bottom bar and last-row padding');
 }finally{await browser.close()}
})().catch(e=>{console.error(e);process.exitCode=1});
