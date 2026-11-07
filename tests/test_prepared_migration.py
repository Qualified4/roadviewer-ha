import gzip,json,os,subprocess,sys,tempfile,unittest
from pathlib import Path
from unittest.mock import patch
os.environ['RV_DATA']=tempfile.mkdtemp() # Before importing server, which creates its data folder.
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'roadviewer/app'))
import server
from compact import compact_data,expand_frames,write_gzip_json,REPLAY_V

FRAME={'t':0,'id':1,'cameraInfo':{'device':'tizi','deviceId':'d','sensor':'os04c10','calibrationStatus':'calibrated','rpy':[0,0,0],'height':1.22,'heightDefault':False},
 'liveTracks':[{'index':3,'trackId':7,'x':42.29999923706055,'y':-2.9000000953674316,'yRel':2.9000000953674316,'vRel':.41999998688697815,'measured':True,'source':'frontRadar','trackState':2}],
 'radarTargets':[{'group':'left','index':1,'x':6.331348419189453,'y':-.09491325914859772,'yRel':.09491325914859772,'vRel':.44,'radar':True,'trackId':48,'modelProb':.029999999329447746}],
 'leads':[{'x':7.4296875,'y':-.076171875,'p':.9999982118606567,'speedKph':31.415625000000002}],'selected':{'x':6.331348419189453,'y':-.09491325914859772,'radar':True,'vRel':.44,'trackId':48},
 'lp':[.4999999],'overlay':{'heightDirection':[.1,.2,.3],'lanes':[[None,[-1.252792,3.034763]]],'edges':[],'path':[[.5,.6]],'markers':[{'kind':'model','index':0,'point':[.48908,.787639],'projection':[3.6182092105449004,5.8269425531224,7.3979848401320645]}]}}

GRID=[0.0,0.1875,0.75]
def geometry_frame(lanes_2d=True):
 # A frame with overlay geometry as overlay.project writes it, and the top-down lines decoder.points makes from the same model.
 lanes=[[(x,-1.7+i,0.01*i) for x in GRID] for i in range(2)];edges=[[(x,-3.5,0.0) for x in GRID]];position=[(0.0,0.0,0.0),(4.0,0.123456,0.02),(9.0,0.4,0.05)]
 flat=lambda line:[[round(x,3),round(y,3)] for x,y,*_ in line]
 frame={'t':0,'overlay':{'geometry':{'basis':[[1,0,0],[0,1,0],[0,0,1]],'height':1.22,'lanes':lanes,'edges':edges,'position':position}},'edges':[flat(l) for l in edges],'position':flat(position)}
 if lanes_2d:frame['lanes']=[flat(l) for l in lanes]
 return frame

