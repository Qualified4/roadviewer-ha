"""Read paths (list, playback, downloads) serve media from the archive store through the same URLs;
lifecycle paths (restart, conversion, registration, deletion, eviction) never act on an unreachable archive."""
import hashlib,io,json,os,sys,tempfile,threading,unittest,zipfile
from pathlib import Path
from unittest.mock import patch
os.environ['RV_DATA']=tempfile.mkdtemp()
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'roadviewer/app'))
import server,media_store

PEER={'REMOTE_ADDR':'172.30.32.2'};HEADERS={'X-RoadViewer-Request':'1'}

def make_nas(root):
 # A temporary directory standing in for the share: sentinel plus the local copy of its storage id.
 nas=Path(tempfile.mkdtemp(prefix='rv-nas-'))
 store=media_store.ArchiveStore(media_store.ArchiveSettings(enabled=True,path=nas),root);store.activate()
 assert store.state()=='connected',store.reason()
 return nas,store

def make_log(root,id,kinds_local,kinds_nas,status='ready',nas=None):
 p=Path(root)/id;p.mkdir();(p/'prepared').mkdir()
 m=dict(id=id,name='0000041b--c6f39793a8--1',status=status,uploaded=1,files={},error=None)
 for kind in kinds_local:(p/kind).write_bytes(kind.encode()*10)
 for kind in kinds_nas:
  target=nas/id/kind;target.parent.mkdir(parents=True,exist_ok=True);data=kind.encode()*20;target.write_bytes(data)
  media_store.set_location(m,kind,location='nas',bytes=len(data),sha256='0'*64,archived_at=1.0)
 server.save_meta(p,m)
 return p

