const fs=require('fs'),assert=require('node:assert/strict'),{chromium}=require('playwright');
(async()=>{
 const browser=await chromium.launch({headless:true});
 try{
 const page=await browser.newPage({viewport:{width:390,height:844}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
 let pinned=false,settings={max_bytes:0,policy:'reject_new',used_bytes:200,free_bytes:5000000,reserved_bytes:0},pair={status:'cancelled'},devices=[],revoke=false,network={configured_port:18443,active_port:18443,restart_required:false,boot_id:'boot-one',restarting:false,restart_error:''},networkSaveError=false,networkRestartError=false,restartPolls=0;
 await page.route('https://rv.test/**',route=>{
  const req=route.request(),p=new URL(req.url()).pathname;
  if(p==='/api/logs')return route.fulfill({json:{logs:[{id:'one',name:'00000395--0d0eda17c5 / 구간 7',status:'unconverted',uploaded:1,bytes:50,prepared_bytes:0,video:false,pinned}],max_upload_mb:512,storage_used_bytes:200}});
  if(p==='/api/settings/storage'){if(req.method()==='POST')settings={...settings,...req.postDataJSON()};return route.fulfill({json:settings})}
  if(p==='/api/logs/one/pin'){pinned=req.postDataJSON().pinned;return route.fulfill({json:{pinned}})}
  if(p==='/api/settings/device-network'){
   if(req.method()==='POST'){
    if(networkSaveError)return route.fulfill({status:502,json:{error:'supervisor_unavailable',message:'설정 저장 실패'}});
    const body=req.postDataJSON();network.configured_port=body.enabled?body.port:null;network.restart_required=network.configured_port!==network.active_port;
   }else if(network.restarting){
    restartPolls++;
    if(restartPolls>2){network.boot_id='boot-two';network.active_port=network.configured_port;network.restart_required=false;network.restarting=false}
   }
   return route.fulfill({json:network});
  }
  if(p==='/api/settings/device-network/restart'){
   if(networkRestartError)return route.fulfill({status:502,json:{error:'supervisor_unavailable',message:'재시작 요청 실패'}});
   network.restarting=true;return route.fulfill({status:202,json:network});
  }
  if(p==='/api/settings/devices')return route.fulfill({json:{enabled:true,devices}});
  if(p==='/api/settings/devices/pairing'){
   if(req.method()==='POST')pair={status:'waiting',code:'ABCDEF123456ABCDEF123456',expires_at:Date.now()/1000+300};
   if(req.method()==='DELETE')pair={status:'cancelled'};
   return route.fulfill({json:pair});
  }
  if(p==='/api/settings/devices/device/revoke'){revoke=true;devices[0].revoked=true;return route.fulfill({json:{revoked:true}})}
  if(p==='/api/settings/devices/device'&&req.method()==='DELETE'){devices=[];return route.fulfill({json:{removed:true}})}
  const name=p==='/'?'library.html':p.replace('/assets/','');return route.fulfill({body:fs.readFileSync('roadviewer/app/web/'+name),contentType:name.endsWith('.html')?'text/html':name.endsWith('.js')?'application/javascript':name.endsWith('.css')?'text/css':'image/svg+xml'});
 });
 page.on('dialog',d=>d.accept());await page.goto('https://rv.test/');
 assert(await page.locator('.upload > #deviceSettings').count()===1);assert(await page.locator('.conversion-info > #storageSettings').count()===1);
 await page.locator('#storageSettings summary').click();await page.waitForFunction(()=>!document.getElementById('storageSave').disabled);
 await page.locator('#storageLimitChoice').click();await page.getByRole('option',{name:'사용자 지정',exact:true}).click();await page.locator('#storageCustom').fill('12.5');await page.locator('#storagePolicyChoice').click();await page.getByRole('option',{name:'오래된 미고정 구간 삭제',exact:true}).click();await page.locator('#storageSave').click();await page.waitForFunction(()=>document.getElementById('storageStatus').textContent==='저장했습니다.');assert.equal(settings.max_bytes,12.5*1073741824);
 assert.equal(await page.locator('.actions > .pin-recording').count(),1);
 await page.getByRole('button',{name:'구간 고정',exact:true}).click();await page.locator('.pin-badge').waitFor();assert(pinned);
 assert.equal(await page.locator('.pin-recording').getAttribute('aria-pressed'),'true');
 await page.getByRole('button',{name:'구간 고정 해제',exact:true}).click();await page.waitForFunction(()=>!document.querySelector('.pin-badge'));assert(!pinned);
 await page.locator('#deviceSettings > summary').click();
 await page.waitForFunction(()=>!document.getElementById('deviceNetworkEnabled').disabled);
 await page.locator('#deviceNetworkEnabled').uncheck();assert(await page.locator('#devicePortField').isHidden());
 await page.locator('#deviceNetworkSave').click();await page.waitForFunction(()=>!document.getElementById('deviceNetworkRestart').hidden);assert.equal(network.configured_port,null);assert.equal(network.active_port,18443);
 await page.locator('#deviceNetworkEnabled').check();await page.locator('#deviceNetworkPort').fill('19443');
 networkSaveError=true;await page.locator('#deviceNetworkSave').click();await page.getByText('설정 저장 실패',{exact:true}).waitFor();assert.equal(network.configured_port,null);assert.equal(await page.locator('#deviceNetworkPort').inputValue(),'19443');
 networkSaveError=false;await page.locator('#deviceNetworkSave').click();await page.waitForFunction(()=>document.getElementById('deviceNetworkStatus').textContent.includes('재시작 후 적용'));assert.equal(network.configured_port,19443);
 networkRestartError=true;await page.locator('#deviceNetworkRestart').click();await page.getByText('재시작 요청 실패',{exact:true}).waitFor();assert(!network.restarting);
 networkRestartError=false;await page.locator('#deviceNetworkRestart').click();await page.waitForFunction(()=>document.getElementById('deviceNetworkRestart').hidden);assert.equal(network.boot_id,'boot-two');assert.equal(network.active_port,19443);assert(restartPolls>2);
 await page.locator('#pairOpen').click();await page.locator('#pairDialog[open]').waitFor();assert.equal(await page.locator('#pairCode').textContent(),'ABCDEF123456ABCDEF123456');
 for(const width of [320,390,1280]){
  await page.setViewportSize({width,height:844});
  const layout=await page.locator('#pairDialog').evaluate(el=>{
   const box=el.getBoundingClientRect(),code=document.getElementById('pairCode'),copy=document.getElementById('pairCopy').getBoundingClientRect();
   return {left:box.left,right:box.right,bottom:box.bottom,overflow:el.scrollWidth>el.clientWidth,codeOverflow:code.scrollWidth>code.clientWidth,copyRight:copy.right};
  });
  assert(layout.left>=0&&layout.right<=width&&layout.bottom<=844);assert(!layout.overflow&&!layout.codeOverflow);assert(layout.copyRight<=layout.right);
 }
 await page.setViewportSize({width:390,height:844});
 await page.evaluate(()=>Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async text=>{window.copiedPairCode=text}}}));
 assert.equal(await page.locator('#pairCopy svg').innerHTML(),await page.locator('.recording-name .copy-recording svg').first().innerHTML());
 assert.equal(await page.locator('#pairCopy').evaluate(el=>getComputedStyle(el).width),'30px');
 await page.locator('#pairCopy').click();await page.waitForFunction(()=>document.getElementById('pairCopyIcon').textContent==='✓');assert.equal(await page.evaluate(()=>window.copiedPairCode),'ABCDEF123456ABCDEF123456');
 assert.equal(await page.locator('#pairCopyStatus').evaluate(el=>getComputedStyle(el).clipPath),'inset(50%)');
 assert.equal(await page.locator('#pairCopy').getAttribute('title'),'페어링 코드 복사');
 await page.locator('#pairCopyIcon svg').waitFor();assert.equal(await page.locator('#pairCopyStatus').textContent(),'');
 assert(!(await page.evaluate(()=>JSON.stringify(localStorage))).includes('ABCDEF123456ABCDEF123456'));
 pair={status:'paired',expires_at:Date.now()/1000+300};devices=[{device_id:'device',name:'My comma',registered_at:1,last_seen:2,revoked:false}];
 await page.getByText('장치가 연결되었습니다.',{exact:true}).waitFor();assert(await page.locator('#pairCopy').isDisabled());await page.locator('#pairClose').click();await page.getByRole('button',{name:'Revoke · 연결 해제'}).click();await page.getByRole('button',{name:'목록 제거',exact:true}).waitFor();assert(revoke);
 await page.getByRole('button',{name:'목록 제거',exact:true}).click();await page.waitForFunction(()=>!document.querySelector('.device-row'));assert.equal(devices.length,0);
 assert.deepEqual(errors,[]);assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
 console.log('storage settings, Pin, pairing, revoke and device removal UI passed');
 }finally{await browser.close()}
})().catch(e=>{console.error(e);process.exitCode=1});
