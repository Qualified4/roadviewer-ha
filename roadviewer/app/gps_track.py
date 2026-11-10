"""GPS route of a segment, for the maps (library list, route card, replay).

Conversion (decoder.prepare) collects the fixes while it reads the log; logs converted before this existed get theirs
once from the background backfill below (TrackBackfill), only from a log that is local or on the NAS: never from
Google Drive. Stored per conversion in prepared/track.json.gz:
  {"v": TRACK_V, "source": "gpsLocationExternal" | "gpsLocation", "points": [[t, lat, lon, speed_mps, bearing_deg], ...]}
t is on the replay timeline (data.json.gz frame t, telemetry time: logMonoTime/1e9 - origin), one point per second,
lat/lon rounded to six decimals (about 0.1 m). speed or bearing is null when the receiver did not report it.
summary.json gets track_v, has_track, track_distance_m and track_bbox ([south, west, north, east]) so the list knows
without opening the file. Only has_track reaches the list (/api/logs); coordinates are served only by the two map
endpoints of server.py (never in the list, replay data, telemetry, downloads, exports or the device API).

Real fixes only: the event is valid, the receiver reports hasFix, the position is finite and not (0, 0), and the
horizontal accuracy is known and at most MAX_ACCURACY_M. A point that implies an absurd jump from the previous kept
point (faster than MAX_SPEED_MPS) is dropped as a glitch."""
import gzip,json,logging,math,os,subprocess,sys,threading,time
from pathlib import Path

log=logging.getLogger(__name__)
TRACK_V=1
FILE='track.json.gz'
TOPICS=('gpsLocationExternal','gpsLocation')  # Preferred first: the external receiver, then the device's own.
MAX_ACCURACY_M=100.0
MAX_SPEED_MPS=90.0
SUMMARY_FIELDS=('track_v','has_track','track_distance_m','track_bbox')
EARTH_M=6371008.8

class Collector:
 """Fixes seen while a log is read; add() is called for every event and returns at once for any other kind."""
 def __init__(self):self.fixes={topic:[] for topic in TOPICS}
 def add(self,e,kind):
  if kind not in self.fixes or not e.valid:return
  fix=getattr(e,kind)
  if not fix.hasFix:return
  lat,lon,accuracy=float(fix.latitude),float(fix.longitude),float(fix.horizontalAccuracy)
  if not (math.isfinite(lat) and math.isfinite(lon) and -90<=lat<=90 and -180<=lon<=180):return
  if abs(lat)<1e-7 and abs(lon)<1e-7:return
  if not (math.isfinite(accuracy) and 0<=accuracy<=MAX_ACCURACY_M):return
  speed,bearing=float(fix.speed),float(fix.bearingDeg)
  self.fixes[kind].append((e.logMonoTime,lat,lon,speed if math.isfinite(speed) and speed>=0 else None,bearing%360 if math.isfinite(bearing) else None))
 def source(self):return next((topic for topic in TOPICS if self.fixes[topic]),None)
 def points(self,origin):
  """1 Hz points on the replay timeline (t = logMonoTime/1e9 - origin)."""
  topic=self.source()
  return downsample(sorted(self.fixes[topic]) if topic else [],origin)

def distance_m(a,b):
 # Haversine between (lat, lon) pairs.
 la1,lo1,la2,lo2=map(math.radians,(a[0],a[1],b[0],b[1]))
 h=math.sin((la2-la1)/2)**2+math.cos(la1)*math.cos(la2)*math.sin((lo2-lo1)/2)**2
 return 2*EARTH_M*math.asin(min(1,math.sqrt(h)))

def downsample(fixes,origin):
 out=[];second=None
 for mono,lat,lon,speed,bearing in fixes:
  t=mono/1e9-origin;bucket=math.floor(t)
  if bucket==second:continue
  if out:
   gap=t-out[-1][0]
   if gap>0 and distance_m(out[-1][1:3],(lat,lon))/gap>MAX_SPEED_MPS:continue
  second=bucket
  out.append([round(t,2),round(lat,6),round(lon,6),None if speed is None else round(speed,1),None if bearing is None else round(bearing)])
 return out

def path_length(points):return sum(distance_m(a[1:3],b[1:3]) for a,b in zip(points,points[1:]))

