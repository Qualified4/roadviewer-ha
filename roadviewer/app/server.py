from pathlib import Path,PurePosixPath
import os,json,uuid,time,shutil,threading,subprocess,sys,re,tempfile,atexit
from concurrent.futures import ThreadPoolExecutor
from flask import Flask,request,jsonify,send_file,send_from_directory,abort
BASE=Path(__file__).resolve().parent
ROOT=Path(os.environ.get('RV_DATA','/data/roadviewer'));ROOT.mkdir(parents=True,exist_ok=True)
options_path=Path('/data/options.json');options=json.loads(options_path.read_text()) if options_path.exists() else {}
app=Flask(__name__,static_folder=None)
app.config.update(MAX_CONTENT_LENGTH=int(options.get('max_upload_mb',512))*1024*1024,MAX_FORM_PARTS=220)
lock=threading.RLock();pool=ThreadPoolExecutor(max_workers=1);processes={}
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
 with lock:
  if not (p/'meta.json').exists():return
  m=read_meta(p);m.update(status='processing');save_meta(p,m)
  proc=subprocess.Popen([sys.executable,'-B',str(BASE/'decoder.py'),str(p/'rlog.zst')],stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True);processes[id]=proc
 try:
  stdout,stderr=proc.communicate(timeout=600)
  with lock:
   if not (p/'meta.json').exists():return
   m=read_meta(p)
   if proc.returncode:raise ValueError((stderr.strip().splitlines() or ['로그 변환 실패'])[-1][:500])
   data=json.loads((p/'prepared/data.json').read_text());data['route']=m['name'];data.pop('path',None);(p/'prepared/data.json').write_text(json.dumps(data,ensure_ascii=False,separators=(',',':')));m.update(status='ready',duration=data['duration'],video=bool(data['video']),warnings=data['warnings'],model_frames=len(data['frames']),error=None,decoder_version='v6-live-tracks');save_meta(p,m)
 except Exception as e:
  if proc.poll() is None:proc.kill();proc.communicate()
  with lock:
   if (p/'meta.json').exists():m=read_meta(p);m.update(status='error',error=str(e));save_meta(p,m)
 finally:
  with lock:processes.pop(id,None)

def submit(id):pool.submit(run_job,id)
@app.before_request
def access():
 # Supervisor is the only accepted network peer in a Home Assistant installation.
 if os.environ.get('RV_INGRESS_ONLY','1')=='1' and request.remote_addr!='172.30.32.2':abort(403)
 if request.method in ('POST','DELETE') and request.headers.get('X-RoadViewer-Request')!='1':abort(403)
@app.errorhandler(413)
def too_large(e):return jsonify(error='업로드 용량 제한을 초과했습니다.'),413
@app.errorhandler(404)
def not_found(e):return jsonify(error='로그 또는 파일을 찾을 수 없습니다.'),404
@app.route('/')
def index():return send_from_directory(BASE/'web','library.html')
@app.route('/view/<id>/')
def view(id):folder(id);return send_from_directory(BASE/'web','index.html')
@app.route('/assets/<path:name>')
def assets(name):return send_from_directory(BASE/'web',name)
@app.route('/api/logs')
def logs():
 with lock:items=[read_meta(p) for p in ROOT.iterdir() if p.is_dir() and ID.fullmatch(p.name) and (p/'meta.json').is_file()]
 return jsonify(logs=sorted(items,key=lambda m:m['uploaded'],reverse=True),max_upload_mb=app.config['MAX_CONTENT_LENGTH']//1024//1024)
@app.route('/api/upload',methods=['POST'])
def upload():
 files=request.files.getlist('files')
 if not files or len(files)>100:return jsonify(error='한 번에 1~100개 파일을 선택하세요.'),400
 if shutil.disk_usage(ROOT).free<(request.content_length or 0)+100*1024*1024:return jsonify(error='로그를 저장할 디스크 공간이 부족합니다.'),507
 staged=[]
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
   with lock:
    for g in groups.values():
     id=uuid.uuid4().hex;p=ROOT/id;g['dir'].rename(p)
     m={'id':id,'name':g['label'],'uploaded':time.time(),'status':'queued','video':'qcamera.ts' in g['files'],'bytes':sum(f.stat().st_size for f in p.iterdir()),'files':g['files'],'error':None};save_meta(p,m);staged.append(m)
  for m in staged:submit(m['id'])
  return jsonify(logs=staged),201
 except ValueError as e:return jsonify(error=str(e)),400
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
@app.route('/api/logs/<id>/data')
def data(id):
 p=folder(id)
 if read_meta(p)['status']!='ready':return jsonify(error='로그를 준비 중이거나 변환에 실패했습니다.'),409
 return send_file(p/'prepared/data.json',mimetype='application/json',conditional=True)
@app.route('/api/logs/<id>/video')
def video(id):
 p=folder(id);file=p/'prepared/camera.mp4'
 if not file.exists():abort(404)
 return send_file(file,mimetype='video/mp4',conditional=True)
# Requeue unfinished conversions after an app restart.
for p in ROOT.iterdir():
 if p.is_dir() and ID.fullmatch(p.name) and (p/'meta.json').is_file() and (read_meta(p)['status'] in ('queued','processing') or (read_meta(p)['status']=='ready' and read_meta(p).get('decoder_version')!='v6-live-tracks')):submit(p.name)
if __name__=='__main__':app.run('127.0.0.1',8099,threaded=True)
