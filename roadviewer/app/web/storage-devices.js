'use strict';
// Credentials and pairing codes are never persisted in browser storage.
const storageDetails=$('storageSettings'),deviceDetails=$('deviceSettings');
let pairingTimer=null,pairingBusy=false,pairingGeneration=0;
const settingsRequest=(url,body,method='POST')=>api(url,{method,headers:{'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});
function showStorage(s){$('storageUsage').textContent=`사용 중 ${storageSize(s.used_bytes)} / ${s.max_bytes?storageSize(s.max_bytes):'제한 없음'} · 디스크 여유 ${storageSize(s.free_bytes)} · 업로드 예약 ${storageSize(s.reserved_bytes)}`}
storageDetails.addEventListener('toggle',async()=>{
 if(!storageDetails.open)return;
 try{const s=await api('api/settings/storage');showStorage(s);const gb=s.max_bytes/1073741824;$('storageLimit').value=[0,10,20,50,100].includes(gb)?String(gb):'custom';$('storageCustom').value=gb||10;$('storageCustomLabel').hidden=$('storageLimit').value!=='custom';$('storagePolicy').value=s.policy;for(const id of ['storageLimit','storagePolicy'])$(id).dispatchEvent(new Event('rv:sync'));$('storageSave').disabled=false}catch(e){$('storageStatus').textContent=e.message}
});
$('storageLimit').onchange=()=>{$('storageCustomLabel').hidden=$('storageLimit').value!=='custom'};
$('storageForm').onsubmit=async e=>{
 e.preventDefault();const gb=Number($('storageLimit').value==='custom'?$('storageCustom').value:$('storageLimit').value),bytes=Math.round(gb*1073741824);
 if(!Number.isSafeInteger(bytes)||bytes<0||($('storageLimit').value==='custom'&&bytes===0)){$('storageStatus').textContent='올바른 용량을 입력하세요.';return}
 if($('storagePolicy').value==='delete_oldest'&&!confirm('공간이 부족할 때 가장 오래된 미고정 주행의 모든 구간을 자동으로 완전 삭제합니다. 이 정책을 저장할까요?'))return;
 $('storageSave').disabled=true;
 try{const s=await settingsRequest('api/settings/storage',{max_bytes:bytes,policy:$('storagePolicy').value});showStorage(s);$('storageStatus').textContent='저장했습니다.'}catch(e){$('storageStatus').textContent=e.message}finally{$('storageSave').disabled=false}
};
async function loadDevices(){
 const data=await api('api/settings/devices');$('deviceStatus').textContent=data.enabled?'HTTPS 장치 API가 켜져 있습니다.':'외부 API가 꺼져 있습니다. 애드온 설정에서 먼저 활성화하세요.';$('pairOpen').disabled=!data.enabled;
 $('deviceList').replaceChildren(...data.devices.map(d=>{
  const row=document.createElement('div');row.className='device-row';const info=document.createElement('div'),name=document.createElement('strong'),meta=document.createElement('p'),button=document.createElement('button');name.textContent=d.name||d.device_id;
  meta.textContent=`${d.revoked?'연결 해제됨':'활성'} · ${d.dongle_id||d.device_id} · 등록 ${new Date(d.registered_at*1000).toLocaleString()} · 마지막 인증 ${d.last_seen?new Date(d.last_seen*1000).toLocaleString():'없음'}`;
  button.textContent='Revoke · 연결 해제';button.type='button';button.disabled=d.revoked;button.onclick=async()=>{if(!confirm(`${d.name} 장치의 인증을 해제할까요? 진행 중인 업로드도 더 이상 이어갈 수 없습니다.`))return;button.disabled=true;try{await settingsRequest(`api/settings/devices/${d.device_id}/revoke`);await loadDevices()}catch(e){$('deviceStatus').textContent=e.message;button.disabled=false}};
  info.append(name,meta);row.append(info,button);return row;
 }));
}
deviceDetails.addEventListener('toggle',()=>{if(deviceDetails.open)loadDevices().catch(e=>$('deviceStatus').textContent=e.message)});
function renderPairing(p){
 $('pairCode').textContent=p.code||'';
 const remaining=Math.max(0,Math.ceil((p.expires_at||0)-Date.now()/1000));
 $('pairStatus').textContent=p.status==='paired'?'장치가 연결되었습니다.':p.status==='waiting'&&remaining?`연결 대기 중 · ${remaining}초 남음`:'코드가 만료되었거나 취소되었습니다.';
 if(p.status!=='waiting'||!remaining){clearInterval(pairingTimer);pairingTimer=null;$('pairClose').textContent='닫기';if(p.status==='paired')loadDevices().catch(e=>$('deviceStatus').textContent=e.message)}
}
$('pairOpen').onclick=async()=>{
 $('pairOpen').disabled=true;const generation=++pairingGeneration;
 try{const p=await settingsRequest('api/settings/devices/pairing');$('pairClose').textContent='취소';$('pairDialog').showModal();renderPairing(p);
 pairingTimer=setInterval(async()=>{if(pairingBusy)return;pairingBusy=true;try{const status=await api('api/settings/devices/pairing');if(generation===pairingGeneration)renderPairing(status)}catch(e){$('pairStatus').textContent=e.message}finally{pairingBusy=false}},1000);
 }catch(e){$('deviceStatus').textContent=e.message}finally{$('pairOpen').disabled=false}
};
$('pairClose').onclick=()=>{$('pairDialog').close()};
$('pairDialog').addEventListener('close',()=>{pairingGeneration++;clearInterval(pairingTimer);pairingTimer=null;$('pairCode').textContent='';settingsRequest('api/settings/devices/pairing',null,'DELETE').catch(e=>$('deviceStatus').textContent=e.message)});
