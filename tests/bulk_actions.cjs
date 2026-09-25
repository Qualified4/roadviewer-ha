const fs=require('fs'),assert=require('node:assert/strict'),{chromium}=require('playwright');
(async()=>{
 const browser=await chromium.launch({headless:true});
 try{
  const page=await browser.newPage({viewport:{width:390,height:844}}),errors=[],calls=[],conversions=[];
  page.on('pageerror',e=>errors.push(e.message));
  let logs=Array.from({length:30},(_,i)=>({id:String(i),name:'주행 기록 / 구간 '+i,status:i===0?'processing':'ready',bytes:10,prepared_bytes:20,uploaded:i,video:true})),failLoad=false,failConvert=true,expectPinProtection=true;
  await page.route('https://rv.test/**',async route=>{
   const p=new URL(route.request().url()).pathname,request=route.request();
   if(p==='/api/logs')return failLoad?route.fulfill({status:500,json:{error:'목록 실패'}}):route.fulfill({json:{logs,concurrency:1,auto_convert:false,max_upload_mb:512,storage_used_bytes:900}});
   if(p==='/api/progress')return route.fulfill({json:{progress:{}}});
   if(request.method()==='POST'&&p.endsWith('/convert')){
    const id=p.split('/')[3];conversions.push(id);
    if(id==='2'&&failConvert)return route.fulfill({status:409,json:{error:'변환 요청 실패'}});
    const row=logs.find(row=>row.id===id);row.status='queued';return route.fulfill({json:{status:'queued'}});
   }
   if(request.method()==='DELETE'){
    calls.push(p);await new Promise(r=>setTimeout(r,15));
    const id=p.split('/')[3],row=logs.find(row=>row.id===id);
    assert.equal(new URL(request.url()).searchParams.get('skip_pinned'),expectPinProtection?'1':null);
    if(row.pinned&&expectPinProtection)return route.fulfill({json:{skipped:'pinned'}});
    if(p.endsWith('/prepared')){
     if(row.status==='processing')return route.fulfill({status:409,json:{error:'처리 중에는 제거할 수 없습니다.'}});
     row.status='unconverted';row.prepared_bytes=0;
    }else logs=logs.filter(row=>row.id!==id);
    return route.fulfill({json:{ok:true}});
   }
   const name=p==='/'?'library.html':p.replace('/assets/','');
   return route.fulfill({body:fs.readFileSync('roadviewer/app/web/'+name),contentType:name.endsWith('.js')?'application/javascript':name.endsWith('.css')?'text/css':name.endsWith('.html')?'text/html':'image/svg+xml'});
  });
  await page.goto('https://rv.test/');await page.waitForSelector('.log-row');
  failLoad=true;await page.locator('#bulkOpen').click();await page.waitForFunction(()=>document.getElementById('bulkStatus').textContent==='목록 실패');
  assert(await page.locator('#bulkAll').isDisabled());await page.locator('#bulkClose').click();failLoad=false;
  await page.locator('#bulkOpen').click();await page.waitForSelector('.bulk-log');
  assert.equal(await page.locator('.bulk-log').count(),30);assert(await page.locator('#bulkRemove').isDisabled());
  const inputs=page.locator('.bulk-log input');await inputs.nth(1).check();
  assert(await page.locator('#bulkAll').evaluate(e=>e.indeterminate));
  await page.locator('#bulkAll').check();assert.equal(await inputs.evaluateAll(els=>els.filter(e=>e.checked).length),30);
  const top=await page.locator('.bulk-select').boundingBox(),footer=await page.locator('.bulk-footer').boundingBox();
  await page.locator('#bulkList').evaluate(e=>e.scrollTop=e.scrollHeight);
  assert.equal((await page.locator('.bulk-select').boundingBox()).y,top.y);
  assert.equal((await page.locator('.bulk-footer').boundingBox()).y,footer.y);
  assert(top.y>=0&&footer.y+footer.height<=844);
  page.once('dialog',d=>d.dismiss());await page.locator('#bulkDelete').click();assert.equal(calls.length,0);
  page.once('dialog',d=>d.accept());await page.locator('#bulkRemove').click();
  await page.waitForFunction(()=>document.getElementById('bulkClose').disabled);await page.keyboard.press('Escape');
  assert(await page.locator('#bulkDialog').evaluate(e=>e.open));
  await page.waitForFunction(()=>!document.getElementById('bulkClose').disabled);
  assert.equal(calls.length,30);assert.equal(logs.length,30);assert.equal(logs.filter(l=>l.prepared_bytes===0).length,29);
  assert((await page.locator('#bulkStatus').textContent()).includes('29개 완료'));
  assert((await page.locator('#bulkFailures').textContent()).includes('처리 중'));
  assert.equal(await inputs.evaluateAll(els=>els.filter(e=>e.checked).length),1);
  page.once('dialog',d=>d.accept());await page.locator('#bulkDelete').click();
  await page.waitForFunction(()=>document.getElementById('bulkStatus').textContent.includes('완전 삭제 1개 완료'));
  assert.equal(calls.at(-1),'/api/logs/0');assert.equal(logs.length,29);
  await page.locator('#bulkAll').check();await page.locator('#bulkConvert').click();
  await page.waitForFunction(()=>document.getElementById('bulkStatus').textContent.includes('변환 요청 28개 완료'));
  assert.equal(conversions.length,29);assert.equal(logs.filter(row=>row.status==='queued').length,28);
  assert.equal(await inputs.evaluateAll(els=>els.filter(e=>e.checked).length),1);
  failConvert=false;await page.locator('#bulkConvert').click();
  await page.waitForFunction(()=>document.getElementById('bulkStatus').textContent==='변환 요청 1개 완료');
  assert.equal(conversions.at(-1),'2');
  await page.locator('#bulkAll').check();await page.locator('#bulkConvert').click();
  await page.waitForFunction(()=>document.getElementById('bulkStatus').textContent.includes('건너뜀 29개'));
  assert.equal(conversions.length,30,'queued jobs are not resubmitted');
  for(const width of [320,1280]){
   await page.setViewportSize({width,height:844});const box=await page.locator('#bulkDialog').boundingBox();
   assert(box.x>=0&&box.x+box.width<=width&&box.y>=0&&box.y+box.height<=844);
  }
  await page.keyboard.press('Escape');assert(await page.locator('#bulkDialog').isHidden());
  await page.waitForFunction(()=>document.body.style.overflow==='');
  assert(await page.locator('#bulkOpen').evaluate(e=>e===document.activeElement));
  logs=[{id:'pinned',name:'고정 로그',pinned:true,status:'unconverted',bytes:10,prepared_bytes:20},{id:'free',name:'일반 로그',status:'ready',bytes:10,prepared_bytes:20},{id:'late',name:'나중 고정',status:'ready',bytes:10,prepared_bytes:20}];
  await page.locator('#bulkOpen').click();await page.waitForFunction(()=>document.querySelectorAll('.bulk-log').length===3);
  assert(await page.locator('.bulk-log .pin-badge').first().isVisible());
  assert(!(await page.locator('#bulkIncludePinned').isChecked()));
  await inputs.nth(0).check();assert(await page.locator('#bulkRemove').isDisabled());assert(await page.locator('#bulkDelete').isDisabled());assert(await page.locator('#bulkConvert').isEnabled());
  logs[2].pinned=true; // A different screen pins this after the popup loaded.
  await page.locator('#bulkAll').check();const beforePinned=calls.length;
  page.once('dialog',d=>{assert(d.message().includes('고정된 1개는 제외'));d.accept()});await page.locator('#bulkRemove').click();
  await page.waitForFunction(()=>document.getElementById('bulkStatus').textContent.includes('변환 데이터 제거 1개 완료 · 건너뜀 2개'));
  assert.equal(calls.length-beforePinned,2);assert.equal(logs[0].prepared_bytes,20);assert.equal(logs[2].prepared_bytes,20);
  await page.locator('#bulkAll').check();page.once('dialog',d=>d.accept());await page.locator('#bulkDelete').click();
  await page.waitForFunction(()=>document.getElementById('bulkStatus').textContent.includes('완전 삭제 1개 완료 · 건너뜀 2개'));
  assert.deepEqual(logs.map(row=>row.id),['pinned','late']);
  await page.locator('#bulkAll').check();assert(await page.locator('#bulkDelete').isDisabled());await page.locator('#bulkConvert').click();
  await page.waitForFunction(()=>document.getElementById('bulkStatus').textContent.includes('변환 요청 1개 완료 · 건너뜀 1개'));
  assert.equal(conversions.at(-1),'pinned');await page.locator('#bulkClose').click();
  logs=[{id:'protected',name:'00000395--0d0eda17c5 / 구간 9',pinned:true,status:'ready',bytes:10,prepared_bytes:20}];
  await page.locator('#bulkOpen').click();await page.waitForFunction(()=>document.querySelectorAll('.bulk-log').length===1);
  const include=page.locator('#bulkIncludePinned');assert(!(await include.isChecked()));
  assert((await page.locator('.bulk-log-title').textContent()).includes('395 / 구간 9'));
  await page.locator('#bulkAll').check();await include.check();
  assert(await page.locator('#bulkDelete').isEnabled());assert(await page.locator('#bulkRemove').isEnabled());
  const beforeOverride=calls.length;
  page.once('dialog',d=>{assert(d.message().includes('고정된 항목도 삭제 대상에 포함'));d.dismiss()});await page.locator('#bulkDelete').click();assert.equal(calls.length,beforeOverride);
  expectPinProtection=false;
  page.once('dialog',d=>d.accept());await page.locator('#bulkRemove').click();
  await page.waitForFunction(()=>document.getElementById('bulkClose').disabled);assert(await include.isDisabled());
  await page.waitForFunction(()=>document.getElementById('bulkStatus').textContent.includes('변환 데이터 제거 1개 완료'));
  assert.equal(logs[0].prepared_bytes,0);assert.equal(logs[0].pinned,true);
  await page.locator('#bulkClose').click();await page.locator('#bulkOpen').click();await page.waitForSelector('.bulk-log');
  assert(!(await include.isChecked()),'destructive override resets whenever opened');
  await page.locator('#bulkAll').check();assert(await page.locator('#bulkDelete').isDisabled());await include.check();
  for(const [width,height] of [[320,568],[768,844],[1280,844],[844,390]]){
   await page.setViewportSize({width,height});
   await page.locator('.bulk-help').evaluate(e=>e.open=true);
   const bounds=await page.locator('#bulkDialog').boundingBox(),footerBox=await page.locator('.bulk-footer').boundingBox();
   assert(bounds.x>=0&&bounds.y>=0&&bounds.x+bounds.width<=width&&bounds.y+bounds.height<=height);
   assert(footerBox.y+footerBox.height<=height,'actions fit with expanded help');
   assert(await page.locator('#bulkList').evaluate(e=>e.clientHeight>=50),'list remains usable with expanded help');
   assert(await page.locator('#bulkDialog').evaluate(e=>e.scrollWidth<=e.clientWidth),'dialog has no horizontal overflow');
  }
  await page.locator('.bulk-help').evaluate(e=>e.open=false);
  page.once('dialog',d=>{assert(d.message().includes('고정된 항목도 삭제 대상에 포함'));d.accept()});await page.locator('#bulkDelete').click();
  await page.waitForFunction(()=>document.getElementById('bulkStatus').textContent.includes('완전 삭제 1개 완료'));assert.equal(logs.length,0);
  await page.locator('#bulkClose').click();
  logs=[];await page.locator('#bulkOpen').click();await page.waitForFunction(()=>document.getElementById('bulkStatus').textContent==='저장된 로그가 없습니다.');
  assert(await page.locator('#bulkAll').isDisabled());assert.deepEqual(errors,[]);
  console.log('PASS: bulk selection, fixed select-all/footer, confirmation, partial failures, exact deletion targets, responsive dialog and empty/error states');
 }finally{await browser.close()}
})().catch(e=>{console.error(e);process.exitCode=1});
