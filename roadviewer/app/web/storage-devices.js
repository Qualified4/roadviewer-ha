'use strict';
// Credentials and pairing codes are never persisted in browser storage.
// The 저장공간 and 장치 tab panels: shown/hidden by the library tabs, which fire 'toggle' on each change.
const storageDetails=$('storageSettings'),deviceDetails=$('deviceSettings');
$('pairCopyIcon').innerHTML=COPY_ICON;
let pairCopyTimer=null;
function resetPairCopy(){
 clearTimeout(pairCopyTimer);pairCopyTimer=null;
 $('pairCopyIcon').innerHTML=COPY_ICON;$('pairCopyStatus').textContent='';$('pairCopy').title='페어링 코드 복사';
}
let pairingTimer=null,pairingBusy=false,pairingGeneration=0,pairingIssuing=false;
const settingsRequest=(url,body,method='POST')=>api(url,{method,headers:{'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});
function showStorage(s){
 storageSnapshotState=s;
 $('storageMaximumLabel').textContent=s.archive?.backend==='gdrive'&&s.archive.effective_mode==='move'?'소프트 한도':'설정 한도';
 $('storageUsed').textContent=storageSize(s.used_bytes);
 $('storageMaximum').textContent=s.max_bytes?storageSize(s.max_bytes):'제한 없음';
 $('storageFree').textContent=storageSize(s.free_bytes);
 $('storageReserved').textContent=storageSize(s.reserved_bytes);
 const percent=s.max_bytes>0&&Number.isFinite(s.used_bytes)?s.used_bytes/s.max_bytes*100:null;
 $('storageUsagePercent').textContent=percent===null?'제한 없음':`${Math.round(percent)}% 사용`;
 $('storageMeter').hidden=percent===null;
 if(percent!==null){const value=Math.max(0,Math.min(100,percent));$('storageMeter').setAttribute('aria-valuenow',String(value));$('storageMeter').setAttribute('aria-valuetext',`${Math.round(percent)}% 사용`);$('storageMeterFill').style.width=value+'%';$('storageMeter').classList.toggle('is-near-limit',percent>=90)}
 showArchive(s.archive);updateEditor();showHeaderStorage(s);
}
// The library header: local usage against the limit and the archive connection, from the same storage block.
function showHeaderStorage(s){
 headerStorage.used=s.used_bytes;headerStorage.max=s.max_bytes;const a=s.archive,drive=a?.backend==='gdrive';
 const text=!a?.enabled?null:drive?gdriveStatusText(a.gdrive||{},a.state):ARCHIVE_STATES[a.state]||'확인 중';
 headerStorage.archive=text?{text:(drive?'Drive ':'NAS ')+text,state:text==='연결됨'?'ok':text==='확인 중'?'checking':'error'}:null;
 syncHeaderStorage();
}
// Every 3 s while the archive reads 'checking' (the server answers as soon as its probe is back), every 10 s otherwise.
const HEADER_CHECKING_MS=3000,HEADER_MS=10000;let headerTimer=null;
async function refreshHeaderStorage(){
 clearTimeout(headerTimer);
 if(!document.hidden&&storageDetails.hidden)try{showHeaderStorage(await storageSnapshot())}catch{}
 headerTimer=setTimeout(refreshHeaderStorage,headerStorage.archive?.state==='checking'?HEADER_CHECKING_MS:HEADER_MS);
}
const ARCHIVE_STATES={connected:'연결됨',unavailable:'연결 불가',checking:'확인 중'},ARCHIVE_ERRORS={storage_unavailable:'NAS에 연결할 수 없습니다.',nas_full:'NAS 공간이 부족합니다.',nas_full_no_candidates:'NAS가 가득 찼지만 정리할 수 있는 파일이 없습니다.',hash_mismatch:'NAS 사본 검증에 실패했습니다.',os_error:'NAS에 파일을 복사하지 못했습니다.'};
// Google Drive: the panel shows only what the status block names; of a waiting sign-in, only the code and the address.
const DRIVE_ERRORS={storage_unavailable:'Google Drive에 연결할 수 없습니다.',remote_full:'Google Drive 공간이 부족합니다.',rate_limited:'Google Drive 요청 한도를 넘었습니다. 다음 주기에 다시 시도합니다.',auth_expired:'Google Drive 인증이 만료되었습니다. 다시 연결하세요.',hash_mismatch:'Google Drive 사본 검증에 실패했습니다.',os_error:'Google Drive에 파일을 올리지 못했습니다.'};
const GDRIVE_AUTH_ERRORS={access_denied:'사용자가 승인을 거부했습니다',code_expired:'코드가 만료되었습니다. 다시 연결하세요',auth_expired:'인증이 만료되었습니다. 다시 연결하세요',invalid_grant:'인증이 만료되었습니다. 다시 연결하세요',invalid_client:'클라이언트 ID/비밀키가 올바르지 않습니다',signed_out:'연결이 해제되어 업로드를 중단했습니다. 다시 연결하세요'};
const GDRIVE_ARCHIVE_OFF='아카이빙이 꺼져 있습니다. 여기서는 Google Drive 계정 연결만 관리하며 파일은 복사하지 않습니다.';
const GDRIVE_SETUP='애드온 옵션에서 Google Drive 클라이언트 ID를 설정하세요',GDRIVE_NOT_SELECTED='아카이브 저장소가 Google Drive로 설정되어 있지 않습니다.';
const GDRIVE_REQUEST_ERRORS={gdrive_not_configured:GDRIVE_SETUP,gdrive_connected:'이미 Google Drive에 연결되어 있습니다.',gdrive_not_selected:GDRIVE_NOT_SELECTED,gdrive_backend:GDRIVE_NOT_SELECTED,gdrive_unavailable:'Google에 연결할 수 없습니다. 잠시 후 다시 시도하세요.'};
const gdriveAuthText=code=>GDRIVE_AUTH_ERRORS[code]||`인증 오류 (${code})`;
const gdriveRequestError=e=>e.code==='gdrive_auth_failed'?gdriveAuthText(e.reason||e.code):GDRIVE_REQUEST_ERRORS[e.code]||e.message;
let gdriveTimer=null,gdriveTick=0,gdriveExpires=0,gdriveBusy=false,gdriveFetching=false,gdriveGeneration=0,gdriveState=null,gdriveSkew=null,gdriveDeadline=null,gdriveShownCode='';
function showArchive(a){
 if(a?.settings_error)$('archiveSettingsStatus').textContent='아카이빙 설정을 읽지 못해 꺼졌습니다. 설정을 확인하고 저장하세요. ('+a.settings_error+')';
 // Local usage and archive metrics have separate sections. Never show the share's path.
 for(const row of document.querySelectorAll('#archiveUsage>.archive-metric,#archiveSecondaryUsage>.archive-metric'))row.remove();
 archiveCheckPoll(a);
 $('archiveRun')?.remove();$('archiveSummary').hidden=!a?.enabled;if(!a?.enabled){$('archiveJob').hidden=true;archiveJobPoll(false)}
 // A block without a backend is the NAS and shows as before; nothing of Drive is created for it.
 // Drive's sign-in does not need archiving on: with it off, only the connection panel is shown.
 const drive=a?.backend==='gdrive';
 $('archiveSummaryTitle').textContent=drive?'확장 저장공간':'NAS 저장공간';
 $('archiveActivity').textContent=a?.enabled?'자동 아카이빙 켜짐 · '+(drive?(a.effective_mode||a.mode||'copy').toUpperCase():'MOVE')+(a.running?' · 실행 중':''):'자동 아카이빙 꺼짐';
 if(!drive)hideGdrive();
 if(!a?.enabled){if(drive)showGdrive(a);return}
 const rows=drive?gdriveRows(a):[['NAS 상태',ARCHIVE_STATES[a.state]||'확인 중'],['NAS 사용 중',storageSize(a.used_bytes)],['NAS 여유',storageSize(a.free_bytes)],['마지막 아카이브',a.last_cycle_at?new Date(a.last_cycle_at*1000).toLocaleString():'—']];
 $('archiveSummary').dataset.backend=drive?'gdrive':'smb';
 rows.push(['최근 실행 결과',a.running?'실행 중':a.last_error?((drive?DRIVE_ERRORS:ARCHIVE_ERRORS)[a.last_error]||a.last_error):a.last_cycle_at?'오류 보고 없음':'아직 실행 안 함']);
 const kinds={'최근 실행 결과':'result','저장소':'destination','Drive 상태':'state','NAS 상태':'state','Drive 사용 중':'capacity','NAS 사용 중':'capacity','Drive 여유':'capacity','NAS 여유':'capacity','복제 사본':'copies','복제 사본 용량':'copies','검증 실패':'errors','마지막 아카이브':'updated'};
 for(const [label,value] of rows){
  const kind=kinds[label],row=document.createElement('div'),dt=document.createElement('dt'),dd=document.createElement('dd');
  row.className='archive-metric';row.dataset.kind=kind;dt.textContent=label;dd.textContent=value;
  if(kind==='errors')row.dataset.hasErrors=String((Number(a.archive_errors?.remote_mismatch)||0)>0);
  if(kind==='state')row.dataset.state=drive?gdriveStatusText(a.gdrive||{},a.state):ARCHIVE_STATES[a.state]||'확인 중';
  row.append(dt,dd);(['copies','errors','updated','result'].includes(kind)?$('archiveSecondaryUsage'):$('archiveUsage')).append(row);
 }
 const button=document.createElement('button');button.id='archiveRun';button.type='button';button.textContent=archiveAllLabel(a);button.disabled=!!a.running;button.onclick=runArchive;$('archiveExecution').prepend(button);
 showArchiveJob(a);
 if(a.last_error)$('storageStatus').textContent='마지막 아카이브 오류: '+((drive?DRIVE_ERRORS:ARCHIVE_ERRORS)[a.last_error]||a.last_error);
 if(drive)showGdrive(a);
}
function gdriveStatusText(g,state){
 if(!g.connected)return '연결 안 됨';
 return g.last_auth_error?'인증 만료':ARCHIVE_STATES[state]||'확인 중';
}
// With archiving off the state is 'disabled' and says nothing of the account: the sign-in block alone does.
const gdriveAccountText=g=>g.pending&&typeof g.pending==='object'?'연결 대기 중':gdriveStatusText(g,'connected');
function gdriveRows(a){
 // Without a figure yet, the one being measured in the background (opening the panel starts it) shows as such.
 const g=a.gdrive||{},measuring=!!a.usage_measuring&&!a.usage_known;
 return [['저장소','Google Drive'],['Drive 상태',gdriveStatusText(g,a.state)],['Drive 사용 중',measuring?'측정 중':storageSize(a.used_bytes)],['Drive 여유',measuring?'측정 중':a.usage_reliable?storageSize(a.free_bytes):'할당량 확인 불가'],
  ['복제 사본',`${Number(a.remote_copies_files)||0}개`],['복제 사본 용량',storageSize(Number(a.remote_copies_bytes)||0)],['검증 실패',`${Number(a.archive_errors?.remote_mismatch)||0}개`],['마지막 아카이브',a.last_cycle_at?new Date(a.last_cycle_at*1000).toLocaleString():'—']];
}
function gdrivePanel(){
 let panel=$('gdrivePanel');if(panel)return panel;
 const el=(tag,props={})=>Object.assign(document.createElement(tag),props);
 panel=el('div',{id:'gdrivePanel',className:'gdrive-panel'});
 const code=el('div',{id:'gdriveCode',className:'gdrive-code',hidden:true}),guide=el('p',{className:'gdrive-code-guide'}),status=el('p',{id:'gdriveStatus',className:'gdrive-status'});
 guide.append('아무 브라우저에서 ',el('a',{id:'gdriveUrl',target:'_blank',rel:'noopener noreferrer'}),' 에 접속해 아래 코드를 입력하세요.');
 code.append(guide,el('code',{id:'gdriveUserCode',className:'gdrive-user-code'}),el('p',{id:'gdriveCountdown',className:'gdrive-countdown'}));
 status.setAttribute('role','status');
 const actions=el('div',{className:'gdrive-actions'}),connect=el('button',{id:'gdriveConnect',type:'button',textContent:'Google Drive 연결'}),disconnect=el('button',{id:'gdriveDisconnect',type:'button',textContent:'연결 해제',hidden:true});
 connect.onclick=()=>gdriveRequest('connect');disconnect.onclick=()=>gdriveRequest('disconnect');
 actions.append(connect,disconnect);
 panel.append(el('h4',{id:'gdriveHeading',className:'gdrive-heading',textContent:'Google Drive',hidden:true}),el('p',{id:'gdriveArchiveOff',className:'archive-mode',textContent:GDRIVE_ARCHIVE_OFF,hidden:true}),el('p',{id:'gdriveAccount',className:'archive-mode',hidden:true}),el('p',{id:'archiveMode',className:'archive-mode'}),el('p',{id:'gdriveSetup',className:'gdrive-setup',textContent:GDRIVE_SETUP,hidden:true}),el('p',{id:'gdriveAuthError',className:'gdrive-auth-error',hidden:true}),code,actions,status);
 return panel;
}
function showGdrive(a){
 // The account belongs to Drive: with archiving on it sits in the Drive card above the run details; off, it is a card of its own.
 const panel=gdrivePanel(),card=$('archiveSummary');
 if(a.enabled){if(panel.parentElement!==card||panel.nextElementSibling!==$('archiveHealth'))card.insertBefore(panel,$('archiveHealth'))}
 else if(panel.parentElement!==card.parentElement||panel.nextElementSibling)card.parentElement.append(panel);
 $('gdriveHeading').hidden=!!a.enabled;
 const g=a.gdrive||{},pending=g.pending&&typeof g.pending==='object'?g.pending:null,move=(a.effective_mode||a.mode)==='move';
 gdriveState=g;
 // Archiving off: a note and the account's state instead of the mode (nothing is copied or moved).
 $('gdriveArchiveOff').hidden=!!a.enabled;$('gdriveAccount').hidden=!!a.enabled;$('archiveMode').hidden=!a.enabled;
 $('gdriveAccount').textContent=a.enabled?'':'Drive 계정: '+gdriveAccountText(g);
 $('archiveMode').textContent=move?'이동 모드: 검증된 원격 사본이 있으면 로컬 원본이 삭제됩니다':'복제 모드: 로컬 파일은 보존됩니다';
 $('archiveMode').className=move?'archive-mode archive-warning':'archive-mode';
 $('gdriveSetup').hidden=!!g.configured;
 $('gdriveAuthError').textContent=g.last_auth_error?gdriveAuthText(g.last_auth_error):'';$('gdriveAuthError').hidden=!g.last_auth_error;
 // Of a waiting sign-in only user_code and verification_url are shown; expires_at drives the countdown.
 $('gdriveCode').hidden=!pending;
 if(pending){
  $('gdriveUserCode').textContent=String(pending.user_code??'');
  // Only an https address becomes a link; anything else is shown as text.
  const link=$('gdriveUrl'),address=String(pending.verification_url??'');let safe=null;
  try{const url=new URL(address);if(url.protocol==='https:')safe=url.href}catch{}
  link.textContent=address;if(safe)link.href=safe;else link.removeAttribute('href');
  gdriveExpires=Number(pending.expires_at)||0;gdriveShownCode=String(pending.user_code??'');
 }
 // Polls only while the panel is open and the page visible; reopening or returning fetches again first.
 gdriveCountdown();gdriveButtons();gdrivePoll(!!pending&&!storageDetails.hidden&&!document.hidden);
}
function gdriveButtons(){
 const g=gdriveState||{},pending=!$('gdriveCode').hidden;
 $('gdriveConnect').textContent=g.connected?'다시 연결':'Google Drive 연결';
 $('gdriveConnect').hidden=pending||(!!g.connected&&!g.last_auth_error);
 $('gdriveConnect').disabled=gdriveBusy||!g.configured;
 $('gdriveDisconnect').hidden=!g.connected;$('gdriveDisconnect').disabled=gdriveBusy;
}
// expires_at is the add-on's clock, which the browser's may not match: the countdown runs from the connect answer's
// expires_in (browser clock only), else from expires_at against the server's Date header. Unknown or past while
// the server still reports the code: no expiry is claimed.
function gdriveRemaining(){
 if(gdriveDeadline&&gdriveDeadline.code===gdriveShownCode)return gdriveDeadline.at-performance.now()/1000;
 return gdriveSkew===null?null:gdriveExpires-(Date.now()/1000+gdriveSkew);
}
function gdriveCountdown(){
 if(!$('gdriveCode')||$('gdriveCode').hidden)return;
 const left=gdriveRemaining(),remaining=left===null?0:Math.max(0,Math.ceil(left));
 $('gdriveCountdown').textContent=remaining?`코드 유효 시간 ${Math.floor(remaining/60)}:${String(remaining%60).padStart(2,'0')} 남음`:'코드 유효 시간을 확인하는 중입니다';
}
async function storageSnapshot(){
 // As api() for the storage block, plus the server's clock from the Date header.
 const response=await fetch('api/settings/storage',{cache:'no-store',headers:{'X-RoadViewer-Request':'1'},signal:AbortSignal.timeout(60000)});
 const date=Date.parse(response.headers.get('Date')||''),result=apiResult(response.status,await response.text());
 if(Number.isFinite(date))gdriveSkew=date/1000-Date.now()/1000;
 return result;
}
async function gdriveRefresh(){
 if(gdriveFetching||gdriveBusy)return;
 gdriveFetching=true;const generation=gdriveGeneration;
 try{const s=await storageSnapshot();if(generation===gdriveGeneration&&!storageDetails.hidden&&!document.hidden)showStorage(s)}
 catch(e){if($('gdriveStatus'))$('gdriveStatus').textContent=e.message}
 finally{gdriveFetching=false}
}
function gdrivePoll(on){
 // While a code waits the panel follows the sign-in every 3 s; the countdown ticks every second.
 if(!on){clearInterval(gdriveTimer);gdriveTimer=null;return}
 if(gdriveTimer)return;
 // Without the server's clock yet, the first fetch comes on the first tick.
 gdriveTick=gdriveSkew===null?2:0;
 gdriveTimer=setInterval(()=>{
  gdriveCountdown();
  if(++gdriveTick%3===0)void gdriveRefresh();
 },1000);
}
function hideGdrive(){gdrivePoll(false);gdriveState=null;$('gdrivePanel')?.remove()}
storageDetails.addEventListener('toggle',()=>{if(!!storageDetails.hidden)gdrivePoll(false)});
document.addEventListener('visibilitychange',()=>{if(document.hidden)gdrivePoll(false);else if(!storageDetails.hidden&&gdriveState?.pending)void gdriveRefresh()});
async function gdriveRequest(action){
 if(gdriveBusy)return;
 if(action==='disconnect'&&!confirm('Google Drive 연결을 해제할까요? Drive에 올린 파일과 목록은 그대로 유지되며, 다시 연결할 때까지 Drive 아카이빙과 재생이 멈춥니다.'))return;
 // A poll answer from before this request must not bring back the earlier state.
 gdriveBusy=true;gdriveGeneration++;gdriveButtons();$('gdriveStatus').textContent='';
 let message='';
 try{
  const result=await settingsRequest('api/settings/archive/gdrive/'+action),seconds=Number(result?.expires_in);
  if(action==='connect'&&Number.isFinite(seconds))gdriveDeadline={code:String(result.user_code??''),at:performance.now()/1000+seconds};
  if(action==='disconnect'){gdriveDeadline=null;message='Google Drive 연결을 해제했습니다.'}
 }
 catch(e){message=gdriveRequestError(e)}
 try{const s=await storageSnapshot();gdriveBusy=false;showStorage(s)}
 catch(e){message=message||e.message}
 finally{gdriveBusy=false;if($('gdrivePanel')){gdriveButtons();$('gdriveStatus').textContent=message}}
}
// 'Archive everything eligible': the server's plan is confirmed first; the run is followed in archive.manual.
const archiveMoves=a=>a?.backend!=='gdrive'||a?.effective_mode==='move';
const archiveAllLabel=a=>archiveMoves(a)?'이동 가능한 데이터 모두 이동':'복사 가능한 데이터 모두 복사';
const ARCHIVE_RUN_ERRORS={archive_running:'아카이빙이 이미 실행 중입니다. 끝난 뒤 다시 시도하세요.',archive_disabled:'아카이빙이 꺼져 있습니다.'};
const JOB_STOPS={disabled:'아카이빙이 꺼졌습니다.',internal_error:'내부 오류가 발생했습니다.'};
let archivePlanBusy=false,archiveJobTimer=null,archiveJobFetching=false;
const manualActive=()=>!!storageSnapshotState?.archive?.manual_active;
function planRow(label,value){const row=document.createElement('div'),dt=document.createElement('dt'),dd=document.createElement('dd');dt.textContent=label;dd.textContent=value;row.append(dt,dd);return row}
function showArchivePlan(plan){
 const move=plan.mode==='move',verb=move?'이동':'복사',target=plan.backend==='gdrive'?'Google Drive':'NAS';
 $('archiveAllTitle').textContent=move?'이동 가능한 데이터 모두 이동':'복사 가능한 데이터 모두 복사';
 const rows=[['처리할 파일',`${plan.files}개`],['주행 구간',`${plan.recordings}개`],['파일 용량',storageSize(plan.bytes)],['동작',`${target}로 ${verb} (${move?'MOVE':'COPY'})`],['로컬 원본 삭제',move?'검증 후 삭제':'삭제 안 함']];
 if(move)rows.splice(3,0,['예상 로컬 확보 용량',storageSize(plan.frees_bytes)]);
 $('archiveAllSummary').replaceChildren(...rows.map(([label,value])=>planRow(label,value)));
 $('archiveAllDelete').textContent=move?`${target}에 사본이 검증되고 기록이 확정된 파일만 이 기기에서 삭제됩니다. 실패한 파일의 로컬 원본은 유지되며, 원격 파일은 삭제하지 않습니다.`:plan.local_delete_blocked?'MOVE로 설정되어 있지만 로컬 원본 삭제가 허용되지 않아 복사만 합니다. 로컬 파일은 삭제되지 않고 로컬 공간도 줄지 않습니다.':'로컬 파일은 삭제되지 않고 로컬 공간도 줄지 않습니다. 이미 원격에 있는 사본은 다시 올리지 않습니다.';
 $('archiveAllDelete').className=move?'archive-mode archive-warning':'archive-mode';
 const ex=plan.excluded||{},age=Number(plan.min_age_hours)||0,ageText=age%24===0?`${age/24}일`:`${age}시간`,notes=[];
 if(ex.min_age)notes.push(`최소 보관 기간(${ageText})이 지나지 않은 ${ex.min_age}개 구간은 제외합니다.`);
 if(ex.pinned)notes.push(`고정된 ${ex.pinned}개 구간은 이동하지 않고 로컬에 유지합니다.`);
 if(ex.not_ready)notes.push(`변환 전이거나 처리 중인 ${ex.not_ready}개 구간은 제외합니다.`);
 $('archiveAllExcluded').replaceChildren(...notes.map(text=>Object.assign(document.createElement('li'),{textContent:text})));
 $('archiveAllConfirm').textContent=`${plan.files}개 파일 ${verb}`;
 $('archiveAllConfirm').disabled=!plan.files;
 $('archiveAllConfirm').className=move?'delete':'primary';
 $('archiveAllDescription').textContent=plan.files?'자동 실행의 배치 개수와 시작 기준 사용량을 적용하지 않고, 지금 처리할 수 있는 파일을 모두 처리합니다. 확인하기 전에는 아무것도 바뀌지 않습니다.':`지금 ${verb}할 수 있는 파일이 없습니다.`;
}
async function runArchive(){
 if(editorSaving||editorDirty()||archivePlanBusy||manualActive())return;
 archivePlanBusy=true;$('archiveRun').disabled=true;$('storageStatus').textContent='처리할 파일을 확인하는 중입니다.';
 try{
  const result=await api('api/settings/archive/run');
  if(result.running){$('storageStatus').textContent=ARCHIVE_RUN_ERRORS.archive_running;return}
  showArchivePlan(result.plan);$('storageStatus').textContent='';$('archiveAllDialog').showModal();
 }catch(e){$('storageStatus').textContent=ARCHIVE_RUN_ERRORS[e.code]||e.message}
 finally{archivePlanBusy=false;updateEditor()}
}
$('archiveAllCancel').onclick=()=>$('archiveAllDialog').close();
$('archiveAllConfirm').onclick=async()=>{
 if(archivePlanBusy)return;archivePlanBusy=true;$('archiveAllConfirm').disabled=true;
 try{
  const result=await settingsRequest('api/settings/archive/run');$('archiveAllDialog').close();
  const a=storageSnapshotState?.archive;if(a)Object.assign(a,{manual:result.manual,manual_active:true,running:true});
  $('storageStatus').textContent='';if(a){$('archiveRun').disabled=true;showArchiveJob(a)}
 }catch(e){$('archiveAllDialog').close();$('storageStatus').textContent=ARCHIVE_RUN_ERRORS[e.code]||e.message}
 finally{archivePlanBusy=false;$('archiveAllConfirm').disabled=false;updateEditor()}
};
// Bytes processed so far, the file being uploaded included (older runs record only files).
function archiveJobBytes(job){return Math.min(Number(job.total_bytes)||0,(Number(job.processed_bytes ?? job.bytes_done)||0)+(Number(job.current_bytes)||0))}
function archiveEta(seconds){
 const m=Math.round(seconds/60);
 if(m<1)return '1분 미만 남음';
 return m<60?`약 ${m}분 남음`:`약 ${Math.floor(m/60)}시간${m%60?` ${m%60}분`:''} 남음`;
}
function archiveJobText(job,drive){
 const verb=job.mode==='move'?'이동':'복사',done=`성공 ${job.succeeded}개 · 실패 ${job.failed}개`;
 // Before its first file a run may wait for the archive's startup checks (after a restart): their progress is shown.
 if(job.state==='running'&&job.checking&&job.checking.total)return `${verb} 준비 중 · 보관본 확인 ${job.checking.done}/${job.checking.total}`;
 if(job.state==='running'){
  const bytes=Number(job.total_bytes)>0?` · ${storageSize(archiveJobBytes(job))} / ${storageSize(job.total_bytes)}`:'';
  const wait=job.waiting==='uploading'?'업로드가 끝나기를 기다리는 중':job.waiting==='processing'?'변환이 끝나기를 기다리는 중':'';
  const rate=Number(job.rate),speed=wait||(Number.isFinite(rate)&&job.rate!==null?`${storageSize(rate)}/s`+(Number.isFinite(job.eta_seconds)&&job.eta_seconds!==null?` · ${archiveEta(job.eta_seconds)}`:''):'속도 계산 중');
  return `${verb} 중 · ${job.processed}/${job.total_files}개 파일${bytes}\n${speed} (${done})`;
 }
 const freed=job.mode==='move'?` · 로컬 ${storageSize(job.freed_bytes||0)} 확보`:'';
 if(job.state==='done')return `${verb} 완료 · ${job.succeeded}개 파일${freed}`;
 if(job.state==='partial')return `일부 완료 · ${done}${freed}. 실패한 파일의 로컬 원본은 그대로 유지됩니다.`;
 if(job.state==='failed')return `중단됨: ${(drive?DRIVE_ERRORS:ARCHIVE_ERRORS)[job.error]||JOB_STOPS[job.error]||job.error} · ${done}. 완료된 파일은 유지되고, 처리하지 못한 파일의 로컬 원본은 보존됩니다.`;
 return `완료되지 않고 중단됨(앱 재시작 등) · ${done}. 완료된 파일은 유지되고 나머지는 로컬에 남아 있습니다. 다시 실행할 수 있습니다.`;
}
function showArchiveJob(a){
 const job=a?.manual,box=$('archiveJob');
 box.hidden=!job;if(!job){archiveJobPoll(false);return}
 box.dataset.state=job.state;
 // By bytes while running (the file being uploaded moves the bar too), else by files.
 const progress=$('archiveJobProgress'),bytes=job.state==='running'&&Number(job.total_bytes)>0,total=bytes?Number(job.total_bytes):Math.max(1,Number(job.total_files)||0);
 progress.max=total;progress.value=job.state==='done'?total:Math.min(total,bytes?archiveJobBytes(job):Number(job.processed)||0);
 $('archiveJobText').textContent=archiveJobText(job,a.backend==='gdrive');
 archiveJobPoll(!!a.manual_active&&!storageDetails.hidden&&!document.hidden);
}
async function archiveJobRefresh(){
 if(archiveJobFetching)return;archiveJobFetching=true;
 try{const s=await storageSnapshot();if(!storageDetails.hidden)showStorage(s)}catch{}
 finally{archiveJobFetching=false}
}
function archiveJobPoll(on){
 if(!on){clearInterval(archiveJobTimer);archiveJobTimer=null;return}
 if(!archiveJobTimer)archiveJobTimer=setInterval(()=>void archiveJobRefresh(),2000);
}
// The server answers 'checking' while it probes the archive, and usage_measuring while it measures Drive's usage, in
// the background (it never waits on the internet): the panel asks again shortly until both are settled, at most ARCHIVE_CHECK_TRIES times in a row.
const ARCHIVE_CHECK_TRIES=20;let archiveCheckTimer=null,archiveCheckTries=0;
function archiveCheckPoll(a){
 const pending=!!a?.enabled&&(a.state==='checking'||!!a.usage_measuring);
 const checking=pending&&!storageDetails.hidden&&!document.hidden;
 if(!checking){clearTimeout(archiveCheckTimer);archiveCheckTimer=null;if(!pending)archiveCheckTries=0;return}
 if(archiveCheckTimer||archiveCheckTries>=ARCHIVE_CHECK_TRIES)return;
 archiveCheckTries++;
 archiveCheckTimer=setTimeout(()=>{archiveCheckTimer=null;void archiveJobRefresh()},2000);
}
storageDetails.addEventListener('toggle',()=>{archiveCheckTries=0;if(!!storageDetails.hidden){archiveJobPoll(false);archiveCheckPoll(null)}});
document.addEventListener('visibilitychange',()=>{if(document.hidden){archiveJobPoll(false);archiveCheckPoll(null)}else if(!storageDetails.hidden&&(manualActive()||storageSnapshotState?.archive?.state==='checking'||storageSnapshotState?.archive?.usage_measuring)){archiveCheckTries=0;void archiveJobRefresh()}});
const archiveForm=$('archiveForm');
let editorLoaded=false,editorLoading=false,editorSaving=false,archiveSettingsNeedsSave=false,savedStorage=null,savedArchive=null,storageSnapshotState=null;
const archivePresets=[['archiveAgePreset','archive_min_age_hours','archiveAgeCustom'],['archiveThresholdPreset','archive_local_threshold_mb','archiveThresholdCustom'],['archiveIntervalPreset','archive_interval_minutes','archiveIntervalCustom']];
const archiveInputs=()=>[...archiveForm.querySelectorAll('[name^="archive_"]')];
function archiveValues(){
 const data={};
 for(const field of archiveInputs()){
  if(field.type==='radio'&&!field.checked)continue;
  data[field.name]=field.type==='checkbox'?field.checked:field.type==='number'||'number' in field.dataset?(field.value===''?null:Number(field.value)):field.value;
 }
 return data;
}
// Sizes are typed in GB with decimals; the archive start is stored in whole MB, the local limit in bytes.
const gbText=gb=>String(Math.round(gb*1000)/1000);
function syncThresholdGb(){const mb=archiveForm.elements.archive_local_threshold_mb.value;$('archiveThresholdGb').value=mb===''?'':gbText(Number(mb)/1024)}
$('archiveThresholdGb').addEventListener('input',()=>{const gb=$('archiveThresholdGb').value;archiveForm.elements.archive_local_threshold_mb.value=gb===''||!(Number(gb)>=0)?'':String(Math.round(Number(gb)*1024))});
function localStorageValues(){
 const custom=$('storageLimit').value==='custom',gb=Number(custom?$('storageCustom').value:$('storageLimit').value);
 return {max_bytes:custom&&$('storageCustom').value===''?null:Math.round(gb*1073741824),policy:$('storagePolicy').value};
}
const sameSettings=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
function editorDirty(){return editorLoaded&&(archiveSettingsNeedsSave||!sameSettings(archiveValues(),savedArchive)||!sameSettings(localStorageValues(),savedStorage))}
function editorStatus(text,state){$('archiveSettingsStatus').textContent=text;$('archiveSettingsStatus').dataset.state=state}
function syncPreset(selectId,name,customId){
 const select=$(selectId),value=archiveForm.elements[name].value;
 select.value=[...select.options].some(option=>option.value===value)?value:'custom';
 $(customId).hidden=select.value!=='custom';select.dispatchEvent(new Event('rv:sync'));
}
function fillArchiveSettings(data){
 for(const field of archiveInputs()){
  if(!(field.name in data))continue;
  if(field.type==='radio')field.checked=field.value===data[field.name];
  else if(field.type==='checkbox')field.checked=data[field.name];else field.value=String(data[field.name]);
 }
 for(const preset of archivePresets)syncPreset(...preset);
 syncThresholdGb();
}
function fillLocalSettings(data){
 const gb=data.max_bytes/1073741824;
 $('storageLimit').value=[0,10,20,50,100].includes(gb)?String(gb):'custom';$('storageCustom').value=gbText(gb||10);$('storagePolicy').value=data.policy;
 for(const id of ['storageLimit','storagePolicy'])$(id).dispatchEvent(new Event('rv:sync'));
}
function archiveFields(){
 if(!editorLoaded)return;
 const drive=archiveForm.elements.archive_backend.value==='gdrive',move=archiveForm.elements.archive_mode.value==='move',remove=archiveForm.elements.archive_allow_local_delete.checked;
 for(const label of archiveForm.querySelectorAll('[data-archive-backend]')){
  label.hidden=(label.dataset.archiveBackend==='gdrive')!==drive;
  for(const input of label.querySelectorAll('input'))input.disabled=label.hidden;
 }
 $('archiveModeChoices').hidden=!drive;$('archiveNasMode').hidden=drive;$('archiveRemoval').hidden=!drive||!move;
 const warning=drive?(move?(remove?'이동 모드 + 로컬 원본 삭제 허용: Google Drive에 검증된 사본이 생기면 이 기기의 원본이 삭제됩니다':'로컬 원본 삭제를 허용하지 않아 COPY로 동작합니다.'):'복제(COPY): 로컬 원본을 유지합니다.'):'NAS는 모드 선택과 관계없이 항상 이동(MOVE)하며, 검증 후 로컬 원본을 삭제합니다.';
 $('archiveWarning').textContent=drive&&move&&!remove?warning:'';$('archiveWarning').className='archive-mode';
 $('storageCustomLabel').hidden=$('storageLimit').value!=='custom';$('storageCustom').required=!$('storageCustomLabel').hidden;
 const soft=drive&&move&&remove;
 $('storagePolicyField').hidden=soft;
 $('storagePolicyInfo').textContent=soft?'Google Drive MOVE의 로컬 한도는 소프트 리밋입니다. 한도와 아카이빙 시작 기준 중 낮은 값에 도달하면 업로드 시 즉시 MOVE를 요청합니다. 실제 디스크 여유가 부족할 때만 업로드를 거부하며, 예약·임시 파일·100 MiB 안전 여유를 확보하면 한도를 일시적으로 초과할 수 있습니다. Drive 파일과 주행 기록은 자동 삭제하지 않습니다.':'아카이빙 시작 기준은 정기 실행 시 파일 보관을 시작할 사용량입니다. COPY는 로컬 공간을 줄이지 않습니다. COPY·NAS의 로컬 최대 사용량은 기존 업로드 제한·자동 삭제 정책을 따릅니다. Drive 파일이 연결된 기록은 자동 삭제 대상에서 제외됩니다.';
 renderStoragePreview();
}
function renderStoragePreview(){
 if(!editorLoaded)return;
 const data=archiveValues(),local=localStorageValues(),drive=data.archive_backend==='gdrive',soft=drive&&data.archive_mode==='move'&&data.archive_allow_local_delete;
 const destination=drive?'Google Drive':'NAS',moving=!drive||soft;
 const age=data.archive_min_age_hours,ageText=age===0?'보관 기간 제한 없이':age>0?(age%24===0?`${age/24}일`:`${age}시간`)+' 이상 지난':'';
 const threshold=data.archive_local_threshold_mb*1048576,thresholdText=threshold>0?storageSize(threshold):'사용량 조건 없음';
 const limit=local.max_bytes,limitText=limit>0?storageSize(limit):'제한 없음';
 $('capacityThresholdText').textContent=thresholdText;$('capacityLimitText').textContent=limitText+(soft&&limit>0?' · 소프트 리밋':'');
 const scale=Math.max(threshold||0,limit||0,1)*1.2;
 for(const [id,amount] of [['capacityThresholdMarker',threshold],['capacityLimitMarker',limit]]){$(id).hidden=!(amount>0);$(id).style.left=Math.min(94,amount/scale*100)+'%'}
 const when=threshold>0?`로컬 데이터가 ${thresholdText}를 넘으면`:'로컬 사용량과 관계없이';
 let summary=`${when} ${ageText} 주행 데이터를 ${destination}로 ${moving?'이동':'복제'}합니다. `;
 summary+=moving?'검증과 저장 기록 확정이 끝난 로컬 원본만 삭제합니다. ':'로컬 원본도 유지하므로 로컬 공간은 줄어들지 않습니다. ';
 if(drive)summary+='Drive의 파일과 주행 기록은 계속 유지됩니다.';
 if(!data.archive_enabled)summary='자동 아카이빙이 꺼져 있어 자동 전송하지 않습니다. 켜면 다음 기준으로 동작합니다. '+summary;
 $('storageBehaviorSummary').textContent=summary;
 const interval=data.archive_interval_minutes,intervalText=interval%60===0?`${interval/60}시간`:`${interval}분`;
 let detail=`${intervalText}마다 최대 ${data.archive_batch}개 파일을 처리합니다. `;
 if(soft){
  const trigger=Math.min(...[threshold,limit].filter(value=>value>0));
  if(Number.isFinite(trigger))detail+=`새 업로드 시에는 ${storageSize(trigger)}부터 MOVE를 요청합니다. `;
  detail+='고정·사용 중·최소 보관 기간·배치 제한을 유지하며, Drive 장애 시에도 원본을 보존합니다. 디스크 안전 여유가 있으면 로컬 한도를 초과한 업로드도 허용합니다.';
 }else detail+=local.policy==='delete_oldest'?'로컬 한도 초과 시 오래된 미고정 로컬 기록을 정리합니다. Drive 파일이 연결된 기록은 삭제하지 않습니다.':'로컬 한도 초과 시 새 업로드를 거부하고 기존 기록을 유지합니다.';
 $('storageBehaviorDetail').textContent=detail;
 $('storagePreviewState').textContent=editorDirty()?'미저장 설정 미리보기 · 저장 후 적용':'저장된 설정';
}
function updateEditor(changed=false){
 if(!editorLoaded)return;
 archiveFields();const dirty=editorDirty();
 archiveForm.setAttribute('aria-busy',String(editorSaving));
 $('storageSave').disabled=editorSaving||!dirty;$('storageReset').hidden=!dirty;$('storageReset').disabled=editorSaving;
 if(changed)editorStatus(dirty?'미저장 변경사항이 있습니다.':'저장된 설정과 같습니다.',dirty?'dirty':'idle');
 const manual=manualActive(),a=storageSnapshotState?.archive;
 // While a manual run works from the saved settings, they cannot be changed.
 $('storageEditorFields').disabled=editorSaving||manual;
 const run=$('archiveRun');if(run)run.disabled=editorSaving||dirty||manual||archivePlanBusy||!!a?.running;
 $('archiveRunHint').textContent=manual?'수동 아카이빙이 진행 중입니다. 끝날 때까지 설정을 바꿀 수 없습니다.':dirty?'미저장 변경사항을 저장하거나 취소한 뒤 실행하세요.':a?.enabled?`저장된 설정으로 배치 개수·시작 기준과 관계없이 ${archiveMoves(a)?'이동':'복사'} 가능한 데이터를 모두 처리합니다. 실행 전에 확인합니다.`:'자동 아카이빙이 꺼져 있습니다. 설정을 저장해 켠 뒤 실행할 수 있습니다.';
}
async function loadStorageEditor(){
 if(editorLoading)return;editorLoading=true;$('storageRetry').hidden=true;
 try{
  if(editorLoaded){showStorage(await api('api/settings/storage'));return}
  const [storage,archive]=await Promise.all([api('api/settings/storage'),api('api/settings/archive')]);
  fillLocalSettings(storage);fillArchiveSettings(archive);archiveSettingsNeedsSave=!!archive.settings_error;savedStorage=localStorageValues();savedArchive=archiveValues();editorLoaded=true;
  archiveForm.dataset.loaded='true';$('storageEditorFields').disabled=false;showStorage(storage);updateEditor();
  editorStatus(archive.settings_error?'아카이빙 설정을 읽지 못해 꺼졌습니다. 설정을 확인하고 저장하세요. ('+archive.settings_error+')':'저장된 설정을 불러왔습니다.',archive.settings_error?'error':'idle');
 }catch(e){editorStatus('설정을 불러오지 못했습니다. '+e.message,'error');$('storageRetry').hidden=false}
 finally{editorLoading=false}
}
storageDetails.addEventListener('toggle',()=>{if(!storageDetails.hidden)void loadStorageEditor()});
for(const [id,name,custom] of archivePresets){
 $(id).addEventListener('change',()=>{
  $(custom).hidden=$(id).value!=='custom';
  if($(id).value!=='custom')archiveForm.elements[name].value=$(id).value;
  if(name==='archive_local_threshold_mb')syncThresholdGb();
  updateEditor(true);
 });
}
archiveForm.addEventListener('input',()=>updateEditor(true));archiveForm.addEventListener('change',()=>updateEditor(true));
archiveForm.addEventListener('invalid',e=>{const details=e.target.closest('details');if(details)details.open=true},true);
$('storageRetry').onclick=()=>void loadStorageEditor();
$('storageReset').onclick=()=>{fillLocalSettings(savedStorage);fillArchiveSettings(savedArchive);updateEditor();editorStatus('변경을 취소했습니다.','idle')};
archiveForm.onsubmit=async e=>{
 e.preventDefault();if(!editorLoaded||editorSaving)return;
 const archive=archiveValues(),local=localStorageValues(),archiveDirty=archiveSettingsNeedsSave||!sameSettings(archive,savedArchive),localDirty=!sameSettings(local,savedStorage);
 if(!archiveDirty&&!localDirty)return;
 if(!Number.isSafeInteger(local.max_bytes)||local.max_bytes<0||($('storageLimit').value==='custom'&&local.max_bytes===0)){editorStatus('올바른 로컬 용량을 입력하세요.','error');return}
 const soft=archive.archive_backend==='gdrive'&&archive.archive_mode==='move'&&archive.archive_allow_local_delete;
 if(!soft&&local.policy==='delete_oldest'&&(localDirty||(savedArchive.archive_backend==='gdrive'&&savedArchive.archive_mode==='move'&&savedArchive.archive_allow_local_delete))&&!confirm('로컬 공간이 부족하면 오래된 미고정 로컬 기록을 자동으로 완전 삭제합니다. Drive 파일이 연결된 기록은 유지합니다. 저장할까요?'))return;
 editorSaving=true;$('storageEditorFields').disabled=true;editorStatus('설정을 저장하는 중입니다.','saving');updateEditor();
 const applied=[];
 try{
  // Apply the archive mode first so a newly selected Drive MOVE protection is
  // effective before a lower local quota. Each API has its own durable commit.
  if(archiveDirty){const saved=await settingsRequest('api/settings/archive',archive);fillArchiveSettings(saved);savedArchive=archiveValues();archiveSettingsNeedsSave=false;applied.push('아카이빙 설정')}
  if(localDirty){const saved=await settingsRequest('api/settings/storage',local);savedStorage={max_bytes:saved.max_bytes,policy:saved.policy};showStorage(saved);applied.push('로컬 용량 설정')}
  let refreshed=true;
  if(!localDirty)try{showStorage(await api('api/settings/storage'))}catch{refreshed=false}
  editorStatus(refreshed?'저장했습니다. 재시작 없이 적용되었습니다.':'설정은 저장됐습니다. 현재 사용량을 갱신하지 못해 저장공간 탭을 다시 열어 확인해 주세요.','saved');
 }catch(e){
  const message=e.code==='archive_running'?'아카이빙이 실행 중입니다. 완료 후 저장하세요.':e.message;
  editorStatus((applied.length?applied.join(' · ')+'은 저장됐지만 나머지는 저장하지 못했습니다. ':'')+message,'error');
 }finally{editorSaving=false;$('storageEditorFields').disabled=false;updateEditor()}
};

async function loadDevices(){
 const data=await api('api/settings/devices');$('deviceStatus').textContent=data.configuration_error||(data.enabled?`HTTPS 장치 API가 켜져 있습니다.${data.host_port?' · 호스트 포트 '+data.host_port:''}`:'외부 API가 꺼져 있습니다. 위에서 외부 연결을 켜고 포트를 저장한 뒤 재시작하세요.');$('pairOpen').disabled=!data.enabled;
 $('deviceList').replaceChildren(...data.devices.map(d=>{
  const row=document.createElement('div');row.className='device-row';const info=document.createElement('div'),name=document.createElement('strong'),meta=document.createElement('p'),button=document.createElement('button');name.textContent=d.name||d.device_id;
  meta.textContent=`${d.revoked?'연결 해제됨':'활성'} · ${d.dongle_id||d.device_id} · 등록 ${new Date(d.registered_at*1000).toLocaleString()} · 마지막 인증 ${d.last_seen?new Date(d.last_seen*1000).toLocaleString():'없음'}`;
  button.textContent=d.revoked?'목록 제거':'연결 해제';button.type='button';
  button.onclick=async()=>{
   const message=d.revoked?`${d.name||d.device_id} 장치를 목록에서 제거할까요? 업로드한 로그와 영상은 유지됩니다.`:`${d.name||d.device_id} 장치의 인증을 해제할까요? 진행 중인 업로드도 더 이상 이어갈 수 없습니다.`;
   if(!confirm(message))return;button.disabled=true;
   try{await settingsRequest(`api/settings/devices/${d.device_id}${d.revoked?'':'/revoke'}`,null,d.revoked?'DELETE':'POST');await loadDevices()}
   catch(e){$('deviceStatus').textContent=e.message;button.disabled=false}
  };
  info.append(name,meta);row.append(info,button);return row;
 }));
}
deviceDetails.addEventListener('toggle',()=>{if(!deviceDetails.hidden){loadNetwork();loadDevices().catch(e=>$('deviceStatus').textContent=e.message)}});
function renderPairing(p){
 const remaining=Math.max(0,Math.ceil((p.expires_at||0)-Date.now()/1000));
 const waiting=p.status==='waiting'&&remaining>0,paired=p.status==='paired';
 $('pairDialog').dataset.state=waiting?'waiting':paired?'paired':'expired';
 // Each new code appears digit by digit; the same code is left alone between polls.
 const code=waiting?p.code||'':'';if($('pairCode').textContent!==code)$('pairCode').replaceChildren(...[...code].map((c,i)=>{const s=document.createElement('span');s.textContent=c;s.style.setProperty('--i',i);return s}));$('pairCopy').disabled=!waiting;
 $('pairCode').parentElement.hidden=!waiting;$('pairEmpty').hidden=waiting;
 $('pairEmpty').textContent=paired?'연결 완료':'코드가 만료되었습니다';
 $('pairState').textContent=waiting?'연결 대기':paired?'인증 완료':'유효 기간 종료';
 $('pairDescription').textContent=paired?'이제 장치에서 로그와 영상을 업로드할 수 있습니다.':'장치의 Road Viewer 연결 화면에 아래 코드를 입력하세요.';
 $('pairLifetime').hidden=!waiting;$('pairLifetime').value=remaining;
 $('pairStatus').textContent=paired?'장치가 연결되었습니다.':waiting?`연결 대기 중 · ${remaining}초 남음`:'새 코드를 발급해 다시 연결하세요.';
 $('pairClose').textContent=waiting?'취소':'닫기';
 if(!waiting){clearInterval(pairingTimer);pairingTimer=null;if(paired)loadDevices().catch(e=>$('deviceStatus').textContent=e.message)}
}
function pollPairing(generation){
 clearInterval(pairingTimer);
 pairingTimer=setInterval(async()=>{
  if(pairingBusy)return;pairingBusy=true;
  try{const status=await api('api/settings/devices/pairing');if(generation===pairingGeneration)renderPairing(status)}
  catch(e){if(generation===pairingGeneration)$('pairStatus').textContent=e.message}
  finally{pairingBusy=false}
 },1000);
}
async function issuePairing(){
 if(pairingIssuing)return;
 pairingIssuing=true;const generation=++pairingGeneration;
 clearInterval(pairingTimer);resetPairCopy();
 $('pairOpen').disabled=true;$('pairRenew').disabled=true;$('pairClose').disabled=true;$('pairCopy').disabled=true;
 try{
  const p=await settingsRequest('api/settings/devices/pairing');
  if(!$('pairDialog').open)$('pairDialog').showModal();
  renderPairing(p);if(p.status==='waiting')pollPairing(generation);
 }catch(e){
  if($('pairDialog').open){$('pairStatus').textContent=e.message;pollPairing(generation)}
  else $('deviceStatus').textContent=e.message;
 }finally{pairingIssuing=false;$('pairOpen').disabled=false;$('pairRenew').disabled=false;$('pairClose').disabled=false}
}
$('pairOpen').onclick=issuePairing;
$('pairRenew').onclick=()=>{$('pairRenew').classList.remove('spin-once');void $('pairRenew').offsetWidth;$('pairRenew').classList.add('spin-once');issuePairing()};
$('pairDialog').addEventListener('cancel',e=>{if(pairingIssuing)e.preventDefault()});
$('pairCopy').onclick=async()=>{
 const code=$('pairCode').textContent,generation=pairingGeneration;if(!code)return;
 clearTimeout(pairCopyTimer);let copied=false;
 try{await copyTextToClipboard(code,$('pairCopy'));copied=true}catch{}
 if(generation!==pairingGeneration||$('pairCode').textContent!==code)return;
 clearTimeout(pairCopyTimer);
 $('pairCopyIcon').textContent=copied?'✓':'!';popIcon($('pairCopyIcon'));
 $('pairCopyStatus').textContent=copied?'페어링 코드를 복사했습니다.':'복사하지 못했습니다.';
 $('pairCopy').title=copied?'페어링 코드 복사':'복사하지 못했습니다. 다시 시도해 주세요.';
 pairCopyTimer=setTimeout(resetPairCopy,1800);
};
$('pairClose').onclick=()=>{$('pairDialog').close()};
$('pairDialog').addEventListener('close',()=>{pairingGeneration++;clearInterval(pairingTimer);pairingTimer=null;$('pairCode').textContent='';$('pairCopy').disabled=true;resetPairCopy();settingsRequest('api/settings/devices/pairing',null,'DELETE').catch(e=>$('deviceStatus').textContent=e.message)});

let networkSettings=null,networkSaving=false,networkDirty=false;
function networkFormState(){
 const enabled=$('deviceNetworkEnabled').checked,locked=networkSaving||networkRestarting||!networkSettings;
 $('deviceNetworkEnabled').disabled=locked;$('devicePortField').hidden=!enabled;
 $('deviceNetworkPort').disabled=locked||!enabled;$('deviceNetworkPort').required=enabled;
 $('deviceNetworkState').textContent=enabled?'켜짐':'꺼짐';
 $('deviceNetworkSave').disabled=locked||!networkDirty;
 $('deviceNetworkRestart').disabled=locked||networkDirty;
}
function showNetwork(data){
 networkSettings=data;networkDirty=false;
 $('deviceNetworkEnabled').checked=data.configured_port!==null;
 if(data.configured_port!==null)$('deviceNetworkPort').value=String(data.configured_port);
 $('deviceNetworkRestart').hidden=!data.restart_required;
 $('deviceNetworkStatus').textContent=data.restart_error||(data.restart_required?`저장됨 · 재시작 후 적용됩니다. 현재는 ${data.active_port===null?'꺼짐':data.active_port+' 포트로 켜짐'} 상태입니다.`:data.active_port===null?'외부 연결이 꺼져 있습니다.':`외부 연결이 ${data.active_port} 포트로 켜져 있습니다.`);
 networkFormState();
}
async function loadNetwork(){
 if(networkSaving||networkRestarting||networkDirty)return;
 try{const data=await api('api/settings/device-network');if(!networkDirty&&!networkSaving&&!networkRestarting)showNetwork(data)}
 catch(e){$('deviceNetworkStatus').textContent=e.message}
}
$('deviceNetworkEnabled').onchange=()=>{networkDirty=true;networkFormState()};
$('deviceNetworkPort').oninput=()=>{networkDirty=true;networkFormState()};
$('deviceNetworkForm').onsubmit=async e=>{
 e.preventDefault();if(networkSaving||networkRestarting)return;
 const enabled=$('deviceNetworkEnabled').checked,port=enabled?Number($('deviceNetworkPort').value):null;
 if(enabled&&(!Number.isInteger(port)||port<1||port>65535)){$('deviceNetworkStatus').textContent='포트는 1~65535 사이의 정수로 입력하세요.';return}
 networkSaving=true;networkFormState();
 try{showNetwork(await settingsRequest('api/settings/device-network',{enabled,port}))}
 catch(e){$('deviceNetworkStatus').textContent=e.message}
 finally{networkSaving=false;networkFormState()}
};
$('deviceNetworkRestart').onclick=async()=>{
 if(networkRestarting||networkDirty||!networkSettings)return;
 if(busy){$('deviceNetworkStatus').textContent='파일 업로드가 끝난 뒤 재시작하세요.';return}
 if(!confirm('Road Viewer를 재시작해 저장한 네트워크 설정을 적용할까요? 진행 중인 업로드·재생이 끊기고 변환 중인 로그는 다시 처리될 수 있습니다.'))return;
 const bootId=networkSettings.boot_id;networkRestarting=true;networkFormState();
 $('deviceNetworkStatus').textContent='재시작을 요청하고 있습니다…';
 try{await settingsRequest('api/settings/device-network/restart',{})}
 catch(e){
  // A dropped response can mean Supervisor has already stopped this worker.
  if(e.code){networkRestarting=false;networkFormState();$('deviceNetworkStatus').textContent=e.message;return}
 }
 $('deviceNetworkStatus').textContent='Road Viewer를 재시작하고 있습니다. 다시 연결되면 적용 상태를 표시합니다…';
 const deadline=Date.now()+180000;
 while(Date.now()<deadline){
  await new Promise(resolve=>setTimeout(resolve,2000));
  try{
   const response=await fetch('api/settings/device-network',{cache:'no-store',signal:AbortSignal.timeout(5000)});
   if(!response.ok)continue;
   const data=await response.json();
   if(data.boot_id!==bootId){networkRestarting=false;showNetwork(data);void loadDevices().catch(e=>$('deviceStatus').textContent=e.message);void refresh();return}
   if(data.restart_error&&!data.restarting){networkRestarting=false;showNetwork(data);return}
  }catch{}
 }
 networkRestarting=false;networkFormState();
 $('deviceNetworkStatus').textContent='아직 재시작 완료를 확인하지 못했습니다. 잠시 후 장치 탭을 다시 열어 확인하세요. 앱이 시작되지 않으면 Home Assistant의 Road Viewer 로그를 확인하세요.';
};
// The tab shown at load (a #storage or #devices link, or the last tab) loads like a freshly opened panel.
if(!storageDetails.hidden)void loadStorageEditor();
if(!deviceDetails.hidden){loadNetwork();loadDevices().catch(e=>$('deviceStatus').textContent=e.message)}
void refreshHeaderStorage();
