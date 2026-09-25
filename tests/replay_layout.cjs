const fs=require('fs'),assert=require('node:assert/strict'),{chromium}=require('playwright');
(async()=>{
 const browser=await chromium.launch({headless:true});
 try{
  const page=await browser.newPage({viewport:{width:390,height:844}}),errors=[];
  page.on('pageerror',e=>errors.push(e.message));
  let pinned=false,pinFailure=false,pinRequests=0;
  const serve=route=>{
   const p=new URL(route.request().url()).pathname;
   if(p==='/api/logs')return route.fulfill({json:{logs:[{id:'one',name:'00000395--0d0eda17c5 / 구간 7',status:'ready',pinned},{id:'two',name:'00000395--0d0eda17c5 / 구간 8',status:'ready',pinned:false}]}});
   if(p==='/api/logs/one/pin'){
    pinRequests++;assert.equal(route.request().method(),'POST');assert.equal(route.request().headers()['x-roadviewer-request'],'1');
    if(pinFailure)return route.fulfill({status:500,json:{error:'failed'}});
    pinned=route.request().postDataJSON().pinned;return route.fulfill({json:{pinned}});
   }
   if(p.endsWith('/video'))return route.fulfill({body:fs.readFileSync((process.env.RV_TEST_VIDEO||'/tmp/roadviewer-test.mp4')),contentType:'video/mp4'});
   if(p.endsWith('/data'))return route.fulfill({json:{route:'test',key:'overlay',duration:2,warnings:[],video:{start:0,duration:2},frames:[{t:0,id:0,valid:true,lanes:[],edges:[],lp:[],es:[],leads:[],liveTracksValid:false,overlay:{lanes:[],edges:[],path:[[.5,.6],[.5,.9]],markers:[]}}]}});
   const name=p.startsWith('/view/')?'index.html':p.replace('/assets/','');
   return route.fulfill({body:fs.readFileSync('roadviewer/app/web/'+name),contentType:name.endsWith('.js')?'application/javascript':name.endsWith('.css')?'text/css':name.endsWith('.png')?'image/png':'image/svg+xml'});
  };
  await page.route('https://rv.test/**',serve);
  await page.route('https://rv.test/view/one/',route=>route.fulfill({body:fs.readFileSync('roadviewer/app/web/index.html'),contentType:'text/html'}));
  await page.goto('https://rv.test/view/one/');
  await page.waitForFunction(()=>!document.getElementById('play').disabled);

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

  for(const width of [320,360,390]){
   await page.setViewportSize({width,height:844});
   const pinBox=await pin.boundingBox(),pickerBox=await page.locator('#logSegmentChoice').boundingBox();
   assert(pinBox.x>=pickerBox.x+pickerBox.width&&Math.abs(pinBox.y-pickerBox.y)<2,'pin stays beside segment dropdown');
   assert(pinBox.x+pinBox.width<=width,'pin fits narrow phone');
   const rects=await page.locator('#play,#prev,#next,#speedChoice').evaluateAll(els=>els.map(e=>{const r=e.getBoundingClientRect();return {top:r.top,left:r.left,right:r.right}}));
   assert(rects.every(r=>Math.abs(r.top-rects[0].top)<2),'playback controls and speed share a row at '+width);
   assert(rects.every(r=>r.left>=0&&r.right<=width),'controls remain inside viewport');
   const seek=await page.locator('#seek').boundingBox(),time=await page.locator('#time').boundingBox();
   assert(time.y>=seek.y+seek.height,'time sits below seek');
   assert((await page.locator('.playback').boundingBox()).height<130,'compact playback bar');
   assert.match(await page.locator('.eyebrow .app-version').textContent(),/^v[0-9]+[.][0-9]+[.][0-9]+$/);
  }
  for(const width of [390,1440]){
   await page.setViewportSize({width,height:844});
   await page.evaluate(()=>scrollTo(0,0));
   await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
   assert(await page.locator('#foldHeading').isHidden(),'fold control must be hidden at page top');
   assert(await page.locator('#logNavigation').isVisible());
   await page.evaluate(()=>scrollTo(0,220));
   await page.waitForFunction(()=>!document.getElementById('foldHeading').hidden);
   if(await page.locator('#foldHeading').getAttribute('aria-expanded')==='false')await page.locator('#foldHeading').click();
   const fold=await page.locator('#foldHeading').boundingBox(),row=await page.locator('.replay-heading .route').boundingBox();
   for(const dimension of ['x','y','width','height'])assert(Math.abs(fold[dimension]-row[dimension])<1,'fold must overlay row: '+dimension);
   await page.locator('#foldHeading').hover();
   assert.equal(await page.locator('#foldHeading').evaluate(e=>getComputedStyle(e).backgroundColor),'rgba(0, 0, 0, 0)','mouse hover must not cover the title row');
   const arrow=await page.locator('#foldHeading svg').boundingBox();
   assert(Math.abs(arrow.x+arrow.width/2-(row.x+row.width/2))<1,'arrow must be centered');
   await page.locator('#foldHeading').click({position:{x:4,y:row.height/2}});
   assert(await page.locator('#logNavigation').isHidden());
   const compact=await page.locator('.replay-heading').evaluate(el=>el.getBoundingClientRect().bottom-el.querySelector('.route').getBoundingClientRect().top);
   assert(compact<=28,'collapsed title and bottom padding stay compact');
   assert(Math.abs(await page.evaluate(()=>scrollY)-220)<1,'collapse must not shift scroll');
   // Return to the top with a remembered fold state, then cross the sticky boundary slowly.
   for(const y of [...Array.from({length:56},(_,i)=>i*4),...Array.from({length:56},(_,i)=>220-i*4),220]){
    await page.evaluate(y=>scrollTo(0,y),y);
    await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
    assert(Math.abs(await page.evaluate(()=>scrollY)-y)<1,'scroll must not jump at '+y);
    const stuck=await page.locator('.replay-heading').evaluate(el=>el.classList.contains('is-stuck'));
    assert.equal(await page.locator('#logNavigation').isHidden(),stuck);
    assert.equal(await page.locator('#foldHeading').isVisible(),stuck);
    const geometry=await page.evaluate(()=>{const heading=document.querySelector('.replay-heading'),route=heading.querySelector('.route');return {title:route.getBoundingClientRect().top,expected:Math.max(10,document.querySelector('.heading-anchor').getBoundingClientRect().top+route.offsetTop),navBottom:document.getElementById('logNavigation').getBoundingClientRect().bottom}});
    assert(Math.abs(geometry.title-geometry.expected)<1,'collapsed title must slide continuously into its sticky position');
    if(stuck)assert(geometry.navBottom<=0,'navigation must already be above the screen when hidden');
   }
   assert(await page.locator('.replay-heading').evaluate(el=>el.classList.contains('is-stuck')));
   await page.reload();await page.waitForFunction(()=>!document.getElementById('play').disabled);
   await page.evaluate(()=>scrollTo(0,220));await page.waitForFunction(()=>document.querySelector('.replay-heading').classList.contains('is-stuck'));
   assert.equal(await page.locator('#foldHeading').getAttribute('aria-expanded'),'false','collapsed state must survive reload');
   await page.locator('#foldHeading').click();
   assert.equal(await page.evaluate(()=>localStorage.getItem('roadviewer-heading-collapsed')),'false');
   assert(await page.locator('#logNavigation').isVisible());
   assert(Math.abs((await page.locator('#logNavigation').boundingBox()).y-10)<1,'expanded bar sticks by navigation');
   assert(Math.abs(await page.evaluate(()=>scrollY)-220)<1,'expanding must not shift scroll');
  }
  await page.setViewportSize({width:1440,height:844});
  await page.evaluate(()=>{const input=document.getElementById('layoutWidth');input.value='920';input.dispatchEvent(new Event('input'))});
  assert.equal(await page.locator('main').evaluate(el=>Math.round(el.getBoundingClientRect().width)),920);
  assert.equal(await page.locator('.playback').evaluate(el=>Math.round(el.getBoundingClientRect().width)),880);
  await page.reload();await page.waitForFunction(()=>!document.getElementById('play').disabled);
  assert.equal(await page.locator('#layoutWidth').inputValue(),'920');
  await page.locator('#layoutWidthButton').click();
  await page.locator('#resetLayoutWidth').click();
  assert.equal(await page.locator('#layoutWidth').inputValue(),'1420');
  await page.locator('#layoutWidthClose').click();
  for(const width of [390,1440]){
   await page.setViewportSize({width,height:844});
   for(const count of [0,3,10,25]){
    await page.evaluate(count=>{
     setTime(0);const f=data.frames[0];f.liveTracksValid=true;f.liveTracksDeltaMs=0;
     f.radarTargets=Array.from({length:count},(_,i)=>({group:'center',index:i,x:i+10,y:0,yRel:0,vRel:0,radar:true,trackId:i}));
     f.liveTracks=f.radarTargets.map(v=>({...v,measured:true,source:'radar',trackState:'tracked'}));render();
    },count);
    for(const table of await page.locator('.radar-values>.table-scroll').all()){
     assert.equal(await table.evaluate(e=>e.clientHeight),456,'table height must stay fixed as targets change');
     if(count===10)assert(await table.evaluate(e=>e.scrollHeight<=e.clientHeight),'ten rows should fit');
     if(count===25){
      assert(await table.evaluate(e=>e.scrollHeight>e.clientHeight));
      await table.evaluate(e=>e.scrollTop=120);
      assert(await table.evaluate(e=>Math.abs(e.querySelector('th').getBoundingClientRect().top-e.getBoundingClientRect().top)<2),'column headers should stay at the top');
     }
    }
   }
  }
  await page.setViewportSize({width:390,height:1000});await page.locator('#layoutWidthButton').click();
  await page.evaluate(()=>{const input=document.getElementById('layoutWidth');input.value='50';input.dispatchEvent(new Event('input'))});
  assert.equal(await page.locator('main').evaluate(el=>Math.round(el.getBoundingClientRect().width)),195);
  assert.equal(await page.locator('.playback').evaluate(el=>Math.round(el.getBoundingClientRect().width)),183);
  await page.keyboard.press('Escape');await page.reload();await page.waitForFunction(()=>!document.getElementById('play').disabled);
  assert.equal(await page.locator('#layoutWidth').inputValue(),'50');
  await page.locator('#layoutWidthButton').click();await page.locator('#resetLayoutWidth').click();
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
   await page.setViewportSize({width,height:1000});await page.locator('#layoutWidthButton').click();
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
   assert(await page.locator('#layoutWidthDialog').isHidden());
   assert(await page.locator('#layoutWidthButton').evaluate(e=>e===document.activeElement));
   assert.equal(await page.evaluate(()=>document.body.style.overflow),'');
  }
  for(const [width,value] of [[390,50],[768,320],[850,500],[1024,600],[1440,920]]){
   await page.setViewportSize({width,height:1000});
   await page.evaluate(value=>{syncLayoutWidth();layoutWidth.value=String(value);layoutWidth.dispatchEvent(new Event('input'));scrollTo(0,250)},value);
   await page.waitForFunction(()=>document.querySelector('.replay-heading').classList.contains('is-stuck'));
   const edges=await page.evaluate(()=>{
    const heading=document.querySelector('.replay-heading'),r=heading.getBoundingClientRect(),before=getComputedStyle(heading,'::before'),bottom=document.querySelector('.playback').getBoundingClientRect();
    return {left:r.left+parseFloat(before.left),right:r.right-parseFloat(before.right),bottomLeft:bottom.left,bottomRight:bottom.right};
   });
   assert(Math.abs(edges.left-edges.bottomLeft)<1&&Math.abs(edges.right-edges.bottomRight)<1,'sticky backgrounds align at '+width+' / '+value);
  }
  const touch=await browser.newPage({viewport:{width:390,height:844},hasTouch:true});
  touch.on('pageerror',e=>errors.push(e.message));
  await touch.route('https://rv.test/**',serve);
  await touch.route('https://rv.test/view/one/',route=>route.fulfill({body:fs.readFileSync('roadviewer/app/web/index.html'),contentType:'text/html'}));
  await touch.goto('https://rv.test/view/one/');await touch.waitForFunction(()=>!document.getElementById('play').disabled);
  for(const width of [390,768]){
   await touch.setViewportSize({width,height:844});await touch.evaluate(()=>scrollTo(0,220));
   await touch.waitForFunction(()=>!document.getElementById('foldHeading').hidden);
   assert(await touch.evaluate(()=>matchMedia('(hover: none)').matches));
   for(let i=0;i<4;i++){
    await touch.locator('#foldHeading').tap();
    const appearance=await touch.locator('#foldHeading').evaluate(e=>({background:getComputedStyle(e).backgroundColor,tap:getComputedStyle(e).webkitTapHighlightColor}));
    assert.equal(appearance.background,'rgba(0, 0, 0, 0)','touch must not leave a background at '+width);
    assert.equal(appearance.tap,'rgba(0, 0, 0, 0)');
    assert(await touch.locator('#routeName').isVisible());assert(await touch.locator('#details').isVisible());
   }
  }
  await touch.close();
  assert.deepEqual(errors,[]);console.log('PASS: replay pin persistence and failure recovery, compact collapsed heading, slow scrolling and saved layout width');
 }finally{await browser.close()}
})().catch(e=>{console.error(e);process.exitCode=1});
