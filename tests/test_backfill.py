"""The background backfill of thumbnails and start times (backfill.py) for older and archived logs: NAS files read
in place, Drive files only through bounded ranged downloads, throttled, backing off on Drive errors, and caching
only real "no data" results."""
import json,os,sys,tempfile,unittest
from pathlib import Path
from unittest.mock import patch
sys.path.insert(0,str(Path(__file__).resolve().parent))
import test_gdrive_server as gs  # Sets RV_DATA and imports the server module.
from test_media_integration import make_log,make_nas
import av,zstandard
import server,decoder,backfill,wall_clock,media_store
START=1762400000.0

def rlog(start=START,filler=0):
 messages=[]
 e=decoder.log.Event.new_message();e.logMonoTime=1_000_000_000;e.valid=True;e.init('initData')
 if start:e.initData.wallTimeNanos=int(start*1e9)
 messages.append(e.to_bytes())
 for i in range(filler):
  e=decoder.log.Event.new_message();e.logMonoTime=1_000_000_000+i;e.valid=True;e.init('carState');e.carState.vEgo=i;messages.append(e.to_bytes())
 return zstandard.ZstdCompressor().compress(b''.join(messages))

def video(path,frames=30,faststart=True,format=None):
 # A flat first frame (small, inside any prefix) then noise, so the file is much larger than the prefix.
 options={'movflags':'+faststart'} if faststart and not format else {}
 with av.open(str(path),'w',format=format,options=options) as out:
  stream=out.add_stream('libx264',rate=20);stream.width=160;stream.height=96;stream.pix_fmt='yuv420p'
  stream.options={'preset':'ultrafast','crf':'0'}
  for i in range(frames):
   frame=av.VideoFrame(160,96,'yuv420p')
   for plane in frame.planes:plane.update(bytes([128])*plane.buffer_size if i<20 else os.urandom(plane.buffer_size))
   for packet in stream.encode(frame):out.mux(packet)
  for packet in stream.encode():out.mux(packet)
 return path.read_bytes()

def summary(p,**extra):(p/'prepared'/'summary.json').write_text(json.dumps(dict(duration=1,warnings=[],model_frames=1,videos={},**extra)))
def saved(p):return json.loads((p/'prepared'/'summary.json').read_text())

