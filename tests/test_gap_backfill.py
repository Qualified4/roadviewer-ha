"""The gap backfill (gap_backfill.py): gap and gapTarget filled into replays converted before 1.3.0 from the rlog alone,
equal to a fresh conversion, once per conversion, never alongside other work on the log, never leaving a broken file."""
import gzip,json,math,os,sys,tempfile,unittest
from pathlib import Path
from unittest.mock import patch
os.environ['RV_DATA']=tempfile.mkdtemp()
os.environ['RV_INGRESS_ONLY']='1'
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'roadviewer/app'))
import zstandard
import server,decoder,gap_backfill,media_store,compact

HEADERS={'REMOTE_ADDR':'172.30.32.2'}
def event(kind,mono,valid=True):
 e=decoder.log.Event.new_message();e.logMonoTime=mono;e.valid=valid;e.init(kind);return e
def events():
 out=[]
 for i in range(80):
  # 20 Hz model frames; camera time a little before logMonoTime, as on a device.
  stamp=round((10+i*.05)*1e9);e=event('modelV2',stamp)
  e.modelV2={'frameId':i,'timestampEof':stamp-30_000_000,'laneLines':[],'laneLineProbs':[],'roadEdges':[],'roadEdgeStds':[]}
  out.append(e)
  if i%3==0 or i==5:
   # The encode index gives the camera time where it has the frame; frame 5's lands after frame 6 (replay order != id order).
   q=event('qRoadEncodeIdx',stamp);q.qRoadEncodeIdx.frameId=i;q.qRoadEncodeIdx.segmentId=i
   q.qRoadEncodeIdx.timestampEof=round((10+6*.05)*1e9)-30_000_000+5_000_000 if i==5 else stamp-40_000_000;out.append(q)
 for i in range(36):
  # 10 Hz following-distance setting: every value 0..5 (only 1..4 are shown), some invalid, none from 12.0 to 12.6 s.
  mono=round((10+i*.1)*1e9)
  if 12.0<=10+i*.1<12.6:continue
  e=event('carControl',mono,valid=i%7!=3);e.carControl.hudControl.leadDistanceBars=i%6;out.append(e)
 for i in range(70):
  # 20 Hz planner target: positive values rounded, NaN, zero and negative ones are not a target.
  e=event('longitudinalPlan',round((10.007+i*.05)*1e9));value=[math.nan,0.0,-3.0][i%3] if i%11==0 else 8+i*.37
  e.longitudinalPlan.desiredDistance=value;out.append(e)
 for i in range(30):
  e=event('carState',round((10+i*.1)*1e9));e.carState.vEgo=10;out.append(e)  # Read by prepare, skipped by the backfill.
 out.sort(key=lambda e:e.logMonoTime)
 out[3],out[4]=out[4],out[3]  # Not quite in time order, as logs can be.
 return out
def rlog_bytes(items):return zstandard.ZstdCompressor().compress(b''.join(e.to_bytes() for e in items))
def converted(root,id):
 p=Path(root)/id;p.mkdir(parents=True);(p/'rlog.zst').write_bytes(rlog_bytes(events()))
 with patch.dict(os.environ,{'RV_PREPARED_DIR':str(p/'prepared'),'RV_RECORDING_DIR':str(p)}):decoder.prepare(p/'rlog.zst')
 server.save_meta(p,dict(id=id,name='0000041b--c6f39793a8--1',status='ready',uploaded=1,files={},decoder_version=server.DECODER_VERSION,video=False,conversion_revision=1))
 return p
def load(p):return json.loads(gzip.decompress((p/'prepared/data.json.gz').read_bytes()))
def summary(p):return json.loads((p/'prepared/summary.json').read_text())
def before_1_3(p):
 # A replay as converted before 1.3.0: no gap, no gapTarget, no mark.
 data=load(p)
 for frame in data['frames']:frame.pop('gap');frame.pop('gapTarget')
 compact.write_gzip_json(p/'prepared/data.json.gz',data,ensure_ascii=False)
 server.atomic_json(p/'prepared/summary.json',{k:v for k,v in summary(p).items() if k!=gap_backfill.MARK})
 return (p/'prepared/data.json.gz').read_bytes()

