const fs=require('fs'),assert=require('node:assert/strict'),{chromium}=require('playwright');

// Mutations must win over a list read already in flight, even when the next read fails.
async function checkRemovalRefresh(browser){
 const deferred=()=>{let resolve;const promise=new Promise(done=>resolve=done);return {promise,resolve}};
 for(const scenario of ['stale','failed']){
  const context=await browser.newContext({viewport:{width:390,height:844},reducedMotion:'reduce'}),page=await context.newPage(),errors=[];
  // Freeze the polling clock; these cases exercise the removal-triggered refresh, not a later poll.
  await page.clock.install({time:new Date('2026-01-01T00:00:00Z')});
  await page.clock.pauseAt(new Date('2026-01-01T00:00:01Z'));
  page.on('pageerror',e=>errors.push(e.message));page.on('dialog',d=>d.accept());
  let status='ready',holdNext=false,failLists=false,removed=0,listReads=0;
  const staleSeen=deferred(),releaseStale=deferred(),staleFinished=deferred(),freshSeen=deferred();
  const list=()=>({logs:[{id:'pinned',name:'고정 로그',pinned:true,status,auto_excluded:status==='unconverted',uploaded:1,bytes:50,prepared_bytes:status==='ready'?200:0,video:true,video_download:'qcamera.ts'}],concurrency:1,auto_convert:true,keep_original_video:true,max_upload_mb:512,storage_used_bytes:250});
  await page.route('https://rv.test/**',async route=>{
   const p=new URL(route.request().url()).pathname;
   if(p==='/api/logs'){
    listReads++;const snapshot=list();
    if(holdNext){holdNext=false;staleSeen.resolve();await releaseStale.promise;try{await route.fulfill({json:snapshot})}catch{}finally{staleFinished.resolve()}return}
    if(removed)freshSeen.resolve();
    return failLists?route.fulfill({status:500,json:{error:'목록 조회 실패'}}):route.fulfill({json:snapshot});
   }
   if(p==='/api/logs/pinned/prepared'){
    assert.equal(route.request().method(),'DELETE');assert.equal(new URL(route.request().url()).search,'','individual removal can include a pinned recording');
    removed++;status='unconverted';if(scenario==='failed')failLists=true;
    return route.fulfill({json:{status}});
   }
   if(p==='/api/progress')return route.fulfill({json:{progress:{}}});
   const name=p==='/'?'library.html':p.replace('/assets/','');
   return route.fulfill({body:fs.readFileSync('roadviewer/app/web/'+name),contentType:name.endsWith('.html')?'text/html':name.endsWith('.js')?'application/javascript':name.endsWith('.css')?'text/css':'image/svg+xml'});
  });
  try{
   await page.goto('https://rv.test/');await page.locator('.replay').waitFor();assert(await page.locator('.pin-badge').isVisible());
   if(scenario==='stale'){holdNext=true;await page.evaluate(()=>{void refresh()});await staleSeen.promise}
   const postRemovalRead=page.waitForRequest(r=>new URL(r.url()).pathname==='/api/logs'&&removed>0,{timeout:2000});
   await page.locator('.recording-more>summary').click();await page.getByRole('button',{name:'제거',exact:true}).click();
   await postRemovalRead;await freshSeen.promise;
   await page.getByRole('button',{name:'변환',exact:true}).waitFor({timeout:2000});
   assert.equal(removed,1);assert.equal(await page.locator('.replay').count(),0,scenario+': successful removal immediately removes the replay action');
   assert((await page.locator('.state').textContent()).includes('수동 변환 필요'));assert(await page.locator('.pin-badge').isVisible());
   if(scenario==='stale'){
    releaseStale.resolve();await staleFinished.promise;
    await page.evaluate(()=>new Promise(resolve=>queueMicrotask(resolve)));
    assert.equal(await page.locator('.replay').count(),0,'the older ready response cannot restore replay');
    assert.equal(listReads,3,'removal refresh runs without waiting for a periodic poll');
   }else{
    await page.waitForFunction(()=>document.getElementById('error').textContent.includes('로그 목록을 읽을 수 없습니다.'));
    assert.equal(await page.locator('.replay').count(),0,'a failed list read cannot retain the removed replay action');
   }
   assert.deepEqual(errors,[]);
  }finally{releaseStale.resolve();await context.close()}
 }
}

