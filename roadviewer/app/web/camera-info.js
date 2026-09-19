'use strict';
(()=>{
 const button=document.getElementById('cameraInfoButton'),dialog=document.getElementById('cameraInfoDialog');
 const close=document.getElementById('cameraInfoClose'),values=document.getElementById('cameraInfoValues'),snapshot=document.getElementById('cameraInfoSnapshot');
 const states={calibrated:'보정 완료',recalibrating:'재보정 중',uncalibrated:'미보정',invalid:'보정 유효하지 않음'};
 let oldOverflow='',opened=false;
 const known=value=>value&&value!=='unknown'?value:'확인 불가';
 button.onclick=()=>{
  if(dialog.open)return;
  const frame=data?.frames?.[idx],available=frame&&frameAvailable(frame),info=available?frame.cameraInfo:null;
  snapshot.textContent=info?`재생 ${clock(t)} · FRAME ${frame.id} 기준`:available?'카메라 정보가 없는 변환 데이터입니다. 로그 목록에서 제거 후 변환해 주세요.':'이 시점에는 확인할 로그 데이터가 없습니다.';
  const angle=i=>Number.isFinite(info?.rpy?.[i])?(info.rpy[i]*180/Math.PI).toFixed(2)+'°':'확인 불가';
  const height=Number.isFinite(info?.height)?(info.heightDefault?'기본값 '+info.height.toFixed(2)+' m 사용':info.height.toFixed(2)+' m (로그 보정값)'):'확인 불가';
  const rows=[['기기 종류',known(info?.device)],['카메라 센서',known(info?.sensor)],['보정 상태',states[info?.calibrationStatus]||'확인 불가'],['롤 · 좌우 기울기',angle(0)],['피치 · 상하 방향',angle(1)],['요 · 좌우 방향',angle(2)],['카메라 높이',height],['좌우 설치 오프셋','확인 불가'],['앞뒤 설치 오프셋','확인 불가']];
  values.replaceChildren();
  for(const [label,value] of rows){const dt=document.createElement('dt'),dd=document.createElement('dd');dt.textContent=label;dd.textContent=value;values.append(dt,dd)}
  oldOverflow=document.body.style.overflow;document.body.style.overflow='hidden';opened=true;
  dialog.showModal();close.focus({preventScroll:true});
 };
 function finish(){if(!opened)return;opened=false;document.body.style.overflow=oldOverflow;button.focus({preventScroll:true})}
 function dismiss(){dialog.close();finish()}
 close.onclick=dismiss;
 dialog.addEventListener('cancel',event=>{event.preventDefault();dismiss()});
 dialog.addEventListener('close',()=>{if(!dialog.open)finish()});
 dialog.addEventListener('click',event=>{if(event.target!==dialog)return;const r=dialog.getBoundingClientRect();if(event.clientX<r.left||event.clientX>r.right||event.clientY<r.top||event.clientY>r.bottom)dismiss()});
})();
