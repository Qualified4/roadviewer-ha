const fs=require('fs'),assert=require('node:assert/strict'),{chromium}=require('playwright');
const {settleLayout}=require('./browser-helpers.cjs');
// Segment preview: a mouse over a segment block, or a finger held on one, shows that segment's thumbnail and start time
// above the strip and leaving hides it; a finger held on a block raises it out of the strip (segmentGesture), and
// pushed up past the line and let go it opens. Each picture is fetched once.
const asset=name=>({body:fs.readFileSync('roadviewer/app/web/'+name),contentType:name.endsWith('.html')?'text/html':name.endsWith('.js')?'application/javascript':name.endsWith('.css')?'text/css':name.endsWith('.png')?'image/png':'image/svg+xml'});
const start=Date.UTC(2026,10,7,23,2)/1000,status=['ready','ready','ready','unconverted'];
const makeLogs=status=>status.map((s,i)=>({id:'s'+i,name:`0000041b--a1b2c3d4e5 / 구간 ${i}`,status:s,uploaded:start,started_at:start+i*60,duration:60,bytes:1e7,prepared_bytes:3e7,video:true,pinned:false,tags:[],
 thumbnail:i===1,thumbnail_available:i===2,conversion_revision:2}));
const replay={route:'0000041b--a1b2c3d4e5',key:'peek',duration:2,warnings:[],video:null,frames:Array.from({length:20},(_,i)=>({t:i*.1,id:i,valid:true,lanes:[],edges:[],lp:[],es:[],leads:[],liveTracksValid:false}))};
const clock=i=>new Date((start+i*60)*1000).toLocaleTimeString('ko-KR',{hour:'numeric',minute:'2-digit'});
const logs=makeLogs(status);
async function open(browser,options,list=logs){
 const context=await browser.newContext(options),page=await context.newPage(),errors=[],pictures=[];
 page.on('pageerror',e=>errors.push(e.message));
 await page.route('https://rv.test/**',route=>{
  const url=new URL(route.request().url()),p=url.pathname;
  if(p.endsWith('/thumbnail')){pictures.push(p+url.search);return route.fulfill(asset('carrot_wheel.png'))}
  if(p.endsWith('/bookmarks'))return route.fulfill({json:{bookmarks:[]}});
  if(p.endsWith('/telemetry'))return route.fulfill({status:404,json:{error:'없음'}});
  if(p.endsWith('/data'))return route.fulfill({json:replay});
  if(p==='/api/logs')return route.fulfill({json:{logs:list,concurrency:1,auto_convert:true,max_upload_mb:512}});
  if(p.startsWith('/api/'))return route.fulfill({json:{progress:{}}});
  return route.fulfill(asset(p==='/'?'library.html':p.startsWith('/view/')?'index.html':p.replace('/assets/','')));
 });
 await page.goto('https://rv.test/view/s0/');await page.locator('#play:enabled').waitFor();
 await page.waitForFunction(n=>document.querySelectorAll('#segmentStrip .segment-block').length===n,list.length);await settleLayout(page);
 return {context,page,errors,pictures};
}
const peek=page=>page.evaluate(()=>{
 const e=document.getElementById('segmentPeek'),r=e.getBoundingClientRect(),img=e.querySelector('img'),s=getComputedStyle(e);
 return {shown:e.classList.contains('is-shown'),visible:s.visibility==='visible',label:e.querySelector('b').textContent,time:e.querySelector('span').textContent,
  img:img?img.src.replace(location.origin,''):null,loaded:!!img?.naturalWidth,rect:[r.left,r.right,r.top,r.bottom],tail:parseFloat(e.style.getPropertyValue('--tail'))||0,width:innerWidth};
});
const block=(page,i)=>page.locator('#segmentStrip .segment-block').nth(i).boundingBox();
(async()=>{
 const browser=await chromium.launch({headless:true});
 try{
  // Mouse: hover shows, moving along switches, leaving hides; the picture comes from the list's thumbnail URL once.
  const desk=await open(browser,{viewport:{width:1300,height:900}});let p=desk.page;
  assert(!(await peek(p)).visible,'hidden until hovered');
  let b=await block(p,1);await p.mouse.move(b.x+b.width/2,b.y+b.height/2);await p.waitForTimeout(200);
  let s=await peek(p);
  assert(s.shown&&s.visible,'hover shows the preview');assert.equal(s.label,'구간 1');assert.equal(s.time,clock(1),'its start time');
  assert.equal(s.img,'/api/logs/s1/thumbnail?v=2','the list thumbnail URL');assert(s.loaded,'the picture loads');
  assert(s.rect[3]<=b.y,'above the strip');assert(Math.abs((s.rect[0]+s.rect[1])/2+s.tail-(b.x+b.width/2))<=1.5,'the tail points at the block');
  b=await block(p,2);await p.mouse.move(b.x+b.width/2,b.y+b.height/2);await p.waitForTimeout(200);s=await peek(p);
  assert.equal(s.label,'구간 2');assert.equal(s.img,'/api/logs/s2/thumbnail?v=2&pending=1','a thumbnail still being made uses its pending URL');
  b=await block(p,3);await p.mouse.move(b.x+b.width/2,b.y+b.height/2);await p.waitForTimeout(200);s=await peek(p);
  assert.equal(s.label,'구간 3');assert.equal(s.time,'미변환','an unconverted segment says so');assert.equal(s.img,null,'and shows the camera placeholder');
  b=await block(p,0);await p.mouse.move(b.x+2,b.y+b.height/2);await p.waitForTimeout(200);s=await peek(p);
  assert(s.rect[0]>=0&&s.rect[1]<=s.width,'the card stays on screen at the edge');
  await p.mouse.move(b.x,b.y-200);await p.waitForTimeout(250);assert(!(await peek(p)).visible,'leaving the strip hides it');
  b=await block(p,1);await p.mouse.move(b.x+b.width/2,b.y+b.height/2);await p.waitForTimeout(200);
  assert.equal(desk.pictures.filter(u=>u.includes('/s1/')).length,1,'a picture seen before is not fetched again');
  // Keyboard shortcuts work with focus left on the controls by a mouse click: Space plays/pauses, ←/→ step a frame,
  // F asks for full screen, PageUp/PageDown open the previous/next playable segment.
  await p.locator('#play').click();await p.waitForTimeout(100);assert(await p.evaluate(()=>playing),'the play button plays');
  await p.keyboard.press('Space');assert(!(await p.evaluate(()=>playing)),'Space pauses with focus on the play button');
  await p.keyboard.press('Space');assert(await p.evaluate(()=>playing),'and plays again');await p.keyboard.press('Space');
  const sk=await p.locator('#seek').boundingBox();await p.mouse.click(sk.x+sk.width*.5,sk.y+sk.height/2);await p.waitForTimeout(100);
  assert.equal(await p.evaluate(()=>document.activeElement.id),'seek');
  let frame=await p.evaluate(()=>idx);await p.keyboard.press('ArrowRight');assert.equal(await p.evaluate(()=>idx),frame+1,'→ steps a frame from the seek bar');
  await p.keyboard.press('ArrowLeft');assert.equal(await p.evaluate(()=>idx),frame,'← steps back');
  assert(!(await p.evaluate(()=>playing)),'stepping leaves it paused');
  const asked=await p.evaluate(()=>{const b=document.getElementById('fullscreenButton');b.hidden=false;window.fullscreenAsked=0;b.onclick=()=>window.fullscreenAsked++;return true});
  await p.keyboard.press('f');assert.equal(await p.evaluate(()=>window.fullscreenAsked),1,'F asks for full screen');
  await p.keyboard.press('PageUp');await p.waitForTimeout(200);assert(p.url().endsWith('/view/s0/'),'PageUp on the first segment stays');
  await p.keyboard.press('PageDown');await p.waitForURL(/\/view\/s1\/$/);await p.locator('#play:enabled').waitFor();
  await p.waitForFunction(()=>document.querySelectorAll('#segmentStrip .segment-block').length===4);
  await p.keyboard.press('PageUp');await p.waitForURL(/\/view\/s0\/$/);
  assert.deepEqual(desk.errors,[]);await desk.context.close();

  // Touch: a held block rises out of the strip (segmentGesture). Holding shows its card, the blurred screen and the
  // looping hint; sliding along the strip changes the segment; pushed up off the strip the segment locks, only the card
  // follows, the title shows and, far enough up, 밀어서 turns to 놓으면 and letting go opens it. Short of that, on the strip
  // or below it, nothing opens. The playing segment flattens the arrow; one not ready says so.
  const phone=await open(browser,{viewport:{width:390,height:844},hasTouch:true,isMobile:true});p=phone.page;
  const cdp=await phone.context.newCDPSession(p),touch=(type,x,y)=>cdp.send('Input.dispatchTouchEvent',{type,touchPoints:type==='touchEnd'?[]:[{x,y}]});
  const g=()=>p.evaluate(()=>{const q=s=>document.querySelector(s),c=q('#segmentGestureCard'),r=c.getBoundingClientRect(),hint=q('.sg-hint'),title=q('.sg-title');
   return {on:q('.segment-gesture-over').classList.contains('is-on'),blur:q('.segment-gesture-under').classList.contains('is-on'),shown:c.classList.contains('is-shown'),label:c.querySelector('b').textContent,top:r.top,
    hintGone:hint.classList.contains('is-gone'),flat:hint.classList.contains('is-flat'),note:q('.sg-note').textContent,title:title.classList.contains('is-shown'),num:q('.sg-num').textContent,armed:q('.sg-sub').classList.contains('is-armed'),
    dark:+getComputedStyle(q('.sg-dark')).opacity,target:[...document.querySelectorAll('#segmentStrip .segment-block.is-target')].map(b=>b.dataset.id)}});
  b=await block(p,1);const x=b.x+b.width/2,y=b.y+b.height/2;
  await touch('touchStart',x,y);await p.waitForTimeout(200);assert(!(await g()).shown,'not before the hold time');
  await p.waitForTimeout(350);s=await g();assert(s.shown&&s.on&&s.blur,'a held finger raises the card over a blurred screen');assert.equal(s.label,'구간 1');
  assert(!s.hintGone&&!s.flat&&!s.title,'the hint loops; no title yet');assert.deepEqual(s.target,['s1'],'its block is marked');
  assert(!(await peek(p)).visible,'the mouse preview stays hidden');
  assert(await p.evaluate(()=>!document.getElementById('segmentStrip').querySelector('.segment-block').dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true}))),'no long-press menu on the strip');
  const rest=s.top;
  await touch('touchMove',x,y+60);await p.waitForTimeout(60);s=await g();assert(s.shown&&!s.title&&s.dark===0,'below the strip nothing changes');
  await touch('touchEnd');await p.waitForTimeout(500);
  assert(!(await g()).on,'letting go closes it');assert(p.url().endsWith('/view/s0/'),'letting go below the strip does not navigate');
  await touch('touchStart',x,y);await p.waitForTimeout(550);await touch('touchEnd');await p.waitForTimeout(500);
  assert(p.url().endsWith('/view/s0/'),'letting go on the strip does not navigate');
  await touch('touchStart',x,y);await p.waitForTimeout(60);await touch('touchMove',x+30,y);await p.waitForTimeout(550);
  assert(!(await g()).shown,'moving before the hold time does not start it');await touch('touchEnd');
  // Held on the strip, sliding scrubs through the segments; on the playing one the arrow flattens, on one not ready a note.
  await touch('touchStart',x,y);await p.waitForTimeout(550);assert.equal((await g()).label,'구간 1');
  for(const [i,label] of [[2,'구간 2'],[3,'구간 3'],[0,'구간 0']]){const t=await block(p,i);await touch('touchMove',t.x+t.width/2,y+4);await p.waitForTimeout(80);
   const now=await g();assert(now.shown,'still shown while scrubbing');assert.equal(now.label,label,'the card follows the finger');
   if(i===3)assert.equal(now.note,'준비 중인 구간','a segment not ready says so');
   if(i===0)assert(now.flat&&now.note==='','on the playing segment the arrow flattens, no words');}
  await touch('touchEnd');await p.waitForTimeout(500);assert(p.url().endsWith('/view/s0/'),'letting go on the playing segment stays');
  // Pushed up: the segment locks, only the card rises, the rest darkens, the title shows 구간 1 · 밀어서 구간이동.
  await touch('touchStart',x,y);await p.waitForTimeout(550);
  await touch('touchMove',x,y-30);await p.waitForTimeout(50);
  {const f=await g();assert(rest-f.top>26,`the card is with the finger a frame later, not easing after it: ${(rest-f.top).toFixed(1)}px of 30`)}
  await p.waitForTimeout(200);s=await g();
  assert(s.title&&s.num==='구간 1'&&!s.armed,'the title rises with 밀어서');assert(s.hintGone,'the hint fades');assert(s.dark>0,'the screen darkens');assert(s.top<rest-20,'the card follows the finger up');
  {const t=await block(p,2);await touch('touchMove',t.x+t.width/2,y-34);await p.waitForTimeout(80);assert.equal((await g()).label,'구간 1','pushed up, sliding sideways keeps the segment');}
  await touch('touchMove',x,y-100);await p.waitForTimeout(250);s=await g();assert(s.armed,'far enough up: 놓으면 구간이동');assert(s.dark>.5,'darker');
  await touch('touchMove',x,y-30);await p.waitForTimeout(150);assert(!(await g()).armed,'back down: 밀어서 again');
  await touch('touchMove',x,y);await p.waitForTimeout(150);s=await g();assert(!s.title&&!s.hintGone,'back on the strip: the hint returns, the title goes');
  {const t=await block(p,2);await touch('touchMove',t.x+t.width/2,y);await p.waitForTimeout(80);assert.equal((await g()).label,'구간 2','back on the strip it scrubs again');}
  await touch('touchMove',x,y-40);await p.waitForTimeout(80);await touch('touchEnd');await p.waitForTimeout(600);
  s=await g();assert(!s.on&&p.url().endsWith('/view/s0/'),'let go short of the line: it settles back and nothing opens');
  // An unconverted segment cannot be pushed; segment 2 pushed past the line opens.
  {const t=await block(p,3);await touch('touchStart',t.x+t.width/2,y);await p.waitForTimeout(550);await touch('touchMove',t.x+t.width/2,y-100);await p.waitForTimeout(150);
   s=await g();assert(!s.title&&!s.armed&&s.dark===0,'a segment not ready does not rise');await touch('touchEnd');await p.waitForTimeout(500);assert(p.url().endsWith('/view/s0/'),'an unconverted segment does not open');}
  {const t=await block(p,2);await touch('touchStart',t.x+t.width/2,y);await p.waitForTimeout(550);await touch('touchMove',t.x+t.width/2,y-100);await p.waitForTimeout(150);
   assert((await g()).armed,'segment 2 pushed past the line');await touch('touchEnd');await p.waitForURL(/\/view\/s2\/$/);}
  await p.locator('#play:enabled').waitFor();await p.waitForFunction(()=>document.querySelectorAll('#segmentStrip .segment-block').length===4);await settleLayout(p);
  await p.locator('#segmentStrip .segment-block').nth(1).tap();await p.waitForURL(/\/view\/s1\/$/);
  assert.deepEqual(phone.errors,[]);await phone.context.close();

  // A long drive's scrolling strip: resting the held finger near its right end moves the strip on to later segments.
  const long=await open(browser,{viewport:{width:390,height:844},hasTouch:true,isMobile:true},makeLogs(Array(60).fill('ready')));p=long.page;
  const lcdp=await long.context.newCDPSession(p),ltouch=(type,x,y)=>lcdp.send('Input.dispatchTouchEvent',{type,touchPoints:type==='touchEnd'?[]:[{x,y}]});
  assert(await p.evaluate(()=>document.getElementById('segmentStrip').classList.contains('is-scrolling')),'60 segments scroll');
  b=await block(p,0);const strip=await p.locator('#segmentStrip').boundingBox(),left=await p.evaluate(()=>document.getElementById('segmentStrip').scrollLeft);
  await ltouch('touchStart',b.x+b.width/2,b.y+b.height/2);await p.waitForTimeout(550);
  await ltouch('touchMove',strip.x+strip.width-6,b.y+b.height/2);await p.waitForTimeout(800);
  const moved=await p.evaluate(()=>document.getElementById('segmentStrip').scrollLeft),label=await p.evaluate(()=>document.querySelector('#segmentGestureCard b').textContent);
  assert(moved>left+40,`the strip moves on at its end: ${left} -> ${moved}`);assert(Number(label.split(' ')[1])>6,'the preview shows a later segment: '+label);
  await ltouch('touchEnd');await p.waitForTimeout(200);const settled=await p.evaluate(()=>document.getElementById('segmentStrip').scrollLeft);await p.waitForTimeout(300);
  assert.equal(await p.evaluate(()=>document.getElementById('segmentStrip').scrollLeft),settled,'it stops when the finger lifts');
  assert.deepEqual(long.errors,[]);await long.context.close();
  console.log('PASS: segment preview on hover (thumbnail, start time, state, placement, fetched once) and on a touch hold (scrubbing along the strip, edge scrolling on long drives, pushing the segment up locks it, raises the title and opens it past the line, short of it or below the strip cancels, the playing segment flattens the arrow, taps still navigate), and the keyboard shortcuts (Space, arrows, F, PageUp/PageDown) with focus left on the controls');
 }finally{await browser.close()}
})().catch(e=>{console.error(e);process.exit(1)});
