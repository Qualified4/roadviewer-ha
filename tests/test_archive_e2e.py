"""End to end on a mock share: archive, lose the share, get it back, fill it, delete while it is gone,
and archiving off. Each step leans on the previous one, so the scenario runs as a single test."""
import dataclasses,gzip,hashlib,sys,tempfile,unittest
from pathlib import Path
from unittest.mock import patch
sys.path.insert(0,str(Path(__file__).resolve().parent))
from test_media_integration import PEER,HEADERS,make_nas,make_log  # Sets RV_DATA and imports the server module.
import server,media_store

UNAVAILABLE={'error':'storage_unavailable','message':'영상 저장소에 연결할 수 없습니다. NAS 연결을 확인하세요.'}
def sha(data):return hashlib.sha256(data).hexdigest()

class ArchiveEndToEnd(unittest.TestCase):
 def setUp(self):
  temp=tempfile.TemporaryDirectory();self.addCleanup(temp.cleanup);self.root=Path(temp.name)
  self.patch(server,'ROOT',self.root);self.patch(server,'cleanup_uploads');self.patch(server,'upload_receiving',return_value=False)
  self.submit=self.patch(server,'submit')
  self.nas,self.store=make_nas(self.root);self.patch(server,'store',self.store)
  self.settings=media_store.ArchiveSettings(enabled=True,path=self.nas,min_age_seconds=0,local_threshold_bytes=0,batch=64,nas_margin_bytes=0)
  self.archiver=media_store.Archiver(server,self.store,self.settings);self.patch(server,'archiver',self.archiver)
  self.client=server.app.test_client()
 def patch(self,*args,**kw):
  patcher=patch.object(*args,**kw);value=patcher.start();self.addCleanup(patcher.stop);return value
 def get(self,url,**kw):return self.client.get(url,environ_overrides=PEER,**kw)
 def send(self,method,url,**kw):return getattr(self.client,method)(url,environ_overrides=PEER,headers=HEADERS,**kw)
 def rows(self):
  r=self.get('/api/logs');self.assertEqual(r.status_code,200);return {row['id']:row for row in r.json['logs']}
 def lose_nas(self):
  self.sentinel=(self.nas/media_store.SENTINEL).read_bytes();(self.nas/media_store.SENTINEL).unlink();self.store.invalidate()
 def restore_nas(self):
  (self.nas/media_store.SENTINEL).write_bytes(self.sentinel);self.store.invalidate()
 def recording(self,id,uploaded,compressed):
  p=make_log(self.root,id,['rlog.zst','fcamera.mp4'],[])
  if compressed:(p/'prepared'/'data.json.gz').write_bytes(gzip.compress(b'{}'))
  else:(p/'prepared'/'data.json').write_text('{}')
  m=server.read_meta(p);m.update(status='ready',decoder_version='v28-runtime-geometry',video=True,uploaded=uploaded);server.save_meta(p,m)
  return p
 def video(self,p):return self.get(f'/api/logs/{p.name}/video?source=front',headers={'Range':'bytes=0-9'})
 def nas_files(self):return sorted(str(f.relative_to(self.nas)) for f in self.nas.rglob('*') if f.is_file() and f.name!=media_store.SENTINEL)

 def test_scenario(self):
  # 1. Three converted recordings, the oldest pinned.
  a,b,c=(self.recording(id*32,uploaded,compressed) for id,uploaded,compressed in (('a',1000,False),('b',2000,True),('c',3000,False)))
  self.patch(server.storage_policy,'settings',{**server.storage_policy.settings,'pinned_logs':[a.name]})
  for p in (a,b,c):
   self.assertEqual(server.read_meta(p)['status'],'ready');self.assertIsNotNone(server.prepared_file(p,'data.json')[0])
  self.assertEqual(len({server.read_meta(p)['uploaded'] for p in (a,b,c)}),3)
  self.assertTrue(server.storage_policy.pinned(server.read_meta(a)))

  # 2. One cycle moves every video and log to the share, the pinned recording's too.
  result=self.archiver.run_cycle()
  self.assertEqual((result['archived'],result['stopped']),(6,None))
  for p in (a,b,c):
   m=server.read_meta(p)
   for kind in ('fcamera.mp4','rlog.zst'):
    self.assertFalse((p/kind).exists(),(p.name,kind))
    data=(self.nas/p.name/kind).read_bytes();self.assertEqual(data,kind.encode()*10)
    e=media_store.entry(m,kind);self.assertEqual((e['location'],e['sha256'],e['bytes']),('nas',sha(data),len(data)))
  r=self.video(b);self.assertEqual(r.status_code,206);self.assertEqual(r.data,(b'fcamera.mp4'*10)[:10]);r.close()
  for row in self.rows().values():
   self.assertTrue(row['video']);self.assertEqual(row['video_state'],{'front':'available'})
   self.assertEqual(row['storage_locations'],{'rlog':'nas','front':'nas'})

  # 3. The share goes away: lists still work, media answers 503, nothing is reconverted, moved or deleted.
  metas={p.name:server.read_meta(p) for p in (a,b,c)};files=self.nas_files()
  self.lose_nas()
  rows=self.rows()
  for p in (a,b,c):self.assertTrue(rows[p.name]['video']);self.assertEqual(rows[p.name]['video_state'],{'front':'storage_unavailable'})
  r=self.video(b);self.assertEqual(r.status_code,503);self.assertEqual(r.json,UNAVAILABLE);r.close()
  r=self.get(f'/api/logs/{b.name}/download?source=rlog');self.assertEqual(r.status_code,503);self.assertEqual(r.json['error'],'storage_unavailable');r.close()
  # A ready recording is not reconverted (the existing answer); one waiting for conversion is refused.
  r=self.send('post',f'/api/logs/{b.name}/convert');self.assertEqual((r.status_code,r.json),(200,{'status':'ready'}))
  server.save_meta(b,{**metas[b.name],'status':'unconverted'})
  r=self.send('post',f'/api/logs/{b.name}/convert');self.assertEqual(r.status_code,409);self.assertEqual(r.json['error'],'storage_unavailable')
  self.assertEqual(server.read_meta(b)['status'],'unconverted');self.assertIsNotNone(server.prepared_file(b,'data.json')[0])
  server.save_meta(b,metas[b.name])
  with patch.object(server,'auto_convert',True):server.requeue_startup()
  self.submit.assert_not_called()
  for p in (a,b,c):
   self.assertEqual(server.read_meta(p)['status'],'ready');self.assertIsNotNone(server.prepared_file(p,'data.json')[0])
  for n in (1,2):
   self.assertEqual(self.archiver.run_cycle()['stopped'],'storage_unavailable')
   status=self.archiver.status();self.assertEqual((status['last_error'],status['consecutive_failures']),('storage_unavailable',n))
  self.assertEqual(self.nas_files(),files);self.assertEqual({p.name:server.read_meta(p) for p in (a,b,c)},metas)

  # 4. The share is back: playback resumes and a clean cycle resets the failure counters.
  self.restore_nas()
  r=self.video(b);self.assertEqual(r.status_code,206);r.close()
  self.assertEqual(self.archiver.run_cycle()['stopped'],None)
  status=self.archiver.status();self.assertEqual((status['last_error'],status['consecutive_failures']),(None,0))

  # 5. The share is over its limit: the oldest unpinned recording loses its video first; its log, meta.json
  # and prepared/ stay, and the pinned recording is untouched.
  video=len(b'fcamera.mp4'*10);total=sum(f.stat().st_size for f in self.nas.rglob('*') if f.is_file() and f.name!=media_store.SENTINEL)
  self.archiver.settings=dataclasses.replace(self.settings,nas_max_bytes=total-video)
  usage=lambda:(sum(f.stat().st_size for f in self.nas.rglob('*') if f.is_file() and f.name!=media_store.SENTINEL),10**12)
  with patch.object(self.store,'usage',side_effect=usage):result=self.archiver.run_cycle()
  self.assertEqual(result['stopped'],None);self.assertIsNone(self.archiver.cleanup_error)
  self.assertEqual(self.archiver.status()['cleanup_last_reason'],'nas_max');self.assertEqual(self.archiver.status()['removed_files_total'],1)
  m=server.read_meta(b);e=media_store.entry(m,'fcamera.mp4')
  self.assertEqual((e['location'],e['reason']),('removed','nas_full'));self.assertEqual(media_store.location(m,'rlog.zst'),'nas')
  self.assertFalse((self.nas/b.name/'fcamera.mp4').exists());self.assertTrue((self.nas/b.name/'rlog.zst').is_file())
  self.assertTrue((b/'meta.json').is_file());self.assertIsNotNone(server.prepared_file(b,'data.json')[0])
  for p in (a,c):
   self.assertEqual(server.read_meta(p)['storage'],metas[p.name]['storage'])
   self.assertTrue((self.nas/p.name/'fcamera.mp4').is_file());self.assertTrue((self.nas/p.name/'rlog.zst').is_file())
  rows=self.rows();self.assertEqual(rows[b.name]['video_state'],{'front':'missing'});self.assertEqual(rows[a.name]['video_state'],{'front':'available'})
  self.archiver.settings=self.settings

  # 6. Deleting an archived recording while the share is away records its files; the next cycle removes them.
  self.lose_nas()
  r=self.send('delete',f'/api/logs/{c.name}');self.assertEqual(r.status_code,200);self.assertEqual(r.json,{'deleted':c.name})
  self.assertFalse(c.exists())
  pending=media_store.PendingDeletes(self.root)
  with pending.lock:rows=pending._load()
  self.assertEqual([(row['id'],sorted(row['kinds'])) for row in rows],[(c.name,['fcamera.mp4','rlog.zst'])])
  self.assertTrue((self.nas/c.name/'fcamera.mp4').is_file())
  self.restore_nas()
  self.archiver.run_cycle()
  self.assertFalse((self.nas/c.name).exists());self.assertEqual(pending.count(),0);self.assertFalse(pending.path.exists())
  self.assertTrue((self.nas/a.name/'fcamera.mp4').is_file())

  # 7. Archiving off: local-only recordings carry no new fields and a cycle does nothing.
  temp=tempfile.TemporaryDirectory();self.addCleanup(temp.cleanup);root=Path(temp.name)
  off=media_store.ArchiveStore(media_store.ArchiveSettings(),root);archiver=media_store.Archiver(server,off,off.settings)
  with patch.object(server,'ROOT',root),patch.object(server,'store',off),patch.object(server,'archiver',archiver):
   p=self.recording_in(root)
   rows=self.rows();self.assertNotIn('video_state',rows[p.name]);self.assertNotIn('storage_locations',rows[p.name])
   self.assertEqual(archiver.run_cycle(),{'archived':0,'bytes':0,'stopped':'disabled'})
   self.assertEqual((p/'fcamera.mp4').read_bytes(),b'fcamera.mp4'*10);self.assertEqual((p/'rlog.zst').read_bytes(),b'rlog.zst'*10)
   self.assertEqual(media_store.location(server.read_meta(p),'fcamera.mp4'),'local')
 def recording_in(self,root):
  p=make_log(root,'d'*32,['rlog.zst','fcamera.mp4'],[]);(p/'prepared'/'data.json').write_text('{}')
  m=server.read_meta(p);m.update(status='ready',decoder_version='v28-runtime-geometry',video=True);server.save_meta(p,m)
  return p

if __name__=='__main__':unittest.main()
