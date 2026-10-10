from pathlib import Path,PurePosixPath
import gzip,hashlib
import os,json,uuid,time,shutil,threading,subprocess,sys,re,tempfile,atexit
from collections import Counter
from progress import ProgressChannel
from work_queue import ProcessingQueue
from flask import Flask,request,jsonify,send_file,send_from_directory,abort
from werkzeug.exceptions import HTTPException
from storage_policy import StoragePolicy,atomic_json
from device_api import DeviceAPI
from device_network import DeviceNetwork
from video_sources import SOURCES,ORIGINALS,DERIVED,UPLOAD_KINDS,STORED_KINDS,validate_hevc
BASE=Path(__file__).resolve().parent
ROOT=Path(os.environ.get('RV_DATA','/data/roadviewer'));ROOT.mkdir(parents=True,exist_ok=True)
options_path=Path('/data/options.json');options=json.loads(options_path.read_text()) if options_path.exists() else {}
DEVICE_HOST_PORT=int(os.environ.get('RV_DEVICE_HOST_PORT','0')) or None
app=Flask(__name__,static_folder=None)
app.config.update(MAX_CONTENT_LENGTH=int(options.get('max_upload_mb',512))*1024*1024,MAX_FORM_PARTS=220)
lock=threading.RLock();processes={};job_progress={};active_uploads=Counter();finishing_uploads=set();registration_lock=threading.Lock()
ID=re.compile(r'^[a-f0-9]{32}$');FLAT=re.compile(r'^(?P<route>.{20})--(?P<segment>\d+)--(?P<kind>rlog\.zst|qcamera\.ts|fcamera\.hevc|ecamera\.hevc)$')
def folder(id):
 if not ID.fullmatch(id):abort(404)
 p=ROOT/id
 if not (p/'meta.json').is_file():abort(404)
 return p

def read_meta(p):return json.loads((p/'meta.json').read_text())
def save_meta(p,m):
 temp=p/'meta.tmp';temp.write_text(json.dumps(m,ensure_ascii=False));temp.replace(p/'meta.json')
def original_bytes(p,kinds=STORED_KINDS):return sum((p/k).stat().st_size for k in kinds if (p/k).is_file())
def has_video(p):return any((p/k).is_file() for k in (*ORIGINALS,*DERIVED.values()))
def video_download_kind(p):
 return next((kind for source in ('front','qcamera','wide') for kind in SOURCES[source][:2] if (p/kind).is_file()),None)

def run_job(id):
 p=ROOT/id
 proc=None;revision=None
 def update_progress(event):
  with lock:
   if processes.get(id) is proc:job_progress[id]=event
 try:
  with ProgressChannel(update_progress) as channel:
   with lock:
    if not (p/'meta.json').exists():return
    m=read_meta(p)
    if m['status']!='queued':return
    if not auto_convert and not m.get('manual_conversion'):
     m.update(status='unconverted');save_meta(p,m);return
    revision=m.get('conversion_revision',0)
    m.update(status='processing');save_meta(p,m)
    job_progress[id]={'stage':'log_read'}
    proc=subprocess.Popen([sys.executable,'-B',str(BASE/'decoder.py'),str(p/'rlog.zst'),m['name']],stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,**channel.options());processes[id]=proc
   channel.start()
   try:
    stdout,stderr=proc.communicate(timeout=1800 if any((p/k).is_file() for k in ('fcamera.hevc','ecamera.hevc')) else 600)
    if proc.returncode:raise ValueError((stderr.strip().splitlines() or ['로그 변환 실패'])[-1][:500])
    # The decoder writes the large data file. Only its small summary is needed here.
    summary=json.loads((p/'prepared/summary.json').read_text())
    with registration_lock,lock:
     if not (p/'meta.json').exists():return
     m=read_meta(p)
     if m.get('conversion_revision',0)!=revision:return
     available=summary.get('videos',{'qcamera':summary.get('video')})
     for source,(original,mp4,_) in SOURCES.items():
      if not available.get(source) or not (p/'prepared'/mp4).is_file():continue
      if not keep_original_video:
       (p/'prepared'/mp4).replace(p/mp4)
       (p/original).unlink(missing_ok=True)
      elif (p/original).is_file():(p/mp4).unlink(missing_ok=True)
     m['bytes']=original_bytes(p)
     m.update(status='ready',manual_conversion=False,duration=summary['duration'],video=has_video(p),warnings=summary['warnings'],model_frames=summary['model_frames'],error=None,decoder_version='v27-ff-sign-telemetry');save_meta(p,m)
   except Exception:
    if proc.poll() is None:proc.kill();proc.communicate()
    raise
 except Exception as e:
  with lock:
   if (p/'meta.json').exists():
    m=read_meta(p)
    if revision is not None and m.get('conversion_revision',0)==revision:
     clear_prepared(p,m);m.update(status='error',error=str(e));save_meta(p,m)
 finally:
  with lock:
   if processes.get(id) is proc:
    processes.pop(id,None);job_progress.pop(id,None)

