"""The archiver moves eligible recordings' files to the share (videos first, the log last), verified
before the local copy goes; any failure leaves the source and the index as they were."""
import hashlib,os,shutil,sys,tempfile,threading,time,unittest
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
 def log(self,id,kinds,uploaded=1,nas_kinds=(),**fields):
  p=make_log(self.root,id,kinds,list(nas_kinds),nas=self.nas)
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
  archiver=self.archiver(nas_margin_bytes=0)  # The copy's own space check, not the cleanup margin.
  with patch.object(media_store.shutil,'disk_usage',return_value=usage):result=archiver.run_cycle()
  self.assertEqual(result,{'archived':0,'bytes':0,'stopped':'nas_full'})
  self.assert_untouched(p,['rlog.zst','fcamera.mp4']);self.assertEqual(archiver.status()['last_error'],'nas_full')

 def test_stops_when_share_is_lost(self):
  p=self.log('a'*32,['rlog.zst','fcamera.mp4'])
  (self.nas/media_store.SENTINEL).unlink();self.store.invalidate()
  archiver=self.archiver()
  self.assertEqual(archiver.run_cycle()['stopped'],'storage_unavailable');self.assert_untouched(p,['rlog.zst','fcamera.mp4'])
  status=archiver.status();self.assertEqual((status['last_error'],status['consecutive_failures']),('storage_unavailable',1))

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
  archiver=self.archiver();archiver.recover_startup()
  self.assertFalse((p/'fcamera.mp4').exists());self.assertTrue((p/'rlog.zst').is_file());self.assertEqual(target.read_bytes(),data)
  self.assertEqual(media_store.location(server.read_meta(p),'fcamera.mp4'),'nas');self.assertTrue(archiver.recovered)

 def index_on_nas(self,p,kind,sha256):
  m=server.read_meta(p);media_store.set_location(m,kind,location='nas',bytes=len(kind.encode()*10),sha256=sha256,archived_at=1.0);server.save_meta(p,m)

 def test_recover_restores_local_when_share_copy_differs(self):
  # The share holds wrong bytes but the local file is the indexed content: the index goes back to local.
  p=self.log('a'*32,['rlog.zst','fcamera.mp4']);self.index_on_nas(p,'fcamera.mp4',sha(b'fcamera.mp4'*10))
  (self.nas/p.name).mkdir();(self.nas/p.name/'fcamera.mp4').write_bytes(b'broken')
  self.archiver().recover_startup()
  self.assert_untouched(p,['rlog.zst','fcamera.mp4']);self.assertNotIn('storage',server.read_meta(p))
  self.assertEqual((self.nas/p.name/'fcamera.mp4').read_bytes(),b'broken')  # Replaced by the next cycle.
  self.assertEqual(self.archiver().run_cycle()['archived'],2);self.assertEqual((self.nas/p.name/'fcamera.mp4').read_bytes(),b'fcamera.mp4'*10)

 def test_recover_restores_local_when_share_copy_missing(self):
  p=self.log('a'*32,['rlog.zst','fcamera.mp4']);self.index_on_nas(p,'fcamera.mp4',sha(b'fcamera.mp4'*10))
  # Known by its recorded content hash even when the index hash differs.
  self.index_on_nas(p,'rlog.zst','2'*64);m=server.read_meta(p);stat=(p/'rlog.zst').stat()
  m['content_hashes']={'rlog.zst':{'size':stat.st_size,'mtime_ns':stat.st_mtime_ns,'sha256':sha(b'rlog.zst'*10)}};server.save_meta(p,m)
  self.archiver().recover_startup()
  self.assert_untouched(p,['rlog.zst','fcamera.mp4']);self.assertNotIn('storage',server.read_meta(p))

 def test_recover_marks_corrupt_when_nothing_matches(self):
  p=self.log('a'*32,['rlog.zst','fcamera.mp4']);self.index_on_nas(p,'fcamera.mp4',sha(b'other'))
  (self.nas/p.name).mkdir();(self.nas/p.name/'fcamera.mp4').write_bytes(b'broken')
  self.archiver().recover_startup()
  m=server.read_meta(p);e=media_store.entry(m,'fcamera.mp4')
  self.assertEqual((e['location'],e['error']),('nas','recovery_mismatch'));self.assertTrue((p/'fcamera.mp4').is_file())
  self.assertEqual(media_store.resolve(p,m,'fcamera.mp4',self.store)[1],'corrupt')
  self.archiver().recover_startup();self.assertEqual(server.read_meta(p),m)  # Not checked again.

 def test_recovery_runs_at_first_connected_cycle(self):
  p=self.log('a'*32,['rlog.zst'],status='queued');(self.nas/p.name).mkdir();(self.nas/p.name/'rlog.zst.part').write_bytes(b'half')
  (self.nas/media_store.SENTINEL).rename(self.nas/'sentinel');self.store.invalidate()
  archiver=self.archiver();archiver.recover_startup();self.assertFalse(archiver.recovered)
  self.assertTrue((self.nas/p.name/'rlog.zst.part').is_file())
  (self.nas/'sentinel').rename(self.nas/media_store.SENTINEL);self.store.invalidate()
  archiver.run_cycle()
  self.assertTrue(archiver.recovered);self.assertFalse((self.nas/p.name/'rlog.zst.part').exists())

 def test_failed_local_unlink_is_finished_by_next_cycle(self):
  p=self.log('a'*32,['rlog.zst']);local=p/'rlog.zst';real=Path.unlink
  def flaky(path,*args,**kw):
   if path==local:raise PermissionError(13,'busy')
   return real(path,*args,**kw)
  archiver=self.archiver()
  with patch.object(media_store.Path,'unlink',flaky):self.assertEqual(archiver.run_cycle()['archived'],1)
  self.assertTrue(local.is_file());self.assertEqual(media_store.location(server.read_meta(p),'rlog.zst'),'nas');self.assertFalse(archiver.recovered)
  archiver.run_cycle()
  self.assertFalse(local.exists());self.assertTrue(archiver.recovered);self.assertEqual((self.nas/p.name/'rlog.zst').read_bytes(),b'rlog.zst'*10)

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
  for p in (a,b):m=server.read_meta(p);self.assertEqual((m['status'],m['error']),('queued',None));self.assertNotIn('deferred',m)
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

 def share_usage(self,calls=None):
  # The share's used bytes from its files (the sentinel aside); free space is ample unless a test says otherwise.
  def usage():
   if calls is not None:calls.append(1)
   return sum(f.stat().st_size for f in self.nas.rglob('*') if f.is_file() and f.name!=media_store.SENTINEL),10**12
  return patch.object(self.store,'usage',side_effect=usage)
 def nas_size(self,kind):return len(kind.encode()*20)

 def test_cleanup_removes_videos_before_rlog(self):
  old=self.log('a'*32,[],uploaded=1,nas_kinds=['fcamera.mp4','rlog.zst'])
  new=self.log('b'*32,[],uploaded=2,nas_kinds=['fcamera.mp4','rlog.zst'])
  total=2*(self.nas_size('fcamera.mp4')+self.nas_size('rlog.zst'))
  # Both videos must go; the logs stay.
  archiver=self.archiver(nas_max_bytes=total-self.nas_size('fcamera.mp4')-1);calls=[]
  with self.share_usage(calls):self.assertEqual(archiver.cleanup_nas(),2)
  self.assertEqual(len(calls),2)  # Measured once before and once after, not after every file.
  self.assertEqual(self.locations(old),{'fcamera.mp4':'removed','rlog.zst':'nas'});self.assertEqual(self.locations(new),{'fcamera.mp4':'removed','rlog.zst':'nas'})
  self.assertEqual(archiver.status()['cleanup_last_reason'],'nas_max');self.assertEqual(archiver.status()['removed_files_total'],2)
  # Still over without videos: the oldest log goes, the newer one stays.
  archiver=self.archiver(nas_max_bytes=2*self.nas_size('rlog.zst')-1)
  with self.share_usage():self.assertEqual(archiver.cleanup_nas(),1)
  self.assertEqual(self.locations(old),{'fcamera.mp4':'removed','rlog.zst':'removed'});self.assertEqual(self.locations(new)['rlog.zst'],'nas')
  self.assertFalse((self.nas/old.name/'rlog.zst').exists());self.assertTrue((self.nas/new.name/'rlog.zst').is_file())
  # Below the limit nothing is removed.
  archiver=self.archiver(nas_max_bytes=10**9)
  with self.share_usage():self.assertEqual(archiver.cleanup_nas(),0)
  self.assertIsNone(archiver.status()['cleanup_last_reason'])

 def test_cleanup_triggers_on_free_margin(self):
  p=self.log('a'*32,[],nas_kinds=['fcamera.mp4','rlog.zst'])
  archiver=self.archiver(nas_margin_bytes=1000)
  with patch.object(self.store,'usage',side_effect=[(400,1000-self.nas_size('fcamera.mp4')),(200,1000)]):self.assertEqual(archiver.cleanup_nas(),1)
  self.assertEqual(self.locations(p),{'fcamera.mp4':'removed','rlog.zst':'nas'});self.assertEqual(archiver.status()['cleanup_last_reason'],'nas_margin')

 def test_cleanup_never_touches_pinned(self):
  pinned=self.log('a'*32,['qcamera.ts'],uploaded=1,nas_kinds=['fcamera.mp4','rlog.zst'])
  other=self.log('b'*32,[],uploaded=2,nas_kinds=['fcamera.mp4','rlog.zst'])
  archiver=self.archiver(nas_max_bytes=1)
  with self.share_usage(),patch.object(server.storage_policy,'pinned',lambda m:m['id']==pinned.name):
   self.assertEqual(archiver.cleanup_nas(),2)
  self.assertEqual(self.locations(pinned),{'fcamera.mp4':'nas','rlog.zst':'nas','qcamera.ts':'local'})
  self.assertTrue((self.nas/pinned.name/'fcamera.mp4').is_file());self.assertTrue((self.nas/pinned.name/'rlog.zst').is_file())
  self.assertEqual(self.locations(other),{'fcamera.mp4':'removed','rlog.zst':'removed'})
  self.assertEqual(archiver.cleanup_error,'nas_full_no_candidates')

 def test_cleanup_marks_removed_and_keeps_meta_prepared(self):
  p=self.log('a'*32,['qcamera.ts'],uploaded=1,nas_kinds=['fcamera.mp4'])
  gone=self.log('b'*32,[],uploaded=2,nas_kinds=['ecamera.mp4']);(self.nas/gone.name/'ecamera.mp4').unlink()  # Already missing: still recorded.
  (p/'prepared'/'data.json').write_text('{}')
  archiver=self.archiver(nas_max_bytes=1)
  with patch.object(self.store,'usage',return_value=(500,10**12)):self.assertEqual(archiver.cleanup_nas(),2)
  m=server.read_meta(p);e=media_store.entry(m,'fcamera.mp4')
  self.assertEqual((e['location'],e['reason']),('removed','nas_full'));self.assertIsInstance(e['removed_at'],float);self.assertNotIn('sha256',e)
  self.assertEqual(media_store.entry(server.read_meta(gone),'ecamera.mp4')['location'],'removed')
  self.assertFalse((self.nas/p.name/'fcamera.mp4').exists())
  self.assertTrue((p/'meta.json').is_file());self.assertEqual((p/'prepared'/'data.json').read_text(),'{}')
  self.assertEqual((p/'qcamera.ts').read_bytes(),b'qcamera.ts'*10)  # Local files are never touched.
  self.assertEqual(media_store.resolve(p,m,'fcamera.mp4',self.store),(None,'missing'))

 def test_restart_after_cleanup_keeps_replay_data(self):
  # Cleanup removes the archived videos, then the log; a restart must not see a stale result and wipe prepared/.
  p=self.log('a'*32,['rlog.zst','fcamera.mp4'],decoder_version='v28-runtime-geometry',video=True)
  (p/'prepared'/'data.json').write_text('{}');(p/'prepared'/'telemetry.json').write_text('{}')
  def restart(label):
   self.store.state()  # A recent "connected" result: the archived recording is not held back.
   with patch.object(server,'store',self.store),patch.object(server,'auto_convert',True):server.requeue_startup()
   m=server.read_meta(p);self.assertEqual(m['status'],'ready',label);self.submit.assert_not_called()
   self.assertEqual(sorted(f.name for f in (p/'prepared').iterdir()),['data.json','telemetry.json'],label)
   return m
  self.assertEqual(self.archiver(min_age_seconds=0).run_cycle()['archived'],2)
  log=len(b'rlog.zst'*10)
  with self.share_usage():self.assertEqual(self.archiver(nas_max_bytes=log).cleanup_nas(),1)
  m=server.read_meta(p);self.assertEqual(self.locations(p),{'fcamera.mp4':'removed','rlog.zst':'nas'})
  self.assertIs(m['video'],False)  # Committed with the removal.
  restart('videos removed')
  # An index written before the flag was kept in step: the removal alone does not make the result stale.
  m['video']=True;server.save_meta(p,m);restart('legacy video flag')
  # The log removed too: nothing could reconvert it, so even an outdated result stays.
  with self.share_usage():self.assertEqual(self.archiver(nas_max_bytes=1).cleanup_nas(),1)
  m=server.read_meta(p);m['decoder_version']='old';server.save_meta(p,m)
  self.assertEqual(restart('log removed')['decoder_version'],'old')

 def test_cleanup_stops_on_oserror_without_marking_removed(self):
  a=self.log('a'*32,[],uploaded=1,nas_kinds=['fcamera.mp4']);b=self.log('b'*32,[],uploaded=2,nas_kinds=['fcamera.mp4'])
  target=self.nas/a.name/'fcamera.mp4';real=Path.unlink
  def broken(path,*args,**kw):
   if path==target:raise OSError(5,'Input/output error')
   return real(path,*args,**kw)
  archiver=self.archiver(nas_max_bytes=1)
  with self.share_usage(),patch.object(media_store.Path,'unlink',broken):result=archiver.run_cycle()
  self.assertEqual(result,{'archived':0,'bytes':0,'stopped':'os_error'})
  self.assertEqual(self.locations(a),{'fcamera.mp4':'nas'});self.assertTrue(target.is_file())
  self.assertEqual(self.locations(b),{'fcamera.mp4':'nas'})  # Cleanup stops for this cycle.
  status=archiver.status();self.assertEqual((status['last_error'],status['consecutive_failures'],status['removed_files_total']),('os_error',1,0))

 def test_cleanup_missing_file_on_lost_share_is_not_recorded(self):
  p=self.log('a'*32,[],nas_kinds=['fcamera.mp4']);target=self.nas/p.name/'fcamera.mp4';real=Path.unlink
  def unmounted(path,*args,**kw):
   if path==target:(self.nas/media_store.SENTINEL).rename(self.nas/'sentinel');raise FileNotFoundError(2,'No such file')
   return real(path,*args,**kw)
  archiver=self.archiver(nas_max_bytes=1)
  with self.share_usage(),patch.object(media_store.Path,'unlink',unmounted):self.assertEqual(archiver.cleanup_nas(),0)
  self.assertEqual(archiver.cleanup_error,'storage_unavailable');self.assertEqual(self.locations(p),{'fcamera.mp4':'nas'})

 def test_cleanup_no_candidates_sets_error_and_skips_archiving(self):
  p=self.log('a'*32,['rlog.zst','fcamera.mp4'])
  archiver=self.archiver(nas_max_bytes=10)
  with patch.object(self.store,'usage',return_value=(100,10**12)):result=archiver.run_cycle()
  self.assertEqual(result,{'archived':0,'bytes':0,'stopped':'nas_full_no_candidates'})
  self.assert_untouched(p,['rlog.zst','fcamera.mp4'])
  status=archiver.status();self.assertEqual((status['last_error'],status['consecutive_failures']),('nas_full_no_candidates',1))

 def test_cleanup_skips_entry_changed_meanwhile(self):
  p=self.log('a'*32,[],nas_kinds=['fcamera.mp4']);target=self.nas/p.name/'fcamera.mp4';real=Path.unlink
  def rearchive(path,*args,**kw):
   result=real(path,*args,**kw)
   if path==target:
    # A new copy of the kind is indexed while the old one is being removed.
    with server.lock:m=server.read_meta(p);m['storage']['fcamera.mp4']['sha256']='1'*64;server.save_meta(p,m)
   return result
  archiver=self.archiver(nas_max_bytes=1)
  with self.share_usage(),patch.object(media_store.Path,'unlink',rearchive):self.assertEqual(archiver.cleanup_nas(),0)
  e=media_store.entry(server.read_meta(p),'fcamera.mp4');self.assertEqual((e['location'],e['sha256']),('nas','1'*64))

 def test_cleanup_measures_unindexed_size_and_remeasures_before_logs(self):
  # The estimate after each removal never overstates what was freed, and the share is measured
  # again before any original log (irreplaceable) is considered.
  for index_bytes in (0,1):
   with self.subTest(index_bytes=index_bytes):
    for id in ('a'*32,'b'*32):shutil.rmtree(self.root/id,ignore_errors=True);shutil.rmtree(self.nas/id,ignore_errors=True)
    old=self.log('a'*32,[],uploaded=1,nas_kinds=['fcamera.mp4','rlog.zst']);new=self.log('b'*32,[],uploaded=2,nas_kinds=['fcamera.mp4','rlog.zst'])
    for p in (old,new):m=server.read_meta(p);m['storage']['fcamera.mp4']['bytes']=index_bytes;server.save_meta(p,m)
    total=2*(self.nas_size('fcamera.mp4')+self.nas_size('rlog.zst'))
    archiver=self.archiver(nas_max_bytes=total-self.nas_size('fcamera.mp4'))
    with self.share_usage():removed=archiver.cleanup_nas()
    # Unknown size: the file is measured, so one video suffices. Understated size: both videos go, never a log.
    self.assertEqual(removed,1 if index_bytes==0 else 2)
    self.assertEqual(self.locations(old),{'fcamera.mp4':'removed','rlog.zst':'nas'})
    self.assertEqual(self.locations(new),{'fcamera.mp4':'nas' if index_bytes==0 else 'removed','rlog.zst':'nas'})
    self.assertIsNone(archiver.cleanup_error)

 def test_cleanup_usage_error_is_counted(self):
  # Reachable share whose usage cannot be read: a counted failure, not a silent skip.
  p=self.log('a'*32,['rlog.zst','fcamera.mp4'])
  archiver=self.archiver(nas_max_bytes=1)
  with patch.object(self.store,'usage',return_value=(0,0)):
   self.assertEqual(archiver.cleanup_nas(),0);self.assertEqual(archiver.cleanup_error,'os_error')
   result=archiver.run_cycle()
  self.assertEqual(result,{'archived':0,'bytes':0,'stopped':'os_error'})
  status=archiver.status();self.assertEqual((status['last_error'],status['consecutive_failures']),('os_error',1))
  self.assert_untouched(p,['rlog.zst','fcamera.mp4'])
  # An empty but readable share is not an error.
  with patch.object(self.store,'usage',return_value=(0,10**12)):self.assertEqual(archiver.cleanup_nas(),0)
  self.assertIsNone(archiver.cleanup_error)

 def test_cleanup_does_no_nas_io_under_server_lock(self):
  p=self.log('a'*32,[],nas_kinds=['fcamera.mp4']);target=self.nas/p.name/'fcamera.mp4';real=Path.unlink
  started,release=threading.Event(),threading.Event()
  def slow(path,*args,**kw):
   if path==target:started.set();release.wait(5)
   return real(path,*args,**kw)
  archiver=self.archiver(nas_max_bytes=1);result=[]
  with self.share_usage(),patch.object(media_store.Path,'unlink',slow):
   worker=threading.Thread(target=lambda:result.append(archiver.cleanup_nas()));worker.start()
   try:
    self.assertTrue(started.wait(5))
    acquired=[]
    def take():
     if server.lock.acquire(timeout=1):acquired.append(1);server.lock.release()
    other=threading.Thread(target=take);other.start();other.join(2)
    self.assertEqual(acquired,[1])
   finally:release.set();worker.join(5)
  self.assertEqual(result,[1]);self.assertEqual(self.locations(p),{'fcamera.mp4':'removed'})

 def test_cleanup_noop_when_disabled(self):
  p=self.log('a'*32,[],nas_kinds=['fcamera.mp4'])
  with patch.object(self.store,'usage',return_value=(100,0)):self.assertEqual(self.archiver(enabled=False,nas_max_bytes=1).cleanup_nas(),0)
  self.assertEqual(self.locations(p),{'fcamera.mp4':'nas'});self.assertTrue((self.nas/p.name/'fcamera.mp4').is_file())

 def test_cycle_processes_pending_deletes_first(self):
  self.log('a'*32,['rlog.zst']);archiver=self.archiver();order=[]
  def step(name,value):
   def run(*args,**kw):order.append(name);return value
   return run
  with patch.object(media_store.PendingDeletes,'process',step('pending',0)),patch.object(archiver,'cleanup_nas',side_effect=step('cleanup',0)),\
       patch.object(archiver,'requeue_deferred',side_effect=step('requeue',0)),patch.object(archiver,'_archive',side_effect=step('archive',None)):
   archiver.run_cycle()
  self.assertEqual(order,['pending','cleanup','requeue','archive'])

 def test_loop_waits_on_cleanup_stop(self):
  archiver=self.archiver(interval_seconds=60)
  stop=server.threading.Event();stop.set()
  with patch.object(server,'cleanup_stop',stop),patch.object(archiver,'run_cycle') as cycle,patch.object(archiver,'recover_startup') as recover:
   archiver.start();archiver.thread.join(5)
  self.assertFalse(archiver.thread.is_alive());recover.assert_called_once_with();cycle.assert_not_called()

 def test_loop_activates_before_recovery(self):
  # Activation moved from import to the archiver thread: first the share is checked (and logged), then recovery.
  archiver=self.archiver(interval_seconds=60);order=[]
  stop=server.threading.Event();stop.set()
  with patch.object(server,'cleanup_stop',stop),patch.object(self.store,'activate',side_effect=lambda:order.append('activate')),       patch.object(archiver,'recover_startup',side_effect=lambda:order.append('recover')),patch.object(self.store,'available',return_value=False),       patch.object(self.store,'reason',return_value='sentinel_missing'),patch.object(server.app.logger,'warning') as warning:
   archiver.start();archiver.thread.join(5)
  self.assertEqual(order,['activate','recover'])
  warning.assert_called_once_with('Video archive is not connected: %s','sentinel_missing')
  # A failing activation is logged and recovery still runs.
  archiver=self.archiver(interval_seconds=60);order.clear()
  with patch.object(server,'cleanup_stop',stop),patch.object(self.store,'activate',side_effect=OSError('hung')),       patch.object(archiver,'recover_startup',side_effect=lambda:order.append('recover')),patch.object(server.app.logger,'exception') as logged:
   archiver.start();archiver.thread.join(5)
  self.assertEqual(order,['recover']);logged.assert_called_once_with('Archive activation failed')

if __name__=='__main__':unittest.main()
