const fs=require('fs'),assert=require('node:assert/strict'),{chromium}=require('playwright');
(async()=>{
 const browser=await chromium.launch({headless:true});
 try{
  const page=await browser.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
  const base='https://rv.test';
  let progressReads=0;
  let logs=[{id:'one',name:'one',status:'processing',uploaded:1,bytes:1,video:true},{id:'two',name:'two',status:'processing',uploaded:2,bytes:1,video:false}],ready=false,reads=0,videoRequests=[];
  const data={route:'one',key:'new-video-version',duration:2,warnings:[],video:{start:0,duration:2},frames:Array.from({length:21},(_,i)=>({t:i/10,id:i,valid:false,lanes:[],edges:[],lp:[],es:[],leads:[],liveTracksValid:false}))};
  await page.route(base+'/**',async route=>{
   const url=new URL(route.request().url()),p=url.pathname;
   if(p==='/api/progress'){progressReads++;return route.fulfill({json:{progress:Object.fromEntries(logs.filter(m=>m.status==='processing'&&m.progress).map(m=>[m.id,m.progress]))}})}
   if(p==='/api/logs')return route.fulfill({json:{logs,max_upload_mb:512,storage_used_bytes:1}});
   if(p.endsWith('/data')){reads++;return route.fulfill(ready?{json:data}:{status:409,json:{status:'processing'}})}
   if(p.endsWith('/video')){videoRequests.push(url.searchParams.get('v'));return route.fulfill({body:fs.readFileSync('/tmp/roadviewer-test.mp4'),contentType:'video/mp4'})}
   if(p==='/api/diagnostics')return route.fulfill({json:{saved:1}});
   const name=p==='/'?'library.html':p.startsWith('/view/')?'index.html':p.replace('/assets/','');
   const contentType=name.endsWith('.js')?'application/javascript':name.endsWith('.css')?'text/css':name.endsWith('.png')?'image/png':name.endsWith('.svg')?'image/svg+xml':'text/html';
   return route.fulfill({body:fs.readFileSync('roadviewer/app/web/'+name),contentType});
  });
  await page.goto(base+'/');await page.waitForFunction(()=>document.querySelectorAll('.log-row').length===2);
  for(const [progress,text] of [
   [{stage:'log_analysis',frames:1234},'프레임 분석 완료'],
   [{stage:'video_convert',percent:65},'영상 변환 중 · 65%'],
   [{stage:'video_verify',percent:80},'영상 검증 중 · 80%'],
   [{stage:'saving'},'마무리 중']
  ]){
   logs[0].progress=progress;await page.evaluate(()=>refresh());
   assert((await page.locator('.state-processing').first().textContent()).includes(text));
  }
  await page.evaluate(()=>window.savedProcessingRow=document.querySelector('.log-row'));
  logs[0].progress={stage:'video_convert',percent:91};
  const readsBefore=progressReads;
  await page.waitForFunction(()=>document.querySelector('.state-processing').textContent==='영상 변환 중 · 91%');
  assert(progressReads>readsBefore);
  assert(await page.evaluate(()=>savedProcessingRow===document.querySelector('.log-row')));
  logs[0].progress={stage:'video_verify',percent:92};
  await page.evaluate(()=>refresh());
  assert(await page.evaluate(()=>savedProcessingRow===document.querySelector('.log-row')));
  assert.equal(await page.locator('.state-processing').first().textContent(),'영상 검증 중 · 92%');
  logs[0].status='ready';await page.evaluate(()=>refresh());
  await page.evaluate(()=>window.savedReplay=document.querySelector('.replay'));
  await page.evaluate(()=>refresh());assert(await page.evaluate(()=>savedReplay===document.querySelector('.replay')));
  // Another row finishing must not replace this row's replay link during a click.
  await page.locator('.replay').hover();await page.mouse.down();
  logs[1].status='ready';await page.evaluate(()=>refresh());assert(await page.evaluate(()=>savedReplay===document.querySelector('.replay')));
  await page.mouse.up();await page.waitForURL('**/view/one/');
  await page.waitForFunction(()=>document.getElementById('status').textContent.includes('로그 준비 중'));
  assert(await page.locator('#play').isDisabled());ready=true;
  await page.waitForFunction(()=>!document.getElementById('play').disabled);
  assert(reads>=2);assert(videoRequests.includes('new-video-version'));
  // Navigation starts in its normal location, then sticks to the top.
  for(const viewport of [{width:1280,height:720},{width:390,height:844}]){
   await page.setViewportSize(viewport);await page.evaluate(()=>window.scrollTo(0,0));
   const nav=page.locator('.log-navigation'),initial=await nav.boundingBox();
   assert(initial.y>10);
   await page.waitForFunction(()=>!document.querySelector('.replay-heading').classList.contains('is-stuck'));
   await page.evaluate(y=>window.scrollTo(0,y),initial.y+100);
   await page.waitForFunction(()=>Math.abs(document.querySelector('.log-navigation').getBoundingClientRect().top-10)<1&&document.querySelector('.replay-heading').classList.contains('is-stuck'));
   const stuck=await nav.boundingBox();assert(Math.abs(stuck.y-10)<1);
   assert.equal(await page.locator('.replay-heading').evaluate(el=>getComputedStyle(el,'::before').backgroundColor),await page.locator('.playback').evaluate(el=>getComputedStyle(el).backgroundColor));
   const heading=await page.locator('.replay-heading').boundingBox();
   const route=await page.locator('.replay-heading .route').boundingBox();
   assert(route.y>=stuck.y+stuck.height&&route.y+route.height<=heading.y+heading.height);
   assert.equal(await page.locator('.camera-panel .note').count(),0);
   assert((await page.locator('.road-panel .note').textContent()).includes('차선 점선'));
   assert.equal(await page.locator('.road-panel h2').textContent(),'주행 상황');
   for(const selector of ['.back','#previousLog','#nextLog']){
    const box=await page.locator(selector).boundingBox();
    assert(box.y>=0&&box.x>=0&&box.x+box.width<=viewport.width);
   }
   await page.evaluate(()=>window.scrollTo(0,0));
   await page.waitForFunction(y=>Math.abs(document.querySelector('.log-navigation').getBoundingClientRect().top-y)<1,initial.y);
  }
  await page.locator('#play').click();await page.waitForFunction(()=>document.getElementById('video').currentTime>0.1);
  assert.deepEqual(errors,[]);console.log('PASS: stable replay links during refresh and click, pending to ready without reload, versioned video loads and plays');
 }finally{await browser.close()}
})().catch(e=>{console.error(e);process.exitCode=1});
