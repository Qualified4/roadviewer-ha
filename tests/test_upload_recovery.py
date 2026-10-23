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
 def test_chunk_write_and_hash_run_outside_the_job_lock(self):
  # A slow disk write must not stall the other files, the web UI or conversion progress.
  id=self.begin();seen=[];real=server.hashlib.sha256
  class Probe:
   def __init__(self,inner):self.inner=inner
   def update(self,data):
    # RLock: re-entry by this thread would always succeed, so try from another thread.
    other=[];t=threading.Thread(target=lambda:other.append(server.lock.acquire(timeout=.5) and (server.lock.release() or True)));t.start();t.join()
    seen.append(other[0]);self.inner.update(data)
   def copy(self):return Probe(self.inner.copy())
   def hexdigest(self):return self.inner.hexdigest()
  with patch.object(server.hashlib,'sha256',lambda *a:Probe(real(*a))):
   self.assertEqual(self.put(id).status_code,200)
  self.assertEqual(seen,[True],'another thread can take the job lock while the chunk is hashed')
  self.assertEqual(server.received_digest(id,0,server.UPLOADS/id/'0'),real(b'log').hexdigest())
 def test_library_scan_does_not_block_chunks_or_progress(self):
  id=self.begin();self.put(id)
  registered=self.c.post(f'/api/uploads/{id}/finish',headers=HEADERS,environ_overrides=PEER).json['logs'][0]['id']
  entered=threading.Event();release=threading.Event();result=[];real=server.storage_used_bytes
  def slow_scan(root=None):
   if root==server.ROOT/registered/'prepared':
    entered.set();release.wait(3)
   return real(root)
  def listing():
   with server.app.test_client() as client:result.append(client.get('/api/logs',environ_overrides=PEER).status_code)
  with patch.object(server,'storage_used_bytes',side_effect=slow_scan):
   thread=threading.Thread(target=listing);thread.start()
   try:
    self.assertTrue(entered.wait(2))
    acquired=server.lock.acquire(timeout=.2)
    if acquired:server.lock.release()
    self.assertTrue(acquired,'library disk scan held the shared upload lock')
    other=self.begin();self.assertEqual(self.put(other).status_code,200)
    self.assertEqual(self.c.get('/api/progress',environ_overrides=PEER).status_code,200)
   finally:release.set();thread.join(4)
  self.assertEqual(result,[200])
 def test_library_tolerates_recording_deleted_during_snapshot(self):
  id=self.begin();self.put(id)
  registered=self.c.post(f'/api/uploads/{id}/finish',headers=HEADERS,environ_overrides=PEER).json['logs'][0]['id']
  real=server.read_meta
  def deleted(path):
   if path.name==registered:
    shutil.rmtree(path)
   return real(path)
  with patch.object(server,'read_meta',side_effect=deleted):
   response=self.c.get('/api/logs',environ_overrides=PEER)
  self.assertEqual(response.status_code,200);self.assertEqual(response.json['logs'],[])
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
   cleaned=self.c.post('/api/storage/cleanup',headers=HEADERS,environ_overrides=PEER)
   self.assertGreater(cleaned.json['removed_bytes'],0)
   self.assertFalse((server.UPLOADS/id).exists(),'stalled chunk was not cleaned')
  finally:release.set();thread.join(4)
  self.assertEqual(result,[410])
 def test_manual_cleanup_removes_recent_upload_but_preserves_registered_data(self):
  old=self.begin();self.put(old);recent=self.begin()
  p=server.ROOT/('a'*32);p.mkdir();(p/'rlog.zst').write_bytes(b'original')
  expected=server.storage_used_bytes(server.UPLOADS)
  r=self.c.post('/api/storage/cleanup',headers=HEADERS,environ_overrides=PEER)
  self.assertEqual(r.status_code,200);self.assertEqual(r.json['removed_bytes'],expected)
  self.assertFalse((server.UPLOADS/old).exists());self.assertFalse((server.UPLOADS/recent).exists())
  self.assertEqual((p/'rlog.zst').read_bytes(),b'original')
 def test_finish_copy_does_not_block_other_uploads(self):
  id=self.begin();self.put(id);entered=threading.Event();release=threading.Event();result=[]
  def slow_registration(files):
   entered.set();release.wait(3)
   return server.jsonify(logs=[],duplicates=[],updated=[]),201
  def finish():
   with server.app.test_client() as client:
    result.append(client.post(f'/api/uploads/{id}/finish',headers=HEADERS,environ_overrides=PEER).status_code)
  with patch.object(server,'register_files',side_effect=slow_registration):
   thread=threading.Thread(target=finish);thread.start()
   try:
    self.assertTrue(entered.wait(2))
    self.begin()
    self.c.post('/api/storage/cleanup',headers=HEADERS,environ_overrides=PEER)
    self.assertTrue((server.UPLOADS/id).exists(),'active finish was deleted')
   finally:release.set();thread.join(4)
  self.assertEqual(result,[201]);self.assertFalse((server.UPLOADS/id).exists())
 def test_existing_hash_does_not_block_other_uploads(self):
  old=server.ROOT/('c'*32);old.mkdir();source=old/'rlog.zst';source.write_bytes(b'old')
  server.save_meta(old,dict(id=old.name,name='old',uploaded=0,status='unconverted'))
  id=self.begin();self.put(id);entered=threading.Event();release=threading.Event();result=[]
  digest=server.file_digest
  def slow_digest(path):
   if path==source:entered.set();release.wait(3)
   return digest(path)
  def finish():
   with server.app.test_client() as client:
    result.append(client.post(f'/api/uploads/{id}/finish',headers=HEADERS,environ_overrides=PEER).status_code)
  with patch.object(server,'file_digest',side_effect=slow_digest):
   thread=threading.Thread(target=finish);thread.start()
   try:
    self.assertTrue(entered.wait(2))
    self.begin()
   finally:release.set();thread.join(4)
  self.assertEqual(result,[201])
 def test_finish_moves_received_file_and_hashes_it_once(self):
  id=self.begin();self.assertEqual(self.put(id).status_code,200)
  inode=(server.UPLOADS/id/'0').stat().st_ino;digests=[]
  real=server.file_digest
  with patch.object(server,'file_digest',side_effect=lambda path:digests.append(path) or real(path)):
   r=self.c.post(f'/api/uploads/{id}/finish',headers=HEADERS,environ_overrides=PEER)
  self.assertEqual(r.status_code,201);registered=server.ROOT/r.json['logs'][0]['id']/'rlog.zst'
  self.assertEqual(registered.read_bytes(),b'log')
  self.assertEqual(registered.stat().st_ino,inode,'the received file is moved, not copied')
  self.assertEqual(len(digests),0,'received bytes already supplied the checksum and duplicate digest')
  self.assertEqual(server.read_meta(registered.parent)['content_hashes']['rlog.zst']['sha256'],real(registered))
 def test_original_download_requires_registered_file(self):
  id='b'*32;p=server.ROOT/id;p.mkdir()
  (p/'meta.json').write_text('{"id":"'+id+'","files":{"rlog.zst":"route--0--rlog.zst"}}')
  (p/'rlog.zst').write_bytes(b'original')
  r=self.c.get(f'/api/logs/{id}/original/rlog.zst',environ_overrides=PEER)
  self.assertEqual(r.status_code,200);self.assertEqual(r.data,b'original')
  self.assertIn('attachment',r.headers['Content-Disposition']);r.close()
  self.assertEqual(self.c.get(f'/api/logs/{id}/original/qcamera.ts',environ_overrides=PEER).status_code,404)
  self.assertEqual(self.c.get(f'/api/logs/{id}/original/meta.json',environ_overrides=PEER).status_code,404)
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
