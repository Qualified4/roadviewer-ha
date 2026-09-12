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

if __name__=='__main__':unittest.main()
