const fs=require('fs'),os=require('os'),path=require('path'),assert=require('node:assert/strict'),{spawn}=require('child_process'),{once,EventEmitter}=require('events'),{chromium}=require('playwright');
(async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'rv-navigation-')),ids=['a'.repeat(32),'b'.repeat(32)];
 for(const id of ids){fs.mkdirSync(path.join(dir,id));fs.writeFileSync(path.join(dir,id,'meta.json'),JSON.stringify({status:'unconverted',auto_excluded:true,name:id,uploaded:1,files:{}}))}
 const python=spawn(process.env.RV_PYTHON||'python',['-u','-c',`
import sys
sys.path.insert(0,'roadviewer/app')
import server
from werkzeug.serving import make_server
from werkzeug.middleware.dispatcher import DispatcherMiddleware
server.app.logger.disabled=True
http=make_server('127.0.0.1',0,DispatcherMiddleware(server.app,{'/api/hassio_ingress/test':server.app}),threaded=True)
print('READY '+str(http.server_port),flush=True)
http.serve_forever()
`],{env:{...process.env,RV_DATA:dir,RV_INGRESS_ONLY:'0'},stdio:['ignore','pipe','pipe']});
 let stderr='';python.stderr.on('data',x=>stderr+=x);
 let browser;
 try{
  const port=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('Test server timeout: '+stderr)),15000);python.once('exit',code=>{clearTimeout(timer);reject(Error('Test server exit '+code+': '+stderr))});python.stdout.on('data',x=>{const m=/READY (\d+)/.exec(String(x));if(m){clearTimeout(timer);resolve(Number(m[1]))}})});
  browser=await chromium.launch({headless:true});require('./browser-helpers.cjs').openRouteGroups(browser);
  for(const {width,prefix} of [{width:390,prefix:'/api/hassio_ingress/test'},{width:1024,prefix:''},{width:1440,prefix:''}]){
   const context=await browser.newContext({viewport:{width,height:844},hasTouch:width<1200,isMobile:width<1200});
   const page=await context.newPage(),errors=[],documents=[];let listReads=0,delayData=false,releaseData,delayNavigation=false;const videoRequests=[];
   const requests=new EventEmitter();
   const base=`http://127.0.0.1:${port}${prefix}/`;
   page.on('pageerror',e=>errors.push(e.message));page.on('request',r=>{if(r.isNavigationRequest())documents.push(r.url())});
   await page.route('**/api/logs**',async r=>{
    const p=new URL(r.request().url()).pathname;
    if(p.endsWith('/api/logs')){if(delayNavigation)await new Promise(resolve=>setTimeout(resolve,180));listReads++;return r.fulfill({json:{logs:ids.map((id,i)=>({id,name:`00000395--0d0eda17c5 / 구간 ${i}`,status:'ready',uploaded:2-i,bytes:1,prepared_bytes:1})).concat({id:'c'.repeat(32),name:'processing',status:'processing',uploaded:0,bytes:1,prepared_bytes:listReads,progress:{stage:listReads===1?'log_read':'video_convert',frames:100,percent:50}}),max_upload_mb:512,storage_used_bytes:2,concurrency:1}})}
    if(p.endsWith('/data')){
     if(delayData)await new Promise(resolve=>{releaseData=resolve;requests.emit('data-held')});
     await r.fulfill({json:{route:p.includes(ids[0])?'first':'second',key:'nav',duration:2,warnings:[],video:{start:0,duration:2},frames:[{t:0,id:0,valid:true,lanes:[],edges:[],lp:[],es:[],leads:[]}]}}).catch(()=>{});requests.emit('data-finished');return;
    }
    if(p.endsWith('/video')){videoRequests.push(p);if(!p.startsWith(prefix+'/api/logs/'))return r.fulfill({status:404,body:'Outside ingress'});return r.fulfill({body:fs.readFileSync(process.env.RV_TEST_VIDEO||'/tmp/roadviewer-test.mp4'),contentType:'video/mp4'});}
    return r.continue();
   });
   await page.addInitScript(()=>{
    window.liveMorphs=[];window.snapshotCalls=0;const animateElement=Element.prototype.animate;Element.prototype.animate=function(frames,options){const animation=animateElement.call(this,frames,options);if(frames[0]?.transformOrigin==='0 0')liveMorphs.push(this.className||this.tagName);if(this.closest('.app-brand')&&frames[0]?.transform){const m=/scale\(([^,]+),([^\)]+)\)/.exec(frames[0].transform);if(m&&Math.abs(Number(m[1])-Number(m[2]))>.0001)window.distortedBrand=true};return animation};
    window.pageMotions=[];const startTransition=document.startViewTransition.bind(document);document.startViewTransition=update=>{snapshotCalls++;const transition=startTransition(update);transition.ready.then(()=>pageMotions.push({root:getComputedStyle(document.documentElement).viewTransitionName,title:!!document.querySelector('[style*="rv-route"]'),background:getComputedStyle(document.documentElement,'::view-transition').backgroundColor,morph:document.getAnimations().some(a=>a.effect?.pseudoElement==='::view-transition-group(rv-route)')}),()=>{});return transition};
    window.pendingFrames=new Set();const request=requestAnimationFrame,cancel=cancelAnimationFrame;
    window.requestAnimationFrame=callback=>{const id=request(time=>{pendingFrames.delete(id);callback(time)});pendingFrames.add(id);return id};
    window.cancelAnimationFrame=id=>{pendingFrames.delete(id);cancel(id)};
   });
   await page.goto(base);await page.locator('.log-row .replay').first().waitFor();
   const checkSweep=async()=>{
    const badge=page.locator('.state-processing');
    assert(await badge.evaluate(e=>getComputedStyle(e).backgroundImage.includes('linear-gradient')),'processing sweep has a visible gradient in the real shell');
    // The page glow (html::before) must not be hidden by the shell's solid pre-load body background.
    assert.deepEqual(await page.evaluate(()=>({body:getComputedStyle(document.body).backgroundColor,image:getComputedStyle(document.body).backgroundImage,glow:getComputedStyle(document.documentElement,'::before').backgroundImage.includes('gradient')})),{body:'rgba(0, 0, 0, 0)',image:'none',glow:true},'the page glow shows through the body in the real shell');
    assert.equal(await badge.evaluate(e=>getComputedStyle(e).backgroundSize),'220% 100%');
    assert.equal(await badge.evaluate(e=>getComputedStyle(e).backgroundRepeat),'no-repeat','one beam per cycle');
    await badge.evaluate(e=>{window.badgeBefore=e;window.sweepBefore=e.getAnimations().find(a=>a.animationName==='rv-sweep');window.sweepTime=sweepBefore.currentTime});
    await page.waitForFunction(()=>sweepBefore.currentTime>sweepTime);await page.locator('#refresh').click();
    await page.waitForFunction(()=>!document.getElementById('refresh').disabled);
    assert(await badge.evaluate(e=>e===badgeBefore&&e.getAnimations().includes(sweepBefore)&&sweepBefore.currentTime>sweepTime),'visible sweep advances across metadata and stage updates');
   };
   await checkSweep();
   assert(await page.evaluate(()=>document.activeElement.tagName!=='H1'),'first entry does not focus the brand');
   await page.evaluate(()=>{window.documentToken={};window.originalToken=documentToken;window.originalBrand=document.querySelector('.app-brand')});
   await page.evaluate(()=>{window.preparedHidden=false;new MutationObserver(records=>{for(const record of records)for(const node of record.addedNodes)if(node.nodeType===1&&node.classList.contains('replay-page')&&node.hidden)preparedHidden=true}).observe(document.getElementById('pageHost'),{childList:true})});
   delayNavigation=true;
   await page.locator('.log-row .replay').first().click();await page.waitForURL(base+'view/'+ids[0]+'/');
   assert(videoRequests.length&&videoRequests.every(p=>p.startsWith(prefix+'/api/logs/')),'video request must retain ingress prefix while the old page base is active: '+videoRequests.join(', '));
   delayNavigation=false;
   await page.waitForFunction(()=>!document.getElementById('play').disabled);
   assert.deepEqual(await page.evaluate(()=>liveMorphs),[],'library to replay does not morph');
   assert(await page.evaluate(()=>preparedHidden),'next page stays hidden during asynchronous preparation');
   assert.equal(await page.evaluate(()=>snapshotCalls),0,'navigation never invokes the snapshot compositor');
   assert(await page.evaluate(()=>!liveMorphs.includes('app-brand')&&!window.distortedBrand),'brand contents morph without stretching the flex container');
   assert(await page.evaluate(()=>pageMotions.every(a=>a.root==='none'&&a.background==='rgba(0, 0, 0, 0)')),'morphing excludes the full-page snapshot and opaque overlay');
   await page.waitForFunction(()=>!document.documentElement.classList.contains('rv-navigation-transition'));
   assert(await page.evaluate(()=>documentToken===originalToken),'document persists');
   // The replay page has its own app bar instead of the brand header; focus lands on its title.
   assert(await page.evaluate(()=>!document.querySelector('.app-brand')&&document.activeElement.tagName==='H1'&&document.activeElement.closest('.video-title')),'replay app bar replaces the brand and takes focus');
   // Opened from the list the page is prepared hidden: the stacked video must still take the room it has (it used to keep
   // the 320px fallback height), and the focused title shows no focus ring.
   const stackedVideo=await page.evaluate(()=>{const page=document.querySelector('.replay-page'),panel=document.querySelector('.camera-panel'),style=getComputedStyle(panel),wrap=document.getElementById('videoStage').getBoundingClientRect();
    const room=panel.clientWidth-parseFloat(style.paddingLeft)-parseFloat(style.paddingRight),ratio=parseFloat(getComputedStyle(page).getPropertyValue('--video-ar'))||1.594;
    const tall=(innerHeight-document.querySelector('.app-bar').offsetHeight-document.querySelector('.playback').offsetHeight-60)*ratio;
    return {compact:page.classList.contains('compact-media'),width:wrap.width,expected:Math.max(160,Math.min(room,tall)),outline:getComputedStyle(document.activeElement).outlineStyle}});
   if(stackedVideo.compact)assert(Math.abs(stackedVideo.width-stackedVideo.expected)<2,`stacked video takes its room after list entry at ${width}: ${JSON.stringify(stackedVideo)}`);
   assert.equal(stackedVideo.outline,'none','the focused replay title shows no focus ring');
   assert.equal(await page.locator('#navigationStatus').textContent(),'','successful navigation has no top loading notice');
   // Use real DOM events inside the SPA: its document/window are proxies, unlike direct index.html tests.
   for(const [id,columns] of [['radarRows',6],['rawRows',7]]){
    await page.locator('#'+id).evaluate(e=>e.closest('details').open=true);
    await page.waitForFunction(([id,columns])=>document.getElementById(id).rows[0]?.cells[0]?.colSpan===columns,[id,columns]);
    assert(await page.locator('#'+id).evaluate(e=>{const row=e.rows[0],seek=document.getElementById('seek');seek.value='.3';seek.dispatchEvent(new Event('input',{bubbles:true}));return e.rows[0]===row}),'shell reuses open table rows');
    await page.locator('#'+id).evaluate(e=>e.closest('details').open=false);
   }
   if(width===1440){
    await page.evaluate(()=>{window.shellDraws={map:0,overlay:0};window.shellClear=CanvasRenderingContext2D.prototype.clearRect;CanvasRenderingContext2D.prototype.clearRect=function(...args){if(this.canvas.id==='road')shellDraws.map++;if(this.canvas.id==='videoOverlay')shellDraws.overlay++;return shellClear.apply(this,args)}});
    await page.locator('#fullscreenButton').click();await page.waitForFunction(()=>document.fullscreenElement);
    const drawn=await page.evaluate(()=>{shellDraws.map=0;shellDraws.overlay=0;document.getElementById('next').click();return {...shellDraws}});
    assert.equal(drawn.map,0,'shell fullscreen skips map');assert(drawn.overlay>0,'shell fullscreen keeps overlay updates');
    await page.evaluate(()=>document.exitFullscreen());await page.waitForFunction(()=>shellDraws.map>0);
    await page.evaluate(()=>{CanvasRenderingContext2D.prototype.clearRect=shellClear});
   }
   await page.evaluate(()=>scrollTo(0,0));
   await page.locator('#play').click();await page.waitForFunction(()=>document.getElementById('video').currentTime>.1);
   const leftAt=await page.evaluate(()=>{window.departedVideo=document.getElementById('video');const target=Math.min(200,document.documentElement.scrollHeight-innerHeight-10);scrollTo(0,target);return scrollY});
   assert(leftAt>0,'the replay fixture must have a real scroll position to restore');
   await page.emulateMedia({reducedMotion:'reduce'});await page.evaluate(()=>pageMotions=[]);
   // Invoke without scrolling the phone's previous/next controls into view, preserving the saved position.
   await page.locator('#previousLog').evaluate(button=>button.click());await page.waitForURL(base+'view/'+ids[1]+'/');
   await page.waitForFunction(()=>document.getElementById('route').textContent==='second');
   assert.equal(await page.evaluate(()=>pageMotions.length),0,'reduced motion disables page effects');await page.emulateMedia({reducedMotion:'no-preference'});
   assert(await page.evaluate(()=>departedVideo.paused&&!departedVideo.hasAttribute('src')),'departed video is released');
   await page.evaluate(()=>liveMorphs=[]);
   await page.goBack();await page.waitForURL(base+'view/'+ids[0]+'/');await page.waitForFunction(()=>document.getElementById('route').textContent==='first');
   assert.deepEqual(await page.evaluate(()=>liveMorphs),[],'replay-to-replay navigation does not morph even with motion enabled');
   await page.waitForFunction(leftAt=>Math.abs(scrollY-leftAt)<1,leftAt);
   // The back link shows its press at once (no touch delay) and the list replaces the replay only after PRESS_HOLD,
   // although the library is already prefetched, so the wave is seen.
   await page.evaluate(()=>{window.backTap={};const b=document.querySelector('.app-bar .back');
    b.addEventListener('pointerdown',()=>setTimeout(()=>backTap.wave=!!b.querySelector('.rv-ripple'),0),{once:true});b.addEventListener('click',()=>backTap.at=performance.now(),{once:true});
    const push=history.pushState;history.pushState=function(...a){backTap.swap=performance.now()-backTap.at;history.pushState=push;return push.apply(history,a)}});
   if(width<1200)await page.locator('.app-bar .back').tap();else await page.locator('.app-bar .back').click();
   await page.waitForURL(base);await page.locator('.log-row .replay').first().waitFor();
   const backTap=await page.evaluate(()=>backTap);
   assert(backTap.wave,'the back link ripples as soon as it is touched');assert(backTap.swap>=190,'the list replaces the replay after the press shows: '+backTap.swap);
   await page.waitForFunction(()=>!document.documentElement.classList.contains('rv-navigation-transition'));
   assert.deepEqual(await page.evaluate(()=>liveMorphs),[],'returning to the library does not morph');
   await page.waitForFunction(()=>pendingFrames.size===0);assert.equal(await page.evaluate(()=>pendingFrames.size),0,'departed replay RAF loop is cancelled');
   await checkSweep();
   const before=listReads;await page.waitForTimeout(3200);assert(listReads-before<=2,'only the current library poller survives');
   await page.waitForFunction(()=>!document.documentElement.classList.contains('rv-navigation-transition'));
   await page.evaluate(()=>{window.savedTransition=document.startViewTransition;document.startViewTransition=undefined});
   await page.locator('.log-row .replay').first().click();await page.waitForURL(base+'view/'+ids[0]+'/');
   await page.locator('.back').click();await page.waitForURL(base);await page.locator('.log-row .replay').first().waitFor();
   assert(await page.evaluate(()=>!document.documentElement.classList.contains('rv-navigation-transition')),'unsupported browsers navigate without a transition');
   await page.evaluate(()=>document.startViewTransition=savedTransition);
   // Late replay data must not replace the title that is already moving.
   const dataReady=once(requests,'data-held',{signal:AbortSignal.timeout(5000)});
   delayData=true;releaseData=null;await page.locator('.log-row .replay').first().click();await page.waitForURL(base+'view/'+ids[0]+'/');
   await page.evaluate(()=>window.movingTitle=document.getElementById('route'));
   await dataReady;assert(releaseData,'data request is pending');delayData=false;releaseData();
   await page.waitForFunction(()=>document.getElementById('route').textContent==='first');
   assert(await page.evaluate(()=>movingTitle===document.getElementById('route')),'late data preserves the animated title node');
   await page.locator('.back').click();await page.waitForURL(base);await page.locator('.log-row .replay').first().waitFor();
   // A slow abandoned replay request must not overwrite the next screen or keep its RAF alive.
   const abandonedReady=once(requests,'data-held',{signal:AbortSignal.timeout(5000)});
   delayData=true;await page.locator('.log-row .replay').first().click();await page.waitForURL(base+'view/'+ids[0]+'/');
   await abandonedReady;await page.waitForFunction(()=>document.querySelector('.back'));
   await page.locator('.back').click();await page.waitForURL(base);delayData=false;
   const abandonedFinished=once(requests,'data-finished',{signal:AbortSignal.timeout(5000)});releaseData();await abandonedFinished;
   await page.locator('.log-row .replay').first().waitFor();
   assert.equal(await page.locator('#play').count(),0);assert.equal(await page.locator('.rv-choice-dialog').count(),1,'dialogs do not accumulate');
   const failedURL=base+'view/'+ids[0]+'/?fragment=1';
   await page.route(failedURL,r=>r.fulfill({status:503,body:'unavailable'}));
   await page.locator('.log-row .replay').first().click();await page.getByRole('button',{name:'다시 시도',exact:true}).waitFor();
   assert.equal(page.url(),base,'failed navigation keeps the old URL');assert(await page.locator('.log-row .replay').first().isVisible(),'failed navigation keeps the old screen');
   await page.unroute(failedURL);await page.getByRole('button',{name:'다시 시도',exact:true}).click();await page.waitForURL(base+'view/'+ids[0]+'/');
   await page.locator('.back').click();await page.waitForURL(base);await page.locator('.log-row .replay').first().waitFor();
   // The newest click wins even if an older fragment responds later.
   let releaseFragment;
   const slowURL=base+'view/'+ids[0]+'/?fragment=1';
   await page.route(slowURL,async r=>{await new Promise(resolve=>{releaseFragment=resolve;requests.emit('fragment-held')});await r.continue().catch(()=>{})});
   const fragmentReady=once(requests,'fragment-held',{signal:AbortSignal.timeout(5000)});
   await page.locator('.log-row .replay').first().click();await fragmentReady;assert(await page.locator('.log-row .replay').nth(1).isVisible(),'current screen remains until replacement is available');
   await page.locator('.log-row .replay').nth(1).click();await page.waitForURL(base+'view/'+ids[1]+'/');releaseFragment?.();
   await page.waitForFunction(()=>document.getElementById('route').textContent==='second');
   await page.unroute(slowURL);await page.locator('.back').click();await page.waitForURL(base);await page.locator('.log-row .replay').first().waitFor();
   // Internal navigation must not abort an active upload or strand its server reservation.
   let uploadRequest,releaseUpload;
   await page.route('**/api/uploads',async r=>{uploadRequest=r;await new Promise(resolve=>{releaseUpload=resolve;requests.emit('upload-held')});await r.fulfill({status:400,json:{error:'Test upload cancelled'}})});
   await page.locator('#files').setInputFiles({name:'00000395--0d0eda17c5--9--rlog.zst',mimeType:'application/octet-stream',buffer:Buffer.from('fixture')});
   const uploadReady=once(requests,'upload-held',{signal:AbortSignal.timeout(5000)});
   // The upload starts in the 업로드 tab and keeps running while the 로그 tab is shown (in-page tabs, not navigation).
   await page.locator('#tab-upload').click();await page.locator('#upload').click();await uploadReady;await page.waitForFunction(()=>document.getElementById('upload').disabled);
   await page.locator('#tab-logs').click();assert(await page.locator('#uploadPill').isVisible(),'the app bar shows the running upload');
   await page.locator('.log-row .replay').first().click();await page.waitForFunction(()=>document.getElementById('navigationStatus').textContent.includes('업로드 또는 정리'));
   assert.equal(page.url(),base+'#logs','still on the library (tab in the hash)');assert(await page.locator('#upload').isDisabled());
   assert(uploadRequest,'upload request is still active');releaseUpload();
   await page.waitForFunction(()=>!document.getElementById('upload').disabled);
   await page.unroute('**/api/uploads');
   assert.equal(await page.evaluate(()=>snapshotCalls),0,'all routes avoid snapshots');
   assert.equal(documents.length,1,'all internal navigation stays in one document');assert.deepEqual(errors,[]);
   // Direct replay entry and refresh still load a working shell.
   await page.goto(base+'view/'+ids[1]+'/');await page.waitForFunction(()=>document.getElementById('play')&&!document.getElementById('play').disabled);
   await page.reload();await page.waitForFunction(()=>document.getElementById('play')&&!document.getElementById('play').disabled);
   if(width===390){
    // A quarter-turned full screen (orientation lock refused) left by moving to another segment: the next page is upright,
    // its dialogs are not turned and touches on its seek bar map along the bar's real width.
    await page.evaluate(()=>{screen.orientation.lock=()=>Promise.reject(new DOMException('refused','NotSupportedError'))});
    await page.evaluate(()=>document.getElementById('fullscreenButton').click());
    await page.waitForFunction(()=>document.documentElement.classList.contains('stage-turned'));
    await page.locator('#nextLog').evaluate(button=>button.click());await page.waitForURL(base+'view/'+ids[0]+'/');
    await page.waitForFunction(()=>document.getElementById('play')&&!document.getElementById('play').disabled&&!document.fullscreenElement);await page.waitForTimeout(200);
    const upright=await page.evaluate(()=>{const d=document.createElement('dialog');document.body.append(d);d.showModal();const rotate=getComputedStyle(d).rotate;d.remove();
     return {root:document.documentElement.classList.contains('stage-turned'),turned:document.querySelector('.camera-panel').classList.contains('is-turned'),rotate}});
    assert.deepEqual(upright,{root:false,turned:false,rotate:'none'},'the next segment is not left turned');
    const seek=await page.locator('#seek').boundingBox();await page.touchscreen.tap(seek.x+seek.width*.75,seek.y+seek.height/2);await page.waitForTimeout(150);
    const fraction=await page.locator('#seek').evaluate(e=>(Number(e.value)-Number(e.min))/(Number(e.max)-Number(e.min)));
    assert(Math.abs(fraction-.75)<.06,'a touch at 3/4 of the seek bar seeks to 3/4 after leaving the turn: '+fraction);
   }
   await context.close();
  }
  console.log('PASS: single-document mobile/tablet/desktop navigation, ingress prefix, history, direct replay, video disposal, stale requests and polling cleanup');
 }finally{await browser?.close();if(python.exitCode===null){python.kill();await once(python,'exit')}fs.rmSync(dir,{recursive:true,force:true})}
})().catch(e=>{console.error(e);process.exitCode=1});
