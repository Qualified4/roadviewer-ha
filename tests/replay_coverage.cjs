const fs=require('fs'),assert=require('node:assert/strict'),{chromium}=require('playwright');
(async()=>{
 const browser=await chromium.launch({headless:true});
 try{
  for(const scenario of [
   {name:'model edge gaps',logStart:.05,logEnd:1.95,videoStart:0,duration:2,probe:0},
   {name:'model tail rounding',logStart:0,logEnd:1.85,videoStart:0,duration:2,probe:1.99,keepModelEnd:true},
   {name:'missing model tail frames',logStart:0,logEnd:1.85,videoStart:0,duration:2,probe:1.99,missingTail:true},
   {name:'real short model log',logStart:0,logEnd:1.7,videoStart:0,duration:2,probe:1.99},
   {name:'matching end',logStart:0,logEnd:2,videoStart:0,duration:2,probe:1.4},
   {name:'video tail rounding',logStart:0,logEnd:2.2,videoStart:0,duration:2.2,probe:2.15,keepVideoEnd:true},
   {name:'real short video',logStart:0,logEnd:2.3,videoStart:0,duration:2.3,probe:2.25},
   {name:'tiny tail',logStart:0,logEnd:2.05,videoStart:0,duration:2.05,probe:1.4},
   {name:'video longer',logStart:0,logEnd:1,videoStart:0,duration:2,probe:1.4},
   {name:'log longer',logStart:0,logEnd:3,videoStart:0,duration:3,probe:2.4},
   {name:'video start rounding',logStart:0,logEnd:2.05,videoStart:.05,duration:2.05,probe:0,keepVideoStart:true},
   {name:'video start tolerance limit',logStart:0,logEnd:2.1,videoStart:.1,duration:2.1,probe:0,keepVideoStart:true},
   {name:'real video start gap',logStart:0,logEnd:2.15,videoStart:.10001,duration:2.15,probe:0},
   {name:'late video',logStart:0,logEnd:4,videoStart:1,duration:4,probe:.4},
   {name:'early video',logStart:1,logEnd:1.5,videoStart:0,duration:2,probe:.4},
   {name:'log only',logStart:0,logEnd:2,videoStart:null,duration:2,probe:.4}
  ]){
   const page=await browser.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
   const {logStart,logEnd,videoStart,duration,probe}=scenario;
   const data={route:'test',key:scenario.name,duration,logStart,logEnd,warnings:[],video:videoStart===null?null:{start:videoStart,duration:2,frames:20},frames:Array.from({length:Math.round((logEnd-logStart)*20)+1},(_,i)=>({t:logStart+i/20,id:i,valid:true,lanes:[],edges:[],lp:[1,1,1,1],es:[0,0],leads:[],egoSpeedKph:50,liveTracksValid:false}))};
   if(scenario.missingTail)data.frames=data.frames.filter(f=>f.t<1.65||f.t>=1.85);
   await page.route('https://rv.test/**',route=>{
    const p=new URL(route.request().url()).pathname;
    if(p==='/api/logs')return route.fulfill({json:{logs:[]}});
    if(p.endsWith('/data'))return route.fulfill({json:data});
    if(p.endsWith('/video')){
     const body=fs.readFileSync((process.env.RV_TEST_VIDEO||'/tmp/roadviewer-test.mp4')),range=/^bytes=(\d+)-(\d*)$/.exec(route.request().headers().range||'');
     if(range){
      const start=Number(range[1]),end=range[2]?Math.min(Number(range[2]),body.length-1):body.length-1;
      return route.fulfill({status:206,body:body.subarray(start,end+1),contentType:'video/mp4',headers:{'Accept-Ranges':'bytes','Content-Range':`bytes ${start}-${end}/${body.length}`}});
     }
     return route.fulfill({body,contentType:'video/mp4',headers:{'Accept-Ranges':'bytes'}});
    }
    const name=p.startsWith('/view/')?'index.html':p.replace('/assets/','');
    return route.fulfill({body:fs.readFileSync('roadviewer/app/web/'+name),contentType:name.endsWith('.js')?'application/javascript':name.endsWith('.css')?'text/css':name.endsWith('.png')?'image/png':name.endsWith('.svg')?'image/svg+xml':'text/html'});
   });
   await page.goto('https://rv.test/view/test/');await page.waitForFunction(()=>!document.getElementById('play').disabled);
   if(scenario.keepVideoStart){
    assert(await page.locator('#video').isVisible(),scenario.name+' initial frame');
    assert(await page.locator('#noVideo').isHidden());
    await page.waitForFunction(()=>!v.seeking&&v.readyState>=2);
    assert.deepEqual(await page.evaluate(()=>({time:v.currentTime,paused:v.paused,t})),{time:0,paused:true,t:0});
    const first=await page.evaluate(()=>{
     const raf=window.requestAnimationFrame;window.requestAnimationFrame=()=>0;
     try{toggle();tick(last+data.video.start*500);return {t,paused:v.paused,time:v.currentTime,playing}}
     finally{pause();window.requestAnimationFrame=raf}
    });
    assert.equal(first.t,videoStart/2,'the log clock must advance while holding the first video frame');
    assert.equal(first.paused,true);assert.equal(first.time,0);assert.equal(first.playing,true);
   }
   await page.evaluate(probe=>setTime(probe),probe);
   const inVideo=videoStart!==null&&(probe>=videoStart||scenario.keepVideoStart===true)&&(probe<videoStart+2||scenario.keepVideoEnd===true);
   assert.equal(await page.locator('#video').isVisible(),inVideo,scenario.name);
   assert.equal(await page.locator('#noVideo').isVisible(),!inVideo,scenario.name);
   if(!scenario.keepModelEnd&&(probe<logStart-.100001||probe>logEnd+.100001)){assert.equal(await page.locator('#left').textContent(),'—');assert.equal(await page.locator('#egoSpeed').textContent(),'—')}
   else assert.equal(await page.locator('#left').textContent(),'100.0%');
   // Range input must preserve both paused and playing states.
   const seekTo=async value=>page.evaluate(value=>{
    const seek=document.getElementById('seek');seek.value=value;seek.dispatchEvent(new Event('input',{bubbles:true}));
    return {playing,t};
   },value);
   assert.deepEqual(await seekTo(.3),{playing:false,t:.3},scenario.name+' paused seek');
   await page.waitForTimeout(150);
   assert.equal(await page.evaluate(()=>t),.3,scenario.name+' remains paused');
   await page.locator('#play').click();
   await page.waitForFunction(()=>playing&&t>.35);
   assert.deepEqual(await seekTo(.6),{playing:true,t:.6},scenario.name+' playing seek');
   await page.waitForFunction(()=>playing&&t>.7);
   assert.deepEqual(await seekTo(.2),{playing:true,t:.2},scenario.name+' backward seek');
   await page.waitForFunction(()=>playing&&t>.3);
   assert.equal(await page.locator('#play').textContent(),'일시정지');
   await page.locator('#play').click();
   assert.deepEqual(await seekTo(.5),{playing:false,t:.5},scenario.name+' paused again');
   await page.waitForTimeout(150);
   assert.equal(await page.evaluate(()=>t),.5);
   await page.evaluate(()=>{pause();setTime(data.duration-.0005)});
   await page.waitForFunction(()=>!v.seeking&&(v.readyState>=3||!videoAvailable()||finalVideoFrame()));
   const boundary=await page.evaluate(()=>{
    playing=true;last=performance.now();
    const schedule=window.requestAnimationFrame;window.requestAnimationFrame=()=>0;
    try{tick(last)}finally{window.requestAnimationFrame=schedule}
    return {time:t,playing,seek:document.getElementById('seek').value};
   });
   assert.deepEqual(boundary,{time:duration,playing:false,seek:String(duration)},scenario.name+' snaps the final sub-millisecond to the endpoint');
   // Run across both start and end boundaries at 4x.
   await page.evaluate(()=>setTime(0));await page.selectOption('#speed','4',{force:true});await page.locator('#play').click();
   await page.waitForFunction(()=>!playing&&t>=data.duration-.001);
   assert.equal(await page.locator('#seek').inputValue(),String(duration));
   const withinLogEdge=scenario.keepModelEnd||duration>=logStart-.100001&&duration<=logEnd+.100001;
   assert.equal(await page.locator('#left').textContent(),withinLogEdge?'100.0%':'—',scenario.name+' final model readout');
   if(scenario.keepModelEnd){
    assert.equal(await page.evaluate(()=>frameAvailable(data.frames[idx])),true);
    await page.evaluate(()=>{data.frames[idx].valid=false;render()});assert.equal(await page.locator('#left').textContent(),'—','holding the last frame must not validate invalid data');
    assert.equal(await page.evaluate(()=>missingModelMessage()),'이 시점의 유효한 모델 데이터 없음');
    await page.evaluate(()=>{data.frames[idx].valid=true;render()});
    await seekTo(0);await seekTo(duration);assert.equal(await page.locator('#left').textContent(),'100.0%','seek to end should preserve the last model frame');
   }
   if(scenario.missingTail||scenario.name==='real short model log')assert.equal(await page.evaluate(()=>missingModelMessage()),'로그 데이터가 종료된 구간입니다.');
   if(scenario.name==='model edge gaps'){
    assert((await page.locator('#frame').textContent()).includes('38'));
    // Edge tolerance must not turn invalid model messages into valid data.
    await page.evaluate(()=>{data.frames[idx].valid=false;render()});
    assert.equal(await page.locator('#left').textContent(),'—');
    await page.evaluate(()=>{data.frames[idx].valid=true;render()});
   }
   const keepLast=videoStart!==null&&Math.abs(duration-(videoStart+2))<=.25;
   assert.equal(await page.locator('#video').isVisible(),keepLast,scenario.name+' end visibility');
   if(keepLast){
    await page.waitForFunction(()=>!document.getElementById('video').seeking);
    const endState=await page.evaluate(()=>({paused:v.paused,time:v.currentTime,duration:v.duration,ready:v.readyState}));
    // The 10fps fixture's final displayed frame starts 0.1s before duration.
    assert(endState.paused&&endState.time>=endState.duration-.101,JSON.stringify(endState));
    assert(await page.locator('#noVideo').isHidden());
    await seekTo(0);await seekTo(duration);
    assert(await page.locator('#video').isVisible());
   }else if(videoStart!==null){
    assert((await page.locator('#noVideo').textContent()).includes('영상이 종료'));
   }
   if(videoStart>0){
    await seekTo(0);
    if(scenario.keepVideoStart){
     await page.waitForFunction(()=>!v.seeking&&pendingVideoSeek===null);
     assert(await page.locator('#video').isVisible());assert(await page.locator('#noVideo').isHidden());
     assert.deepEqual(await page.evaluate(()=>({time:v.currentTime,paused:v.paused})),{time:0,paused:true},'seek back must restore the first frame');
    }else{
     assert(await page.locator('#video').isHidden());
     assert.equal(await page.locator('#noVideo').textContent(),'아직 영상이 시작되지 않은 구간입니다.');
     await seekTo(videoStart-.01);assert(await page.locator('#video').isHidden(),'a real gap must not be shortened near its endpoint');
    }
   }
   // Seeking back into video restores the image after the video-free tail.
   if(videoStart!==null){await page.evaluate(start=>setTime(start+.2),videoStart);assert(await page.locator('#video').isVisible())}
   if(scenario.name==='matching end'){
    // A cached frame may finish seeking while the pointer is still held.
    await page.evaluate(()=>{pause();$('speed').value='1';v.playbackRate=1;setTime(.5)});
    await page.waitForFunction(()=>!v.seeking&&v.readyState>=3);
    await page.evaluate(()=>toggle());
    const bar=await page.locator('#seek').boundingBox();
    await page.mouse.move(bar.x+bar.width*.25,bar.y+bar.height/2);await page.mouse.down();
    await page.mouse.move(bar.x+bar.width*.6,bar.y+bar.height/2,{steps:5});
    await page.waitForFunction(()=>!v.seeking&&pendingVideoSeek===null);
    const held=await page.evaluate(()=>t);await page.waitForTimeout(100);
    assert.equal(await page.evaluate(()=>t),held,'holding the pointer freezes automatic time');
    assert(await page.evaluate(()=>v.paused),'cached video must stay paused until pointer release');
    await page.mouse.up();await page.waitForFunction(time=>playing&&t>time+.02,held);await page.evaluate(()=>pause());
    // Slow decoder: currentTime changes immediately, but the displayed frame waits for seeked.
    const result=await page.evaluate(()=>{
     pause();$('speed').value='1';const raf=window.requestAnimationFrame;window.requestAnimationFrame=()=>0;
     let mediaTime=0,decoded=0,seeking=false,ready=4,paused=true,writes=[];
     Object.defineProperties(v,{
      currentTime:{configurable:true,get:()=>mediaTime,set:value=>{mediaTime=value;seeking=true;ready=1;writes.push(value)}},
      seeking:{configurable:true,get:()=>seeking},readyState:{configurable:true,get:()=>ready},paused:{configurable:true,get:()=>paused},
      play:{configurable:true,value:()=>{paused=false;return Promise.resolve()}},pause:{configurable:true,value:()=>{paused=true}}
     });
     const input=time=>{const bar=$('seek');bar.value=time;bar.dispatchEvent(new Event('input'))};
     const frame=ms=>tick(last+ms),finish=()=>{decoded=mediaTime;seeking=false;ready=4;v.dispatchEvent(new Event('seeked'));v.dispatchEvent(new Event('canplay'))};
     const samples=[];
     try{
      for(const intent of [false,true]){
       pendingVideoSeek=null;mediaTime=0;decoded=0;seeking=false;ready=4;writes=[];playing=intent;paused=!intent;t=0;
       $('seek').dispatchEvent(new PointerEvent('pointerdown',{pointerId:7,button:0}));
       input(.5);frame(800);input(1.2);frame(800);input(.8);frame(800);
       samples.push({stage:'drag',intent,t,playing,writes:[...writes],decoded});
       window.dispatchEvent(new PointerEvent('pointerup',{pointerId:7}));frame(800);
       samples.push({stage:'released',intent,t,playing,writes:[...writes]});
       finish();frame(800);samples.push({stage:'latest',intent,t,writes:[...writes],decoded});
       finish();samples.push({stage:'ready',intent,t,playing,decoded});
       frame(20);samples.push({stage:'resumed',intent,t,playing});
       $('seek').dispatchEvent(new PointerEvent('pointerdown',{pointerId:8,button:0}));
       window.dispatchEvent(new PointerEvent('pointercancel',{pointerId:8}));
       samples.push({stage:'cancel',intent,playing,pointer:seekPointer});
      }
      // Buffering must not advance the log, but real video-free intervals must still play.
      pendingVideoSeek=null;seeking=false;ready=2;playing=true;t=1;frame(1500);samples.push({stage:'buffering',t});
      ready=4;v.dispatchEvent(new Event('canplay'));mediaTime=t;frame(20);samples.push({stage:'buffered',t});
      const original=data.video;data.video={...original,start:1};t=.2;ready=1;seeking=true;frame(100);samples.push({stage:'no-video',t});data.video=original;
      return samples;
     }finally{
      for(const key of ['currentTime','seeking','readyState','paused','play','pause'])delete v[key];
      window.requestAnimationFrame=raf;pendingVideoSeek=null;seekPointer=null;pause();
     }
    });
    for(const intent of [false,true]){
     const get=stage=>result.find(x=>x.stage===stage&&x.intent===intent);
     assert.deepEqual(get('drag'),{stage:'drag',intent,t:.8,playing:intent,writes:[.5],decoded:0});
     assert.deepEqual(get('released').writes,[.5]);assert.equal(get('released').t,.8);
     assert.deepEqual(get('latest').writes,[.5,.8]);assert.equal(get('latest').t,.8);assert.equal(get('latest').decoded,.5);
     assert.equal(get('cancel').pointer,null);assert.equal(get('cancel').playing,intent);
     assert.equal(get('ready').decoded,.8);assert.equal(get('ready').playing,intent);
     assert(Math.abs(get('resumed').t-(intent?.82:.8))<1e-6,'resume without counting time spent waiting');
    }
    assert.equal(result.find(x=>x.stage==='buffering').t,1);
    assert(Math.abs(result.find(x=>x.stage==='buffered').t-1.02)<1e-6);
    assert(Math.abs(result.find(x=>x.stage==='no-video').t-.3)<1e-6);
   }
   assert.deepEqual(errors,[]);await page.close();
  }
  console.log('PASS: longer video/log, offset starts, no-video gaps, playback state preserved on seek, full playback and seek at 4x, missing log readouts hidden');
 }finally{await browser.close()}
})().catch(e=>{console.error(e);process.exitCode=1});
