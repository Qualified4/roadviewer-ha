from pathlib import Path
import sys,json,hashlib,bisect,collections,math
import av,zstandard,capnp
BASE=Path(__file__).resolve().parent
log=capnp.load(str(BASE.parent/'schema/cereal/log.capnp'))

def prepare(value):
 src=Path(value).resolve();video=src.parent/'qcamera.ts';log_entry={'label':src.parent.name};choices=[]
 def attach(data):
  data.update(path=str(src),route=log_entry['label'],choices=choices)
  return data
 key=hashlib.sha256((str(src)+str(src.stat().st_mtime_ns)+(str(video.stat().st_mtime_ns) if video.exists() else '')+'v6-live-tracks').encode()).hexdigest()[:20]
 dest=src.parent/'prepared';dest.mkdir(parents=True,exist_ok=True)
 if (dest/'data.json').exists():
  cached=json.loads((dest/'data.json').read_text())
  if cached.get('key')==key:return dest,attach(cached)
 print('로그 읽는 중:',src,flush=True)
 with src.open('rb') as source, zstandard.ZstdDecompressor().stream_reader(source) as reader:
  raw=reader.read(512*1024*1024+1)
 if len(raw)>512*1024*1024:raise ValueError('압축 해제된 로그가 512MB 제한을 초과합니다.')
 models=[];radars=[];cameras=[];live_tracks=[];counts=collections.Counter()
 for e in log.Event.read_multiple_bytes(raw):
  kind=e.which();counts[kind]+=1
  if kind=='modelV2':models.append((e.logMonoTime,e.valid,e.modelV2.to_dict()))
  elif kind=='radarState':radars.append((e.logMonoTime,e.valid,e.radarState.to_dict()))
  elif kind=='liveTracks':live_tracks.append((e.logMonoTime,e.valid,e.liveTracks.to_dict()))
  elif kind=='qRoadEncodeIdx':cameras.append(e.qRoadEncodeIdx.to_dict())
 if not models:raise ValueError('이 로그에 modelV2 데이터가 없습니다.')
 camera_by_id={q['frameId']:q['timestampEof'] for q in cameras}
 time_of=lambda stamp,m:camera_by_id.get(m['frameId'],m.get('timestampEof') or stamp)/1e9
 origin=min(time_of(stamp,m) for stamp,valid,m in models)
 rt=[r[2].get('mdMonoTime',r[0]) for r in radars]
 ordered=sorted(zip(rt,radars),key=lambda item:item[0]);rt=[a for a,b in ordered];radars=[b for a,b in ordered]
 live_tracks.sort(key=lambda row:row[0]);lt_times=[row[0] for row in live_tracks]
 frames=[]
 def points(line):return [[round(float(x),3),round(float(y),3)] for x,y in zip(line['x'],line['y']) if math.isfinite(x) and math.isfinite(y)]
 for stamp,valid,m in models:
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
   if fresh and l['status']:selected={'x':l['dRel'],'y':-l['yRel'],'radar':l['radar'],'vRel':l['vRel']}
   if fresh:
    groups=[('center',r.get('leadsCenter',[])),('left',r.get('leadsLeft',[])),('right',r.get('leadsRight',[]))]
    for group,values in groups:
     for number,target in enumerate(values):
      if not target.get('status'):continue
      if not all(math.isfinite(target.get(k,float('nan'))) for k in ('dRel','yRel','vRel')):continue
      radar_targets.append({'group':group,'index':number,'x':target['dRel'],'y':-target['yRel'],'yRel':target['yRel'],'vRel':target['vRel'],'radar':target.get('radar',False),'trackId':target.get('radarTrackId',-1),'modelProb':target.get('modelProb',0)})
  leads=[{'x':l['x'][0],'y':l['y'][0],'p':l['prob']} for l in m.get('leadsV3',[])[:2] if l.get('x') and l.get('y')]
  frames.append({'t':round(time_of(stamp,m)-origin,6),'id':m['frameId'],'valid':valid,'lanes':[points(l) for l in m['laneLines']],'lp':m['laneLineProbs'],'edges':[points(l) for l in m['roadEdges']],'es':m['roadEdgeStds'],'leads':leads,'selected':selected,'radarTargets':radar_targets,'liveTracks':raw_targets,'liveTracksValid':live_valid,'liveTracksDeltaMs':live_delta})
 frames.sort(key=lambda f:f['t'])
 video_info=None;warnings=[]
 if video.exists() and cameras:
  print('전방 영상 준비 중…',flush=True)
  qs=sorted(cameras,key=lambda q:q['segmentId'])
  pts=[]
  with av.open(str(video)) as c:
   for f in c.decode(video=0):pts.append(float(f.pts*f.time_base))
  if len(pts)==len(qs) and [q['segmentId'] for q in qs]==list(range(len(qs))):
   offsets=[q['timestampEof']/1e9-p for q,p in zip(qs,pts)]
   if max(offsets)-min(offsets)<.005:
    with av.open(str(video)) as inp, av.open(str(dest/'camera.mp4'),'w',options={'movflags':'+faststart'}) as out:
     stream=inp.streams.video[0]; target=out.add_stream_from_template(stream);offset=round(pts[0]/float(stream.time_base))
     for packet in inp.demux(stream):
      if packet.dts is None:continue
      packet.pts-=offset;packet.dts-=offset;packet.stream=target;out.mux(packet)
    with av.open(str(dest/'camera.mp4')) as check:
     decoded_count=0;first_pts=0
     for f in check.decode(video=0):
      if decoded_count==0:first_pts=float(f.pts*f.time_base)
      decoded_count+=1
     if decoded_count!=len(pts):raise ValueError('변환된 영상 프레임 수가 다릅니다.')
    video_info={'start':qs[0]['timestampEof']/1e9-origin-first_pts,'duration':pts[-1]-pts[0],'frames':len(pts),'timestampSpreadMs':(max(offsets)-min(offsets))*1000}
   else:warnings.append('영상과 로그의 프레임 시간이 일치하지 않아 영상 동기화를 중단했습니다.')
  else:warnings.append('영상과 로그의 프레임 수가 일치하지 않아 영상 동기화를 중단했습니다.')
 elif video.exists():warnings.append('카메라 프레임 정보가 없어 영상 동기화를 사용할 수 없습니다.')
 else:warnings.append('qcamera.ts가 없어 도로 형태만 표시합니다.')
 data={'route':src.parent.name,'path':str(src.parent),'key':key,'duration':frames[-1]['t'],'frames':frames,'video':video_info,'warnings':warnings,'counts':dict(counts)}
 (dest/'data.json').write_text(json.dumps(data,ensure_ascii=False,separators=(',',':'),allow_nan=False))
 print('준비 완료:',len(frames),'개 모델 프레임',flush=True)
 return dest,attach(data)

if __name__=='__main__':
 try:prepare(sys.argv[1])
 except Exception as e:print(str(e),file=sys.stderr);sys.exit(1)
