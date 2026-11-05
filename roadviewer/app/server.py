from pathlib import Path,PurePosixPath
import gzip,hashlib,unicodedata,math,zipfile
import os,json,uuid,time,shutil,threading,subprocess,sys,re,tempfile,atexit
import playback_cache
from collections import Counter
from progress import ProgressChannel
from work_queue import ProcessingQueue
from flask import Flask,request,jsonify,send_file,send_from_directory,abort,g as request_state
from werkzeug.exceptions import HTTPException
from storage_policy import StoragePolicy,StorageError,atomic_json
import media_store,archive_backends,archive_settings as archive_config
from device_api import DeviceAPI
from device_network import DeviceNetwork
from video_sources import SOURCES,ORIGINALS,DERIVED,VIDEO_KINDS,CAMERA_KINDS,UPLOAD_KINDS,STORED_KINDS,validate_hevc,validate_mp4
BASE=Path(__file__).resolve().parent
ROOT=Path(os.environ.get('RV_DATA','/data/roadviewer'));ROOT.mkdir(parents=True,exist_ok=True)
options_path=Path('/data/options.json');options=json.loads(options_path.read_text()) if options_path.exists() else {}
options.update(json.loads(os.environ.get('RV_ARCHIVE_OPTIONS_JSON','{}')))  # Archive options for tests only; production never sets it.
DEVICE_HOST_PORT=int(os.environ.get('RV_DEVICE_HOST_PORT','0')) or None
app=Flask(__name__,static_folder=None)
app.config.update(MAX_CONTENT_LENGTH=int(options.get('max_upload_mb',512))*1024*1024,MAX_FORM_PARTS=220)
lock=threading.RLock();processes={};job_progress={};active_uploads=Counter();finishing_uploads=set();registration_lock=threading.Lock()
upload_hashes={}  # Session/file -> (stat fingerprint, incremental SHA256); restart falls back to disk verification.
upload_file_locks={}  # Session/file -> Lock: one chunk per file at a time, so disk writes and hashing stay outside the job lock.
ID=re.compile(r'^[a-f0-9]{32}$');FLAT=re.compile(r'^(?P<route>.{20})--(?P<segment>\d+)--(?P<kind>'+ '|'.join(map(re.escape,UPLOAD_KINDS))+r')$')
def folder(id):
 if not ID.fullmatch(id):abort(404)
 p=ROOT/id
 if not (p/'meta.json').is_file():abort(404)
 return p

def read_meta(p):return json.loads((p/'meta.json').read_text())
def save_meta(p,m):
 temp=p/'meta.tmp';temp.write_text(json.dumps(m,ensure_ascii=False));temp.replace(p/'meta.json')
def stored(p,m,kind):
 # Registered for this recording: on the archive by the index (reachable or not), present locally, or a local
 # entry whose verified remote copy stands in for a local file that is gone (as resolve serves it).
 where=media_store.location(m,kind)
 return media_store.is_archived_location(where) or where=='local' and ((p/kind).is_file() or media_store.remote(m,kind) is not None)
def original_bytes(p,m=None,kinds=STORED_KINDS):return sum(media_store.media_size(p,m or {},k,store) for k in kinds if stored(p,m or {},k))
def has_video(p,m):return any(stored(p,m,k) for k in (*ORIGINALS,*DERIVED.values()))
# A recording's metadata as API responses show it: never an upload's session URI (a credential) or remote file ids.
def public_meta(m):return dict(m,storage=media_store.public_storage(m['storage'])) if 'storage' in m else m
def archived(m):return any(media_store.is_archived_location(media_store.location(m,k)) for k in media_store.MEDIA_KINDS)
def video_download_kind(p,m):
 return next((kind for source in ('front','qcamera','wide') for kind in SOURCES[source][:2] if stored(p,m,kind)),None)
def video_downloads(p,m):
 # One entry per stored camera (front f, wide e, low-res q): its original, or the MP4 kept instead of it.
 rows=[]
 for source in ('front','wide','qcamera'):
  kind=next((kind for kind in SOURCES[source][:2] if stored(p,m,kind)),None)
  if kind:rows.append({'source':source,'kind':kind,'bytes':media_store.media_size(p,m,kind,store)})
 return rows
MEDIA_ERRORS={'storage_unavailable':(503,'영상 저장소에 연결할 수 없습니다. NAS 연결을 확인하세요.'),
 'storage_checking':(503,'영상 저장소 연결을 확인하는 중입니다. 잠시 후 다시 시도하세요.'),
 'media_corrupt':(409,'영상 파일을 읽을 수 없습니다. 손상되었을 수 있습니다.'),
 'insufficient_disk_space':(507,'보관된 파일을 내려받을 디스크 공간이 부족합니다.')}
REMOTE_UNAVAILABLE='영상 저장소(Google Drive)에 연결할 수 없습니다. 인터넷과 Google Drive 연결을 확인하세요.'
def remote_backend():return backend.caps.kind!='smb'
def remote_result():
 # A remote backend's (state, reason) from its cache; a stale one is refreshed in the background, so a request
 # never waits on the internet (the probe's own lock keeps concurrent refreshes to one).
 result=backend.last_result()
 if result is None:
  threading.Thread(target=backend.probe,name='archive-probe',daemon=True).start()
  return 'checking','probe_pending'
 return result
def archive_state():
 # The active backend's state, outside the locks: the share's check for the NAS (as before), Drive's cache.
 return remote_result()[0] if remote_backend() else store.state()
def archive_last_state():
 # The active backend's latest result without probing, for callers holding the locks.
 return backend.last_state() if remote_backend() else store.last_state()
def media_file(p,m,kind):
 # The readable file (a Path, or a RemoteFile only the remote backend has), or None if it does not exist.
 # An unreachable archive or a recorded read error is answered (503/409) instead: it must never look like
 # a missing file to the caller.
 path,state=media_store.resolve(p,m,kind,store,backend)
 if state in ('available','missing'):return path
 error={'storage_unavailable':'storage_unavailable','checking':'storage_checking','corrupt':'media_corrupt'}[state]
 if remote_entry(m,kind):request_state.remote_unavailable=True  # The answer names Google Drive instead of the NAS.
 abort(MEDIA_ERRORS[error][0],description=error)
def remote_entry(m,kind):
 # The file is (or would be read) on a remote backend rather than the NAS or local disk.
 where=media_store.location(m,kind)
 return where in media_store.REMOTE_BACKENDS or where=='local' and media_store.remote(m,kind) is not None
def media_path(p,m,kind):
 path=media_file(p,m,kind)
 if path is None:abort(404)
 return path
STATE_RANK=('available','corrupt','checking','storage_unavailable','missing')
def registered(p,m,kind):return stored(p,m,kind) or media_store.location(m,kind)=='removed'
def video_states(p,m,share):
 # Per camera, the best state among its registered files (original or kept MP4); removed ones count as missing.
 # share: the archive's state, checked once per list request (archived files are judged by the index).
 states={}
 for source,(original,mp4,_) in SOURCES.items():
  found=[media_store.indexed_state(p,m,kind,share) for kind in (original,mp4) if registered(p,m,kind)]
  if found:states[source]=min(found,key=STATE_RANK.index)
 return states
def storage_locations(p,m):
 locations={}
 for part,kinds in {'rlog':('rlog.zst',),**{source:row[:2] for source,row in SOURCES.items()}}.items():
  where={media_store.location(m,kind) for kind in kinds if registered(p,m,kind)}
  if where:locations[part]=next(w for w in (*media_store.REMOTE_LOCATIONS,'local','removed') if w in where)
 return locations
def remote_copies(p,m):
 # Parts whose local file also has a verified copy on a remote backend: {part: backend}.
 copies={}
 for part,kinds in {'rlog':('rlog.zst',),**{source:row[:2] for source,row in SOURCES.items()}}.items():
  for kind in kinds:
   block=media_store.remote(m,kind)
   if block and media_store.location(m,kind)=='local' and isinstance(block.get('backend'),str):copies.setdefault(part,block['backend'])
 return copies
def archive_errors(m):
 # Files whose remote copy did not verify; the local file is kept and plays. A later task offers a retry.
 return {kind:'remote_mismatch' for kind in media_store.MEDIA_KINDS if media_store.entry(m,kind).get('error')=='remote_mismatch'}

STREAM_BLOCK=65536
STAGING_MARGIN=100*1024*1024
class StagingSpace(Exception):pass
class InsufficientStorage(HTTPException):code=507  # werkzeug's abort() knows no 507.
def abort_remote(e):
 # A backend failure while reading: a copy that does not match its index is corrupt, a file gone since it was
 # resolved is missing, anything else (network, auth, rate) is an unreachable archive.
 if e.code=='not_found':abort(404)
 error='media_corrupt' if e.code=='mismatch' else 'storage_unavailable';request_state.remote_unavailable=True
 abort(MEDIA_ERRORS[error][0],description=error)
def stage_remote(p,rf):
 # A local, hash-verified copy of a remote-only file where a path is needed (original-format export, the
 # decoder's inputs), under p/.staging; the caller removes it (unstage). Remote I/O: never under a lock.
 if shutil.disk_usage(ROOT).free<rf.size+STAGING_MARGIN:raise StagingSpace()
 dest=p/'.staging'/uuid.uuid4().hex/rf.kind
 dest.parent.mkdir(parents=True)
 try:backend.download_to(rf.ref,dest,rf.ref.sha256)
 except BaseException:
  unstage(dest);raise
 return dest
def local_content(p,m,kind):
 # ((size, mtime_ns), sha256) of a local file, reusing the recorded hash while the file is unchanged; None if absent.
 # Reads the file otherwise: never under a lock.
 try:st=(p/kind).stat()
 except OSError:return None  # Gone, or unreadable: the lock-time stat decides.
 known=(m.get('content_hashes') or {}).get(kind)
 fresh=isinstance(known,dict) and known.get('size')==st.st_size and known.get('mtime_ns')==st.st_mtime_ns and isinstance(known.get('sha256'),str)
 if fresh:return (st.st_size,st.st_mtime_ns),known['sha256']
 try:return (st.st_size,st.st_mtime_ns),file_digest(p/kind)
 except OSError:
  # Unverifiable: the copy is not promoted (the registration drops it); the conversion itself goes on.
  app.logger.warning('Reading %s/%s failed; its remote copy cannot be checked against it',p.name,kind)
  return None
def unstage(path):
 shutil.rmtree(path.parent,ignore_errors=True)
 try:path.parent.parent.rmdir()  # .staging itself, once no other download or conversion uses it.
 except OSError:pass
def staged_source(p,rf):
 # A staged copy opened for reading. The file is removed at once: the open descriptor keeps it readable.
 try:path=stage_remote(p,rf)
 except StagingSpace:raise InsufficientStorage(description='insufficient_disk_space') from None
 except archive_backends.BackendError as e:abort_remote(e)
 try:return path.open('rb')
 finally:unstage(path)
class RemoteBody:
 # The remote file (or one range of it) as small chunks: a response never holds more than one block.
 # close() ends the backend's download too, also when the client went away before the first chunk.
 def __init__(self,body):self.body=body
 def __iter__(self):
  for block in self.body:
   for i in range(0,len(block),STREAM_BLOCK):yield block[i:i+STREAM_BLOCK]
 def close(self):
  if hasattr(self.body,'close'):self.body.close()
def remote_chunks(rf,start=0,end=None):
 # The request is made here, so an unreachable archive is answered before any byte is sent.
 try:return RemoteBody(backend.open(rf.ref,start,end))
 except archive_backends.BackendError as e:abort_remote(e)
def attachment(response,name):
 from email.message import Message
 disposition=Message();disposition.add_header('Content-Disposition','attachment',filename=name)
 response.headers['Content-Disposition']=disposition['Content-Disposition']