class Case(unittest.TestCase):
 def setUp(self):
  temp=tempfile.TemporaryDirectory();self.addCleanup(temp.cleanup);self.root=Path(temp.name)
  for patcher in (patch.object(server,'ROOT',self.root),patch.object(server,'upload_receiving',return_value=False),patch.object(server.list_backfill,'busy',return_value=False)):
   patcher.start();self.addCleanup(patcher.stop)
  self.p=converted(self.root,'a'*32);self.expected=load(self.p)
 def worker(self):return gap_backfill.GapBackfill(server,pause=0)
 def unchanged(self,old):
  self.assertEqual((self.p/'prepared/data.json.gz').read_bytes(),old)
  self.assertNotIn(gap_backfill.MARK,summary(self.p))
  self.assertEqual(list(self.root.glob(gap_backfill.GapBackfill.TEMP_PREFIX+'*')),[])  # Temporary copies are gone.

class FillTests(Case):
 def test_filled_values_equal_a_fresh_conversion_and_are_filled_once(self):
  frames=self.expected['frames']
  self.assertNotEqual([f['id'] for f in frames],sorted(f['id'] for f in frames))  # Replay order is camera time, not id.
  self.assertEqual({f['gap'] for f in frames},{1,2,3,4,None})
  self.assertIn(None,[f['gapTarget'] for f in frames]);self.assertTrue(any(isinstance(f['gapTarget'],float) for f in frames))
  old=before_1_3(self.p);client=server.app.test_client()
  etag=client.get(f'/api/logs/{self.p.name}/data?format=gzip',environ_overrides=HEADERS).headers['ETag']
  worker=self.worker()
  self.assertFalse(worker.run_once())
  self.assertNotEqual((self.p/'prepared/data.json.gz').read_bytes(),old)
  self.assertEqual(load(self.p),self.expected)  # The whole replay equals the conversion's, values and all.
  self.assertEqual(summary(self.p)[gap_backfill.MARK],1)
  response=client.get(f'/api/logs/{self.p.name}/data?format=gzip',environ_overrides=HEADERS)
  self.assertNotEqual(response.headers['ETag'],etag);self.assertEqual(json.loads(gzip.decompress(response.data)),self.expected)
  self.assertEqual(client.get(f'/api/logs/{self.p.name}/data',environ_overrides=HEADERS).json,self.expected)
  self.assertEqual(list(self.root.glob(gap_backfill.GapBackfill.TEMP_PREFIX+'*')),[])
  # Marked: neither this worker nor one after a restart reads it again.
  for again in (worker,self.worker()):
   with patch.object(gap_backfill,'has_gaps',side_effect=AssertionError('read again')),patch.object(media_store,'resolve',side_effect=AssertionError('read again')):
    self.assertFalse(again.run_once())
  # The list rows are unchanged by the mark.
  row=next(r for r in client.get('/api/logs',environ_overrides=HEADERS).json['logs'] if r['id']==self.p.name)
  self.assertNotIn(gap_backfill.MARK,row)

 def test_a_replay_with_the_values_is_marked_without_reading_the_log(self):
  old=(self.p/'prepared/data.json.gz').read_bytes();worker=self.worker()
  with patch.object(media_store,'resolve',side_effect=AssertionError('rlog read')),patch.object(worker,'read',side_effect=AssertionError('rlog read')):
   self.assertFalse(worker.run_once())
  self.assertEqual((self.p/'prepared/data.json.gz').read_bytes(),old);self.assertEqual(summary(self.p)[gap_backfill.MARK],1)
  self.assertEqual(self.worker().targets(),[])

 def test_older_replay_format_and_other_decoders_are_left_to_the_migration_and_conversion(self):
  old=before_1_3(self.p)
  server.atomic_json(self.p/'prepared/summary.json',{**summary(self.p),'replay_v':1})
  self.assertEqual(self.worker().targets(),[])
  server.atomic_json(self.p/'prepared/summary.json',{**summary(self.p),'replay_v':compact.REPLAY_V})
  server.save_meta(self.p,{**server.read_meta(self.p),'decoder_version':'v27-old'})
  self.assertEqual(self.worker().targets(),[])
  self.unchanged(old)

