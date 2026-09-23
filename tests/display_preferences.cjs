const fs=require('fs'),assert=require('node:assert/strict'),{chromium}=require('playwright');
(async()=>{
 const browser=await chromium.launch({headless:true});
 try{
  const page=await browser.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.route('https://rv.test/**',route=>{
   const p=new URL(route.request().url()).pathname;
   if(p==='/api/logs')return route.fulfill({json:{logs:[]}});
   if(p.endsWith('/data'))return route.fulfill({json:{route:'test',key:'path',duration:2,warnings:[],video:null,frames:[{t:0,id:0,valid:true,position:[[0,0],[10,1],[20,-2]],lanes:[],edges:[],lp:[],es:[],leads:[],liveTracksValid:false}]}});
   const name=p.startsWith('/view/')?'index.html':p.replace('/assets/','');
   return route.fulfill({body:fs.readFileSync('roadviewer/app/web/'+name),contentType:name.endsWith('.js')?'application/javascript':name.endsWith('.css')?'text/css':name.endsWith('.png')?'image/png':name.endsWith('.svg')?'image/svg+xml':'text/html'});
  });
  await page.goto('https://rv.test/view/one/');
  await page.waitForFunction(()=>!document.getElementById('play').disabled);
  assert(await page.locator('#trackLabels').isChecked());
  assert.deepEqual(await page.locator('.target-label-mode input').evaluateAll(inputs=>inputs.map(input=>input.id)),['hideLabels','trackLabels','distanceLabels','yRelLabels','speedLabels','relativeSpeedLabels','liveTrackLabels']);
  assert(await page.locator('#modelPath').isChecked());assert(!(await page.locator('#hideScc').isChecked()));
  await page.evaluate(()=>{const f=data.frames[0];f.liveTracksValid=true;f.liveTracksDeltaMs=0;f.liveTracks=[{trackId:1,x:10,y:0,yRel:0,vRel:0,source:'scc',measured:true},{trackId:2,x:12,y:0,yRel:0,vRel:0,source:'frontRadar',measured:true}];render()});
  assert.equal(await page.locator('#rawRows tr').count(),2);
  await page.locator('#hideScc').check();assert.equal(await page.locator('#rawRows tr').count(),1);
  assert((await page.locator('#rawRows').textContent()).includes('frontRadar'));
  await page.evaluate(()=>{
   window.pathDraws=0;const stroke=ctx.stroke.bind(ctx);
   ctx.stroke=()=>{if(ctx.strokeStyle==='#c4a5ff')window.pathDraws++;stroke()};
  });
  await page.evaluate(()=>render());
  assert((await page.evaluate(()=>window.pathDraws))>0);
  await page.locator('#lanes').uncheck();await page.locator('#liveTrackLabels').check();await page.locator('#yRelLabels').check();
  await page.goto('https://rv.test/view/two/');
  await page.waitForFunction(()=>!document.getElementById('play').disabled);
  assert(await page.locator('#modelPath').isChecked());
  assert(!(await page.locator('#lanes').isChecked()));
  assert(await page.locator('#liveTrackLabels').isChecked());assert(await page.locator('#yRelLabels').isChecked());assert(await page.locator('#hideScc').isChecked());
  await page.locator('#modelPath').uncheck();await page.locator('#hideLabels').check();
  await page.reload();assert(!(await page.locator('#modelPath').isChecked()));assert(await page.locator('#hideLabels').isChecked());
  await page.evaluate(()=>localStorage.setItem('roadviewer-display-preferences','invalid JSON'));
  await page.reload();assert(await page.locator('#modelPath').isChecked());assert(await page.locator('#trackLabels').isChecked());
  assert.deepEqual(errors,[]);console.log('PASS: model path default/drawing, checkbox and label persistence, malformed preference fallback');
 }finally{await browser.close()}
})().catch(e=>{console.error(e);process.exitCode=1});
