"""Background backfill of the list's thumbnail, started_at and drive_summary for logs converted before they
existed, archived logs included (their files may be on the NAS or only on Google Drive). The list (/api/logs) only
reads what is stored here and by conversion; it never opens a log, its telemetry or a video.

Starts written before start_v 2 (a device clock first, often stale) are read again, the same way.

Order: logs the list asked for, then the first segment of every drive (its card's picture and start time), newest
drive first, then the other segments, newest first. A log whose files cannot be read now (its NAS is not the
active archive, a Drive file errors, an unexpected failure) goes to the end of the next runs instead of stopping
the whole backfill; only TRANSIENT_LIMIT such logs in a row (the archive itself is down), or a run where nothing
worked, back off.

One worker thread, one log at a time, a pause between logs and at most RUN_CAP logs per run. It waits while
uploads, conversions, an archive run or a Drive-backed playback are active, and backs off exponentially after
a Drive error. Files are never downloaded whole: a NAS file is read in place (only its first bytes / frames),
a Drive file through ranged downloads of its first PREFIX_BYTES (plus, for an MP4 whose moov box is at the
end, that box alone, up to MOOV_MAX). Results go where conversion puts them (prepared/thumbnail.jpg,
summary.json started_at and its start fields) under the server lock and only into the conversion they were made from.

Cached as unknown, per conversion: started_at null with start_v (the log was read and has no usable clock; a log
with no readable rlog keeps its old start, marked 'device') and
prepared/thumbnail.failed (every source was read and none decoded). An unreachable archive or a Drive error is
never cached: the log is tried again on a later run.
"""
import gzip,json,logging,tempfile,threading,time
from pathlib import Path
import media_store,wall_clock
from telemetry import drive_summary

log=logging.getLogger(__name__)
PREFIX_BYTES=2*2**20
MOOV_MAX=8*2**20
PAUSE_SECONDS=2.0;RUN_CAP=50
START_DELAY=120;INTERVAL=900;BUSY_RETRY=60
TRANSIENT_LIMIT=3  # Logs in a row that could not be read: the archive is down, back off.
BACKOFF_START=60;BACKOFF_MAX=3600
WATCHING_SECONDS=120  # A Drive video played within this long counts as being watched.
THUMBNAIL_KINDS=('camera.mp4','qcamera.ts','fcamera.mp4','fcamera.hevc')  # Smallest first: qcamera, then front.
THUMBNAIL_FAILED='thumbnail.failed'
TRANSIENT_STATES=('storage_unavailable','checking')
MISSING=object()  # Not decided now (unreachable, busy): nothing is cached.

def drive_key(order):
 # recording_order(): (1, route counter, route id, segment, id) for a numbered route; anything else stands alone.
 return order[1:3] if order[0]==1 else order

class Transient(Exception):
 """A Drive or share error for one log: nothing is cached, the log is tried again after the others."""

def archived(m,kind):
 # Only the archive has this file (NAS or Drive), or a remote copy stands in for a local file that is gone.
 where=media_store.location(m,kind)
 return media_store.is_archived_location(where) or where=='local' and media_store.remote(m,kind) is not None

def archived_thumbnail_source(p,m):
 return any(archived(m,kind) and not (p/kind).is_file() for kind in THUMBNAIL_KINDS)

def mp4_atoms(data,base=0):
 # (offset, type, size) of the top-level boxes that start inside data; size None runs to the end of the file.
 offset=0
 while offset+8<=len(data):
  size=int.from_bytes(data[offset:offset+4],'big');kind=data[offset+4:offset+8];header=8
  if size==1:
   if offset+16>len(data):return
   size=int.from_bytes(data[offset+8:offset+16],'big');header=16
  elif size==0:size=None
  yield base+offset,kind,size
  if size is None or size<header:return
  offset+=size

def moov_location(head):
 """None when the moov box is complete in head; (offset, size or None) where it is otherwise; False if unknown."""
 for offset,kind,size in mp4_atoms(head):
  if kind==b'moov':return None if size is not None and offset+size<=len(head) else (offset,size)
  if kind==b'mdat':return (offset+size,None) if size is not None else False
 return False

