"""Real TLS + Gunicorn socket isolation. Runs in the add-on image in CI."""
import hashlib, hmac, importlib.util, json, os, shutil, socket, ssl, subprocess, sys, tempfile, time, unittest, urllib.request, urllib.error
from pathlib import Path
BASE=Path(__file__).resolve().parents[1]/'roadviewer/app'
if not BASE.is_dir():BASE=Path('/app')
sys.path.insert(0,str(BASE))
from start import nginx_config
NGINX=os.environ.get('RV_TEST_NGINX') or shutil.which('nginx')

@unittest.skipUnless(NGINX and shutil.which('openssl') and importlib.util.find_spec('gunicorn'), 'nginx, openssl and gunicorn required')
class TLSBoundary(unittest.TestCase):
 def test_tls_pair_upload_and_private_ui(self):
  with tempfile.TemporaryDirectory() as temp:
   root=Path(temp);os.chmod(root,0o755)
   subprocess.run(['openssl','req','-x509','-newkey','rsa:2048','-nodes','-keyout',str(root/'key.pem'),'-out',str(root/'cert.pem'),'-days','1','-subj','/CN=localhost','-addext','subjectAltName=DNS:localhost'],check=True,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
   (root/'wsgi_test.py').write_text("import server\nserver.DEVICE_HOST_PORT=18443\napp=server.app\n")
   config=nginx_config({'device_certfile':'cert.pem','device_keyfile':'key.pem'}).replace('/ssl/',temp+'/').replace('/tmp/roadviewer-nginx',temp+'/nginx')
   (root/'nginx.conf').write_text(config)
   env={**os.environ,'RV_DATA':str(root/'data'),'RV_INGRESS_ONLY':'0','PYTHONPATH':str(BASE)+os.pathsep+str(root)+os.pathsep+os.environ.get('PYTHONPATH','')}
   logs=(root/'process.log').open('w+')
   gunicorn=subprocess.Popen([sys.executable,'-m','gunicorn','--bind','127.0.0.1:8099','--bind','127.0.0.1:8098','--workers','1','--threads','4','wsgi_test:app'],env=env,stdout=logs,stderr=logs)
   nginx=subprocess.Popen([NGINX,'-c',str(root/'nginx.conf'),'-g','daemon off;'],stdout=logs,stderr=logs)
   try:
    context=ssl.create_default_context(cafile=str(root/'cert.pem'))
    def call(path,body=None,headers=None,tls=True,method=None):
     data=json.dumps(body).encode() if body is not None else None
     req=urllib.request.Request(('https://localhost:8443' if tls else 'http://127.0.0.1:8099')+path,data=data,headers={'Content-Type':'application/json','X-RoadViewer-Request':'1',**(headers or {})},method=method)
     try:
      with urllib.request.urlopen(req,context=context,timeout=5) as response:return response.status,json.load(response)
     except urllib.error.HTTPError as e:return e.code,e.read()
    for _ in range(100):
     try:
      code,_=call('/api/settings/devices',tls=False)
      if code==200 and call('/')[0]==404:break
     except OSError:pass
     time.sleep(.1)
    else:
     logs.seek(0);self.fail(logs.read())
    for path in ('/','/api/logs','/api/settings/devices','/api/uploads','/assets/library.js','/api/device/../logs'):
     code,_=call(path,headers={'Host':'localhost:8099','X-Forwarded-For':'172.30.32.2'});self.assertEqual(code,404,path)
    self.assertEqual(call('/api/device/pair',tls=False,headers={'Host':'localhost:8098'})[0],404)
    with urllib.request.urlopen('https://localhost:8443/api/device/test',context=context,timeout=5) as response:
     self.assertEqual(response.status,200);self.assertIn('text/html',response.headers['Content-Type'])
     self.assertIn("connect-src 'self'",response.headers['Content-Security-Policy'])
     self.assertIn('브라우저로 장치 업로드 테스트',response.read().decode())
    _,pair=call('/api/settings/devices/pairing',{},tls=False)
    code,device=call('/api/device/pair',{'code':pair['code'],'metadata':{'name':'TLS device'}});self.assertEqual(code,201,device)
    # Use exactly the bytes call() sends, including its JSON whitespace.
    body={'batch_id':'tls_batch_0123456789','segments':[{'route':'00000395--0d0eda17c5','segment':0,'files':[{'kind':'rlog.zst','size':3,'sha256':hashlib.sha256(b'log').hexdigest()}]}]}
    stamp=str(int(time.time()));nonce='tls_nonce_0123456789';raw=json.dumps(body).encode()
    canonical='\n'.join(('RV1',device['device_id'],stamp,nonce,'POST','/api/device/uploads',hashlib.sha256(raw).hexdigest()))
    headers={'X-RV-Device':device['device_id'],'X-RV-Timestamp':stamp,'X-RV-Nonce':nonce,'X-RV-Signature':hmac.new(device['device_secret'].encode(),canonical.encode(),hashlib.sha256).hexdigest()}
    self.assertEqual(call('/api/device/uploads',body,headers)[0],201)
   finally:
    for proc in (nginx,gunicorn):proc.terminate()
    for proc in (nginx,gunicorn):
     try:proc.wait(timeout=10)
     except subprocess.TimeoutExpired:proc.kill();proc.wait()
    logs.close()

if __name__=='__main__':unittest.main()