def summary_fields(points):
 if not points:return {'track_v':TRACK_V,'has_track':False,'track_distance_m':None,'track_bbox':None}
 lats=[p[1] for p in points];lons=[p[2] for p in points]
 return {'track_v':TRACK_V,'has_track':True,'track_distance_m':round(path_length(points)),'track_bbox':[min(lats),min(lons),max(lats),max(lons)]}

def write(dest,points,source,name=FILE):
 """Writes (or removes, without points) the track; returns the summary fields."""
 from compact import write_gzip_json
 dest=Path(dest)
 if points:write_gzip_json(dest/name,{'v':TRACK_V,'source':source,'points':points})
 else:(dest/name).unlink(missing_ok=True)
 return summary_fields(points)

def read(prepared):
 """The stored points of one conversion, [] when there are none (or the file is from another format)."""
 try:value=json.loads(gzip.decompress((Path(prepared)/FILE).read_bytes()))
 except (OSError,ValueError,EOFError):return []
 return value.get('points') or [] if isinstance(value,dict) and value.get('v')==TRACK_V else []

def simplify(coords,limit):
 """Douglas-Peucker on (lat, lon) pairs, the tolerance growing until at most `limit` points remain."""
 if len(coords)<=limit:return coords
 mid=math.radians(sum(c[0] for c in coords)/len(coords));scale=math.cos(mid)
 xy=[(math.radians(c[1])*scale*EARTH_M,math.radians(c[0])*EARTH_M) for c in coords]
 def keep(tolerance):
  marked=[False]*len(xy);marked[0]=marked[-1]=True;stack=[(0,len(xy)-1)]
  while stack:
   a,b=stack.pop();(ax,ay),(bx,by)=xy[a],xy[b];dx,dy=bx-ax,by-ay;length=math.hypot(dx,dy);best,index=-1,None
   for i in range(a+1,b):
    px,py=xy[i]
    d=abs(dy*(px-ax)-dx*(py-ay))/length if length else math.hypot(px-ax,py-ay)
    if d>best:best,index=d,i
   if index is not None and best>tolerance:marked[index]=True;stack+=[(a,index),(index,b)]
  return [c for c,m in zip(coords,marked) if m]
 tolerance=2.0
 while True:
  out=keep(tolerance)
  if len(out)<=limit:return out
  tolerance*=2

# --- Backfill of logs converted before tracks existed.

def frame_origin(prepared):
 """(frame id, frame t) of the replay's first model frame, to put the backfilled fixes on the same timeline."""
 value=json.loads(gzip.decompress((Path(prepared)/'data.json.gz').read_bytes()))
 for frame in value.get('frames') or []:
  if isinstance(frame.get('id'),int) and isinstance(frame.get('t'),(int,float)):return frame['id'],float(frame['t'])
 return None

def extract(rlog,prepared,name=FILE+'.migrating'):
 """Child process: reads the whole log, writes prepared/<name> when it has fixes and returns the summary fields.
 The timeline origin is where the first replay frame sits: its camera time (qRoadEncodeIdx, else the model's own
 timestampEof, else logMonoTime, as decoder.time_of) minus its t."""
 import capnp,zstandard
 schema=capnp.load(str(Path(__file__).resolve().parent.parent/'schema/cereal/log.capnp'))
 anchor=frame_origin(prepared)
 with open(rlog,'rb') as source,zstandard.ZstdDecompressor().stream_reader(source) as reader:raw=reader.read(512*1024*1024+1)
 if len(raw)>512*1024*1024:raise ValueError('log too large')
 collector=Collector();camera=model=None
 for e in schema.Event.read_multiple_bytes(raw):
  try:kind=e.which()
  except capnp.KjException:continue
  if kind in TOPICS:collector.add(e,kind)
  elif anchor and kind=='modelV2' and model is None and e.modelV2.frameId==anchor[0]:model=(e.logMonoTime,e.modelV2.timestampEof)
  elif anchor and kind=='qRoadEncodeIdx' and camera is None and e.qRoadEncodeIdx.frameId==anchor[0]:camera=e.qRoadEncodeIdx.timestampEof
 if not collector.source() or model is None:return write(prepared,[],None,name)
 origin=(camera or model[1] or model[0])/1e9-anchor[1]
 return write(prepared,collector.points(origin),collector.source(),name)

