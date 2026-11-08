// 내보내기 · 불러오기 (log-transfer.js): the storage card exports every recording and imports an exported .tar, read in the
// browser and sent one recording at a time (progress in bytes, then a summary); selection mode exports the selected ones.
const fs=require('fs'),path=require('path'),assert=require('node:assert/strict'),{chromium}=require('playwright');
const {showTab,openRouteGroups}=require('./browser-helpers.cjs');
// A ustar archive as log_transfer.py writes it.
function tar(members){
 const blocks=[];
 for(const [name,body] of members){
  const data=Buffer.isBuffer(body)?body:Buffer.from(typeof body==='string'?body:JSON.stringify(body)),head=Buffer.alloc(512);
  head.write(name,0);head.write('0000644\0',100);head.write('0000000\0',108);head.write('0000000\0',116);
  head.write(data.length.toString(8).padStart(11,'0')+'\0',124);head.write('00000000000\0',136);head.write('        ',148);head.write('0',156);head.write('ustar\x0000',257);
  let sum=0;for(const byte of head)sum+=byte;head.write(sum.toString(8).padStart(6,'0')+'\0 ',148);
  blocks.push(head,data,Buffer.alloc(-data.length&511));
 }
 return Buffer.concat([...blocks,Buffer.alloc(1024)]);
}
const ID1='a'.repeat(32),ID2='b'.repeat(32),ID3='c'.repeat(32),S1='1'.repeat(32),S3='3'.repeat(32);
const LOG1=Buffer.from('rlog-one-bytes'),LOG3=Buffer.from('rlog-three');
const record=(id,log)=>({id,name:`00000395--aaaaaaaaaa--${id[0]}`,uploaded:1,files:{},tags:[],bookmarks:[],pinned:false,video_codecs:{},video_origins:{},originals:{'rlog.zst':{bytes:log.length,sha256:'0'.repeat(64)}},storage:{}});
const exportTar=(version=1)=>tar([['manifest.json',{format:'roadviewer-export',version,app_version:'1.0.15',exported_at:1,recordings:[ID1,ID2,ID3].map(id=>({id,name:'n-'+id[0]}))}],
 [ID1+'/rlog.zst',LOG1],[ID1+'/record.json',JSON.stringify(record(ID1,LOG1))+'   '],[ID2+'/record.json',{...record(ID2,Buffer.alloc(0)),originals:{},storage:{'rlog.zst':{location:'gdrive',file_id:'f',bytes:3,sha256:'1'.repeat(64)}}}],
 [ID3+'/rlog.zst',LOG3],[ID3+'/record.json',record(ID3,LOG3)]]);
