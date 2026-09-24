const fs=require('fs'),assert=require('node:assert/strict'),{chromium}=require('playwright');
(async()=>{
 const browser=await chromium.launch({headless:true});
 try{
  const page=await browser.newPage({viewport:{width:390,height:844}}),errors=[];
  page.on('pageerror',e=>errors.push(e.message));
  let pairing={status:'cancelled'},issued=0,fail=false,deleted=0,hold=false,held=null;
  await page.route('https://rv.test/**',async route=>{
   const req=route.request(),p=new URL(req.url()).pathname;
   if(p==='/api/logs')return route.fulfill({json:{logs:[],max_upload_mb:512,storage_used_bytes:0,concurrency:1}});
   if(p==='/api/settings/device-network')return route.fulfill({json:{configured_port:18443,active_port:18443,restart_required:false}});
   if(p==='/api/settings/devices')return route.fulfill({json:{enabled:true,devices:[]}});
   if(p==='/api/settings/devices/pairing'){
    if(req.method()==='POST'){
     if(fail)return route.fulfill({status:500,json:{error:'코드 발급 실패'}});
     pairing={status:'waiting',code:String(++issued).padStart(24,'A'),expires_at:Date.now()/1000+300};
    }
    if(req.method()==='DELETE'){deleted++;pairing={status:'cancelled'}}
    if(req.method()==='GET'&&hold){hold=false;held={route,json:{...pairing}};return}
    return route.fulfill({json:pairing});
   }
   const name=p==='/'?'library.html':p.replace('/assets/','');
   return route.fulfill({body:fs.readFileSync('roadviewer/app/web/'+name),contentType:name.endsWith('.html')?'text/html':name.endsWith('.js')?'application/javascript':name.endsWith('.css')?'text/css':'image/svg+xml'});
  });
  await page.goto('https://rv.test/');await page.locator('#deviceSettings>summary').click();
  fail=true;await page.locator('#pairOpen').click();await page.getByText('코드 발급 실패',{exact:true}).waitFor();assert.equal(await page.locator('#pairDialog').isVisible(),false);
  fail=false;await page.locator('#pairOpen').click();await page.locator('#pairDialog[open]').waitFor();
  assert.equal(await page.locator('#pairClose').textContent(),'취소');assert.equal(await page.locator('#pairDialog').getAttribute('data-state'),'waiting');
  // A status response started before renewal must not replace the newly issued code.
  hold=true;for(let i=0;i<100&&!held;i++)await page.waitForTimeout(50);assert(held);
  await page.locator('#pairRenew').click();await page.waitForFunction(()=>document.getElementById('pairCode').textContent.endsWith('2'));
  await held.route.fulfill({json:held.json});await page.waitForTimeout(100);
  assert.equal(await page.locator('#pairCode').textContent(),pairing.code);assert.equal(issued,2);
  fail=true;await page.locator('#pairRenew').click();await page.waitForFunction(()=>document.getElementById('pairStatus').textContent==='코드 발급 실패'&&!document.getElementById('pairRenew').disabled);assert.equal(issued,2);
  fail=false;await page.locator('#pairRenew').click();await page.waitForFunction(()=>document.getElementById('pairCode').textContent.endsWith('3'));
  pairing={status:'expired',expires_at:Date.now()/1000-1};
  await page.getByText('코드가 만료되었습니다',{exact:true}).waitFor();assert(await page.locator('#pairCopy').isHidden());assert.equal(await page.locator('#pairClose').textContent(),'닫기');
  await page.locator('#pairRenew').click();await page.waitForFunction(()=>document.getElementById('pairCode').textContent.endsWith('4'));assert.equal(await page.locator('#pairClose').textContent(),'취소');
  // Narrow phones, tablets and desktop keep the complete code and footer reachable.
  for(const [width,height] of [[320,640],[390,844],[768,1024],[1440,900],[844,390]]){
   await page.setViewportSize({width,height});
   assert(await page.locator('#pairDialog').evaluate(el=>el.scrollWidth<=el.clientWidth));
   assert(await page.locator('#pairCode').evaluate(el=>el.scrollWidth<=el.clientWidth));
   await page.locator('#pairClose').scrollIntoViewIfNeeded();const box=await page.locator('#pairClose').boundingBox();assert(box.x>=0&&box.x+box.width<=width&&box.y>=0&&box.y+box.height<=height);
  }
  await page.setViewportSize({width:390,height:844});
  pairing={status:'paired',expires_at:Date.now()/1000+300};await page.getByText('장치가 연결되었습니다.',{exact:true}).waitFor();
  assert.equal(await page.locator('#pairClose').textContent(),'닫기');assert.equal(await page.locator('#pairDialog').getAttribute('data-state'),'paired');assert(await page.locator('#pairCopy').isHidden());
  await page.locator('#pairRenew').click();await page.waitForFunction(()=>document.getElementById('pairCode').textContent.endsWith('5'));
  await Promise.all([page.waitForResponse(r=>r.url().endsWith('/devices/pairing')&&r.request().method()==='DELETE'),page.locator('#pairClose').click()]);assert.equal(deleted,1);
  await page.locator('#pairOpen').click();await page.locator('#pairDialog[open]').waitFor();await Promise.all([page.waitForResponse(r=>r.url().endsWith('/devices/pairing')&&r.request().method()==='DELETE'),page.keyboard.press('Escape')]);assert.equal(deleted,2);
  assert.deepEqual(errors,[]);console.log('PASS: pairing renewal before/after expiry and success, stale-response guard, failure recovery, cancellation and responsive dialog');
 }finally{await browser.close()}
})().catch(e=>{console.error(e);process.exitCode=1});
