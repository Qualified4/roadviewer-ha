const fs=require('fs'),assert=require('node:assert/strict'),{chromium}=require('playwright');
(async()=>{
 const browser=await chromium.launch({headless:true});
 try{
  const page=await browser.newPage({viewport:{width:1280,height:1000}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
  const logs=[1,2].map(n=>({id:String(n).repeat(32),name:`0000041b--c6f39793a8--${n}`,files:{'rlog.zst':`0000041b--c6f39793a8--${n}--rlog.zst`},status:'ready',uploaded:1,bytes:87800000,prepared_bytes:1000000,video:true,log_bytes:10200000,duration:60,download_options:['front','wide','qcamera'].map((source,i)=>({source,mp4:true,original:true,bytes:[37800000,37500000,2300000][i]}))}));
  await page.route('https://rv.test/**',route=>{
   const path=new URL(route.request().url()).pathname;
   if(path==='/api/logs')return route.fulfill({json:{logs,concurrency:1,auto_convert:true,max_upload_mb:512,storage_used_bytes:175600000}});
   if(path==='/api/progress')return route.fulfill({json:{progress:{}}});
   if(path.startsWith('/api/'))return route.fulfill({json:{max_bytes:0,free_bytes:1000000000,used_bytes:175600000,reserved_bytes:0,policy:'reject_new'}});
   const name=path==='/'?'library.html':path.replace('/assets/','');
   return route.fulfill({body:fs.readFileSync('roadviewer/app/web/'+name),contentType:name.endsWith('.html')?'text/html':name.endsWith('.js')?'application/javascript':name.endsWith('.css')?'text/css':'application/octet-stream'});
  });
  await page.goto('https://rv.test/');await page.waitForSelector('.log-row');
  const height=await page.locator('.log-row').first().evaluate(e=>e.offsetHeight);
  await page.locator('.recording-more summary').first().click();await page.getByRole('link',{name:'모두 받기',exact:true}).first().click();
  const dialog=page.getByRole('dialog',{name:'로그 및 영상 다운로드'});await dialog.waitFor();
  assert.equal(await page.locator('.log-row').first().evaluate(e=>e.offsetHeight),height);
  assert((await dialog.locator('.rv-download-total').textContent()).includes('4개 파일'));
  let url=new URL(await dialog.locator('.rv-download-start').getAttribute('href'),'https://rv.test');assert.equal(url.searchParams.get('format'),'mp4');assert.equal(url.searchParams.get('parts'),'rlog,front,wide,qcamera');
  await dialog.getByRole('button',{name:/^원본 형식/}).click();assert((await dialog.textContent()).includes('ecamera.hevc'));assert((await dialog.textContent()).includes('바이트까지 동일하지는'));
  await dialog.locator('.rv-download-file input').nth(0).uncheck();await dialog.locator('.rv-download-file input').nth(2).uncheck();await dialog.locator('.rv-download-file input').nth(3).uncheck();
  url=new URL(await dialog.locator('.rv-download-start').getAttribute('href'),'https://rv.test');assert.equal(url.searchParams.get('source'),'front');assert.equal(url.searchParams.get('format'),'original');
  await page.keyboard.press('Escape');await page.locator('.rv-download-dialog').waitFor({state:'detached'});assert.equal(await page.locator('.rv-download-dialog').count(),0);
  await page.locator('#bulkOpen').click();await page.locator('#bulkAll').check();await page.locator('#bulkDownload').click();await dialog.waitFor();
  assert((await dialog.locator('.rv-download-total').textContent()).includes('8개 파일'));url=new URL(await dialog.locator('.rv-download-start').getAttribute('href'),'https://rv.test');assert.equal(url.searchParams.get('ids').split(',').length,2);
  await dialog.getByRole('button',{name:'닫기',exact:true}).click();await page.locator('.rv-download-dialog').waitFor({state:'detached'});await page.locator('#bulkClose').click();
  if(process.env.RV_CAPTURE_DOCS){
   await page.locator('.upload > summary').click();await page.locator('#storageSettings').evaluate(e=>e.open=true);await page.locator('.conversion-info').screenshot({path:'docs/images/roadviewer-library-settings.png'});
   await page.locator('.recording-more summary').first().click();await page.getByRole('link',{name:'모두 받기',exact:true}).first().click();await dialog.screenshot({path:'docs/images/roadviewer-download-options.png'});await page.keyboard.press('Escape');await page.locator('.rv-download-dialog').waitFor({state:'detached'});
  }
  for(const width of [320,390]){
   await page.setViewportSize({width,height:844});await page.locator('.recording-more summary').first().click();await page.getByRole('link',{name:'원본 형식 다운로드',exact:true}).first().click();await dialog.waitFor();
   assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));const box=await dialog.boundingBox();assert(box.x>=0&&box.x+box.width<=width);await page.keyboard.press('Escape');await page.locator('.rv-download-dialog').waitFor({state:'detached'});
  }
  assert.deepEqual(errors,[]);console.log('PASS: compact rows, modal formats/files, ZIP scopes, nested dialog and mobile widths');
 }finally{await browser.close()}
})().catch(e=>{console.error(e);process.exitCode=1});
