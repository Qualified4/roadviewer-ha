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
}
storageDetails.addEventListener('toggle',async()=>{
 if(!storageDetails.open)return;
 try{const s=await api('api/settings/storage');showStorage(s);const gb=s.max_bytes/1073741824;$('storageLimit').value=[0,10,20,50,100].includes(gb)?String(gb):'custom';$('storageCustom').value=gb||10;$('storageCustomLabel').hidden=$('storageLimit').value!=='custom';$('storagePolicy').value=s.policy;for(const id of ['storageLimit','storagePolicy'])$(id).dispatchEvent(new Event('rv:sync'));$('storageSave').disabled=false}catch(e){$('storageStatus').textContent=e.message}
});
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
  button.textContent=d.revoked?'목록 제거':'Revoke · 연결 해제';button.type='button';
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
 $('pairCode').textContent=waiting?p.code||'':'';$('pairCopy').disabled=!waiting;
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
 $('pairCopyIcon').textContent=copied?'✓':'!';
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
