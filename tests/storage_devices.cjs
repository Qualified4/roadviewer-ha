const fs=require('fs'),assert=require('node:assert/strict'),{chromium}=require('playwright');
(async()=>{
 const browser=await chromium.launch({headless:true});
 try{
 const page=await browser.newPage({viewport:{width:390,height:844}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
 let pinned=false,settings={max_bytes:0,policy:'reject_new',used_bytes:200,free_bytes:5000000,reserved_bytes:0},pair={status:'cancelled'},devices=[],revoke=false;
 await page.route('https://rv.test/**',route=>{
  const req=route.request(),p=new URL(req.url()).pathname;
  if(p==='/api/logs')return route.fulfill({json:{logs:[{id:'one',name:'00000395--0d0eda17c5 / 구간 7',status:'unconverted',uploaded:1,bytes:50,prepared_bytes:0,video:false,pinned}],max_upload_mb:512,storage_used_bytes:200}});
  if(p==='/api/settings/storage'){if(req.method()==='POST')settings={...settings,...req.postDataJSON()};return route.fulfill({json:settings})}
  if(p==='/api/logs/one/pin'){pinned=req.postDataJSON().pinned;return route.fulfill({json:{pinned}})}
  if(p==='/api/settings/devices')return route.fulfill({json:{enabled:true,devices}});
  if(p==='/api/settings/devices/pairing'){
   if(req.method()==='POST')pair={status:'waiting',code:'ABCDEF123456ABCDEF123456',expires_at:Date.now()/1000+300};
   if(req.method()==='DELETE')pair={status:'cancelled'};
   return route.fulfill({json:pair});
  }
  if(p==='/api/settings/devices/device/revoke'){revoke=true;devices[0].revoked=true;return route.fulfill({json:{revoked:true}})}
  const name=p==='/'?'library.html':p.replace('/assets/','');return route.fulfill({body:fs.readFileSync('roadviewer/app/web/'+name),contentType:name.endsWith('.html')?'text/html':name.endsWith('.js')?'application/javascript':name.endsWith('.css')?'text/css':'image/svg+xml'});
 });
 page.on('dialog',d=>d.accept());await page.goto('https://rv.test/');
 await page.locator('#storageSettings summary').click();await page.waitForFunction(()=>!document.getElementById('storageSave').disabled);
 await page.locator('#storageLimitChoice').click();await page.getByRole('option',{name:'사용자 지정',exact:true}).click();await page.locator('#storageCustom').fill('12.5');await page.locator('#storagePolicyChoice').click();await page.getByRole('option',{name:'오래된 미고정 주행 삭제',exact:true}).click();await page.locator('#storageSave').click();await page.waitForFunction(()=>document.getElementById('storageStatus').textContent==='저장했습니다.');assert.equal(settings.max_bytes,12.5*1073741824);
 await page.locator('.recording-more summary').click();await page.getByRole('button',{name:'Pin · 주행 고정',exact:true}).click();await page.locator('.pin-badge').waitFor();assert(pinned);
 await page.locator('.recording-more summary').click();await page.getByRole('button',{name:'Unpin · 고정 해제',exact:true}).click();await page.waitForFunction(()=>!document.querySelector('.pin-badge'));assert(!pinned);
 await page.locator('#deviceSettings summary').click();await page.locator('#pairOpen').click();await page.locator('#pairDialog[open]').waitFor();assert.equal(await page.locator('#pairCode').textContent(),'ABCDEF123456ABCDEF123456');
 assert(!(await page.evaluate(()=>JSON.stringify(localStorage))).includes('ABCDEF123456ABCDEF123456'));
 pair={status:'paired',expires_at:Date.now()/1000+300};devices=[{device_id:'device',name:'My comma',registered_at:1,last_seen:2,revoked:false}];
 await page.getByText('장치가 연결되었습니다.',{exact:true}).waitFor();await page.locator('#pairClose').click();await page.getByRole('button',{name:'Revoke · 연결 해제'}).click();await page.waitForFunction(()=>document.querySelector('.device-row button').disabled);assert(revoke);
 assert.deepEqual(errors,[]);assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
 console.log('storage settings, Pin, pairing and revoke UI passed');
 }finally{await browser.close()}
})().catch(e=>{console.error(e);process.exitCode=1});
