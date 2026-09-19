import os,sys,tempfile,threading,time,unittest
from pathlib import Path
from unittest.mock import patch
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'roadviewer/app'))
from work_queue import ProcessingQueue
os.environ['RV_DATA']=tempfile.mkdtemp()
os.environ['RV_INGRESS_ONLY']='1'
import server

class QueueTests(unittest.TestCase):
 def test_live_limit_preserves_running_jobs_and_order(self):
  started={k:threading.Event() for k in 'abc'}
  release={k:threading.Event() for k in 'abc'}
  def work(id):started[id].set();release[id].wait(5)
  q=ProcessingQueue(work)
  try:
   q.submit('a');q.submit('b');q.submit('c')
   self.assertTrue(started['a'].wait(2));self.assertFalse(started['b'].is_set())
   q.set_limit(2);self.assertTrue(started['b'].wait(2))
   q.set_limit(1);release['a'].set()
   with q.condition:self.assertTrue(q.condition.wait_for(lambda:'a' not in q.active,2))
   self.assertFalse(started['c'].is_set())
   release['b'].set();self.assertTrue(started['c'].wait(2))
  finally:
   for event in release.values():event.set()
   q.shutdown()
 def test_four_actual_workers_and_reducing_limit(self):
  started={k:threading.Event() for k in 'abcde'};release={k:threading.Event() for k in started}
  def work(id):started[id].set();release[id].wait(5)
  q=ProcessingQueue(work,4)
  try:
   for id in started:q.submit(id)
   for id in 'abcd':self.assertTrue(started[id].wait(2))
   self.assertFalse(started['e'].is_set());q.set_limit(2)
   for id in 'ab':release[id].set()
   with q.condition:self.assertTrue(q.condition.wait_for(lambda:not {'a','b'}&q.active,2))
   self.assertFalse(started['e'].is_set())
   release['c'].set();self.assertTrue(started['e'].wait(2))
  finally:
   for event in release.values():event.set()
   q.shutdown()
 def test_same_log_serialized_and_pending_duplicates_coalesced(self):
  gate=threading.Event();started=threading.Event();calls=[]
  def work(id):
   calls.append(id);started.set()
   if len(calls)==1:gate.wait(5)
  q=ProcessingQueue(work,2)
  try:
   q.submit('same');self.assertTrue(started.wait(2))
   q.submit('same');q.submit('same')
   with q.condition:self.assertEqual(q.pending,['same']);self.assertEqual(len(q.active),1)
  finally:gate.set();q.shutdown()
  self.assertEqual(calls,['same','same'])
 def test_discard_pending_preserves_active_and_manual_work(self):
  gate=threading.Event();started=threading.Event();calls=[]
  def work(id):
   calls.append(id)
   if id=='running':started.set();gate.wait(5)
  q=ProcessingQueue(work)
  try:
   q.submit('running');self.assertTrue(started.wait(2))
   q.submit('automatic');q.submit('manual');q.discard('automatic');q.discard('running')
   self.assertEqual(q.pending,['manual'])
  finally:gate.set();q.shutdown()
  self.assertEqual(calls,['running','manual'])
 def test_failed_job_releases_slot(self):
  done=threading.Event()
  def work(id):
   if id=='bad':raise ValueError('expected')
   done.set()
  q=ProcessingQueue(work)
  try:q.submit('bad');q.submit('next');self.assertTrue(done.wait(2))
  finally:q.shutdown()
 def test_settings_validate_persist_and_protect_access(self):
  peer={'REMOTE_ADDR':'172.30.32.2'};headers={'X-RoadViewer-Request':'1'}
  with tempfile.TemporaryDirectory() as root,patch.object(server,'PROCESSING_SETTINGS',Path(root)/'settings.json'):
   c=server.app.test_client()
   self.assertEqual(server.read_processing_limit(),1)
   self.assertEqual(c.post('/api/settings/processing',json={'concurrency':2,'auto_convert':True},environ_overrides=peer).status_code,403)
   for value in [0,5,True,'2',None]:
    self.assertEqual(c.post('/api/settings/processing',json={'concurrency':value},headers=headers,environ_overrides=peer).status_code,400)
   try:
    for value in (1,2,3,4):
     r=c.post('/api/settings/processing',json={'concurrency':value,'auto_convert':True},headers=headers,environ_overrides=peer)
     self.assertEqual(r.json,{'concurrency':value,'auto_convert':True})
     self.assertEqual(server.read_processing_limit(),value)
     self.assertEqual(c.get('/api/settings/processing',environ_overrides=peer).json,{'concurrency':value,'auto_convert':True})
     self.assertEqual(r.headers['Cache-Control'],'no-store')
   finally:server.pool.set_limit(1)

if __name__=='__main__':unittest.main()
