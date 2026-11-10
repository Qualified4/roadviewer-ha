// GPS route maps (maps.js): ① the list's 목록 | 지도 view, ② the route shape on a card and 주행 지도 (the drive full
// screen: map + segment sheet), ③ the replay's 주행 상황 | 지도 view and ④ the small map in the video's top-right corner,
// in the dark and the light theme. Tiles are stubbed with a generated PNG that looks like a map (a few roads, a park
// and water on a neutral ground; no network); the positions are synthetic (open ocean), never a real drive.
const fs=require('fs'),os=require('os'),path=require('path'),zlib=require('zlib'),assert=require('node:assert/strict'),{spawn}=require('child_process'),{chromium}=require('playwright');
const {settleLayout}=require('./browser-helpers.cjs');
function png(size,pixel){
 const crcTable=[...Array(256)].map((_,n)=>{let c=n;for(let k=0;k<8;k++)c=c&1?0xEDB88320^(c>>>1):c>>>1;return c>>>0});
 const crc=buf=>{let c=0xFFFFFFFF;for(const b of buf)c=crcTable[(c^b)&255]^(c>>>8);return (c^0xFFFFFFFF)>>>0};
 const chunk=(type,data)=>{const body=Buffer.concat([Buffer.from(type),data]),out=Buffer.alloc(8+data.length+4);out.writeUInt32BE(data.length,0);body.copy(out,4);out.writeUInt32BE(crc(body),8+data.length);return out};
 const ihdr=Buffer.alloc(13);ihdr.writeUInt32BE(size,0);ihdr.writeUInt32BE(size,4);ihdr[8]=8;ihdr[9]=2;
 const raw=Buffer.alloc(size*(size*3+1));
 for(let y=0;y<size;y++){raw[y*(size*3+1)]=0;for(let x=0;x<size;x++){const [r,g,b]=pixel(x,y),o=y*(size*3+1)+1+x*3;raw[o]=r;raw[o+1]=g;raw[o+2]=b}}
 return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',ihdr),chunk('IDAT',zlib.deflateSync(raw)),chunk('IEND',Buffer.alloc(0))]);
}
// A stub tile: ground, a park block, a water corner, two main roads (with casing) and a few minor streets.
function mapTile(c){
 return png(256,(x,y)=>{
  const main=Math.abs(y-92)<=4||Math.abs(x-168)<=5,casing=Math.abs(y-92)<=6||Math.abs(x-168)<=7;
  const minor=Math.abs(x-60)<=1.5||Math.abs(y-200)<=1.5||Math.abs((x-y*0.55)-120)<=1.6;
  if(main)return c.road;if(casing)return c.casing;if(minor)return c.minor;
  if(x>196&&y>150)return c.water;if(x>72&&x<150&&y>110&&y<186)return c.park;return c.ground;
 });
}
const TILES={light:mapTile({ground:[240,238,234],park:[216,234,208],water:[200,222,238],road:[255,255,255],casing:[214,210,202],minor:[252,251,248]}),
 dark:mapTile({ground:[36,38,42],park:[34,46,40],water:[27,33,44],road:[70,74,82],casing:[48,51,56],minor:[54,57,63]})};