class Backfill:
 def __init__(self,server,clock=time.monotonic,pause=PAUSE_SECONDS,run_cap=RUN_CAP):
  self.s,self.clock,self.pause,self.run_cap=server,clock,pause,run_cap
  self.event=threading.Event();self.lock=threading.Lock();self.priority=[]
  self.backoff=0;self.retry_at=0;self.thread=None;self.stopped=threading.Event()
  self.deferred=set()  # Logs that could not be read last time: tried after all others.

 def start(self,delay=START_DELAY):
  self.thread=threading.Thread(target=self._loop,args=(delay,),name='list-backfill',daemon=True);self.thread.start()

 def wake(self,id=None):
  # A new ready log, or a thumbnail the list asked for (that log goes first).
  if id:
   with self.lock:
    if id in self.priority:self.priority.remove(id)
    self.priority.insert(0,id)
  self.event.set()

 def _loop(self,delay):
  self.event.wait(delay)
  while not self.stopped.is_set():
   self.event.clear()
   wait=max(0,self.retry_at-self.clock())
   if not wait:
    try:done,more=self.run_once()
    except Exception:log.exception('List backfill stopped');more=False
    wait=BUSY_RETRY if more else INTERVAL
   self.event.wait(wait)

 def busy(self):
  s=self.s
  if s.processes or s.upload_receiving() or getattr(s.archiver,'running',False):return True
  # Someone is watching: any video request (local files included, not only archived ones) in the last two minutes.
  if time.monotonic()-getattr(s,'last_video_request',-1e9)<WATCHING_SECONDS:return True
  entry=getattr(s.playback,'entry',None)
  return entry is not None and s.playback.clock()-entry.used<WATCHING_SECONDS

 def needs(self,p,m):
  if m.get('status')!='ready':return set()
  prepared=p/'prepared'
  try:summary=json.loads((prepared/'summary.json').read_text())
  except (OSError,ValueError):return set()
  out=set()
  if not (prepared/'thumbnail.jpg').is_file() and not (prepared/THUMBNAIL_FAILED).exists():out.add('thumbnail')
  # Starts before start_v 2 came from a device clock that may not have been synced yet: read again (from GPS).
  if summary.get('start_v')!=wall_clock.START_V:out.add('started_at')
  if 'drive_summary' not in summary and self.telemetry_file(p):out.add('drive_summary')
  return out

 @staticmethod
 def telemetry_file(p):
  return next((f for f in (p/'prepared'/'telemetry.json.gz',p/'prepared'/'telemetry.json') if f.is_file()),None)

 def drive_summary(self,p):
  # From the local converted telemetry; null (unknown) when it does not parse, MISSING when it went away.
  f=self.telemetry_file(p)
  if f is None:return MISSING
  try:
   raw=f.read_bytes()
   return drive_summary(json.loads(gzip.decompress(raw) if f.suffix=='.gz' else raw))
  except FileNotFoundError:return MISSING
  except Exception:
   log.warning('Drive summary of %s could not be computed',p.name,exc_info=True);return None

 def candidates(self):
  with self.lock:first,self.priority=self.priority,[]
  paths=[]
  for id in first:
   if self.s.ID.fullmatch(id) and (self.s.ROOT/id/'meta.json').is_file():paths.append(self.s.ROOT/id)
  rest=[]
  for p in self.s.recording_paths():
   try:rest.append((self.s.recording_order(self.s.read_meta(p)),p))
   except (OSError,ValueError):pass
  # Newest first: those are the ones the list shows on top. The first segment of each drive is its card.
  rest.sort(key=lambda row:row[0],reverse=True)
  first_segment={}
  for order,p in rest:first_segment[drive_key(order)]=p  # Descending: the last one seen is the first segment.
  cards=set(first_segment.values())
  ordered=[p for _,p in rest if p in cards]+[p for _,p in rest if p not in cards]
  paths+=[p for p in ordered if p not in paths and p.name not in self.deferred]+[p for p in ordered if p not in paths and p.name in self.deferred]
  return paths

 def run_once(self):
  """(logs processed, whether work remains for soon: busy, capped or backed off)."""
  done=0;failed=0;in_row=0;last=None
  for p in self.candidates():
   try:m=self.s.read_meta(p)
   except (OSError,ValueError):continue
   need=self.needs(p,m)
   if not need:self.deferred.discard(p.name);continue
   if done>=self.run_cap:return done,True
   if self.busy():return done,True
   try:self.process(p,m,need)
   except Transient as e:
    # This log's archive cannot be read now: the others go on, it is tried again after them next time.
    self.deferred.add(p.name);failed+=1;in_row+=1;last=e
    if in_row>=TRANSIENT_LIMIT:return done,self.back_off(e)
    continue
   except Exception:
    log.warning('List backfill of %s failed',p.name,exc_info=True)
    self.deferred.add(p.name);failed+=1;continue
   self.deferred.discard(p.name);done+=1;in_row=0
   if self.pause:self.stopped.wait(self.pause)
  if failed and not done:return done,self.back_off(last)
  self.backoff=0
  return done,False  # Logs that failed wait for the next regular run.

 def back_off(self,error):
  self.backoff=min(BACKOFF_MAX,max(BACKOFF_START,self.backoff*2));self.retry_at=self.clock()+self.backoff
  log.warning('List backfill paused for %d s: %s',self.backoff,error)
  return True

 # Reading

 def resolve(self,p,m,kind):
  found,state=media_store.resolve(p,m,kind,self.s.store,self.s.backend)
  if state in TRANSIENT_STATES:raise Transient(kind+' '+state)
  return found if state=='available' else None

 def read(self,found,start,length):
  # At most `length` bytes from start: a NAS/local file read in place, a Drive file by one ranged download.
  if isinstance(found,Path):
   try:
    with open(found,'rb') as f:f.seek(start);return f.read(length)
   except OSError as e:raise Transient(type(e).__name__) from None
  from archive_backends import BackendError
  end=min(start+length,found.size)-1
  if end<start:return b''
  try:
   blocks=self.s.backend.open(found.ref,start,end);data=bytearray()
   try:
    for block in blocks:
     data+=block
     if len(data)>=length:break
   finally:
    if hasattr(blocks,'close'):blocks.close()
  except BackendError as e:
   if e.code in ('not_found','mismatch'):return None
   raise Transient(e.code) from None
  return bytes(data[:length])

 def started_at(self,p,m):
  """The start fields (wall_clock.Starts.fields) from the first bytes of the log; None when there is no log to
  read (removed, not readable as stored) or it is not a readable log."""
  found=self.resolve(p,m,'rlog.zst')
  if found is None:return None  # Removed, or not readable as stored: no start to find.
  data=self.read(found,0,wall_clock.SCAN_BYTES)
  if data is None:return None
  try:return wall_clock.scan_bytes(data)
  except Exception:
   log.warning('Start time of %s could not be read',p.name,exc_info=True);return None

 def start_fields(self,p,m):
  # Cached per conversion (start_v): a log that cannot be read keeps the start it has, marked as from the device.
  fields=self.started_at(p,m)
  if fields is not None:return fields
  try:old=json.loads((p/'prepared'/'summary.json').read_text()).get('started_at')
  except (OSError,ValueError):old=None
  return {'started_at':old,'start_source':'device' if old is not None else None,'first_mono':None,'gps_offset':None,'clock_offset':None,'start_v':wall_clock.START_V}

 def remote_thumbnail(self,thumbnails,found):
  head=self.read(found,0,PREFIX_BYTES)
  if not head:return None
  moov=None
  if found.kind.endswith('.mp4') and len(head)<found.size:
   where=moov_location(head)
   if where is False:return None  # No moov box in sight: not decodable from a prefix.
   if where:
    offset,size=where;length=(size if size else found.size-offset)
    if offset>=found.size or length>MOOV_MAX:return None
    tail=self.read(found,offset,length)
    if not tail or tail[4:8]!=b'moov':return None
    moov=(offset,tail)
  with tempfile.TemporaryDirectory(dir=self.s.ROOT,prefix='.thumbnail-') as temp:
   path=Path(temp)/found.kind
   with open(path,'wb') as f:
    f.write(head)
    # A sparse file: the frames at the start and the index at its own offset, nothing in between.
    if moov:f.seek(moov[0]);f.write(moov[1])
   return thumbnails.make_thumbnail([path])

 def thumbnail(self,p,m):
  import thumbnail as thumbnails  # PyAV, only when there is something to make.
  local=self.s.thumbnail_sources(p,m)
  if local:
   data=thumbnails.make_thumbnail(local)
   if data:return data
  for kind in THUMBNAIL_KINDS:
   if not archived(m,kind) or (p/kind).is_file():continue
   found=self.resolve(p,m,kind)
   if found is None:continue
   data=thumbnails.make_thumbnail([found]) if isinstance(found,Path) else self.remote_thumbnail(thumbnails,found)
   if data:return data
  return None  # Every source was read (or there is none) and nothing decoded.

 def process(self,p,m,need):
  updates={};data=MISSING
  if 'started_at' in need:updates.update(self.start_fields(p,m))
  if 'drive_summary' in need:
   value=self.drive_summary(p)
   if value is not MISSING:updates['drive_summary']=value
  if 'thumbnail' in need:data=self.thumbnail(p,m)
  def write():
   prepared=p/'prepared'
   if updates:
    file=prepared/'summary.json'
    self.s.atomic_json(file,{**json.loads(file.read_text()),**updates})
   if data is not MISSING:
    import thumbnail as thumbnails
    if data:thumbnails.write_thumbnail(prepared,data)
    else:(prepared/THUMBNAIL_FAILED).touch()
  self.s.commit_prepared(p,m,write)
