const fs=require('fs'),assert=require('node:assert/strict'),crypto=require('crypto'),{chromium}=require('playwright');
(async()=>{
 const browser=await chromium.launch({headless:true});
 try{
  const page=await browser.newPage({viewport:{width:390,height:844}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
  const secret='f'.repeat(64),device='a'.repeat(32),nonceSet=new Set();let current=null,chunkCount=0,finished=false,cancelled=false,tokenNumber=0;
  const hash=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
  await page.route('https://rv.test/**',route=>{
   const req=route.request(),u=new URL(req.url()),path=u.pathname,headers=req.headers();
   const send=(status,json)=>route.fulfill({status,json});
   if(path==='/api/device/test')return route.fulfill({body:fs.readFileSync('roadviewer/app/web/device-test.html'),contentType:'text/html',headers:{'Content-Security-Policy':"default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"}});
   if(path==='/api/device/pair')return send(201,{device_id:device,device_secret:secret});
   if(path==='/api/device/uploads'){
    const raw=req.postData(),body=JSON.parse(raw),nonce=headers['x-rv-nonce'];
    const canonical=['RV1',device,headers['x-rv-timestamp'],nonce,'POST',path,hash(raw)].join('\n');
    const expected=crypto.createHmac('sha256',Buffer.from(secret,'ascii')).update(canonical).digest('hex');
    if(expected!==headers['x-rv-signature'])return send(401,{error:'invalid_signature'});
    if(nonceSet.has(nonce))return send(409,{error:'nonce_replayed'});nonceSet.add(nonce);
    assert(/^[a-f0-9]{36}$/.test(nonce));assert(Math.abs(Date.now()/1000-Number(headers['x-rv-timestamp']))<5);
    if(!current){
     current={id:'b'.repeat(32),token:'',expires_at:Date.now()/1000+7200,chunk_size:262144,files:body.segments.flatMap(s=>s.files.map(f=>({...f,name:`${s.route}--${s.segment}--${f.kind}`}))).map((f,i)=>({...f,index:i,received:0,data:Buffer.alloc(0)}))};
    }
    current.token='session-token-'+(++tokenNumber);
    return send(201,{...current,files:current.files.map(({data,...f})=>f)});
   }
   assert(current);assert.equal(headers.authorization,'Bearer '+current.token,'token reissuance must update the browser token');
   if(path.endsWith('/finish')){
    for(const f of current.files){assert.equal(f.received,f.size);assert.equal(hash(f.data),f.sha256)}finished=true;return send(201,{logs:[{id:'one'},{id:'two'}],updated:[],duplicates:[]});
   }
   if(path.includes('/files/')){
    const f=current.files[Number(path.split('/').pop())],offset=Number(u.searchParams.get('offset')),data=req.postDataBuffer();
    assert.equal(offset,f.received);assert(data.length<=262144);f.data=Buffer.concat([f.data,data]);f.received+=data.length;chunkCount++;return send(200,{received:f.received});
   }
   if(req.method()==='DELETE'){current=null;cancelled=true;return send(200,{deleted:'b'.repeat(32)})}
   return send(200,{id:current.id,state:'uploading',files:current.files.map(({data,...f})=>f)});
  });
  await page.goto('https://rv.test/api/device/test');
  assert(await page.locator('#blocked').isHidden());assert(await page.locator('#session').isDisabled());
  await page.locator('#pairCode').fill('ABCDEF123456ABCDEF123456');await page.locator('#pair').click();await page.waitForFunction(()=>document.getElementById('deviceStatus').textContent.startsWith('연결됨'));
  await page.locator('#mock').click();await page.waitForFunction(()=>!document.getElementById('session').disabled);
  assert.equal(await page.locator('#fileList li').count(),4);
  await page.locator('#badSignature').click();await page.waitForFunction(()=>document.getElementById('result').textContent.includes('잘못된 서명 차단 (401)'));
  await page.locator('#session').click();await page.waitForFunction(()=>!document.getElementById('upload').disabled);
  await page.locator('#upload').click();await page.waitForFunction(()=>document.getElementById('result').textContent.startsWith('첫 조각 전송 후'));assert.equal(chunkCount,1);
  await page.locator('#replay').click();await page.waitForFunction(()=>document.getElementById('result').textContent.includes('동일 nonce 재전송 차단 (409)'));
  await page.locator('#status').click();await page.waitForFunction(()=>document.getElementById('result').textContent.startsWith('서버에 저장된'));
  await page.locator('#upload').click();await page.waitForFunction(()=>document.getElementById('result').textContent.startsWith('모든 파일을 전송'));assert.equal(chunkCount,6);
  await page.locator('#finish').click();await page.waitForFunction(()=>document.getElementById('result').textContent.startsWith('완료 ·'));assert(finished);
  const text=await page.locator('body').innerText();assert(!text.includes(secret));assert(!text.includes('session-token-'));
  assert.equal(await page.evaluate(()=>localStorage.length),0);assert.equal(await page.evaluate(()=>sessionStorage.length),0);
  current=null;await page.reload();assert(await page.locator('#deviceStatus').textContent()==='연결된 장치 없음');
  await page.locator('#pairCode').fill('ABCDEF123456ABCDEF123456');await page.locator('#pair').click();await page.waitForFunction(()=>document.getElementById('deviceStatus').textContent.startsWith('연결됨'));
  await page.locator('#files').setInputFiles({name:'00000395--0d0eda17c5--7--rlog.zst',mimeType:'application/zstd',buffer:Buffer.from('real-file-selection-test')});await page.waitForFunction(()=>!document.getElementById('session').disabled);
  await page.locator('#session').click();await page.waitForFunction(()=>!document.getElementById('cancel').disabled);await page.locator('#cancel').click();await page.waitForFunction(()=>document.getElementById('result').textContent.startsWith('세션 취소'));assert(cancelled);
  await page.locator('#files').setInputFiles({name:'bad.exe',mimeType:'application/octet-stream',buffer:Buffer.from('x')});await page.waitForFunction(()=>document.getElementById('result').dataset.error==='true');assert(await page.locator('#session').isDisabled());
  assert.deepEqual(errors,[]);assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  console.log('PASS: browser HMAC against Node crypto, dummy/real files, chunk hashes, pause/resume, nonce rejection, cancel, reload and secret non-persistence');
 }finally{await browser.close()}
})().catch(e=>{console.error(e);process.exitCode=1});
