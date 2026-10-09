const fs=require('fs'),os=require('os'),path=require('path'),assert=require('node:assert/strict'),{spawn}=require('child_process'),{once}=require('events'),{chromium}=require('playwright');
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
  browser=await chromium.launch({headless:true});
  for(const {width,prefix} of [{width:390,prefix:'/api/hassio_ingress/test'},{width:1024,prefix:''},{width:1440,prefix:''}]){
   const context=await browser.newContext({viewport:{width,height:844},hasTouch:width<1200,isMobile:width<1200});
   const page=await context.newPage(),errors=[],documents=[];let listReads=0,delayData=false,releaseData;
   const base=`http://127.0.0.1:${port}${prefix}/`;
   page.on('pageerror',e=>errors.push(e.message));page.on('request',r=>{if(r.isNavigationRequest())documents.push(r.url())});
   await page.route('**/api/logs**',async r=>{
    const p=new URL(r.request().url()).pathname;
    if(p.endsWith('/api/logs')){listReads++;return r.fulfill({json:{logs:ids.map((id,i)=>({id,name:`00000395--0d0eda17c5 / 구간 ${i}`,status:'ready',uploaded:2-i,bytes:1,prepared_bytes:1})),max_upload_mb:512,storage_used_bytes:2,concurrency:1}})}
    if(p.endsWith('/data')){
     if(delayData)await new Promise(resolve=>releaseData=resolve);
     return r.fulfill({json:{route:p.includes(ids[0])?'first':'second',key:'nav',duration:2,warnings:[],video:{start:0,duration:2},frames:[{t:0,id:0,valid:true,lanes:[],edges:[],lp:[],es:[],leads:[]}]}}).catch(()=>{});
    }
    if(p.endsWith('/video'))return r.fulfill({body:fs.readFileSync(process.env.RV_TEST_VIDEO||'/tmp/roadviewer-test.mp4'),contentType:'video/mp4'});
    return r.continue();
   });
   await page.addInitScript(()=>{
    window.pendingFrames=new Set();const request=requestAnimationFrame,cancel=cancelAnimationFrame;
    window.requestAnimationFrame=callback=>{const id=request(time=>{pendingFrames.delete(id);callback(time)});pendingFrames.add(id);return id};
    window.cancelAnimationFrame=id=>{pendingFrames.delete(id);cancel(id)};
   });
   await page.goto(base);await page.locator('.replay').first().waitFor();
   await page.evaluate(()=>{window.documentToken={};window.originalToken=documentToken;window.originalBrand=document.querySelector('.app-brand')});
   await page.locator('.replay').first().click();await page.waitForURL(base+'view/'+ids[0]+'/');
   await page.waitForFunction(()=>!document.getElementById('play').disabled);
   assert(await page.evaluate(()=>documentToken===originalToken&&originalBrand===document.querySelector('.app-brand')),'document and brand persist');
   await page.locator('#play').click();await page.waitForFunction(()=>document.getElementById('video').currentTime>.1);
   await page.evaluate(()=>{window.departedVideo=document.getElementById('video');scrollTo(0,200)});
   await page.locator('#previousLog').click();await page.waitForURL(base+'view/'+ids[1]+'/');
   await page.waitForFunction(()=>document.getElementById('route').textContent==='second');
   assert(await page.evaluate(()=>departedVideo.paused&&!departedVideo.hasAttribute('src')),'departed video is released');
   await page.goBack();await page.waitForURL(base+'view/'+ids[0]+'/');await page.waitForFunction(()=>document.getElementById('route').textContent==='first');
   await page.waitForFunction(()=>Math.abs(scrollY-200)<1);
   await page.locator('.back').click();await page.waitForURL(base);await page.locator('.replay').first().waitFor();
   await page.waitForTimeout(400);assert.equal(await page.evaluate(()=>pendingFrames.size),0,'departed replay RAF loop is cancelled');
   const before=listReads;await page.waitForTimeout(3200);assert(listReads-before<=2,'only the current library poller survives');
   // A slow abandoned replay request must not overwrite the next screen or keep its RAF alive.
   delayData=true;await page.locator('.replay').first().click();await page.waitForURL(base+'view/'+ids[0]+'/');
   await page.waitForFunction(()=>document.querySelector('.back'));
   await page.locator('.back').click();await page.waitForURL(base);delayData=false;releaseData?.();
   await page.locator('.replay').first().waitFor();await page.waitForTimeout(100);
   assert.equal(await page.locator('#play').count(),0);assert.equal(await page.locator('.rv-choice-dialog').count(),1,'dialogs do not accumulate');
   const failedURL=base+'view/'+ids[0]+'/?fragment=1';
   await page.route(failedURL,r=>r.fulfill({status:503,body:'unavailable'}));
   await page.locator('.replay').first().click();await page.getByRole('button',{name:'다시 시도',exact:true}).waitFor();
   assert.equal(page.url(),base,'failed navigation keeps the old URL');assert(await page.locator('.replay').first().isVisible(),'failed navigation keeps the old screen');
   await page.unroute(failedURL);await page.getByRole('button',{name:'다시 시도',exact:true}).click();await page.waitForURL(base+'view/'+ids[0]+'/');
   await page.locator('.back').click();await page.waitForURL(base);await page.locator('.replay').first().waitFor();
   // The newest click wins even if an older fragment responds later.
   let releaseFragment;
   const slowURL=base+'view/'+ids[0]+'/?fragment=1';
   await page.route(slowURL,async r=>{await new Promise(resolve=>releaseFragment=resolve);await r.continue().catch(()=>{})});
   await page.locator('.replay').first().click();
   await page.waitForTimeout(50);assert(await page.locator('.replay').nth(1).isVisible(),'current screen remains until replacement is available');
   await page.locator('.replay').nth(1).click();await page.waitForURL(base+'view/'+ids[1]+'/');releaseFragment?.();
   await page.waitForFunction(()=>document.getElementById('route').textContent==='second');
   await page.unroute(slowURL);await page.locator('.back').click();await page.waitForURL(base);await page.locator('.replay').first().waitFor();
   // Internal navigation must not abort an active upload or strand its server reservation.
   let uploadRequest,releaseUpload;
   await page.route('**/api/uploads',async r=>{uploadRequest=r;await new Promise(resolve=>releaseUpload=resolve);await r.fulfill({status:400,json:{error:'Test upload cancelled'}})});
   await page.locator('#files').setInputFiles({name:'00000395--0d0eda17c5--9--rlog.zst',mimeType:'application/octet-stream',buffer:Buffer.from('fixture')});
   await page.locator('#upload').click();await page.waitForFunction(()=>document.getElementById('upload').disabled);
   await page.locator('.replay').first().click();await page.waitForFunction(()=>document.getElementById('navigationStatus').textContent.includes('업로드 또는 정리'));
   assert.equal(page.url(),base);assert(await page.locator('#upload').isDisabled());
   assert(uploadRequest,'upload request is still active');releaseUpload();
   await page.waitForFunction(()=>!document.getElementById('upload').disabled);
   await page.unroute('**/api/uploads');
   assert.equal(documents.length,1,'all internal navigation stays in one document');assert.deepEqual(errors,[]);
   // Direct replay entry and refresh still load a working shell.
   await page.goto(base+'view/'+ids[1]+'/');await page.waitForFunction(()=>document.getElementById('play')&&!document.getElementById('play').disabled);
   await page.reload();await page.waitForFunction(()=>document.getElementById('play')&&!document.getElementById('play').disabled);
   await context.close();
  }
  console.log('PASS: single-document mobile/tablet/desktop navigation, ingress prefix, history, direct replay, video disposal, stale requests and polling cleanup');
 }finally{await browser?.close();if(python.exitCode===null){python.kill();await once(python,'exit')}fs.rmSync(dir,{recursive:true,force:true})}
})().catch(e=>{console.error(e);process.exitCode=1});
