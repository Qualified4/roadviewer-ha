const fs=require('fs'),assert=require('node:assert/strict'),{chromium}=require('playwright');
(async()=>{
 const browser=await chromium.launch({headless:true});
 try{
  const page=await browser.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
  const videos={front:{start:0,duration:2,frames:20},qcamera:{start:.1,duration:2,frames:20},wide:{start:.2,duration:2,frames:20}};
  const data={route:'three cameras',key:'cameras',duration:2.2,warnings:[],video:videos.front,videos,defaultVideo:'front',frames:Array.from({length:45},(_,i)=>({t:i/20,id:i,valid:true,lanes:[],edges:[],lp:[],es:[],leads:[],cameraInfo:{device:'mici',sensor:'os04c10',wideSensor:'os04c10',calibrationStatus:'calibrated',rpy:[.02,.01,-.03],wideRpy:[.01,-.02,.04]},overlay:{geometry:{basis:[[.5,.5,1],[.85,0,0],[0,1.5,0]],height:1.22,lanes:[],edges:[],position:[[5,0,0],[20,1,0],[50,3,0]]}}}))};
  let failFront=false,legacy=false,checking=0,driveDown=false;const requested=[];
  const serve=route=>{
   const url=new URL(route.request().url()),p=url.pathname;
   if(p.endsWith('/bookmarks'))return route.fulfill({json:{bookmarks:[]}});
   if(p==='/api/logs')return route.fulfill({json:{logs:[]}});
   // The replay loads vehicle data in the background for the event track; none here.
   if(p.endsWith('/telemetry'))return route.fulfill({status:404,json:{error:'차량 정보 없음'}});
   if(p.endsWith('/data'))return route.fulfill({json:legacy?{...data,videos:undefined,video:videos.qcamera,defaultVideo:undefined}:data});
   if(p.endsWith('/video')){
    // The page's background copy of the whole video (app.js) is not a choice of source.
    if(route.request().headers()['x-roadviewer-whole-video']!=='1')requested.push(url.searchParams.get('source'));
    if(failFront&&url.searchParams.get('source')==='front')return route.fulfill({status:404,body:'missing'});
    // The server's answers while Google Drive is being checked (first visit) or unreachable.
    if(checking>0){checking--;return route.fulfill({status:503,json:{error:'storage_checking',message:'영상 저장소 연결을 확인하는 중입니다. 잠시 후 다시 시도하세요.'},headers:{'Retry-After':'1'}})}
    if(driveDown)return route.fulfill({status:503,json:{error:'storage_unavailable',message:'영상 저장소(Google Drive)에 연결할 수 없습니다. 인터넷과 Google Drive 연결을 확인하세요.'}});
    const body=fs.readFileSync(process.env.RV_TEST_VIDEO||'/tmp/roadviewer-test.mp4'),range=/^bytes=(\d+)-(\d*)$/.exec(route.request().headers().range||'');
    if(range){const start=Number(range[1]),end=range[2]?Math.min(Number(range[2]),body.length-1):body.length-1;return route.fulfill({status:206,body:body.subarray(start,end+1),contentType:'video/mp4',headers:{'Accept-Ranges':'bytes','Content-Range':`bytes ${start}-${end}/${body.length}`}})}
    return route.fulfill({body,contentType:'video/mp4',headers:{'Accept-Ranges':'bytes'}});
   }
   const name=p.startsWith('/view/')?'index.html':p.replace('/assets/','');
   return route.fulfill({body:fs.readFileSync('roadviewer/app/web/'+name),contentType:name.endsWith('.js')?'application/javascript':name.endsWith('.css')?'text/css':name.endsWith('.html')?'text/html':name.endsWith('.png')?'image/png':'image/svg+xml'});
  };
  await page.route('https://rv.test/**',serve);
  await page.goto('https://rv.test/view/test/');await page.waitForFunction(()=>!loading);
  assert.equal(await page.evaluate(()=>videoSource),'front');assert(requested.includes('front'));
  // Each camera uses its own start offset: preview small offsets, preserve real missing intervals.
  for(const [source,visible] of [['qcamera',true],['wide',false],['front',true]]){
   await page.evaluate(source=>selectVideo(source),source);await page.waitForFunction(()=>!loading&&!v.seeking);
   assert.equal(await page.locator('#video').isVisible(),visible,source+' initial visibility');
   assert.equal(await page.locator('#noVideo').isVisible(),!visible);
   assert.deepEqual(await page.evaluate(()=>({t,playing,time:v.currentTime,paused:v.paused})),{t:0,playing:false,time:0,paused:true});
  }
  for(const width of [320,768,1280]){
   await page.setViewportSize({width,height:900});
   const box=await page.locator('#videoSourceChoice').boundingBox();assert(box.x>=0&&box.x+box.width<=width);
  }
  // A queued animation frame can predate performance.now() recorded when playback resumes.
  await page.evaluate(()=>{pause();setTime(.75)});
  await page.waitForFunction(()=>!v.seeking&&v.readyState>=3);
  const clockSteps=await page.evaluate(()=>{
   const schedule=window.requestAnimationFrame;window.requestAnimationFrame=()=>0;
   try{toggle();const start=last;tick(start-16);const first=t;tick(start+20);return [first,t]}
   finally{pause();window.requestAnimationFrame=schedule}
  });
  assert.equal(clockSteps[0],.75,'a stale animation frame must not rewind playback');
  assert(Math.abs(clockSteps[1]-.77)<1e-9,'the next frame must count only time since resume');
  // Which source the app's loadedmetadata handler (it seeks to the replay time) has run for: this listener comes after it.
  await page.evaluate(()=>{v.addEventListener('loadedmetadata',()=>{window.metadataSrc=v.src})});
  await page.evaluate(()=>{pause();setTime(.75)});
  await page.locator('#videoSourceChoice').click();await page.getByRole('option',{name:'와이드',exact:true}).click();
  // A paused source reloads from its background whole-video copy (a blob: URL) as soon as that has been read. The app's
  // loading flag alone does not mean the media element has finished that reload and its pending seek; nor do
  // readyState and seeking: the swap can land after a wait on those (CI read time 0), and the local copy can read as
  // ready at time 0 before loadedmetadata is handled and the seek starts. So the swap is waited for, then its seek.
  await page.waitForFunction(()=>!loading&&videoSource==='wide'&&v.src.startsWith('blob:')&&window.metadataSrc===v.src&&!v.seeking&&v.readyState>=3);
  let state=await page.evaluate(()=>({t,playing,time:v.currentTime,overlay:$('videoOverlay').hidden}));
  assert.equal(state.t,.75);assert.equal(state.playing,false);assert(Math.abs(state.time-.55)<.02,JSON.stringify(state));
  assert.equal(await page.locator('#videoOverlayToggle').getAttribute('aria-pressed'),'true');assert.doesNotMatch(await page.locator('#overlayStatus').textContent(),/없습니다|표시할 수 없습니다|재분석/);
  assert(await page.locator('#videoOverlay').isVisible());
  const wide=await page.evaluate(()=>{const c=$('videoOverlay');return {path:data.frames[idx].overlay.path,pixels:c.getContext('2d').getImageData(0,0,c.width,c.height).data.some((v,i)=>i%4===3&&v>0)}});assert(wide.pixels,'wide overlay actually draws');
  await page.evaluate(()=>{window.savedWideInfo=data.frames[idx].cameraInfo;data.frames[idx].cameraInfo={...savedWideInfo,wideRpy:null};overlayGeometryCache.clear();render()});
  assert(await page.locator('#videoOverlay').isHidden());assert.match(await page.locator('#overlayStatus').textContent(),/재분석/);
  await page.evaluate(()=>{data.frames[idx].cameraInfo=savedWideInfo;overlayGeometryCache.clear();render()});
  await page.evaluate(()=>selectVideo('front'));await page.waitForFunction(()=>!loading);
  assert.notDeepEqual(await page.evaluate(()=>data.frames[idx].overlay.path),wide.path,'front switch must not reuse wide projection');
  await page.evaluate(()=>selectVideo('wide'));await page.waitForFunction(()=>!loading);
  assert.deepEqual(await page.evaluate(()=>data.frames[idx].overlay.path),wide.path,'switching back recovers the same projection');
  state=await page.evaluate(()=>new Promise(resolve=>{
   const ready=()=>{if(loading||!playing||videoSource!=='front')return;v.removeEventListener('canplay',ready);const state={t,playing,time:v.currentTime};pause();resolve(state)};
   v.addEventListener('canplay',ready);toggle();selectVideo('front');
  }));
  assert.equal(state.t,.75,JSON.stringify(state));assert.equal(state.playing,true);assert(Math.abs(state.time-state.t)<.02,JSON.stringify(state));
  await page.evaluate(()=>{pause();setTime(.9);videoFailure('test error')});
  await page.waitForFunction(()=>!loading&&videoSource==='qcamera');
  assert.equal(await page.evaluate(()=>t),.9);assert.equal(await page.evaluate(()=>playing),false);
  assert.equal(await page.locator('#videoSourceChoice').textContent(),'전방 · 저용량');
  failFront=true;await page.reload();await page.waitForFunction(()=>!loading&&videoSource==='qcamera');
  assert.match(await page.locator('#errorText').textContent(),/전방 · 저용량/);
  legacy=true;await page.reload();await page.waitForFunction(()=>!loading);
  assert(await page.locator('#videoSourceControl').isHidden());assert.equal(await page.evaluate(()=>videoSource),'qcamera');
  assert.equal(requested.at(-1),null);
  // First visit while the store is still being checked: the same camera loads again by itself and plays, no error.
  legacy=false;failFront=false;checking=2;await page.reload();
  await page.waitForFunction(()=>!loading&&videoSource==='front'&&v.readyState>=2,null,{timeout:15000});
  assert.equal(checking,0);assert(await page.locator('#error').isHidden());assert(await page.locator('#video').isVisible());
  // Unreachable Drive: the server's message (naming Google Drive) is shown, not a NAS one, and the log still replays.
  driveDown=true;await page.reload();
  await page.waitForFunction(()=>document.getElementById('errorText')?.textContent==='영상 저장소(Google Drive)에 연결할 수 없습니다. 인터넷과 Google Drive 연결을 확인하세요.'&&!document.getElementById('error').hidden,null,{timeout:15000});
  assert(!(await page.locator('#errorText').textContent()).includes('NAS'));
  await page.waitForFunction(()=>!document.getElementById('play').disabled);
  // Default quality per connection: phones and tablets whose browser does not report it count as mobile data (qcamera),
  // Android's Wi-Fi uses the Wi-Fi choice (front); both are chosen in the 재생 화질 dialog and kept in this browser.
  driveDown=false;
  const open=async(context,expected,label)=>{
   const p=await context.newPage();p.on('pageerror',e=>errors.push(e.message));await p.route('https://rv.test/**',serve);
   requested.length=0;await p.goto('https://rv.test/view/test/');await p.waitForFunction(()=>!loading&&videoSource);
   assert.equal(await p.evaluate(()=>videoSource),expected,label);assert.deepEqual(requested.filter(Boolean),[expected],label);
   return p;
  };
  const choose=async(p,group,value,note)=>{
   await p.locator('#videoSourceChoice').click();await p.locator('.rv-choice-action').click();
   assert(await p.locator('#videoQualityDialog').evaluate(d=>d.open));assert(!(await p.locator('.rv-choice-dialog').evaluate(d=>d.open)));
   assert.equal(await p.locator('#videoQualityNetwork').textContent(),note);
   await p.locator(`input[name="${group}"][value="${value}"]`).check();await p.locator('#videoQualityClose').click();
   assert(await p.locator('#videoSourceChoice').evaluate(e=>e===document.activeElement),'focus returns to the camera choice');
  };
  for(const viewport of [{width:390,height:844},{width:1024,height:1366}]){
   const context=await browser.newContext({hasTouch:true,isMobile:true,viewport});
   let p=await open(context,'qcamera',JSON.stringify(viewport));
   await p.evaluate(()=>videoFailure('test error'));await p.waitForFunction(()=>!loading&&videoSource==='front');
   await context.close();
  }
  const phone=await browser.newContext({hasTouch:true,isMobile:true,viewport:{width:390,height:844}});
  let p=await open(phone,'qcamera','unknown network on a phone');
  await choose(p,'qualityCellular','front','현재 연결을 확인할 수 없어 모바일 데이터 설정을 따릅니다.');await p.close();
  p=await open(phone,'front','mobile data set to high quality');await p.close();
  await phone.addInitScript(()=>Object.defineProperty(navigator,'connection',{configurable:true,value:{type:'wifi',addEventListener(){}}}));
  p=await open(phone,'front','Wi-Fi on Android');
  await choose(p,'qualityWifi','qcamera','현재 연결: 와이파이 · 유선');await p.close();
  p=await open(phone,'qcamera','Wi-Fi set to low quality');await phone.close();
  const desktop=await browser.newContext();
  p=await open(desktop,'front','desktop');await choose(p,'qualityWifi','qcamera','현재 연결을 확인할 수 없어 와이파이 · 유선 설정을 따릅니다.');await p.close();
  p=await open(desktop,'qcamera','desktop set to low quality');
  await p.locator('#speedChoice').click();assert(await p.locator('.rv-choice-action').isHidden(),'only the camera list has 기본 화질');
  await p.keyboard.press('Escape');await desktop.close();
  assert.deepEqual(errors,[]);
  console.log('PASS: front preference, per-connection default quality (phones, tablets, Android Wi-Fi, desktop), independent clocks, paused/playing switches, wide projection/cache/metadata guard, failure fallback, legacy qcamera, storage-checking retry, Drive failure message');
 }finally{await browser.close()}
})().catch(e=>{console.error(e);process.exit(1)});
