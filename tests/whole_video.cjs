const fs=require('fs'),assert=require('node:assert/strict'),{chromium}=require('playwright');
// The browser stops reading ahead while paused; the page reads the whole video in the background and switches to
// that copy while paused, so every seek within the video is immediate. The copy's parts are asked with the
// whole-video header (the server answers them from its held copy), a new segment drops the copy of the old one, and a
// copy that cannot play falls back to the streamed video.
const video=fs.readFileSync(process.env.RV_TEST_VIDEO||'/tmp/roadviewer-test.mp4'),requests=[];
let failCopy=false;
const serve=route=>{
 const request=route.request(),p=new URL(request.url()).pathname;
 if(p.endsWith('/bookmarks'))return route.fulfill({json:{bookmarks:[]}});
 if(p==='/api/logs')return route.fulfill({json:{logs:[{id:'two',name:'00000395--0d0eda17c5 / 구간 8',status:'ready'},{id:'one',name:'00000395--0d0eda17c5 / 구간 7',status:'ready'}]}});
 if(p.endsWith('/video')){
  const whole=request.headers()['x-roadviewer-whole-video']==='1',range=/bytes=(\d+)-(\d*)/.exec(request.headers().range||'');
  requests.push({id:p.split('/')[3],whole,range:request.headers().range||null});
  if(whole&&failCopy)return route.fulfill({status:500,json:{error:'x'}});
  if(!range)return route.fulfill({body:video,contentType:'video/mp4',headers:{'Accept-Ranges':'bytes'}});
  // Parts of a quarter of the file at most, as a capped remote range would come.
  const start=+range[1],end=Math.min(video.length-1,range[2]?+range[2]:start+Math.ceil(video.length/4)-1);
  return route.fulfill({status:206,body:video.subarray(start,end+1),contentType:'video/mp4',headers:{'Accept-Ranges':'bytes','Content-Range':`bytes ${start}-${end}/${video.length}`}});
 }
 if(p.endsWith('/telemetry'))return route.fulfill({status:404,json:{error:'차량 정보 없음'}});
 if(p.endsWith('/data'))return route.fulfill({json:{route:'test',key:'k'+p.split('/')[3],duration:2,warnings:[],video:{start:0,duration:2},frames:[{t:0,id:0,valid:true,lanes:[],edges:[],lp:[],es:[],leads:[],liveTracksValid:false}]}});
 const name=p.startsWith('/view/')?'index.html':p.replace('/assets/','');
 return route.fulfill({body:fs.readFileSync('roadviewer/app/web/'+name),contentType:name.endsWith('.html')?'text/html':name.endsWith('.js')?'application/javascript':name.endsWith('.css')?'text/css':name.endsWith('.png')?'image/png':'image/svg+xml'});
};
(async()=>{
 const browser=await chromium.launch({headless:true});
 try{
  const page=await browser.newPage({viewport:{width:1280,height:800}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.route('https://rv.test/**',serve);await page.goto('https://rv.test/view/one/');
  await page.waitForFunction(()=>!document.getElementById('play').disabled);
  // Paused: switched to the whole copy, read in parts with the header.
  await page.waitForFunction(()=>document.getElementById('video').src.startsWith('blob:'),null,{timeout:10000});
  const parts=requests.filter(r=>r.whole);
  assert(parts.length>1&&parts.every(r=>r.id==='one'&&/^bytes=\d+-$/.test(r.range)),'the copy is read in parts: '+JSON.stringify(parts.slice(0,3)));
  // Seeks and playback work on the copy, without loading messages.
  for(const at of [1.5,.4]){
   await page.evaluate(at=>setTime(at),at);
   await page.waitForFunction(at=>{const v=document.getElementById('video');return !v.seeking&&Math.abs(v.currentTime-at)<.08},at,{timeout:5000});
  }
  assert.equal(await page.evaluate(()=>document.getElementById('play').disabled),false);
  await page.locator('#play').click();await page.waitForFunction(()=>!document.getElementById('video').paused);
  await page.locator('#play').click();
  // Another segment: the copy of the old one is not used there.
  const before=requests.length;
  await page.goto('https://rv.test/view/two/');await page.waitForFunction(()=>!document.getElementById('play').disabled);
  await page.waitForFunction(()=>document.getElementById('video').src.startsWith('blob:'),null,{timeout:10000});
  assert(requests.slice(before).filter(r=>r.whole).every(r=>r.id==='two'),'the new segment reads its own video');
  // A copy that cannot be read: the streamed video stays.
  failCopy=true;
  const third=await browser.newPage({viewport:{width:1280,height:800}});third.on('pageerror',e=>errors.push(e.message));
  await third.route('https://rv.test/**',serve);await third.goto('https://rv.test/view/one/');
  await third.waitForFunction(()=>!document.getElementById('play').disabled);await third.waitForTimeout(800);
  assert(!(await third.evaluate(()=>document.getElementById('video').src)).startsWith('blob:'),'no copy: streamed');
  await third.evaluate(()=>setTime(1.2));await third.waitForFunction(()=>{const v=document.getElementById('video');return !v.seeking&&Math.abs(v.currentTime-1.2)<.08});
  assert.deepEqual(errors,[]);
  console.log('PASS: paused video switches to a whole copy read in parts (whole-video header), seeks and plays on it, a new segment reads its own, an unreadable copy keeps the stream');
 }finally{await browser.close()}
})().catch(e=>{console.error(e);process.exit(1)});
