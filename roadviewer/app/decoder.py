from pathlib import Path
import sys,json,hashlib,bisect,collections,math
import av,zstandard,capnp
from steering import SteeringReplay
from timeline import align_timeline
from video_sources import SOURCES
from hevc_video import prepare_video,VideoProgress
from progress import Reporter
from overlay import OverlayProjector,restore_ccnc_targets
from telemetry import extract_telemetry,FIELDS
from compact import compact_data,write_gzip_json
BASE=Path(__file__).resolve().parent
log=capnp.load(str(BASE.parent/'schema/cereal/log.capnp'))

# to_dict() converts every field of every message, which dominated conversion time and memory.
# pick() returns the same values for only the fields used here, with to_dict()'s rules:
# unset pointer fields are absent, and a union shows only its active member.
POINTERS={'struct','list','text','data','anyPointer','interface'}
_layouts={}
def _layout(schema,spec):
 key=(schema.node.id,id(spec))
 if key not in _layouts:
  fields=schema.fields;rows=[]
  for name,sub in spec.items():
   if name not in fields:continue # Older or newer schemas: absent, as with to_dict().
   proto=fields[name].proto
   kind='group' if proto.which()=='group' else proto.slot.type.which()
   element=proto.slot.type.list.elementType.which() if kind=='list' else None
   rows.append((name,kind,element,sub,proto.discriminantValue!=0xFFFF))
  _layouts[key]=(rows,bool(schema.union_fields))
 return _layouts[key]

def _enum(value):
 try:return value._as_str()
 except Exception:return value.raw # Enumerant unknown to this schema, as to_dict() reports it.

def pick(reader,spec):
 rows,has_union=_layout(reader.schema,spec);active=reader.which() if has_union else None;out={}
 for name,kind,element,sub,member in rows:
  if member and name!=active:continue
  if kind in POINTERS and not reader._has(name):continue
  value=getattr(reader,name)
  if kind in ('struct','group'):value=pick(value,sub) if sub else value.to_dict()
  elif kind=='enum':value=_enum(value)
  elif kind=='list':
   if element=='struct':value=[pick(item,sub) if sub else item.to_dict() for item in value]
   elif element=='enum':value=[_enum(item) for item in value]
   else:value=list(value)
  out[name]=value
 return out

def spec(*paths):
 tree={}
 for path in paths:
  node=tree;parts=path.split('.')
  for part in parts[:-1]:
   if node.get(part) is None:node[part]={}
   node=node[part]
  node.setdefault(parts[-1],None)
 return tree

def telemetry_paths(topic):return [path for path,_ in FIELDS[topic].values()]
OUTPUT=('torque','steeringAngleDeg','curvature','accel','gas','brake')
SPECS={
 'carState':spec(*telemetry_paths('carState'),'vEgo','steeringAngleDeg','steeringPressed'),
 'carControl':spec(*telemetry_paths('carControl'),'latActive','longActive',*('actuatorsOutputDEPRECATED.'+k for k in OUTPUT)),
 'carOutput':spec(*('actuatorsOutput.'+k for k in OUTPUT)),
 'controlsState':spec(*telemetry_paths('controlsState'),'desiredCurvature','activeLaneLine','lateralControlState.torqueState.active',
  *(f'lateralControlState.{state}.{k}' for state in ('angleState','pidState') for k in ('active','steeringAngleDesiredDeg'))),
 'selfdriveState':spec('alertHudVisual','alertSize'),
 'liveParameters':spec('roll'),
 'carParams':spec('maxLateralAccel','brand'),
 'liveCalibration':spec('calStatus','rpyCalib','height'),
 'modelV2':spec('frameId','timestampEof',*(f'{line}.{axis}' for line in ('position','laneLines','roadEdges') for axis in 'xyz'),
  'laneLineProbs','roadEdgeStds',*('leadsV3.'+k for k in ('x','y','v','prob'))),
 'radarState':spec('mdMonoTime',*(f'{lead}.{k}' for lead in ('leadOne','leadsCenter','leadsLeft','leadsRight') for k in ('status','dRel','yRel','vRel','radar','radarTrackId','modelProb'))),
 'liveTracks':spec(*('points.'+k for k in ('dRel','yRel','vRel','trackId','measured','radarSource','trackState'))),
 'qRoadEncodeIdx':spec('frameId','timestampEof','segmentId'),
}


