const fs=require('fs'),assert=require('node:assert/strict'),{chromium}=require('playwright');
(async()=>{
 const browser=await chromium.launch({headless:true});
 try{
  const page=await browser.newPage({viewport:{width:390,height:844}}),errors=[];
  page.on('pageerror',e=>errors.push(e.message));
  await page.route('https://rv.test/**',route=>{
   const p=new URL(route.request().url()).pathname;
   if(p==='/api/logs')return route.fulfill({json:{logs:[]}});
   if(p.endsWith('/video'))return route.fulfill({body:fs.readFileSync('/tmp/roadviewer-test.mp4'),contentType:'video/mp4'});
   if(p.endsWith('/data'))return route.fulfill({json:{route:'test',key:'overlay',duration:2,warnings:[],video:{start:0,duration:2},frames:[{t:0,id:0,valid:true,lanes:[],edges:[],lp:[],es:[],leads:[],liveTracksValid:false,overlay:{lanes:[],edges:[],path:[[.5,.6],[.5,.9]],markers:[]}}]}});
   const name=p.startsWith('/view/')?'index.html':p.replace('/assets/','');
   return route.fulfill({body:fs.readFileSync('roadviewer/app/web/'+name),contentType:name.endsWith('.js')?'application/javascript':name.endsWith('.css')?'text/css':name.endsWith('.png')?'image/png':'image/svg+xml'});
  });
  await page.route('https://rv.test/view/one/',route=>route.fulfill({body:fs.readFileSync('roadviewer/app/web/index.html'),contentType:'text/html'}));
  await page.goto('https://rv.test/view/one/');
  await page.waitForFunction(()=>!document.getElementById('play').disabled);

  const button=page.locator('#cameraInfoButton'),dialog=page.locator('#cameraInfoDialog'),values=page.locator('#cameraInfoValues');
  for(const width of [390,1440]){
   await page.setViewportSize({width,height:844});
   await page.evaluate(()=>{setTime(0);data.frames[0].cameraInfo={device:'mici',deviceId:'device-123',sensor:'os04c10',calibrationStatus:'calibrated',rpy:[Math.PI/180,-Math.PI/90,Math.PI/60],height:1.35,heightDefault:false}});
   await button.click();assert(await dialog.isVisible());
   const text=await values.textContent();
   for(const value of ['mici','디바이스 IDdevice-123','os04c10','보정 완료','1.00°','-2.00°','3.00°','1.35 m (로그 보정값)','좌우 설치 오프셋확인 불가'])assert(text.includes(value),value);
   assert.equal(await page.locator('#cameraInfoClose').evaluate(el=>el===document.activeElement),true);
   const rect=await dialog.boundingBox();assert(rect.x>=0&&rect.x+rect.width<=width&&rect.y>=0&&rect.y+rect.height<=844);
   await page.evaluate(()=>{data.frames[0].cameraInfo.height=1.8;render()});
   assert.equal(await values.textContent(),text,'dialog must retain its opening snapshot');
   await page.keyboard.press('Escape');assert(!(await dialog.isVisible()));
   assert(await button.evaluate(el=>el===document.activeElement));
   await button.click();assert((await values.textContent()).includes('1.80 m'));
   await page.locator('#cameraInfoClose').click();assert(!(await dialog.isVisible()));
   await page.evaluate(()=>{data.frames[0].cameraInfo.height=1.22;data.frames[0].cameraInfo.heightDefault=true;data.frames[0].cameraInfo.calibrationStatus='uncalibrated'});
   await button.click();assert((await values.textContent()).includes('기본값 1.22 m 사용'));assert((await values.textContent()).includes('미보정'));
   await page.mouse.click(2,2);assert(!(await dialog.isVisible()));
   assert.equal(await page.evaluate(()=>document.body.style.overflow),'');
  }
  await page.evaluate(()=>{delete data.frames[0].cameraInfo});await button.click();
  assert((await values.textContent()).includes('디바이스 ID확인 불가'));
  assert((await page.locator('#cameraInfoSnapshot').textContent()).includes('제거 후 변환'));assert(!(await values.textContent()).includes('1.22'));
  await page.locator('#cameraInfoClose').click();
  await page.evaluate(()=>{data=null});await button.click();
  assert((await page.locator('#cameraInfoSnapshot').textContent()).includes('로그 데이터가 없습니다'));
  assert.deepEqual(errors,[]);console.log('PASS: camera info snapshot, units, fallback, missing data, mobile/desktop dialog and close/focus behavior');
 }finally{await browser.close()}
})().catch(e=>{console.error(e);process.exitCode=1});
