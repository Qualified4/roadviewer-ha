const fs=require('fs'),assert=require('node:assert/strict'),{chromium}=require('playwright');
(async()=>{
 const browser=await chromium.launch({headless:true});
 try{
  for(const scenario of [
   {name:'video longer',logStart:0,logEnd:1,videoStart:0,duration:2,probe:1.4},
   {name:'log longer',logStart:0,logEnd:3,videoStart:0,duration:3,probe:2.4},
   {name:'late video',logStart:0,logEnd:4,videoStart:1,duration:4,probe:.4},
   {name:'early video',logStart:1,logEnd:1.5,videoStart:0,duration:2,probe:.4},
   {name:'log only',logStart:0,logEnd:2,videoStart:null,duration:2,probe:.4}
  ]){
   const page=await browser.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
   const {logStart,logEnd,videoStart,duration,probe}=scenario;
   const data={route:'test',key:scenario.name,duration,logStart,logEnd,warnings:[],video:videoStart===null?null:{start:videoStart,duration:2},frames:Array.from({length:Math.round((logEnd-logStart)*20)+1},(_,i)=>({t:logStart+i/20,id:i,valid:true,lanes:[],edges:[],lp:[1,1,1,1],es:[0,0],leads:[],egoSpeedKph:50,liveTracksValid:false}))};
   await page.route('https://rv.test/**',route=>{
    const p=new URL(route.request().url()).pathname;
    if(p==='/api/logs')return route.fulfill({json:{logs:[]}});
    if(p.endsWith('/data'))return route.fulfill({json:data});
    if(p.endsWith('/video'))return route.fulfill({body:fs.readFileSync('/tmp/roadviewer-test.mp4'),contentType:'video/mp4'});
    const name=p.startsWith('/view/')?'index.html':p.replace('/assets/','');
    return route.fulfill({body:fs.readFileSync('roadviewer/app/web/'+name),contentType:name.endsWith('.js')?'application/javascript':name.endsWith('.css')?'text/css':name.endsWith('.png')?'image/png':name.endsWith('.svg')?'image/svg+xml':'text/html'});
   });
   await page.goto('https://rv.test/view/test/');await page.waitForFunction(()=>!document.getElementById('play').disabled);
   await page.evaluate(probe=>setTime(probe),probe);
   const inVideo=videoStart!==null&&probe>=videoStart&&probe<videoStart+2;
   assert.equal(await page.locator('#video').isVisible(),inVideo,scenario.name);
   assert.equal(await page.locator('#noVideo').isVisible(),!inVideo,scenario.name);
   if(probe<logStart||probe>logEnd){assert.equal(await page.locator('#left').textContent(),'—');assert.equal(await page.locator('#egoSpeed').textContent(),'—')}
   else assert.equal(await page.locator('#left').textContent(),'100.0%');
   // Run across both start and end boundaries at 4x.
   await page.evaluate(()=>setTime(0));await page.selectOption('#speed','4');await page.locator('#play').click();
   await page.waitForFunction(()=>!playing&&t>=data.duration-.001);
   assert.equal(await page.locator('#seek').inputValue(),String(duration));
   // Seeking back into video restores the image after the video-free tail.
   if(videoStart!==null){await page.evaluate(start=>setTime(start+.2),videoStart);assert(await page.locator('#video').isVisible())}
   assert.deepEqual(errors,[]);await page.close();
  }
  console.log('PASS: longer video/log, offset starts, no-video gaps, full playback and seek at 4x, missing log readouts hidden');
 }finally{await browser.close()}
})().catch(e=>{console.error(e);process.exitCode=1});
