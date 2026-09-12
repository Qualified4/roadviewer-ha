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

 def test_attach_video_to_existing_log_and_requeue(self):
  from unittest.mock import patch
  m=self.upload([('rlog.zst',b'log')]).json['logs'][0];p=server.ROOT/m['id']
  m.update(status='ready');server.save_meta(p,m)
  (p/'prepared').mkdir();(p/'prepared/data.json').write_text('{}')
  with patch.object(server,'submit') as submit:
   r=self.upload([('renamed/rlog.zst',b'log'),('renamed/qcamera.ts',b'video')])
   self.assertEqual(r.status_code,201);submit.assert_called_once_with(m['id'])
  self.assertEqual(r.json['logs'],[]);self.assertEqual(r.json['duplicates'],[])
  self.assertEqual(r.json['updated'][0]['id'],m['id']);self.assertEqual(self.count(),1)
  self.assertEqual((p/'rlog.zst').read_bytes(),b'log')
  self.assertEqual((p/'qcamera.ts').read_bytes(),b'video')
  self.assertFalse((p/'prepared').exists());self.assertEqual(server.read_meta(p)['status'],'queued')
  again=self.upload([('rlog.zst',b'log'),('qcamera.ts',b'video')])
  self.assertEqual(again.json['updated'],[]);self.assertEqual(len(again.json['duplicates']),1)
 def test_video_only_still_rejected_even_with_existing_log(self):
  self.upload([('rlog.zst',b'log')])
  r=self.upload([('qcamera.ts',b'video')]);self.assertEqual(r.status_code,400)
  self.assertEqual(self.count(),1)
  self.assertFalse(self.c.get('/api/logs',environ_overrides=PEER).json['logs'][0]['video'])
 def test_list_video_uses_ts_not_metadata_or_mp4(self):
  m=self.upload([('rlog.zst',b'log'),('qcamera.ts',b'video')]).json['logs'][0];p=server.ROOT/m['id']
  for status in ('queued','processing','ready','error'):
   m.update(status=status,video=False);server.save_meta(p,m)
   self.assertTrue(self.c.get('/api/logs',environ_overrides=PEER).json['logs'][0]['video'])
  (p/'qcamera.ts').unlink();(p/'prepared').mkdir();(p/'prepared/camera.mp4').write_bytes(b'mp4')
  m.update(video=True);server.save_meta(p,m)
  self.assertFalse(self.c.get('/api/logs',environ_overrides=PEER).json['logs'][0]['video'])
 def test_concurrent_video_attachment_updates_once(self):
  self.upload([('rlog.zst',b'log')])
  def send(_):
   with server.app.test_client() as client:return self.upload([('rlog.zst',b'log'),('qcamera.ts',b'video')],client).json
  with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:results=list(pool.map(send,range(2)))
  self.assertEqual(sum(len(r['updated']) for r in results),1)
  self.assertEqual(sum(len(r['duplicates']) for r in results),1);self.assertEqual(self.count(),1)
 def test_cancelled_conversion_cannot_overwrite_new_status(self):
  import threading
  from unittest.mock import patch,Mock
  m=self.upload([('rlog.zst',b'log')]).json['logs'][0];p=server.ROOT/m['id']
  started=threading.Event();stopped=threading.Event()
  proc=Mock();proc.returncode=-15;proc.poll.return_value=None
  proc.terminate.side_effect=lambda: (setattr(proc.poll,'return_value',-15),stopped.set())
  def communicate(**kwargs):
   started.set()
   if not stopped.wait(5):raise RuntimeError('conversion was not stopped')
   return '', 'terminated'
  proc.communicate.side_effect=communicate
  with patch.object(server.subprocess,'Popen',return_value=proc),patch.object(server,'submit'):
   worker=threading.Thread(target=server.run_job,args=(m['id'],));worker.start()
   self.assertTrue(started.wait(5))
   try:
    r=self.upload([('rlog.zst',b'log'),('qcamera.ts',b'video')]);self.assertEqual(r.status_code,201)
   finally:stopped.set();worker.join(5)
  self.assertFalse(worker.is_alive());self.assertEqual(server.read_meta(p)['status'],'queued')
  self.assertEqual(server.read_meta(p)['conversion_revision'],1)
 def test_chunk_upload_attaches_video(self):
  self.upload([('rlog.zst',b'log')])
  files=[('rlog.zst',b'log'),('qcamera.ts',b'video')]
  session=self.c.post('/api/uploads',json={'files':[{'name':name,'size':len(data)} for name,data in files]},headers=HEADERS,environ_overrides=PEER).json['id']
  for i,(_,payload) in enumerate(files):
   self.assertEqual(self.c.put(f'/api/uploads/{session}/files/{i}?offset=0',data=payload,headers=HEADERS,environ_overrides=PEER).status_code,200)
  r=self.c.post(f'/api/uploads/{session}/finish',headers=HEADERS,environ_overrides=PEER)
  self.assertEqual(r.status_code,201);self.assertEqual(len(r.json['updated']),1)
  self.assertFalse((server.UPLOADS/session).exists());self.assertEqual(self.count(),1)

if __name__=='__main__':
 try:unittest.main()
 finally:server.pool.shutdown()
