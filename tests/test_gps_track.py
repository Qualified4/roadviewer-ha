"""GPS routes for the maps (gps_track.py): real fixes only, 1 Hz on the replay timeline, stored per conversion, filled in
once for older logs (local or NAS; Google Drive only when asked, read-only) and served only by the two map endpoints, never by the list.
The fixture is synthetic: a made-up straight drive, never a real position."""
import gzip,hashlib,json,math,os,sys,tempfile,unittest
from pathlib import Path
from unittest.mock import patch
sys.path.insert(0,str(Path(__file__).resolve().parent))
from test_media_integration import make_log,make_nas,PEER,HEADERS  # Sets RV_DATA and imports the server module.
from fake_drive import FakeDrive
import zstandard
import server,decoder,gps_track,media_store
import archive_backends as ab

BASE_LAT,BASE_LON=10.0,20.0  # Synthetic, in open ocean.
def gps(mono,lat,lon,kind='gpsLocationExternal',fix=True,valid=True,accuracy=4.0,speed=12.5,bearing=0.0):
 e=decoder.log.Event.new_message();e.logMonoTime=mono;e.valid=valid;e.init(kind);g=getattr(e,kind)
 g.hasFix=fix;g.latitude=lat;g.longitude=lon;g.horizontalAccuracy=accuracy;g.speed=speed;g.bearingDeg=bearing
 return e
def car(mono,lat,lon,sample=None,available=True,valid=True,heading=90.0,heading_valid=True,v=11.0):
 # carState at 100 Hz repeats the vehicle GPS sample until the next one (sampleMonoTime).
 e=decoder.log.Event.new_message();e.logMonoTime=mono;e.valid=True;e.init('carState');c=e.carState;c.vEgo=v;g=c.vehicleGps
 g.available=available;g.valid=valid;g.latitude=lat;g.longitude=lon;g.sampleMonoTime=mono if sample is None else sample;g.headingDeg=heading;g.headingValid=heading_valid
 return e
