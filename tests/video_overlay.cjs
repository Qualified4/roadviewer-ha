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
  await page.evaluate(()=>{data.frames[0].leads=[{x:20,y:0,p:1}];data.frames[0].overlay.markers=[{kind:'model',index:0,point:[.5,.8],projection:[.5,.8,1]}];data.frames[0].overlay.heightDirection=[0,-1,0];document.getElementById('hideLabels').checked=true;render()});
  assert(await pixels());
  const alphaAt=y=>page.evaluate(y=>{const c=document.getElementById('videoOverlay');return c.getContext('2d').getImageData(Math.floor(c.width*.5),Math.floor((c.height-c.width*90/160)/2+c.width*90/160*y),1,1).data[3]},y);
  assert(await alphaAt(.65)>0,'raised marker must connect to ground');
  await page.locator('#overlayHeight').click();
  assert.equal(await alphaAt(.65),0,'ground mode has no vertical stem');

  await page.locator('#overlayHeight').click();
  await page.locator('#overlayHeightSettings').click();
  assert(await page.locator('#overlayHeightDialog').isVisible());
  const setHeight=async cm=>page.locator('#overlayHeightRange').evaluate((e,cm)=>{e.value=cm;e.dispatchEvent(new Event('input'))},cm);
  await setHeight(0);assert.equal(await alphaAt(.65),0);assert.equal(await page.locator('#overlayHeightValue').textContent(),'0 cm');
  await setHeight(30);assert(await alphaAt(.65)>0);
  await setHeight(200);assert.equal(await page.locator('#overlayHeightValue').textContent(),'200 cm');
  await page.locator('#overlayHeightReset').click();assert.equal(await page.locator('#overlayHeightRange').inputValue(),'30');
  await setHeight(75);await page.keyboard.press('Escape');assert(await page.locator('#overlayHeightDialog').isHidden());
  assert(await page.locator('#overlayHeightSettings').evaluate(e=>e===document.activeElement));
  await page.locator('#overlayHeight').click();
  await page.evaluate(()=>{data.frames[0].overlay=null;render()});
  assert((await page.locator('#overlayStatus').textContent()).includes('보정'));
  await page.reload();await page.waitForFunction(()=>!document.getElementById('play').disabled);
  assert.equal(await page.locator('#videoOverlayToggle').getAttribute('aria-pressed'),'true');
  assert.equal(await page.locator('#overlayHeight').getAttribute('aria-pressed'),'false');
  assert.equal(await page.locator('#overlayHeightRange').inputValue(),'75','height setting survives reload independently of toggle');
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
  await page.setViewportSize({width:2200,height:1000});
  for(const width of [390,1440]){
   await page.setViewportSize({width,height:1000});await page.evaluate(()=>setReplayLayout('split'));
   const group=await page.locator('.height-controls').boundingBox(),panel=await page.locator('.camera-panel').boundingBox();
   assert(group.x>=panel.x&&group.x+group.width<=panel.x+panel.width,'height settings must fit narrow panels');
   await page.locator('#overlayHeightSettings').click();
   const popup=await page.locator('#overlayHeightDialog').boundingBox();assert(popup.x>=0&&popup.x+popup.width<=width);
   await page.locator('#overlayHeightClose').click();
  }
  await page.setViewportSize({width:2200,height:1000});
  const sizes=[];
  for(const width of [1420,1920]){
   await page.evaluate(width=>{setReplayLayout('split');applyLayoutWidth(width)},width);
   await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
   sizes.push(await page.evaluate(()=>{
    const v=document.getElementById('video'),box=v.getBoundingClientRect(),road=document.querySelector('.road-wrap').getBoundingClientRect();
    const scale=Math.min(box.width/v.videoWidth,box.height/v.videoHeight);
    return {width:box.width,height:box.height,visibleWidth:v.videoWidth*scale,roadHeight:road.height};
   }));
  }
  assert(sizes[1].height>440&&sizes[1].height>sizes[0].height,'video height must grow beyond the former cap');
  assert(sizes[1].visibleWidth>sizes[0].visibleWidth*1.2,'the actual image must grow with the width slider');
  for(const size of sizes){assert(Math.abs(size.height-size.roadHeight)<1,'split panels must stay aligned');assert(Math.abs(size.width-size.visibleWidth)<1,'image should use the available panel width');}
  assert.deepEqual(errors,[]);console.log('PASS: camera overlay drawing, toggle, layer controls, missing calibration and preference restoration');
 }finally{await browser.close()}
})().catch(e=>{console.error(e);process.exitCode=1});
