"""Abrupt termination at every step of moving a file to the share (copy, fsync, re-read hash, rename, index
commit, local unlink), of NAS cleanup (unlink, index commit) and of deleting a recording with archived files.
After each, a restarted archiver (recover_startup, then one cycle) must leave exactly one verified copy, an index
that agrees with where the bytes are, no partial copy, and a local file that went only once the index said nas."""
import hashlib,os,shutil,sys,tempfile,unittest
from pathlib import Path
from unittest.mock import patch
sys.path.insert(0,str(Path(__file__).resolve().parent))
from test_media_integration import make_nas,make_log  # Sets RV_DATA and imports the server module.
import server,media_store

class Crash(BaseException):
 """The process stops here: nothing below the raise runs, no except OSError catches it."""

def sha(data):return hashlib.sha256(data).hexdigest()
KINDS=('fcamera.mp4','rlog.zst')  # Archived in this order (videos first).
DATA={kind:kind.encode()*10 for kind in KINDS}

def fd_path(fd):
 try:return os.readlink(f'/proc/self/fd/{fd}')
 except OSError:return ''

def crashing(target,attr,when,match,partial=None):
 # Wraps target.attr: the first call whose arguments match crashes before or after the real call.
 real=getattr(target,attr);state={'done':False}
 def wrapper(*args,**kw):
  hit=not state['done'] and match(*args,**kw)
  if hit:state['done']=True
  if hit and when=='before':
   if partial:partial(*args,**kw)
   raise Crash(attr)
  result=real(*args,**kw)
  if hit:raise Crash(attr)
  return result
 return patch.object(target,attr,wrapper),state

