// Wait for layout prerequisites, not a guessed duration. Infinite status effects
// must keep running; they do not prevent geometry assertions from settling.
async function settleLayout(page,selector='html'){
 await page.locator(selector).waitFor({state:'visible'});
 await page.evaluate(async()=>{
  await document.fonts.ready;
  await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
 });
 await page.waitForFunction(selector=>{
  const root=document.querySelector(selector);
  return root&&!document.documentElement.classList.contains('rv-layout-transition')
   &&!root.matches('.is-closing')&&!root.querySelector('.is-closing')
   &&root.getAnimations({subtree:true}).every(animation=>animation.playState!=='running'||animation.effect.getTiming().iterations===Infinity);
 },selector);
}
// Wait until the elements matching `selector` keep the same boxes, font sizes and classes over consecutive frames with
// no finite animation or transition on them. Each check reads the boxes first: that runs layout, so styles that depend
// on it (container query units, a scrollbar coming or going) are resolved and their transitions exist before
// getAnimations() is asked. A fixed number of frames was not enough on a loaded machine: a transition that had not
// started yet read as its start value.
async function waitForSteadyLayout(page,selector,frames=3){
 await page.evaluate(()=>{window.rvSteady=null});
 await page.waitForFunction(([selector,frames])=>{
  const elements=[...document.querySelectorAll(selector)];
  const key=JSON.stringify([innerWidth,document.documentElement.clientWidth,elements.map(e=>{const r=e.getBoundingClientRect();return [r.x,r.y,r.width,r.height,getComputedStyle(e).fontSize,e.className]})]);
  const moving=elements.some(e=>e.getAnimations().some(a=>a.playState!=='finished'&&a.playState!=='idle'&&a.effect?.getTiming().iterations!==Infinity));
  const last=window.rvSteady;window.rvSteady={key,count:!moving&&last?.key===key?last.count+1:0};
  return elements.length>0&&window.rvSteady.count>=frames;
 },[selector,frames],{polling:'raf'});
}
// Saved logs start with their route groups folded. Tests about the rows themselves (not folding) open every
// group as it is created, in every page of this browser; recording_names.cjs covers the folded default.
function openRouteGroups(browser){
 const newContext=browser.newContext.bind(browser);
 browser.newContext=async(...args)=>{
  const context=await newContext(...args);
  await context.addInitScript(()=>{
   const open=root=>root.querySelectorAll?.('details.log-route:not([open])').forEach(group=>{group.open=true});
   new MutationObserver(records=>records.forEach(r=>r.addedNodes.forEach(node=>{if(node.nodeType===1){if(node.matches('details.log-route'))node.open=true;open(node)}}))).observe(document,{childList:true,subtree:true});
  });
  return context;
 };
 return browser;
}
// The library is one page with in-page tabs (로그 · 업로드 · 저장공간 · 장치 · 설정).
async function showTab(page,tab){
 await page.locator('#tab-'+tab).click();
 await page.waitForFunction(tab=>document.getElementById('tab-'+tab)?.getAttribute('aria-selected')==='true',tab);
}
// Leaving a tab and coming back reloads it, like folding and unfolding the old panels did.
async function reopenTab(page,tab){await showTab(page,'logs');await showTab(page,tab)}
module.exports={settleLayout,waitForSteadyLayout,openRouteGroups,showTab,reopenTab};
