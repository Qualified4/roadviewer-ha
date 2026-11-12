const fs=require('fs'),assert=require('node:assert/strict'),{chromium}=require('playwright');
// Files go up four at a time; within a file the chunks stay in order; one failed file stops the others and removes the session.
(async()=>{
 const browser=await chromium.launch({headless:true});
 try{
  const page=await browser.newPage({viewport:{width:1100,height:800}}),errors=[];
  page.on('pageerror',e=>errors.push(e.message));
  const id='c'.repeat(32);let stored={},active=0,peak=0,finished=0,deletes=0,manifest=null,failFile=null,sessions=0,arrived=0,delay=60;
  await page.route('https://rv.test/**',async route=>{
   const req=route.request(),url=new URL(req.url()),p=url.pathname;
   if(p==='/api/logs')return route.fulfill({json:{logs:[],max_upload_mb:512,storage_used_bytes:0,concurrency:1}});
   if(p==='/api/uploads'){sessions++;stored={};manifest=req.postDataJSON().files;return route.fulfill({status:201,json:{id,chunk_size:65536}})}
   if(p.endsWith('/failure'))return route.fulfill({json:{recorded:true}});
   if(p.includes('/files/')){
    arrived++;const i=Number(p.split('/').pop()),offset=Number(url.searchParams.get('offset')),body=req.postDataBuffer();
    if(i===failFile&&offset>0)return route.fulfill({status:409,json:{error:'offset conflict'}});
    assert.equal(offset,stored[i]||0,'file '+i+' in order');
    active++;peak=Math.max(peak,active);await new Promise(resolve=>setTimeout(resolve,delay));active--;
    stored[i]=offset+body.length;return route.fulfill({json:{received:stored[i]}});
   }
   if(p.endsWith('/finish')){finished++;return route.fulfill({status:201,json:{logs:[{}],duplicates:[],updated:[]}})}
   if(req.method()==='DELETE'&&p.startsWith('/api/uploads/')){deletes++;return route.fulfill({json:{deleted:id}})}
   if(p==='/api/settings/storage')return route.fulfill({status:404,json:{error:'not_found'}});const name=p==='/'?'library.html':p.replace('/assets/','');
   return route.fulfill({body:fs.readFileSync('roadviewer/app/web/'+name),contentType:name.endsWith('.html')?'text/html':name.endsWith('.js')?'application/javascript':name.endsWith('.css')?'text/css':'image/svg+xml'});
  });
  await page.goto('https://rv.test/#upload');
  const sizes=[200000,150000,70000,300000,65536,1,180000];
  const pick=()=>page.locator('#files').setInputFiles(sizes.map((size,n)=>({name:`0000001a--aaaaaaaaaa--${n}--rlog.zst`,mimeType:'application/octet-stream',buffer:Buffer.alloc(size,n+1)})));
  await pick();await page.locator('#upload').click();
  await page.waitForFunction(()=>document.getElementById('uploadStatus').textContent.includes('새 로그'));
  assert.equal(finished,1);assert.equal(peak,4,'four files at a time');
  assert.deepEqual(manifest.map(f=>f.size).sort((a,b)=>a-b),[...sizes].sort((a,b)=>a-b));
  manifest.forEach((f,i)=>assert.equal(stored[i],f.size,'file '+i+' complete'));
  // One file fails on its second chunk: the upload ends as failed, nothing is registered and the session is removed.
  failFile=3;peak=0;arrived=0;await pick();await page.locator('#upload').click();
  await page.waitForFunction(()=>document.getElementById('uploadStatus').textContent.includes('업로드 실패'));
  assert.equal(finished,1);assert.equal(deletes,1);assert((await page.locator('#error').textContent()).includes('offset conflict'));
  const settled=arrived;await page.waitForTimeout(400);assert.equal(arrived,settled,'no chunk is sent after the failure');assert(arrived<16,'the rest (19 chunks in all) was not sent: '+arrived);
  assert(await page.locator('#upload').isEnabled());
  // A longer upload shows its speed and the time left next to the percentage.
  failFile=null;delay=450;await pick();await page.locator('#upload').click();
  await page.waitForFunction(()=>/^업로드 \d+% · 파일 \d+\/7 · \d+(\.\d)? (B|KB|MB)\/s · 1분 미만 남음/.test(document.getElementById('uploadStatus').textContent));
  await page.waitForFunction(()=>document.getElementById('uploadStatus').textContent.includes('새 로그'));assert.equal(finished,2);
  assert.deepEqual(errors,[]);console.log('PASS: files upload four at a time with ordered chunks; a failed file stops the rest and removes the session');
 }finally{await browser.close()}
})().catch(e=>{console.error(e);process.exitCode=1});
