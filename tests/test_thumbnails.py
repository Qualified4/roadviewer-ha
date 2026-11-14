"""List extras made at conversion: the camera thumbnail and the drive summary (engaged share, takeovers)."""
import gzip,json,os,sys,tempfile,unittest
from pathlib import Path
from unittest.mock import patch
os.environ.setdefault('RV_DATA',tempfile.mkdtemp())
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'roadviewer/app'))
import av,zstandard
import decoder,server,media_store
from thumbnail import save_thumbnail
from test_video_sources import hevc
FIXTURE=Path(__file__).resolve().parent/'fixtures/black.mp4'
PEER={'REMOTE_ADDR':'172.30.32.2'};HEADERS={'X-RoadViewer-Request':'1'}

def jpeg_size(path):
 with av.open(str(path)) as image:
  stream=image.streams.video[0];return stream.width,stream.height

def multi_camera_log(root):
 hevc(root/'fcamera.hevc');hevc(root/'ecamera.hevc');messages=[]
 for i in range(8):
  for kind,start in [('modelV2',10.),('roadEncodeIdx',10.1),('wideRoadEncodeIdx',9.9),('carControl',10.)]:
   stamp=round((start+i*.05)*1e9)
   event=decoder.log.Event.new_message();event.logMonoTime=stamp;event.valid=True;event.init(kind)
   if kind=='carControl':event.carControl.enabled=i<4
   else:
    values={'frameId':i,'timestampEof':stamp}
    if kind=='modelV2':values.update(laneLines=[],laneLineProbs=[],roadEdges=[],roadEdgeStds=[])
    else:values['segmentId']=i
    setattr(event,kind,values)
   messages.append(event.to_bytes())
 source=root/'rlog.zst';source.write_bytes(zstandard.ZstdCompressor().compress(b''.join(messages)))
 return source

def ramp_video(path,luma,seconds=6,rate=20):
 # luma(t) -> (low, high): a horizontal gradient between them, so each frame has a known mean and contrast.
 with av.open(str(path),'w') as out:
  stream=out.add_stream('libx264',rate=rate);stream.width=160;stream.height=96;stream.pix_fmt='yuv420p'
  stream.options={'preset':'ultrafast','crf':'0'}
  for i in range(seconds*rate):
   low,high=luma(i/rate);frame=av.VideoFrame(160,96,'yuv420p')
   y=frame.planes[0];row=bytes(round(low+(high-low)*x/159) for x in range(160))+bytes(y.line_size-160)
   y.update(row*96)
   for plane in frame.planes[1:]:plane.update(bytes([128])*plane.buffer_size)
   for packet in stream.encode(frame):out.mux(packet)
  for packet in stream.encode():out.mux(packet)
 return path

def jpeg_luma(data):
 import thumbnail
 with tempfile.TemporaryDirectory() as temp:
  path=Path(temp)/'t.jpg';path.write_bytes(data)
  with av.open(str(path)) as image:frame=next(image.decode(video=0))
 return thumbnail.stats(frame.reformat(format='yuvj420p'))

