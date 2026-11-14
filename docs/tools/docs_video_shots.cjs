// Documentation screenshots with the driving video (docs/images): overview, driving-view, wide-camera, replay-map and
// video-minimap, light (daytime drive) and dark (night drive); there is no daytime wide video, so both wide shots use
// the night drive. Not a test and not in any CI group; rerun by hand when the replay UI changes.
//
// The video is a still clip of one real frame per scene (docs/tools/docs_video_scenes.json): docs_video_frames.py decodes it
// from the log's video at the scene time, remasters it and erases the listed licence plates. The app draws 겹쳐 보기
// (on, default settings) from that log's own replay data and /telemetry at the same time, so the drawing lines up with
// the picture. Identifiers are replaced (device DEMO-DEVICE, hash 0000000000, example dates) and every GPS or location
// field is dropped from what is served; the maps show an example route: an OSRM road path between public Seoul
// landmarks on real OpenFreeMap tiles (the only outside requests). The map position is not related to the video.
//
// RV_DOCS_LOGS: folder with one subfolder per scene log holding data.json and telemetry.json (the app's /data and
//   /telemetry answers) and front.mp4 / wide.mp4 (its /video?source=front|wide). Not in the repository.
// RV_DOCS_FRAMES: reuse frames docs_video_frames.py already made there (default: make them in a temporary folder).
// RV_DOCS_ONLY: comma list of file names (e.g. roadviewer-overview-dark) to capture only those.
// RV_DOCS_OUT: where the PNGs go (default docs/images). RV_PYTHON: a python with PyAV, numpy and opencv-python-headless.
// Run from an ASCII path (Node has died silently under the Korean checkout path): node docs/tools/docs_video_shots.cjs
const fs=require('fs'),os=require('os'),path=require('path'),{execFileSync}=require('child_process'),{chromium}=require('playwright');
const {settleLayout}=require('../../tests/browser-helpers.cjs');
const OUT=process.env.RV_DOCS_OUT||'docs/images',LOGS=process.env.RV_DOCS_LOGS,WORK=fs.mkdtempSync(path.join(os.tmpdir(),'rv-docs-'));
const ONLY=process.env.RV_DOCS_ONLY?process.env.RV_DOCS_ONLY.split(','):null,PYTHON=process.env.RV_PYTHON||'python';
const OFM='https://tiles.openfreemap.org/',OSRM='https://router.project-osrm.org/';
const {scenes,shots}=JSON.parse(fs.readFileSync(path.join(__dirname,'docs_video_scenes.json'),'utf8'));
const DURATION=60,SEGMENTS=4,FPS=5;
function stillVideo(png,seconds,out){
 execFileSync(PYTHON,['-c',`import av, sys
src, out, seconds, fps = sys.argv[1], sys.argv[2], float(sys.argv[3]), int(sys.argv[4])
with av.open(src) as image: pixels = next(image.decode(video=0)).to_ndarray(format='rgb24')
with av.open(out, 'w') as video:
 stream = video.add_stream('libx264', rate=fps); stream.width = pixels.shape[1]; stream.height = pixels.shape[0]; stream.pix_fmt = 'yuv420p'
 stream.options = {'crf': '14'}
 for i in range(int(seconds * fps) + 2):
  frame = av.VideoFrame.from_ndarray(pixels, format='rgb24'); frame.pts = i
  for packet in stream.encode(frame): video.mux(packet)
 for packet in stream.encode(): video.mux(packet)
`,png,out,String(seconds),String(FPS)]);
}
// A road path through central Seoul (서울역 → 시청 → 광화문 → 안국역 → 종각), resampled to 1 Hz over the four segments.
async function seoulRoute(){
 const cache=path.join(os.tmpdir(),'rv-docs-osrm.json');let line;
 try{line=JSON.parse(fs.readFileSync(cache,'utf8'))}catch{
  const stops=[[126.9707,37.5547],[126.9779,37.5663],[126.9769,37.5759],[126.9855,37.5765],[126.9830,37.5701]];
  const r=await fetch(`${OSRM}route/v1/driving/${stops.map(s=>s.join(',')).join(';')}?overview=full&geometries=geojson`);
  if(!r.ok)throw Error('OSRM '+r.status);line=(await r.json()).routes[0].geometry.coordinates;fs.writeFileSync(cache,JSON.stringify(line));
 }
 const metres=(a,b)=>{const k=Math.PI/180,x=(b[0]-a[0])*k*Math.cos((a[1]+b[1])/2*k),y=(b[1]-a[1])*k;return Math.hypot(x,y)*6371000};
 const along=[0];for(let i=1;i<line.length;i++)along.push(along[i-1]+metres(line[i-1],line[i]));
 const total=along.at(-1),steps=DURATION*SEGMENTS,speed=total/steps,points=[];
 for(let s=0,j=0;s<=steps;s++){
  const d=s*total/steps;while(j<line.length-2&&along[j+1]<d)j++;
  const a=line[j],b=line[j+1],k=Math.min(1,Math.max(0,(d-along[j])/((along[j+1]-along[j])||1)));
  const bearing=(Math.atan2((b[0]-a[0])*Math.cos(a[1]*Math.PI/180),b[1]-a[1])*180/Math.PI+360)%360;
  points.push([s,+(a[1]+(b[1]-a[1])*k).toFixed(6),+(a[0]+(b[0]-a[0])*k).toFixed(6),+speed.toFixed(2),+bearing.toFixed(1)]);
 }
 return Array.from({length:SEGMENTS},(_,i)=>({id:'seg'+i,segment:i,duration:DURATION,distance_m:Math.round(speed*DURATION),
  points:points.slice(i*DURATION,(i+1)*DURATION+1).map(([t,...rest])=>[t-i*DURATION,...rest])}));
}
const ROUTE='0000041b--0000000000';
// Location fields (GPS and anything named like it) are dropped; the device id is replaced.
const PRIVATE=/^(lat|lon|lng|latitude|longitude|altitude|bearing|bearingDeg|speedAccuracy|accuracy|location)$|gps|gnss|ublox|carrot|nav/i;
function scrub(value){
 if(Array.isArray(value))return value.map(scrub);
 if(!value||typeof value!=='object')return value;
 return Object.fromEntries(Object.entries(value).filter(([k])=>!PRIVATE.test(k)).map(([k,v])=>[k,k==='deviceId'?'0000000000000000':scrub(v)]));
}
function sceneData(name){
 const scene=scenes[name],folder=path.join(LOGS,scene.log),read=file=>JSON.parse(fs.readFileSync(path.join(folder,file),'utf8'));
 const replay=scrub(read('data.json')),telemetry=scrub(read('telemetry.json'));
 replay.route=`${ROUTE} / 구간 0`;replay.key='docs-'+name;replay.warnings=[];
 const video={...replay.videos.front,codec:'h264'};
 replay.video=video;replay.videos={front:video,qcamera:video,...('wide' in scene.cameras?{wide:video}:{})};replay.defaultVideo='front';
 const text=JSON.stringify([replay,telemetry]);
 if(/[가-힣]/.test(text.replace(replay.route,'')))throw Error(name+': Korean text left in the served data');
 if(/"[^"]*(gps|latitude|longitude)[^"]*"\s*:/i.test(text))throw Error(name+': location field left in the served data');
 return {telemetry,replay,duration:replay.duration};
}
// Day scenes start the example drive in the morning, night scenes ("evening": true) in the evening.
const STARTS={day:Date.UTC(2026,10,6,23,2)/1000,evening:Date.UTC(2026,10,7,11,12)/1000};  // 2026-11-07 08:02 / 20:12 KST
const logsFor=START=>Array.from({length:SEGMENTS},(_,i)=>({id:'seg'+i,name:`${ROUTE} / 구간 ${i}`,files:{'rlog.zst':`${ROUTE}--${i}--rlog.zst`},device:'DEMO-DEVICE',status:'ready',uploaded:START+3600,started_at:START+i*DURATION,duration:DURATION,
 bytes:48000000,prepared_bytes:30000000,video:true,has_track:true,pinned:i===0,tags:[{name:'고속도로',color:'blue'}],drive_summary:{engaged_ratio:.94,takeovers:1},storage_locations:{rlog:'local',front:'local'}}));
