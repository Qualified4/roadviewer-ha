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

 def test_remove_convert_and_converted_size(self):
  with tempfile.TemporaryDirectory() as root,patch.object(server,'ROOT',Path(root)),patch.object(server,'submit') as submit:
   p=Path(root)/('b'*32);p.mkdir();(p/'rlog.zst').write_bytes(b'log');(p/'prepared').mkdir();(p/'prepared/data.json').write_bytes(b'{}');(p/'prepared/camera.mp4').write_bytes(b'video')
   server.save_meta(p,dict(id=p.name,status='ready',uploaded=1,bytes=3,conversion_revision=2))
   c=server.app.test_client();peer={'REMOTE_ADDR':'172.30.32.2'};headers={'X-RoadViewer-Request':'1'}
   self.assertEqual(c.get('/api/logs',environ_overrides=peer).json['logs'][0]['prepared_bytes'],7)
   r=c.delete(f'/api/logs/{p.name}/prepared',headers=headers,environ_overrides=peer)
   self.assertEqual(r.status_code,200);self.assertFalse((p/'prepared').exists());self.assertEqual((p/'rlog.zst').read_bytes(),b'log')
   self.assertEqual(server.read_meta(p)['conversion_revision'],3);submit.assert_not_called()
   self.assertEqual(c.post(f'/api/logs/{p.name}/convert',headers=headers,environ_overrides=peer).status_code,200)
   submit.assert_called_once_with(p.name)
   self.assertEqual(c.post(f'/api/logs/{p.name}/convert',headers=headers,environ_overrides=peer).status_code,200)
   submit.assert_called_once_with(p.name)
 def test_telemetry_endpoint_checks_readiness(self):
  with tempfile.TemporaryDirectory() as root,patch.object(server,'ROOT',Path(root)):
   p=Path(root)/('d'*32);p.mkdir();(p/'prepared').mkdir();server.save_meta(p,dict(status='processing'))
   c=server.app.test_client();peer={'REMOTE_ADDR':'172.30.32.2'};url=f'/api/logs/{p.name}/telemetry'
   self.assertEqual(c.get(url,environ_overrides=peer).status_code,409)
   server.save_meta(p,dict(status='ready'))
   self.assertEqual(c.get(url,environ_overrides=peer).status_code,404)
   (p/'prepared/telemetry.json').write_text('{"streams":{}}')
   r=c.get(url,environ_overrides=peer);self.assertEqual(r.status_code,200);self.assertEqual(r.json,{'streams':{}});self.assertEqual(r.headers['Cache-Control'],'no-store');r.close()
   self.assertEqual(c.get(url).status_code,403)
 def test_backup_patterns_exclude_recordings_and_keep_settings(self):
  # Supervisor matches each path and prunes matching directories before descent.
  import re
  config=(Path(__file__).resolve().parents[1]/'roadviewer/config.yaml').read_text().split('backup_exclude:',1)[1]
  patterns=re.findall(r'"([^"\n]+)"',config)
  root=Path('/data/addons/data/local_roadviewer')
  def excluded(name):
   path=root/name
   return any(parent.match(pattern) for parent in [path,*path.parents] for pattern in patterns)
  for id in ['0'*32,'a'*32,'f'*32]:
   for name in ['rlog.zst','qcamera.ts','meta.json','prepared/camera.mp4','prepared/data.json','prepared/telemetry.json']:
    self.assertTrue(excluded(f'roadviewer/{id}/{name}'),name)
  for name in ['.uploads/abc/0','.upload-staging/file','.picker-diagnostics.jsonl','.picker-diagnostics.previous.jsonl']:
   self.assertTrue(excluded('roadviewer/'+name),name)
  for name in ['options.json','roadviewer/.processing-settings.json']:
   self.assertFalse(excluded(name),name)

if __name__=='__main__':unittest.main()
