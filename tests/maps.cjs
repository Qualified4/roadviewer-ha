// GPS route maps (maps.js): ① the list's 목록 | 지도 view, ② the route shape on a card and 주행 지도 (the drive full
// screen: map + segment sheet), ③ the replay's 주행 상황 | 지도 view and ④ the small map in the video's top-right corner,
// in the dark and the light theme. The OpenFreeMap basemap (MapLibre in Leaflet) is stubbed with small fixtures (no
// network) unless RV_MAP_REAL_TILES=1; the positions are synthetic, never a real drive.
const fs=require('fs'),os=require('os'),path=require('path'),zlib=require('zlib'),assert=require('node:assert/strict'),{spawn}=require('child_process'),{chromium}=require('playwright');
const {settleLayout}=require('./browser-helpers.cjs');
// OpenFreeMap stubs: a style per theme (a background, a GeoJSON street grid around the routes and a symbol layer of
// street names, so 글자 숨기기 has layers to hide), its TileJSON, empty vector tiles and empty glyph ranges.
// RV_MAP_REAL_TILES=1 lets the browser fetch the real OpenFreeMap styles and tiles instead (with RV_MAP_SHOTS, to look).
const REAL=process.env.RV_MAP_REAL_TILES==='1';
// RV_MAP_SCHEMES=dark or =light runs one theme only: CI runs the two as separate groups (the file took 140-170 s as one).
const SCHEMES=(process.env.RV_MAP_SCHEMES||'dark,light').split(',');
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
// Each Leaflet map of the page (window.rvTestMaps), for the checks against MapLibre's own projection.
const hookMaps=()=>{let L;Object.defineProperty(window,'L',{configurable:true,get:()=>L,set(v){L=v;try{v.Map.addInitHook(function(){(window.rvTestMaps||=[]).push(this)})}catch{}}})};
(async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'rv-maps-')),shots=process.env.RV_MAP_SHOTS;
 if(shots)fs.mkdirSync(shots,{recursive:true});
 fs.writeFileSync(path.join(dir,'.processing-settings.json'),JSON.stringify({auto_convert:false}));
 // Route A: eight segments winding north-east (segment 1 has video); route B: one segment elsewhere; route C: no GPS.
 const track=(lat,lon,dlat,dlon)=>Array.from({length:61},(_,i)=>[i,+(lat+i*dlat).toFixed(6),+(lon+i*dlon+Math.sin(i/9)*2e-5).toFixed(6),12.5,Math.round(Math.atan2(dlon,dlat)*180/Math.PI+360)%360]);
 const turns=[[8e-5,6e-5],[0,1e-4],[7e-5,4e-5],[1e-4,0],[6e-5,-5e-5],[0,9e-5],[8e-5,3e-5],[5e-5,7e-5]];
 const routeA=[];{let [lat,lon]=ORIGIN;turns.forEach(([dlat,dlon],k)=>{routeA.push(track(lat,lon,dlat,dlon));lat=+(lat+60*dlat).toFixed(6);lon=+(lon+60*dlon).toFixed(6)})}
 // Segment 1 (the one with video): its bearing climbs 3° a second through north (350° … 359°, 2° …), and its sample
 // at 31 s holds the fix of 30 s (a GPS hold while moving).
 routeA[1].forEach((p,i)=>{p[4]=(350+3*i)%360});routeA[1][31][1]=routeA[1][30][1];routeA[1][31][2]=routeA[1][30][2];
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
  for(const scheme of SCHEMES){
   const context=await browser.newContext({viewport:{width:390,height:844},hasTouch:true,isMobile:true,colorScheme:scheme,reducedMotion:'reduce'}),page=await context.newPage(),errors=[],tiles=[],stubbed=[];
   page.on('pageerror',error=>errors.push(error.message));await context.addInitScript(hookMaps);
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
   // Opening focuses the title (not the back button) and shows no focus ring.
   assert.deepEqual(await page.evaluate(()=>({id:document.activeElement.id,ring:!!document.querySelector('#driveMap :focus-visible'),outline:getComputedStyle(document.activeElement).outlineStyle})),{id:'driveMapTitle',ring:false,outline:'none'});
   assert.equal(await page.locator('#driveMapFacts').innerText(),`${(A*0.9).toFixed(1)} km · ${A}:00 · ${A}개 구간`);
   assert.equal(await drive.locator('.drive-map-list>.log-row').count(),A,'one row per segment, in segment order');
   assert.deepEqual(await drive.locator('.drive-map-list>.log-row').evaluateAll(rows=>rows.map(r=>r.dataset.id[0])),logs.slice(0,A).map(log=>log.id[0]));
   assert.equal(await drive.locator('.drive-map-list .log-row a.replay').count(),A,'each row keeps its play button');
   assert.equal(await drive.locator('.drive-map-list .log-row .recording-more').count(),A,'and its ⋯ menu');
   assert.equal(await drive.locator('.leaflet-control-attribution').innerText(),'OpenFreeMap © OpenMapTiles Data from OpenStreetMap');
   assert.equal(await drive.locator('.leaflet-tile-pane canvas.maplibregl-canvas').count(),1,'MapLibre draws the basemap in the tile pane');
   {const l=await layout();assert(l.area.top>=l.bar-1&&l.area.h>=.28*844,JSON.stringify(l));assert(Math.abs(l.share-.54)<.02,JSON.stringify(l))}
   // A row's ⋯ menu in the sheet opens to the side with room (the list scrolls it clear when neither has one) and lies
   // over the rows after it, never cut by the sheet's edges (in a low sheet it slides over its own button).
   const menuClear=async id=>{const row=drive.locator(`.log-row[data-id="${id}"]`);await row.locator('.recording-more>summary').tap();await page.waitForTimeout(450);
    const g=await row.evaluate(r=>{const m=r.querySelector('.recording-menu'),menu=m.getBoundingClientRect(),list=r.closest('.drive-map-list').getBoundingClientRect();
     return {inside:menu.top>=list.top-.5&&menu.bottom<=list.bottom+.5,over:[menu.top+10,(menu.top+menu.bottom)/2,menu.bottom-10].every(y=>m.contains(document.elementFromPoint(menu.left+30,y))),menu:[menu.top,menu.bottom].map(Math.round),list:[list.top,list.bottom].map(Math.round)}});
    await row.evaluate(r=>{r.querySelector('.recording-more').open=false});await page.waitForTimeout(100);assert(g.inside&&g.over,'menu '+id[0]+' '+JSON.stringify(g))};
   for(const k of [0,2,3])await menuClear(logs[k].id);
   await drive.locator('.drive-map-list').evaluate(list=>{list.scrollTop=0});
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
   // Every map folds its credit into an ⓘ from the start.
   assert(await drive.locator('.leaflet-control-attribution').isHidden()&&await drive.locator('.rv-credit-toggle').isVisible(),'the credit is folded');
   await tapLine(driveLines.nth(1),.5);
   await page.waitForFunction(id=>document.querySelector(`#driveMap .log-row[data-id="${id}"]`)?.classList.contains('is-map-marked'),logs[1].id);
   await page.waitForTimeout(100);{const l=await layout();assert(l.rowVisible,JSON.stringify(l))}
   // The sheet's handle: dragged up the sheet grows to 70% and the map keeps ≥ 30%; dragged down it snaps to 36%.
   const drag=async dy=>{const box=await drive.locator('.drive-map-handle').boundingBox(),x=box.x+box.width/2,y=box.y+box.height/2;await page.mouse.move(x,y);await page.mouse.down();await page.mouse.move(x,y+dy/2,{steps:4});await page.mouse.move(x,y+dy,{steps:4});await page.mouse.up();await page.waitForTimeout(120)};
   // Raising or lowering the sheet does not move the map (only a tap on a card does): the drawn route stays put.
   const routeBox=()=>page.evaluate(()=>{const b=document.querySelector('#driveMap .leaflet-overlay-pane path').getBoundingClientRect();return [b.left,b.top,b.width,b.height].map(Math.round)});
   const routeBefore=await routeBox();
   await drag(-160);{const l=await layout();assert(Math.abs(l.share-.7)<.02&&l.area.h>=.26*l.body,JSON.stringify(l))}
   await page.waitForTimeout(450);{const after=await routeBox();assert(after.every((v,i)=>Math.abs(v-routeBefore[i])<=1),'the sheet moved the map: '+JSON.stringify({routeBefore,after}))}
   await drive.locator(`.log-row[data-id="${last}"] .log-meta`).tap();await page.waitForTimeout(100);
   {const l=await layout();assert(l.rowVisible&&l.lineInside,JSON.stringify(l))}
   await shot('drive-up');
   // Dragged all the way down the cards hide and only the handle stays; a tap brings them back at the middle height.
   await drag(400);{const g=await page.evaluate(()=>{const b=document.querySelector('#driveMap .drive-map-body'),h=document.querySelector('#driveMap .drive-map-handle'),row=document.querySelector('#driveMap .drive-map-list>.log-row');return {hidden:b.classList.contains('is-sheet-hidden'),now:h.getAttribute('aria-valuenow'),text:h.getAttribute('aria-valuetext'),rowOpacity:getComputedStyle(row).opacity,handle:h.getBoundingClientRect().bottom<=innerHeight}});
    assert(g.hidden&&g.now==='0'&&g.text==='숨김'&&g.rowOpacity==='0'&&g.handle,JSON.stringify(g))}
   await shot('drive-hidden');
   // The ⓘ in the corner is not under the clear sheet: a tap opens the credit, another folds it.
   {const toggle=drive.locator('.rv-credit-toggle'),credit=drive.locator('.leaflet-control-attribution');
    assert(await toggle.evaluate(t=>{const b=t.getBoundingClientRect();return t.contains(document.elementFromPoint(b.left+b.width/2,b.top+b.height/2))}),'nothing covers the ⓘ');
    await toggle.tap();await credit.waitFor();assert.equal(await toggle.getAttribute('aria-expanded'),'true');await toggle.tap();await credit.waitFor({state:'hidden'})}
   // The marked segment's pill sits on the hidden sheet; a tap brings the cards back and the pill leaves from where it
   // is (riding up with the sheet's own motion, no jump to the new height) — it is leaving right away.
   {const pill=drive.locator('.drive-map-card');assert(await pill.isVisible(),'the pill shows while the cards are away');
    await page.emulateMedia({reducedMotion:'no-preference'});  // this check is about the motion itself
    const top0=(await pill.boundingBox()).y;
    const next=await page.evaluate(()=>new Promise(resolve=>{document.querySelector('#driveMap .drive-map-handle').click();requestAnimationFrame(()=>{const p=document.querySelector('#driveMap .drive-map-card');resolve({top:p.getBoundingClientRect().top,leaving:p.classList.contains('is-leaving')||p.hidden})})}));
    assert(next.leaving&&next.top>0&&Math.abs(next.top-top0)<40,'the pill leaves without a jump: '+JSON.stringify({top0,next}))}
   await page.waitForTimeout(400);await page.emulateMedia({reducedMotion:'reduce'});{const l=await layout();assert(Math.abs(l.share-.54)<.02,JSON.stringify(l));assert(await drive.locator('.drive-map-card').isHidden(),'the pill has gone')}
   await drag(-30);{const l=await layout();assert(Math.abs(l.share-.54)<.02,'a short drag snaps back: '+JSON.stringify(l))}
   // A tap folds and unfolds like a disclosure: shown (at any height) -> hidden, hidden -> the middle height.
   {const hidden=()=>page.evaluate(()=>document.querySelector('#driveMap .drive-map-body').classList.contains('is-sheet-hidden'));
    await drive.locator('.drive-map-handle').tap();await page.waitForTimeout(150);assert(await hidden(),'a tap on a shown sheet hides it');
    await drive.locator('.drive-map-handle').tap();await page.waitForTimeout(150);{const l=await layout();assert(!await hidden()&&Math.abs(l.share-.54)<.02,'a tap on the hidden sheet brings the middle height: '+JSON.stringify(l))}
    await drag(-160);await drive.locator('.drive-map-handle').tap();await page.waitForTimeout(150);assert(await hidden(),'from the top height too, a tap hides it')
    await drive.locator('.drive-map-handle').tap();await page.waitForTimeout(150)}
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
   {const g=await page.evaluate(()=>{const r=s=>document.querySelector('#driveMap '+s).getBoundingClientRect(),area=r('.drive-map-area'),sheet=r('.drive-map-sheet'),bar=r('.drive-map-bar'),zoom=r('.leaflet-control-zoom'),credit=r('.rv-credit-toggle');
     return {full:area.left<=1&&area.right>=innerWidth-1&&area.top>=bar.bottom-1&&area.bottom>=innerHeight-1,inset:[innerWidth-sheet.right,sheet.top-bar.bottom,innerHeight-sheet.bottom].map(Math.round),w:Math.round(sheet.width),
      clear:zoom.right<=sheet.left-8&&area.right-credit.right>=0&&area.right-credit.right<=8&&area.bottom-credit.bottom>=0&&area.bottom-credit.bottom<=8&&sheet.bottom<=credit.top,glass:getComputedStyle(document.querySelector('#driveMap .drive-map-list>.log-row')).backdropFilter!=='none'&&getComputedStyle(document.querySelector('#driveMap .drive-map-sheet')).backgroundColor==='rgba(0, 0, 0, 0)',scrolls:getComputedStyle(document.querySelector('#driveMap .drive-map-list')).overflowY}});
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
   // Phones: the drives are a bottom sheet like the drive map's: a small glass handle with the count over the same glass
   // cards, at the middle height to start (no label, nothing autofocused).
   // The whole map on screen, clear of the header and the fixed tab bar.
   await page.locator('#logMap').evaluate(m=>m.scrollIntoView({block:'center'}));await page.waitForTimeout(100);
   {const handle=page.locator('#logMap .log-map-handle'),rows=page.locator('#logMapRows .map-list-row'),mapCard=page.locator('#logMapCard');
    const sheetState=()=>page.evaluate(()=>{const m=document.getElementById('logMap'),r=m.getBoundingClientRect(),s=document.getElementById('logMapList').getBoundingClientRect(),h=m.querySelector('.log-map-handle'),row=m.querySelector('#logMapRows>.map-list-row');
     return {hidden:m.classList.contains('is-sheet-hidden'),share:s.height/r.height,bottom:Math.round(r.bottom-s.bottom),now:h.getAttribute('aria-valuenow'),text:h.getAttribute('aria-valuetext'),rowOpacity:getComputedStyle(row).opacity}});
    const lineBox=(width=null)=>page.evaluate(width=>{const p=[...document.querySelectorAll('#logMap .leaflet-overlay-pane path.leaflet-interactive')].find(p=>width===null||Number(p.getAttribute('stroke-width'))===width),b=p.getBoundingClientRect();return [b.left,b.top,b.width,b.height].map(Math.round)},width);
    const drag=async dy=>{const box=await handle.boundingBox(),x=box.x+box.width/2,y=box.y+box.height/2;await page.mouse.move(x,y);await page.mouse.down();await page.mouse.move(x,y+dy/2,{steps:4});await page.mouse.move(x,y+dy,{steps:4});await page.mouse.up();await page.waitForTimeout(120)};
    const creditFree=()=>page.locator('#logMap .rv-credit-toggle').evaluate(t=>{const b=t.getBoundingClientRect();return t.contains(document.elementFromPoint(b.left+b.width/2,b.top+b.height/2))});
    assert.equal((await handle.innerText()).trim(),'주행 목록 2개');assert(await handle.isVisible()&&await page.locator('#logMapList .log-map-list-head').isHidden());
    // The phone map reaches down to just above the bottom tab bar (whatever sits above it), with the page at the top.
    {const g=await page.evaluate(()=>{const m=document.getElementById('logMap').getBoundingClientRect(),t=document.querySelector('.lib-tabs').getBoundingClientRect();return {gap:Math.round(t.top-(m.top+window.scrollY+m.height)),h:Math.round(m.height)}});
     assert(g.gap>=8&&g.gap<=16,'the phone map ends just above the tab bar '+JSON.stringify(g))}
    // A short screen (a Fold's inner one): the map is taller than what is left under the header; the page stays where it
    // is, and scrolled until the chips reach the app bar the map ends just above the tab bar.
    {const size=page.viewportSize();await page.setViewportSize({width:476,height:670});
     await page.locator('#logView button[data-view="list"]').click();await page.locator('#logView button[data-view="map"]').click();
     await page.waitForTimeout(500);assert.equal(await page.evaluate(()=>scrollY),0,'opening the map does not scroll the page');
     await page.evaluate(()=>{const c=document.getElementById('logChips').getBoundingClientRect(),a=document.querySelector('.lib-appbar').getBoundingClientRect();scrollTo(0,c.top-a.bottom-8)});await page.waitForTimeout(200);
     const g=await page.evaluate(()=>{const m=document.getElementById('logMap').getBoundingClientRect(),t=document.querySelector('.lib-tabs').getBoundingClientRect(),c=document.getElementById('logChips').getBoundingClientRect(),a=document.querySelector('.lib-appbar').getBoundingClientRect();
      return {h:Math.round(m.height),gap:Math.round(t.top-m.bottom),chips:Math.round(c.top-a.bottom),chipsShown:c.bottom<=m.top+1,scrollY:Math.round(scrollY)}});
     assert(g.h>=420&&g.gap>=8&&g.gap<=16&&g.chips>=4&&g.chips<=12&&g.chipsShown,'the short-screen map fills below the chips '+JSON.stringify(g));
     await page.setViewportSize(size);await page.evaluate(()=>scrollTo(0,0));
     await page.locator('#logView button[data-view="list"]').click();await page.locator('#logView button[data-view="map"]').click();await page.waitForTimeout(400)}
    assert.equal(await handle.getAttribute('role'),'slider');assert.equal(await page.locator('#logMap [autofocus]').count(),0);
    assert.equal(await rows.count(),2);assert(await rows.first().evaluate(r=>getComputedStyle(r).backdropFilter!=='none'),'glass cards');
    assert.equal(await page.locator('#logMapRows .map-list-pick[data-no-ripple]').count(),2,'a press scales the whole card instead of rippling in its title part');
    {const g=await sheetState();assert(!g.hidden&&Math.abs(g.share-.54)<.02&&g.bottom===0&&g.now==='54',JSON.stringify(g))}
    assert(await creditFree(),'the open sheet leaves the ⓘ uncovered');
    // A tap on a route marks its card (its actions inline, scrolled into view); no bottom card while the cards show.
    await tapLine(routeLines.nth(1));await page.waitForFunction(()=>document.querySelectorAll('#logMapRows>.map-list-row')[1].classList.contains('is-selected'));await page.waitForTimeout(150);
    assert.deepEqual(await rows.nth(1).locator('.map-card-actions>:is(a,button)').allInnerTexts(),['재생','주행 지도','목록에서 보기']);
    assert(await mapCard.isHidden(),'no bottom card while the sheet is up');
    assert(await rows.nth(1).evaluate(r=>{const b=r.getBoundingClientRect(),l=r.parentElement.getBoundingClientRect();return b.top>=l.top-1&&b.bottom<=l.bottom+1}),'the marked card is in view');
    // A tap beside a route line, a finger's width away and on no line, marks that route all the same (the lines are a few
    // pixels wide; such a tap used to clear the selection). Here: beside the other route's line (the thinner one).
    {const beside=await page.evaluate(()=>{const p=[...document.querySelectorAll('#logMap .leaflet-overlay-pane path.leaflet-interactive')].find(p=>Number(p.getAttribute('stroke-width'))!==6),m=p.getScreenCTM(),length=p.getTotalLength();
      for(const k of [.5,.4,.6,.3,.7,.2,.8])for(const [dx,dy] of [[0,14],[14,0],[0,-14],[-14,0]]){const at=p.getPointAtLength(length*k),x=Math.round(at.x*m.a+at.y*m.c+m.e)+dx,y=Math.round(at.x*m.b+at.y*m.d+m.f)+dy,hit=document.elementFromPoint(x,y);
       if(hit&&hit.closest('.log-map-canvas')&&hit.localName!=='path'&&!hit.closest('.leaflet-control,#logMapList'))return {x,y}}return null});
     assert(beside,'a free spot beside the other route');await page.touchscreen.tap(beside.x,beside.y);
     await page.waitForFunction(()=>document.querySelectorAll('#logMapRows>.map-list-row')[0].classList.contains('is-selected'),null,{timeout:3000});
     // Back to the second route, by its own line (now the thinner one; a marked line is brought to the front).
     await tapLine(page.locator('#logMap .leaflet-overlay-pane path.leaflet-interactive:not([stroke-width="6"])').first());await page.waitForFunction(()=>document.querySelectorAll('#logMapRows>.map-list-row')[1].classList.contains('is-selected'));await page.waitForTimeout(150)}
    // A tap on a card selects that drive and fits the map to it above the sheet. (lineBox(): the first card's line, the marked
    // one having been brought to the front, the last path).
    const before=await lineBox();await rows.first().locator('.map-list-pick').tap();await page.waitForTimeout(450);
    assert(await rows.first().evaluate(r=>r.classList.contains('is-selected'))&&!await rows.nth(1).evaluate(r=>r.classList.contains('is-selected')));
    {const g=await page.evaluate(()=>{const m=document.getElementById('logMap').getBoundingClientRect(),s=document.getElementById('logMapList').getBoundingClientRect(),line=[...document.querySelectorAll('#logMap .leaflet-overlay-pane path.leaflet-interactive')].find(p=>Number(p.getAttribute('stroke-width'))===6).getBoundingClientRect();
      return {inside:line.top>=m.top-1&&line.bottom<=s.top+1&&line.left>=m.left-1&&line.right<=m.right+1,line:[line.top,line.bottom].map(Math.round),sheet:Math.round(s.top)}});
     const after=await lineBox(6);assert(g.inside&&after[3]>before[3]*2,'fitted above the sheet '+JSON.stringify({g,before,after}))}
    await shot('list-map-middle');
    // Raising and lowering the sheet keeps the map where it is; a drag snaps to the nearest height.
    const still=await lineBox(6);
    await drag(-160);{const g=await sheetState();assert(!g.hidden&&Math.abs(g.share-.7)<.02,JSON.stringify(g))}
    await page.waitForTimeout(450);{const after=await lineBox(6);assert(after.every((v,i)=>Math.abs(v-still[i])<=1),'the sheet moved the map: '+JSON.stringify({still,after}))}
    await drag(110);{const g=await sheetState();assert(Math.abs(g.share-.54)<.02,'snaps to the middle '+JSON.stringify(g))}
    // Pulled all the way down only the handle stays; the selected drive's card shows above it.
    await drag(400);await page.waitForTimeout(150);
    {const g=await sheetState();assert(g.hidden&&g.now==='0'&&g.text==='숨김'&&g.rowOpacity==='0',JSON.stringify(g))}
    {const after=await lineBox(6);assert(after.every((v,i)=>Math.abs(v-still[i])<=1),'hiding the sheet moved the map: '+JSON.stringify({still,after}))}
    await mapCard.waitFor();
    {const [c,h]=await page.evaluate(()=>['#logMapCard','#logMap .log-map-handle'].map(s=>document.querySelector(s).getBoundingClientRect()));assert(c.bottom<=h.top+1,'the card sits above the handle '+JSON.stringify([c.bottom,h.top]))}
    assert.deepEqual(await mapCard.locator('.map-card-actions>:is(a,button):not(.map-card-close)').allInnerTexts(),['재생','주행 지도','목록에서 보기']);
    await shot('list-map-hidden');
    {const toggle=page.locator('#logMap .rv-credit-toggle'),credit=page.locator('#logMap .leaflet-control-attribution');
     assert(await creditFree(),'nothing covers the ⓘ');await toggle.tap();await credit.waitFor();await toggle.tap();await credit.waitFor({state:'hidden'})}
    // A tap (or Enter) folds and unfolds: hidden -> the middle height (the card leaves), shown -> hidden (it is back).
    await handle.tap();await page.waitForTimeout(400);{const g=await sheetState();assert(!g.hidden&&Math.abs(g.share-.54)<.02,JSON.stringify(g))}
    assert(await mapCard.isHidden(),'the card leaves while the cards show');
    await handle.tap();await page.waitForTimeout(150);assert((await sheetState()).hidden,'a tap hides it');await mapCard.waitFor();
    await handle.focus();await page.keyboard.press('Enter');await page.waitForTimeout(150);assert(!(await sheetState()).hidden,'Enter brings it back');
    await page.keyboard.press('Enter');await page.waitForTimeout(150);assert((await sheetState()).hidden,'Enter hides it');
    await page.evaluate(()=>document.activeElement.blur());
    // Shown again, the map starts like the drive map: every drive fitted, the sheet at the middle height.
    await switcher.getByRole('button',{name:'목록'}).tap();await page.locator('#list').waitFor();await switcher.getByRole('button',{name:'지도'}).tap();
    await page.waitForFunction(()=>document.querySelectorAll('#logMap .leaflet-overlay-pane path.leaflet-interactive').length===2);await page.locator('#logMap').scrollIntoViewIfNeeded();await page.waitForTimeout(150);
    {const g=await sheetState();assert(!g.hidden&&Math.abs(g.share-.54)<.02,JSON.stringify(g))}
    await handle.tap();await page.waitForTimeout(150);assert((await sheetState()).hidden)}
   // The checks below use the bottom card: the sheet stays hidden.
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
   // Leaflet's panes and controls (z-index 400–1000) stay inside the map: the floating playback bar is drawn over it.
   assert.equal(await page.evaluate(()=>getComputedStyle(document.querySelector('#routeMapView .rv-map')).isolation),'isolate');
   {const covered=await page.evaluate(()=>{const map=document.querySelector('#routeMapView .rv-map').getBoundingClientRect(),bar=document.querySelector('.playback').getBoundingClientRect();
     const top=Math.max(map.top,bar.top),bottom=Math.min(map.bottom,bar.bottom);if(bottom<=top)return null;const e=document.elementFromPoint(bar.left+bar.width/2,(top+bottom)/2);return !!e?.closest('.playback')});
    assert(covered!==false,'the playback bar stays above the map')}
   assert(await page.locator('#road').isHidden());assert.equal(await page.locator('#mapFollow').getAttribute('aria-pressed'),'true');
   // 따라가기 stacks inside the map view (its own stacking context): it never rises over the sticky video above it.
   assert.equal(await page.locator('#routeMapView').evaluate(v=>getComputedStyle(v).isolation),'isolate');
   const carAt=()=>page.locator('#routeMapView .map-car').evaluate(e=>e.style.transform||e.getAttribute('style'));
   const seek=value=>page.locator('#seek').evaluate((e,value)=>{e.value=String(value);e.dispatchEvent(new Event('input'))},value);
   const start=await carAt();await seek(40);await page.waitForFunction(start=>document.querySelector('#routeMapView .map-car').style.transform!==start,start);
   {const box=await page.locator('#routeMapView').boundingBox();await page.touchscreen.tap(box.x+box.width/2,box.y+box.height-30);
    await page.mouse.move(box.x+box.width/2,box.y+box.height/2);await page.mouse.down();await page.mouse.move(box.x+box.width/2+60,box.y+box.height/2+40,{steps:5});await page.mouse.up();
    await page.waitForFunction(()=>document.getElementById('mapFollow').getAttribute('aria-pressed')==='false');
    await page.locator('#mapFollow').tap();assert.equal(await page.locator('#mapFollow').getAttribute('aria-pressed'),'true')}
   // A pinch narrows the 지도 tab's margin (basemap and lines) to 0.1 for the gesture (MapLibre redraws the whole canvas
   // each frame); a second after it, the full margin again, the car, lines and basemap together. A one-finger drag
   // moves what is drawn with the pane: a few redraws at most, the map left where the drag left it, nothing cut off.
   {await page.waitForFunction(()=>window.rvTestMaps.some(m=>document.querySelector('#routeMapView').contains(m.getContainer())&&m.rvGl?.loaded?.()),null,{timeout:15000});
    await page.evaluate(()=>{
     const m=document.querySelector('#routeMapView .rv-map'),map=window.rvTestMaps.find(x=>m.contains(x.getContainer())||x.getContainer()===m),gl=map.rvGl;
     const t=window.rvTestBig={map,renders:0,redraws:0};gl.on('render',()=>t.renders++);{const redraw=gl.redraw.bind(gl);gl.redraw=()=>{t.redraws++;return redraw()}}map.on('dragstart',()=>{t.atDrag={renders:t.renders,redraws:t.redraws}});
     const inside=(a,b)=>a.left<=b.left+1&&a.top<=b.top+1&&a.right>=b.right-1&&a.bottom>=b.bottom-1;
     t.state=()=>{
      let car=null;map.eachLayer(l=>{if(l.options?.icon?.options?.className==='map-car')car=l.getLatLng()});
      const box=m.getBoundingClientRect(),c=gl.getCanvas().getBoundingClientRect(),q=gl.project([car.lng,car.lat]),b=m.querySelector('.map-car-body').getBoundingClientRect(),at=[b.left+b.width/2,b.top+b.height/2];
      const line=Math.min(...[...m.querySelectorAll('.leaflet-overlay-pane path.map-current')].flatMap(p=>{if(!p.getTotalLength())return [Infinity];const M=p.getScreenCTM();return (p.style.strokeDasharray?[p.getPointAtLength(parseFloat(p.style.strokeDasharray))]:[p.getPointAtLength(0),p.getPointAtLength(p.getTotalLength())]).map(r=>Math.hypot(r.x*M.a+r.y*M.c+M.e-at[0],r.x*M.b+r.y*M.d+M.f-at[1]))}));
      return {base:Math.hypot(c.left+q.x-at[0],c.top+q.y-at[1]),line,layer:map.rvGlLayer.options.padding,lines:map.options.renderer.options.padding,margin:map.rvMargin,
       basemapCovers:inside(c,box),linesCover:inside(m.querySelector('.leaflet-overlay-pane svg').getBoundingClientRect(),box),renders:t.renders,redraws:t.redraws};
     };
    });
    const cdp=await context.newCDPSession(page),state=()=>page.evaluate(()=>window.rvTestBig.state());
    const touch=(type,points)=>cdp.send('Input.dispatchTouchEvent',{type,touchPoints:points});
    await seek(20);await page.waitForTimeout(400);const full=await state();
    assert(full.layer===full.margin&&full.lines===full.margin&&full.margin>.1,'full margin before '+JSON.stringify(full));
    const b=await page.locator('#routeMapView .rv-map').boundingBox(),cx=b.x+b.width/2,cy=b.y+Math.min(b.height,844-b.y-120)/2;
    const pair=d=>[{x:cx-d,y:cy,id:1},{x:cx+d,y:cy,id:2}];
    await touch('touchStart',pair(40));const pinching=await state();
    for(let k=1;k<=10;k++){await touch('touchMove',pair(40+3*k));await page.waitForTimeout(16)}
    const during=await state();await touch('touchEnd',[]);await page.waitForTimeout(300);const ended=await state();
    assert(pinching.layer===.1&&pinching.lines===.1&&during.layer===.1&&during.lines===.1&&ended.layer===.1,'narrow while pinching '+JSON.stringify([pinching,during,ended]));
    assert(during.basemapCovers,'the basemap covers the map while pinching '+JSON.stringify(during));
    await page.waitForTimeout(1300);const after=await state();
    assert(after.layer===full.margin&&after.lines===full.margin&&after.margin===full.margin,'full margin after the pinch '+JSON.stringify(after));
    assert(after.base<=1&&after.line<=1&&after.basemapCovers&&after.linesCover,'together after the pinch '+JSON.stringify(after));
    // A pinch ending exactly on a zoom step (twice the spread: +1) with reduced motion (no zoom animation): Leaflet fires
    // no zoomend for it; the basemap still follows (not frozen out of place) and the full margin comes back.
    {const z0=await page.evaluate(()=>window.rvTestBig.map.getZoom());
     await touch('touchStart',pair(40));for(let k=1;k<=8;k++){await touch('touchMove',pair(40+5*k));await page.waitForTimeout(16)}
     await touch('touchEnd',[]);await page.waitForTimeout(1600);const step=await state();
     const z=await page.evaluate(()=>({zoom:window.rvTestBig.map.getZoom(),stuck:!!window.rvTestBig.map.rvGlLayer._zooming}));
     assert(z.zoom===z0+1&&!z.stuck,'the pinch ended on a whole step and closed its zoom '+JSON.stringify({z0,...z}));
     assert(step.base<=1&&step.basemapCovers&&step.layer===full.margin,'together after a pinch ending on a step '+JSON.stringify(step))}
    // One finger, ~300 px over ~1 s, held still before lifting (no inertia).
    await seek(30);await page.waitForTimeout(400);
    // A fixed place on the basemap, on screen (the car could still move a little after the seek).
    await page.evaluate(()=>{const t=window.rvTestBig;t.c0=t.map.getCenter()});
    const onScreen=()=>page.evaluate(()=>{const t=window.rvTestBig,gl=t.map.rvGl,c=gl.getCanvas().getBoundingClientRect(),q=gl.project([t.c0.lng,t.c0.lat]);return {x:c.left+q.x,y:c.top+q.y}}),from=await onScreen();
    let mid=null;
    await touch('touchStart',[{x:cx+150,y:cy,id:1}]);
    for(let k=1;k<=60;k++){await touch('touchMove',[{x:cx+150-5*k,y:cy+k/3,id:1}]);await page.waitForTimeout(16);if(k===40)mid=await state()}
    const held=await state();await page.waitForTimeout(150);await touch('touchEnd',[]);await page.waitForTimeout(400);
    const dragged=await state(),moved=await onScreen();
    assert.equal(await page.locator('#mapFollow').getAttribute('aria-pressed'),'false','a drag turns 따라가기 off');
    // From the drag's start: redrawn once past RECENTRE of the margin and once at rest; the other renders are
    // MapLibre's own (tiles of the newly drawn area). Each frame before (~60).
    const s0=await page.evaluate(()=>window.rvTestBig.atDrag);
    assert(dragged.redraws-s0.redraws<=2&&dragged.renders-s0.renders<=6,'a drag redraws the basemap a few times at most: '+JSON.stringify([dragged.redraws-s0.redraws,dragged.renders-s0.renders]));
    assert(Math.abs(moved.x-from.x+300)<=2&&Math.abs(moved.y-from.y-20)<=2,'the map stays where the drag left it '+JSON.stringify([from,moved]));
    assert(dragged.layer===full.margin&&mid.layer===full.margin,'full margin while dragging '+JSON.stringify([mid,dragged]));
    assert([mid,held,dragged].every(s=>s.basemapCovers&&s.linesCover),'nothing cut off while dragging '+JSON.stringify([mid,held,dragged]));
    assert(dragged.base<=1&&dragged.line<=1,'together after the drag '+JSON.stringify(dragged));
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
   const simpleAsked=tone=>REAL?Promise.resolve():page.waitForRequest(r=>r.url()===(tone==='light'?SIMPLE_LIGHT:STYLE_OF.dark),{timeout:5000});
   {assert.equal(await tilesOf('#videoMap .rv-map'),scheme);
    const pick=async label=>{await page.locator('#overlayHeightSettings').tap();await dialog.waitFor();await dialog.locator('#videoMiniMapTone button',{hasText:label}).tap();if(label!=='자동'){await dialog.locator('#videoMiniMapTone').scrollIntoViewIfNeeded();await shot('minimap-tone')}await page.locator('#overlayHeightClose').tap();await dialog.waitFor({state:'hidden'})};
    {const asked=styleAsked(other);await pick(other==='light'?'라이트':'다크');await asked}assert.equal(await tilesOf('#videoMap .rv-map'),other);
    assert.equal(await page.evaluate(()=>localStorage.getItem('roadviewer-minimap-tone')),other);
    assert.equal(await page.locator('#videoMiniMapTone button[aria-pressed=true]').textContent(),other==='light'?'라이트':'다크');
    {const asked=styleAsked(scheme);await pick('자동');await asked}assert.equal(await tilesOf('#videoMap .rv-map'),scheme);await settleLayout(page)}
   // 작은 지도 글자 숨기기: off by default; on, the small map alone hides the style's symbol layers (names, icons, arrows)
   // with no other style asked, and keeps them hidden through a tone change; kept with the display preferences.
   // 작은 지도 회색으로 (checked further down) takes the grey style.
   {const keyOf=()=>page.locator('#videoMap .rv-map').evaluate(e=>e.dataset.tileKey),labels=want=>page.waitForFunction(want=>document.querySelector('#videoMap .rv-map').dataset.labels===want,want,{timeout:5000});
    assert.equal(await keyOf(),scheme);assert.equal(await labelsOf('#videoMap .rv-map'),'shown');
    await page.locator('#overlayHeightSettings').tap();await dialog.waitFor();const box=dialog.getByLabel('작은 지도 글자 숨기기');assert.equal(await box.isChecked(),false);
    const styles=tiles.filter(url=>url.startsWith(OFM+'styles/')).length;
    await box.check();await labels('hidden');
    assert.equal(tiles.filter(url=>url.startsWith(OFM+'styles/')).length,styles,'no other style for the labels');
    assert.equal(await page.locator('#videoMap .rv-map').evaluate(e=>e.dataset.simple),'false','the colours stay');
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
    await box.uncheck();await labels('shown');
    // 작은 지도 회색으로: the grey style without the busy layers, names kept; the panel map keeps its colours.
    {const grey=dialog.getByLabel('작은 지도 회색으로');assert.equal(await grey.isChecked(),false);
     {const asked=simpleAsked(scheme);await grey.check();await asked}
     await page.waitForFunction(()=>document.querySelector('#videoMap .rv-map').dataset.simple==='true',null,{timeout:5000});
     if(!REAL)await page.waitForFunction(()=>(document.querySelector('#videoMap .rv-map').dataset.removed||'').includes('poi_r1'),null,{timeout:5000});
     await labels('shown');assert.equal(await page.locator('#routeMapView .rv-map').evaluate(e=>e.dataset.simple),'false');
     assert.equal(await page.evaluate(()=>JSON.parse(localStorage.getItem('roadviewer-display-preferences')).checks.videoMiniMapGrey),true);
     {const asked=styleAsked(scheme);await grey.uncheck();await asked}}await labels('shown');await page.locator('#overlayHeightClose').tap();await dialog.waitFor({state:'hidden'});
    assert.equal(await keyOf(),scheme)}
   // Where it sits: the stage's top-right corner, a third of its width (104–180px, 4:3), under the speed and wheel
   // (drawn on top; never narrower than they are); clear of the title, the bottom row, the fullscreen button and the transport; the segment's
   // car always in the middle of the part below the speed (it follows the car like 따라가기).
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
     trackInside:(()=>{const car=el.querySelector('.map-car')?.getBoundingClientRect();if(!car||!car.width)return false;
      return Math.abs((car.left+car.right)/2-(map.left+map.right)/2)<=3&&Math.abs((car.top+car.bottom)/2-(map.top+map.height*.6))<=3})(),
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
   // The car (smaller here than on the big map) sits on the line's end: its body centred on the marker's anchor.
   {const d=await mini.evaluate(m=>{const b=m.querySelector('.map-car-body').getBoundingClientRect(),c=[b.left+b.width/2,b.top+b.height/2];
     return Math.min(...[...m.querySelectorAll('.leaflet-overlay-pane path.map-current')].flatMap(p=>{const M=p.getScreenCTM();return (p.style.strokeDasharray?[p.getPointAtLength(parseFloat(p.style.strokeDasharray))]:[p.getPointAtLength(0),p.getPointAtLength(p.getTotalLength())]).map(q=>Math.hypot(q.x*M.a+q.y*M.c+M.e-c[0],q.x*M.b+q.y*M.d+M.f-c[1]))}))});
    assert(d<=1,'car on the line: '+d)}
   // Smooth following. The car's place on the map (car centre minus the map pane's on-screen origin, both including
   // the sub-pixel translates) moves on every frame of playback by a fraction of a pixel, never a whole-pixel jump; the
   // heading turns between samples the short way round, with no CSS transition; a held GPS sample is passed over.
   {const frame=()=>page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));
    const carOnMap=()=>mini.evaluate(m=>{const a=m.querySelector('.leaflet-map-pane').getBoundingClientRect(),b=m.querySelector('.map-car-body').getBoundingClientRect();return [b.left+b.width/2-a.left,b.top+b.height/2-a.top]});
    const turn=()=>mini.locator('.map-car-body').evaluate(b=>Number(/rotate\(([-\d.]+)deg\)/.exec(b.style.transform)?.[1]));
    await page.evaluate(()=>{const b=document.getElementById('play');if(b.dataset.playing==='true')b.click()});assert.equal(await mini.locator('.map-car-body').evaluate(b=>getComputedStyle(b).transitionDuration),'0s','no heading transition');
    await seek(3.5);await frame();assert(Math.abs(await turn()-.5)<.01,'359° → 2°: 0.5° half way '+await turn());
    await seek(3.25);await frame();assert(Math.abs(await turn()-359.75)<.01,'a quarter of the way '+await turn());
    await seek(30);await frame();const at30=await carOnMap();await seek(31);await frame();const at31=await carOnMap();await seek(32);await frame();const at32=await carOnMap();
    const mid=[(at30[0]+at32[0])/2,(at30[1]+at32[1])/2];
    assert(Math.hypot(at31[0]-mid[0],at31[1]-mid[1])<.6&&Math.hypot(at32[0]-at30[0],at32[1]-at30[1])>4,'the held sample at 31 s is passed over '+JSON.stringify([at30,at31,at32]));
    // One second of playback from 0.5 s: per frame, the car's place and the DOM writes to the time readout, the no-video
    // note and the bookmark time (written only when they change: the label at most once a second, the note when playing
    // starts or stops).
    await seek(.5);await frame();
    const run=await page.evaluate(()=>new Promise(resolve=>{
     const m=document.getElementById('videoMap'),pane=m.querySelector('.leaflet-map-pane'),body=m.querySelector('.map-car-body'),time=document.getElementById('time');
     const writes={label:0,total:0,note:0,bookmark:0},watch=(target,key,options)=>new MutationObserver(records=>{writes[key]+=records.length}).observe(target,options);
     watch(time,'label',{attributes:true});watch(time.querySelector('.time-total'),'total',{childList:true,characterData:true,subtree:true});
     watch(document.getElementById('noVideo'),'note',{childList:true,characterData:true,subtree:true,attributes:true});watch(document.querySelector('.bookmark-time'),'bookmark',{childList:true,characterData:true,subtree:true});
     // The current segment's lines are drawn once: only the travelled line's dash moves with the car.
     const paths=[...m.querySelectorAll('.leaflet-overlay-pane path.map-current')],d0=paths.map(p=>p.getAttribute('d')),dashes=new Set();
     const out=[],play=document.getElementById('play');play.click();const started=performance.now();
     const step=()=>{const a=pane.getBoundingClientRect(),b=body.getBoundingClientRect();out.push([b.left+b.width/2-a.left,b.top+b.height/2-a.top]);dashes.add(m.querySelector('path.map-travelled').style.strokeDasharray);
      if(performance.now()-started<1000)requestAnimationFrame(step);else{play.click();setTimeout(()=>resolve({out,writes,redrawn:paths.filter((p,i)=>!p.isConnected||p.getAttribute('d')!==d0[i]).length,paths:paths.length,dashes:dashes.size}))}};
     requestAnimationFrame(step);
    }));
    const steps=run.out.slice(1).map((p,i)=>Math.hypot(p[0]-run.out[i][0],p[1]-run.out[i][1])),moved=steps.filter(d=>d>.001).length,biggest=Math.max(...steps);
    const fractional=run.out.filter(p=>p.some(v=>Math.abs(v-Math.round(v))>.05)).length;
    assert(biggest<1&&moved>=steps.length*.6&&fractional>=run.out.length/3,'smooth: '+JSON.stringify({frames:run.out.length,moved,biggest,fractional}));
    assert(run.paths===2&&run.redrawn===0&&run.dashes>=run.out.length/3,'the segment drawn once, its dash following: '+JSON.stringify({paths:run.paths,redrawn:run.redrawn,dashes:run.dashes,frames:run.out.length}));
    assert(run.writes.label<=4&&run.writes.total===0&&run.writes.note<=2&&run.writes.bookmark<=2,'per-frame DOM writes: '+JSON.stringify(run.writes))}
   // Following scrolls what is drawn: over 2 s of playback the small map's basemap (MapLibre) draws at most twice (it is
   // panned and redrawn only when the car nears the edge of its drawn margin), and on every frame the basemap, the lines
   // and the car stay together: the car's centre is where MapLibre places its position, and the current lines end there
   // (within a pixel: the travelled line is dashed up to the car). Stepping on (paused) until
   // the basemap is re-centred: together (within a pixel) just before and just after, the car
   // still in its place on the map.
   // The replay maps draw up to their margin (1: a full size) beyond each edge, as much as keeps the basemap canvas within 4000 device
   // pixels on its longer side; the basemap and the route lines use the same margin.
   {const margins=await page.evaluate(()=>window.rvTestMaps.filter(m=>m.rvFitMargin&&m.getSize().x>0).map(m=>{const s=m.getSize(),r=Math.min(devicePixelRatio||1,2),side=Math.max(s.x,s.y)*r;
     return {margin:m.rvMargin,layer:m.rvGlLayer?.options.padding,lines:m.options.renderer.options.padding,canvas:Math.round((1+2*m.rvMargin)*side),max:m.rvMarginMax,full:(1+2*m.rvMarginMax)*side<=4000}}));
    assert(margins.length>=1&&margins.every(m=>m.layer===m.margin&&m.lines===m.margin&&m.canvas<=4001&&m.margin>=.1&&(!m.full||m.margin===m.max)),'replay map margins: '+JSON.stringify(margins))}
   {const frame=()=>page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));
    await page.evaluate(()=>{
     const m=document.getElementById('videoMap'),map=window.rvTestMaps.find(x=>m.contains(x.getContainer())),gl=map.rvGl;
     window.rvTestSmall={renders:0};gl.on('render',()=>window.rvTestSmall.renders++);
     window.rvTestAlign=()=>{
      let car=null;map.eachLayer(l=>{if(l.options?.icon?.options?.className==='map-car')car=l.getLatLng()});
      const c=gl.getCanvas().getBoundingClientRect(),q=gl.project([car.lng,car.lat]),b=m.querySelector('.map-car-body').getBoundingClientRect(),at=[b.left+b.width/2,b.top+b.height/2],box=m.getBoundingClientRect();
      const line=Math.min(...[...m.querySelectorAll('.leaflet-overlay-pane path.map-current')].flatMap(p=>{const M=p.getScreenCTM();return (p.style.strokeDasharray?[p.getPointAtLength(parseFloat(p.style.strokeDasharray))]:[p.getPointAtLength(0),p.getPointAtLength(p.getTotalLength())]).map(r=>Math.hypot(r.x*M.a+r.y*M.c+M.e-at[0],r.x*M.b+r.y*M.d+M.f-at[1]))}));
      return {base:Math.hypot(c.left+q.x-at[0],c.top+q.y-at[1]),line,place:Math.hypot(at[0]-(box.left+box.width/2),at[1]-(box.top+box.height*.6)),drawn:m.querySelector('.leaflet-gl-layer').style.transform};
     };
    });
    await seek(5);await frame();await page.waitForTimeout(400);
    const run=await page.evaluate(()=>new Promise(resolve=>{
     const out=[],play=document.getElementById('play'),from=window.rvTestSmall.renders;play.click();const started=performance.now();
     const step=()=>{out.push(window.rvTestAlign());if(performance.now()-started<2000)requestAnimationFrame(step);else{play.click();resolve({frames:out.length,renders:window.rvTestSmall.renders-from,base:Math.max(...out.map(a=>a.base)),line:Math.max(...out.map(a=>a.line)),place:Math.max(...out.map(a=>a.place))})}};
     requestAnimationFrame(step);
    }));
    assert(run.frames>30&&run.renders<=2&&run.base<=1&&run.line<=1&&run.place<=1,'scrolled, together: '+JSON.stringify(run));
    let last=await page.evaluate(()=>window.rvTestAlign()),recentred=null;
    for(let s=6;s<=29&&!recentred;s++){await seek(s);await frame();const now=await page.evaluate(()=>window.rvTestAlign());if(now.drawn!==last.drawn)recentred=[last,now];else last=now}
    assert(recentred&&recentred.every(a=>a.base<=1&&a.line<=1&&a.place<=1),'re-centred, together: '+JSON.stringify(recentred))}
   // ⑤ The bottom-left corner resizes it, here by touch (real touch events through CDP): wider, anchored at its top-right,
   // 4:3, not enlarged by the drag, kept in this browser; a double tap on the corner goes back to the default size.
   {const grip=mini.locator('.video-map-grip'),b0=await mini.boundingBox(),g=await grip.boundingBox(),cdp=await context.newCDPSession(page);
    const x=g.x+g.width/2,y=g.y+g.height/2,touch=(type,px,py)=>cdp.send('Input.dispatchTouchEvent',{type,touchPoints:type==='touchEnd'?[]:[{x:px,y:py}]});
    await touch('touchStart',x,y);for(let k=1;k<=8;k++)await touch('touchMove',x-6*k,y+4.5*k);await touch('touchEnd');await page.waitForTimeout(200);
    const b1=await mini.boundingBox(),kept=Number(await page.evaluate(()=>localStorage.getItem('roadviewer-minimap-size')));
    assert(b1.width>b0.width+30,'touch: wider '+JSON.stringify([b0,b1]));
    assert(Math.abs(b1.x+b1.width-(b0.x+b0.width))<=1.5&&Math.abs(b1.y-b0.y)<=1.5,'touch: anchored at its top-right '+JSON.stringify([b0,b1]));
    assert(Math.abs(b1.height-b1.width*.75)<=1.5,'touch: 4:3 '+JSON.stringify(b1));
    assert(!await mini.evaluate(e=>e.classList.contains('is-large')),'the drag does not enlarge');assert(kept>0&&kept<1,'kept '+kept);
    await shot('minimap-resized');
    await grip.dblclick();await page.waitForTimeout(200);const b2=await mini.boundingBox();
    assert(Math.abs(b2.width-b0.width)<=1,'double tap: default size '+JSON.stringify([b0,b2]));assert.equal(await page.evaluate(()=>localStorage.getItem('roadviewer-minimap-size')),null)}
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
   // Pressed, it is not brightened like the controls (that washed a light map out to white); released, it enlarges.
   {const b=await mini.boundingBox();await page.mouse.move(b.x+b.width/2,b.y+b.height*.7);await page.mouse.down();const f=await mini.evaluate(m=>[m.matches(':active'),getComputedStyle(m).filter]);await page.mouse.up();assert.deepEqual(f,[true,'none'],'no press brightening')}
   await page.waitForFunction(()=>document.getElementById('videoMap').classList.contains('is-large'));await settleLayout(page);await page.waitForTimeout(150);
   await large('portrait large');
   await shot('replay-large');
   await mini.tap();await page.waitForFunction(()=>!document.getElementById('videoMap').classList.contains('is-large'));await page.waitForTimeout(100);
   // The small map folds its credit into an ⓘ: a tap shows it (without enlarging the map), another hides it.
   {const credit=mini.locator('.leaflet-control-attribution'),toggle=mini.locator('.rv-credit-toggle');
    assert(await credit.isHidden()&&await toggle.isVisible(),'the small map folds its credit');
    await toggle.tap();await credit.waitFor();assert.equal(await credit.innerText(),'OpenFreeMap © OpenMapTiles © OSM');assert.equal(await toggle.getAttribute('aria-expanded'),'true');
    await page.waitForTimeout(150);assert(!await page.evaluate(()=>document.getElementById('videoMap').classList.contains('is-large')),'ⓘ does not enlarge the map');
    await toggle.tap();await credit.waitFor({state:'hidden'})}
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
   // With motion on, the map is not redrawn while it changes size: its container keeps the larger of the two sizes,
   // centred in the moving frame (so the frame is always covered), and follows the frame again once the motion has ended
   // (a redraw per frame made the animation stutter).
   {await page.emulateMedia({reducedMotion:'no-preference'});
    const state=()=>page.evaluate(()=>{const m=document.getElementById('videoMap'),box=m.querySelector('.video-map-canvas'),a=m.getBoundingClientRect(),b=box.getBoundingClientRect();
     return {held:!!box.style.width,box:[Math.round(b.width),Math.round(b.height)],frame:[Math.round(a.width),Math.round(a.height)],centred:Math.abs((a.left+a.right)-(b.left+b.right))<2&&Math.abs((a.top+a.bottom)-(b.top+b.bottom))<2,large:m.classList.contains('is-large')}});
    for(const large of [true,false]){
     const before=await state();assert(!before.held&&before.large!==large&&before.box.join()===before.frame.join(),'at rest the map fills its frame '+JSON.stringify(before));
     await page.evaluate(()=>document.getElementById('videoMap').click());await page.waitForTimeout(120);
     const during=await state();assert(during.held&&during.centred&&during.frame.join()!==before.frame.join()&&during.box[0]>=during.frame[0]&&during.box[1]>=during.frame[1]&&(large||during.box.join()===before.box.join()),'held, centred and covering the moving frame '+JSON.stringify({before,during}));
     await page.waitForTimeout(600);
     const after=await state();assert(!after.held&&after.large===large&&after.box.join()===after.frame.join()&&after.frame.join()!==before.frame.join()&&(!large||Math.abs(during.box[0]-after.frame[0])<2&&Math.abs(during.box[1]-after.frame[1])<2),'released at the new size (growing: the size it was held at) '+JSON.stringify({during,after}))}
    await page.emulateMedia({reducedMotion:'reduce'});await settleLayout(page)}
   // A phone held upright turns the fullscreen picture a quarter (CSS): the small map is still there, measured in the
   // picture's own frame (it was hidden: its room, taken from sideways screen rectangles, came out negative).
   await page.evaluate(()=>{try{Object.defineProperty(screen.orientation,'lock',{configurable:true,value:()=>Promise.reject(new DOMException('refused','NotSupportedError'))})}catch{}document.getElementById("fullscreenButton").click()});
   if(await page.waitForFunction(()=>document.querySelector('.camera-panel').classList.contains('is-turned'),null,{timeout:3000}).then(()=>true,()=>false)){
    await page.waitForTimeout(400);
    const t=await page.evaluate(()=>{const m=document.getElementById('videoMap'),b=m.getBoundingClientRect(),s=document.getElementById('videoStage').getBoundingClientRect(),h=document.querySelector('#videoStage .video-hud').getBoundingClientRect();
     return {noRoom:m.classList.contains('no-room'),room:parseFloat(m.style.getPropertyValue('--vmap-room')),map:[b.left,b.top,b.width,b.height].map(Math.round),stage:[s.left,s.top,s.width,s.height].map(Math.round),hud:[h.width,h.height].map(Math.round)}});
    assert(!t.noRoom&&t.room>100,'the small map has room in the turned fullscreen picture '+JSON.stringify(t));
    assert(t.map[3]>t.map[2]&&t.map[3]>=t.hud[1]-1&&t.map[0]>=t.stage[0]&&t.map[1]>=t.stage[1]&&t.map[0]+t.map[2]<=t.stage[0]+t.stage[2]+1&&t.map[1]+t.map[3]<=t.stage[1]+t.stage[3]+1,'turned with the picture and inside it '+JSON.stringify(t));
    await shot('mini-turned');
    await page.evaluate(()=>document.exitFullscreen());await page.waitForFunction(()=>!document.fullscreenElement);await settleLayout(page);
   }else{console.log('maps: turned fullscreen unavailable here, skipped');await page.evaluate(()=>document.fullscreenElement&&document.exitFullscreen());await page.waitForFunction(()=>!document.fullscreenElement)}
   await page.evaluate(()=>{delete screen.orientation.lock});
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
   // The same corner with a mouse on a desktop (no touch): shown on hover, larger then smaller within its limits, the
   // size back after a reload.
   if(scheme==='dark'){const desk=await browser.newContext({viewport:{width:1280,height:800},colorScheme:scheme,reducedMotion:'reduce'}),dp=await desk.newPage(),derrors=[];
    dp.on('pageerror',error=>derrors.push(error.message));await desk.route(`**/api/logs/${withVideo}/video**`,route=>route.fulfill({body:video,contentType:'video/mp4'}));
    await dp.goto(base+`view/${withVideo}/`);await dp.waitForFunction(()=>!document.getElementById('play').disabled);
    await dp.locator('#overlayHeightSettings').click();await dp.locator('#overlayHeightDialog').waitFor();await dp.getByLabel('영상 위 작은 지도').check();await dp.locator('#overlayHeightClose').click();
    const dm=dp.locator('#videoMap');await dm.locator('.map-car').waitFor();await settleLayout(dp);await dp.waitForTimeout(150);
    const b0=await dm.boundingBox();await dm.hover();await dp.waitForTimeout(300);const g=await dm.locator('.video-map-grip').boundingBox();
    assert(Number(await dm.locator('.video-map-grip').evaluate(e=>getComputedStyle(e,'::before').opacity))>.5,'the corner shows on hover');
    await dp.mouse.move(g.x+g.width/2,g.y+g.height/2);await dp.mouse.down();await dp.mouse.move(g.x-80,g.y+60,{steps:8});await dp.mouse.up();await dp.waitForTimeout(150);
    const b1=await dm.boundingBox();assert(b1.width>b0.width+60,'mouse: wider '+JSON.stringify([b0,b1]));
    assert(Math.abs(b1.x+b1.width-(b0.x+b0.width))<=1.5&&Math.abs(b1.y-b0.y)<=1.5&&Math.abs(b1.height-b1.width*.75)<=1.5,'mouse: anchored, 4:3 '+JSON.stringify(b1));
    assert(!await dm.evaluate(e=>e.classList.contains('is-large')),'the drag does not enlarge');
    if(shots){await dp.waitForTimeout(REAL?3000:150);await dp.screenshot({path:path.join(shots,'minimap-resized-desktop-dark.png')})}
    {const g1=await dm.locator('.video-map-grip').boundingBox();await dp.mouse.move(g1.x+g1.width/2,g1.y+g1.height/2);await dp.mouse.down();await dp.mouse.move(g1.x+600,g1.y-400,{steps:8});await dp.mouse.up();await dp.waitForTimeout(150)}
    const b2=await dm.boundingBox();assert(b2.width>=103.5&&b2.width<b1.width,'mouse: smaller, not below the least size '+JSON.stringify(b2));
    await dp.reload();await dp.waitForFunction(()=>!document.getElementById('play').disabled);await dm.locator('.map-car').waitFor();await settleLayout(dp);await dp.waitForTimeout(150);
    {const b3=await dm.boundingBox(),info=await dp.evaluate(()=>({f:localStorage.getItem('roadviewer-minimap-size'),v:document.getElementById('videoStage').style.getPropertyValue('--vmap-f'),min:document.getElementById('videoStage').style.getPropertyValue('--vmap-min-w'),sized:document.getElementById('videoStage').classList.contains('vmap-sized'),w:document.getElementById('videoStage').getBoundingClientRect().width}));assert(Math.abs(b3.width-Math.max(b2.width,parseFloat(info.min)))<=1.5&&info.sized,'kept after a reload (never narrower than the speed) '+JSON.stringify([b1,b2,b3,info]))}
    assert.deepEqual(derrors,[]);await desk.close()}
  }
  // Many drives (60 of one segment and one of 40) on wide screens: the all-drives map lists them in a glass card on
  // the right (its own scroll, a row per drive in its line's colour; hover highlights, a tap selects with the actions
  // inline and fits beside the card), and the card folds away to its button (then a selection shows the bottom card).
  // The drive map's segment card scrolls on its own and folds the same way. Both fold states are kept.
  const many=Array.from({length:60},(_,k)=>({id:(0xe0000000+k).toString(16).padEnd(32,'0'),name:`${(0x500+k).toString(16).padStart(8,'0')}--5a5a5a5a5a / 구간 0`,uploaded:100+k,points:track(ORIGIN[0]-.02+(k%10)*.005,ORIGIN[1]-.03+Math.floor(k/10)*.008,5e-5,4e-5)}));
  const long=[];{let [lat,lon]=[ORIGIN[0]+.01,ORIGIN[1]-.04];for(let k=0;k<40;k++){const d=turns[k%turns.length];long.push({id:(0xf0000000+k).toString(16).padEnd(32,'0'),name:`00000600--6b6b6b6b6b / 구간 ${k}`,uploaded:200+k,points:track(lat,lon,d[0]/3,d[1]/3)});lat=+(lat+20*d[0]).toFixed(6);lon=+(lon+20*d[1]).toFixed(6)}}
  [...many,...long].forEach(writeLog);
  const drives=2+many.length+1;
  for(const scheme of SCHEMES){
   const context=await browser.newContext({viewport:{width:1280,height:800},colorScheme:scheme,reducedMotion:'reduce'}),page=await context.newPage(),errors=[];
   page.on('pageerror',error=>errors.push(error.message));await context.addInitScript(hookMaps);
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
   const card=()=>page.evaluate(()=>{const r=s=>document.querySelector(s).getBoundingClientRect(),map=r('#logMap'),list=r('#logMapList'),button=r('#logMap>.map-fold'),rows=document.getElementById('logMapRows'),zoom=r('#logMap .leaflet-control-zoom'),credit=r('#logMap .rv-credit-toggle');
    return {right:Math.round(map.right-list.right),below:Math.abs(list.top-button.top)<=1,bottom:list.bottom<=map.bottom-15,w:Math.round(list.width),scrolls:rows.scrollHeight>rows.clientHeight+40,button:[map.right-button.right,button.top-map.top].map(Math.round),size:Math.round(button.width),
     clear:zoom.right<list.left&&map.right-credit.right>=0&&map.right-credit.right<=8&&map.bottom-credit.bottom>=0&&map.bottom-credit.bottom<=8&&list.bottom<=credit.top,glass:getComputedStyle(document.querySelector('#logMapRows>.map-list-row')).backdropFilter!=='none'&&getComputedStyle(document.getElementById('logMapList')).backgroundColor==='rgba(0, 0, 0, 0)',shown:!!list.width}});
   {const g=await card();assert(g.shown&&g.right===16&&g.below&&g.bottom&&g.w>=300&&g.w<=380&&g.scrolls&&g.clear&&g.glass&&g.button[0]===16&&g.button[1]===16&&g.size===40,JSON.stringify(g))}
   assert.equal(await fold.getAttribute('aria-expanded'),'true');assert.equal(await fold.getAttribute('aria-label'),'주행 목록 접기');
   assert.equal(await page.locator('#logMapList .log-map-list-count').innerText(),`${drives}개`);
   // The count label's bottom lines up with the fold button's; the first card starts at least 12px below them.
   {const [head,button,first]=await page.evaluate(()=>['#logMapList .log-map-list-head','#logMap>.map-fold','#logMapRows>.map-list-row'].map(s=>document.querySelector(s).getBoundingClientRect()));
    assert(Math.abs(head.bottom-button.bottom)<=1&&first.top-button.bottom>=12,'label on the fold button bottom line, cards below '+JSON.stringify([head.bottom,button.bottom,first.top]))}
   // Each row in its line's colour; a hovered row's line stands out.
   const strong=()=>page.locator('#logMap .leaflet-overlay-pane path.leaflet-interactive').evaluateAll(lines=>lines.map((l,i)=>Number(l.getAttribute('stroke-width'))===6?l.getAttribute('stroke'):null).filter(Boolean));
   await rows.nth(4).hover();await page.waitForTimeout(50);
   {const lit=await strong(),swatch=await rows.nth(4).locator('.map-list-pick').evaluate(b=>getComputedStyle(b,'::before').backgroundColor);assert.equal(lit.length,1,'the hovered drive');assert.equal(swatch,await page.evaluate(c=>{const e=document.createElement('i');e.style.color=c;document.body.append(e);const v=getComputedStyle(e).color;e.remove();return v},lit[0]),'the row\'s swatch is its line\'s colour')}
   // A tap selects: actions inline, no bottom card, the drive fitted beside the card.
   await rows.nth(4).locator('.map-list-pick').click();await page.waitForTimeout(250);
   assert.equal(await rows.nth(4).locator('.map-list-pick').evaluate(b=>getComputedStyle(b).backgroundColor),'rgba(0, 0, 0, 0)','the selected card lights evenly: no hover tint on its title part alone');
   await page.mouse.move(10,400);await page.waitForTimeout(150);
   assert(await rows.nth(4).evaluate(r=>r.classList.contains('is-selected')));
   assert.deepEqual(await rows.nth(4).locator('.map-card-actions>:is(a,button)').allInnerTexts(),['재생','주행 지도','목록에서 보기']);
   assert(await page.locator('#logMapCard').isHidden(),'no bottom card while the list shows');
   {const g=await page.evaluate(()=>{const list=document.getElementById('logMapList').getBoundingClientRect(),line=[...document.querySelectorAll('#logMap .leaflet-overlay-pane path.leaflet-interactive')].find(p=>Number(p.getAttribute('stroke-width'))===6).getBoundingClientRect();return {left:line.right<=list.left+1,line:[line.left,line.right].map(Math.round),list:Math.round(list.left)}});assert(g.left,JSON.stringify(g))}
   await shot('list-wide');
   // The cards fade out at an edge only with more beyond it: at the top of the column, only at the bottom.
   {const fades=()=>page.evaluate(()=>{const c=document.getElementById('logMapRows'),cards=[...c.children];return {top:c.classList.contains('fade-top'),bottom:c.classList.contains('fade-bottom'),masked:cards.filter(e=>e.style.maskImage).length}});
    await page.evaluate(()=>document.getElementById('logMapRows').scrollTop=0);await page.waitForTimeout(100);
    {const f=await fades();assert(!f.top&&f.bottom&&f.masked>=1,JSON.stringify(f))}
    // The top fade grows with the distance scrolled (none, half after 7px, full after 14px), and a masked card keeps its
    // shadow (the mask reaches past it, unclipped).
    {const widths=[];for(const top of [0,7,40]){widths.push(await page.evaluate(top=>new Promise(done=>{const c=document.getElementById('logMapRows');c.scrollTop=top;requestAnimationFrame(()=>requestAnimationFrame(()=>done(parseFloat(c.style.getPropertyValue('--fade-top'))))) }),top))}
     assert.deepEqual(widths,[0,14,28],'top fade width follows the scroll distance');
     const masked=await page.evaluate(()=>{const card=[...document.getElementById('logMapRows').children].find(e=>e.style.maskImage),st=card&&getComputedStyle(card);return st&&[st.maskClip,st.maskRepeat,st.boxShadow!=='none']});
     assert.deepEqual(masked,['no-clip','no-repeat',true],'the masked card keeps its shadow')}
    await page.evaluate(()=>{const c=document.getElementById('logMapRows');c.scrollTop=c.scrollHeight/2});await page.waitForTimeout(100);
    {const f=await fades();assert(f.top&&f.bottom&&f.masked>=2,JSON.stringify(f))}
    await shot('list-wide-scrolled');
    await page.evaluate(()=>{const c=document.getElementById('logMapRows');c.scrollTop=c.scrollHeight});await page.waitForTimeout(100);
    {const f=await fades();assert(f.top&&!f.bottom,JSON.stringify(f))}
    await rows.nth(4).scrollIntoViewIfNeeded()}
   // 지도 표시: one layers button under the zoom buttons opens a popover (towards the map's middle; Escape or a tap
   // elsewhere closes it) with two switches. 글자 숨기기 hides every name and symbol in the style's own colours (no other
   // style); 회색 지도 switches to the calm style (Positron light / Dark) without 3D buildings and points of interest,
   // names kept. Both keep the view and are kept on this browser (off by default).
   {const button=page.locator('#logMap .rv-map-options-button'),pop=page.locator('#logMap .rv-map-options');
    const box=kind=>pop.locator(`input[data-kind=${kind}]`),open=async()=>{if(await pop.isHidden()){await button.click();await pop.waitFor()}};
    {const z=await page.locator('#logMap .leaflet-control-zoom').boundingBox(),b=await button.boundingBox();assert(Math.abs(b.x-z.x)<2&&b.y>=z.y+z.height-1&&b.y<z.y+z.height+16&&Math.abs(b.width-z.width)<3,JSON.stringify({z,b}))}
    assert(await pop.isHidden());assert.equal(await button.getAttribute('aria-expanded'),'false');
    await open();assert.equal(await button.getAttribute('aria-expanded'),'true');
    {const [b,p,m]=await Promise.all([button.boundingBox(),pop.boundingBox(),page.locator('#logMap .rv-map').boundingBox()]);
     assert(p.x>=m.x-1&&p.x+p.width<=m.x+m.width+1&&p.y>=m.y-1,'inside the map '+JSON.stringify({b,p,m}));assert(p.x>=b.x+b.width||p.x+p.width<=b.x,'beside the button '+JSON.stringify({b,p}))}
    assert.deepEqual(await pop.locator('b').allInnerTexts(),['글자 숨기기','회색 지도']);assert.equal(await box('labels').isChecked(),false);assert.equal(await box('grey').isChecked(),false);
    if(scheme==='light')await shot('list-wide-options');
    await page.keyboard.press('Escape');await pop.waitFor({state:'hidden'});
    const askedStyles=[];page.on('request',r=>{if(r.url().startsWith(OFM+'styles/'))askedStyles.push(r.url())});
    await open();await box('labels').check();
    await page.waitForFunction(()=>document.querySelector('#logMap .rv-map').dataset.labels==='hidden',null,{timeout:5000});
    assert.deepEqual(askedStyles,[],'글자 숨기기 asks no other style');
    assert.equal(await page.evaluate(()=>document.querySelector('#logMap .rv-map').dataset.simple),'false','the colours stay');
    assert.equal(await page.evaluate(()=>localStorage.getItem('roadviewer-map-nolabels')),'1');assert(await button.evaluate(b=>b.classList.contains('is-on')),'the button shows a choice is on');
    if(scheme==='light')await shot('list-wide-nolabels');
    await box('labels').uncheck();await page.waitForFunction(()=>document.querySelector('#logMap .rv-map').dataset.labels==='shown',null,{timeout:5000});
    assert.equal(await page.evaluate(()=>localStorage.getItem('roadviewer-map-nolabels')),'0');
    await page.mouse.click(5,400);await pop.waitFor({state:'hidden'});
    const styleUrls=[];page.on('request',r=>{if(r.url().startsWith(OFM+'styles/'))styleUrls.push(r.url())});
    const view=()=>page.evaluate(()=>document.querySelector('#logMap .leaflet-map-pane').style.transform);
    const before=await view();
    await open();await box('grey').check();
    await page.waitForFunction(()=>document.querySelector('#logMap .rv-map').dataset.simple==='true');
    await page.waitForFunction(()=>(document.querySelector('#logMap .rv-map').dataset.removed||'')!=='',null,{timeout:20000});await page.waitForTimeout(REAL?2500:200);
    assert(styleUrls.includes(scheme==='light'?SIMPLE_LIGHT:STYLE_OF.dark),'grey style '+styleUrls);
    assert.equal(await page.evaluate(()=>document.querySelector('#logMap .rv-map').dataset.labels),'shown','회색 지도 keeps the names');
    {const removed=(await page.evaluate(()=>document.querySelector('#logMap .rv-map').dataset.removed)).split(' ');
     assert(!REAL?removed.includes('building-3d')&&removed.includes('poi_r1')&&!removed.includes('street-name'):removed.every(id=>!/name|label/.test(id)||/poi/.test(id)),removed.join(' '))}
    assert.equal(await view(),before,'the view stays');assert(await rows.nth(4).evaluate(r=>r.classList.contains('is-selected')),'the selection stays');
    assert.equal(await page.evaluate(()=>localStorage.getItem('roadviewer-map-simple')),'1');
    await page.keyboard.press('Escape');await pop.waitFor({state:'hidden'});
    if(scheme==='light')await shot('list-wide-simple');
    await page.reload();await page.locator('#logView').waitFor();await page.waitForFunction(()=>document.querySelector('#logMap .rv-map-options-button'),null,{timeout:20000});
    await open();assert.equal(await box('grey').isChecked(),true,'kept on');
    await box('grey').uncheck();assert.equal(await page.evaluate(()=>localStorage.getItem('roadviewer-map-simple')),'0');
    await page.waitForFunction(()=>document.querySelector('#logMap .rv-map').dataset.simple==='false');await page.keyboard.press('Escape');
    await page.waitForFunction(n=>document.querySelectorAll('#logMap .leaflet-overlay-pane path.leaflet-interactive').length===n,drives,{timeout:20000});
    await rows.nth(4).locator('.map-list-pick').click();await page.mouse.move(10,400);await page.waitForTimeout(150)}
   // A line tapped on the map selects its row and scrolls the list to it.
   {const last=page.locator('#logMap .leaflet-overlay-pane path.leaflet-interactive').last();await last.evaluate(p=>{const L=window.L;p.dispatchEvent(new MouseEvent('click',{bubbles:true,clientX:0,clientY:0}))});
    await page.waitForFunction(()=>{const r=document.querySelector('#logMapRows .map-list-row.is-selected');if(!r)return false;const b=r.getBoundingClientRect(),l=document.getElementById('logMapRows').getBoundingClientRect();return b.top>=l.top-1&&b.bottom<=l.bottom+1})}
   // Folded: only the button (same place, chevron turned), the bottom card for a selection, no right padding.
   const pane=()=>page.evaluate(()=>getComputedStyle(document.querySelector('#logMap .leaflet-map-pane')).transform+'|'+document.querySelector('#logMap .leaflet-proxy')?.style.transform);
   const view=await pane();
   const before=await fold.boundingBox();await fold.click();
   await page.waitForTimeout(400);assert.equal(await pane(),view,'folding keeps the map where it is');
   assert.equal(await fold.getAttribute('aria-expanded'),'false');assert.equal(await fold.getAttribute('aria-label'),'주행 목록 펼치기');
   assert(await page.locator('#logMapList').isHidden());assert.deepEqual(await fold.boundingBox(),before,'the button stays put');
   assert(await page.locator('#logMapCard').isVisible(),'folded: the selection shows the bottom card');
   assert.equal(await page.evaluate(()=>localStorage.getItem('roadviewer-map-list-folded')),'1');
   await shot('list-wide-folded');
   await page.reload();await page.locator('#logView').waitFor();await page.waitForFunction(()=>document.querySelectorAll('#logMap .leaflet-overlay-pane path.leaflet-interactive').length>0,null,{timeout:20000});
   assert.equal(await fold.getAttribute('aria-expanded'),'false','kept folded');assert(await page.locator('#logMapList').isHidden());
   await fold.click();await page.locator('#logMapList').waitFor();
   await page.waitForTimeout(400);assert.equal(await pane(),view,'unfolding keeps the map where it is');
   // The 40-segment drive's map: its segment card scrolls on its own and folds like the list.
   const longRow=rows.filter({hasText:'40개 구간'});await longRow.locator('.map-list-pick').click();await longRow.getByRole('button',{name:'주행 지도'}).click();
   await page.waitForFunction(()=>{const d=document.getElementById('driveMap');return d.open&&d.querySelectorAll('.drive-map-list>.log-row').length===40&&d.querySelectorAll('.leaflet-overlay-pane path.leaflet-interactive').length===40},null,{timeout:20000});
   await settleLayout(page,'#driveMap');
   // Its 지도 표시 popover: Escape closes the popover only, the drive map stays open.
   {const pop=page.locator('#driveMap .rv-map-options');await page.locator('#driveMap .rv-map-options-button').click();await pop.waitFor();
    await page.keyboard.press('Escape');await pop.waitFor({state:'hidden'});await page.waitForTimeout(200);assert(await page.evaluate(()=>document.getElementById('driveMap').open),'the drive map stays open')}
   {const g=await page.evaluate(()=>{const d=document.getElementById('driveMap'),r=s=>d.querySelector(s).getBoundingClientRect(),sheet=r('.drive-map-sheet'),button=r('.drive-map-fold'),list=d.querySelector('.drive-map-list');return {scrolls:list.scrollHeight>list.clientHeight+40,bottom:Math.round(innerHeight-sheet.bottom),below:Math.abs(sheet.top-button.top)<=1,button:[innerWidth-button.right].map(Math.round)}});
    assert(g.scrolls&&g.bottom>=16&&g.below&&g.button[0]===16,JSON.stringify(g))}
   await shot('drive-wide-40');
   {const button=page.locator('#driveMap .drive-map-fold'),at=await button.boundingBox();await button.click();
    assert.equal(await button.getAttribute('aria-expanded'),'false');assert(await page.locator('#driveMap .drive-map-sheet').isHidden());assert.deepEqual(await button.boundingBox(),at);
    // Folded with a segment marked: its glass pill shows at the bottom with 재생; ✕ clears the mark and the pill.
    {const pill=page.locator('#driveMap .drive-map-card');assert(await pill.isHidden(),'no pill without a marked segment');
     await button.click();await page.locator('#driveMap .drive-map-list>.log-row .log-meta').first().click();await button.click();await pill.waitFor();assert.match(await pill.locator('.map-card-title').innerText(),/^구간 \d+/);
     assert(await pill.locator('a.map-card-play').count()===1,'재생 in the pill');await shot('drive-wide-folded-pill');
     assert.equal(await pill.locator('.map-card-actions>*').count(),2,'재생 and ✕ only');
     await pill.locator('.map-card-close').click();
     // It sinks out (no instant cut) before it is hidden.
     if(!await page.evaluate(()=>matchMedia('(prefers-reduced-motion: reduce)').matches))assert.equal(await pill.evaluate(p=>p.classList.contains('is-leaving')&&getComputedStyle(p).animationName),'rv-map-card-out','the pill animates out');
     await pill.waitFor({state:'hidden'});assert.equal(await page.locator('#driveMap .drive-map-list>.log-row.is-map-marked').count(),0)}
    await shot('drive-wide-folded');await button.click();assert(await page.locator('#driveMap .drive-map-sheet').isVisible())}
   assert.deepEqual(errors,[]);
   await context.close();
  }
  // Opening one segment after another does not keep the pages left behind: nodes, listeners and heap stay level (a
  // listener left on the window or on the connection object, or a map never removed, kept every page and its log:
  // 1,500 nodes more with each one). The measured page is never touched by evaluate or a selector wait (the debugger's
  // own handles keep a page alive): the buttons' places come from a second page, and only taps and counters follow.
  if(SCHEMES.includes('dark')){const context=await browser.newContext({viewport:{width:390,height:844},hasTouch:true,isMobile:true,colorScheme:'dark',reducedMotion:'reduce'});
   await context.route(OFM+'**',route=>{const url=route.request().url(),style=url===SIMPLE_LIGHT?['light']:Object.entries(STYLE_OF).find(([,u])=>url===u);
    if(style)return route.fulfill({body:JSON.stringify(fixtureStyle(style[0])),contentType:'application/json'});
    if(url===OFM+'planet')return route.fulfill({body:JSON.stringify({tilejson:'3.0.0',tiles:[OFM+'planet/fixture/{z}/{x}/{y}.pbf'],minzoom:0,maxzoom:14}),contentType:'application/json'});
    return route.fulfill({body:Buffer.alloc(0),contentType:'application/x-protobuf'})});
   await context.route(`**/api/logs/${withVideo}/video**`,route=>route.fulfill({body:video,contentType:'video/mp4'}));
   const start=base+'view/'+logs[3].id+'/',probe=await context.newPage();await probe.goto(start);await probe.waitForSelector('#nextLog');await probe.waitForTimeout(1200);
   const at=await probe.evaluate(()=>Object.fromEntries(['nextLog','previousLog'].map(id=>{const r=document.getElementById(id).getBoundingClientRect();return [id,[r.left+r.width/2,r.top+r.height/2]]})));await probe.close();
   const page=await context.newPage();await page.goto(start);await page.waitForTimeout(2500);
   const cdp=await context.newCDPSession(page);await cdp.send('Performance.enable');await cdp.send('HeapProfiler.enable');
   const count=async()=>{for(let i=0;i<3;i++){await cdp.send('HeapProfiler.collectGarbage');await new Promise(r=>setTimeout(r,250))}
    const m=Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map(x=>[x.name,x.value]));return {nodes:m.Nodes,listeners:m.JSEventListeners,url:page.url().slice(-9,-1)}};
   const tap=async id=>{const [x,y]=at[id];await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x,y}]});await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});await new Promise(r=>setTimeout(r,1300))};
   const before=await count();for(const id of ['previousLog','previousLog','nextLog','nextLog','nextLog','previousLog'])await tap(id);const after=await count();
   assert.equal(before.url,logs[3].id.slice(-8));assert.equal(after.url,logs[3].id.slice(-8),'the taps opened other segments and came back '+JSON.stringify(after));
   assert(after.nodes<=before.nodes*1.2&&after.listeners<=before.listeners*1.2,'pages left behind are freed '+JSON.stringify({before,after}));
   await context.close()}
  console.log('maps ok');
 }finally{await browser?.close();python.kill();fs.rmSync(dir,{recursive:true,force:true})}
})().catch(error=>{console.error(error);process.exit(1)});