(async()=>{
 const browser=await chromium.launch({headless:true});
 try{
  const page=await browser.newPage({viewport:{width:390,height:844}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
  let keep=true,automatic=true,status='ready',excluded=false,fail=false,converted=0,removed=0,deleted=0;
  await page.route('https://rv.test/**',route=>{
   const p=new URL(route.request().url()).pathname;
   if(p==='/api/logs')return route.fulfill({json:{logs:deleted?[]:[{id:'one',name:'test',status,auto_excluded:excluded,uploaded:1,bytes:50,prepared_bytes:status==='ready'?200:0,video:true,video_download:keep?'qcamera.ts':'camera.mp4'}],concurrency:1,auto_convert:automatic,keep_original_video:keep,max_upload_mb:512,storage_used_bytes:250}});
   if(p==='/api/progress')return route.fulfill({json:{progress:{}}});
   if(p==='/api/settings/processing'){
    if(fail)return route.fulfill({status:500,json:{error:'설정 저장 실패'}});
    const body=route.request().postDataJSON();if('auto_convert' in body)automatic=body.auto_convert;if('keep_original_video' in body)keep=body.keep_original_video;return route.fulfill({json:{concurrency:1,auto_convert:automatic,keep_original_video:keep}});
   }
   if(p.endsWith('/prepared')){assert.equal(route.request().method(),'DELETE');removed++;status='unconverted';excluded=true;return route.fulfill({json:{status}})}
   if(p.endsWith('/convert')){converted++;status='queued';return route.fulfill({json:{status}})}
   if(p==='/api/logs/one'){deleted++;return route.fulfill({json:{deleted:'one'}})}
   const name=p==='/'?'library.html':p.replace('/assets/','');return route.fulfill({body:fs.readFileSync('roadviewer/app/web/'+name),contentType:name.endsWith('.html')?'text/html':name.endsWith('.js')?'application/javascript':name.endsWith('.css')?'text/css':'image/svg+xml'});
  });
  await page.goto('https://rv.test/');await page.waitForFunction(()=>!document.getElementById('autoConvert').disabled);
  assert(await page.getByRole('heading',{name:'변환 및 저장 설정'}).isVisible());assert.equal(await page.locator('.status-guide dt').count(),5);assert(await page.evaluate(()=>document.querySelector('.upload').nextElementSibling.matches('.conversion-info')));
  const more=page.locator('.recording-more>summary');
  assert.equal(await page.getByRole('button',{name:'제거',exact:true}).isVisible(),false);
  assert.equal(await page.getByRole('link',{name:'영상 다운로드',exact:true}).isVisible(),false);
  await more.click();assert(await page.getByRole('button',{name:'제거',exact:true}).isVisible());
  assert((await page.getByRole('link',{name:'영상 다운로드',exact:true}).getAttribute('href')).endsWith('/download/video'));
  await page.evaluate(()=>refresh());assert(await page.locator('.recording-more').evaluate(e=>e.open),'polling keeps menu open');
  await page.keyboard.press('Escape');assert.equal(await page.locator('.recording-more').evaluate(e=>e.open),false);
  await more.click();await page.getByRole('heading',{name:'저장된 로그',exact:true}).click();
  assert.equal(await page.locator('.recording-more').evaluate(e=>e.open),false,'outside click closes menu');
  const guide=page.locator('.conversion-info');
  await guide.locator(':scope > summary').click();await page.waitForFunction(()=>localStorage.getItem('roadviewer-conversion-guide-open')==='false');
  await page.reload();assert.equal(await guide.evaluate(e=>e.open),false,'guide stays collapsed after reload');
  await guide.locator(':scope > summary').click();await page.waitForFunction(()=>localStorage.getItem('roadviewer-conversion-guide-open')==='true');
  await page.reload();assert.equal(await guide.evaluate(e=>e.open),true,'guide stays expanded after reload');
  await page.getByRole('switch',{name:'자동 변환'}).uncheck();await page.waitForFunction(()=>document.getElementById('autoConvertState').textContent==='꺼짐');assert.equal(automatic,false);
  await page.reload();assert.equal(await page.getByRole('switch',{name:'자동 변환'}).isChecked(),false);
  fail=true;await page.getByRole('switch',{name:'자동 변환'}).check();await page.waitForFunction(()=>document.getElementById('error').textContent==='설정 저장 실패');assert.equal(await page.getByRole('switch',{name:'자동 변환'}).isChecked(),false);fail=false;
  assert.equal(await guide.locator('#autoConvert, #concurrency, #keepOriginalVideo').count(),3);
  await page.getByRole('switch',{name:'원본 영상 같이 보관'}).uncheck();
  await page.waitForFunction(()=>[...document.querySelectorAll('.recording-menu a')].some(a=>a.href.endsWith('/download/video')));await more.click();
  await page.getByRole('link',{name:'영상 다운로드'}).waitFor();
  assert.equal(keep,false);assert((await page.getByRole('link',{name:'영상 다운로드'}).getAttribute('href')).endsWith('/download/video'));
  await page.reload();assert.equal(await page.getByRole('switch',{name:'원본 영상 같이 보관'}).isChecked(),false);
  fail=true;await page.getByRole('switch',{name:'원본 영상 같이 보관'}).check();
  await page.waitForFunction(()=>!document.getElementById('keepOriginalVideo').disabled);
  assert.equal(await page.getByRole('switch',{name:'원본 영상 같이 보관'}).isChecked(),false);fail=false;
  page.on('dialog',d=>d.accept());await more.click();await page.getByRole('button',{name:'제거',exact:true}).click();await page.getByRole('button',{name:'변환',exact:true}).waitFor();assert.equal(removed,1);assert.equal(await page.locator('.replay').count(),0);assert((await page.locator('.state').textContent()).includes('수동 변환 필요'));
  await more.click();assert.equal(await page.getByRole('button',{name:'제거',exact:true}).count(),0);assert(await page.getByRole('button',{name:'완전 삭제',exact:true}).isVisible());
  await page.keyboard.press('Escape');await page.getByRole('button',{name:'변환',exact:true}).click();await page.getByRole('button',{name:'대기 중',exact:true}).waitFor();assert.equal(converted,1);assert(await page.getByRole('button',{name:'대기 중',exact:true}).isDisabled());
  await more.click();assert(await page.getByRole('button',{name:'제거',exact:true}).isEnabled());await page.getByRole('button',{name:'제거',exact:true}).click();await page.getByRole('button',{name:'변환',exact:true}).waitFor();assert.equal(removed,2,'queued conversion can be cancelled from the menu');
  status='processing';await page.evaluate(()=>refresh());assert(await page.getByRole('button',{name:'처리 중',exact:true}).isDisabled());
  status='error';await page.evaluate(()=>refresh());assert(await page.getByRole('button',{name:'변환',exact:true}).isEnabled());
  status='ready';await page.evaluate(()=>refresh());await more.click();assert(await page.getByRole('button',{name:'제거',exact:true}).isEnabled());assert(await page.getByRole('link',{name:'재생',exact:true}).isVisible());
  for(const width of [320,390,1280]){await page.setViewportSize({width,height:844});assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));const box=await page.locator('.recording-menu').boundingBox();assert(box.x>=0&&box.x+box.width<=width);}
  await page.getByRole('button',{name:'완전 삭제',exact:true}).click();await page.waitForFunction(()=>document.querySelectorAll('.log-row').length===0);assert.equal(deleted,1);assert.deepEqual(errors,[]);
  await checkRemovalRefresh(browser);
  console.log('PASS: automatic conversion toggle, persistence/error rollback, guide, convert/remove states, complete delete, responsive widths and removal refresh races');
 }finally{await browser.close()}
})().catch(e=>{console.error(e);process.exitCode=1});
