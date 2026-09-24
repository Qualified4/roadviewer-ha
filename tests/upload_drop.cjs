const fs=require('fs'),assert=require('node:assert/strict'),{chromium}=require('playwright');
(async()=>{
 const browser=await chromium.launch({headless:true});
 try{
  const page=await browser.newPage({viewport:{width:1280,height:900}}),errors=[];
  page.on('pageerror',e=>errors.push(e.message));
  let uploads=0,manifest=null,heldChunk=null,heldCleanup=null,holdChunk=true;
  await page.route('https://rv.test/**',route=>{
   const req=route.request(),p=new URL(req.url()).pathname;
   if(p==='/api/logs')return route.fulfill({json:{logs:[],max_upload_mb:512,storage_used_bytes:0,concurrency:1}});
   if(p==='/api/uploads'){uploads++;manifest=req.postDataJSON();return route.fulfill({json:{id:'a'.repeat(32),chunk_size:262144}})}
   if(p.includes('/files/')){
    if(holdChunk){holdChunk=false;heldChunk=route;return}
    return route.fulfill({json:{received:req.postDataBuffer().length}});
   }
   if(p.endsWith('/finish'))return route.fulfill({json:{logs:[],duplicates:[],updated:[{id:'existing',status:'ready',original_restored:true}]}});
   if(p==='/api/storage/cleanup'){heldCleanup=route;return}
   const name=p==='/'?'library.html':p.replace('/assets/','');
   return route.fulfill({body:fs.readFileSync('roadviewer/app/web/'+name),contentType:name.endsWith('.html')?'text/html':name.endsWith('.js')?'application/javascript':name.endsWith('.css')?'text/css':'image/svg+xml'});
  });
  await page.goto('https://rv.test/');
  const zone=page.locator('.picker-surface');
  const transfer=await page.evaluateHandle(()=>{
   const dt=new DataTransfer();
   for(const [name,body] of [['rlog.zst','replacement-log'],['qcamera.ts','video'],['notes.txt','unsupported']])dt.items.add(new File([body],name));
   return dt;
  });
  await page.locator('#files').setInputFiles({name:'rlog.zst',mimeType:'application/octet-stream',buffer:Buffer.from('old')});
  await zone.dispatchEvent('dragenter',{dataTransfer:transfer});
  await page.locator('.pick-button').dispatchEvent('dragenter',{dataTransfer:transfer});
  await zone.dispatchEvent('dragleave',{dataTransfer:transfer});
  assert(await zone.evaluate(e=>e.classList.contains('is-dragover')),'moving across child elements keeps highlight');
  await page.locator('.pick-button').dispatchEvent('dragleave',{dataTransfer:transfer});
  assert(!await zone.evaluate(e=>e.classList.contains('is-dragover')));
  await zone.dispatchEvent('dragover',{dataTransfer:transfer});assert(await page.locator('.picker-drop-title').isVisible());
  await page.locator('#files').dispatchEvent('drop',{dataTransfer:transfer});
  assert(!await zone.evaluate(e=>e.classList.contains('is-dragover')));
  assert.equal(await page.locator('#selectedFiles li').count(),2);assert((await page.locator('#error').textContent()).includes('notes.txt'));
  assert.equal(uploads,0,'dropping files must not start upload');
  assert.equal(await page.locator('#files').evaluate(e=>e.files[0].size),3,'keep the existing file input alive');
  const outsideCancelled=await page.evaluate(()=>{
   const dt=new DataTransfer();dt.items.add(new File(['x'],'outside--rlog.zst'));
   return !document.body.dispatchEvent(new DragEvent('drop',{dataTransfer:dt,bubbles:true,cancelable:true}));
  });
  assert(outsideCancelled);assert.equal(await page.locator('#selectedFiles li').count(),2);
  // Folder entries, even with a supported file name, must not become zero-byte uploads.
  await page.evaluate(()=>{
   const dt=new DataTransfer();dt.items.add(new File([''],'qcamera.ts'));
   const original=DataTransferItem.prototype.webkitGetAsEntry;
   DataTransferItem.prototype.webkitGetAsEntry=()=>({isDirectory:true,name:'qcamera.ts'});
   try{document.querySelector('.picker-surface').dispatchEvent(new DragEvent('drop',{dataTransfer:dt,bubbles:true,cancelable:true}))}
   finally{DataTransferItem.prototype.webkitGetAsEntry=original}
  });
  assert((await page.locator('#error').textContent()).includes('폴더는 추가할 수 없습니다'));
  const textCancelled=await page.evaluate(()=>{
   const dt=new DataTransfer();dt.setData('text/plain','ordinary text');
   return !document.querySelector('.picker-surface').dispatchEvent(new DragEvent('drop',{dataTransfer:dt,bubbles:true,cancelable:true}));
  });
  assert(!textCancelled);assert.equal(await page.locator('#selectedFiles li').count(),2);
  await page.locator('#upload').click();
  for(let i=0;i<100&&!heldChunk;i++)await page.waitForTimeout(50);assert(heldChunk);
  assert.deepEqual(manifest.files,[{name:'rlog.zst',size:15},{name:'qcamera.ts',size:5}]);
  assert.equal(heldChunk.request().postDataBuffer().toString(),'replacement-log');
  await zone.dispatchEvent('dragover',{dataTransfer:transfer});assert(!await zone.evaluate(e=>e.classList.contains('is-dragover')));
  await zone.dispatchEvent('drop',{dataTransfer:transfer});assert.equal(await page.locator('#selectedFiles li').count(),2);
  await heldChunk.fulfill({json:{received:15}});
  await page.waitForFunction(()=>document.getElementById('uploadStatus').textContent.includes('새 로그'));
  assert.equal(await page.locator('#selectedFiles li').count(),0);
  assert((await page.locator('#uploadStatus').textContent()).includes('원본 TS 복원 1개'));
  assert(!(await page.locator('#uploadStatus').textContent()).includes('준비가 끝나면'));
  await page.locator('#cleanupStorage').click();
  for(let i=0;i<100&&!heldCleanup;i++)await page.waitForTimeout(50);assert(heldCleanup);
  await zone.dispatchEvent('drop',{dataTransfer:transfer});assert.equal(await page.locator('#selectedFiles li').count(),0);
  await heldCleanup.fulfill({json:{removed_bytes:0}});await page.waitForFunction(()=>!document.getElementById('cleanupStorage').disabled);
  await zone.dispatchEvent('drop',{dataTransfer:transfer});assert.equal(await page.locator('#selectedFiles li').count(),2);
  await page.locator('#clearSelection').click();assert.equal(await page.locator('#selectedFiles li').count(),0);assert(await page.locator('#upload').isDisabled());
  for(const width of [320,390,768,1280]){
   await page.setViewportSize({width,height:900});await zone.dispatchEvent('dragover',{dataTransfer:transfer});
   assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  }
  assert.deepEqual(errors,[]);console.log('PASS: drop highlight, multi-file selection, duplicate replacement, validation, explicit upload, busy/cleanup guards and responsive widths');
 }finally{await browser.close()}
})().catch(e=>{console.error(e);process.exitCode=1});
