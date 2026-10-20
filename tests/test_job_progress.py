import os,sys,tempfile,threading,time,unittest,json
from pathlib import Path
from unittest.mock import patch
os.environ['RV_DATA']=tempfile.mkdtemp()
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'roadviewer/app'))
import server

class JobProgressTests(unittest.TestCase):
 def test_progress_endpoint_never_reads_files_or_storage(self):
  with patch.dict(server.job_progress,{'a'*32:{'stage':'video_convert','percent':65}},clear=True),patch.object(server,'read_meta',side_effect=AssertionError('metadata read')),patch.object(server,'storage_used_bytes',side_effect=AssertionError('storage scan')):
   response=server.app.test_client().get('/api/progress',environ_overrides={'REMOTE_ADDR':'172.30.32.2'})
   self.assertEqual(response.status_code,200)
   self.assertEqual(response.json,{'progress':{'a'*32:{'stage':'video_convert','percent':65}}})
   self.assertEqual(response.headers['Cache-Control'],'no-store')
   self.assertEqual(server.app.test_client().get('/api/progress').status_code,403)

 def test_progress_is_live_ephemeral_and_cleared_after_completion(self):
  self.check_job(False)
 def test_failure_clears_progress(self):
  self.check_job(True)
 def check_job(self,fail):
  with tempfile.TemporaryDirectory() as root,patch.object(server,'ROOT',Path(root)):
   p=Path(root)/('a'*32);p.mkdir()
   server.save_meta(p,dict(id=p.name,name='test',uploaded=0,status='queued'))
   script=Path(root)/'decoder.py'
   script.write_text("import os,json,time,sys\nfrom pathlib import Path\nf=os.fdopen(int(os.environ['RV_PROGRESS_FD']),'w',buffering=1)\nf.write(json.dumps({'stage':'log_analysis','frames':123,'total_frames':246})+'\\n')\np=Path(sys.argv[1]).parent\nwhile not (p/'continue').exists():time.sleep(.01)\n"+("(p/'prepared').mkdir()\n(p/'prepared/partial.mp4').write_bytes(b'partial')\nsys.exit(1)\n" if fail else "(p/'prepared').mkdir()\n(p/'prepared/data.json').write_text(json.dumps({'duration':1,'warnings':[],'frames':[{}]}))\n(p/'prepared/summary.json').write_text(json.dumps({'duration':1,'warnings':[],'model_frames':1}))\n"))
   with patch.object(server,'BASE',Path(root)):
    thread=threading.Thread(target=server.run_job,args=(p.name,));thread.start()
    try:
     deadline=time.monotonic()+5
     while server.job_progress.get(p.name,{}).get('frames')!=123 and time.monotonic()<deadline:time.sleep(.01)
     response=server.app.test_client().get('/api/logs',environ_overrides={'REMOTE_ADDR':'172.30.32.2'})
     item=response.json['logs'][0]
     self.assertEqual(item['progress'],{'stage':'log_analysis','frames':123,'total_frames':246})
     live=server.app.test_client().get('/api/progress',environ_overrides={'REMOTE_ADDR':'172.30.32.2'})
     self.assertEqual(live.json['progress'][p.name],item['progress'])
     self.assertNotIn('progress',server.read_meta(p))
    finally:
     (p/'continue').touch();thread.join(timeout=5)
    self.assertFalse(thread.is_alive())
   self.assertEqual(server.read_meta(p)['status'],'error' if fail else 'ready')
   if fail:self.assertFalse((p/'prepared').exists())
   self.assertNotIn(p.name,server.job_progress);self.assertNotIn(p.name,server.processes)

class UploadPriorityTests(unittest.TestCase):
 def test_automatic_conversion_waits_for_arriving_uploads(self):
  # Converting next to an arriving upload slowed and broke device transfers on a small host.
  with tempfile.TemporaryDirectory() as root,patch.object(server,'ROOT',Path(root)),patch.object(server,'UPLOADS',Path(root)/'.uploads'),patch.object(server.time,'sleep',lambda s:None):
   (Path(root)/'.uploads').mkdir();session=Path(root)/'.uploads'/('b'*32);session.mkdir()
   p=Path(root)/('a'*32);p.mkdir();server.save_meta(p,dict(id=p.name,name='test',uploaded=0,status='queued'))
   checks=[];started=[]
   def receiving():
    checks.append(1)
    if len(checks)==3:os.utime(session,(time.time()-60,time.time()-60)) # Quiet from now on.
    return real()
   real=server.upload_receiving
   class Started(Exception):pass
   def popen(args,**kwargs):started.append((args,kwargs));raise Started()
   with patch.object(server,'upload_receiving',receiving),patch.object(server.subprocess,'Popen',popen):
    server.run_job(p.name)
   self.assertEqual(len(checks),3,'waited while a chunk was recent, started once quiet')
   args,kwargs=started[0]
   self.assertIn('decoder.py',' '.join(map(str,args)));self.assertTrue(callable(kwargs.get('preexec_fn')),'decoder runs at lower CPU priority')
   if server.shutil.which('ionice'):self.assertEqual(args[:4],['ionice','-c2','-n7','-t'])
   # A manual request does not wait, and a removed/requeued job stops waiting.
   server.save_meta(p,dict(id=p.name,name='test',uploaded=0,status='queued',manual_conversion=True));os.utime(session,None);started.clear()
   with patch.object(server.subprocess,'Popen',popen):server.run_job(p.name)
   self.assertEqual(len(started),1)
   server.save_meta(p,dict(id=p.name,name='test',uploaded=0,status='unconverted'));started.clear()
   with patch.object(server.subprocess,'Popen',popen):server.run_job(p.name)
   self.assertEqual(started,[])

if __name__=='__main__':unittest.main()
