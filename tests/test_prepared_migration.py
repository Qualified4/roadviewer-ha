import gzip,json,os,subprocess,sys,tempfile,unittest
from pathlib import Path
from unittest.mock import patch
os.environ['RV_DATA']=tempfile.mkdtemp() # Before importing server, which creates its data folder.
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'roadviewer/app'))
import server
from compact import compact_data

FRAME={'t':0,'id':1,'cameraInfo':{'device':'tizi','deviceId':'d','sensor':'os04c10','calibrationStatus':'calibrated','rpy':[0,0,0],'height':1.22,'heightDefault':False},
 'liveTracks':[{'index':3,'trackId':7,'x':42.29999923706055,'y':-2.9000000953674316,'yRel':2.9000000953674316,'vRel':.41999998688697815,'measured':True,'source':'frontRadar','trackState':2}],
 'radarTargets':[{'group':'left','index':1,'x':6.331348419189453,'y':-.09491325914859772,'yRel':.09491325914859772,'vRel':.44,'radar':True,'trackId':48,'modelProb':.029999999329447746}],
 'leads':[{'x':7.4296875,'y':-.076171875,'p':.9999982118606567,'speedKph':31.415625000000002}],'selected':{'x':6.331348419189453,'y':-.09491325914859772,'radar':True,'vRel':.44,'trackId':48},
 'lp':[.4999999],'overlay':{'heightDirection':[.1,.2,.3],'lanes':[[None,[-1.252792,3.034763]]],'edges':[],'path':[[.5,.6]],'markers':[{'kind':'model','index':0,'point':[.48908,.787639],'projection':[3.6182092105449004,5.8269425531224,7.3979848401320645]}]}}

class CompactTests(unittest.TestCase):
 def test_compact_is_idempotent_and_reversible(self):
  data=compact_data({'frames':[json.loads(json.dumps(FRAME)) for _ in range(3)]})
  self.assertEqual(data['cameraInfos'],[FRAME['cameraInfo']]);self.assertEqual([f['cameraInfo'] for f in data['frames']],[0,0,0])
  frame=data['frames'][0]
  self.assertEqual(frame['liveTracks'][0],{'trackId':7,'x':42.3,'yRel':2.9,'vRel':.42,'measured':True,'source':'frontRadar','trackState':2})
  self.assertEqual(frame['radarTargets'][0]['index'],1,'radar index is a per-group number and stays')
  self.assertNotIn('y',frame['radarTargets'][0]);self.assertEqual(frame['radarTargets'][0]['modelProb'],FRAME['radarTargets'][0]['modelProb'])
  self.assertEqual(frame['lp'],[.4999999],'thresholded probabilities are not rounded')
  marker=frame['overlay']['markers'][0];self.assertNotIn('point',marker)
  self.assertAlmostEqual(marker['projection'][0]/marker['projection'][2],FRAME['overlay']['markers'][0]['point'][0],places=5)
  self.assertEqual(frame['overlay']['lanes'],[[None,[-1.2528,3.0348]]])
  self.assertEqual(compact_data(json.loads(json.dumps(data))),data)

 def test_new_overlay_coordinates_keep_precision_and_gaps(self):
  overlay={'laneBands':[[[None,[.123456789,.87654321]]]],'laneDepths':[[12.123456789]],
           'pathProjection':[[1.123456789,2.123456789,.10000123]],
           'pathSides':[[.123456789,.987654321,.00000123]],
           'markers':[{'box':[[1.123456789,2.123456789,.10000123]]}]}
  data={'frames':[{'overlay':overlay,'lp':[.4999999]}]}
  compact_data(data)
  self.assertNotIn('laneDepths',overlay)
  self.assertIsNone(overlay['laneBands'][0][0][0])
  self.assertEqual(overlay['laneBands'][0][0][1],[.1235,.8765])
  self.assertEqual(overlay['pathSides'][0],[.123457,.987654,.000001])
  self.assertEqual(overlay['markers'][0]['box'],overlay['pathProjection'])
  self.assertEqual(data['frames'][0]['lp'],[.4999999])
  self.assertEqual(compact_data(json.loads(json.dumps(data))),data)

class MigrationTests(unittest.TestCase):
 def setUp(self):
  self.root=tempfile.TemporaryDirectory();root=Path(self.root.name)
  self.patches=[patch.object(server,'ROOT',root)];[p.start() for p in self.patches]
  self.p=root/('a'*32);(self.p/'prepared').mkdir(parents=True)
  server.save_meta(self.p,dict(id=self.p.name,status='ready',conversion_revision=2))
  (self.p/'prepared/data.json').write_text(json.dumps({'frames':[FRAME]}));(self.p/'prepared/telemetry.json').write_text('{"streams":{}}')
 def tearDown(self):
  [p.stop() for p in self.patches];self.root.cleanup()
 def test_plain_files_become_compact_gzip(self):
  before=(self.p/'prepared/data.json').stat().st_size
  server.migrate_prepared()
  self.assertEqual(sorted(f.name for f in (self.p/'prepared').iterdir()),['data.json.gz','telemetry.json.gz'])
  data=json.loads(gzip.decompress((self.p/'prepared/data.json.gz').read_bytes()))
  self.assertEqual(data['frames'][0]['cameraInfo'],0);self.assertLess((self.p/'prepared/data.json.gz').stat().st_size,before)
  self.assertEqual(json.loads(gzip.decompress((self.p/'prepared/telemetry.json.gz').read_bytes())),{'streams':{}})
  server.migrate_prepared() # Nothing left to migrate.
  self.assertEqual(len(list((self.p/'prepared').iterdir())),2)
 def test_conversion_started_meanwhile_keeps_its_own_files(self):
  real=subprocess.run
  def reconvert(*args,**kwargs):
   result=real(*args,**kwargs)
   m=server.read_meta(self.p);m.update(conversion_revision=3,status='processing');server.save_meta(self.p,m)
   return result
  with patch.object(server.subprocess,'run',side_effect=reconvert):server.migrate_prepared()
  self.assertEqual(sorted(f.name for f in (self.p/'prepared').iterdir()),['data.json','telemetry.json'],'stale migration output is discarded')
 def test_unfinished_logs_are_not_migrated(self):
  server.save_meta(self.p,dict(id=self.p.name,status='processing'))
  server.migrate_prepared()
  self.assertTrue((self.p/'prepared/data.json').is_file());self.assertFalse((self.p/'prepared/data.json.gz').exists())

if __name__=='__main__':unittest.main()