def speed_at(states,times,stamp):
 if not states:return None
 k=bisect.bisect_left(times,stamp)
 i=min(range(max(0,k-1),min(len(times),k+1)),key=lambda i:abs(times[i]-stamp))
 time,valid,speed=states[i]
 return speed*3.6 if valid and abs(time-stamp)<150_000_000 and math.isfinite(speed) else None

def ccnc_targets(payload):
 # Hyundai CCNC_0x162 (32 bytes), outgoing display commands, not raw radar tracks.
 if len(payload)!=32:return []
 bits=int.from_bytes(payload,'little');targets=[]
 for slot,offset in (('LF',112),('FF',64),('RF',136)):
  detect=(bits>>offset)&31;distance=(bits>>(offset+5))&2047;lateral=(bits>>(offset+16))&127
  if not 1<=detect<=14 or distance>=2046:continue
  if slot=='FF' and lateral>=64:lateral-=128
  y_rel=round(lateral*.1*(-1 if slot=='RF' else 1),1)
  targets.append({'slot':slot,'detect':detect,'x':round(distance*.1,1),'yRel':y_rel,'y':-y_rel})
 return targets

def ccnc_road(payload):
 if len(payload)!=32:return None
 bits=int.from_bytes(payload,'little')
 return {'target':(bits>>66)&7,'distance':round(((bits>>69)&2047)*.1,1),
         'highlight':(bits>>105)&15,'left':(bits>>120)&7,'right':(bits>>123)&7,
         'blinkerLeft':bool((bits>>57)&7),'blinkerRight':bool((bits>>60)&7)}

