"""The drive's wall-clock start (started_at) read from the log: at conversion and for logs converted before."""
import json,os,sys,tempfile,time,unittest
from pathlib import Path
from unittest.mock import patch
os.environ.setdefault('RV_DATA',tempfile.mkdtemp())
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'roadviewer/app'))
import zstandard
import decoder,server,wall_clock
from test_thumbnails import ServerCase,PEER
START=1762400000.0 # 2025-11-06, a plausible drive.

def event(kind,mono,**fields):
 e=decoder.log.Event.new_message();e.logMonoTime=mono;e.valid=True;e.init(kind)
 for key,value in fields.items():setattr(getattr(e,kind),key,value)
 return e.to_bytes()

def rlog(path,messages):path.write_bytes(zstandard.ZstdCompressor().compress(b''.join(messages)));return path

class PickTests(unittest.TestCase):
 def test_preference_offset_and_plausibility(self):
  now=START+3600
  # The clock wins over initData, moved back to the segment's first logMonoTime (the reading came 2 s later).
  self.assertEqual(wall_clock.pick_start(10_000_000_000,init=(10_000_000_000,START+50),clocks=(12_000_000_000,START+2),now=now),START)
  # A clock never set (1970) or set far ahead is skipped for the next source.
  self.assertEqual(wall_clock.pick_start(0,init=(0,86400.),clocks=(1_000_000_000,START+1),now=now),START)
  self.assertEqual(wall_clock.pick_start(0,init=(0,now+2*86400),gps=(500_000_000,START+.5),now=now),START)
  self.assertEqual(wall_clock.pick_start(0,init=(0,now+3600),now=now),now+3600) # Within a day ahead: kept.
  self.assertIsNone(wall_clock.pick_start(0,init=(0,1e9),clocks=None,gps=(0,now+90000),now=now))
  self.assertIsNone(wall_clock.pick_start(0))

def gps(mono,unix,kind='gpsLocationExternal',fix=True):
 e=decoder.log.Event.new_message();e.logMonoTime=mono;e.valid=True;e.init(kind)
 getattr(e,kind).hasFix=fix;getattr(e,kind).unixTimestampMillis=int(unix*1000)
 return e.to_bytes()

STALE=START-30*3600 # The last shutdown: a device clock not yet synced when the route started.

class ScanTests(unittest.TestCase):
 def setUp(self):self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup);self.root=Path(self.temp.name)
 def start(self,path,**options):return wall_clock.scan(path,**options)['started_at']
 def test_init_data_then_clocks_without_gps(self):
  path=rlog(self.root/'a.zst',[event('carState',4_000_000_000),event('initData',5_000_000_000,wallTimeNanos=int((START+1)*1e9)),event('clocks',6_000_000_000,wallTimeNanos=int((START+99)*1e9))])
  fields=wall_clock.scan(path)
  # The clock wins over initData (a copy of the route's start record), moved back 2 s to the first message.
  self.assertEqual(fields,{'started_at':START+97,'start_source':'clock','first_mono':4_000_000_000,'gps_offset':None,'clock_offset':START+93,'start_v':3})
  path=rlog(self.root/'b.zst',[event('initData',1_000_000_000),event('clocks',3_000_000_000,wallTimeNanos=int((START+2)*1e9))])
  self.assertEqual(self.start(path),START+2) # initData's own logMonoTime is the route's, not the segment's.
  self.assertEqual(wall_clock.scan(rlog(self.root/'none.zst',[event('carState',1)])),{'started_at':None,'start_source':None,'first_mono':1,'gps_offset':None,'clock_offset':None,'start_v':3})
 def test_gps_preferred_over_a_stale_device_clock(self):
  for kind in ('gpsLocationExternal','gpsLocation'):
   path=rlog(self.root/'c.zst',[event('initData',1_000_000_000,wallTimeNanos=int(STALE*1e9)),event('clocks',1_200_000_000,wallTimeNanos=int(STALE*1e9)),
    gps(1_500_000_000,START,fix=False),gps(2_000_000_000,START+1,kind=kind),gps(3_000_000_000,START+999)])
   fields=wall_clock.scan(path)
   self.assertEqual((fields['started_at'],fields['start_source'],fields['first_mono']),(START+.2,'gps',1_200_000_000))
   self.assertAlmostEqual(fields['gps_offset'],START+1-2.0,places=3)
 def test_gps_after_thousands_of_messages_is_found(self):
  filler=[event('carState',1_000_000_000+i*1000) for i in range(5000)]
  path=rlog(self.root/'late.zst',[event('initData',1_000_000_000,wallTimeNanos=int(STALE*1e9)),*filler,gps(4_000_000_000,START+3)])
  self.assertEqual(wall_clock.scan(path)['start_source'],'gps');self.assertEqual(self.start(path),START)
  self.assertEqual(wall_clock.scan(path,messages=2000)['start_source'],'device') # The old message cap missed it.
  # A byte limit that cuts a message in half keeps the whole messages before it.
  size=len(event('initData',1,wallTimeNanos=1))
  self.assertEqual(self.start(rlog(self.root/'cut.zst',[event('initData',1_000_000_000,wallTimeNanos=int(START*1e9)),*filler]),limit=size+10),START)
  with self.assertRaises(zstandard.ZstdError):wall_clock.scan(self.write(b'not zstd'))
 def write(self,data):path=self.root/'bad.zst';path.write_bytes(data);return path

