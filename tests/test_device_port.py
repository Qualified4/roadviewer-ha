import io,json,sys,unittest
from pathlib import Path
from unittest.mock import patch
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'roadviewer/app'))
import start

class PortTests(unittest.TestCase):
 def test_only_network_mapping_controls_activation(self):
  for value,expected in [(None,None),(18443,18443),('18099',18099)]:
   with self.subTest(value=value),patch.dict(start.os.environ,{'SUPERVISOR_TOKEN':'test-token'}),patch.object(start,'urlopen',return_value=io.BytesIO(json.dumps({'result':'ok','data':{'network':{'8443/tcp':value},'options':{'device_api_enabled':False}}}).encode())) as call:
    self.assertEqual(start.device_host_port(),(expected,None))
    req=call.call_args.args[0];self.assertEqual(req.full_url,'http://supervisor/addons/self/info');self.assertEqual(req.get_method(),'GET')
 def test_missing_token_keeps_api_disabled(self):
  with patch.dict(start.os.environ,{},clear=True),patch.object(start,'urlopen') as call:
   port,error=start.device_host_port();self.assertIsNone(port);self.assertTrue(error);call.assert_not_called()
 def test_bad_mapping_fails_closed_without_logging_credentials(self):
  for value in [True,0,65536,'bad']:
   with self.subTest(value=value),patch.dict(start.os.environ,{'SUPERVISOR_TOKEN':'private-token'}),patch.object(start,'urlopen',side_effect=lambda *a,**kw:io.BytesIO(json.dumps({'result':'ok','data':{'network':{'8443/tcp':value}}}).encode())),patch.object(start.time,'sleep'):
    port,error=start.device_host_port();self.assertIsNone(port);self.assertTrue(error);self.assertNotIn('private-token',error)
 def test_unmapped_port_never_starts_https_and_worker_gets_same_state(self):
  for port in (None,18443):
   with self.subTest(port=port),patch.object(start,'device_host_port',return_value=(port,None)),patch.object(start.Path,'exists',return_value=False),patch.object(start.Path,'write_text'),patch.object(start.signal,'signal'),patch.object(start.subprocess,'run') as validate,patch.object(start.subprocess,'Popen') as launch:
    launch.return_value.poll.return_value=0
    with self.assertRaisesRegex(RuntimeError,'listener exited'):start.main()
    self.assertEqual(launch.call_count,1 if port is None else 2)
    worker=launch.call_args;self.assertEqual(worker.kwargs['env']['RV_DEVICE_HOST_PORT'],str(port or 0))
    self.assertEqual(worker.args[0][0],'gunicorn')
    self.assertEqual(validate.called,port is not None)
 def test_transient_supervisor_failure_retries(self):
  response=io.BytesIO(b'{"result":"ok","data":{"network":{"8443/tcp":18443}}}')
  with patch.dict(start.os.environ,{'SUPERVISOR_TOKEN':'test-token'}),patch.object(start,'urlopen',side_effect=[OSError(),response]) as call,patch.object(start.time,'sleep'):
   self.assertEqual(start.device_host_port(),(18443,None));self.assertEqual(call.call_count,2)

if __name__=='__main__':unittest.main()
