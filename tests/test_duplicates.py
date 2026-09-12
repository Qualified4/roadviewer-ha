import io,os,sys,tempfile,unittest,concurrent.futures
from pathlib import Path
os.environ['RV_DATA']=tempfile.mkdtemp();os.environ['RV_INGRESS_ONLY']='1'
sys.path.insert(0,'/app');sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'roadviewer/app'))
import server
server.submit=lambda id:None
PEER={'REMOTE_ADDR':'172.30.32.2'};HEADERS={'X-RoadViewer-Request':'1'}
class DuplicateTests(unittest.TestCase):
 def setUp(self):
  import shutil
  for p in server.ROOT.iterdir():
   if p!=server.UPLOADS:shutil.rmtree(p)
  self.c=server.app.test_client()
 def upload(self,files,client=None):
  return (client or self.c).post('/api/upload',headers=HEADERS,environ_overrides=PEER,data={'files':[(io.BytesIO(content),name) for name,content in files]})
 def count(self):return len(self.c.get('/api/logs',environ_overrides=PEER).json['logs'])
 def test_renamed_identical_and_different_contents(self):
  self.assertEqual(self.upload([('rlog.zst',b'log1')]).status_code,201)
  r=self.upload([('renamed/rlog.zst',b'log1')]);self.assertEqual(len(r.json['duplicates']),1);self.assertEqual(r.json['logs'],[])
  self.upload([('rlog.zst',b'log2')]);self.assertEqual(self.count(),2)
 def test_legacy_cache_and_delete(self):
  m=self.upload([('rlog.zst',b'log')]).json['logs'][0];p=server.ROOT/m['id'];meta=server.read_meta(p);meta.pop('content_hashes');server.save_meta(p,meta)
  self.assertEqual(len(self.upload([('rlog.zst',b'log')]).json['duplicates']),1);self.assertIn('content_hashes',server.read_meta(p))
  self.c.delete('/api/logs/'+m['id'],headers=HEADERS,environ_overrides=PEER)
  self.assertEqual(len(self.upload([('rlog.zst',b'log')]).json['logs']),1)
 def test_mixed_and_same_batch(self):
  self.upload([('rlog.zst',b'old')]);r=self.upload([('a/rlog.zst',b'old'),('b/rlog.zst',b'new'),('c/rlog.zst',b'new')]);self.assertEqual(len(r.json['logs']),1);self.assertEqual(len(r.json['duplicates']),2);self.assertEqual(self.count(),2)
 def test_video_difference_is_reported_not_overwritten(self):
  m=self.upload([('rlog.zst',b'log'),('qcamera.ts',b'video')]).json['logs'][0]
  same=self.upload([('rlog.zst',b'log'),('qcamera.ts',b'video')]);self.assertFalse(same.json['duplicates'][0]['video_differs'])
  different=self.upload([('rlog.zst',b'log'),('qcamera.ts',b'other')]);self.assertTrue(different.json['duplicates'][0]['video_differs']);self.assertEqual((server.ROOT/m['id']/'qcamera.ts').read_bytes(),b'video');self.assertEqual(self.count(),1)
 def test_simultaneous_requests(self):
  def send(_):
   with server.app.test_client() as client:return self.upload([('rlog.zst',b'concurrent')],client).json
  with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:results=list(pool.map(send,range(2)))
  self.assertEqual(sum(len(r['logs']) for r in results),1);self.assertEqual(self.count(),1)
 def test_chunk_duplicate_cleanup(self):
  self.upload([('rlog.zst',b'log')])
  r=self.c.post('/api/uploads',json={'files':[{'name':'rlog.zst','size':3}]},headers=HEADERS,environ_overrides=PEER);id=r.json['id']
  self.assertEqual(self.c.put(f'/api/uploads/{id}/files/0?offset=0',data=b'log',headers=HEADERS,environ_overrides=PEER).status_code,200)
  r=self.c.post(f'/api/uploads/{id}/finish',headers=HEADERS,environ_overrides=PEER);self.assertEqual(r.status_code,201);self.assertEqual(len(r.json['duplicates']),1);self.assertFalse((server.UPLOADS/id).exists());self.assertEqual(self.count(),1)
  self.assertFalse(list(server.ROOT.glob('.upload-*')))
if __name__=='__main__':
 try:unittest.main()
 finally:server.pool.shutdown()