const bookmarks=[{id:'b1',time:12.4,title:'차선 합류 확인',note:'주변 차량과의 간격을 확인합니다.'},{id:'b2',time:31.2,title:'앞차 감속',note:''},{id:'b3',time:47.7,title:'운전자 개입',note:''}];
const TYPES={html:'text/html',js:'application/javascript',css:'text/css',woff2:'font/woff2',png:'image/png',svg:'image/svg+xml',json:'application/json'};
function server(videos,track,{telemetry,replay},logs){return async route=>{
 const url=new URL(route.request().url()),p=url.pathname;
 if(url.href.startsWith(OFM))return route.continue();  // real basemap tiles
 if(url.hostname!=='rv.test')return route.abort();
 if(p.endsWith('/video')){
  const body=videos[url.searchParams.get('source')||'front']||videos.front,range=/^bytes=(\d+)-(\d*)$/.exec(route.request().headers().range||'');
  if(range){const start=Number(range[1]),end=range[2]?Math.min(Number(range[2]),body.length-1):body.length-1;return route.fulfill({status:206,body:body.subarray(start,end+1),contentType:'video/mp4',headers:{'Accept-Ranges':'bytes','Content-Range':`bytes ${start}-${end}/${body.length}`}})}
  return route.fulfill({body,contentType:'video/mp4',headers:{'Accept-Ranges':'bytes'}});
 }
 if(p.endsWith('/data'))return route.fulfill({json:replay});
 if(p.endsWith('/telemetry'))return route.fulfill({json:telemetry});
 if(p.endsWith('/bookmarks'))return route.fulfill({json:{bookmarks}});
 if(p.endsWith('/track'))return route.fulfill({json:{id:p.split('/').at(-2),segments:track}});
 if(p==='/api/logs')return route.fulfill({json:{logs,concurrency:1,auto_convert:true,max_upload_mb:512}});
 if(p.startsWith('/api/'))return route.fulfill({json:{progress:{}}});
 const name=p==='/'?'library.html':p.startsWith('/view/')?'index.html':p.replace('/assets/','');
 return route.fulfill({body:fs.readFileSync(path.join('roadviewer/app/web',name)),contentType:TYPES[path.extname(name).slice(1)]||'application/octet-stream'});
}}
(async()=>{
 if(!LOGS)throw Error('RV_DOCS_LOGS is not set');
 const frames=process.env.RV_DOCS_FRAMES||path.join(WORK,'frames');
 if(!process.env.RV_DOCS_FRAMES)execFileSync(PYTHON,[path.join(__dirname,'docs_video_frames.py'),path.join(__dirname,'docs_video_scenes.json'),LOGS,frames],{stdio:'inherit'});
 const wanted=Object.entries(shots).flatMap(([theme,list])=>Object.entries(list).map(([file,scene])=>({theme,file,scene})))
  .filter(({theme,file})=>!ONLY||ONLY.includes(file+(theme==='dark'?'-dark':'')));
 const data={},videos={};
 for(const name of new Set(wanted.map(s=>s.scene))){
  data[name]=sceneData(name);videos[name]={};
  for(const camera of Object.keys(scenes[name].cameras)){
   const out=path.join(WORK,`${name}-${camera}.mp4`);stillVideo(path.join(frames,`${name}-${camera}.png`),data[name].duration,out);
   videos[name][camera]=fs.readFileSync(out);
  }
  videos[name].front??=videos[name].wide;videos[name].qcamera=videos[name].front;  // a wide-only scene never shows its front video
 }
 const track=await seoulRoute(),browser=await chromium.launch({headless:true});
 // Analysis tab and small map per file; the wide shot selects the wide camera.
 const LAYOUT={'roadviewer-overview':['telemetryTab'],'roadviewer-driving-view':['roadTab'],'roadviewer-wide-camera':['roadTab','wide'],
  'roadviewer-replay-map':['mapTab'],'roadviewer-video-minimap':['telemetryTab',null,true]};
 try{
  for(const {theme,file,scene} of wanted){
   const [tab,camera,mini]=LAYOUT[file],time=scenes[scene].time,suffix=theme==='dark'?'-dark':'';
   const context=await browser.newContext({viewport:{width:1440,height:1000},colorScheme:theme,timezoneId:'Asia/Seoul',locale:'ko-KR',reducedMotion:'reduce'});
   const page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
   await page.route('**/*',server(videos[scene],track,data[scene],logsFor(scenes[scene].evening?STARTS.evening:STARTS.day)));
   await page.goto('https://rv.test/view/seg0/');await page.locator('#play:enabled').waitFor();
   if(camera)await page.evaluate(c=>selectVideo(c),camera);
   await page.locator('#'+tab).waitFor({state:'visible'});await page.locator('#'+tab).click();
   if(mini){
    await page.locator('#overlayHeightSettings').click();const dialog=page.locator('#overlayHeightDialog');await dialog.waitFor();
    await dialog.locator('#videoMiniMap').check();await dialog.locator('#videoMiniMapPlain').check();
    await page.locator('#overlayHeightClose').click();await dialog.waitFor({state:'hidden'});await page.locator('#videoMap .map-car').waitFor();
   }
   await page.evaluate(t=>{pause();setTime(t)},time);
   await page.waitForFunction(()=>!video.seeking&&video.readyState>=2);
   if(tab==='telemetryTab')await page.locator('.telemetry-chart canvas').first().waitFor();
   if(tab==='mapTab')await page.locator('#routeMapView .map-car').waitFor();
   await settleLayout(page);
   if(tab==='mapTab'||mini)await page.waitForTimeout(4000);  // real tiles arrive and draw
   await page.waitForTimeout(1500);  // overlay fades settle
   const overlay=await page.locator('#videoOverlayToggle').getAttribute('aria-pressed');
   if(overlay!=='true')throw Error(file+': overlay is off');
   const target=path.join(OUT,file+suffix+'.png');
   if(mini)await page.locator('#videoStage').screenshot({path:target,animations:'disabled'});
   else await page.screenshot({path:target,animations:'disabled'});
   if(errors.length)throw Error(file+': '+errors.join('; '));
   console.log(`saved ${target} (${scene}, ${scenes[scene].log} at ${time} s)`);await context.close();
  }
 }finally{await browser.close();fs.rmSync(WORK,{recursive:true,force:true})}
})().catch(e=>{console.error(e);process.exitCode=1});
