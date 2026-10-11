import json,os,sys,tempfile,unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from unittest.mock import patch
os.environ.setdefault('RV_DATA',tempfile.mkdtemp())
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'roadviewer/app'))
import server

class BookmarkTests(unittest.TestCase):
 def setUp(self):
  temp=tempfile.TemporaryDirectory();self.addCleanup(temp.cleanup);self.root=Path(temp.name)
  p=patch.object(server,'ROOT',self.root);p.start();self.addCleanup(p.stop)
  self.id='a'*32;self.path=self.root/self.id;self.path.mkdir();(self.path/'rlog.zst').write_bytes(b'log')
  (self.path/'prepared').mkdir();(self.path/'prepared/data.json').write_text('{}')
  server.save_meta(self.path,dict(id=self.id,name='test',status='ready',uploaded=1,duration=60,tags=[{'name':'test'}],pinned=True))
 def call(self,method='GET',body=None,suffix='',headers=True,peer='172.30.32.2'):
  return server.app.test_client().open('/api/logs/'+self.id+'/bookmarks'+suffix,method=method,json=body,headers={'X-RoadViewer-Request':'1'} if headers else {},environ_overrides={'REMOTE_ADDR':peer})
 def add(self,t=10,title='장면',note='메모'):
  return self.call('POST',dict(time=t,title=title,note=note))
 def test_crud_sorted_persistent_and_private(self):
  self.assertEqual(self.call().json,{'bookmarks':[]})
  first=self.add(20).json['bookmarks'][0];self.add(0)
  self.assertEqual([b['time'] for b in self.call().json['bookmarks']],[0,20])
  r=self.call('PUT',dict(time=60,title='  끝  ',note='메모\n둘째 줄'),'/'+first['id']);self.assertEqual(r.status_code,200)
  self.assertEqual(r.json['bookmarks'][-1],dict(id=first['id'],time=60,title='끝',note='메모\n둘째 줄'))
  self.assertEqual(self.call('DELETE',suffix='/'+first['id']).status_code,200)
  self.assertEqual(self.call('DELETE',suffix='/'+first['id']).status_code,404)
  self.assertEqual(len(self.call().json['bookmarks']),1)
  m=server.read_meta(self.path);self.assertTrue(m['pinned']);self.assertEqual(m['tags'],[{'name':'test'}])
 def test_invalid_requests_cannot_change_metadata(self):
  before=server.read_meta(self.path)
  for time in [-1,61,True,'1',None,float('nan'),float('inf'),10**400]:
   with self.subTest(time=time):self.assertEqual(self.add(time).status_code,400)
  for title,note in [('', ''),('x'*81,''),('ok','x'*1001),('x\x00',''),([],''),('ok',{})]:
   self.assertEqual(self.add(title=title,note=note).status_code,400)
  self.assertEqual(self.call('POST',{'time':1,'title':'x','note':'','pinned':False}).status_code,400)
  self.assertEqual(self.call('POST',{'time':1,'title':'x','note':''},headers=False).status_code,403)
  self.assertEqual(self.call(peer='192.0.2.1').status_code,403)
  self.assertEqual(self.add(note='x'*9000).status_code,413)
  self.assertEqual(server.read_meta(self.path),before)
 def test_limit_and_concurrency(self):
  with ThreadPoolExecutor(max_workers=4) as pool:results=list(pool.map(lambda i:self.add(i).status_code,range(20)))
  self.assertEqual(results,[201]*20);items=self.call().json['bookmarks'];self.assertEqual(len({b['id'] for b in items}),20)
  for i in range(80):self.assertEqual(self.add().status_code,201)
  self.assertEqual(self.add().status_code,400)
  self.assertEqual(self.call('PUT',dict(time=1,title='수정',note=''),'/'+items[0]['id']).status_code,200)
 def test_survives_prepared_removal_requeue_and_conversion(self):
  items=self.add().json['bookmarks'];c=server.app.test_client();kwargs=dict(headers={'X-RoadViewer-Request':'1'},environ_overrides={'REMOTE_ADDR':'172.30.32.2'})
  self.assertEqual(c.delete('/api/logs/'+self.id+'/prepared',**kwargs).status_code,200)
  server.requeue_startup()
  with patch.object(server,'submit'):c.post('/api/logs/'+self.id+'/convert',**kwargs)
  self.assertEqual(server.read_meta(self.path)['bookmarks'],items)
  with patch.object(server,'cleanup_uploads'):
   self.assertNotIn('bookmarks',c.get('/api/logs',**kwargs).json['logs'][0])
  m=server.read_meta(self.path);m['status']='unconverted';server.save_meta(self.path,m)
  self.assertEqual(c.delete('/api/logs/'+self.id,**kwargs).status_code,200)
  self.assertEqual(self.call().status_code,404)

if __name__=='__main__':unittest.main()