class TrackBackfill:
 """Once per log converted before tracks existed: newest first, one log at a time in a low-priority child process,
 a pause between logs. Waits while uploads, conversions, playback (backfill.Backfill.busy) or an archive run are
 active. A log whose rlog is only on Google Drive (or nowhere) gets has_track false; an unreachable NAS is tried
 again on a later run."""
 START_DELAY=180;INTERVAL=3600;BUSY_RETRY=60;PAUSE=2.0;TIMEOUT=600
 def __init__(self,server,list_backfill,pause=None):
  self.s,self.list_backfill=server,list_backfill;self.pause=self.PAUSE if pause is None else pause
  self.stopped=threading.Event();self.thread=None
 def start(self,delay=None):
  self.thread=threading.Thread(target=self._loop,args=(self.START_DELAY if delay is None else delay,),name='track-backfill',daemon=True);self.thread.start()
 def _loop(self,delay):
  self.stopped.wait(delay)
  while not self.stopped.is_set():
   try:more=self.run_once()
   except Exception:log.exception('Track backfill stopped');more=False
   self.stopped.wait(self.BUSY_RETRY if more else self.INTERVAL)
 def busy(self):
  archiver=getattr(self.s,'archiver',None)
  return self.list_backfill.busy() or bool(archiver and (getattr(archiver,'running',False) or getattr(archiver,'manual_active',False)))
 @staticmethod
 def needs(p,m):
  if m.get('status')!='ready' or not (p/'prepared'/'data.json.gz').is_file():return False
  try:return json.loads((p/'prepared'/'summary.json').read_text()).get('track_v')!=TRACK_V
  except (OSError,ValueError):return False
 def source(self,p,m):
  """A local path of the log, None when it cannot be read here (Drive only, removed), or 'retry' (NAS down)."""
  import media_store
  where=media_store.location(m,'rlog.zst')
  if where=='local':return p/'rlog.zst' if (p/'rlog.zst').is_file() else None
  if where!='nas':return None  # Google Drive (or removed): never downloaded for a map.
  found,state=media_store.resolve(p,m,'rlog.zst',self.s.store,None)
  if state in ('storage_unavailable','checking'):return 'retry'
  return found if isinstance(found,Path) else None
 def run_once(self):
  """Whether work remains for soon (busy or a NAS that could not be read)."""
  paths=[]
  for p in self.s.recording_paths():
   try:paths.append((p.stat().st_mtime,p))
   except OSError:pass
  retry=False
  for _,p in sorted(paths,reverse=True):
   if self.stopped.is_set():return False
   try:m=self.s.read_meta(p)
   except (OSError,ValueError):continue
   if not self.needs(p,m):continue
   if self.busy():return True
   rlog=self.source(p,m)
   if rlog=='retry':retry=True;continue
   self.process(p,m,rlog)
   if self.pause:self.stopped.wait(self.pause)
  return retry
 def process(self,p,m,rlog):
  prepared=p/'prepared';staged=prepared/(FILE+'.migrating');fields=summary_fields([])
  if rlog is not None:
   try:
    done=subprocess.run([sys.executable,'-B',str(Path(__file__).resolve()),str(rlog),str(prepared)],capture_output=True,text=True,timeout=self.TIMEOUT,preexec_fn=lambda:os.nice(10) if hasattr(os,'nice') else None)
    if done.returncode==0:fields=json.loads(done.stdout.strip().splitlines()[-1])
    else:log.warning('Track of %s could not be read: %s',p.name,done.stderr.strip()[-300:])
   except (OSError,ValueError,IndexError,subprocess.SubprocessError):log.warning('Track of %s could not be read',p.name,exc_info=True)
  def commit():
   summary_file=prepared/'summary.json'
   if staged.is_file() and fields.get('has_track'):staged.replace(prepared/FILE)
   else:staged.unlink(missing_ok=True);(prepared/FILE).unlink(missing_ok=True)
   self.s.atomic_json(summary_file,{**json.loads(summary_file.read_text()),**{k:fields.get(k) for k in SUMMARY_FIELDS}})
  if not self.s.commit_prepared(p,m,commit):staged.unlink(missing_ok=True)

if __name__=='__main__':
 # One log per child: the server never holds a whole decoded log in memory.
 print(json.dumps(extract(sys.argv[1],sys.argv[2])))
