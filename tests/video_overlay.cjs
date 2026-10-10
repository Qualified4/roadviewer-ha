const fs=require('fs'),assert=require('node:assert/strict'),{chromium}=require('playwright');
(async()=>{
 const browser=await chromium.launch({headless:true});
 try{
  const page=await browser.newPage({viewport:{width:390,height:844},reducedMotion:'reduce'}),errors=[];
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
  await page.locator('#overlayHeightReset').click();assert.equal(await page.locator('#overlayHeightRange').inputValue(),'60');
  await setHeight(75);await page.keyboard.press('Escape');await page.locator('#overlayHeightDialog').waitFor({state:'hidden'});
  assert(await page.locator('#overlayHeightSettings').evaluate(e=>e===document.activeElement));
  // CCNC display commands have their own toggle; unknown TrackID/speed are never invented.
  assert.equal(await page.locator('#ccncTargets').isChecked(),false);
  await page.evaluate(()=>{data.frames[0].leads=[];data.frames[0].ccncTargets=[{slot:'FF',detect:4,x:20,y:0,yRel:0}];data.frames[0].overlay.markers=[{kind:'ccnc',index:0,point:[.5,.8],projection:[.5,.8,1],box:[[.4,.8,1],[.6,.8,1],[.43,.7,1],[.57,.7,1],[.4,.5,1],[.6,.5,1],[.43,.45,1],[.57,.45,1]]}];render()});
  assert(!(await pixels()),'CCNC hidden by default');
  await page.locator('#ccncTargets').check();assert(await pixels(),'CCNC draws in video overlay');
  const overlayImage=()=>page.locator('#videoOverlay').evaluate(c=>c.toDataURL());
  const setBoxHeight=async value=>page.locator('#ccncBoxHeight').evaluate((e,v)=>{e.value=v;e.dispatchEvent(new Event('input'))},value);
  await setBoxHeight(0);const flat=await overlayImage();assert(await pixels(),'zero height keeps the footprint');
  await setBoxHeight(300);assert.notEqual(await overlayImage(),flat,'box grows from its base');
  await setBoxHeight(150);
  const beforeHeight=await overlayImage();
  await page.locator('#overlayHeight').click();assert.equal(await overlayImage(),beforeHeight,'3D box ignores height toggle');
  await page.locator('#overlayHeight').click();
  const setOpacity=async value=>page.locator('#ccncOpacity').evaluate((e,v)=>{e.value=v;e.dispatchEvent(new Event('input'))},value);
  const boxEdges=()=>page.evaluate(()=>{const edges=[],original=CanvasRenderingContext2D.prototype.stroke;CanvasRenderingContext2D.prototype.stroke=function(){if(this.canvas.id==='videoOverlay'&&this.strokeStyle==='#8deeff')edges.push(this.globalAlpha);return original.call(this)};try{render()}finally{CanvasRenderingContext2D.prototype.stroke=original}return edges});
  await setOpacity(0);assert.equal((await boxEdges()).filter(a=>a>0).length,12,'transparent cube shows all twelve edges');const wireframe=await overlayImage();assert(await pixels(),'zero fill keeps outlines');
  await setOpacity(100);assert((await boxEdges()).some(a=>a===0),'opaque cube hides far edges');assert.notEqual(await overlayImage(),wireframe,'opacity changes filled faces');
  await setOpacity(45);assert.equal(await page.locator('#ccncOpacityValue').textContent(),'45%');
  await page.evaluate(()=>{data.frames[0].overlay.markers[0].box[0][2]=-.1;render()});assert(!(await pixels()),'box crossing camera near plane is omitted');
  await page.evaluate(()=>{data.frames[0].overlay.markers[0].box[0][2]=1;render()});

  await setBoxHeight(200);
  await page.locator('#ccncTargets').uncheck();assert(!(await pixels()));
  await page.locator('#ccncTargets').check();
  await page.locator('#overlayHeight').click();
  await page.evaluate(()=>{data.frames[0].overlay=null;render()});
  assert((await page.locator('#overlayStatus').textContent()).includes('보정'));
  await page.locator('#modelPathWidth').evaluate(e=>{e.value=200;e.dispatchEvent(new Event('input'))});
  await page.reload();await page.waitForFunction(()=>!document.getElementById('play').disabled);
  assert.equal(await page.locator('#modelPathWidth').inputValue(),'200','path width survives reload');
  assert.equal(await page.locator('#ccncBoxHeight').inputValue(),'200','box height survives reload');
  assert.equal(await page.locator('#ccncOpacity').inputValue(),'45','box opacity survives reload');
  assert.equal(await page.locator('#ccncTargets').isChecked(),true,'CCNC preference survives reload');
  assert.equal(await page.locator('#videoOverlayToggle').getAttribute('aria-pressed'),'true');
  assert.equal(await page.locator('#overlayHeight').getAttribute('aria-pressed'),'false');
  assert.equal(await page.locator('#overlayHeightRange').inputValue(),'75','height setting survives reload independently of toggle');
  await page.waitForFunction(()=>document.getElementById('video').videoWidth>0);
  const laneStyles=await page.evaluate(()=>{
   const result=[],original=CanvasRenderingContext2D.prototype.stroke;
   CanvasRenderingContext2D.prototype.stroke=function(){if(this.strokeStyle==='#57d9b0')result.push({canvas:this.canvas.id,width:this.lineWidth,alpha:this.globalAlpha,dash:this.getLineDash()});return original.call(this)};
   const f=data.frames[0];f.lanes=[[[10,-1],[30,-1]],[[10,1],[30,1]]];f.lp=[.2,.8];f.overlay.lanes=[[[.3,.8],[.4,.5]],[[.7,.8],[.6,.5]]];
   try{render()}finally{CanvasRenderingContext2D.prototype.stroke=original}
   f.lanes=[];f.lp=[];f.overlay.lanes=[];render();return result;
  });
  for(const canvas of ['road','videoOverlay']){
   const lines=laneStyles.filter(s=>s.canvas===canvas);assert.equal(lines.length,4);
   assert(lines.every(s=>s.width===1),'lane outlines are exactly 1 CSS px');
   assert(lines[0].alpha<lines[2].alpha,'confidence controls outline visibility');
   assert(lines.every(s=>s.dash.length===0),'probability does not make lanes dashed');
  }

  const shared=await page.evaluate(()=>({full:laneAppearance(1),zero:laneAppearance(0),half:laneAppearance(.5),left:highlightBands({highlight:0,left:1,right:0}),both:highlightBands({highlight:3,left:0,right:1}),ribbon:ribbonEdges([[0,0],[10,0]],1.8)}));
  assert.deepEqual(shared.full,{width:15,alpha:.1,edge:1});assert.equal(shared.zero.width,0);assert.equal(shared.half.width,7.5);assert.equal(shared.half.alpha,.05);
  assert.deepEqual(shared.left,['#62ed9e',null,null]);assert.deepEqual(shared.both,[null,'#55b9ff','#62ed9e']);
  assert.deepEqual(shared.ribbon,[[[0,.9],[10,.9]],[[0,-.9],[10,-.9]]]);
  await page.evaluate(()=>{const f=data.frames[0];f.overlay.path=[];f.overlay.targetLine=[[.3,.7],[.7,.7]];f.ccncRoad={target:1,distance:25,highlight:0,left:0,right:0};render()});
  assert(await pixels(),'target distance line draws');
  await page.evaluate(()=>{data.frames[0].ccncRoad.target=0;render()});assert(!(await pixels()),'hidden TARGET does not draw a distance line');
  await page.evaluate(()=>{data.frames[0].ccncRoad.blinkerLeft=true;render()});assert(await pixels(),'blinker renders');
  const labelState=await page.evaluate(()=>{
   const c=document.createElement('canvas');c.width=300;c.height=100;const x=c.getContext('2d');x.globalAlpha=.25;x.shadowBlur=9;
   let textAlpha;const fill=x.fillText.bind(x);x.fillText=(...args)=>{textAlpha=x.globalAlpha;fill(...args)};
   hudLabel(x,'TARGET · 25.0 m',150,50,'#7be5ff');return {textAlpha,alpha:x.globalAlpha,blur:x.shadowBlur};
  });assert.deepEqual(labelState,{textAlpha:.25,alpha:.25,blur:9},'HUD labels preserve fade and canvas state');
  let wallTestTime=0;const wallImage=()=>page.evaluate(time=>{const c=document.createElement('canvas');c.width=200;c.height=100;paintBlindspotWall(c.getContext('2d'),[[10,90],[190,90]],[[10,10],[190,10]],1,time);return c.toDataURL()},wallTestTime||0);
  const stillWall=await wallImage();wallTestTime=.8;assert.equal(await wallImage(),stillWall,'reduced motion disables wall scan');
  await page.emulateMedia({reducedMotion:'no-preference'});wallTestTime=0;const scanningWall=await wallImage();wallTestTime=.8;assert.notEqual(await wallImage(),scanningWall,'wall scan follows replay time');await page.emulateMedia({reducedMotion:'reduce'});
  const anchors=await page.evaluate(()=>({
   straight:blinkerLaneAnchors([[],[[.2,.9],[.45,.5]],[[.8,.9],[.55,.5]]]),
   curved:blinkerLaneAnchors([[],[[.3,.9],[.55,.5]],[[.9,.9],[.65,.5]]]),
   missing:blinkerLaneAnchors([]),gaps:blinkerLaneAnchors([[],[null,[.4,.5]],[]])
  }));
  for(let i=0;i<2;i++)assert(Math.abs(anchors.curved[i][0]-anchors.straight[i][0]-.1)<1e-6,'AR arrows follow curved lane positions');
  assert.deepEqual(anchors.missing,[[.32,.72],[.68,.72]]);assert.deepEqual(anchors.gaps,anchors.missing,'missing geometry falls back to central AR positions');
  const chevrons=await page.evaluate(()=>{
   const c=document.createElement('canvas');c.width=400;c.height=100;const x=c.getContext('2d');let strokes=0;const stroke=x.stroke.bind(x);x.stroke=()=>{strokes++;stroke()};
   drawBlinkers(x,{blinkerLeft:true,blinkerRight:true},0,10,390,50);const rows=[];const pixels=x.getImageData(0,0,400,100).data;for(let y=0;y<100;y++)for(let px=0;px<400;px++)if(pixels[(y*400+px)*4+3]>5){rows.push(y);break}return {strokes,center:(Math.min(...rows)+Math.max(...rows))/2};
  });assert.equal(chevrons.strokes,6,'three chevrons per direction');assert(Math.abs(chevrons.center-50)<2,'AR arrows stay vertically centered');
  await page.emulateMedia({reducedMotion:'no-preference'});
  const easing=await page.evaluate(()=>{
   const frames=Array.from({length:41},(_,i)=>({t:i*.05,valid:true,roadSignals:{blindspotLeft:i>=4&&i<20,blindspotRight:i>=20}}));
   return [0,4,10,19,20,25,40].map(i=>blindspotLevels(frames,i,frames[i].t));
  });
  assert.deepEqual(easing[0],[0,0]);assert(easing[1][0]>0&&easing[1][0]<easing[2][0]);assert.equal(easing[3][0],1);
  assert(easing[4][0]<1&&easing[4][0]>easing[5][0]);assert.equal(easing[6][0],0);assert.equal(easing[6][1],1);
  await page.emulateMedia({reducedMotion:'reduce'});
  assert.deepEqual(await page.evaluate(()=>blindspotLevels([{t:0,valid:true,roadSignals:{blindspotLeft:true}}],0,0)),[1,0]);
  await page.evaluate(()=>{const f=data.frames[0];f.ccncRoad.blinkerLeft=false;f.roadSignals={blindspotLeft:true};f.overlay.lanes=[[],[[.2,.9],[.4,.55]],[[.8,.9],[.6,.55]],[]];f.overlay.laneDepths=[[5,40],[5,40]];f.overlay.heightDirection=[0,-1,0];render()});
  assert(await pixels(),'blindspot renders without a CCNC command or radar detection');
  const wallBefore=await page.locator('#videoOverlay').evaluate(c=>c.toDataURL());
  await page.locator('#overlayHeight').click();
  assert.equal(await page.locator('#videoOverlay').evaluate(c=>c.toDataURL()),wallBefore,'marker height does not move wall');
  await page.evaluate(()=>{data.frames[0].roadSignals=null;data.frames[0].overlay.lanes=[];data.frames[0].ccncRoad.blinkerLeft=true;render()});

  await page.locator('#ccncRoad').uncheck();assert(!(await pixels()),'road toggle hides blinker');await page.locator('#ccncRoad').check();
  await page.evaluate(()=>{const f=data.frames[0];f.ccncRoad=null;f.overlay.path=[[.5,.6],[.5,.9]];render()});
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

  // Motion uses current samples while playback continues, and also settles while paused.
  await page.setViewportSize({width:390,height:844});
  await page.evaluate(()=>{
   pause();setReplayLayout('auto');
   document.getElementById('hideLabels').checked=true;document.getElementById('modelPath').checked=false;
   data.frames=Array.from({length:41},(_,i)=>({t:i*.05,id:i,valid:true,lanes:[],edges:[],lp:[],es:[],leads:[{x:20,y:0,p:1}],
    overlay:{lanes:[],edges:[],path:[],heightDirection:[0,-.5,0],markers:[{kind:'model',index:0,point:[.3+i*.005,.8],projection:[.3+i*.005,.8,1]}]}}));
   const slider=document.getElementById('overlayHeightRange');slider.value=60;slider.dispatchEvent(new Event('input'));
   const height=document.getElementById('overlayHeight');if(height.getAttribute('aria-pressed')!=='true')height.click();
   setTime(0);
   const c=document.getElementById('videoOverlay').getContext('2d'),arc=c.arc.bind(c);
   window.overlayDraws=[];c.arc=(x,y,...rest)=>{overlayDraws.push({x,y,time:t});return arc(x,y,...rest)};
  });
  await page.emulateMedia({reducedMotion:'no-preference'});
  const settleOverlay=()=>page.waitForTimeout(320);
  // Pausing a native fade at its midpoint lets us check reversal without timing races.
  const fade=await page.evaluate(()=>{
   const button=document.getElementById('videoOverlayToggle'),layer=document.getElementById('videoOverlay');
   button.click();const a=layer.getAnimations()[0];a.pause();a.currentTime=100;
   const before=Number(getComputedStyle(layer).opacity);button.click();
   const after=Number(getComputedStyle(layer).opacity);
   return {before,after,visible:!layer.hidden};
  });
  assert(fade.before>0&&fade.before<1);assert(Math.abs(fade.after-fade.before)<.02,'fade reverses from its current opacity');assert(fade.visible);
  await settleOverlay();
  await page.evaluate(()=>{overlayDraws=[];document.getElementById('overlayHeight').click()});
  await settleOverlay();
  let draws=await page.evaluate(()=>overlayDraws);
  assert(draws.length>2,'paused height changes draw intermediate positions');
  assert(draws.some(p=>p.y>draws[0].y+1&&p.y<draws.at(-1).y-1),'height moves smoothly to ground');
  const idleCount=draws.length;await page.waitForTimeout(80);
  assert.equal(await page.evaluate(()=>overlayDraws.length),idleCount,'settled paused overlays do not keep redrawing');
  await page.evaluate(()=>{setTime(0);overlayDraws=[];toggle();document.getElementById('overlayHeight').click()});
  await settleOverlay();
  draws=await page.evaluate(()=>overlayDraws);
  assert(await page.evaluate(()=>playing&&t>.2),'height motion must not pause playback');
  assert(draws.at(-1).x>draws[0].x,'motion keeps following the latest moving vehicle');
  assert(draws.at(-1).y<draws[0].y-5,'vehicle rises during playback');
  await page.evaluate(()=>pause());
  // Reverse a height change mid-flight and finish at the saved target, without a jump.
  await page.evaluate(()=>{overlayDraws=[];document.getElementById('overlayHeight').click()});
  await page.waitForTimeout(90);
  const reverse=await page.evaluate(()=>{const before=overlayDraws.at(-1).y;document.getElementById('overlayHeight').click();return {before,after:overlayDraws.at(-1).y}});
  assert(Math.abs(reverse.after-reverse.before)<10,'height reversal starts from the current position');
  await settleOverlay();
  // Switching reduced motion on settles an in-flight fade and height change immediately.
  await page.evaluate(()=>{document.getElementById('overlayHeight').click();document.getElementById('videoOverlayToggle').click()});
  await page.emulateMedia({reducedMotion:'reduce'});
  await page.waitForFunction(()=>document.getElementById('videoOverlay').hidden);
  assert.equal(await page.locator('#videoOverlay').evaluate(e=>e.getAnimations().length),0);
  await page.evaluate(()=>document.getElementById('videoOverlayToggle').click());
  assert(await page.locator('#videoOverlay').isVisible());
  assert.equal(await page.locator('#videoOverlay').evaluate(e=>e.getAnimations().length),0,'reduced motion shows overlay instantly');
  assert.deepEqual(errors,[]);console.log('PASS: overlay drawing/layout, playback and paused motion, reversal, reduced motion, missing calibration and saved settings');
 }finally{await browser.close()}
})().catch(e=>{console.error(e);process.exitCode=1});
