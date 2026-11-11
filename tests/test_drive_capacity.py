"""Isolated Drive capacity admission; no OAuth, real Drive, or production data."""
import hashlib,json,os,sys,tempfile,threading,time,unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'roadviewer/app'))
os.environ.setdefault('RV_DATA',tempfile.mkdtemp(prefix='rv-capacity-import-'))
import server,media_store,archive_backends as ab

PEER={'REMOTE_ADDR':'172.30.32.2'}
HEADERS={'X-RoadViewer-Request':'1'}
SIZE=512*1024

class MemoryDrive:
    caps=SimpleNamespace(kind='gdrive')
    def __init__(self):
        self.files={};self.deleted=[];self.uploads=[];self.state='connected';self.failure=None;self.mismatch=False
        self.started=threading.Event();self.release=None;self.verified=set()
    def last_state(self):return self.state
    def last_result(self):return (self.state,None)
    def probe(self):return self.state,None
    def invalidate(self):pass
    def find(self,id,kind):return [value[0] for value in self.files.values() if value[2:]==(id,kind)]
    def upload(self,path,id,kind,sha256,md5,size,**kwargs):
        self.started.set()
        if self.release is not None and not self.release.wait(5):raise AssertionError('Test did not release the held upload')
        if self.failure:raise ab.BackendError(self.failure)
        data=path.read_bytes();ref=ab.RemoteRef('gdrive',str(len(self.files)+1),len(data),sha256,hashlib.md5(data).hexdigest())
        self.files[ref.file_id]=(ref,data,id,kind);self.uploads.append((id,kind));return ref
    def verify(self,ref,sha256,size,md5):
        if self.mismatch:return 'mismatch'
        good=hashlib.sha256(self.files[ref.file_id][1]).hexdigest()==sha256 and ref.bytes==size
        if good:self.verified.add(ref.file_id)
        return 'ok' if good else 'mismatch'
    def delete(self,ref):self.deleted.append(ref.file_id);self.files.pop(ref.file_id,None);return True
    def stat(self,ref):return self.files[ref.file_id][0]
    def open(self,ref,start=0,end=None):yield self.files[ref.file_id][1][start:None if end is None else end+1]

