"""Fills the following-distance setting (gap) and the planner's target distance (gapTarget) into replay data converted
before 1.3.0, from the rlog alone: no video is read and nothing else in the replay changes.

One worker thread, one log at a time, newest first, each read in a low-priority child process (the server never holds
a decoded log or a whole replay in memory). A log is filled once per conversion: summary.json gets gap_backfill 1
(a reconversion writes a new summary, and new conversions have the values already: a replay whose frames carry gap is
only marked, its rlog never read).

Which logs: ready, made by the current decoder, replay data in the current format (the startup migration owns the
others until it has rewritten them), not marked yet. The rlog is read where it is stored: locally, in place on the NAS,
or from Google Drive through a verified temporary copy (server.stage_remote) removed as soon as the child is done. A log
whose rlog cannot be read now (archive unreachable, Drive error, no space, removed, read failure) is skipped and marked
nothing; it is tried again after the next start.

Never alongside other work on a log: it waits while a conversion is queued or running, an upload is arriving, a video
is being watched (backfill.Backfill.busy) or an archive run is moving files. A queued conversion, or any change to the
log (conversion, reconversion, removal, deletion) while the child reads, stops the child and the log is left as it
was. The new data.json.gz is written in a temporary directory under the data root and moved over the old one under the
server lock, only while the log still holds the conversion it was read from (server.commit_prepared) and its replay
file is the one the child read: a reader sees the old file or the new one, never a partial one, and the new file's
mtime gives /data a new ETag.
"""
import gzip,json,logging,os,shutil,subprocess,sys,tempfile,threading,time
from pathlib import Path

log=logging.getLogger(__name__)
# The add-on configures no logging, so only warnings reach its log: progress is written as one too (short lines).
progress=log.warning
MARK='gap_backfill'  # summary.json: 1 once this conversion's replay has gap and gapTarget.
HEAD_BYTES=4*2**20  # Decompressed bytes of data.json.gz searched for the keys: the first frames come right after the header.

def has_gaps(file):
 """Whether the replay's first frames already carry the values (converted with 1.3.0 or later)."""
 with gzip.open(file,'rb') as f:return b'"gapTarget":' in f.read(HEAD_BYTES)

def fill(rlog,data_file,out):
 """Writes data_file with each frame's gap and gapTarget from rlog to out (the child's work)."""
 import decoder
 from compact import write_gzip_json
 data=json.loads(gzip.decompress(Path(data_file).read_bytes()))
 frames=data.get('frames') or []
 if frames and all('gap' in frame for frame in frames):return {'already':True}
 order,gaps=decoder.read_gaps(rlog)
 # The frames are prepare()'s model frames in the same order: a different list means another log or decoder.
 if [frame.get('id') for frame in frames]!=[frame_id for frame_id,_ in order]:raise ValueError('replay frames do not match the log')
 for frame,(_,stamp) in zip(frames,order):frame['gap'],frame['gapTarget']=gaps.at(stamp)
 write_gzip_json(out,data,ensure_ascii=False)
 return {'filled':len(frames)}