class MediaIntegrationTests(unittest.TestCase):
 def setUp(self):
  temp=tempfile.TemporaryDirectory();self.addCleanup(temp.cleanup);self.root=Path(temp.name)
  for patcher in (patch.object(server,'ROOT',self.root),patch.object(server,'cleanup_uploads')):patcher.start();self.addCleanup(patcher.stop)
  self.client=server.app.test_client()
 def use(self,store):
  patcher=patch.object(server,'store',store);patcher.start();self.addCleanup(patcher.stop)
 def get(self,url,**kw):return self.client.get(url,environ_overrides=PEER,**kw)
 def lose_nas(self,nas,store):
  self.sentinel=(nas/media_store.SENTINEL).read_bytes();(nas/media_store.SENTINEL).unlink();store.invalidate()
 def restore_nas(self,nas,store):
  (nas/media_store.SENTINEL).write_bytes(self.sentinel);store.invalidate()
 def send(self,method,url,**kw):return getattr(self.client,method)(url,environ_overrides=PEER,headers=HEADERS,**kw)
 def ready(self,p,**fields):
  # A converted recording whose replay data must survive anything short of a real change.
  m=server.read_meta(p);(p/'prepared'/'data.json').write_text('{}')
  m.update({'status':'ready','decoder_version':'v28-runtime-geometry','video':server.has_video(p,m),**fields});server.save_meta(p,m)
  return m
 def run_job(self,p,returncode=0,summary=None):
  # The decoder child is replaced; with a summary its output is registered as a real conversion would be.
  if summary is not None:(p/'prepared'/'summary.json').write_text(json.dumps(summary))
  with patch.object(server,'ProgressChannel') as channel,patch.object(server.subprocess,'Popen') as popen:
   channel.return_value.__enter__.return_value.options.return_value={}
   popen.return_value.communicate.return_value=('','failed');popen.return_value.returncode=returncode;popen.return_value.poll.return_value=returncode
   server.run_job(p.name)
  return popen

 def test_video_served_from_nas_with_range(self):
  nas,store=make_nas(self.root);self.use(store)
  p=make_log(self.root,'a'*32,['rlog.zst'],['fcamera.mp4'],nas=nas)
  r=self.get(f'/api/logs/{p.name}/video?source=front',headers={'Range':'bytes=0-9'})
  self.assertEqual(r.status_code,206);self.assertEqual(r.headers['Content-Range'],f'bytes 0-9/{len(b"fcamera.mp4")*20}')
  self.assertEqual(r.data,(b'fcamera.mp4'*20)[:10]);r.close()

 def test_video_503_when_sentinel_missing(self):
  nas,store=make_nas(self.root);self.use(store)
  p=make_log(self.root,'a'*32,['rlog.zst'],['fcamera.mp4'],nas=nas);self.lose_nas(nas,store)
  r=self.get(f'/api/logs/{p.name}/video?source=front')
  self.assertEqual(r.status_code,503)
  self.assertEqual(r.json,{'error':'storage_unavailable','message':'영상 저장소에 연결할 수 없습니다. NAS 연결을 확인하세요.'})
  self.assertNotIn(str(nas),r.get_data(as_text=True))
  # The files and the index are untouched: the share may come back.
  self.assertTrue((nas/p.name/'fcamera.mp4').is_file());self.assertEqual(media_store.location(server.read_meta(p),'fcamera.mp4'),'nas')
  with patch.object(store,'state',return_value='checking'):
   r=self.get(f'/api/logs/{p.name}/video?source=front')
  self.assertEqual(r.status_code,503);self.assertEqual(r.headers['Retry-After'],'5');self.assertEqual(r.json['error'],'storage_checking')

 def test_corrupt_media_is_409(self):
  nas,store=make_nas(self.root);self.use(store)
  p=make_log(self.root,'a'*32,['rlog.zst'],['fcamera.mp4'],nas=nas)
  m=server.read_meta(p);m['storage']['fcamera.mp4']['error']='sha256_mismatch';server.save_meta(p,m)
  r=self.get(f'/api/logs/{p.name}/video?source=front')
  self.assertEqual(r.status_code,409);self.assertEqual(r.json,{'error':'media_corrupt','message':'영상 파일을 읽을 수 없습니다. 손상되었을 수 있습니다.'})

 def test_logs_list_works_when_nas_unavailable(self):
  nas,store=make_nas(self.root);self.use(store)
  p=make_log(self.root,'a'*32,['rlog.zst','camera.mp4'],['fcamera.mp4'],nas=nas);self.lose_nas(nas,store)
  r=self.get('/api/logs');self.assertEqual(r.status_code,200)
  row=r.json['logs'][0]
  self.assertTrue(row['video']);self.assertEqual(row['video_state'],{'front':'storage_unavailable','qcamera':'available'})
  self.assertEqual(row['storage_locations'],{'rlog':'local','front':'nas','qcamera':'local'})
  size=len(b'fcamera.mp4')*20
  self.assertEqual(row['video_download'],'fcamera.mp4')
  self.assertIn({'source':'front','kind':'fcamera.mp4','bytes':size},row['video_downloads'])
  self.assertEqual(next(o for o in row['download_options'] if o['source']=='front')['bytes'],size)
  self.assertEqual(row['bytes'],size+len(b'rlog.zst')*10+len(b'camera.mp4')*10);self.assertEqual(row['log_bytes'],len(b'rlog.zst')*10)
  self.assertNotIn(str(nas),r.get_data(as_text=True))

 def test_logs_list_does_not_stat_archived_files(self):
  # The library polls the list: archived files are judged by the index and one share check per request.
  nas,store=make_nas(self.root);self.use(store)
  p=make_log(self.root,'a'*32,['rlog.zst','camera.mp4'],['fcamera.mp4','ecamera.mp4'],nas=nas)
  q=make_log(self.root,'b'*32,['rlog.zst'],['fcamera.hevc'],nas=nas);m=server.read_meta(q);m['storage']['fcamera.hevc']['error']='recovery_mismatch';server.save_meta(q,m)
  (nas/p.name/'ecamera.mp4').unlink()  # Gone from the share: only playback finds out (404), the list trusts the index.
  real=Path.is_file;seen=[]
  def is_file(path):
   if str(path).startswith(str(nas)):seen.append(path)
   return real(path)
  def rows():
   with patch.object(Path,'is_file',is_file),patch.object(store,'_probe',wraps=store._probe) as probe:
    r=self.get('/api/logs');self.assertEqual(r.status_code,200)
   return {row['id']:row['video_state'] for row in r.json['logs']},probe.call_count
  store.invalidate()
  states,probes=rows();self.assertEqual(seen,[]);self.assertEqual(probes,1)
  self.assertEqual(states,{p.name:{'front':'available','wide':'available','qcamera':'available'},q.name:{'front':'corrupt'}})
  self.lose_nas(nas,store);states,_=rows()
  self.assertEqual(states,{p.name:{'front':'storage_unavailable','wide':'storage_unavailable','qcamera':'available'},q.name:{'front':'storage_unavailable'}})
  with patch.object(store,'state',return_value='checking'):states,_=rows()
  self.assertEqual(states[p.name]['front'],'checking');self.assertEqual(seen,[])
  # Playback still checks the file itself.
  self.restore_nas(nas,store);self.assertEqual(self.get(f'/api/logs/{p.name}/video?source=wide').status_code,404)

 def test_logs_omit_new_fields_for_local_only_logs(self):
  nas,store=make_nas(self.root);self.use(store)
  make_log(self.root,'a'*32,['rlog.zst','camera.mp4'],[])
  row=self.get('/api/logs').json['logs'][0]
  self.assertNotIn('video_state',row);self.assertNotIn('storage_locations',row)
  self.assertTrue(row['video']);self.assertEqual(row['video_downloads'],[{'source':'qcamera','kind':'camera.mp4','bytes':len(b'camera.mp4')*10}])
  # Only removed (cleaned-up) videos: the recording no longer has a video.
  p=make_log(self.root,'b'*32,['rlog.zst'],[]);m=server.read_meta(p)
  media_store.set_location(m,'fcamera.mp4',location='removed',removed_at=1.0,reason='nas_full');server.save_meta(p,m)
  row=next(row for row in self.get('/api/logs').json['logs'] if row['id']==p.name)
  self.assertFalse(row['video']);self.assertEqual(row['video_state'],{'front':'missing'});self.assertEqual(row['storage_locations']['front'],'removed')

 def test_original_rlog_from_nas(self):
  nas,store=make_nas(self.root);self.use(store)
  p=make_log(self.root,'a'*32,[],['rlog.zst'],nas=nas)
  r=self.get(f'/api/logs/{p.name}/original/rlog.zst');self.assertEqual(r.status_code,200);self.assertEqual(r.data,b'rlog.zst'*20);r.close()
  r=self.get(f'/api/logs/{p.name}/download?source=rlog');self.assertEqual(r.status_code,200);self.assertEqual(r.data,b'rlog.zst'*20);r.close()
  self.lose_nas(nas,store)
  self.assertEqual(self.get(f'/api/logs/{p.name}/original/rlog.zst').status_code,503)

 def test_zip_refuses_partial_when_unavailable(self):
  nas,store=make_nas(self.root);self.use(store)
  a=make_log(self.root,'a'*32,['rlog.zst'],[]);b=make_log(self.root,'b'*32,['rlog.zst'],['fcamera.mp4'],nas=nas)
  url=f'/api/logs/download.zip?ids={a.name},{b.name}&parts=rlog,front'
  for suffix in ('','&format=mp4'):
   r=self.get(url+suffix);self.assertEqual(r.status_code,200)
   with zipfile.ZipFile(io.BytesIO(r.data)) as archive:self.assertEqual(len(archive.namelist()),3)
   r.close()
  self.lose_nas(nas,store)
  for suffix in ('','&format=mp4'):
   r=self.get(url+suffix);self.assertEqual(r.status_code,503,suffix);self.assertEqual(r.json['error'],'storage_unavailable');r.close()
  self.assertEqual(self.get(f'/api/logs/{b.name}/download/video').status_code,503)

 def test_missing_nas_file_is_404(self):
  nas,store=make_nas(self.root);self.use(store)
  p=make_log(self.root,'a'*32,['rlog.zst'],['fcamera.mp4'],nas=nas);(nas/p.name/'fcamera.mp4').unlink()
  self.assertEqual(self.get(f'/api/logs/{p.name}/video?source=front').status_code,404)
  self.assertEqual(self.get(f'/api/logs/{p.name}/original/fcamera.mp4').status_code,404)
  self.assertEqual(self.get(f'/api/logs/{p.name}/download?source=front').status_code,404)

 def test_hung_nas_does_not_block_other_requests(self):
  # A download stuck on an unresponsive share must not hold the lock shared by the list, progress and uploads.
  nas,store=make_nas(self.root);self.use(store)
  p=make_log(self.root,'a'*32,['rlog.zst'],['fcamera.mp4'],nas=nas)
  for url in (f'/api/logs/{p.name}/download/video',f'/api/logs/{p.name}/download?source=front',f'/api/logs/download.zip?ids={p.name}&parts=rlog,front',f'/api/logs/download.zip?ids={p.name}&parts=rlog,front&format=mp4'):
   started,release=threading.Event(),threading.Event();results={}
   def probe():
    started.set();release.wait(10);return 'connected',None
   def download():
    r=server.app.test_client().get(url,environ_overrides=PEER);results['download']=(r.status_code,len(r.data));r.close()
   def listing():
    c=server.app.test_client();results['logs']=c.get('/api/logs',environ_overrides=PEER).status_code;results['progress']=c.get('/api/progress',environ_overrides=PEER).status_code
   store.invalidate()
   with patch.object(store,'_probe',side_effect=probe):
    worker=threading.Thread(target=download);worker.start()
    try:
     self.assertTrue(started.wait(5),url)
     other=threading.Thread(target=listing);other.start();other.join(2)
     self.assertFalse(other.is_alive(),url);self.assertEqual((results['logs'],results['progress']),(200,200),url)
     self.assertTrue(worker.is_alive(),url)
    finally:release.set();worker.join(10)
   self.assertEqual(results['download'][0],200,url);self.assertGreater(results['download'][1],0,url)

 def test_archiving_off_serves_local_files(self):
  store=media_store.ArchiveStore(media_store.ArchiveSettings(),self.root);self.use(store)
  p=make_log(self.root,'a'*32,['rlog.zst','fcamera.mp4'],[])
  self.assertEqual(store.state(),'disabled')
  r=self.get(f'/api/logs/{p.name}/video?source=front');self.assertEqual(r.status_code,200);self.assertEqual(r.data,b'fcamera.mp4'*10);r.close()
  self.assertEqual(self.get(f'/api/logs/{p.name}/video?source=wide').status_code,404)
  self.assertNotIn('video_state',self.get('/api/logs').json['logs'][0])

 def test_requeue_keeps_prepared_when_nas_unavailable(self):
  nas,store=make_nas(self.root);self.use(store)
  p=make_log(self.root,'a'*32,['rlog.zst'],['fcamera.hevc','fcamera.mp4'],nas=nas)
  # An older decoder version would normally discard the results and reconvert.
  before=self.ready(p,decoder_version='old');self.lose_nas(nas,store)
  for state in ('unavailable','checking'):
   with self.subTest(state=state),patch.object(server,'auto_convert',True),patch.object(server,'submit') as submit,patch.object(store,'state',return_value=state):
    server.requeue_startup()
    submit.assert_not_called();self.assertEqual(server.read_meta(p),before)
    self.assertTrue((p/'prepared'/'data.json').is_file());self.assertTrue((nas/p.name/'fcamera.hevc').is_file())

 def test_requeue_detects_truly_missing_local_video(self):
  nas,store=make_nas(self.root);self.use(store)
  p=make_log(self.root,'a'*32,['rlog.zst','camera.mp4'],[]);self.ready(p);(p/'camera.mp4').unlink()
  q=make_log(self.root,'b'*32,['rlog.zst'],['fcamera.mp4'],nas=nas);self.ready(q);self.lose_nas(nas,store)
  with patch.object(server,'auto_convert',True),patch.object(server,'submit') as submit:server.requeue_startup()
  submit.assert_called_once_with(p.name)
  self.assertFalse(server.read_meta(p)['video']);self.assertFalse((p/'prepared').exists())
  self.assertEqual(server.read_meta(q)['status'],'ready');self.assertTrue((q/'prepared'/'data.json').is_file())

 def test_convert_409_when_rlog_on_unavailable_nas(self):
  nas,store=make_nas(self.root);self.use(store)
  p=make_log(self.root,'a'*32,[],['rlog.zst'],status='unconverted',nas=nas);(p/'prepared'/'data.json').write_text('{}')
  before=server.read_meta(p);self.lose_nas(nas,store)
  with patch.object(server,'submit') as submit:
   for state in (None,'checking'):
    with patch.object(store,'state',**({'return_value':state} if state else {'wraps':store.state})):r=self.send('post',f'/api/logs/{p.name}/convert')
    self.assertEqual(r.status_code,409,state);self.assertEqual(r.json,{'error':'storage_unavailable','message':'저장소 연결 후 다시 시도하세요.'})
   submit.assert_not_called()
  self.assertEqual(server.read_meta(p),before);self.assertTrue((p/'prepared'/'data.json').is_file())
  # The index says the log was removed: the existing answer for a missing log.
  m=server.read_meta(p);media_store.set_location(m,'rlog.zst',location='removed',removed_at=1.0,reason='nas_full');server.save_meta(p,m)
  r=self.send('post',f'/api/logs/{p.name}/convert');self.assertEqual(r.status_code,409);self.assertEqual(r.json,{'error':'원본 로그가 없습니다.'})
  self.restore_nas(nas,store);m=server.read_meta(p);media_store.set_location(m,'rlog.zst',**before['storage']['rlog.zst']);server.save_meta(p,m)
  with patch.object(server,'submit') as submit:r=self.send('post',f'/api/logs/{p.name}/convert')
  self.assertEqual(r.json,{'status':'queued'});submit.assert_called_once_with(p.name)

 def test_convert_409_when_video_on_unavailable_nas(self):
  # The log is local, a camera is archived: refused up front instead of being queued and deferred.
  nas,store=make_nas(self.root);self.use(store)
  p=make_log(self.root,'a'*32,['rlog.zst'],['fcamera.hevc'],status='unconverted',nas=nas);(p/'prepared'/'data.json').write_text('{}')
  before=server.read_meta(p);self.lose_nas(nas,store)
  with patch.object(server,'submit') as submit:r=self.send('post',f'/api/logs/{p.name}/convert')
  self.assertEqual(r.status_code,409);self.assertEqual(r.json['error'],'storage_unavailable');submit.assert_not_called()
  self.assertEqual(server.read_meta(p),before);self.assertTrue((p/'prepared'/'data.json').is_file())

 def test_convert_refuses_corrupt_archived_camera(self):
  # A camera whose archived original cannot be read would not come back from a reconversion: its MP4 is kept.
  nas,store=make_nas(self.root);self.use(store)
  p=make_log(self.root,'a'*32,['rlog.zst'],['fcamera.hevc'],status='error',nas=nas)
  m=server.read_meta(p);m['storage']['fcamera.hevc']['error']='recovery_mismatch';server.save_meta(p,m)
  (p/'prepared'/'fcamera.mp4').write_bytes(b'verified');(p/'prepared'/'data.json').write_text('{}');before=server.read_meta(p)
  with patch.object(server,'submit') as submit:r=self.send('post',f'/api/logs/{p.name}/convert')
  self.assertEqual(r.status_code,409);self.assertEqual(r.json,{'error':'media_corrupt','message':'영상 파일을 읽을 수 없습니다. 손상되었을 수 있습니다.'})
  submit.assert_not_called();self.assertEqual(server.read_meta(p),before)
  self.assertEqual((p/'prepared'/'fcamera.mp4').read_bytes(),b'verified');self.assertTrue((p/'prepared'/'data.json').is_file())

 def test_run_job_failure_keeps_prepared_when_log_unreadable(self):
  # A failed conversion normally discards the old result; not when its log cannot be read to make it again.
  nas,store=make_nas(self.root);self.use(store)
  removed=make_log(self.root,'a'*32,[],[],status='queued');m=server.read_meta(removed);m['manual_conversion']=True
  media_store.set_location(m,'rlog.zst',location='removed',removed_at=1.0,reason='nas_full');server.save_meta(removed,m)
  lost=make_log(self.root,'b'*32,[],['rlog.zst'],status='queued',nas=nas);m=server.read_meta(lost);m['manual_conversion']=True;server.save_meta(lost,m)
  for p,during in ((removed,None),(lost,lambda:self.lose_nas(nas,store))):
   (p/'prepared'/'data.json').write_text('{}');(p/'prepared'/'fcamera.mp4').write_bytes(b'verified')
   with patch.object(server,'ProgressChannel') as channel,patch.object(server.subprocess,'Popen') as popen:
    channel.return_value.__enter__.return_value.options.return_value={}
    def communicate(**kw):
     if during:during()  # The share goes away while the decoder runs.
     return '','failed'
    popen.return_value.communicate.side_effect=communicate;popen.return_value.returncode=1;popen.return_value.poll.return_value=1
    server.run_job(p.name)
   popen.assert_called_once()
   m=server.read_meta(p);self.assertEqual((m['status'],m['error']),('error','failed'),p.name);self.assertEqual(m.get('conversion_revision',0),0,p.name)
   self.assertEqual(sorted(f.name for f in (p/'prepared').iterdir()),['data.json','fcamera.mp4'],p.name)

 def test_run_job_passes_media_paths_env(self):
  nas,store=make_nas(self.root);self.use(store)
  p=make_log(self.root,'a'*32,['camera.mp4'],['rlog.zst','fcamera.hevc'],status='queued',nas=nas)
  m=server.read_meta(p);m.update(manual_conversion=True,deferred='storage');server.save_meta(p,m)
  popen=self.run_job(p,returncode=1)
  self.assertNotIn('deferred',server.read_meta(p))  # Cleared once the job really starts.
  args,kw=popen.call_args;env=kw['env']
  self.assertEqual(args[0][-2],str(nas/p.name/'rlog.zst'))
  paths=json.loads(env['RV_MEDIA_PATHS'])
  self.assertEqual(paths['fcamera.hevc'],str(nas/p.name/'fcamera.hevc'));self.assertEqual(paths['camera.mp4'],str(p/'camera.mp4'))
  # Absent kinds point into the local folder, never at whatever happens to lie next to an archived log.
  self.assertEqual(paths['ecamera.hevc'],str(p/'ecamera.hevc'))
  self.assertEqual(env['RV_PREPARED_DIR'],str(p/'prepared'));self.assertEqual(env['RV_RECORDING_DIR'],str(p))
  self.assertEqual(popen.return_value.communicate.call_args.kwargs['timeout'],1800)
  self.assertEqual(server.read_meta(p)['status'],'error');self.assertTrue((nas/p.name/'fcamera.hevc').is_file())

 def test_run_job_keeps_prepared_mp4_when_original_on_nas(self):
  nas,store=make_nas(self.root);self.use(store)
  p=make_log(self.root,'a'*32,['rlog.zst','qcamera.ts'],['fcamera.hevc'],status='queued',nas=nas)
  m=server.read_meta(p);m['manual_conversion']=True;server.save_meta(p,m)
  for mp4 in ('fcamera.mp4','camera.mp4'):(p/'prepared'/mp4).write_bytes(b'verified')
  self.run_job(p,summary=dict(duration=1,warnings=[],model_frames=1,videos={'front':{'codec':'hevc'},'qcamera':{'codec':'h264'}}))
  m=server.read_meta(p);self.assertEqual(m['status'],'ready')
  # The archived original stays the stored copy; its MP4 remains converted output.
  self.assertTrue((p/'prepared'/'fcamera.mp4').is_file());self.assertFalse((p/'fcamera.mp4').exists())
  self.assertTrue((nas/p.name/'fcamera.hevc').is_file());self.assertEqual(media_store.location(m,'fcamera.hevc'),'nas')
  # A local original is replaced by its MP4 as before.
  self.assertFalse((p/'qcamera.ts').exists());self.assertEqual((p/'camera.mp4').read_bytes(),b'verified')
  r=self.get(f'/api/logs/{p.name}/video?source=front');self.assertEqual(r.status_code,200);self.assertEqual(r.data,b'verified');r.close()

 def test_run_job_restores_mp4_removed_by_cleanup(self):
  # The MP4 was removed from the share, the original uploaded again: the new MP4 must not be hidden by the index.
  nas,store=make_nas(self.root);self.use(store)
  p=make_log(self.root,'a'*32,['rlog.zst','qcamera.ts'],[],status='queued');m=server.read_meta(p);m['manual_conversion']=True
  media_store.set_location(m,'camera.mp4',location='removed',removed_at=1.0,reason='nas_full');server.save_meta(p,m)
  (p/'prepared'/'camera.mp4').write_bytes(b'verified')
  self.run_job(p,summary=dict(duration=1,warnings=[],model_frames=1,videos={'qcamera':{'codec':'h264'}}))
  m=server.read_meta(p);self.assertEqual(m['status'],'ready');self.assertEqual(media_store.location(m,'camera.mp4'),'local')
  self.assertFalse((p/'qcamera.ts').exists())
  r=self.get(f'/api/logs/{p.name}/video?source=qcamera');self.assertEqual(r.status_code,200);self.assertEqual(r.data,b'verified');r.close()

 def test_run_job_defers_when_unavailable(self):
  nas,store=make_nas(self.root);self.use(store)
  p=make_log(self.root,'a'*32,['rlog.zst'],['fcamera.hevc'],status='queued',nas=nas);(p/'prepared'/'data.json').write_text('{}')
  m=server.read_meta(p);m['manual_conversion']=True;server.save_meta(p,m);self.lose_nas(nas,store)
  for state in (None,'checking'):
   with patch.object(store,'state',**({'return_value':state} if state else {'wraps':store.state})):popen=self.run_job(p)
   popen.assert_not_called()
   m=server.read_meta(p);self.assertEqual((m['status'],m['error'],m['deferred']),('unconverted','저장소에 연결할 수 없어 변환을 미뤘습니다.','storage'))
   self.assertEqual(m.get('conversion_revision',0),0);self.assertTrue((p/'prepared'/'data.json').is_file())
   m['status']='queued';server.save_meta(p,m)

 def test_reupload_duplicate_detected_without_nas(self):
  nas,store=make_nas(self.root);self.use(store)
  p=make_log(self.root,'a'*32,[],['rlog.zst','fcamera.mp4'],nas=nas)
  m=server.read_meta(p);m['storage']['rlog.zst']['sha256']=hashlib.sha256(b'rlog.zst'*20).hexdigest();self.ready(p,storage=m['storage'])
  before=server.read_meta(p);self.lose_nas(nas,store)
  upload=lambda *files:self.send('post','/api/upload',data={'files':[(io.BytesIO(content),name) for name,content in files]})
  with patch.object(store,'_probe',side_effect=AssertionError('the archive must not be read')),patch.object(server,'submit') as submit:
   store.cached=(store.clock(),'unavailable','sentinel_missing')
   r=upload(('rlog.zst',b'rlog.zst'*20))
   self.assertEqual(r.status_code,201);self.assertEqual(r.json['logs'],[]);self.assertEqual([d['id'] for d in r.json['duplicates']],[p.name])
   # A new camera would require reconverting the recording: refused until the archive is back.
   r=upload(('rlog.zst',b'rlog.zst'*20),('qcamera.ts',b'video'))
   self.assertEqual(r.status_code,409);self.assertEqual(r.json['error'],'storage_unavailable')
   submit.assert_not_called()
  self.assertEqual(sorted(x.name for x in self.root.iterdir() if server.ID.fullmatch(x.name)),[p.name])
  after=server.read_meta(p);after.pop('content_hashes',None);before.pop('content_hashes',None);self.assertEqual(after,before)
  self.assertFalse((p/'qcamera.ts').exists());self.assertTrue((p/'prepared'/'data.json').is_file())

 def test_reupload_restores_video_removed_by_cleanup(self):
  nas,store=make_nas(self.root);self.use(store)
  p=make_log(self.root,'a'*32,['rlog.zst'],[]);m=server.read_meta(p)
  media_store.set_location(m,'qcamera.ts',location='removed',removed_at=1.0,reason='nas_full');self.ready(p,storage=m['storage'])
  with patch.object(server,'submit'):
   r=self.send('post','/api/upload',data={'files':[(io.BytesIO(b'rlog.zst'*10),'rlog.zst'),(io.BytesIO(b'video'),'qcamera.ts')]})
  self.assertEqual(r.status_code,201);self.assertEqual([u['id'] for u in r.json['updated']],[p.name])
  m=server.read_meta(p);self.assertEqual(media_store.location(m,'qcamera.ts'),'local');self.assertEqual(m['status'],'queued')
  self.assertEqual((p/'qcamera.ts').read_bytes(),b'video')

 def test_delete_records_pending_when_nas_down(self):
  nas,store=make_nas(self.root);self.use(store)
  p=make_log(self.root,'a'*32,['rlog.zst'],['fcamera.mp4','ecamera.mp4'],nas=nas);self.lose_nas(nas,store)
  self.assertEqual(self.send('delete',f'/api/logs/{p.name}').status_code,200)
  self.assertFalse(p.exists());self.assertTrue((nas/p.name/'fcamera.mp4').is_file())
  self.assertEqual(json.loads((self.root/'.pending-nas-deletes.json').read_text()),[{'id':p.name,'kinds':['fcamera.mp4','ecamera.mp4']}])
  # Nothing is removed while the archive is still unreachable.
  self.assertEqual(media_store.PendingDeletes(self.root).process(store),0);self.assertTrue((nas/p.name/'ecamera.mp4').is_file())

 def test_pending_processed_when_nas_back(self):
  nas,store=make_nas(self.root);self.use(store)
  p=make_log(self.root,'a'*32,['rlog.zst'],['fcamera.mp4'],nas=nas);self.lose_nas(nas,store)
  self.send('delete',f'/api/logs/{p.name}');self.restore_nas(nas,store)
  pending=media_store.PendingDeletes(self.root)
  self.assertEqual(pending.process(store),1)
  self.assertFalse((nas/p.name).exists());self.assertEqual(pending.process(store),0)
  self.assertFalse((self.root/'.pending-nas-deletes.json').exists())
  # With the archive connected, deletion removes the archived files at once.
  q=make_log(self.root,'b'*32,['rlog.zst'],['fcamera.mp4','camera.mp4'],nas=nas)
  self.assertEqual(self.send('delete',f'/api/logs/{q.name}').status_code,200)
  self.assertFalse(q.exists());self.assertFalse((nas/q.name).exists());self.assertFalse((self.root/'.pending-nas-deletes.json').exists())

 def test_delete_oldest_skips_nas_logs_when_unavailable(self):
  nas,store=make_nas(self.root);self.use(store)
  old=make_log(self.root,'a'*32,['rlog.zst'],['fcamera.mp4'],nas=nas)
  new=make_log(self.root,'b'*32,['rlog.zst'],[]);(new/'qcamera.ts').write_bytes(b'x'*200000)
  m=server.read_meta(new);m.update(uploaded=2,name='0000041c--c6f39793a8--1');server.save_meta(new,m)
  def admit():
   limit=server.storage_used_bytes()+65536-1;store.state()
   with patch.dict(server.storage_policy.settings,{'max_bytes':limit,'policy':'delete_oldest','pinned_logs':[]}),server.registration_lock,server.lock:
    server.storage_policy.admit(0,[],commit=True)
  self.lose_nas(nas,store);admit()
  self.assertTrue(old.exists());self.assertFalse(new.exists());self.assertTrue((nas/old.name/'fcamera.mp4').is_file())
  self.assertFalse((self.root/'.pending-nas-deletes.json').exists())
  # Connected again, the oldest recording goes first, archived files included.
  new=make_log(self.root,'b'*32,['rlog.zst'],[]);m=server.read_meta(new);m.update(uploaded=2,name='0000041c--c6f39793a8--1');server.save_meta(new,m)
  self.restore_nas(nas,store);admit()
  self.assertFalse(old.exists());self.assertTrue(new.exists())
  # Under the locks the share is not touched: the files wait in the pending list until it is processed.
  self.assertEqual(json.loads((self.root/'.pending-nas-deletes.json').read_text()),[{'id':old.name,'kinds':['fcamera.mp4']}])
  server.process_pending();self.assertFalse((nas/old.name).exists());self.assertFalse((self.root/'.pending-nas-deletes.json').exists())
  # Without a recent probe result, archived recordings are not evicted (the share is never probed under the lock).
  old=make_log(self.root,'a'*32,['rlog.zst'],['fcamera.mp4'],nas=nas);store.invalidate()
  limit=server.storage_used_bytes()+65536-1
  with patch.object(store,'_probe',side_effect=AssertionError('probed under the lock')),patch.dict(server.storage_policy.settings,{'max_bytes':limit,'policy':'delete_oldest','pinned_logs':[]}),server.registration_lock,server.lock:
   server.storage_policy.admit(0,[],commit=True)
  self.assertTrue(old.exists());self.assertFalse(new.exists())

 def test_clear_prepared_keeps_mp4_when_original_unavailable(self):
  nas,store=make_nas(self.root);self.use(store)
  p=make_log(self.root,'a'*32,['rlog.zst','fcamera.mp4'],['fcamera.hevc'],nas=nas);self.ready(p);self.lose_nas(nas,store)
  self.assertEqual(self.send('delete',f'/api/logs/{p.name}/prepared').status_code,200)
  self.assertFalse((p/'prepared').exists());self.assertEqual((p/'fcamera.mp4').read_bytes(),b'fcamera.mp4'*10)
  self.assertTrue((nas/p.name/'fcamera.hevc').is_file());self.assertEqual(media_store.location(server.read_meta(p),'fcamera.hevc'),'nas')
  # Connected, the original is readable again and the MP4 is disposable output as before.
  # Without states resolved beforehand an archived original never counts as readable.
  self.restore_nas(nas,store);m=server.read_meta(p);server.clear_prepared(p,m);self.assertTrue((p/'fcamera.mp4').exists())
  server.clear_prepared(p,m,server.archived_states(p,m))
  self.assertFalse((p/'fcamera.mp4').exists());self.assertTrue((nas/p.name/'fcamera.hevc').is_file())

 def hung_probe(self,store):
  # The share stops answering: probes block until released, then report connected.
  started,release=threading.Event(),threading.Event();probe=store._probe
  def hung():
   started.set();release.wait(10);return probe()
  store.invalidate()
  return patch.object(store,'_probe',side_effect=hung),started,release

 def assert_lock_free(self,label):
  results={}
  def listing():
   c=server.app.test_client();results['logs']=c.get('/api/logs',environ_overrides=PEER).status_code;results['progress']=c.get('/api/progress',environ_overrides=PEER).status_code
  other=threading.Thread(target=listing);other.start();other.join(2)
  self.assertFalse(other.is_alive(),label);self.assertEqual((results['logs'],results['progress']),(200,200),label)

 def test_delete_does_not_hold_lock_on_hung_nas(self):
  nas,store=make_nas(self.root);self.use(store)
  p=make_log(self.root,'a'*32,['rlog.zst'],['fcamera.mp4'],nas=nas);results={}
  patcher,started,release=self.hung_probe(store)
  with patcher:
   def delete():results['delete']=server.app.test_client().delete(f'/api/logs/{p.name}',environ_overrides=PEER,headers=HEADERS).status_code
   worker=threading.Thread(target=delete);worker.start()
   try:
    self.assertTrue(started.wait(5));self.assertFalse(p.exists())
    self.assertEqual(json.loads((self.root/'.pending-nas-deletes.json').read_text()),[{'id':p.name,'kinds':['fcamera.mp4']}])
    self.assertTrue(worker.is_alive());self.assertTrue((nas/p.name/'fcamera.mp4').is_file())
    self.assertTrue(server.lock.acquire(timeout=2),'lock held during the NAS probe');server.lock.release()
    self.assertTrue(server.registration_lock.acquire(timeout=2),'registration lock held during the NAS probe');server.registration_lock.release()
    self.assert_lock_free('delete')
   finally:release.set();worker.join(10)
  # Once the share answered, the same request removed the archived files.
  self.assertEqual(results['delete'],200);self.assertFalse((nas/p.name).exists());self.assertFalse((self.root/'.pending-nas-deletes.json').exists())

 def test_prepared_removal_and_convert_do_not_hold_lock_on_hung_nas(self):
  nas,store=make_nas(self.root);self.use(store)
  p=make_log(self.root,'a'*32,['rlog.zst','fcamera.mp4'],['fcamera.hevc'],nas=nas);self.ready(p)
  for method,url,expected in (('delete',f'/api/logs/{p.name}/prepared',200),('post',f'/api/logs/{p.name}/convert',200)):
   patcher,started,release=self.hung_probe(store);results={}
   with patcher,patch.object(server,'submit'):
    def call():results['status']=getattr(server.app.test_client(),method)(url,environ_overrides=PEER,headers=HEADERS).status_code
    worker=threading.Thread(target=call);worker.start()
    try:
     self.assertTrue(started.wait(5),url)
     self.assertTrue(server.lock.acquire(timeout=2),url);server.lock.release()
     self.assert_lock_free(url)
    finally:release.set();worker.join(10)
   self.assertEqual(results['status'],expected,url)
  # Connected after the probe: the original is readable, so its MP4 was disposable output.
  self.assertFalse((p/'fcamera.mp4').exists());self.assertEqual(server.read_meta(p)['status'],'queued')

 def test_delete_with_broken_meta(self):
  nas,store=make_nas(self.root);self.use(store)
  p=make_log(self.root,'a'*32,['rlog.zst'],[]);(p/'meta.json').write_text('{broken')
  self.assertEqual(self.send('delete',f'/api/logs/{p.name}').status_code,200);self.assertFalse(p.exists())
  self.assertFalse((self.root/'.pending-nas-deletes.json').exists())

 def test_pending_deletes_keep_corrupt_file_and_merge_concurrent_adds(self):
  nas,store=make_nas(self.root);self.use(store)
  pending=media_store.PendingDeletes(self.root);path=self.root/'.pending-nas-deletes.json'
  path.write_text('{not json');pending.add('a'*32,['fcamera.mp4'])
  aside=list(self.root.glob('.pending-nas-deletes.corrupt-*.json'))
  self.assertEqual(len(aside),1);self.assertEqual(aside[0].read_text(),'{not json')
  self.assertEqual(json.loads(path.read_text()),[{'id':'a'*32,'kinds':['fcamera.mp4']}])
  # Partly malformed content is also kept aside; the valid entries stay pending.
  for f in aside:f.unlink()
  path.write_text(json.dumps([{'id':'a'*32,'kinds':['fcamera.mp4']},{'id':'../x','kinds':['rlog.zst']}]))
  pending.add('b'*32,['rlog.zst'])
  self.assertEqual(len(list(self.root.glob('.pending-nas-deletes.corrupt-*.json'))),1)
  self.assertEqual(json.loads(path.read_text()),[{'id':'a'*32,'kinds':['fcamera.mp4']},{'id':'b'*32,'kinds':['rlog.zst']}])
  # A deletion recorded while the share is being cleaned is not lost by the merge.
  for id,kind in (('a'*32,'fcamera.mp4'),('b'*32,'rlog.zst')):
   target=nas/id/kind;target.parent.mkdir(parents=True,exist_ok=True);target.write_bytes(b'x')
  real=media_store.delete_archived
  def racing(store,id,kinds):
   if id=='a'*32:pending.add('c'*32,['camera.mp4'])
   return real(store,id,kinds)
  with patch.object(media_store,'delete_archived',side_effect=racing):self.assertEqual(pending.process(store),2)
  self.assertEqual(json.loads(path.read_text()),[{'id':'c'*32,'kinds':['camera.mp4']}])
  self.assertFalse((nas/('a'*32)).exists());self.assertFalse((nas/('b'*32)).exists())

 ARCHIVE_KEYS={'enabled','state','reason','path_configured','used_bytes','free_bytes','max_bytes','margin_bytes','last_cycle_at','last_error','consecutive_failures','pending_deletes','archived_files','archived_bytes','running'}
 def test_storage_snapshot_has_archive_block_without_path(self):
  # Archiving off: the block reports "disabled" and the existing fields are unchanged.
  body=self.get('/api/settings/storage').json
  self.assertTrue({'max_bytes','policy','used_bytes','free_bytes','reserved_bytes'}<=set(body))
  self.assertEqual(set(body['archive']),self.ARCHIVE_KEYS)
  self.assertEqual({k:body['archive'][k] for k in ('enabled','state','path_configured','used_bytes','free_bytes','pending_deletes','archived_files','archived_bytes')},
                   {'enabled':False,'state':'disabled','path_configured':False,'used_bytes':0,'free_bytes':0,'pending_deletes':0,'archived_files':0,'archived_bytes':0})
  nas,store=make_nas(self.root);self.use(store)
  make_log(self.root,'a'*32,['rlog.zst'],['fcamera.mp4','qcamera.ts'],nas=nas);make_log(self.root,'b'*32,['rlog.zst'],[])
  media_store.PendingDeletes(self.root).add('c'*32,['fcamera.mp4','rlog.zst'])
  r=self.get('/api/settings/storage');archive=r.json['archive']
  self.assertEqual(r.headers['Cache-Control'],'no-store')
  self.assertEqual(set(archive),self.ARCHIVE_KEYS)
  self.assertEqual((archive['enabled'],archive['state'],archive['reason'],archive['path_configured']),(True,'connected',None,True))
  self.assertEqual((archive['archived_files'],archive['archived_bytes'],archive['pending_deletes']),(2,len(b'fcamera.mp4')*20+len(b'qcamera.ts')*20,2))
  self.assertGreater(archive['used_bytes'],0);self.assertGreater(archive['free_bytes'],0)
  self.assertEqual((archive['max_bytes'],archive['margin_bytes']),(store.settings.nas_max_bytes,store.settings.nas_margin_bytes))
  self.assertNotIn(str(nas),r.get_data(as_text=True));self.assertNotIn('archive_path',r.get_data(as_text=True))
  # Unreachable: the state says so and no share usage is reported.
  self.lose_nas(nas,store);archive=self.get('/api/settings/storage').json['archive']
  self.assertEqual((archive['state'],archive['reason'],archive['used_bytes'],archive['free_bytes'],archive['archived_files']),('unavailable','sentinel_missing',0,0,2))
  # A POST returns the same block.
  r=self.send('post','/api/settings/storage',json={'max_bytes':0,'policy':'reject_new'})
  self.assertEqual(r.status_code,200);self.assertEqual(set(r.json['archive']),self.ARCHIVE_KEYS)

 def test_storage_snapshot_computes_archive_outside_lock(self):
  nas,store=make_nas(self.root);self.use(store)
  started,release=threading.Event(),threading.Event()
  def slow():started.set();release.wait(5);return 1,2
  results=[]
  with patch.object(store,'usage',side_effect=slow):
   worker=threading.Thread(target=lambda:results.append(self.get('/api/settings/storage')));worker.start()
   try:
    self.assertTrue(started.wait(5))
    acquired=[]
    def take():
     for held in (server.lock,server.registration_lock):
      if held.acquire(timeout=1):acquired.append(1);held.release()
    other=threading.Thread(target=take);other.start();other.join(3)
    self.assertEqual(acquired,[1,1])
   finally:release.set();worker.join(5)
  self.assertEqual(results[0].status_code,200);self.assertEqual((results[0].json['archive']['used_bytes'],results[0].json['archive']['free_bytes']),(1,2))

 def test_archive_run_requires_header_and_enabled(self):
  self.assertEqual(self.client.post('/api/settings/archive/run',environ_overrides=PEER).status_code,403)
  self.assertEqual(self.client.post('/api/settings/archive/run',headers=HEADERS).status_code,403)  # Not from the Supervisor.
  r=self.send('post','/api/settings/archive/run')
  self.assertEqual((r.status_code,r.json),(409,{'error':'archive_disabled'}));self.assertEqual(r.headers['Cache-Control'],'no-store')
  nas,store=make_nas(self.root);self.use(store)
  archiver=media_store.Archiver(server,store,store.settings);calls=[]
  def body(result):
   calls.append(threading.current_thread());self.assertTrue(archiver.status()['running']);return 'below_threshold'
  with patch.object(server,'archiver',archiver),patch.object(archiver,'_cycle',side_effect=body):
   r=self.send('post','/api/settings/archive/run')
   self.assertEqual((r.status_code,r.json),(202,{'started':True}));self.assertEqual(r.headers['Cache-Control'],'no-store')
   archiver.manual.join(5);self.assertFalse(archiver.manual.is_alive())
   # The cycle ran once, off the request thread, and released the lock.
   self.assertEqual(len(calls),1);self.assertIs(calls[0],archiver.manual);self.assertNotEqual(calls[0],threading.current_thread())
   self.assertTrue(archiver.cycle.acquire(blocking=False));archiver.cycle.release();self.assertFalse(archiver.status()['running'])
   # A cycle already running (the background loop) is not started twice.
   with archiver.cycle:r=self.send('post','/api/settings/archive/run')
   self.assertEqual((r.status_code,r.json),(409,{'error':'archive_running'}))
   self.assertNotIn(str(nas),r.get_data(as_text=True));self.assertEqual(len(calls),1)

 def test_archive_run_second_post_while_running_is_409(self):
  nas,store=make_nas(self.root);self.use(store)
  archiver=media_store.Archiver(server,store,store.settings);started,release=threading.Event(),threading.Event();calls=[]
  def body(result):calls.append(1);started.set();release.wait(5);return 'below_threshold'
  with patch.object(server,'archiver',archiver),patch.object(archiver,'_cycle',side_effect=body):
   try:
    self.assertEqual(self.send('post','/api/settings/archive/run').status_code,202);self.assertTrue(started.wait(5))
    r=self.send('post','/api/settings/archive/run')
    self.assertEqual((r.status_code,r.json),(409,{'error':'archive_running'}))
    self.assertTrue(self.get('/api/settings/storage').json['archive']['running'])
    self.assertEqual(archiver.run_cycle()['stopped'],'busy')  # The background loop waits too.
   finally:release.set();archiver.manual.join(5)
  self.assertEqual(calls,[1]);self.assertFalse(self.get('/api/settings/storage').json['archive']['running'])

 def test_storage_snapshot_reads_no_index_when_archiving_disabled(self):
  make_log(self.root,'a'*32,['rlog.zst'],[])
  media_store.PendingDeletes(self.root).add('c'*32,['fcamera.mp4'])
  def forbidden(*args,**kw):raise AssertionError('index scanned while archiving is disabled')
  with patch.object(server,'recording_paths',side_effect=forbidden),patch.object(server,'read_meta',side_effect=forbidden),patch.object(media_store.PendingDeletes,'count',side_effect=forbidden):
   r=self.get('/api/settings/storage')
  self.assertEqual(r.status_code,200)
  archive=r.json['archive'];self.assertEqual((archive['enabled'],archive['archived_files'],archive['archived_bytes'],archive['pending_deletes']),(False,0,0,0))

 def test_storage_snapshot_caches_index_scan(self):
  class Clock:
   t=1000.0
   def __call__(self):return self.t
  clock=Clock();nas,_=make_nas(self.root)
  store=media_store.ArchiveStore(media_store.ArchiveSettings(enabled=True,path=nas),self.root,clock=clock);self.use(store)
  archiver=media_store.Archiver(server,store,store.settings);patcher=patch.object(server,'archiver',archiver);patcher.start();self.addCleanup(patcher.stop)
  make_log(self.root,'a'*32,['rlog.zst'],['fcamera.mp4'],nas=nas)
  files=lambda:self.get('/api/settings/storage').json['archive']['archived_files']
  scans=[];real=server.storage_policy.archived_totals
  with patch.object(server.storage_policy,'archived_totals',side_effect=lambda:scans.append(1) or real()):
   self.assertEqual(files(),1)
   make_log(self.root,'b'*32,['rlog.zst'],['fcamera.mp4'],nas=nas)
   clock.t+=9.9;self.assertEqual(files(),1);self.assertEqual(len(scans),1)  # Within 10 s: the earlier scan.
   clock.t+=0.1;self.assertEqual(files(),2);self.assertEqual(len(scans),2)
   make_log(self.root,'c'*32,['rlog.zst'],['fcamera.mp4'],nas=nas)
   store.invalidate();self.assertEqual(files(),3)
   make_log(self.root,'d'*32,['rlog.zst'],['fcamera.mp4'],nas=nas)
   # Each archiver cycle ends by dropping the cached scan.
   with patch.object(archiver,'_cycle',return_value='below_threshold'):archiver.run_cycle()
   self.assertEqual(files(),4);self.assertEqual(len(scans),4)

 def test_config_yaml_has_share_map_and_archive_options(self):
  import re
  text=(Path(__file__).resolve().parents[1]/'roadviewer/config.yaml').read_text(encoding='utf-8')
  self.assertRegex(text,r'(?m)^map:\n  - type: ssl\n    read_only: true\n  - type: share\n    read_only: false$')
  options=text.split('\noptions:\n',1)[1].split('\nschema:\n',1)[0];schema=text.split('\nschema:\n',1)[1].split('\nurl:',1)[0]
  expected={'archive_enabled':('false','bool'),'archive_path':('""','str'),'archive_local_threshold_mb':('0','int(0,)'),'archive_min_age_hours':('24','int(0,8760)'),
            'archive_interval_minutes':('10','int(1,1440)'),'archive_batch':('4','int(1,64)'),'archive_nas_max_mb':('0','int(0,)'),'archive_nas_margin_mb':('1024','int(0,)')}
  for key,(default,rule) in expected.items():
   self.assertRegex(options,rf'(?m)^  {key}: {re.escape(default)}$',key);self.assertRegex(schema,rf'(?m)^  {key}: {re.escape(rule)}$',key)
  self.assertEqual(len(re.findall(r'(?m)^  archive_',options)),8);self.assertEqual(len(re.findall(r'(?m)^  archive_',schema)),8)
  # Existing options stay; the add-on version is not bumped by this change.
  for line in ('  max_upload_mb: 512','  max_upload_mb: int(16,2048)','hassio_api: true'):self.assertIn(line+'\n',text)
  self.assertRegex(text,r'(?m)^version: "0\.12\.2"$')

 def test_archive_options_json_env_merges(self):
  # The merge happens at import, so a fresh interpreter imports the server with the variable set.
  import subprocess
  app=Path(__file__).resolve().parents[1]/'roadviewer/app';nas=Path(tempfile.mkdtemp(prefix='rv-nas-'))
  # The share is first touched by the archiver thread's activation, not by the import.
  code='import server;server.archiver.activate();print(server.archive_settings.enabled,server.archive_settings.batch,server.store.state())'
  def run(**env):
   data=tempfile.mkdtemp(prefix='rv-data-')
   base={k:v for k,v in os.environ.items() if k not in ('RV_ARCHIVE_OPTIONS_JSON','RV_MIGRATE_PREPARED','RV_ARCHIVE_ALLOW_ANY_PATH')}
   done=subprocess.run([sys.executable,'-c',code],cwd=app,env={**base,'RV_DATA':data,**env},capture_output=True,text=True,timeout=60)
   self.assertEqual(done.returncode,0,done.stderr);return done.stdout.split()
  self.assertEqual(run(),['False','4','disabled'])
  options=json.dumps({'archive_enabled':True,'archive_path':str(nas),'archive_batch':7})
  self.assertEqual(run(RV_ARCHIVE_OPTIONS_JSON=options,RV_ARCHIVE_ALLOW_ANY_PATH='1'),['True','7','connected'])

 def test_import_never_probes_the_share(self):
  # A hung mount at startup: importing the server (which also runs requeue_startup) must not touch the share.
  import subprocess
  app=Path(__file__).resolve().parents[1]/'roadviewer/app';nas=Path(tempfile.mkdtemp(prefix='rv-nas-'));data=Path(tempfile.mkdtemp(prefix='rv-data-'))
  p=make_log(data,'a'*32,['rlog.zst'],['fcamera.mp4'],nas=nas);self.ready(p)
  code=('import media_store;calls=[];media_store.ArchiveStore._probe=lambda self:calls.append(1) or ("unavailable","os_error");import server;'
        'print(len(calls),server.store.last_state(),server.read_meta(server.ROOT/"'+p.name+'")["status"])')
  base={k:v for k,v in os.environ.items() if k not in ('RV_ARCHIVE_OPTIONS_JSON','RV_MIGRATE_PREPARED','RV_ARCHIVE_ALLOW_ANY_PATH')}
  options=json.dumps({'archive_enabled':True,'archive_path':str(nas)})
  done=subprocess.run([sys.executable,'-c',code],cwd=app,env={**base,'RV_DATA':str(data),'RV_ARCHIVE_OPTIONS_JSON':options,'RV_ARCHIVE_ALLOW_ANY_PATH':'1'},capture_output=True,text=True,timeout=60)
  self.assertEqual(done.returncode,0,done.stderr);self.assertEqual(done.stdout.split(),['0','None','ready'])
  self.assertFalse((nas/media_store.SENTINEL).exists());self.assertTrue((p/'prepared'/'data.json').is_file())

 def test_requeue_startup_does_not_probe(self):
  nas,store=make_nas(self.root);self.use(store)
  p=make_log(self.root,'a'*32,['rlog.zst'],['fcamera.hevc'],nas=nas);self.ready(p,decoder_version='old')
  q=make_log(self.root,'b'*32,['rlog.zst'],['fcamera.hevc'],status='processing',nas=nas)
  store.invalidate()  # No recent result, as at startup.
  with patch.object(store,'_probe',side_effect=AssertionError('probed at startup')) as probe,patch.object(server,'auto_convert',True),patch.object(server,'submit') as submit:
   server.requeue_startup()
  probe.assert_not_called()
  # Held while the share is unchecked: the outdated result stays.
  self.assertEqual(server.read_meta(p)['status'],'ready');self.assertTrue((p/'prepared'/'data.json').is_file())
  # The interrupted conversion is queued again (run_job defers it until the share answers).
  self.assertEqual(server.read_meta(q)['status'],'queued');submit.assert_called_once_with(q.name)
  self.assertTrue((nas/q.name/'fcamera.hevc').is_file())

 def test_reupload_does_not_probe_under_registration_lock(self):
  # Re-uploading an archived recording with a new camera: the share is probed before the registration lock.
  nas,store=make_nas(self.root);self.use(store)
  p=make_log(self.root,'a'*32,[],['rlog.zst','fcamera.mp4'],nas=nas)
  m=server.read_meta(p);m['storage']['rlog.zst']['sha256']=hashlib.sha256(b'rlog.zst'*20).hexdigest();self.ready(p,storage=m['storage'])
  # The share answers the upload's own check, then hangs once registration starts: the received files are
  # hashed for longer than the cached result lives.
  now=[1000.0];probe=store._probe;started,release=threading.Event(),threading.Event();calls=[];results={}
  def hung():
   calls.append(1)
   if len(calls)>1:started.set();release.wait(10)
   return probe()
  def digest(path):now[0]+=media_store.CACHE_SECONDS+1;return real_digest(path)
  real_digest=server.file_digest;store.invalidate()
  with patch.object(store,'clock',lambda:now[0]),patch.object(store,'_probe',side_effect=hung),patch.object(server,'file_digest',digest),patch.object(server,'submit'):
   def upload():
    r=server.app.test_client().post('/api/upload',environ_overrides=PEER,headers=HEADERS,data={'files':[(io.BytesIO(b'rlog.zst'*20),'rlog.zst'),(io.BytesIO(b'video'),'qcamera.ts')]})
    results['upload']=(r.status_code,r.json)
   worker=threading.Thread(target=upload);worker.start()
   try:
    self.assertTrue(started.wait(5))
    self.assertTrue(server.registration_lock.acquire(timeout=1),'registration lock held during the NAS probe');server.registration_lock.release()
    self.assertTrue(server.lock.acquire(timeout=1),'lock held during the NAS probe');server.lock.release()
    self.assertTrue(worker.is_alive())
   finally:release.set();worker.join(10)
  # Once the share answered, the camera was added and the recording queued for reconversion.
  self.assertEqual(results['upload'][0],201,results['upload']);self.assertEqual([u['id'] for u in results['upload'][1]['updated']],[p.name])
  self.assertEqual((p/'qcamera.ts').read_bytes(),b'video');self.assertEqual(server.read_meta(p)['status'],'queued')

 def test_decoder_reads_paths_from_environment(self):
  import importlib,decoder
  src=self.root/'nas'/'rlog.zst'
  with patch.dict(os.environ,{'RV_MEDIA_PATHS':json.dumps({'fcamera.hevc':'/nas/x/fcamera.hevc'}),'RV_PREPARED_DIR':str(self.root/'p'/'prepared'),'RV_RECORDING_DIR':str(self.root/'p')}):
   decoder=importlib.reload(decoder)
   self.assertEqual(decoder.media(src,'fcamera.hevc'),Path('/nas/x/fcamera.hevc'));self.assertEqual(decoder.media(src,'camera.mp4'),src.parent/'camera.mp4')
   self.assertEqual(decoder.prepared_dir(src),self.root/'p'/'prepared');self.assertEqual(decoder.recording_dir(src),self.root/'p')
  decoder=importlib.reload(decoder)
  self.assertEqual(decoder.media(src,'fcamera.hevc'),src.parent/'fcamera.hevc')
  self.assertEqual(decoder.prepared_dir(src),src.parent/'prepared');self.assertEqual(decoder.recording_dir(src),src.parent)

if __name__=='__main__':unittest.main()