RANGE=re.compile(r'bytes=(\d*)-(\d*)')
# Playback asks for open ranges (bytes=N-). Answering each with at most this much keeps a request the browser
# dropped on a seek from streaming the rest of the file from Google while it holds one of the server's threads.
PLAYBACK_RANGE=16*2**20  # Above the ~4 MB under which Home Assistant Ingress buffers a whole response before sending it.
# Remote videos being watched are copied to a scratch folder (playback_cache.py); outside /data, emptied on start.
PLAYBACK_DIR=os.environ.get('RV_PLAYBACK_CACHE') or (tempfile.gettempdir()+'/roadviewer-playback' if ROOT==Path('/data/roadviewer') else str(ROOT)+'-playback')
playback=playback_cache.PlaybackCache(PLAYBACK_DIR)
def remote_response(rf,mimetype,as_attachment=False,name=None):
 # A file only the remote backend has, served like send_file serves a local one, with one byte range at most.
 size=rf.size;header=request.headers.get('Range');start,end=0,size-1
 if header is not None:
  match=RANGE.fullmatch(header.strip())
  first,last=(match[1],match[2]) if match else ('','')
  if first:start,end=int(first),min(int(last),size-1) if last else size-1 if as_attachment else min(size-1,int(first)+PLAYBACK_RANGE-1)
  elif last:start=max(size-int(last),0)  # bytes=-N: the last N bytes.
  if not (first or last) or not first and int(last)==0 or first and last and int(last)<int(first) or start>=size:
   response=jsonify(error='range_not_satisfiable');response.status_code=416
   response.headers['Content-Range']=f'bytes */{size}';response.headers['Cache-Control']='no-store'
   return response
 partial=header is not None
 body=None
 if not as_attachment:
  # Playback: the part of the local copy already written answers at once (an open range is shortened to it);
  # the copy of the whole file starts with the first request.
  local=playback.local_range(rf.ref,start,end) if partial else None
  if local and (local[1]==end or not (match and match[2])):body=playback.blocks(local[0],start,local[1]);end=local[1]
  source=backend;playback.ensure(rf.ref,rf.size,lambda:source.open(rf.ref))
 if body is None:body=remote_chunks(rf,start,end) if partial else remote_chunks(rf)
 response=app.response_class(body,status=206 if partial else 200,mimetype=mimetype,direct_passthrough=True)
 response.headers['Accept-Ranges']='bytes'
 # Playback has no Content-Length (Content-Range carries the size): Ingress buffers a response it knows is under
 # ~4 MB before sending a byte, which near a video's end would hold a seek until that part came from Google.
 if as_attachment or not partial:response.headers['Content-Length']=str(end-start+1)
 if partial:response.headers['Content-Range']=f'bytes {start}-{end}/{size}'
 # Opaque: derived from the file id and hash without showing either.
 response.headers['ETag']='"'+hashlib.sha256(rf.etag.encode()).hexdigest()[:32]+'"'
 # Playback may be kept in the browser's own cache (the ETag names this exact copy): Chromium drops played ranges from
 # memory while its seek bar still shows them as loaded, and only its HTTP cache lets a seek back there skip Google.
 response.headers['Cache-Control']='no-store' if as_attachment else 'private, max-age=3600'
 if as_attachment:attachment(response,name)
 return response

UPLOAD_QUIET_SECONDS=30
def upload_receiving():
 # A chunk was written recently (upload_chunk touches the session folder) or is being received now.
 if active_uploads:return True
 now=time.time()
 try:return any(d.is_dir() and now-d.stat().st_mtime<UPLOAD_QUIET_SECONDS for d in UPLOADS.iterdir())
 except OSError:return False

# Conversion runs below uploads and the web UI: on a small host (HA Green) a full-priority decoder and
# H.264 encoder took the CPU and disk from the receiving side and slowed or broke device uploads.
LOW_PRIORITY=(['ionice','-c2','-n7','-t'] if shutil.which('ionice') else [])
def run_job(id):
 p=ROOT/id
 proc=None;revision=None;staged=[]
 # Automatic conversions wait (still queued) while segments are arriving; a manual request starts at once.
 while upload_receiving():
  with lock:
   if not (p/'meta.json').exists():return
   m=read_meta(p)
   if m['status']!='queued' or m.get('manual_conversion'):break
  time.sleep(5)
 def update_progress(event):
  with lock:
   if processes.get(id) is proc:job_progress[id]=event
 try:
  with ProgressChannel(update_progress) as channel:
   # Resolve the inputs before taking the lock: an archived file may wait on the NAS.
   try:current=read_meta(p)
   except FileNotFoundError:return
   inputs={kind:media_store.resolve(p,current,kind,store,backend) for kind in STORED_KINDS}
   # A file only the remote backend has is read by the decoder from a verified local copy, staged here (still
   # outside the lock) and removed when the job ends. Nothing is downloaded for a job that will not run.
   short=False
   if current.get('status')=='queued' and (auto_convert or current.get('manual_conversion')):
    remote=[kind for kind,(found,state) in inputs.items() if isinstance(found,media_store.RemoteFile) and state=='available']
    # Room for every copy is checked before the first download: a conversion deferred for space must not
    # download part of its inputs again at each retry.
    if remote and shutil.disk_usage(ROOT).free<sum(inputs[kind][0].size for kind in remote)+STAGING_MARGIN:
     short=True
     for kind in remote:inputs[kind]=(None,'storage_unavailable')
     remote=[]
    for kind in remote:
     try:staged.append(stage_remote(p,inputs[kind][0]));inputs[kind]=(staged[-1],'available')
     except StagingSpace:short=True;inputs[kind]=(None,'storage_unavailable')
     except archive_backends.BackendError as e:inputs[kind]=(None,'corrupt' if e.code=='mismatch' else 'missing' if e.code=='not_found' else 'storage_unavailable')
   def input_path(kind):return inputs[kind][0] if inputs[kind][1]=='available' else p/kind
   with lock:
    if not (p/'meta.json').exists():return
    m=read_meta(p)
    if m['status']!='queued':return
    if not auto_convert and not m.get('manual_conversion'):
     m.update(status='unconverted');save_meta(p,m);return
    if any(state in ('storage_unavailable','checking') or isinstance(found,media_store.RemoteFile) for found,state in inputs.values()):
     # Converting without the archived files would replace a good result with one lacking its videos.
     # 'deferred' marks it for requeueing once the share is back (archiver), independent of the message text.
     error='디스크 공간이 부족해 변환을 미뤘습니다.' if short else '저장소에 연결할 수 없어 변환을 미뤘습니다.'
     m.update(status='unconverted',error=error,deferred='storage');save_meta(p,m);return
    revision=m.get('conversion_revision',0)
    m.pop('deferred',None);m.update(status='processing');save_meta(p,m)
    job_progress[id]={'stage':'log_prepare','percent':0}
    # Archived files are read where they are; replay output and meta.json stay in the local folder (decoder.py).
    options=channel.options()
    env=dict(options.get('env',os.environ),RV_MEDIA_PATHS=json.dumps({kind:str(input_path(kind)) for kind in VIDEO_KINDS}),RV_PREPARED_DIR=str(p/'prepared'),RV_RECORDING_DIR=str(p))
    proc=subprocess.Popen([*LOW_PRIORITY,sys.executable,'-B',str(BASE/'decoder.py'),str(input_path('rlog.zst')),m['name']],stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,preexec_fn=lambda:os.nice(10),**{**options,'env':env});processes[id]=proc
   channel.start()
   try:
    stdout,stderr=proc.communicate(timeout=1800 if any(inputs[k][1]=='available' for k in ('fcamera.hevc','ecamera.hevc')) else 600)
    if proc.returncode:raise ValueError((stderr.strip().splitlines() or ['로그 변환 실패'])[-1][:500])
    # The decoder writes the large data file. Only its small summary is needed here.
    summary=json.loads((p/'prepared/summary.json').read_text())
    with lock:job_progress[id]={'stage':'registering','percent':0}
    # Originals with a remote copy that the registration may delete are hashed now, outside the locks: an
    # identical copy then stands in for the deleted original (promote_remote).
    try:before=read_meta(p)
    except FileNotFoundError:return
    contents={kind:local_content(p,before,kind) for kind in DERIVED if media_store.remote(before,kind)}
    with registration_lock,lock:
     if not (p/'meta.json').exists():return
     m=read_meta(p)
     if m.get('conversion_revision',0)!=revision:return
     available=summary.get('videos',{'qcamera':summary.get('video')})
     for source,(original,mp4,_) in SOURCES.items():
      if not available.get(source) or not (p/'prepared'/mp4).is_file():continue
      # Only a newly verified, codec-preserving result may replace an original.
      expected='h264' if source=='qcamera' else 'hevc'
      if available[source].get('codec')!=expected:continue
      # An archived original stays the stored copy; its MP4 remains converted output in prepared/.
      if media_store.location(m,original)!='local' or media_store.is_archived_location(media_store.location(m,mp4)):continue
      # An MP4 removed by archive cleanup exists again, locally: the index must not hide it.
      if media_store.location(m,mp4)=='removed':m['storage'].pop(mp4)
      (p/'prepared'/mp4).replace(p/mp4)
      # The MP4 is new content: a copy of the previous one no longer describes it (the archiver copies it again).
      if media_store.drop_remote(m,mp4):app.logger.info('Remote copy of %s/%s superseded by a new conversion; it is left on the remote archive',id,mp4)
      if media_store.remote(m,original):
       # The original goes: its copy becomes the stored file if it is the same content, else it is dropped.
       try:st=(p/original).stat()
       except FileNotFoundError:content=None
       else:
        known=contents.get(original)
        content=(st.st_size,known[1] if known and known[0]==(st.st_size,st.st_mtime_ns) else None)
       if not media_store.promote_remote(m,original,content):
        app.logger.info('Remote copy of %s/%s did not match the replaced original; it is left on the remote archive',id,original)
      (p/original).unlink(missing_ok=True)
     m['video_codecs']={**m.get('video_codecs',{}),**{key:info['codec'] for key,info in available.items() if info and info.get('codec')}}
     m['video_origins']={**m.get('video_origins',{}),**{key:info['sourcePts'] for key,info in available.items() if info and 'sourcePts' in info}}
     m['bytes']=original_bytes(p,m)
     m.update(status='ready',manual_conversion=False,duration=summary['duration'],video=has_video(p,m),warnings=summary['warnings'],model_frames=summary['model_frames'],error=None,decoder_version='v28-runtime-geometry');save_meta(p,m)
   except Exception:
    if proc.poll() is None:proc.kill();proc.communicate()
    raise
 except Exception as e:
  try:states=archived_states(p,read_meta(p)) if revision is not None else {}
  except (OSError,ValueError):states={}
  with lock:
   if (p/'meta.json').exists():
    m=read_meta(p)
    if revision is not None and m.get('conversion_revision',0)==revision:
     if reconvertible(m,states):clear_prepared(p,m,states)
     m.update(status='error',error=str(e));save_meta(p,m)
 finally:
  with lock:
   if processes.get(id) is proc:
    processes.pop(id,None);job_progress.pop(id,None)
  for path in staged:unstage(path)

PROCESSING_SETTINGS=ROOT/'.processing-settings.json'
def read_processing_settings():
 try:
  saved=json.loads(PROCESSING_SETTINGS.read_text())
  if not isinstance(saved,dict):saved={}
 except (OSError,ValueError):saved={}
 value=saved.get('concurrency',1)
 return (value if type(value) is int and value in (1,2,3,4) else 1),saved.get('auto_convert',True) is not False,False

def read_processing_limit():return read_processing_settings()[0]
def read_auto_convert():return read_processing_settings()[1]
def read_keep_original_video():return read_processing_settings()[2]

