const fs=require('fs'),assert=require('node:assert/strict'),{chromium}=require('playwright');
(async()=>{
 const browser=await chromium.launch({headless:true});
 try{
  const page=await browser.newPage({viewport:{width:390,height:844}}),errors=[];
  page.on('pageerror',e=>errors.push(e.message));
  await page.addInitScript(()=>{
   window.copied=[];
   Object.defineProperty(navigator,'clipboard',{value:{writeText:async text=>{if(window.denyCopy)throw Error('Denied');window.copied.push(text)}}});
   document.execCommand=()=>{if(window.failFallback)return false;window.copied.push(document.activeElement.value);return true};
  });
  const logs=[
   {id:'one',name:'00000395--0d0eda17c5 / 구간 7',files:{'rlog.zst':'00000395--0d0eda17c5--7--rlog.zst'}},
   {id:'two',name:'00000395--0d0eda17c5 / 구간 8'},
   {id:'other',name:'00000395--1234567890 / 구간 9'}
  ].map(row=>({...row,status:'ready',uploaded:1,bytes:1,prepared_bytes:1,video:false}));
  await page.route('https://rv.test/**',route=>{
   const p=new URL(route.request().url()).pathname;
   if(p==='/api/logs')return route.fulfill({json:{logs,concurrency:1,max_upload_mb:512,storage_used_bytes:6}});
   if(p==='/api/progress')return route.fulfill({json:{progress:{}}});
   if(p.endsWith('/data'))return route.fulfill({json:{route:logs[0].name,duration:1,frames:[{t:0,id:0,valid:true,lanes:[],edges:[],lp:[],es:[],leads:[]}],warnings:[],video:null}});
   const name=p==='/'?'library.html':p.startsWith('/view/')?'index.html':p.replace('/assets/','');
   return route.fulfill({body:fs.readFileSync('roadviewer/app/web/'+name),contentType:name.endsWith('.html')?'text/html':name.endsWith('.js')?'application/javascript':name.endsWith('.css')?'text/css':'image/png'});
  });
  await page.goto('https://rv.test/');await page.waitForSelector('.log-row');
  assert.equal(await page.locator('.log-name .recording-name-text').first().textContent(),'395 / 구간 7');
  await page.locator('.log-name .copy-recording').first().click();
  assert.deepEqual(await page.evaluate(()=>copied),['00000395--0d0eda17c5--7']);
  const examples=await page.evaluate(()=>[
   recordingIdentity('000AAA--bbbbbbbbbb--0'),
   recordingIdentity('00000000--bbbbbbbbbb / 구간 0'),
   recordingIdentity('직접 올린 로그'),
   recordingIdentity('00000395--0d0eda17c5 / 구간 7',{'rlog.zst':'00000395--0d0eda17c5--007--rlog.zst'})
  ]);
  assert.equal(examples[0].display,'AAA / 구간 0');assert.equal(examples[1].display,'0 / 구간 0');
  assert.equal(examples[2].display,'직접 올린 로그');assert.equal(examples[3].original,'00000395--0d0eda17c5--007');
  await page.evaluate(()=>window.denyCopy=true);await page.locator('.copy-recording').first().click();
  assert.equal(await page.evaluate(()=>copied.length),2);
  await page.evaluate(()=>window.failFallback=true);await page.locator('.copy-recording').first().click();
  assert.equal(await page.locator('.copy-recording').first().getAttribute('title'),'복사하지 못했습니다. 다시 시도해 주세요.');
  await page.goto('https://rv.test/view/one/');await page.waitForFunction(()=>document.getElementById('route').textContent==='395 / 구간 7');
  await page.waitForFunction(()=>document.getElementById('logSegment').options.length===2);
  await page.locator('#routeName .copy-recording').click();
  assert.equal(await page.evaluate(()=>copied.at(-1)),'00000395--0d0eda17c5--7');
  await page.evaluate(()=>scrollTo(0,220));await page.waitForFunction(()=>!document.getElementById('foldHeading').hidden);
  const expanded=await page.locator('#foldHeading').getAttribute('aria-expanded');
  await page.locator('#routeName .copy-recording').click();
  assert.equal(await page.locator('#foldHeading').getAttribute('aria-expanded'),expanded,'copy must not fold heading');
  assert.equal(await page.evaluate(()=>copied.length),2);assert.deepEqual(errors,[]);
  console.log('PASS: shortened names, original copy, leading zero/text cases, clipboard fallback/error, replay copy over fold control and unchanged route grouping');
 }finally{await browser.close()}
})().catch(e=>{console.error(e);process.exitCode=1});
