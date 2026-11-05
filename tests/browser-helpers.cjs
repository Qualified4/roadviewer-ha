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
module.exports={settleLayout,openRouteGroups};
