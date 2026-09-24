import os, sys, json, hashlib, hmac, tempfile, time, unittest, threading
from pathlib import Path
from contextlib import ExitStack
from unittest.mock import patch
os.environ['RV_DATA'] = tempfile.mkdtemp()
sys.path.insert(0, str(Path(__file__).resolve().parents[1]/'roadviewer/app'))
import server as s
from storage_policy import StorageError, StoragePolicy
from flask import Flask
from types import SimpleNamespace

class DeviceTests(unittest.TestCase):
 def setUp(self):
  self.stack=ExitStack();self.addCleanup(self.stack.close)
  root=Path(self.stack.enter_context(tempfile.TemporaryDirectory()));uploads=root/'.uploads';uploads.mkdir()
  for name,value in [('ROOT',root),('UPLOADS',uploads),('auto_convert',False),('DEVICE_HOST_PORT',18443)]:self.stack.enter_context(patch.object(s,name,value))
  self.stack.enter_context(patch.object(s,'submit'))
  self.stack.enter_context(patch.object(s.devices,'path',root/'.devices.json'))
  self.stack.enter_context(patch.object(s.devices,'state',{'master':'f'*64,'devices':{},'nonces':{},'receipts':{}}))
  self.stack.enter_context(patch.object(s.devices,'pairing',None));s.devices.attempts.clear()
  self.stack.enter_context(patch.object(s.storage_policy,'path',root/'.storage-settings.json'))
  self.stack.enter_context(patch.object(s.storage_policy,'settings',{'max_bytes':0,'policy':'reject_new','pinned_logs':[]}))
  self.client=s.app.test_client();self.peer={'REMOTE_ADDR':'127.0.0.1','gunicorn.socket':type('Listener',(),{'getsockname':lambda _:('127.0.0.1',8098)})()};self.ui={'REMOTE_ADDR':'172.30.32.2'}
  self.device=self.pair();self.counter=0
 def ui_call(self,path,method='GET',body=None):return self.client.open(path,method=method,json=body,environ_overrides=self.ui,headers={'X-RoadViewer-Request':'1'})
 def external(self,path,method='POST',**kwargs):return self.client.open(path,method=method,environ_overrides=self.peer,**kwargs)
 def pair(self):
  code=self.ui_call('/api/settings/devices/pairing','POST').json['code']
  r=self.external('/api/device/pair',json={'code':code,'metadata':{'name':'comma','dongle_id':'dongle'}})
  self.assertEqual(r.status_code,201,r.json);return r.json
 def batch(self,segments=1):return {'batch_id':'batch_012345678901','segments':[{'route':'00000395--0d0eda17c5','segment':i,'files':[{'kind':kind,'size':len(payload),'sha256':hashlib.sha256(payload).hexdigest()} for kind,payload in [('rlog.zst',b'log'+bytes([i])),('qcamera.ts',b'video')]]} for i in range(segments)]}
 def signed(self,body=None,stamp=None,nonce=None,signature=None):
  body=body or self.batch();raw=json.dumps(body).encode();stamp=str(stamp if stamp is not None else int(time.time()));self.counter+=1;nonce=nonce or f'nonce_{self.counter:020d}'
  canonical='\n'.join(('RV1',self.device['device_id'],stamp,nonce,'POST','/api/device/uploads',hashlib.sha256(raw).hexdigest()))
  headers={'Content-Type':'application/json','X-RV-Device':self.device['device_id'],'X-RV-Timestamp':stamp,'X-RV-Nonce':nonce,'X-RV-Signature':signature or hmac.new(self.device['device_secret'].encode(),canonical.encode(),hashlib.sha256).hexdigest()}
  return self.external('/api/device/uploads',data=raw,headers=headers)
 def token(self,result):return {'Authorization':'Bearer '+result['token']}
 def test_test_page_has_no_management_access_or_cors(self):
  r=self.external('/api/device/test','GET')
  self.assertEqual(r.status_code,200);self.assertIn('text/html',r.content_type)
  self.assertIn("connect-src 'self'",r.headers['Content-Security-Policy'])
  self.assertEqual(r.headers['Cache-Control'],'no-store');self.assertNotIn('Access-Control-Allow-Origin',r.headers)
  r.close()
  self.assertEqual(self.ui_call('/api/device/test').status_code,404)
  with patch.object(s,'DEVICE_HOST_PORT',None):self.assertEqual(self.external('/api/device/test','GET').status_code,404)
 def test_pairing_single_use_wrong_expired_cancelled(self):
  for mode in ('wrong','expired','cancelled','used'):
   code=self.ui_call('/api/settings/devices/pairing','POST').json['code']
   if mode=='wrong':code='incorrect'
   if mode=='expired':s.devices.pairing['expires_at']=time.time()-1
   if mode=='cancelled':self.ui_call('/api/settings/devices/pairing','DELETE')
   if mode=='used':self.assertEqual(self.external('/api/device/pair',json={'code':code,'metadata':{'name':'second'}}).status_code,201)
   self.assertEqual(self.external('/api/device/pair',json={'code':code,'metadata':{'name':'bad'}}).status_code,401)
 def test_pairing_rate_limit_and_no_secret_readback(self):
  for _ in range(10):self.external('/api/device/pair',json={'code':'wrong','metadata':{'name':'bad'}})
  self.assertEqual(self.external('/api/device/pair',json={'code':'wrong','metadata':{'name':'bad'}}).status_code,429)
  self.assertNotIn(self.device['device_secret'],self.ui_call('/api/settings/devices').get_data(as_text=True))
  self.assertNotIn(self.device['device_secret'],s.devices.path.read_text())
 def test_auth_and_persistent_replay_prevention(self):
  self.assertEqual(self.signed(signature='0'*64).status_code,401)
  self.assertEqual(self.signed(stamp=int(time.time())-121).json['error'],'stale_timestamp')
  self.assertEqual(self.signed(nonce='same_nonce_1234567890').status_code,201)
  s.devices.state=json.loads(s.devices.path.read_text())
  self.assertEqual(self.signed(nonce='same_nonce_1234567890').json['error'],'nonce_replayed')
  self.assertEqual(self.ui_call('/api/settings/devices/'+self.device['device_id']+'/revoke','POST').status_code,200)
  self.assertEqual(self.signed().status_code,401)
 def test_remove_revoked_device_persists_and_preserves_recordings(self):
  path='/api/settings/devices/'+self.device['device_id']
  self.assertEqual(self.ui_call(path,'DELETE').status_code,409)
  self.assertEqual(self.external(path,'DELETE').status_code,404)
  recording=self.make_log('a','00000001--aaaaaaaaaa',0,1)
  session=self.signed().json
  self.assertEqual(self.ui_call(path+'/revoke','POST').status_code,200)
  self.assertEqual(self.ui_call(path,'DELETE').json,{'removed':True})
  s.devices.state=json.loads(s.devices.path.read_text())
  self.assertEqual(self.ui_call('/api/settings/devices').json['devices'],[])
  self.assertTrue(recording.exists())
  self.assertEqual(self.signed().status_code,401)
  self.assertNotEqual(self.external('/api/device/uploads/'+session['id'],'GET',headers=self.token(session)).status_code,200)
  self.assertEqual(self.ui_call(path,'DELETE').status_code,404)
  self.assertNotEqual(self.pair()['device_id'],self.device['device_id'])
 def test_remove_releases_registration_limit(self):
  for i in range(99):s.devices.state['devices'][str(i)]={'device_id':str(i),'revoked':True}
  code=self.ui_call('/api/settings/devices/pairing','POST').json['code']
  body={'code':code,'metadata':{'name':'new device'}}
  self.assertEqual(self.external('/api/device/pair',json=body).json['error'],'device_limit_reached')
  self.assertEqual(self.ui_call('/api/settings/devices/0','DELETE').status_code,200)
  self.assertEqual(self.external('/api/device/pair',json=body).status_code,201)
 def test_removal_during_authenticated_admission_is_rejected(self):
  def remove():
   path='/api/settings/devices/'+self.device['device_id']
   self.ui_call(path+'/revoke','POST');self.ui_call(path,'DELETE')
  with patch.object(s,'cleanup_uploads',side_effect=remove):
   response=self.signed()
  self.assertEqual(response.status_code,401);self.assertEqual(response.json['error'],'invalid_device')
 def test_single_multi_segment_resume_finish_and_retry(self):
  for n in (1,2):
   body=self.batch(n);body['batch_id']+=str(n);r=self.signed(body);self.assertEqual(r.status_code,201,r.json);data=r.json;id=data['id'];headers=self.token(data)
   for f in data['files']:
    payload=b'video' if f['name'].endswith('qcamera.ts') else b'log'+bytes([f['index']//2])
    url=f'/api/device/uploads/{id}/files/{f["index"]}'
    self.assertEqual(self.external(url+'?offset=0','PUT',data=payload[:2],headers=headers).status_code,200)
    self.assertEqual(self.external(url+'?offset=0','PUT',data=payload[:2],headers=headers).status_code,200)
    status=self.external('/api/device/uploads/'+id,'GET',headers=headers);self.assertEqual(status.json['files'][f['index']]['received'],2)
    self.assertEqual(self.external(url+'?offset=2','PUT',data=payload[2:],headers=headers).status_code,200)
   s.cleanup_uploads(startup=True)
   self.assertTrue((s.UPLOADS/id).exists())
   result=self.external('/api/device/uploads/'+id+'/finish',headers=headers);self.assertEqual(result.status_code,201,result.json)
   self.assertEqual(self.external('/api/device/uploads/'+id+'/finish',headers=headers).json,result.json)
   self.assertEqual(self.signed(body).json['state'],'completed')
   self.assertEqual(s.storage_policy.reserved(),0)
  self.assertEqual(len(s.recording_paths()),2)
 def test_session_reissue_binding_cancel_expiry_and_revoke(self):
  r=self.signed().json;again=self.signed().json;self.assertEqual(r['id'],again['id'])
  self.assertEqual(self.external('/api/device/uploads/'+r['id'],'GET',headers=self.token(r)).status_code,401)
  self.assertEqual(self.external('/api/device/uploads/'+r['id'],'DELETE',headers=self.token(again)).status_code,200)
  self.assertEqual(s.storage_policy.reserved(),0)
  r=self.signed().json;p=s.UPLOADS/r['id'];meta=json.loads((p/'device.json').read_text());meta['expires_at']=time.time()-1;(p/'device.json').write_text(json.dumps(meta))
  self.assertEqual(self.external('/api/device/uploads/'+r['id'],'GET',headers=self.token(r)).status_code,410)
  s.cleanup_uploads();self.assertFalse(p.exists())
  r=self.signed().json;self.ui_call('/api/settings/devices/'+self.device['device_id']+'/revoke','POST')
  self.assertNotEqual(self.external('/api/device/uploads/'+r['id'],'GET',headers=self.token(r)).status_code,200)
 def test_isolation_paths_and_invalid_batches(self):
  for path in ('/','/api/logs','/api/settings/devices','/assets/library.js','/api/storage/cleanup'):
   self.assertEqual(self.external(path,'GET',headers={'X-RoadViewer-Request':'1','X-Forwarded-For':'172.30.32.2'}).status_code,404)
  self.assertEqual(self.ui_call('/api/device/pair','POST').status_code,404)
  for route in ('../attack','/tmp/x','a'*20,'00000395--0d0eda17c5/../'):
   body=self.batch();body['segments'][0]['route']=route;self.assertEqual(self.signed(body).status_code,400)
  for kind in ('../../bad','camera.mp4','/tmp/rlog.zst'):
   body=self.batch();body['segments'][0]['files'][0]['kind']=kind;self.assertEqual(self.signed(body).status_code,400)
  body=self.batch();body['segments'][0]['files']=body['segments'][0]['files'][1:];self.assertEqual(self.signed(body).json['error'],'rlog_required')
 def test_checksum_failure_releases_and_active_cleanup_protection(self):
  r=self.signed().json;id=r['id'];headers=self.token(r)
  self.external(f'/api/device/uploads/{id}/files/0?offset=0','PUT',headers=headers,data=b'xxxx')
  self.external(f'/api/device/uploads/{id}/files/1?offset=0','PUT',headers=headers,data=b'xxxxx')
  s.cleanup_uploads(force=True);self.assertTrue((s.UPLOADS/id).exists())
  self.assertEqual(self.external(f'/api/device/uploads/{id}/finish',headers=headers).json['error'],'checksum_mismatch')
  self.assertEqual(s.storage_policy.reserved(),0)
 def test_disk_full_write_releases_session(self):
  import errno
  r=self.signed().json
  with patch.object(s,'upload_chunk',side_effect=OSError(errno.ENOSPC,'disk full')):
   response=self.external('/api/device/uploads/'+r['id']+'/files/0?offset=0','PUT',headers=self.token(r),data=b'log')
  self.assertEqual(response.status_code,507);self.assertEqual(s.storage_policy.reserved(),0)
  self.assertFalse((s.UPLOADS/r['id']).exists())
 def test_reserved_capacity_concurrent_admission(self):
  # Neither request sees the same free capacity twice.
  s.storage_policy.settings['max_bytes']=s.storage_used_bytes()+100000
  barrier=threading.Barrier(2);results=[]
  def begin():
   with s.app.test_request_context('/api/uploads',method='POST'):
    barrier.wait()
    try:
     with s.registration_lock,s.lock:results.append(s.create_upload([{'name':'rlog.zst','size':10000}])[1])
    except StorageError:results.append(507)
  threads=[threading.Thread(target=begin) for _ in range(2)]
  for t in threads:t.start()
  for t in threads:t.join()
  self.assertEqual(sorted(results),[201,507])
 def make_log(self,id,route,segment,uploaded,size=50000):
  p=s.ROOT/(id*32);p.mkdir();(p/'rlog.zst').write_bytes(b'x'*size);s.save_meta(p,dict(id=p.name,name=f'{route} / 구간 {segment}',uploaded=uploaded,status='unconverted',files={'rlog.zst':f'{route}--{segment}--rlog.zst'}));return p
 def test_segment_pins_and_partial_route_eviction(self):
  a=self.make_log('a','00000001--aaaaaaaaaa',0,1)
  b=self.make_log('b','00000001--aaaaaaaaaa',1,2,size=100000)
  c=self.make_log('c','00000002--bbbbbbbbbb',0,3)
  self.assertEqual(self.ui_call('/api/logs/'+a.name+'/pin','POST',{'pinned':True}).status_code,200)
  self.assertTrue(s.storage_policy.pinned(s.read_meta(a)))
  self.assertFalse(s.storage_policy.pinned(s.read_meta(b)))
  self.assertEqual(json.loads(s.storage_policy.path.read_text())['pinned_logs'],[a.name])
  s.storage_policy.settings.update(max_bytes=s.storage_used_bytes()+20000,policy='delete_oldest')
  with s.registration_lock,s.lock:s.storage_policy.admit(10000,[])
  self.assertTrue(a.exists());self.assertFalse(b.exists());self.assertTrue(c.exists())
  self.ui_call('/api/logs/'+a.name+'/pin','POST',{'pinned':False})
  self.assertFalse(s.storage_policy.pinned(s.read_meta(a)))
 def test_pinned_capacity_is_excluded_from_preflight(self):
  a=self.make_log('a','00000001--aaaaaaaaaa',0,1,size=100000)
  b=self.make_log('b','00000001--aaaaaaaaaa',1,2,size=10000)
  c=self.make_log('c','00000002--bbbbbbbbbb',0,3,size=10000)
  self.ui_call('/api/logs/'+a.name+'/pin','POST',{'pinned':True})
  s.storage_policy.settings.update(max_bytes=s.storage_used_bytes()+20000,policy='delete_oldest')
  with s.registration_lock,s.lock:
   with self.assertRaises(StorageError):s.storage_policy.admit(10000,[])
  self.assertTrue(a.exists());self.assertTrue(b.exists());self.assertTrue(c.exists())
 def test_legacy_pins_migrate_once_and_future_segments_stay_unpinned(self):
  a=self.make_log('a','00000001--aaaaaaaaaa',0,1)
  b=self.make_log('b','00000001--aaaaaaaaaa',1,2)
  c=self.make_log('c','00000002--bbbbbbbbbb',0,3)
  s.storage_policy.path.write_text(json.dumps({'max_bytes':123456,'policy':'delete_oldest','pinned_routes':['00000001--aaaaaaaaaa']}))
  def load():return StoragePolicy(SimpleNamespace(ROOT=s.ROOT,app=Flask(__name__),recording_paths=s.recording_paths,read_meta=s.read_meta,FLAT=s.FLAT))
  policy=load()
  self.assertTrue(policy.pinned(s.read_meta(a)));self.assertTrue(policy.pinned(s.read_meta(b)))
  self.assertFalse(policy.pinned(s.read_meta(c)))
  self.assertNotIn('pinned_routes',json.loads(policy.path.read_text()))
  self.assertEqual(policy.settings['max_bytes'],123456);self.assertEqual(policy.settings['policy'],'delete_oldest')
  d=self.make_log('d','00000001--aaaaaaaaaa',2,4)
  policy=load();self.assertFalse(policy.pinned(s.read_meta(d)))
  self.assertEqual(policy.settings['pinned_logs'],[a.name,b.name])
 def test_unpin_does_not_change_other_segment(self):
  a=self.make_log('a','00000001--aaaaaaaaaa',0,1);b=self.make_log('b','00000001--aaaaaaaaaa',1,2)
  for p in (a,b):self.ui_call('/api/logs/'+p.name+'/pin','POST',{'pinned':True})
  self.ui_call('/api/logs/'+a.name+'/pin','POST',{'pinned':False})
  self.assertFalse(s.storage_policy.pinned(s.read_meta(a)));self.assertTrue(s.storage_policy.pinned(s.read_meta(b)))
 def test_protect_incoming_and_processing_routes(self):
  a=self.make_log('a','00000001--aaaaaaaaaa',0,1,size=100000)
  b=self.make_log('b','00000002--bbbbbbbbbb',0,2,size=100000)
  c=self.make_log('c','00000003--cccccccccc',0,3,size=100000)
  m=s.read_meta(b);m['status']='processing';s.save_meta(b,m)
  s.storage_policy.settings.update(max_bytes=s.storage_used_bytes()+20000,policy='delete_oldest')
  with s.registration_lock,s.lock:s.storage_policy.admit(10000,[{'name':'00000001--aaaaaaaaaa--1--rlog.zst'}])
  self.assertTrue(a.exists());self.assertTrue(b.exists());self.assertFalse(c.exists())
 def test_device_idle_deadline_and_active_requests(self):
  r=self.signed().json;p=s.UPLOADS/r['id'];os.utime(p,(0,0))
  s.active_uploads[p.name]+=1
  try:
   s.cleanup_uploads(force=True);self.assertTrue(p.exists())
   self.assertEqual(self.external('/api/device/uploads/'+p.name,'GET',headers=self.token(r)).status_code,410)
  finally:s.active_uploads.pop(p.name,None)
  s.cleanup_uploads();self.assertFalse(p.exists());self.assertEqual(s.storage_policy.reserved(),0)
 def test_signature_binds_exact_body_and_query(self):
  body=self.batch();raw=json.dumps(body).encode();stamp=str(int(time.time()));nonce='tamper_nonce_12345678'
  canonical='\n'.join(('RV1',self.device['device_id'],stamp,nonce,'POST','/api/device/uploads',hashlib.sha256(raw).hexdigest()))
  headers={'Content-Type':'application/json','X-RV-Device':self.device['device_id'],'X-RV-Timestamp':stamp,'X-RV-Nonce':nonce,'X-RV-Signature':hmac.new(self.device['device_secret'].encode(),canonical.encode(),hashlib.sha256).hexdigest()}
  self.assertEqual(self.external('/api/device/uploads',data=raw+b' ',headers=headers).json['error'],'invalid_signature')
  self.assertEqual(self.external('/api/device/uploads?extra=1',data=raw,headers=headers).json['error'],'unexpected_query')
 def test_credential_state_restores_and_pin_survives(self):
  saved=json.loads(s.devices.path.read_text());s.devices.state=saved
  self.assertEqual(s.devices.secret(self.device['device_id']),self.device['device_secret'])
  self.assertEqual(self.signed().status_code,201)
  a=self.make_log('a','00000001--aaaaaaaaaa',0,1)
  self.ui_call('/api/logs/'+a.name+'/pin','POST',{'pinned':True})
  s.storage_policy.settings=json.loads(s.storage_policy.path.read_text())
  self.assertTrue(s.storage_policy.pinned(s.read_meta(a)))
  self.assertEqual(s.devices.path.stat().st_mode & 0o777,0o600)
 def test_real_disk_free_error_and_legacy_reservation(self):
  with patch.object(s.shutil,'disk_usage',return_value=type('Disk',(),{'free':1000})()):
   self.assertEqual(self.signed().json['error'],'insufficient_disk_space')
  r=self.ui_call('/api/uploads','POST',{'files':[{'name':'rlog.zst','size':2}]});self.assertEqual(r.status_code,201)
  self.assertGreater(s.storage_policy.reserved(),0);s.cleanup_uploads(startup=True);self.assertEqual(s.storage_policy.reserved(),0)

if __name__=='__main__':unittest.main()
