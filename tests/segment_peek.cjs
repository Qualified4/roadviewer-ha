const fs=require('fs'),assert=require('node:assert/strict'),{chromium}=require('playwright');
const {settleLayout}=require('./browser-helpers.cjs');
// Segment preview: a mouse over a segment block, or a finger held on one, shows that segment's thumbnail and start time
// above the strip; leaving or letting go hides it, a held finger does not navigate, and each picture is fetched once.
const asset=name=>({body:fs.readFileSync('roadviewer/app/web/'+name),contentType:name.endsWith('.html')?'text/html':name.endsWith('.js')?'application/javascript':name.endsWith('.css')?'text/css':name.endsWith('.png')?'image/png':'image/svg+xml'});
const start=Date.UTC(2026,10,7,23,2)/1000,status=['ready','ready','ready','unconverted'];
const logs=status.map((s,i)=>({id:'s'+i,name:`0000041b--a1b2c3d4e5 / 구간 ${i}`,status:s,uploaded:start,started_at:start+i*60,duration:60,bytes:1e7,prepared_bytes:3e7,video:true,pinned:false,tags:[],
 thumbnail:i===1,thumbnail_available:i===2,conversion_revision:2}));
const replay={route:'0000041b--a1b2c3d4e5',key:'peek',duration:2,warnings:[],video:null,frames:[{t:0,id:0,valid:true,lanes:[],edges:[],lp:[],es:[],leads:[],liveTracksValid:false}]};
const clock=i=>new Date((start+i*60)*1000).toLocaleTimeString('ko-KR',{hour:'numeric',minute:'2-digit'});
async function open(browser,options){
 const context=await browser.newContext(options),page=await context.newPage(),errors=[],pictures=[];
 page.on('pageerror',e=>errors.push(e.message));
 await page.route('https://rv.test/**',route=>{
  const url=new URL(route.request().url()),p=url.pathname;
  if(p.endsWith('/thumbnail')){pictures.push(p+url.search);return route.fulfill(asset('carrot_wheel.png'))}
  if(p.endsWith('/bookmarks'))return route.fulfill({json:{bookmarks:[]}});
  if(p.endsWith('/telemetry'))return route.fulfill({status:404,json:{error:'없음'}});
  if(p.endsWith('/data'))return route.fulfill({json:replay});
  if(p==='/api/logs')return route.fulfill({json:{logs,concurrency:1,auto_convert:true,max_upload_mb:512}});
  if(p.startsWith('/api/'))return route.fulfill({json:{progress:{}}});
  return route.fulfill(asset(p==='/'?'library.html':p.startsWith('/view/')?'index.html':p.replace('/assets/','')));
 });
 await page.goto('https://rv.test/view/s0/');await page.locator('#play:enabled').waitFor();
 await page.waitForFunction(()=>document.querySelectorAll('#segmentStrip .segment-block').length===4);await settleLayout(page);
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
  assert.deepEqual(desk.errors,[]);await desk.context.close();

  // Touch: holding shows it and letting go hides it without navigating; moving first is a scroll; a tap navigates.
  const phone=await open(browser,{viewport:{width:390,height:844},hasTouch:true,isMobile:true});p=phone.page;
  const cdp=await phone.context.newCDPSession(p),touch=(type,x,y)=>cdp.send('Input.dispatchTouchEvent',{type,touchPoints:type==='touchEnd'?[]:[{x,y}]});
  b=await block(p,1);const x=b.x+b.width/2,y=b.y+b.height/2;
  await touch('touchStart',x,y);await p.waitForTimeout(200);assert(!(await peek(p)).shown,'not before the hold time');
  await p.waitForTimeout(350);s=await peek(p);assert(s.shown,'a held finger shows the preview');assert.equal(s.label,'구간 1');
  assert(await p.evaluate(()=>!document.getElementById('segmentStrip').querySelector('.segment-block').dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true}))),'no long-press menu on the strip');
  await touch('touchEnd');await p.waitForTimeout(300);
  assert(!(await peek(p)).visible,'letting go hides it');assert(p.url().endsWith('/view/s0/'),'a hold does not navigate');
  await touch('touchStart',x,y);await p.waitForTimeout(60);await touch('touchMove',x+30,y);await p.waitForTimeout(550);
  assert(!(await peek(p)).shown,'moving before the hold time does not show it');await touch('touchEnd');
  await p.locator('#segmentStrip .segment-block').nth(2).tap();await p.waitForURL(/\/view\/s2\/$/);
  assert.deepEqual(phone.errors,[]);await phone.context.close();
  console.log('PASS: segment preview on hover (thumbnail, start time, state, placement, fetched once) and on a touch hold (no navigation, movement cancels, taps still navigate)');
 }finally{await browser.close()}
})().catch(e=>{console.error(e);process.exit(1)});
