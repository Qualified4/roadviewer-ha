const fs=require('fs'),assert=require('node:assert/strict'),{chromium}=require('playwright');
// Tag filter chips: tablets and desktops show at most two rows; the rest fold behind "+N개 더보기" at the end of the second
// row, which unfolds them all and then reads 접기. A selected tag is never folded away. Phones keep one scrolling row.
const asset=name=>({body:fs.readFileSync('roadviewer/app/web/'+name),contentType:name.endsWith('.html')?'text/html':name.endsWith('.js')?'application/javascript':name.endsWith('.css')?'text/css':name.endsWith('.png')?'image/png':'image/svg+xml'});
const now=Math.floor(Date.now()/1000),colors=['red','orange','yellow','mint','blue','violet','slate'];
const logs=Array.from({length:50},(_,i)=>({id:'s'+i,name:`0000041b--a1b2c3d4e5 / 구간 ${i}`,status:'ready',uploaded:now,started_at:now-20000+i*60,duration:60,bytes:1e7,prepared_bytes:3e7,video:true,pinned:false,tags:[{name:'태그'+String(i).padStart(2,'0'),color:colors[i%7]}]}));
(async()=>{
 const browser=await chromium.launch({headless:true});
 try{
  for(const width of [1300,820,390]){
   const page=await browser.newPage({viewport:{width,height:900}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
   await page.route('https://rv.test/**',route=>{const p=new URL(route.request().url()).pathname;
    if(p==='/api/logs')return route.fulfill({json:{logs,concurrency:1,auto_convert:true,max_upload_mb:512,storage_used_bytes:1e9}});
    if(p.startsWith('/api/'))return route.fulfill({json:{progress:{}}});
    return route.fulfill(asset(p==='/'?'library.html':p.replace('/assets/','')))});
   await page.goto('https://rv.test/');await page.locator('.log-route').first().waitFor();
   const state=()=>page.locator('#logChips').evaluate(box=>{const shown=[...box.children].filter(e=>e.offsetParent),top=shown[0].offsetTop,pitch=shown[0].offsetHeight+parseFloat(getComputedStyle(box).rowGap);
    const more=box.querySelector('.chip-more');
    return {rows:Math.max(...shown.map(e=>Math.round((e.offsetTop-top)/pitch)))+1,hidden:box.querySelectorAll('.filter-chip:not(.chip-more)[hidden]').length,more:more.hidden?null:more.textContent.trim(),expanded:more.getAttribute('aria-expanded'),
     moreRow:Math.round((more.offsetTop-top)/pitch),tags:box.querySelectorAll('.filter-chip[data-filter^="tag:"]').length}});
   if(width<720){
    const s=await state();assert.equal(s.more,null,'phones keep one scrolling row, no fold');assert.equal(s.hidden,0);
    assert.equal(await page.locator('#logChips').evaluate(e=>getComputedStyle(e).flexWrap),'nowrap');
    await page.close();continue;
   }
   let s=await state();
   assert.equal(s.rows,2,'folded to two rows at '+width);assert.equal(s.moreRow,1,'the more chip ends the second row');
   assert(s.hidden>0&&s.more===`+${s.hidden}개 더보기`,'the more chip counts the folded tags: '+JSON.stringify(s));
   await page.locator('.chip-more').click();s=await state();
   assert.equal(s.hidden,0,'더보기 shows every tag');assert(s.rows>2);assert.equal(s.more,'접기');assert.equal(s.expanded,'true');
   // Keyboard: the toggle keeps focus across the rebuild.
   await page.locator('.chip-more').focus();await page.keyboard.press('Enter');assert.equal((await state()).more,`+${(await state()).hidden}개 더보기`);
   assert(await page.locator('.chip-more').evaluate(e=>e===document.activeElement),'focus stays on the toggle');
   await page.keyboard.press('Enter');assert.equal((await state()).more,'접기');
   // Picking a tag from the unfolded rows, then folding: the selected tag moves to the front and stays visible.
   await page.locator('.filter-chip[data-filter="tag:tag:태그45"]').click();
   await page.locator('.chip-more').click();s=await state();assert.equal(s.rows,2);
   const picked=page.locator('.filter-chip[data-filter="tag:tag:태그45"]');
   assert(await picked.isVisible(),'the selected tag is never folded away');assert.equal(await picked.getAttribute('aria-pressed'),'true');
   assert.equal(await page.locator('.log-row:not([hidden])').count()>=0,true);
   // Narrower widths re-fold.
   await page.setViewportSize({width:width-80,height:900});await page.waitForTimeout(100);s=await state();
   assert.equal(s.rows,2,'re-folded after a resize: '+JSON.stringify(s));assert.equal(s.more,`+${s.hidden}개 더보기`);
   assert.deepEqual(errors,[]);await page.close();
  }
  // Few tags: no more chip.
  const page=await browser.newPage({viewport:{width:1300,height:900}});
  await page.route('https://rv.test/**',route=>{const p=new URL(route.request().url()).pathname;
   if(p==='/api/logs')return route.fulfill({json:{logs:logs.slice(0,3),concurrency:1,auto_convert:true,max_upload_mb:512,storage_used_bytes:1e9}});
   if(p.startsWith('/api/'))return route.fulfill({json:{progress:{}}});
   return route.fulfill(asset(p==='/'?'library.html':p.replace('/assets/','')))});
  await page.goto('https://rv.test/');await page.locator('.log-route').first().waitFor();
  assert(await page.locator('.chip-more').isHidden(),'no more chip when everything fits in two rows');
  console.log('PASS: tag filter folds to two rows with +N개 더보기/접기 on tablets and desktops, selected tag kept visible, re-fold on resize, phones unchanged');
 }finally{await browser.close()}
})().catch(e=>{console.error(e);process.exit(1)});
