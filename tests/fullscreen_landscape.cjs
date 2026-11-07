const fs=require('fs'),assert=require('node:assert/strict'),{chromium}=require('playwright');
// Full screen on phones and tablets shows the video in landscape: the browser's orientation lock where it works, and a
// quarter-turned frame where it is refused (the Home Assistant app's Android WebView), with touch seeking along the turn.
const serve=route=>{
 const p=new URL(route.request().url()).pathname;
 if(p.endsWith('/bookmarks'))return route.fulfill({json:{bookmarks:[]}});
 if(p==='/api/logs')return route.fulfill({json:{logs:[{id:'one',name:'00000395--0d0eda17c5 / 구간 7',status:'ready',pinned:false}]}});
 if(p.endsWith('/video'))return route.fulfill({body:fs.readFileSync(process.env.RV_TEST_VIDEO||'/tmp/roadviewer-test.mp4'),contentType:'video/mp4'});
 if(p.endsWith('/telemetry'))return route.fulfill({status:404,json:{error:'차량 정보 없음'}});
 if(p.endsWith('/data'))return route.fulfill({json:{route:'test',key:'overlay',duration:2,warnings:[],video:{start:0,duration:2},frames:[{t:0,id:0,valid:true,lanes:[],edges:[],lp:[],es:[],leads:[],liveTracksValid:false}]}});
 const name=p.startsWith('/view/')?'index.html':p.replace('/assets/','');
 return route.fulfill({body:fs.readFileSync('roadviewer/app/web/'+name),contentType:name.endsWith('.html')?'text/html':name.endsWith('.js')?'application/javascript':name.endsWith('.css')?'text/css':name.endsWith('.png')?'image/png':'image/svg+xml'});
};
async function open(browser,options,lock){
 const page=await browser.newPage(options),errors=[];page.on('pageerror',e=>errors.push(e.message));
 // The orientation lock is the browser's; here it records calls and resolves or refuses as asked.
 await page.addInitScript(lock=>{window.lockCalls=[];window.unlockCalls=0;const o=screen.orientation;
  o.lock=type=>{window.lockCalls.push(type);return lock==='resolve'?Promise.resolve():Promise.reject(new DOMException('not supported','NotSupportedError'))};
  o.unlock=()=>{window.unlockCalls++}},lock);
 await page.route('https://rv.test/**',serve);await page.goto('https://rv.test/view/one/');
 await page.waitForFunction(()=>!document.getElementById('play').disabled);page.errors=errors;return page;
}
const state=page=>page.evaluate(()=>{
 const stage=document.querySelector('.camera-panel'),frame=stage.querySelector('.stage-frame').getBoundingClientRect(),wrap=document.getElementById('videoStage'),bar=document.querySelector('.playback');
 return {full:document.fullscreenElement===stage,turned:stage.classList.contains('is-turned'),root:document.documentElement.classList.contains('stage-turned'),
  frame:[frame.left,frame.top,frame.width,frame.height].map(Math.round),wrap:[wrap.clientWidth,wrap.clientHeight],bar:bar.offsetWidth,
  transport:getComputedStyle(document.documentElement).getPropertyValue('--transport-height'),barHeight:bar.offsetHeight,strip:getComputedStyle(document.getElementById('segmentStrip')).display,lock:window.lockCalls,unlock:window.unlockCalls};
});
(async()=>{
 const browser=await chromium.launch({headless:true});
 try{
  // Refused lock on a portrait phone: the frame is laid out 844 wide and turned to cover the 390x844 screen.
  const phone=await open(browser,{viewport:{width:390,height:844},hasTouch:true,isMobile:true},'reject');
  await phone.locator('#fullscreenButton').tap();
  await phone.waitForFunction(()=>document.querySelector('.camera-panel').classList.contains('is-turned'));
  let s=await state(phone);
  assert.deepEqual(s.lock,['landscape']);assert(s.full&&s.root,'full screen, turned');assert.equal(s.strip,'none','no segment strip in touch full screen');
  assert.deepEqual(s.frame,[0,0,390,844],'the turned frame covers the screen');
  assert.equal(s.bar,844,'the transport bar runs the screen height');assert(s.wrap[0]>s.wrap[1],'the video area is landscape');
  assert.equal(s.transport,s.barHeight+'px','the bar is measured by its own height, not its turned length');
  // Touch seeking follows the finger down the turned bar.
  const seek=await phone.locator('#seek').boundingBox();
  // Measured while the finger is down: on release the bar follows the video's actual (keyframe) time.
  const cdp=await phone.context().newCDPSession(phone),x=seek.x+seek.width/2,y=fraction=>seek.y+8+fraction*(seek.height-16);
  await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x,y:y(.25)}]});
  for(const fraction of [.25,.75]){
   if(fraction!==.25)await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x,y:y(fraction)}]});
   const value=await phone.evaluate(()=>{const seek=document.getElementById('seek');return Number(seek.value)/Number(seek.max)});
   assert(Math.abs(value-fraction)<.02,`touch at ${fraction} of the turned bar seeks to ${value}`);
  }
  await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
  // A dialog opened while turned is turned with it.
  assert.equal(await phone.evaluate(()=>{const d=document.createElement('dialog');document.body.append(d);d.showModal();const r=getComputedStyle(d).rotate;d.remove();return r}),'90deg');
  // (Turning the device itself cannot be emulated: headless Chromium does not resize a full screen window.)
  await phone.evaluate(()=>document.exitFullscreen());await phone.waitForFunction(()=>!document.fullscreenElement&&!document.documentElement.classList.contains('stage-turned'),null,{timeout:3000}).catch(()=>{});
  s=await state(phone);assert(!s.turned&&!s.root,'leaving full screen undoes the turn');assert.notEqual(s.strip,'none','the strip is back after full screen');assert.equal(s.unlock,0,'nothing to unlock after a refused lock');
  assert.deepEqual(phone.errors,[]);

  // Accepted lock: the browser turns the screen itself, so the page does not, and leaving full screen unlocks.
  const locked=await open(browser,{viewport:{width:390,height:844},hasTouch:true,isMobile:true},'resolve');
  await locked.locator('#fullscreenButton').tap();await locked.waitForFunction(()=>window.lockCalls.length&&document.fullscreenElement);
  await locked.waitForTimeout(100);s=await state(locked);assert(s.full&&!s.turned&&!s.root,'an accepted lock is not turned again');assert.equal(s.strip,'none','no segment strip in touch full screen');
  await locked.evaluate(()=>document.exitFullscreen());await locked.waitForFunction(()=>!document.fullscreenElement&&window.unlockCalls,null,{timeout:3000}).catch(()=>{});
  assert.equal((await state(locked)).unlock,1);assert.deepEqual(locked.errors,[]);

  // Landscape tablet, stacked: the picture is sized as if the app bar folds away (it does while playing), so it fills the
  // card's width, and coming back from full screen (system bars hide and return) gives the same size, not a smaller one.
  // Paused, with the app bar shown, the bottom controls over the video move up clear of the transport bar.
  const tab=await open(browser,{viewport:{width:1000,height:780},hasTouch:true,isMobile:true},'reject'),tabCdp=await tab.context().newCDPSession(tab);
  const metrics=height=>tabCdp.send('Emulation.setDeviceMetricsOverride',{width:1000,height,deviceScaleFactor:2,mobile:true});
  const sized=()=>tab.evaluate(()=>{const v=document.getElementById('videoStage').getBoundingClientRect(),p=document.querySelector('.camera-panel'),s=getComputedStyle(p),bar=document.querySelector('.playback').getBoundingClientRect();
   return {stacked:document.body.classList.contains('layout-stacked'),size:[Math.round(v.width),Math.round(v.height)],room:Math.round(p.clientWidth-parseFloat(s.paddingLeft)-parseFloat(s.paddingRight)),
    button:document.getElementById('fullscreenButton').getBoundingClientRect().bottom,tools:document.querySelector('.video-tools').getBoundingClientRect().bottom,bar:bar.top}});
  await tab.waitForTimeout(800);const first=await sized();
  assert(first.stacked,'the tablet layout is stacked');assert(Math.abs(first.size[0]-first.room)<=1,'the picture fills the card width: '+first.size[0]+' / '+first.room);
  assert(first.button<=first.bar&&first.tools<=first.bar,`bottom video controls clear the transport bar: ${first.button}, ${first.tools} / ${first.bar}`);
  await tab.evaluate(()=>document.getElementById('fullscreenButton').click());await tab.waitForFunction(()=>document.fullscreenElement);await metrics(840);await tab.waitForTimeout(200);
  await tab.evaluate(()=>document.exitFullscreen());await tab.waitForTimeout(100);await metrics(780);await tab.waitForTimeout(500);
  assert.deepEqual((await sized()).size,first.size,'the same size after full screen');assert.deepEqual(tab.errors,[]);

  // Desktop: no orientation lock, no turn.
  const desk=await open(browser,{viewport:{width:1280,height:800}},'reject');
  await desk.locator('#fullscreenButton').click();await desk.waitForFunction(()=>document.fullscreenElement);await desk.waitForTimeout(100);
  s=await state(desk);assert.deepEqual(s.lock,[]);assert(!s.turned);assert.notEqual(s.strip,'none','desktop full screen keeps the segment strip');assert.deepEqual(desk.errors,[]);
  console.log('PASS: full screen on touch screens locks landscape, or turns the frame a quarter turn when refused (screen-filling frame, bar measured by its height, touch seek along the turn, turned dialogs, no segment strip, undone on exit); desktop unchanged');
 }finally{await browser.close()}
})().catch(e=>{console.error(e);process.exit(1)});
