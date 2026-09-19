const fs=require('fs'),assert=require('node:assert/strict'),{chromium}=require('playwright');
(async()=>{
 const browser=await chromium.launch({headless:true});
 try{
  const page=await browser.newPage({viewport:{width:390,height:844}}),errors=[];
  page.on('pageerror',e=>errors.push(e.message));
  let concurrency=1,fail=false,writes=0;
  await page.route('https://rv.test/**',route=>{
   const p=new URL(route.request().url()).pathname;
   if(p==='/api/logs')return route.fulfill({json:{logs:[],max_upload_mb:512,storage_used_bytes:0,concurrency}});
   if(p==='/api/settings/processing'){
    writes++;if(fail)return route.fulfill({status:500,json:{error:'저장 실패'}});
    concurrency=route.request().postDataJSON().concurrency;
    return route.fulfill({json:{concurrency}});
   }
   if(p==='/api/diagnostics')return route.fulfill({json:{saved:1}});
   const name=p==='/'?'library.html':p.replace('/assets/','');
   return route.fulfill({body:fs.readFileSync('roadviewer/app/web/'+name),contentType:name.endsWith('.js')?'application/javascript':name.endsWith('.css')?'text/css':'image/svg+xml'});
  });
  // Use the real library HTML content type.
  await page.route('https://rv.test/',route=>route.fulfill({body:fs.readFileSync('roadviewer/app/web/library.html'),contentType:'text/html'}));
  await page.goto('https://rv.test/');
  await page.waitForFunction(()=>document.getElementById('concurrencyChoice')&&!document.getElementById('concurrencyChoice').disabled);
  assert.equal(await page.locator('#concurrencyChoice').textContent(),'1개');
  for(const value of [2,3,4]){
   await page.locator('#concurrencyChoice').click();await page.getByRole('option',{name:value+'개',exact:true}).click();
   await page.waitForFunction(value=>document.getElementById('concurrencyStatus').textContent.includes(value+'개'),value);
   assert.equal(concurrency,value);assert.equal(writes,value-1);
   await page.reload();await page.waitForFunction(value=>document.getElementById('concurrencyChoice')?.textContent===value+'개',value);
  }
  concurrency=1;await page.evaluate(()=>refresh());
  assert.equal(await page.locator('#concurrencyChoice').textContent(),'1개');
  fail=true;await page.locator('#concurrencyChoice').click();await page.getByRole('option',{name:'2개',exact:true}).click();
  await page.waitForFunction(()=>document.getElementById('error').textContent==='저장 실패');
  assert.equal(await page.locator('#concurrencyChoice').textContent(),'1개');
  assert.deepEqual(errors,[]);console.log('PASS: processing selector save, reload, remote changes, and failure rollback');
 }finally{await browser.close()}
})().catch(e=>{console.error(e);process.exitCode=1});
