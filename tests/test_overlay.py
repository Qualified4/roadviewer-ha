import math,sys,unittest
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'roadviewer/app'))
from overlay import OverlayProjector,project_point,camera_config,projection_coordinates

class OverlayTests(unittest.TestCase):
 def test_device_id_is_session_metadata_and_missing_is_unknown(self):
  for rows,expected in [([],None),([(0,False,{'dongleId':'invalid'})],None),([(0,True,{'dongleId':''})],None),([(0,False,{'dongleId':'invalid'}),(10_000_000_000,True,{'dongleId':'device-123'})],'device-123')]:
   projector=OverlayProjector({'initData':rows})
   for stamp in (0,90_000_000_000):self.assertEqual(projector.camera_info(stamp)['deviceId'],expected)
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
  for height in (0,.3,1,2):
   projected=[v+height*out['heightDirection'][i] for i,v in enumerate(out['markers'][0]['projection'])]
   self.assertEqual([round(projected[i]/projected[2],6) for i in (0,1)],project_point((10,0,1.2-height),(0,0,0),camera_config('tici','ar0231')))
  # Tilt changes depth too: use projective coordinates, not linear interpolation in pixels.
  for rpy in ([.1,.2,-.1],[-.2,-.1,.3]):
   config=camera_config('tici','ar0231');base=projection_coordinates((5,1,1.2),rpy,config);direction=projection_coordinates((0,0,-1),rpy,config)
   for height in (0,.3,1,2):
    projected=[v+height*direction[i] for i,v in enumerate(base)]
    self.assertEqual([round(projected[i]/projected[2],6) for i in (0,1)],project_point((5,1,1.2-height),rpy,config))
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

 def test_camera_info_measured_default_invalid_and_stale(self):
  streams={'liveCalibration':[(0,True,{'calStatus':'uncalibrated','rpyCalib':[0,.1,-.2],'height':[1.5]}),(1_000_000_000,True,{'calStatus':'calibrated','rpyCalib':[0,0,0],'height':[]})],
           'deviceState':[(0,True,{'deviceType':'mici'})],'roadCameraState':[(0,True,{'sensor':'os04c10'})]}
  projector=OverlayProjector(streams)
  first=projector.camera_info(0)
  self.assertEqual(first['device'],'mici');self.assertEqual(first['sensor'],'os04c10')
  self.assertEqual(first['rpy'],[0,.1,-.2]);self.assertEqual(first['height'],1.5);self.assertFalse(first['heightDefault'])
  self.assertEqual(first['calibrationStatus'],'uncalibrated');self.assertIsNone(projector.project(0,{},{}))
  default=projector.camera_info(1_000_000_000)
  self.assertEqual(default['height'],1.22);self.assertTrue(default['heightDefault'])
  self.assertIsNotNone(projector.project(1_000_000_000,{},{}))
  stale=projector.camera_info(12_000_000_000)
  self.assertIsNone(stale['rpy']);self.assertEqual(stale['calibrationStatus'],'unknown');self.assertEqual(stale['device'],'mici')
  for height in [float('nan'),float('inf'),-1,9]:
   p=OverlayProjector({'liveCalibration':[(0,True,{'rpyCalib':[0,float('nan'),0],'height':[height]})]})
   self.assertTrue(p.camera_info(0)['heightDefault']);self.assertIsNone(p.camera_info(0)['rpy'])
  empty=OverlayProjector({}).camera_info(0)
  self.assertEqual(empty['device'],'unknown');self.assertEqual(empty['sensor'],'unknown')

if __name__=='__main__':unittest.main()
