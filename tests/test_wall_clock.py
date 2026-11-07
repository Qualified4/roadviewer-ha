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
  # Moved back to the segment's first logMonoTime: initData came 2 s after the first message.
  self.assertEqual(wall_clock.pick_start(10_000_000_000,init=(12_000_000_000,START+2),clocks=(10_000_000_000,START+50),now=now),START)
  # A clock never set (1970) or set far ahead is skipped for the next source.
  self.assertEqual(wall_clock.pick_start(0,init=(0,86400.),clocks=(1_000_000_000,START+1),now=now),START)
  self.assertEqual(wall_clock.pick_start(0,init=(0,now+2*86400),gps=(500_000_000,START+.5),now=now),START)
  self.assertEqual(wall_clock.pick_start(0,init=(0,now+3600),now=now),now+3600) # Within a day ahead: kept.
  self.assertIsNone(wall_clock.pick_start(0,init=(0,1e9),clocks=None,gps=(0,now+90000),now=now))
  self.assertIsNone(wall_clock.pick_start(0))

class ScanTests(unittest.TestCase):
 def setUp(self):self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup);self.root=Path(self.temp.name)
 def test_init_data_then_clocks_then_gps(self):
  path=rlog(self.root/'a.zst',[event('carState',4_000_000_000),event('initData',5_000_000_000,wallTimeNanos=int((START+1)*1e9)),event('clocks',6_000_000_000,wallTimeNanos=int((START+99)*1e9))])
  self.assertEqual(wall_clock.scan(path),START) # Moved back 1 s to the first message; initData wins over clocks.
  path=rlog(self.root/'b.zst',[event('initData',1_000_000_000),event('clocks',3_000_000_000,wallTimeNanos=int((START+2)*1e9))])
  self.assertEqual(wall_clock.scan(path),START)
  gps=decoder.log.Event.new_message();gps.logMonoTime=1_500_000_000;gps.valid=True;gps.init('gpsLocationExternal')
  gps.gpsLocationExternal.hasFix=True;gps.gpsLocationExternal.unixTimestampMillis=int((START+.5)*1000)
  path=rlog(self.root/'c.zst',[event('initData',1_000_000_000),gps.to_bytes()])
  self.assertEqual(wall_clock.scan(path),START)
 def test_reads_only_the_first_messages(self):
  filler=[event('carState',1_000_000_000+i) for i in range(30)]
  path=rlog(self.root/'late.zst',[event('initData',1_000_000_000),*filler,event('clocks',2_000_000_000,wallTimeNanos=int((START+1)*1e9))])
  self.assertIsNone(wall_clock.scan(path,messages=20))
  self.assertEqual(wall_clock.scan(path),START)
  # A byte limit that cuts a message in half keeps the whole messages before it.
  size=len(event('initData',1,wallTimeNanos=1))
  self.assertEqual(wall_clock.scan(rlog(self.root/'cut.zst',[event('initData',1_000_000_000,wallTimeNanos=int(START*1e9)),*filler]),limit=size+10),START)
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
   self.assertEqual(json.loads((dest/'summary.json').read_text())['started_at'],START)
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

if __name__=='__main__':unittest.main()