def ccnc_at(rows,times,stamp):
 # Hold only the most recent command; never pull a future command into an earlier frame.
 i=bisect.bisect_right(times,stamp)-1
 if i<0 or stamp-times[i]>=150_000_000 or not rows[i][1]:return None
 return rows[i][2]

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
 key=hashlib.sha256((str(src)+str(src.stat().st_mtime_ns)+(str(video.stat().st_mtime_ns) if video.exists() else '')+''.join(str((src.parent/name).stat().st_mtime_ns) for name in ('fcamera.hevc','ecamera.hevc','fcamera.mp4','ecamera.mp4') if (src.parent/name).is_file())+'v26-ff-path-reference').encode()).hexdigest()[:20]
 dest=src.parent/'prepared';dest.mkdir(parents=True,exist_ok=True)
 def save_summary(data):
  (dest/'summary.json').write_text(json.dumps({'duration':data['duration'],'warnings':data['warnings'],'model_frames':len(data['frames']),'video':data.get('video'),'videos':data.get('videos',{})},ensure_ascii=False))
 print('로그 읽는 중:',src,flush=True)
 with src.open('rb') as source, zstandard.ZstdDecompressor().stream_reader(source) as reader:
  raw=reader.read(512*1024*1024+1)
 if len(raw)>512*1024*1024:raise ValueError('압축 해제된 로그가 512MB 제한을 초과합니다.')
 streams=collections.defaultdict(list)
 ccnc=[];ccnc_roads=[];road_signals=[]
 video_indices=collections.defaultdict(list)
 models=[];radars=[];cameras=[];live_tracks=[];car_states=[];counts=collections.Counter()
 for e in log.Event.read_multiple_bytes(raw):
  kind=e.which();counts[kind]+=1
  if kind in ('carState','carControl','controlsState','carOutput','selfdriveState','liveParameters','carParams','liveCalibration'):streams[kind].append((e.logMonoTime,e.valid,pick(getattr(e,kind),SPECS[kind])))
  if kind=='initData':streams[kind].append((e.logMonoTime,e.valid,{'dongleId':str(e.initData.dongleId)}))
  if kind=='deviceState':streams[kind].append((e.logMonoTime,e.valid,{'deviceType':str(e.deviceState.deviceType)}))
  if kind=='roadCameraState':streams[kind].append((e.logMonoTime,e.valid,{'sensor':str(e.roadCameraState.sensor)}))
  if kind=='modelV2':
   models.append((e.logMonoTime,e.valid,pick(e.modelV2,SPECS['modelV2'])));progress.update('log_read',frames=len(models))
  elif kind=='sendcan':
   for msg in e.sendcan:
    if msg.address==0x161 and msg.src<128 and len(msg.dat)==32:ccnc_roads.append((e.logMonoTime,e.valid,ccnc_road(msg.dat)))
    if msg.address==0x162 and msg.src<128 and len(msg.dat)==32:ccnc.append((e.logMonoTime,e.valid,ccnc_targets(msg.dat)))
  elif kind=='radarState':radars.append((e.logMonoTime,e.valid,pick(e.radarState,SPECS['radarState'])))
  elif kind=='liveTracks':live_tracks.append((e.logMonoTime,e.valid,pick(e.liveTracks,SPECS['liveTracks'])))
  elif kind=='carState':
   car_states.append((e.logMonoTime,e.valid,float(e.carState.vEgo)))
   acceleration=float(e.carState.aEgo)
   road_signals.append((e.logMonoTime,e.valid,{'acceleration':acceleration if math.isfinite(acceleration) else None,**{name:bool(getattr(e.carState,field)) for name,field in [('blinkerLeft','leftBlinker'),('blinkerRight','rightBlinker'),('blindspotLeft','leftBlindspot'),('blindspotRight','rightBlindspot')]}}))
  elif kind in ('qRoadEncodeIdx','roadEncodeIdx','wideRoadEncodeIdx'):
   video_indices[kind].append(pick(getattr(e,kind),SPECS['qRoadEncodeIdx']))
 cameras=video_indices['qRoadEncodeIdx']
 if not models:raise ValueError('이 로그에 modelV2 데이터가 없습니다.')
 camera_by_id={q['frameId']:q['timestampEof'] for q in cameras}
 time_of=lambda stamp,m:camera_by_id.get(m['frameId'],m.get('timestampEof') or stamp)/1e9
 origin=min(time_of(stamp,m) for stamp,valid,m in models)
 rt=[r[2].get('mdMonoTime',r[0]) for r in radars]
 ordered=sorted(zip(rt,radars),key=lambda item:item[0]);rt=[a for a,b in ordered];radars=[b for a,b in ordered]
 live_tracks.sort(key=lambda row:row[0]);lt_times=[row[0] for row in live_tracks]
 car_states.sort(key=lambda row:row[0]);car_times=[row[0] for row in car_states]
 if not any(valid and p.get('brand')=='hyundai' for _,valid,p in streams['carParams']):ccnc=[];ccnc_roads=[]
 ccnc_roads.sort(key=lambda row:row[0]);ccnc_road_times=[row[0] for row in ccnc_roads]
 ccnc.sort(key=lambda row:row[0]);ccnc_times=[row[0] for row in ccnc]
 road_signals.sort(key=lambda row:row[0]);signal_times=[row[0] for row in road_signals]
 steering=SteeringReplay(streams)
 overlay=OverlayProjector(streams)
 models.sort(key=lambda row:time_of(row[0],row[2]))
 frames=[]
 def points(line):return [[round(float(x),3),round(float(y),3)] for x,y in zip(line['x'],line['y']) if math.isfinite(x) and math.isfinite(y)]
 progress.update('log_analysis',frames=0,total_frames=len(models))
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
  frames[-1]['ccncTargets']=restore_ccnc_targets(ccnc_at(ccnc,ccnc_times,time_of(stamp,m)*1e9),m,valid)
  frames[-1]['ccncRoad']=ccnc_at(ccnc_roads,ccnc_road_times,time_of(stamp,m)*1e9)
  frames[-1]['roadSignals']=ccnc_at(road_signals,signal_times,time_of(stamp,m)*1e9)
  frames[-1]['cameraInfo']=overlay.camera_info(time_of(stamp,m)*1e9)
  frames[-1]['overlay']=overlay.project(time_of(stamp,m)*1e9,m,frames[-1])
  progress.update('log_analysis',frames=len(frames),total_frames=len(models))
 progress.update('log_analysis',frames=len(frames),total_frames=len(models),force=True)
 frames.sort(key=lambda f:f['t'])
 video_info=None;warnings=[]
 video_inputs={key:next((src.parent/name for name in names[:2] if (src.parent/name).is_file()),None) for key,names in SOURCES.items()}
 camera_progress=VideoProgress(progress,sum(path is not None for path in video_inputs.values()))
 try:
  if video.exists() and cameras:
   print('전방 영상 준비 중…',flush=True)
   qs=sorted(cameras,key=lambda q:q['segmentId'])
   camera_progress.update('video_read',frames=0)
   pts=[]
   # Frame timestamps come from the packets; decoding every frame here only repeated the verify step below.
   with av.open(str(video)) as c:
    stream=c.streams.video[0]
    for packet in c.demux(stream):
     if packet.pts is None or packet.size==0:continue
     pts.append(float(packet.pts*stream.time_base));camera_progress.update('video_read',frames=len(pts))
   pts.sort()
   if len(pts)==len(qs) and [q['segmentId'] for q in qs]==list(range(len(qs))):
    offsets=[q['timestampEof']/1e9-p for q,p in zip(qs,pts)]
    if max(offsets)-min(offsets)<.005:
     converted_percent=0
     camera_progress.update('video_convert',percent=0)
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
        camera_progress.update('video_convert',percent=converted_percent)
     camera_progress.update('video_convert',percent=100,force=True)
     camera_progress.update('video_verify',percent=0)
     with av.open(str(output_video)) as check:
      video_duration=float(check.duration)/av.time_base if check.duration is not None else pts[-1]-pts[0]+(pts[-1]-pts[-2] if len(pts)>1 else .05)
      decoded_count=0;first_pts=0
      for f in check.decode(video=0):
       if decoded_count==0:first_pts=float(f.pts*f.time_base)
       decoded_count+=1
       camera_progress.update('video_verify',percent=min(99,100*decoded_count/len(pts)))
      if decoded_count!=len(pts):raise ValueError('변환된 영상 프레임 수가 다릅니다.')
     video_info={'start':qs[0]['timestampEof']/1e9-origin-first_pts,'duration':video_duration,'frames':len(pts),'timestampSpreadMs':(max(offsets)-min(offsets))*1000}
    else:warnings.append('영상과 로그의 프레임 시간이 일치하지 않아 영상 동기화를 중단했습니다.')
   else:warnings.append('영상과 로그의 프레임 수가 일치하지 않아 영상 동기화를 중단했습니다.')
  elif video.exists():warnings.append('카메라 프레임 정보가 없어 영상 동기화를 사용할 수 없습니다.')
 except Exception as exc:
  (dest/'camera.mp4').unlink(missing_ok=True)
  warnings.append('qcamera 영상 준비 실패: '+str(exc))
 videos={'qcamera':video_info} if video_info else {}
 camera_progress.index=int(video_inputs['qcamera'] is not None)
 for source in ('front','wide'):
  original,mp4,topic=SOURCES[source]
  source_file=video_inputs[source]
  if source_file is None:continue
  try:videos[source]=prepare_video(source_file,dest/mp4,video_indices[topic],origin,camera_progress)
  except Exception as exc:warnings.append(original+' 영상 준비 실패: '+str(exc))
  camera_progress.index+=1
 default_video=next((source for source in ('front','qcamera','wide') if source in videos),None)
 video_info=videos.get(default_video)
 if not videos:warnings.append('재생 가능한 영상이 없어 도로 형태만 표시합니다.')
 progress.update('saving')
 timeline_start=frames[0]['t']
 bounds=align_timeline(frames,video_info,videos)
 telemetry_origin=origin+timeline_start-frames[0]['t']
 telemetry=extract_telemetry(streams,telemetry_origin,bounds['duration'])
 # Compact gzip files: about 5x smaller on disk and over the network (see compact.py).
 write_gzip_json(dest/'telemetry.json.gz',telemetry)
 data={'route':log_entry['label'],'key':key,**bounds,'frames':frames,'video':video_info,'videos':videos,'defaultVideo':default_video,'warnings':warnings,'counts':dict(counts)}
 write_gzip_json(dest/'data.json.gz',compact_data(data),ensure_ascii=False)
 for stale in ('data.json','telemetry.json'):(dest/stale).unlink(missing_ok=True) # Plain files from an earlier version.
 save_summary(data)
 print('준비 완료:',len(frames),'개 모델 프레임',flush=True)
 return dest,attach(data)

if __name__=='__main__':
 try:prepare(sys.argv[1],sys.argv[2] if len(sys.argv)>2 else None)
 except Exception as e:print(str(e),file=sys.stderr);sys.exit(1)
