import os,sys,tempfile,unittest,json,contextlib,io
from pathlib import Path
os.environ['RV_DATA']=tempfile.mkdtemp();os.environ['RV_INGRESS_ONLY']='1'
sys.path.insert(0,'/app');sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'roadviewer/app'))
import server
class DiagnosticsTests(unittest.TestCase):
 def setUp(self):
  self.c=server.app.test_client();self.peer={'REMOTE_ADDR':'172.30.32.2'};self.headers={'X-RoadViewer-Request':'1'}
  server.DIAGNOSTICS.unlink(missing_ok=True);server.DIAGNOSTICS.with_suffix('.previous.jsonl').unlink(missing_ok=True)
 def post(self,events):
  with contextlib.redirect_stdout(io.StringIO()):return self.c.post('/api/diagnostics',json={'events':events},headers=self.headers,environ_overrides=self.peer)
 def test_auth(self):
  self.assertEqual(self.c.get('/api/diagnostics').status_code,403)
  self.assertEqual(self.c.post('/api/diagnostics',json={},environ_overrides=self.peer).status_code,403)
 def test_export_persistence_and_console(self):
  event={'id':'event1','page':'page1','event':'picker_change','details':{'count':2,'multiple':True}}
  with contextlib.redirect_stdout(io.StringIO()) as stdout:r=self.c.post('/api/diagnostics',json={'events':[event]},headers=self.headers,environ_overrides=self.peer)
  self.assertEqual(r.status_code,200);self.assertIn('[RoadViewer picker]',stdout.getvalue());self.assertTrue(server.DIAGNOSTICS.exists())
  r=self.c.get('/api/diagnostics',environ_overrides=self.peer);self.assertEqual(r.headers['Cache-Control'],'no-store');self.assertIn('attachment',r.headers['Content-Disposition']);self.assertEqual(json.loads(r.text)['details']['count'],2)
 def test_invalid_and_limits(self):
  for events in [[],[{}],['bad'],[{'event':'x'}]*101]:self.assertEqual(self.post(events).status_code,400)
  self.assertEqual(self.post([{'event':'x','details':{'text':'x'*17000}}]).status_code,413)
  self.assertEqual(self.post([{'event':'x','details':{'text':'x'*33000}}]).status_code,413)
 def test_rotation(self):
  server.DIAGNOSTICS.write_text('x'*(512*1024))
  self.assertEqual(self.post([{'event':'page_load'}]).status_code,200)
  self.assertTrue(server.DIAGNOSTICS.with_suffix('.previous.jsonl').exists());self.assertLess(server.DIAGNOSTICS.stat().st_size,512*1024)
if __name__=='__main__':
 try:unittest.main()
 finally:server.pool.shutdown()
