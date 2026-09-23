import io,json,os,sys,tempfile,unittest
from pathlib import Path
from unittest.mock import patch
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'roadviewer/app'))
os.environ.setdefault('RV_DATA',tempfile.mkdtemp())
import server
PEER={'REMOTE_ADDR':'172.30.32.2'};HEADERS={'X-RoadViewer-Request':'1'}

class ConversionTests(unittest.TestCase):
 def setUp(self):
  temp=tempfile.TemporaryDirectory();self.addCleanup(temp.cleanup);self.root=Path(temp.name)
  for name,value in [('ROOT',self.root),('PROCESSING_SETTINGS',self.root/'.processing-settings.json'),('auto_convert',True),('keep_original_video',True)]:
   patcher=patch.object(server,name,value);patcher.start();self.addCleanup(patcher.stop)
  patcher=patch.object(server,'submit');self.submit=patcher.start();self.addCleanup(patcher.stop)
  self.c=server.app.test_client()
 def request(self,method,url,**kwargs):return getattr(self.c,method)(url,headers=HEADERS,environ_overrides=PEER,**kwargs)
 def setting(self,value):return self.request('post','/api/settings/processing',json={'auto_convert':value})
 def row(self,n,status,**kwargs):
  p=self.root/f'{n:032x}';p.mkdir();(p/'rlog.zst').write_bytes(b'log');(p/'qcamera.ts').write_bytes(b'ts')
  server.save_meta(p,dict(id=p.name,name='test',uploaded=n,status=status,**kwargs));return p
 def test_disable_leaves_running_and_manual_jobs_then_enables_oldest_first(self):
  rows=[self.row(3,'queued'),self.row(1,'unconverted'),self.row(2,'processing'),self.row(4,'queued',manual_conversion=True),self.row(5,'unconverted',auto_excluded=True),self.row(6,'error')]
  self.assertEqual(self.setting(False).status_code,200)
  self.assertEqual([server.read_meta(p)['status'] for p in rows],['unconverted','unconverted','processing','queued','unconverted','error'])
  self.assertFalse(server.read_auto_convert())
  self.assertEqual(self.request('post','/api/settings/processing',json={'concurrency':1}).json['auto_convert'],False)
  self.assertEqual(self.setting(True).status_code,200)
  self.assertEqual([c.args[0] for c in self.submit.call_args_list],[rows[1].name,rows[0].name])
 def test_remove_preserves_originals_survives_restart_and_deduplicates_manual_convert(self):
  p=self.row(1,'ready');prepared=p/'prepared';prepared.mkdir()
  for name in ('camera.mp4','data.json','telemetry.json'):(prepared/name).write_text('data')
  url='/api/logs/'+p.name
  self.assertEqual(self.request('delete',url+'/prepared').status_code,200)
  self.assertFalse(prepared.exists());self.assertEqual((p/'rlog.zst').read_bytes(),b'log');self.assertEqual((p/'qcamera.ts').read_bytes(),b'ts')
  server.requeue_startup();self.setting(False);self.setting(True);self.submit.assert_not_called()
  self.setting(False)
  for _ in range(3):self.assertEqual(self.request('post',url+'/convert').status_code,200)
  self.submit.assert_called_once_with(p.name)
  m=server.read_meta(p);self.assertTrue(m['manual_conversion']);self.assertFalse(m['auto_excluded'])
  self.assertEqual(self.request('delete',url+'/prepared').status_code,409)
  self.submit.reset_mock();server.requeue_startup();self.submit.assert_called_once_with(p.name)
  self.assertEqual(self.request('delete',url).status_code,200);self.assertFalse(p.exists())
 def test_upload_off_and_late_video_respect_manual_removal(self):
  self.setting(False)
  def upload(video=False):
   files=[(io.BytesIO(b'unique'),'rlog.zst')]
   if video:files.append((io.BytesIO(b'ts'),'qcamera.ts'))
   return self.request('post','/api/upload',data={'files':files})
  result=upload();self.assertEqual(result.status_code,201);m=result.json['logs'][0];p=self.root/m['id']
  self.assertEqual(m['status'],'unconverted');self.submit.assert_not_called()
  self.request('delete','/api/logs/'+p.name+'/prepared');self.setting(True)
  self.assertEqual(upload(True).json['updated'][0]['status'],'unconverted');self.submit.assert_not_called()
 def test_stale_results_invalidated_without_auto_start_and_auth_validation(self):
  p=self.row(1,'ready',decoder_version='old',video=True);(p/'prepared').mkdir();(p/'prepared/data.json').write_text('{}')
  self.setting(False);server.requeue_startup()
  self.assertEqual(server.read_meta(p)['status'],'unconverted');self.assertFalse((p/'prepared').exists());self.submit.assert_not_called()
  for value in [None,1,'false',[]]:self.assertEqual(self.setting(value).status_code,400)
  self.assertEqual(self.c.post('/api/settings/processing',json={'auto_convert':True},environ_overrides=PEER).status_code,403)
  for method,suffix in [('post','convert'),('delete','prepared')]:
   self.assertEqual(getattr(self.c,method)('/api/logs/'+p.name+'/'+suffix,environ_overrides=PEER).status_code,403)
 def test_worker_does_not_start_stale_automatic_queue_when_disabled(self):
  p=self.row(1,'queued');server.auto_convert=False
  with patch.object(server.subprocess,'Popen') as popen:server.run_job(p.name);popen.assert_not_called()
  self.assertEqual(server.read_meta(p)['status'],'unconverted')

 def test_video_retention_setting_persists_and_rejects_invalid_values(self):
  self.assertTrue(server.read_keep_original_video())
  for value in (False,True):
   r=self.request('post','/api/settings/processing',json={'keep_original_video':value})
   self.assertEqual(r.status_code,200);self.assertEqual(server.read_keep_original_video(),value)
   self.assertEqual(self.setting(False).json['keep_original_video'],value)
  for value in (None,1,'false',[]):
   self.assertEqual(self.request('post','/api/settings/processing',json={'keep_original_video':value}).status_code,400)

 def test_verified_mp4_retention_download_removal_restart_and_duplicates(self):
  p=self.row(1,'queued');server.keep_original_video=False
  meta=server.read_meta(p);meta['files']={'qcamera.ts':'route--0--qcamera.ts'}
  server.stored_digests(p,meta);server.save_meta(p,meta)
  prepared=p/'prepared';prepared.mkdir()
  (prepared/'camera.mp4').write_bytes(b'verified-video')
  (prepared/'data.json').write_text('{}')
  (prepared/'summary.json').write_text(json.dumps(dict(duration=1,warnings=[],model_frames=1,video={'frames':1})))
  with patch.object(server,'ProgressChannel') as channel,patch.object(server.subprocess,'Popen') as popen:
   channel.return_value.__enter__.return_value.options.return_value={}
   popen.return_value.communicate.return_value=('','');popen.return_value.returncode=0;popen.return_value.poll.return_value=0
   server.run_job(p.name)
  self.assertEqual(server.read_meta(p)['status'],'ready')
  self.assertFalse((p/'qcamera.ts').exists());self.assertFalse((prepared/'camera.mp4').exists())
  self.assertEqual((p/'camera.mp4').read_bytes(),b'verified-video')
  server.requeue_startup();self.submit.assert_not_called()
  url='/api/logs/'+p.name
  (p/'qcamera.ts').write_bytes(b'ts')
  response=self.request('get',url+'/download/video')
  self.assertEqual(response.data,b'ts');self.assertEqual(response.mimetype,'video/mp2t');response.close()
  (p/'qcamera.ts').unlink()
  for suffix in ('/video','/original/camera.mp4','/download/video'):
   response=self.request('get',url+suffix)
   self.assertEqual(response.data,b'verified-video');self.assertEqual(response.mimetype,'video/mp4')
   if suffix.startswith('/original'):self.assertIn('route--0--qcamera.mp4',response.headers['Content-Disposition'])
   response.close()
  with patch.object(server,'cleanup_uploads'):
   row=self.request('get','/api/logs').json['logs'][0]
  self.assertTrue(row['video']);self.assertEqual(row['video_download'],'camera.mp4')
  self.assertEqual(row['bytes'],len(b'logverified-video'))
  result=self.request('post','/api/upload',data={'files':[(io.BytesIO(b'log'),'rlog.zst'),(io.BytesIO(b'ts'),'qcamera.ts')]})
  self.assertEqual(len(result.json['duplicates']),1);self.assertFalse(result.json['duplicates'][0]['video_differs'])
  self.assertFalse((p/'qcamera.ts').exists())
  self.request('delete',url+'/prepared');self.assertTrue((p/'camera.mp4').is_file())
  self.request('post',url+'/convert');server.requeue_startup()
  self.assertTrue((p/'camera.mp4').is_file())
  self.request('delete',url);self.assertFalse(p.exists())

 def test_ts_preserved_when_enabled_or_video_not_verified_or_job_fails(self):
  for index,(keep,video,failed) in enumerate([(True,{'frames':1},False),(False,None,False),(False,{'frames':1},True)],10):
   p=self.row(index,'queued');server.keep_original_video=keep
   prepared=p/'prepared';prepared.mkdir();(prepared/'camera.mp4').write_bytes(b'output')
   (prepared/'summary.json').write_text(json.dumps(dict(duration=1,warnings=[],model_frames=1,video=video)))
   with patch.object(server,'ProgressChannel') as channel,patch.object(server.subprocess,'Popen') as popen:
    channel.return_value.__enter__.return_value.options.return_value={}
    popen.return_value.communicate.return_value=('','failed');popen.return_value.returncode=int(failed);popen.return_value.poll.return_value=int(failed)
    server.run_job(p.name)
   self.assertTrue((p/'qcamera.ts').is_file());self.assertFalse((p/'camera.mp4').exists())
   response=self.request('get','/api/logs/'+p.name+'/download/video')
   self.assertEqual(response.mimetype,'video/mp2t');response.close()

if __name__=='__main__':unittest.main()
