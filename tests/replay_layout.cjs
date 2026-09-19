const fs=require('fs'),assert=require('node:assert/strict'),{chromium}=require('playwright');
(async()=>{
 const browser=await chromium.launch({headless:true});
 try{
  const page=await browser.newPage({viewport:{width:390,height:844}}),errors=[];
  page.on('pageerror',e=>errors.push(e.message));
  await page.route('https://rv.test/**',route=>{
   const p=new URL(route.request().url()).pathname;
   if(p==='/api/logs')return route.fulfill({json:{logs:[]}});
   if(p.endsWith('/video'))return route.fulfill({body:fs.readFileSync('/tmp/roadviewer-test.mp4'),contentType:'video/mp4'});
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
   for(let y=0;y<=220;y+=4){
    await page.evaluate(y=>scrollTo(0,y),y);
    await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
    assert(Math.abs(await page.evaluate(()=>scrollY)-y)<1,'scroll must not jump at '+y);
    const stuck=await page.locator('.replay-heading').evaluate(el=>el.classList.contains('is-stuck'));
    assert.equal(await page.locator('#logNavigation').isHidden(),stuck);
    assert.equal(await page.locator('#foldHeading').isVisible(),stuck);
   }
   assert(await page.locator('.replay-heading').evaluate(el=>el.classList.contains('is-stuck')));
   await page.locator('#foldHeading').click();
   assert(await page.locator('#logNavigation').isVisible());
   assert(Math.abs(await page.evaluate(()=>scrollY)-220)<1,'expanding must not shift scroll');
  }
  await page.evaluate(()=>{const input=document.getElementById('layoutWidth');input.value='920';input.dispatchEvent(new Event('input'))});
  assert.equal(await page.locator('main').evaluate(el=>Math.round(el.getBoundingClientRect().width)),920);
  assert.equal(await page.locator('.playback').evaluate(el=>Math.round(el.getBoundingClientRect().width)),880);
  await page.reload();await page.waitForFunction(()=>!document.getElementById('play').disabled);
  assert.equal(await page.locator('#layoutWidth').inputValue(),'920');
  await page.locator('#resetLayoutWidth').click();
  assert.equal(await page.locator('#layoutWidth').inputValue(),'1420');
  assert.deepEqual(errors,[]);console.log('PASS: collapsed slow scrolling, full-width fold touch target and saved layout width');
 }finally{await browser.close()}
})().catch(e=>{console.error(e);process.exitCode=1});
