// Offline visual review, including a generated colourful video (no downloads).
const fs=require('fs'),path=require('path'),assert=require('node:assert/strict'),{chromium}=require('playwright');
const {settleLayout}=require('./browser-helpers.cjs');
const shots=process.env.RV_FINAL_SHOTS||require('path').join(require('os').tmpdir(),'roadviewer-glass-shots');
const videoFile='tests/fixtures/ui-review-colour.mp4';
if(!fs.existsSync(videoFile))require('child_process').execFileSync(process.env.RV_PYTHON||'python',['-c',`import av, numpy as np, sys
with av.open(sys.argv[1], 'w') as out:
 stream=out.add_stream('libx264', rate=20);stream.width=640;stream.height=360;stream.pix_fmt='yuv420p'
 y,x=np.mgrid[:360,:640]
 for i in range(80):
  pixels=np.stack(((x+i*4)%256,(y*2+i*3)%256,160+60*np.sin(x/90+i/10)+y*0),axis=2).astype('uint8')
  frame=av.VideoFrame.from_ndarray(pixels,format='rgb24')
  for packet in stream.encode(frame):out.mux(packet)
 for packet in stream.encode():out.mux(packet)
`,videoFile]);
const times=Array.from({length:81},(_,i)=>i/20),values=fn=>times.map(fn);
const carState={speed:values(t=>62+Math.sin(t*2)*3),clusterSpeed:values(t=>63+Math.sin(t*2)*3),cruiseSpeed:values(()=>70),acceleration:values(t=>Math.sin(t*3)*.6),gas:values(t=>10+Math.sin(t)*3),brake:values(()=>0),steeringAngle:values(t=>Math.sin(t*2)*4),steeringPressed:values(t=>t>=1.55&&t<2.4),gasPressed:values(()=>false),brakePressed:values(()=>false)};
const telemetry={duration:4,maxGap:.2,streams:{carState:{times,values:carState},carControl:{times,values:{enabled:values(t=>t<2.8),latActive:values(()=>true),longActive:values(()=>true),targetAngle:values(t=>Math.sin(t*2+.1)*4),targetAcceleration:values(t=>Math.sin(t*3+.3)*.6)}}}};
const points=y=>Array.from({length:26},(_,i)=>[i*2,y+Math.sin(i/15)*.25]);
const frames=times.map((t,id)=>({t,id,valid:true,egoSpeedKph:62+Math.sin(t*2)*3,steering:t>=1.55&&t<2.4?{state:'driver',active:true,pressed:true,angle:Math.sin(t*2)*4,torque:.3,color:[255,255,255]}:{state:'active',active:true,pressed:false,angle:Math.sin(t*2)*4,torque:.3,color:[91,227,174]},position:points(0),lanes:[-5.4,-1.8,1.8,5.4].map(points),edges:[points(-7),points(7)],lp:[.3,.97,.95,.25],es:[.3,.4],laneY0:[-5.4,-1.8,1.8,5.4],edgeY0:[-7,7],leads:[{x:33,y:.2,p:.95,speedKph:60}],selected:{x:33,y:.2,radar:true,speedKph:60},radarTargets:[{group:'left',index:0,x:22,y:-3.6,yRel:3.6,vRel:-.4,trackId:12,radar:true},{group:'right',index:0,x:42,y:3.6,yRel:-3.6,vRel:.1,trackId:18,radar:true}],liveTracksValid:true,liveTracksDeltaMs:3,liveTracks:[{trackId:12,x:22,y:-3.6,yRel:3.6,vRel:-.4,measured:true,source:'radar',trackState:'tracked'}],overlay:{lanes:[],edges:[],path:[],markers:[]},ccncRoad:{laneLeft:8,laneRight:2},ccncTargets:[],ccncRearTargets:[]}));
const replay={route:'0000041b--a1b2c3d4e5',key:'glass-preview',duration:4,warnings:[],video:{start:0,duration:4},videos:{front:{start:0,duration:4},qcamera:{start:0,duration:4}},frames};
const now=Date.now()/1000,logs=Array.from({length:4},(_,i)=>({id:i?'two'+i:'one',name:`0000041b--a1b2c3d4e5 / 구간 ${i}`,status:i===3?'processing':'ready',uploaded:now,started_at:now-400+i*60,duration:60,bytes:12000000,prepared_bytes:30000000,video:true,pinned:false,tags:[{name:'고속도로',color:'blue'}],drive_summary:{engaged_ratio:.92,takeovers:2},storage_locations:{rlog:'local',front:'local'},progress:i===3?{stage:'video_convert',percent:55}:undefined}));
// Two more drives so the library scrolls under its floating bars.
for(const [r,route] of [[1,'0000042a--b2c3d4e5f6'],[2,'0000043c--c3d4e5f6a7']])for(let i=0;i<4;i++)logs.push({id:`r${r}s${i}`,name:`${route} / 구간 ${i}`,status:'ready',uploaded:now,started_at:now-90000*r+i*60,duration:60,bytes:12000000,prepared_bytes:30000000,video:true,pinned:r===2,tags:r===1?[{name:'시내',color:'green'}]:[],drive_summary:{engaged_ratio:.7+r/10,takeovers:r},storage_locations:{rlog:'local',front:r===2?'drive':'local'}});
async function serve(route){
 const url=new URL(route.request().url()),p=url.pathname;
 if(p.endsWith('/video')){
  const body=fs.readFileSync(videoFile),range=/^bytes=(\d+)-(\d*)$/.exec(route.request().headers().range||'');
  if(range){const start=Number(range[1]),end=range[2]?Math.min(Number(range[2]),body.length-1):body.length-1;return route.fulfill({status:206,body:body.subarray(start,end+1),contentType:'video/mp4',headers:{'Accept-Ranges':'bytes','Content-Range':`bytes ${start}-${end}/${body.length}`}})}
  return route.fulfill({body,contentType:'video/mp4'});
 }
 if(p.endsWith('/data'))return route.fulfill({json:replay});
 if(p.endsWith('/telemetry'))return route.fulfill({json:telemetry});
 if(p.endsWith('/bookmarks'))return route.fulfill({json:{bookmarks:[{id:'preview',time:1.3,title:'차선 합류 확인',note:'주변 차량과의 간격을 확인합니다.'}]}});
 if(p==='/api/logs')return route.fulfill({json:{logs,concurrency:1,auto_convert:true,max_upload_mb:512}});
 if(p==='/api/settings/storage')return route.fulfill({json:{used_bytes:2.1*1024**3,max_bytes:4*1024**3,free_bytes:8*1024**3,reserved_bytes:0,policy:'reject_new',archive:{enabled:false}}});
 if(p.startsWith('/api/'))return route.fulfill({json:{progress:{}}});
 const name=p==='/'?'library.html':p.startsWith('/view/')?'index.html':p.replace('/assets/','');
 const type=name.endsWith('.html')?'text/html':name.endsWith('.js')?'application/javascript':name.endsWith('.css')?'text/css':name.endsWith('.woff2')?'font/woff2':name.endsWith('.png')?'image/png':'image/svg+xml';
 return route.fulfill({body:fs.readFileSync(path.join('roadviewer/app/web',name)),contentType:type});
}
async function assertFlatControls(page){
 // As in the design: raised buttons are lit gradients with a soft ring and shadow, never a hard outline.
 const controls=await page.locator('button').evaluateAll(es=>es.filter(e=>e.getBoundingClientRect().width).map(e=>{const c=getComputedStyle(e);return {id:e.id||e.className||e.getAttribute('aria-label')||e.textContent.trim().slice(0,24)||e.parentElement.className,image:c.backgroundImage,shadow:c.boxShadow,border:c.borderTopStyle!=='none'&&parseFloat(c.borderTopWidth)>0&&!/rgba\(0, 0, 0, 0\)|transparent/.test(c.borderTopColor)}}));
 assert(controls.some(e=>/gradient/.test(e.image)),'raised buttons use the lit gradient');
 {const flat=controls.filter(e=>/gradient/.test(e.image)&&e.shadow==='none').map(e=>e.id);assert.deepEqual(flat,[],'raised buttons keep their depth: '+JSON.stringify(flat))}
 {const lined=controls.filter(e=>e.border).map(e=>e.id);assert.deepEqual(lined,[],'no hard outlines on buttons: '+JSON.stringify(lined))}
}
(async()=>{
 fs.mkdirSync(shots,{recursive:true});const browser=await chromium.launch({headless:true});
 try{
  for(const theme of ['dark','light'])for(const width of [1300,390]){
   const page=await browser.newPage({viewport:{width,height:1000},colorScheme:theme}),errors=[];
   page.on('pageerror',e=>errors.push(e.message));await page.route('**/*',serve);
   await page.goto('https://rv.test/view/one/');await page.locator('#play:enabled').waitFor();
   await page.evaluate(()=>setTime(1.7));await page.waitForFunction(()=>!video.seeking);
   assert.equal(await page.locator('#videoAmbient,.ambient-clip').count(),0,'no ambient glow');
   assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'no horizontal overflow '+width);
   // The card follows the page theme; the floating transport bar is a theme glass pane; only the picture stays dark.
   const card=await page.evaluate(()=>({card:getComputedStyle(document.querySelector('.camera-panel')).backgroundColor,bar:getComputedStyle(document.querySelector('.playback')).backgroundColor,text:getComputedStyle(document.getElementById('time')).color,stage:getComputedStyle(document.querySelector('.video-wrap')).backgroundColor}));
   // Over-video glass follows the screen mode; static cards sit on the page without a lit top edge.
   const hud=await page.evaluate(()=>{const e=getComputedStyle(document.querySelector('.ego-speed'));return {text:getComputedStyle(document.getElementById('logSegmentChoice')).color,bg:getComputedStyle(document.getElementById('logSegmentChoice')).backgroundColor,speed:e.backgroundColor,card:getComputedStyle(document.querySelector('.road-panel')).boxShadow}});
   assert.equal(hud.text,theme==='light'?'rgb(20, 23, 28)':'rgb(242, 244, 246)','over-video text follows the theme');assert.equal(hud.speed,'rgba(0, 0, 0, 0)','speed has no pill');
   assert.equal(hud.bg,theme==='light'?'rgba(255, 255, 255, 0.6)':'rgba(18, 20, 24, 0.22)','over-video glass is lighter than the floating bars');
   // Over-video text is crisp (no halo) and every pill keeps 4.5:1 against its own fill.
   const crisp=await page.evaluate(()=>[...document.querySelectorAll('.video-wrap .glass,.video-wrap .glass *,.video-tools .rv-choice-trigger')].filter(e=>getComputedStyle(e).textShadow!=='none').map(e=>e.id||e.className));
   assert.deepEqual(crisp,[],'no text halo over the video');
   const contrast=await page.evaluate(()=>{
    const rgba=c=>{const m=c.match(/[\d.]+/g).map(Number);return [m[0],m[1],m[2],m[3]??1]},over=(top,base)=>top.slice(0,3).map((v,i)=>v*top[3]+base[i]*(1-top[3]));
    const lum=c=>{const [r,g,b]=c.map(v=>{v/=255;return v<=.03928?v/12.92:((v+.055)/1.055)**2.4});return .2126*r+.7152*g+.0722*b},ratio=(a,b)=>{const [x,y]=[lum(a),lum(b)].sort((p,q)=>q-p);return (x+.05)/(y+.05)};
    const pill=getComputedStyle(document.getElementById('logSegmentChoice')),fill=rgba(pill.backgroundColor),bright=Number(/brightness\(([\d.]+)\)/.exec(pill.backdropFilter)?.[1]??1),worst=[];
    for(const sel of ['#titleText','#titleCount','#videoSourceChoice','#videoOverlayToggle','#overlayStatus'])for(const e of document.querySelectorAll(sel)){if(!e.getBoundingClientRect().width)continue;
     for(const video of [[0,0,0],[255,255,255]]){const bg=over(fill,video.map(v=>Math.min(255,v*bright)));worst.push([sel,+ratio(over(rgba(getComputedStyle(e).color),bg),bg).toFixed(2)])}}
    return worst});
   assert(contrast.every(([,r])=>r>=4.5),'over-video text meets 4.5:1 on its pill over black and white footage: '+JSON.stringify(contrast));
   if(width>=720)assert(hud.card!=='none','cards keep their soft shadow: '+hud.card);
   const play=await page.evaluate(()=>{const c=getComputedStyle(document.getElementById('play'));return [c.backgroundImage,c.color]});
   assert(/linear-gradient/.test(play[0])&&play[1]==='rgb(4, 36, 26)','play button uses the design mint gradient: '+play);
   assert.equal(card.bar,theme==='light'?'rgba(255, 255, 255, 0.68)':'rgba(18, 20, 24, 0.42)','transport glass fill');assert.equal(card.stage,'rgb(6, 9, 13)');
   if(theme==='light'){assert(['rgba(0, 0, 0, 0)','rgb(238, 240, 243)'].includes(card.card),'no white card around the video: '+card.card);assert.equal(card.text,'rgb(20, 23, 28)')}
   // The bookmark marker is centred on the seek track.
   await page.locator('.bookmark-marker').waitFor();
   const centre=await page.evaluate(()=>{const m=document.querySelector('.bookmark-marker').getBoundingClientRect(),t=document.querySelector('.seek-track').getBoundingClientRect();return Math.abs((m.top+m.bottom)/2-(t.top+t.bottom)/2)});
   assert(centre<=.5,'bookmark marker centred on the track: '+centre);
   assert.equal(await page.evaluate(()=>{const m=document.querySelector('.bookmark-marker').getBoundingClientRect();return document.elementFromPoint(m.left+m.width/2,m.top+m.height/2)?.className}),'bookmark-marker','marker stays clickable above the track');
   // Scroll so the analysis content passes behind the floating glass bar, then capture an intervention while playing.
   await page.evaluate(w=>scrollTo(0,w>=720?0:180),width);await settleLayout(page);await page.evaluate(()=>{pause();setTime(1.5);toggle()});await page.waitForFunction(()=>!video.paused&&video.currentTime>1.6);await page.locator('#steeringBadge').waitFor({state:'visible'});
   await page.screenshot({path:`${shots}/replay-${theme}-${width}.png`,animations:'disabled'});assert(await page.evaluate(()=>!video.paused&&video.currentTime<3.9),'capture playing mid-video');
   await page.addStyleTag({content:':root{scroll-padding-top:0!important}.replay-page .camera-panel,.app-bar{position:relative!important;top:auto!important}'});
   for(const [tab,id] of [['road','roadTab'],['lanes','laneTab'],['telemetry','telemetryTab'],['bookmarks','bookmarkTab']]){
    await page.locator('#'+id).click();await settleLayout(page,'.road-panel');
    if(tab==='telemetry')await page.locator('.telemetry-chart canvas').first().waitFor();
    // Isolate the panel for review after capturing the normal sticky phone layout above.
    await page.locator('.road-panel').screenshot({path:`${shots}/panel-${tab}-${theme}-${width}.png`});
    assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'tab has no overflow '+tab+' '+width);
   }
   await page.locator('#roadTab').click();await page.locator('#layerMenu').evaluate(d=>d.open=true);await settleLayout(page,'#layerPanel');
   await page.locator('#layerPanel').screenshot({path:`${shots}/layers-${theme}-${width}.png`});
   await page.goto('https://rv.test/#logs');await page.locator('.log-route').first().waitFor();await page.locator('.log-route').first().evaluate(e=>e.open=true);await settleLayout(page);
   await assertFlatControls(page);
   // Show the upload pill (glass) and scroll so cards pass behind the phone tab bar.
   await page.evaluate(()=>{const p=document.getElementById('uploadPill');p.hidden=false;p.style.setProperty('--upload','.42');document.getElementById('uploadPillText').textContent='업로드 42%';scrollTo(0,300)});await settleLayout(page);
   await page.screenshot({path:`${shots}/library-logs-${theme}-${width}.png`});
   await page.evaluate(()=>{document.getElementById('uploadPill').hidden=true;scrollTo(0,0)});
   await page.locator('#bulkOpen').click();for(const i of [0,1,3])await page.locator('.segment-select input').nth(i).check();await page.evaluate(()=>scrollTo(0,0));await page.locator('#bulkCount').click();await settleLayout(page);
   assert(await page.locator('#bulkFeedback').isHidden());assert(await page.locator('#bulkOpen').isEnabled());
   await assertFlatControls(page);
   // Rows pass behind the glass selection bar.
   await page.evaluate(()=>{for(const d of document.querySelectorAll('.log-route'))d.open=true;scrollTo(0,Math.max(0,document.documentElement.scrollHeight-innerHeight-260))});await settleLayout(page);
   await page.screenshot({path:`${shots}/selection-${theme}-${width}.png`});
   await page.locator('#bulkClose').click();await page.locator('#tab-settings').click();await settleLayout(page);
   await page.screenshot({path:`${shots}/library-settings-${theme}-${width}.png`});
   // Verify actual computed controls, including pseudo-element knobs, rather than token declarations alone.
   await assertFlatControls(page);
   assert.equal(await page.locator('.auto-convert-control span').first().evaluate(e=>getComputedStyle(e,'::after').boxShadow),'none');
   assert.deepEqual(errors,[]);await page.close();
  }
  console.log('PASS: theme-following transport, intervention badge, responsive tabs, flat library controls; screenshots: '+shots);
 }finally{await browser.close()}
})().catch(e=>{console.error(e);process.exitCode=1});
