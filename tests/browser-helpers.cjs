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
module.exports={settleLayout};
