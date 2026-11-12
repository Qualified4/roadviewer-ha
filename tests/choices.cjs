const fs=require('fs'),assert=require('node:assert/strict'),{chromium}=require('playwright');
// Dialog, sheet and view transitions animate; measure geometry once they have settled.
const {settleLayout:settle}=require('./browser-helpers.cjs');
(async()=>{
 const browser=await chromium.launch({headless:true});
 try{
  for(const width of [390,1280]){
   const page=await browser.newPage({viewport:{width,height:844}}),errors=[];
   page.on('pageerror',e=>errors.push(e.message));
   const logs=[{id:'one',name:'00000356--148eb5e823 / 구간 13',status:'ready'},{id:'two',name:'00000356--148eb5e823 / 구간 12',status:'ready'},{id:'pending',name:'00000356--148eb5e823 / 구간 14',status:'processing'}];
   await page.route('https://rv.test/**',route=>{
    const p=new URL(route.request().url()).pathname;
   if(p.endsWith('/bookmarks'))return route.fulfill({json:{bookmarks:[]}});
    if(p==='/api/logs')return route.fulfill({json:{logs}});
    // The replay loads vehicle data in the background for the event track; none here.
    if(p.endsWith('/telemetry'))return route.fulfill({status:404,json:{error:'차량 정보 없음'}});
    if(p.endsWith('/data'))return route.fulfill({json:{route:'test',key:'test',duration:2,warnings:[],video:null,frames:[{t:0,id:0,valid:false,lanes:[],edges:[],lp:[],es:[],leads:[],liveTracksValid:false}]}});
    const name=p.startsWith('/view/')?'index.html':p.replace('/assets/','');
    return route.fulfill({body:fs.readFileSync('roadviewer/app/web/'+name),contentType:name.endsWith('.js')?'application/javascript':name.endsWith('.css')?'text/css':name.endsWith('.svg')?'image/svg+xml':name.endsWith('.png')?'image/png':'text/html'});
   });
   await page.goto('https://rv.test/view/one/');
   // The app bar title is the segment chooser: route, segment and its place among the route's segments.
   await page.waitForFunction(()=>document.getElementById('titleText')?.textContent==='주행 356 · 구간 13');
   assert.equal(await page.locator('#titleCount').textContent(),' (2/3)');assert(await page.locator('#logSegmentChoice').isEnabled());
   // With the route's start time the title says 출발; with only the upload time it says 업로드 (tooltip has the full time).
   const started=1762415160.25,uploaded=started+86400,clock=t=>new Date(t*1000).toLocaleTimeString('ko-KR',{hour:'numeric',minute:'2-digit'}),date=t=>new Date(t*1000).toLocaleDateString('ko-KR',{month:'long',day:'numeric',weekday:'short'});
   logs[0].started_at=uploaded+86400;logs[1].uploaded=uploaded;
   for(const known of [true,false]){
    if(known)logs[1].started_at=started;else delete logs[1].started_at;
    await page.evaluate(()=>loadLogNavigation());
    const when=known?started:uploaded;
    assert.equal(await page.locator('#titleText').textContent(),(known?clock(when)+' 출발':'업로드 '+clock(when))+' · 구간 13','the first segment supplies the route time, even when another segment is active');
    // The tooltip uses the browser locale, which may differ from Node's OS locale on Windows.
    const full=await page.evaluate(t=>new Date(t*1000).toLocaleString(),when);
    assert.equal(await page.locator('#titleText').getAttribute('title'),(known?'출발 ':'업로드 ')+full);
    assert.equal(await page.locator('#titleDate').textContent(),date(when));
    assert.equal(await page.locator('#titleCount').textContent(),' (2/3)');
   }
   delete logs[0].started_at;delete logs[1].uploaded;
   await page.evaluate(()=>loadLogNavigation());
   await page.locator('#speedChoice').click();
   const dialog=page.locator('.rv-choice-dialog');
   assert(await dialog.isVisible());
   if(width===1280){
    assert.equal(await dialog.getAttribute('data-placement'),'above');
    // Menu motion (M2): fade 120 ms linear, grow from .8 over 150 ms with deceleration, out of the bottom edge under the button.
    const entry=await dialog.evaluate(d=>({grow:d.getAnimations().filter(a=>a.transitionProperty==='transform').map(a=>[a.effect.getKeyframes()[0].transform,a.effect.getTiming().duration,a.effect.getTiming().easing]),
     fade:d.getAnimations().filter(a=>a.transitionProperty==='opacity').map(a=>[a.effect.getTiming().duration,a.effect.getTiming().easing]),origin:d.style.transformOrigin}));
    assert(entry.grow.some(([t,duration,easing])=>/scale\(0\.8\)|matrix\(0\.8, 0, 0, 0\.8/.test(t)&&duration===150&&easing==='cubic-bezier(0, 0, 0.2, 1)'),'menu grows from .8: '+JSON.stringify(entry));
    assert(entry.fade.some(([duration,easing])=>duration===120&&easing==='linear'),'menu fades in over 120 ms: '+JSON.stringify(entry));
    assert.match(entry.origin,/^[0-9]+px 100%$/,'upward menu grows from its bottom edge');
   }
   assert.equal(await page.getByRole('option',{selected:true}).textContent(),'1×✓');
   await settle(page);const box=await dialog.boundingBox();assert(box.x>=0&&box.x+box.width<=width&&box.y>=0&&box.y+box.height<=844);
   if(width===390)assert(Math.abs(box.y+box.height-836)<2);
   await page.getByRole('option',{name:'4×',exact:true}).click();
   assert.equal(await page.locator('#speed').inputValue(),'4');
   assert.equal(await page.locator('#speedChoice').textContent(),'4×');
   await dialog.waitFor({state:'hidden'});
   await page.locator('#rangeChoice').click();
   await page.keyboard.press('End');await page.keyboard.press('Enter');
   assert.equal(await page.locator('#range').inputValue(),'80');
   await page.locator('#rangeChoice').click();await page.keyboard.press('Escape');
   await page.waitForFunction(()=>!document.querySelector('.rv-choice-dialog').open);
   assert.equal(await page.evaluate(()=>document.activeElement.id),'rangeChoice');
   assert.equal(await page.evaluate(()=>document.body.style.overflow),'');
   await page.locator('#logSegmentChoice').click();
   assert(await page.getByRole('option',{name:'구간 14 · 준비 중'}).isDisabled());
   await page.getByRole('option',{name:'구간 12',exact:true}).click();
   await page.waitForURL('**/view/two/');
   await page.waitForFunction(()=>document.getElementById('titleText')?.textContent==='주행 356 · 구간 12');
   // The segment strip under the video navigates the same way.
   assert.equal(await page.locator('#segmentStrip .segment-block').count(),3);assert.equal(await page.locator('#segmentStrip [aria-current=true]').getAttribute('aria-label'),'구간 12 · 재생 중');
   assert(await page.locator('#segmentStrip [aria-label="구간 14 · 준비 중"]').isDisabled());
   await page.locator('#segmentStrip [aria-label="구간 13"]').click();await page.waitForURL('**/view/one/');
   await page.waitForFunction(()=>document.getElementById('titleText')?.textContent==='주행 356 · 구간 13');
   assert.deepEqual(errors,[]);await page.close();
  }
  // The log list failing for a moment (the app restarting): the title shows the replay data's name meanwhile, and the
  // list is asked again until it answers (then the segment count, the strip and the neighbours appear).
  {const page=await browser.newPage({viewport:{width:1280,height:844}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
   const logs=[{id:'one',name:'00000356--148eb5e823 / 구간 13',status:'ready'},{id:'two',name:'00000356--148eb5e823 / 구간 12',status:'ready'}];let asked=0;
   await page.route('https://rv.test/**',route=>{
    const p=new URL(route.request().url()).pathname;
    if(p.endsWith('/bookmarks'))return route.fulfill({json:{bookmarks:[]}});
    if(p==='/api/logs')return ++asked<=2?route.fulfill({status:502,body:'Bad Gateway'}):route.fulfill({json:{logs}});
    if(p.endsWith('/telemetry'))return route.fulfill({status:404,json:{error:'차량 정보 없음'}});
    if(p.endsWith('/data'))return route.fulfill({json:{route:'00000356--148eb5e823 / 구간 13',key:'test',duration:2,warnings:[],video:null,frames:[{t:0,id:0,valid:false,lanes:[],edges:[],lp:[],es:[],leads:[],liveTracksValid:false}]}});
    const name=p.startsWith('/view/')?'index.html':p.replace('/assets/','');
    return route.fulfill({body:fs.readFileSync('roadviewer/app/web/'+name),contentType:name.endsWith('.js')?'application/javascript':name.endsWith('.css')?'text/css':name.endsWith('.svg')?'image/svg+xml':name.endsWith('.png')?'image/png':'text/html'});
   });
   await page.goto('https://rv.test/view/one/');
   await page.waitForFunction(()=>document.getElementById('titleText')?.textContent==='주행 356 · 구간 13');
   assert.equal(await page.locator('#titleCount').textContent(),'','no list yet: no count');assert(await page.locator('#previousLog').isDisabled());
   await page.waitForFunction(()=>document.getElementById('titleCount').textContent===' (2/2)',null,{timeout:8000});
   assert.equal(asked,3,'asked again until it answered');assert.equal(await page.locator('#segmentStrip .segment-block').count(),2);
   assert(await page.locator('#nextLog').isEnabled()||await page.locator('#previousLog').isEnabled(),'a neighbour to go to');
   assert.deepEqual(errors,[]);await page.close()}
  // 보기 › 재생: 끝나면 다음 구간 재생 (off by default) and 구간을 옮기면 일시정지 (on by default), kept on this browser.
  {const page=await browser.newPage({viewport:{width:1280,height:844}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
   const logs=[{id:'one',name:'00000356--148eb5e823 / 구간 13',status:'ready'},{id:'two',name:'00000356--148eb5e823 / 구간 12',status:'ready'},{id:'pending',name:'00000356--148eb5e823 / 구간 14',status:'processing'},{id:'far',name:'00000356--148eb5e823 / 구간 15',status:'ready'}];
   await page.route('https://rv.test/**',route=>{
    const p=new URL(route.request().url()).pathname;
    if(p.endsWith('/bookmarks'))return route.fulfill({json:{bookmarks:[]}});
    if(p==='/api/logs')return route.fulfill({json:{logs}});
    if(p.endsWith('/telemetry'))return route.fulfill({status:404,json:{error:'차량 정보 없음'}});
    if(p.endsWith('/data'))return route.fulfill({json:{route:'test',key:'test',duration:1,warnings:[],video:null,frames:[{t:0,id:0,valid:false,lanes:[],edges:[],lp:[],es:[],leads:[],liveTracksValid:false}]}});
    const name=p.startsWith('/view/')?'index.html':p.replace('/assets/','');
    return route.fulfill({body:fs.readFileSync('roadviewer/app/web/'+name),contentType:name.endsWith('.js')?'application/javascript':name.endsWith('.css')?'text/css':name.endsWith('.svg')?'image/svg+xml':name.endsWith('.png')?'image/png':'text/html'});
   });
   const ready=()=>page.waitForFunction(()=>typeof data!=='undefined'&&data&&!loading&&document.getElementById('titleCount').textContent!=='');
   await page.goto('https://rv.test/view/two/');await ready();
   assert.equal(await page.locator('#autoNext').getAttribute('aria-pressed'),'false');assert.equal(await page.locator('#pauseOnJump').getAttribute('aria-pressed'),'true');
   // Defaults: moving while playing pauses; the end of a segment stops there.
   await page.evaluate(()=>toggle());await page.locator('#segmentStrip [aria-label="구간 13"]').click();await page.waitForURL('**/view/one/');await ready();await page.waitForTimeout(200);
   assert.equal(await page.evaluate(()=>playing),false,'a move pauses by default');
   await page.evaluate(()=>toggle());await page.waitForFunction(()=>!playing&&t>=data.duration);await page.waitForTimeout(300);assert(page.url().endsWith('/view/one/'),'the end stops by default');
   // 구간을 옮기면 일시정지 off: a move made while playing plays on; one made while paused stays paused.
   await page.locator('#viewMenu>summary').click();await page.locator('#pauseOnJump').click();
   assert.equal(await page.locator('#pauseOnJump').getAttribute('aria-pressed'),'false');assert(await page.locator('#viewMenu').evaluate(d=>d.open),'the menu stays open for the switches');
   await page.locator('#viewMenu>summary').click();
   await page.locator('#segmentStrip [aria-label="구간 12"]').click();await page.waitForURL('**/view/two/');await ready();await page.waitForTimeout(200);
   assert.equal(await page.evaluate(()=>playing),false,'paused before the move: paused after it');
   assert.equal(await page.locator('#pauseOnJump').getAttribute('aria-pressed'),'false','kept on this browser');
   await page.evaluate(()=>{setTime(0);toggle()});await page.locator('#segmentStrip [aria-label="구간 13"]').click();await page.waitForURL('**/view/one/');await ready();
   await page.waitForFunction(()=>playing||t>0);
   // 끝나면 다음 구간 재생: the next playable segment of the drive (구간 14 is still converting: skipped), playing; the
   // drive's last segment stops at its end.
   await page.waitForFunction(()=>!playing&&t>=data.duration);
   await page.locator('#viewMenu>summary').click();await page.locator('#autoNext').click();assert.equal(await page.locator('#autoNext').getAttribute('aria-pressed'),'true');await page.locator('#viewMenu>summary').click();
   await page.evaluate(()=>toggle());await page.waitForURL('**/view/far/',{timeout:8000});await ready();
   await page.waitForFunction(()=>playing||t>0);
   await page.waitForFunction(()=>!playing&&t>=data.duration);await page.waitForTimeout(400);assert(page.url().endsWith('/view/far/'),'the last segment stops');
   // The video ending first (a moment before the log's clock, as after a pause) is playing to the end too.
   await page.goto('https://rv.test/view/two/');await ready();
   await page.evaluate(()=>{data.video={start:0,duration:data.duration,frames:20};playing=true;pendingVideoSeek=null;v.onended()});await page.waitForURL('**/view/one/',{timeout:8000});
   // Seeking to the end does not move on.
   await page.goto('https://rv.test/view/two/');await ready();await page.evaluate(()=>setTime(data.duration));await page.waitForTimeout(400);assert(page.url().endsWith('/view/two/'));
   assert.deepEqual(errors,[]);await page.close()}
  console.log('PASS: mobile sheet and desktop menu, speed/range changes, keyboard, focus, disabled options and segment navigation');
 }finally{await browser.close()}
})().catch(e=>{console.error(e);process.exitCode=1});
