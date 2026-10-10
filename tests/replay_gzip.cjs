const fs=require('fs'),zlib=require('zlib'),assert=require('node:assert/strict'),{chromium}=require('playwright');
// Compact gzip replay files (compact.py) load through DecompressionStream and expand to the full form.
const info={device:'tizi',deviceId:'gzip-device',sensor:'os04c10',calibrationStatus:'calibrated',rpy:[0,0,0],height:1.22,heightDefault:false};
const frame=i=>({t:i*.05,id:i,valid:true,cameraInfo:0,lanes:[],edges:[],lp:[],es:[],leads:[],egoSpeedKph:40,liveTracksValid:true,liveTracksDeltaMs:1,
 liveTracks:[{trackId:7,x:20.5,yRel:1.25,vRel:.4,measured:true,source:'frontRadar',trackState:2}],
 radarTargets:[{group:'left',index:1,x:10,yRel:-2,vRel:.1,radar:true,trackId:3,modelProb:.5}],
 overlay:{heightDirection:[0,.1,0],lanes:[],edges:[],path:[[.5,.6],[.5,.9]],markers:[{kind:'raw',index:0,projection:[2,3,4]}]}});
const compact={route:'gzip',key:'gzip-key',duration:1,logStart:0,logEnd:.95,warnings:[],video:null,cameraInfos:[info],frames:Array.from({length:20},(_,i)=>frame(i))};
(async()=>{
 const browser=await chromium.launch({headless:true});
 try{
  for(const supported of [true,false]){
   const page=await browser.newPage({viewport:{width:1280,height:900}}),errors=[],requests=[];
   page.on('pageerror',e=>errors.push(e.message));
   if(!supported)await page.addInitScript(()=>{delete window.DecompressionStream});
   await page.route('https://rv.test/**',route=>{
    const url=new URL(route.request().url()),p=url.pathname;
    if(p==='/api/logs')return route.fulfill({json:{logs:[]}});
    if(p.endsWith('/data')){
     requests.push(url.search);
     // Without DecompressionStream the server answers plain JSON instead.
     return url.searchParams.get('format')==='gzip'?route.fulfill({body:zlib.gzipSync(JSON.stringify(compact)),contentType:'application/gzip'}):route.fulfill({json:compact});
    }
    const name=p.startsWith('/view/')?'index.html':p.replace('/assets/','');
    return route.fulfill({body:fs.readFileSync('roadviewer/app/web/'+name),contentType:name.endsWith('.js')?'application/javascript':name.endsWith('.css')?'text/css':name.endsWith('.png')?'image/png':'image/svg+xml'});
   });
   await page.route('https://rv.test/view/one/',route=>route.fulfill({body:fs.readFileSync('roadviewer/app/web/index.html'),contentType:'text/html'}));
   await page.goto('https://rv.test/view/one/');
   await page.waitForFunction(()=>!document.getElementById('play').disabled);
   assert.deepEqual(requests,[supported?'?format=gzip':'']);
   const fixtures=JSON.parse(require('child_process').execFileSync('python3',['tests/overlay_geometry_fixture.py'],{encoding:'utf8'}));
   const parity=await page.evaluate(rows=>{
    let error=0;
    function compare(a,b){if(typeof b==='number'){if(!Number.isFinite(a))throw Error('nonfinite projection');error=Math.max(error,Math.abs(a-b));return}if(Array.isArray(b)){if(a.length!==b.length)throw Error('geometry length mismatch '+a.length+' vs '+b.length);b.forEach((v,i)=>compare(a[i],v));return}if(b&&typeof b==='object'){for(const k in b)compare(a[k],b[k]);return}if(a!==b)throw Error('geometry value mismatch')}
    for(const {frame,expected,wideInfo,wideBasis} of rows){compare(buildReplayOverlay(frame,frame.overlay.geometry),expected);compare(wideProjectionBasis(wideInfo),wideBasis)}
    if(wideProjectionBasis({...rows[0].wideInfo,wideRpy:null})!==null||wideProjectionBasis({...rows[0].wideInfo,wideSensor:'unsupported'})!==null)throw Error('missing wide metadata must be rejected');
    const frame=rows[0].frame,source=frame.overlay;
    const first=frameOverlay(frame,source);if(frameOverlay(frame,source)!==first)throw Error('cache miss');
    for(let i=0;i<100;i++)frameOverlay({...frame},source);
    return {error,cache:overlayGeometryCache.size};
   },fixtures);
   assert(parity.error<.001,`runtime geometry differs by ${parity.error}`);assert.equal(parity.cache,32);
   const expanded=await page.evaluate(()=>{const f=data.frames[3];return {info:f.cameraInfo,shared:data.frames[0].cameraInfo===data.frames[19].cameraInfo,live:f.liveTracks[0],radar:f.radarTargets[0],point:f.overlay.markers[0].point}});
   assert.deepEqual(expanded.info,info);assert(expanded.shared,'frames share one camera info object');
   assert.equal(expanded.live.index,0);assert.equal(expanded.live.y,-1.25);
   assert.equal(expanded.radar.index,1,'radar group index is kept');assert.equal(expanded.radar.y,2);
   assert.deepEqual(expanded.point,[.5,.75]);
   await page.locator('#cameraInfoButton').click();
   assert.match(await page.locator('#cameraInfoValues').textContent(),/gzip-device/);
   // Playback redraws the road view only when the model frame changes.
   await page.evaluate(()=>{window.draws=0;const c=document.getElementById('road').getContext('2d'),clear=c.clearRect.bind(c);c.clearRect=(...a)=>{window.draws++;return clear(...a)}});
   await page.keyboard.press('Escape');await page.evaluate(()=>toggle());await page.waitForTimeout(500);await page.evaluate(()=>pause());
   const draws=await page.evaluate(()=>window.draws),frameIndex=await page.evaluate(()=>idx);
   assert(draws>=frameIndex&&draws<=frameIndex+4,`${draws} redraws for ${frameIndex} frames`);
   assert.deepEqual(errors,[]);await page.close();
  }
  console.log('PASS: gzip replay data, plain fallback without DecompressionStream, compact expansion and frame-paced redraws');
 }finally{await browser.close()}
})().catch(e=>{console.error(e);process.exitCode=1});
