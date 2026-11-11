"""GPS route of a segment, for the maps (library list, route card, replay).

Conversion (decoder.prepare) collects the fixes while it reads the log; logs converted before this existed get theirs
once from the background backfill below (TrackBackfill), from a log that is local or on the NAS, and from Google
Drive only when the user asks for it (setting archive_gdrive_fill_tracks or one pass by hand; read-only). Stored per conversion in prepared/track.json.gz:
  {"v": TRACK_V, "source": "gpsLocationExternal" | "gpsLocation" | "vehicleGps" | "carrotMan", "points": [[t, lat, lon, speed_mps, bearing_deg], ...]}
t is on the replay timeline (data.json.gz frame t, telemetry time: logMonoTime/1e9 - origin), one point per second,
lat/lon rounded to six decimals (about 0.1 m). speed or bearing is null when the receiver did not report it.
summary.json gets track_v, has_track, track_distance_m, track_bbox ([south, west, north, east]), track_read so the list knows
without opening the file. Only has_track reaches the list (/api/logs); coordinates are served only by the two map
endpoints of server.py (never in the list, replay data, telemetry, downloads, exports or the device API).

Sources, best first: the device's receivers (gpsLocationExternal, gpsLocation) when they have a fix; else the car's
own GPS as the vehicle port decodes it from CAN (carState.vehicleGps). On cars where the device's receiver sees no
satellites (measured: every log of this car so far), the vehicle GPS is the only position. Last, carrotMan's
xPosLat/xPosLon: carrot_serv's 20 Hz position, chosen from one of the above or the CarrotNavi app and carried forward
by speed and heading between samples (an estimate, so only for a car with neither).
Real fixes only: for a receiver, the event is valid, it reports hasFix, the position is finite and not (0, 0), and
the horizontal accuracy is known and at most MAX_ACCURACY_M; for the vehicle GPS, available and valid, finite and
not (0, 0), one point per new sample (sampleMonoTime; carState repeats it at 100 Hz), speed from vEgo and heading
when headingValid. A point that implies an absurd jump from the previous kept point (faster than MAX_SPEED_MPS) is
dropped as a glitch. TRACK_V 2 added the vehicle GPS: logs that version 1 found without a fix are read again."""
import gzip,json,logging,math,os,shutil,subprocess,sys,tempfile,threading,time
from pathlib import Path

log=logging.getLogger(__name__)
TRACK_V=2
FILE='track.json.gz'
TOPICS=('gpsLocationExternal','gpsLocation')  # Preferred first: the external receiver, then the device's own.
VEHICLE='vehicleGps'  # carState.vehicleGps: the car's GPS, used when no receiver has a fix.
CARROT='carrotMan'  # carrotMan.xPosLat/xPosLon: an estimated position, the last resort.
SOURCES=TOPICS+(VEHICLE,CARROT)
READ_KINDS=TOPICS+('carState',CARROT)  # Event kinds add() reads.
MAX_ACCURACY_M=100.0
MAX_SPEED_MPS=90.0
SUMMARY_FIELDS=('track_v','has_track','track_distance_m','track_bbox','track_read')
FAILURES='track_failures'  # Failed Drive reads of one log (summary.json); skipped at MAX_FAILURES.
MAX_FAILURES=3
# Drive probe reasons that need the user (sign in again, archiving on, the folder back): no back-off loop for them.
BLOCKING=('not_connected','auth_expired','folder_missing','folder_trashed','storage_id_mismatch')
EARTH_M=6371008.8

