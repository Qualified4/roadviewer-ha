import io,os,sys,tempfile,unittest,shutil,time,threading
from pathlib import Path
from unittest.mock import patch
os.environ['RV_DATA']=tempfile.mkdtemp();os.environ['RV_INGRESS_ONLY']='1'
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'roadviewer/app'))
import server
server.submit=lambda id:None
PEER={'REMOTE_ADDR':'172.30.32.2'}
HEADERS={'X-RoadViewer-Request':'1'}
class RecoveryTests(unittest.TestCase):
 def setUp(self):
  for p in server.ROOT.iterdir():
   if p.is_dir():shutil.rmtree(p)
   else:p.unlink()
  server.UPLOADS.mkdir()
  self.c=server.app.test_client()
 def begin(self,name='rlog.zst'):
  r=self.c.post('/api/uploads',json={'files':[{'name':name,'size':3}]},headers=HEADERS,environ_overrides=PEER)
  self.assertEqual(r.status_code,201);return r.json['id']
 def put(self,id,data=b'log'):
  return self.c.put(f'/api/uploads/{id}/files/0?offset=0',data=data,headers=HEADERS,environ_overrides=PEER)
 def test_lost_response_retry_and_conflict(self):
  id=self.begin()
  self.assertEqual(self.put(id).status_code,200)
  self.assertEqual(self.put(id).json['received'],3)
  self.assertEqual((server.UPLOADS/id/'0').read_bytes(),b'log')
  self.assertEqual(self.put(id,b'bad').status_code,409)
 def test_cleanup_on_startup_preserves_registered_sources(self):
  id=self.begin();self.put(id)
  p=server.ROOT/('a'*32);p.mkdir();(p/'rlog.zst').write_bytes(b'original')
  stage=server.ROOT/'.upload-abandoned';stage.mkdir();(stage/'partial').write_bytes(b'x')
  server.cleanup_uploads(startup=True)
  self.assertFalse((server.UPLOADS/id).exists());self.assertFalse(stage.exists())
  self.assertEqual((p/'rlog.zst').read_bytes(),b'original')
 def test_expired_cleanup_before_disk_check_and_active_preserved(self):
  old=self.begin();self.put(old);active=self.begin()
  os.utime(server.UPLOADS/old,(0,0))
  original=shutil.disk_usage
  def space(path):
   self.assertFalse((server.UPLOADS/old).exists())
   return original(path)
  with patch.object(server.shutil,'disk_usage',side_effect=space):self.begin()
  self.assertTrue((server.UPLOADS/active).exists())
  os.utime(server.UPLOADS/active,(0,0))
  self.c.get('/api/logs',environ_overrides=PEER)
  self.assertFalse((server.UPLOADS/active).exists())
 def test_registration_failure_removes_complete_staging(self):
  id=self.begin('qcamera.ts');self.put(id)
  r=self.c.post(f'/api/uploads/{id}/finish',headers=HEADERS,environ_overrides=PEER)
  self.assertEqual(r.status_code,400);self.assertFalse((server.UPLOADS/id).exists())
 def test_slow_network_does_not_hold_job_lock(self):
  id=self.begin();entered=threading.Event();release=threading.Event()
  class SlowInput(io.BytesIO):
   def readinto(self,buffer):
    entered.set();release.wait(3)
    return super().readinto(buffer)
  result=[]
  def send():
   with server.app.test_client() as client:
    result.append(client.open(f'/api/uploads/{id}/files/0?offset=0',method='PUT',headers=HEADERS,environ_overrides={**PEER,'wsgi.input':SlowInput(b'log'),'CONTENT_LENGTH':'3'}).status_code)
  thread=threading.Thread(target=send);thread.start()
  try:
   self.assertTrue(entered.wait(2))
   acquired=server.lock.acquire(timeout=.2)
   if acquired:server.lock.release()
   self.assertTrue(acquired,'network read held shared job lock')
  finally:release.set();thread.join(4)
  self.assertEqual(result,[200])
 def test_manual_cleanup_preserves_recent_upload_and_registered_data(self):
  old=self.begin();self.put(old);active=self.begin()
  os.utime(server.UPLOADS/old,(0,0))
  expected=server.storage_used_bytes(server.UPLOADS/old)
  r=self.c.post('/api/storage/cleanup',headers=HEADERS,environ_overrides=PEER)
  self.assertEqual(r.status_code,200);self.assertEqual(r.json['removed_bytes'],expected)
  self.assertFalse((server.UPLOADS/old).exists());self.assertTrue((server.UPLOADS/active).exists())
 def test_timer_runs_without_http_requests(self):
  old=self.begin();self.put(old);os.utime(server.UPLOADS/old,(0,0))
  with patch.object(server.cleanup_stop,'wait',side_effect=[False,True]):server.cleanup_loop()
  self.assertFalse((server.UPLOADS/old).exists())
 def test_failure_report_is_bounded_and_protected(self):
  id=self.begin()
  self.assertEqual(self.c.post(f'/api/uploads/{id}/failure',json={},environ_overrides=PEER).status_code,403)
  with self.assertLogs(server.app.logger,level='WARNING') as logs:
   r=self.c.post(f'/api/uploads/{id}/failure',json={'stage':'chunk','errorName':'TypeError','filename':'private'},headers=HEADERS,environ_overrides=PEER)
  self.assertEqual(r.status_code,200);self.assertNotIn('private',''.join(logs.output))
if __name__=='__main__':unittest.main()