class ThumbnailTests(unittest.TestCase):
 def test_best_exposed_frame_of_the_first_seconds_is_chosen(self):
  import thumbnail
  with tempfile.TemporaryDirectory() as temp:
   # Exposure still settling: dark for the first 2.5 s, then a normal picture.
   source=ramp_video(Path(temp)/'camera.mp4',lambda t:(5,30) if t<2.5 else (40,220))
   thumb=thumbnail.make_thumbnail([source])
  self.assertGreaterEqual(thumb.second,3);self.assertGreater(thumb.score,30)
  self.assertTrue(thumb.jpeg.startswith(b'\xff\xd8'))
  with tempfile.TemporaryDirectory() as temp:
   # Already well exposed at 1 s and darker later: the earlier frame stays.
   source=ramp_video(Path(temp)/'camera.mp4',lambda t:(40,220) if t<1.5 else (5,30))
   self.assertEqual(thumbnail.make_thumbnail([source]).second,1)

 def test_a_dark_picture_is_levelled_and_stays_a_valid_jpeg(self):
  import thumbnail
  with tempfile.TemporaryDirectory() as temp:
   source=ramp_video(Path(temp)/'camera.mp4',lambda t:(8,48),seconds=2)
   thumb=thumbnail.make_thumbnail([source])
   with av.open(str(source)) as video:before=thumbnail.stats(thumbnail.small(next(video.decode(video=0))))
  mean,std,low,high=jpeg_luma(thumb.jpeg)
  self.assertLess(before[0],35)
  self.assertGreater(mean,70);self.assertGreater(std,before[1]*2) # Stretched (at most 3x) and lifted by the gamma.
  self.assertLessEqual(low,before[2]+3)
  # A well exposed picture is only stretched, not lifted: its mean stays near the middle.
  with tempfile.TemporaryDirectory() as temp:
   thumb=thumbnail.make_thumbnail([ramp_video(Path(temp)/'camera.mp4',lambda t:(20,235),seconds=2)])
  self.assertLess(abs(jpeg_luma(thumb.jpeg)[0]-127),12)

 def test_score_written_beside_the_thumbnail(self):
  import thumbnail_meta
  with tempfile.TemporaryDirectory() as temp:
   root=Path(temp);save_thumbnail(root,[FIXTURE])
   info=json.loads((root/'thumbnail.json').read_text())
   self.assertEqual(info['version'],thumbnail_meta.VERSION);self.assertIsInstance(info['score'],float)
   self.assertTrue(thumbnail_meta.current(root));self.assertFalse(any(root.glob('*.tmp')))
   (root/'thumbnail.json').write_text('{"version":1}');self.assertFalse(thumbnail_meta.current(root))
   (root/'thumbnail.json').write_text('broken');self.assertEqual(thumbnail_meta.read(root),{})

 def test_scaled_jpeg_and_fallback_to_the_next_source(self):
  with tempfile.TemporaryDirectory() as temp:
   root=Path(temp);broken=root/'camera.mp4';broken.write_bytes(b'not a video')
   target=save_thumbnail(root,[None,root/'missing.mp4',broken,FIXTURE])
   self.assertEqual(target,root/'thumbnail.jpg')
   self.assertTrue(target.read_bytes().startswith(b'\xff\xd8'))
   self.assertEqual(jpeg_size(target),(320,180)) # 160x90 fixture, aspect kept.
   self.assertFalse((root/'thumbnail.jpg.tmp').exists())
   target.unlink()
   self.assertIsNone(save_thumbnail(root,[broken,None]));self.assertFalse((root/'thumbnail.jpg').exists())

 def test_conversion_makes_a_thumbnail_and_drive_summary_and_survives_failures(self):
  with tempfile.TemporaryDirectory() as temp:
   source=multi_camera_log(Path(temp))
   dest,data=decoder.prepare(source)
   self.assertEqual(jpeg_size(dest/'thumbnail.jpg'),(320,192)) # From the prepared front HEVC (160x96).
   self.assertEqual(json.loads((dest/'thumbnail.json').read_text())['version'],2)
   summary=json.loads((dest/'summary.json').read_text())
   self.assertEqual(summary['drive_summary']['takeovers'],1)
   self.assertGreater(summary['drive_summary']['engaged_ratio'],0);self.assertLess(summary['drive_summary']['engaged_ratio'],1)
   # A thumbnail that cannot be made never fails the conversion, nor does a drive summary error.
   with patch.object(decoder,'save_thumbnail',side_effect=RuntimeError('boom')),patch.object(decoder,'drive_summary',side_effect=ValueError('bad')):
    dest,again=decoder.prepare(source)
   self.assertFalse((dest/'thumbnail.jpg').exists());self.assertFalse((dest/'thumbnail.json').exists())
   self.assertEqual(again['videos'],data['videos']);self.assertEqual(again['warnings'],data['warnings'])
   self.assertIsNone(json.loads((dest/'summary.json').read_text())['drive_summary'])
   self.assertFalse((dest/'thumbnail.failed').exists()) # An exception may be transient: tried again on demand.
   with patch.object(decoder,'save_thumbnail',return_value=None):dest,_=decoder.prepare(source)
   self.assertTrue((dest/'thumbnail.failed').exists()) # Nothing decodable: remembered for this conversion.
   dest,_=decoder.prepare(source)
   self.assertTrue((dest/'thumbnail.jpg').exists());self.assertFalse((dest/'thumbnail.failed').exists())

 def test_decoding_is_bounded_for_a_source_without_decodable_frames(self):
  import itertools,thumbnail
  calls=[]
  class Packet:
   def decode(self):calls.append(1);raise av.InvalidDataError(1094995529,'bad')
  class Container:
   streams=type('Streams',(),{'video':[type('Stream',(),{'thread_type':None})()]})()
   def demux(self,stream):return (Packet() for _ in itertools.count()) # A broken file that never ends.
   def __enter__(self):return self
   def __exit__(self,*args):pass
  with tempfile.TemporaryDirectory() as temp,patch.object(thumbnail.av,'open',return_value=Container()):
   source=Path(temp)/'camera.mp4';source.write_bytes(b'x')
   self.assertIsNone(thumbnail.make_thumbnail([source]))
  self.assertEqual(len(calls),thumbnail.MAX_PACKETS)

