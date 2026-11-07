const fs=require('fs'),assert=require('node:assert/strict'),{chromium}=require('playwright');
// The replay ⋯ menu: an icon in the app bar (no taller bar) with 제거, downloads (the log plus a choice of camera
// videos, or the download dialog), camera info, 화면 모드, recording info, the version and 완전 삭제, as in the log list.
const asset=name=>({body:fs.readFileSync('roadviewer/app/web/'+name),contentType:name.endsWith('.html')?'text/html':name.endsWith('.js')?'application/javascript':name.endsWith('.css')?'text/css':name.endsWith('.png')?'image/png':name.endsWith('.woff2')?'font/woff2':'image/svg+xml'});
const MB=1024*1024,VERSION='v'+fs.readFileSync('roadviewer/config.yaml','utf8').match(/version: "([^"]+)"/)[1];
const logs=[
 {id:'multi',name:'000003cb--8bf810e0fe / 구간 16',files:{'rlog.zst':'000003cb--8bf810e0fe--16--rlog.zst'},status:'ready',uploaded:3,bytes:1,prepared_bytes:1,video:true,
  video_downloads:[{source:'front',kind:'fcamera.hevc',bytes:48.4*MB},{source:'wide',kind:'ecamera.hevc',bytes:47*MB},{source:'qcamera',kind:'qcamera.ts',bytes:2.2*MB}]},
 {id:'single',name:'000003cb--8bf810e0fe / 구간 15',status:'ready',uploaded:2,bytes:1,prepared_bytes:1,video:true,video_downloads:[{source:'qcamera',kind:'qcamera.ts',bytes:2.2*MB}]},
 {id:'nolog',name:'000003cb--8bf810e0fe / 구간 14',status:'ready',uploaded:1,bytes:1,prepared_bytes:1,video:false,video_downloads:[]},
 {id:'remote',name:'000003cb--8bf810e0fe / 구간 13',status:'ready',uploaded:0,bytes:1,prepared_bytes:1,video:true,download_options:[{source:'front'},{source:'qcamera'}],
  video_downloads:[{source:'front',kind:'fcamera.mp4',bytes:40*MB},{source:'qcamera',kind:'qcamera.mp4',bytes:2*MB}],storage_locations:{rlog:'local',front:'gdrive',qcamera:'gdrive'},video_state:{front:'available',qcamera:'available'}}
];
const deleted=[];
const replay={route:'test',key:'k',duration:1,warnings:[],video:null,frames:[{t:0,id:0,valid:true,lanes:[],edges:[],lp:[],es:[],leads:[],liveTracksValid:false,overlay:null}]};
(async()=>{
 const browser=await chromium.launch({headless:true});require('./browser-helpers.cjs').openRouteGroups(browser);
 try{
  const page=await browser.newPage({viewport:{width:1280,height:800}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.route('https://rv.test/**',route=>{
   const p=new URL(route.request().url()).pathname;
   if(p==='/api/logs')return route.fulfill({json:{logs,concurrency:1,auto_convert:true,keep_original_video:true,max_upload_mb:512,storage_used_bytes:1}});
   if(p.endsWith('/bookmarks'))return route.fulfill({json:{bookmarks:[]}});
   // The replay loads vehicle data in the background for the event track; none here.
   if(p.endsWith('/telemetry'))return route.fulfill({status:404,json:{error:'차량 정보 없음'}});
   if(p.endsWith('/data'))return route.fulfill({json:replay});
   if(route.request().method()==='DELETE'){deleted.push([p,route.request().headers()['x-roadviewer-request']]);return route.fulfill({json:p.endsWith('/prepared')?{status:'unconverted'}:{ok:true}})}
   if(p.startsWith('/api/'))return route.fulfill({json:{progress:{}}});
   return route.fulfill(asset(p==='/'?'library.html':p.startsWith('/view/')?'index.html':p.replace('/assets/','')));
  });
  const open=async id=>{await page.goto(`https://rv.test/view/${id}/`);await page.waitForFunction(()=>!document.getElementById('replayDownload').classList.contains('is-empty'))};
  await open('multi');
  // The button joins the app bar's action row without making it taller, at every width.
  for(const width of [320,360,390,768,1280]){
   await page.setViewportSize({width,height:800});
   const heights=await page.evaluate(()=>{const nav=document.getElementById('logNavigation'),d=document.getElementById('replayDownload'),h=()=>nav.getBoundingClientRect().height;const withIt=h();d.style.display='none';const without=h();d.style.display='';return [withIt,without]});
   assert.equal(heights[0],heights[1],`navigation height changes at ${width}px`);
  }
  await page.setViewportSize({width:390,height:800});
  const summary=page.locator('#replayDownload>summary');
  await summary.click();await page.locator('#replayDownloadMenu').waitFor();
  const items=await page.$$eval('#replayDownloadMenu>*',els=>els.map(e=>[e.tagName,e.querySelector('span')?.textContent||e.textContent,e.getAttribute('href'),e.querySelector('.download-detail')?.textContent||null]));
  assert.deepEqual(items,[
   ['BUTTON','제거',null,null],
   ['A','로그 다운로드','../../api/logs/multi/original/rlog.zst','rlog.zst'],
   ['P','영상 선택',null,null],
   ['A','전방 영상','../../api/logs/multi/original/fcamera.hevc','f · HEVC · 48 MB'],
   ['A','광각 영상','../../api/logs/multi/original/ecamera.hevc','e · HEVC · 47 MB'],
   ['A','저화질 영상','../../api/logs/multi/original/qcamera.ts','q · TS · 2.2 MB'],
   ['DIV','보기',null,null],
   ['BUTTON','카메라 설치 정보',null,null],
   ['DIV','화면 모드',null,null],
   ['P','1 모델 프레임 · 영상 없음',null,null],
   ['P',VERSION,null,null],
   ['HR','',null,null],
   ['BUTTON','완전 삭제',null,null]]);
  // 화면 모드 in the ⋯ menu applies at once and is remembered; 자동 removes the override.
  await page.locator('#replayDownloadMenu [data-theme-mode=light]').click();
  assert.deepEqual(await page.evaluate(()=>[document.documentElement.dataset.theme,localStorage.getItem('roadviewer-theme'),document.querySelector('#replayDownloadMenu [data-theme-mode=light]').getAttribute('aria-pressed')]),['light','light','true']);
  await page.locator('#replayDownloadMenu [data-theme-mode=auto]').click();
  assert.equal(await page.evaluate(()=>document.documentElement.hasAttribute('data-theme')),false);
  assert(await page.locator('#replayDownloadMenu a').first().evaluate(a=>a.hasAttribute('download')));
  await page.waitForFunction(()=>document.getElementById('replayDownloadMenu').getAnimations().every(a=>a.playState!=='running'));
  const box=await page.locator('#replayDownloadMenu').boundingBox();assert(box.x>=0&&box.x+box.width<=390,'menu fits a phone screen');
  // The page re-places an open menu from its resize handler, which a busy runner can run after
  // setViewportSize resolves. A listener added now runs after the page's own handler.
  await page.evaluate(()=>{window.__narrowed=false;addEventListener('resize',()=>{window.__narrowed=true},{once:true})});
  await page.setViewportSize({width:320,height:800});
  await page.waitForFunction(()=>window.__narrowed);
  const narrow=await page.locator('#replayDownloadMenu').boundingBox();assert(narrow.x>=0&&narrow.x+narrow.width<=320,'menu fits 320px');
  // Escape and outside taps close the menu; Space on the button does not start playback.
  await page.keyboard.press('Escape');await page.waitForFunction(()=>!document.getElementById('replayDownload').open);
  assert(await summary.evaluate(e=>e===document.activeElement),'focus returns to the button');
  await page.keyboard.press('Space');await page.waitForFunction(()=>document.getElementById('replayDownload').open);
  assert.equal(await page.evaluate(()=>playing),false,'Space opens the menu instead of playing');
  await page.mouse.click(5,700);await page.waitForFunction(()=>!document.getElementById('replayDownload').open);
  // One video: a single entry through the existing endpoint. No video: only the log.
  await open('single');await summary.click();
  assert.deepEqual(await page.$$eval('#replayDownloadMenu a',els=>els.map(a=>[a.querySelector('span').textContent,a.getAttribute('href')])),[['로그 다운로드','../../api/logs/single/original/rlog.zst'],['영상 다운로드','../../api/logs/single/download/video']]);
  assert.equal(await page.locator('#replayDownloadMenu>p:not(.menu-info)').count(),0);
  await open('nolog');await summary.click();
  assert.deepEqual(await page.$$eval('#replayDownloadMenu a span',els=>els.map(e=>e.textContent)),['로그 다운로드']);
  // Landscape: the menu opens below the app bar button, stays within the viewport and scrolls.
  await page.setViewportSize({width:740,height:360});await open('multi');await summary.click();
  await page.waitForFunction(()=>document.getElementById('replayDownloadMenu').getAnimations().every(a=>a.playState!=='running'));
  const placement=()=>page.evaluate(()=>{
   const menu=document.getElementById('replayDownloadMenu'),box=menu.getBoundingClientRect(),button=document.getElementById('replayDownload').getBoundingClientRect();
   return {top:box.top,bottom:box.bottom,buttonTop:button.top,buttonBottom:button.bottom,bar:innerHeight,scrollable:menu.scrollHeight>menu.clientHeight};
  });
  let placed=await placement();assert(placed.top>=placed.buttonBottom&&placed.bottom<=placed.bar-8,'landscape menu stays within the viewport');
  assert(placed.scrollable,'all menu items remain reachable by scrolling');
  // Scroll only the menu (as a finger or wheel inside it does) until the last download sits at its bottom edge;
  // scrollIntoView would also scroll the page behind it.
  await page.locator('#replayDownloadMenu a').last().evaluate(a=>{const m=a.closest('#replayDownloadMenu');m.scrollTop=a.offsetTop+a.offsetHeight-m.clientHeight+6});await page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));
  const lastDownload=await page.locator('#replayDownloadMenu a').last().boundingBox();placed=await placement();
  assert(lastDownload.y>=placed.top&&lastDownload.y+lastDownload.height<=placed.bottom,'last download is fully visible after scrolling');
  await page.setViewportSize({width:390,height:800});await page.waitForFunction(()=>document.getElementById('replayDownloadMenu').style.bottom==='');
  placed=await placement();assert(placed.top>=placed.buttonBottom&&placed.bottom<=placed.bar-8,'rotation keeps the menu below its button');
  await page.setViewportSize({width:740,height:360});await page.evaluate(()=>scrollTo(0,200));
  await page.waitForFunction(()=>{const m=document.getElementById('replayDownloadMenu').getBoundingClientRect();return m.top>=12&&m.bottom<=innerHeight-8});
  // Download options: one 다운로드 entry opens the download dialog, as in the list.
  await page.setViewportSize({width:1280,height:800});await open('remote');await summary.click();
  assert.deepEqual(await page.$$eval('#replayDownloadMenu>button',els=>els.map(e=>e.textContent)),['제거','다운로드','카메라 설치 정보','완전 삭제']);
  assert.equal(await page.locator('#replayDownloadMenu #splitView').count(),0,'보기 has its own app bar menu on wide screens');
  await page.locator('#replayDownloadMenu>button',{hasText:'다운로드'}).click();
  await page.locator('.rv-download-dialog').waitFor();assert.equal(await page.evaluate(()=>document.getElementById('replayDownload').open),false);
  await page.keyboard.press('Escape');
  // 제거 and 완전 삭제 ask first; declining sends nothing, confirming deletes and returns to the log list.
  let answer=false;const dialogs=[];page.on('dialog',d=>{dialogs.push(d.message());answer?d.accept():d.dismiss()});
  await open('multi');await summary.click();await page.locator('#replayDownloadMenu>button',{hasText:'제거'}).click();
  assert.match(dialogs.at(-1),/재생용 임시 영상을 제거할까요/);assert.deepEqual(deleted,[]);
  answer=true;await summary.click();await page.locator('#replayDownloadMenu>button',{hasText:'제거'}).click();
  await page.waitForURL('https://rv.test/');assert.deepEqual(deleted,[['/api/logs/multi/prepared','1']]);
  await open('single');await summary.click();await page.locator('#replayDownloadMenu>.delete').click();
  assert.match(dialogs.at(-1),/완전히 삭제할까요/);await page.waitForURL('https://rv.test/');
  assert.deepEqual(deleted.at(-1),['/api/logs/single','1']);
  // The list menu offers the same choices.
  await page.setViewportSize({width:1280,height:800});await page.goto('https://rv.test/');await page.locator('.log-row').first().waitFor();
  await page.locator('.log-row').first().locator('.recording-more>summary').click();
  assert.deepEqual(await page.locator('.log-row').first().locator('.recording-menu a.download-original span').allTextContents(),['로그 다운로드','전방 영상','광각 영상','저화질 영상']);
  // Where each part is kept: local unless the archive moved it; only stored parts are listed.
  // The list shows one summary line per segment; its tooltip names every stored part (chips appear only when mixed).
  const where=id=>page.locator(`.log-row:has(a.replay[href="view/${id}/"]) .storage-summary`);
  assert.equal(await where('multi').textContent(),'모두 로컬');
  assert.equal(await where('multi').getAttribute('title'),'로그: Home Assistant\n고화질: Home Assistant\n저용량: Home Assistant\n와이드: Home Assistant');
  assert.equal(await where('nolog').getAttribute('title'),'로그: Home Assistant');
  assert.equal(await where('remote').textContent(),'로그 로컬 · 영상 Drive');
  assert.equal(await where('remote').getAttribute('title'),'로그: Home Assistant\n고화질: Google Drive\n저용량: Google Drive');
  assert.equal(await where('remote').evaluate(e=>e.dataset.place),'gdrive');
  assert.equal(await page.locator('.log-row .storage-part').count(),0,'per-part chips only for mixed storage');
  assert.deepEqual(errors,[]);
  console.log('PASS: replay ⋯ menu keeps app bar height, offers 제거/downloads/camera info/screen mode/info/완전 삭제 (log and f/e/q videos or the download dialog), confirmed deletes, single-video fallback, closing, keyboard, list parity and storage locations per part');
 }finally{await browser.close()}
})().catch(e=>{console.error(e);process.exitCode=1});