class ArchiverCrashTests(unittest.TestCase):
 def setUp(self):
  temp=tempfile.TemporaryDirectory();self.addCleanup(temp.cleanup);self.root=Path(temp.name)
  self.nas,self.store=make_nas(self.root)
  for patcher in (patch.object(server,'ROOT',self.root),patch.object(server,'store',self.store),
                  patch.object(server,'upload_receiving',return_value=False),patch.object(server,'submit')):
   patcher.start();self.addCleanup(patcher.stop)
 def archiver(self,**fields):
  return media_store.Archiver(server,self.store,media_store.ArchiveSettings(**{'enabled':True,'path':self.nas,**fields}))
 def recording(self,id='a'*32):
  # Converted, old enough, nothing stale: only the archiver acts on it.
  p=make_log(self.root,id,list(KINDS),[])
  (p/'prepared'/'data.json').write_text('{}')
  m=server.read_meta(p);m.update(decoder_version='v28-runtime-geometry',video=True);server.save_meta(p,m)
  return p
 def restart(self,**fields):
  # A new process: recovery first, then one cycle.
  self.store.invalidate();archiver=self.archiver(**fields);archiver.recover_startup();archiver.run_cycle();return archiver

 def assert_consistent(self,p,label):
  # At any moment: a local file is gone only when the index says nas and the share holds the indexed bytes.
  m=server.read_meta(p)
  for kind in KINDS:
   e=media_store.entry(m,kind);share=self.nas/p.name/kind
   if not (p/kind).exists():
    self.assertEqual(e['location'],'nas',f'{label}: {kind} gone locally before its index said nas')
    self.assertEqual(share.read_bytes(),DATA[kind],f'{label}: {kind} indexed copy differs')
   if e['location']=='nas':
    self.assertTrue(share.is_file(),f'{label}: {kind} indexed on the share but not there');self.assertEqual(e['sha256'],sha(share.read_bytes()),label)
 def assert_archived(self,p,label):
  m=server.read_meta(p)
  for kind in KINDS:
   e=media_store.entry(m,kind)
   self.assertEqual((e['location'],e['sha256'],e['bytes']),('nas',sha(DATA[kind]),len(DATA[kind])),f'{label}: {kind}')
   self.assertEqual((self.nas/p.name/kind).read_bytes(),DATA[kind],label);self.assertFalse((p/kind).exists(),label)
  self.assertEqual(sorted(f.name for f in (self.nas/p.name).iterdir()),sorted(KINDS),f'{label}: one copy each, no .part')
  self.assertEqual(list(self.nas.rglob('*.part')),[],label)
  self.assertEqual((m['status'],(p/'prepared'/'data.json').is_file()),('ready',True),label)

 def test_archive_crash_matrix(self):
  part=lambda path,*a,**k:str(path).endswith('.part')
  local=lambda kind:lambda path,*a,**k:Path(path)==self.root/('a'*32)/kind
  def half(src,dst,length=0):dst.write(src.read(7))  # Torn copy: some bytes reached the .part file.
  rows=[  # (label, target, attribute, before/after, which call, partial effect)
   ('copy torn',media_store.shutil,'copyfileobj','before',lambda *a,**k:True,half),
   ('copy done',media_store.shutil,'copyfileobj','after',lambda *a,**k:True,None),
   ('fsync before',media_store.os,'fsync','before',lambda fd:fd_path(fd).endswith('.part'),None),
   ('fsync after',media_store.os,'fsync','after',lambda fd:fd_path(fd).endswith('.part'),None),
   ('re-read hash',media_store,'_sha256','before',part,None),
   ('rename before',media_store.os,'replace','before',part,None),
   ('rename after',media_store.os,'replace','after',part,None),
   ('commit before',media_store,'atomic_json','before',lambda path,value:path.name=='meta.json',None),
   ('commit after',media_store,'atomic_json','after',lambda path,value:path.name=='meta.json',None),
   ('unlink before',media_store.Path,'unlink','before',local('fcamera.mp4'),None),
   ('unlink after',media_store.Path,'unlink','after',local('fcamera.mp4'),None),
   ('log rename after',media_store.os,'replace','after',lambda src,dst:str(src).endswith('rlog.zst.part'),None),
   ('log commit after',media_store,'atomic_json','after',lambda path,value:media_store.location(value,'rlog.zst')=='nas',None),
  ]
  for label,target,attr,when,match,partial in rows:
   with self.subTest(label):
    self.forget(self.root/('a'*32));p=self.recording()
    patcher,state=crashing(target,attr,when,match,partial)
    with patcher,self.assertRaises(Crash):self.archiver().run_cycle()
    self.assertTrue(state['done'],label);self.assert_consistent(p,label+' (at the crash)')
    self.restart();self.assert_consistent(p,label+' (after restart)');self.assert_archived(p,label)

 def forget(self,p):
  # Each row starts from scratch (the same id is reused).
  shutil.rmtree(p,ignore_errors=True);shutil.rmtree(self.nas/p.name,ignore_errors=True)
  (self.root/media_store.PENDING_DELETES).unlink(missing_ok=True)
 def archived(self):
  p=self.recording();self.assertEqual(self.archiver().run_cycle()['archived'],2);self.assert_archived(p,'setup')
  return p
 def over_limit(self):
  # Only the video goes: the limit leaves room for the log.
  return patch.object(self.store,'usage',side_effect=lambda:(sum(f.stat().st_size for f in (self.nas/('a'*32)).iterdir()),10**12))

 def test_cleanup_crash_matrix(self):
  video=lambda path,*a,**k:Path(path)==self.nas/('a'*32)/'fcamera.mp4'
  rows=[('share unlink before',media_store.Path,'unlink','before',video),
        ('share unlink after',media_store.Path,'unlink','after',video),
        ('index commit before',server,'save_meta','before',lambda p,m:media_store.location(m,'fcamera.mp4')=='removed'),
        ('index commit after',server,'save_meta','after',lambda p,m:media_store.location(m,'fcamera.mp4')=='removed')]
  for label,target,attr,when,match in rows:
   with self.subTest(label):
    self.forget(self.root/('a'*32));p=self.archived();limit=len(DATA['rlog.zst'])
    patcher,state=crashing(target,attr,when,match)
    with self.over_limit(),patcher,self.assertRaises(Crash):self.archiver(nas_max_bytes=limit).cleanup_nas()
    self.assertTrue(state['done'],label)
    # Restarted without the limit: cleanup does not run again, so recovery alone must settle the index.
    self.restart()
    m=server.read_meta(p);e=media_store.entry(m,'fcamera.mp4');share=self.nas/p.name/'fcamera.mp4'
    if share.exists():self.assertEqual((e['location'],e['sha256']),('nas',sha(share.read_bytes())),label)
    else:self.assertEqual(e['location'],'removed',label);self.assertFalse(m['video'],label)
    self.assertEqual(media_store.location(m,'rlog.zst'),'nas',label);self.assertEqual((self.nas/p.name/'rlog.zst').read_bytes(),DATA['rlog.zst'])
    self.assertEqual((m['status'],(p/'prepared'/'data.json').is_file()),('ready',True),label)
    self.assertEqual(media_store.indexed_state(p,m,'fcamera.mp4','connected'),
                     'available' if share.exists() else 'missing',label)

 def test_delete_crash_before_local_removal_keeps_archived_files(self):
  # Deletion records the archived files first, then removes the recording. Stopped in between, the recording
  # is still there: its archived files must not be deleted under it.
  p=self.archived()
  patcher,state=crashing(server.shutil,'rmtree','before',lambda path,*a,**k:Path(path)==p)
  with patcher,self.assertRaises(Crash):
   with server.registration_lock,server.lock:server.delete_recording(p.name)
  self.assertTrue((p/'meta.json').is_file())
  self.restart()
  self.assert_archived(p,'after restart')
  # Deleting it again completes, and its archived files go then.
  with server.registration_lock,server.lock:server.delete_recording(p.name)
  server.process_pending()
  self.assertFalse(p.exists());self.assertFalse((self.nas/p.name).exists());self.assertFalse((self.root/media_store.PENDING_DELETES).exists())

 def test_delete_crash_after_share_unlink_is_finished(self):
  p=self.archived()
  with server.registration_lock,server.lock:
   with patch.object(server,'process_pending'):server.delete_recording(p.name)
  pending=media_store.PendingDeletes(self.root)
  patcher,state=crashing(media_store.PendingDeletes,'_save','before',lambda self,rows:True)
  with patcher,self.assertRaises(Crash):pending.process(self.store)
  self.assertFalse((self.nas/p.name/'fcamera.mp4').exists());self.assertEqual(pending.count(),2)  # Still listed.
  self.restart()
  self.assertFalse((self.nas/p.name).exists());self.assertEqual(pending.count(),0);self.assertFalse(pending.path.exists())

if __name__=='__main__':unittest.main()