class UnreadableTests(Case):
 def test_unreadable_log_is_skipped_unmarked_until_the_next_start(self):
  old=before_1_3(self.p);rlog=(self.p/'rlog.zst').read_bytes();(self.p/'rlog.zst').unlink()
  worker=self.worker()
  self.assertFalse(worker.run_once());self.unchanged(old)
  (self.p/'rlog.zst').write_bytes(rlog)
  with patch.object(media_store,'resolve',side_effect=AssertionError('tried again before a restart')):self.assertFalse(worker.run_once())
  # After a restart: an unreachable archive, then a log that does not decode, are skipped the same way.
  with patch.object(media_store,'resolve',return_value=(None,'storage_unavailable')):self.assertFalse(self.worker().run_once())
  self.unchanged(old)
  (self.p/'rlog.zst').write_bytes(b'not a log')
  self.assertFalse(self.worker().run_once());self.unchanged(old)
  (self.p/'rlog.zst').write_bytes(rlog)
  self.assertFalse(self.worker().run_once());self.assertEqual(load(self.p),self.expected)

 def test_drive_log_is_read_from_a_temporary_copy_and_a_failed_download_is_skipped(self):
  old=before_1_3(self.p);rlog=self.p/'rlog.zst';remote=media_store.RemoteFile('gdrive',None,'rlog.zst',1,'"x"')
  staged=[]
  def stage(p,rf):
   self.assertIs(rf,remote);dest=p/'.staging'/'x'/'rlog.zst';dest.parent.mkdir(parents=True);dest.write_bytes(rlog.read_bytes());staged.append(dest);return dest
  with patch.object(media_store,'resolve',return_value=(remote,'available')),patch.object(server,'stage_remote',side_effect=OSError('network')):
   self.assertFalse(self.worker().run_once())
  self.unchanged(old)
  with patch.object(media_store,'resolve',return_value=(remote,'available')),patch.object(server,'stage_remote',side_effect=stage):
   self.assertFalse(self.worker().run_once())
  self.assertEqual(load(self.p),self.expected);self.assertEqual(len(staged),1);self.assertFalse((self.p/'.staging').exists())

class OverlapTests(Case):
 def test_processing_and_queued_logs_are_left_alone(self):
  old=before_1_3(self.p)
  with patch.dict(server.processes,{self.p.name:object()}):self.assertTrue(self.worker().run_once())  # Waits for the conversion.
  with patch.object(server.pool,'pending',['b'*32]):self.assertTrue(self.worker().run_once())  # A queued conversion goes first.
  for status in ('queued','processing','unconverted'):
   server.save_meta(self.p,{**server.read_meta(self.p),'status':status});self.assertEqual(self.worker().targets(),[])
  self.unchanged(old)

 def test_a_conversion_requested_while_reading_wins(self):
  old=before_1_3(self.p);worker=self.worker();read=worker.read
  def requested(p,m,*args):
   # The user asks for this log while the child reads it: queued (the child is stopped) or already reconverting.
   with server.lock:server.save_meta(p,{**server.read_meta(p),'status':'queued','conversion_revision':2})
   return read(p,m,*args)
  with patch.object(worker,'read',side_effect=requested):self.assertTrue(worker.run_once())
  self.unchanged(old)
  server.save_meta(self.p,{**server.read_meta(self.p),'status':'ready','conversion_revision':1})
  with patch.object(worker,'read',side_effect=lambda p,m,*args:(server.pool.pending.append(p.name),read(p,m,*args))[1]):
   try:self.assertTrue(worker.run_once())
   finally:server.pool.pending.clear()
  self.unchanged(old)
  self.assertFalse(worker.run_once());self.assertEqual(load(self.p),self.expected)  # Once nothing else runs.

class WriteFailureTests(Case):
 def test_an_error_while_writing_keeps_the_old_replay(self):
  old=before_1_3(self.p);worker=self.worker()
  def broken(path,value,**options):Path(path).write_bytes(b'\x1f\x8b partial');raise OSError('disk full')
  # The child's work in this process, failing half way through its file.
  with patch.object(worker,'read',side_effect=lambda p,m,rlog,data,out:gap_backfill.fill(rlog,data,out)),patch.object(compact,'write_gzip_json',side_effect=broken):
   self.assertFalse(worker.run_once())
  self.unchanged(old)
  # Failing while moving the new file into place.
  with patch.object(gap_backfill.os,'replace',side_effect=OSError('io')):self.assertFalse(self.worker().run_once())
  self.unchanged(old)
  # The replay replaced meanwhile (another writer): the child's result is not moved over it.
  worker=self.worker();read=worker.read
  def replaced(p,m,rlog,data,out):
   result=read(p,m,rlog,data,out);compact.write_gzip_json(data,{**load(p),'route':'other'},ensure_ascii=False);return result
  with patch.object(worker,'read',side_effect=replaced):self.assertTrue(worker.run_once())  # Left for the next pass.
  self.assertEqual(load(self.p)['route'],'other');self.assertNotIn(gap_backfill.MARK,summary(self.p))

if __name__=='__main__':unittest.main()
