"""GPS routes for the maps (gps_track.py): real fixes only, 1 Hz on the replay timeline, stored per conversion, filled in
once for older logs (local or NAS only, never Drive) and served only by the two map endpoints, never by the list.
The fixture is synthetic: a made-up straight drive, never a real position."""
import gzip,json,math,os,sys,tempfile,unittest
from pathlib import Path
from unittest.mock import patch
sys.path.insert(0,str(Path(__file__).resolve().parent))
from test_media_integration import make_log,make_nas,PEER  # Sets RV_DATA and imports the server module.
import zstandard
import server,decoder,gps_track,media_store

BASE_LAT,BASE_LON=10.0,20.0  # Synthetic, in open ocean.
def gps(mono,lat,lon,kind='gpsLocationExternal',fix=True,valid=True,accuracy=4.0,speed=12.5,bearing=0.0):
 e=decoder.log.Event.new_message();e.logMonoTime=mono;e.valid=valid;e.init(kind);g=getattr(e,kind)
 g.hasFix=fix;g.latitude=lat;g.longitude=lon;g.horizontalAccuracy=accuracy;g.speed=speed;g.bearingDeg=bearing
 return e
def model(i,start=10.0,lag=.03):
 # 20 Hz frames whose camera time (timestampEof) is a little before logMonoTime, as on a device.
 e=decoder.log.Event.new_message();stamp=round((start+i*.05)*1e9);e.logMonoTime=stamp;e.valid=True;e.init('modelV2')
 e.modelV2={'frameId':i,'timestampEof':stamp-round(lag*1e9),'laneLines':[],'laneLineProbs':[],'roadEdges':[],'roadEdgeStds':[]}
 return e
def drive(seconds=6,start=10.0,kind='gpsLocationExternal',lat=BASE_LAT):
 # 10 Hz fixes heading north at 12.5 m/s (about 1.1e-4 degrees per second).
 return [gps(round((start+i/10)*1e9),lat+i*1.125e-5,BASE_LON,kind=kind) for i in range(seconds*10)]
def rlog_bytes(events):return zstandard.ZstdCompressor().compress(b''.join(e.to_bytes() for e in events))

class CollectorTests(unittest.TestCase):
 def collect(self,events):
  c=gps_track.Collector()
  for e in events:c.add(e,e.which())
  return c
 def test_only_real_fixes_one_per_second(self):
  bad=[gps(1_000_000_000,BASE_LAT,BASE_LON,fix=False),gps(1_100_000_000,BASE_LAT,BASE_LON,valid=False),gps(1_200_000_000,0.0,0.0),
       gps(1_300_000_000,BASE_LAT,BASE_LON,accuracy=5000),gps(1_400_000_000,math.nan,BASE_LON),gps(1_500_000_000,BASE_LAT,BASE_LON,accuracy=math.nan)]
  self.assertIsNone(self.collect(bad).source())
  points=self.collect(drive(seconds=5,start=1.0)).points(0)
  self.assertEqual([p[0] for p in points],[1.0,2.0,3.0,4.0,5.0])
  self.assertEqual(points[0][1:],[BASE_LAT,BASE_LON,12.5,0])
  self.assertEqual(len(str(points[1][1]).split('.')[1]),6)  # Six decimals.
 def test_external_receiver_preferred_and_device_gps_as_fallback(self):
  both=self.collect(drive(seconds=2,start=1.0)+drive(seconds=3,start=1.0,kind='gpsLocation',lat=BASE_LAT+1))
  self.assertEqual(both.source(),'gpsLocationExternal');self.assertEqual(len(both.points(0)),2)
  self.assertEqual(self.collect(drive(seconds=3,start=1.0,kind='gpsLocation')).source(),'gpsLocation')
 def test_a_jump_is_dropped(self):
  events=drive(seconds=3,start=1.0);events[15]=gps(events[15].logMonoTime,BASE_LAT+1,BASE_LON)  # 110 km away for one fix.
  points=self.collect(events).points(0)
  self.assertTrue(all(abs(p[1]-BASE_LAT)<.01 for p in points))
 def test_simplify_keeps_the_ends_and_the_limit(self):
  coords=[[BASE_LAT+i*1e-5,BASE_LON+math.sin(i/40)*1e-3] for i in range(3000)]
  out=gps_track.simplify(coords,300)
  self.assertLessEqual(len(out),300);self.assertGreater(len(out),20);self.assertEqual((out[0],out[-1]),(coords[0],coords[-1]))

