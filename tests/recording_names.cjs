const fs=require('fs'),assert=require('node:assert/strict'),{chromium}=require('playwright');
(async()=>{
 const browser=await chromium.launch({headless:true});
 try{
  const page=await browser.newPage({viewport:{width:390,height:844},hasTouch:true}),errors=[];
  page.on('pageerror',e=>errors.push(e.message));
  await page.addInitScript(()=>{
   window.copied=[];
   Object.defineProperty(navigator,'clipboard',{value:{writeText:async text=>{if(window.denyCopy)throw Error('Denied');window.copied.push(text)}}});
   document.execCommand=()=>{if(window.failFallback)return false;window.copied.push(document.activeElement.value);return true};
  });
  const logs=[
   {id:'one',name:'00000395--0d0eda17c5 / 구간 7',files:{'rlog.zst':'00000395--0d0eda17c5--7--rlog.zst'}},
   {id:'two',name:'00000395--0d0eda17c5 / 구간 8'},
   {id:'other',name:'00000395--1234567890 / 구간 9'}
  ].map(row=>({...row,status:'ready',uploaded:1700000000+(row.id==='one'?60:0),bytes:1,prepared_bytes:1,video:false,log_bytes:1,download_options:[],pinned:row.id==='one',tags:row.id==='one'?[{name:'검토',color:'cyan'}]:[]}));
  let failPinId=null;const mutations=[];page.on('dialog',dialog=>dialog.accept());
  await page.route('https://rv.test/**',route=>{
   const p=new URL(route.request().url()).pathname;
   const mutation=/^\/api\/logs\/([^/]+)\/(pin|prepared|convert)$/.exec(p);
   if(mutation&&route.request().method()!=='GET'){
    mutations.push([mutation[1],mutation[2]]);const log=logs.find(log=>log.id===mutation[1]);
    if(mutation[2]==='pin'&&mutation[1]===failPinId)return route.fulfill({status:503,json:{error:'fixture_pin_failure'}});
    if(mutation[2]==='pin')log.pinned=route.request().postDataJSON().pinned;
    else log.status=mutation[2]==='prepared'?'unconverted':'queued';
    return route.fulfill({json:{status:log.status,pinned:log.pinned}});
   }
   if(p.endsWith('/bookmarks'))return route.fulfill({json:{bookmarks:[]}});
   if(p==='/api/logs')return route.fulfill({json:{logs,concurrency:1,max_upload_mb:512,storage_used_bytes:6}});
   if(p==='/api/progress')return route.fulfill({json:{progress:{}}});
   // The replay loads vehicle data in the background for the event track; none here.
   if(p.endsWith('/telemetry'))return route.fulfill({status:404,json:{error:'차량 정보 없음'}});
   if(p.endsWith('/data'))return route.fulfill({json:{route:logs[0].name,duration:1,frames:[{t:0,id:0,valid:true,lanes:[],edges:[],lp:[],es:[],leads:[]}],warnings:[],video:null}});
   if(p==='/api/settings/storage')return route.fulfill({status:404,json:{error:'not_found'}});const name=p==='/'?'library.html':p.startsWith('/view/')?'index.html':p.replace('/assets/','');
   return route.fulfill({body:fs.readFileSync('roadviewer/app/web/'+name),contentType:name.endsWith('.html')?'text/html':name.endsWith('.js')?'application/javascript':name.endsWith('.css')?'text/css':'image/png'});
  });
  await page.goto('https://rv.test/');await page.waitForSelector('.log-row',{state:'attached'});await page.evaluate(()=>document.fonts.ready);
  // Saved logs start folded: every route group is closed and its segment rows hidden until opened.
  assert.deepEqual(await page.locator('.log-route').evaluateAll(groups=>groups.map(g=>g.open)),[false,false]);
  assert(await page.locator('.log-row').first().isHidden());
  // Expansion is not remembered: a group opened by hand is folded again after a reload.
  await page.locator('.log-route[data-route="00000395--0d0eda17c5"]>summary .log-route-name').tap();
  await page.waitForFunction(()=>document.querySelector('.log-route[data-route="00000395--0d0eda17c5"]').open&&!document.querySelector('.log-route')._foldAnimation);
  await page.reload();await page.waitForSelector('.log-row',{state:'attached'});
  assert.deepEqual(await page.locator('.log-route').evaluateAll(groups=>Object.fromEntries(groups.map(g=>[g.dataset.route,g.open]))),{'00000395--0d0eda17c5':false,'00000395--1234567890':false});
  await page.evaluate(()=>document.querySelectorAll('.log-route').forEach(g=>{g.open=true}));await page.waitForSelector('.log-row');
  // Full route IDs group segments without merging equal shortened counters with different hashes.
  const group=page.locator('.log-route[data-route="00000395--0d0eda17c5"]'),summary=group.locator(':scope>summary');
  assert.equal(await page.locator('.log-route').count(),2);
  // An open card is not an open menu: its own ⋯ stays three dots (the ✕ belongs to the menu being open).
  {const icon=()=>summary.locator('.recording-more>summary>.icon-more').evaluate(svg=>({dot:getComputedStyle(svg.querySelector('.more-dot')).opacity,x:getComputedStyle(svg.querySelector('.more-x')).opacity}));
   assert.deepEqual(await icon(),{dot:'1',x:'0'});
   await summary.locator('.recording-more>summary').click();await page.waitForFunction(()=>getComputedStyle(document.querySelector('.log-route>summary .recording-more .more-x')).opacity==='1');
   await summary.locator('.recording-more>summary').click();await page.waitForFunction(()=>{const menu=document.querySelector('.log-route>summary .recording-more');return !menu.open&&getComputedStyle(menu.querySelector('.more-x')).opacity==='0'&&getComputedStyle(menu.querySelector('.more-dot')).opacity==='1'})}
  assert.equal(await group.locator('.log-row').count(),2);
  assert.equal(await group.locator('.log-route-count').textContent(),'2개 구간');
  const firstDate=await page.evaluate(time=>new Date(time*1000).toLocaleString(),logs[0].uploaded);
  // The card title is the first segment's time; the first segment and its upload date are its tooltip.
  assert.equal(await group.locator('.route-time').getAttribute('title'),'첫 구간 7 · 업로드 '+firstDate);
  assert.match(await group.locator('.route-time').textContent(),/^업로드 /,'without started_at the title says it is the upload time');assert.equal(await group.locator('.log-route-name').textContent(),'주행 395');
  await page.evaluate(()=>{window.originalGroupedRow=document.querySelector('.log-row[data-id="one"]');window.originalGroupedState=originalGroupedRow.querySelector('.state');window.originalHeaderButtons=document.querySelector('.log-route-actions .actions');window.originalHeaderHeight=document.querySelector('.log-route>summary').getBoundingClientRect().height});
  logs[1].status='processing';await page.evaluate(()=>refresh());
  assert(await page.evaluate(()=>originalHeaderButtons===document.querySelector('.log-route-actions .actions')),'another segment changing status does not replace the header buttons');
  logs[1].status='ready';await page.evaluate(()=>refresh());
  await summary.focus();await page.keyboard.press('Enter');
  await page.waitForFunction(()=>!document.querySelector('.log-route').open);
  assert(await group.locator('.log-row').first().isHidden());
  assert(await page.evaluate(()=>originalHeaderButtons===document.querySelector('.log-route-actions .actions')),'folding never destroys the header buttons');
  assert(await page.evaluate(()=>Math.abs(originalHeaderHeight-document.querySelector('.log-route>summary').getBoundingClientRect().height)<1),'header height stays fixed across fold states');
  const midpoint=await page.evaluate(async()=>{
   const root=document.querySelector('.log-route'),closed=root.getBoundingClientRect().height;
   root.querySelector('.log-route-name').click();
   const animation=root.getAnimations().find(a=>a.effect.getKeyframes().some(frame=>'height' in frame));
   await animation.ready;animation.pause();animation.currentTime=125;
   await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));
   return {closed,height:root.getBoundingClientRect().height,full:root.getAnimations().find(a=>a===animation).effect.getKeyframes().at(-1).height};
  });
  assert(midpoint.height>midpoint.closed&&midpoint.height<parseFloat(midpoint.full),'only the segment body expands through intermediate heights');
  assert(await page.evaluate(()=>originalHeaderButtons===document.querySelector('.log-route-actions .actions')&&Math.abs(originalHeaderHeight-document.querySelector('.log-route>summary').getBoundingClientRect().height)<1),'mid-animation header buttons and geometry remain stable');
  const reversal=await page.evaluate(()=>{const root=document.querySelector('.log-route'),before=root.getBoundingClientRect().height;root.querySelector('.log-route-name').click();return Math.abs(before-root.getBoundingClientRect().height)});
  assert(reversal<1,'rapid reversal continues from the current height');
  await page.waitForFunction(()=>!document.querySelector('.log-route').open&&!document.querySelector('.log-route')._foldAnimation);

  const headerActions=group.locator(':scope>summary .log-route-actions');
  assert.equal(await headerActions.locator('.replay').getAttribute('href'),'view/one/');
  assert.equal(await page.locator('.replay').count(),5,'both route headers retain their own action alongside segment rows');
  assert.equal(await headerActions.locator('.pin-recording').getAttribute('aria-pressed'),'mixed');
  assert.equal(await headerActions.locator('.pin-partial').count(),0,'all pin states are icon-only');
  assert.equal(await headerActions.locator('.pin-recording').getAttribute('title'),'1/2개 구간 고정됨 · 전체 구간 고정');
  const partialColor=await headerActions.locator('.pin-recording').evaluate(e=>getComputedStyle(e).color);
  // The pinned fill is a layer under the glyph that ripples in and fades out (style.css ::before): read it once settled.
  const pinFill=async button=>{await page.waitForFunction(()=>!document.getAnimations().some(a=>a.transitionProperty),null,{timeout:2000});return button.evaluate(e=>{const f=getComputedStyle(e,'::before');return +f.opacity?f.backgroundColor:getComputedStyle(e).backgroundColor})};
  const partialBackground=await pinFill(headerActions.locator('.pin-recording'));
  assert.equal(await headerActions.locator('.pin-head').evaluate(e=>getComputedStyle(e).fill),'none','partial state is not a filled pin');
  await headerActions.locator('.pin-recording').tap();
  await page.waitForFunction(()=>document.querySelector('.log-route-actions .pin-recording')?.getAttribute('aria-pressed')==='true');
  assert.deepEqual(mutations,[['two','pin']],'partial pin adds protection only to the remaining segment');
  assert.equal(await headerActions.locator('.pin-partial').count(),0);
  assert.equal(await headerActions.locator('.pin-recording').evaluate(e=>getComputedStyle(e).color),partialColor,'partial and full both use the yellow pin');
  assert.notEqual(await pinFill(headerActions.locator('.pin-recording')),partialBackground,'only all-pinned has the yellow background');
  assert(logs[0].pinned&&logs[1].pinned&&!logs[2].pinned,'a different route with the same displayed number is untouched');
  assert.equal(await group.getAttribute('open'),null,'pin does not unfold the route');
  // Partial failures retain acknowledged pin changes and never claim all segments were updated.
  failPinId='two';await headerActions.locator('.pin-recording').tap();
  await page.waitForFunction(()=>document.getElementById('error').textContent.includes('1/2'));
  await page.waitForFunction(()=>document.querySelector('.log-route-actions .pin-recording')?.getAttribute('aria-pressed')==='mixed');
  assert(!logs[0].pinned&&logs[1].pinned&&!logs[2].pinned);
  failPinId=null;await headerActions.locator('.pin-recording').tap();
  await page.waitForFunction(()=>document.querySelector('.log-route-actions .pin-recording')?.getAttribute('aria-pressed')==='true');
  await headerActions.locator('.pin-recording').tap();
  await page.waitForFunction(()=>document.querySelector('.log-route-actions .pin-recording')?.getAttribute('aria-pressed')==='false');
  assert(logs.every(log=>!log.pinned),'a fully pinned route toggles to fully unpinned');
  assert.notEqual(await headerActions.locator('.pin-recording').evaluate(e=>getComputedStyle(e).color),partialColor,'unpinned uses a neutral pin');
  assert.equal(await pinFill(headerActions.locator('.pin-recording')),partialBackground,'unpinned and partial have the same neutral background');
  assert.equal(await headerActions.locator('.pin-partial').count(),0,'unpinned state has no partial label');
  assert(mutations.every(([id,action])=>id!=='other'&&action==='pin'));
  assert.equal(await headerActions.locator('.recording-more').count(),1,'the route keeps its download in its own ⋯ menu');
  await page.evaluate(()=>refresh());
  await headerActions.locator('.recording-more>summary').tap();
  assert.deepEqual(await headerActions.locator('.recording-menu button').allTextContents(),['전체 구간 다운로드','전체 구간 태그 편집']);
  await headerActions.getByRole('button',{name:'전체 구간 다운로드',exact:true}).tap();
  const download=page.locator('.rv-download-dialog');await download.waitFor();
  assert.equal(await download.locator('.rv-download-context').textContent(),'선택한 2개 구간');
  const zip=await download.locator('.rv-download-start').getAttribute('href');
  assert.equal(new URL(zip,'https://rv.test/').searchParams.get('ids'),'one,two','header download includes every segment in this route only');
  await download.locator('.rv-download-close').click();await download.waitFor({state:'detached'});
  assert.equal(await group.getAttribute('open'),null);
  // Metadata changes replace actions but keep the row and processing badge mounted.
  // Polling/status changes must neither reopen a group nor remount a processing badge.
  logs[0].status='processing';logs[0].progress={stage:'log_analysis',frames:10,total_frames:100};
  await page.evaluate(()=>refresh());
  assert.equal(await group.getAttribute('open'),null);
  assert(await page.evaluate(()=>originalGroupedRow===document.querySelector('.log-row[data-id="one"]')&&originalGroupedState===originalGroupedRow.querySelector('.state')));
  assert((await group.locator('.state').first().textContent()).includes('분석'));
  // A newly discovered lower segment supplies the header date; existing order is kept inside the group.
  logs.push({...logs[0],id:'earlier',name:'00000395--0d0eda17c5 / 구간 3',files:{'rlog.zst':'rlog.zst'},uploaded:1700000120,status:'ready',tags:[]});
  await page.evaluate(()=>refresh());
  const lowerDate=await page.evaluate(()=>new Date(1700000120*1000).toLocaleString());
  assert.equal(await group.locator('.route-time').getAttribute('title'),'첫 구간 3 · 업로드 '+lowerDate);
  assert.equal(await group.locator('.log-route-count').textContent(),'3개 구간');
  assert.equal(await headerActions.locator('.replay').getAttribute('href'),'view/earlier/','header actions follow the actual first segment');
  await page.locator('#logChips [data-filter="tag:tag:검토"]').click();
  assert.equal(await group.locator('.log-route-count').textContent(),'1 / 3개 구간');
  assert(await page.locator('.log-route[data-route="00000395--1234567890"]').isHidden());
  assert((await group.locator('.route-time').getAttribute('title')).startsWith('첫 구간 3'), 'filter does not change the first actual segment');
  await page.locator('#logChips [data-filter="tag:tag:검토"]').click();assert.equal(await group.locator('.log-route-count').textContent(),'3개 구간','pressing the tag chip again clears it');
  logs.pop();logs[0].status='ready';delete logs[0].progress;
  await page.reload();await group.waitFor();
  assert.equal(await group.getAttribute('open'),null,'fold state survives reload');
  await summary.locator('.log-route-name').tap();await page.waitForFunction(()=>document.querySelector('.log-route').open&&!document.querySelector('.log-route')._foldAnimation);
  assert(await group.locator('.log-row').first().isVisible());
  assert.equal(await headerActions.locator('.actions').count(),1,'expanding keeps route controls and segment-specific buttons');
  assert(await group.locator('.log-row').first().evaluate(e=>e.classList.contains('is-update')),'expanding does not replay row-insertion effects');
  assert.equal(await group.locator('.log-row[data-id="one"] .replay').count(),1);
  const rowPin=group.locator('.log-row[data-id="one"] .pin-recording');
  await group.locator('.log-row[data-id="one"] .recording-more>summary').tap();await rowPin.tap();await page.waitForFunction(()=>document.querySelector('.log-row[data-id="one"] .pin-recording')?.getAttribute('aria-pressed')==='true');
  assert(logs[0].pinned&&!logs[1].pinned,'expanded-row pin remains segment-specific');
  const rowMenu=group.locator('.log-row[data-id="one"] .recording-more');
  assert.deepEqual(await rowMenu.locator('.recording-menu button').allTextContents(),['제거','다운로드','태그 편집','로그 이름 복사','구간 고정 해제','완전 삭제']);

  for(const width of [320,768,1440]){
   await page.setViewportSize({width,height:900});await page.evaluate(()=>document.fonts.ready);
   assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'route header fits '+width+'px');
   await summary.locator('.log-route-name').tap();await page.waitForFunction(()=>!document.querySelector('.log-route').open);
   const playBox=await headerActions.locator('.replay').boundingBox(),pinBox=await headerActions.locator('.pin-recording').boundingBox(),downloadBox=await headerActions.locator('.recording-more>summary').boundingBox();
   assert(playBox.width<=90,'play stays content-sized at '+width+'px');const iconSize=await page.evaluate(()=>matchMedia('(pointer:coarse)').matches?44:40);assert.equal(Math.round(pinBox.width),iconSize,'icon buttons are 40 px, 44 px for touch');assert.equal(Math.round(downloadBox.width),iconSize);
   assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'collapsed actions fit '+width+'px');
   await summary.locator('.log-route-name').tap();await page.waitForFunction(()=>document.querySelector('.log-route').open&&!document.querySelector('.log-route')._foldAnimation);
  }
  await page.setViewportSize({width:390,height:844});
  // Removing a route clears its wrapper without disturbing other groups or their rows.
  const other=logs.pop();await page.evaluate(()=>refresh());assert.equal(await page.locator('.log-route').count(),1);
  logs.push(other);await page.evaluate(()=>refresh());assert.equal(await page.locator('.log-route').count(),2);
  // Inside its route a segment shows as "구간 7"; the tooltip and copy keep the full original name.
  assert.equal(await page.locator('.log-name .recording-name-text').first().textContent(),'구간 7');
  assert.equal(await page.locator('.log-name .recording-name-text').first().getAttribute('title'),'00000395--0d0eda17c5--7');
  await page.locator('.log-name .copy-recording').first().click();
  assert.deepEqual(await page.evaluate(()=>copied),['00000395--0d0eda17c5--7']);
  const examples=await page.evaluate(()=>[
   recordingIdentity('000AAA--bbbbbbbbbb--0'),
   recordingIdentity('00000000--bbbbbbbbbb / 구간 0'),
   recordingIdentity('직접 올린 로그'),
   recordingIdentity('00000395--0d0eda17c5 / 구간 7',{'rlog.zst':'00000395--0d0eda17c5--007--rlog.zst'})
  ]);
  assert.equal(examples[0].display,'AAA / 구간 0');assert.equal(examples[1].display,'0 / 구간 0');
  assert.equal(examples[2].display,'직접 올린 로그');assert.equal(examples[3].original,'00000395--0d0eda17c5--007');
  await page.evaluate(()=>window.denyCopy=true);await page.locator('.copy-recording').first().click();
  assert.equal(await page.evaluate(()=>copied.length),2);
  await page.evaluate(()=>window.failFallback=true);await page.locator('.copy-recording').first().click();
  assert.equal(await page.locator('.copy-recording').first().getAttribute('title'),'복사하지 못했습니다. 다시 시도해 주세요.');
  await page.evaluate(()=>{copied=[];window.denyCopy=false;window.failFallback=false});
  await summary.locator('.log-route-name').tap();await page.waitForFunction(()=>!document.querySelector('.log-route').open);
  await headerActions.locator('.replay').tap();await page.waitForURL('https://rv.test/view/one/');await page.waitForFunction(()=>document.getElementById('route').textContent==='395 / 구간 7');
  await page.waitForFunction(()=>document.getElementById('logSegment').options.length===2);
  await page.locator('#routeName .copy-recording').click();
  assert.equal(await page.evaluate(()=>copied.at(-1)),'00000395--0d0eda17c5--7');
  // The name, its copy button and the tag button ride in the sticky app bar: still reachable after scrolling.
  await page.evaluate(()=>scrollTo(0,220));await page.waitForFunction(()=>Math.abs(document.querySelector('.app-bar').getBoundingClientRect().top)<1);
  const hit=selector=>page.locator(selector).evaluate(button=>{const r=button.getBoundingClientRect();return button.contains(document.elementFromPoint(r.left+r.width/2,r.top+r.height/2))});
  assert(await hit('#routeName .copy-recording'),'copy button stays tappable in the app bar');
  await page.locator('#routeName .copy-recording').click();
  assert(await hit('#editReplayTags'),'tag button stays tappable in the app bar');
  await page.locator('#editReplayTags').click();
  assert(await page.locator('dialog[open]').count()>0,'tag editor opens');
  assert.equal(await page.evaluate(()=>copied.length),2);assert.deepEqual(errors,[]);
  console.log('PASS: route grouping, first-segment upload dates, persistent keyboard/touch disclosure with stable header controls, smooth height/reversal, collapsed playback, whole-route pins/partial-failure recovery/direct download/compact controls, independent row management, polling DOM stability, filtering, responsive headers, shortened names, original copy, leading zero/text cases, clipboard fallback/error, replay copy and tag buttons in the sticky app bar and unchanged route grouping');
 }finally{await browser.close()}
})().catch(e=>{console.error(e);process.exitCode=1});
