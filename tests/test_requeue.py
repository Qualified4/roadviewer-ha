import os,sys,tempfile,unittest,json
from pathlib import Path
from unittest.mock import patch
os.environ['RV_DATA']=tempfile.mkdtemp()
os.environ['RV_INGRESS_ONLY']='1'
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'roadviewer/app'))
import server

class RequeueTests(unittest.TestCase):
 def test_cleanup_finishes_before_any_job_and_preserves_originals(self):
  with tempfile.TemporaryDirectory() as root,patch.object(server,'ROOT',Path(root)):
   paths=[]
   for n,status,version in [(1,'ready','old'),(2,'processing','old'),(3,'queued','old'),(4,'ready','v22-adjustable-height')]:
    p=Path(root)/f'{n:032x}';p.mkdir();paths.append(p)
    (p/'rlog.zst').write_bytes(b'original log');(p/'qcamera.ts').write_bytes(b'original video')
    (p/'prepared').mkdir();(p/'prepared/camera.mp4').write_bytes(b'old mp4');(p/'prepared/data.json').write_text('{}')
    server.save_meta(p,dict(status=status,decoder_version=version,video=True,duration=60))
   def submitted(id):
    for p in paths[:3]:
     self.assertEqual(server.read_meta(p)['status'],'queued')
     self.assertTrue(server.read_meta(p)['video'])
     self.assertIsNone(server.read_meta(p)['duration'])
     self.assertFalse((p/'prepared').exists())
     self.assertEqual((p/'rlog.zst').read_bytes(),b'original log')
     self.assertEqual((p/'qcamera.ts').read_bytes(),b'original video')
   with patch.object(server,'submit',side_effect=submitted) as submit:server.requeue_startup()
   self.assertEqual(submit.call_count,3)
   self.assertEqual(server.read_meta(paths[3])['status'],'ready')
   self.assertTrue((paths[3]/'prepared/camera.mp4').exists())

 def test_requeue_is_oldest_first_and_reverses_library_order(self):
  with tempfile.TemporaryDirectory() as root,patch.object(server,'ROOT',Path(root)):
   for n,uploaded in [(4,200),(2,300),(1,200),(3,100)]:
    p=Path(root)/f'{n:032x}';p.mkdir()
    server.save_meta(p,dict(id=p.name,status='ready',decoder_version='old',uploaded=uploaded))
   rows=server.app.test_client().get('/api/logs',environ_overrides={'REMOTE_ADDR':'172.30.32.2'}).json['logs']
   with patch.object(server,'submit') as submit:server.requeue_startup()
   actual=[call.args[0] for call in submit.call_args_list]
   self.assertEqual(actual,[f'{n:032x}' for n in [3,1,4,2]])
   self.assertEqual(actual,[m['id'] for m in reversed(rows)])

 def test_video_unavailable_until_ready_even_if_file_exists(self):
  with tempfile.TemporaryDirectory() as root,patch.object(server,'ROOT',Path(root)):
   p=Path(root)/('a'*32);p.mkdir();(p/'prepared').mkdir();(p/'prepared/camera.mp4').write_bytes(b'mp4')
   client=server.app.test_client()
   for status in ['queued','processing','error','ready']:
    server.save_meta(p,dict(status=status))
    response=client.get('/api/logs/'+p.name+'/video',environ_overrides={'REMOTE_ADDR':'172.30.32.2'})
    self.assertEqual(response.status_code,200 if status=='ready' else 409)
    response.close()

 def test_restored_backup_without_video_is_rebuilt_as_log_only(self):
  with tempfile.TemporaryDirectory() as root,patch.object(server,'ROOT',Path(root)),patch.object(server,'submit') as submit:
   p=Path(root)/('c'*32);p.mkdir();(p/'rlog.zst').write_bytes(b'log');(p/'prepared').mkdir();(p/'prepared/data.json').write_text('{}')
   server.save_meta(p,dict(id=p.name,status='ready',video=True,decoder_version='v22-adjustable-height'))
   server.requeue_startup()
   submit.assert_called_once_with(p.name);self.assertFalse(server.read_meta(p)['video']);self.assertFalse((p/'prepared').exists())
if __name__=='__main__':unittest.main()
