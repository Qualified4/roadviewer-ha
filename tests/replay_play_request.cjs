const fs=require('fs'),assert=require('node:assert/strict'),{chromium}=require('playwright');
(async()=>{
 const browser=await chromium.launch({headless:true});
 try{
  const page=await browser.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
  const data={route:'play request test',key:'play-request',duration:2.15,warnings:[],video:{start:0,duration:2,frames:20},frames:Array.from({length:44},(_,i)=>({t:i/20,id:i,valid:true,lanes:[],edges:[],lp:[],es:[],leads:[]}))};
  await page.route('https://rv.test/**',route=>{
   const p=new URL(route.request().url()).pathname;
   if(p==='/api/logs')return route.fulfill({json:{logs:[]}});
   if(p.endsWith('/data'))return route.fulfill({json:data});
   if(p.endsWith('/video'))return route.fulfill({body:fs.readFileSync((process.env.RV_TEST_VIDEO||'/tmp/roadviewer-test.mp4')),contentType:'video/mp4'});
   const name=p.startsWith('/view/')?'index.html':p.replace('/assets/','');
   return route.fulfill({body:fs.readFileSync('roadviewer/app/web/'+name),contentType:name.endsWith('.js')?'application/javascript':name.endsWith('.css')?'text/css':name.endsWith('.html')?'text/html':name.endsWith('.png')?'image/png':'image/svg+xml'});
  });
  await page.goto('https://rv.test/view/test/');await page.waitForFunction(()=>!document.getElementById('play').disabled);
  for(const scenario of ['end-hold','pause','pause-resume','resolved-after-pause','NotAllowedError','NotSupportedError','AbortError']){
   const result=await page.evaluate(async scenario=>{
    pause();showError('');setTime(1);const originalPlay=v.play;let rejectPlay,resolvePlay;
    v.play=()=>new Promise((resolve,reject)=>{resolvePlay=resolve;rejectPlay=reject});
    playing=true;syncVideo();const pending=videoPlayPending;
    if(scenario==='end-hold')setTime(2);
    if(['pause','pause-resume','resolved-after-pause'].includes(scenario))pause();
    if(scenario==='pause-resume')toggle();
    if(scenario==='resolved-after-pause')resolvePlay();
    else rejectPlay(new DOMException('test '+scenario,scenario.endsWith('Error')?scenario:'AbortError'));
    await Promise.resolve();await Promise.resolve();await Promise.resolve();
    const result={pending,error:document.getElementById('error').textContent,hidden:document.getElementById('error').hidden,playing,paused:v.paused,settled:!videoPlayPending};
    v.play=originalPlay;pause();return result;
   },scenario);
   assert(result.pending&&result.settled,scenario);
   if(scenario.endsWith('Error')){assert(!result.hidden&&result.error.includes(scenario),scenario+' genuine failure remains visible');assert.equal(result.playing,false)}
   else{assert(result.hidden,scenario+' intentional interruption must not become an error');assert.equal(result.playing,['end-hold','pause-resume'].includes(scenario));assert(result.paused)}
  }
  await page.evaluate(()=>{showError('');setTime(0);toggle()});await page.waitForFunction(()=>v.currentTime>.1);await page.evaluate(()=>pause());
  assert.deepEqual(errors,[]);console.log('PASS: pending play cancellation at end/pause/resume, late resolution, real failures and subsequent playback');
 }finally{await browser.close()}
})().catch(e=>{console.error(e);process.exitCode=1});
