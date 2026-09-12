const fs=require('fs'),assert=require('node:assert/strict'),{chromium}=require('playwright');
(async()=>{
 const browser=await chromium.launch({headless:true});
 try{
  for(const width of [390,1280]){
   const page=await browser.newPage({viewport:{width,height:844}}),errors=[];
   page.on('pageerror',e=>errors.push(e.message));
   const logs=[{id:'one',name:'00000356--148eb5e823 / 구간 13',status:'ready'},{id:'two',name:'00000356--148eb5e823 / 구간 12',status:'ready'},{id:'pending',name:'00000356--148eb5e823 / 구간 14',status:'processing'}];
   await page.route('https://rv.test/**',route=>{
    const p=new URL(route.request().url()).pathname;
    if(p==='/api/logs')return route.fulfill({json:{logs}});
    if(p.endsWith('/data'))return route.fulfill({json:{route:'test',key:'test',duration:2,warnings:[],video:null,frames:[{t:0,id:0,valid:false,lanes:[],edges:[],lp:[],es:[],leads:[],liveTracksValid:false}]}});
    const name=p.startsWith('/view/')?'index.html':p.replace('/assets/','');
    return route.fulfill({body:fs.readFileSync('roadviewer/app/web/'+name),contentType:name.endsWith('.js')?'application/javascript':name.endsWith('.css')?'text/css':name.endsWith('.svg')?'image/svg+xml':name.endsWith('.png')?'image/png':'text/html'});
   });
   await page.goto('https://rv.test/view/one/');
   await page.waitForFunction(()=>document.getElementById('logSegmentChoice')?.textContent==='구간 13');
   await page.locator('#speedChoice').click();
   const dialog=page.locator('.rv-choice-dialog');
   assert(await dialog.isVisible());
   assert.equal(await page.getByRole('option',{selected:true}).textContent(),'1×✓');
   const box=await dialog.boundingBox();assert(box.x>=0&&box.x+box.width<=width&&box.y>=0&&box.y+box.height<=844);
   if(width===390)assert(Math.abs(box.y+box.height-836)<2);
   await page.getByRole('option',{name:'4×',exact:true}).click();
   assert.equal(await page.locator('#speed').inputValue(),'4');
   assert.equal(await page.locator('#speedChoice').textContent(),'4×');
   assert(!(await dialog.isVisible()));
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
   await page.waitForFunction(()=>document.getElementById('logSegmentChoice')?.textContent==='구간 12');
   assert.deepEqual(errors,[]);await page.close();
  }
  console.log('PASS: mobile sheet and desktop menu, speed/range changes, keyboard, focus, disabled options and segment navigation');
 }finally{await browser.close()}
})().catch(e=>{console.error(e);process.exitCode=1});
