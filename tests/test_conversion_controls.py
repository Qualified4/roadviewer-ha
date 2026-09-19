import io,os,sys,tempfile,unittest
from pathlib import Path
from unittest.mock import patch
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'roadviewer/app'))
os.environ.setdefault('RV_DATA',tempfile.mkdtemp())
import server
PEER={'REMOTE_ADDR':'172.30.32.2'};HEADERS={'X-RoadViewer-Request':'1'}

class ConversionTests(unittest.TestCase):
 def setUp(self):
  temp=tempfile.TemporaryDirectory();self.addCleanup(temp.cleanup);self.root=Path(temp.name)
  for name,value in [('ROOT',self.root),('PROCESSING_SETTINGS',self.root/'.processing-settings.json'),('auto_convert',True)]:
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

if __name__=='__main__':unittest.main()
