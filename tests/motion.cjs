const fs=require('fs'),assert=require('node:assert/strict'),{chromium}=require('playwright');
// motion.css and its hooks: each effect runs, and reduced motion switches everything instantly.
const asset=name=>({body:fs.readFileSync('roadviewer/app/web/'+name),contentType:name.endsWith('.html')?'text/html':name.endsWith('.js')?'application/javascript':name.endsWith('.css')?'text/css':name.endsWith('.png')?'image/png':'image/svg+xml'});
const replay={route:'motion',key:'motion',duration:1,logStart:0,logEnd:.95,warnings:[],video:null,frames:Array.from({length:20},(_,i)=>({t:i*.05,id:i,valid:true,lanes:[],edges:[],lp:[],es:[],leads:[],liveTracksValid:false,steering:{angle:i*10,scale:1,state:'active',color:[0,255,0],active:true,pressed:false,torque:.2},overlay:null}))};
const running=page=>page.evaluate(()=>document.getAnimations().filter(a=>a.playState==='running').map(a=>a.animationName||a.transitionProperty));
(async()=>{
 const browser=await chromium.launch({headless:true});
 try{
  for(const {width,touch} of [{width:1280,touch:false},{width:390,touch:true},{width:1024,touch:true}])for(const reduced of [false,true]){
   const context=await browser.newContext({viewport:{width,height:900},hasTouch:touch,isMobile:touch,reducedMotion:reduced?'reduce':'no-preference'}),page=await context.newPage(),errors=[];
   page.on('pageerror',e=>errors.push(e.message));
   await context.addInitScript(()=>{
    addEventListener('pageswap',e=>{if(e.viewTransition)sessionStorage.setItem('snapshot-navigation','yes')});
    addEventListener('pagereveal',e=>{if(e.viewTransition)sessionStorage.setItem('snapshot-navigation','yes')});
   });
   let logs=[{id:'one',name:'00000395--0d0eda17c5 / 구간 7',files:{'rlog.zst':'00000395--0d0eda17c5--7--rlog.zst'},status:'processing',progress:{stage:'video_convert',percent:50},uploaded:2,bytes:1,prepared_bytes:0,video:true}];
   await page.route('https://rv.test/**',route=>{
    const p=new URL(route.request().url()).pathname;
    if(p==='/api/logs')return route.fulfill({json:{logs,concurrency:1,auto_convert:true,keep_original_video:true,max_upload_mb:512,storage_used_bytes:1}});
    if(p.endsWith('/data'))return route.fulfill({json:replay});
    if(p.startsWith('/api/'))return route.fulfill({json:{progress:{}}});
    return route.fulfill(asset(p==='/'?'library.html':p.startsWith('/view/')?'index.html':p.replace('/assets/','')));
   });
   await page.goto('https://rv.test/');await page.locator('.log-row').waitFor();
   // Processing: a sweep in the badge and a progress bar at video_convert 50% = 0.7 overall.
   assert.equal(await page.locator('.state-progress>span').evaluate(e=>e.style.getPropertyValue('--progress')),'0.7');
   assert.equal((await running(page)).includes('rv-sweep'),!reduced);
   assert((await page.locator('.state-processing').boundingBox()).height<=30,'processing badge stays compact');
   logs=[{...logs[0],prepared_bytes:42,progress:{stage:'log_read',frames:99999}}];
   await page.evaluate(()=>refresh());
   if(!reduced)assert.equal(await page.locator('.state-processing').evaluate(e=>e.getAnimations().find(a=>a.animationName==='rv-sweep').startTime),0,'rebuilt badge keeps the sweep timeline');
   await page.evaluate(()=>addFiles([new File(['x'],'unsupported.txt')]));
   assert(await page.locator('#error').evaluate(e=>parseFloat(getComputedStyle(e).marginTop)>=12),'unsupported-file message has top spacing');
   await page.evaluate(()=>{const d=document.querySelector('.inline-help');for(let p=d.parentElement;p;p=p.parentElement)if(p.tagName==='DETAILS')p.open=true;d.open=true;});
   await page.locator('.inline-help').evaluate(d=>d.querySelector('summary').click());
   assert.equal(await page.locator('.inline-help').evaluate(d=>d.classList.contains('is-closing')), !reduced);
   await page.waitForFunction(()=>!document.querySelector('.inline-help').open);
   // A new log slides in; an existing row rebuilt for its status does not.
   // The server lists newest first.
   logs=[{id:'two',name:'00000395--0d0eda17c5 / 구간 8',status:'ready',uploaded:3,bytes:1,prepared_bytes:1,video:true},{...logs[0],status:'ready',progress:null}];
   await page.evaluate(()=>refresh());
   const rows=await page.evaluate(()=>[...document.querySelectorAll('.log-row')].map(r=>[r.dataset.id,r.getAnimations().length,r.classList.contains('is-update')]));
   assert.deepEqual(rows.map(r=>r[0]),['two','one']);
   assert.equal(rows[0][1]>0,!reduced,'new row enters with motion');assert.equal(rows[1][2],true);
   // Deleting reflows the list through a view transition.
   await page.evaluate(()=>{window.transitions=0;const start=document.startViewTransition.bind(document);document.startViewTransition=cb=>{transitions++;return start(cb)}});
   logs=[logs[0]];await page.evaluate(()=>refresh());await page.waitForFunction(()=>document.querySelectorAll('.log-row').length===1);
   assert.equal(await page.evaluate(()=>transitions),reduced||width<=850||touch?0:1);
   // Dialogs fade/scale in and stay in the top layer while closing.
   await page.locator('#bulkOpen').click();
   assert.equal((await page.locator('#bulkDialog').evaluate(d=>d.getAnimations().length))>0,!reduced);
   await page.keyboard.press('Escape');
   if(!reduced)assert(await page.locator('#bulkDialog').evaluate(d=>!d.open&&getComputedStyle(d).display!=='none'),'closing dialog animates out');
   await page.locator('#bulkDialog').waitFor({state:'hidden'});
   // The tapped log name is handed to the replay page for the page transition.
   await page.locator('a.replay').click();await page.waitForURL(/view\/two\//);
   await page.waitForFunction(()=>typeof data!=='undefined'&&data);
   logs=[{...logs[0],id:'newer',name:'00000395--0d0eda17c5 / 구간 9'},logs[0],{...logs[0],id:'older',name:'00000396--0d0eda17c5 / 구간 0'}];
   await page.evaluate(()=>loadLogNavigation());
   assert.equal(await page.locator('#nextLog').textContent(),'다음 구간');
   assert.equal(await page.locator('#previousLog').textContent(),'이전 로그');
   assert.equal(await page.evaluate(()=>sessionStorage.getItem('rv-route')),null,'handoff is consumed');
   assert.equal(await page.evaluate(()=>document.body.classList.contains('replay-loading')),false,'loading skeleton ends with the data');
   // The wheel turns via a CSS transform that glides between 20 Hz samples.
   await page.evaluate(()=>setTime(.5));
   assert.match(await page.locator('#wheelRotate').evaluate(e=>e.style.transform),/rotate\(-100deg\)/);
   assert.equal(await page.locator('#wheelRotate').evaluate(e=>getComputedStyle(e).transitionDuration),reduced?'0s':'0.06s');
   // Tabs: the highlight moves to the selected tab; layout toggles use a view transition.
   await page.evaluate(()=>{window.transitions=0;const start=document.startViewTransition.bind(document);document.startViewTransition=cb=>{transitions++;return start(cb)}});
   await page.locator('#telemetryTab').click();
   assert(await page.locator('.playback').evaluate(p=>{const r=p.getBoundingClientRect();return p.contains(document.elementFromPoint(r.x+r.width/2,r.y+10))}),'playback stays above the tab content during motion');
   assert.equal(await page.evaluate(()=>transitions),0,'tab changes keep the rest of the screen live');
   await page.waitForFunction(()=>!document.documentElement.classList.contains('rv-layout-transition'));
   const tab=await page.evaluate(()=>{const t=document.getElementById('telemetryTab'),s=getComputedStyle(t.parentElement);return [s.getPropertyValue('--tab-x'),t.offsetLeft+'px']});
   assert.equal(tab[0],tab[1]);
   if(!reduced)assert.equal(await page.locator('.tab-indicator').evaluate(e=>getComputedStyle(e).transitionTimingFunction),'cubic-bezier(0.4, 0, 0.2, 1), cubic-bezier(0.4, 0, 0.2, 1)');
   if(touch)assert(await page.locator('button,a,summary,input,label').evaluateAll(es=>es.every(e=>getComputedStyle(e).webkitTapHighlightColor==='rgba(0, 0, 0, 0)')),'native rectangular touch highlights are disabled');
   await page.locator('#splitView').click();await page.waitForFunction(()=>!document.documentElement.classList.contains('rv-layout-transition'));
   assert.equal(await page.locator('#splitView').getAttribute('aria-pressed'),'true');
   assert.equal(await page.evaluate(()=>transitions),reduced||width<=850||touch?0:1,'tabs must not snapshot the fixed playback controls');
   if(touch){
    await page.locator('#stackView').click();
    assert.equal(await page.locator('#stackView').getAttribute('aria-pressed'),'true');
    assert.equal(await page.evaluate(()=>transitions),0,'touch layout changes never capture the whole page');
    await page.locator('#previousLog').click();await page.waitForURL('**/view/older/');
    await page.waitForFunction(()=>typeof data!=='undefined'&&data);
    await page.locator('.back').click();await page.waitForURL('https://rv.test/');
    await page.locator('a.replay').first().click();await page.waitForURL('**/view/newer/');
    await page.waitForFunction(()=>typeof data!=='undefined'&&data);
    assert.equal(await page.evaluate(()=>sessionStorage.getItem('snapshot-navigation')),null,'touch page navigation never uses snapshots');
    // Even before external CSS is available, a newly loaded document has an opaque dark canvas.
    await page.route('**/assets/*.css*',r=>r.fulfill({body:'',contentType:'text/css'}));
    for(const url of ['https://rv.test/','https://rv.test/view/two/']){
     await page.goto(url);
     assert.deepEqual(await page.evaluate(()=>[document.documentElement,document.body].map(e=>getComputedStyle(e).backgroundColor)),['rgb(12, 17, 24)','rgb(12, 17, 24)']);
    }
   }
   assert.deepEqual(errors,[]);await context.close();
  }
  console.log('PASS: list enter/reflow and progress, dialog enter/exit, page handoff, loading state, wheel glide, tab indicator, layout transitions and reduced motion');
 }finally{await browser.close()}
})().catch(e=>{console.error(e);process.exitCode=1});