class Collector:
 """Fixes seen while a log is read; add() is called for every event and returns at once for any other kind."""
 def __init__(self):self.fixes={topic:[] for topic in SOURCES};self.vehicle_sample=None
 def add(self,e,kind):
  if kind=='carState':return self.add_vehicle(e)
  if kind==CARROT:return self.add_carrot(e)
  if kind not in TOPICS or not e.valid:return
  fix=getattr(e,kind)
  if not fix.hasFix:return
  lat,lon,accuracy=float(fix.latitude),float(fix.longitude),float(fix.horizontalAccuracy)
  if not (math.isfinite(lat) and math.isfinite(lon) and -90<=lat<=90 and -180<=lon<=180):return
  if abs(lat)<1e-7 and abs(lon)<1e-7:return
  if not (math.isfinite(accuracy) and 0<=accuracy<=MAX_ACCURACY_M):return
  speed,bearing=float(fix.speed),float(fix.bearingDeg)
  self.fixes[kind].append((e.logMonoTime,lat,lon,speed if math.isfinite(speed) and speed>=0 else None,bearing%360 if math.isfinite(bearing) else None))
 def add_vehicle(self,e):
  try:gps=e.carState.vehicleGps
  except Exception:return  # A log written before the field existed.
  if not (gps.available and gps.valid):return
  sample=int(gps.sampleMonoTime) or None
  if sample is not None and sample==self.vehicle_sample:return  # The same sample, repeated by every carState.
  lat,lon=float(gps.latitude),float(gps.longitude)
  if not (math.isfinite(lat) and math.isfinite(lon) and -90<=lat<=90 and -180<=lon<=180):return
  if abs(lat)<1e-7 and abs(lon)<1e-7:return
  self.vehicle_sample=sample
  speed=float(e.carState.vEgo);heading=float(gps.headingDeg)
  self.fixes[VEHICLE].append((sample or e.logMonoTime,lat,lon,speed if math.isfinite(speed) and speed>=0 else None,heading%360 if gps.headingValid and math.isfinite(heading) else None))
 def add_carrot(self,e):
  c=e.carrotMan;lat,lon=float(c.xPosLat),float(c.xPosLon)
  if not (math.isfinite(lat) and math.isfinite(lon) and -90<=lat<=90 and -180<=lon<=180) or abs(lat)<1e-7 and abs(lon)<1e-7:return
  angle=float(c.xPosAngle)
  self.fixes[CARROT].append((e.logMonoTime,lat,lon,None,angle%360 if math.isfinite(angle) else None))
 def source(self):return next((topic for topic in SOURCES if self.fixes[topic]),None)
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

def summary_fields(points,read=True):
 # read: the log itself was read (false for a log the backfill could not read: read from Drive when asked).
 if not points:return {'track_v':TRACK_V,'has_track':False,'track_distance_m':None,'track_bbox':None,'track_read':read}
 lats=[p[1] for p in points];lons=[p[2] for p in points]
 return {'track_v':TRACK_V,'has_track':True,'track_distance_m':round(path_length(points)),'track_bbox':[min(lats),min(lons),max(lats),max(lons)],'track_read':True}

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
  if kind in READ_KINDS:collector.add(e,kind)
  elif anchor and kind=='modelV2' and model is None and e.modelV2.frameId==anchor[0]:model=(e.logMonoTime,e.modelV2.timestampEof)
  elif anchor and kind=='qRoadEncodeIdx' and camera is None and e.qRoadEncodeIdx.frameId==anchor[0]:camera=e.qRoadEncodeIdx.timestampEof
 if not collector.source() or model is None:return write(prepared,[],None,name)
 origin=(camera or model[1] or model[0])/1e9-anchor[1]
 return write(prepared,collector.points(origin),collector.source(),name)

class Blocked(Exception):
 """Drive cannot be read until someone acts (signed out, sign-in expired, archiving off, folder gone): the Drive part
 of the pass stops and nothing is marked; the next run tries again."""
class Later(Exception):
 """A network, rate-limit or server error: Drive is tried again after a back-off; nothing is marked."""

def drive_only(p,m):
 # The rlog is only on Google Drive: moved there, or a Drive copy whose local file is gone.
 import media_store
 where=media_store.location(m,'rlog.zst')
 return where=='gdrive' or where=='local' and media_store.remote(m,'rlog.zst') is not None and not (Path(p)/'rlog.zst').is_file()

def track_read(summary):
 # The log was read for its route (with or without a fix). Logs the backfill skipped because their rlog was only on
 # Drive have has_track false and no track_read (1.1.1) or track_read false.
 return summary.get('track_v')==TRACK_V and (summary.get('has_track') is True or summary.get('track_read') is True)