(async()=>{
 const browser=openRouteGroups(await chromium.launch({headless:true}));
 try{
  const page=await browser.newPage({viewport:{width:1280,height:900}}),errors=[],exports=[],begins=[],deletes=[],received={};
  page.on('pageerror',e=>errors.push(e.message));
  let logs=[ID1,'d'.repeat(32)].map((id,i)=>({id,name:`00000395--aaaaaaaaaa--${i}`,status:'ready',uploaded:i,bytes:10,prepared_bytes:0,video:false})),chunkGate=null,releaseChunk;
  await page.route('https://rv.test/**',async route=>{
   const req=route.request(),url=new URL(req.url()),p=url.pathname;
   if(p==='/api/logs')return route.fulfill({json:{logs,max_upload_mb:512,storage_used_bytes:200,concurrency:1,auto_convert:true}});
   if(p==='/api/progress')return route.fulfill({json:{progress:{}}});
   if(p==='/api/settings/storage')return route.fulfill({json:{max_bytes:0,policy:'reject_new',used_bytes:200,free_bytes:5000000,reserved_bytes:0}});
   if(p==='/api/settings/archive')return route.fulfill({json:{archive_enabled:false,archive_backend:'smb',archive_mode:'move',archive_allow_local_delete:false,archive_path:'',archive_local_threshold_mb:0,archive_min_age_hours:24,archive_interval_minutes:10,archive_batch:4,archive_nas_max_mb:0,archive_nas_margin_mb:1024,archive_gdrive_folder_name:'Road Viewer',effective_mode:'move',client_configured:false}});
   if(p==='/api/logs/import'){
    assert.equal(req.headers()['x-roadviewer-request'],'1');const body=req.postDataJSON();begins.push(body);
    if(body.record.id===ID2)return route.fulfill({json:{skipped:'exists',id:ID2}});
    return route.fulfill({status:201,json:{session:body.record.id===ID1?S1:S3,chunk_size:4,files:['rlog.zst']}});
   }
   if(p.startsWith('/api/uploads/')&&req.method()==='PUT'){
    const session=p.split('/')[3],offset=Number(url.searchParams.get('offset'));
    if(chunkGate&&session===S1&&offset===4){const gate=chunkGate;chunkGate=null;await gate}
    received[session]=Buffer.concat([received[session]||Buffer.alloc(0),req.postDataBuffer()]);
    return route.fulfill({json:{received:received[session].length}});
   }
   if(p===`/api/logs/import/${S1}/finish`)return route.fulfill({status:201,json:{imported:ID1,status:'queued'}});
   if(p===`/api/logs/import/${S3}/finish`)return route.fulfill({status:422,json:{error:'checksum_mismatch',message:'rlog.zst 파일이 내보낸 내용과 다릅니다 (체크섬 불일치).'}});
   if(req.method()==='DELETE'){deletes.push(p);return route.fulfill({json:{deleted:true}})}
   if(p.startsWith('/api/'))return route.fulfill({status:404,json:{error:'not_found'}});
   const name=p==='/'?'library.html':p.replace('/assets/',''),file='roadviewer/app/web/'+name;
   if(!fs.existsSync(file))return route.abort();
   return route.fulfill({body:fs.readFileSync(file),contentType:name.endsWith('.js')?'application/javascript':name.endsWith('.css')?'text/css':name.endsWith('.html')?'text/html':name.endsWith('.svg')?'image/svg+xml':name.endsWith('.woff2')?'font/woff2':'application/octet-stream'});
  });
  // The export is a download started by a link click: the link is recorded instead of downloading.
  await page.addInitScript(()=>{const click=HTMLAnchorElement.prototype.click;HTMLAnchorElement.prototype.click=function(){if(this.download!==undefined&&this.getAttribute('href').includes('export.tar')){(window.exportLinks||=[]).push(this.getAttribute('href'));return}return click.call(this)}});
  await page.goto('https://rv.test/');await page.waitForSelector('.log-row');
  await showTab(page,'storage');
  const card=page.locator('.storage-local');
  assert(await card.locator('#exportLogs').isVisible());assert(await card.locator('#importLogs').isVisible());assert(await page.locator('#importCancel').isHidden());
  // The buttons sit at the foot of the card, below the usage figures, inside it.
  const [box,exportBox,metrics]=await Promise.all([card.boundingBox(),page.locator('#exportLogs').boundingBox(),page.locator('#storageUsage').boundingBox()]);
  assert(exportBox.y>metrics.y+metrics.height&&exportBox.y+exportBox.height<=box.y+box.height&&exportBox.x+exportBox.width<=box.x+box.width);
  if(process.env.RV_EXPORT_SHOTS){
   for(const scheme of ['light','dark']){await page.emulateMedia({colorScheme:scheme});await page.waitForTimeout(150);await card.screenshot({path:path.join(process.env.RV_EXPORT_SHOTS,`storage-card-${scheme}.png`)})}
   await page.emulateMedia({colorScheme:null});
  }
  // 내보내기: every recording, as one download.
  const exported=async count=>{exports.splice(0,exports.length,...await page.evaluate(()=>(window.exportLinks||[]).map(href=>href.replace('api/logs/export.tar',''))));assert.equal(exports.length,count)};
  await page.locator('#exportLogs').click();await page.waitForFunction(()=>document.getElementById('transferStatus').textContent.includes('내보내기를 시작'));
  await exported(1);assert.deepEqual(exports,['']);
  // 불러오기: three recordings — imported (in chunks, progress shown), already present, failed with its reason.
  chunkGate=new Promise(resolve=>releaseChunk=resolve);
  await page.locator('#importFile').setInputFiles({name:'roadviewer-export.tar',mimeType:'application/x-tar',buffer:exportTar()});
  await page.waitForFunction(()=>/불러오는 중 1\/3 · 4 B \/ 24 B/.test(document.getElementById('transferStatus').textContent));
  assert(await page.locator('#importProgress').isVisible());assert(await page.locator('#importLogs').isDisabled());assert(await page.locator('#importCancel').isVisible());
  assert.match(await page.locator('#transferStatus').textContent(),/4 B \/ 24 B/,'bytes sent of the whole file');
  assert.equal(await page.locator('#importProgress').evaluate(e=>e.value),17);
  releaseChunk();
  await page.waitForFunction(()=>document.getElementById('transferStatus').textContent.startsWith('불러오기 완료'));
  assert.equal(await page.locator('#transferStatus').textContent(),'불러오기 완료 · 새 기록 1개 · 이미 있는 1개 건너뜀 · 실패 1개');
  assert.match(await page.locator('#transferFailures').textContent(),/n-c: rlog\.zst 파일이 내보낸 내용과 다릅니다/);
  assert(await page.locator('#importProgress').isHidden());assert(await page.locator('#importLogs').isEnabled());
  assert.deepEqual(begins.map(b=>[b.format,b.version,b.record.id]),[['roadviewer-export',1,ID1],['roadviewer-export',1,ID2],['roadviewer-export',1,ID3]]);
  assert.deepEqual(received[S1],LOG1,'the file bytes come from the tar, chunk by chunk');assert.deepEqual(received[S3],LOG3);
  assert.deepEqual(deletes,[`/api/uploads/${S3}`],'a failed recording cancels its session');
  // A file from a newer app is refused before anything is sent.
  begins.length=0;await page.locator('#importFile').setInputFiles({name:'new.tar',mimeType:'application/x-tar',buffer:exportTar(2)});
  await page.waitForFunction(()=>document.getElementById('transferStatus').textContent.includes('지원하지 않는 내보내기 형식 버전'));
  await page.locator('#importFile').setInputFiles({name:'other.tar',mimeType:'application/x-tar',buffer:tar([['notes.txt','hello']])});
  await page.waitForFunction(()=>document.getElementById('transferStatus').textContent==='Road Viewer 내보내기 파일이 아닙니다.');
  assert.equal(begins.length,0);
  // Selection mode: the selected segments, or the whole list when every one is selected.
  await showTab(page,'logs');await page.locator('#bulkOpen').click();await page.locator('#bulkBar').waitFor();
  assert(await page.locator('#bulkExport').isDisabled());
  await page.locator('.segment-select input').first().check();await page.locator('#bulkExport').click();
  await page.waitForFunction(()=>document.getElementById('bulkStatus').textContent.includes('1개 구간 내보내기를 시작'));
  await page.locator('#bulkAll').check();await page.locator('#bulkExport').click();
  await page.waitForFunction(()=>document.getElementById('bulkStatus').textContent.includes('2개 구간 내보내기를 시작'));
  await exported(3);assert.equal(exports.length,3);assert.match(exports[1],/^\?ids=[0-9a-f]{32}$/);assert.equal(exports[2],'');
  // Narrow screens: the button is under 더보기 like the other secondary actions.
  await page.setViewportSize({width:390,height:844});
  assert(await page.locator('#bulkExport').isHidden());await page.locator('#bulkMore').click();assert(await page.locator('#bulkExport').isVisible());
  assert.deepEqual(errors,[]);
  console.log('log export ok');
 }finally{await browser.close()}
})().catch(e=>{console.error(e);process.exit(1)});