(async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'rv-maps-')),shots=process.env.RV_MAP_SHOTS;
 if(shots)fs.mkdirSync(shots,{recursive:true});
 fs.writeFileSync(path.join(dir,'.processing-settings.json'),JSON.stringify({auto_convert:false}));
 // Route A: eight segments winding north-east (segment 1 has video); route B: one segment elsewhere; route C: no GPS.
 const track=(lat,lon,dlat,dlon)=>Array.from({length:61},(_,i)=>[i,+(lat+i*dlat).toFixed(6),+(lon+i*dlon+Math.sin(i/9)*2e-5).toFixed(6),12.5,Math.round(Math.atan2(dlon,dlat)*180/Math.PI+360)%360]);
 const turns=[[8e-5,6e-5],[0,1e-4],[7e-5,4e-5],[1e-4,0],[6e-5,-5e-5],[0,9e-5],[8e-5,3e-5],[5e-5,7e-5]];
 const routeA=[];{let lat=10,lon=20;turns.forEach(([dlat,dlon],k)=>{routeA.push(track(lat,lon,dlat,dlon));lat=+(lat+60*dlat).toFixed(6);lon=+(lon+60*dlon).toFixed(6)})}
 const hex=k=>'0123456789'[k];
 const logs=[
  ...routeA.map((points,k)=>({id:hex(k).repeat(32),name:`00000395--0d0eda17c5 / 구간 ${k}`,uploaded:30+k,points,tags:k===0?[{name:'출근',color:'blue'}]:[],video:k===1})),
  {id:'c'.repeat(32),name:'00000396--1a2b3c4d5e / 구간 0',uploaded:20,points:track(10.03,20.03,-6e-5,-4e-5),tags:[{name:'주말',color:'rose'}]},
  {id:'d'.repeat(32),name:'00000397--9f8e7d6c5b / 구간 0',uploaded:10,points:null},
 ];
 const A=routeA.length,withVideo=logs[1].id;
 for(const log of logs){
  const folder=path.join(dir,log.id);fs.mkdirSync(path.join(folder,'prepared'),{recursive:true});
  fs.writeFileSync(path.join(folder,'rlog.zst'),'fixture');
  fs.writeFileSync(path.join(folder,'meta.json'),JSON.stringify({id:log.id,status:'ready',name:log.name,uploaded:log.uploaded,files:{},video:false,tags:log.tags||[],decoder_version:'v28-runtime-geometry',duration:60}));
  fs.writeFileSync(path.join(folder,'prepared/data.json'),JSON.stringify({route:log.name,key:'map-'+log.id[0],duration:60,warnings:[],video:log.video?{start:0,duration:60}:null,frames:Array.from({length:61},(_,i)=>({t:i,id:i,valid:true,lanes:[],edges:[],lp:[],es:[],leads:[]}))}));
  const summary={duration:60,warnings:[],model_frames:61,video:null,videos:{},started_at:1762400000+log.uploaded*60,start_v:3,track_v:1,has_track:!!log.points};
  if(log.points){summary.track_distance_m=900;fs.writeFileSync(path.join(folder,'prepared/track.json.gz'),zlib.gzipSync(JSON.stringify({v:1,source:'gpsLocationExternal',points:log.points})))}
  fs.writeFileSync(path.join(folder,'prepared/summary.json'),JSON.stringify(summary));
 }
 const python=spawn(process.env.RV_PYTHON||'python',['-u','-c',`import sys
sys.path.insert(0,'roadviewer/app')
import server
from werkzeug.serving import make_server
from werkzeug.middleware.dispatcher import DispatcherMiddleware
http=make_server('127.0.0.1',0,DispatcherMiddleware(server.app,{'/api/hassio_ingress/test':server.app}),threaded=True)
print('READY '+str(http.server_port),flush=True)
http.serve_forever()`],{env:{...process.env,RV_DATA:dir,RV_INGRESS_ONLY:'0'},stdio:['ignore','pipe','pipe']});
 let stderr='',browser;python.stderr.on('data',x=>stderr+=x);
 try{
  const port=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('Server timeout '+stderr)),15000);python.once('exit',code=>{clearTimeout(timer);reject(Error('Server exit '+code+stderr))});python.stdout.on('data',x=>{const m=/READY (\d+)/.exec(String(x));if(m){clearTimeout(timer);resolve(Number(m[1]))}})});
  const base=`http://127.0.0.1:${port}/api/hassio_ingress/test/`;
  const video=fs.readFileSync(process.env.RV_TEST_VIDEO||'/tmp/roadviewer-test.mp4');
  browser=await chromium.launch({headless:true});
  for(const scheme of ['dark','light']){
   const context=await browser.newContext({viewport:{width:390,height:844},hasTouch:true,isMobile:true,colorScheme:scheme,reducedMotion:'reduce'}),page=await context.newPage(),errors=[],tiles=[];
   page.on('pageerror',error=>errors.push(error.message));
   await context.route('https://*.basemaps.cartocdn.com/**',route=>{const url=route.request().url();tiles.push(url);return route.fulfill({body:url.includes('/dark_')?TILES.dark:TILES.light,contentType:'image/png'})});
   await context.route(`**/api/logs/${withVideo}/video**`,route=>route.fulfill({body:video,contentType:'video/mp4'}));
   const shot=async name=>{if(shots){await settleLayout(page);await page.waitForTimeout(150);await page.screenshot({path:path.join(shots,`${name}-${scheme}.png`)})}};
   const tilesUsed=()=>{const expected=scheme==='dark'?'/dark_all/':'/rastertiles/voyager/';assert(tiles.length&&tiles.every(url=>url.includes(expected)),`${scheme} tiles: ${tiles.slice(0,2)}`)};
   // Taps the middle of a drawn route line (an SVG path of Leaflet's overlay pane).
   const tapLine=async(locator,share=.5)=>{const point=await locator.evaluate((p,share)=>{const at=p.getPointAtLength(p.getTotalLength()*share),m=p.getScreenCTM();return {x:at.x*m.a+at.y*m.c+m.e,y:at.x*m.b+at.y*m.d+m.f}},share);await page.touchscreen.tap(point.x,point.y)};
   const listRow=id=>page.locator(`#list .log-row[data-id="${id}"]`);
   await page.goto(base);await page.locator('.log-route').first().waitFor();
   assert(!await page.evaluate(()=>!!window.L),'Leaflet loads only when a map is first shown');
   // ② The cards with GPS show the route shape (an SVG, no tiles); the card without GPS has none.
   await page.locator('.route-shape').first().waitFor();
   assert.equal(await page.locator('.route-shape').count(),2);assert.equal(await page.locator('.route-shape polyline').count(),2);
   assert.equal(await page.locator('.log-route[data-route*="00000397"] .route-shape').count(),0);
   {const box=await page.locator('.route-shape').first().boundingBox();assert(Math.abs(box.width-64)<1&&Math.abs(box.height-48)<1,JSON.stringify(box))}
   assert.equal(tiles.length,0,'the shape draws no tiles');
   const cardA=page.locator('.log-route[data-route*="00000395"]'),drive=page.locator('#driveMap');
   const driveLines=drive.locator('.leaflet-overlay-pane path.leaflet-interactive');
   const driveOpen=async marked=>{
    await page.waitForFunction(({count,marked})=>{const d=document.getElementById('driveMap');return d.open&&d.querySelectorAll('.leaflet-overlay-pane path.leaflet-interactive').length===count&&(!marked||d.querySelector(`.log-row[data-id="${marked}"]`)?.classList.contains('is-map-marked'))},{count:A,marked});
    await settleLayout(page,'#driveMap');
   };
   const driveClosed=()=>page.waitForFunction(()=>!document.getElementById('driveMap').open);
   // The geometry that matters: the map stays on screen above the sheet and the marked line lies inside it.
   const layout=()=>page.evaluate(()=>{
    const d=document.getElementById('driveMap'),r=s=>d.querySelector(s).getBoundingClientRect(),area=r('.drive-map-area'),bar=r('.drive-map-bar'),sheet=r('.drive-map-sheet'),list=r('.drive-map-list'),body=r('.drive-map-body');
    const marked=d.querySelector('.log-row.is-map-marked'),row=marked?.getBoundingClientRect();
    const strong=[...d.querySelectorAll('.leaflet-overlay-pane path.leaflet-interactive')].find(p=>Number(p.getAttribute('stroke-width'))===7)?.getBoundingClientRect();
    return {area:{top:Math.round(area.top),bottom:Math.round(area.bottom),h:Math.round(area.height)},bar:Math.round(bar.bottom),body:Math.round(body.height),sheet:Math.round(sheet.height),share:sheet.height/body.height,
     rowVisible:!!row&&row.top>=list.top-1&&row.bottom<=list.bottom+1,lineInside:!!strong&&strong.top>=area.top-1&&strong.bottom<=sheet.top+15&&strong.left>=area.left-1&&strong.right<=area.right+1,scrolled:d.querySelector('.drive-map-list').scrollTop};
   });
   // Opened from the card's route shape: a history entry with the drive's date, distance, duration and segments.
   await cardA.locator('.route-shape').tap();await driveOpen();
   assert.equal(new URL(page.url()).hash,'#drive-map');
   assert.match(await page.locator('#driveMapTitle').innerText(),/\d/);
   assert.equal(await page.locator('#driveMapFacts').innerText(),`${(A*0.9).toFixed(1)} km · ${A}:00 · ${A}개 구간`);
   assert.equal(await drive.locator('.drive-map-list>.log-row').count(),A,'one row per segment, in segment order');
   assert.deepEqual(await drive.locator('.drive-map-list>.log-row').evaluateAll(rows=>rows.map(r=>r.dataset.id[0])),logs.slice(0,A).map(log=>log.id[0]));
   assert.equal(await drive.locator('.drive-map-list .log-row a.replay').count(),A,'each row keeps its play button');
   assert.equal(await drive.locator('.drive-map-list .log-row .recording-more').count(),A,'and its ⋯ menu');
   assert.match(await drive.locator('.leaflet-control-attribution').innerText(),/OpenStreetMap.*CARTO/);
   {const l=await layout();assert(l.area.top>=l.bar-1&&l.area.h>=.28*844,JSON.stringify(l));assert(Math.abs(l.share-.54)<.02,JSON.stringify(l))}
   // A LOWER row with the sheet scrolled: its segment is marked and fitted on the map, which stays visible above.
   await drive.locator('.drive-map-list').evaluate(list=>{list.scrollTop=list.scrollHeight});
   const last=logs[A-1].id,before=page.url();
   await drive.locator(`.log-row[data-id="${last}"] .log-meta`).tap();
   await page.waitForFunction(id=>document.querySelector(`#driveMap .log-row[data-id="${id}"]`)?.classList.contains('is-map-marked'),last);
   assert.equal(page.url(),before,'a row tap marks instead of playing');
   await settleLayout(page,'#driveMap');
   {const l=await layout();assert(l.scrolled>0&&l.rowVisible&&l.lineInside&&l.area.h>=.28*844,JSON.stringify(l))}
   assert.deepEqual((await driveLines.evaluateAll(lines=>lines.map(l=>Number(l.getAttribute('stroke-opacity'))>.5))).filter(Boolean).length,1,'the other segments dim');
   await shot('drive');
   // A tap on the map's empty ground shows the whole drive again; a tap on an upper segment then marks its row and
   // scrolls the sheet back to it.
   {const box=await drive.locator('.drive-map-area').boundingBox();await page.touchscreen.tap(box.x+14,box.y+40)}
   await page.waitForFunction(()=>!document.querySelector('#driveMap .log-row.is-map-marked'));await page.waitForTimeout(100);
   await tapLine(driveLines.nth(1),.5);
   await page.waitForFunction(id=>document.querySelector(`#driveMap .log-row[data-id="${id}"]`)?.classList.contains('is-map-marked'),logs[1].id);
   await page.waitForTimeout(100);{const l=await layout();assert(l.rowVisible,JSON.stringify(l))}
   // The sheet's handle: dragged up the sheet grows to 70% and the map keeps ≥ 30%; dragged down it snaps to 36%.
   const drag=async dy=>{const box=await drive.locator('.drive-map-handle').boundingBox(),x=box.x+box.width/2,y=box.y+box.height/2;await page.mouse.move(x,y);await page.mouse.down();await page.mouse.move(x,y+dy/2,{steps:4});await page.mouse.move(x,y+dy,{steps:4});await page.mouse.up();await page.waitForTimeout(120)};
   await drag(-160);{const l=await layout();assert(Math.abs(l.share-.7)<.02&&l.area.h>=.26*l.body,JSON.stringify(l))}
   await drive.locator(`.log-row[data-id="${last}"] .log-meta`).tap();await page.waitForTimeout(100);
   {const l=await layout();assert(l.rowVisible&&l.lineInside,JSON.stringify(l))}
   await shot('drive-up');
   await drag(400);{const l=await layout();assert(Math.abs(l.share-.36)<.02,JSON.stringify(l))}
   await drag(-30);{const l=await layout();assert(Math.abs(l.share-.36)<.02,'a short drag snaps back: '+JSON.stringify(l))}
   // The system back closes it (back in the list, the card's shape focused again).
   await page.goBack();await driveClosed();assert.notEqual(new URL(page.url()).hash,'#drive-map');
   assert(await page.locator('#list').isVisible());
   // ⋯ › 지도에서 보기 (only for segments with GPS) opens the same view with that segment marked; Escape closes it.
   await cardA.locator('.log-route-chevron').tap();await settleLayout(page);
   assert.equal(await listRow(logs[A+1].id).locator('button.map-segment').count(),0);
   {const row=listRow(logs[5].id);await row.locator('.recording-more>summary').tap();await row.getByRole('button',{name:'지도에서 보기',exact:true}).tap()}
   await driveOpen(logs[5].id);{const l=await layout();assert(l.rowVisible&&l.lineInside,JSON.stringify(l))}
   await page.keyboard.press('Escape');await driveClosed();assert.notEqual(new URL(page.url()).hash,'#drive-map');
   // The header's back button closes it too.
   await cardA.locator('.route-shape').tap();await driveOpen();await page.locator('#driveMapBack').tap();await driveClosed();
   // Wide screens: map left, list right, both the full height under the header.
   await page.setViewportSize({width:1280,height:800});await cardA.locator('.route-shape').tap();await driveOpen();
   {const g=await page.evaluate(()=>{const r=s=>document.querySelector('#driveMap '+s).getBoundingClientRect(),area=r('.drive-map-area'),sheet=r('.drive-map-sheet'),bar=r('.drive-map-bar');return {side:Math.abs(area.right-sheet.left)<=1&&area.left<=1&&sheet.right>=innerWidth-1,tall:area.top>=bar.bottom-1&&Math.abs(area.height-sheet.height)<=1&&area.bottom>=innerHeight-1,list:sheet.width}});
    assert(g.side&&g.tall&&g.list>=320&&g.list<=460,JSON.stringify(g))}
   await page.keyboard.press('Escape');await driveClosed();await page.setViewportSize({width:390,height:844});await settleLayout(page);
   // ① 목록 | 지도 in the logs panel's header: every drive the list shows, one colour each, fitted.
   const switcher=page.locator('#logView');await switcher.waitFor();
   assert.deepEqual(await switcher.locator('button').allTextContents(),['목록','지도']);
   {const head=await page.locator('.lib-panel-head').first().evaluate(h=>({scroll:h.scrollWidth<=h.clientWidth+1,page:document.documentElement.scrollWidth<=innerWidth}));assert.deepEqual(head,{scroll:true,page:true})}
   await switcher.getByRole('button',{name:'지도'}).tap();
   await page.waitForFunction(()=>document.querySelectorAll('#logMap .leaflet-overlay-pane path').length===2);
   assert(await page.locator('#list').isHidden());
   const routeLines=page.locator('#logMap .leaflet-overlay-pane path.leaflet-interactive');
   const colours=await routeLines.evaluateAll(lines=>lines.map(l=>l.getAttribute('stroke')));assert.notEqual(colours[0],colours[1],'each drive in its own colour');
   assert.match(await page.locator('#logMap .leaflet-control-attribution').innerText(),/OpenStreetMap.*CARTO/);
   await page.locator('#logMap').scrollIntoViewIfNeeded();
   await tapLine(routeLines.first());const card=page.locator('#logMapCard');await card.waitFor();
   assert.match(await card.locator('.map-card-facts').innerText(),new RegExp(`^(${(A*0.9).toFixed(1)} km · ${A}:00 · ${A}개 구간|900 m · 1:00 · 1개 구간)$`));
   assert.match(await card.locator('.map-card-play').getAttribute('href'),/view\/[a-f0-9]{32}\/$/);
   assert.deepEqual(await card.locator('.map-card-actions>:is(a,button):not(.map-card-close)').allInnerTexts(),['재생','주행 지도','목록에서 보기']);
   assert.equal((await routeLines.evaluateAll(lines=>lines.map(l=>Number(l.getAttribute('stroke-opacity'))<.5))).filter(Boolean).length,1,'the others dim');
   await shot('list-map');tilesUsed();
   // The card's 주행 지도 opens the same view for that drive; back returns to the list's map.
   {const facts=await card.locator('.map-card-facts').innerText(),count=Number(/(\d+)개 구간/.exec(facts)[1]);
    await card.getByRole('button',{name:'주행 지도'}).tap();
    await page.waitForFunction(count=>{const d=document.getElementById('driveMap');return d.open&&d.querySelectorAll('.drive-map-list>.log-row').length===count&&d.querySelectorAll('.leaflet-overlay-pane path.leaflet-interactive').length===count},count);
    assert.equal(await page.locator('#driveMapFacts').innerText(),facts);
    await page.goBack();await driveClosed();assert(await page.locator('#logMap').isVisible())}
   // The filters apply to the map too.
   await page.locator('#logSearch').fill('주말');await page.waitForFunction(()=>document.querySelectorAll('#logMap .leaflet-overlay-pane path').length===1);
   await page.locator('#logSearch').fill('');await page.waitForFunction(()=>document.querySelectorAll('#logMap .leaflet-overlay-pane path').length===2);
   await tapLine(routeLines.first());await card.waitFor();const shownRoute=await page.evaluate(()=>document.querySelector('#logMapCard .map-card-play').getAttribute('href'));
   await card.getByRole('button',{name:'목록에서 보기'}).tap();
   await page.locator('#list').waitFor();assert(await page.locator('#logMap').isHidden());
   {const id=shownRoute.split('/').filter(Boolean).at(-1);await page.waitForFunction(id=>{const r=document.querySelector(`#list .log-row[data-id="${id}"]`).closest('.log-route').getBoundingClientRect();return r.top>=0&&r.top<innerHeight},id)}
   // ③ The replay's 주행 상황 | 지도: the whole drive, travelled part solid, a car marker following playback.
   await page.goto(base+`view/${withVideo}/`);await page.waitForFunction(()=>!document.getElementById('play').disabled);
   // The 지도 tab sits right after 주행 상황 and shows only for a segment with a track; the tab row stays one row.
   const mapTab=page.locator('#mapTab');await mapTab.waitFor();
   assert.deepEqual((await page.locator('.vehicle-tabs [role=tab]').allTextContents()).map(t=>t.replace(/\d+$/,'').trim()),['주행 상황','지도','차선·도로','차량 정보','북마크']);
   {const tops=await page.locator('.vehicle-tabs [role=tab]').evaluateAll(tabs=>tabs.map(t=>Math.round(t.getBoundingClientRect().top)));assert.equal(new Set(tops).size,1,'one tab row '+tops)}
   assert.equal(await page.locator('#roadMode').count(),0,'no 주행 상황 | 지도 switch any more');
   await mapTab.tap();await page.locator('#mapView').waitFor();await page.locator('#routeMapView .map-car').waitFor();await shot('map-tab');
   await page.locator('#routeMapView .map-car').waitFor();
   assert(await page.locator('#road').isHidden());assert.equal(await page.locator('#mapFollow').getAttribute('aria-pressed'),'true');
   const carAt=()=>page.locator('#routeMapView .map-car').evaluate(e=>e.style.transform||e.getAttribute('style'));
   const seek=value=>page.locator('#seek').evaluate((e,value)=>{e.value=String(value);e.dispatchEvent(new Event('input'))},value);
   const start=await carAt();await seek(40);await page.waitForFunction(start=>document.querySelector('#routeMapView .map-car').style.transform!==start,start);
   {const box=await page.locator('#routeMapView').boundingBox();await page.touchscreen.tap(box.x+box.width/2,box.y+box.height-30);
    await page.mouse.move(box.x+box.width/2,box.y+box.height/2);await page.mouse.down();await page.mouse.move(box.x+box.width/2+60,box.y+box.height/2+40,{steps:5});await page.mouse.up();
    await page.waitForFunction(()=>document.getElementById('mapFollow').getAttribute('aria-pressed')==='false');
    await page.locator('#mapFollow').tap();assert.equal(await page.locator('#mapFollow').getAttribute('aria-pressed'),'true')}
   tilesUsed();
   // ④ 겹쳐 보기 설정 › 지도 › 영상 위 작은 지도: off by default, kept on this browser, tap to enlarge and shrink.
   await page.locator('#overlayHeightSettings').tap();const dialog=page.locator('#overlayHeightDialog');await dialog.waitFor();
   assert.equal(await dialog.locator('h3',{hasText:'지도'}).count(),1);const toggle=dialog.getByLabel('영상 위 작은 지도');
   assert.equal(await toggle.isChecked(),false);assert(await page.locator('#videoMap').isHidden());
   await toggle.check();await page.locator('#overlayHeightClose').tap();await dialog.waitFor({state:'hidden'});
   // Never two maps: while the panel shows 지도 the small map stays hidden; back on 주행 상황 it appears.
   await page.waitForTimeout(300);assert(await page.locator('#videoMap').isHidden(),'no small map while the panel shows the map');
   await page.locator('#roadTab').tap();
   const mini=page.locator('#videoMap');await mini.locator('.map-car').waitFor();await settleLayout(page);await page.waitForTimeout(150);
   // 작은 지도 색상: 자동 follows the theme; 라이트/다크 override only the small map's tiles and are kept on this browser.
   {const tilesOf=sel=>page.locator(sel).evaluate(e=>e.dataset.tiles),other=scheme==='dark'?'light':'dark';
    assert.equal(await tilesOf('#videoMap .rv-map'),scheme);
    const pick=async label=>{await page.locator('#overlayHeightSettings').tap();await dialog.waitFor();await dialog.locator('#videoMiniMapTone button',{hasText:label}).tap();if(label!=='자동'){await dialog.locator('#videoMiniMapTone').scrollIntoViewIfNeeded();await shot('minimap-tone')}await page.locator('#overlayHeightClose').tap();await dialog.waitFor({state:'hidden'})};
    await pick(other==='light'?'라이트':'다크');assert.equal(await tilesOf('#videoMap .rv-map'),other);
    assert.equal(await page.evaluate(()=>localStorage.getItem('roadviewer-minimap-tone')),other);
    assert.equal(await page.locator('#videoMiniMapTone button[aria-pressed=true]').textContent(),other==='light'?'라이트':'다크');
    await pick('자동');assert.equal(await tilesOf('#videoMap .rv-map'),scheme);await settleLayout(page)}
   // 작은 지도 글자 없이 보기: off by default; on, the small map alone asks CARTO's *_nolabels tiles; kept with the display preferences.
   {const keyOf=()=>page.locator('#videoMap .rv-map').evaluate(e=>e.dataset.tileKey),plain=scheme==='dark'?'/dark_nolabels/':'/voyager_nolabels/';
    assert.equal(await keyOf(),scheme);
    await page.locator('#overlayHeightSettings').tap();await dialog.waitFor();const box=dialog.getByLabel('작은 지도 글자 없이 보기');assert.equal(await box.isChecked(),false);
    const asked=page.waitForRequest(r=>r.url().includes(plain),{timeout:5000});await box.check();await asked;
    await page.locator('#overlayHeightClose').tap();await dialog.waitFor({state:'hidden'});
    assert.equal(await keyOf(),scheme+'-nolabels');assert.equal(await page.locator('#routeMapView .rv-map').evaluate(e=>e.dataset.tileKey),scheme,'the panel map keeps its labels');
    assert.equal(await page.evaluate(()=>JSON.parse(localStorage.getItem('roadviewer-display-preferences')).checks.videoMiniMapPlain),true);
    await page.locator('#overlayHeightSettings').tap();await dialog.waitFor();await box.uncheck();await page.locator('#overlayHeightClose').tap();await dialog.waitFor({state:'hidden'});
    assert.equal(await keyOf(),scheme)}
   // Where it sits: the stage's top-right corner, a third of its width (104–180px, 4:3), under the speed and wheel
   // (drawn on top; never narrower than they are); clear of the title, the bottom row, the fullscreen button and the transport; the segment's
   // whole track inside it and below the speed.
   const geometry=()=>page.evaluate(()=>{
    const stage=document.getElementById('videoStage').getBoundingClientRect(),el=document.getElementById('videoMap'),map=el.getBoundingClientRect(),hud=document.querySelector('.video-hud').getBoundingClientRect();
    const r=s=>[...document.querySelectorAll(s)].filter(e=>e.offsetParent||getComputedStyle(e).position==='fixed').map(e=>e.getBoundingClientRect()).filter(b=>b.width&&b.height);
    const hit=(b,box=map)=>!(b.right<=box.left||b.left>=box.right||b.bottom<=box.top||b.top>=box.bottom);
    const title=document.querySelector('.video-title').getBoundingClientRect(),style=getComputedStyle(el);
    const titleClear=!hit(title);
    // The current segment's two lines (travelled, ahead), marked map-current.
    const track=[...el.querySelectorAll('.leaflet-overlay-pane path.map-current')].map(p=>p.getBoundingClientRect()).filter(b=>b.width||b.height);
    const current=track.length?track.reduce((a,b)=>({left:Math.min(a.left,b.left),right:Math.max(a.right,b.right),top:Math.min(a.top,b.top),bottom:Math.max(a.bottom,b.bottom)})):null;
    return {stage:{w:Math.round(stage.width),top:Math.round(stage.top),right:Math.round(stage.right)},map:{w:Math.round(map.width),h:Math.round(map.height),top:Math.round(map.top),right:Math.round(map.right)},
     hudOnMap:hud.left>=map.left-1&&hud.right<=map.right+1&&hud.top>=map.top-1&&hud.bottom<=map.bottom+1&&Number(getComputedStyle(document.querySelector('.video-hud')).zIndex)>Number(style.zIndex),
     titleClear,covers:['.video-tools','.video-fullscreen','.playback'].filter(s=>r(s).some(b=>hit(b))),
     trackInside:!!current&&current.left>=map.left-1&&current.right<=map.right+1&&current.top>=hud.bottom-2&&current.bottom<=map.bottom+1,
     hud:[hud.left,hud.top,hud.right,hud.bottom].map(Math.round),hudZ:getComputedStyle(document.querySelector('.video-hud')).zIndex,cur:current&&[current.left,current.top,current.right,current.bottom].map(Math.round),n:track.length,rows:['.video-tools','.video-fullscreen','.video-title'].map(q=>{const b=document.querySelector(q).getBoundingClientRect();return [b.left,b.top,b.right,b.bottom].map(Math.round)}),stageH:Math.round(stage.height),large:el.classList.contains('is-large'),shown:!el.hidden,marked:document.getElementById('videoStage').classList.contains('has-video-map')};
   });
   const small=async label=>{
    const g=await geometry(),want=Math.max(104,g.hud[2]-g.hud[0],Math.min(180,g.stage.w/3)),floor=Math.min(...g.rows.slice(0,2).map(r=>r[1]))-8;
    assert(g.shown&&g.marked&&!g.large,label+JSON.stringify(g));
    // 4:3, or shorter where the bottom row comes first.
    assert(Math.abs(g.map.w-want)<=1.5&&(Math.abs(g.map.h-g.map.w*.75)<=1.5||g.map.h<g.map.w*.75&&Math.abs(g.map.top+g.map.h-floor)<=1.5),label+' size '+JSON.stringify(g));
    assert(g.stage.right-g.map.right<=12.5&&g.map.top-g.stage.top<=12.5,label+' corner '+JSON.stringify(g));
    assert(g.hudOnMap&&g.titleClear&&g.trackInside,label+' '+JSON.stringify(g));assert.deepEqual(g.covers,[],label+' '+JSON.stringify(g));
   };
   await small('portrait');
   // Enlarged: a plain rectangle filling the picture (12px or 8px margins); the title, speed and wheel and fullscreen
   // button float over it and still take taps; the quality and overlay controls are hidden; the messages sit at the
   // bottom edge, over the map.
   const large=async label=>{
    await page.waitForFunction(()=>getComputedStyle(document.querySelector('.video-tools')).visibility==='hidden',null,{timeout:2000}).catch(()=>{});
    const g=await page.evaluate(()=>{
     const stage=document.getElementById('videoStage').getBoundingClientRect(),el=document.getElementById('videoMap'),map=el.getBoundingClientRect(),tools=document.querySelector('.video-tools');
     const usable=q=>{const e=document.querySelector(q),b=e.getBoundingClientRect();return !!b.width&&!!document.elementFromPoint(b.left+b.width/2,b.top+b.height/2)?.closest(q)};
     const messages=document.querySelector('.video-messages').getBoundingClientRect();
     return {large:el.classList.contains('is-large'),marked:document.getElementById('videoStage').classList.contains('video-map-large'),
      margins:[map.left-stage.left,stage.right-map.right,map.top-stage.top,stage.bottom-map.bottom].map(Math.round),
      title:usable('.video-title .app-title-button'),fullscreen:usable('.video-fullscreen'),hud:Number(getComputedStyle(document.querySelector('.video-hud')).zIndex)>Number(getComputedStyle(el).zIndex),
      toolsHidden:getComputedStyle(tools).visibility==='hidden',messagesGap:Math.round(map.bottom-messages.bottom)};
    });
    assert(g.large&&g.marked,label+JSON.stringify(g));
    assert(g.margins.every(m=>m>=7&&m<=12.5)&&new Set(g.margins).size<=2,label+' fills the picture '+JSON.stringify(g));
    assert(g.title&&g.fullscreen&&g.hud&&g.toolsHidden,label+' controls '+JSON.stringify(g));
    assert(g.messagesGap>=-1&&g.messagesGap<=6,label+' messages at the bottom edge '+JSON.stringify(g));
   };
   await shot('replay');
   await mini.tap();await page.waitForFunction(()=>document.getElementById('videoMap').classList.contains('is-large'));await settleLayout(page);await page.waitForTimeout(150);
   await large('portrait large');
   await shot('replay-large');
   await mini.tap();await page.waitForFunction(()=>!document.getElementById('videoMap').classList.contains('is-large'));await page.waitForTimeout(100);
   assert(await mini.locator('.leaflet-control-attribution').isVisible());assert.match(await mini.locator('.leaflet-control-attribution').innerText(),/^© OSM © CARTO$/);
   // Landscape phone, desktop and fullscreen: the same rules.
   await page.setViewportSize({width:844,height:390});await settleLayout(page);await page.waitForTimeout(150);await small('landscape');
   await page.setViewportSize({width:1280,height:800});await settleLayout(page);await page.waitForTimeout(150);await small('desktop');
   await mini.tap();await page.waitForFunction(()=>document.getElementById('videoMap').classList.contains('is-large'));await page.waitForTimeout(150);
   await large('desktop large');
   await mini.tap();await page.waitForFunction(()=>!document.getElementById('videoMap').classList.contains('is-large'));
   assert.equal(await page.evaluate(()=>getComputedStyle(document.querySelector('.video-tools')).visibility),'visible','the controls come back');
   await page.evaluate(()=>document.getElementById("fullscreenButton").click());
   if(await page.waitForFunction(()=>document.fullscreenElement,null,{timeout:3000}).then(()=>true,()=>false)){
    await page.waitForTimeout(250);await small('fullscreen');await page.evaluate(()=>document.exitFullscreen());await page.waitForFunction(()=>!document.fullscreenElement);
   }else console.log('maps: fullscreen unavailable here, skipped');
   await page.setViewportSize({width:390,height:844});await settleLayout(page);
   await mapTab.tap();await page.locator('#videoMap').waitFor({state:'hidden'});await page.locator('#routeMapView .map-car').waitFor();
   // Tapping segment 0 of the drive on the map opens that segment at that point.
   {const lines=page.locator('#routeMapView .leaflet-overlay-pane path.leaflet-interactive');assert(await lines.count()>=2);
    await seek(0);await page.waitForTimeout(100);
    const first=lines.first();await first.evaluate(p=>p.closest('.leaflet-container').scrollIntoView({block:'center'}));await tapLine(first,.85);
    await page.waitForURL(new RegExp(`view/${logs[0].id}/$`));await page.waitForFunction(()=>!document.getElementById('play').disabled&&Number(document.getElementById('seek').value)>0)}
   assert(await page.locator('#videoMiniMap').isChecked(),'the small map setting is kept');
   // A segment with GPS but no video: the panel's map only, no small map over the picture.
   await page.waitForTimeout(400);assert(await page.locator('#mapTab').isVisible());assert.equal(await page.locator('#mapTab').getAttribute('aria-selected'),'true','the 지도 tab is kept');assert(await page.locator('#videoMap').isHidden());
   assert.equal(await page.locator('#videoStage.has-video-map').count(),0);
   // A segment without GPS has neither the switch nor the small map.
   await page.goto(base+`view/${logs.at(-1).id}/`);await page.waitForFunction(()=>!document.getElementById('play').disabled);await page.waitForTimeout(300);
   assert(await page.locator('#mapTab').isHidden());assert(await page.locator('#videoMap').isHidden());
   assert.deepEqual(errors,[]);
   await context.close();
  }
  console.log('maps ok');
 }finally{await browser?.close();python.kill();fs.rmSync(dir,{recursive:true,force:true})}
})().catch(error=>{console.error(error);process.exit(1)});
