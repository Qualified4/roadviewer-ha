const fs=require('fs'),assert=require('node:assert/strict'),{chromium}=require('playwright');
// motion.css and its hooks: each effect runs, and reduced motion switches everything instantly.
const asset=name=>({body:fs.readFileSync('roadviewer/app/web/'+name),contentType:name.endsWith('.html')?'text/html':name.endsWith('.js')?'application/javascript':name.endsWith('.css')?'text/css':name.endsWith('.png')?'image/png':'image/svg+xml'});
const replay={route:'motion',key:'motion',duration:1,logStart:0,logEnd:.95,warnings:[],video:null,frames:Array.from({length:20},(_,i)=>({t:i*.05,id:i,valid:true,lanes:[],edges:[],lp:[],es:[],leads:[],liveTracksValid:false,steering:{angle:i*10,scale:1,state:'active',color:[0,255,0],active:true,pressed:false,torque:.2},overlay:null}))};
const running=page=>page.evaluate(()=>document.getAnimations().filter(a=>a.playState==='running').map(a=>a.animationName||a.transitionProperty));
(async()=>{
 const browser=await chromium.launch({headless:true});require('./browser-helpers.cjs').openRouteGroups(browser);
 try{
  for(const {width,touch} of [{width:1280,touch:false},{width:390,touch:true},{width:1024,touch:true}])for(const reduced of [false,true]){
   const context=await browser.newContext({viewport:{width,height:900},hasTouch:touch,isMobile:touch,reducedMotion:reduced?'reduce':'no-preference'}),page=await context.newPage(),errors=[];
   page.on('pageerror',e=>errors.push(e.message));
   await context.addInitScript(()=>{
    addEventListener('pageswap',e=>{if(e.viewTransition)sessionStorage.setItem('snapshot-navigation','yes')});
    addEventListener('pagereveal',e=>{if(e.viewTransition)sessionStorage.setItem('snapshot-navigation','yes')});
   });
   let logs=[{id:'one',name:'00000395--0d0eda17c5 / 구간 7',files:{'rlog.zst':'00000395--0d0eda17c5--7--rlog.zst'},status:'processing',progress:{stage:'video_verify',percent:50},uploaded:2,bytes:1,prepared_bytes:0,video:true}];
   await page.route('https://rv.test/**',route=>{
    const p=new URL(route.request().url()).pathname;
   if(p.endsWith('/bookmarks'))return route.fulfill({json:{bookmarks:[]}});
    if(p==='/api/logs')return route.fulfill({json:{logs,concurrency:1,auto_convert:true,keep_original_video:true,max_upload_mb:512,storage_used_bytes:1}});
    // The replay loads vehicle data in the background for the event track; none here.
    if(p.endsWith('/telemetry'))return route.fulfill({status:404,json:{error:'차량 정보 없음'}});
    if(p.endsWith('/data'))return route.fulfill({json:replay});
    if(p==='/api/progress')return route.fulfill({json:{progress:Object.fromEntries(logs.filter(m=>m.status==='processing').map(m=>[m.id,m.progress]))}});
    if(p.startsWith('/api/'))return route.fulfill({json:{progress:{}}});
    return route.fulfill(asset(p==='/'?'library.html':p.startsWith('/view/')?'index.html':p.replace('/assets/','')));
   });
   await page.goto('https://rv.test/');await page.locator('.log-row').waitFor();
   // Processing: a sweep in the badge and a progress bar at video_verify 50% = 0.77 overall.
   assert.equal(await page.locator('.state-progress>span').evaluate(e=>e.style.getPropertyValue('--progress')),'0.77');
   assert.equal((await running(page)).includes('rv-sweep'),!reduced);
   assert((await page.locator('.state-processing').boundingBox()).height<=30,'processing badge stays compact');
   if(!reduced){
    await page.evaluate(()=>{const probe=document.createElement('span');probe.id='sweepProbe';probe.className='state state-processing';probe.style.cssText='position:fixed;top:0;left:0;width:240px;height:24px;z-index:99999';document.body.append(probe);window.probeSweep=probe.getAnimations().find(a=>a.animationName==='rv-sweep');probeSweep.pause()});
    const probe=page.locator('#sweepProbe');
    await page.evaluate(()=>probeSweep.currentTime=540);const bright=await probe.screenshot();
    await page.evaluate(()=>probeSweep.currentTime=1400);const dark=await probe.screenshot();
    await page.evaluate(()=>probeSweep.currentTime=1799);const end=await probe.screenshot();
    assert(!bright.equals(dark),'the beam visibly passes through the badge');
    assert(dark.equals(end),'the end of a cycle does not introduce a second beam');
    await probe.evaluate(e=>e.remove());
   }
   await page.locator('.state-processing').evaluate(async e=>{window.processingBadge=e;window.sweep=e.getAnimations().find(a=>a.animationName==='rv-sweep');if(sweep){await sweep.ready;sweep.currentTime=725;await sweep.ready;window.sweepStart=sweep.startTime}});
   const progressCases=[
    [{stage:'log_prepare',percent:0},'0'],[{stage:'log_decompress',percent:50},'0.025'],
    [{stage:'log_read',frames:99999},'0.04'],[{stage:'log_read',percent:50},'0.245'],
    [{stage:'log_analysis',frames:99999},'0.45'],[{stage:'log_analysis',frames:0,total_frames:20},'0.45'],
    [{stage:'log_analysis',frames:10,total_frames:20},'0.525'],[{stage:'log_analysis',frames:20,total_frames:20},'0.6'],
    [{stage:'log_analysis',frames:25,total_frames:20},'0.6'],[{stage:'log_analysis',frames:-1,total_frames:20},'0.45'],
    [{stage:'log_analysis',frames:1,total_frames:0},'0.45'],[{stage:'log_analysis',total_frames:20},'0.45'],
    [{stage:'video_read',frames:5},'0.6'],[{stage:'video_convert',percent:75},'0.715'],
    [{stage:'video_verify',percent:0},'0.74'],[{stage:'video_verify',percent:90},'0.794'],
    [{stage:'video_verify',percent:100},'0.8'],[{stage:'video_verify',percent:100,video_percent:50},'0.7'],
    [{stage:'video_convert',percent:50,video_percent:50},'0.7'],[{stage:'video_verify',percent:50,video_percent:75},'0.75'],
    [{stage:'telemetry_build',percent:50},'0.825'],[{stage:'telemetry_encode',percent:50},'0.855'],
    [{stage:'telemetry_compress',percent:50},'0.87'],[{stage:'replay_compact',percent:50},'0.9'],
    [{stage:'replay_encode',percent:50},'0.94'],[{stage:'replay_compress',percent:50},'0.98'],
    [{stage:'summary_save',percent:100},'1'],[{stage:'registering'},'1'],[{stage:'saving'},'0.8'],
   ];
   for(const [i,[progress,expected]] of progressCases.entries()){
    logs=[{...logs[0],prepared_bytes:42+i,conversion_revision:i+1,progress}];
    await page.evaluate(()=>refresh());
    assert(await page.locator('.state-processing').evaluate(e=>e===processingBadge),'metadata refresh keeps the badge connected');
    assert.equal(await page.locator('.state-progress').evaluate(e=>e.hidden),['summary_save','registering'].includes(progress.stage),'only the short summary/registration hides the bar');
    if(expected)assert.equal(await page.locator('.state-progress>span').evaluate(e=>e.style.getPropertyValue('--progress')),expected);
    if(!reduced){
     assert(await page.locator('.state-processing').evaluate(e=>e.getAnimations().find(a=>a.animationName==='rv-sweep')===sweep),'stage changes retain the same sweep animation');
     assert.equal(await page.evaluate(()=>sweep.startTime),await page.evaluate(()=>sweepStart),'refresh does not reset the sweep timeline');
     assert(await page.evaluate(()=>sweep.currentTime>=725),'sweep keeps advancing');
    }
   }
   logs=[{...logs[0],conversion_revision:100,progress:{stage:'replay_compress',percent:75}}];await page.evaluate(()=>refresh());
   const forward=await page.locator('.state-progress>span').evaluate(e=>e.style.getPropertyValue('--progress'));
   logs[0].progress={stage:'log_read',percent:10};await page.evaluate(()=>refresh());
   assert.equal(await page.locator('.state-progress>span').evaluate(e=>e.style.getPropertyValue('--progress')),forward,'late progress never moves backwards');
   logs=[{...logs[0],conversion_revision:101,video:false,progress:{stage:'log_analysis',frames:10,total_frames:20}}];await page.evaluate(()=>refresh());
   assert.equal(await page.locator('.state-progress>span').evaluate(e=>e.style.getPropertyValue('--progress')),'0.65','log-only recordings redistribute video work');
   logs[0].progress={stage:'log_analysis',frames:15,total_frames:20};await page.evaluate(()=>refreshProgress());
   assert.equal(await page.locator('.state-progress>span').evaluate(e=>e.style.getPropertyValue('--progress')),'0.7','lightweight polls preserve log-only weights and conversion revision');
   await page.evaluate(()=>refresh());assert.equal(await page.locator('.state-progress>span').evaluate(e=>e.style.getPropertyValue('--progress')),'0.7','full refresh matches lightweight progress');
   await page.evaluate(()=>addFiles([new File(['x'],'unsupported.txt')]));
   assert(await page.locator('#error').evaluate(e=>e.getBoundingClientRect().top-document.querySelector('.lib-appbar').getBoundingClientRect().bottom>=12),'unsupported-file message has top spacing below the app bar');
   await page.locator('#tab-devices').click();
   await page.evaluate(()=>{const d=document.querySelector('.inline-help');for(let p=d.parentElement;p;p=p.parentElement)if(p.tagName==='DETAILS')p.open=true;d.open=true;});
   await page.locator('.inline-help').evaluate(d=>d.querySelector('summary').click());
   assert.equal(await page.locator('.inline-help').evaluate(d=>d.classList.contains('is-closing')), !reduced);
   await page.waitForFunction(()=>!document.querySelector('.inline-help').open);
   await page.locator('#tab-logs').click();
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
   assert.equal(await page.evaluate(()=>transitions),0);
   if(!reduced){
    assert(await page.evaluate(()=>{const e=document.createElement('div');e.style.cssText='position:fixed;left:0;top:0;width:100px;height:20px';document.body.append(e);const motion=RoadViewerMotion,before=motion.capture(e);e.style.width='200px';motion.play(e,before);e.getAnimations()[0].currentTime=120;const middle=motion.capture(e);e.style.width='150px';motion.play(e,middle);const next=motion.capture(e),continuous=Math.abs(next.width-middle.width)<1;e.remove();return continuous}),'an interrupted morph resumes at its visible size');
   }
   // A filter chip that becomes selected pops once with the spring.
   const chipFilter=await page.locator('.filter-chip[aria-pressed=false]').first().getAttribute('data-filter');
   await page.locator(`.filter-chip[data-filter="${chipFilter}"]`).click();
   assert.equal(await page.locator(`.filter-chip[data-filter="${chipFilter}"]`).evaluate(e=>e.getAttribute('aria-pressed')+' '+getComputedStyle(e).animationName),reduced?'true none':'true rv-chip-pop');
   await page.locator('.filter-chip[data-filter="filter:all"]').click();
   // Bulk selection is now in-list, with an instant exit and no viewport scroll lock.
   await page.locator('#bulkOpen').click();assert(await page.locator('#bulkBar').isVisible());
   assert.equal(await page.locator('#bulkBar').evaluate(e=>e.getAnimations().some(a=>a.animationName==='rv-selection-in')), !reduced,'selection bar enters gently unless reduced motion is requested');
   if(!reduced){
    const rise=await page.locator('#bulkBar').evaluate(e=>{const a=e.getAnimations().find(a=>a.animationName==='rv-selection-in');return {duration:a.effect.getTiming().duration,easing:a.effect.getKeyframes()[0].easing}});
    assert.equal(rise.duration,400);assert.match(rise.easing,/^linear\(/,'the selection bar settles with the spring');
   }
   await page.locator('.segment-select input').check();assert(await page.locator('.log-row').evaluate(e=>e.classList.contains('is-selected')));
   assert(await page.locator('#bulkFeedback').isHidden(),'selection does not retain an obsolete prompt');
   assert.equal(await page.evaluate(()=>document.body.style.overflow),'');
   await page.keyboard.press('Escape');await page.locator('#bulkBar').waitFor({state:'hidden'});
   // Keep dialog enter/exit motion coverage on the existing device dialog.
   await page.locator('#pairDialog').evaluate(d=>d.showModal());
   const enter=await page.locator('#pairDialog').evaluate(d=>Object.fromEntries(d.getAnimations().map(a=>[a.transitionProperty,[a.effect.getTiming().duration,a.effect.getTiming().easing]])));
   assert.equal(Object.keys(enter).length>0,!reduced);
   // Dialogs (M3 emphasized): 400 ms rise/grow with emphasized deceleration, 150 ms fade; exit 200 ms emphasized acceleration.
   if(!reduced)assert.deepEqual([enter.transform,enter.opacity],[[400,'cubic-bezier(0.05, 0.7, 0.1, 1)'],[150,'linear']],'dialog enter timing: '+JSON.stringify(enter));
   await page.waitForFunction(()=>document.getElementById('pairDialog').getAnimations().length===0);
   const exit=await page.locator('#pairDialog').evaluate(d=>{d.close();return d.getAnimations().filter(a=>a.transitionProperty==='opacity').map(a=>[a.effect.getTiming().duration,a.effect.getTiming().easing])});
   if(!reduced){
    assert(await page.locator('#pairDialog').evaluate(d=>!d.open&&getComputedStyle(d).display!=='none'),'closing dialog animates out');
    assert.deepEqual(exit,[[200,'cubic-bezier(0.3, 0, 0.8, 0.15)']],'dialog exit is faster, emphasized acceleration');
   }
   await page.locator('#pairDialog').waitFor({state:'hidden'});
   // The tapped log name is handed to the replay page for the page transition.
   await page.locator('.log-row a.replay').click();await page.waitForURL(/view\/two\//);
   await page.waitForFunction(()=>typeof data!=='undefined'&&data);
   logs=[{...logs[0],id:'newer',name:'00000395--0d0eda17c5 / 구간 9'},logs[0],{...logs[0],id:'older',name:'00000396--0d0eda17c5 / 구간 0'}];
   await page.evaluate(()=>loadLogNavigation());
   assert.equal(await page.locator('#nextLog').textContent(),'다음 구간');
   assert.equal(await page.locator('#previousLog').textContent(),'이전 로그');
   assert.equal(await page.evaluate(()=>sessionStorage.getItem('rv-route')),null,'handoff is consumed');
   assert.equal(await page.evaluate(()=>document.body.classList.contains('replay-loading')),false,'loading skeleton ends with the data');
   // Appear-once springs: the transport bar on load; reduced motion has none.
   assert.equal(await page.locator('.playback').evaluate(e=>getComputedStyle(e).animationName),reduced?'none':'rv-transport-in, rv-fade-in');
   // The play triangle's two halves pull apart into the pause bars and close back; reduced motion swaps at once.
   const icon=()=>page.locator('#play .icon-playpause').evaluate(e=>[...e.querySelectorAll('path')].map(p=>p.getAttribute('d')).join(' '));
   const PLAY='M7 4L13.5 8L13.5 16L7 20Z M13.5 8L20 12L20 12L13.5 16Z',PAUSE='M6 4L10 4L10 20L6 20Z M14 4L18 4L18 20L14 20Z';
   assert.equal(await icon(),PLAY);
   const mid=await page.evaluate(()=>new Promise(done=>{document.getElementById('play').click();setTimeout(()=>done([...document.querySelectorAll('#play .icon-playpause path')].map(p=>p.getAttribute('d')).join(' ')),110)}));
   if(reduced)assert.equal(mid,PAUSE,'reduced motion swaps the icon at once');
   else assert(mid!==PLAY&&mid!==PAUSE,'the icon morphs between play and pause: '+mid);
   await page.waitForFunction(p=>[...document.querySelectorAll('#play .icon-playpause path')].map(x=>x.getAttribute('d')).join(' ')===p,PAUSE,{timeout:2000});
   await page.locator('#play').click();
   await page.waitForFunction(p=>[...document.querySelectorAll('#play .icon-playpause path')].map(x=>x.getAttribute('d')).join(' ')===p,PLAY,{timeout:2000});
   // The wheel turns via a CSS transform that glides between 20 Hz samples.
   await page.evaluate(()=>setTime(.5));
   assert.match(await page.locator('#wheelRotate').evaluate(e=>e.style.transform),/rotate\(-100deg\)/);
   assert.equal(await page.locator('#wheelRotate').evaluate(e=>getComputedStyle(e).transitionDuration),reduced?'0s':'0.06s');
   // Tabs retain their selection highlight, but page panels never morph.
   await page.evaluate(()=>{window.transitions=0;const start=document.startViewTransition.bind(document);document.startViewTransition=cb=>{transitions++;return start(cb)}});
   await page.locator('#telemetryTab').click();
   assert(await page.locator('.playback').evaluate(p=>{const r=p.getBoundingClientRect();if(p.contains(document.elementFromPoint(r.x+r.width/2,r.y+10)))return true;return document.documentElement.classList.contains('rv-layout-transition')&&getComputedStyle(p).viewTransitionName==='rv-controls'&&Number(getComputedStyle(document.documentElement,'::view-transition-group(rv-controls)').zIndex)>(Number.parseInt(getComputedStyle(document.documentElement,'::view-transition-group(rv-data)').zIndex)||0)}),'playback snapshot stays above the morphing panel');
   assert.equal(await page.evaluate(()=>transitions),0,'tabs do not use view transitions');
   assert.equal(await page.locator('.camera-panel,.road-panel').evaluateAll(es=>es.flatMap(e=>e.getAnimations()).filter(a=>a.id==='rv-element-morph').length),0,'tab panels do not morph');
   await page.waitForFunction(()=>!document.documentElement.classList.contains('rv-layout-transition'));
   const tab=await page.evaluate(()=>{const t=document.getElementById('telemetryTab'),s=getComputedStyle(t.parentElement);return [s.getPropertyValue('--tab-x'),t.offsetLeft+'px']});
   assert.equal(tab[0],tab[1]);
   await page.evaluate(()=>{document.getElementById('roadTab').click();document.getElementById('telemetryTab').click();document.getElementById('roadTab').click()});
   await page.waitForFunction(()=>!document.documentElement.classList.contains('rv-layout-transition'));
   assert.equal(await page.locator('#roadTab').getAttribute('aria-selected'),'true','rapid tab changes finish on the last choice');
   await page.evaluate(()=>transitions=0);
   if(!reduced)assert.equal(await page.locator('.tab-indicator').evaluate(e=>getComputedStyle(e).transitionTimingFunction),'cubic-bezier(0.4, 0, 0.2, 1), cubic-bezier(0.4, 0, 0.2, 1)');
   if(touch)assert(await page.locator('button,a,summary,input,label').evaluateAll(es=>es.every(e=>getComputedStyle(e).webkitTapHighlightColor==='rgba(0, 0, 0, 0)')),'native rectangular touch highlights are disabled');
   // Layout choices live in the 보기 menu (in ⋯ on phones).
   const viewToggle=async id=>{const menu=await page.locator('#viewMenu').isVisible()?'#viewMenu':'#replayDownload';await page.locator(menu+'>summary').click();await page.locator('#'+id).click();await page.keyboard.press('Escape')};
   await viewToggle('splitView');await page.waitForFunction(()=>!document.documentElement.classList.contains('rv-layout-transition'));
   assert.equal(await page.locator('#splitView').getAttribute('aria-pressed'),'true');
   assert.equal(await page.locator('.camera-panel,.road-panel').evaluateAll(es=>es.flatMap(e=>e.getAnimations()).filter(a=>a.id==='rv-element-morph').length),0,'layout panels do not morph');
   assert.equal(await page.evaluate(()=>transitions),0,'tabs must not snapshot the fixed playback controls');
   if(touch){
    await viewToggle('stackView');
    await page.waitForFunction(()=>!document.documentElement.classList.contains('rv-layout-transition'));
    assert.equal(await page.locator('#stackView').getAttribute('aria-pressed'),'true');
    assert.equal(await page.evaluate(()=>transitions),0,'touch layouts morph named panels too');
    await page.locator('#previousLog').click();await page.waitForURL('**/view/older/');
    await page.waitForFunction(()=>typeof data!=='undefined'&&data);
    await page.locator('.back').click();await page.waitForURL('https://rv.test/');
    await page.locator('.log-row a.replay').first().click();await page.waitForURL('**/view/newer/');
    await page.waitForFunction(()=>typeof data!=='undefined'&&data);
    assert.equal(await page.evaluate(()=>sessionStorage.getItem('snapshot-navigation')),null,'touch page navigation never uses snapshots');
    // Even before external CSS is available, a newly loaded document has an opaque canvas in the screen mode's colour (light here).
    await page.route('**/assets/*.css*',r=>r.fulfill({body:'',contentType:'text/css'}));
    for(const url of ['https://rv.test/','https://rv.test/view/two/']){
     await page.goto(url);
     assert.deepEqual(await page.evaluate(()=>[document.documentElement,document.body].map(e=>getComputedStyle(e).backgroundColor)),['rgb(238, 240, 243)','rgb(238, 240, 243)']);
    }
   }
   assert.deepEqual(errors,[]);await context.close();
  }
  console.log('PASS: list enter/reflow and progress, dialog enter/exit, page handoff, loading state, wheel glide, tab indicator, layout transitions and reduced motion');
 }finally{await browser.close()}
})().catch(e=>{console.error(e);process.exitCode=1});
