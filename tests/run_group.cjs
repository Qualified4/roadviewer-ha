// Runs one CI browser test group (tests/browser-groups.json) file by file, in the listed order.
// A file that fails is run once more; the group fails only when a file fails twice. Every file that needed its second
// run is named in the summary (and in the job summary on GitHub Actions), so flaky tests stay visible.
//   node tests/run_group.cjs g3
// RV_TEST_GROUPS=<path> reads another manifest; RV_TEST_FILE_TIMEOUT=<seconds> bounds one run of a file (900).
const fs=require('fs'),path=require('path'),{spawn}=require('child_process');
const group=process.argv[2];
const manifestPath=process.env.RV_TEST_GROUPS||path.join(__dirname,'browser-groups.json');
const manifest=JSON.parse(fs.readFileSync(manifestPath,'utf8'));
const limit=Number(process.env.RV_TEST_FILE_TIMEOUT)||900;
if(!group||!manifest[group]){console.error(`usage: node tests/run_group.cjs <group>; groups in ${manifestPath}: ${Object.keys(manifest).join(', ')}`);process.exit(2)}
const tests=manifest[group].map(entry=>typeof entry==='string'?{file:entry,env:{}}:{file:entry.file,env:entry.env||{}});
const label=test=>Object.entries(test.env).map(([k,v])=>`${k}=${v} `).join('')+'tests/'+test.file;
const missing=tests.filter(test=>!fs.existsSync(path.join(path.dirname(manifestPath),test.file)));
if(missing.length){console.error('missing test files: '+missing.map(label).join(', '));process.exit(2)}

function run(test){
 return new Promise(resolve=>{
  const started=Date.now();
  // Its own process group on POSIX, so a timeout also ends the browser the test started.
  const child=spawn(process.execPath,[path.join(path.dirname(manifestPath),test.file)],{env:{...process.env,...test.env},stdio:'inherit',detached:process.platform!=='win32'});
  let timedOut=false;
  const timer=setTimeout(()=>{timedOut=true;try{process.platform!=='win32'?process.kill(-child.pid,'SIGKILL'):child.kill('SIGKILL')}catch{}},limit*1000);
  child.on('exit',(code,signal)=>{clearTimeout(timer);resolve({ok:code===0&&!timedOut,detail:timedOut?`timed out after ${limit} s`:signal?`signal ${signal}`:`exit ${code}`,seconds:Math.round((Date.now()-started)/1000)})});
 });
}

(async()=>{
 const results=[];
 for(const test of tests){
  console.log(`\n=== ${label(test)}`);
  const first=await run(test);let second=null;
  if(!first.ok){
   console.log(`=== ${label(test)} failed (${first.detail}), running it once more`);
   second=await run(test);
  }
  const result={test,first,second,ok:first.ok||second.ok};results.push(result);
  if(second?.ok)console.log(`::warning title=Flaky browser test::${label(test)} failed once (${first.detail}) and passed on its second run`);
  if(!result.ok)console.log(`::error title=Browser test failed twice::${label(test)}: ${first.detail}, then ${second.detail}`);
 }
 const retried=results.filter(r=>r.second?.ok),failed=results.filter(r=>!r.ok);
 const lines=[`### Browser tests ${group}: ${failed.length?'FAILED':'passed'}`,'',
  `${results.length} files, ${results.length-retried.length-failed.length} passed first time, ${retried.length} passed on their second run, ${failed.length} failed twice.`,''];
 if(retried.length)lines.push('Needed a second run (flaky):','',...retried.map(r=>`- \`${label(r.test)}\`: first run ${r.first.detail}`),'');
 if(failed.length)lines.push('Failed twice:','',...failed.map(r=>`- \`${label(r.test)}\`: ${r.first.detail}, then ${r.second.detail}`),'');
 lines.push('| file | first run | second run |','|---|---|---|',...results.map(r=>`| \`${label(r.test)}\` | ${r.first.ok?'pass':r.first.detail} (${r.first.seconds} s) | ${r.second?(r.second.ok?'pass':r.second.detail)+` (${r.second.seconds} s)`:'-'} |`));
 const text=lines.join('\n')+'\n';
 console.log('\n'+text);
 if(process.env.GITHUB_STEP_SUMMARY)fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY,text);
 process.exitCode=failed.length?1:0;
})().catch(e=>{console.error(e);process.exitCode=1});