class DriveCapacityTests(unittest.TestCase):
    def setUp(self):
        temp=tempfile.TemporaryDirectory();self.addCleanup(temp.cleanup);self.root=Path(temp.name);(self.root/'.uploads').mkdir()
        self.settings=media_store.ArchiveSettings(enabled=True,backend='gdrive',mode='move',allow_local_delete=True,min_age_seconds=0,batch=4)
        self.backend=MemoryDrive();self.store=media_store.ArchiveStore(self.settings,self.root)
        self.policy={'max_bytes':0,'policy':'delete_oldest','pinned_logs':[]}
        for p in [patch.object(server,'ROOT',self.root),patch.object(server,'UPLOADS',self.root/'.uploads'),patch.object(server,'store',self.store),
                  patch.object(server,'backend',self.backend),patch.object(server,'cleanup_uploads'),patch.object(server,'submit'),
                  patch.object(server.storage_policy,'settings',self.policy),patch.object(server.storage_policy,'path',self.root/'.storage-settings.json'),
                  patch.object(server,'processes',{}),patch.object(server,'active_uploads',server.Counter()),
                  patch('storage_policy.shutil.disk_usage',return_value=SimpleNamespace(free=2**40))]:
            p.start();self.addCleanup(p.stop)
        self.archiver=media_store.Archiver(server,self.store,self.settings,backend=self.backend)
        p=patch.object(server,'archiver',self.archiver);p.start();self.addCleanup(p.stop)
        self.addCleanup(self.join)
    def join(self):
        if self.archiver.manual:
            if self.backend.release:self.backend.release.set()
            self.archiver.manual.join(5);self.assertFalse(self.archiver.manual.is_alive(),'archiver deadlocked')
    def log(self,ch='a',route='00000001--aaaaaaaaaa',**fields):
        p=self.root/(ch*32);p.mkdir();(p/'prepared').mkdir();(p/'prepared/data.json').write_text('{"duration":1,"frames":[]}')
        for kind in ['rlog.zst','fcamera.mp4']:(p/kind).write_bytes(kind.encode()[:1]*SIZE)
        server.save_meta(p,dict(id=p.name,name=route+'--0',uploaded=1,status='ready',files={'rlog.zst':route+'--0--rlog.zst'},video=True,**fields));return p
    def shortage(self,deficit=200000):self.policy['max_bytes']=server.storage_used_bytes()+65536+4096-deficit
    def begin(self):
        return server.app.test_client().post('/api/uploads',json={'files':[{'name':'00000009--bbbbbbbbbb--0--rlog.zst','size':4096}]},headers=HEADERS,environ_overrides=PEER)
    def wait(self):
        self.assertIsNotNone(self.archiver.manual);self.archiver.manual.join(5);self.assertFalse(self.archiver.manual.is_alive())
    def assert_intact(self,p):
        self.assertTrue((p/'meta.json').exists());self.assertTrue((p/'rlog.zst').exists());self.assertTrue((p/'fcamera.mp4').exists());self.assertEqual(self.backend.deleted,[])
    def test_soft_limit_admits_immediately_then_moves_without_deleting_record(self):
        p=self.log();self.shortage();self.backend.release=threading.Event()
        with patch.object(media_store.PendingDeletes,'add',side_effect=AssertionError('Automatic delete queue used')),patch.object(media_store.PendingDeletes,'process',side_effect=AssertionError('Automatic delete processor used')):
            first=self.begin();self.assertEqual(first.status_code,201);self.assertTrue(self.backend.started.wait(2))
            self.assertTrue((p/'fcamera.mp4').exists());self.assertGreater(server.storage_used_bytes()+server.storage_policy.reserved(),self.policy['max_bytes'])
            self.assertEqual(self.begin().status_code,201,'uploads continue while MOVE is held')
            self.backend.release.set();self.wait()
        m=server.read_meta(p);self.assertTrue((p/'prepared/data.json').exists());self.assertTrue(p.exists())
        moved=[k for k in media_store.ARCHIVE_ORDER if media_store.location(m,k)=='gdrive'];self.assertTrue(moved)
        for kind in moved:
            e=media_store.entry(m,kind);self.assertIn(e['file_id'],self.backend.verified);self.assertIn(e['file_id'],self.backend.files);self.assertFalse((p/kind).exists())
        self.assertEqual(self.backend.deleted,[])
        response=server.app.test_client().get('/api/logs',environ_overrides=PEER);self.assertEqual(response.status_code,200);row=response.json['logs'][0]
        self.assertEqual(row['id'],p.name);self.assertTrue(row['video']);self.assertTrue(row['download_options'])
        response=server.app.test_client().get(f'/api/logs/{p.name}/data',environ_overrides=PEER);self.assertEqual(response.status_code,200);response.close()
    def test_move_failure_and_disconnection_do_not_reject_safe_uploads(self):
        p=self.log();self.shortage();self.backend.failure='unavailable'
        self.assertEqual(self.begin().status_code,201);self.wait();self.assert_intact(p)
        self.backend.state='unavailable';self.assertEqual(self.begin().status_code,201);self.wait();self.assert_intact(p)
    def test_soft_limit_moves_pinned_logs_last(self):
        # 'a' is first by upload order but pinned: the unpinned 'b' goes first, 'a' only while space is still short.
        a=self.log('a');b=self.log('b',route='00000002--bbbbbbbbbb');self.policy['pinned_logs']=[a.name];self.shortage()
        self.assertEqual(self.begin().status_code,201);self.wait()
        self.assertEqual(self.backend.uploads,[(b.name,'fcamera.mp4')]);self.assert_intact(a)
        self.shortage(2*SIZE+200000)
        self.assertEqual(self.begin().status_code,201);self.wait()
        uploads=self.backend.uploads;self.assertEqual(uploads[:3],[(b.name,'fcamera.mp4'),(b.name,'rlog.zst'),(a.name,'fcamera.mp4')])
        self.assertTrue(all(id==a.name for id,_ in uploads[2:]))
        m=server.read_meta(a);self.assertEqual(media_store.location(m,'fcamera.mp4'),'gdrive');self.assertFalse((a/'fcamera.mp4').exists())
        self.assertTrue(server.storage_policy.pinned(m));self.assertEqual(self.backend.deleted,[])
    def test_minimum_age_is_not_bypassed_by_soft_limit(self):
        p=self.log();self.shortage()
        m=server.read_meta(p);m['uploaded']=time.time();server.save_meta(p,m)
        object.__setattr__(self.settings,'min_age_seconds',3600)
        self.assertEqual(self.begin().status_code,201);self.wait();self.assert_intact(p);self.assertEqual(self.backend.uploads,[])
    def test_quota_is_soft_even_when_smaller_than_upload_or_archive_is_disabled(self):
        p=self.log();self.policy.update(max_bytes=1,policy='reject_new');object.__setattr__(self.settings,'enabled',False)
        self.assertEqual(self.begin().status_code,201);self.assertIsNone(self.archiver.manual);self.assert_intact(p)
        # A configured threshold above the quota cannot turn the quota into a rejection or delay the MOVE request.
        object.__setattr__(self.settings,'enabled',True);object.__setattr__(self.settings,'local_threshold_bytes',2**40)
        self.assertEqual(self.begin().status_code,201);self.wait();self.assertTrue(self.backend.uploads);self.assertTrue(p.exists())
    def test_batch_limit_is_not_bypassed(self):
        p=self.log();self.shortage(700000);object.__setattr__(self.settings,'batch',1)
        self.assertEqual(self.begin().status_code,201);self.wait();self.assertEqual(len(self.backend.uploads),1);self.assertTrue(p.exists())
        self.assertEqual(self.begin().status_code,201);self.wait();self.assertEqual(len(self.backend.uploads),2);self.assertEqual(self.backend.deleted,[])
    def test_concurrent_uploads_reserve_real_disk_and_share_one_move(self):
        from concurrent.futures import ThreadPoolExecutor
        from storage_policy import MARGIN
        p=self.log();self.policy['max_bytes']=1;self.backend.release=threading.Event()
        baseline=server.storage_used_bytes();budget=MARGIN+2*(65536+4096)+1024
        def usage(_):return SimpleNamespace(free=budget-(server.storage_used_bytes()-baseline))
        with patch('storage_policy.shutil.disk_usage',side_effect=usage):
            self.assertEqual(self.begin().status_code,201);self.assertTrue(self.backend.started.wait(2));worker=self.archiver.manual
            with ThreadPoolExecutor(max_workers=4) as pool:responses=list(pool.map(lambda _:self.begin(),range(5)))
            self.assertEqual(sum(r.status_code==201 for r in responses),1)
            self.assertTrue(all(r.status_code in (201,507) for r in responses));self.assertEqual(len(list(server.UPLOADS.iterdir())),2)
            self.assertIs(self.archiver.manual,worker);self.assertEqual(self.archiver.run_cycle()['stopped'],'busy')
            with server.lock:self.assertTrue(p.exists())
            self.assertGreaterEqual(usage(None).free-server.storage_policy.reserved(),MARGIN)
            self.backend.release.set();self.wait()
        self.assertEqual(self.backend.deleted,[])
    def test_commit_excludes_own_reservation_but_preserves_other_uploads(self):
        from storage_policy import MARGIN
        object.__setattr__(self.settings,'enabled',False)
        own=self.begin().json['id'];other=self.begin().json['id']
        with server.registration_lock,server.lock:
            with patch('storage_policy.shutil.disk_usage',return_value=SimpleNamespace(free=MARGIN+65536+1024)):
                with self.assertRaises(server.StorageError):server.storage_policy.admit(0,[],commit=True,reservation_id=own)
                server.shutil.rmtree(server.UPLOADS/other)
                self.assertEqual(server.storage_policy.admit(0,[],commit=True,reservation_id=own),65536)
    def test_multipart_staging_requires_room_for_both_copies(self):
        from storage_policy import MARGIN
        object.__setattr__(self.settings,'enabled',False)
        with server.registration_lock,server.lock,patch('storage_policy.shutil.disk_usage',return_value=SimpleNamespace(free=MARGIN+65536+SIZE)):
            self.assertEqual(server.storage_policy.admit(SIZE,[],staging=False),SIZE+65536)
            with self.assertRaises(server.StorageError):server.storage_policy.admit(SIZE,[],staging=True)
    def test_running_scheduled_cycle_takes_pressure_request_without_second_worker(self):
        p=self.log();self.shortage();entered=threading.Event();release=threading.Event()
        def scheduled(result):
            entered.set()
            if not release.wait(3):raise AssertionError('Scheduled cycle not released')
            return 'uploading'
        with patch.object(self.archiver,'_cycle',side_effect=scheduled):
            self.assertTrue(self.archiver.start_cycle());self.assertTrue(entered.wait(2));worker=self.archiver.manual
            try:
                self.assertEqual(self.begin().status_code,201);self.assertIs(self.archiver.manual,worker)
            finally:release.set();self.wait()
        self.assertTrue(self.backend.uploads);self.assertTrue(p.exists());self.assertEqual(self.backend.deleted,[])
    def test_verification_failure_and_physical_shortage_preserve_originals(self):
        from storage_policy import MARGIN
        p=self.log();self.shortage();self.backend.mismatch=True
        self.assertEqual(self.begin().status_code,201);self.wait();self.assert_intact(p)
        self.backend.state='unavailable'
        with patch('storage_policy.shutil.disk_usage',return_value=SimpleNamespace(free=MARGIN)):
            self.assertEqual(self.begin().status_code,507);self.wait()
        self.assert_intact(p)
    def test_pin_during_transfer_still_moves(self):
        p=self.log();self.shortage();self.backend.release=threading.Event();self.assertEqual(self.begin().status_code,201);self.assertTrue(self.backend.started.wait(2))
        with server.lock:self.policy['pinned_logs']=[p.name]
        self.backend.release.set();self.wait()
        m=server.read_meta(p);self.assertEqual(media_store.location(m,'fcamera.mp4'),'gdrive');self.assertFalse((p/'fcamera.mp4').exists())
        self.assertTrue(server.storage_policy.pinned(m));self.assertEqual(self.backend.deleted,[])
    def test_local_quota_auto_delete_still_keeps_pinned(self):
        # Drive COPY: the local quota deletes the oldest unpinned recording, never a pinned one.
        object.__setattr__(self.settings,'mode','copy')
        a=self.log('a');b=self.log('b',route='00000002--bbbbbbbbbb');self.policy['pinned_logs']=[a.name];self.policy['max_bytes']=server.storage_used_bytes()
        files=[{'name':'00000009--bbbbbbbbbb--0--rlog.zst','size':4096}]
        with server.registration_lock,server.lock:server.storage_policy.admit(4096,files,commit=True,staging=False)
        self.assertTrue((a/'meta.json').exists());self.assertTrue((a/'fcamera.mp4').exists());self.assertFalse(b.exists())
        # With only the pinned one left nothing is deleted: the upload is refused instead.
        self.policy['max_bytes']=server.storage_used_bytes()
        with server.registration_lock,server.lock,self.assertRaises(server.StorageError):
            server.storage_policy.admit(4096,files,commit=True,staging=False)
        self.assert_intact(a)
    def test_metadata_commit_failure_never_unlinks_local_file(self):
        p=self.log();self.shortage();original=media_store.atomic_json
        def save(path,value):
            if path.name=='meta.json':raise OSError('Simulated index failure')
            return original(path,value)
        with patch.object(media_store,'atomic_json',side_effect=save):self.assertEqual(self.begin().status_code,201);self.wait()
        self.assert_intact(p)
    def test_only_explicit_complete_delete_can_delete_drive_files(self):
        p=self.log();self.shortage();self.begin();self.wait();refs=media_store.remote_refs(server.read_meta(p),copies=True);self.assertTrue(refs)
        with server.registration_lock,server.lock:
            with self.assertRaises(server.StorageError):server.delete_recording(p.name)
        self.assertTrue(p.exists());self.assertEqual(self.backend.deleted,[])
        response=server.app.test_client().delete(f'/api/logs/{p.name}',headers=HEADERS,environ_overrides=PEER);self.assertEqual(response.status_code,200);self.assertFalse(p.exists())
        pending=media_store.PendingDeletes(self.root);self.assertEqual(pending.count(),len(refs));pending.process(self.backend)
        self.assertEqual(set(self.backend.deleted),{ref['file_id'] for ref in refs})
    def test_legacy_unattributed_pending_delete_is_preserved(self):
        pending=media_store.PendingDeletes(self.root)
        pending.add('f'*32,[],[{'kind':'rlog.zst','backend':'gdrive','file_id':'legacy','bytes':1,'sha256':None}])
        self.assertEqual(pending.process(self.backend),0);self.assertEqual(self.backend.deleted,[]);self.assertEqual(pending.count(),1)

if __name__=='__main__':unittest.main()
