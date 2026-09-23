const fs=require('fs'),assert=require('node:assert/strict'),{chromium}=require('playwright');
(async()=>{
 const browser=await chromium.launch({headless:true});
 try{
  const page=await browser.newPage({viewport:{width:390,height:844}}),errors=[];
  page.on('pageerror',e=>errors.push(e.message));
  await page.route('https://rv.test/**',route=>{
   const p=new URL(route.request().url()).pathname;
   if(p==='/api/logs')return route.fulfill({json:{logs:[]}});
   if(p.endsWith('/video'))return route.fulfill({body:fs.readFileSync((process.env.RV_TEST_VIDEO||'/tmp/roadviewer-test.mp4')),contentType:'video/mp4'});
   if(p.endsWith('/data'))return route.fulfill({json:{route:'test',key:'overlay',duration:2,warnings:[],video:{start:0,duration:2},frames:[{t:0,id:0,valid:true,lanes:[],edges:[],lp:[],es:[],leads:[],liveTracksValid:false,overlay:{lanes:[],edges:[],path:[[.5,.6],[.5,.9]],markers:[]}}]}});
   const name=p.startsWith('/view/')?'index.html':p.replace('/assets/','');
   return route.fulfill({body:fs.readFileSync('roadviewer/app/web/'+name),contentType:name.endsWith('.js')?'application/javascript':name.endsWith('.css')?'text/css':name.endsWith('.png')?'image/png':'image/svg+xml'});
  });
  await page.route('https://rv.test/view/one/',route=>route.fulfill({body:fs.readFileSync('roadviewer/app/web/index.html'),contentType:'text/html'}));
  await page.goto('https://rv.test/view/one/');
  await page.waitForFunction(()=>!document.getElementById('play').disabled);

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
   const arrow=await page.locator('#foldHeading svg').boundingBox();
   assert(Math.abs(arrow.x+arrow.width/2-(row.x+row.width/2))<1,'arrow must be centered');
   await page.locator('#foldHeading').click({position:{x:4,y:row.height/2}});
   assert(await page.locator('#logNavigation').isHidden());
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
  await page.evaluate(()=>{const input=document.getElementById('layoutWidth');input.value='80';input.dispatchEvent(new Event('input'))});
  assert.equal(await page.locator('main').evaluate(el=>Math.round(el.getBoundingClientRect().width)),312);
  assert.equal(await page.locator('.playback').evaluate(el=>Math.round(el.getBoundingClientRect().width)),300);
  await page.keyboard.press('Escape');await page.reload();await page.waitForFunction(()=>!document.getElementById('play').disabled);
  assert.equal(await page.locator('#layoutWidth').inputValue(),'80');
  await page.locator('#layoutWidthButton').click();await page.locator('#resetLayoutWidth').click();
  assert.equal(await page.locator('#layoutWidth').inputValue(),'100');await page.keyboard.press('Escape');
  for(const width of [390,2200]){
   await page.setViewportSize({width,height:1000});await page.locator('#layoutWidthButton').click();
   const slider=page.locator('#layoutWidth'),box=await slider.boundingBox();
   const rect=await page.locator('#layoutWidthDialog').boundingBox();assert(rect.x>=0&&rect.x+rect.width<=width);
   await page.mouse.move(box.x+10,box.y+box.height/2);await page.mouse.down();
   for(const fraction of [.1,.5,.9]){
    await page.mouse.move(box.x+box.width*fraction,box.y+box.height/2,{steps:3});
    const current=await slider.boundingBox();for(const key of ['x','y','width','height'])assert(Math.abs(current[key]-box[key])<1,'slider must stay fixed while resizing: '+key);
   }
   await page.mouse.up();assert(Number(await slider.inputValue())>(width<850?95:1700));
   assert.equal(await page.evaluate(mobile=>localStorage.getItem(mobile?'roadviewer-layout-width-mobile':'roadviewer-layout-width'),width<850),await slider.inputValue());
   await page.keyboard.press('Escape');assert(await page.locator('#layoutWidthDialog').isHidden());
   assert(await page.locator('#layoutWidthButton').evaluate(e=>e===document.activeElement));
   assert.equal(await page.evaluate(()=>document.body.style.overflow),'');
  }
  assert.deepEqual(errors,[]);console.log('PASS: collapsed slow scrolling, full-width fold touch target and saved layout width');
 }finally{await browser.close()}
})().catch(e=>{console.error(e);process.exitCode=1});