class NasBackfillTests(unittest.TestCase):
 def setUp(self):
  temp=tempfile.TemporaryDirectory();self.addCleanup(temp.cleanup);self.root=Path(temp.name)
  self.nas,self.store=make_nas(self.root)
  for patcher in (patch.object(server,'ROOT',self.root),patch.object(server,'store',self.store),patch.object(server,'upload_receiving',return_value=False)):
   patcher.start();self.addCleanup(patcher.stop)
  self.worker=backfill.Backfill(server,pause=0)
 def log(self,id,files):
  p=make_log(self.root,id,[],list(files),nas=self.nas)
  for kind,data in files.items():(self.nas/id/kind).write_bytes(data)
  m=server.read_meta(p);m.update(status='ready',decoder_version='v28-runtime-geometry');server.save_meta(p,m);summary(p)
  return p
 def test_nas_files_read_in_place(self):
  with tempfile.TemporaryDirectory() as temp:ts=video(Path(temp)/'qcamera.ts',format='mpegts')
  p=self.log('a'*32,{'rlog.zst':rlog(),'qcamera.ts':ts})
  self.assertTrue(server.thumbnail_pending(p,server.read_meta(p)))
  self.assertEqual(self.worker.run_once(),(1,False))
  self.assertEqual(saved(p)['started_at'],START)
  with av.open(str(p/'prepared/thumbnail.jpg')) as image:self.assertEqual(image.streams.video[0].width,320)
  self.assertFalse(any(self.root.glob('.thumbnail-*')))
  self.assertEqual(self.worker.run_once(),(0,False)) # Nothing left to do.
 def test_failures_cached_per_conversion_and_unreachable_share_not(self):
  p=self.log('b'*32,{'rlog.zst':rlog(start=None),'qcamera.ts':b'not a video'})
  self.assertEqual(self.worker.run_once(),(1,False))
  self.assertIsNone(saved(p)['started_at']);self.assertTrue((p/'prepared/thumbnail.failed').exists())
  self.assertFalse(server.thumbnail_pending(p,server.read_meta(p)))
  with patch('thumbnail.make_thumbnail',side_effect=AssertionError('read again')):self.assertEqual(self.worker.run_once(),(0,False))
  # The share is gone: nothing is cached, and the run stops and backs off.
  q=self.log('c'*32,{'rlog.zst':rlog(),'qcamera.ts':b'x'})
  with patch.object(self.store,'available',return_value=False):self.assertEqual(self.worker.run_once(),(0,True))
  self.assertNotIn('started_at',saved(q));self.assertFalse((q/'prepared/thumbnail.failed').exists())
  self.assertEqual(self.worker.backoff,backfill.BACKOFF_START);self.assertGreater(self.worker.retry_at,0)
 def test_starts_without_start_v_are_read_again_from_gps(self):
  # Before start_v 2 the stale device clock (initData) won: three drives of a day showed the same time.
  stale=START-30*3600;messages=[]
  e=decoder.log.Event.new_message();e.logMonoTime=1_000_000_000;e.valid=True;e.init('initData');e.initData.wallTimeNanos=int(stale*1e9);messages.append(e.to_bytes())
  e=decoder.log.Event.new_message();e.logMonoTime=3_000_000_000;e.valid=True;e.init('gpsLocationExternal')
  e.gpsLocationExternal.hasFix=True;e.gpsLocationExternal.unixTimestampMillis=int((START+2)*1000);messages.append(e.to_bytes())
  p=self.log('e'*32,{'rlog.zst':zstandard.ZstdCompressor().compress(b''.join(messages))});summary(p,started_at=stale)
  q=self.log('f'*32,{'rlog.zst':b'not a log'});summary(q,started_at=stale)
  done=self.log('9'*32,{'rlog.zst':rlog()});summary(done,started_at=START+5,start_source='gps',start_v=2)
  with self.assertLogs('backfill','WARNING'):self.assertEqual(self.worker.run_once(),(3,False))
  self.assertEqual({k:saved(p)[k] for k in wall_clock.FIELDS},{'started_at':START,'start_source':'gps','first_mono':1_000_000_000,'gps_offset':START-1,'start_v':2})
  # No readable log: the old start is kept, marked as the device clock, and not tried again.
  self.assertEqual({k:saved(q)[k] for k in wall_clock.FIELDS},{'started_at':stale,'start_source':'device','first_mono':None,'gps_offset':None,'start_v':2})
  self.assertEqual(saved(done)['started_at'],START+5) # Already start_v 2: not read again.
  with patch.object(wall_clock,'scan_bytes',side_effect=AssertionError('read again')):self.assertEqual(self.worker.run_once(),(0,False))
 def test_result_dropped_when_the_conversion_changed_meanwhile(self):
  p=self.log('d'*32,{'rlog.zst':rlog()})
  real=backfill.Backfill.started_at
  def reconverted(worker,p,m):
   value=real(worker,p,m);current=server.read_meta(p);current['conversion_revision']=current.get('conversion_revision',0)+1;server.save_meta(p,current)
   return value
  with patch.object(backfill.Backfill,'started_at',reconverted):self.worker.run_once()
  self.assertNotIn('started_at',saved(p))

class ThrottleTests(unittest.TestCase):
 def setUp(self):
  temp=tempfile.TemporaryDirectory();self.addCleanup(temp.cleanup);self.root=Path(temp.name)
  for patcher in (patch.object(server,'ROOT',self.root),patch.object(server,'upload_receiving',return_value=False)):patcher.start();self.addCleanup(patcher.stop)
  self.ids=[c*32 for c in 'abc']
  for id in self.ids:
   p=make_log(self.root,id,['rlog.zst'],[]);(p/'rlog.zst').write_bytes(rlog());summary(p)
   m=server.read_meta(p);m.update(status='ready');server.save_meta(p,m)
  self.worker=backfill.Backfill(server,pause=2.0,run_cap=2)
  self.pauses=[];patcher=patch.object(self.worker.stopped,'wait',side_effect=self.pauses.append);patcher.start();self.addCleanup(patcher.stop)
 def test_cap_pause_priority_and_busy(self):
  self.worker.wake(self.ids[0])
  with patch.object(self.worker,'process',wraps=self.worker.process) as process:
   self.assertEqual(self.worker.run_once(),(2,True)) # Capped: more next time, soon.
  self.assertEqual(process.call_args_list[0].args[0].name,self.ids[0]) # Asked for first.
  self.assertEqual(self.pauses,[2.0,2.0])
  self.assertEqual(self.worker.run_once(),(1,False))
  for id in self.ids:self.assertEqual(saved(self.root/id)['started_at'],START)
  for id in self.ids:summary(self.root/id)
  entry=type('Entry',(),{'used':server.playback.clock()})()
  for busy in (patch.object(server,'processes',{'x':1}),patch.object(server,'upload_receiving',return_value=True),
               patch.object(server.archiver,'running',True),patch.object(server.playback,'entry',entry)):
   with self.subTest(busy=busy),busy,patch.object(self.worker,'process',side_effect=AssertionError('worked while busy')):
    self.assertEqual(self.worker.run_once(),(0,True))
  old=type('Entry',(),{'used':server.playback.clock()-backfill.WATCHING_SECONDS-1})()
  with patch.object(server.playback,'entry',old):self.assertEqual(self.worker.run_once()[0],2) # Watched long ago: not busy.

