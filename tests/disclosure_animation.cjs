const fs=require('fs'),assert=require('node:assert/strict'),{chromium}=require('playwright');
const {settleLayout}=require('./browser-helpers.cjs');
(async()=>{
 const browser=await chromium.launch({headless:true});require('./browser-helpers.cjs').openRouteGroups(browser);
 try{
  const serve=route=>{
   const p=new URL(route.request().url()).pathname;
   if(p==='/api/logs')return route.fulfill({json:{logs:[{id:'one',name:'test',status:'ready',uploaded:1,bytes:50,prepared_bytes:200,video:true,video_download:'qcamera.ts'}],concurrency:1,auto_convert:true,keep_original_video:true,max_upload_mb:512,storage_used_bytes:250}});
   if(p==='/api/progress')return route.fulfill({json:{progress:{}}});
   if(p.startsWith('/api/'))return route.fulfill({json:{}});
   if(p==='/api/settings/storage')return route.fulfill({status:404,json:{error:'not_found'}});const name=p==='/'?'library.html':p.replace('/assets/','');
   return route.fulfill({body:fs.readFileSync('roadviewer/app/web/'+name),contentType:name.endsWith('.html')?'text/html':name.endsWith('.js')?'application/javascript':name.endsWith('.css')?'text/css':'image/svg+xml'});
  };
  const open=async options=>{
   const page=await browser.newPage({viewport:{width:1280,height:900},...options}),errors=[];page.on('pageerror',e=>errors.push(e.message));
   await page.route('https://rv.test/**',serve);await page.goto('https://rv.test/');await page.locator('.log-row').waitFor();
   // The guides are in the 설정 tab.
   await page.locator('#tab-settings').click();
   await page.evaluate(()=>{window.toggles=[];document.querySelector('.conversion-info').addEventListener('toggle',()=>toggles.push(document.querySelector('.conversion-info').open))});
   return {page,errors};
  };
  const settled=page=>settleLayout(page);
  // Capture the actual height animation at its midpoint, independent of runner speed.
  const startAtMidpoint=(page,selector)=>page.locator(selector).evaluate(element=>{
   element.querySelector(':scope>summary').click();
   const motion=element.getAnimations().find(animation=>animation.effect.getKeyframes().some(frame=>'height' in frame));
   if(!motion)throw Error('Expected a height animation');
   motion.pause();motion.currentTime=motion.effect.getTiming().duration/2;
   return element.getBoundingClientRect().height;
  });
  const resume=(page,selector)=>page.locator(selector).evaluate(element=>element.getAnimations().forEach(animation=>animation.play()));
  const height=(page,selector)=>page.locator(selector).evaluate(e=>e.getBoundingClientRect().height);

  const {page,errors}=await open();
  const guide='.conversion-info',summary=page.locator(guide+'>summary');
  await settled(page);const full=await height(page,guide);

  // Closing keeps the panel open while its height eases down; the label flips at once.
  const mid=await startAtMidpoint(page,guide);
  assert(await page.locator(guide).evaluate(e=>e.open&&e.classList.contains('is-closing')),'closing panel stays open during the fold');
  assert(await page.locator(guide+'>summary .when-closed').isVisible(),'label switches to 펼치기 immediately');

  assert(mid>80&&mid<full-20,`height animates between states (${mid} of ${full})`);
  await resume(page,guide);await settled(page);
  assert.equal(await page.locator(guide).evaluate(e=>e.open),false);
  assert.equal(await page.evaluate(()=>localStorage.getItem('roadviewer-conversion-guide-open')),'false');
  assert.deepEqual(await page.evaluate(()=>toggles),[false],'measuring the closed height must not fire extra toggle events');
  const closed=await height(page,guide);

  // Opening grows from the closed height; a second tap mid-motion reverses from where it is.
  const opening=await startAtMidpoint(page,guide);
  assert(await page.locator(guide).evaluate(e=>e.open));
  assert(opening>closed+5&&opening<full-5,'opening animates the height');
  const [before,after]=await page.evaluate(selector=>{const e=document.querySelector(selector),h=()=>e.getBoundingClientRect().height,start=h();e.querySelector(':scope>summary').click();return [start,h()]},guide);
  assert(Math.abs(after-before)<1,`reversal starts from the current height (${before} → ${after})`);
  await settled(page);
  assert.equal(await page.locator(guide).evaluate(e=>e.open),false);
  assert(Math.abs(await height(page,guide)-closed)<1);
  await summary.click();await settled(page);
  assert(Math.abs(await height(page,guide)-full)<1,'panel returns to its natural height');
  assert.equal(await page.locator(guide).evaluate(e=>e.style.height+e.style.overflow),'','no inline styles remain');

  // Nested secondary settings use the same motion and chevron transition.
  const usage=page.locator('.usage-guide');
  assert.equal(await usage.locator('summary').evaluate(e=>getComputedStyle(e,'::after').transitionDuration),'0.25s');
  const usageMotions=await usage.evaluate(e=>{e.querySelector('summary').click();const height=e.getAnimations()[0],fades=e.getAnimations({subtree:true}).filter(a=>a!==height&&!a.effect.pseudoElement&&a.effect.target.parentElement===e);
   return {count:e.getAnimations().length,duration:height?.effect.getTiming().duration,easing:height?.effect.getTiming().easing,fill:height?.effect.getTiming().fill,fades:fades.map(a=>[a.effect.getTiming().duration,a.effect.getTiming().easing,a.effect.getKeyframes().map(f=>[f.opacity,new DOMMatrixReadOnly(f.transform).m42])])}});
  assert.equal(usageMotions.count,1,'secondary settings animate their height');
  assert.equal(usageMotions.fill,'forwards','the height holds its end until [open] changes (no full-height frame after a fold)');assert.equal(usageMotions.duration,300);assert.equal(usageMotions.easing,'cubic-bezier(0.4, 0, 0.2, 1)','height uses the standard curve');
  // Content is clipped by the growing panel and slides down into place in parallax (no fade): from a quarter of the
  // height change above (at most 40px) to 0, with the height's timing.
  const parallax=([duration,easing,frames])=>duration===300&&easing==='cubic-bezier(0.4, 0, 0.2, 1)'&&frames.every(([opacity])=>opacity===undefined);
  assert(usageMotions.fades.length&&usageMotions.fades.every(m=>parallax(m)&&m[2][0][1]<0&&m[2][0][1]>=-40&&m[2][1][1]===0),'content slides down into place: '+JSON.stringify(usageMotions.fades));
  await settled(page);
  const collapsing=await usage.evaluate(e=>{e.querySelector('summary').click();return e.getAnimations({subtree:true}).filter(a=>!e.getAnimations().includes(a)&&!a.effect.pseudoElement&&a.effect.target.parentElement===e).map(a=>[a.effect.getTiming().duration,a.effect.getTiming().easing,a.effect.getKeyframes().map(f=>[f.opacity,new DOMMatrixReadOnly(f.transform).m42])])});
  assert(collapsing.length&&collapsing.every(m=>parallax(m)&&m[2][0][1]===0&&m[2][1][1]<0),'content slides up as the panel closes over it: '+JSON.stringify(collapsing));
  await settled(page);await usage.locator('summary').click();
  await settled(page);assert(await usage.evaluate(e=>e.open));

  // Dropdown menus fade and slide; outside clicks and Escape still close them at once.
  await page.locator('#tab-logs').click();
  const more=page.locator('.log-row .recording-more');
  const opened=await more.evaluate(e=>{e.querySelector('summary').click();const a=e.querySelector('.recording-menu').getAnimations().map(a=>({duration:a.effect.getTiming().duration,easing:a.effect.getTiming().easing,frames:a.effect.getKeyframes()}));return {open:e.open,a}});
  assert(opened.open&&opened.a.length===2,'menu fades and grows in');
  const fade=opened.a.find(a=>'opacity' in a.frames[0]),grow=opened.a.find(a=>'transform' in a.frames[0]);
  assert.deepEqual([fade.duration,fade.easing],[120,'linear'],'menu fades in over 120 ms');
  assert.deepEqual([grow.duration,grow.easing,grow.frames[0].transform],[150,'cubic-bezier(0, 0, 0.2, 1)','scale(0.8)'],'menu grows from .8 with deceleration');
  assert.match(grow.frames[0].transformOrigin,/^(top|bottom) (left|right)$|^(left|right) (top|bottom)$/,'menu grows out of a corner next to its button');
  await settled(page);
  const closing=await more.evaluate(e=>{e.querySelector('summary').click();const a=e.querySelector('.recording-menu').getAnimations();return e.open&&e.classList.contains('is-closing')&&a.length===1&&a[0].effect.getTiming().duration===75&&!('transform' in a[0].effect.getKeyframes()[0])});
  assert(closing,'menu fades out (75 ms, no scale) before closing');
  await settled(page);assert.equal(await more.evaluate(e=>e.open),false);
  await more.locator('summary').click();await page.keyboard.press('Escape');
  await settled(page);
  assert.equal(await more.evaluate(e=>e.open||e.classList.contains('is-closing')),false,'Escape during the fade wins');

  // Keyboard activation goes through the same animation.
  await page.locator('#tab-settings').click();
  await summary.focus();await page.keyboard.press('Enter');
  await settled(page);assert.equal(await page.locator(guide).evaluate(e=>e.open),false);
  assert.deepEqual(errors,[]);
  await page.close();

  // Reduced motion toggles immediately.
  const quiet=await open({reducedMotion:'reduce'});
  await quiet.page.locator(guide+'>summary').click();
  assert.equal(await quiet.page.locator(guide).evaluate(e=>e.open||e.getAnimations().length>0),false);
  assert.deepEqual(quiet.errors,[]);
  console.log('PASS: animated details height, reversible folds, immediate labels, toggle events, menu fade, keyboard and reduced motion');
 }finally{await browser.close()}
})().catch(e=>{console.error(e);process.exitCode=1});
