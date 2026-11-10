const fs=require('fs'),assert=require('node:assert/strict'),{chromium}=require('playwright');
// Dialog, sheet and view transitions animate; measure geometry once they have settled.
const {settleLayout:settle}=require('./browser-helpers.cjs');
(async()=>{
 const browser=await chromium.launch({headless:true});
 try{
  // Exact colours below are the dark screen mode's tokens.
  const page=await browser.newPage({viewport:{width:390,height:844},colorScheme:'dark'}),errors=[];
  page.on('pageerror',e=>errors.push(e.message));
  let pinned=false,pinFailure=false,pinRequests=0;
  const serve=route=>{
   const p=new URL(route.request().url()).pathname;
   if(p.endsWith('/bookmarks'))return route.fulfill({json:{bookmarks:[]}});
   if(p==='/api/logs')return route.fulfill({json:{logs:[{id:'one',name:'00000395--0d0eda17c5 / 구간 7',status:'ready',pinned},{id:'two',name:'00000395--0d0eda17c5 / 구간 8',status:'ready',pinned:false}]}});
   if(p==='/api/logs/one/pin'){
    pinRequests++;assert.equal(route.request().method(),'POST');assert.equal(route.request().headers()['x-roadviewer-request'],'1');
    if(pinFailure)return route.fulfill({status:500,json:{error:'failed'}});
    pinned=route.request().postDataJSON().pinned;return route.fulfill({json:{pinned}});
   }
   if(p.endsWith('/video'))return route.fulfill({body:fs.readFileSync((process.env.RV_TEST_VIDEO||'/tmp/roadviewer-test.mp4')),contentType:'video/mp4'});
   // The replay loads vehicle data in the background for the event track; none here.
   if(p.endsWith('/telemetry'))return route.fulfill({status:404,json:{error:'차량 정보 없음'}});
   if(p.endsWith('/data'))return route.fulfill({json:{route:'test',key:'overlay',duration:2,warnings:[],video:{start:0,duration:2},frames:[{t:0,id:0,valid:true,lanes:[],edges:[],lp:[],es:[],leads:[],liveTracksValid:false,overlay:{lanes:[],edges:[],path:[[.5,.6],[.5,.9]],markers:[]}}]}});
   const name=p.startsWith('/view/')?'index.html':p.replace('/assets/','');
   return route.fulfill({body:fs.readFileSync('roadviewer/app/web/'+name),contentType:name.endsWith('.js')?'application/javascript':name.endsWith('.css')?'text/css':name.endsWith('.png')?'image/png':'image/svg+xml'});
  };
  await page.route('https://rv.test/**',serve);
  await page.route('https://rv.test/view/one/',route=>route.fulfill({body:fs.readFileSync('roadviewer/app/web/index.html'),contentType:'text/html'}));
  await page.goto('https://rv.test/view/one/');
  await page.waitForFunction(()=>!document.getElementById('play').disabled);
  // The frame takes the video's aspect ratio once its metadata arrives; let that resize (and the renders it triggers) settle.
  await page.waitForFunction(()=>document.getElementById('video').readyState>=1);await page.waitForTimeout(500);

  // A compact phone must keep navigation clear of the HUD. Also test coarse pointers: their 44px targets
  // used to overlap even when the mouse layout fitted. Capture both themes with generated test data only.
  const narrow=await browser.newPage({viewport:{width:320,height:844},hasTouch:true,isMobile:true});
  await narrow.route('https://rv.test/**',serve);
  await narrow.route('https://rv.test/view/one/',route=>route.fulfill({body:fs.readFileSync('roadviewer/app/web/index.html'),contentType:'text/html'}));
  await narrow.goto('https://rv.test/view/one/');await narrow.locator('#play:enabled').waitFor();
  for(const theme of ['dark','light']){
   await narrow.emulateMedia({colorScheme:theme});await narrow.reload();await narrow.locator('#play:enabled').waitFor();
   await narrow.waitForFunction(()=>document.getElementById('video').readyState>=1);
   await narrow.evaluate(()=>{data.frames[0].egoSpeedKph=123.4;render()});
   for(const width of [320,360,390]){
   await narrow.setViewportSize({width,height:844});await settle(narrow);
   const boxes=await narrow.locator('#nextLog,.video-hud,#play,#prev,#next,#bookmarkOpen,#speedChoice').evaluateAll(es=>es.map(e=>{const r=e.getBoundingClientRect();return {id:e.id||e.className,l:r.left,r:r.right,t:r.top,b:r.bottom,w:r.width,h:r.height}}));
   const overlap=(a,b)=>Math.min(a.r,b.r)-Math.max(a.l,b.l)>.5&&Math.min(a.b,b.b)-Math.max(a.t,b.t)>.5;
   assert(!overlap(boxes[0],boxes[1]),'navigation and HUD do not overlap '+width+' '+theme+': '+JSON.stringify(boxes.slice(0,2)));
   const corner=await narrow.evaluate(()=>{
    const rect=selector=>{const r=document.querySelector(selector).getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom}};
    return {title:rect('.video-title'),stage:rect('#videoStage'),speed:rect('.ego-speed'),wheel:rect('#steeringStatus')};
   });
   assert(Math.abs(corner.title.top-corner.stage.top-8)<=1,'navigation stays at the top left '+width);
   if(width<360){
    assert(corner.wheel.top>=corner.speed.bottom,'wheel sits below speed at 320px');
    assert(Math.abs(corner.stage.right-corner.speed.right-8)<=1,'speed aligns with the right inset at 320px');
   }else assert(corner.wheel.left>=corner.speed.right-1,'wider screens keep the wheel beside the speed '+width);
   const buttons=boxes.slice(2);for(let i=0;i<buttons.length;i++)for(let j=i+1;j<buttons.length;j++)assert(!overlap(buttons[i],buttons[j]),'transport buttons do not overlap '+width+' '+theme+': '+JSON.stringify([buttons[i],buttons[j]]));
   assert(buttons.every(b=>b.w>=(width<360?43.5:39.5)&&b.h>=39.5),'touch targets (44px below 360px; the 360px design keeps 40px bookmark/speed) '+width);
   if(process.env.RV_AUDIT_SHOTS){fs.mkdirSync(process.env.RV_AUDIT_SHOTS,{recursive:true});await narrow.screenshot({path:require('path').join(process.env.RV_AUDIT_SHOTS,`replay-${theme}-${width}.png`)})}
   }
  }
  await narrow.close();

  // No video-derived glow behind the card; the transport bar follows the page theme.
  assert.equal(await page.locator('#videoAmbient,.ambient-clip').count(),0,'no ambient glow');
  assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'no horizontal overflow at 390px');
  // HUD: the speed is plain white figures with the wheel's dark edge (no pill); the wheel sits to its right, raised to the top.
  assert.equal(await page.locator('.video-hud .glass,.video-hud.glass').count(),0,'no glass in the speed/wheel corner');
  assert.equal(await page.locator('#steeringLabel').count(),0,'no visible steering label');
  const hud=await page.evaluate(()=>{const speed=document.querySelector('.video-hud .ego-speed'),box=speed.getBoundingClientRect(),status=document.getElementById('steeringStatus'),ring=status.getBoundingClientRect(),wheel=document.getElementById('steeringIcon').getBoundingClientRect(),s=getComputedStyle(speed),stage=document.getElementById('videoStage').getBoundingClientRect(),fs=document.getElementById('fullscreenButton').getBoundingClientRect(),title=document.querySelector('.video-title').getBoundingClientRect(),tools=document.querySelector('.video-tools').getBoundingClientRect();
   return {right:ring.left>=box.right-1,top:ring.top<=box.top+1,edge:Math.abs(stage.right-ring.right),centred:Math.abs((wheel.left+wheel.right)/2-(ring.left+ring.right)/2),bg:getComputedStyle(status).backgroundColor,ring:getComputedStyle(status,'::before').visibility,
    speedBg:s.backgroundColor,speedText:getComputedStyle(document.getElementById('egoSpeed')).color,shadow:s.textShadow,
    title:title.top-stage.top<=16&&title.left-stage.left<=16,tools:stage.bottom-tools.bottom<=16&&tools.left-stage.left<=16,
    circle:Math.abs(fs.width-fs.height)<.5&&getComputedStyle(document.getElementById('fullscreenButton')).borderTopLeftRadius==='50%'}});
  assert(hud.right,'wheel sits right of the speed');assert(hud.top,'wheel is raised to the top');assert(hud.edge<=16,'wheel at the right edge');assert(hud.centred<=1,'wheel is centred in its ring');
  assert.equal(hud.bg,'rgba(0, 0, 0, 0)');assert.equal(hud.ring,'hidden','no ring behind the wheel normally');
  assert.equal(hud.speedBg,'rgba(0, 0, 0, 0)','speed has no background');assert.equal(hud.speedText,'rgb(242, 244, 246)','white speed in both themes');assert.match(hud.shadow,/rgba\(0, 0, 0/,'dark edge like the wheel');
  assert(hud.title,'title group (with 이전/다음 on phones) at the top left of the video');assert(hud.tools,'camera and overlay chips at the bottom left');
  if(await page.locator('#fullscreenButton').isVisible())assert(hud.circle,'fullscreen button is a circle');
  const badge=page.locator('#steeringBadge');
  const steer=async steering=>{await page.evaluate(s=>{const f={...data.frames[0],steering:s};renderSteering(f)},steering);return {hidden:await badge.isHidden(),label:await page.locator('#steeringIcon').getAttribute('aria-label'),title:await page.locator('#steeringStatus').getAttribute('title')}};
  let state=await steer({state:'active',active:true,pressed:false,angle:2,torque:.2,color:[0,255,0]});
  assert(state.hidden,'no badge while steering control runs');assert.match(state.label,/^조향 제어 중/);assert.equal(state.title,state.label);
  state=await steer({state:'driver',active:true,pressed:true,angle:2,torque:.2,color:[255,255,255]});
  assert(!state.hidden,'intervention badge shows');assert.equal((await badge.textContent()).trim(),'개입');assert.equal(await badge.getAttribute('aria-hidden'),'true','state is read from the icon name');
  // Intervention: a takeover-coloured glass ring appears behind the wheel; "개입" sits on its bottom edge like a legend.
  const ring=await page.evaluate(()=>{const st=document.getElementById('steeringStatus'),r=st.getBoundingClientRect(),b=document.getElementById('steeringBadge').getBoundingClientRect(),c=getComputedStyle(st,'::before');return {visible:c.visibility,radius:c.borderTopLeftRadius,ring:c.borderTopColor,filter:c.backdropFilter,legend:Math.abs((b.top+b.bottom)/2-r.bottom),centre:Math.abs((b.left+b.right)/2-(r.left+r.right)/2),round:Math.abs(r.width-r.height)}});
  assert.equal(ring.visible,'visible');assert.equal(ring.radius,'50%');assert.equal(ring.ring,'rgb(255, 159, 90)');assert.match(ring.filter,/blur/);assert(ring.round<.5,'ring is a circle');
  assert(ring.legend<=1&&ring.centre<=1,'legend is centred on the ring bottom edge');
  assert.match(state.label,/^운전자 조향 개입/);assert.match(state.title,/^운전자 조향 개입/);
  const look=await badge.evaluate(e=>({weight:getComputedStyle(e).fontWeight,bg:getComputedStyle(e).backgroundColor,color:getComputedStyle(e).color,radius:getComputedStyle(e).borderTopLeftRadius,animation:getComputedStyle(e.parentElement,'::before').animationName}));
  assert.equal(look.weight,'700');assert.equal(look.bg,'rgb(194, 65, 12)');assert.equal(look.color,'rgb(255, 255, 255)');assert.equal(look.radius,'999px','legend is a pill');assert.equal(look.animation,'rv-takeover-pulse','the ring pulses');
  await page.emulateMedia({reducedMotion:'reduce'});assert.equal(await badge.evaluate(e=>getComputedStyle(e.parentElement,'::before').animationName),'none','reduced motion stops the pulse');await page.emulateMedia({reducedMotion:'no-preference'});
  state=await steer({state:'driver',active:false,pressed:true,angle:2,torque:null,color:[255,255,255]});assert(state.hidden,'manual driving without steering control is not an intervention');
  state=await steer({state:'inactive',active:false,pressed:false,angle:0,torque:.1,color:[230,230,230]});assert(state.hidden);assert.match(state.label,/^조향 제어 꺼짐/);
  await page.evaluate(()=>render());
  assert.equal(await page.locator('.road-legend').evaluate(e=>e.open),false,'the detailed map legend starts folded');
  // Map: only the followed lead (selected) gets the ellipse halo; model leads and other targets are glyph only. The legend explains it.
  const halos=await page.evaluate(()=>{const f=data.frames[idx],saved={leads:f.leads,selected:f.selected},calls=[],orig=ctx.ellipse;ctx.ellipse=function(...a){calls.push(a);return orig.apply(this,a)};
   const count=(leads,selected)=>{f.leads=leads;f.selected=selected;calls.length=0;render();return calls.length};
   try{const lead={x:30,y:0,p:.9,v:20,a:0};return {models:count([lead,{...lead,x:50,y:1}],null),followed:count([lead],{x:30,y:0,radar:true,vRel:0,trackId:1})}}finally{ctx.ellipse=orig;Object.assign(f,saved);render()}});
  assert.equal(halos.models,0,'model leads have no halo');assert(halos.followed>0,'the followed lead has a halo');
  assert.match(await page.locator('.road-legend .map-color-key').textContent(),/타원: 추종 중인 앞차/);

  const pin=page.locator('#pinLog');await pin.waitFor();
  await page.waitForFunction(()=>!document.getElementById('pinLog').disabled);
  assert.equal(await pin.getAttribute('aria-pressed'),'false');
  await pin.click();await page.waitForFunction(()=>document.getElementById('pinLog').getAttribute('aria-pressed')==='true');
  assert.equal(await pin.getAttribute('aria-label'),'구간 고정 해제');
  await page.reload();await page.waitForFunction(()=>!document.getElementById('pinLog').disabled);
  assert.equal(await pin.getAttribute('aria-pressed'),'true','pin persists after reload');
  pinFailure=true;await pin.click();await page.locator('#error').waitFor();
  assert.equal(await pin.getAttribute('aria-pressed'),'true','failed save preserves pin');
  await page.waitForFunction(()=>!document.getElementById('pinLog').disabled);
  pinFailure=false;await pin.click();await page.waitForFunction(()=>document.getElementById('pinLog').getAttribute('aria-pressed')==='false');
  assert.equal(pinRequests,3);await page.reload();await page.waitForFunction(()=>!document.getElementById('play').disabled);

  // The ⋯ (or, on wider screens, 보기) menu opens a view setting; the layout-width dialog sits behind both.
  const openWidthDialog=async()=>{
   const menu=await page.locator('#viewMenu').isVisible()?'#viewMenu':'#replayDownload';
   await page.locator(menu+'>summary').click();await page.locator('#layoutWidthButton').click();
   await page.locator('#layoutWidthDialog[open]').waitFor();return menu;
  };
  for(const width of [320,360,390]){
   await page.setViewportSize({width,height:844});
   // Phone app bar: back, the one-line date/drive, pin and ⋯ share one row inside the screen; 보기 lives in ⋯. The title is on the video.
   const bar=await page.locator('.app-bar').boundingBox(),boxes={};
   for(const selector of ['.back','#pinLog','#replayDownload>summary'])boxes[selector]=await page.locator(selector).boundingBox();
   assert(Object.values(boxes).every(b=>b.x>=0&&b.x+b.width<=width&&b.y>=bar.y&&b.y+b.height<=bar.y+bar.height),'app bar controls fit at '+width);
   assert(await page.locator('#viewMenu').isHidden(),'보기 moves into ⋯ on phones');
   assert(bar.height<=56,'one-line phone app bar: '+bar.height);
   const rects=await page.locator('#play,#prev,#next,#bookmarkOpen,#speedChoice,#time').evaluateAll(els=>els.map(e=>{const r=e.getBoundingClientRect();return {id:e.id,top:r.top,bottom:r.bottom,left:r.left,right:r.right}}));
   const at=id=>rects.find(r=>r.id===id);
   const middle=r=>(r.top+r.bottom)/2;
   assert(rects.filter(r=>width>=360||r.id!=='time').every(r=>Math.abs(middle(r)-middle(at('play')))<14),'playback controls share a row at '+width);
   assert(rects.every(r=>r.left>=0&&r.right<=width),'controls remain inside viewport');
   const seek=await page.locator('#seek').boundingBox(),time=await page.locator('#time').boundingBox();
   assert(time.y>=seek.y+seek.height,'time sits below seek');
   // B6: time · 북마크 on the left, play at the exact centre with the ◀|▶ pill tucked under its right half, 속도 at the right edge.
   const order=width>=360?['time','bookmarkOpen','play','prev','next','speedChoice']:['play','prev','next','time','bookmarkOpen','speedChoice'];
   order.slice(1).forEach((id,i)=>assert(at(order[i]).right<=at(id).left+.5,`${order[i]} sits left of ${id} at ${width}: ${JSON.stringify(rects)}`));
   const row=await page.evaluate(()=>{const s=e=>getComputedStyle(e),q=id=>document.getElementById(id),pill=document.querySelector('.frame-step'),bar=document.querySelector('.playback').getBoundingClientRect();
    const soft=[q('bookmarkOpen'),q('speedChoice')];
    const play=q('play').getBoundingClientRect(),box=pill.getBoundingClientRect(),cs=getComputedStyle(document.querySelector('.playback'));
    const content={left:bar.left+parseFloat(cs.paddingLeft)+parseFloat(cs.borderLeftWidth),right:bar.right-parseFloat(cs.paddingRight)-parseFloat(cs.borderRightWidth)};
    const under=document.elementFromPoint(box.left+4,(box.top+box.bottom)/2);
    return {centre:(play.left+play.right)/2-(bar.left+bar.right)/2,play:play.height,tuck:box.left>play.left+play.width/2-1&&box.left<play.right-4,playOnTop:q('play').contains(under),
     pill:box.height,pillRadius:s(pill).borderRadius,speedEdge:content.right-q('speedChoice').getBoundingClientRect().right,playEdges:s(q('play')).borderTopWidth,grouped:pill.contains(q('prev'))&&pill.contains(q('next'))&&!!pill.querySelector('.frame-step-sep'),
     heights:soft.map(e=>e.getBoundingClientRect().height),fills:soft.map(e=>s(e).backgroundColor),edges:soft.map(e=>s(e).borderTopWidth+' '+s(e).boxShadow),
     fits:[...q('time').children].every(c=>c.scrollWidth<=c.clientWidth),time:q('time').innerText.trim(),label:q('time').getAttribute('aria-label'),title:q('time').title,frameBelow:q('frame').getBoundingClientRect().top>=q('time').getBoundingClientRect().bottom-1}});
   if(width>=360)assert(Math.abs(row.centre)<=1,'play is centred on the bar at '+width+': '+row.centre);
   assert(Math.abs(row.play-(width>360?52:44))<1,'play size at '+width+': '+row.play);
   if(width>=360)assert(row.tuck&&row.playOnTop,'the frame pill starts under the right half of play, play on top: '+JSON.stringify(row));
   assert(row.grouped&&Math.abs(row.pill-44)<.5&&row.pillRadius===(width>=360?'0px 22px 22px 0px':'22px'),'frame steps share one 44px pill, rounded on the right, with a divider');
   assert(Math.abs(row.speedEdge)<1,'speed sits at the right edge: '+row.speedEdge);
   assert(row.heights.every(h=>Math.abs(h-(width>=360?40:44))<.5),'bookmark and speed keep their targets: '+row.heights);
   assert.equal(row.playEdges,'0px','play has no border');
   const pillLook=await page.locator('.frame-step').evaluate(e=>{const c=getComputedStyle(e);return [c.backgroundColor,c.borderTopWidth,c.boxShadow]});
   assert.deepEqual(pillLook,[row.fills[0],'0px','none'],'the pill shares the soft fill without edges');
   assert(new Set(row.fills).size===1&&!/rgba\(0, 0, 0, 0\)/.test(row.fills[0]),'secondary controls share the soft fill: '+row.fills);
   assert(row.edges.every(e=>e==='0px none'),'secondary controls have no borders or shadows: '+row.edges);
   assert(row.fits,'the time is not cut off at '+width);
   assert.match(row.time,/^[0-9]+:[0-9]{2}[.][0-9]{2}$/,'time shows only the current time');
   assert(row.label===row.title&&/^[0-9]+:[0-9]{2}[.][0-9]{2} \/ [0-9]+:[0-9]{2}[.][0-9]{2} · 눌러서 전체 길이 표시\/숨기기$/.test(row.label),'full current / total time stays in the label and tooltip: '+row.label);
   if(width>360)assert(row.frameBelow,'FRAME sits under the time');
   assert((await page.locator('.playback').boundingBox()).height<150,'compact transport bar');
   // Video is full-bleed; the transport bar floats at the bottom of the screen, inset from the edges.
   // The bar's entrance spring may still be running: measure where it comes to rest.
   await page.evaluate(()=>Promise.all(document.querySelector('.playback').getAnimations().map(a=>a.finished.catch(()=>{}))));
   const video=await page.locator('.video-wrap').boundingBox(),transport=await page.locator('.playback').boundingBox();
   assert(Math.abs(video.x)<1&&Math.abs(video.width-width)<1,'full-bleed video');
   assert.equal(await page.locator('.playback').evaluate(e=>getComputedStyle(e).position),'fixed');
   assert(Math.abs(transport.y+transport.height-(844-8))<1&&Math.abs(transport.x-8)<1&&Math.abs(transport.width-(width-16))<1,'transport floats at the bottom on phones '+JSON.stringify(transport));
  }
  // The time is a quiet toggle: current time by default, the total length (muted) after a tap, in the same width; the choice persists.
  for(const width of [390,1440]){
   await page.setViewportSize({width,height:844});
   await page.evaluate(()=>{try{localStorage.removeItem('roadviewer-time-total')}catch{}});await page.reload();await page.waitForFunction(()=>!document.getElementById('play').disabled);
   await page.evaluate(()=>setTime(1.25));
   const time=page.locator('#time'),state=async()=>({text:await time.evaluate(e=>e.innerText.trim()),pressed:await time.getAttribute('aria-pressed'),label:await time.getAttribute('aria-label'),title:await time.getAttribute('title'),tag:await time.evaluate(e=>e.tagName),width:await time.evaluate(e=>e.getBoundingClientRect().width),stored:await page.evaluate(()=>localStorage.getItem('roadviewer-time-total'))});
   const label='0:01.25 / 0:02.00 · 눌러서 전체 길이 표시/숨기기';
   const a=await state();
   assert.deepEqual([a.text,a.pressed,a.label,a.title,a.tag,a.stored],['0:01.25','false',label,label,'BUTTON',null],'default shows the current time only at '+width);
   assert.deepEqual(await time.evaluate(e=>{const c=getComputedStyle(e);return [c.backgroundColor,c.borderTopWidth,c.boxShadow]}),['rgba(0, 0, 0, 0)','0px','none'],'time toggle looks like plain text');
   await time.click();const b=await state();
   assert.deepEqual([b.text,b.pressed,b.label,b.stored],['0:02.00','true',label,'1'],'tap swaps to the total length only at '+width);
   assert.equal(b.width,a.width,'the time keeps its width when swapped at '+width);
   assert.notEqual(await time.locator('.time-total').evaluate(e=>getComputedStyle(e).color),await time.locator('.time-now').evaluate(e=>getComputedStyle(e).color),'the total is muted');
   await page.evaluate(()=>setTime(1.5));assert.equal(await time.evaluate(e=>e.innerText.trim()),'0:02.00','the total stays while time moves');
   await page.reload();await page.waitForFunction(()=>!document.getElementById('play').disabled);await page.evaluate(()=>setTime(1.25));
   const c=await state();assert.deepEqual([c.text,c.pressed],['0:02.00','true'],'the choice persists after reload');
   await time.click();const d=await state();
   assert.deepEqual([d.text,d.pressed,d.stored],['0:01.25','false',null],'tap again returns to the current time');
   assert.equal(d.width,a.width,'width is stable across toggles');
   // Playing through time and frame changes (short and long frame numbers, the 구간 끝 note, both toggle states) never moves 북마크,
   // and FRAME stays visible on phones wider than 360px.
   if(width<720){
    const xs=await page.evaluate(async()=>{const out=[],q=id=>document.getElementById(id),probe=()=>({x:q('bookmarkOpen').getBoundingClientRect().left,frame:getComputedStyle(q('frame')).visibility==='visible'&&q('frame').getBoundingClientRect().width>0,text:q('frame').textContent});
     const ids=data.frames.map(f=>f.id);
     for(const [time,id] of [[0,7],[.5,88],[1,1234],[1.5,9],[data.duration,4321]]){data.frames.forEach(f=>f.id=id);setTime(time);await new Promise(r=>requestAnimationFrame(r));out.push(probe());q('time').click();await new Promise(r=>requestAnimationFrame(r));out.push(probe());q('time').click()}
     data.frames.forEach((f,i)=>f.id=ids[i]);setTime(0);return out});
    assert(xs.every(p=>Math.abs(p.x-xs[0].x)<.5),'북마크 never moves: '+JSON.stringify(xs.map(p=>p.x)));
    assert(xs.filter((p,i)=>i<8).every(p=>p.frame),'FRAME stays visible while playing: '+JSON.stringify(xs));
   }
   // A focused time button keeps the global shortcuts out of the way, like other buttons.
   await time.focus();const before=await page.evaluate(()=>t);await page.keyboard.press('ArrowRight');assert.equal(await page.evaluate(()=>t),before,'arrow keys do not step while the time button is focused');
   await page.evaluate(()=>document.activeElement.blur());
  }
  await page.setViewportSize({width:390,height:844});
  await page.locator('#replayDownload>summary').click();
  assert.match(await page.locator('#replayDownloadMenu .menu-version .app-version').textContent(),/^v[0-9]+[.][0-9]+[.][0-9]+$/,'version is an info line in ⋯');
  await page.locator('#replayDownloadMenu #splitView').waitFor({timeout:2000});  // 보기 choices are in ⋯ on phones (the menu grows in).
  await page.keyboard.press('Escape');
  // The app bar stays at the top; the video stays in view: right under it on phones, 12px under it beside the analysis.
  // The retired heading fold leaves its old key harmless.
  await page.evaluate(()=>localStorage.setItem('roadviewer-heading-collapsed','true'));
  for(const [width,height] of [[390,844],[1440,844]]){
   await page.setViewportSize({width,height});await page.reload();await page.waitForFunction(()=>!document.getElementById('play').disabled);
   await page.evaluate(()=>{document.getElementById('roadView').style.minHeight='2400px';scrollTo(0,0)});
   const video=await page.locator('.camera-panel').boundingBox();
   await page.evaluate(()=>scrollTo(0,400));await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
   const bar=await page.locator('.app-bar').boundingBox();
   assert(Math.abs(bar.y)<1,'app bar sticks to the top at '+width);
   assert(await page.locator('#logNavigation').isVisible()&&await page.locator('#pinLog').isVisible(),'no folded navigation');
   const stuck=await page.locator('.camera-panel').boundingBox();
   if(width<720){
    // Stacked phones: the card slides 40% under the app bar and the video fills the rest, right under the bar.
    const shown=await page.locator('#videoStage').boundingBox(),full=await page.evaluate(()=>parseFloat(document.querySelector('.replay-page').style.getPropertyValue('--video-full-h')));
    assert(Math.abs(shown.y-(bar.y+bar.height))<1.5,'phone video stays under the app bar: '+JSON.stringify([shown,bar]));
    assert(Math.abs(shown.height-full*.6)<1.5,'scrolled past the collapse range, the video keeps 60% of its height: '+JSON.stringify([shown.height,full]));
    await page.evaluate(()=>scrollTo(0,20));await page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));
    const partial=await page.locator('#videoStage').boundingBox();
    assert(Math.abs(partial.height-(full-20))<1.5,'the video height follows the scroll position pixel for pixel: '+JSON.stringify([partial.height,full]));
    await page.evaluate(()=>scrollTo(0,400));await page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));
   }
   else assert(Math.abs(stuck.y-(bar.y+bar.height+12))<1.5,'desktop video stays beside the scrolling analysis: '+JSON.stringify([stuck,bar]));
   await page.evaluate(()=>{document.getElementById('roadView').style.minHeight='';scrollTo(0,0)});
  }
  // The transport bar floats at the bottom as a glass pane, as wide as the page content; at the end of the page nothing
  // hides behind it, and choosers opened from it (speed) open upward inside the screen.
  for(const [width,height] of [[390,844],[900,700],[1440,844]]){
   await page.setViewportSize({width,height});await settle(page);
   const r=await page.evaluate(async()=>{
    scrollTo(0,document.documentElement.scrollHeight);await new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done)));
    const p=document.querySelector('.playback'),bar=p.getBoundingClientRect(),main=document.querySelector('main'),cs=getComputedStyle(main),box=main.getBoundingClientRect(),s=getComputedStyle(p);
    const ends=[...document.querySelectorAll('.road-panel,.camera-panel')].filter(e=>e.getBoundingClientRect().height).map(e=>e.getBoundingClientRect().bottom);
    return {pos:s.position,bottom:innerHeight-bar.bottom,left:bar.left-(box.left+parseFloat(cs.paddingLeft)),right:box.right-parseFloat(cs.paddingRight)-bar.right,end:Math.max(...ends),top:bar.top,radius:s.borderTopLeftRadius,filter:s.backdropFilter,glass:p.classList.contains('glass-panel')};
   });
   assert.equal(r.pos,'fixed','transport bar is fixed at '+width);assert(r.glass&&/^blur\(20px\) saturate\(1\.7\) brightness\((0\.55|1\.12)\)$/.test(r.filter),'transport bar is glass: '+r.filter);assert.equal(r.radius,'18px');
   if(width>=720){assert(Math.abs(r.bottom-14)<1,'floats 14px above the bottom: '+r.bottom);assert(Math.abs(r.left)<1&&Math.abs(r.right)<1,'aligned to the page content at '+width)}
   else assert(Math.abs(r.bottom-8)<1,'floats 8px above the bottom on phones');
   assert(r.end<=r.top-8,`the end of the page stays clear of the bar at ${width}: ${r.end} > ${r.top}`);
   await page.locator('#speedChoice').click();const sheet=page.locator('.rv-choice-dialog[open]');await sheet.waitFor();await settle(page,'.rv-choice-dialog[open]');
   const pop=await sheet.boundingBox(),trigger=await page.locator('#speedChoice').boundingBox();
   assert(pop.y>=0&&pop.y+pop.height<=height+.5,'speed chooser stays in the viewport at '+width);
   if(width>600)assert(pop.y+pop.height<=trigger.y+.5,'speed chooser opens upward from the bar at '+width);
   await page.keyboard.press('Escape');await sheet.waitFor({state:'hidden'});
   await page.evaluate(()=>scrollTo(0,0));
  }
  await page.setViewportSize({width:1440,height:844});
  await page.evaluate(()=>{const input=document.getElementById('layoutWidth');input.value='920';input.dispatchEvent(new Event('input'))});
  assert.equal(await page.locator('main').evaluate(el=>Math.round(el.getBoundingClientRect().width)),920);
  assert.equal(await page.locator('.app-bar-inner').evaluate(el=>Math.round(el.getBoundingClientRect().width)),920,'app bar content follows the width');
  await page.reload();await page.waitForFunction(()=>!document.getElementById('play').disabled);
  assert.equal(await page.locator('#layoutWidth').inputValue(),'920');
  assert.equal(await openWidthDialog(),'#viewMenu');
  assert.equal(await page.evaluate(()=>document.getElementById('viewMenu').open),false,'the menu closes behind the dialog');
  await page.locator('#resetLayoutWidth').click();
  assert.equal(await page.locator('#layoutWidth').inputValue(),'1420');
  await page.locator('#layoutWidthClose').click();
  // radarState / liveTracks tables: folded sections sized by their rows, scrolling with sticky headers when long.
  for(const width of [390,1440]){
   await page.setViewportSize({width,height:844});
   if(width===390)assert.equal(await page.locator('details.radar-values[open]').count(),0,'tables start folded');
   await page.locator('details.radar-values').evaluateAll(all=>all.forEach(d=>{d.open=false}));
   for(const summary of await page.locator('details.radar-values>summary').all())await summary.click();
   assert.equal(await page.locator('details.radar-values[open]').count(),2,'tables open from their headings');
   for(const count of [0,3,10,25]){
    await page.evaluate(count=>{
     setTime(0);const f=data.frames[0];f.liveTracksValid=true;f.liveTracksDeltaMs=0;
     f.radarTargets=Array.from({length:count},(_,i)=>({group:'center',index:i,x:i+10,y:0,yRel:0,vRel:0,radar:true,trackId:i}));
     f.liveTracks=f.radarTargets.map(v=>({...v,measured:true,source:'radar',trackState:'tracked'}));render();
    },count);
    for(const table of await page.locator('.radar-values>.table-scroll').all()){
     const size=await table.evaluate(e=>({client:e.clientHeight,scroll:e.scrollHeight,rows:e.querySelectorAll('tbody tr').length}));
     assert(size.client<=420,'tables never exceed their cap');
     if(count<=3)assert(size.client<=(size.rows+1)*44+8,'no empty space below short tables');
     if(count===25){
      assert(size.scroll>size.client);
      await table.evaluate(e=>e.scrollTop=120);
      assert(await table.evaluate(e=>Math.abs(e.querySelector('th').getBoundingClientRect().top-e.getBoundingClientRect().top)<2),'column headers should stay at the top');
     }
    }
   }
   await page.locator('details.radar-values').evaluateAll(all=>all.forEach(d=>{d.open=false}));
  }
  await page.setViewportSize({width:390,height:1000});
  assert.equal(await openWidthDialog(),'#replayDownload');
  await page.evaluate(()=>{const input=document.getElementById('layoutWidth');input.value='50';input.dispatchEvent(new Event('input'))});
  assert.equal(await page.locator('main').evaluate(el=>Math.round(el.getBoundingClientRect().width)),195);
  assert.equal(await page.locator('.camera-panel').evaluate(el=>Math.round(el.getBoundingClientRect().width)),195);
  await page.keyboard.press('Escape');await page.reload();await page.waitForFunction(()=>!document.getElementById('play').disabled);
  assert.equal(await page.locator('#layoutWidth').inputValue(),'50');
  await openWidthDialog();await page.locator('#resetLayoutWidth').click();
  assert.equal(await page.locator('#layoutWidth').inputValue(),'100');await page.keyboard.press('Escape');
  await page.setViewportSize({width:1024,height:1000});
  await page.waitForFunction(()=>document.getElementById('layoutWidth').min==='320');
  assert.equal(await page.locator('#layoutWidth').getAttribute('max'),'1280');
  await page.evaluate(()=>{const input=document.getElementById('layoutWidth');input.value='320';input.dispatchEvent(new Event('input'))});
  assert.equal(await page.locator('main').evaluate(el=>Math.round(el.getBoundingClientRect().width)),320);
  await page.reload();await page.waitForFunction(()=>!document.getElementById('play').disabled);
  assert.equal(await page.locator('#layoutWidth').inputValue(),'320');
  await page.setViewportSize({width:768,height:1000});
  assert.equal(await page.locator('#layoutWidth').inputValue(),'320');
  await page.setViewportSize({width:390,height:1000});
  await page.waitForFunction(()=>document.getElementById('layoutWidth').value==='100');
  for(const width of [390,1024,2200]){
   await page.setViewportSize({width,height:1000});const menu=await openWidthDialog();await settle(page);
   const slider=page.locator('#layoutWidth'),box=await slider.boundingBox();
   const rect=await page.locator('#layoutWidthDialog').boundingBox();assert(rect.x>=0&&rect.x+rect.width<=width);
   await page.mouse.move(box.x+10,box.y+box.height/2);await page.mouse.down();
   for(const fraction of [.1,.5,.9]){
    await page.mouse.move(box.x+box.width*fraction,box.y+box.height/2,{steps:3});
    const current=await slider.boundingBox();for(const key of ['x','y','width','height'])assert(Math.abs(current[key]-box[key])<1,'slider must stay fixed while resizing: '+key);
   }
   await page.mouse.up();assert(Number(await slider.inputValue())>(width<=600?90:width<=1280?1150:1700));
   assert.equal(await page.evaluate(()=>localStorage.getItem(widthProfile().key)),await slider.inputValue());
   await page.keyboard.press('Escape');await page.waitForFunction(()=>!document.getElementById('layoutWidthDialog').open&&document.body.style.overflow==='');
   await page.locator('#layoutWidthDialog').waitFor({state:'hidden'});
   assert(await page.locator(menu+'>summary').evaluate(e=>e===document.activeElement),'focus returns to the menu button');
   assert.equal(await page.evaluate(()=>document.body.style.overflow),'');
  }
  // The app bar's content lines up with the page content at every saved width.
  for(const [width,value] of [[390,50],[768,320],[850,500],[1024,600],[1440,920]]){
   await page.setViewportSize({width,height:1000});
   await page.evaluate(value=>{syncLayoutWidth();layoutWidth.value=String(value);layoutWidth.dispatchEvent(new Event('input'))},value);
   const edges=await page.evaluate(()=>{const bar=document.querySelector('.app-bar-inner').getBoundingClientRect(),main=document.querySelector('main').getBoundingClientRect();return {bar:[bar.left,bar.right],main:[main.left,main.right]}});
   if(width>600)assert(Math.abs(edges.bar[0]-edges.main[0])<1&&Math.abs(edges.bar[1]-edges.main[1])<1,'app bar aligns with content at '+width+' / '+value);
   else assert(edges.bar[0]<=edges.main[0]+1&&edges.bar[1]>=edges.main[1]-1,'phone app bar spans the content');
  }
  const touch=await browser.newPage({viewport:{width:390,height:844},hasTouch:true,isMobile:true,colorScheme:'dark'});
  touch.on('pageerror',e=>errors.push(e.message));
  await touch.route('https://rv.test/**',serve);
  await touch.route('https://rv.test/view/one/',route=>route.fulfill({body:fs.readFileSync('roadviewer/app/web/index.html'),contentType:'text/html'}));
  await touch.goto('https://rv.test/view/one/');await touch.waitForFunction(()=>!document.getElementById('play').disabled);
  for(const width of [320,360,390,768]){
   await touch.setViewportSize({width,height:844});
   for(const expected of [true,false]){
    await touch.locator('#pinLog').tap();
    await touch.waitForFunction(expected=>{const b=document.getElementById('pinLog');return !b.disabled&&b.getAttribute('aria-pressed')===String(expected)},expected);
    await touch.waitForFunction(expected=>getComputedStyle(document.getElementById('pinLog'),'::before').opacity===(expected?'1':'0'),expected,{timeout:2000});
    const appearance=await touch.locator('#pinLog').evaluate(e=>{const fill=getComputedStyle(e,'::before');return {color:getComputedStyle(e).color,background:getComputedStyle(e).backgroundColor,fill:+fill.opacity?fill.backgroundColor:'none',tap:getComputedStyle(e).webkitTapHighlightColor}});
    assert.equal(appearance.color,expected?'rgb(245, 196, 81)':'rgb(154, 160, 169)','touch release reflects saved pin state');
    // The pinned fill is a layer that ripples in from the press (style.css/motion.css); the button keeps no hover background.
    assert.deepEqual([appearance.background,appearance.fill],['rgba(0, 0, 0, 0)',expected?'rgba(245, 196, 81, 0.12)':'none'],'touch must not retain hover background');
    assert.equal(appearance.tap,'rgba(0, 0, 0, 0)');
    // The pin button itself shows the state; the title line carries no 고정 chip (it took the tags' room).
    assert.equal(await touch.locator('.app-subtitle .pin-badge').count(),0);
   }
   // Touch targets: at least 44px on coarse pointers.
   for(const selector of ['.back','#pinLog','#replayDownload>summary','#play','#prev','#next','#bookmarkOpen','#speedChoice','#videoOverlayToggle','#overlayHeightSettings','#roadTab','#telemetryTab','#bookmarkTab','#layerMenu>summary',...(width>=720?['#previousLog','#nextLog','#viewMenu>summary']:['#previousLog','#nextLog'])]){
    const box=await touch.locator(selector).boundingBox();
    // The 360px design keeps its centred row with 40px-wide bookmark/speed (44px tall); narrower phones get 44px.
    const minWidth=width===360&&['#bookmarkOpen','#speedChoice'].includes(selector)?40:44;
    assert(box.width>=minWidth-.5&&box.height>=44-.5,`${selector} is a ${minWidth}px touch target at ${width} (${box.width}x${box.height})`);
   }
   // The text-sized time toggle gets a 44px-tall hit area from a pseudo-element.
   const hit=await touch.evaluate(()=>{const e=document.getElementById('time'),r=e.getBoundingClientRect(),a=getComputedStyle(e,'::after'),top=r.top+parseFloat(a.top),bottom=r.bottom-parseFloat(a.bottom),x=r.left+Math.min(10,r.width/2);return {height:bottom-top,ends:[top+1,bottom-1].map(y=>document.elementFromPoint(x,y)===e)}});
   // 360px keeps its existing centred row, where the time's hit area stays as it was (about 39px tall).
   if(width!==360)assert(hit.height>=44-.5&&hit.ends.every(Boolean),'time toggle has a 44px touch target at '+width+': '+JSON.stringify(hit));
  }
  await touch.close();
  assert.deepEqual(errors,[]);console.log('PASS: replay pin persistence and failure recovery, compact phone app bar and transport, sticky app bar/video, view settings in menus, tables without empty space, touch targets and saved layout width');
 }finally{await browser.close()}
})().catch(e=>{console.error(e);process.exitCode=1});
