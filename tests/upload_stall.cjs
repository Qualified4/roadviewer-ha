const fs=require('fs'),assert=require('node:assert/strict'),{chromium}=require('playwright');
(async()=>{
 const browser=await chromium.launch({headless:true});
 try{
  const page=await browser.newPage({viewport:{width:390,height:844}}),errors=[],reports=[];
  page.on('pageerror',e=>errors.push(e.message));
  // Compress waits while retaining the real XMLHttpRequest event sequence.
  await page.addInitScript(()=>{
   const timeout=window.setTimeout;
   window.setTimeout=(fn,ms,...args)=>timeout(fn,ms===15000?500:ms===3000?50:ms===1000?20:ms,...args);
  });
  const id='b'.repeat(32);let firstBody=null,attempts=0,stored=0,finished=false;
  await page.route('https://rv.test/**',route=>{
   const req=route.request(),url=new URL(req.url()),p=url.pathname;
   if(p==='/api/logs')return route.fulfill({json:{logs:[],max_upload_mb:512,storage_used_bytes:0,concurrency:1}});
   if(p==='/api/uploads')return route.fulfill({json:{id,chunk_size:262144}});
   if(p.endsWith('/failure')){reports.push(req.postDataJSON());return route.fulfill({json:{recorded:true}})}
   if(p.includes('/files/')){
    attempts++;const body=req.postDataBuffer(),offset=Number(url.searchParams.get('offset'));
    if(attempts===1){firstBody=body;stored=body.length;return} // Stored, but response never reaches the browser.
    if(attempts===2){assert.equal(offset,0);assert.deepEqual(body,firstBody)}
    else{assert.equal(offset,stored);stored+=body.length}
    return route.fulfill({json:{received:offset+body.length}});
   }
   if(p.endsWith('/finish')){finished=true;return route.fulfill({json:{logs:[{}],duplicates:[],updated:[]}})}
   const name=p==='/'?'library.html':p.replace('/assets/','');
   return route.fulfill({body:fs.readFileSync('roadviewer/app/web/'+name),contentType:name.endsWith('.html')?'text/html':name.endsWith('.js')?'application/javascript':name.endsWith('.css')?'text/css':'image/svg+xml'});
  });
  await page.goto('https://rv.test/');
  await page.locator('#files').setInputFiles({name:'rlog.zst',mimeType:'application/octet-stream',buffer:Buffer.alloc(300000,9)});
  await page.locator('#upload').click();
  await page.waitForFunction(()=>/서버 응답 대기|전송 확인/.test(document.getElementById('uploadStatus').textContent));
  assert.equal(await page.locator('#progress').evaluate(e=>e.value),0,'percentage advances only after server acknowledgement');
  await page.waitForFunction(()=>document.getElementById('uploadStatus').textContent.includes('새 로그'));
  assert(finished);assert.equal(stored,300000);assert.equal(attempts,3);
  assert.equal(reports.length,1);assert.equal(reports[0].errorCode,'upload_idle_timeout');assert(['chunk-send','chunk-response'].includes(reports[0].stage));assert.equal(reports[0].total,262144);assert(reports[0].elapsedMs>=450&&reports[0].elapsedMs<5000);
  assert.deepEqual(errors,[]);console.log('PASS: real browser stalled upload aborts, retries identical bytes, preserves acknowledged progress and completes without duplicate storage');
 }finally{await browser.close()}
})().catch(e=>{console.error(e);process.exitCode=1});