class DecoderTests(unittest.TestCase):
 def test_conversion_stores_started_at(self):
  with tempfile.TemporaryDirectory() as root:
   model=decoder.log.Event.new_message();model.logMonoTime=10_000_000_000;model.valid=True
   model.init('modelV2');model.modelV2={'frameId':0,'timestampEof':model.logMonoTime,'laneLines':[],'laneLineProbs':[],'roadEdges':[],'roadEdgeStds':[]}
   model=model.to_bytes()
   src=rlog(Path(root)/'rlog.zst',[event('initData',9_000_000_000,wallTimeNanos=int(START*1e9)),model])
   dest,_=decoder.prepare(src)
   saved=json.loads((dest/'summary.json').read_text())
   self.assertEqual((saved['started_at'],saved['start_source'],saved['first_mono'],saved['start_v']),(START+1,'device',10_000_000_000,3))
   src=rlog(Path(root)/'rlog.zst',[event('initData',9_000_000_000,wallTimeNanos=int(STALE*1e9)),model,gps(11_000_000_000,START+2)])
   dest,_=decoder.prepare(src);saved=json.loads((dest/'summary.json').read_text())
   self.assertEqual((saved['started_at'],saved['start_source']),(START+1,'gps'));self.assertAlmostEqual(saved['gps_offset'],START-9,places=3)
   src=rlog(Path(root)/'rlog.zst',[model])
   dest,_=decoder.prepare(src)
   self.assertIsNone(json.loads((dest/'summary.json').read_text())['started_at'])

class ServerTests(ServerCase):
 def saved(self):return json.loads((self.prepared/'summary.json').read_text())
 def backfill(self):
  import backfill
  with patch.object(server,'upload_receiving',return_value=False):return backfill.Backfill(server,pause=0).run_once()
 def test_backfilled_once_from_a_local_log(self):
  self.summary(drive_summary=None);rlog(self.path/'rlog.zst',[event('initData',1_000_000_000,wallTimeNanos=int(START*1e9))])
  # The list never reads the log: the backfill does, once.
  with patch.object(wall_clock,'scan_bytes',side_effect=AssertionError('read by the list')):self.assertNotIn('started_at',self.row())
  self.assertEqual(self.backfill(),(1,False))
  self.assertEqual(self.row()['started_at'],START);self.assertEqual(self.saved()['started_at'],START)
  self.assertEqual((self.row()['start_source'],self.saved()['start_v']),('device',3));self.assertNotIn('first_mono',self.row())
  with patch.object(wall_clock,'scan_bytes',side_effect=AssertionError('read again')):self.assertEqual(self.backfill(),(0,False))
  self.summary(drive_summary=None,started_at=START+60);self.assertEqual(self.row()['started_at'],START+60)
 def test_unknown_is_cached_and_unready_logs_are_not_read(self):
  self.summary(drive_summary=None) # rlog.zst holds b'log': not a readable log.
  with self.assertLogs('backfill','WARNING'):self.backfill()
  self.assertNotIn('started_at',self.row())
  self.assertIn('started_at',self.saved());self.assertIsNone(self.saved()['started_at'])
  self.summary(drive_summary=None)
  with patch.object(wall_clock,'scan_bytes',side_effect=AssertionError('must not read')):
   server.save_meta(self.path,dict(server.read_meta(self.path),status='processing'));self.backfill();self.assertNotIn('started_at',self.row())
  self.assertNotIn('started_at',self.saved())