def vehicle_drive(seconds=5,start=10.0,lat=BASE_LAT):
 # A 1 Hz vehicle GPS seen through 10 Hz carState here (100 Hz on the car): each sample repeated ten times.
 out=[]
 for i in range(seconds*10):
  sample=round((start+(i//10))*1e9);out.append(car(round((start+i*.1)*1e9),lat+(i//10)*1e-5,BASE_LON,sample=sample))
 return out
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
 def test_vehicle_gps_when_no_receiver_has_a_fix(self):
  # The device's receiver sees no satellites (as on the real car): its unfixed reports are ignored and the car's own
  # GPS from carState is used, one point per new sample, with vEgo as speed and the heading when valid.
  events=[gps(round((1+i*.1)*1e9),0.0,0.0,fix=False) for i in range(30)]+vehicle_drive(seconds=3,start=1.0)
  c=self.collect(sorted(events,key=lambda e:e.logMonoTime))
  self.assertEqual(c.source(),'vehicleGps');points=c.points(0)
  self.assertEqual([p[0] for p in points],[1.0,2.0,3.0]);self.assertEqual(points[0][1:],[BASE_LAT,BASE_LON,11.0,90])
  self.assertEqual(points[1][1],round(BASE_LAT+1e-5,6))
  bad=[car(1_000_000_000,BASE_LAT,BASE_LON,available=False),car(1_100_000_000,BASE_LAT,BASE_LON,valid=False),car(1_200_000_000,0.0,0.0),car(1_300_000_000,math.nan,BASE_LON)]
  self.assertIsNone(self.collect(bad).source())
  self.assertIsNone(self.collect([car(1_000_000_000,BASE_LAT,BASE_LON,heading_valid=False)]).points(0)[0][4])
  # carrotMan's estimated position only when neither a receiver nor the car has one.
  def carrot(mono,lat,lon):
   e=decoder.log.Event.new_message();e.logMonoTime=mono;e.valid=True;e.init('carrotMan');e.carrotMan.xPosLat=lat;e.carrotMan.xPosLon=lon;e.carrotMan.xPosAngle=45;return e
  carrots=[carrot(round((1+i*.05)*1e9),BASE_LAT,BASE_LON) for i in range(60)]+[carrot(round(4.5e9),0.0,0.0)]
  only=self.collect(carrots);self.assertEqual(only.source(),'carrotMan');self.assertEqual([p[0] for p in only.points(0)],[1.0,2.0,3.0])
  self.assertEqual(self.collect(carrots+vehicle_drive(seconds=2,start=1.0)).source(),'vehicleGps')
  # A receiver with a fix still wins.
  self.assertEqual(self.collect(drive(seconds=2,start=1.0)+vehicle_drive(seconds=3,start=1.0)).source(),'gpsLocationExternal')
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
 def test_vehicle_gps_converted_and_version_1_logs_read_again(self):
  # Conversion keeps the vehicle GPS; a log that version 1 (receivers only) marked without a track is read again.
  events=[model(i) for i in range(120)]+vehicle_drive(seconds=5,start=10.5)
  p=converted(self.root,'e'*32,events,'0000042d--bfa94dc544--11')
  stored=lambda:json.loads(gzip.decompress((p/'prepared'/gps_track.FILE).read_bytes()))
  self.assertEqual(stored()['source'],'vehicleGps');self.assertEqual(len(gps_track.read(p/'prepared')),5)
  summary=p/'prepared/summary.json';s=json.loads(summary.read_text())
  self.assertEqual(s['track_v'],gps_track.TRACK_V);self.assertTrue(s['has_track'])
  (p/'prepared'/gps_track.FILE).unlink();summary.write_text(json.dumps({**s,'track_v':1,'has_track':False,'track_distance_m':None,'track_bbox':None}))
  self.assertFalse(self.worker().run_once())
  self.assertTrue(json.loads(summary.read_text())['has_track']);self.assertEqual(stored()['source'],'vehicleGps')
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
  # The routes are kept between requests (no recording read again) until a recording or a track file changes.
  with patch.object(server,'all_routes',side_effect=AssertionError('built again')):self.assertEqual(self.get('/api/tracks').json['routes'],routes)
  meta=server.read_meta(a1);server.save_meta(a1,{**meta,'tags':[{'name':'t','color':'mint'}]})
  with patch.object(server,'all_routes',wraps=server.all_routes) as built:
   self.assertEqual(self.get('/api/tracks').json['routes'],routes);self.assertEqual(built.call_count,1)
  self.assertEqual(self.get('/api/tracks?ids='+other.name).json['routes'],[])
  self.assertEqual(len(self.get('/api/tracks?ids='+a1.name).json['routes']),1)
  # Only through Ingress, as every other page API.
  self.assertEqual(self.client.get('/api/tracks',environ_overrides={'REMOTE_ADDR':'10.0.0.5'}).status_code,403)

class Clock:
 def __init__(self):self.now=1000.0
 def __call__(self):return self.now

class DriveFillTests(Case):
 """Logs whose rlog is only on Google Drive (tests/fake_drive.py): read only when asked, read-only, the download
 deleted at once; a sign-in problem marks nothing, a network error backs off, three failures skip the log."""
 def setUp(self):
  super().setUp()
  self.drive=FakeDrive().start();self.addCleanup(self.drive.stop)
  env=patch.dict(os.environ,self.drive.env());env.start();self.addCleanup(env.stop)
  self.http=ab.Http(sleep=lambda seconds:None,rand=lambda:0.0)
  auth=self.auth();auth.start_device_flow();self.assertEqual(auth.poll_once(),'granted')
  settings=self.settings(False);auth=self.auth()
  self.backend=ab.DriveBackend(settings,self.root,auth,ab.DriveClient(self.http,auth))
  for name,value in (('backend',self.backend),('store',media_store.ArchiveStore(settings,self.root))):
   patcher=patch.object(server,name,value);patcher.start();self.addCleanup(patcher.stop)
  patcher=patch.object(server,'archiver',media_store.Archiver(server,server.store,settings,backend=self.backend));patcher.start();self.addCleanup(patcher.stop)
  self.backend.activate();self.assertEqual(self.backend.probe(),('connected',None))
  with self.drive.lock:self.writes_before=len(self.writes())
  self.clock=Clock()
 def auth(self):return ab.DriveAuth(self.root/'.gdrive-auth.json','client-id','secret',self.http)
 def settings(self,fill):
  # The add-on's archive settings with the switch on or off (the backend reads its own copy for enabled).
  settings=media_store.ArchiveSettings(enabled=True,backend='gdrive',gdrive_client_id='client-id',gdrive_fill_tracks=fill)
  patcher=patch.object(server,'archive_settings',settings);patcher.start();self.addCleanup(patcher.stop)
  if hasattr(self,'backend'):self.backend.settings=settings
  return settings
 def fill_worker(self,busy=False):
  class List:
   def busy(self):return busy
  return gps_track.TrackBackfill(server,List(),pause=0,clock=self.clock)
 def writes(self):
  # Every request that could change something on Drive (sign-in requests aside).
  return [r for r in self.drive.requests if r['method']!='GET' and r['path'].split('?')[0] not in ('/token','/device/code','/revoke')]
 def downloads(self):
  with self.drive.lock:return [r for r in self.drive.requests if 'alt=media' in r['path']]
 def drive_log(self,id,name,content=None):
  """A converted log as 1.1.1 left it once its rlog was moved to Drive: version 2, has_track false, no track_read."""
  p=converted(self.root,id,self.events(),name);expected=gps_track.read(p/'prepared');self.forget(p)
  summary=p/'prepared/summary.json'
  summary.write_text(json.dumps({**json.loads(summary.read_text()),'track_v':gps_track.TRACK_V,'has_track':False,'track_distance_m':None,'track_bbox':None}))
  content=(p/'rlog.zst').read_bytes() if content is None else content
  with self.drive.lock:
   self.drive.file_count+=1;fid='f%d'%self.drive.file_count
   self.drive.files[fid]={'name':p.name+'--rlog.zst','mimeType':'application/octet-stream','parents':[self.backend.auth.folder_id],
                          'appProperties':{'rv_storage_id':self.backend.storage_id(),'rv_id':p.name,'rv_kind':'rlog.zst'},'content':content,'trashed':False,
                          'md5':hashlib.md5(content).hexdigest(),'sha256':hashlib.sha256(content).hexdigest()}
  m=server.read_meta(p);media_store.set_location(m,'rlog.zst',location='gdrive',file_id=fid,bytes=len(content),sha256=hashlib.sha256(content).hexdigest(),archived_at=1.0);server.save_meta(p,m)
  (p/'rlog.zst').unlink()
  return p,expected,fid
 def summary(self,p):return json.loads((p/'prepared/summary.json').read_text())
 def counts(self,worker):
  s=worker.status();return {k:s[k] for k in ('total','done','failed','pending')}
 def post(self,url,**kw):return self.client.post(url,environ_overrides=PEER,headers=HEADERS,**kw)
 def test_off_never_downloads_on_fills_read_only_and_deletes_the_download(self):
  p,expected,fid=self.drive_log('a'*32,'0000041b--c6f39793a8--1')
  with self.drive.lock:before=json.dumps(self.drive.files[fid],default=repr)
  meta_before=server.read_meta(p)['storage']
  worker=self.fill_worker()
  self.assertFalse(worker.run_once());self.assertEqual(self.downloads(),[])  # Off (the default): Drive is not read.
  self.assertFalse(self.summary(p)['has_track']);self.assertEqual(self.counts(worker),{'total':1,'done':0,'failed':0,'pending':1})
  self.settings(True);seen=[]
  real=gps_track.TrackBackfill.read
  def read(worker_self,q,rlog):
   seen.append(Path(rlog));self.assertTrue(Path(rlog).is_file());self.assertTrue(Path(rlog).parent.name.startswith('.track-'))
   self.assertEqual(Path(rlog).parent.parent,self.root);return real(worker_self,q,rlog)
  with patch.object(gps_track.TrackBackfill,'read',read):self.assertFalse(worker.run_once())
  self.assertEqual(gps_track.read(p/'prepared'),expected)  # The same route as a conversion would have kept.
  s=self.summary(p);self.assertEqual((s['has_track'],s['track_read']),(True,True));self.assertNotIn(gps_track.FAILURES,s)
  self.assertEqual(len(seen),1);self.assertFalse(seen[0].exists());self.assertEqual(list(self.root.glob('.track-*')),[])  # Deleted at once.
  self.assertFalse((p/'rlog.zst').exists())
  # Read-only: no request that writes, the Drive file and the archive index as they were.
  with self.drive.lock:self.assertEqual(len(self.writes()),self.writes_before);self.assertEqual(json.dumps(self.drive.files[fid],default=repr),before)
  self.assertEqual(server.read_meta(p)['storage'],meta_before)
  self.assertEqual(self.counts(worker),{'total':1,'done':1,'failed':0,'pending':0})
  self.assertFalse(worker.run_once());self.assertEqual(len(self.downloads()),1)  # Once.
 def test_a_sign_in_problem_marks_nothing_and_is_tried_again(self):
  p,expected,_=self.drive_log('b'*32,'0000041b--c6f39793a8--1');self.settings(True);before=self.summary(p)
  worker=self.fill_worker()
  with self.drive.lock:self.drive.scenario.fail_next('/drive/v3/files/'+self.backend.auth.folder_id,401,'authError',times=4)
  self.backend.invalidate()
  self.assertFalse(worker.run_once())  # Stopped until the next run: no back-off loop for something only the user can fix.
  self.assertEqual(self.summary(p),before);self.assertEqual(self.downloads(),[])
  self.assertEqual(worker.status()['last_error'],'auth_expired')
  with self.drive.lock:self.drive.scenario.failures.clear()
  self.backend.invalidate()
  self.assertFalse(worker.run_once());self.assertEqual(gps_track.read(p/'prepared'),expected);self.assertIsNone(worker.status()['last_error'])
 def test_network_errors_back_off(self):
  p,expected,_=self.drive_log('c'*32,'0000041b--c6f39793a8--1');self.settings(True);before=self.summary(p)
  worker=self.fill_worker()
  with self.drive.lock:self.drive.scenario.fail_next('alt=media',503,'backendError',times=100)
  self.assertTrue(worker.run_once())  # Tried again later.
  self.assertEqual(self.summary(p),before);status=worker.status()
  self.assertEqual(status['last_error'],'network');self.assertGreaterEqual(status['retry_in'],60);self.assertEqual(list(self.root.glob('.track-*')),[])
  asked=len(self.downloads())
  self.assertTrue(worker.run_once());self.assertEqual(len(self.downloads()),asked)  # Backing off: Drive is not asked.
  with self.drive.lock:self.drive.scenario.failures.clear()
  self.clock.now+=worker.BACKOFF_MAX+1
  self.assertFalse(worker.run_once());self.assertEqual(gps_track.read(p/'prepared'),expected)
 def test_three_failed_reads_skip_the_log_and_a_log_gone_from_drive_has_no_track(self):
  bad,_,_=self.drive_log('d'*32,'0000041b--c6f39793a8--1',content=b'not a log')
  gone,_,fid=self.drive_log('e'*32,'0000041b--c6f39793a8--2')
  with self.drive.lock:del self.drive.files[fid]
  self.settings(True);worker=self.fill_worker()
  for n in range(1,4):
   self.assertFalse(worker.run_once());self.assertEqual(self.summary(bad)[gps_track.FAILURES],n)
   self.assertEqual(list(self.root.glob('.track-*')),[])
  self.assertFalse(self.summary(bad)['has_track'])
  s=self.summary(gone);self.assertEqual((s['has_track'],s['track_read']),(False,True))
  asked=len(self.downloads());self.assertFalse(worker.run_once());self.assertEqual(len(self.downloads()),asked)  # Skipped now.
  self.assertEqual(self.counts(worker),{'total':2,'done':1,'failed':1,'pending':0})
 def test_waits_while_busy(self):
  p,_,_=self.drive_log('f'*32,'0000041b--c6f39793a8--1');self.settings(True)
  worker=self.fill_worker(busy=True)
  self.assertTrue(worker.run_once());self.assertEqual(self.downloads(),[])
  status=worker.status();self.assertEqual((status['running'],status['waiting']),(True,'busy'))
  self.assertFalse(self.summary(p)['has_track'])
 def test_run_once_with_the_switch_off_stop_and_no_second_pass(self):
  a,expected,_=self.drive_log('1'*32,'0000041b--c6f39793a8--1');b,_,_=self.drive_log('2'*32,'0000041b--c6f39793a8--2')
  worker=self.fill_worker()
  with patch.object(server,'track_backfill',worker):
   r=self.post('/api/settings/archive/tracks/run')
   self.assertEqual(r.status_code,202);self.assertTrue(r.json['track_fill']['manual']);self.assertTrue(worker.wake.is_set())
   r=self.post('/api/settings/archive/tracks/run')
   self.assertEqual((r.status_code,r.json['error']),(409,'track_fill_running'))  # Never two passes.
   # Stopped during the first log: the other one waits.
   real=gps_track.TrackBackfill.process_drive
   def process_drive(worker_self,p,m):
    real(worker_self,p,m);self.assertTrue(self.post('/api/settings/archive/tracks/stop').json['track_fill']['stopping'])
   with patch.object(gps_track.TrackBackfill,'process_drive',process_drive):self.assertFalse(worker.run_once())
   self.assertEqual(sum(self.summary(q)['has_track'] for q in (a,b)),1);self.assertFalse(worker.status()['manual'])
   self.assertFalse(worker.run_once());self.assertEqual(sum(self.summary(q)['has_track'] for q in (a,b)),1)  # Off: nothing more.
   # Once more: the rest, then it stops (the switch is still off).
   self.assertEqual(self.post('/api/settings/archive/tracks/run').status_code,202)
   self.assertFalse(worker.run_once());self.assertTrue(all(self.summary(q)['has_track'] for q in (a,b)))
   self.assertEqual(gps_track.read(a/'prepared'),expected)
   status=self.client.get('/api/settings/archive/tracks/run',environ_overrides=PEER).json['track_fill']
   self.assertEqual((status['manual'],status['running'],status['done'],status['total']),(False,False,2,2))
 def test_the_setting_persists_and_the_storage_block_shows_progress(self):
  p,_,_=self.drive_log('3'*32,'0000041b--c6f39793a8--1')
  worker=self.fill_worker();worker.scan()
  with patch.object(server,'track_backfill',worker):
   r=self.client.get('/api/settings/archive',environ_overrides=PEER);self.assertIs(r.json['archive_gdrive_fill_tracks'],False)
   r=self.post('/api/settings/archive',json={'archive_gdrive_fill_tracks':True})
   self.assertEqual(r.status_code,200,r.json);self.assertIs(r.json['archive_gdrive_fill_tracks'],True)
   self.assertTrue(worker.wake.is_set())  # Turned on: the first pass starts now.
   self.assertIs(json.loads((self.root/'.archive-settings.json').read_text())['archive_gdrive_fill_tracks'],True)
   import archive_settings as archive_config
   self.assertTrue(archive_config.load(self.root,{})[0].gdrive_fill_tracks)  # As after a restart.
   self.assertEqual(self.post('/api/settings/archive',json={'archive_gdrive_fill_tracks':'yes'}).status_code,400)
   block=self.client.get('/api/settings/storage',environ_overrides=PEER).json['archive']['track_fill']
   self.assertEqual((block['enabled'],block['total'],block['done'],block['pending']),(True,1,0,1))
   self.assertFalse(worker.run_once())
   block=self.client.get('/api/settings/storage',environ_overrides=PEER).json['archive']['track_fill']
   self.assertEqual((block['done'],block['pending'],block['running']),(1,0,False))
  self.assertNotIn(str(BASE_LON),self.client.get('/api/logs',environ_overrides=PEER).get_data(as_text=True))

if __name__=='__main__':unittest.main()