class CompactTests(unittest.TestCase):
 def test_chunked_json_and_gzip_progress_preserve_atomic_bytes(self):
  with tempfile.TemporaryDirectory() as root:
   path=Path(root)/'data.json.gz';value={'route':'한글 경로','frames':[{'t':i,'text':'영상'*1024} for i in range(129)],'empty':[]}
   write_gzip_json(path,value,ensure_ascii=False);before=path.read_bytes();events=[]
   write_gzip_json(path,value,ensure_ascii=False,progress=lambda stage,p:events.append((stage,p)))
   self.assertEqual(path.read_bytes(),before)
   self.assertEqual(gzip.decompress(path.read_bytes()),json.dumps(value,separators=(',',':'),allow_nan=False,ensure_ascii=False).encode())
   for stage in ('encode','compress'):
    values=[p for kind,p in events if kind==stage]
    self.assertEqual(values,sorted(values));self.assertEqual(values[0],0);self.assertEqual(values[-1],100)
    self.assertTrue(any(0<p<100 for p in values))
   with self.assertRaises(ValueError):write_gzip_json(path,{'frames':[{'x':float('nan')}]},progress=lambda *args:None)
   self.assertEqual(path.read_bytes(),before,'encoding failure must preserve the previous complete file')

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

 def test_format_2_leaves_out_what_the_geometry_gives(self):
  # Top-down lines equal to the geometry's x/y are left out, a frame without them is marked null, and lane/edge
  # points on the model's distance grid keep [y, z]; expand_frames (and app.js expandReplayData) restore it all.
  differing=geometry_frame();differing['position']=[[0.0,0.0],[4.0,0.5],[9.0,0.4]]
  odd=geometry_frame();odd['overlay']['geometry']['edges']=[[(0.0,-3.5,0.0),(2.0,-3.5,0.0),(5.0,-3.4,0.0)]];odd['edges']=[[[0.0,-3.5],[2.0,-3.5],[5.0,-3.4]]]
  frames=[geometry_frame(),geometry_frame(lanes_2d=False),differing,odd]
  original=json.loads(json.dumps(frames));data=compact_data({'frames':frames})
  self.assertEqual((data['replayV'],data['laneX']),(REPLAY_V,GRID))
  first,without,kept,offgrid=data['frames']
  self.assertFalse({'lanes','edges','position'}&set(first),'derivable top-down lines are left out')
  self.assertIsNone(without['lanes'],'a frame that had no top-down lanes keeps having none')
  self.assertEqual(kept['position'],[[0.0,0.0],[4.0,0.5],[9.0,0.4]],'lines that differ from the geometry stay')
  self.assertEqual(first['overlay']['geometry']['lanes'][1],[[-0.7,0.01]]*3)
  self.assertEqual(offgrid['overlay']['geometry']['edges'],[[[0.0,-3.5,0.0],[2.0,-3.5,0.0],[5.0,-3.4,0.0]]],'a line off the grid keeps its x')
  self.assertEqual(compact_data(json.loads(json.dumps(data))),data,'idempotent')
  back=expand_frames(json.loads(json.dumps(data)))['frames']
  for frame,before in zip(back,original):
   for key in ('lanes','edges','position'):self.assertEqual(frame.get(key),before.get(key),key)
   self.assertEqual(frame['overlay']['geometry']['lanes'],json.loads(json.dumps(before['overlay']['geometry']['lanes'])))
  self.assertEqual(round(back[0]['position'][1][1],3),0.123)

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
 def test_older_gzip_replay_is_rewritten_once(self):
  # 1.0.6 and earlier wrote format 1 at gzip level 3: rewritten in format 2 and marked in summary.json, which the next
  # start reads instead of opening the replay again.
  for f in ('data.json','telemetry.json'):(self.p/'prepared'/f).unlink()
  old={'frames':[geometry_frame() for _ in range(40)]}
  (self.p/'prepared/data.json.gz').write_bytes(gzip.compress(json.dumps(old).encode(),compresslevel=3))
  (self.p/'prepared/telemetry.json.gz').write_bytes(gzip.compress(b'{"streams":{}}'))
  (self.p/'prepared/summary.json').write_text(json.dumps({'duration':60,'started_at':1.5}))
  before=(self.p/'prepared/data.json.gz').stat().st_size
  server.migrate_prepared()
  data=json.loads(gzip.decompress((self.p/'prepared/data.json.gz').read_bytes()))
  self.assertEqual(data['replayV'],REPLAY_V);self.assertNotIn('lanes',data['frames'][0])
  self.assertLess((self.p/'prepared/data.json.gz').stat().st_size,before)
  self.assertEqual(json.loads((self.p/'prepared/summary.json').read_text()),{'duration':60,'started_at':1.5,'replay_v':REPLAY_V})
  self.assertEqual(sorted(f.name for f in (self.p/'prepared').iterdir()),['data.json.gz','summary.json','telemetry.json.gz'])
  with patch.object(server.subprocess,'run') as run:server.migrate_prepared()
  run.assert_not_called()

 def test_unfinished_logs_are_not_migrated(self):
  server.save_meta(self.p,dict(id=self.p.name,status='processing'))
  server.migrate_prepared()
  self.assertTrue((self.p/'prepared/data.json').is_file());self.assertFalse((self.p/'prepared/data.json.gz').exists())

if __name__=='__main__':unittest.main()
