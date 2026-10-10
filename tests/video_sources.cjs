const fs=require('fs'),assert=require('node:assert/strict'),{chromium}=require('playwright');
(async()=>{
 const browser=await chromium.launch({headless:true});
 try{
  const page=await browser.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
  const videos={front:{start:0,duration:2,frames:20},qcamera:{start:.1,duration:2,frames:20},wide:{start:.2,duration:2,frames:20}};
  const data={route:'three cameras',key:'cameras',duration:2.2,warnings:[],video:videos.front,videos,defaultVideo:'front',frames:Array.from({length:45},(_,i)=>({t:i/20,id:i,valid:false,lanes:[],edges:[],lp:[],es:[],leads:[]}))};
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
  await page.evaluate(()=>{pause();setTime(.75)});
  await page.locator('#videoSourceChoice').click();await page.getByRole('option',{name:'와이드',exact:true}).click();
  await page.waitForFunction(()=>!loading&&videoSource==='wide');
  let state=await page.evaluate(()=>({t,playing,time:v.currentTime,overlay:$('videoOverlay').hidden}));
  assert.equal(state.t,.75);assert.equal(state.playing,false);assert(Math.abs(state.time-.55)<.02,JSON.stringify(state));
  await page.locator('#videoOverlayToggle').click();assert.match(await page.locator('#overlayStatus').textContent(),/와이드/);
  assert(await page.locator('#videoOverlay').isHidden());
  await page.evaluate(()=>{toggle();selectVideo('front')});
  await page.waitForFunction(()=>!loading&&playing&&videoSource==='front');
  state=await page.evaluate(()=>({t,playing,time:v.currentTime}));assert(state.t>=.75&&state.t<1.2);assert(Math.abs(state.time-state.t)<.15);
  await page.evaluate(()=>{pause();setTime(.9);videoFailure('test error')});
  await page.waitForFunction(()=>!loading&&videoSource==='qcamera');
  assert.equal(await page.evaluate(()=>t),.9);assert.equal(await page.evaluate(()=>playing),false);
  assert.equal(await page.locator('#videoSourceChoice').textContent(),'전방 · 저용량');
  failFront=true;await page.reload();await page.waitForFunction(()=>!loading&&videoSource==='qcamera');
  assert.match(await page.locator('#errorText').textContent(),/전방 · 저용량/);
  legacy=true;await page.reload();await page.waitForFunction(()=>!loading);
  assert(await page.locator('#videoSourceControl').isHidden());assert.equal(await page.evaluate(()=>videoSource),'qcamera');
  assert.equal(requested.at(-1),null);assert.deepEqual(errors,[]);
  console.log('PASS: front preference, independent clocks, paused/playing switches, wide overlay guard, failure fallback, legacy qcamera');
 }finally{await browser.close()}
})().catch(e=>{console.error(e);process.exit(1)});
