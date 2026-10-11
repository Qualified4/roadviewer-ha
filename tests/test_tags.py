import json,os,sys,tempfile,unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from unittest.mock import patch
os.environ.setdefault('RV_DATA',tempfile.mkdtemp())
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'roadviewer/app'))
import server

class TagTests(unittest.TestCase):
 def setUp(self):
  self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup)
  self.root=Path(self.temp.name);p=patch.object(server,'ROOT',self.root);p.start();self.addCleanup(p.stop)
  self.id='a'*32;self.path=self.root/self.id;self.path.mkdir();(self.path/'rlog.zst').write_bytes(b'log')
  (self.path/'prepared').mkdir();(self.path/'prepared/data.json').write_text('{}')
  server.save_meta(self.path,dict(id=self.id,name='test',status='ready',uploaded=1,decoder_version='v28-runtime-geometry',video=False,conversion_revision=1))
 def post(self,body,id=None,headers=True):
  return server.app.test_client().post('/api/logs/'+(id or self.id)+'/tags',json=body,headers={'X-RoadViewer-Request':'1'} if headers else {},environ_overrides={'REMOTE_ADDR':'172.30.32.2'})
 def test_normalization_scope_and_validation(self):
  r=self.post({'tags':[{'name':'  야간   주행  ','color':'blue'},{'name':'TEST'},{'name':'test','color':'rose'}]})
  self.assertEqual(r.status_code,200);self.assertEqual(r.json['tags'],[{'name':'야간 주행','color':'blue'},{'name':'test','color':'rose'}])
  before=server.read_meta(self.path)
  for body in ({'tags':'x'},{'tags':[None]},{'tags':[{'name':''}]},{'tags':[{'name':'x'*33}]},{'tags':[{'name':'a\x00b'}]},{'tags':[{'name':'x','color':'red'}]},{'tags':[{'name':'x','color':[]}]},{'tags':[{'name':'x','unexpected':1}]},{'tags':[],'status':'ready'},{'tags':[],'action':[]},{'tags':[{'name':str(i)} for i in range(21)]}):
   with self.subTest(body=body):self.assertEqual(self.post(body).status_code,400)
  self.assertEqual(server.read_meta(self.path),before)
  self.assertEqual(self.post({'tags':[]},headers=False).status_code,403)
  self.assertEqual(self.post({'tags':[]},id='b'*32).status_code,404)
  self.assertEqual(self.post({'tags':[{'name':'x'*17000}]}).status_code,413)
 def test_add_remove_preserves_unrelated_tags_and_metadata(self):
  self.post({'tags':[{'name':'야간','color':'blue'}]})
  self.post({'action':'add','tags':[{'name':'급제동','color':'amber'},{'name':'야간','color':'rose'}]})
  tags=server.read_meta(self.path)['tags'];self.assertEqual(tags,[{'name':'야간','color':'blue'},{'name':'급제동','color':'amber'}])
  self.post({'action':'remove','tags':[{'name':'급제동'}]})
  self.assertEqual(server.read_meta(self.path)['tags'],tags[:1]);self.assertEqual(server.read_meta(self.path)['conversion_revision'],1)
  full=[{'name':str(i)} for i in range(20)];self.post({'tags':full})
  self.assertEqual(self.post({'action':'add','tags':[{'name':'extra'}]}).status_code,400)
  self.assertEqual(len(server.read_meta(self.path)['tags']),20)
  self.assertEqual(self.post({'tags':[]}).json['tags'],[])
 def test_tags_survive_removal_requeue_and_list(self):
  tags=[{'name':'검토 필요','color':'violet'}];self.post({'tags':tags})
  c=server.app.test_client();peer={'REMOTE_ADDR':'172.30.32.2'};headers={'X-RoadViewer-Request':'1'}
  self.assertEqual(c.delete('/api/logs/'+self.id+'/prepared',headers=headers,environ_overrides=peer).status_code,200)
  self.assertEqual(server.read_meta(self.path)['tags'],tags)
  server.requeue_startup();self.assertEqual(server.read_meta(self.path)['tags'],tags)
  with patch.object(server,'submit'):
   c.post('/api/logs/'+self.id+'/convert',headers=headers,environ_overrides=peer)
  self.assertEqual(server.read_meta(self.path)['tags'],tags)
  with patch.object(server,'cleanup_uploads'):
   self.assertEqual(c.get('/api/logs',environ_overrides=peer).json['logs'][0]['tags'],tags)
 def test_concurrent_additions_do_not_overwrite_each_other(self):
  with ThreadPoolExecutor(max_workers=4) as pool:
   results=list(pool.map(lambda i:self.post({'action':'add','tags':[{'name':str(i)}]}).status_code,range(12)))
  self.assertEqual(results,[200]*12)
  self.assertEqual({tag['name'] for tag in server.read_meta(self.path)['tags']},{str(i) for i in range(12)})

if __name__=='__main__':unittest.main()