class TrackBackfill:
 """Once per log converted before tracks existed: newest first, one log at a time in a low-priority child process,
 a pause between logs. Waits while uploads, conversions, playback (backfill.Backfill.busy) or an archive run are
 active. An unreachable NAS is tried again on a later run.

 A log whose rlog is only on Google Drive is read only when the user asked for it: the setting
 archive_gdrive_fill_tracks ("Drive 로그 지도 채우기", off by default) or one pass started by hand (request_run, also
 with the setting off). Otherwise it gets has_track false and track_read false, and is read once either is on. Drive
 is only read: the rlog is downloaded (backend.download_to, sha256 checked) into a temporary directory under the data
 root that is removed as soon as the child is done, success or not; nothing on Drive or in the archive index changes.
 A Drive sign-in problem stops the Drive part of the pass (Blocked), a network/429/5xx error backs off (Later), a
 log whose read fails MAX_FAILURES times (summary track_failures) is skipped, a file gone from Drive has no track.
 Turning the setting off, or request_stop, stops after the current log."""
 START_DELAY=180;INTERVAL=3600;BUSY_RETRY=60;PAUSE=2.0;TIMEOUT=600
 BACKOFF_START=300;BACKOFF_MAX=3600
 TEMP_PREFIX='.track-'
 def __init__(self,server,list_backfill,pause=None,clock=time.monotonic):
  self.s,self.list_backfill=server,list_backfill;self.pause=self.PAUSE if pause is None else pause
  self.stopped=threading.Event();self.wake=threading.Event();self.thread=None;self.clock=clock
  self.lock=threading.Lock()
  self.manual=False  # A pass started by hand (request_run), until it ends.
  self.halt=False  # request_stop during a pass: no more Drive logs in it.
  self.active=False  # A Drive pass is under way (waiting included).
  self.waiting=None  # 'busy' while it waits for uploads, conversions, playback or an archive run.
  self.counts=None  # {'total','done','failed'} of the Drive-only logs, from the worker's latest scan.
  self.last_error=None;self.retry_at=0.0;self.backoff=0
  self.finished_at=None  # Wall-clock time the last Drive pass (by hand or by the setting) ended; not kept over a restart.
 def start(self,delay=None):
  for stale in Path(self.s.ROOT).glob(self.TEMP_PREFIX+'*'):shutil.rmtree(stale,ignore_errors=True)  # Left by a restart mid-read.
  self.thread=threading.Thread(target=self._loop,args=(self.START_DELAY if delay is None else delay,),name='track-backfill',daemon=True);self.thread.start()
 def _sleep(self,seconds):
  self.wake.wait(seconds);self.wake.clear()
 def _loop(self,delay):
  try:self.scan()  # The storage panel's counts, without waiting for the first run.
  except Exception:log.exception('Track backfill could not count the logs')
  self._sleep(delay)
  while not self.stopped.is_set():
   try:more=self.run_once()
   except Exception:log.exception('Track backfill stopped');more=False;self.end_pass()
   wait=self.BUSY_RETRY if more else self.INTERVAL
   if more and self.waiting is None and self.retry_at>self.clock():wait=max(wait,self.retry_at-self.clock())
   self._sleep(wait)
 def busy(self):
  archiver=getattr(self.s,'archiver',None)
  return self.list_backfill.busy() or bool(archiver and (getattr(archiver,'running',False) or getattr(archiver,'manual_active',False)))
 # --- Drive: the setting, the pass started by hand, and the status the storage panel shows.
 def enabled(self):return bool(getattr(getattr(self.s,'archive_settings',None),'gdrive_fill_tracks',False))
 def drive_selected(self):
  try:return bool(self.s.remote_backend())
  except Exception:return False
 def drive_on(self):return (self.manual or self.enabled()) and not self.halt and self.drive_selected()
 def request_run(self):
  """One pass over the Drive logs now, setting on or off; False while one started by hand is under way."""
  with self.lock:
   if self.manual:return False
   self.manual,self.halt=True,False
  self.retry_at=0.0;self.wake.set();return True
 def request_stop(self):
  """Stops after the current log (the setting, if on, starts again on its next run)."""
  with self.lock:
   was=self.manual or self.active
   self.manual=False;self.halt=self.active
  return was
 def end_pass(self):
  with self.lock:
   if self.manual or self.active:self.finished_at=time.time()
   self.manual=self.halt=False
  self.active=False;self.waiting=None
 def status(self):
  # The counts come from the worker's scans; only before its first one (or without the worker) are they made here, once.
  if self.counts is None:
   try:self.scan()
   except Exception:log.warning('Track backfill could not count the logs',exc_info=True)
  c=self.counts;total=c['total'] if c else None
  retry=self.retry_at-self.clock()
  return dict(enabled=self.enabled(),manual=self.manual,running=self.active,stopping=self.halt and self.active,waiting=self.waiting,
              total=total,done=c['done'] if c else None,failed=c['failed'] if c else None,
              pending=max(0,total-c['done']-c['failed']) if c else None,last_error=self.last_error,
              retry_in=round(retry) if retry>0 else None,finished_at=self.finished_at)
 # --- Which logs.
 @staticmethod
 def needs(p,m):
  if m.get('status')!='ready' or not (p/'prepared'/'data.json.gz').is_file():return False
  try:return json.loads((p/'prepared'/'summary.json').read_text()).get('track_v')!=TRACK_V
  except (OSError,ValueError):return False
 @staticmethod
 def kind(p,m):
  """'local' (needs a track, rlog here or on the NAS), 'drive' (rlog only on Drive, not read yet), 'done' or
  'failed' (Drive-only, read or skipped after MAX_FAILURES), or None (nothing to do: not ready, no summary)."""
  if m.get('status')!='ready' or not (p/'prepared'/'data.json.gz').is_file():return None
  try:summary=json.loads((p/'prepared'/'summary.json').read_text())
  except (OSError,ValueError):return None
  if not isinstance(summary,dict):return None
  if not drive_only(p,m):return 'local' if summary.get('track_v')!=TRACK_V else None
  if track_read(summary):return 'done'
  return 'failed' if (summary.get(FAILURES) or 0)>=MAX_FAILURES else 'drive'
 def scan(self):
  """(path, kind) of the logs to read, newest first; counts the Drive-only ones for the status."""
  paths=[]
  for p in self.s.recording_paths():
   try:paths.append((p.stat().st_mtime,p))
   except OSError:pass
  rows=[];counts={'total':0,'done':0,'failed':0}
  for _,p in sorted(paths,reverse=True):
   try:kind=self.kind(p,self.s.read_meta(p))
   except (OSError,ValueError):continue
   if kind in ('drive','done','failed'):counts['total']+=1
   if kind in ('done','failed'):counts[kind]+=1
   elif kind:rows.append((p,kind))
  self.counts=counts
  return rows
 def source(self,p,m):
  """A local path of the log, None when it cannot be read here (Drive only, removed), or 'retry' (NAS down)."""
  import media_store
  where=media_store.location(m,'rlog.zst')
  if where=='local':return p/'rlog.zst' if (p/'rlog.zst').is_file() else None
  if where!='nas':return None  # Google Drive (or removed): read by process_drive only.
  found,state=media_store.resolve(p,m,'rlog.zst',self.s.store,None)
  if state in ('storage_unavailable','checking'):return 'retry'
  return found if isinstance(found,Path) else None
 def run_once(self):
  """Whether work remains for soon (busy, a NAS that could not be read, Drive backing off)."""
  more=self._run()
  if not more:self.end_pass()
  return more
 def _run(self):
  self.wake.clear()
  retry=False;blocked=False
  for p,kind in self.scan():
   if self.stopped.is_set():return False
   try:m=self.s.read_meta(p)
   except (OSError,ValueError):continue
   kind=self.kind(p,m) if kind=='drive' else kind
   if kind=='local':
    if not self.needs(p,m):continue
    if self.busy():self.waiting='busy';return True
    self.waiting=None
    rlog=self.source(p,m)
    if rlog=='retry':retry=True;continue
    self.process(p,m,rlog)
   elif kind=='drive':
    if blocked or not self.drive_on():
     # Not asked to read Drive: a log never given a track gets has_track false (and track_read false) as before.
     if self.needs(p,m):self.process(p,m,None)
     continue
    if self.retry_at>self.clock():retry=True;continue  # Backing off: the Drive logs wait.
    self.active=True
    if self.busy():self.waiting='busy';return True
    self.waiting=None
    try:self.process_drive(p,m)
    except Blocked as e:
     log.warning('Drive maps paused: %s',e);self.last_error=str(e);blocked=True
     with self.lock:self.manual=False  # A pass started by hand ends here; the setting tries again next run.
     self.active=False;continue
    except Later as e:
     self.backoff=min(self.BACKOFF_MAX,max(self.BACKOFF_START,self.backoff*2));self.retry_at=self.clock()+self.backoff
     log.warning('Drive maps paused for %d s: %s',self.backoff,e);self.last_error=str(e);retry=True;continue
    self.backoff=0;self.last_error=None
   else:continue
   if self.pause:self.stopped.wait(self.pause)
  return retry
 # --- Reading one log.
 def read(self,p,rlog):
  """The summary fields from the child, None when it failed."""
  prepared=p/'prepared'
  try:
   done=subprocess.run([sys.executable,'-B',str(Path(__file__).resolve()),str(rlog),str(prepared)],capture_output=True,text=True,timeout=self.TIMEOUT,preexec_fn=lambda:os.nice(10) if hasattr(os,'nice') else None)
   if done.returncode==0:return json.loads(done.stdout.strip().splitlines()[-1])
   log.warning('Track of %s could not be read: %s',p.name,done.stderr.strip()[-300:])
  except (OSError,ValueError,IndexError,subprocess.SubprocessError):log.warning('Track of %s could not be read',p.name,exc_info=True)
  return None
 def commit(self,p,m,fields,extra=None):
  prepared=p/'prepared';staged=prepared/(FILE+'.migrating')
  def write():
   summary_file=prepared/'summary.json'
   if staged.is_file() and fields.get('has_track'):staged.replace(prepared/FILE)
   else:staged.unlink(missing_ok=True);(prepared/FILE).unlink(missing_ok=True)
   summary={**json.loads(summary_file.read_text()),**{k:fields.get(k) for k in SUMMARY_FIELDS},**(extra or {})}
   self.s.atomic_json(summary_file,{k:v for k,v in summary.items() if not (k==FAILURES and v is None)})
  ok=self.s.commit_prepared(p,m,write)
  if not ok:staged.unlink(missing_ok=True)
  return ok
 def process(self,p,m,rlog):
  fields=self.read(p,rlog) if rlog is not None else None
  self.commit(p,m,fields or summary_fields([],read=False))
 def process_drive(self,p,m):
  """One Drive-only log; raises Blocked or Later when Drive cannot be read now (nothing is marked). Only reads Drive:
  probe (the folder), the file's metadata (media_store.resolve) and one download."""
  import media_store
  from archive_backends import BackendError
  backend=self.s.backend
  if getattr(getattr(backend,'caps',None),'kind',None)!='gdrive':raise Blocked('gdrive_not_selected')
  state,reason=backend.probe(wait=True)
  if state=='disabled':raise Blocked('archive_disabled')
  if state=='checking':raise Later('checking')
  if state!='connected':raise Blocked(reason) if reason in BLOCKING else Later('rate_limited' if reason=='rate_limited' else 'network')
  found,state=media_store.resolve(p,m,'rlog.zst',self.s.store,backend)
  if state=='missing':return self.done(p,m,summary_fields([]))  # Gone from Drive: there is no route to read.
  if state in ('storage_unavailable','checking'):raise Later('network')
  if state!='available' or found is None:return self.fail(p,m,state)  # corrupt: not the verified file.
  with tempfile.TemporaryDirectory(dir=self.s.ROOT,prefix=self.TEMP_PREFIX) as temp:
   if isinstance(found,Path):fields=self.read(p,found)  # A local file came back meanwhile.
   else:
    dest=Path(temp)/'rlog.zst'
    try:backend.download_to(found.ref,dest,found.ref.sha256)
    except BackendError as e:
     if e.code=='not_found':return self.done(p,m,summary_fields([]))
     if e.code=='auth_expired':raise Blocked('auth_expired') from None
     if e.code in ('mismatch','io'):return self.fail(p,m,e.code)
     raise Later('rate_limited' if e.code in ('rate_limited','quota_exceeded') else 'network') from None
    fields=self.read(p,dest)
  # The temporary directory, and the downloaded log with it, is gone here.
  if fields is None:return self.fail(p,m,'read_failed')
  return self.done(p,m,fields)
 def done(self,p,m,fields):
  if self.commit(p,m,fields,{FAILURES:None}) and self.counts:self.counts['done']+=1
 def fail(self,p,m,why):
  # Counted in the summary; after MAX_FAILURES the log is skipped (and marked unread, so the local backfill stops too).
  log.warning('Drive track of %s failed: %s',p.name,why)
  prepared=p/'prepared';count=[]
  def write():
   file=prepared/'summary.json';summary=json.loads(file.read_text());n=int(summary.get(FAILURES) or 0)+1;count.append(n)
   update={FAILURES:n}
   if n>=MAX_FAILURES and summary.get('track_v')!=TRACK_V:update.update(summary_fields([],read=False))
   self.s.atomic_json(file,{**summary,**update})
  if self.s.commit_prepared(p,m,write) and count and count[0]>=MAX_FAILURES and self.counts:self.counts['failed']+=1

if __name__=='__main__':
 # One log per child: the server never holds a whole decoded log in memory.
 print(json.dumps(extract(sys.argv[1],sys.argv[2])))