def converted(root,id,events,name):
 p=Path(root)/id;p.mkdir(parents=True);(p/'rlog.zst').write_bytes(rlog_bytes(events))
 with patch.dict(os.environ,{'RV_PREPARED_DIR':str(p/'prepared'),'RV_RECORDING_DIR':str(p)}):decoder.prepare(p/'rlog.zst')
 server.save_meta(p,dict(id=id,name=name,status='ready',uploaded=1,files={},decoder_version='v28-runtime-geometry',video=False,conversion_revision=1))
 return p

class Case(unittest.TestCase):
 def setUp(self):
  temp=tempfile.TemporaryDirectory();self.addCleanup(temp.cleanup);self.root=Path(temp.name)
  for patcher in (patch.object(server,'ROOT',self.root),patch.object(server,'cleanup_uploads'),patch.object(server,'upload_receiving',return_value=False)):patcher.start();self.addCleanup(patcher.stop)
  self.client=server.app.test_client()
 def events(self,gps_start=10.5):return [model(i) for i in range(120)]+drive(seconds=5,start=gps_start)
 def worker(self,busy=False):
  class List:
   def __init__(self):self.calls=0
   def busy(self):return busy
  return gps_track.TrackBackfill(server,List(),pause=0)
 def forget(self,p):
  (p/'prepared'/gps_track.FILE).unlink(missing_ok=True);file=p/'prepared/summary.json'
  file.write_text(json.dumps({k:v for k,v in json.loads(file.read_text()).items() if k not in gps_track.SUMMARY_FIELDS}))

class ConversionAndBackfillTests(Case):
 def test_conversion_writes_the_track_on_the_replay_timeline(self):
  p=converted(self.root,'a'*32,self.events(),'0000041b--c6f39793a8--1')
  summary=json.loads((p/'prepared/summary.json').read_text())
  self.assertEqual((summary['track_v'],summary['has_track']),(gps_track.TRACK_V,True))
  self.assertAlmostEqual(summary['track_distance_m'],56,delta=2)  # First fix of each second, t .53 to 5.03: 4.5 s at 12.5 m/s.
  self.assertEqual(len(summary['track_bbox']),4)
  points=gps_track.read(p/'prepared');data=json.loads(gzip.decompress((p/'prepared/data.json.gz').read_bytes()))
  # The replay's frame 0 is at t 0 and its camera time is 9.97 s: a fix logged at 10.5 s is at t 0.53.
  self.assertEqual(data['frames'][0]['t'],0);self.assertAlmostEqual(points[0][0],.53,places=2);self.assertEqual([p[0] for p in points][1:3],[1.03,2.03]);self.assertEqual(len(points),6)
  # Bench logs: the receiver reports no fix at all; such a log simply has no track.
  q=converted(self.root,'b'*32,[model(i) for i in range(40)]+[gps(round((10+i/10)*1e9),0.0,0.0,fix=False) for i in range(20)],'0000041b--c6f39793a8--2')
  self.assertFalse(json.loads((q/'prepared/summary.json').read_text())['has_track']);self.assertFalse((q/'prepared'/gps_track.FILE).exists())
 def test_backfill_gives_the_same_track_once_and_never_reads_drive(self):
  p=converted(self.root,'c'*32,self.events(),'0000041b--c6f39793a8--1');expected=gps_track.read(p/'prepared');self.forget(p)
  drive_only=converted(self.root,'d'*32,self.events(),'0000041c--aaaaaaaaaa--0');self.forget(drive_only)
  m=server.read_meta(drive_only);media_store.set_location(m,'rlog.zst',location='gdrive',file_id='x',bytes=1,sha256='0'*64);server.save_meta(drive_only,m)
  (drive_only/'rlog.zst').unlink()
  worker=self.worker(busy=True)
  self.assertTrue(worker.run_once());self.assertFalse((p/'prepared'/gps_track.FILE).exists())  # Waits while busy.
  worker=self.worker()
  with patch.object(media_store,'resolve',side_effect=AssertionError('Drive must not be read')):self.assertFalse(worker.run_once())
  self.assertEqual(gps_track.read(p/'prepared'),expected)  # Same points and times as at conversion.
  self.assertFalse(json.loads((drive_only/'prepared/summary.json').read_text())['has_track'])
  self.assertFalse(any(p.glob('prepared/*.migrating')))
  with patch.object(gps_track.TrackBackfill,'process',side_effect=AssertionError('read again')):self.assertFalse(worker.run_once())
 def test_nas_log_read_in_place_and_an_unreachable_nas_retried(self):
  nas,store=make_nas(self.root)
  p=converted(self.root,'e'*32,self.events(),'0000041b--c6f39793a8--1');expected=gps_track.read(p/'prepared');self.forget(p)
  (nas/p.name).mkdir(parents=True,exist_ok=True);(p/'rlog.zst').replace(nas/p.name/'rlog.zst')
  m=server.read_meta(p);media_store.set_location(m,'rlog.zst',location='nas',bytes=1,sha256='0'*64,archived_at=1.0);server.save_meta(p,m)
  with patch.object(server,'store',store):
   with patch.object(store,'available',return_value=False):self.assertTrue(self.worker().run_once())
   self.assertNotIn('track_v',json.loads((p/'prepared/summary.json').read_text()))  # Not cached: tried again.
   self.assertFalse(self.worker().run_once())
  self.assertEqual(gps_track.read(p/'prepared'),expected)