_limit,auto_convert,keep_original_video=read_processing_settings()
pool=ProcessingQueue(run_job,_limit)
def submit(id):pool.submit(id)

def recording_paths():
 return [p for p in ROOT.iterdir() if p.is_dir() and ID.fullmatch(p.name) and (p/'meta.json').is_file()]

def archived_states(p,m,kinds=STORED_KINDS):
 # Resolve the archived kinds BEFORE taking the lock (the share may be slow); local kinds are checked later.
 return {kind:media_store.resolve(p,m,kind,store,backend)[1] for kind in kinds if media_store.is_archived_location(media_store.location(m,kind))}

def reconvertible(m,states=None):
 # Replay data may be discarded for a reconversion only while its log can be read: an archived log by its state
 # resolved beforehand (archived_states), never one removed by NAS cleanup. A local log is handled as before.
 where=media_store.location(m,'rlog.zst')
 return where=='local' or media_store.is_archived_location(where) and (states or {}).get('rlog.zst')=='available'

def clear_prepared(p,m,states=None):
 if (p/'prepared').exists():shutil.rmtree(p/'prepared')
 # Never remove the only retained copy of any camera: an unreachable or unreadable original keeps its MP4.
 # Archived originals count only by states resolved beforehand (archived_states); without one, the MP4 stays.
 for original,mp4 in DERIVED.items():
  where=media_store.location(m,original)
  readable=(p/original).is_file() if where=='local' else media_store.is_archived_location(where) and (states or {}).get(original)=='available'
  if readable:
   (p/mp4).unlink(missing_ok=True)
   # The conversion makes this MP4 again: a copy of the old one must never stand in for the new result.
   media_store.drop_remote(m,mp4)
 m['bytes']=original_bytes(p,m)
 m.update(duration=None,model_frames=None,warnings=[],error=None,conversion_revision=m.get('conversion_revision',0)+1)

def queue_unconverted():
 pending=sorted(((p,read_meta(p)) for p in recording_paths()),key=lambda row:(row[1].get('uploaded',0),row[0].name))
 for p,m in pending:
  if m['status']=='unconverted' and not m.get('auto_excluded'):
   m.update(status='queued',manual_conversion=False);save_meta(p,m);submit(p.name)

@app.route('/api/settings/processing',methods=['GET','POST'])
def processing_settings():
 global auto_convert,keep_original_video
 with lock:
  if request.method=='POST':
   body=request.get_json(silent=True)
   if not isinstance(body,dict) or not body or set(body)-{'concurrency','auto_convert','keep_original_video'}:return jsonify(error='처리 설정이 올바르지 않습니다.'),400
   value=body.get('concurrency',pool.limit);automatic=body.get('auto_convert',auto_convert);keep=body.get('keep_original_video',keep_original_video)
   if type(value) is not int or value not in (1,2,3,4):return jsonify(error='동시 처리 개수는 1~4여야 합니다.'),400
   if type(automatic) is not bool:return jsonify(error='자동 변환 설정은 켜짐 또는 꺼짐이어야 합니다.'),400
   if type(keep) is not bool:return jsonify(error='원본 영상 보관 설정은 켜짐 또는 꺼짐이어야 합니다.'),400
   temp=PROCESSING_SETTINGS.with_suffix('.tmp')
   temp.write_text(json.dumps({'concurrency':value,'auto_convert':automatic,'keep_original_video':False}));temp.replace(PROCESSING_SETTINGS)
   auto_convert=automatic;keep_original_video=False
   if not auto_convert:
    for p in recording_paths():
     m=read_meta(p)
     if m['status']=='queued' and not m.get('manual_conversion'):
      m.update(status='unconverted');save_meta(p,m);pool.discard(p.name)
   pool.set_limit(value)
   if auto_convert:queue_unconverted()
  return jsonify(concurrency=pool.limit,auto_convert=auto_convert,keep_original_video=keep_original_video)

@app.before_request
def access():
 # A separate loopback listener receives ONLY nginx's device API traffic.
 listener=request.environ.get('gunicorn.socket')
 if listener is not None and listener.getsockname()[1]==8098:
  if request.remote_addr!='127.0.0.1' or DEVICE_HOST_PORT is None or not request.path.startswith('/api/device/'):
   abort(404)
  request.max_content_length=STREAM_CHUNK_SIZE+1 if request.method=='PUT' else 65536
  return
 if request.path.startswith('/api/device/'):abort(404)
 # Supervisor is the only accepted network peer in a Home Assistant installation.
 if os.environ.get('RV_INGRESS_ONLY','1')=='1' and request.remote_addr!='172.30.32.2':abort(403)
 if request.method in ('POST','PUT','DELETE') and request.headers.get('X-RoadViewer-Request')!='1':abort(403)
@app.after_request
def fresh_replay_state(response):
 if request.path.startswith(('/api/device/','/api/settings/')):response.headers['Cache-Control']='no-store'
 if request.path.startswith('/view/') or request.path in ('/api/logs','/api/progress','/api/settings/processing'):
  response.headers['Cache-Control']='no-store'
 if request.path.startswith('/api/logs/') and request.path.endswith(('/data','/telemetry')):
  # Finished replay files may be cached but are revalidated (ETag) on every visit; pending states never are.
  response.headers['Cache-Control']='no-cache' if response.status_code in (200,304) else 'no-store'
 return response

@app.errorhandler(HTTPException)
def http_error(e):
 if isinstance(e.description,str) and e.description in MEDIA_ERRORS:
  code,message=MEDIA_ERRORS[e.description]
  if e.description=='storage_unavailable' and request_state.get('remote_unavailable'):message=REMOTE_UNAVAILABLE
  response=jsonify(error=e.description,message=message)
  if e.description=='storage_checking':response.headers['Retry-After']='5'
  return response,code
 if request.path.startswith('/api/device/'):
  message=e.description if isinstance(e.description,str) and re.fullmatch(r'[a-z_]+',e.description) else {400:'invalid_request',401:'unauthorized',403:'forbidden',404:'not_found',405:'method_not_allowed',413:'request_too_large'}.get(e.code,'request_failed')
  return jsonify(error=message),e.code
 return e

@app.errorhandler(413)
def too_large(e):
 if request.path.startswith('/api/device/'):return jsonify(error='batch_too_large'),413
 return jsonify(error='업로드 용량 제한을 초과했습니다.'),413
@app.errorhandler(404)
def not_found(e):
 if request.path.startswith('/api/device/'):return jsonify(error='session_not_found' if '/uploads/' in request.path else 'not_found'),404
 return jsonify(error='로그 또는 파일을 찾을 수 없습니다.'),404
PAGE_SCRIPTS={
 'library':['disclosure','recording-name','download-dialog','tags','library','choices','bulk','storage-devices'],
 'replay':['recording-name','download-dialog','tags','app','choices','video-overlay','camera-info','telemetry','bookmarks'],
}

def page_response(kind):
 if request.args.get('fragment')=='1':
  response=send_from_directory(BASE/'web','library.html' if kind=='library' else 'index.html',conditional=False)
 else:
  template=(BASE/'web'/'library.html').read_text()
  version=re.search(r'assets/style.css\?v=([^"&]+)',template)[1]
  prefix='../../' if kind=='replay' else ''
  html=(BASE/'web'/'shell.html').read_text().replace('__ASSETS__',prefix+'assets/').replace('__VERSION__',version)
  response=app.make_response(html)
 response.headers['Cache-Control']='no-store'
 return response

@app.route('/')
def index():return page_response('library')
@app.route('/view/<id>/')
def view(id):folder(id);return page_response('replay')
@app.route('/assets/<path:name>')
def assets(name):
 for kind,scripts in PAGE_SCRIPTS.items():
  if name=='page-'+kind+'.js':
   # Native module factory: trusted application sources share one page-local scope.
   bindings='window,document,location,fetch,setTimeout,clearTimeout,setInterval,clearInterval,requestAnimationFrame,cancelAnimationFrame,ResizeObserver,MutationObserver,XMLHttpRequest,matchMedia'
   source='export function mount(env) {\nconst {'+bindings+'}=env;\n'+ '\n;\n'.join((BASE/'web'/(script+'.js')).read_text() for script in scripts)
   source+='\nreturn {ready:pageReady,canLeave:()=>'+('!busy&&!cleaning&&!networkRestarting' if kind=='library' else 'true')+'};\n}'
   response=app.make_response(source);response.mimetype='application/javascript'
   response.headers['Cache-Control']='public, max-age=31536000' if request.args.get('v') else 'no-cache'
   return response
 # ?v= changes with every release, so versioned URLs never need revalidation.
 return send_from_directory(BASE/'web',name,max_age=31536000 if request.args.get('v') else None)

def storage_used_bytes(root=None):
 total=0
 pending=[root or ROOT]
 while pending:
  try:
   with os.scandir(pending.pop()) as entries:
    for entry in entries:
     try:
      if entry.is_dir(follow_symlinks=False):pending.append(entry.path)
      elif entry.is_file(follow_symlinks=False):total+=entry.stat(follow_symlinks=False).st_size
     except FileNotFoundError:pass # Upload cleanup or log deletion during the scan.
  except FileNotFoundError:pass
 return total

@app.route('/api/progress')
def processing_progress():
 # Only memory: do not read metadata or scan storage for frequent polling.
 with lock:progress={id:dict(event) for id,event in job_progress.items()}
 return jsonify(progress=progress)

def recording_order(m):
 # Route counters are hexadecimal; segment numbers are decimal. Keep each route together.
 match=re.fullmatch(r'([0-9a-fA-F]+)--([0-9a-fA-F]+)(?:\s*/\s*구간\s*|--)(\d+)',m.get('name',''))
 if match:return (1,int(match[1],16),match[2].lower(),int(match[3]),m['id'])
 # Unrecognised/custom names remain accessible after numbered routes.
 return (0,m.get('uploaded',0),'',0,m['id'])