class ServerCase(unittest.TestCase):
 def setUp(self):
  self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup)
  self.root=Path(self.temp.name)
  p=patch.object(server,'ROOT',self.root);p.start();self.addCleanup(p.stop)
  p=patch.object(server,'cleanup_uploads');p.start();self.addCleanup(p.stop)
  self.id='a'*32;self.path=self.root/self.id;self.prepared=self.path/'prepared';self.prepared.mkdir(parents=True)
  (self.path/'rlog.zst').write_bytes(b'log');(self.prepared/'data.json.gz').write_bytes(gzip.compress(b'{}'))
  server.save_meta(self.path,dict(id=self.id,name='test',status='ready',uploaded=1,decoder_version='v28-runtime-geometry',video=False,conversion_revision=1))
  self.client=server.app.test_client()
 def row(self):return self.client.get('/api/logs',environ_overrides=PEER).json['logs'][0]
 def summary(self,**extra):(self.prepared/'summary.json').write_text(json.dumps(dict(duration=1,warnings=[],model_frames=1,video=None,videos={},**extra)))
 def telemetry(self):
  value={'duration':1,'maxGap':.15,'streams':{'carControl':{'times':[i*.1 for i in range(10)],'values':{'enabled':[i<5 for i in range(10)]}}}}
  (self.prepared/'telemetry.json.gz').write_bytes(gzip.compress(json.dumps(value).encode()))


