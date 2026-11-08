'use strict';
// 내보내기 · 불러오기 (log_transfer.py). An export is one .tar download made by the server. An exported .tar is read here
// (ustar headers through File.slice: never the whole file in memory, never stored twice on the server) and imported one
// recording at a time: the record opens an upload session, its files go in chunks as uploads do, finish registers it.
const EXPORT_FORMAT='roadviewer-export',EXPORT_VERSION=1,EXPORT_MEMBER=/^([0-9a-f]{32})\/(record\.json|rlog\.zst|qcamera\.ts|fcamera\.hevc|ecamera\.hevc|camera\.mp4|fcamera\.mp4|ecamera\.mp4)$/;
let importController=null;
function downloadExport(ids=null){
 const link=document.createElement('a');link.href='api/logs/export.tar'+(ids?`?ids=${ids.join(',')}`:'');link.download='';
 document.body.append(link);link.click();link.remove();
}
function transferStatus(text,failures=[]){
 $('transferStatus').textContent=text;
 $('transferFailures').replaceChildren(...failures.map(message=>{const line=document.createElement('p');line.textContent=message;return line}));$('transferFailures').hidden=!failures.length;
}
async function tarMembers(file){
 const members=[],decoder=new TextDecoder();let offset=0;
 while(offset+512<=file.size){
  const block=new Uint8Array(await file.slice(offset,offset+512).arrayBuffer());
  if(block.every(byte=>byte===0))break;
  const field=(start,length)=>{let end=start;while(end<start+length&&block[end])end++;return decoder.decode(block.subarray(start,end))};
  let sum=0;for(let i=0;i<512;i++)sum+=i>=148&&i<156?32:block[i];
  if(!field(257,6).startsWith('ustar')||parseInt(field(148,8).trim(),8)!==sum)throw Error('Road Viewer 내보내기 파일(.tar)이 아닙니다.');
  const prefix=field(345,155),name=(prefix?prefix+'/':'')+field(0,100),size=parseInt(field(124,12).trim()||'0',8),type=field(156,1);
  if(!Number.isSafeInteger(size)||size<0||offset+512+size>file.size)throw Error('내보내기 파일이 손상되었거나 끝까지 받아지지 않았습니다.');
  if(type!==''&&type!=='0')throw Error('내보내기 파일에 알 수 없는 항목이 있습니다.');
  members.push({name,offset:offset+512,size});offset+=512+Math.ceil(size/512)*512;
 }
 return members;
}
const memberText=(file,member)=>file.slice(member.offset,member.offset+member.size).text();
async function importExport(file){
 if(busy||cleaning){transferStatus('업로드가 끝난 뒤 다시 시도하세요.');return}
 busy=true;selectionChanged();$('importLogs').disabled=$('exportLogs').disabled=true;$('importCancel').hidden=false;
 importController=uploadController=new AbortController();const signal=importController.signal;
 const progress=$('importProgress'),failures=[];let imported=0,skipped=0;
 progress.value=0;progress.hidden=false;transferStatus('파일을 읽는 중…');
 try{
  const members=await tarMembers(file);
  let manifest=null;
  try{if(members[0]?.name==='manifest.json')manifest=JSON.parse(await memberText(file,members[0]))}catch{}
  if(manifest?.format!==EXPORT_FORMAT)throw Error('Road Viewer 내보내기 파일이 아닙니다.');
  if(manifest.version!==EXPORT_VERSION)throw Error('지원하지 않는 내보내기 형식 버전입니다. 앱을 업데이트한 뒤 다시 시도하세요.');
  const groups=new Map();
  for(const member of members.slice(1)){
   const match=EXPORT_MEMBER.exec(member.name);if(!match)throw Error('내보내기 파일에 알 수 없는 항목이 있습니다: '+member.name.slice(0,80));
   if(!groups.has(match[1]))groups.set(match[1],{});groups.get(match[1])[match[2]]=member;
  }
  const bytesOf=group=>Object.entries(group).reduce((sum,[name,member])=>sum+(name==='record.json'?0:member.size),0);
  const total=[...groups.values()].reduce((sum,group)=>sum+bytesOf(group),0),names=new Map((manifest.recordings||[]).map(row=>[row.id,row.name]));
  let done=0,index=0;
  for(const [id,group] of groups){
   index++;signal.throwIfAborted();
   let sent=0,session=null;
   const show=(extra='')=>{const bytes=done+sent;progress.value=total?Math.round(bytes/total*100):100;transferStatus(`불러오는 중 ${index}/${groups.size} · ${storageSize(bytes)} / ${storageSize(total)}${extra?' · '+extra:''}`)};
   show();
   try{
    if(!group['record.json'])throw Error('기록 정보가 없습니다.');
    let record;try{record=JSON.parse(await memberText(file,group['record.json']))}catch{throw Error('기록 정보를 읽을 수 없습니다.')}
    if(record?.id!==id)throw Error('기록 ID가 파일 위치와 다릅니다.');
    for(const [kind,info] of Object.entries(record.originals||{}))if(group[kind]?.size!==info?.bytes)throw Error(`${kind} 파일이 없거나 크기가 기록과 다릅니다.`);
    let result=await api('api/logs/import',{signal,method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({format:manifest.format,version:manifest.version,record})});
    if(result.session){
     session=result.session;
     for(const [i,kind] of result.files.entries()){
      const member=group[kind];
      for(let offset=0;offset<member.size;offset+=result.chunk_size){
       const end=Math.min(offset+result.chunk_size,member.size);
       await uploadPart(`api/uploads/${session}/files/${i}?offset=${offset}`,file.slice(member.offset+offset,member.offset+end),signal,show);
       sent+=end-offset;show();
      }
     }
     show('등록 중…');
     result=await api(`api/logs/import/${session}/finish`,{method:'POST',signal});session=null;
    }
    if(result.skipped)skipped++;else imported++;
   }catch(e){
    if(signal.aborted)throw e;
    failures.push(`${names.get(id)||id}: ${e.message}`);
   }finally{
    if(session)try{await api(`api/uploads/${session}`,{method:'DELETE'})}catch{}
   }
   done+=bytesOf(group);
  }
  progress.value=100;
  transferStatus(`불러오기 완료 · 새 기록 ${imported}개${skipped?` · 이미 있는 ${skipped}개 건너뜀`:''}${failures.length?` · 실패 ${failures.length}개`:''}`,failures);
 }catch(e){
  transferStatus(signal.aborted?`불러오기를 중단했습니다. 등록을 마친 ${imported}개는 유지됩니다.`:e.message,failures);
 }finally{
  importController=uploadController=null;busy=false;progress.hidden=true;$('importCancel').hidden=true;$('importLogs').disabled=$('exportLogs').disabled=false;selectionChanged();await refresh();
 }
}
$('exportLogs').onclick=()=>{
 if(!logRows.size){transferStatus('내보낼 기록이 없습니다.');return}
 downloadExport();transferStatus(`기록 ${logRows.size}개 내보내기를 시작했습니다. 받는 동안 이 화면을 닫아도 됩니다.`);
};
$('importLogs').onclick=()=>$('importFile').click();
$('importFile').onchange=()=>{const file=$('importFile').files[0];$('importFile').value='';if(file)void importExport(file)};
$('importCancel').onclick=()=>importController?.abort();