PROCESSING_SETTINGS=ROOT/'.processing-settings.json'
def read_processing_settings():
 try:
  saved=json.loads(PROCESSING_SETTINGS.read_text())
  if not isinstance(saved,dict):saved={}
 except (OSError,ValueError):saved={}
 value=saved.get('concurrency',1)
 return (value if type(value) is int and value in (1,2,3,4) else 1),saved.get('auto_convert',True) is not False,saved.get('keep_original_video',True) is not False

def read_processing_limit():return read_processing_settings()[0]
def read_auto_convert():return read_processing_settings()[1]
def read_keep_original_video():return read_processing_settings()[2]

_limit,auto_convert,keep_original_video=read_processing_settings()
pool=ProcessingQueue(run_job,_limit)
def submit(id):pool.submit(id)

def recording_paths():
 return [p for p in ROOT.iterdir() if p.is_dir() and ID.fullmatch(p.name) and (p/'meta.json').is_file()]

def clear_prepared(p,m):
 if (p/'prepared').exists():shutil.rmtree(p/'prepared')
 # Never remove the only retained copy of any camera.
 for original,mp4 in DERIVED.items():
  if (p/original).is_file():(p/mp4).unlink(missing_ok=True)
 m['bytes']=original_bytes(p)
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
   temp.write_text(json.dumps({'concurrency':value,'auto_convert':automatic,'keep_original_video':keep}));temp.replace(PROCESSING_SETTINGS)
   auto_convert=automatic;keep_original_video=keep
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
  request.max_content_length=CHUNK_SIZE+1 if request.method=='PUT' else 65536
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
 'library':['disclosure','recording-name','library','choices','bulk','storage-devices'],
 'replay':['recording-name','app','choices','video-overlay','camera-info','telemetry'],
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