class ServerTests(ServerCase):
 def test_thumbnail_endpoint_row_flag_and_removal_with_prepared_data(self):
  url='/api/logs/'+self.id+'/thumbnail'
  self.assertEqual(self.client.get(url,environ_overrides=PEER).status_code,404)
  self.assertNotIn('thumbnail',self.row())
  save_thumbnail(self.prepared,[FIXTURE])
  response=self.client.get(url,environ_overrides=PEER)
  self.assertEqual(response.status_code,200);self.assertEqual(response.mimetype,'image/jpeg')
  self.assertEqual(response.headers['Cache-Control'],'private, max-age=86400')
  self.assertEqual(response.data,(self.prepared/'thumbnail.jpg').read_bytes());response.close()
  row=self.row();self.assertIs(row['thumbnail'],True);self.assertEqual(row['thumbnail_version'],2);self.assertIsInstance(row['thumbnail_score'],float)
  self.assertEqual(self.client.get(url).status_code,403) # Ingress only, like every other route.
  self.assertEqual(self.client.get('/api/logs/'+'b'*32+'/thumbnail',environ_overrides=PEER).status_code,404)
  # Archiving handles only the media kinds; the thumbnail stays with the local converted data.
  self.assertNotIn('thumbnail.jpg',media_store.MEDIA_KINDS)
  self.assertEqual(self.client.delete('/api/logs/'+self.id+'/prepared',headers=HEADERS,environ_overrides=PEER).status_code,200)
  self.assertFalse((self.prepared/'thumbnail.jpg').exists())
  self.assertEqual(self.client.get(url,environ_overrides=PEER).status_code,404)

 def backfill(self):
  import backfill
  with patch.object(server,'upload_receiving',return_value=False):return backfill.Backfill(server,pause=0).run_once()

 def test_drive_summary_from_summary_and_backfilled_once_from_telemetry(self):
  self.summary(drive_summary={'engaged_ratio':.92,'takeovers':2},started_at=None)
  self.assertEqual(self.row()['drive_summary'],{'engaged_ratio':.92,'takeovers':2})
  # Converted before drive summaries: the list only reads; the backfill computes it from the stored telemetry once.
  self.summary(started_at=None);self.telemetry()
  with patch.object(server,'drive_summary',side_effect=AssertionError('computed by the list')),patch('backfill.drive_summary',side_effect=AssertionError('computed by the list')):
   self.assertNotIn('drive_summary',self.row())
  self.assertEqual(self.backfill()[0],1)
  self.assertEqual(self.row()['drive_summary'],{'engaged_ratio':.5,'takeovers':1})
  self.assertEqual(json.loads((self.prepared/'summary.json').read_text())['drive_summary'],{'engaged_ratio':.5,'takeovers':1})
  with patch('backfill.drive_summary',side_effect=AssertionError('computed again')):self.assertEqual(self.backfill(),(0,False))
  # Unknown (no enabled samples) is cached as null and omitted from the row.
  self.summary(started_at=None);(self.prepared/'telemetry.json.gz').write_bytes(gzip.compress(b'{"duration":1,"streams":{}}'))
  self.backfill()
  self.assertNotIn('drive_summary',self.row())
  self.assertIsNone(json.loads((self.prepared/'summary.json').read_text())['drive_summary'])

 def test_drive_summary_omitted_without_telemetry_or_not_ready(self):
  self.summary(started_at=None)
  self.backfill()
  self.assertNotIn('drive_summary',self.row())
  self.assertNotIn('drive_summary',json.loads((self.prepared/'summary.json').read_text()))
  self.telemetry()
  server.save_meta(self.path,dict(server.read_meta(self.path),status='processing'))
  self.backfill()
  self.assertNotIn('drive_summary',self.row())
  self.assertNotIn('drive_summary',json.loads((self.prepared/'summary.json').read_text()))
  (self.prepared/'telemetry.json.gz').write_bytes(b'broken')
  server.save_meta(self.path,dict(server.read_meta(self.path),status='ready'))
  with self.assertLogs('backfill','WARNING'):self.backfill()
  self.assertNotIn('drive_summary',self.row())

 def age(self,seconds=60):
  # Older than the list cache's racy window: the cached row may be reused.
  t=os.stat(self.path/'meta.json').st_mtime-seconds
  for f in (self.path,self.path/'meta.json',self.prepared,self.prepared/'summary.json'):os.utime(f,(t,t))

 def test_list_row_cached_until_the_log_changes(self):
  self.summary(drive_summary={'engaged_ratio':.9,'takeovers':0},started_at=1762400000.0);self.age()
  first=self.client.get('/api/logs',environ_overrides=PEER).json
  self.assertEqual(first['storage_used_bytes'],server.storage_used_bytes())
  with patch.object(server,'read_meta',side_effect=AssertionError('read again')),patch.object(server,'build_list_row',side_effect=AssertionError('built again')),       patch.object(server.storage_policy,'pinned',return_value=True),patch.dict(server.job_progress,{self.id:{'stage':'x'}}):
   again=self.client.get('/api/logs',environ_overrides=PEER).json
  # Unchanged log: same row; pinned and progress are still read per request.
  self.assertEqual({k:v for k,v in again['logs'][0].items() if k not in ('pinned','progress')},{k:v for k,v in first['logs'][0].items() if k not in ('pinned','progress')})
  self.assertIs(again['logs'][0]['pinned'],True);self.assertEqual(again['logs'][0]['progress'],{'stage':'x'})
  self.assertEqual(again['storage_used_bytes'],first['storage_used_bytes'])
  # A new thumbnail (prepared/ changes), new metadata, a rewritten summary: each is seen at once.
  save_thumbnail(self.prepared,[FIXTURE]);self.assertIs(self.row()['thumbnail'],True)
  self.assertEqual(self.client.get('/api/logs',environ_overrides=PEER).json['storage_used_bytes'],server.storage_used_bytes())
  self.age();self.row();server.save_meta(self.path,dict(server.read_meta(self.path),tags=[{'name':'a'}]));self.assertEqual(self.row()['tags'],[{'name':'a'}])
  self.age();self.row();server.atomic_json(self.prepared/'summary.json',{**json.loads((self.prepared/'summary.json').read_text()),'started_at':5.0})
  self.assertEqual(self.row()['started_at'],5.0)
  # Removed: gone from the list and from the cache.
  import shutil;shutil.rmtree(self.path)
  self.assertEqual(self.client.get('/api/logs',environ_overrides=PEER).json['logs'],[]);self.assertNotIn(self.id,server.list_rows)

