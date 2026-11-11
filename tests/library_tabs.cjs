const fs=require('fs'),os=require('os'),path=require('path'),assert=require('node:assert/strict'),{spawn}=require('child_process'),{once}=require('events'),{chromium}=require('playwright');
const {showTab}=require('./browser-helpers.cjs');
// Library page: in-page tabs with hash links, header summary, filter chips and search, date sections and route cards.
(async()=>{
 const browser=await chromium.launch({headless:true});require('./browser-helpers.cjs').openRouteGroups(browser);
 let python=null;const dir=fs.mkdtempSync(path.join(os.tmpdir(),'rv-tabs-'));
 try{
  const GB=1024**3,today=new Date(),at=(days,h,m)=>new Date(today.getFullYear(),today.getMonth(),today.getDate()-days,h,m).getTime()/1000;
  const seg=(route,n,uploaded,extra={})=>({id:route.slice(4,8)+n,name:`${route} / 구간 ${n}`,files:{'rlog.zst':`${route}--${n}--rlog.zst`},status:'ready',uploaded,duration:60,bytes:1,prepared_bytes:1,video:true,tags:[],pinned:false,conversion_revision:3,...extra});
  const logs=[
   seg('0000041b--a1b2c3d4e5',0,at(0,8,46),{started_at:at(0,8,40),thumbnail:true,tags:[{name:'고속도로',color:'blue'}],drive_summary:{engaged_ratio:1,takeovers:1},storage_locations:{rlog:'local',front:'gdrive'},video_downloads:[{source:'front',kind:'fcamera.mp4',bytes:1}]}),
   seg('0000041b--a1b2c3d4e5',1,at(0,8,47),{started_at:at(0,8,41),duration:180,thumbnail_available:true,drive_summary:{engaged_ratio:.5,takeovers:2},pinned:true}),
   seg('0000041b--a1b2c3d4e5',2,at(0,8,48),{status:'processing',progress:{stage:'video_convert',percent:50}}),
   seg('0000041b--a1b2c3d4e5',3,at(0,8,49),{status:'error',error:'실패'}),
   seg('00000395--0d0eda17c5',0,at(1,18,12),{storage_locations:{rlog:'nas'},tags:[{name:'야간',color:'violet'}]}),
   seg('00000396--0d0eda17c5',0,at(1,7,0),{status:'unconverted',thumbnail:true}),
  ];
  const storage={used_bytes:3.8*GB,max_bytes:4*GB,free_bytes:GB,reserved_bytes:0,policy:'reject_new',archive:{enabled:true,backend:'smb',state:'connected',used_bytes:0,free_bytes:0}};
  const thumbs=[];let uploads={received_bytes:37,total_bytes:100};
  const page=await browser.newPage({viewport:{width:1300,height:900}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.route('https://rv.test/**',route=>{
   const p=new URL(route.request().url()).pathname,url=new URL(route.request().url());
   if(p==='/api/logs')return route.fulfill({json:{logs,concurrency:1,auto_convert:true,max_upload_mb:512,storage_used_bytes:storage.used_bytes,uploads}});
   if(p==='/api/progress')return route.fulfill({json:{progress:{}}});
   if(p==='/api/settings/storage')return route.fulfill({json:storage});
   if(p==='/api/settings/archive')return route.fulfill({json:{archive_enabled:true,archive_backend:'smb',archive_mode:'move',archive_allow_local_delete:true,archive_path:'/share',archive_local_threshold_mb:0,archive_min_age_hours:0,archive_interval_minutes:60,archive_batch:2,archive_nas_max_mb:0,archive_nas_margin_mb:0,archive_gdrive_folder_name:'Road Viewer'}});
   const thumb=/^\/api\/logs\/([^/]+)\/thumbnail$/.exec(p);
   if(thumb){thumbs.push(thumb[1]+url.search);return thumb[1]==='041b0'?route.fulfill({body:'<svg xmlns="http://www.w3.org/2000/svg" width="16" height="9"/>',contentType:'image/svg+xml'}):route.fulfill({status:404,json:{error:'not_found'}})}
   if(p.startsWith('/api/'))return route.fulfill({json:{}});
   if(p.startsWith('/view/'))return route.fulfill({body:'<!doctype html><title>replay</title>',contentType:'text/html'});
   const name=p==='/'?'library.html':p.replace('/assets/','');
   return route.fulfill({body:fs.readFileSync('roadviewer/app/web/'+name),contentType:name.endsWith('.html')?'text/html':name.endsWith('.js')?'application/javascript':name.endsWith('.css')?'text/css':'image/svg+xml'});
  });
  await page.goto('https://rv.test/');await page.locator('.log-row').first().waitFor();  // openRouteGroups unfolds every drive.
  // Tabs: 로그 by default; one tab stop with arrow keys; only the selected panel is shown.
  assert.deepEqual(await page.getByRole('tab').allTextContents(),['로그','업로드','저장공간','장치','설정']);
  assert.equal(await page.locator('[role=tab][tabindex="0"]').count(),1);
  await page.locator('#tab-logs').focus();await page.keyboard.press('ArrowRight');
  assert.equal(await page.evaluate(()=>[document.activeElement.id,location.hash,sessionStorage.getItem('roadviewer-library-tab')].join()),'tab-upload,#upload,upload');
  assert(await page.locator('#panel-upload').isVisible());assert(await page.locator('#panel-logs').isHidden());
  await page.keyboard.press('End');assert.equal(await page.evaluate(()=>document.activeElement.id),'tab-settings');
  assert(await page.locator('#themeControl .theme-switch').isVisible(),'screen mode sits in 설정');
  await page.keyboard.press('Home');assert(await page.locator('#panel-logs').isVisible());
  // A hash change (typed address or link) switches the tab without reloading.
  await page.evaluate(()=>{window.sameDocument=true;location.hash='#devices'});await page.waitForFunction(()=>!document.getElementById('deviceSettings').hidden);
  assert(await page.evaluate(()=>window.sameDocument));
  await page.locator('#tab-logs').click();
  // Header: local usage against the limit (warning colour from 90 %) and the archive state; the meter leads to 저장공간.
  await page.waitForFunction(()=>document.getElementById('headerStorageText').textContent==='3.8/4.0 GB');
  assert(await page.locator('#summary').evaluate(e=>e.classList.contains('is-near-limit')));
  assert.equal(await page.locator('#headerArchiveText').textContent(),'NAS 연결됨');
  // A device's (or another browser's) upload shows in the header chip from the list, and leaves with it.
  await page.waitForFunction(()=>!document.getElementById('uploadPill').hidden&&document.getElementById('uploadPillText').textContent==='업로드 37%');
  uploads=null;await page.waitForFunction(()=>document.getElementById('uploadPill').hidden,null,{timeout:8000});
  // The header asks again every 10 s, and every 3 s while the archive reads 'checking', so a finished check shows soon.
  storage.archive.state='checking';
  await page.waitForFunction(()=>document.getElementById('headerArchiveText').textContent==='NAS 확인 중',null,{timeout:11500});
  storage.archive.state='connected';const recovered=Date.now();
  await page.waitForFunction(()=>document.getElementById('headerArchiveText').textContent==='NAS 연결됨',null,{timeout:4000});
  assert(Date.now()-recovered<4000,'checking is asked again within 3 s');
  assert.match(await page.locator('#summary').getAttribute('title'),/^6개 로그 · 저장공간 3\.8 GB 사용 중/);
  // Counts, date sections (newest first) and route cards.
  assert.equal(await page.locator('#logCounts').textContent(),'주행 3번 · 구간 6개 · 재생 가능 3개');
  assert.deepEqual(await page.locator('.log-day-title').allTextContents(),['오늘'+new Date(at(0,8,46)*1000).toLocaleDateString('ko-KR',{month:'long',day:'numeric',weekday:'long'}),'어제'+new Date(at(1,0,0)*1000).toLocaleDateString('ko-KR',{month:'long',day:'numeric',weekday:'long'})]);
  assert.deepEqual(await page.locator('.log-route').evaluateAll(r=>r.map(e=>e.dataset.route)),['0000041b--a1b2c3d4e5','00000395--0d0eda17c5','00000396--0d0eda17c5']);
  const card=page.locator('.log-route[data-route="0000041b--a1b2c3d4e5"]');
  // Titles use the recording's start (started_at); without it they say honestly that the time is the upload time.
  const clock=t=>new Date(t*1000).toLocaleTimeString('ko-KR',{hour:'numeric',minute:'2-digit'});
  assert.equal(await card.locator('.route-time').textContent(),clock(at(0,8,40))+' 출발');
  assert.equal(await card.locator('.route-time').getAttribute('title'),`첫 구간 0 · 출발 ${new Date(at(0,8,40)*1000).toLocaleString()} · 업로드 ${new Date(at(0,8,46)*1000).toLocaleString()}`);
  assert.equal(await page.locator('.log-route[data-route="00000395--0d0eda17c5"] .route-time').textContent(),'업로드 '+clock(at(1,18,12)));
  assert.equal(await page.locator('.log-row[data-id="041b0"] .log-time').textContent(),'08:40–08:41','segment ranges come from started_at + duration');
  assert.equal(await page.locator('.log-row[data-id="03950"] .log-time').count(),0,'no range from upload times');
  assert.equal(await card.locator('.route-meta').textContent(),'주행 41b · 4개 구간');
  assert.equal(await card.locator('.route-duration').textContent(),'6:00');
  assert.deepEqual(await card.locator('.route-seg').evaluateAll(b=>b.map(e=>e.dataset.status)),['ready','ready','processing','error']);
  assert.equal(await card.locator('.route-status').textContent(),'재생 가능 2 · 처리 중 1 · 변환 실패 1');
  // Duration-weighted: (100 % × 60 s + 50 % × 180 s) / 240 s = 62.5 % → 63 %; takeovers are summed.
  assert.equal(await card.locator('.route-drive').textContent(),'자동 제어 63% · 개입 3회');
  assert.equal(await page.locator('.log-route[data-route="00000396--0d0eda17c5"] .route-drive').count(),0,'no summary, no line');
  assert.equal(await card.locator('.route-facts .storage-summary').textContent(),'혼합');
  assert.equal(await page.locator('.log-row[data-id="041b0"] .storage-summary').textContent(),'로그 로컬 · 영상 Drive');
  assert.equal(await page.locator('.log-row[data-id="041b0"] .storage-parts').count(),0,'a uniform summary needs no per-part chips');
  assert.equal(await page.locator('.log-route[data-route="00000395--0d0eda17c5"] .storage-summary').first().textContent(),'모두 NAS');
  assert.equal(await card.locator('.log-route-actions .replay').getAttribute('href'),'view/041b0/');
  // Thumbnails: the route card uses its first ready segment; versioned by conversion; a failed one falls back.
  await page.waitForFunction(()=>document.querySelector('.log-route .route-thumb img')?.complete);
  assert.equal(await card.locator('.route-thumb img').getAttribute('src'),'api/logs/041b0/thumbnail?v=3');
  assert.equal(await card.locator('.route-thumb img').getAttribute('loading'),'lazy');
  // A shown picture hides the camera placeholder for good, so a fold's re-paint cannot flash it.
  await page.waitForFunction(()=>document.querySelector('.log-route .route-thumb')?.classList.contains('has-thumb'));
  assert.equal(await card.locator('.route-thumb .thumb-placeholder').evaluate(e=>getComputedStyle(e).visibility),'hidden');
  // The server lists newer segments first: the card still shows the first segment's picture.
  logs.reverse();await page.locator('#refresh').click();await page.waitForTimeout(400);
  assert.equal(await card.locator('.route-thumb img').getAttribute('src'),'api/logs/041b0/thumbnail?v=3','card thumbnail comes from the lowest segment, not the first listed');
  logs.reverse();await page.locator('#refresh').click();await page.waitForTimeout(400);
  await page.waitForFunction(()=>!document.querySelector('.log-row[data-id="041b1"] .log-thumb img'));
  assert(thumbs.includes('041b1?v=3&pending=1'),'thumbnail_available asks for one, under its own URL so a made one is fetched again');assert(await page.locator('.log-row[data-id="041b1"] .thumb-placeholder').isVisible(),'a failed thumbnail shows the placeholder');
  // Made later by the backfill: the next list reports it and the image is asked for again.
  {const made=logs.find(log=>log.id==='041b1');delete made.thumbnail_available;made.thumbnail=true;await page.evaluate(()=>refresh());
   for(let i=0;i<100&&!thumbs.includes('041b1?v=3');i++)await page.waitForTimeout(20);
   assert(thumbs.includes('041b1?v=3'),'a thumbnail made after the first try is fetched again');
   delete made.thumbnail;made.thumbnail_available=true;await page.evaluate(()=>refresh())}
  assert.equal(await page.locator('.log-route[data-route="00000396--0d0eda17c5"] .route-thumb img').count(),0,'only ready segments show a thumbnail');
  // Refresh must update wording even if the new start equals the old upload time, and keep the tooltip current.
  const fallback=page.locator('.log-route[data-route="00000395--0d0eda17c5"] .route-time'),upload=logs[4].uploaded;
  assert.equal(await fallback.getAttribute('title'),'첫 구간 0 · 업로드 '+new Date(upload*1000).toLocaleString());
  logs[4].started_at=upload;await page.evaluate(()=>refresh());
  assert.equal(await fallback.textContent(),clock(upload)+' 출발');
  logs[4].uploaded=upload+60;await page.evaluate(()=>refresh());
  assert.equal(await fallback.getAttribute('title'),`첫 구간 0 · 출발 ${new Date(upload*1000).toLocaleString()} · 업로드 ${new Date((upload+60)*1000).toLocaleString()}`);
  delete logs[4].started_at;logs[4].uploaded=upload;
  // A later segment arriving first must not supply the route date or reorder the server's segment list.
  const first=logs[0],second=logs[1];logs[0]=second;logs[1]=first;first.started_at=at(2,8,40)+.25;
  await page.evaluate(()=>refresh());
  assert.equal(await card.locator('.route-time').textContent(),clock(first.started_at)+' 출발');
  const firstDay=new Date(first.started_at*1000);
  assert.equal(await card.locator('xpath=../..').getAttribute('data-day'),`${firstDay.getFullYear()}-${firstDay.getMonth()+1}-${firstDay.getDate()}`);
  assert.deepEqual(await card.locator('.log-row').evaluateAll(rows=>rows.map(row=>row.dataset.id)),['041b1','041b0','041b2','041b3']);
  assert.deepEqual(await page.locator('.log-route').evaluateAll(routes=>routes.map(route=>route.dataset.route)),['0000041b--a1b2c3d4e5','00000395--0d0eda17c5','00000396--0d0eda17c5'],'route order follows the server even when the date is older');
  delete first.started_at;await page.evaluate(()=>refresh());
  assert.equal(await card.locator('.route-time').textContent(),'업로드 '+clock(first.uploaded),'a later segment start cannot replace a missing first-segment start');
  assert.equal(await card.locator('xpath=../..').getAttribute('data-day'),`${today.getFullYear()}-${today.getMonth()+1}-${today.getDate()}`);
  assert.equal(await page.locator('.log-row[data-id="041b0"] .log-time').count(),0);
  logs[0]=first;logs[1]=second;first.started_at=at(0,8,40);await page.evaluate(()=>refresh());
  // Chips: built-in group AND one tag; every tag has its own chip with a count.
  const chips=await page.locator('#logChips .filter-chip:not(.chip-more)').evaluateAll(c=>c.map(e=>e.textContent));
  assert.deepEqual(chips,['전체','고정1','미변환2','처리 중1','Drive1','NAS1','태그 없음4','고속도로1','야간1']);
  const chip=name=>page.locator('#logChips .filter-chip').filter({hasText:name}).first();
  const shown=()=>page.locator('.log-row').evaluateAll(rows=>rows.filter(r=>!r.hidden).map(r=>r.dataset.id));
  await chip('미변환').click();assert.deepEqual(await shown(),['041b3','03960']);
  assert.equal(await card.locator('.log-route-count').textContent(),'1 / 4개 구간');
  await chip('태그 없음').click();assert.deepEqual(await shown(),['041b3','03960'],'AND with a tag chip');
  await chip('고속도로').click();assert.deepEqual(await shown(),[]);assert.equal(await page.locator('#tagFilterStatus').textContent(),'조건에 맞는 로그가 없습니다.');
  assert(await page.locator('.log-day').first().isHidden(),'empty date sections hide');
  await chip('미변환').click();assert.deepEqual(await shown(),['041b0']);assert.equal(await page.locator('#tagFilterStatus').textContent(),'1개 로그 표시 중');
  await chip('전체').click();assert.equal(await page.locator('#tagFilterStatus').isHidden(),true);assert.equal((await shown()).length,6);
  // Search: names, route IDs, tags and dates.
  for(const [query,ids] of [['구간 3',['041b3']],['00000395',['03950']],['야간',['03950']],['어제',['03950','03960']],['고속도로',['041b0']],['41B / 구간 0',['041b0']]]){
   await page.locator('#logSearch').fill(query);assert.deepEqual((await shown()).sort(),ids.sort(),query);
  }
  await page.locator('#logSearch').fill('');
  // Phone: bottom tab bar, horizontally scrolling chips, storage warning linking to 저장공간, nothing overflows.
  await page.setViewportSize({width:390,height:844});
  const bar=await page.locator('.lib-tabs').boundingBox();assert(Math.abs(bar.y+bar.height-844)<1&&bar.width>=389,'tabs sit at the bottom on phones');
  assert.equal(await page.locator('#logChips').evaluate(e=>getComputedStyle(e).flexWrap),'nowrap');
  assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  // Phone app bar: the Road Viewer wordmark stays beside the icon and never meets the right group, with or without the
  // upload pill (widest label). It keeps full size wherever there is room and shrinks only when the free width runs out.
  for(const width of [320,360,390,430])for(const pill of [false,true]){
   await page.setViewportSize({width,height:844});
   await page.evaluate(on=>{const p=document.getElementById('uploadPill');p.hidden=!on;document.getElementById('uploadPillText').textContent='업로드 100%'},pill);
   await page.locator('#uploadPill').waitFor({state:pill?'visible':'hidden'});
   await page.waitForFunction(()=>document.querySelector('.lib-appbar h1').getAnimations().length===0);
   // Off-screen cards settle their real heights over the next frames (content-visibility), which can add or remove the
   // scrollbar and so change the width the header has.
   await page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));
   const m=await page.evaluate(()=>{
    const h=document.querySelector('.lib-appbar h1').getBoundingClientRect(),st=document.querySelector('.lib-status').getBoundingClientRect(),inner=document.querySelector('.lib-appbar-inner').getBoundingClientRect();
    const t=document.querySelector('.lib-appbar h1');
    return {wordmark:h.width,size:parseFloat(getComputedStyle(t).fontSize),cut:t.scrollWidth>t.clientWidth+.5,gap:st.left-h.right,right:inner.right-st.right,overflow:document.documentElement.scrollWidth-innerWidth,text:getComputedStyle(document.getElementById('headerStorageText')).display,parts:[...document.querySelector('.lib-status').children].map(c=>[c.id||c.className,Math.round(c.getBoundingClientRect().width),c.textContent.slice(0,30)])}});
   assert(m.wordmark>60,`wordmark visible at ${width}${pill?' with the upload pill':''}`);
   assert(m.gap>=6&&m.right>=0&&m.overflow<=0,`wordmark and right group do not collide at ${width}${pill?' with the upload pill':''}: `+JSON.stringify(m));
   assert(!m.cut&&m.size>=14&&m.size<=16,'wordmark is whole, 14–16px: '+JSON.stringify(m));
   if(width>=430||!pill)assert.equal(m.size,16,`full-size wordmark when there is room (${width}${pill?', upload pill':''})`);
   if(pill&&width<=360)assert(m.size<16||m.text==='none','the wordmark shrinks (or the storage text yields) when the free width runs out at '+width);
   if(width>=430)assert.notEqual(m.text,'none','storage text stays when there is room at '+width);
  }
  await page.evaluate(()=>{document.getElementById('uploadPill').hidden=true});await page.setViewportSize({width:390,height:844});
  assert(await page.locator('#storageWarning').isVisible());assert.equal(await page.locator('#storageWarningText').textContent(),'로컬 저장공간 95% 사용 중');
  await page.locator('#storageWarning button').click();assert.equal(await page.locator('#tab-storage').getAttribute('aria-selected'),'true');
  await page.locator('#archiveForm[data-loaded=true]').waitFor();
  await showTab(page,'logs');
  // Phone card: the empty part of the actions row (under the thumbnail, left of 재생) folds the card like the rest of it;
  // the gaps between the buttons do not.
  {const open=()=>card.evaluate(e=>e.open),before=await open();
   // Off-screen cards skip rendering (content-visibility): the card is brought into view and rendered before measuring.
   await card.scrollIntoViewIfNeeded();await page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));
   const spot=await card.evaluate(e=>{const row=e.querySelector('.log-route-actions').getBoundingClientRect(),buttons=e.querySelector('.log-route-actions .actions').getBoundingClientRect();
    return {x:row.left+8,y:row.top+row.height/2,inside:buttons.left-row.left>40,gap:(()=>{const b=[...e.querySelectorAll('.log-route-actions .actions>*')].map(n=>n.getBoundingClientRect());return {x:(b[0].right+b[1].left)/2,y:b[0].top+b[0].height/2}})()}});
   assert(spot.inside,'the actions row has empty room left of the buttons on a phone');
   await page.mouse.click(spot.x,spot.y);await page.waitForFunction(b=>document.querySelector('.log-route[data-route="0000041b--a1b2c3d4e5"]').open!==b,before);
   await page.waitForTimeout(400);const after=await open();await page.mouse.click(spot.gap.x,spot.gap.y);await page.waitForTimeout(400);
   assert.equal(await open(),after,'a tap between the buttons does not fold the card');
   await page.mouse.click(spot.x,spot.y);await page.waitForFunction(b=>document.querySelector('.log-route[data-route="0000041b--a1b2c3d4e5"]').open===b,before);await page.waitForTimeout(400)}
  // While a card folds, its header's lower corners ease to square (and back) and the list slides out from behind it the sliding list on an opaque background (on phones the list's clip can trail its slide); shades under the divider and over
  // the closing edge follow how folded the card is: fading out as it opens, coming in as it closes; none remain at rest.
  {const shade=()=>card.evaluate(e=>{const s=e.querySelector(':scope>summary'),of=name=>s.getAnimations({subtree:true}).find(a=>a.effect.target===s&&a.effect.pseudoElement===name)?.effect.getKeyframes().map(f=>Number(f.opacity));
    const list=e.querySelector('.log-route-segments'),after=list.getAnimations({subtree:true}).find(a=>a.effect.target===list&&a.effect.pseudoElement==='::after')?.effect.getKeyframes().map(f=>Number(f.opacity)),before=of('::before'),heights=s.getAnimations({subtree:true}).find(a=>a.effect.target===s&&a.effect.pseudoElement==='::after')?.effect.getKeyframes().map(f=>parseFloat(f.height));
    const css=getComputedStyle(s),corner=s.getAnimations().find(a=>!a.effect.pseudoElement)?.effect.getKeyframes().map(f=>parseFloat(f.borderBottomLeftRadius));return {corners:corner&&[corner[0],corner.at(-1)],behind:getComputedStyle(e.querySelector('.log-route-segments')).zIndex,folding:e.classList.contains('is-folding'),z:css.zIndex,opaque:css.backgroundImage!=='none'||!/rgba\(0, 0, 0, 0\)|transparent/.test(css.backgroundColor),divider:css.boxShadow.includes('inset'),after:after&&[after[0],after.at(-1)],strip:heights&&[heights[0],heights.at(-1)],same:JSON.stringify(after)===JSON.stringify(before)}});
   const wasOpen=await card.evaluate(e=>e.open);
   // The card's outline is drawn around the header and the visible panel (summary::after) while it folds.
   const [head,stripFull]=await card.evaluate(e=>{const o=e.open,s=e.querySelector(':scope>summary').offsetHeight;e.open=true;const h=e.clientHeight-s;e.open=o;return [s,h]});
   const near=(a,b)=>a&&Math.abs(a[0]-b[0])<3&&Math.abs(a[1]-b[1])<3;
   if(wasOpen){await card.locator('.log-route-chevron').click();await card.evaluate(e=>e.classList.contains('is-folding')?new Promise(done=>{const o=new MutationObserver(()=>{if(!e.classList.contains('is-folding')){o.disconnect();done()}});o.observe(e,{attributes:true,attributeFilter:['class']})}):null)}
   await card.locator('.log-route-chevron').click();
   // The folding card keeps its content-visibility (lifting and restoring it flashed it blank on Android) and its clip
   // reaches past it far enough for the drawn outline and shadow.
   assert.deepEqual(await card.evaluate(e=>{const c=getComputedStyle(e);return [e.classList.contains('is-folding'),c.contentVisibility,c.overflowClipMargin]}),[true,'auto','48px'],'the fold keeps content-visibility');
   {const s=await shade();assert(near(s.strip,[head,head+stripFull]),'opening: the drawn outline grows from the header to the whole card '+JSON.stringify(s.strip));delete s.strip;assert.deepEqual(s,{corners:[16,0],behind:'auto',folding:true,z:'1',opaque:true,divider:true,after:[1,0],same:true},'opening: header on top, shades fade out')}
   await card.evaluate(e=>e.classList.contains('is-folding')?new Promise(done=>{const o=new MutationObserver(()=>{if(!e.classList.contains('is-folding')){o.disconnect();done()}});o.observe(e,{attributes:true,attributeFilter:['class']})}):null);
   await card.locator('.log-route-chevron').click();
   {const s=await shade();assert(near(s.strip,[head+stripFull,head]),'closing: the drawn outline shrinks back to the header '+JSON.stringify(s.strip));delete s.strip;assert.deepEqual(s,{corners:[0,16],behind:'auto',folding:true,z:'1',opaque:true,divider:true,after:[0,1],same:true},'closing: header on top, shades come in')}
   await card.evaluate(e=>e.classList.contains('is-folding')?new Promise(done=>{const o=new MutationObserver(()=>{if(!e.classList.contains('is-folding')){o.disconnect();done()}});o.observe(e,{attributes:true,attributeFilter:['class']})}):null);
   assert.deepEqual(await card.evaluate(e=>[e.open,e.classList.contains('is-folding'),getComputedStyle(e.querySelector(':scope>summary'),'::after').content]),[false,false,'none'],'nothing remains after the fold');
   if(wasOpen){await card.locator('.log-route-chevron').click();await card.evaluate(e=>e.classList.contains('is-folding')?new Promise(done=>{const o=new MutationObserver(()=>{if(!e.classList.contains('is-folding')){o.disconnect();done()}});o.observe(e,{attributes:true,attributeFilter:['class']})}):null)}}
  assert.deepEqual(errors,[]);
  // Tapping a ready row plays it.
  await page.locator('.log-row[data-id="041b0"] .log-meta').click();await page.waitForURL('https://rv.test/view/041b0/');

  // In the real shell (SPA navigation), a hash-only change keeps the mounted page, and the tab survives a round trip to replay.
  python=spawn(process.env.RV_PYTHON||'python',['-u','-c',`import sys
sys.path.insert(0,'roadviewer/app')
import server
from werkzeug.serving import make_server
server.app.logger.disabled=True
http=make_server('127.0.0.1',0,server.app,threaded=True)
print('READY '+str(http.server_port),flush=True)
http.serve_forever()`],{env:{...process.env,RV_DATA:dir,RV_INGRESS_ONLY:'0'},stdio:['ignore','pipe','pipe']});
  let stderr='';python.stderr.on('data',x=>stderr+=x);
  const port=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('Server timeout '+stderr)),15000);python.once('exit',code=>{clearTimeout(timer);reject(Error('Server exit '+code+stderr))});python.stdout.on('data',x=>{const m=/READY (\d+)/.exec(String(x));if(m){clearTimeout(timer);resolve(Number(m[1]))}})});
  const shell=await browser.newPage({viewport:{width:1300,height:900}}),shellErrors=[];shell.on('pageerror',e=>shellErrors.push(e.message));
  const base=`http://127.0.0.1:${port}/`;
  await shell.goto(base+'#storage');await shell.waitForFunction(()=>document.getElementById('tab-storage')?.getAttribute('aria-selected')==='true');
  await shell.evaluate(()=>{window.mountedPage=document.getElementById('pageHost').firstElementChild});
  await shell.evaluate(()=>{location.hash='#devices'});await shell.waitForFunction(()=>document.getElementById('tab-devices').getAttribute('aria-selected')==='true');
  await shell.goBack();await shell.waitForFunction(()=>document.getElementById('tab-storage').getAttribute('aria-selected')==='true');
  assert(await shell.evaluate(()=>window.mountedPage===document.getElementById('pageHost').firstElementChild),'hash changes never remount the library');
  assert.equal(await shell.locator('#navigationStatus').textContent(),'');
  assert.deepEqual(shellErrors,[]);
  console.log('PASS: library tabs (keyboard, hash links, session memory, shell hash changes), header usage/archive, counts, date sections, route cards (status, drive summary, storage, thumbnails), chips AND search, phone tab bar, warning and row tap');
 }finally{await browser.close();if(python&&python.exitCode===null){python.kill();await once(python,'exit')}fs.rmSync(dir,{recursive:true,force:true})}
})().catch(e=>{console.error(e);process.exitCode=1});
