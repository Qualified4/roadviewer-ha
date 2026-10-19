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
   const f=data.frames[0];Object.assign(f,{lp:[.2,.9,.9,.2],lanes:[[[0,-5.4],[60,-5.4]],[[0,-1.8],[60,-1.8]],[[0,1.8],[60,1.8]],[[0,5.4],[60,5.4]]],ccncRoad:{laneLeft:8,laneRight:4}});
   f.overlay={...frame.overlay,geometry:{...frame.overlay.geometry,lanes:frame.overlay.geometry.lanes}};data.frames[0].cameraInfo=frame.cameraInfo;
   expandReplayData({frames:[f]});render();
  },fixture);
  const on=await yellow();assert(on[0]>0,'orange line on the video');assert(on[1]>0,'orange line in the road view');
  assert.deepEqual(await page.evaluate(()=>[laneLineLeft.textContent,laneLineRight.textContent]),['LANELINE_LEFT 8 · 흰색 점선','LANELINE_RIGHT 4 · 주황 실선']);
  await page.evaluate(()=>{document.getElementById('laneMarking').click()});const off=await yellow();assert.deepEqual(off,[0,0],'setting off restores the default lanes');
  assert.equal(await page.evaluate(()=>JSON.parse(localStorage.getItem('roadviewer-display-preferences')).checks.laneMarking),false,'setting is remembered');
  assert.deepEqual(errors,[]);
  console.log('PASS: cluster LANELINE codes on video and road view, moving dashes, raw codes, setting, old warnings hidden');
 }finally{await browser.close()}
})().catch(e=>{console.error(e);process.exitCode=1});
