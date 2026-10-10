const fs=require('fs'),assert=require('node:assert/strict'),{chromium}=require('playwright');
(async()=>{
 const browser=await chromium.launch({headless:true});
 try{
  const page=await browser.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.route('https://rv.test/**',route=>{
   const p=new URL(route.request().url()).pathname;
   if(p==='/api/logs')return route.fulfill({json:{logs:[]}});
   if(p.endsWith('/data'))return route.fulfill({json:{route:'test',key:'path',duration:2,warnings:[],video:null,frames:[{t:0,id:0,valid:true,position:[[0,0],[10,1],[20,-2]],lanes:[],edges:[],lp:[],es:[],leads:[],liveTracksValid:false}]}});
   const name=p.startsWith('/view/')?'index.html':p.replace('/assets/','');
   return route.fulfill({body:fs.readFileSync('roadviewer/app/web/'+name),contentType:name.endsWith('.js')?'application/javascript':name.endsWith('.css')?'text/css':name.endsWith('.png')?'image/png':name.endsWith('.svg')?'image/svg+xml':'text/html'});
  });
  await page.goto('https://rv.test/view/one/');
  await page.waitForFunction(()=>!document.getElementById('play').disabled);
  assert(await page.locator('#trackLabels').isChecked());
  assert.deepEqual(await page.locator('.target-label-mode input').evaluateAll(inputs=>inputs.map(input=>input.id)),['hideLabels','trackLabels','distanceLabels','yRelLabels','speedLabels','relativeSpeedLabels','liveTrackLabels']);
  assert(await page.locator('#modelPath').isChecked());assert(!(await page.locator('#hideScc').isChecked()));
  const laneStyles=await page.evaluate(()=>{
   const f=data.frames[0],saved={lanes:f.lanes,lp:f.lp,edges:f.edges,es:f.es},strokes=[],original=ctx.stroke;
   f.lp=[0,.49,.5,1,NaN];f.lanes=f.lp.map((p,i)=>[[0,i-2],[40,i-2]]);f.edges=[[[0,-6],[40,-6]],[[0,6],[40,6]]];f.es=[.2,1.5];
   ctx.stroke=function(...args){if(['#57d9b0','#ffa665'].includes(this.strokeStyle))strokes.push({color:this.strokeStyle,width:this.lineWidth,alpha:this.globalAlpha,dash:this.getLineDash()});return original.apply(this,args)};
   try{render()}finally{ctx.stroke=original;Object.assign(f,saved);render()}return strokes;
  });
  const lanes=laneStyles.filter(s=>s.color==='#57d9b0');assert.equal(lanes.length,5);
  for(const [i,p] of [0,.49,.5,1,0].entries()){assert(Math.abs(lanes[i].width-(1+3*p))<1e-6);assert(Math.abs(lanes[i].alpha-p)<1e-6);assert.deepEqual(lanes[i].dash,p<.5?[6,5]:[])}
  const edges=laneStyles.filter(s=>s.color==='#ffa665');assert.deepEqual(edges.map(s=>s.width),[2,2]);assert.deepEqual(edges.map(s=>s.dash),[[],[6,5]]);
  await page.evaluate(()=>{const f=data.frames[0];f.liveTracksValid=true;f.liveTracksDeltaMs=0;f.liveTracks=[{trackId:1,x:10,y:0,yRel:0,vRel:0,source:'scc',measured:true},{trackId:2,x:12,y:0,yRel:0,vRel:0,source:'frontRadar',measured:true}];render()});
  assert.equal(await page.locator('#rawRows tr').count(),2);
  await page.locator('#hideScc').check();assert.equal(await page.locator('#rawRows tr').count(),1);
  assert((await page.locator('#rawRows').textContent()).includes('frontRadar'));
  await page.evaluate(()=>{
   window.pathDraws=0;const stroke=ctx.stroke.bind(ctx);
   ctx.stroke=()=>{if(ctx.strokeStyle==='#c4a5ff')window.pathDraws++;stroke()};
  });
  const roadImage=()=>page.locator('#road').evaluate(c=>c.toDataURL());
  const originalPath=await roadImage();
  await page.locator('#modelPathWidth').evaluate(e=>{e.value=300;e.dispatchEvent(new Event('input'))});
  assert.equal(await roadImage(),originalPath,'top-down model path stays a line independent of car width');
  await page.evaluate(()=>render());
  assert((await page.evaluate(()=>window.pathDraws))>0);
  await page.locator('#lanes').uncheck();await page.locator('#liveTrackLabels').check();await page.locator('#yRelLabels').check();
  await page.goto('https://rv.test/view/two/');
  await page.waitForFunction(()=>!document.getElementById('play').disabled);
  assert(await page.locator('#modelPath').isChecked());
  assert(!(await page.locator('#lanes').isChecked()));
  assert(await page.locator('#liveTrackLabels').isChecked());assert(await page.locator('#yRelLabels').isChecked());assert(await page.locator('#hideScc').isChecked());
  await page.locator('#modelPath').uncheck();await page.locator('#hideLabels').check();
  await page.reload();assert(!(await page.locator('#modelPath').isChecked()));assert(await page.locator('#hideLabels').isChecked());
  await page.evaluate(()=>localStorage.setItem('roadviewer-display-preferences','invalid JSON'));
  await page.reload();assert(await page.locator('#modelPath').isChecked());assert(await page.locator('#trackLabels').isChecked());
  await page.evaluate(()=>localStorage.setItem('roadviewer-display-preferences',JSON.stringify({checks:{boxBsdLabels:false,ccncTargets:false}})));
  await page.reload();
  assert(!(await page.locator('#ccncTargets').isChecked()),'saved CCNC off overrides default');assert(!(await page.locator('#boxLabels').isChecked()));assert(!(await page.locator('#bsdLabels').isChecked()));assert(await page.locator('#targetLabels').isChecked(),'legacy combined preference does not hide TARGET');
  await page.locator('#overlayHeightSettings').click();await page.locator('#boxLabels').check();await page.locator('#boxLabelsBelow').check();await page.locator('#targetLabels').uncheck();
  await page.reload();
  assert(await page.locator('#boxLabelsBelow').isChecked(),'below-label preference survives reload');assert(await page.locator('#boxLabels').isChecked());assert(!(await page.locator('#bsdLabels').isChecked()));assert(!(await page.locator('#targetLabels').isChecked()),'three label choices persist independently');
  assert.deepEqual(errors,[]);console.log('PASS: model path default/drawing, checkbox and label persistence, malformed preference fallback');
 }finally{await browser.close()}
})().catch(e=>{console.error(e);process.exitCode=1});