class LazyThumbnailTests(ServerCase):
 url=property(lambda self:'/api/logs/'+self.id+'/thumbnail')
 def get(self):
  response=self.client.get(self.url,environ_overrides=PEER);response.close();return response
 def test_made_on_demand_from_a_local_video_once(self):
  (self.path/'camera.mp4').write_bytes(FIXTURE.read_bytes())
  row=self.row();self.assertIs(row['thumbnail_available'],True);self.assertNotIn('thumbnail',row)
  response=self.get();self.assertEqual(response.status_code,200);self.assertEqual(response.mimetype,'image/jpeg')
  self.assertEqual(response.headers['Cache-Control'],'private, max-age=86400')
  self.assertEqual(jpeg_size(self.prepared/'thumbnail.jpg'),(320,180))
  row=self.row();self.assertIs(row['thumbnail'],True);self.assertNotIn('thumbnail_available',row);self.assertEqual(row['thumbnail_version'],2)
  with patch('thumbnail.make_thumbnail',side_effect=AssertionError('decoded again')):self.assertEqual(self.get().status_code,200)
 def test_busy_failed_remote_and_not_ready_answer_404_without_decoding(self):
  (self.path/'camera.mp4').write_bytes(FIXTURE.read_bytes())
  with patch('thumbnail.make_thumbnail',side_effect=AssertionError('must not decode')):
   # Another decode is running: 404 at once, nothing queued.
   self.assertTrue(server.thumbnail_lock.acquire())
   try:self.assertEqual(self.get().status_code,404)
   finally:server.thumbnail_lock.release()
   # Not ready: neither offered nor made.
   server.save_meta(self.path,dict(server.read_meta(self.path),status='processing'))
   self.assertNotIn('thumbnail_available',self.row());self.assertEqual(self.get().status_code,404)
   # Only an archived copy (Drive or NAS): never downloaded in the request; the backfill worker gets it first.
   (self.path/'camera.mp4').unlink()
   server.save_meta(self.path,dict(server.read_meta(self.path),status='ready',storage={'camera.mp4':{'location':'gdrive'}}))
   self.assertIs(self.row()['thumbnail_available'],True)
   with patch.object(server.list_backfill,'wake') as wake:self.assertEqual(self.get().status_code,404)
   wake.assert_called_once_with(self.id)
  # A local video that does not decode: tried once, then remembered for this conversion.
  server.save_meta(self.path,dict(server.read_meta(self.path),storage={}))
  (self.path/'camera.mp4').write_bytes(b'not a video')
  self.assertIs(self.row()['thumbnail_available'],True)
  self.assertEqual(self.get().status_code,404);self.assertTrue((self.prepared/'thumbnail.failed').exists())
  with patch('thumbnail.make_thumbnail',side_effect=AssertionError('decoded again')):self.assertEqual(self.get().status_code,404)
  self.assertNotIn('thumbnail_available',self.row())
  # A new conversion clears prepared/, and with it the remembered failure.
  self.assertEqual(self.client.delete('/api/logs/'+self.id+'/prepared',headers=HEADERS,environ_overrides=PEER).status_code,200)
  self.assertFalse((self.prepared/'thumbnail.failed').exists())
 def test_prefers_qcamera_then_prepared_front(self):
  m=server.read_meta(self.path)
  (self.prepared/'fcamera.mp4').write_bytes(b'front');(self.path/'qcamera.ts').write_bytes(b'q')
  self.assertEqual(server.thumbnail_sources(self.path,m),[self.path/'qcamera.ts',self.prepared/'fcamera.mp4'])
  (self.prepared/'camera.mp4').write_bytes(b'q');(self.path/'camera.mp4').write_bytes(b'q')
  self.assertEqual(server.thumbnail_sources(self.path,m)[:2],[self.path/'camera.mp4',self.prepared/'camera.mp4'])

if __name__=='__main__':unittest.main()