@app.route('/api/logs')
def logs():
 cleanup_uploads()
 def item(p):
  m=read_meta(p)
  return dict(m,pinned=storage_policy.pinned(m),bytes=original_bytes(p),video=has_video(p),video_download=video_download_kind(p),progress=job_progress.get(p.name),prepared_bytes=storage_used_bytes(p/'prepared'))
 with lock:items=[item(p) for p in recording_paths()]
 return jsonify(logs=sorted(items,key=lambda m:(m['uploaded'],m['id']),reverse=True),max_upload_mb=app.config['MAX_CONTENT_LENGTH']//1024//1024,storage_used_bytes=storage_used_bytes(),concurrency=pool.limit,auto_convert=auto_convert,keep_original_video=keep_original_video)
@app.route('/api/upload',methods=['POST'])
def upload():
 # Legacy multipart uploads use the same admission reservation. Browsers use chunks.
 if not request.content_length:return jsonify(error='content_length_required'),411
 files=request.files.getlist('files')
 with registration_lock,lock:
  amount=storage_policy.admit(request.content_length,[{'name':f.filename or ''} for f in files],staging=True)
  id=uuid.uuid4().hex;p=UPLOADS/id;p.mkdir();atomic_json(p/'reservation.json',{'bytes':amount});active_uploads[id]+=1
 try:return register_files(files)
 finally:
  with lock:shutil.rmtree(p,ignore_errors=True);active_uploads.pop(id,None)

def file_digest(path):
 # Bound memory use even for large logs/videos.
 with path.open('rb') as source:return hashlib.file_digest(source,'sha256').hexdigest()

def stored_digests(path,meta):
 cached=meta.get('content_hashes',{});updated={}
 for kind in UPLOAD_KINDS:
  file=path/kind
  if not file.is_file():
   if kind in DERIVED and (path/DERIVED[kind]).is_file() and kind in cached:updated[kind]=cached[kind]
   continue
  stat=file.stat();old=cached.get(kind,{})
  if old.get('size')==stat.st_size and old.get('mtime_ns')==stat.st_mtime_ns and old.get('sha256'):
   updated[kind]=old
  else:updated[kind]={'size':stat.st_size,'mtime_ns':stat.st_mtime_ns,'sha256':file_digest(file)}
 meta['content_hashes']=updated
 return {kind:value['sha256'] for kind,value in updated.items()}

def register_files(files):
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
    if group not in groups:
     group_dir=Path(temp)/uuid.uuid4().hex;group_dir.mkdir();groups[group]={'dir':group_dir,'label':label,'files':{}}
    g=groups[group]
    if kind in g['files']:raise ValueError('같은 구간의 파일이 중복되었습니다: '+path.name)
    if getattr(f,'path',None):
     # Finished chunked uploads already live under ROOT: move instead of copying up to 512 MB.
     os.replace(f.path,g['dir']/kind);g.setdefault('known',{})[kind]=f.sha256
    else:f.save(g['dir']/kind)
    if kind.endswith('.hevc'):validate_hevc(g['dir']/kind)
    g['files'][kind]=path.name
   for g in groups.values():
    if 'rlog.zst' not in g['files']:raise ValueError(g['label']+': 영상과 짝이 되는 rlog.zst를 함께 올려주세요.')
    if (g['dir']/'rlog.zst').stat().st_size==0:raise ValueError('로그 파일이 비어 있습니다.')
    g['hashes']={kind:g.get('known',{}).get(kind) or file_digest(g['dir']/kind) for kind in g['files']}
   with registration_lock:
    # Hash old recordings without blocking upload chunks or conversion progress.
    existing={};hash_updates=[]
    for path in ROOT.iterdir():
     if not path.is_dir() or not ID.fullmatch(path.name) or not (path/'meta.json').is_file():continue
     meta=read_meta(path);hashes=stored_digests(path,meta)
     hash_updates.append((path,meta['content_hashes']))
     if 'rlog.zst' in hashes:existing.setdefault(hashes['rlog.zst'],(meta,hashes))
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
       if any(kind in g['hashes'] and not (path/kind).is_file() and
              (not (path/DERIVED[kind]).is_file() or g['hashes'][kind]==match[1].get(kind)) for kind in ORIGINALS):changes=True
     if changes:
      storage_policy.admit(0,[{'name':name} for g in groups.values() for name in g['files'].values()],commit=True,protected_ids={match[0]['id'] for match in matches if match})
     for g in groups.values():
      match=existing.get(g['hashes']['rlog.zst'])
      if match:
       meta,hashes=match
       p=ROOT/meta['id'];meta=read_meta(p)
       added=[kind for kind in ORIGINALS if kind in g['hashes'] and not (p/kind).is_file() and
              (not (p/DERIVED[kind]).is_file() or g['hashes'][kind]==hashes.get(kind))]
       if added:
        restored=all((p/DERIVED[kind]).is_file() and g['hashes'][kind]==hashes.get(kind) for kind in added)
        if not restored:
         proc=processes.get(meta['id'])
         if proc and proc.poll() is None:
          proc.terminate()
          try:proc.wait(timeout=3)
          except subprocess.TimeoutExpired:proc.kill();proc.wait()
        for kind in added:
         target=p/kind;(g['dir']/kind).replace(target);stat=target.stat()
         meta.setdefault('files',{})[kind]=g['files'][kind]
         meta.setdefault('content_hashes',{})[kind]={'size':stat.st_size,'mtime_ns':stat.st_mtime_ns,'sha256':g['hashes'][kind]}
         hashes={**hashes,kind:g['hashes'][kind]}
        if not restored:
         clear_prepared(p,meta)
         meta.update(status='queued' if (meta.get('manual_conversion') or (auto_convert and not meta.get('auto_excluded'))) else 'unconverted')
        meta.update(video=True,bytes=original_bytes(p));save_meta(p,meta)
        existing[g['hashes']['rlog.zst']]=(meta,hashes)
        updated.append(dict(meta,original_restored=True) if restored else meta)
        continue
       video_diff=any(kind in g['hashes'] and g['hashes'][kind]!=hashes.get(kind) for kind in ORIGINALS)
       duplicates.append({'id':meta['id'],'name':g['label'],'video_differs':video_diff})
       continue
      id=uuid.uuid4().hex;p=g['dir']
      m={'id':id,'name':g['label'],'uploaded':time.time(),'status':'queued' if auto_convert else 'unconverted','video':any(kind in g['files'] for kind in ORIGINALS),'bytes':sum(f.stat().st_size for f in p.iterdir()),'files':g['files'],'error':None,'content_hashes':{kind:{'size':(p/kind).stat().st_size,'mtime_ns':(p/kind).stat().st_mtime_ns,'sha256':digest} for kind,digest in g['hashes'].items()}};save_meta(p,m);p.rename(ROOT/id);staged.append(m);existing[g['hashes']['rlog.zst']]=(m,g['hashes'])
  return jsonify(logs=staged,duplicates=duplicates,updated=updated),201
 except ValueError as e:return jsonify(error=str(e)),400
 finally:
  # A later registration failure must not strand earlier accepted logs.
  for id in dict.fromkeys(m['id'] for m in staged+updated if m['status']=='queued' and not m.get('original_restored')):submit(id)
# Small requests pass through HA Ingress and remote proxy upload limits.
UPLOADS=ROOT/'.uploads';UPLOADS.mkdir(exist_ok=True)
CHUNK_SIZE=256*1024
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
def upload_chunk(id,index):
 with lock:
  p,files=upload_session(id)
  if index>=len(files):abort(404)
  active_uploads[id]+=1
 failed=False
 try:
  # Network reads must not hold the job lock.
  payload=request.stream.read(CHUNK_SIZE+1)
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
   if offset<0 or not payload or len(payload)>CHUNK_SIZE or offset+len(payload)>files[index]['size']:return upload_error('invalid_chunk','업로드 조각의 크기가 잘못되었습니다.',400)
   if offset<current and offset+len(payload)<=current:
    with target.open('rb') as source:
     source.seek(offset)
     if source.read(len(payload))==payload:
      return jsonify(received=offset+len(payload))
   if offset!=current:return upload_error('offset_conflict','업로드 위치가 일치하지 않습니다. 다시 업로드해 주세요.',409)
   if shutil.disk_usage(ROOT).free<len(payload)+100*1024*1024:
    failed=True
    return upload_error('insufficient_disk_space','저장 공간이 부족합니다.',507)
   with target.open('ab') as out:out.write(payload)
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
    if failed:shutil.rmtree(p,ignore_errors=True)

class ReceivedFile:
 # A completely received chunked upload, registered by moving it instead of copying a stream.
 def __init__(self,path,filename,sha256):self.path,self.filename,self.sha256=path,filename,sha256

@app.route('/api/uploads/<id>/finish',methods=['POST'])
def finish_upload(id):
 with lock:
  p,files=upload_session(id)
  if active_uploads[id]:return upload_error('upload_busy','업로드 조각을 전송 중입니다.',409)
  if any(not (p/str(i)).is_file() or (p/str(i)).stat().st_size!=f['size'] for i,f in enumerate(files)):return upload_error('incomplete_upload','아직 전송되지 않은 파일이 있습니다.',409)
  active_uploads[id]+=1;finishing_uploads.add(id)
 try:
  # Each file is hashed once: the same digest checks the device checksum and finds duplicates.
  received=[]
  for i,f in enumerate(files):
   digest=file_digest(p/str(i))
   if f.get('sha256') and digest!=f['sha256']:return jsonify(error='checksum_mismatch'),422
   received.append(ReceivedFile(p/str(i),f['name'],digest))
  # Hashing and registering up to 512 MB must not block other requests.
  return register_files(received)
 finally:
  with lock:
   shutil.rmtree(p,ignore_errors=True)
   active_uploads.pop(id,None);finishing_uploads.discard(id)

@app.route('/api/uploads/<id>',methods=['DELETE'])
def cancel_upload(id):
 with lock:
  p,_=upload_session(id)
  if active_uploads[id]:return upload_error('upload_busy','업로드 처리 중입니다.',409)
  shutil.rmtree(p)
 return jsonify(deleted=id)

@app.route('/api/logs/<id>',methods=['DELETE'])
def delete(id):
 with registration_lock,lock:
  if request.args.get('skip_pinned')=='1' and storage_policy.pinned(read_meta(folder(id))):return jsonify(skipped='pinned')
  delete_recording(id)
 return jsonify(deleted=id)

def delete_recording(id):
 # Shared deletion unit for explicit deletion and route-level storage cleanup.
 p=folder(id);proc=processes.get(id)
 if proc and proc.poll() is None:
  proc.terminate()
  try:proc.wait(timeout=3)
  except subprocess.TimeoutExpired:proc.kill();proc.wait()
 pool.discard(id)
 shutil.rmtree(p)

@app.route('/api/logs/<id>/convert',methods=['POST'])
def convert(id):
 with lock:
  p=folder(id);m=read_meta(p)
  if m['status'] in ('queued','processing','ready'):
   return jsonify(status=m['status'])
  if not (p/'rlog.zst').is_file():return jsonify(error='원본 로그가 없습니다.'),409
  clear_prepared(p,m)
  m.update(status='queued',manual_conversion=True,auto_excluded=False)
  save_meta(p,m);submit(id)
 return jsonify(status='queued')

@app.route('/api/logs/<id>/prepared',methods=['DELETE'])
def remove_prepared(id):
 with lock:
  p=folder(id);m=read_meta(p)
  if request.args.get('skip_pinned')=='1' and storage_policy.pinned(m):return jsonify(skipped='pinned')
  if m['status'] in ('queued','processing'):return jsonify(error='대기 또는 처리 중에는 변환 데이터를 제거할 수 없습니다.'),409
  clear_prepared(p,m)
  m.update(status='unconverted',manual_conversion=False,auto_excluded=True)
  save_meta(p,m)
 return jsonify(status='unconverted')

@app.route('/api/logs/<id>/download/video')
def download_video(id):
 with lock:
  kind=video_download_kind(folder(id))
  if kind is None:abort(404)
  return original(id,kind)

@app.route('/api/logs/<id>/original/<kind>')
def original(id,kind):
 if kind not in STORED_KINDS:abort(404)
 p=folder(id);file=p/kind
 if not file.is_file():abort(404)
 source_kind=next((original for original,mp4 in DERIVED.items() if kind==mp4),kind)
 name=PurePosixPath(read_meta(p).get('files',{}).get(source_kind,source_kind)).name
 if kind.endswith('.mp4'):name=str(PurePosixPath(name).with_suffix('.mp4'))
 mime='video/mp4' if kind.endswith('.mp4') else 'video/hevc' if kind.endswith('.hevc') else 'video/mp2t' if kind=='qcamera.ts' else 'application/zstd'
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
 p=folder(id)
 if read_meta(p)['status']!='ready':return jsonify(error='로그를 준비 중이거나 변환에 실패했습니다.'),409
 summary_file=p/'prepared/summary.json'
 summary=json.loads(summary_file.read_text()) if summary_file.is_file() else {}
 preferred=next((key for key in ('front','qcamera','wide') if summary.get('videos',{}).get(key)),'qcamera')
 source=request.args.get('source',preferred)
 if source not in SOURCES:abort(404)
 name=SOURCES[source][1]
 file=p/name if (p/name).is_file() else p/'prepared'/name
 if not file.exists():abort(404)
 return send_file(file,mimetype='video/mp4',conditional=True)
def requeue_startup():
 # Invalidate all stale results before admitting work, oldest first.
 pending=[]
 for p in recording_paths():
  m=read_meta(p)
  stale=m['status']=='ready' and (m.get('decoder_version')!='v27-ff-sign-telemetry' or bool(m.get('video'))!=has_video(p) or prepared_file(p,'data.json')[0] is None)
  if m['status'] in ('queued','processing') or stale:
   clear_prepared(p,m)
   m.update(status='unconverted',video=has_video(p))
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

storage_policy=StoragePolicy(sys.modules[__name__])
devices=DeviceAPI(sys.modules[__name__])
device_network=DeviceNetwork(sys.modules[__name__])
requeue_startup()
# start.py enables this for the app; tests and tools importing the module do not migrate in the background.
if os.environ.get('RV_MIGRATE_PREPARED')=='1':threading.Thread(target=migrate_prepared,name='prepared-migration',daemon=True).start()
if __name__=='__main__':app.run('127.0.0.1',8099,threaded=True)
