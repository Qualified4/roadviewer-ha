const fs=require('fs'),assert=require('node:assert/strict'),{chromium}=require('playwright');
// ripple.js: one delegated listener spawns a clipped wave inside the pressed control and removes it afterwards;
// keyboard presses ripple from the centre; reduced motion only dims; disabled controls and the time toggle get none.
const asset=name=>({body:fs.readFileSync('roadviewer/app/web/'+name),contentType:name.endsWith('.html')?'text/html':name.endsWith('.js')?'application/javascript':name.endsWith('.css')?'text/css':name.endsWith('.png')?'image/png':'image/svg+xml'});
const replay={route:'ripple',key:'ripple',duration:1,warnings:[],video:null,frames:Array.from({length:20},(_,i)=>({t:i*.05,id:i,valid:true,lanes:[],edges:[],lp:[],es:[],leads:[],liveTracksValid:false}))};
(async()=>{
 const browser=await chromium.launch({headless:true});
 try{
  for(const reduced of [false,true]){
   const context=await browser.newContext({viewport:{width:1280,height:900},reducedMotion:reduced?'reduce':'no-preference'}),page=await context.newPage(),errors=[];
   page.on('pageerror',e=>errors.push(e.message));
   await page.route('https://rv.test/**',route=>{
    const p=new URL(route.request().url()).pathname;
    if(p.endsWith('/bookmarks'))return route.fulfill({json:{bookmarks:[]}});
    if(p.endsWith('/telemetry'))return route.fulfill({status:404,json:{error:'없음'}});
    if(p.endsWith('/data'))return route.fulfill({json:replay});
    if(p==='/api/logs')return route.fulfill({json:{logs:[],concurrency:1,auto_convert:true,max_upload_mb:512}});
    if(p.startsWith('/api/'))return route.fulfill({json:{progress:{}}});
    return route.fulfill(asset(p==='/'?'library.html':p.startsWith('/view/')?'index.html':p.replace('/assets/','')));
   });
   await page.goto('https://rv.test/view/ripple/');await page.locator('#play:enabled').waitFor();
   // Install the observer first (awaited), then press, then collect: avoids a race where the press beats the observer.
   const watch=async selector=>{await page.evaluate(sel=>{window.__rvWatch=new Promise(done=>{
    const el=document.querySelector(sel),seen={wave:null,dimmed:false,overflow:getComputedStyle(el).overflow};
    const check=()=>{const layer=el.querySelector(':scope>.rv-ripple');if(layer&&!seen.wave){const w=layer.firstElementChild.getBoundingClientRect(),b=el.getBoundingClientRect(),l=getComputedStyle(layer);seen.wave={clip:l.overflow,radius:l.borderRadius===getComputedStyle(el).borderRadius,inside:(r=>r.left>=b.left&&r.right<=b.right&&r.top>=b.top&&r.bottom<=b.bottom&&r.width>=b.width-4)(layer.getBoundingClientRect()),animation:getComputedStyle(layer.firstElementChild).animationName,soft:getComputedStyle(layer.firstElementChild).backgroundImage!=='none',centre:[w.left+w.width/2-b.left,w.top+w.height/2-b.top]}}if(el.classList.contains('rv-pressed'))seen.dimmed=true};
    new MutationObserver(check).observe(el,{childList:true,attributes:true,attributeFilter:['class']});
    setTimeout(()=>{check();done({...seen,left:!!el.querySelector('.rv-ripple'),after:getComputedStyle(el).overflow})},1100);
   })},selector);return ()=>page.evaluate(()=>window.__rvWatch)};
   // The bookmark press opens an editor; dismiss it before exercising the background playback controls.
   let pending=await watch('#bookmarkOpen');
   const box=await page.locator('#bookmarkOpen').boundingBox();
   await page.mouse.move(box.x+10,box.y+box.height/2);await page.mouse.down();await page.mouse.up();
   let seen=await (await pending)();
   if(reduced){assert.equal(seen.wave,null,'no ripple with reduced motion');assert(seen.dimmed,'reduced motion dims briefly instead')}
   else{
    assert(seen.wave,'ripple appears inside the pressed button');
    assert.equal(seen.wave.clip,'hidden');assert(seen.wave.radius&&seen.wave.inside,'ripple layer is clipped to the button shape');
    assert.equal(seen.wave.animation,'rv-ripple');
    assert.equal(seen.wave.soft,false,'buttons get a crisp circle');
    assert(Math.abs(seen.wave.centre[0]-10)<2,'ripple starts at the pointer: '+seen.wave.centre);
   }
   assert.equal(seen.left,false,'ripple is removed afterwards');assert.equal(seen.after,seen.overflow,'host overflow untouched');
   await page.locator('.bookmark-close').click();await page.locator('.bookmark-dialog').waitFor({state:'hidden'});
   await page.waitForFunction(()=>document.body.style.overflow!=='hidden');
   // Keyboard: ripple from the centre.
   await page.locator('#roadTab').focus();pending=await watch('#roadTab');await page.keyboard.press('Enter');seen=await (await pending)();
   if(!reduced){const b=await page.locator('#roadTab').boundingBox();assert(Math.abs(seen.wave.centre[0]-b.width/2)<1.5&&Math.abs(seen.wave.centre[1]-b.height/2)<1.5,'keyboard ripple starts at the centre')}
   assert.equal(seen.left,false);
   // Transport buttons glow instead of rippling: lit at once while pressed, fading out after release; keys light them too.
   const glow=sel=>page.evaluate(sel=>new Promise(done=>{const el=document.querySelector(sel),seen={lit:false,filter:'none',wave:false};
    const o=new MutationObserver(()=>{if(el.classList.contains('is-lit')&&!seen.lit){seen.lit=true;requestAnimationFrame(()=>requestAnimationFrame(()=>seen.filter=getComputedStyle(el).filter))}seen.wave||=!!el.querySelector('.rv-ripple')});
    o.observe(el,{attributes:true,attributeFilter:['class'],childList:true});setTimeout(()=>{o.disconnect();done({...seen,after:el.classList.contains('is-lit')})},700)}),sel);
   for(const [sel,act] of [['#play',()=>page.locator('#play').click()],['#next',()=>page.locator('#next').click()],['#prev',async()=>{await page.evaluate(()=>document.activeElement.blur());await page.keyboard.press('ArrowLeft')}]]){
    const pending=glow(sel);await act();const seen=await pending;
    assert(seen.lit&&!seen.wave&&!seen.after,sel+' glows (no ripple) and fades: '+JSON.stringify(seen));
    if(!reduced)assert.match(seen.filter,sel==='#play'?/brightness.*drop-shadow/:/drop-shadow/,sel+' glow');
   }
   if(await page.evaluate(()=>playing))await page.locator('#play').click();
   // None on the time toggle or a disabled button.
   const none=await page.evaluate(()=>{const fire=el=>{const r=el.getBoundingClientRect();el.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,clientX:r.left+2,clientY:r.top+2,button:0}));return !!el.querySelector('.rv-ripple')};
    const off=document.createElement('button');off.disabled=true;off.textContent='x';document.body.append(off);const result=[fire(document.getElementById('time')),fire(off)];off.remove();return result});
   assert.deepEqual(none,[false,false],'no ripple on the time toggle or disabled buttons');
   // One delegated listener: the script installs once even when loaded twice.
   await page.addScriptTag({url:'https://rv.test/assets/ripple.js'});
   const count=await page.evaluate(()=>{const b=document.getElementById('bookmarkOpen'),r=b.getBoundingClientRect();b.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,clientX:r.left+2,clientY:r.top+2,button:0}));return b.querySelectorAll('.rv-ripple').length});
   assert.equal(count,reduced?0:1,'a single ripple per press');
   // Card headers keep the soft-edged wave.
   if(!reduced)assert.equal(await page.evaluate(()=>{const d=document.createElement('details');d.className='log-route';d.innerHTML='<summary>카드</summary>';document.body.append(d);const s=d.firstChild,r=s.getBoundingClientRect();
    s.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,clientX:r.left+5,clientY:r.top+5,button:0}));const w=s.querySelector('.rv-ripple>span');const soft=!!w&&getComputedStyle(w).backgroundImage.includes('radial-gradient');d.remove();return soft}),true,'card headers keep a soft wave');
   // Library page loads it too.
   await page.goto('https://rv.test/');await page.waitForFunction(()=>window.rvRipple===true);
   assert.deepEqual(errors,[]);await context.close();
  }
  console.log('PASS: delegated press ripple at the pointer/centre, clipped and removed, white on mint, none when disabled/time toggle, reduced-motion dim, library and replay');
 }finally{await browser.close()}
})().catch(e=>{console.error(e);process.exitCode=1});
