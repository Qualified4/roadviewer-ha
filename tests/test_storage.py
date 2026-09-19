import os,sys,tempfile,unittest
from pathlib import Path
from unittest.mock import patch
os.environ['RV_DATA']=tempfile.mkdtemp()
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'roadviewer/app'))
import server

class StorageTests(unittest.TestCase):
 def test_counts_all_app_files_and_reflects_deletion(self):
  with tempfile.TemporaryDirectory() as root,patch.object(server,'ROOT',Path(root)):
   sizes={'log/rlog.zst':10,'log/qcamera.ts':20,'log/prepared/camera.mp4':30,'log/prepared/data.json':40,'.uploads/part':50,'.picker-diagnostics.jsonl':60}
   for name,size in sizes.items():
    p=Path(root)/name;p.parent.mkdir(parents=True,exist_ok=True);p.write_bytes(b'x'*size)
   self.assertEqual(server.storage_used_bytes(),210)
   (Path(root)/'alias').symlink_to(Path(root)/'log',target_is_directory=True)
   self.assertEqual(server.storage_used_bytes(),210)
   (Path(root)/'log/prepared/camera.mp4').unlink()
   c=server.app.test_client();r=c.get('/api/logs',environ_overrides={'REMOTE_ADDR':'172.30.32.2'})
   self.assertEqual(r.json['storage_used_bytes'],180)
   self.assertEqual(r.json['max_upload_mb'],server.app.config['MAX_CONTENT_LENGTH']//1024//1024)

 def test_rebuild_and_converted_size(self):
  with tempfile.TemporaryDirectory() as root,patch.object(server,'ROOT',Path(root)),patch.object(server,'submit') as submit:
   p=Path(root)/('b'*32);p.mkdir();(p/'rlog.zst').write_bytes(b'log');(p/'prepared').mkdir();(p/'prepared/data.json').write_bytes(b'{}');(p/'prepared/camera.mp4').write_bytes(b'video')
   server.save_meta(p,dict(id=p.name,status='ready',uploaded=1,bytes=3,conversion_revision=2))
   c=server.app.test_client();peer={'REMOTE_ADDR':'172.30.32.2'};headers={'X-RoadViewer-Request':'1'}
   self.assertEqual(c.get('/api/logs',environ_overrides=peer).json['logs'][0]['prepared_bytes'],7)
   r=c.post(f'/api/logs/{p.name}/rebuild',headers=headers,environ_overrides=peer)
   self.assertEqual(r.status_code,200);self.assertFalse((p/'prepared').exists());self.assertEqual((p/'rlog.zst').read_bytes(),b'log')
   self.assertEqual(server.read_meta(p)['conversion_revision'],3);submit.assert_called_once_with(p.name)
   self.assertEqual(c.post(f'/api/logs/{p.name}/rebuild',headers=headers,environ_overrides=peer).status_code,409)
 def test_backup_patterns_keep_logs_and_settings(self):
  # Supervisor matches each path and prunes matching directories before descent.
  import re
  config=(Path(__file__).resolve().parents[1]/'roadviewer/config.yaml').read_text().split('backup_exclude:',1)[1]
  patterns=re.findall(r'"([^"\n]+)"',config)
  root=Path('/data/addons/data/local_roadviewer/roadviewer')
  for path in ['a/qcamera.ts','a/prepared/camera.mp4','.uploads','.upload-staging']:
   self.assertTrue(any((root/path).match(pattern) for pattern in patterns),path)
  for path in ['a/rlog.zst','a/meta.json','a/prepared/data.json','.processing-settings.json']:
   self.assertFalse(any((root/path).match(pattern) for pattern in patterns),path)
if __name__=='__main__':unittest.main()
