from pathlib import Path,PurePosixPath
import hashlib
import os,json,uuid,time,shutil,threading,subprocess,sys,re,tempfile,atexit
from progress import ProgressChannel
from werkzeug.datastructures import FileStorage
from work_queue import ProcessingQueue
from flask import Flask,request,jsonify,send_file,send_from_directory,abort
BASE=Path(__file__).resolve().parent
ROOT=Path(os.environ.get('RV_DATA','/data/roadviewer'));ROOT.mkdir(parents=True,exist_ok=True)
options_path=Path('/data/options.json');options=json.loads(options_path.read_text()) if options_path.exists() else {}
app=Flask(__name__,static_folder=None)
app.config.update(MAX_CONTENT_LENGTH=int(options.get('max_upload_mb',512))*1024*1024,MAX_FORM_PARTS=220)
lock=threading.RLock();processes={};job_progress={}
ID=re.compile(r'^[a-f0-9]{32}$');FLAT=re.compile(r'^(?P<route>.{20})--(?P<segment>\d+)--(?P<kind>rlog\.zst|qcamera\.ts)$')
def folder(id):
 if not ID.fullmatch(id):abort(404)
 p=ROOT/id
 if not (p/'meta.json').is_file():abort(404)
 return p

def read_meta(p):return json.loads((p/'meta.json').read_text())
def save_meta(p,m):
 temp=p/'meta.tmp';temp.write_text(json.dumps(m,ensure_ascii=False));temp.replace(p/'meta.json')
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
    revision=m.get('conversion_revision',0)
    m.update(status='processing');save_meta(p,m)
    job_progress[id]={'stage':'log_read'}
    proc=subprocess.Popen([sys.executable,'-B',str(BASE/'decoder.py'),str(p/'rlog.zst')],stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,**channel.options());processes[id]=proc
   channel.start()
   try:
    stdout,stderr=proc.communicate(timeout=600)
    with lock:
     if not (p/'meta.json').exists():return
     m=read_meta(p)
     if m.get('conversion_revision',0)!=revision:return
     if proc.returncode:raise ValueError((stderr.strip().splitlines() or ['로그 변환 실패'])[-1][:500])
     data=json.loads((p/'prepared/data.json').read_text());data['route']=m['name'];data.pop('path',None);(p/'prepared/data.json').write_text(json.dumps(data,ensure_ascii=False,separators=(',',':')));m.update(status='ready',duration=data['duration'],video=(p/'qcamera.ts').is_file(),warnings=data['warnings'],model_frames=len(data['frames']),error=None,decoder_version='v16-overlay-height');save_meta(p,m)
   except Exception:
    if proc.poll() is None:proc.kill();proc.communicate()
    raise
 except Exception as e:
  with lock:
   if (p/'meta.json').exists():
    m=read_meta(p)
    if revision is not None and m.get('conversion_revision',0)==revision:m.update(status='error',error=str(e));save_meta(p,m)
 finally:
  with lock:
   if processes.get(id) is proc:
    processes.pop(id,None);job_progress.pop(id,None)

PROCESSING_SETTINGS=ROOT/'.processing-settings.json'
def read_processing_limit():
 try:
  value=json.loads(PROCESSING_SETTINGS.read_text()).get('concurrency',1)
  return value if type(value) is int and value in (1,2) else 1
 except (OSError,ValueError,AttributeError):return 1

pool=ProcessingQueue(run_job,read_processing_limit())
def submit(id):pool.submit(id)

@app.route('/api/settings/processing',methods=['GET','POST'])
def processing_settings():
 with lock:
  if request.method=='POST':
   body=request.get_json(silent=True)
   value=body.get('concurrency') if isinstance(body,dict) else None
   if type(value) is not int or value not in (1,2):return jsonify(error='동시 처리 개수는 1 또는 2여야 합니다.'),400
   temp=PROCESSING_SETTINGS.with_suffix('.tmp')
   temp.write_text(json.dumps({'concurrency':value}));temp.replace(PROCESSING_SETTINGS)
   pool.set_limit(value)
  return jsonify(concurrency=pool.limit)