class GapBackfill:
 START_DELAY=300;INTERVAL=3600;BUSY_RETRY=60;PAUSE=2.0;POLL=1.0;TIMEOUT=600
 TEMP_PREFIX='.gap-'
 def __init__(self,server,pause=None,clock=time.monotonic):
  self.s,self.clock=server,clock;self.pause=self.PAUSE if pause is None else pause
  self.stopped=threading.Event();self.wake=threading.Event();self.thread=None
  self.skipped=set()  # Logs that could not be read since this start: tried again after the next one.
  self.reported=None
 def start(self,delay=None):
  for stale in Path(self.s.ROOT).glob(self.TEMP_PREFIX+'*'):shutil.rmtree(stale,ignore_errors=True)  # Left by a restart mid-read.
  self.thread=threading.Thread(target=self._loop,args=(self.START_DELAY if delay is None else delay,),name='gap-backfill',daemon=True);self.thread.start()
 def _loop(self,delay):
  self.wake.wait(delay)
  while not self.stopped.is_set():
   self.wake.clear()
   try:more=self.run_once()
   except Exception:log.exception('Gap fill stopped');more=False
   self.wake.wait(self.BUSY_RETRY if more else self.INTERVAL)

 # --- Which logs, and when.
 def queued(self):
  pool=self.s.pool
  with pool.condition:return set(pool.pending)|set(pool.active)
 def busy(self):
  s=self.s;archiver=getattr(s,'archiver',None)
  if self.queued() or s.processes:return True  # Conversions go first.
  if archiver and (getattr(archiver,'running',False) or getattr(archiver,'manual_active',False)):return True
  return s.list_backfill.busy()  # Uploads arriving, a conversion running, someone watching.
 def needs(self,p,m):
  s=self.s;prepared=p/'prepared'
  if m.get('status')!='ready' or m.get('decoder_version')!=s.DECODER_VERSION or p.name in self.skipped:return False
  if not (prepared/'data.json.gz').is_file() or (prepared/'data.json').is_file() or s.replay_outdated(p):return False
  try:summary=json.loads((prepared/'summary.json').read_text())
  except (OSError,ValueError):return False
  return isinstance(summary,dict) and summary.get(MARK)!=1
 def targets(self):
  paths=[]
  for p in self.s.recording_paths():
   try:paths.append((p.stat().st_mtime,p))
   except OSError:pass
  rows=[]
  for _,p in sorted(paths,reverse=True):
   try:
    if self.needs(p,self.s.read_meta(p)):rows.append(p)
   except (OSError,ValueError):pass
  return rows
 def run_once(self):
  """Whether work remains for soon (it waited for other work)."""
  rows=self.targets();total=len(rows);done=0
  if total and total!=self.reported:progress('Gap fill: %d logs to fill',total)  # Not again on each retry after waiting.
  self.reported=total
  for n,p in enumerate(rows,1):
   if self.stopped.is_set():return False
   if self.busy():
    if done:progress('Gap fill: %d/%d logs, waiting for other work',done,total)
    return True
   try:result=self.process(p)
   except Exception:log.warning('Gap fill of %s failed',p.name,exc_info=True);self.skipped.add(p.name);result='skipped'
   if result=='busy':return True
   if result in ('filled','marked'):done+=1
   if n%25==0 or n==total:progress('Gap fill: %d/%d logs',n,total)
   if self.pause and result=='filled':self.stopped.wait(self.pause)
  return False

 # --- One log.
 def current(self,p,m):
  # The log still holds the conversion m was read with and nothing else is working on it.
  try:now=self.s.read_meta(p)
  except (OSError,ValueError):return False
  return now.get('status')=='ready' and now.get('conversion_revision',0)==m.get('conversion_revision',0) and p.name not in self.s.processes and p.name not in self.queued()
 def process(self,p):
  """'filled', 'marked' (already had the values), 'skipped' (cannot be read now; not marked) or 'busy'."""
  import media_store
  s=self.s;data_file=p/'prepared'/'data.json.gz'
  with s.lock:
   m=s.read_meta(p)
   if not self.needs(p,m) or not self.current(p,m):return 'skipped'
   before=self.stamp(data_file)
  if has_gaps(data_file):return 'marked' if self.commit(p,m,before,None) else 'skipped'
  found,state=media_store.resolve(p,m,'rlog.zst',s.store,s.backend)
  if state!='available' or found is None:return self.skip(p,'rlog '+state)
  staged=None
  try:
   if isinstance(found,media_store.RemoteFile):
    try:staged=found=s.stage_remote(p,found)
    except Exception as e:return self.skip(p,'download '+str(getattr(e,'code',type(e).__name__)))
   with tempfile.TemporaryDirectory(dir=s.ROOT,prefix=self.TEMP_PREFIX) as temp:
    out=Path(temp)/'data.json.gz'
    result=self.read(p,m,found,data_file,out)
    if result=='busy':return 'busy'
    if result is None:return self.skip(p,'read failed')
    if not self.commit(p,m,before,out if result.get('filled') else None):return 'busy'  # The log changed meanwhile.
    return 'filled' if result.get('filled') else 'marked'
  finally:
   if staged is not None:s.unstage(staged)
 def skip(self,p,why):
  log.warning('Gap fill skipped %s until the next start: %s',p.name,why);self.skipped.add(p.name);return 'skipped'
 @staticmethod
 def stamp(file):
  try:st=file.stat()
  except OSError:return None
  return (st.st_mtime_ns,st.st_size,st.st_ino)
 def read(self,p,m,rlog,data_file,out):
  """The child's result, None when it failed, or 'busy' when it was stopped to make way for other work."""
  try:proc=subprocess.Popen([*getattr(self.s,'LOW_PRIORITY',[]),sys.executable,'-B',str(Path(__file__).resolve()),str(rlog),str(data_file),str(out)],stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,preexec_fn=lambda:os.nice(10) if hasattr(os,'nice') else None)
  except OSError:log.warning('Gap fill of %s could not start',p.name,exc_info=True);return None
  deadline=self.clock()+self.TIMEOUT
  try:
   while True:
    try:stdout,stderr=proc.communicate(timeout=self.POLL);break
    except subprocess.TimeoutExpired:
     if self.stopped.is_set() or not self.current(p,m):return 'busy'
     if self.clock()>deadline:log.warning('Gap fill of %s timed out',p.name);return None
  finally:
   if proc.poll() is None:proc.kill();proc.communicate()
  if proc.returncode:log.warning('Gap fill of %s could not read the log: %s',p.name,stderr.strip()[-300:]);return None
  try:return json.loads(stdout.strip().splitlines()[-1])
  except (ValueError,IndexError):return None
 def commit(self,p,m,before,out):
  # Under the lock, only into the conversion it was read from and over the very file the child read.
  s=self.s;prepared=p/'prepared'
  def write():
   if self.stamp(prepared/'data.json.gz')!=before or p.name in self.queued():raise Changed()
   if out is not None:os.replace(out,prepared/'data.json.gz')
   file=prepared/'summary.json'
   s.atomic_json(file,{**json.loads(file.read_text()),MARK:1})
  try:return s.commit_prepared(p,m,write)
  except Changed:return False
  except FileNotFoundError:return False  # Deleted meanwhile.

class Changed(Exception):pass

if __name__=='__main__':
 # One log per child: the server never holds a decoded log or a whole replay in memory.
 print(json.dumps(fill(sys.argv[1],sys.argv[2],sys.argv[3])))
