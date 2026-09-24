"""Network settings are stored by Supervisor; only explicit restart applies them."""
import io, json, os, sys, tempfile, unittest
from pathlib import Path
from contextlib import ExitStack
from unittest.mock import patch
os.environ['RV_DATA'] = tempfile.mkdtemp()
sys.path.insert(0, str(Path(__file__).resolve().parents[1]/'roadviewer/app'))
import server as s
import device_network as n

class NetworkTests(unittest.TestCase):
 def setUp(self):
  self.stack=ExitStack();self.addCleanup(self.stack.close)
  self.client=s.app.test_client()
  for obj,name,value in [(s,'DEVICE_HOST_PORT',None),(s.device_network,'restarting',False),(s.device_network,'restart_error','')]:
   self.stack.enter_context(patch.object(obj,name,value))
  self.stack.enter_context(patch.dict(os.environ,{'RV_DEVICE_PORT_ERROR':''}))
  self.info={'network':{'8443/tcp':None,'9000/tcp':19000},'options':{'device_certfile':'fullchain.pem','device_keyfile':'privkey.pem'}}
  def call(action,body=None,**kwargs):
   if action=='info':return self.info
   if action=='options':self.info['network']=body['network']
   return {}
  self.supervisor=self.stack.enter_context(patch.object(n,'supervisor',side_effect=call))
  self.tls=self.stack.enter_context(patch.object(n,'validate_tls'))
  self.timer=self.stack.enter_context(patch.object(n.threading,'Timer'))
 def api(self,method='GET',body=None,suffix='',headers=True,external=False):
  peer={'REMOTE_ADDR':'172.30.32.2'}
  if external:peer={'REMOTE_ADDR':'127.0.0.1','gunicorn.socket':type('Listener',(),{'getsockname':lambda _:('127.0.0.1',8098)})()}
  return self.client.open('/api/settings/device-network'+suffix,method=method,json=body,environ_overrides=peer,headers={'X-RoadViewer-Request':'1'} if headers else {})
 def test_save_preserves_other_ports_and_waits_for_explicit_restart(self):
  response=self.api();self.assertIsNone(response.json['configured_port']);self.assertFalse(response.json['restart_required'])
  response=self.api('POST',{'enabled':True,'port':18443})
  self.assertEqual(response.status_code,200);self.assertEqual(response.json['configured_port'],18443)
  self.assertIsNone(response.json['active_port']);self.assertTrue(response.json['restart_required'])
  self.supervisor.assert_any_call('options',{'network':{'8443/tcp':18443,'9000/tcp':19000}})
  self.timer.assert_not_called();self.tls.assert_called_once_with(self.info['options'])
  self.assertEqual(self.api().json['configured_port'],18443)
  with patch.object(s,'DEVICE_HOST_PORT',18443):
   self.assertFalse(self.api().json['restart_required'])
   response=self.api('POST',{'enabled':False,'port':None})
   self.assertIsNone(response.json['configured_port']);self.assertEqual(response.json['active_port'],18443);self.assertTrue(response.json['restart_required'])
  self.assertEqual(self.tls.call_count,1)
 def test_invalid_input_and_external_access_never_changes_ports(self):
  for body in [None,{}, {'enabled':1,'port':18443},{'enabled':False,'port':18443},*({'enabled':True,'port':p} for p in [None,True,0,65536,12.5,'18443']),{'enabled':True,'port':8443,'slug':'other'}]:
   self.assertEqual(self.api('POST',body).status_code,400)
  self.assertEqual(self.api('POST',{'enabled':False,'port':None},headers=False).status_code,403)
  for suffix in ('','/restart'):
   self.assertEqual(self.api('POST',{},suffix=suffix,external=True).status_code,404)
  self.supervisor.assert_not_called()
 def test_tls_failure_preserves_settings_and_does_not_restart(self):
  self.tls.side_effect=OSError('private path')
  response=self.api('POST',{'enabled':True,'port':18443})
  self.assertEqual(response.json['error'],'invalid_tls');self.assertIsNone(self.info['network']['8443/tcp'])
  self.info['network']['8443/tcp']=18443
  self.assertEqual(self.api('POST',{},suffix='/restart').json['error'],'invalid_tls')
  self.timer.assert_not_called()
 def test_supervisor_failure_does_not_report_success(self):
  self.supervisor.side_effect=OSError('secret-token')
  for method,suffix,body in [('GET','',None),('POST','',{'enabled':False,'port':None}),('POST','/restart',{})]:
   response=self.api(method,body,suffix=suffix)
   self.assertEqual(response.status_code,502);self.assertNotIn('secret-token',response.get_data(as_text=True))
  self.timer.assert_not_called()
 def test_explicit_restart_is_queued_once_and_errors_can_be_retried(self):
  self.info['network']['8443/tcp']=18443
  response=self.api('POST',{},suffix='/restart')
  self.assertEqual(response.status_code,202);self.assertTrue(response.json['restarting']);self.assertTrue(response.json['restart_required'])
  self.timer.assert_called_once_with(.5,s.device_network.restart_app);self.timer.return_value.start.assert_called_once()
  self.assertEqual(self.api('POST',{},suffix='/restart').status_code,202);self.assertEqual(self.timer.call_count,1)
  self.assertEqual(self.api('POST',{'enabled':False,'port':None}).status_code,409)
  self.supervisor.side_effect=OSError()
  s.device_network.restart_app()
  self.assertFalse(s.device_network.restarting);self.assertTrue(s.device_network.restart_error)
  self.supervisor.assert_called_with('restart',{},timeout=60)
 def test_http_client_uses_only_self_and_does_not_return_options_on_save(self):
  # Exercise the real transport independently of this test's Supervisor fake.
  with patch.dict(os.environ,{'SUPERVISOR_TOKEN':'private-token'}),patch.object(n,'urlopen',return_value=io.BytesIO(b'{"result":"ok"}')) as transport:
   # Saved original function is supplied below, since setUp patches the module.
   self.assertEqual(supervisor_request('options',{'network':{'8443/tcp':18443}}),{})
   req=transport.call_args.args[0]
   self.assertEqual(req.full_url,'http://supervisor/addons/self/options');self.assertEqual(req.get_method(),'POST')
   self.assertEqual(json.loads(req.data),{'network':{'8443/tcp':18443}})

supervisor_request=n.supervisor
if __name__=='__main__':unittest.main()