SKIPPED_EVENTS_WARNING='지원하지 않는 새 로그 이벤트'
@app.route('/api/logs')
def logs():
 cleanup_uploads()
 def item(p):
  # Metadata is atomically replaced. Slow file/stat scans must not hold the
  # lock shared with upload chunks and conversion progress.
  m=read_meta(p);m.pop('bookmarks',None)
  with lock:pinned=storage_policy.pinned(m);progress=job_progress.get(p.name)
  # Logs converted before 0.9.6 stored a warning for skipped new event types; it was never a problem.
  m['warnings']=[w for w in m.get('warnings') or [] if not str(w).startswith(SKIPPED_EVENTS_WARNING)]
  row=dict(m,pinned=pinned,bytes=original_bytes(p,m),video=has_video(p,m),video_download=video_download_kind(p,m),video_downloads=video_downloads(p,m),download_options=download_options(p,m),log_bytes=media_store.media_size(p,m,'rlog.zst',store) if stored(p,m,'rlog.zst') else 0,progress=progress,prepared_bytes=storage_used_bytes(p/'prepared'))
  # Only recordings touched by the archive carry the new fields; local-only rows stay as before.
  if any(media_store.location(m,kind)!='local' for kind in media_store.MEDIA_KINDS):row.update(video_state=video_states(p,m,share_state()),storage_locations=storage_locations(p,m))
  # Remote copies of local files and copies that did not verify: only on rows that have them.
  copies=remote_copies(p,m);errors=archive_errors(m)
  if copies:row['remote_copies']=copies
  if errors:row['archive_error']=errors
  return public_meta(row)
 share=[]
 def share_state():
  # Once per request and only when a row has archived files; never under the lock. The active backend's state.
  if not share:share.append(archive_state())
  return share[0]
 items=[]
 for p in recording_paths():
  try:items.append(item(p))
  except FileNotFoundError:pass # A recording may be deleted while the snapshot is read.
 return jsonify(logs=sorted(items,key=recording_order,reverse=True),max_upload_mb=app.config['MAX_CONTENT_LENGTH']//1024//1024,storage_used_bytes=storage_used_bytes(),concurrency=pool.limit,auto_convert=auto_convert,keep_original_video=keep_original_video)
@app.route('/api/upload',methods=['POST'])
def upload():
 # Legacy multipart uploads use the same admission reservation. Browsers use chunks.
 if not request.content_length:return jsonify(error='content_length_required'),411
 files=request.files.getlist('files')
 archive_state()  # Refreshed before locking: admission reads it without probing the share (archive_last_state).
 with registration_lock,lock:
  amount=storage_policy.admit(request.content_length,[{'name':f.filename or ''} for f in files],staging=True)
  id=uuid.uuid4().hex;p=UPLOADS/id;p.mkdir();atomic_json(p/'reservation.json',{'bytes':amount});active_uploads[id]+=1
 try:return register_files(files,reservation_id=id)
 finally:
  with lock:shutil.rmtree(p,ignore_errors=True);active_uploads.pop(id,None)

def file_digest(path):
 # Bound memory use even for large logs/videos.
 with path.open('rb') as source:return hashlib.file_digest(source,'sha256').hexdigest()

def upload_fingerprint(path):
 st=path.stat()
 return st.st_dev,st.st_ino,st.st_size,st.st_mtime_ns,st.st_ctime_ns

def received_digest(id,index,path):
 cached=upload_hashes.get(id,{}).get(index)
 if cached and cached[0]==upload_fingerprint(path):return cached[1].hexdigest()
 return file_digest(path)

def stored_digests(path,meta,kinds=UPLOAD_KINDS):
 cached=meta.get('content_hashes',{});updated={}
 for kind in kinds:
  file=path/kind
  if not file.is_file():
   e=media_store.entry(meta,kind)
   # An archived file is known by the hash recorded when it was verified; the share is never read here.
   if media_store.is_archived_location(e['location']) and isinstance(e.get('sha256'),str):updated[kind]=dict(cached.get(kind,{}),sha256=e['sha256'])
   elif kind in DERIVED and stored(path,meta,DERIVED[kind]) and kind in cached:updated[kind]=cached[kind]
   continue
  stat=file.stat();old=cached.get(kind,{})
  if old.get('size')==stat.st_size and old.get('mtime_ns')==stat.st_mtime_ns and old.get('sha256'):
   updated[kind]=old
  else:updated[kind]={'size':stat.st_size,'mtime_ns':stat.st_mtime_ns,'sha256':file_digest(file)}
 meta['content_hashes']={**cached,**updated} if kinds!=UPLOAD_KINDS else updated
 return {kind:value['sha256'] for kind,value in updated.items()}

def retained_original(p,m,kind,digest,known):
 # A matching re-upload must not recreate the second permanent camera copy.
 source=next(key for key,value in SOURCES.items() if value[0]==kind)
 return (stored(p,m,DERIVED[kind]) and digest==known.get(kind) and
         m.get('video_codecs',{}).get(source)==('h264' if source=='qcamera' else 'hevc'))

def additional_videos(p,meta,incoming,known):
 # Existence follows the index (stored): an archived file exists even while the share is unreachable,
 # so a re-upload never creates a second copy, and the share is not touched under the lock.
 added=[]
 for kind in VIDEO_KINDS:
  if kind not in incoming or stored(p,meta,kind):continue
  if kind in DERIVED:
   if retained_original(p,meta,kind,incoming[kind],known):continue
   if stored(p,meta,DERIVED[kind]) and incoming[kind]!=known.get(kind):continue
  else:
   original=next(raw for raw,mp4 in DERIVED.items() if mp4==kind)
   if stored(p,meta,original) or (p/'prepared'/kind).is_file():continue
  added.append(kind)
 return added

def archived_matches(wanted):
 # States of the archived files of recordings whose log has one of these hashes, resolved before any lock.
 # The hash comes from the index (or the cached local hash): nothing is read from the share or hashed here.
 # A recording missed here has no states, so clear_prepared keeps the MP4s of its archived originals.
 states={}
 for p in recording_paths():
  try:m=read_meta(p)
  except (OSError,ValueError):continue
  if not isinstance(m,dict) or not archived(m):continue
  e=media_store.entry(m,'rlog.zst');cached=m.get('content_hashes',{}).get('rlog.zst')
  digest=e.get('sha256') if media_store.is_archived_location(e['location']) else cached.get('sha256') if isinstance(cached,dict) else None
  if digest in wanted:states[m['id']]=archived_states(p,m)
 return states

def register_files(files,reservation_id=None):
 if not files or len(files)>(200 if request.path.startswith('/api/device/') else 100):return jsonify(error='한 번에 1~100개 파일을 선택하세요.'),400
 if shutil.disk_usage(ROOT).free<(request.content_length or 0)+100*1024*1024:return upload_error('insufficient_disk_space','로그를 저장할 디스크 공간이 부족합니다.',507)
 staged=[];duplicates=[];updated=[]
 try:
  with tempfile.TemporaryDirectory(dir=ROOT,prefix='.upload-') as temp:
   groups={}
   for f in files:
    original=(f.filename or '').replace('\\','/');path=PurePosixPath(original)
    if path.is_absolute() or '..' in path.parts or not path.name:raise ValueError('허용하지 않는 파일 경로입니다.')
    match=FLAT.fullmatch(path.name)
    if match:group=str(path.parent)+'/'+match['route']+'--'+match['segment'];kind=match['kind'];label=match['route']+' / 구간 '+str(int(match['segment']))
    elif path.name in UPLOAD_KINDS:group=str(path.parent);kind=path.name;label=path.parent.name or '업로드한 로그'
    else:raise ValueError('지원하지 않는 파일: '+path.name)
    if kind=='qcamera.mp4':kind='camera.mp4'
    if group not in groups:
     group_dir=Path(temp)/uuid.uuid4().hex;group_dir.mkdir();groups[group]={'dir':group_dir,'label':label,'files':{}}
    g=groups[group]
    if kind in g['files'] or (kind in CAMERA_KINDS and any(CAMERA_KINDS.get(k)==CAMERA_KINDS[kind] for k in g['files'])):raise ValueError('같은 구간의 카메라 파일이 중복되었습니다: '+path.name)
    if getattr(f,'path',None):
     # Finished chunked uploads already live under ROOT: move instead of copying up to 512 MB.
     os.replace(f.path,g['dir']/kind);g.setdefault('known',{})[kind]=f.sha256
    else:f.save(g['dir']/kind)
    if kind.endswith('.hevc'):validate_hevc(g['dir']/kind)
    if kind.endswith('.mp4'):validate_mp4(g['dir']/kind)
    g['files'][kind]=path.name
   for g in groups.values():
    if 'rlog.zst' not in g['files']:raise ValueError(g['label']+': 영상과 짝이 되는 rlog.zst를 함께 올려주세요.')
    if (g['dir']/'rlog.zst').stat().st_size==0:raise ValueError('로그 파일이 비어 있습니다.')
    g['hashes']={kind:g.get('known',{}).get(kind) or file_digest(g['dir']/kind) for kind in g['files']}
   # The share is probed before any lock, and only for re-uploads of archived recordings: it may be slow.
   # Admission and the checks below then read the result without probing (last_state).
   archive_state();states=archived_matches({g['hashes']['rlog.zst'] for g in groups.values()})
   with registration_lock:
    # Hash old recordings without blocking upload chunks or conversion progress.
    existing={};hash_updates=[]
    wanted={g['hashes']['rlog.zst'] for g in groups.values()}
    for path in ROOT.iterdir():
     if not path.is_dir() or not ID.fullmatch(path.name) or not (path/'meta.json').is_file():continue
     meta=read_meta(path);hashes=stored_digests(path,meta,('rlog.zst',))
     if hashes.get('rlog.zst') in wanted:hashes=stored_digests(path,meta)
     hash_updates.append((path,meta['content_hashes']))
     if 'rlog.zst' in hashes:existing.setdefault(hashes['rlog.zst'],(meta,hashes))
    found=[match[0] for match in (existing.get(g['hashes']['rlog.zst']) for g in groups.values()) if match and archived(match[0])]
    reachable=not found or archive_last_state()=='connected'
    with lock:
     # Recheck device revocation/expiry after slow copying and hashing, before deletion.
     if request.path.startswith('/api/device/'):
      devices.authorize_session(request.view_args['id'])
     for path,hashes in hash_updates:
      current=read_meta(path)
      if current.get('content_hashes')!=hashes:
       current['content_hashes']=hashes;save_meta(path,current)
     # All files are received, validated and hashed before any eviction.
     # A duplicate-only upload must never remove existing data.
     matches=[existing.get(g['hashes']['rlog.zst']) for g in groups.values()]
     changes=False
     for g,match in zip(groups.values(),matches):
      if match is None:
       changes=True
      else:
       path=ROOT/match[0]['id']
       if additional_videos(path,match[0],g['hashes'],match[1]):
        # A new camera reconverts the recording, which needs every archived file: wait for the share.
        if not reachable and archived(match[0]):return jsonify(error='storage_unavailable',message='저장소 연결 후 다시 시도하세요.'),409
        # Without a readable log (archived one corrupt or missing, by the states resolved before the locks) the
        # replay data could not be made again: the recording is left as it is. A state not resolved yet waits for the share.
        if not reconvertible(match[0],states.get(match[0]['id'])):
         if media_store.is_archived_location(media_store.location(match[0],'rlog.zst')) and (states.get(match[0]['id']) or {}).get('rlog.zst') in (None,'storage_unavailable','checking'):
          return jsonify(error='storage_unavailable',message='저장소 연결 후 다시 시도하세요.'),409
         return jsonify(error='log_unavailable',message='원본 로그가 없어 영상을 추가할 수 없습니다. 로그와 영상을 함께 다시 업로드하세요.'),409
        changes=True
     if changes:
      storage_policy.admit(0,[{'name':name} for g in groups.values() for name in g['files'].values()],commit=True,protected_ids={match[0]['id'] for match in matches if match},reservation_id=reservation_id)
     for g in groups.values():
      match=existing.get(g['hashes']['rlog.zst'])
      if match:
       meta,hashes=match
       p=ROOT/meta['id'];meta=read_meta(p)
       added=additional_videos(p,meta,g['hashes'],hashes)
       if added:
        restored=all(kind in DERIVED and (p/DERIVED[kind]).is_file() and g['hashes'][kind]==hashes.get(kind) for kind in added)
        if not restored:
         proc=processes.get(meta['id'])
         if proc and proc.poll() is None:
          proc.terminate()
          try:proc.wait(timeout=3)
          except subprocess.TimeoutExpired:proc.kill();proc.wait()
        for kind in added:
         target=p/kind;(g['dir']/kind).replace(target);stat=target.stat()
         meta.setdefault('files',{})[kind]=g['files'][kind]
         # A camera removed by archive cleanup is local again once re-uploaded (archived ones are never added).
         if media_store.location(meta,kind)=='removed':meta['storage'].pop(kind)
         # A remote copy of other content no longer describes this file.
         media_store.drop_remote(meta,kind,g['hashes'][kind])
         meta.setdefault('content_hashes',{})[kind]={'size':stat.st_size,'mtime_ns':stat.st_mtime_ns,'sha256':g['hashes'][kind]}
         hashes={**hashes,kind:g['hashes'][kind]}
        if not restored:
         clear_prepared(p,meta,states.get(meta['id']))
         meta.update(status='queued' if (meta.get('manual_conversion') or (auto_convert and not meta.get('auto_excluded'))) else 'unconverted')
        meta.update(video=True,bytes=original_bytes(p,meta));save_meta(p,meta)
        existing[g['hashes']['rlog.zst']]=(meta,hashes)
        updated.append(public_meta(dict(meta,original_restored=True) if restored else meta))
        continue
       video_diff=any(kind in g['hashes'] and g['hashes'][kind]!=hashes.get(kind) for kind in VIDEO_KINDS)
       duplicates.append({'id':meta['id'],'name':g['label'],'video_differs':video_diff})
       continue
      id=uuid.uuid4().hex;p=g['dir']
      m={'id':id,'name':g['label'],'uploaded':time.time(),'status':'queued' if auto_convert else 'unconverted','video':any(kind in g['files'] for kind in VIDEO_KINDS),'bytes':sum(f.stat().st_size for f in p.iterdir()),'files':g['files'],'error':None,'content_hashes':{kind:{'size':(p/kind).stat().st_size,'mtime_ns':(p/kind).stat().st_mtime_ns,'sha256':digest} for kind,digest in g['hashes'].items()}};save_meta(p,m);p.rename(ROOT/id);staged.append(m);existing[g['hashes']['rlog.zst']]=(m,g['hashes'])
  process_pending()  # Archived files of recordings evicted by admission, now that the locks are released.
  return jsonify(logs=staged,duplicates=duplicates,updated=updated),201
 except ValueError as e:return jsonify(error=str(e)),400
 finally:
  # A later registration failure must not strand earlier accepted logs.
  for id in dict.fromkeys(m['id'] for m in staged+updated if m['status']=='queued' and not m.get('original_restored')):submit(id)
# Small requests pass through HA Ingress and remote proxy upload limits.
UPLOADS=ROOT/'.uploads';UPLOADS.mkdir(exist_ok=True)
CHUNK_SIZE=2*1024*1024
STREAM_CHUNK_SIZE=8*1024*1024
UPLOAD_IDLE_SECONDS=15*60
UPLOAD_MAX_SECONDS=2*60*60
UPLOAD_SESSION_LIMIT=32

def cleanup_uploads(startup=False,force=False):
 removed=0
 with lock:
  now=time.time()
  for p in UPLOADS.iterdir():
   if not p.is_dir() or not ID.fullmatch(p.name):continue
   device_file=p/'device.json'
   device=json.loads(device_file.read_text()) if device_file.is_file() else None
   reservation=p/'reservation.json'
   deadline=json.loads(reservation.read_text()).get('expires_at',float('inf')) if reservation.is_file() else float('inf')
   stale=now-p.stat().st_mtime>UPLOAD_IDLE_SECONDS or now>=deadline or (device and device['expires_at']<=now)
   # Device sessions survive restart, but never their absolute/idle deadlines.
   # Explicit UI cleanup cannot interrupt live device sessions.
   expired=stale if device else (startup or force or stale)
   protected=active_uploads[p.name] if device or not force else p.name in finishing_uploads
   if not protected and expired:
    removed+=storage_used_bytes(p);shutil.rmtree(p)
  if startup:
   # Staging copies only; registered originals and conversions are preserved.
   for p in ROOT.glob('.upload-*'):
    if p.is_dir():removed+=storage_used_bytes(p);shutil.rmtree(p)
   # Local copies of remote files left by an interrupted download or conversion (stage_remote).
   for p in ROOT.glob('*/.staging'):
    if p.is_dir() and ID.fullmatch(p.parent.name):removed+=storage_used_bytes(p);shutil.rmtree(p)
  for id in list(upload_hashes):
   if not (UPLOADS/id).is_dir():upload_hashes.pop(id,None)
  for key in list(upload_file_locks):
   if not (UPLOADS/key[0]).is_dir():upload_file_locks.pop(key,None)
 return removed

cleanup_uploads(startup=True)
cleanup_stop=threading.Event()
def cleanup_loop():
 while not cleanup_stop.wait(60):
  try:cleanup_uploads()
  except OSError:app.logger.exception('Upload storage cleanup failed')
threading.Thread(target=cleanup_loop,name='upload-cleanup',daemon=True).start()
atexit.register(cleanup_stop.set)

@app.route('/api/storage/cleanup',methods=['POST'])
def cleanup_storage():
 # Explicit cleanup removes incomplete sessions immediately; sessions already being registered are spared.
 return jsonify(removed_bytes=cleanup_uploads(force=True))

@app.route('/api/uploads/<id>/failure',methods=['POST'])
def upload_failure(id):
 if not ID.fullmatch(id):abort(404)
 if (request.content_length or 0)>2048:abort(413)
 body=request.get_json(silent=True)
 if not isinstance(body,dict):abort(400)
 # No filenames or arbitrary client text in server logs.
 fields={key:body.get(key) for key in ('stage','attempt','offset','status','errorName','errorCode','elapsedMs','loaded','total','visibility')}
 fields={key:str(value)[:80] for key,value in fields.items()}
 app.logger.warning('Upload failure session=%s details=%s',id,json.dumps(fields))
 return jsonify(recorded=True)

def upload_error(code,message,status):
 return (jsonify(error=code,message=message) if request.path.startswith('/api/device/') else jsonify(error=message)),status

def upload_session(id):
 if not ID.fullmatch(id):abort(404)
 p=UPLOADS/id
 if not (p/'manifest.json').is_file():abort(404)
 reservation=p/'reservation.json'
 deadline=json.loads(reservation.read_text()).get('expires_at',float('inf')) if reservation.is_file() else float('inf')
 if time.time()>=deadline or time.time()-p.stat().st_mtime>UPLOAD_IDLE_SECONDS:
  if not active_uploads[id]:shutil.rmtree(p)
  abort(410,description='session_expired')
 return p,json.loads((p/'manifest.json').read_text())

@app.route('/api/uploads',methods=['POST'])
def begin_upload():
 cleanup_uploads()
 body=request.get_json(silent=True)
 if not isinstance(body,dict):return jsonify(error='invalid_upload'),400
 archive_state()  # Refreshed before locking: admission reads it without probing the share (archive_last_state).
 with registration_lock,lock:return create_upload(body.get('files'))

def create_upload(files,max_bytes=None,max_files=100):
 if not isinstance(files,list) or not 1<=len(files)<=max_files:return jsonify(error='invalid_files'),400
 for f in files:
  if not isinstance(f,dict) or not isinstance(f.get('name'),str) or type(f.get('size')) is not int or f['size']<=0:return jsonify(error='invalid_file'),400
  path=PurePosixPath(f['name'].replace('\\','/'))
  if path.is_absolute() or '..' in path.parts or not (path.name in UPLOAD_KINDS or FLAT.fullmatch(path.name)):return jsonify(error='invalid_file_path'),400
 total=sum(f['size'] for f in files)
 if total>(max_bytes if max_bytes is not None else app.config['MAX_CONTENT_LENGTH']):return too_large(None)
 if sum(1 for p in UPLOADS.iterdir() if (p/'reservation.json').is_file())>=UPLOAD_SESSION_LIMIT:return jsonify(error='session_limit_reached'),429
 # Chunks are moved into place when finished, so no second copy needs room.
 amount=storage_policy.admit(total,files,staging=False)
 id=uuid.uuid4().hex;p=UPLOADS/id;p.mkdir()
 try:
  atomic_json(p/'manifest.json',files);atomic_json(p/'reservation.json',{'bytes':amount,'expires_at':time.time()+UPLOAD_MAX_SECONDS})
 except Exception:
  shutil.rmtree(p,ignore_errors=True);raise
 return jsonify(id=id,chunk_size=CHUNK_SIZE),201

@app.route('/api/uploads/<id>/files/<int:index>',methods=['PUT'])
def upload_chunk(id,index,max_chunk_size=None):
 maximum=max_chunk_size or CHUNK_SIZE
 with lock:
  p,files=upload_session(id)
  if index>=len(files):abort(404)
  if id in finishing_uploads:return upload_error('upload_busy','업로드를 등록 중입니다.',409)
  active_uploads[id]+=1
 failed=False
 try:
  # Network reads must not hold the job lock.
  payload=request.stream.read(maximum+1)
  with lock:file_lock=upload_file_locks.setdefault((id,index),threading.Lock())
  # Writing up to 8 MiB and hashing it can stall on a slow disk: hold only this file's lock meanwhile, so the
  # other files of the segment, the web UI and conversion progress keep going.
  with file_lock:
   with lock:
    if request.path.startswith('/api/device/'):
     try:devices.authorize_session(id)
     except Exception:
      failed=True
      raise
    try:offset=int(request.args.get('offset','-1'))
    except ValueError:return upload_error('invalid_offset','잘못된 업로드 위치입니다.',400)
    if not (p/'manifest.json').is_file():return upload_error('session_expired','정리된 업로드입니다. 파일을 다시 선택해 주세요.',410)
    target=p/str(index);current=target.stat().st_size if target.exists() else 0
    if offset<0 or not payload or len(payload)>maximum or offset+len(payload)>files[index]['size']:return upload_error('invalid_chunk','업로드 조각의 크기가 잘못되었습니다.',400)
    repeat=offset<current and offset+len(payload)<=current
    if not repeat and offset!=current:return upload_error('offset_conflict','업로드 위치가 일치하지 않습니다. 다시 업로드해 주세요.',409)
    if not repeat and shutil.disk_usage(ROOT).free<len(payload)+100*1024*1024:
     failed=True
     return upload_error('insufficient_disk_space','저장 공간이 부족합니다.',507)
    cached=upload_hashes.get(id,{}).get(index)
    digest=hashlib.sha256() if current==0 else cached[1].copy() if cached and cached[0]==upload_fingerprint(target) else None
   if repeat:
    # A retried chunk whose first response was lost: accept it only if the stored bytes match.
    with target.open('rb') as source:
     source.seek(offset)
     if source.read(len(payload))==payload:return jsonify(received=offset+len(payload))
    return upload_error('offset_conflict','업로드 위치가 일치하지 않습니다. 다시 업로드해 주세요.',409)
   with target.open('ab') as out:out.write(payload)
   if digest is not None:digest.update(payload)
   with lock:
    if digest is not None:upload_hashes.setdefault(id,{})[index]=(upload_fingerprint(target),digest)
    else:upload_hashes.get(id,{}).pop(index,None)
    os.utime(p,None)
  return jsonify(received=current+len(payload))
 except OSError:
  failed=True
  raise
 finally:
  with lock:
   active_uploads[id]-=1
   if not active_uploads[id]:
    active_uploads.pop(id,None)
    if failed:
     shutil.rmtree(p,ignore_errors=True);upload_hashes.pop(id,None)

class ReceivedFile:
 # A completely received chunked upload, registered by moving it instead of copying a stream.
 def __init__(self,path,filename,sha256):self.path,self.filename,self.sha256=path,filename,sha256

@app.route('/api/uploads/<id>/finish',methods=['POST'])
def finish_upload(id,expected_hashes=None):
 with lock:
  p,files=upload_session(id)
  if expected_hashes is None and any(f.get('sha256','') is None for f in files):return upload_error('invalid_file','체크섬이 필요합니다.',400)
  if active_uploads[id]:return upload_error('upload_busy','업로드 조각을 전송 중입니다.',409)
  if any(not (p/str(i)).is_file() or (p/str(i)).stat().st_size!=f['size'] for i,f in enumerate(files)):return upload_error('incomplete_upload','아직 전송되지 않은 파일이 있습니다.',409)
  active_uploads[id]+=1;finishing_uploads.add(id)
 try:
  # Each file is hashed once: the same digest checks the device checksum and finds duplicates.
  received=[]
  for i,f in enumerate(files):
   digest=received_digest(id,i,p/str(i))
   expected=expected_hashes[i] if expected_hashes is not None else f.get('sha256')
   if expected and digest!=expected:return jsonify(error='checksum_mismatch'),422
   received.append(ReceivedFile(p/str(i),f['name'],digest))
  # Hashing and registering up to 512 MB must not block other requests.
  return register_files(received,reservation_id=id)
 finally:
  with lock:
   shutil.rmtree(p,ignore_errors=True)
   active_uploads.pop(id,None);finishing_uploads.discard(id)
   upload_hashes.pop(id,None)

@app.route('/api/uploads/<id>',methods=['DELETE'])
def cancel_upload(id):
 with lock:
  p,_=upload_session(id)
  if active_uploads[id]:return upload_error('upload_busy','업로드 처리 중입니다.',409)
  shutil.rmtree(p)
  upload_hashes.pop(id,None)
 return jsonify(deleted=id)

@app.route('/api/logs/<id>',methods=['DELETE'])
def delete(id):
 with registration_lock,lock:
  if request.args.get('skip_pinned')=='1' and storage_policy.pinned(read_meta(folder(id))):return jsonify(skipped='pinned')
  delete_recording(id,remote=True)
 process_pending()
 return jsonify(deleted=id)

def process_pending():
 # Outside the locks: the share may be slow. Archived files of deleted recordings go once it answers.
 # A remote backend's files are only queued here: the archiver cycle removes them, so Drive (retries, timeouts)
 # never holds a request.
 if backend.caps.kind!='smb':return
 pending=media_store.PendingDeletes(ROOT)
 if pending.path.exists():pending.process(store)

def delete_recording(id,remote=False):
 # Drive is extension storage. Only an explicit complete deletion may remove its recording or remote files.
 p=folder(id)
 try:m=read_meta(p)
 except (OSError,ValueError):m={}
 if not isinstance(m,dict):m={}
 if not remote and media_store.remote_refs(m,copies=True):raise StorageError('no_deletable_logs')
 proc=processes.get(id)
 if proc and proc.poll() is None:
  proc.terminate()
  try:proc.wait(timeout=3)
  except subprocess.TimeoutExpired:proc.kill();proc.wait()
 pool.discard(id)
 # The caller holds the locks, so the share is not touched here: archived files are only recorded, and
 # removed after the locks are released (process_pending) or by the archiver, whenever the share answers.
 try:m=read_meta(p)
 except (OSError,ValueError):m={}  # A broken meta.json is still deletable; it records no archived files.
 if not isinstance(m,dict):m={}
 kinds=[kind for kind in media_store.MEDIA_KINDS if media_store.location(m,kind)=='nas']
 refs=media_store.remote_refs(m,copies=True) if remote else []
 if kinds or refs:media_store.PendingDeletes(ROOT).add(id,kinds,refs or None,explicit=remote)
 shutil.rmtree(p)

# Tags belong to the recording, never to disposable prepared data.
TAG_COLORS={'mint','blue','violet','amber','rose','slate','red','coral','lime','yellow','cyan','indigo'}

@app.route('/api/logs/<id>/bookmarks',methods=['GET','POST'])
@app.route('/api/logs/<id>/bookmarks/<bookmark_id>',methods=['PUT','DELETE'])
def recording_bookmarks(id,bookmark_id=None):
 request.max_content_length=8192
 body=None
 if request.method in ('POST','PUT'):
  body=request.get_json(silent=True)
  if not isinstance(body,dict) or set(body)!={'time','title','note'}:return jsonify(error='북마크 요청이 올바르지 않습니다.'),400
  when=body['time']
  if isinstance(when,bool) or not isinstance(when,(int,float)) or not 0<=when<=86400 or not math.isfinite(when):return jsonify(error='북마크 시간이 올바르지 않습니다.'),400
  for key,limit in (('title',80),('note',1000)):
   if not isinstance(body[key],str):return jsonify(error='제목과 메모는 문자열이어야 합니다.'),400
   body[key]=unicodedata.normalize('NFC',body[key]).strip()
   if len(body[key])>limit or any(unicodedata.category(c).startswith('C') and c not in '\n\t' for c in body[key]):return jsonify(error='제목은 80자, 메모는 1000자 이내로 입력해 주세요.'),400
  body['title']=' '.join(body['title'].split())
  if not body['title']:return jsonify(error='북마크 제목을 입력해 주세요.'),400
 with lock:
  p=folder(id);m=read_meta(p);items=m.get('bookmarks',[])
  if request.method=='GET':return jsonify(bookmarks=items)
  existing=next((b for b in items if b['id']==bookmark_id),None)
  if bookmark_id and existing is None:abort(404)
  if body is not None:
   duration=m.get('duration')
   if isinstance(duration,(int,float)) and math.isfinite(duration) and body['time']>duration:return jsonify(error='구간 길이를 벗어난 북마크입니다.'),400
   if request.method=='POST' and len(items)>=100:return jsonify(error='북마크는 구간당 최대 100개입니다.'),400
   item=dict(id=bookmark_id or uuid.uuid4().hex,**body)
   items=[b for b in items if b['id']!=bookmark_id]+[item]
  else:items=[b for b in items if b['id']!=bookmark_id]
  m['bookmarks']=sorted(items,key=lambda b:(b['time'],b['id']));save_meta(p,m)
 return jsonify(bookmarks=m['bookmarks']),201 if request.method=='POST' else 200

@app.route('/api/logs/<id>/tags',methods=['POST'])
def recording_tags(id):
 request.max_content_length=65536
 body=request.get_json(silent=True)
 if not isinstance(body,dict) or set(body)-{'action','tags'} or body.get('action','set') not in ('set','add','remove'):
  return jsonify(error='태그 요청이 올바르지 않습니다.'),400
 values=body.get('tags')
 if not isinstance(values,list) or len(values)>100:return jsonify(error='태그는 구간당 최대 100개입니다.'),400
 tags={}
 for value in values:
  if not isinstance(value,dict) or set(value)-{'name','color'} or not isinstance(value.get('name'),str):return jsonify(error='태그 이름이 올바르지 않습니다.'),400
  name=' '.join(unicodedata.normalize('NFC',value['name']).split());color=value.get('color','mint')
  if not name or len(name)>32 or any(unicodedata.category(c).startswith('C') for c in name):return jsonify(error='태그 이름은 1~32자의 표시 가능한 문자로 입력해 주세요.'),400
  if not isinstance(color,str) or color not in TAG_COLORS:return jsonify(error='태그 색상이 올바르지 않습니다.'),400
  tags[name.lower()]={'name':name,'color':color}
 with lock:
  p=folder(id);m=read_meta(p);action=body.get('action','set')
  current={tag['name'].lower():tag for tag in m.get('tags',[])}
  if action=='add':
   # Adding a tag does not recolor a tag already assigned by another editor.
   for key,value in tags.items():current.setdefault(key,value)
  elif action=='remove':
   for key in tags:current.pop(key,None)
  else:current=tags
  if len(current)>100:return jsonify(error='태그는 구간당 최대 100개입니다.'),400
  m['tags']=list(current.values());save_meta(p,m)
 return jsonify(tags=m['tags'])

@app.route('/api/logs/<id>/convert',methods=['POST'])
def convert(id):
 # Outside the lock: archived files may wait on the NAS.
 with lock:p=folder(id);m=read_meta(p)
 states=archived_states(p,m)
 with lock:
  p=folder(id);m=read_meta(p)
  if m['status'] in ('queued','processing','ready'):
   return jsonify(status=m['status'])
  # Local files are checked here; an archived one not resolved beforehand counts as unreachable.
  def state(kind):return states.get(kind,'storage_unavailable') if media_store.is_archived_location(media_store.location(m,kind)) else media_store.resolve(p,m,kind,store)[1]
  # A conversion needs every archived input, videos included: refused now rather than queued and deferred.
  if any(state(kind) in ('storage_unavailable','checking') for kind in STORED_KINDS):return jsonify(error='storage_unavailable',message='저장소 연결 후 다시 시도하세요.'),409
  # An unreadable archived camera could not be converted again: its MP4 in prepared/ is the only playable copy.
  if any(state(kind)=='corrupt' for kind in STORED_KINDS):return jsonify(error='media_corrupt',message=MEDIA_ERRORS['media_corrupt'][1]),409
  if state('rlog.zst')=='missing' or not reconvertible(m,states):return jsonify(error='원본 로그가 없습니다.'),409
  clear_prepared(p,m,states)
  m.update(status='queued',manual_conversion=True,auto_excluded=False)
  save_meta(p,m);submit(id)
 return jsonify(status='queued')

@app.route('/api/logs/<id>/prepared',methods=['DELETE'])
def remove_prepared(id):
 # Outside the lock: whether an archived original is readable may wait on the NAS.
 with lock:p=folder(id);m=read_meta(p)
 states=archived_states(p,m,ORIGINALS)
 with lock:
  p=folder(id);m=read_meta(p)
  if request.args.get('skip_pinned')=='1' and storage_policy.pinned(m):return jsonify(skipped='pinned')
  if m['status']=='processing':return jsonify(error='처리 중에는 변환 데이터를 제거할 수 없습니다.'),409
  pool.discard(id)
  clear_prepared(p,m,states)
  m.update(status='unconverted',manual_conversion=False,auto_excluded=True)
  save_meta(p,m)
 return jsonify(status='unconverted')

@app.route('/api/logs/<id>/download/video')
def download_video(id):
 with lock:
  p=folder(id);kind=video_download_kind(p,read_meta(p))
 if kind is None:abort(404)
 # Outside the lock: resolving an archived file may wait on the NAS.
 return original(id,kind)

def download_name(m,kind):
 # The uploaded filename (e.g. 000003fe--d524dc1e0b--8--rlog.zst); a kept MP4 takes its original's name.
 source_kind=next((original for original,mp4 in DERIVED.items() if kind==mp4),kind)
 files=m.get('files',{});name=PurePosixPath(files.get(source_kind,files.get(kind,source_kind))).name
 # A camera added later without its filename recorded follows the log's route--segment prefix.
 log=PurePosixPath(files.get('rlog.zst','')).name
 if source_kind not in files and kind not in files and log.endswith('--rlog.zst'):name=log[:-len('rlog.zst')]+source_kind
 return str(PurePosixPath(name).with_suffix('.mp4')) if kind.endswith('.mp4') else name

class _ZipSink:
 # zipfile writes into this unseekable buffer (data descriptors); the response streams it out as it fills.
 def __init__(self):self.chunks=[]
 def write(self,data):self.chunks.append(bytes(data));return len(data)
 def flush(self):pass
 def take(self):
  data=b''.join(self.chunks);self.chunks.clear();return data

def zip_stream(entries):
 # Stored, not deflated: rlog.zst and the videos are already compressed. Nothing is staged on disk.
 sink=_ZipSink()
 with zipfile.ZipFile(sink,'w',zipfile.ZIP_STORED,allowZip64=True) as archive:
  for path,name in entries:
   if isinstance(path,media_store.RemoteFile):
    # Read from the remote backend as the ZIP is written; a failure ends the stream (an incomplete ZIP),
    # except a file deleted meanwhile, which is left out as a removed local one is.
    try:body=RemoteBody(backend.open(path.ref))
    except archive_backends.BackendError as e:
     if e.code=='not_found':continue
     raise
    try:
     info=zipfile.ZipInfo(name,time.localtime()[:6]);info.file_size=path.size
     with archive.open(info,'w',force_zip64=path.size>=0x7fffffff) as out:
      for chunk in body:out.write(chunk);yield sink.take()
    finally:body.close()
    yield sink.take()
    continue
   try:source=path.open('rb')
   except OSError:continue # Removed since the request started.
   with source:
    stat=os.fstat(source.fileno())
    info=zipfile.ZipInfo(name,time.localtime(max(stat.st_mtime,315532800))[:6]);info.file_size=stat.st_size
    with archive.open(info,'w',force_zip64=stat.st_size>=0x7fffffff) as out:
     while chunk:=source.read(1<<20):
      out.write(chunk);yield sink.take()
   yield sink.take()
 yield sink.take()

DOWNLOAD_PARTS=('rlog','front','wide','qcamera')

def download_options(p,m):
 rows=[]
 for source,(original,mp4,_) in SOURCES.items():
  video=stored(p,m,mp4) or (p/'prepared'/mp4).is_file();raw=stored(p,m,original)
  if not raw and not video:continue
  codec=m.get('video_codecs',{}).get(source)
  reversible=video and (codec=='hevc' if source!='qcamera' else codec in (None,'h264'))
  size=media_store.media_size(p,m,mp4,store) if stored(p,m,mp4) else (p/'prepared'/mp4).stat().st_size if video else media_store.media_size(p,m,original,store)
  rows.append(dict(source=source,mp4=video,original=raw or reversible,bytes=size,original_kind=original))
 return rows

def planned_video(p,m,source,format):
 original,mp4,_=SOURCES[source]
 # Resolve only the file actually sent: an unreachable MP4 must not block its reachable original.
 def kept():return media_file(p,m,mp4) or ((p/'prepared'/mp4) if (p/'prepared'/mp4).is_file() else None)
 if format=='mp4':
  video=kept();return (video,mp4,None,0) if video else None
 raw=media_file(p,m,original)
 if raw:return raw,original,None,0
 video=kept()
 if video is None:return None
 option=next(row for row in download_options(p,m) if row['source']==source)
 if not option['original']:abort(409,description='요청한 원본 형식 파일을 만들 수 없습니다.')
 return video,original,'mpegts' if source=='qcamera' else 'hevc',m.get('video_origins',{}).get(source,0)

def export_chunks(source,kind,offset):
 # The source descriptor stays valid if the recording is deleted during a download.
 proc=subprocess.Popen([sys.executable,str(BASE/'media_export.py'),f'/proc/self/fd/{source.fileno()}',kind,str(offset)],
                       pass_fds=(source.fileno(),),stdout=subprocess.PIPE,stderr=subprocess.PIPE)
 try:
  while chunk:=proc.stdout.read(65536):yield chunk
  proc.stderr.read();proc.wait()
  if proc.returncode:raise OSError('원본 형식 영상 생성에 실패했습니다.')
 finally:
  if proc.poll() is None:proc.terminate()
  proc.wait();proc.stdout.close();proc.stderr.close()

def plan_downloads(ids,parts,format):
 # Without the lock: metadata is replaced atomically, and resolving archived files may wait on the NAS.
 plans,names=[],set()
 for id in ids:
  p=folder(id);m=read_meta(p);rows=[]
  if 'rlog' in parts and (log:=media_file(p,m,'rlog.zst')):rows.append((log,'rlog.zst',None,0))
  for source in ('front','wide','qcamera'):
   if source in parts and (plan:=planned_video(p,m,source,format)):rows.append(plan)
  for path,kind,export,offset in rows:
   name=download_name(m,kind)
   if name in names:name=f'{id[:8]}-{name}'
   names.add(name);plans.append((path,name,export,offset,p))
 return plans

def close_source(source):
 if hasattr(source,'close'):source.close()

def open_downloads(ids,plans):
 # Archived files are opened outside the lock (a local deletion cannot affect them); local files under it,
 # after rechecking each recording, so a concurrent deletion answers 404 as before. A file only the remote
 # backend has stays a RemoteFile, read while streaming; one to export from a path is staged first (verified).
 sources=[None]*len(plans)
 try:
  for i,(path,_,export,_,p) in enumerate(plans):
   if isinstance(path,media_store.RemoteFile):
    sources[i]=staged_source(p,path) if export else path
    continue
   if path.is_relative_to(ROOT):continue
   try:sources[i]=path.open('rb')
   except OSError:abort(503,description='storage_unavailable')  # The archive went away after resolving.
  with lock:
   for id in ids:folder(id)
   for i,(path,*_) in enumerate(plans):
    if sources[i] is None:sources[i]=path.open('rb')
 except BaseException:
  for source in sources:
   if source:close_source(source)
  raise
 return [(source,*plan[1:4]) for source,plan in zip(sources,plans)]

def remote_stream(rf):
 # A remote file read while a response already streams: a failure ends the response, never mid-body JSON.
 body=RemoteBody(backend.open(rf.ref))
 try:yield from body
 finally:body.close()

def download_selected(ids,parts,format,single=False):
 if format not in ('mp4','original'):abort(400)
 for attempt in range(3):
  plans=plan_downloads(ids,parts,format)
  if not plans:abort(404)
  try:entries=open_downloads(ids,plans);break
  except FileNotFoundError:
   # A conversion replaced a local file (original -> kept MP4) after planning: plan again.
   if attempt==2:raise
 name=entries[0][1] if single else f'roadviewer-{len(ids)}-segments-{format}.zip'
 mime=('video/mp4' if name.endswith('.mp4') else 'video/hevc' if name.endswith('.hevc') else 'video/mp2t' if name.endswith('.ts') else 'application/zstd') if single else 'application/zip'
 # One remote-only file sent as it is: streamed from the backend like the playback routes (ranges included).
 if single and isinstance(entries[0][0],media_store.RemoteFile) and not entries[0][2]:
  return remote_response(entries[0][0],mime,as_attachment=True,name=name)
 def stream():
  try:
   if single:
    source,_,kind,offset=entries[0]
    if kind:yield from export_chunks(source,kind,offset)
    else:
     while chunk:=source.read(65536):yield chunk
   else:
    sink=_ZipSink()
    with zipfile.ZipFile(sink,'w',zipfile.ZIP_STORED,allowZip64=True) as archive:
     for source,name,kind,offset in entries:
      remote=isinstance(source,media_store.RemoteFile)
      info=zipfile.ZipInfo(name);info.file_size=0 if kind else source.size if remote else os.fstat(source.fileno()).st_size
      with archive.open(info,'w',force_zip64=True) as out:
       if kind:
        for chunk in export_chunks(source,kind,offset):out.write(chunk);yield sink.take()
       else:
        for chunk in remote_stream(source) if remote else iter(lambda:source.read(65536),b''):out.write(chunk);yield sink.take()
      yield sink.take()
    yield sink.take()
  finally:
   for source,*_ in entries:close_source(source)
 response=app.response_class(stream(),mimetype=mime,direct_passthrough=True)
 attachment(response,name)
 response.headers['Cache-Control']='no-store'
 response.call_on_close(lambda:[close_source(source) for source,*_ in entries])
 return response

@app.route('/api/logs/<id>/download')
def download_one(id):
 source=request.args.get('source','rlog')
 if source not in DOWNLOAD_PARTS:abort(400)
 return download_selected([id],{source},request.args.get('format','mp4'),single=True)

@app.route('/api/logs/download.zip')
def download_many():
 # Several segments as one ZIP: the logs and, if asked, one file per camera (as the single downloads offer).
 ids=list(dict.fromkeys(i for i in request.args.get('ids','').split(',') if i))
 parts=set(request.args.get('parts','rlog').split(','))
 if not ids or len(ids)>150 or not parts or not parts<=set(DOWNLOAD_PARTS):abort(400)
 if request.args.get('format') is not None:return download_selected(ids,parts,request.args['format'])
 entries,names=[],set()
 # Without the lock: resolving archived files may wait on the NAS. Files are opened while streaming.
 for id in ids:
  p=folder(id);m=read_meta(p)
  kinds=(['rlog.zst'] if 'rlog' in parts else [])+[row['kind'] for row in video_downloads(p,m) if row['source'] in parts]
  for kind in kinds:
   # Every file is resolved before streaming: one unreachable file refuses the whole ZIP.
   path=media_file(p,m,kind)
   if path is None:continue
   name=download_name(m,kind)
   if name in names:name=f'{id[:8]}-{name}'
   names.add(name);entries.append((path,name))
 with lock:
  for id in ids:folder(id)
 if not entries:abort(404)
 response=app.response_class(zip_stream(entries),mimetype='application/zip',direct_passthrough=True)
 response.headers['Content-Disposition']=f'attachment; filename="roadviewer-{len(ids)}-segments-{time.strftime("%Y%m%d-%H%M%S")}.zip"'
 response.headers['Cache-Control']='no-store'
 return response

@app.route('/api/logs/<id>/original/<kind>')
def original(id,kind):
 if kind not in STORED_KINDS:abort(404)
 p=folder(id);m=read_meta(p);file=media_path(p,m,kind)
 name=download_name(m,kind)
 mime='video/mp4' if kind.endswith('.mp4') else 'video/hevc' if kind.endswith('.hevc') else 'video/mp2t' if kind=='qcamera.ts' else 'application/zstd'
 if isinstance(file,media_store.RemoteFile):return remote_response(file,mime,as_attachment=True,name=name)
 return send_file(file,as_attachment=True,download_name=name,mimetype=mime,conditional=True)

@app.route('/api/logs/<id>/data')
def data(id):
 p=folder(id);meta=read_meta(p)
 if meta['status']!='ready':return jsonify(status=meta['status'],error=meta.get('error') or ('변환 데이터가 없습니다. 로그 목록에서 변환해 주세요.' if meta['status']=='unconverted' else '로그를 준비 중입니다.')),409
 response=send_prepared(p,'data.json')
 if response is None:abort(404)
 return response

def prepared_file(p,name):
 # New conversions and migrated logs keep only name.gz; plain files remain readable until migrated.
 for file,compressed in ((p/'prepared'/(name+'.gz'),True),(p/'prepared'/name,False)):
  if file.is_file():return file,compressed
 return None,False

def send_prepared(p,name):
 file,compressed=prepared_file(p,name)
 if file is None:return None
 if not compressed:return send_file(file,mimetype='application/json',conditional=True)
 # The browser inflates the stored bytes itself (DecompressionStream). Content-Encoding is avoided
 # because proxies such as Home Assistant Ingress may drop or rewrite it.
 if request.args.get('format')=='gzip':return send_file(file,mimetype='application/gzip',conditional=True)
 return app.response_class(gzip.decompress(file.read_bytes()),mimetype='application/json')

@app.route('/api/logs/<id>/telemetry')
def telemetry(id):
 p=folder(id)
 if read_meta(p)['status']!='ready':return jsonify(error='로그를 준비 중입니다.'),409
 response=send_prepared(p,'telemetry.json')
 return (jsonify(error='차량 정보가 없는 변환 데이터입니다. 로그 목록에서 제거 후 변환해 주세요.'),404) if response is None else response

@app.route('/api/logs/<id>/video')
def video(id):
 p=folder(id);m=read_meta(p)
 if m['status']!='ready':return jsonify(error='로그를 준비 중이거나 변환에 실패했습니다.'),409
 summary_file=p/'prepared/summary.json'
 summary=json.loads(summary_file.read_text()) if summary_file.is_file() else {}
 preferred=next((key for key in ('front','qcamera','wide') if summary.get('videos',{}).get(key)),'qcamera')
 source=request.args.get('source',preferred)
 if source not in SOURCES:abort(404)
 name=SOURCES[source][1]
 file=media_file(p,m,name) or p/'prepared'/name
 if isinstance(file,media_store.RemoteFile):return remote_response(file,'video/mp4')
 if not file.exists():abort(404)
 return send_file(file,mimetype='video/mp4',conditional=True)
def stale_recording(p,m):
 # A ready result made by an older decoder, without its replay data, or recorded with other videos than stored now.
 # Videos removed by NAS cleanup are gone for good: the result recorded with them is not stale for it.
 removed=not has_video(p,m) and any(media_store.location(m,kind)=='removed' for kind in VIDEO_KINDS)
 return m['status']=='ready' and (m.get('decoder_version')!='v28-runtime-geometry' or bool(m.get('video'))!=has_video(p,m) and not removed or prepared_file(p,'data.json')[0] is None)

def invalidate_recording(p,m,states):
 # Marks the recording for conversion again; the caller saves it. Archived inputs count only by states resolved
 # beforehand (archived_states). False when a ready result is kept because its log cannot be read.
 if not reconvertible(m,states):
  if m['status']=='ready':return False
 else:clear_prepared(p,m,states)
 m.update(status='unconverted',video=has_video(p,m))
 return True

def requeue_startup():
 # Invalidate all stale results before admitting work, oldest first.
 pending=[]
 # The share is never probed here (a hung mount must not stall startup): only a recent result counts.
 connected=archive_last_state()=='connected'
 for p in recording_paths():
  m=read_meta(p)
  # Results of a recording with archived files are kept while the share cannot be checked: reconverting
  # without them would replace a good result with one lacking its videos. The archiver checks them once
  # the share is connected (Archiver.recheck_held).
  held=archived(m) and not connected
  states=archived_states(p,m,(*ORIGINALS,'rlog.zst')) if archived(m) and connected else {}
  if m['status'] in ('queued','processing') or not held and stale_recording(p,m):
   if not invalidate_recording(p,m,states):continue
   save_meta(p,m)
  if m['status']=='unconverted' and not m.get('auto_excluded') and (auto_convert or m.get('manual_conversion')):pending.append((p,m))
 pending.sort(key=lambda row:(row[1].get('uploaded',0),row[0].name))
 for p,m in pending:
  m.update(status='queued');save_meta(p,m)
 for p,_ in pending:submit(p.name)

def migrate_prepared():
 # One log at a time in a low-priority child process, so the server never holds a whole replay in memory.
 for p in sorted(recording_paths(),key=lambda path:path.stat().st_mtime,reverse=True):
  if cleanup_stop.is_set():return
  try:
   with lock:
    m=read_meta(p)
    if m['status']!='ready' or not any((p/'prepared'/name).is_file() for name in ('data.json','telemetry.json')):continue
    revision=m.get('conversion_revision',0)
   done=subprocess.run([sys.executable,'-B',str(BASE/'compact.py'),str(p/'prepared')],capture_output=True,text=True,timeout=600,preexec_fn=lambda:os.nice(10))
   with lock:
    current=read_meta(p) if (p/'meta.json').is_file() else None
    staged=[f for f in (p/'prepared').glob('*.migrating')] if (p/'prepared').is_dir() else []
    # A conversion or removal that started meanwhile owns prepared/; discard the stale result.
    if done.returncode or current is None or current['status']!='ready' or current.get('conversion_revision',0)!=revision:
     for f in staged:f.unlink(missing_ok=True)
     continue
    for f in staged:
     f.replace(f.with_suffix(''));(p/'prepared'/f.with_suffix('').stem).unlink(missing_ok=True)
  except (OSError,ValueError,KeyError,subprocess.SubprocessError):
   app.logger.exception('Replay data migration failed for %s',p.name)

archive_settings,archive_migrated_from,archive_settings_error=archive_config.load(ROOT,options)
# Only constructed here: the share is first touched by the archiver thread (Archiver.activate), so a hung mount cannot stall startup.
store=media_store.ArchiveStore(archive_settings,ROOT)
# The active backend (the NAS around `store`, or Drive); constructing it reads at most the local token file.
backend=archive_backends.make_backend(archive_settings,ROOT,store=store)
if archive_settings_error:app.logger.warning('Video archive is disabled: %s',archive_settings_error)
archiver=media_store.Archiver(sys.modules[__name__],store,archive_settings,backend=backend)
def archive_preferences():
 result=dict(archive_config.values(archive_settings),effective_mode=archive_settings.effective_mode,
             client_configured=bool(archive_settings.gdrive_client_id))
 if archive_settings_error:result['settings_error']=archive_settings_error
 return result

@app.route('/api/settings/archive',methods=['GET','POST'])
def archive_preferences_api():
 global archive_settings,archive_settings_error,archive_migrated_from,store,backend,connection
 if request.method=='GET':
  with lock:return jsonify(archive_preferences())
 request.max_content_length=65536
 body=request.get_json(silent=True)
 # The cycle lock spans validation, persistence and swap: even a newly starting job sees one configuration.
 if not archiver.cycle.acquire(blocking=False):return jsonify(error='archive_running'),409
 try:
  with lock:
   if not isinstance(body,dict):return jsonify(error='invalid_archive_settings',fields={'_body':'expected_object'}),400
   data={**archive_config.values(archive_settings),**body}
   errors=archive_config.validate(data)
   if errors:return jsonify(error='invalid_archive_settings',fields=errors),400
   updated=archive_config.parse(data,options)
   rebuild=(updated.backend,updated.path,updated.gdrive_folder_name)!=(archive_settings.backend,archive_settings.path,archive_settings.gdrive_folder_name)
   new_store=media_store.ArchiveStore(updated,ROOT) if rebuild else store
   new_backend=archive_backends.make_backend(updated,ROOT,store=new_store) if rebuild else backend
   try:atomic_json(ROOT/archive_config.FILENAME,archive_config.document(updated,archive_migrated_from))
   except OSError:return jsonify(error='settings_write_failed'),500
   if rebuild:
    with connection_lock:
     if connection is not None:connection._cancel.set()
     connection=None
     store,backend=new_store,new_backend
     if updated.backend=='gdrive':connection=archive_backends.DriveConnection(backend,on_change=drive_changed)
    archiver.store,archiver.backend=store,backend
    archiver.remote=updated.backend=='gdrive'
    archiver.recovered=archiver.held_checked=False
    archiver.missing.clear();archiver.empty.clear()
    archiver.last_auth_error=None
   archiver.needs_activation |= rebuild or updated.enabled and not archive_settings.enabled
   archive_settings=updated
   store.settings=archiver.settings=updated
   if archiver.remote:backend.settings=updated
   store.invalidate();store.forget_index()
   archive_settings_error=None
   archiver.settings_changed.set()  # Reset the deadline; saving never starts work.
   return jsonify(archive_preferences())
 finally:archiver.cycle.release()

@app.route('/api/settings/archive/run',methods=['GET','POST'])
def run_archive():
 # GET: what 'archive everything eligible' would process now (for the confirmation) and the latest run.
 # POST: starts that run in the background (it can outlast the Ingress timeout): the scheduled cycle's engine
 # repeated without its batch or local threshold. Its progress shows in the storage block's archive.manual.
 # Never while another cycle runs; settings cannot be saved meanwhile (the cycle lock).
 if not archiver.settings.enabled:return jsonify(error='archive_disabled'),409
 if request.method=='GET':
  status=archiver.status()
  return jsonify(plan=archiver.manual_plan(),running=status['running'],manual=status['manual'],manual_active=status['manual_active'])
 job=archiver.start_manual()
 if job is None:return jsonify(error='archive_running'),409
 return jsonify(started=True,manual=job),202
connection=None;connection_lock=threading.Lock()
FOLDER_REASONS=('folder_missing','folder_trashed','storage_id_mismatch')
def drive_connection():
 # The device-flow sign-in of the active Drive backend (None for the NAS), made on first use.
 global connection
 if not remote_backend():return None
 with connection_lock:
  if connection is None or connection.backend is not backend:connection=archive_backends.DriveConnection(backend,on_change=drive_changed)
  return connection
def drive_changed(connected):
 # A new grant or a disconnect: an earlier sign-in failure of the archiver no longer applies.
 archiver.last_auth_error=None
def gdrive_auth_error(reason):
 # Why Drive needs signing in (again), as a code: the sign-in's last failure, the archiver's, or the cached probe's.
 # reason: the cached probe reason (remote_result), never a fresh probe.
 conn=drive_connection()
 return conn.last_error or archiver.last_auth_error or ('auth_expired' if reason=='auth_expired' else None)
def gdrive_status(reason):
 # The connection as the settings panel shows it: never a token, secret, device code or session.
 auth=backend.auth
 return dict(configured=bool(backend.settings.gdrive_client_id),connected=auth.connected,
             folder_ok=bool(auth.folder_id) and reason not in FOLDER_REASONS,pending=drive_connection().pending(),
             last_auth_error=gdrive_auth_error(reason))
@app.route('/api/settings/archive/gdrive/connect',methods=['POST'])
def gdrive_connect():
 # Asks Google for a device code (the only Google call in a request: the user waits for the code); a daemon
 # thread polls for the grant. One flow at a time: while a code waits, the same code is answered again.
 conn=drive_connection()
 if conn is None:return jsonify(error='gdrive_not_selected'),409
 if not backend.settings.gdrive_client_id:return jsonify(error='gdrive_not_configured'),409
 # Signed in and working: disconnect first. A grant Google no longer accepts can be renewed in place.
 if backend.auth.connected and not gdrive_auth_error((backend.last_result() or (None,None))[1]):return jsonify(error='gdrive_connected'),409
 try:flow=conn.start()
 except archive_backends.BackendError as e:
  if e.code in ('unavailable','rate_limited'):return jsonify(error='gdrive_unavailable'),503
  return jsonify(error='gdrive_auth_failed',reason=e.reason or e.code),502
 return jsonify(user_code=flow['user_code'],verification_url=flow['verification_url'],
                expires_in=max(0,int(flow['expires_at']-backend.auth.clock()))),202
@app.route('/api/settings/archive/gdrive/disconnect',methods=['POST'])
def gdrive_disconnect():
 # Forgets the grant (token file); Google's revoke runs in the background and may fail. The index is untouched:
 # Drive files stay recorded and answer storage_unavailable until a connection to the same folder.
 conn=drive_connection()
 if conn is None:return jsonify(error='gdrive_not_selected'),409
 conn.disconnect()
 return jsonify(connected=False)
@app.route('/api/logs/<id>/archive/retry',methods=['POST'])
def retry_archive(id):
 # A file whose remote copy did not verify (error remote_mismatch) is skipped by the archiver; this clears the
 # error so the next cycle uploads it again. Local and remote files are untouched (the bad copy stays on Drive).
 request.max_content_length=65536
 body=request.get_json(silent=True) if request.get_data() else {}
 kinds=body.get('kinds',list(media_store.MEDIA_KINDS)) if isinstance(body,dict) and not set(body)-{'kinds'} else None
 if not isinstance(kinds,list) or not kinds or any(not isinstance(k,str) or k not in media_store.MEDIA_KINDS for k in kinds):
  return jsonify(error='invalid_archive_retry'),400
 with lock:
  p=folder(id);m=read_meta(p)
  failed=[k for k in media_store.MEDIA_KINDS if k in kinds and media_store.entry(m,k).get('error')=='remote_mismatch']
  if not failed:return jsonify(error='no_archive_error'),409
  for kind in failed:
   e=m['storage'][kind];e.pop('error')
   if e=={'location':'local'}:m['storage'].pop(kind)
  atomic_json(p/'meta.json',m)
 store.forget_index()  # The settings panel's error count.
 return jsonify(retried=failed)
storage_policy=StoragePolicy(sys.modules[__name__])
devices=DeviceAPI(sys.modules[__name__])
device_network=DeviceNetwork(sys.modules[__name__])
requeue_startup()
# start.py enables this for the app; tests and tools importing the module do not migrate in the background.
if os.environ.get('RV_MIGRATE_PREPARED')=='1':
 threading.Thread(target=migrate_prepared,name='prepared-migration',daemon=True).start()
 archiver.start()  # Wait a full interval before activation/recovery; disabled archives only wait for settings changes.
if __name__=='__main__':app.run('127.0.0.1',8099,threaded=True)
