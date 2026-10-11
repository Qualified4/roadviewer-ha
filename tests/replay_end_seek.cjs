const fs=require('fs'),assert=require('node:assert/strict'),{chromium}=require('playwright');
(async()=>{
 const browser=await chromium.launch({headless:true});
 try{
  const page=await browser.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
  const data={route:'play request test',key:'play-request',duration:2.15,warnings:[],video:{start:0,duration:2,frames:20},frames:Array.from({length:44},(_,i)=>({t:i/20,id:i,valid:true,lanes:[],edges:[],lp:[],es:[],leads:[]}))};
  await page.route('https://rv.test/**',route=>{
   const p=new URL(route.request().url()).pathname;
   if(p.endsWith('/bookmarks'))return route.fulfill({json:{bookmarks:[]}});
   if(p==='/api/logs')return route.fulfill({json:{logs:[]}});
   if(p.endsWith('/data'))return route.fulfill({json:data});
   if(p.endsWith('/video'))return route.fulfill({body:fs.readFileSync((process.env.RV_TEST_VIDEO||'/tmp/roadviewer-test.mp4')),contentType:'video/mp4'});
   const name=p.startsWith('/view/')?'index.html':p.replace('/assets/','');
   return route.fulfill({body:fs.readFileSync('roadviewer/app/web/'+name),contentType:name.endsWith('.js')?'application/javascript':name.endsWith('.css')?'text/css':name.endsWith('.html')?'text/html':name.endsWith('.png')?'image/png':'image/svg+xml'});
  });
  await page.goto('https://rv.test/view/test/');await page.waitForFunction(()=>!document.getElementById('play').disabled);
  const result=await page.evaluate(async()=>{
   pause();const oldVideo=data.video,oldDuration=data.duration,raf=window.requestAnimationFrame;window.requestAnimationFrame=()=>0;
   let mediaTime=2,seeking=false,ended=true,paused=true,ready=2,restarts=0,plays=0,writes=0;
   Object.defineProperties(v,{
    duration:{configurable:true,get:()=>2},currentTime:{configurable:true,get:()=>mediaTime,set:value=>{mediaTime=value>=1.999?2:value;seeking=true;ready=2;ended=mediaTime>=2;writes++}},
    seeking:{configurable:true,get:()=>seeking},ended:{configurable:true,get:()=>ended},readyState:{configurable:true,get:()=>ready},paused:{configurable:true,get:()=>paused},
    pause:{configurable:true,value:()=>{paused=true}},play:{configurable:true,value:()=>{plays++;if(ended){restarts++;mediaTime=0;ended=false}paused=false;return Promise.resolve()}}
   });
   const settle=async()=>{seeking=false;v.dispatchEvent(new Event('seeked'));await Promise.resolve();await Promise.resolve();await Promise.resolve()};
   try{
    data.duration=2;data.video={start:0,duration:2.02,frames:20};playing=true;seekPointer=7;
    setTime(2);await settle();window.dispatchEvent(new PointerEvent('pointerup',{pointerId:7}));
    for(let i=0;i<5;i++){await settle();tick(last+16)}
    const end={restarts,plays,playing,paused,time:mediaTime,t,writes};
    data.duration=2.15;data.video={start:0,duration:2,frames:20};seekPointer=7;playing=true;mediaTime=2;ended=true;seeking=false;
    const writesBefore=writes;setTime(2.15);for(let i=0;i<5;i++)await settle();const repeatedEndSeeks=writes-writesBefore;
    seekPointer=null;
    // Ended media without future frames must not freeze the log clock while waiting for readyState 3.
    data.duration=2.4;data.video={start:0,duration:2.05,frames:20};playing=true;t=1.99;pendingVideoSeek=null;seeking=false;ended=true;mediaTime=2;ready=2;
    tick(last+100);const shortVideo={t,restarts};
    // A pending backward seek must settle before playback resumes.
    seekPointer=null;playing=true;setTime(.5);const before=plays;syncVideo();const seekingPlays=plays-before;ready=4;await settle();const resumed=plays>before;
    return {end,shortVideo,seekingPlays,resumed,repeatedEndSeeks};
   }finally{
    for(const key of ['duration','currentTime','seeking','ended','readyState','paused','play','pause'])delete v[key];
    data.video=oldVideo;data.duration=oldDuration;window.requestAnimationFrame=raf;pendingVideoSeek=null;seekPointer=null;pause();
   }
  });
  assert.equal(result.end.restarts,0,'end seek must never restart the video at frame zero');
  assert(!result.end.playing&&result.end.paused,'drag release at log end stops playback');
  assert.equal(result.repeatedEndSeeks,0,'rounded final frame must not trigger endless seeked requests');assert.equal(result.end.time,2);assert.equal(result.end.t,2);
  assert(result.shortVideo.t>1.99,'ended video cannot stall the log clock');
  assert.equal(result.shortVideo.restarts,0);assert.equal(result.seekingPlays,0);assert(result.resumed,'backward seek resumes only after seeked');
  assert.deepEqual(errors,[]);console.log('PASS: end seek with duration rounding, delayed seeked, ended media and backward resume');
 }finally{await browser.close()}
})().catch(e=>{console.error(e);process.exitCode=1});