class OrderAndFailureTests(unittest.TestCase):
 # Local logs (no archive needed): what matters is which log is processed when, and what one failure stops.
 def setUp(self):
  temp=tempfile.TemporaryDirectory();self.addCleanup(temp.cleanup);self.root=Path(temp.name)
  for patcher in (patch.object(server,'ROOT',self.root),patch.object(server,'upload_receiving',return_value=False)):patcher.start();self.addCleanup(patcher.stop)
  self.worker=backfill.Backfill(server,pause=0)
 def log(self,id,name):
  p=make_log(self.root,id,['rlog.zst'],[]);(p/'rlog.zst').write_bytes(rlog());summary(p)
  m=server.read_meta(p);m.update(status='ready',name=name);server.save_meta(p,m)
  return p
 def order(self):
  seen=[]
  with patch.object(self.worker,'process',side_effect=lambda p,m,need:seen.append(p.name)):self.worker.run_once()
  return seen
 def test_first_segment_of_every_drive_first_newest_drive_first(self):
  old=[self.log(c*32,'0000041b--c6f39793a8--%d'%i) for i,c in enumerate('abc')]
  new=[self.log(c*32,'0000041c--d6f39793a8--%d'%i) for i,c in enumerate('def')]
  self.assertEqual(self.order(),[new[0].name,old[0].name,new[2].name,new[1].name,old[2].name,old[1].name])
 def test_an_unreadable_log_does_not_stop_the_others_and_goes_last(self):
  logs=[self.log(c*32,'0000041b--c6f39793a8--%d'%i) for i,c in enumerate('abcd')]
  bad={logs[0].name:backfill.Transient('rlog.zst storage_unavailable'),logs[1].name:RuntimeError('boom')}
  real=self.worker.process
  def process(p,m,need):
   if p.name in bad:raise bad[p.name]
   real(p,m,need)
  with patch.object(self.worker,'process',side_effect=process),self.assertLogs('backfill','WARNING'):
   self.assertEqual(self.worker.run_once(),(2,False))
  self.assertEqual(self.worker.backoff,0) # Others worked: the archive is up, nothing backs off.
  for p in logs[2:]:self.assertEqual(saved(p)['started_at'],START)
  for p in logs[:2]:self.assertNotIn('started_at',saved(p)) # Nothing cached for them.
  # Next run: the readable logs are done, the two that failed come last (here: alone), in list order.
  self.log('f'*32,'0000041b--c6f39793a8--9')
  self.assertEqual(self.order(),['f'*32,logs[0].name,logs[1].name])
  self.assertEqual(self.worker.run_once(),(3,False));self.assertFalse(self.worker.deferred) # Readable again.
 def test_logs_unreadable_in_a_row_back_off(self):
  logs=[self.log(c*32,'0000041b--c6f39793a8--%d'%i) for i,c in enumerate('abcde')]
  with patch.object(self.worker,'process',side_effect=backfill.Transient('gdrive down')) as process,self.assertLogs('backfill','WARNING'):
   self.assertEqual(self.worker.run_once(),(0,True))
  self.assertEqual(process.call_count,backfill.TRANSIENT_LIMIT);self.assertEqual(self.worker.backoff,backfill.BACKOFF_START)

