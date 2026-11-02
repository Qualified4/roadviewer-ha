"""The archiver moves eligible recordings' files to the share (videos first, the log last), verified
before the local copy goes; any failure leaves the source and the index as they were."""
import hashlib,os,sys,tempfile,time,unittest
from pathlib import Path
from unittest.mock import patch
sys.path.insert(0,str(Path(__file__).resolve().parent))
from test_media_integration import make_nas,make_log  # Sets RV_DATA and imports the server module.
import server,media_store

DAY=86400
def sha(data):return hashlib.sha256(data).hexdigest()

class ArchiverTests(unittest.TestCase):
 def setUp(self):
  temp=tempfile.TemporaryDirectory();self.addCleanup(temp.cleanup);self.root=Path(temp.name)
  for patcher in (patch.object(server,'ROOT',self.root),patch.object(server,'upload_receiving',return_value=False),patch.object(server,'submit')):
   patcher.start();self.addCleanup(patcher.stop)
  self.submit=server.submit
  self.nas,self.store=make_nas(self.root)
 def archiver(self,**fields):
  settings=media_store.ArchiveSettings(**{'enabled':True,'path':self.nas,'min_age_seconds':DAY,**fields})
  return media_store.Archiver(server,self.store,settings)
 def log(self,id,kinds,uploaded=1,**fields):
  p=make_log(self.root,id,kinds,[],nas=self.nas)
  m=server.read_meta(p);m.update(uploaded=uploaded,**fields);server.save_meta(p,m)
  return p
 def locations(self,p):
  m=server.read_meta(p);return {kind:media_store.location(m,kind) for kind in media_store.MEDIA_KINDS if media_store.location(m,kind)!='local' or (p/kind).is_file()}
 def assert_untouched(self,p,kinds):
  m=server.read_meta(p)
  for kind in kinds:
   self.assertEqual((p/kind).read_bytes(),kind.encode()*10);self.assertEqual(media_store.location(m,kind),'local')
  self.assertEqual(list(self.nas.rglob('*.part')),[])

 def test_cycle_noop_when_disabled(self):
  p=self.log('a'*32,['rlog.zst','fcamera.mp4'])
  archiver=self.archiver(enabled=False)
  self.assertEqual(archiver.run_cycle(),{'archived':0,'bytes':0,'stopped':'disabled'})
  self.assert_untouched(p,['rlog.zst','fcamera.mp4']);self.assertFalse((self.nas/p.name).exists())
  with patch.object(media_store.threading,'Thread') as thread:archiver.start()
  thread.assert_not_called()
  self.assertFalse(archiver.status()['running']);self.assertIsNone(archiver.status()['last_cycle_at'])

 def test_module_import_starts_no_archiver_thread(self):
  self.assertIsInstance(server.archiver,media_store.Archiver)
  self.assertIsNone(server.archiver.thread)

 def test_cycle_waits_during_upload(self):
  p=self.log('a'*32,['rlog.zst','fcamera.mp4'])
  with patch.object(server,'upload_receiving',return_value=True):result=self.archiver().run_cycle()
  self.assertEqual(result,{'archived':0,'bytes':0,'stopped':'uploading'})
  self.assert_untouched(p,['rlog.zst','fcamera.mp4'])

 def test_cycle_waits_while_converting_or_below_threshold(self):
  p=self.log('a'*32,['rlog.zst'])
  with patch.dict(server.processes,{'b'*32:object()}):self.assertEqual(self.archiver().run_cycle()['stopped'],'processing')
  self.assertEqual(self.archiver(local_threshold_bytes=10**9).run_cycle()['stopped'],'below_threshold')
  self.assert_untouched(p,['rlog.zst'])

 def test_archive_moves_oldest_first_videos_then_rlog(self):
  new=self.log('b'*32,['rlog.zst','camera.mp4'],uploaded=2000)
  old=self.log('a'*32,['rlog.zst','fcamera.mp4','qcamera.ts'],uploaded=1000)
  young=self.log('c'*32,['rlog.zst'],uploaded=time.time())  # Not old enough.
  archiver=self.archiver(batch=4)
  order=[];real=archiver.archive_file
  def record(p,m,kind):order.append((p.name,kind));return real(p,m,kind)
  with patch.object(archiver,'archive_file',side_effect=record):result=archiver.run_cycle()
  self.assertEqual(order,[(old.name,'fcamera.mp4'),(old.name,'qcamera.ts'),(old.name,'rlog.zst'),(new.name,'camera.mp4')])
  self.assertEqual(result,{'archived':4,'bytes':len(b'fcamera.mp4'*10)+len(b'qcamera.ts'*10)+len(b'rlog.zst'*10)+len(b'camera.mp4'*10),'stopped':None})
  m=server.read_meta(old)
  for kind in ('fcamera.mp4','qcamera.ts','rlog.zst'):
   self.assertFalse((old/kind).exists())
   data=(self.nas/old.name/kind).read_bytes();self.assertEqual(data,kind.encode()*10)
   e=media_store.entry(m,kind)
   self.assertEqual((e['location'],e['bytes'],e['sha256']),('nas',len(data),sha(data)));self.assertIsInstance(e['archived_at'],float)
  self.assertEqual(self.locations(new),{'rlog.zst':'local','camera.mp4':'nas'})
  self.assert_untouched(young,['rlog.zst'])
  status=archiver.status()
  self.assertEqual((status['consecutive_failures'],status['last_error'],status['archived_files_total'],status['running']),(0,None,4,False))
  self.assertIsNotNone(status['last_cycle_at'])
  # The archived files are served from the share through the same paths.
  with patch.object(server,'store',self.store):self.assertEqual(server.media_path(old,m,'fcamera.mp4'),self.nas/old.name/'fcamera.mp4')

 def test_pinned_logs_are_archived(self):
  p=self.log('a'*32,['rlog.zst','fcamera.mp4'],pinned=True)
  self.assertEqual(self.archiver().run_cycle()['archived'],2)
  self.assertEqual(self.locations(p),{'rlog.zst':'nas','fcamera.mp4':'nas'})
  self.assertTrue(server.read_meta(p)['pinned'])

 def test_only_ready_and_idle_recordings_are_candidates(self):
  self.log('a'*32,['rlog.zst'],status='queued');self.log('b'*32,['rlog.zst'],status='error')
  busy=self.log('c'*32,['rlog.zst']);ready=self.log('d'*32,['rlog.zst'])
  archiver=self.archiver()
  with patch.dict(server.processes,{busy.name:object()}):self.assertEqual([p.name for p,_ in archiver.candidates()],[ready.name])

 def test_copy_failure_leaves_source_and_meta_intact(self):
  p=self.log('a'*32,['rlog.zst','fcamera.mp4'])
  def broken(source,target,length=0):target.write(source.read(5));raise OSError(5,'Input/output error')
  archiver=self.archiver()
  with patch.object(media_store.shutil,'copyfileobj',side_effect=broken):result=archiver.run_cycle()
  self.assertEqual(result,{'archived':0,'bytes':0,'stopped':'os_error'})
  self.assert_untouched(p,['rlog.zst','fcamera.mp4']);self.assertFalse((self.nas/p.name/'fcamera.mp4').exists())
  status=archiver.status();self.assertEqual((status['last_error'],status['consecutive_failures']),('os_error',1))
  with patch.object(media_store.shutil,'copyfileobj',side_effect=broken):archiver.run_cycle()
  self.assertEqual(archiver.status()['consecutive_failures'],2)
  # The next good cycle resets the count.
  self.assertEqual(archiver.run_cycle()['archived'],2);self.assertEqual(archiver.status()['consecutive_failures'],0)

 def test_hash_mismatch_aborts(self):
  p=self.log('a'*32,['rlog.zst','fcamera.mp4'])
  real=media_store._sha256
  def corrupt(path):return '0'*64 if path.name.endswith('.part') else real(path)
  archiver=self.archiver()
  with patch.object(media_store,'_sha256',side_effect=corrupt):result=archiver.run_cycle()
  self.assertEqual(result,{'archived':0,'bytes':0,'stopped':'hash_mismatch'})
  self.assert_untouched(p,['rlog.zst','fcamera.mp4']);self.assertFalse((self.nas/p.name/'fcamera.mp4').exists())
  self.assertEqual(archiver.status()['last_error'],'hash_mismatch')
  # A recorded hash the local file no longer matches stops the cycle as well; nothing is moved.
  m=server.read_meta(p);stat=(p/'fcamera.mp4').stat()
  m['content_hashes']={'fcamera.mp4':{'size':stat.st_size,'mtime_ns':stat.st_mtime_ns,'sha256':'1'*64}};server.save_meta(p,m)
  self.assertEqual(archiver.run_cycle()['stopped'],'hash_mismatch');self.assert_untouched(p,['rlog.zst','fcamera.mp4'])

 def test_recorded_hash_is_reused(self):
  p=self.log('a'*32,['rlog.zst']);m=server.read_meta(p);stat=(p/'rlog.zst').stat()
  m['content_hashes']={'rlog.zst':{'size':stat.st_size,'mtime_ns':stat.st_mtime_ns,'sha256':sha(b'rlog.zst'*10)}};server.save_meta(p,m)
  hashed=[];real=media_store._sha256
  def spy(path):hashed.append(path);return real(path)
  with patch.object(media_store,'_sha256',side_effect=spy):self.assertEqual(self.archiver().run_cycle()['archived'],1)
  self.assertEqual(hashed,[self.nas/p.name/'rlog.zst.part'])  # Only the copy is re-read.

 def test_stops_when_nas_full(self):
  p=self.log('a'*32,['rlog.zst','fcamera.mp4'])
  usage=media_store.shutil.disk_usage(self.nas)._replace(free=100*media_store.MB+50)
  archiver=self.archiver()
  with patch.object(media_store.shutil,'disk_usage',return_value=usage):result=archiver.run_cycle()
  self.assertEqual(result,{'archived':0,'bytes':0,'stopped':'nas_full'})
  self.assert_untouched(p,['rlog.zst','fcamera.mp4']);self.assertEqual(archiver.status()['last_error'],'nas_full')

 def test_stops_when_share_is_lost(self):
  p=self.log('a'*32,['rlog.zst','fcamera.mp4'])
  (self.nas/media_store.SENTINEL).unlink();self.store.invalidate()
  self.assertEqual(self.archiver().run_cycle()['stopped'],'storage_unavailable');self.assert_untouched(p,['rlog.zst','fcamera.mp4'])

 def test_upload_mid_cycle_ends_after_current_file(self):
  p=self.log('a'*32,['rlog.zst','fcamera.mp4'])
  with patch.object(server,'upload_receiving',side_effect=[False,True]):result=self.archiver().run_cycle()
  self.assertEqual((result['archived'],result['stopped']),(1,'uploading'))
  self.assertEqual(self.locations(p),{'fcamera.mp4':'nas','rlog.zst':'local'})

 def test_recording_changed_during_copy_is_abandoned(self):
  p=self.log('a'*32,['rlog.zst','fcamera.mp4'])
  archiver=self.archiver();real=media_store._sha256
  def reconvert(path):
   # A reconversion starts while the copy is being verified.
   with server.lock:m=server.read_meta(p);m.update(status='queued',conversion_revision=1);server.save_meta(p,m)
   return real(path)
  with patch.object(media_store,'_sha256',side_effect=reconvert):result=archiver.run_cycle()
  self.assertEqual((result['archived'],result['stopped']),(0,None))
  m=server.read_meta(p);self.assertEqual((m['status'],m.get('storage')),('queued',None))
  self.assertTrue((p/'fcamera.mp4').is_file());self.assertEqual(list((self.nas/p.name).iterdir()),[])
  self.assertEqual(archiver.status()['consecutive_failures'],0)

 def test_cycle_respects_batch(self):
  a=self.log('a'*32,['rlog.zst','fcamera.mp4','ecamera.mp4'],uploaded=1)
  b=self.log('b'*32,['rlog.zst'],uploaded=2)
  archiver=self.archiver(batch=2)
  self.assertEqual(archiver.run_cycle(),{'archived':2,'bytes':len(b'fcamera.mp4'*10)+len(b'ecamera.mp4'*10),'stopped':None})
  self.assertEqual(self.locations(a),{'fcamera.mp4':'nas','ecamera.mp4':'nas','rlog.zst':'local'});self.assertEqual(self.locations(b),{'rlog.zst':'local'})
  self.assertEqual(archiver.run_cycle()['archived'],2)
  self.assertEqual(self.locations(a)['rlog.zst'],'nas');self.assertEqual(self.locations(b),{'rlog.zst':'nas'})
  self.assertEqual(archiver.run_cycle(),{'archived':0,'bytes':0,'stopped':None})

 def test_orphan_copy_on_share_is_reused(self):
  # Crash after the rename (step 4) but before the index (step 5): the next cycle reuses the copy.
  p=self.log('a'*32,['rlog.zst']);target=self.nas/p.name/'rlog.zst';target.parent.mkdir();target.write_bytes(b'rlog.zst'*10)
  with patch.object(media_store.shutil,'copyfileobj') as copy:self.assertEqual(self.archiver().run_cycle()['archived'],1)
  copy.assert_not_called();self.assertEqual(self.locations(p),{'rlog.zst':'nas'})
  # A different file at the target is replaced by a verified copy.
  q=self.log('b'*32,['rlog.zst']);target=self.nas/q.name/'rlog.zst';target.parent.mkdir();target.write_bytes(b'x'*80)
  self.assertEqual(self.archiver().run_cycle()['archived'],1);self.assertEqual(target.read_bytes(),b'rlog.zst'*10)

 def test_recover_deletes_local_after_committed_index(self):
  p=self.log('a'*32,['rlog.zst','fcamera.mp4']);data=b'fcamera.mp4'*10
  target=self.nas/p.name/'fcamera.mp4';target.parent.mkdir();target.write_bytes(data)
  m=server.read_meta(p);media_store.set_location(m,'fcamera.mp4',location='nas',bytes=len(data),sha256=sha(data),archived_at=1.0);server.save_meta(p,m)
  # The index records a copy the share does not hold intact: the local file stays.
  q=self.log('b'*32,['fcamera.mp4']);(self.nas/q.name).mkdir();(self.nas/q.name/'fcamera.mp4').write_bytes(b'broken')
  m=server.read_meta(q);media_store.set_location(m,'fcamera.mp4',location='nas',bytes=len(data),sha256=sha(data),archived_at=1.0);server.save_meta(q,m)
  self.archiver().recover_startup()
  self.assertFalse((p/'fcamera.mp4').exists());self.assertTrue((p/'rlog.zst').is_file());self.assertEqual(target.read_bytes(),data)
  self.assertTrue((q/'fcamera.mp4').is_file())

 def test_recover_removes_part_files(self):
  p=self.log('a'*32,['rlog.zst']);(self.nas/p.name).mkdir();(self.nas/p.name/'rlog.zst.part').write_bytes(b'half')
  (self.nas/('f'*32)).mkdir();(self.nas/('f'*32)/'fcamera.mp4.part').write_bytes(b'half')  # Recording since deleted.
  # A copy whose index was never written is left for the next cycle.
  (self.nas/p.name/'fcamera.mp4').write_bytes(b'orphan')
  self.archiver().recover_startup()
  self.assertEqual(list(self.nas.rglob('*.part')),[]);self.assertTrue((self.nas/p.name/'fcamera.mp4').is_file())
  self.assert_untouched(p,['rlog.zst'])

 def test_recover_does_nothing_when_share_unavailable(self):
  p=self.log('a'*32,['rlog.zst']);(self.nas/p.name).mkdir();(self.nas/p.name/'rlog.zst.part').write_bytes(b'half')
  (self.nas/media_store.SENTINEL).unlink();self.store.invalidate()
  self.archiver().recover_startup()
  self.assertTrue((self.nas/p.name/'rlog.zst.part').is_file());self.assertTrue((p/'rlog.zst').is_file())

 def test_requeues_deferred_recordings_when_connected(self):
  error='저장소에 연결할 수 없어 변환을 미뤘습니다.'
  a=self.log('a'*32,['rlog.zst'],status='unconverted',deferred='storage',error=error,uploaded=2)
  b=self.log('b'*32,['rlog.zst'],status='unconverted',deferred='storage',error=error,uploaded=1)
  plain=self.log('c'*32,['rlog.zst'],status='unconverted')
  archiver=self.archiver()
  # Not while the share is unreachable.
  (self.nas/media_store.SENTINEL).rename(self.nas/'sentinel');self.store.invalidate()
  archiver.run_cycle();self.submit.assert_not_called()
  (self.nas/'sentinel').rename(self.nas/media_store.SENTINEL);self.store.invalidate()
  with patch.object(server,'auto_convert',True):archiver.run_cycle()
  self.assertEqual([call.args[0] for call in self.submit.call_args_list],[b.name,a.name])
  for p in (a,b):m=server.read_meta(p);self.assertEqual(m['status'],'queued');self.assertNotIn('deferred',m)
  self.assertEqual(server.read_meta(plain)['status'],'unconverted');self.assertEqual(archiver.status()['requeued_deferred'],2)
  # With automatic conversion off only a manual request is requeued.
  c=self.log('d'*32,['rlog.zst'],status='unconverted',deferred='storage');d=self.log('e'*32,['rlog.zst'],status='unconverted',deferred='storage',manual_conversion=True)
  self.submit.reset_mock()
  with patch.object(server,'auto_convert',False):archiver.run_cycle()
  self.submit.assert_called_once_with(d.name);self.assertEqual(server.read_meta(c)['status'],'unconverted')

 def test_respects_auto_excluded_on_requeue(self):
  p=self.log('a'*32,['rlog.zst'],status='unconverted',deferred='storage',auto_excluded=True)
  archiver=self.archiver()
  with patch.object(server,'auto_convert',True):archiver.run_cycle()
  self.submit.assert_not_called();m=server.read_meta(p);self.assertEqual((m['status'],m['deferred']),('unconverted','storage'))
  self.assertEqual(archiver.status()['requeued_deferred'],0)

 def test_loop_waits_on_cleanup_stop(self):
  archiver=self.archiver(interval_seconds=60)
  stop=server.threading.Event();stop.set()
  with patch.object(server,'cleanup_stop',stop),patch.object(archiver,'run_cycle') as cycle,patch.object(archiver,'recover_startup') as recover:
   archiver.start();archiver.thread.join(5)
  self.assertFalse(archiver.thread.is_alive());recover.assert_called_once_with();cycle.assert_not_called()

if __name__=='__main__':unittest.main()
