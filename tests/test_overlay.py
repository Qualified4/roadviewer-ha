import math,sys,unittest
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'roadviewer/app'))
from overlay_reference import OverlayProjector
from overlay import project_point,camera_config,projection_coordinates,restore_ccnc_targets

class StoredGeometryTests(unittest.TestCase):
 def test_only_source_geometry_is_stored(self):
  from overlay import OverlayProjector as SourceProjector
  streams={'liveCalibration':[(0,True,{'calStatus':'calibrated','rpyCalib':[0,0,0],'height':[1.2]})],'deviceState':[(0,True,{'deviceType':'tici'})]}
  model={'position':{'x':[10,20],'y':[0,1],'z':[0,.1]}}
  out=SourceProjector(streams).project(0,model,{})
  self.assertEqual(set(out),{'geometry'})
  self.assertEqual(set(out['geometry']),{'basis','height','lanes','edges','position'})
  self.assertEqual(out['geometry']['position'],[(10,0,0),(20,1,.1)])
  self.assertIsNone(SourceProjector({}).project(0,model,{}))

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
  frame={'leads':[{'x':10,'y':0}], 'radarTargets':[{'x':10,'y':-1}], 'ccncTargets':[{'slot':'RF','x':10,'y':2}]}
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
  self.assertEqual(out['markers'][2]['kind'],'ccnc')
  marker=out['markers'][2];box=marker['box'];self.assertEqual(len(box),8)
  for i in range(3):self.assertAlmostEqual((box[0][i]+box[1][i])/2,marker['projection'][i])
  config=camera_config('tici','ar0231')
  for index,point in enumerate([(10,1.1,1.2),(10,2.9,1.2),(14.5,1.1,1.2),(14.5,2.9,1.2),(10,1.1,-.3),(10,2.9,-.3),(14.5,1.1,-.3),(14.5,2.9,-.3)]):
   for actual,expected in zip(box[index],projection_coordinates(point,[0,0,0],config)):self.assertAlmostEqual(actual,expected)
  self.assertGreater(out['markers'][2]['point'][0],.5)
  self.assertIsNone(OverlayProjector({}).project(100,model,frame))

 def test_boxes_follow_lane_center_five_meters_ahead(self):
  streams={'liveCalibration':[(0,True,{'calStatus':'calibrated','rpyCalib':[0,0,0],'height':[1.2]})],'deviceState':[(0,True,{'deviceType':'tici'})]}
  projector=OverlayProjector(streams);config=camera_config('tici','unknown')
  for slope in (-.6,0,.6):
   # Different boundary slopes verify that both sides contribute to the heading.
   lanes=[{'x':[0,10,15,20],'y':[offset+slope*x+spread*x for x in (0,10,15,20)],'z':[1.2]*4} for offset,spread in ((-1.8,-.05),(1.8,.05))]
   model={'laneLines':[{},*lanes,{}]}
   frame={'ccncTargets':[{'slot':slot,'x':10,'y':y} for slot,y in (('LF',-3),('FF',0),('RF',3))]}
   out=projector.project(0,model,frame)
   fx=1/math.hypot(1,slope);fy=slope*fx
   for marker,target in zip(out['markers'],frame['ccncTargets']):
    box=marker['box']
    for k in range(3):self.assertAlmostEqual((box[0][k]+box[1][k])/2,marker['projection'][k],msg='rear anchor must not move')
    expected=[projection_coordinates((10+dx*fx-dy*fy,target['y']+dx*fy+dy*fx,1.2-up),[0,0,0],config)
              for up in (0,1.5) for dx in (0,4.5) for dy in (-.9,.9)]
    for point,want in zip(box,expected):
     for actual,value in zip(point,want):self.assertAlmostEqual(actual,value)
   # Missing, short or invalid geometry must retain the original straight box.
   fallback=projector.project(0,{},frame)['markers']
   for invalid in ([{},lanes[0]], [{},lanes[0],{'x':[0,12],'y':[0,1],'z':[1.2]*2}], [{},lanes[0],{'x':[0,20],'y':[0,float('nan')],'z':[1.2]*2}]):
    self.assertEqual(projector.project(0,{'laneLines':invalid},frame)['markers'],fallback)

 def test_target_line_and_path_width_projection(self):
  streams={'liveCalibration':[(0,True,{'calStatus':'calibrated','rpyCalib':[0,0,0],'height':[1.2]})],'deviceState':[(0,True,{'deviceType':'tici'})]}
  model={'position':{'x':[10,20],'y':[0,0],'z':[0,0]},'laneLines':[{'x':[10,20],'y':[y,y],'z':[1.2,1.2]} for y in (-5.4,-1.8,1.8,5.4)]}
  p=OverlayProjector(streams);frame={'ccncRoad':{'target':1,'distance':15}}
  out=p.project(0,model,frame);config=camera_config('tici','unknown')
  self.assertEqual(out['laneDepths'],[[10,20],[10,20]])
  for i,y in enumerate((-1.8,1.8)):
   for j,x in enumerate((10,20)):
    uv=out['lanes'][i+1][j];depth=out['laneDepths'][i][j]
    raised=[v+n*1.2 for v,n in zip([uv[0]*depth,uv[1]*depth,depth],out['heightDirection'])]
    expected=project_point((x,y,0),[0,0,0],config)
    for actual,value in zip([raised[0]/raised[2],raised[1]/raised[2]],expected):self.assertAlmostEqual(actual,value,places=5)
  self.assertEqual(out['targetLine'],[project_point((15,y,1.2),[0,0,0],config) for y in (-.9,.9)])
  self.assertEqual(len(out['targetSections']),11,'stop at the available 10 m lane boundary')
  for width in (1,1.8,3):
   for index,section in enumerate(out['targetSections']):
    center,side=section
    for sign in (-1,1):
     q=[v+sign*width/2*w for v,w in zip(center,side)]
     expected=project_point((15-index*.5,sign*width/2,1.2),[0,0,0],config)
     for actual,value in zip([q[j]/q[2] for j in (0,1)],expected):self.assertAlmostEqual(actual,value,places=5)
  self.assertEqual(p.project(0,model,{'ccncRoad':{'target':0,'distance':15}})['targetSections'],[])

  for width in (1,1.8,3):
   for i,x in enumerate((10,20)):
    for sign in (-1,1):
     q=[c+sign*n*width/2 for c,n in zip(out['pathProjection'][i],out['pathSides'][i])]
     expected=projection_coordinates((x,sign*width/2,1.2),[0,0,0],config)
     for actual,value in zip(q,expected):self.assertAlmostEqual(actual,value)
  self.assertEqual(p.project(0,model,{'ccncRoad':{'target':0,'distance':15}})['targetLine'],[])
  self.assertEqual(p.project(0,model,{'ccncRoad':{'target':1,'distance':204.6}})['targetLine'],[])
  self.assertEqual(p.project(0,model,{'ccncRoad':{'target':1,'distance':30}})['targetLine'],[None,None])

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

