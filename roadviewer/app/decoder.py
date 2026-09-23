from pathlib import Path
import sys,json,hashlib,bisect,collections,math
import av,zstandard,capnp
from steering import SteeringReplay
from timeline import align_timeline
from progress import Reporter
from overlay import OverlayProjector
from telemetry import extract_telemetry
BASE=Path(__file__).resolve().parent
log=capnp.load(str(BASE.parent/'schema/cereal/log.capnp'))


def speed_at(states,times,stamp):
 if not states:return None
 k=bisect.bisect_left(times,stamp)
 i=min(range(max(0,k-1),min(len(times),k+1)),key=lambda i:abs(times[i]-stamp))
 time,valid,speed=states[i]
 return speed*3.6 if valid and abs(time-stamp)<150_000_000 and math.isfinite(speed) else None

def first_y(line):
 values=line.get('y',[])
 return float(values[0]) if values and math.isfinite(values[0]) else None

def prepare(value,route=None):
 progress=Reporter();progress.update('log_read')
 src=Path(value).resolve();video=src.parent/'qcamera.ts'
 if not video.is_file():video=src.parent/'camera.mp4'
 log_entry={'label':route or src.parent.name};choices=[]
 def attach(data):
  data.update(path=str(src),route=log_entry['label'],choices=choices)
  return data
 key=hashlib.sha256((str(src)+str(src.stat().st_mtime_ns)+(str(video.stat().st_mtime_ns) if video.exists() else '')+'v22-adjustable-height').encode()).hexdigest()[:20]
 dest=src.parent/'prepared';dest.mkdir(parents=True,exist_ok=True)
 def save_summary(data):
  (dest/'summary.json').write_text(json.dumps({'duration':data['duration'],'warnings':data['warnings'],'model_frames':len(data['frames']),'video':data.get('video')},ensure_ascii=False))
 if (dest/'data.json').exists():
  cached=json.loads((dest/'data.json').read_text())
  if cached.get('key')==key and (dest/'telemetry.json').is_file():
   save_summary(cached)
   return dest,attach(cached)
 print('로그 읽는 중:',src,flush=True)
 with src.open('rb') as source, zstandard.ZstdDecompressor().stream_reader(source) as reader:
  raw=reader.read(512*1024*1024+1)
 if len(raw)>512*1024*1024:raise ValueError('압축 해제된 로그가 512MB 제한을 초과합니다.')
 streams=collections.defaultdict(list)
 models=[];radars=[];cameras=[];live_tracks=[];car_states=[];counts=collections.Counter()
 for e in log.Event.read_multiple_bytes(raw):
  kind=e.which();counts[kind]+=1
  if kind in ('carState','carControl','controlsState','carOutput','selfdriveState','liveParameters','carParams','liveCalibration'):streams[kind].append((e.logMonoTime,e.valid,getattr(e,kind).to_dict()))
  if kind=='initData':streams[kind].append((e.logMonoTime,e.valid,{'dongleId':str(e.initData.dongleId)}))
  if kind=='deviceState':streams[kind].append((e.logMonoTime,e.valid,{'deviceType':str(e.deviceState.deviceType)}))
  if kind=='roadCameraState':streams[kind].append((e.logMonoTime,e.valid,{'sensor':str(e.roadCameraState.sensor)}))
  if kind=='modelV2':
   models.append((e.logMonoTime,e.valid,e.modelV2.to_dict()));progress.update('log_read',frames=len(models))
  elif kind=='radarState':radars.append((e.logMonoTime,e.valid,e.radarState.to_dict()))
  elif kind=='liveTracks':live_tracks.append((e.logMonoTime,e.valid,e.liveTracks.to_dict()))
  elif kind=='carState':car_states.append((e.logMonoTime,e.valid,float(e.carState.vEgo)))
  elif kind=='qRoadEncodeIdx':cameras.append(e.qRoadEncodeIdx.to_dict())
 if not models:raise ValueError('이 로그에 modelV2 데이터가 없습니다.')
 camera_by_id={q['frameId']:q['timestampEof'] for q in cameras}
 time_of=lambda stamp,m:camera_by_id.get(m['frameId'],m.get('timestampEof') or stamp)/1e9
 origin=min(time_of(stamp,m) for stamp,valid,m in models)
 rt=[r[2].get('mdMonoTime',r[0]) for r in radars]
 ordered=sorted(zip(rt,radars),key=lambda item:item[0]);rt=[a for a,b in ordered];radars=[b for a,b in ordered]
 live_tracks.sort(key=lambda row:row[0]);lt_times=[row[0] for row in live_tracks]
 car_states.sort(key=lambda row:row[0]);car_times=[row[0] for row in car_states]
 steering=SteeringReplay(streams)
 overlay=OverlayProjector(streams)
 models.sort(key=lambda row:time_of(row[0],row[2]))
 frames=[]
 def points(line):return [[round(float(x),3),round(float(y),3)] for x,y in zip(line['x'],line['y']) if math.isfinite(x) and math.isfinite(y)]
 progress.update('log_analysis',frames=0)
 for stamp,valid,m in models:
  ego_speed=speed_at(car_states,car_times,time_of(stamp,m)*1e9)
  selected=None;radar_targets=[];raw_targets=[];live_valid=False;live_delta=None
  if live_tracks:
   k=bisect.bisect_left(lt_times,stamp);i=min(range(max(0,k-1),min(len(lt_times),k+1)),key=lambda i:abs(lt_times[i]-stamp))
   live_stamp,live_valid,live=live_tracks[i];live_delta=(live_stamp-stamp)/1e6;live_valid=live_valid and abs(live_delta)<150
   if live_valid:
    for n,target in enumerate(live.get('points',[])):
     if not all(math.isfinite(target.get(k,float('nan'))) for k in ('dRel','yRel','vRel')):continue
     raw_targets.append({'index':n,'trackId':target.get('trackId',-1),'x':target['dRel'],'y':-target['yRel'],'yRel':target['yRel'],'vRel':target['vRel'],'measured':target.get('measured',False),'source':target.get('radarSource','unknown'),'trackState':target.get('trackState',0)})
  if radars:
   k=bisect.bisect_left(rt,stamp);i=min(range(max(0,k-1),min(len(rt),k+1)),key=lambda i:abs(rt[i]-stamp))
   _,rv,r=radars[i];l=r['leadOne']
   fresh=rv and abs(rt[i]-stamp)<150_000_000
   if fresh and l['status']:selected={'x':l['dRel'],'y':-l['yRel'],'radar':l['radar'],'vRel':l['vRel'],'trackId':l.get('radarTrackId',-1)}
   if fresh:
    groups=[('center',r.get('leadsCenter',[])),('left',r.get('leadsLeft',[])),('right',r.get('leadsRight',[]))]
    for group,values in groups:
     for number,target in enumerate(values):
      if not target.get('status'):continue
      if not all(math.isfinite(target.get(k,float('nan'))) for k in ('dRel','yRel','vRel')):continue
      radar_targets.append({'group':group,'index':number,'x':target['dRel'],'y':-target['yRel'],'yRel':target['yRel'],'vRel':target['vRel'],'radar':target.get('radar',False),'trackId':target.get('radarTrackId',-1),'modelProb':target.get('modelProb',0)})
  leads=[{'x':l['x'][0],'y':l['y'][0],'p':l['prob'],'speedKph':float(l['v'][0])*3.6 if l.get('v') and math.isfinite(l['v'][0]) else None} for l in m.get('leadsV3',[])[:2] if l.get('x') and l.get('y')]
  frames.append({'t':round(time_of(stamp,m)-origin,6),'id':m['frameId'],'egoSpeedKph':ego_speed,'steering':steering.at(time_of(stamp,m)*1e9),'valid':valid,'position':points(m.get('position',{'x':[],'y':[]})),'lanes':[points(l) for l in m['laneLines']],'laneY0':[first_y(l) for l in m['laneLines']],'lp':m['laneLineProbs'],'edges':[points(l) for l in m['roadEdges']],'edgeY0':[first_y(l) for l in m['roadEdges']],'es':m['roadEdgeStds'],'leads':leads,'selected':selected,'radarTargets':radar_targets,'liveTracks':raw_targets,'liveTracksValid':live_valid,'liveTracksDeltaMs':live_delta})
  frames[-1]['cameraInfo']=overlay.camera_info(time_of(stamp,m)*1e9)
  frames[-1]['overlay']=overlay.project(time_of(stamp,m)*1e9,m,frames[-1])
  progress.update('log_analysis',frames=len(frames))
 progress.update('log_analysis',frames=len(frames),force=True)
 frames.sort(key=lambda f:f['t'])
 video_info=None;warnings=[]
 if video.exists() and cameras:
  print('전방 영상 준비 중…',flush=True)
  qs=sorted(cameras,key=lambda q:q['segmentId'])
  progress.update('video_read',frames=0)
  pts=[]
  with av.open(str(video)) as c:
   for f in c.decode(video=0):
    pts.append(float(f.pts*f.time_base));progress.update('video_read',frames=len(pts))
  if len(pts)==len(qs) and [q['segmentId'] for q in qs]==list(range(len(qs))):
   offsets=[q['timestampEof']/1e9-p for q,p in zip(qs,pts)]
   if max(offsets)-min(offsets)<.005:
    converted_percent=0
    progress.update('video_convert',percent=0)
    output_video=dest/'camera.mp4' if video.suffix=='.ts' else video
    if video.suffix=='.ts':
     with av.open(str(video)) as inp, av.open(str(dest/'camera.mp4'),'w',options={'movflags':'+faststart'}) as out:
      stream=inp.streams.video[0]; target=out.add_stream_from_template(stream);offset=round(pts[0]/float(stream.time_base))
      for packet in inp.demux(stream):
       if packet.dts is None:continue
       packet.pts-=offset;packet.dts-=offset;packet.stream=target
       position=float(packet.pts*stream.time_base) if packet.pts is not None else 0
       out.mux(packet)
       converted_percent=max(converted_percent,min(99,100*position/max(pts[-1]-pts[0],.001)))
       progress.update('video_convert',percent=converted_percent)
    progress.update('video_convert',percent=100,force=True)
    progress.update('video_verify',percent=0)
    with av.open(str(output_video)) as check:
     video_duration=float(check.duration)/av.time_base if check.duration is not None else pts[-1]-pts[0]+(pts[-1]-pts[-2] if len(pts)>1 else .05)
     decoded_count=0;first_pts=0
     for f in check.decode(video=0):
      if decoded_count==0:first_pts=float(f.pts*f.time_base)
      decoded_count+=1
      progress.update('video_verify',percent=min(99,100*decoded_count/len(pts)))
     if decoded_count!=len(pts):raise ValueError('변환된 영상 프레임 수가 다릅니다.')
    video_info={'start':qs[0]['timestampEof']/1e9-origin-first_pts,'duration':video_duration,'frames':len(pts),'timestampSpreadMs':(max(offsets)-min(offsets))*1000}
   else:warnings.append('영상과 로그의 프레임 시간이 일치하지 않아 영상 동기화를 중단했습니다.')
  else:warnings.append('영상과 로그의 프레임 수가 일치하지 않아 영상 동기화를 중단했습니다.')
 elif video.exists():warnings.append('카메라 프레임 정보가 없어 영상 동기화를 사용할 수 없습니다.')
 else:warnings.append('저장된 영상이 없어 도로 형태만 표시합니다.')
 progress.update('saving')
 timeline_start=frames[0]['t']
 bounds=align_timeline(frames,video_info)
 telemetry_origin=origin+timeline_start-frames[0]['t']
 telemetry=extract_telemetry(streams,telemetry_origin,bounds['duration'])
 with (dest/'telemetry.json').open('w') as out:json.dump(telemetry,out,separators=(',',':'),allow_nan=False)
 data={'route':log_entry['label'],'key':key,**bounds,'frames':frames,'video':video_info,'warnings':warnings,'counts':dict(counts)}
 with (dest/'data.json').open('w') as out:json.dump(data,out,ensure_ascii=False,separators=(',',':'),allow_nan=False)
 save_summary(data)
 print('준비 완료:',len(frames),'개 모델 프레임',flush=True)
 return dest,attach(data)

if __name__=='__main__':
 try:prepare(sys.argv[1],sys.argv[2] if len(sys.argv)>2 else None)
 except Exception as e:print(str(e),file=sys.stderr);sys.exit(1)