class DriveBackfillTests(gs.GdriveServerTests):
 def setUp(self):
  super().setUp()
  self.worker=backfill.Backfill(server,pause=0)
  for patcher in (patch.object(backfill,'PREFIX_BYTES',64*1024),patch.object(wall_clock,'SCAN_BYTES',8*1024)):patcher.start();self.addCleanup(patcher.stop)
 def media_requests(self):
  with self.drive.lock:return [r for r in self.drive.requests if r['method']=='GET' and 'alt=media' in r['path']]
 def archived(self,id,faststart=True,log=None):
  with tempfile.TemporaryDirectory() as temp:mp4=video(Path(temp)/'camera.mp4',frames=60,faststart=faststart)
  log=log or rlog(filler=3000)
  p=self.log(id,{'rlog.zst':log,'camera.mp4':mp4});self.ready(p);summary(p)
  self.move()
  m=server.read_meta(p);self.assertEqual(media_store.location(m,'camera.mp4'),'gdrive');self.assertFalse((p/'camera.mp4').exists())
  return p,mp4,log
 def ranges(self):
  out=[]
  for r in self.media_requests():
   header=r['headers'].get('Range');self.assertIsNotNone(header,'a Drive file was downloaded without a range')
   start,end=header.split('=')[1].split('-');out.append((int(start),int(end)))
  return out
 def test_prefix_only_from_drive(self):
  p,mp4,log=self.archived('a'*32)
  self.assertGreater(len(log),wall_clock.SCAN_BYTES);self.assertGreater(len(mp4),4*backfill.PREFIX_BYTES)
  self.assertIs(self.get_row(p)['thumbnail_available'],True)
  self.assertEqual(self.worker.run_once(),(1,False))
  self.assertEqual(saved(p)['started_at'],START)
  self.assertTrue((p/'prepared/thumbnail.jpg').is_file());self.assertFalse((p/'camera.mp4').exists()) # Thumbnail local, video stays on Drive.
  self.assertEqual(sorted(self.ranges()),[(0,wall_clock.SCAN_BYTES-1),(0,backfill.PREFIX_BYTES-1)])
 def test_moov_at_the_end_is_fetched_as_its_own_range(self):
  p,mp4,_=self.archived('b'*32,faststart=False)
  moov=[(o,s) for o,k,s in backfill.mp4_atoms(mp4) if k==b'moov'][0];self.assertGreater(moov[0],backfill.PREFIX_BYTES)
  self.worker.run_once()
  self.assertTrue((p/'prepared/thumbnail.jpg').is_file())
  self.assertIn((moov[0],moov[0]+moov[1]-1),self.ranges())
  self.assertLess(sum(e-s+1 for s,e in self.ranges()),len(mp4)) # Never the whole video.
 def test_moov_too_large_is_unsupported_and_cached(self):
  p,mp4,_=self.archived('c'*32,faststart=False)
  with patch.object(backfill,'MOOV_MAX',16):self.worker.run_once()
  self.assertFalse((p/'prepared/thumbnail.jpg').exists());self.assertTrue((p/'prepared/thumbnail.failed').exists())
  self.assertEqual(saved(p)['started_at'],START)
 def test_drive_errors_back_off_without_caching(self):
  p,_,_=self.archived('d'*32)
  self.drive.scenario.fail_next('alt=media',503,'backendError',times=100)
  self.assertEqual(self.worker.run_once(),(0,True))
  self.assertNotIn('started_at',saved(p));self.assertFalse((p/'prepared/thumbnail.failed').exists())
  self.assertEqual(self.worker.backoff,backfill.BACKOFF_START)
  self.worker.run_once();self.assertEqual(self.worker.backoff,2*backfill.BACKOFF_START)
  self.drive.scenario.failures.clear()
  self.assertEqual(self.worker.run_once(),(1,False));self.assertEqual(self.worker.backoff,0)
  self.assertTrue((p/'prepared/thumbnail.jpg').is_file())
 def get_row(self,p):
  return [row for row in self.client.get('/api/logs',environ_overrides=gs.PEER).json['logs'] if row['id']==p.name][0]

def load_tests(loader,tests,pattern):
 # Only this module's tests: DriveBackfillTests reuses the Drive server set-up, not its tests.
 suite=unittest.TestSuite()
 for case in (NasBackfillTests,ThrottleTests,OrderAndFailureTests,DriveBackfillTests):
  suite.addTests(case(name) for name in vars(case) if name.startswith('test'))
 return suite


class StartupTests(unittest.TestCase):
 def test_thread_start_is_not_shadowed(self):
  # server.py calls list_backfill.start() at import; a per-log helper named start() once replaced it and the add-on
  # failed to boot.
  import inspect
  params=list(inspect.signature(backfill.Backfill.start).parameters)
  self.assertEqual(params,['self','delay'])

if __name__=='__main__':unittest.main()
