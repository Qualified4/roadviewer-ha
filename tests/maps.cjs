// GPS route maps (maps.js): ① the list's 목록 | 지도 view, ② the route shape on a card and 주행 지도 (the drive full
// screen: map + segment sheet), ③ the replay's 주행 상황 | 지도 view and ④ the small map in the video's top-right corner,
// in the dark and the light theme. The OpenFreeMap basemap (MapLibre in Leaflet) is stubbed with small fixtures (no
// network) unless RV_MAP_REAL_TILES=1; the positions are synthetic, never a real drive.
const fs=require('fs'),os=require('os'),path=require('path'),zlib=require('zlib'),assert=require('node:assert/strict'),{spawn}=require('child_process'),{chromium}=require('playwright');
const {settleLayout}=require('./browser-helpers.cjs');
// OpenFreeMap stubs: a style per theme (a background, a GeoJSON street grid around the routes and a symbol layer of
// street names, so 글자 없이 보기 has layers to hide), its TileJSON, empty vector tiles and empty glyph ranges.
// RV_MAP_REAL_TILES=1 lets the browser fetch the real OpenFreeMap styles and tiles instead (with RV_MAP_SHOTS, to look).
const REAL=process.env.RV_MAP_REAL_TILES==='1';
// Synthetic routes: in the stubbed run on empty ground (the fixture streets lie around it); with real tiles, in a city
// centre (a public landmark, not a drive) so the pictures show roads and names.
const ORIGIN=REAL?[37.55,126.96]:[10,20];
const OFM='https://tiles.openfreemap.org/',STYLE_OF={light:OFM+'styles/liberty',dark:OFM+'styles/dark'},SIMPLE_LIGHT=OFM+'styles/positron';
function fixtureStyle(scheme){
 const c=scheme==='dark'?{ground:'#24262a',road:'#464a52',text:'#9aa0a9'}:{ground:'#f0eeea',road:'#ffffff',text:'#555a60'};
 const streets=[];for(let k=0;k<12;k++){streets.push({type:'Feature',properties:{name:'가로 '+k},geometry:{type:'LineString',coordinates:[[19.99,9.99+k*0.004],[20.06,9.99+k*0.004]]}});streets.push({type:'Feature',properties:{name:'세로 '+k},geometry:{type:'LineString',coordinates:[[19.99+k*0.006,9.99],[19.99+k*0.006,10.05]]}})}
 return {version:8,name:'fixture-'+scheme,glyphs:OFM+'fonts/{fontstack}/{range}.pbf',
  sources:{openmaptiles:{type:'vector',url:OFM+'planet'},streets:{type:'geojson',data:{type:'FeatureCollection',features:streets}}},
  layers:[{id:'background',type:'background',paint:{'background-color':c.ground}},
   {id:'transportation',type:'line',source:'openmaptiles','source-layer':'transportation',paint:{'line-color':c.road}},
   {id:'street',type:'line',source:'streets',paint:{'line-color':c.road,'line-width':3}},
   {id:'street-name',type:'symbol',source:'streets',layout:{'symbol-placement':'line','text-field':['get','name'],'text-font':['Noto Sans Regular'],'text-size':11},paint:{'text-color':c.text}},
   {id:'building-3d',type:'fill-extrusion',source:'openmaptiles','source-layer':'building',paint:{'fill-extrusion-height':10}},
   {id:'poi_r1',type:'symbol',source:'streets',layout:{'text-field':['get','name'],'text-font':['Noto Sans Regular']}},
   {id:'poi-hidden',type:'symbol',source:'streets',layout:{visibility:'none','text-field':['get','name'],'text-font':['Noto Sans Regular']}}]};
}
(async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'rv-maps-')),shots=process.env.RV_MAP_SHOTS;
 if(shots)fs.mkdirSync(shots,{recursive:true});
 fs.writeFileSync(path.join(dir,'.processing-settings.json'),JSON.stringify({auto_convert:false}));
 // Route A: eight segments winding north-east (segment 1 has video); route B: one segment elsewhere; route C: no GPS.
 const track=(lat,lon,dlat,dlon)=>Array.from({length:61},(_,i)=>[i,+(lat+i*dlat).toFixed(6),+(lon+i*dlon+Math.sin(i/9)*2e-5).toFixed(6),12.5,Math.round(Math.atan2(dlon,dlat)*180/Math.PI+360)%360]);
 const turns=[[8e-5,6e-5],[0,1e-4],[7e-5,4e-5],[1e-4,0],[6e-5,-5e-5],[0,9e-5],[8e-5,3e-5],[5e-5,7e-5]];
 const routeA=[];{let [lat,lon]=ORIGIN;turns.forEach(([dlat,dlon],k)=>{routeA.push(track(lat,lon,dlat,dlon));lat=+(lat+60*dlat).toFixed(6);lon=+(lon+60*dlon).toFixed(6)})}
 const hex=k=>'0123456789'[k];
 const logs=[
  ...routeA.map((points,k)=>({id:hex(k).repeat(32),name:`00000395--0d0eda17c5 / 구간 ${k}`,uploaded:30+k,points,tags:k===0?[{name:'출근',color:'blue'}]:[],video:k===1})),
  {id:'c'.repeat(32),name:'00000396--1a2b3c4d5e / 구간 0',uploaded:20,points:track(ORIGIN[0]+.03,ORIGIN[1]+.03,-6e-5,-4e-5),tags:[{name:'주말',color:'rose'}]},
  {id:'d'.repeat(32),name:'00000397--9f8e7d6c5b / 구간 0',uploaded:10,points:null},
 ];
 const A=routeA.length,withVideo=logs[1].id;
 const writeLog=log=>{
  const folder=path.join(dir,log.id);fs.mkdirSync(path.join(folder,'prepared'),{recursive:true});
  fs.writeFileSync(path.join(folder,'rlog.zst'),'fixture');
  fs.writeFileSync(path.join(folder,'meta.json'),JSON.stringify({id:log.id,status:'ready',name:log.name,uploaded:log.uploaded,files:{},video:false,tags:log.tags||[],decoder_version:'v28-runtime-geometry',duration:60}));
  fs.writeFileSync(path.join(folder,'prepared/data.json'),JSON.stringify({route:log.name,key:'map-'+log.id[0],duration:60,warnings:[],video:log.video?{start:0,duration:60}:null,frames:Array.from({length:61},(_,i)=>({t:i,id:i,valid:true,lanes:[],edges:[],lp:[],es:[],leads:[]}))}));
  const summary={duration:60,warnings:[],model_frames:61,video:null,videos:{},started_at:1762400000+log.uploaded*60,start_v:3,track_v:2,has_track:!!log.points};
  if(log.points){summary.track_distance_m=900;fs.writeFileSync(path.join(folder,'prepared/track.json.gz'),zlib.gzipSync(JSON.stringify({v:2,source:'gpsLocationExternal',points:log.points})))}
  fs.writeFileSync(path.join(folder,'prepared/summary.json'),JSON.stringify(summary));
 };
 logs.forEach(writeLog);
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
   const context=await browser.newContext({viewport:{width:390,height:844},hasTouch:true,isMobile:true,colorScheme:scheme,reducedMotion:'reduce'}),page=await context.newPage(),errors=[],tiles=[],stubbed=[];
   page.on('pageerror',error=>errors.push(error.message));
   page.on('request',request=>{if(request.url().startsWith(OFM))tiles.push(request.url())});
   if(REAL)page.on('console',message=>{if(message.type()==='error')console.log('maps: console',message.text().slice(0,200))});
   else await context.route(OFM+'**',route=>{
    const url=route.request().url();stubbed.push(url);const style=url===SIMPLE_LIGHT?['light']:Object.entries(STYLE_OF).find(([,u])=>url===u);
    if(style)return route.fulfill({body:JSON.stringify(fixtureStyle(style[0])),contentType:'application/json'});
    if(url===OFM+'planet')return route.fulfill({body:JSON.stringify({tilejson:'3.0.0',tiles:[OFM+'planet/fixture/{z}/{x}/{y}.pbf'],minzoom:0,maxzoom:14}),contentType:'application/json'});
    return route.fulfill({body:Buffer.alloc(0),contentType:'application/x-protobuf'});  // tiles, glyphs: empty
   });
   await context.route(`**/api/logs/${withVideo}/video**`,route=>route.fulfill({body:video,contentType:'video/mp4'}));
   // Real tiles: give them time to arrive and draw before the picture.
   const shot=async name=>{if(shots){await settleLayout(page);await page.waitForTimeout(REAL?3000:150);await page.screenshot({path:path.join(shots,`${name}-${scheme}.png`)})}};
   // The theme's style (Liberty light, Dark dark), never the other one, for the maps that follow the theme.
   const tilesUsed=()=>{const styles=tiles.filter(url=>url.startsWith(OFM+'styles/'));assert(styles.length&&styles.every(url=>url===STYLE_OF[scheme]),`${scheme} styles: ${styles}`);
    if(!REAL)assert(stubbed.includes(OFM+'planet')&&stubbed.some(url=>url.startsWith(OFM+'planet/fixture/')),'the vector source and its tiles come from the stub: '+stubbed.slice(0,4))};
   // Taps the middle of a drawn route line (an SVG path of Leaflet's overlay pane).
   // The first point from the middle outwards that no map control covers.
   const tapLine=async(locator,share=.5)=>{const point=await locator.evaluate((p,share)=>{const m=p.getScreenCTM(),length=p.getTotalLength();
     // Away from the controls too: Chromium moves a tap onto a button or link within a few pixels.
     const controls=[...document.querySelectorAll('.leaflet-control')].map(c=>c.getBoundingClientRect()),near=(x,y)=>controls.some(r=>x>r.left-24&&x<r.right+24&&y>r.top-24&&y<r.bottom+24);
     const shares=Array.from({length:21},(_,i)=>i/20).sort((a,b)=>Math.abs(a-share)-Math.abs(b-share));
     for(const k of shares){const at=p.getPointAtLength(length*Math.min(1,Math.max(0,k))),x=Math.round(at.x*m.a+at.y*m.c+m.e),y=Math.round(at.x*m.b+at.y*m.d+m.f);if(document.elementFromPoint(x,y)===p&&!near(x,y))return {x,y}}
     const at=p.getPointAtLength(length*share);return {x:at.x*m.a+at.y*m.c+m.e,y:at.x*m.b+at.y*m.d+m.f}},share);await page.touchscreen.tap(point.x,point.y)};
   const listRow=id=>page.locator(`#list .log-row[data-id="${id}"]`);
   await page.goto(base);await page.locator('.log-route').first().waitFor();
   assert(!await page.evaluate(()=>!!(window.L||window.maplibregl)),'Leaflet and MapLibre load only when a map is first shown');
   // ② The cards with GPS show their route (SVGs, no tiles); phones: a 지도 button left of 재생, no route in the thumbnail.
   await page.locator('.route-map-button').first().waitFor();
   assert.equal(await page.locator('.route-map-button').count(),2);assert.equal(await page.locator('.route-map-button svg .shape-line').count(),2);
   assert.equal(await page.locator('.log-route[data-route*="00000397"] :is(.route-inset,.route-strip,.route-map-button)').count(),0,'no GPS: no route at all');
   {const card=page.locator('.log-route[data-route*="00000395"]'),button=await card.locator('.route-map-button').boundingBox(),play=await card.locator('.log-route-actions a.replay').boundingBox();
    assert(button.height>=44&&button.x+button.width<=play.x&&play.x-(button.x+button.width)<=12&&Math.abs(button.y+button.height/2-play.y-play.height/2)<2,JSON.stringify({button,play}));
    assert.equal(await card.locator('.route-map-button').innerText(),'지도');
    // The empty left of the actions row folds the card (지도 sits beside 재생).
    {const row=await card.locator('.log-route-actions').boundingBox(),open=await card.evaluate(e=>e.open);await page.touchscreen.tap(row.x+12,row.y+row.height/2);
     await page.waitForFunction(([id,was])=>document.querySelector(`.log-route[data-route*="${id}"]`).open!==was,['00000395',open]);
     await page.touchscreen.tap(row.x+12,row.y+row.height/2);await page.waitForFunction(([id,was])=>document.querySelector(`.log-route[data-route*="${id}"]`).open===was,['00000395',open])}
    assert(await card.locator('.route-inset').isHidden()&&await card.locator('.route-strip').isHidden(),'phones: nothing in the thumbnail');
    if(shots){await card.evaluate(e=>e.scrollIntoView({block:'center'}));await settleLayout(page);await card.screenshot({path:path.join(shots,`card-phone-${scheme}.png`)})}}
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
   await cardA.locator('.route-map-button').tap();await driveOpen();
   assert.equal(new URL(page.url()).hash,'#drive-map');
   assert.match(await page.locator('#driveMapTitle').innerText(),/\d/);
   assert.equal(await page.locator('#driveMapFacts').innerText(),`${(A*0.9).toFixed(1)} km · ${A}:00 · ${A}개 구간`);
   assert.equal(await drive.locator('.drive-map-list>.log-row').count(),A,'one row per segment, in segment order');
   assert.deepEqual(await drive.locator('.drive-map-list>.log-row').evaluateAll(rows=>rows.map(r=>r.dataset.id[0])),logs.slice(0,A).map(log=>log.id[0]));
   assert.equal(await drive.locator('.drive-map-list .log-row a.replay').count(),A,'each row keeps its play button');
   assert.equal(await drive.locator('.drive-map-list .log-row .recording-more').count(),A,'and its ⋯ menu');
   assert.equal(await drive.locator('.leaflet-control-attribution').innerText(),'OpenFreeMap © OpenMapTiles Data from OpenStreetMap');
   assert.equal(await drive.locator('.leaflet-tile-pane canvas.maplibregl-canvas').count(),1,'MapLibre draws the basemap in the tile pane');
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
   // Dragged all the way down the cards hide and only the handle stays; a tap brings them back at the lowest height.
   await drag(400);{const g=await page.evaluate(()=>{const b=document.querySelector('#driveMap .drive-map-body'),h=document.querySelector('#driveMap .drive-map-handle'),row=document.querySelector('#driveMap .drive-map-list>.log-row');return {hidden:b.classList.contains('is-sheet-hidden'),now:h.getAttribute('aria-valuenow'),text:h.getAttribute('aria-valuetext'),rowOpacity:getComputedStyle(row).opacity,handle:h.getBoundingClientRect().bottom<=innerHeight}});
    assert(g.hidden&&g.now==='0'&&g.text==='숨김'&&g.rowOpacity==='0'&&g.handle,JSON.stringify(g))}
   await shot('drive-hidden');
   await drive.locator('.drive-map-handle').click();await page.waitForTimeout(120);{const l=await layout();assert(Math.abs(l.share-.36)<.02,JSON.stringify(l))}
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
   await cardA.locator('.route-map-button').tap();await driveOpen();await page.locator('#driveMapBack').tap();await driveClosed();
   // Wide screens: the map fills the screen under the header; the list floats over its right side as a glass card
   // (16px in, its own scroll), the zoom buttons and attribution beside it, a marked segment fitted left of it.
   await page.setViewportSize({width:1280,height:800});await cardA.locator('.route-map-button').tap();await driveOpen();
   {const g=await page.evaluate(()=>{const r=s=>document.querySelector('#driveMap '+s).getBoundingClientRect(),area=r('.drive-map-area'),sheet=r('.drive-map-sheet'),bar=r('.drive-map-bar'),zoom=r('.leaflet-control-zoom'),credit=r('.leaflet-control-attribution');
     return {full:area.left<=1&&area.right>=innerWidth-1&&area.top>=bar.bottom-1&&area.bottom>=innerHeight-1,inset:[innerWidth-sheet.right,sheet.top-bar.bottom,innerHeight-sheet.bottom].map(Math.round),w:Math.round(sheet.width),
      clear:zoom.right<=sheet.left-8&&credit.right<=sheet.left-8,glass:getComputedStyle(document.querySelector('#driveMap .drive-map-list>.log-row')).backdropFilter!=='none'&&getComputedStyle(document.querySelector('#driveMap .drive-map-sheet')).backgroundColor==='rgba(0, 0, 0, 0)',scrolls:getComputedStyle(document.querySelector('#driveMap .drive-map-list')).overflowY}});
    assert(g.full&&g.inset[0]===16&&g.inset[1]===16&&g.inset[2]>=16&&g.w>=320&&g.w<=400&&g.clear&&g.glass&&g.scrolls==='auto',JSON.stringify(g))}
   await drive.locator(`.log-row[data-id="${logs[3].id}"] .log-meta`).click();await page.waitForTimeout(150);
   {const g=await page.evaluate(()=>{const d=document.getElementById('driveMap'),sheet=d.querySelector('.drive-map-sheet').getBoundingClientRect(),line=[...d.querySelectorAll('.leaflet-overlay-pane path.leaflet-interactive')].find(p=>Number(p.getAttribute('stroke-width'))===7)?.getBoundingClientRect();return {left:!!line&&line.right<=sheet.left+1,line:line&&[line.left,line.right].map(Math.round),sheet:Math.round(sheet.left)}});
    assert(g.left,'the marked segment is fitted beside the card '+JSON.stringify(g))}
   await shot('drive-wide');
   await page.keyboard.press('Escape');await driveClosed();await page.setViewportSize({width:390,height:844});await settleLayout(page);
   // ① 목록 | 지도 in the logs panel's header: every drive the list shows, one colour each, fitted.
   const switcher=page.locator('#logView');await switcher.waitFor();
   assert.deepEqual(await switcher.locator('button').allTextContents(),['목록','지도']);
   {const head=await page.locator('.lib-panel-head').first().evaluate(h=>({scroll:h.scrollWidth<=h.clientWidth+1,page:document.documentElement.scrollWidth<=innerWidth}));assert.deepEqual(head,{scroll:true,page:true})}
   await switcher.getByRole('button',{name:'지도'}).tap();
   await page.waitForFunction(()=>document.querySelectorAll('#logMap .leaflet-overlay-pane path.leaflet-interactive').length===2);
   assert(await page.locator('#list').isHidden());
   const routeLines=page.locator('#logMap .leaflet-overlay-pane path.leaflet-interactive');
   const colours=await routeLines.evaluateAll(lines=>lines.map(l=>l.getAttribute('stroke')));assert.notEqual(colours[0],colours[1],'each drive in its own colour');
   assert.equal(await page.locator('#logMap .leaflet-control-attribution').innerText(),'OpenFreeMap © OpenMapTiles Data from OpenStreetMap');
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
   await page.locator('#logSearch').fill('주말');await page.waitForFunction(()=>document.querySelectorAll('#logMap .leaflet-overlay-pane path.leaflet-interactive').length===1);
   await page.locator('#logSearch').fill('');await page.waitForFunction(()=>document.querySelectorAll('#logMap .leaflet-overlay-pane path.leaflet-interactive').length===2);
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
   // 작은 지도 색상: 자동 follows the theme; 라이트/다크 override only the small map's style and are kept on this browser.
   const tilesOf=sel=>page.locator(sel).evaluate(e=>e.dataset.tiles),other=scheme==='dark'?'light':'dark';
   const labelsOf=sel=>page.waitForFunction(sel=>document.querySelector(sel)?.dataset.labels,sel).then(h=>h.jsonValue());
   const styleAsked=tone=>REAL?Promise.resolve():page.waitForRequest(r=>r.url()===STYLE_OF[tone],{timeout:5000});
   {assert.equal(await tilesOf('#videoMap .rv-map'),scheme);
    const pick=async label=>{await page.locator('#overlayHeightSettings').tap();await dialog.waitFor();await dialog.locator('#videoMiniMapTone button',{hasText:label}).tap();if(label!=='자동'){await dialog.locator('#videoMiniMapTone').scrollIntoViewIfNeeded();await shot('minimap-tone')}await page.locator('#overlayHeightClose').tap();await dialog.waitFor({state:'hidden'})};
    {const asked=styleAsked(other);await pick(other==='light'?'라이트':'다크');await asked}assert.equal(await tilesOf('#videoMap .rv-map'),other);
    assert.equal(await page.evaluate(()=>localStorage.getItem('roadviewer-minimap-tone')),other);
    assert.equal(await page.locator('#videoMiniMapTone button[aria-pressed=true]').textContent(),other==='light'?'라이트':'다크');
    {const asked=styleAsked(scheme);await pick('자동');await asked}assert.equal(await tilesOf('#videoMap .rv-map'),scheme);await settleLayout(page)}
   // 작은 지도 글자 없이 보기: off by default; on, the small map alone hides the style's symbol layers (names), with no
   // other style asked, and keeps them hidden through a tone change; kept with the display preferences.
   {const keyOf=()=>page.locator('#videoMap .rv-map').evaluate(e=>e.dataset.tileKey),labels=want=>page.waitForFunction(want=>document.querySelector('#videoMap .rv-map').dataset.labels===want,want,{timeout:5000});
    assert.equal(await keyOf(),scheme);assert.equal(await labelsOf('#videoMap .rv-map'),'shown');
    await page.locator('#overlayHeightSettings').tap();await dialog.waitFor();const box=dialog.getByLabel('작은 지도 글자 없이 보기');assert.equal(await box.isChecked(),false);
    const styles=tiles.filter(url=>url.startsWith(OFM+'styles/')).length;
    await box.check();await labels('hidden');
    assert.equal(tiles.filter(url=>url.startsWith(OFM+'styles/')).length,styles,'no other style for the labels');
    await shot('minimap-plain');
    await page.locator('#overlayHeightClose').tap();await dialog.waitFor({state:'hidden'});
    assert.equal(await keyOf(),scheme+'-nolabels');assert.equal(await page.locator('#routeMapView .rv-map').evaluate(e=>e.dataset.tileKey),scheme,'the panel map keeps its labels');
    assert.equal(await labelsOf('#routeMapView .rv-map'),'shown','the panel map shows its names');
    assert.equal(await page.evaluate(()=>JSON.parse(localStorage.getItem('roadviewer-display-preferences')).checks.videoMiniMapPlain),true);
    // Another tone loads the other style with its names hidden from the start.
    {const asked=styleAsked(other);await page.locator('#overlayHeightSettings').tap();await dialog.waitFor();await dialog.locator('#videoMiniMapTone button',{hasText:other==='light'?'라이트':'다크'}).tap();await asked}
    await page.waitForFunction(other=>document.querySelector('#videoMap .rv-map').dataset.tiles===other,other);await page.waitForTimeout(REAL?1500:300);await labels('hidden');
    assert.equal(await keyOf(),other+'-nolabels');
    {const asked=styleAsked(scheme);await dialog.locator('#videoMiniMapTone button',{hasText:'자동'}).tap();await asked}
    await box.uncheck();await labels('shown');await page.locator('#overlayHeightClose').tap();await dialog.waitFor({state:'hidden'});
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
   assert(await mini.locator('.leaflet-control-attribution').isVisible());assert.equal(await mini.locator('.leaflet-control-attribution').innerText(),'OpenFreeMap © OpenMapTiles © OSM');
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
  // Many drives (60 of one segment and one of 40) on wide screens: the all-drives map lists them in a glass card on
  // the right (its own scroll, a row per drive in its line's colour; hover highlights, a tap selects with the actions
  // inline and fits beside the card), and the card folds away to its button (then a selection shows the bottom card).
  // The drive map's segment card scrolls on its own and folds the same way. Both fold states are kept.
  const many=Array.from({length:60},(_,k)=>({id:(0xe0000000+k).toString(16).padEnd(32,'0'),name:`${(0x500+k).toString(16).padStart(8,'0')}--5a5a5a5a5a / 구간 0`,uploaded:100+k,points:track(ORIGIN[0]-.02+(k%10)*.005,ORIGIN[1]-.03+Math.floor(k/10)*.008,5e-5,4e-5)}));
  const long=[];{let [lat,lon]=[ORIGIN[0]+.01,ORIGIN[1]-.04];for(let k=0;k<40;k++){const d=turns[k%turns.length];long.push({id:(0xf0000000+k).toString(16).padEnd(32,'0'),name:`00000600--6b6b6b6b6b / 구간 ${k}`,uploaded:200+k,points:track(lat,lon,d[0]/3,d[1]/3)});lat=+(lat+20*d[0]).toFixed(6);lon=+(lon+20*d[1]).toFixed(6)}}
  [...many,...long].forEach(writeLog);
  const drives=2+many.length+1;
  for(const scheme of ['dark','light']){
   const context=await browser.newContext({viewport:{width:1280,height:800},colorScheme:scheme,reducedMotion:'reduce'}),page=await context.newPage(),errors=[];
   page.on('pageerror',error=>errors.push(error.message));
   if(!REAL)await context.route(OFM+'**',route=>{const url=route.request().url(),style=url===SIMPLE_LIGHT?['light']:Object.entries(STYLE_OF).find(([,u])=>url===u);
    if(style)return route.fulfill({body:JSON.stringify(fixtureStyle(style[0])),contentType:'application/json'});
    if(url===OFM+'planet')return route.fulfill({body:JSON.stringify({tilejson:'3.0.0',tiles:[OFM+'planet/fixture/{z}/{x}/{y}.pbf'],minzoom:0,maxzoom:14}),contentType:'application/json'});
    return route.fulfill({body:Buffer.alloc(0),contentType:'application/x-protobuf'})});
   const shot=async name=>{if(shots){await settleLayout(page);await page.waitForTimeout(REAL?3000:150);await page.screenshot({path:path.join(shots,`${name}-${scheme}.png`)})}};
   await page.goto(base);await page.locator('#logView').waitFor();
   // Mouse screens: the route is a glass inset in the thumbnail's top-right corner; hovering the thumbnail grows the map
   // strip out of its right edge (pushing the title aside), and the strip opens 주행 지도. No GPS: none of it.
   {const c=page.locator('.log-route[data-route*="00000395"]'),thumb=c.locator('.route-thumb'),strip=c.locator('.route-strip');
    await c.locator('.route-inset svg').waitFor();await c.scrollIntoViewIfNeeded();await page.mouse.move(640,5);
    const rects=()=>c.evaluate(e=>Object.fromEntries(['.route-thumb','.route-inset','.route-strip','.route-main'].map(sel=>{const r=e.querySelector(sel).getBoundingClientRect();return [sel.slice(7),{x:r.x,y:r.y,w:r.width,h:r.height}]})));
    const rect=async sel=>(await rects())[sel.slice(7)];
    await page.waitForTimeout(300);const {thumb:t,inset,strip:rest,main:title}=await rects();
    assert(Math.round(inset.w)===46&&Math.abs(t.x+t.w-inset.x-inset.w-6)<1.5&&Math.abs(inset.y-t.y-6)<1.5&&rest.w===0,JSON.stringify({t,inset,rest}));
    assert(await c.locator('.route-map-button').isHidden(),'no 지도 button with a mouse');
    assert.equal(await page.locator('.log-route[data-route*="00000397"] :is(.route-inset,.route-strip,.route-map-button)').count(),0);
    if(shots){await settleLayout(page);await c.screenshot({path:path.join(shots,`card-rest-${scheme}.png`)})}
    await thumb.hover();await page.waitForTimeout(400);
    const {strip:open,main:moved,thumb:t2}=await rects();t.x=t2.x;t.y=t2.y;title.x+=0;
    assert(Math.abs(open.w-open.h)<1.5&&Math.abs(open.x-t.x-t.w)<1.5&&Math.abs(open.h-t.h)<1.5&&moved.x>=title.x+open.w-2,JSON.stringify({open,t,title,moved}));
    assert.equal(await c.locator('.route-inset').evaluate(e=>getComputedStyle(e).opacity),'0');
    if(shots){await c.screenshot({path:path.join(shots,`card-hover-${scheme}.png`)})}
    assert.equal(await strip.getAttribute('aria-label'),'주행 지도 열기');
    await strip.click();await page.waitForFunction(()=>document.getElementById('driveMap').open);
    assert(!await c.evaluate(e=>e.open),'the strip does not fold the card');
    await page.keyboard.press('Escape');await page.waitForFunction(()=>!document.getElementById('driveMap').open);
    assert(await strip.evaluate(e=>e===document.activeElement),'focus returns to the strip (it stays open while focused)');
    await page.evaluate(()=>document.activeElement.blur());await page.mouse.move(640,5);await page.waitForTimeout(400);assert.equal((await rect('.route-strip')).w,0,'folds back')}
   await page.locator('#logView').getByRole('button',{name:'지도'}).click();
   const rows=page.locator('#logMapRows .map-list-row'),fold=page.locator('#logMap>.map-fold');
   await page.waitForFunction(n=>document.querySelectorAll('#logMapRows .map-list-row').length===n&&document.querySelectorAll('#logMap .leaflet-overlay-pane path.leaflet-interactive').length===n,drives,{timeout:20000});
   const card=()=>page.evaluate(()=>{const r=s=>document.querySelector(s).getBoundingClientRect(),map=r('#logMap'),list=r('#logMapList'),button=r('#logMap>.map-fold'),rows=document.getElementById('logMapRows'),zoom=r('#logMap .leaflet-control-zoom'),credit=r('#logMap .leaflet-control-attribution');
    return {right:Math.round(map.right-list.right),below:Math.abs(list.top-button.top)<=1,bottom:list.bottom<=map.bottom-15,w:Math.round(list.width),scrolls:rows.scrollHeight>rows.clientHeight+40,button:[map.right-button.right,button.top-map.top].map(Math.round),size:Math.round(button.width),
     clear:zoom.right<list.left&&credit.right<=list.left-8,glass:getComputedStyle(document.querySelector('#logMapRows>.map-list-row')).backdropFilter!=='none'&&getComputedStyle(document.getElementById('logMapList')).backgroundColor==='rgba(0, 0, 0, 0)',shown:!!list.width}});
   {const g=await card();assert(g.shown&&g.right===16&&g.below&&g.bottom&&g.w>=300&&g.w<=380&&g.scrolls&&g.clear&&g.glass&&g.button[0]===16&&g.button[1]===16&&g.size===40,JSON.stringify(g))}
   assert.equal(await fold.getAttribute('aria-expanded'),'true');assert.equal(await fold.getAttribute('aria-label'),'주행 목록 접기');
   assert.equal(await page.locator('#logMapList .log-map-list-count').innerText(),`${drives}개`);
   // The count label sits on the fold button's line.
   {const [head,button]=await page.evaluate(()=>['#logMapList .log-map-list-head','#logMap>.map-fold'].map(s=>{const r=document.querySelector(s).getBoundingClientRect();return r.top+r.height/2}));assert(Math.abs(head-button)<=1.5,'label and fold button on one line '+head+' '+button)}
   // Each row in its line's colour; a hovered row's line stands out.
   const strong=()=>page.locator('#logMap .leaflet-overlay-pane path.leaflet-interactive').evaluateAll(lines=>lines.map((l,i)=>Number(l.getAttribute('stroke-width'))===6?l.getAttribute('stroke'):null).filter(Boolean));
   await rows.nth(4).hover();await page.waitForTimeout(50);
   {const lit=await strong(),swatch=await rows.nth(4).locator('.map-list-pick').evaluate(b=>getComputedStyle(b,'::before').backgroundColor);assert.equal(lit.length,1,'the hovered drive');assert.equal(swatch,await page.evaluate(c=>{const e=document.createElement('i');e.style.color=c;document.body.append(e);const v=getComputedStyle(e).color;e.remove();return v},lit[0]),'the row\'s swatch is its line\'s colour')}
   // A tap selects: actions inline, no bottom card, the drive fitted beside the card.
   await rows.nth(4).locator('.map-list-pick').click();await page.mouse.move(10,400);await page.waitForTimeout(150);
   assert(await rows.nth(4).evaluate(r=>r.classList.contains('is-selected')));
   assert.deepEqual(await rows.nth(4).locator('.map-card-actions>:is(a,button)').allInnerTexts(),['재생','주행 지도','목록에서 보기']);
   assert(await page.locator('#logMapCard').isHidden(),'no bottom card while the list shows');
   {const g=await page.evaluate(()=>{const list=document.getElementById('logMapList').getBoundingClientRect(),line=[...document.querySelectorAll('#logMap .leaflet-overlay-pane path.leaflet-interactive')].find(p=>Number(p.getAttribute('stroke-width'))===6).getBoundingClientRect();return {left:line.right<=list.left+1,line:[line.left,line.right].map(Math.round),list:Math.round(list.left)}});assert(g.left,JSON.stringify(g))}
   await shot('list-wide');
   // The cards fade out at an edge only with more beyond it: at the top of the column, only at the bottom.
   {const fades=()=>page.evaluate(()=>{const c=document.getElementById('logMapRows'),cards=[...c.children];return {top:c.classList.contains('fade-top'),bottom:c.classList.contains('fade-bottom'),masked:cards.filter(e=>e.style.maskImage).length}});
    await page.evaluate(()=>document.getElementById('logMapRows').scrollTop=0);await page.waitForTimeout(100);
    {const f=await fades();assert(!f.top&&f.bottom&&f.masked>=1,JSON.stringify(f))}
    await page.evaluate(()=>{const c=document.getElementById('logMapRows');c.scrollTop=c.scrollHeight/2});await page.waitForTimeout(100);
    {const f=await fades();assert(f.top&&f.bottom&&f.masked>=2,JSON.stringify(f))}
    await shot('list-wide-scrolled');
    await page.evaluate(()=>{const c=document.getElementById('logMapRows');c.scrollTop=c.scrollHeight});await page.waitForTimeout(100);
    {const f=await fades();assert(f.top&&!f.bottom,JSON.stringify(f))}
    await rows.nth(4).scrollIntoViewIfNeeded()}
   // 단순 지도: the button under the zoom buttons switches every map to the calm style (Positron light / Dark) without 3D
   // buildings and points of interest, keeps the view, and is kept on this browser (off by default).
   {const simple=page.locator('#logMap .rv-map-simple a'),gl=()=>page.evaluate(()=>{const box=document.querySelector('#logMap .rv-map');return {simple:box.dataset.simple}});
    assert.equal(await simple.getAttribute('aria-pressed'),'false');assert.equal(await simple.getAttribute('aria-label'),'단순 지도 켜기');
    {const z=await page.locator('#logMap .leaflet-control-zoom').boundingBox(),b=await simple.boundingBox();assert(Math.abs(b.x-z.x)<2&&b.y>=z.y+z.height-1&&b.y<z.y+z.height+16&&Math.abs(b.width-z.width)<3,JSON.stringify({z,b}))}
    const styleUrls=[];page.on('request',r=>{if(r.url().startsWith(OFM+'styles/'))styleUrls.push(r.url())});
    const view=()=>page.evaluate(()=>document.querySelector('#logMap .leaflet-map-pane').style.transform);const before=await view();
    await simple.click();assert.equal(await simple.getAttribute('aria-pressed'),'true');assert.equal(await simple.getAttribute('aria-label'),'단순 지도 끄기');
    await page.waitForFunction(()=>document.querySelector('#logMap .rv-map').dataset.simple==='true');
    await page.waitForFunction(()=>(document.querySelector('#logMap .rv-map').dataset.removed||'')!=='',null,{timeout:20000});await page.waitForTimeout(REAL?2500:200);
    assert(styleUrls.includes(scheme==='light'?SIMPLE_LIGHT:STYLE_OF.dark),'simple style '+styleUrls);
    {const removed=(await page.evaluate(()=>document.querySelector('#logMap .rv-map').dataset.removed)).split(' ');
     assert(!REAL?removed.includes('building-3d')&&removed.includes('poi_r1')&&!removed.includes('street-name'):removed.every(id=>!/name|label/.test(id)||/poi/.test(id)),removed.join(' '))}
    assert.equal(await view(),before,'the view stays');assert(await rows.nth(4).evaluate(r=>r.classList.contains('is-selected')),'the selection stays');
    assert.equal(await page.evaluate(()=>localStorage.getItem('roadviewer-map-simple')),'1');
    if(scheme==='light')await shot('list-wide-simple');
    await page.reload();await page.locator('#logView').waitFor();await page.waitForFunction(()=>document.querySelector('#logMap .rv-map-simple a'),null,{timeout:20000});
    assert.equal(await simple.getAttribute('aria-pressed'),'true','kept on');
    await simple.click();assert.equal(await simple.getAttribute('aria-pressed'),'false');assert.equal(await page.evaluate(()=>localStorage.getItem('roadviewer-map-simple')),'0');
    await page.waitForFunction(()=>document.querySelector('#logMap .rv-map').dataset.simple==='false');
    await page.waitForFunction(n=>document.querySelectorAll('#logMap .leaflet-overlay-pane path.leaflet-interactive').length===n,drives,{timeout:20000});
    await rows.nth(4).locator('.map-list-pick').click();await page.mouse.move(10,400);await page.waitForTimeout(150)}
   // A line tapped on the map selects its row and scrolls the list to it.
   {const last=page.locator('#logMap .leaflet-overlay-pane path.leaflet-interactive').last();await last.evaluate(p=>{const L=window.L;p.dispatchEvent(new MouseEvent('click',{bubbles:true,clientX:0,clientY:0}))});
    await page.waitForFunction(()=>{const r=document.querySelector('#logMapRows .map-list-row.is-selected');if(!r)return false;const b=r.getBoundingClientRect(),l=document.getElementById('logMapRows').getBoundingClientRect();return b.top>=l.top-1&&b.bottom<=l.bottom+1})}
   // Folded: only the button (same place, chevron turned), the bottom card for a selection, no right padding.
   const before=await fold.boundingBox();await fold.click();
   assert.equal(await fold.getAttribute('aria-expanded'),'false');assert.equal(await fold.getAttribute('aria-label'),'주행 목록 펼치기');
   assert(await page.locator('#logMapList').isHidden());assert.deepEqual(await fold.boundingBox(),before,'the button stays put');
   assert(await page.locator('#logMapCard').isVisible(),'folded: the selection shows the bottom card');
   assert.equal(await page.evaluate(()=>localStorage.getItem('roadviewer-map-list-folded')),'1');
   await shot('list-wide-folded');
   await page.reload();await page.locator('#logView').waitFor();await page.waitForFunction(()=>document.querySelectorAll('#logMap .leaflet-overlay-pane path.leaflet-interactive').length>0,null,{timeout:20000});
   assert.equal(await fold.getAttribute('aria-expanded'),'false','kept folded');assert(await page.locator('#logMapList').isHidden());
   await fold.click();await page.locator('#logMapList').waitFor();
   // The 40-segment drive's map: its segment card scrolls on its own and folds like the list.
   const longRow=rows.filter({hasText:'40개 구간'});await longRow.locator('.map-list-pick').click();await longRow.getByRole('button',{name:'주행 지도'}).click();
   await page.waitForFunction(()=>{const d=document.getElementById('driveMap');return d.open&&d.querySelectorAll('.drive-map-list>.log-row').length===40&&d.querySelectorAll('.leaflet-overlay-pane path.leaflet-interactive').length===40},null,{timeout:20000});
   await settleLayout(page,'#driveMap');
   {const g=await page.evaluate(()=>{const d=document.getElementById('driveMap'),r=s=>d.querySelector(s).getBoundingClientRect(),sheet=r('.drive-map-sheet'),button=r('.drive-map-fold'),list=d.querySelector('.drive-map-list');return {scrolls:list.scrollHeight>list.clientHeight+40,bottom:Math.round(innerHeight-sheet.bottom),below:Math.abs(sheet.top-button.top)<=1,button:[innerWidth-button.right].map(Math.round)}});
    assert(g.scrolls&&g.bottom>=16&&g.below&&g.button[0]===16,JSON.stringify(g))}
   await shot('drive-wide-40');
   {const button=page.locator('#driveMap .drive-map-fold'),at=await button.boundingBox();await button.click();
    assert.equal(await button.getAttribute('aria-expanded'),'false');assert(await page.locator('#driveMap .drive-map-sheet').isHidden());assert.deepEqual(await button.boundingBox(),at);
    await shot('drive-wide-folded');await button.click();assert(await page.locator('#driveMap .drive-map-sheet').isVisible())}
   assert.deepEqual(errors,[]);
   await context.close();
  }
  console.log('maps ok');
 }finally{await browser?.close();python.kill();fs.rmSync(dir,{recursive:true,force:true})}
})().catch(error=>{console.error(error);process.exit(1)});