@app.before_request
def access():
 # Supervisor is the only accepted network peer in a Home Assistant installation.
 if os.environ.get('RV_INGRESS_ONLY','1')=='1' and request.remote_addr!='172.30.32.2':abort(403)
 if request.method in ('POST','PUT','DELETE') and request.headers.get('X-RoadViewer-Request')!='1':abort(403)
@app.after_request
def fresh_replay_state(response):
 if request.path.startswith('/view/') or request.path in ('/api/logs','/api/progress','/api/settings/processing') or (request.path.startswith('/api/logs/') and request.path.endswith('/data')):
  response.headers['Cache-Control']='no-store'
 return response

@app.errorhandler(413)
def too_large(e):return jsonify(error='업로드 용량 제한을 초과했습니다.'),413
@app.errorhandler(404)
def not_found(e):return jsonify(error='로그 또는 파일을 찾을 수 없습니다.'),404
@app.route('/')
def index():
 response=send_from_directory(BASE/'web','library.html',conditional=False)
 response.headers['Cache-Control']='no-store'
 return response
@app.route('/view/<id>/')
def view(id):folder(id);return send_from_directory(BASE/'web','index.html')
@app.route('/assets/<path:name>')
def assets(name):return send_from_directory(BASE/'web',name)
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
 with lock:items=[dict(read_meta(p),bytes=sum((p/k).stat().st_size for k in ('rlog.zst','qcamera.ts') if (p/k).is_file()),video=(p/'qcamera.ts').is_file(),progress=job_progress.get(p.name),prepared_bytes=storage_used_bytes(p/'prepared')) for p in ROOT.iterdir() if p.is_dir() and ID.fullmatch(p.name) and (p/'meta.json').is_file()]
 return jsonify(logs=sorted(items,key=lambda m:(m['uploaded'],m['id']),reverse=True),max_upload_mb=app.config['MAX_CONTENT_LENGTH']//1024//1024,storage_used_bytes=storage_used_bytes(),concurrency=pool.limit)
@app.route('/api/upload',methods=['POST'])
def upload():
 return register_files(request.files.getlist('files'))

def file_digest(path):
 # Bound memory use even for large logs/videos.
 with path.open('rb') as source:return hashlib.file_digest(source,'sha256').hexdigest()

def stored_digests(path,meta):
 cached=meta.get('content_hashes',{});updated={}
 for kind in ('rlog.zst','qcamera.ts'):
  file=path/kind
  if not file.is_file():continue
  stat=file.stat();old=cached.get(kind,{})
  if old.get('size')==stat.st_size and old.get('mtime_ns')==stat.st_mtime_ns and old.get('sha256'):
   updated[kind]=old
  else:updated[kind]={'size':stat.st_size,'mtime_ns':stat.st_mtime_ns,'sha256':file_digest(file)}
 if cached!=updated:meta['content_hashes']=updated;save_meta(path,meta)
 return {kind:value['sha256'] for kind,value in updated.items()}

def register_files(files):
 if not files or len(files)>100:return jsonify(error='한 번에 1~100개 파일을 선택하세요.'),400
 if shutil.disk_usage(ROOT).free<(request.content_length or 0)+100*1024*1024:return jsonify(error='로그를 저장할 디스크 공간이 부족합니다.'),507
 staged=[];duplicates=[];updated=[]
 try:
  with tempfile.TemporaryDirectory(dir=ROOT,prefix='.upload-') as temp:
   groups={}
   for f in files:
    original=(f.filename or '').replace('\\','/');path=PurePosixPath(original)
    if path.is_absolute() or '..' in path.parts or not path.name:raise ValueError('허용하지 않는 파일 경로입니다.')
    match=FLAT.fullmatch(path.name)
    if match:group=str(path.parent)+'/'+match['route']+'--'+match['segment'];kind=match['kind'];label=match['route']+' / 구간 '+str(int(match['segment']))
    elif path.name in ('rlog.zst','qcamera.ts'):group=str(path.parent);kind=path.name;label=path.parent.name or '업로드한 로그'
    else:raise ValueError('지원하지 않는 파일: '+path.name)
    if group not in groups:
     group_dir=Path(temp)/uuid.uuid4().hex;group_dir.mkdir();groups[group]={'dir':group_dir,'label':label,'files':{}}
    g=groups[group]
    if kind in g['files']:raise ValueError('같은 구간의 파일이 중복되었습니다: '+path.name)
    f.save(g['dir']/kind);g['files'][kind]=path.name
   for g in groups.values():
    if 'rlog.zst' not in g['files']:raise ValueError(g['label']+': 영상과 짝이 되는 rlog.zst를 함께 올려주세요.')
    if (g['dir']/'rlog.zst').stat().st_size==0:raise ValueError('로그 파일이 비어 있습니다.')
    g['hashes']={kind:file_digest(g['dir']/kind) for kind in g['files']}
   with lock:
    # Check and register under one lock: simultaneous uploads cannot both win.
    existing={}
    for path in ROOT.iterdir():
     if not path.is_dir() or not ID.fullmatch(path.name) or not (path/'meta.json').is_file():continue
     meta=read_meta(path);hashes=stored_digests(path,meta)
     if 'rlog.zst' in hashes:existing.setdefault(hashes['rlog.zst'],(meta,hashes))
    for g in groups.values():
     match=existing.get(g['hashes']['rlog.zst'])
     if match:
      meta,hashes=match
      p=ROOT/meta['id']
      if 'qcamera.ts' in g['hashes'] and not (p/'qcamera.ts').is_file():
       # Cancel the old conversion before removing any of its output files.
       proc=processes.get(meta['id'])
       if proc and proc.poll() is None:
        proc.terminate()
        try:proc.wait(timeout=3)
        except subprocess.TimeoutExpired:proc.kill();proc.wait()
       (g['dir']/'qcamera.ts').replace(p/'qcamera.ts')
       meta.setdefault('files',{})['qcamera.ts']=g['files']['qcamera.ts']
       meta.update(status='queued',video=True,duration=None,model_frames=None,warnings=[],error=None,conversion_revision=meta.get('conversion_revision',0)+1,bytes=sum((p/k).stat().st_size for k in ('rlog.zst','qcamera.ts')))
       save_meta(p,meta)
       if (p/'prepared').exists():shutil.rmtree(p/'prepared')
       hashes=stored_digests(p,meta)
       existing[g['hashes']['rlog.zst']]=(meta,hashes)
       updated.append(meta)
       continue
      video_diff='qcamera.ts' in g['hashes'] and g['hashes']['qcamera.ts']!=hashes.get('qcamera.ts')
      duplicates.append({'id':meta['id'],'name':g['label'],'video_differs':video_diff})
      continue
     id=uuid.uuid4().hex;p=ROOT/id;g['dir'].rename(p)
     m={'id':id,'name':g['label'],'uploaded':time.time(),'status':'queued','video':'qcamera.ts' in g['files'],'bytes':sum(f.stat().st_size for f in p.iterdir()),'files':g['files'],'error':None};save_meta(p,m);stored_digests(p,m);staged.append(m);existing[g['hashes']['rlog.zst']]=(m,g['hashes'])
  return jsonify(logs=staged,duplicates=duplicates,updated=updated),201
 except ValueError as e:return jsonify(error=str(e)),400
 finally:
  # A later registration failure must not strand earlier accepted logs.
  for id in dict.fromkeys(m['id'] for m in staged+updated):submit(id)
# Small requests pass through HA Ingress and remote proxy upload limits.
UPLOADS=ROOT/'.uploads';UPLOADS.mkdir(exist_ok=True)
CHUNK_SIZE=256*1024
UPLOAD_IDLE_SECONDS=15*60

def cleanup_uploads(startup=False):
 removed=0
 with lock:
  now=time.time()
  for p in UPLOADS.iterdir():
   if p.is_dir() and ID.fullmatch(p.name) and (startup or now-p.stat().st_mtime>UPLOAD_IDLE_SECONDS):
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
 # Use the same expiry rule as the timer so another device's upload is safe.
 return jsonify(removed_bytes=cleanup_uploads())

@app.route('/api/uploads/<id>/failure',methods=['POST'])
def upload_failure(id):
 if not ID.fullmatch(id):abort(404)
 if (request.content_length or 0)>2048:abort(413)
 body=request.get_json(silent=True)
 if not isinstance(body,dict):abort(400)
 # No filenames or arbitrary client text in server logs.
 fields={key:body.get(key) for key in ('stage','attempt','offset','status','errorName','visibility')}
 fields={key:str(value)[:80] for key,value in fields.items()}
 app.logger.warning('Upload failure session=%s details=%s',id,json.dumps(fields))
 return jsonify(recorded=True)

def upload_session(id):
 if not ID.fullmatch(id):abort(404)
 p=UPLOADS/id
 if not (p/'manifest.json').is_file():abort(404)
 return p,json.loads((p/'manifest.json').read_text())

@app.route('/api/uploads',methods=['POST'])
def begin_upload():
 cleanup_uploads()
 body=request.get_json(silent=True) or {};files=body.get('files')
 if not isinstance(files,list) or not 1<=len(files)<=100:return jsonify(error='한 번에 1~100개 파일을 선택하세요.'),400
 for f in files:
  if not isinstance(f,dict) or not isinstance(f.get('name'),str) or type(f.get('size')) is not int or f['size']<=0:return jsonify(error='파일 이름 또는 크기가 잘못되었습니다.'),400
  path=PurePosixPath(f['name'].replace('\\','/'))
  if path.is_absolute() or '..' in path.parts or not (path.name in ('rlog.zst','qcamera.ts') or FLAT.fullmatch(path.name)):return jsonify(error='지원하지 않는 파일 경로입니다.'),400
 total=sum(f['size'] for f in files)
 if total>app.config['MAX_CONTENT_LENGTH']:return too_large(None)
 if shutil.disk_usage(ROOT).free<total*2+100*1024*1024:return jsonify(error='저장 공간이 부족합니다.'),507
 with lock:
  id=uuid.uuid4().hex;p=UPLOADS/id;p.mkdir();(p/'manifest.json').write_text(json.dumps(files))
 return jsonify(id=id,chunk_size=CHUNK_SIZE),201

@app.route('/api/uploads/<id>/files/<int:index>',methods=['PUT'])
def upload_chunk(id,index):
 # Never hold the shared job lock while waiting for network input.
 payload=request.stream.read(CHUNK_SIZE+1)
 with lock:
  p,files=upload_session(id)
  if index>=len(files):abort(404)
  try:offset=int(request.args.get('offset','-1'))
  except ValueError:return jsonify(error='잘못된 업로드 위치입니다.'),400
  target=p/str(index);current=target.stat().st_size if target.exists() else 0
  if offset<0 or not payload or len(payload)>CHUNK_SIZE or offset+len(payload)>files[index]['size']:return jsonify(error='업로드 조각의 크기가 잘못되었습니다.'),400
  if offset<current and offset+len(payload)<=current:
   # A lost response may cause the client to repeat an already stored chunk.
   with target.open('rb') as source:
    source.seek(offset)
    if source.read(len(payload))==payload:
     os.utime(p,None)
     return jsonify(received=offset+len(payload))
  if offset!=current:return jsonify(error='업로드 위치가 일치하지 않습니다. 다시 업로드해 주세요.'),409
  if shutil.disk_usage(ROOT).free<len(payload)+100*1024*1024:return jsonify(error='저장 공간이 부족합니다.'),507
  with target.open('ab') as out:out.write(payload)
  os.utime(p,None)
 return jsonify(received=current+len(payload))

@app.route('/api/uploads/<id>/finish',methods=['POST'])
def finish_upload(id):
 with lock:
  p,files=upload_session(id)
  if any(not (p/str(i)).is_file() or (p/str(i)).stat().st_size!=f['size'] for i,f in enumerate(files)):return jsonify(error='아직 전송되지 않은 파일이 있습니다.'),409
  streams=[FileStorage(stream=(p/str(i)).open('rb'),filename=f['name']) for i,f in enumerate(files)]
  try:result=register_files(streams)
  finally:
   for f in streams:f.close()
   shutil.rmtree(p)
  return result

@app.route('/api/uploads/<id>',methods=['DELETE'])
def cancel_upload(id):
 with lock:
  p,_=upload_session(id);shutil.rmtree(p)
 return jsonify(deleted=id)

@app.route('/api/logs/<id>',methods=['DELETE'])
def delete(id):
 with lock:
  p=folder(id);proc=processes.get(id)
  if proc and proc.poll() is None:
   proc.terminate()
   try:proc.wait(timeout=3)
   except subprocess.TimeoutExpired:proc.kill();proc.wait()
  shutil.rmtree(p)
 return jsonify(deleted=id)
@app.route('/api/logs/<id>/rebuild',methods=['POST'])
def rebuild(id):
 with lock:
  p=folder(id);m=read_meta(p)
  if m['status'] in ('queued','processing'):
   return jsonify(error='이미 준비 중인 로그입니다.'),409
  if not (p/'rlog.zst').is_file():return jsonify(error='원본 로그가 없습니다.'),409
  m.update(status='queued',duration=None,model_frames=None,warnings=[],error=None,conversion_revision=m.get('conversion_revision',0)+1)
  save_meta(p,m)
  if (p/'prepared').exists():shutil.rmtree(p/'prepared')
  submit(id)
 return jsonify(status='queued')

@app.route('/api/logs/<id>/data')
def data(id):
 p=folder(id);meta=read_meta(p)
 if meta['status']!='ready':return jsonify(status=meta['status'],error=meta.get('error') or '로그를 준비 중입니다.'),409
 return send_file(p/'prepared/data.json',mimetype='application/json',conditional=True)
@app.route('/api/logs/<id>/video')
def video(id):
 p=folder(id)
 if read_meta(p)['status']!='ready':return jsonify(error='로그를 준비 중이거나 변환에 실패했습니다.'),409
 file=p/'prepared/camera.mp4'
 if not file.exists():abort(404)
 return send_file(file,mimetype='video/mp4',conditional=True)
def requeue_startup():
 # Invalidate every stale result before starting even the first conversion.
 pending=[]
 for p in ROOT.iterdir():
  if not (p.is_dir() and ID.fullmatch(p.name) and (p/'meta.json').is_file()):continue
  m=read_meta(p)
  if m['status'] in ('queued','processing') or (m['status']=='ready' and (m.get('decoder_version')!='v16-overlay-height' or bool(m.get('video'))!=(p/'qcamera.ts').is_file() or not (p/'prepared/data.json').is_file())):
   pending.append((p,m)) # Reverse of library order: oldest upload first, with a stable tie-breaker.
 pending.sort(key=lambda item:(item[1].get('uploaded',0),item[0].name))
 for p,m in pending:
  m.update(status='queued',video=(p/'qcamera.ts').is_file(),duration=None,model_frames=None,warnings=[],error=None)
  save_meta(p,m)
 for p,_ in pending:
  prepared=p/'prepared'
  if prepared.exists():shutil.rmtree(prepared)
 for p,_ in pending:submit(p.name)

requeue_startup()
if __name__=='__main__':app.run('127.0.0.1',8099,threaded=True)
