const fs=require('fs'),assert=require('node:assert/strict'),{chromium}=require('playwright');
const {settleLayout}=require('./browser-helpers.cjs');
(async()=>{
 const browser=await chromium.launch({headless:true});
 try{
  const page=await browser.newPage({viewport:{width:390,height:1000},reducedMotion:'reduce'}),errors=[];
  page.on('pageerror',e=>errors.push(e.message));
  const GB=1024**3,storage={used_bytes:3.8*GB,max_bytes:4*GB,free_bytes:4.9*GB,reserved_bytes:0,policy:'reject_new',archive:{enabled:true,backend:'gdrive',state:'checking',used_bytes:58.3*GB,free_bytes:4.6*1024*GB,usage_reliable:true,remote_copies_files:12,remote_copies_bytes:1.2*GB,archive_errors:{remote_mismatch:2},gdrive:{connected:true,configured:true}}};
  const frame={t:0,id:0,valid:true,lanes:[],edges:[],lp:[.366,.945,.995,.001],es:[3.695,.370],leads:[],selected:{x:35.3},laneY0:[-5.4,-1.8,1.8,5.4],edgeY0:[-6.2,6.4],liveTracksValid:false};
  await page.route('https://rv.test/**',route=>{
   const p=new URL(route.request().url()).pathname;
   if(p==='/api/logs')return route.fulfill({json:{logs:[],max_upload_mb:512,storage_used_bytes:storage.used_bytes,concurrency:1}});
   if(p==='/api/settings/archive')return route.fulfill({json:{archive_enabled:true,archive_backend:'gdrive',archive_mode:'copy',archive_allow_local_delete:false,archive_path:'',archive_local_threshold_mb:3072,archive_min_age_hours:168,archive_interval_minutes:1440,archive_batch:2,archive_nas_max_mb:0,archive_nas_margin_mb:1024,archive_gdrive_folder_name:'Road Viewer'}});
   if(p==='/api/settings/storage')return route.fulfill({json:storage});
   if(p.endsWith('/data'))return route.fulfill({json:{route:'preview',key:'ui',duration:60,warnings:[],video:null,frames:[frame]}});
   if(p.endsWith('/bookmarks'))return route.fulfill({json:{bookmarks:[]}});
   if(p.startsWith('/api/'))return route.fulfill({json:{progress:{}}});
   const name=p==='/'?'library.html':p.startsWith('/view/')?'index.html':p.replace('/assets/','');
   return route.fulfill({body:fs.readFileSync('roadviewer/app/web/'+name),contentType:name.endsWith('.html')?'text/html':name.endsWith('.js')?'application/javascript':name.endsWith('.css')?'text/css':name.endsWith('.woff2')?'font/woff2':'image/svg+xml'});
  });
  await page.goto('https://rv.test/');await page.locator('#storageSettings>summary').click();await page.locator('#archiveRun').waitFor();
  assert.equal(await page.locator('#storageUsage>div').count(),4);assert.equal(await page.locator('#archiveUsage>div,#archiveSecondaryUsage>div').count(),9);
  assert.equal(await page.locator('#storageMeter').getAttribute('aria-valuenow'),'95');
  for(const width of [320,390,768,1024,1100,1440,1920]){
   await page.setViewportSize({width,height:1000});await settleLayout(page,'#storageSettings');
   assert(await page.locator('#storageSettings').evaluate(el=>el.scrollWidth<=el.clientWidth),'storage does not overflow '+width);
   const cards=await page.locator('.storage-overview').evaluate(el=>{
    const box=selector=>{const r=el.querySelector(selector).getBoundingClientRect();return {left:r.left,top:r.top,bottom:r.bottom,width:r.width}};
    return {local:box('.storage-local'),archive:box('.storage-archive'),connection:box('.gdrive-panel'),bottom:el.getBoundingClientRect().bottom};
   });
   assert(cards.connection.left>=cards.local.left&&cards.connection.left+cards.connection.width<=cards.local.left+cards.local.width,'connection is grouped within local storage '+width);
   assert(cards.connection.bottom<=cards.local.bottom,'connection does not create a separate empty grid row '+width);
   if(width>=1100){
    assert(Math.abs(cards.archive.top-cards.local.top)<1,'remote storage stays aligned with local storage '+width);
    assert(Math.abs(cards.archive.bottom-cards.local.bottom)<1,'desktop storage cards have matching heights '+width);
    assert(Math.abs(cards.bottom-Math.max(cards.archive.bottom,cards.local.bottom))<1,'no trailing panel margin '+width);
   }else assert(cards.archive.top>=cards.local.bottom,'mobile and tablet stack capacity groups '+width);
   if(process.env.RV_PANEL_CAPTURE&&[390,1440,1920].includes(width)){await page.locator('.storage-settings-body').screenshot({path:`/tmp/roadviewer-storage-${width}-after.png`});await page.locator('.storage-overview').screenshot({path:`/tmp/roadviewer-storage-overview-${width}.png`})}
  }
  await page.evaluate(()=>showStorage({used_bytes:120,max_bytes:100,free_bytes:0,reserved_bytes:0,archive:{enabled:false}}));
  assert.equal(await page.locator('#storageMeter').getAttribute('aria-valuenow'),'100');assert.equal(await page.locator('#storageUsagePercent').textContent(),'120% 사용');
  await page.evaluate(()=>showStorage({used_bytes:1,max_bytes:0,free_bytes:0,reserved_bytes:0,archive:{enabled:false}}));
  assert(await page.locator('#storageMeter').isHidden());assert(await page.locator('#archiveSummary').isHidden());assert.equal(await page.locator('#archiveRun').count(),0);
  await page.goto('https://rv.test/view/one/');await page.locator('#play:enabled').waitFor();
  assert.deepEqual(await page.locator('#boundaryLanes strong').allTextContents(),['36.6%','94.5%','99.5%','0.1%']);
  assert.equal(await page.locator('#lead').textContent(),'35.3 m');
  for(const width of [320,390,768,1440]){
   await page.setViewportSize({width,height:1000});await settleLayout(page,'.boundary-summary');
   let probabilityLayout;
   for(const distance of [false,true]){
    if((await page.locator('#boundaryDistance').getAttribute('aria-pressed')==='true')!==distance)await page.locator('#boundaryDistance').click();
    const cells=await page.locator('.boundary-lane,.boundary-edge').evaluateAll(nodes=>nodes.map(el=>({ok:el.scrollWidth<=el.clientWidth,title:el.textContent})));
    assert(cells.every(cell=>cell.ok),`readout overflow ${width} distance=${distance}: ${JSON.stringify(cells)}`);
    const layout=await page.locator('.boundary-lane,.boundary-edge').evaluateAll(nodes=>nodes.map(el=>{const r=el.getBoundingClientRect(),value=el.querySelector('strong'),v=value.getBoundingClientRect();return {top:r.top,height:r.height,valueTop:v.top-r.top,valueLeft:v.left-r.left,font:getComputedStyle(value).fontSize}}));
    if(!distance)probabilityLayout=layout;
    else for(let i=0;i<layout.length;i++){
     assert(Math.abs(layout[i].top-probabilityLayout[i].top)<1&&Math.abs(layout[i].height-probabilityLayout[i].height)<1,'readout cards keep their geometry when switching modes '+width+' card '+i+' '+JSON.stringify([probabilityLayout[i],layout[i]]));
     assert(Math.abs(layout[i].valueTop-probabilityLayout[i].valueTop)<1,'values keep their vertical alignment '+width);
     assert.equal(layout[i].font,probabilityLayout[i].font,'font size does not change with mode '+width);
    }
    const rows=await page.locator('#boundaryLanes strong').evaluateAll(nodes=>nodes.map(el=>el.getBoundingClientRect().top));assert(rows.every(y=>Math.abs(y-rows[0])<1),'four lane values share a baseline');
    if(width===390&&!distance&&process.env.RV_PANEL_CAPTURE){await page.locator('.boundary-summary').evaluate(el=>scrollTo(0,scrollY+el.getBoundingClientRect().top-220));await settleLayout(page,'.boundary-summary');await page.locator('.boundary-summary').screenshot({path:'/tmp/roadviewer-boundary-panel.png'})}
   }
  }
  assert.equal(await page.locator('#left').textContent(),'-1.800 m');assert.equal(await page.locator('#right').textContent(),'+1.800 m');
  assert.deepEqual(errors,[]);console.log('PASS: grouped storage metrics, quota/unlimited states, camera label-value pairing, probability/distance mode and responsive layout');
 }finally{await browser.close()}
})().catch(e=>{console.error(e);process.exitCode=1});
