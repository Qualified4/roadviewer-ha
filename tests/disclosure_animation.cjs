const fs=require('fs'),assert=require('node:assert/strict'),{chromium}=require('playwright');
(async()=>{
 const browser=await chromium.launch({headless:true});
 try{
  const serve=route=>{
   const p=new URL(route.request().url()).pathname;
   if(p==='/api/logs')return route.fulfill({json:{logs:[{id:'one',name:'test',status:'ready',uploaded:1,bytes:50,prepared_bytes:200,video:true,video_download:'qcamera.ts'}],concurrency:1,auto_convert:true,keep_original_video:true,max_upload_mb:512,storage_used_bytes:250}});
   if(p==='/api/progress')return route.fulfill({json:{progress:{}}});
   if(p.startsWith('/api/'))return route.fulfill({json:{}});
   const name=p==='/'?'library.html':p.replace('/assets/','');
   return route.fulfill({body:fs.readFileSync('roadviewer/app/web/'+name),contentType:name.endsWith('.html')?'text/html':name.endsWith('.js')?'application/javascript':name.endsWith('.css')?'text/css':'image/svg+xml'});
  };
  const open=async options=>{
   const page=await browser.newPage({viewport:{width:1280,height:900},...options}),errors=[];page.on('pageerror',e=>errors.push(e.message));
   await page.route('https://rv.test/**',serve);await page.goto('https://rv.test/');await page.locator('.log-row').waitFor();
   await page.evaluate(()=>{window.toggles=[];document.querySelector('.conversion-info').addEventListener('toggle',()=>toggles.push(document.querySelector('.conversion-info').open))});
   return {page,errors};
  };
  const settled=page=>page.waitForFunction(()=>!document.querySelector('details.is-closing')&&document.getAnimations().length===0);
  const height=(page,selector)=>page.locator(selector).evaluate(e=>e.getBoundingClientRect().height);

  const {page,errors}=await open();
  const guide='.conversion-info',summary=page.locator(guide+'>summary');
  const full=await height(page,guide);

  // Closing keeps the panel open while its height eases down; the label flips at once.
  await summary.click();
  assert(await page.locator(guide).evaluate(e=>e.open&&e.classList.contains('is-closing')),'closing panel stays open during the fold');
  assert(await page.locator(guide+'>summary .when-closed').isVisible(),'label switches to 펼치기 immediately');
  await page.waitForTimeout(110);
  const mid=await height(page,guide);
  assert(mid>80&&mid<full-20,`height animates between states (${mid} of ${full})`);
  await settled(page);
  assert.equal(await page.locator(guide).evaluate(e=>e.open),false);
  assert.equal(await page.evaluate(()=>localStorage.getItem('roadviewer-conversion-guide-open')),'false');
  assert.deepEqual(await page.evaluate(()=>toggles),[false],'measuring the closed height must not fire extra toggle events');
  const closed=await height(page,guide);

  // Opening grows from the closed height; a second tap mid-motion reverses from where it is.
  await summary.click();
  assert(await page.locator(guide).evaluate(e=>e.open));
  await page.waitForTimeout(90);
  const opening=await height(page,guide);
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
  await usage.locator('summary').click();
  assert(await usage.evaluate(e=>e.getAnimations().length===1),'secondary settings animate their height');
  await settled(page);assert(await usage.evaluate(e=>e.open));

  // Dropdown menus fade and slide; outside clicks and Escape still close them at once.
  const more=page.locator('.recording-more');
  await more.locator('summary').click();
  assert(await more.evaluate(e=>e.open&&e.querySelector('.recording-menu').getAnimations().length===1),'menu fades in');
  await settled(page);
  await more.locator('summary').click();
  assert(await more.evaluate(e=>e.open&&e.classList.contains('is-closing')),'menu fades out before closing');
  await settled(page);assert.equal(await more.evaluate(e=>e.open),false);
  await more.locator('summary').click();await page.keyboard.press('Escape');
  await page.waitForTimeout(250);
  assert.equal(await more.evaluate(e=>e.open||e.classList.contains('is-closing')),false,'Escape during the fade wins');

  // Keyboard activation goes through the same animation.
  await summary.focus();await page.keyboard.press('Enter');
  assert(await page.locator(guide).evaluate(e=>e.classList.contains('is-closing')));
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
