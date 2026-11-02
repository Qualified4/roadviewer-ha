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

 def test_run_job_passes_media_paths_env(self):
  nas,store=make_nas(self.root);self.use(store)
  p=make_log(self.root,'a'*32,['camera.mp4'],['rlog.zst','fcamera.hevc'],status='queued',nas=nas)
  m=server.read_meta(p);m['manual_conversion']=True;server.save_meta(p,m)
  popen=self.run_job(p,returncode=1)
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
   m=server.read_meta(p);self.assertEqual((m['status'],m['error']),('unconverted','저장소에 연결할 수 없어 변환을 미뤘습니다.'))
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
   limit=server.storage_used_bytes()+65536-1
   with patch.dict(server.storage_policy.settings,{'max_bytes':limit,'policy':'delete_oldest','pinned_logs':[]}),server.registration_lock,server.lock:
    server.storage_policy.admit(0,[],commit=True)
  self.lose_nas(nas,store);admit()
  self.assertTrue(old.exists());self.assertFalse(new.exists());self.assertTrue((nas/old.name/'fcamera.mp4').is_file())
  self.assertFalse((self.root/'.pending-nas-deletes.json').exists())
  # Connected again, the oldest recording goes first, archived files included.
  new=make_log(self.root,'b'*32,['rlog.zst'],[]);m=server.read_meta(new);m.update(uploaded=2,name='0000041c--c6f39793a8--1');server.save_meta(new,m)
  self.restore_nas(nas,store);admit()
  self.assertFalse(old.exists());self.assertFalse((nas/old.name).exists());self.assertTrue(new.exists())

 def test_clear_prepared_keeps_mp4_when_original_unavailable(self):
  nas,store=make_nas(self.root);self.use(store)
  p=make_log(self.root,'a'*32,['rlog.zst','fcamera.mp4'],['fcamera.hevc'],nas=nas);self.ready(p);self.lose_nas(nas,store)
  self.assertEqual(self.send('delete',f'/api/logs/{p.name}/prepared').status_code,200)
  self.assertFalse((p/'prepared').exists());self.assertEqual((p/'fcamera.mp4').read_bytes(),b'fcamera.mp4'*10)
  self.assertTrue((nas/p.name/'fcamera.hevc').is_file());self.assertEqual(media_store.location(server.read_meta(p),'fcamera.hevc'),'nas')
  # Connected, the original is readable again and the MP4 is disposable output as before.
  self.restore_nas(nas,store);server.clear_prepared(p,server.read_meta(p))
  self.assertFalse((p/'fcamera.mp4').exists());self.assertTrue((nas/p.name/'fcamera.hevc').is_file())

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
