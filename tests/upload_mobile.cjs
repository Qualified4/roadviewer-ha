const fs=require('fs'),assert=require('node:assert/strict'),{chromium}=require('playwright');
(async()=>{
 const browser=await chromium.launch({headless:true});
 try{
  const page=await browser.newPage({viewport:{width:390,height:844},isMobile:true,hasTouch:true}),errors=[];
  page.on('pageerror',e=>errors.push(e.message));
  const id='a'.repeat(32);let mode='recover',attempts=0,received=0,listReads=0,deletes=0,reports=0,finished=false,rebuilds=0,cleanups=0;
  await page.route('https://rv.test/**',async route=>{
   const request=route.request(),url=new URL(request.url()),p=url.pathname;
   if(p==='/api/logs'){listReads++;return route.fulfill({json:{logs:[{id,name:'test',status:rebuilds?'unconverted':'ready',uploaded:1,bytes:3,prepared_bytes:7,video:false}],max_upload_mb:512,storage_used_bytes:10,concurrency:1}})}
   if(p==='/api/progress')return route.fulfill({json:{progress:{}}});
   if(p==='/api/uploads'){received=0;return route.fulfill({status:201,json:{id,chunk_size:256*1024}})}
   if(p.endsWith('/failure')){reports++;return route.fulfill({json:{recorded:true}})}
   if(p.includes('/files/')){
    attempts++;
    if(mode==='fail')return route.fulfill({status:409,json:{error:'offset conflict'}});
    if(attempts===1)return route.fulfill({status:502,contentType:'text/html',body:'<html>Bad Gateway</html>'});
    assert.equal(Number(url.searchParams.get('offset')),received);
    received+=request.postDataBuffer().length;
    await new Promise(resolve=>setTimeout(resolve,250));
    return route.fulfill({json:{received}});
   }
   if(p.endsWith('/finish')){finished=true;return route.fulfill({status:201,json:{logs:[{id}],duplicates:[],updated:[]}})}
   if(request.method()==='DELETE'&&p.startsWith('/api/uploads/')){deletes++;return route.fulfill({json:{deleted:id}})}
   if(p.endsWith('/prepared')){rebuilds++;return route.fulfill({json:{status:'unconverted'}})}
   if(p==='/api/storage/cleanup'){cleanups++;return route.fulfill({json:{removed_bytes:123}})}
   const name=p==='/'?'library.html':p.replace('/assets/','');
   return route.fulfill({body:fs.readFileSync('roadviewer/app/web/'+name),contentType:name.endsWith('.js')?'application/javascript':name.endsWith('.css')?'text/css':name.endsWith('.html')?'text/html':'image/svg+xml'});
  });
  await page.goto('https://rv.test/');await page.waitForSelector('.log-row');
  assert((await page.locator('.log-meta').textContent()).includes('변환 7 B'));
  const file={name:'rlog.zst',mimeType:'application/octet-stream',buffer:Buffer.alloc(600000,9)};
  await page.locator('#files').setInputFiles(file);
  assert.equal(await page.locator('#files').evaluate(el=>el.files.length),1);
  await page.locator('#upload').click();
  await page.waitForFunction(()=>document.body.classList.contains('uploading'));
  const before=listReads;
  for(let i=0;i<8;i++){await page.evaluate(i=>{scrollTo(0,i%2?500:0);void refresh();void refreshProgress()},i);await page.waitForTimeout(50)}
  assert.equal(listReads,before,'upload must not compete with list polling');
  await page.waitForFunction(()=>document.getElementById('uploadStatus').textContent.includes('새 로그'));
  assert(finished);assert.equal(received,file.buffer.length);assert.equal(attempts,4);assert.equal(deletes,0);assert(reports>=1);
  assert.equal(await page.locator('#files').evaluate(el=>el.files.length),0);
  mode='fail';await page.locator('#files').setInputFiles(file);await page.locator('#upload').click();
  await page.waitForFunction(()=>!document.body.classList.contains('uploading'));
  assert.equal(deletes,1,'failed upload session must be removed');assert((await page.locator('#error').textContent()).includes('offset conflict'));
  await page.locator('#cleanupStorage').click();await page.waitForFunction(()=>document.getElementById('cleanupStatus').textContent.includes('123 B'));assert.equal(cleanups,1);
  page.on('dialog',dialog=>dialog.accept());
  await page.getByRole('button',{name:'제거',exact:true}).click();
  await page.waitForFunction(()=>!document.querySelector('.actions button').disabled);assert.equal(rebuilds,1);
  assert.deepEqual(errors,[]);console.log('PASS: mobile scrolling upload, HTML proxy retry, failed-session cleanup, storage cleanup and converted data removal');
 }finally{await browser.close()}
})().catch(e=>{console.error(e);process.exitCode=1});
