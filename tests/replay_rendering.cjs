const fs=require('fs'),assert=require('node:assert/strict'),{chromium}=require('playwright');
const {settleLayout}=require('./browser-helpers.cjs');
const frames=Array.from({length:41},(_,id)=>({t:id/20,id,valid:true,egoSpeedKph:40+id,lanes:[],edges:[],lp:[],es:[],leads:[],
 radarTargets:[{group:'center',index:0,x:20+id,y:0,yRel:0,vRel:-1,trackId:1,radar:true}],
 liveTracksValid:true,liveTracksDeltaMs:2,liveTracks:[{trackId:1,x:30+id,y:0,yRel:0,vRel:-1,source:'radar',trackState:'tracked',measured:true}],
 roadSignals:{blindspotLeft:true},overlay:{lanes:[],edges:[],path:[[.5,.6],[.5,.9]],markers:[]}}));
async function serve(route){
 const p=new URL(route.request().url()).pathname;
 if(p.endsWith('/bookmarks'))return route.fulfill({json:{bookmarks:[]}});
 if(p.endsWith('/telemetry'))return route.fulfill({status:404,json:{error:'none'}});
 if(p==='/api/logs')return route.fulfill({json:{logs:[]}});
 if(p.endsWith('/data'))return route.fulfill({json:{route:'test',key:'render-audit',duration:2,warnings:[],video:{start:0,duration:2},frames}});
 if(p.endsWith('/video'))return route.fulfill({body:fs.readFileSync(process.env.RV_TEST_VIDEO||'/tmp/roadviewer-test.mp4'),contentType:'video/mp4'});
 const name=p.startsWith('/view/')?'index.html':p.replace('/assets/','');
 if(name==='app.js'&&process.env.RV_AUDIT_BASELINE)return route.fulfill({body:require('child_process').execFileSync('git',['show','HEAD:roadviewer/app/web/app.js']),contentType:'application/javascript'});
 return route.fulfill({body:fs.readFileSync('roadviewer/app/web/'+name),contentType:name.endsWith('.html')?'text/html':name.endsWith('.js')?'application/javascript':name.endsWith('.css')?'text/css':name.endsWith('.png')?'image/png':'image/svg+xml'});
}
(async()=>{
 const browser=await chromium.launch({headless:true});
 try{
  const page=await browser.newPage({viewport:{width:1440,height:900}}),errors=[];
  page.on('pageerror',e=>errors.push(e.message));await page.route('https://rv.test/**',serve);
  await page.addInitScript(()=>{
   let stamp=null;window.drawAudit={map:[],overlay:[],callbacks:[]};
   const request=window.requestAnimationFrame,clear=CanvasRenderingContext2D.prototype.clearRect;
   window.requestAnimationFrame=fn=>request(time=>{stamp=time;drawAudit.callbacks.push(time);try{fn(time)}finally{stamp=null}});
   CanvasRenderingContext2D.prototype.clearRect=function(...args){const list=this.canvas.id==='road'?'map':this.canvas.id==='videoOverlay'?'overlay':null;if(list)drawAudit[list].push(stamp);return clear.apply(this,args)};
  });
  await page.goto('https://rv.test/view/one/');await page.locator('#play:enabled').waitFor();
  await page.waitForFunction(()=>document.getElementById('video').readyState>=2);await settleLayout(page);
  // Pure observation: count RAF callbacks and overlay clears while the model updates at 20 Hz and BSD is animated.
  await page.evaluate(()=>{setTime(0);drawAudit.map=[];drawAudit.overlay=[];drawAudit.callbacks=[];
   window.foldedReplayMutations=0;for(const id of ['radarRows','rawRows'])new MutationObserver(records=>foldedReplayMutations+=records.length).observe(document.getElementById(id),{childList:true,subtree:true,characterData:true});
  });await page.locator('#play').click();
  await page.waitForFunction(()=>t>=.8);await page.locator('#play').click();
  const measurement=await page.evaluate(()=>{
   const counts=list=>{const bins=new Map();for(const time of list)if(time!==null)bins.set(time,(bins.get(time)||0)+1);return {calls:list.length,frames:bins.size,maxPerFrame:Math.max(0,...bins.values()),duplicateFrames:[...bins.values()].filter(n=>n>1).length}};
   return {raf:counts(drawAudit.callbacks),overlay:counts(drawAudit.overlay),map:counts(drawAudit.map)};
  });console.log('DRAW_MEASUREMENT '+JSON.stringify(measurement));
  if(process.env.RV_MEASURE_ONLY)return;
  assert.equal(measurement.overlay.duplicateFrames,0,'one overlay draw at most per animation frame during playback');
  if(process.env.RV_AUDIT_CASE!=='fullscreen'){
  assert.equal(await page.evaluate(()=>foldedReplayMutations),0,'folded rows never mutate during playback');
  // A folded table does no row work, including while the replay clock advances.
  await page.evaluate(()=>{window.rowMutations={radarRows:0,rawRows:0};for(const id of Object.keys(rowMutations))new MutationObserver(records=>rowMutations[id]+=records.length).observe(document.getElementById(id),{childList:true,subtree:true,characterData:true});for(const time of [.1,.2,.3])setTime(time)});
  await page.evaluate(()=>new Promise(resolve=>setTimeout(resolve,0)));
  assert.deepEqual(await page.evaluate(()=>rowMutations),{radarRows:0,rawRows:0},'folded tables never mutate');
  for(const id of ['radarRows','rawRows']){
   await page.evaluate(()=>setTime(.3));
   await page.locator('#'+id).evaluate(e=>e.closest('details').open=true);
   const expected=id==='radarRows'?'26.00':'36.00';await page.waitForFunction(([id,expected])=>document.getElementById(id).rows[0]?.cells[1]?.textContent===expected,[id,expected]);
   assert(await page.locator('#'+id).evaluate(e=>{const row=e.rows[0],cell=row.cells[1];setTime(.4);return e.rows[0]===row&&e.rows[0].cells[1]===cell}),'rows and cells reused '+id);
   await page.locator('#'+id).evaluate(e=>e.closest('details').open=false);
  }
  // Add/remove rows, then an empty-state row, then data again without retaining stale cells or colspans.
  const rows=await page.evaluate(async()=>{
   const table=document.getElementById('radarRows');table.closest('details').open=true;await new Promise(r=>setTimeout(r,0));
   const f=data.frames[idx],saved=f.radarTargets,first=table.rows[0];f.radarTargets=[...saved,{...saved[0],trackId:2,index:1}];render();const added=table.rows.length===2&&table.rows[0]===first;
   f.radarTargets=[];render();const empty=table.rows.length===1&&table.rows[0].cells.length===1&&table.rows[0].cells[0].colSpan===6;
   f.radarTargets=saved;render();return {added,empty,restored:table.rows[0].cells.length===6&&table.rows[0].cells[0].colSpan===1};
  });assert.deepEqual(rows,{added:true,empty:true,restored:true});
  if(process.env.RV_AUDIT_SHOTS){
   fs.mkdirSync(process.env.RV_AUDIT_SHOTS,{recursive:true});
   await page.locator('#rawRows').evaluate(e=>e.closest('details').open=true);
   for(const colorScheme of ['dark','light']){await page.emulateMedia({colorScheme});await settleLayout(page);await page.screenshot({path:require('path').join(process.env.RV_AUDIT_SHOTS,`tables-${colorScheme}.png`),fullPage:true})}
   await page.locator('#rawRows').evaluate(e=>e.closest('details').open=false);
  }
  await page.locator('#radarRows').evaluate(e=>e.closest('details').open=false);
  }
  // The hidden map stays idle in video fullscreen; HUD and overlay still follow the current model sample.
  await page.locator('#fullscreenButton').click();await page.waitForFunction(()=>document.fullscreenElement);
  const full=await page.evaluate(()=>{drawAudit.map=[];drawAudit.overlay=[];for(const time of [.5,.6,.7])setTime(time);return {map:drawAudit.map.length,overlay:drawAudit.overlay.length,speed:document.getElementById('egoSpeed').textContent}});
  assert.equal(full.map,0,'no map drawing in fullscreen');assert(full.overlay>0,'overlay remains live');assert.equal(full.speed,'54.0','HUD remains live');
  if(process.env.RV_AUDIT_SHOTS)for(const colorScheme of ['dark','light']){await page.emulateMedia({colorScheme});await settleLayout(page);await page.screenshot({path:require('path').join(process.env.RV_AUDIT_SHOTS,`fullscreen-${colorScheme}.png`)})}
  await page.evaluate(()=>{setTime(0);drawAudit.map=[];drawAudit.overlay=[];toggle()});await page.waitForFunction(()=>t>=.5);
  const playback=await page.evaluate(()=>{pause();return {map:drawAudit.map.length,overlay:drawAudit.overlay.length}});
  assert.equal(playback.map,0,'fullscreen playback never draws the map');assert(playback.overlay>0,'fullscreen playback keeps drawing the overlay');
  await page.evaluate(()=>{drawAudit.map=[];return document.exitFullscreen()});await page.waitForFunction(()=>drawAudit.map.length>0);
  // Crowded traffic on the map: the followed lead (선택) and FF always get their labels first, the others still show
  // wherever they fit, and no two label backgrounds overlap.
  const crowd=await page.evaluate(()=>{
   for(const box of document.querySelectorAll('.road-panel input[type=checkbox]'))if(['hideLabels','boxLabelsBelow'].includes(box.id))box.checked=false;
   for(const id of ['leads','ccncTargets','boxLabels'])if(document.getElementById(id))document.getElementById(id).checked=true;
   for(const style of Object.values(targetStyle))if(document.getElementById(style.toggle))document.getElementById(style.toggle).checked=true;
   const f=data.frames[idx];
   f.selected={x:30,y:0,yRel:0,vRel:-1,radar:true};
   f.leads=[0,1,2].map(i=>({x:29+i,y:.3*i,p:.9}));
   f.radarTargets=[...[0,1,2].map(i=>({group:'center',index:i,x:30+i*.6,y:-.2*i,yRel:.2*i,vRel:-1,trackId:10+i,radar:true})),...[0,1].map(i=>({group:'left',index:i,x:31+i,y:2+.3*i,yRel:-2,vRel:0,trackId:20+i,radar:true})),...[0,1].map(i=>({group:'right',index:i,x:29+i,y:-2-.3*i,yRel:2,vRel:0,trackId:30+i,radar:true}))];
   f.ccncTargets=[{slot:'FF',x:31,y:0,yRel:0,vRel:-1},{slot:'LF',x:30,y:3,yRel:-3,vRel:0},{slot:'RF',x:32,y:-3,yRel:3,vRel:0}];
   const ctx=document.getElementById('road').getContext('2d'),texts=[],boxes=[],fill=ctx.fillText,round=ctx.roundRect;
   ctx.fillText=function(text,...rest){texts.push(String(text));return fill.call(this,text,...rest)};
   ctx.roundRect=function(x,y,w,h,r){if(r===6)boxes.push({l:x,t:y,r:x+w,b:y+h});return round.call(this,x,y,w,h,r)};
   render();delete ctx.fillText;delete ctx.roundRect;
   const labels=texts.filter(t=>/ · /.test(t));
   const overlaps=boxes.some((a,i)=>boxes.some((b,j)=>j>i&&a.l<b.r&&a.r>b.l&&a.t<b.b&&a.b>b.t));
   return {labels,count:boxes.length,overlaps,targets:f.leads.length+1+f.radarTargets.length+f.ccncTargets.length};
  });
  assert(crowd.labels.some(t=>t.startsWith('선택 · ')),'the followed lead keeps its label: '+crowd.labels);
  assert(crowd.labels.some(t=>t.startsWith('FF · ')),'FF keeps its label: '+crowd.labels);
  assert(!crowd.overlaps,'label boxes do not overlap');
  if(process.env.RV_AUDIT_SHOTS)for(const scheme of ['light','dark']){await page.emulateMedia({colorScheme:scheme});await page.evaluate(()=>render());await page.locator('#road').screenshot({path:require('path').join(process.env.RV_AUDIT_SHOTS,'labels-'+scheme+'.png')})}
  console.log('CROWD '+crowd.count+' of '+crowd.targets);assert(crowd.count>=8,`as many labels as fit are still shown (${crowd.count} of ${crowd.targets})`);
  assert.deepEqual(errors,[]);console.log('PASS: map labels by priority in traffic, folded tables, current values on open, row/cell reuse and empty states; fullscreen map suppression, live overlay/HUD and redraw on exit');
 }finally{await browser.close()}
})().catch(e=>{console.error(e);process.exitCode=1});
