"""Streamed downloads provide one filename, without a misleading fallback name."""
import os,sys,tempfile,unittest
from email import message_from_string
from pathlib import Path
from unittest.mock import patch
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'roadviewer/app'))
sys.path.insert(0,'/app')
os.environ.setdefault('RV_DATA',tempfile.mkdtemp(prefix='rv-filename-tests-'))
import server

class DownloadFilenameTests(unittest.TestCase):
 def test_streamed_log_and_zip_filename_headers(self):
  with tempfile.TemporaryDirectory() as temp,patch.object(server,'ROOT',Path(temp)):
   p=Path(temp)/('a'*32);p.mkdir();(p/'rlog.zst').write_bytes(b'original log')
   client=server.app.test_client();peer={'REMOTE_ADDR':'172.30.32.2'}
   for name in ('0000041b--c6f39793a8--1--rlog.zst','test log "one"--rlog.zst','테스트--1--rlog.zst'):
    with self.subTest(name=name):
     server.save_meta(p,dict(id=p.name,name='test',status='ready',files={'rlog.zst':name}))
     response=client.get(f'/api/logs/{p.name}/download?source=rlog&format=mp4',environ_overrides=peer)
     self.assertEqual(response.status_code,200);self.assertEqual(response.data,b'original log')
     header=response.headers['Content-Disposition'];parsed=message_from_string('Content-Disposition: '+header)
     self.assertEqual(parsed.get_filename(),name)
     self.assertEqual(len(parsed.get_params(header='Content-Disposition')),2)
     if name.isascii():self.assertEqual(header,'attachment; filename="'+name.replace('"','\\"')+'"')
     response.close()
   for format in ('mp4','original'):
    response=client.get(f'/api/logs/download.zip?ids={p.name}&parts=rlog&format={format}',environ_overrides=peer)
    header=response.headers['Content-Disposition'];parsed=message_from_string('Content-Disposition: '+header)
    self.assertEqual(parsed.get_filename(),f'roadviewer-1-segments-{format}.zip');self.assertNotIn('filename*',header)
    self.assertTrue(response.data.startswith(b'PK'));response.close()

if __name__=='__main__':unittest.main()
