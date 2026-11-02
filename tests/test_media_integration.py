"""Read paths (list, playback, downloads) serve media from the archive store through the same URLs."""
import io,json,os,sys,tempfile,unittest,zipfile
from pathlib import Path
from unittest.mock import patch
os.environ['RV_DATA']=tempfile.mkdtemp()
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'roadviewer/app'))
import server,media_store

PEER={'REMOTE_ADDR':'172.30.32.2'}

def make_nas(root):
 # A temporary directory standing in for the share: sentinel plus the local copy of its storage id.
 nas=Path(tempfile.mkdtemp(prefix='rv-nas-'))
 store=media_store.ArchiveStore(media_store.ArchiveSettings(enabled=True,path=nas),root);store.activate()
 assert store.state()=='connected',store.reason()
 return nas,store

def make_log(root,id,kinds_local,kinds_nas,status='ready',nas=None):
 p=Path(root)/id;p.mkdir();(p/'prepared').mkdir()
 m=dict(id=id,name='0000041b--c6f39793a8--1',status=status,uploaded=1,files={},error=None)
 for kind in kinds_local:(p/kind).write_bytes(kind.encode()*10)
 for kind in kinds_nas:
  target=nas/id/kind;target.parent.mkdir(parents=True,exist_ok=True);data=kind.encode()*20;target.write_bytes(data)
  media_store.set_location(m,kind,location='nas',bytes=len(data),sha256='0'*64,archived_at=1.0)
 server.save_meta(p,m)
 return p

