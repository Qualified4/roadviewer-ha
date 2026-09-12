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
  assert(await page.locator('#videoOverlay').isHidden());
  await page.locator('#videoOverlayToggle').click();
  assert(await page.locator('#videoOverlay').isVisible());
  const pixels=()=>page.evaluate(()=>{const c=document.getElementById('videoOverlay'),d=c.getContext('2d').getImageData(0,0,c.width,c.height).data;return d.some((v,i)=>i%4===3&&v>0)});
  assert(await pixels());
  await page.locator('#modelPath').uncheck();assert(!(await pixels()));
  await page.evaluate(()=>{data.frames[0].overlay=null;render()});
  assert((await page.locator('#overlayStatus').textContent()).includes('보정'));
  await page.reload();await page.waitForFunction(()=>!document.getElementById('play').disabled);
  assert.equal(await page.locator('#videoOverlayToggle').getAttribute('aria-pressed'),'true');
  assert.deepEqual(errors,[]);console.log('PASS: camera overlay drawing, toggle, layer controls, missing calibration and preference restoration');
 }finally{await browser.close()}
})().catch(e=>{console.error(e);process.exitCode=1});
