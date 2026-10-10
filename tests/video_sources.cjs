const fs=require('fs'),assert=require('node:assert/strict'),{chromium}=require('playwright');
(async()=>{
 const browser=await chromium.launch({headless:true});
 try{
  const page=await browser.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
  const videos={front:{start:0,duration:2,frames:20},qcamera:{start:.1,duration:2,frames:20},wide:{start:.2,duration:2,frames:20}};
  const data={route:'three cameras',key:'cameras',duration:2.2,warnings:[],video:videos.front,videos,defaultVideo:'front',frames:Array.from({length:45},(_,i)=>({t:i/20,id:i,valid:true,lanes:[],edges:[],lp:[],es:[],leads:[],cameraInfo:{device:'mici',sensor:'os04c10',wideSensor:'os04c10',calibrationStatus:'calibrated',rpy:[.02,.01,-.03],wideRpy:[.01,-.02,.04]},overlay:{geometry:{basis:[[.5,.5,1],[.85,0,0],[0,1.5,0]],height:1.22,lanes:[],edges:[],position:[[5,0,0],[20,1,0],[50,3,0]]}}}))};
  let failFront=false,legacy=false;const requested=[];
  await page.route('https://rv.test/**',route=>{
   const url=new URL(route.request().url()),p=url.pathname;
   if(p==='/api/logs')return route.fulfill({json:{logs:[]}});
   if(p.endsWith('/data'))return route.fulfill({json:legacy?{...data,videos:undefined,video:videos.qcamera,defaultVideo:undefined}:data});
   if(p.endsWith('/video')){
    requested.push(url.searchParams.get('source'));
    if(failFront&&url.searchParams.get('source')==='front')return route.fulfill({status:404,body:'missing'});
    const body=fs.readFileSync(process.env.RV_TEST_VIDEO||'/tmp/roadviewer-test.mp4'),range=/^bytes=(\d+)-(\d*)$/.exec(route.request().headers().range||'');
    if(range){const start=Number(range[1]),end=range[2]?Math.min(Number(range[2]),body.length-1):body.length-1;return route.fulfill({status:206,body:body.subarray(start,end+1),contentType:'video/mp4',headers:{'Accept-Ranges':'bytes','Content-Range':`bytes ${start}-${end}/${body.length}`}})}
    return route.fulfill({body,contentType:'video/mp4',headers:{'Accept-Ranges':'bytes'}});
   }
   const name=p.startsWith('/view/')?'index.html':p.replace('/assets/','');
   return route.fulfill({body:fs.readFileSync('roadviewer/app/web/'+name),contentType:name.endsWith('.js')?'application/javascript':name.endsWith('.css')?'text/css':name.endsWith('.html')?'text/html':name.endsWith('.png')?'image/png':'image/svg+xml'});
  });
  await page.goto('https://rv.test/view/test/');await page.waitForFunction(()=>!loading);
  assert.equal(await page.evaluate(()=>videoSource),'front');assert(requested.includes('front'));
  for(const width of [320,768,1280]){
   await page.setViewportSize({width,height:900});
   const box=await page.locator('#videoSourceChoice').boundingBox();assert(box.x>=0&&box.x+box.width<=width);
  }
  // A queued animation frame can predate performance.now() recorded when playback resumes.
  const clockSteps=await page.evaluate(()=>{
   pause();setTime(.75);const schedule=window.requestAnimationFrame;window.requestAnimationFrame=()=>0;
   try{toggle();const start=last;tick(start-16);const first=t;tick(start+20);return [first,t]}
   finally{pause();window.requestAnimationFrame=schedule}
  });
  assert.equal(clockSteps[0],.75,'a stale animation frame must not rewind playback');
  assert(Math.abs(clockSteps[1]-.77)<1e-9,'the next frame must count only time since resume');
  await page.evaluate(()=>{pause();setTime(.75)});
  await page.locator('#videoSourceChoice').click();await page.getByRole('option',{name:'와이드',exact:true}).click();
  await page.waitForFunction(()=>!loading&&videoSource==='wide');
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
  assert.equal(requested.at(-1),null);assert.deepEqual(errors,[]);
  console.log('PASS: front preference, independent clocks, paused/playing switches, wide projection/cache/metadata guard, failure fallback, legacy qcamera');
 }finally{await browser.close()}
})().catch(e=>{console.error(e);process.exit(1)});