class ApiTests(Case):
 def get(self,url,**kw):return self.client.get(url,environ_overrides=PEER,**kw)
 def test_list_flag_route_endpoint_and_simplified_routes(self):
  a0=converted(self.root,'1'*32,self.events(),'0000041b--c6f39793a8--0')
  a1=converted(self.root,'2'*32,[model(i,start=70) for i in range(40)]+drive(seconds=3,start=70.5,lat=BASE_LAT+.001),'0000041b--c6f39793a8--1')
  other=converted(self.root,'3'*32,[model(i) for i in range(40)],'0000041c--bbbbbbbbbb--0')  # No GPS.
  rows={row['id']:row for row in self.get('/api/logs').json['logs']}
  self.assertEqual((rows[a0.name]['has_track'],rows[other.name]['has_track']),(True,False))
  # The list never carries coordinates (it is also read by tools such as roadviewer-mcp).
  for row in rows.values():self.assertFalse({'track_bbox','track_distance_m','points'}&set(row))
  self.assertNotIn(str(BASE_LON),self.get('/api/logs').get_data(as_text=True))
  route=self.get(f'/api/logs/{a1.name}/track').json
  self.assertEqual([(s['id'],s['segment']) for s in route['segments']],[(a0.name,0),(a1.name,1)])
  self.assertEqual(route['segments'][0]['points'],gps_track.read(a0/'prepared'))
  self.assertEqual(self.get(f'/api/logs/{other.name}/track').json['segments'],[])
  response=self.get('/api/tracks');routes=response.json['routes']
  self.assertEqual(len(routes),1);self.assertEqual(routes[0]['segments'],[a0.name,a1.name]);self.assertEqual(sorted(routes[0]['ids']),[a0.name,a1.name])
  self.assertLessEqual(len(routes[0]['points']),server.ROUTE_POINTS);self.assertGreater(routes[0]['distance_m'],0)
  self.assertEqual(self.get('/api/tracks',headers={'If-None-Match':response.headers['ETag']}).status_code,304)
  self.assertEqual(self.get('/api/tracks?ids='+other.name).json['routes'],[])
  self.assertEqual(len(self.get('/api/tracks?ids='+a1.name).json['routes']),1)
  # Only through Ingress, as every other page API.
  self.assertEqual(self.client.get('/api/tracks',environ_overrides={'REMOTE_ADDR':'10.0.0.5'}).status_code,403)

if __name__=='__main__':unittest.main()