class RoadPerspectiveTests(unittest.TestCase):
 def test_ccnc_distance_and_lane_center_inverse(self):
  target={'slot':'LF','detect':3,'x':40,'y':1,'yRel':-1}
  def model(sign):return {'laneLines':[{},*[{'x':[0,20,40,60],'y':[offset+sign*d for d in (0,1,4,9)],'z':[1.2]*4} for offset in (-1.8,1.8)]]}
  for sign in (-1,0,1):
   result=restore_ccnc_targets([target],model(sign))[0]
   self.assertEqual(result['x'],50);self.assertEqual(result['y'],1+sign*6.5);self.assertEqual(result['yRel'],-result['y']);self.assertTrue(result['curveRestored'])
   self.assertEqual(result['displayX'],40);self.assertEqual(result['displayY'],1)
  self.assertEqual(target['x'],40,'held CAN samples must not be modified repeatedly')
  self.assertEqual(restore_ccnc_targets([target],model(1),False)[0]['y'],1)
  self.assertFalse(restore_ccnc_targets([target],{'laneLines':[]})[0]['curveRestored'])
  self.assertEqual(restore_ccnc_targets([{**target,'x':80}],model(1))[0]['y'],1,'do not extrapolate missing lane geometry')
  self.assertIsNone(restore_ccnc_targets(None,{}));self.assertEqual(restore_ccnc_targets([],{}),[])

 def test_ff_uses_position_offset_with_lane_fallback(self):
  targets=[{'slot':slot,'x':24,'y':.5} for slot in ('LF','FF','RF')]
  for sign in (-1,1):
   model={'position':{'x':[0,20,40],'y':[.2,sign*2,sign*6],'z':[1.2]*3},
          'laneLines':[{},*[{'x':[0,20,40],'y':[offset,offset+sign,offset+sign*3],'z':[1.2]*3} for offset in (-1.8,1.8)]]}
   result=restore_ccnc_targets(targets,model)
   self.assertEqual([r['y'] for r in result],[.5+sign*2,.5+sign*4,.5+sign*2])
   self.assertEqual(result[1]['yRel'],-result[1]['y']);self.assertEqual(result[1]['displayY'],.5)
   self.assertTrue(result[1]['curveRestored']);self.assertEqual(result[1]['x'],30)
   self.assertEqual(restore_ccnc_targets(targets,model,False)[1]['y'],.5)
   for position in ({},{'x':[0,10],'y':[0,1],'z':[1.2]*2},{'x':[0,40],'y':[0,float('nan')],'z':[1.2]*2}):
    self.assertEqual(restore_ccnc_targets(targets,{**model,'position':position})[1]['y'],.5+sign*2,'unavailable path falls back without extrapolation')
  self.assertTrue(all(t['x']==24 and t['y']==.5 for t in targets))

 def test_projected_bands_narrow_with_distance_and_bsd_stops_at_40m(self):
  streams={'liveCalibration':[(0,True,{'calStatus':'calibrated','rpyCalib':[0,0,0],'height':[1.2]})],'deviceState':[(0,True,{'deviceType':'tici'})]}
  lane={'x':[0,10,20,60],'y':[1.8]*4,'z':[1.2]*4}
  model={'laneLines':[lane]*4,'laneLineProbs':[1]*4,'roadEdges':[lane,lane],'roadEdgeStds':[0,2]}
  out=OverlayProjector(streams).project(0,model,{})
  for key in ('laneBands','edgeBands'):
   a,b=out[key][0];near=abs(a[1][0]-b[1][0]);far=abs(a[3][0]-b[3][0]);self.assertAlmostEqual(near/far,6,places=3)
   self.assertIsNone(a[0]);self.assertIsNone(b[0])
  strong=out['edgeBands'][0];weak=out['edgeBands'][1]
  self.assertGreater(abs(strong[0][1][0]-strong[1][1][0]),abs(weak[0][1][0]-weak[1][1][0]))
  for path in out['blindspotPaths']:
   self.assertEqual(path[-1][2],40);self.assertEqual(len(path),21);self.assertTrue(all(p[2]<=40 for p in path))
  lane['x']=[0,10,20,33]
  short=OverlayProjector(streams).project(0,model,{})
  self.assertEqual(short['blindspotPaths'][0][-1][2],33,'short models must not be extrapolated')

if __name__=='__main__':unittest.main()
