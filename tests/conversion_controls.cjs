const fs=require('fs'),assert=require('node:assert/strict'),{chromium}=require('playwright');
(async()=>{
 const browser=await chromium.launch({headless:true});
 try{
  const page=await browser.newPage({viewport:{width:390,height:844}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
  let automatic=true,status='ready',excluded=false,fail=false,converted=0,removed=0,deleted=0;
  await page.route('https://rv.test/**',route=>{
   const p=new URL(route.request().url()).pathname;
   if(p==='/api/logs')return route.fulfill({json:{logs:deleted?[]:[{id:'one',name:'test',status,auto_excluded:excluded,uploaded:1,bytes:50,prepared_bytes:status==='ready'?200:0,video:true}],concurrency:1,auto_convert:automatic,max_upload_mb:512,storage_used_bytes:250}});
   if(p==='/api/progress')return route.fulfill({json:{progress:{}}});
   if(p==='/api/settings/processing'){
    if(fail)return route.fulfill({status:500,json:{error:'설정 저장 실패'}});
    automatic=route.request().postDataJSON().auto_convert;return route.fulfill({json:{concurrency:1,auto_convert:automatic}});
   }
   if(p.endsWith('/prepared')){assert.equal(route.request().method(),'DELETE');removed++;status='unconverted';excluded=true;return route.fulfill({json:{status}})}
   if(p.endsWith('/convert')){converted++;status='queued';return route.fulfill({json:{status}})}
   if(p==='/api/logs/one'){deleted++;return route.fulfill({json:{deleted:'one'}})}
   const name=p==='/'?'library.html':p.replace('/assets/','');return route.fulfill({body:fs.readFileSync('roadviewer/app/web/'+name),contentType:name.endsWith('.html')?'text/html':name.endsWith('.js')?'application/javascript':name.endsWith('.css')?'text/css':'image/svg+xml'});
  });
  await page.goto('https://rv.test/');await page.waitForFunction(()=>!document.getElementById('autoConvert').disabled);
  assert(await page.getByRole('heading',{name:'변환 및 저장 안내'}).isVisible());assert.equal(await page.locator('.status-guide dt').count(),5);
  await page.getByRole('switch',{name:'자동 변환'}).uncheck();await page.waitForFunction(()=>document.getElementById('autoConvertInfo').textContent.includes('꺼짐'));assert.equal(automatic,false);
  await page.reload();assert.equal(await page.getByRole('switch',{name:'자동 변환'}).isChecked(),false);
  fail=true;await page.getByRole('switch',{name:'자동 변환'}).check();await page.waitForFunction(()=>document.getElementById('error').textContent==='설정 저장 실패');assert.equal(await page.getByRole('switch',{name:'자동 변환'}).isChecked(),false);fail=false;
  page.on('dialog',d=>d.accept());await page.getByRole('button',{name:'제거',exact:true}).click();await page.getByRole('button',{name:'변환',exact:true}).waitFor();assert.equal(removed,1);assert.equal(await page.locator('.replay').count(),0);assert((await page.locator('.state').textContent()).includes('수동 변환 필요'));
  await page.getByRole('button',{name:'변환',exact:true}).click();await page.getByRole('button',{name:'대기 중',exact:true}).waitFor();assert.equal(converted,1);assert(await page.getByRole('button',{name:'대기 중',exact:true}).isDisabled());
  status='processing';await page.evaluate(()=>refresh());assert(await page.getByRole('button',{name:'처리 중',exact:true}).isDisabled());
  status='error';await page.evaluate(()=>refresh());assert(await page.getByRole('button',{name:'변환',exact:true}).isEnabled());
  status='ready';await page.evaluate(()=>refresh());assert(await page.getByRole('button',{name:'제거',exact:true}).isEnabled());assert(await page.getByRole('link',{name:'재생',exact:true}).isVisible());
  for(const width of [320,390,1280]){await page.setViewportSize({width,height:844});assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));}
  await page.getByRole('button',{name:'완전 삭제',exact:true}).click();await page.waitForFunction(()=>document.querySelectorAll('.log-row').length===0);assert.equal(deleted,1);assert.deepEqual(errors,[]);
  console.log('PASS: automatic conversion toggle, persistence/error rollback, guide, convert/remove states, complete delete and responsive widths');
 }finally{await browser.close()}
})().catch(e=>{console.error(e);process.exitCode=1});