class MediaIntegrationTests(unittest.TestCase):
 def setUp(self):
  temp=tempfile.TemporaryDirectory();self.addCleanup(temp.cleanup);self.root=Path(temp.name)
  for patcher in (patch.object(server,'ROOT',self.root),patch.object(server,'cleanup_uploads')):patcher.start();self.addCleanup(patcher.stop)
  self.client=server.app.test_client()
 def use(self,store):
  patcher=patch.object(server,'store',store);patcher.start();self.addCleanup(patcher.stop)
 def get(self,url,**kw):return self.client.get(url,environ_overrides=PEER,**kw)
 def lose_nas(self,nas,store):
  (nas/media_store.SENTINEL).unlink();store.invalidate()

 def test_video_served_from_nas_with_range(self):
  nas,store=make_nas(self.root);self.use(store)
  p=make_log(self.root,'a'*32,['rlog.zst'],['fcamera.mp4'],nas=nas)
  r=self.get(f'/api/logs/{p.name}/video?source=front',headers={'Range':'bytes=0-9'})
  self.assertEqual(r.status_code,206);self.assertEqual(r.headers['Content-Range'],f'bytes 0-9/{len(b"fcamera.mp4")*20}')
  self.assertEqual(r.data,(b'fcamera.mp4'*20)[:10]);r.close()

 def test_video_503_when_sentinel_missing(self):
  nas,store=make_nas(self.root);self.use(store)
  p=make_log(self.root,'a'*32,['rlog.zst'],['fcamera.mp4'],nas=nas);self.lose_nas(nas,store)
  r=self.get(f'/api/logs/{p.name}/video?source=front')
  self.assertEqual(r.status_code,503)
  self.assertEqual(r.json,{'error':'storage_unavailable','message':'영상 저장소에 연결할 수 없습니다. NAS 연결을 확인하세요.'})
  self.assertNotIn(str(nas),r.get_data(as_text=True))
  # The files and the index are untouched: the share may come back.
  self.assertTrue((nas/p.name/'fcamera.mp4').is_file());self.assertEqual(media_store.location(server.read_meta(p),'fcamera.mp4'),'nas')
  with patch.object(store,'state',return_value='checking'):
   r=self.get(f'/api/logs/{p.name}/video?source=front')
  self.assertEqual(r.status_code,503);self.assertEqual(r.headers['Retry-After'],'5');self.assertEqual(r.json['error'],'storage_checking')

 def test_corrupt_media_is_409(self):
  nas,store=make_nas(self.root);self.use(store)
  p=make_log(self.root,'a'*32,['rlog.zst'],['fcamera.mp4'],nas=nas)
  m=server.read_meta(p);m['storage']['fcamera.mp4']['error']='sha256_mismatch';server.save_meta(p,m)
  r=self.get(f'/api/logs/{p.name}/video?source=front')
  self.assertEqual(r.status_code,409);self.assertEqual(r.json,{'error':'media_corrupt','message':'영상 파일을 읽을 수 없습니다. 손상되었을 수 있습니다.'})

 def test_logs_list_works_when_nas_unavailable(self):
  nas,store=make_nas(self.root);self.use(store)
  p=make_log(self.root,'a'*32,['rlog.zst','camera.mp4'],['fcamera.mp4'],nas=nas);self.lose_nas(nas,store)
  r=self.get('/api/logs');self.assertEqual(r.status_code,200)
  row=r.json['logs'][0]
  self.assertTrue(row['video']);self.assertEqual(row['video_state'],{'front':'storage_unavailable','qcamera':'available'})
  self.assertEqual(row['storage_locations'],{'rlog':'local','front':'nas','qcamera':'local'})
  size=len(b'fcamera.mp4')*20
  self.assertEqual(row['video_download'],'fcamera.mp4')
  self.assertIn({'source':'front','kind':'fcamera.mp4','bytes':size},row['video_downloads'])
  self.assertEqual(next(o for o in row['download_options'] if o['source']=='front')['bytes'],size)
  self.assertEqual(row['bytes'],size+len(b'rlog.zst')*10+len(b'camera.mp4')*10);self.assertEqual(row['log_bytes'],len(b'rlog.zst')*10)
  self.assertNotIn(str(nas),r.get_data(as_text=True))

 def test_logs_omit_new_fields_for_local_only_logs(self):
  nas,store=make_nas(self.root);self.use(store)
  make_log(self.root,'a'*32,['rlog.zst','camera.mp4'],[])
  row=self.get('/api/logs').json['logs'][0]
  self.assertNotIn('video_state',row);self.assertNotIn('storage_locations',row)
  self.assertTrue(row['video']);self.assertEqual(row['video_downloads'],[{'source':'qcamera','kind':'camera.mp4','bytes':len(b'camera.mp4')*10}])
  # Only removed (cleaned-up) videos: the recording no longer has a video.
  p=make_log(self.root,'b'*32,['rlog.zst'],[]);m=server.read_meta(p)
  media_store.set_location(m,'fcamera.mp4',location='removed',removed_at=1.0,reason='nas_full');server.save_meta(p,m)
  row=next(row for row in self.get('/api/logs').json['logs'] if row['id']==p.name)
  self.assertFalse(row['video']);self.assertEqual(row['video_state'],{'front':'missing'});self.assertEqual(row['storage_locations']['front'],'removed')

 def test_original_rlog_from_nas(self):
  nas,store=make_nas(self.root);self.use(store)
  p=make_log(self.root,'a'*32,[],['rlog.zst'],nas=nas)
  r=self.get(f'/api/logs/{p.name}/original/rlog.zst');self.assertEqual(r.status_code,200);self.assertEqual(r.data,b'rlog.zst'*20);r.close()
  r=self.get(f'/api/logs/{p.name}/download?source=rlog');self.assertEqual(r.status_code,200);self.assertEqual(r.data,b'rlog.zst'*20);r.close()
  self.lose_nas(nas,store)
  self.assertEqual(self.get(f'/api/logs/{p.name}/original/rlog.zst').status_code,503)

 def test_zip_refuses_partial_when_unavailable(self):
  nas,store=make_nas(self.root);self.use(store)
  a=make_log(self.root,'a'*32,['rlog.zst'],[]);b=make_log(self.root,'b'*32,['rlog.zst'],['fcamera.mp4'],nas=nas)
  url=f'/api/logs/download.zip?ids={a.name},{b.name}&parts=rlog,front'
  for suffix in ('','&format=mp4'):
   r=self.get(url+suffix);self.assertEqual(r.status_code,200)
   with zipfile.ZipFile(io.BytesIO(r.data)) as archive:self.assertEqual(len(archive.namelist()),3)
   r.close()
  self.lose_nas(nas,store)
  for suffix in ('','&format=mp4'):
   r=self.get(url+suffix);self.assertEqual(r.status_code,503,suffix);self.assertEqual(r.json['error'],'storage_unavailable');r.close()
  self.assertEqual(self.get(f'/api/logs/{b.name}/download/video').status_code,503)

 def test_missing_nas_file_is_404(self):
  nas,store=make_nas(self.root);self.use(store)
  p=make_log(self.root,'a'*32,['rlog.zst'],['fcamera.mp4'],nas=nas);(nas/p.name/'fcamera.mp4').unlink()
  self.assertEqual(self.get(f'/api/logs/{p.name}/video?source=front').status_code,404)
  self.assertEqual(self.get(f'/api/logs/{p.name}/original/fcamera.mp4').status_code,404)
  self.assertEqual(self.get(f'/api/logs/{p.name}/download?source=front').status_code,404)

 def test_archiving_off_serves_local_files(self):
  store=media_store.ArchiveStore(media_store.ArchiveSettings(),self.root);self.use(store)
  p=make_log(self.root,'a'*32,['rlog.zst','fcamera.mp4'],[])
  self.assertEqual(store.state(),'disabled')
  r=self.get(f'/api/logs/{p.name}/video?source=front');self.assertEqual(r.status_code,200);self.assertEqual(r.data,b'fcamera.mp4'*10);r.close()
  self.assertEqual(self.get(f'/api/logs/{p.name}/video?source=wide').status_code,404)
  self.assertNotIn('video_state',self.get('/api/logs').json['logs'][0])

if __name__=='__main__':unittest.main()
