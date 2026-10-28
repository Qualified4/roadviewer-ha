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
  await page.locator('.recording-more summary').first().click();assert.deepEqual(await page.locator('.recording-menu').first().locator('button').allTextContents(),['제거','다운로드','완전 삭제']);await page.getByRole('button',{name:'다운로드',exact:true}).first().click();
  const dialog=page.getByRole('dialog',{name:'로그 및 영상 다운로드'});await dialog.waitFor();
  assert.equal(await page.locator('.log-row').first().evaluate(e=>e.offsetHeight),height);
  assert.equal(await dialog.locator('.rv-download-segment-heading,.rv-download-segments').count(),0,'individual download keeps the compact file-only popup');
  assert.equal(await dialog.locator('.rv-download-one').count(),4,'other segments are not included in individual downloads');
  assert((await dialog.locator('.rv-download-total').textContent()).includes('4개 파일'));
  let url=new URL(await dialog.locator('.rv-download-start').getAttribute('href'),'https://rv.test');assert.equal(url.searchParams.get('format'),'mp4');assert.equal(url.searchParams.get('parts'),'rlog,front,wide,qcamera');
  await dialog.getByRole('button',{name:'선택 해제',exact:true}).click();assert.equal(await dialog.locator('.rv-download-file input:checked').count(),0);assert.equal(await dialog.locator('.rv-download-start').getAttribute('href'),null);
  url=new URL(await dialog.locator('.rv-download-file').nth(1).locator('.rv-download-one').first().getAttribute('href'),'https://rv.test');assert.equal(url.pathname,`/api/logs/${logs[0].id}/download`);assert.equal(url.searchParams.get('source'),'front');assert.equal(url.searchParams.get('format'),'mp4');assert(!url.pathname.endsWith('.zip'));
  const received=page.waitForEvent('download');await dialog.locator('.rv-download-file').nth(1).locator('.rv-download-one').first().click();const downloaded=await received;assert.equal(new URL(downloaded.url()).searchParams.get('source'),'front');await downloaded.cancel();assert.equal(await dialog.locator('.rv-download-file input:checked').count(),0,'individual download does not change ZIP selection');
  await dialog.getByRole('button',{name:'전체 선택',exact:true}).click();assert.equal(await dialog.locator('.rv-download-file input:checked').count(),4);
  await dialog.getByRole('button',{name:/^원본 형식/}).click();assert((await dialog.textContent()).includes('ecamera.hevc'));assert((await dialog.textContent()).includes('바이트까지 동일하지는'));
  url=new URL(await dialog.locator('.rv-download-file').nth(1).locator('.rv-download-one').first().getAttribute('href'),'https://rv.test');assert.equal(url.searchParams.get('format'),'original');assert.equal(url.searchParams.get('source'),'front');
  await dialog.locator('.rv-download-file input').nth(0).uncheck();await dialog.locator('.rv-download-file input').nth(2).uncheck();await dialog.locator('.rv-download-file input').nth(3).uncheck();
  url=new URL(await dialog.locator('.rv-download-start').getAttribute('href'),'https://rv.test');assert.equal(url.searchParams.get('source'),'front');assert.equal(url.searchParams.get('format'),'original');
  await page.keyboard.press('Escape');await page.locator('.rv-download-dialog').waitFor({state:'detached'});assert.equal(await page.locator('.rv-download-dialog').count(),0);
  await page.locator('#bulkOpen').click();await page.locator('#bulkAll').check();await page.locator('#bulkDownload').click();await dialog.waitFor();
  assert((await dialog.locator('.rv-download-total').textContent()).includes('8개 파일'));url=new URL(await dialog.locator('.rv-download-start').getAttribute('href'),'https://rv.test');assert.equal(url.searchParams.get('ids').split(',').length,2);
  await dialog.locator('.rv-download-individual summary').nth(1).click();const links=dialog.locator('.rv-download-file').nth(1).locator('.rv-download-one');assert.equal(await links.count(),2);for(let n=0;n<2;n++){url=new URL(await links.nth(n).getAttribute('href'),'https://rv.test');assert.equal(url.pathname,`/api/logs/${logs[n].id}/download`);assert.equal(url.searchParams.get('source'),'front')}
  const segments=dialog.locator('.rv-download-segment input');
  assert.equal(await segments.count(),2);
  await segments.nth(1).uncheck();
  assert.equal(await dialog.locator('.rv-download-group summary input').evaluate(e=>e.indeterminate),true);
  assert((await dialog.locator('.rv-download-total').textContent()).includes('4개 파일'));
  url=new URL(await dialog.locator('.rv-download-start').getAttribute('href'),'https://rv.test');assert.equal(url.searchParams.get('ids'),logs[0].id);
  await dialog.locator('.rv-download-segments-all').check();await dialog.locator('.rv-download-segments-all').uncheck();assert.equal(await dialog.locator('.rv-download-start').getAttribute('href'),null);
  await dialog.locator('.rv-download-group summary input').check();assert.equal(await segments.count(),2);assert.equal(await segments.evaluateAll(inputs=>inputs.filter(input=>input.checked).length),2);
  await dialog.getByRole('button',{name:'닫기',exact:true}).click();await page.locator('.rv-download-dialog').waitFor({state:'detached'});await page.locator('#bulkClose').click();
  if(process.env.RV_CAPTURE_DOCS){
   await page.locator('.upload > summary').click();await page.locator('#storageSettings').evaluate(e=>e.open=true);await page.locator('.conversion-info').screenshot({path:'docs/images/roadviewer-library-settings.png'});
   await page.locator('.recording-more summary').first().click();await page.getByRole('button',{name:'다운로드',exact:true}).first().click();await dialog.screenshot({path:'docs/images/roadviewer-download-options.png'});await page.keyboard.press('Escape');await page.locator('.rv-download-dialog').waitFor({state:'detached'});
  }
  for(const width of [320,390]){
   await page.setViewportSize({width,height:844});await page.locator('.recording-more summary').first().click();await page.getByRole('button',{name:'다운로드',exact:true}).first().click();await dialog.waitFor();await dialog.getByRole('button',{name:/^원본 형식/}).click();
   assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));const box=await dialog.boundingBox();assert(box.x>=0&&box.x+box.width<=width);await page.keyboard.press('Escape');await page.locator('.rv-download-dialog').waitFor({state:'detached'});
  }
  // Replay uses the same compact popup, with no segment selection.
  await page.evaluate(log=>openRecordingDownload([log],'../../','videos'),logs[0]);await dialog.waitFor();
  assert.equal(await dialog.locator('.rv-download-segments').count(),0);assert((await dialog.locator('.rv-download-total').textContent()).includes('3개 파일'));
  await page.keyboard.press('Escape');await page.locator('.rv-download-dialog').waitFor({state:'detached'});
  // Separate routes stay separate, missing cameras do not disable available files.
  const varied=[logs[0],{...logs[1],name:'0000041c--different--0',files:{'rlog.zst':'0000041c--different--0--rlog.zst'},download_options:[]}];
  await page.evaluate(items=>openRecordingDownload(items,'','all',true),varied);await dialog.waitFor();
  assert.equal(await dialog.locator('.rv-download-group').count(),2);
  assert((await dialog.locator('.rv-download-total').textContent()).includes('5개 파일'));
  await dialog.getByRole('button',{name:'선택 해제',exact:true}).click();await dialog.locator('.rv-download-file input').nth(2).check();
  url=new URL(await dialog.locator('.rv-download-start').getAttribute('href'),'https://rv.test');assert.equal(url.pathname,`/api/logs/${logs[0].id}/download`);assert.equal(url.searchParams.get('source'),'wide');
  await dialog.evaluate(el=>el.scrollTop=el.scrollHeight);
  const pinned=await dialog.locator('.rv-download-segment-heading').boundingBox(),frame=await dialog.boundingBox(),bottom=await dialog.locator('.rv-download-footer').boundingBox();assert(pinned.y>=frame.y&&pinned.y+pinned.height<frame.y+frame.height);assert(bottom.y+bottom.height<=frame.y+frame.height+1);
  await page.keyboard.press('Escape');await page.locator('.rv-download-dialog').waitFor({state:'detached'});
  const many=Array.from({length:151},(_,n)=>({...logs[0],id:`many${n}`,name:`0000041d--limit--${n}`,files:{'rlog.zst':`0000041d--limit--${n}--rlog.zst`}}));
  await page.evaluate(items=>openRecordingDownload(items,'','all',true),many);await dialog.waitFor();assert.equal(await dialog.locator('.rv-download-start').getAttribute('href'),null);assert((await dialog.locator('.rv-download-segment-count').textContent()).includes('151'));
  await page.keyboard.press('Escape');await page.locator('.rv-download-dialog').waitFor({state:'detached'});
  assert.deepEqual(errors,[]);console.log('PASS: compact rows, modal formats/files, ZIP scopes, nested dialog and mobile widths');
 }finally{await browser.close()}
})().catch(e=>{console.error(e);process.exitCode=1});
