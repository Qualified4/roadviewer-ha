const fs=require('fs'),assert=require('node:assert/strict'),{chromium}=require('playwright');
// Cluster lane code (ADRV_0x161 LANELINE_LEFT/RIGHT): own-lane lines take the sent colour and shape, dashed lines
// break into dashes that move with the distance travelled, the raw code is listed, and the setting turns it off.
(async()=>{
 const browser=await chromium.launch({headless:true});
 try{
  const page=await browser.newPage({viewport:{width:1280,height:900},reducedMotion:'reduce'}),errors=[];
  page.on('pageerror',e=>errors.push(e.message));
  await page.route('https://rv.test/**',route=>{
   const p=new URL(route.request().url()).pathname;
   if(p.endsWith('/bookmarks'))return route.fulfill({json:{bookmarks:[]}});
   if(p==='/api/logs')return route.fulfill({json:{logs:[]}});
   if(p.endsWith('/video'))return route.fulfill({body:fs.readFileSync(process.env.RV_TEST_VIDEO||'/tmp/roadviewer-test.mp4'),contentType:'video/mp4'});
   // The replay loads vehicle data in the background for the event track; none here.
   if(p.endsWith('/telemetry'))return route.fulfill({status:404,json:{error:'차량 정보 없음'}});
   if(p.endsWith('/data'))return route.fulfill({json:{route:'lane',key:'lane',duration:2,warnings:['지원하지 않는 새 로그 이벤트 3개를 건너뛰었습니다.','다른 경고'],video:{start:0,duration:2},
    frames:[{t:0,id:0,valid:true,lanes:[],edges:[],lp:[],es:[],leads:[],liveTracksValid:false,overlay:{lanes:[],edges:[],path:[],markers:[]}}]}});
   const name=p.startsWith('/view/')?'index.html':p.replace('/assets/','');
   return route.fulfill({body:fs.readFileSync('roadviewer/app/web/'+name),contentType:name.endsWith('.html')?'text/html':name.endsWith('.js')?'application/javascript':name.endsWith('.css')?'text/css':name.endsWith('.png')?'image/png':'image/svg+xml'});
  });
  await page.goto('https://rv.test/view/one/');await page.waitForFunction(()=>!document.getElementById('play').disabled);
  assert.deepEqual(await page.evaluate(()=>data.warnings),['다른 경고'],'old skipped-event warnings are not shown');
  const fixture=JSON.parse(require('child_process').execFileSync('python3',['tests/overlay_geometry_fixture.py'],{encoding:'utf8'}))[0].frame;
  const geometry=await page.evaluate(frame=>{
   const at=(road,odometer)=>buildReplayOverlay({...frame,ccncRoad:road,odometer},frame.overlay.geometry).laneDashBands;
   const dashed=at({laneLeft:8,laneRight:4},0),moved=at({laneLeft:10,laneRight:6},2);
   const first=bands=>bands[1][0][0].find(Boolean);
   return {count:dashed[1]?.length,right:dashed[2],others:[dashed[0],dashed[3]],moved:JSON.stringify(moved[1])!==JSON.stringify(dashed[1]),none:at(undefined,0).every(b=>b===null)&&at({laneLeft:14,laneRight:2},0).every(b=>b===null)};
  },fixture);
  assert(geometry.count>=3,'dashed left line is split into dashes');assert.equal(geometry.right,null,'solid line stays one ribbon');
  assert.deepEqual(geometry.others,[null,null],'only the own-lane lines are marked');assert(geometry.moved,'dashes move with distance travelled');assert(geometry.none);
  // Drawn colours: yellow left line on the video and in the road view; nothing yellow when the setting is off.
  const yellow=()=>page.evaluate(()=>['videoOverlay','road'].map(id=>{const c=document.getElementById(id),d=c.getContext('2d').getImageData(0,0,c.width,c.height).data;let n=0;for(let i=0;i<d.length;i+=4)if(d[i+3]>40&&d[i]>200&&d[i+1]>110&&d[i+1]<190&&d[i+2]<110)n++;return n}));
  await page.evaluate(frame=>{
   const f=data.frames[0];Object.assign(f,{lp:[.2,.9,.9,.2],lanes:[[[0,-5.4],[60,-5.4]],[[0,-1.8],[60,-1.8]],[[0,1.8],[60,1.8]],[[0,5.4],[60,5.4]]],ccncRoad:{laneLeft:8,laneRight:4},gap:2});
   f.overlay={...frame.overlay,geometry:{...frame.overlay.geometry,lanes:frame.overlay.geometry.lanes}};data.frames[0].cameraInfo=frame.cameraInfo;
   expandReplayData({frames:[f]});render();
  },fixture);
  const on=await yellow();assert(on[0]>0,'orange line on the video');assert(on[1]>0,'orange line in the road view');
  // The own-lane cards carry a piece of the line: dashed white in 차선 1, solid orange in 차선 2, named for screen readers.
  assert.deepEqual(await page.evaluate(()=>[laneLineLeft,laneLineRight].map(el=>[el.hidden,el.dataset.type,el.style.getPropertyValue('--lane'),getComputedStyle(el,'::before').backgroundImage.startsWith('repeating-linear-gradient'),el.getAttribute('aria-label'),el.parentElement.querySelector('.boundary-index').textContent])),[[false,'dashed','#eef3f8',true,'왼쪽 차선 흰색 점선','차선 1'],[false,'solid','#ff9f43',false,'오른쪽 차선 주황 실선','차선 2']]);
  // Following-distance setting (frame.gap): four cells, as many lit as the level; just above the bottom controls while they
  // show and down in the corner when they fade; off by its setting, and absent for logs converted without the value.
  {const gap=()=>page.evaluate(()=>{const c=document.getElementById('videoGap'),r=c.getBoundingClientRect(),s=document.getElementById('videoStage').getBoundingClientRect(),t=document.querySelector('.video-tools').getBoundingClientRect();
    return {hidden:c.hidden,lit:c.querySelectorAll('.is-on').length,cells:c.children.length,label:c.getAttribute('aria-label'),left:Math.round(r.left-s.left),fromBottom:Math.round(s.bottom-r.bottom),aboveTools:Math.round(t.top-r.bottom)}});
   let g=await gap();assert.deepEqual([g.hidden,g.cells,g.lit,g.label],[false,4,2,'차간 거리 2단계 (4단계 중)']);
   assert.deepEqual([g.left,g.aboveTools],[12,8],'rides above the bottom controls '+JSON.stringify(g));
   await page.evaluate(()=>document.body.classList.add('hud-idle'));g=await gap();assert.equal(g.fromBottom,12,'settles into the corner when the controls fade '+JSON.stringify(g));
   await page.evaluate(()=>{document.body.classList.remove('hud-idle');data.frames[0].gap=4;render()});assert.equal((await gap()).lit,4);
   await page.evaluate(()=>{document.getElementById('gapLevel').click()});assert.equal((await gap()).hidden,true,'the setting turns it off');
   await page.evaluate(()=>{document.getElementById('gapLevel').click();data.frames[0].gap=null;render()});assert.equal((await gap()).hidden,true,'no value in the log: nothing shown');
   await page.evaluate(()=>{data.frames[0].gap=2;render()})}
  // Path chevrons carry the drive state. Radial gradients on the video overlay come only from the chevrons: their count says
  // whether chevrons were drawn, their colour stops which tint they had.
  {const chevrons=()=>page.evaluate(()=>{const stops=[],original=CanvasRenderingContext2D.prototype.createRadialGradient;let count=0;
    CanvasRenderingContext2D.prototype.createRadialGradient=function(...args){const g=original.apply(this,args);if(this.canvas.id==='videoOverlay'){count++;const add=g.addColorStop.bind(g);g.addColorStop=(at,color)=>{stops.push(color);add(at,color)}}return g};
    try{render()}finally{CanvasRenderingContext2D.prototype.createRadialGradient=original}return {count,stops}});
   const tinted=(r,rgb)=>r.stops.some(c=>c.startsWith(`rgba(${rgb},`));
   const wasPath=await page.evaluate(()=>{const box=document.getElementById('modelPath'),was=box.checked;if(!was)box.click();return was});
   let r=await chevrons();assert(r.count>0,'chevrons on the model path');assert(!tinted(r,'255,178,87'),'plain teal by default');
   // Longitudinal control off (vehicle data): no chevrons. Not loaded (404 here): no opinion, drawn.
   assert.equal(await page.evaluate(()=>window.rvControlAt(0)),null,'no vehicle data: unknown');
   await page.evaluate(()=>{window.__control=window.rvControlAt;window.rvControlAt=()=>false});r=await chevrons();assert.equal(r.count,0,'no chevrons while longitudinal control is off');
   await page.evaluate(()=>{window.rvControlAt=window.__control});
   // Slowing down: amber from the apex.
   await page.evaluate(()=>{data.frames[0].roadSignals={acceleration:-3}});r=await chevrons();assert(tinted(r,'255,178,87'),'amber at a hard deceleration');
   await page.evaluate(()=>{data.frames[0].roadSignals={acceleration:.5}});r=await chevrons();assert(!tinted(r,'255,178,87'),'no amber while speeding up');
   // Lead well inside the target following distance: no chevrons; outside it: drawn.
   await page.evaluate(()=>{const f=data.frames[0];f.ccncRoad={...f.ccncRoad,target:1,distance:20};f.gapTarget=40;overlayGeometryCache.clear()});  // the lead's distance mark is part of the cached geometryr=await chevrons();assert.equal(r.count,0,'lead inside the target: no chevrons');
   await page.evaluate(()=>{data.frames[0].gapTarget=12});r=await chevrons();assert(r.count>0,'lead beyond the target: chevrons');
   await page.evaluate(()=>{const f=data.frames[0];f.ccncRoad={laneLeft:8,laneRight:4};delete f.gapTarget;delete f.roadSignals;overlayGeometryCache.clear();render()});
   // Blinker morph progress: up over 0.9 s after the blinker comes on, back down over 1.2 s after it goes off (a gap under
   // 0.25 s still counts as on); without motion it switches at once. The arrows keep their 6-point outline.
   const morphAt=()=>page.evaluate(()=>{const frames=[0,.25,.5,.75,1].map(t=>({t,valid:true,roadSignals:{blinkerRight:true}})).concat([1.25,1.5,2,2.5].map(t=>({t,valid:true,roadSignals:{blinkerRight:false}})));
    const at=time=>{const k=frames.findIndex(f=>f.t>time),i=k<0?frames.length-1:Math.max(0,k-1);return +blinkerMorph(frames,i,time,'blinkerRight').toFixed(2)};
    return [at(0),at(.45),at(.95),at(1.1),at(1.85),at(2.6),+blinkerMorph(frames,3,.75,'blinkerLeft').toFixed(2),blinkerArrows(1,0,900,300).map(a=>a.length).join()]});
   assert.deepEqual(await morphAt(),[1,1,1,1,0,0,0,'6,6,6'],'reduced motion: switches at once');
   await page.emulateMedia({reducedMotion:'no-preference'});
   try{const moving=await morphAt();assert.deepEqual(moving,[0,.5,1,1,.5,0,0,'6,6,6'],'blinker morph '+JSON.stringify(moving));
    // Switched back mid-way, the arrows turn round where they are: the progress never jumps between samples (at most one
    // 50 ms step of rise or fall), and the movement keeps its start and its kind (so the same chevrons and the same curve).
    const turns=await page.evaluate(()=>{
     const run=on=>{const frames=Array.from({length:81},(_,k)=>({t:k*.05,valid:true,roadSignals:{blinkerRight:on(k*.05)}}));
      return frames.map((f,i)=>blinkerMorphState(frames,i,f.t,'blinkerRight'))};
     const check=states=>{let jump=0,flips=0;for(let i=1;i<states.length;i++){const a=states[i-1],b=states[i];jump=Math.max(jump,Math.abs(b.progress-a.progress));
      if(a.progress>0&&a.progress<1&&b.progress>0&&b.progress<1&&(a.settling!==b.settling||a.start!==b.start))flips++}return {jump:+jump.toFixed(3),flips}};
     const quick=run(t=>t<.5||(t>=.85&&t<1.6)),again=run(t=>t<1.5||t>=2.05);
     return {quick:check(quick),again:check(again),dipped:Math.min(...quick.slice(10,20).map(s=>s.progress))>0,turned:again.slice(36,46).some(s=>s.settling&&s.progress>.6)&&again.slice(36,46).some((s,i,a)=>i&&s.settling&&s.progress>a[i-1].progress)&&again[60].progress===1};
    });
    assert(turns.quick.jump<=.06&&turns.quick.flips===0&&turns.dipped,'on, off, on again: arrows turn round '+JSON.stringify(turns));
    assert(turns.again.jump<=.06&&turns.again.flips===0&&turns.turned,'formed, off, on again: the settling turns back up '+JSON.stringify(turns))}finally{await page.emulateMedia({reducedMotion:'reduce'})}
   if(!wasPath)await page.evaluate(()=>document.getElementById('modelPath').click())}
  await page.evaluate(()=>{document.getElementById('laneMarking').click()});const off=await yellow();assert.deepEqual(off,[0,0],'setting off restores the default lanes');
  assert.equal(await page.evaluate(()=>JSON.parse(localStorage.getItem('roadviewer-display-preferences')).checks.laneMarking),false,'setting is remembered');
  assert.deepEqual(errors,[]);
  console.log('PASS: cluster LANELINE codes on video and road view, moving dashes, raw codes, setting, old warnings hidden, path chevron states');
 }finally{await browser.close()}
})().catch(e=>{console.error(e);process.exitCode=1});
