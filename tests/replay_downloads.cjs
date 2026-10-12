const fs=require('fs'),assert=require('node:assert/strict'),{chromium}=require('playwright');
// Replay downloads: an icon in the navigation row (no taller heading), the log plus a choice of camera videos.
const asset=name=>({body:fs.readFileSync('roadviewer/app/web/'+name),contentType:name.endsWith('.html')?'text/html':name.endsWith('.js')?'application/javascript':name.endsWith('.css')?'text/css':name.endsWith('.png')?'image/png':name.endsWith('.woff2')?'font/woff2':'image/svg+xml'});
const MB=1024*1024;
const logs=[
 {id:'multi',name:'000003cb--8bf810e0fe / 구간 16',files:{'rlog.zst':'000003cb--8bf810e0fe--16--rlog.zst'},status:'ready',uploaded:3,bytes:1,prepared_bytes:1,video:true,
  video_downloads:[{source:'front',kind:'fcamera.hevc',bytes:48.4*MB},{source:'wide',kind:'ecamera.hevc',bytes:47*MB},{source:'qcamera',kind:'qcamera.ts',bytes:2.2*MB}]},
 {id:'single',name:'000003cb--8bf810e0fe / 구간 15',status:'ready',uploaded:2,bytes:1,prepared_bytes:1,video:true,video_downloads:[{source:'qcamera',kind:'qcamera.ts',bytes:2.2*MB}]},
 {id:'nolog',name:'000003cb--8bf810e0fe / 구간 14',status:'ready',uploaded:1,bytes:1,prepared_bytes:1,video:false,video_downloads:[]}
];
const replay={route:'test',key:'k',duration:1,warnings:[],video:null,frames:[{t:0,id:0,valid:true,lanes:[],edges:[],lp:[],es:[],leads:[],liveTracksValid:false,overlay:null}]};
(async()=>{
 const browser=await chromium.launch({headless:true});
 try{
  const page=await browser.newPage({viewport:{width:1280,height:800}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.route('https://rv.test/**',route=>{
   const p=new URL(route.request().url()).pathname;
   if(p==='/api/logs')return route.fulfill({json:{logs,concurrency:1,auto_convert:true,keep_original_video:true,max_upload_mb:512,storage_used_bytes:1}});
   if(p.endsWith('/bookmarks'))return route.fulfill({json:{bookmarks:[]}});
   if(p.endsWith('/data'))return route.fulfill({json:replay});
   if(p.startsWith('/api/'))return route.fulfill({json:{progress:{}}});
   return route.fulfill(asset(p==='/'?'library.html':p.startsWith('/view/')?'index.html':p.replace('/assets/','')));
  });
  const open=async id=>{await page.goto(`https://rv.test/view/${id}/`);await page.waitForFunction(()=>!document.getElementById('replayDownload').classList.contains('is-empty'))};
  await open('multi');
  // The button joins the navigation row without making the heading taller, at every width.
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
   ['A','로그 다운로드','../../api/logs/multi/original/rlog.zst','rlog.zst'],
   ['P','영상 선택',null,null],
   ['A','전방 영상','../../api/logs/multi/original/fcamera.hevc','f · HEVC · 48 MB'],
   ['A','광각 영상','../../api/logs/multi/original/ecamera.hevc','e · HEVC · 47 MB'],
   ['A','저화질 영상','../../api/logs/multi/original/qcamera.ts','q · TS · 2.2 MB']]);
  assert(await page.locator('#replayDownloadMenu a').first().evaluate(a=>a.hasAttribute('download')));
  await page.waitForFunction(()=>document.getElementById('replayDownloadMenu').getAnimations().every(a=>a.playState!=='running'));
  const box=await page.locator('#replayDownloadMenu').boundingBox();assert(box.x>=0&&box.x+box.width<=390,'menu fits a phone screen');
  await page.setViewportSize({width:320,height:800});
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
  assert.equal(await page.locator('#replayDownloadMenu>p').count(),0);
  await open('nolog');await summary.click();
  assert.deepEqual(await page.$$eval('#replayDownloadMenu a span',els=>els.map(e=>e.textContent)),['로그 다운로드']);
  // Landscape: the menu stays within the viewport and above the fixed playback bar.
  await page.setViewportSize({width:740,height:360});await open('multi');await summary.click();
  await page.waitForFunction(()=>document.getElementById('replayDownloadMenu').getAnimations().every(a=>a.playState!=='running'));
  const placement=()=>page.evaluate(()=>{
   const menu=document.getElementById('replayDownloadMenu'),box=menu.getBoundingClientRect(),button=document.getElementById('replayDownload').getBoundingClientRect();
   return {top:box.top,bottom:box.bottom,buttonTop:button.top,buttonBottom:button.bottom,bar:document.querySelector('.playback').getBoundingClientRect().top,scrollable:menu.scrollHeight>menu.clientHeight};
  });
  let placed=await placement();assert(placed.top>=12&&placed.bottom<=placed.bar-8,'landscape menu does not overlap the playback bar');
  assert(placed.bottom<placed.buttonTop,'opens upward when that side has more space');assert(placed.scrollable,'all downloads remain reachable by scrolling');
  await page.locator('#replayDownloadMenu a').last().evaluate(a=>a.scrollIntoView({block:'nearest'}));
  const lastDownload=await page.locator('#replayDownloadMenu a').last().boundingBox();placed=await placement();
  assert(lastDownload.y>=placed.top&&lastDownload.y+lastDownload.height<=placed.bottom,'last download is fully visible after scrolling');
  await page.setViewportSize({width:390,height:800});await page.waitForFunction(()=>document.getElementById('replayDownloadMenu').style.bottom==='');
  placed=await placement();assert(placed.top>=placed.buttonBottom&&placed.bottom<=placed.bar-8,'rotation restores downward placement');
  await page.setViewportSize({width:740,height:360});await page.evaluate(()=>scrollTo(0,200));
  await page.waitForFunction(()=>{const m=document.getElementById('replayDownloadMenu').getBoundingClientRect();return m.top>=12&&m.bottom<=document.querySelector('.playback').getBoundingClientRect().top-8});
  // The list menu offers the same choices.
  await page.setViewportSize({width:1280,height:800});await page.goto('https://rv.test/');await page.locator('.log-row').first().waitFor();
  await page.locator('.log-row').first().locator('.recording-more>summary').click();
  assert.deepEqual(await page.locator('.log-row').first().locator('.recording-menu a.download-original span').allTextContents(),['로그 다운로드','전방 영상','광각 영상','저화질 영상']);
  assert.deepEqual(errors,[]);
  console.log('PASS: replay download menu keeps heading height, offers log and f/e/q videos, single-video fallback, closing, keyboard and list parity');
 }finally{await browser.close()}
})().catch(e=>{console.error(e);process.exitCode=1});