class RouteStartTests(ServerCase):
 def segment(self,id,name,**start):
  p=self.root/id;(p/'prepared').mkdir(parents=True);(p/'rlog.zst').write_bytes(b'log')
  server.save_meta(p,dict(id=id,name=name,status='ready',uploaded=1,decoder_version='v28-runtime-geometry',video=False,conversion_revision=1))
  (p/'prepared/summary.json').write_text(json.dumps(dict(duration=60,warnings=[],model_frames=1,video=None,videos={},start_v=2,**start)))
 def rows(self):return {row['id']:row for row in self.client.get('/api/logs',environ_overrides=PEER).json['logs']}
 def test_route_without_gps_dated_from_its_latest_clock(self):
  # No GPS fix anywhere (common): the first segment read a clock not yet synced; the latest segment's clock is right
  # and, with the continuous logMonoTime, dates every segment of the route.
  synced=START-40 # wall - logMonoTime/1e9 once the clock is synced.
  self.segment('7'*32,'0000044e--cdf / 구간 0',first_mono=40_000_000_000,started_at=STALE,start_source='clock',gps_offset=None,clock_offset=STALE-40)
  self.segment('8'*32,'0000044e--cdf / 구간 1',first_mono=100_000_000_000,started_at=START+60,start_source='clock',gps_offset=None,clock_offset=synced)
  self.segment('9'*32,'0000044e--cdf / 구간 7',first_mono=460_000_000_000,started_at=START+420,start_source='clock',gps_offset=None,clock_offset=synced)
  rows=self.rows()
  self.assertEqual([rows[k*32]['started_at'] for k in '789'],[START,START+60,START+420])
  self.assertEqual({rows[k*32]['start_source'] for k in '789'},{'clock'})
  for row in rows.values():self.assertNotIn('clock_offset',row)
 def test_segments_without_gps_dated_from_their_route(self):
  device=dict(started_at=STALE,start_source='device',gps_offset=None)
  offset=START-100 # unix - logMonoTime/1e9, from segment 2's GPS fix (the nearest to 1 and 3).
  self.segment('1'*32,'0000044c--abc / 구간 0',first_mono=40_000_000_000,**device)
  self.segment('2'*32,'0000044c--abc / 구간 1',first_mono=100_000_000_000,**device)
  self.segment('3'*32,'0000044c--abc / 구간 2',first_mono=160_000_000_000,started_at=START+60,start_source='gps',gps_offset=offset)
  self.segment('4'*32,'0000044c--abc / 구간 5',first_mono=340_000_000_000,started_at=START+240,start_source='gps',gps_offset=offset+.5)
  self.segment('5'*32,'0000044c--abc / 구간 3',**device) # Converted before first_mono: kept.
  self.segment('6'*32,'0000044d--def / 구간 0',first_mono=5_000_000_000,**device) # No GPS in its route: kept.
  rows=self.rows()
  self.assertEqual((rows['1'*32]['started_at'],rows['1'*32]['start_source']),(START-60,'gps'))
  self.assertEqual(rows['2'*32]['started_at'],START)
  self.assertEqual((rows['3'*32]['started_at'],rows['4'*32]['started_at']),(START+60,START+240))
  self.assertEqual((rows['5'*32]['started_at'],rows['5'*32]['start_source']),(STALE,'device'))
  self.assertEqual((rows['6'*32]['started_at'],rows['6'*32]['start_source']),(STALE,'device'))
  for row in rows.values():self.assertNotIn('first_mono',row);self.assertNotIn('gps_offset',row)
  # The cached rows are not changed by the correction.
  with patch.object(server,'LIST_RACY_SECONDS',-60):self.assertEqual(self.rows()['1'*32]['started_at'],START-60)
  self.assertEqual(self.rows()['1'*32]['started_at'],START-60)
  self.assertEqual(server.list_rows['1'*32][1]['started_at'],STALE)

if __name__=='__main__':unittest.main()
