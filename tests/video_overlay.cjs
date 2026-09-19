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
  await page.evaluate(()=>{data.frames[0].leads=[{x:20,y:0,p:1}];data.frames[0].overlay.markers=[{kind:'model',index:0,point:[.5,.8],raised:[.5,.5]}];document.getElementById('hideLabels').checked=true;render()});
  assert(await pixels());
  const alphaAt=y=>page.evaluate(y=>{const c=document.getElementById('videoOverlay');return c.getContext('2d').getImageData(Math.floor(c.width*.5),Math.floor((c.height-c.width*90/160)/2+c.width*90/160*y),1,1).data[3]},y);
  assert(await alphaAt(.65)>0,'raised marker must connect to ground');
  await page.locator('#overlayHeight').click();
  assert.equal(await alphaAt(.65),0,'ground mode has no vertical stem');

  await page.evaluate(()=>{data.frames[0].overlay=null;render()});
  assert((await page.locator('#overlayStatus').textContent()).includes('보정'));
  await page.reload();await page.waitForFunction(()=>!document.getElementById('play').disabled);
  assert.equal(await page.locator('#videoOverlayToggle').getAttribute('aria-pressed'),'true');
  assert.equal(await page.locator('#overlayHeight').getAttribute('aria-pressed'),'false');
  await page.waitForFunction(()=>document.getElementById('video').videoWidth>0);
  await page.evaluate(()=>{document.getElementById('modelPath').checked=true;render()});
  for(const viewport of [390,2200]){
   await page.setViewportSize({width:viewport,height:1000});
   for(const mode of ['auto','split','stack'])for(const width of [720,1920,920,1920]){
    await page.evaluate(({mode,width})=>{setReplayLayout(mode);const input=document.getElementById('layoutWidth');input.value=width;input.dispatchEvent(new Event('input'))},{mode,width});
    await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
    const result=await page.evaluate(()=>{
     const v=document.getElementById('video'),c=document.getElementById('videoOverlay'),box=v.parentElement.getBoundingClientRect(),vr=v.getBoundingClientRect(),cr=c.getBoundingClientRect();
     const same=[vr,cr].every(r=>['x','y','width','height'].every(k=>Math.abs(r[k]-box[k])<1));
     const ratio=Math.min(vr.width/v.videoWidth,vr.height/v.videoHeight),vw=v.videoWidth*ratio,vh=v.videoHeight*ratio;
     const px=(vr.x-cr.x+vr.width/2)*c.width/cr.width,py=(vr.y-cr.y+(vr.height-vh)/2+vh*.75)*c.height/cr.height;
     return {same,bottom:vr.bottom<=document.querySelector('.overlay-tools').getBoundingClientRect().top+1,ink:c.getContext('2d').getImageData(Math.floor(px),Math.floor(py),1,1).data[3]>0};
    });
    assert(result.same,`video and overlay bounds must match: ${viewport}/${mode}/${width}`);
    assert(result.bottom,'video must not overlap the controls below');
    assert(result.ink,'projected path must align with the contained video after resizing');
   }
  }
  assert.deepEqual(errors,[]);console.log('PASS: camera overlay drawing, toggle, layer controls, missing calibration and preference restoration');
 }finally{await browser.close()}
})().catch(e=>{console.error(e);process.exitCode=1});
