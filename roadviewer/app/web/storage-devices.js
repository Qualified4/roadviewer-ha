'use strict';
// Credentials and pairing codes are never persisted in browser storage.
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
 $('storageUsed').textContent=storageSize(s.used_bytes);
 $('storageMaximum').textContent=s.max_bytes?storageSize(s.max_bytes):'제한 없음';
 $('storageFree').textContent=storageSize(s.free_bytes);
 $('storageReserved').textContent=storageSize(s.reserved_bytes);
 showArchive(s.archive);
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
 // Archiving off: the panel keeps exactly its four local metrics. The share's path is never shown.
 for(const row of document.querySelectorAll('#storageUsage>.archive-metric'))row.remove();
 $('archiveRun')?.remove();
 // A block without a backend is the NAS and shows as before; nothing of Drive is created for it.
 // Drive's sign-in does not need archiving on: with it off, only the connection panel is shown.
 const drive=a?.backend==='gdrive';
 if(!drive)hideGdrive();
 if(!a?.enabled){if(drive)showGdrive(a);return}
 const rows=drive?gdriveRows(a):[['NAS 상태',ARCHIVE_STATES[a.state]||'확인 중'],['NAS 사용 중',storageSize(a.used_bytes)],['NAS 여유',storageSize(a.free_bytes)],['마지막 아카이브',a.last_cycle_at?new Date(a.last_cycle_at*1000).toLocaleString():'—']];
 $('storageUsage').append(...rows.map(([label,value])=>{const row=document.createElement('div'),dt=document.createElement('dt'),dd=document.createElement('dd');row.className='archive-metric';dt.textContent=label;dd.textContent=value;row.append(dt,dd);return row}));
 const button=document.createElement('button');button.id='archiveRun';button.type='button';button.textContent='지금 아카이브';button.disabled=!!a.running;button.onclick=runArchive;$('storageUsage').after(button);
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
 const g=a.gdrive||{};
 return [['저장소','Google Drive'],['Drive 상태',gdriveStatusText(g,a.state)],['Drive 사용 중',storageSize(a.used_bytes)],['Drive 여유',a.usage_reliable?storageSize(a.free_bytes):'할당량 확인 불가'],
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
 panel.append(el('p',{id:'gdriveArchiveOff',className:'archive-mode',textContent:GDRIVE_ARCHIVE_OFF,hidden:true}),el('p',{id:'gdriveAccount',className:'archive-mode',hidden:true}),el('p',{id:'archiveMode',className:'archive-mode'}),el('p',{id:'gdriveSetup',className:'gdrive-setup',textContent:GDRIVE_SETUP,hidden:true}),el('p',{id:'gdriveAuthError',className:'gdrive-auth-error',hidden:true}),code,actions,status);
 ($('archiveRun')||$('storageUsage')).after(panel);
 return panel;
}
function showGdrive(a){
 gdrivePanel();
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
 gdriveCountdown();gdriveButtons();gdrivePoll(!!pending&&storageDetails.open&&!document.hidden);
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
 try{const s=await storageSnapshot();if(generation===gdriveGeneration&&storageDetails.open&&!document.hidden)showStorage(s)}
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
storageDetails.addEventListener('toggle',()=>{if(!storageDetails.open)gdrivePoll(false)});
document.addEventListener('visibilitychange',()=>{if(document.hidden)gdrivePoll(false);else if(storageDetails.open&&gdriveState?.pending)void gdriveRefresh()});
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
async function runArchive(){
 $('archiveRun').disabled=true;
 try{await settingsRequest('api/settings/archive/run');$('storageStatus').textContent='아카이브를 시작했습니다.'}
 catch(e){$('storageStatus').textContent={archive_running:'아카이빙이 이미 실행 중입니다.',archive_disabled:'아카이빙이 꺼져 있습니다.'}[e.code]||e.message;$('archiveRun').disabled=false}
}
storageDetails.addEventListener('toggle',async()=>{
 if(!storageDetails.open)return;
 void loadArchiveSettings();
 try{const s=await api('api/settings/storage');showStorage(s);const gb=s.max_bytes/1073741824;$('storageLimit').value=[0,10,20,50,100].includes(gb)?String(gb):'custom';$('storageCustom').value=gb||10;$('storageCustomLabel').hidden=$('storageLimit').value!=='custom';$('storagePolicy').value=s.policy;for(const id of ['storageLimit','storagePolicy'])$(id).dispatchEvent(new Event('rv:sync'));$('storageSave').disabled=false}catch(e){$('storageStatus').textContent=e.message}
});
const archiveForm=$('archiveForm');
function archiveFields(){
 const drive=archiveForm.elements.archive_backend.value==='gdrive',move=archiveForm.elements.archive_mode.value==='move',remove=archiveForm.elements.archive_allow_local_delete.checked;
 for(const label of archiveForm.querySelectorAll('[data-archive-backend]')){
  label.hidden=(label.dataset.archiveBackend==='gdrive')!==drive;
  // Hidden inputs retain their values, but do not block the visible form's native validation.
  for(const input of label.querySelectorAll('input'))input.disabled=label.hidden;
 }
 const warning=drive?(move?(remove?'이동 모드 + 로컬 원본 삭제 허용: Google Drive에 검증된 사본이 생기면 이 기기의 원본이 삭제됩니다':'로컬 원본 삭제를 허용하지 않아 COPY로 동작합니다.'):'복제(COPY): 로컬 원본을 유지합니다.'):'NAS는 모드 선택과 관계없이 항상 이동(MOVE)하며, 검증 후 로컬 원본을 삭제합니다.';
 $('archiveWarning').textContent=warning;$('archiveWarning').className=drive&&move&&remove?'archive-mode archive-warning':'archive-mode';
}
function showArchiveSettings(data){
 for(const field of archiveForm.querySelectorAll('[name]')){
  if(!(field.name in data))continue;
  if(field.type==='checkbox')field.checked=data[field.name];else field.value=String(data[field.name]);
  field.dispatchEvent(new Event('rv:sync'));
 }
 archiveFields();$('archiveSave').disabled=false;
 $('archiveSettingsStatus').textContent=data.settings_error?'아카이빙 설정을 읽지 못해 꺼졌습니다. 설정을 확인하고 저장하세요. ('+data.settings_error+')':'';
}
async function loadArchiveSettings(){
 try{showArchiveSettings(await api('api/settings/archive'))}catch(e){$('archiveSettingsStatus').textContent=e.message}
}
archiveForm.addEventListener('change',archiveFields);
archiveForm.onsubmit=async e=>{
 e.preventDefault();const data={};
 for(const field of archiveForm.querySelectorAll('[name]'))data[field.name]=field.type==='checkbox'?field.checked:field.type==='number'?Number(field.value):field.value;
 $('archiveSave').disabled=true;
 try{
  showArchiveSettings(await settingsRequest('api/settings/archive',data));
  showStorage(await api('api/settings/storage'));
  $('archiveSettingsStatus').textContent='저장했습니다. 재시작 없이 적용되었습니다.';
 }catch(e){$('archiveSettingsStatus').textContent=e.code==='archive_running'?'아카이빙이 실행 중입니다. 완료 후 저장하세요.':e.message}
 finally{$('archiveSave').disabled=false}
};
$('storageLimit').onchange=()=>{$('storageCustomLabel').hidden=$('storageLimit').value!=='custom'};
$('storageForm').onsubmit=async e=>{
 e.preventDefault();const gb=Number($('storageLimit').value==='custom'?$('storageCustom').value:$('storageLimit').value),bytes=Math.round(gb*1073741824);
 if(!Number.isSafeInteger(bytes)||bytes<0||($('storageLimit').value==='custom'&&bytes===0)){$('storageStatus').textContent='올바른 용량을 입력하세요.';return}
 if($('storagePolicy').value==='delete_oldest'&&!confirm('공간이 부족할 때 오래된 주행부터 고정하지 않은 구간을 자동으로 완전 삭제합니다. 고정한 구간은 남깁니다. 이 정책을 저장할까요?'))return;
 $('storageSave').disabled=true;
 try{const s=await settingsRequest('api/settings/storage',{max_bytes:bytes,policy:$('storagePolicy').value});showStorage(s);$('storageStatus').textContent='저장했습니다.'}catch(e){$('storageStatus').textContent=e.message}finally{$('storageSave').disabled=false}
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
deviceDetails.addEventListener('toggle',()=>{if(deviceDetails.open){loadNetwork();loadDevices().catch(e=>$('deviceStatus').textContent=e.message)}});
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
$('pairRenew').onclick=issuePairing;
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
 $('deviceNetworkStatus').textContent='아직 재시작 완료를 확인하지 못했습니다. 잠시 후 외부 장치 연결을 다시 펼쳐 확인하세요. 앱이 시작되지 않으면 Home Assistant의 Road Viewer 로그를 확인하세요.';
};
