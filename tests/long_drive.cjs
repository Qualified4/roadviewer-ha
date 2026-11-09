const fs=require('fs'),assert=require('node:assert/strict'),{chromium}=require('playwright');
const {settleLayout}=require('./browser-helpers.cjs');
// Long drives (180 segments): the replay segment strip scrolls with the current segment centred, the library route bar
// draws proportional status runs, and the segment chooser opens centred on the current segment with group headers.
const asset=name=>({body:fs.readFileSync('roadviewer/app/web/'+name),contentType:name.endsWith('.html')?'text/html':name.endsWith('.js')?'application/javascript':name.endsWith('.css')?'text/css':name.endsWith('.png')?'image/png':'image/svg+xml'});
const now=Math.floor(Date.now()/1000),status=i=>i===85?'processing':i>=170?'unconverted':'ready';
const longLogs=Array.from({length:180},(_,i)=>({id:'s'+i,name:`0000041b--a1b2c3d4e5 / 구간 ${i}`,status:status(i),uploaded:now,started_at:now-20000+i*60,duration:60,bytes:1e7,prepared_bytes:status(i)==='ready'?3e7:0,video:true,pinned:false,tags:[],progress:i===85?{stage:'video_convert',percent:40}:undefined}));
const shortLogs=Array.from({length:3},(_,i)=>({...longLogs[i],id:'t'+i,name:`0000042a--b2c3d4e5f6 / 구간 ${i}`,status:'ready'}));
const replay={route:'0000041b--a1b2c3d4e5',key:'long',duration:2,warnings:[],video:null,frames:[{t:0,id:0,valid:true,lanes:[],edges:[],lp:[],es:[],leads:[],liveTracksValid:false}]};
(async()=>{
 const browser=await chromium.launch({headless:true}),shots=process.env.RV_LONG_SHOTS;
 try{
  for(const reduced of [false,true])for(const width of [360,390,1300]){
   const context=await browser.newContext({viewport:{width,height:900},reducedMotion:reduced?'reduce':'no-preference'}),page=await context.newPage(),errors=[];
   page.on('pageerror',e=>errors.push(e.message));
   await page.route('https://rv.test/**',route=>{
    const p=new URL(route.request().url()).pathname;
    if(p.endsWith('/bookmarks'))return route.fulfill({json:{bookmarks:[]}});
    if(p.endsWith('/telemetry'))return route.fulfill({status:404,json:{error:'없음'}});
    if(p.endsWith('/data'))return route.fulfill({json:replay});
    if(p==='/api/logs')return route.fulfill({json:{logs:[...longLogs,...shortLogs],concurrency:1,auto_convert:true,max_upload_mb:512}});
    if(p.startsWith('/api/'))return route.fulfill({json:{progress:{}}});
    return route.fulfill(asset(p==='/'?'library.html':p.startsWith('/view/')?'index.html':p.replace('/assets/','')));
   });
   await page.goto('https://rv.test/view/s90/');await page.locator('#play:enabled').waitFor();
   await page.waitForFunction(()=>document.querySelectorAll('#segmentStrip .segment-block').length===180);await settleLayout(page);
   const strip=()=>page.locator('#segmentStrip').evaluate(s=>{const c=s.querySelector('[aria-current]').getBoundingClientRect(),f=s.getBoundingClientRect(),b=s.querySelector('.segment-block').getBoundingClientRect();
    return {scrolling:s.classList.contains('is-scrolling'),offset:(c.left+c.width/2)-(f.left+f.width/2),block:b.width,overflowX:getComputedStyle(s).overflowX,scrollbar:getComputedStyle(s).scrollbarWidth,
     fades:[s.classList.contains('fade-left'),s.classList.contains('fade-right')],page:document.documentElement.scrollWidth-innerWidth,bar:document.querySelector('.playback').getBoundingClientRect().width,left:s.scrollLeft}});
   let s=await strip();
   assert(s.scrolling&&s.overflowX==='auto'&&s.scrollbar==='none','180 segments scroll in a strip with a hidden scrollbar at '+width);
   assert.equal(s.block,width<720?24:28,'fixed block width');
   assert(Math.abs(s.offset)<=3,'the current segment is centred on load at '+width+': '+s.offset);
   assert.deepEqual(s.fades,[true,true],'edge fades where more segments exist');
   assert(s.page<=0,'no page horizontal scroll at '+width);
   // The scrolling strip clips its blocks' enlarged hit area to its own box, so it pads that box: a block takes taps over
   // at least 22px of height with a mouse (the visible block is 8-12px; touch also gets the event track's rows), and the seek bar below keeps its own.
   const hit=await page.locator('#segmentStrip').evaluate(s=>{const b=s.querySelector('[aria-current]'),r=b.getBoundingClientRect(),x=r.left+r.width/2;let n=0;
    for(let y=Math.floor(r.top)-20;y<=r.bottom+20;y++)if(document.elementFromPoint(x,y)===b)n++;const seek=document.getElementById('seek').getBoundingClientRect();
    return {n,seek:document.elementFromPoint(x,seek.top+seek.height/2)?.id}});
   assert(hit.n>=22,'segment block touch height at '+width+': '+hit.n);assert.equal(hit.seek,'seek','the seek bar keeps its touches');assert(s.bar<=width,'transport bar keeps its width');
   if(shots&&!reduced)await page.screenshot({path:`${shots}/long-drive-replay-${width}.png`});
   // Manual scrolling is the user's until the next segment change; scrolling to the start drops the left fade.
   await page.locator('#segmentStrip').evaluate(e=>{e.dispatchEvent(new WheelEvent('wheel'));e.scrollLeft=0});await page.waitForFunction(()=>!document.getElementById('segmentStrip').classList.contains('fade-left'));
   await page.evaluate(()=>window.dispatchEvent(new Event('resize')));await page.waitForTimeout(50);
   assert.equal((await strip()).left,0,'manual scroll position is kept');
   // The fade widens with the distance scrolled from the end: none at the start, half after 7px, full (28px) after 14px.
   const fade=async left=>page.locator('#segmentStrip').evaluate((s,left)=>{s.style.scrollSnapType='none';s.scrollLeft=left;s.dispatchEvent(new Event('scroll'));const f=parseFloat(s.style.getPropertyValue('--fade-left'));s.style.scrollSnapType='';return f},left);
   assert.deepEqual([await fade(0),await fade(7),await fade(200)],[0,14,28],'left fade width follows the scroll distance');await fade(0);
   // At either end the strip's clip keeps a block's 2px ring (offset 1.5px) whole.
   const room=await page.locator('#segmentStrip').evaluate(s=>{const f=s.getBoundingClientRect(),first=s.firstElementChild.getBoundingClientRect();s.scrollLeft=s.scrollWidth;
    const last=s.lastElementChild.getBoundingClientRect();return [first.left-(f.left+s.clientLeft),(f.left+s.clientLeft+s.clientWidth)-last.right]});
   assert(room.every(r=>r>=3.5),'room for the current ring at the strip ends at '+width+': '+room);
   await page.locator('#segmentStrip').evaluate(s=>{s.scrollLeft=0});
   // Mouse drag scrolls without opening a segment.
   if(width===1300){
    const box=await page.locator('#segmentStrip').boundingBox();const url=page.url();
    await page.mouse.move(box.x+300,box.y+box.height/2);await page.mouse.down();await page.mouse.move(box.x+100,box.y+box.height/2,{steps:5});await page.mouse.up();
    const dragLeft=(await strip()).left;assert(Math.abs(dragLeft-200)<=16,'drag scrolls the strip (then may snap to a block): '+dragLeft);assert.equal(page.url(),url,'a drag is not a click');
   }
   // Keyboard: blocks stay focusable and scroll into view.
   await page.locator('#segmentStrip .segment-block').nth(150).focus();
   const visible=await page.locator('#segmentStrip').evaluate(s=>{const b=s.children[150].getBoundingClientRect(),f=s.getBoundingClientRect();return b.left>=f.left-1&&b.right<=f.right+1});
   assert(visible,'a focused block scrolls into view');
   // Chooser: centred on the current segment, light headers every 10 segments, arrow keys skip headers.
   await page.locator('#logSegmentChoice').click();const dialog=page.locator('.rv-choice-dialog[open]');await dialog.waitFor();await settleLayout(page,'.rv-choice-dialog[open]');
   const chooser=await dialog.evaluate(d=>{const list=d.querySelector('.rv-choice-list'),cur=list.querySelector('[aria-selected=true]'),l=list.getBoundingClientRect(),c=cur.getBoundingClientRect();
    return {offset:(c.top+c.height/2)-(l.top+l.height/2),headers:[...list.querySelectorAll('.rv-choice-group')].map(h=>h.textContent),focused:document.activeElement===cur,text:cur.textContent}});
   assert.equal(chooser.text,'구간 90✓');assert(chooser.focused);
   assert(Math.abs(chooser.offset)<=4,'the current segment opens centred in the chooser: '+chooser.offset);
   assert.equal(chooser.headers.length,18);assert.match(chooser.headers[0],/^구간 0–9 · /);assert.match(chooser.headers[17],/^구간 170–179/);
   await page.keyboard.press('End');assert.equal(await page.evaluate(()=>document.activeElement.textContent),'구간 169','End goes to the last enabled option');
   await page.keyboard.press('ArrowDown');assert.equal(await page.evaluate(()=>document.activeElement.className),'rv-choice-option','arrow keys move between options only');
   await page.keyboard.press('Escape');await dialog.waitFor({state:'hidden'});
   // Short routes keep blocks that stretch to fill.
   await page.goto('https://rv.test/view/t1/');await page.waitForFunction(()=>document.querySelectorAll('#segmentStrip .segment-block').length===3);await settleLayout(page);
   const fill=await page.locator('#segmentStrip').evaluate(s=>({scrolling:s.classList.contains('is-scrolling'),sum:[...s.children].reduce((n,b)=>n+b.getBoundingClientRect().width,0)+3*(s.children.length-1),width:s.clientWidth}));
   assert(!fill.scrolling&&Math.abs(fill.sum-fill.width)<1,'a short route fills the strip without scrolling');
   // Library: a 180-segment route bar shows its first 20 blocks and a borderless "+" coloured by the most urgent
   // status among the rest (segment 85 is processing); short routes keep one block per segment.
   await page.evaluate(()=>localStorage.setItem('roadviewer-expanded-routes',JSON.stringify(['0000041b--a1b2c3d4e5'])));
   await page.goto('https://rv.test/');await page.locator('.log-route').first().waitFor();await settleLayout(page);
   // Every drive starts folded; an unfold saved by an older build is ignored and dropped.
   assert.deepEqual(await page.locator('.log-route').evaluateAll(r=>r.map(e=>e.open)),[false,false],'drives start folded');
   assert.equal(await page.evaluate(()=>localStorage.getItem('roadviewer-expanded-routes')),null,'the old saved state is removed');
   const bar=await page.locator('.log-route').filter({hasText:'180'}).first().locator('.route-bar').evaluate(b=>{const r=b.getBoundingClientRect(),card=b.closest('.log-route').getBoundingClientRect(),plus=b.querySelector('.route-more'),blocks=[...b.querySelectorAll('.route-seg')],ps=plus&&getComputedStyle(plus);
    return {more:b.classList.contains('has-more'),blocks:blocks.length,ids:blocks.map(x=>x.dataset.id),last:b.lastElementChild===plus,plus:plus&&{status:plus.dataset.status,title:plus.title,border:ps.borderTopWidth,bg:ps.backgroundColor,gap:plus.getBoundingClientRect().left-blocks.at(-1).getBoundingClientRect().right,barGap:parseFloat(getComputedStyle(b).columnGap),mask:getComputedStyle(b).maskImage},
     inside:r.right<=card.right+.5&&r.left>=card.left-.5,label:b.getAttribute('aria-label'),title:b.title}});
   assert(bar.more&&bar.last,'a long route ends its bar with a "+"');
   assert.equal(bar.blocks,20);assert.deepEqual(bar.ids,Array.from({length:20},(_,i)=>'s'+i),'the first 20 segments, in order');
   assert.equal(bar.plus.status,'processing','the "+" takes the most urgent status of the hidden segments');
   assert.equal(bar.plus.title,'나머지 160개 구간 · 재생 가능 149 · 처리 중 1 · 미변환 10');
   assert.equal(bar.plus.border,'0px');assert.equal(bar.plus.bg,'rgba(0, 0, 0, 0)','no border or background: not a button');
   assert(Math.abs(bar.plus.gap-bar.plus.barGap)<.6,'the "+" sits one block gap after the bar: '+bar.plus.gap);assert.equal(bar.plus.mask,'none','the bar is not faded');
   assert(bar.inside,'the route bar stays inside its card at '+width);
   assert.equal(bar.label,'180개 구간: 재생 가능 169 · 처리 중 1 · 미변환 10');assert.equal(bar.title,'180개 구간 · '+bar.label.split(': ')[1]);
   assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'no library overflow at '+width);
   const short=await page.locator('.route-bar:not(.has-more)').first().evaluate(b=>[b.classList.contains('has-more'),b.children.length]);
   assert.deepEqual(short,[false,3],'short routes keep one block per segment');
   if(shots&&!reduced)await page.screenshot({path:`${shots}/long-drive-library-${width}.png`});
   // Light theme status colours: vivid fills for graphics (yellow processing with a darker 1px edge), a neutral processing label on a yellow tint (4.5:1).
   if(width===390){
    const look=await page.evaluate(()=>{
     const rgba=c=>{const m=c.match(/[\d.]+/g).map(Number);return [m[0],m[1],m[2],m[3]??1]},over=(t,b)=>t.slice(0,3).map((v,i)=>v*t[3]+b[i]*(1-t[3]));
     const lum=c=>{const [r,g,b]=c.map(v=>{v/=255;return v<=.03928?v/12.92:((v+.055)/1.055)**2.4});return .2126*r+.7152*g+.0722*b},ratio=(a,b)=>{const [x,y]=[lum(a),lum(b)].sort((p,q)=>q-p);return (x+.05)/(y+.05)};
     const base=e=>{const layers=[];for(let n=e;n;n=n.parentElement){const c=rgba(getComputedStyle(n).backgroundColor);if(c[3]>0)layers.push(c);if(c[3]===1)break}return layers.reverse().reduce((acc,c)=>over(c,acc),[255,255,255])};
     document.querySelector('.log-route:not([open])>summary')?.click();
     const chip=document.querySelector('.state-processing');if(!chip)return null;
     const bg=base(chip);return {text:getComputedStyle(chip).color,ratio:ratio(rgba(getComputedStyle(chip).color),bg),ready:getComputedStyle(document.querySelector('.route-seg[data-status=ready]')).backgroundColor,warn:getComputedStyle(document.querySelector('.route-more[data-status=processing]')).color}});
    assert(look,'a processing chip is shown');assert.equal(look.text,'rgb(20, 23, 28)','neutral processing label');assert(look.ratio>=4.5,'processing label contrast '+look.ratio);
    assert.deepEqual([look.ready,look.warn],['rgb(34, 192, 138)','rgb(234, 179, 8)'],'vivid ready fill and processing "+"');
   }
   assert.deepEqual(errors,[]);await context.close();
  }
  console.log('PASS: 180-segment scrolling strip centred on the current segment (load, manual scroll, drag, keyboard), no overflow, chooser centred with group headers, first 20 library blocks with a status-coloured "+"');
 }finally{await browser.close()}
})().catch(e=>{console.error(e);process.exitCode=1});
