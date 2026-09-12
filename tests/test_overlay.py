import math,sys,unittest
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'roadviewer/app'))
from overlay import OverlayProjector,project_point,camera_config

class OverlayTests(unittest.TestCase):
 def test_projection_axes_and_depth(self):
  config=camera_config('tici','ar0231')
  self.assertEqual(project_point((10,0,0),(0,0,0),config),[.5,.5])
  self.assertGreater(project_point((10,1,1),(0,0,0),config)[0],.5)
  self.assertGreater(project_point((10,1,1),(0,0,0),config)[1],.5)
  self.assertIsNone(project_point((-1,0,0),(0,0,0),config))
  self.assertIsNone(project_point((1,math.nan,0),(0,0,0),config))
  self.assertIsNone(camera_config('unknown','unknown'))
 def test_calibration_and_road_height(self):
  streams={'liveCalibration':[(100,True,{'calStatus':'calibrated','rpyCalib':[0,0,0],'height':[1.2]})],'deviceState':[(100,True,{'deviceType':'tici'})],'roadCameraState':[(100,True,{'sensor':'ar0231'})]}
  model={'position':{'x':[10,20],'y':[0,0],'z':[0,0]},'laneLines':[{'x':[10,20],'y':[1,1],'z':[1.2,1.2]}]}
  frame={'leads':[{'x':10,'y':0}], 'radarTargets':[{'x':10,'y':-1}]}
  p=OverlayProjector(streams)
  self.assertEqual(p.project(99,model,frame),p.project(100,model,frame))
  self.assertIsNone(p.project(11_000_000_100,model,frame))
  out=p.project(100,model,frame)
  self.assertEqual(out['path'][0],out['markers'][0]['point'])
  self.assertEqual(out['lanes'][0][0][1],out['path'][0][1])
  self.assertLess(out['markers'][1]['point'][0],.5)
  self.assertIsNone(OverlayProjector({}).project(100,model,frame))

 def test_startup_metadata_arrives_after_first_model(self):
  second=1_000_000_000
  calibration={'calStatus':'calibrated','rpyCalib':[0,0,0]}
  streams={'liveCalibration':[(2*second,True,calibration)],'deviceState':[(second,True,{'deviceType':'mici'})],'roadCameraState':[(second//10,True,{'sensor':'os04c10'})]}
  p=OverlayProjector(streams)
  self.assertIsNotNone(p.project(0,{},{}))
  self.assertIsNone(p.project(-1,{},{}))
  self.assertIsNone(OverlayProjector({**streams,'roadCameraState':[]}).project(0,{},{}))
  for valid,status in [(False,'calibrated'),(True,'uncalibrated')]:
   rows=[(second,valid,{**calibration,'calStatus':status}),(2*second,True,calibration)]
   q=OverlayProjector({**streams,'liveCalibration':rows})
   self.assertIsNone(q.project(0,{},{}))
   self.assertIsNone(q.project(second+1,{},{}))
   self.assertIsNotNone(q.project(2*second,{},{}))

if __name__=='__main__':unittest.main()
