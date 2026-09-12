import sys,unittest,math,tempfile
from pathlib import Path
sys.path.insert(0,'/app')
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'roadviewer/app'))
from steering import SteeringReplay,sample
class SteeringTests(unittest.TestCase):
 def state(self,pressed=False,active=True,angle=30,torque=1,angle_control=False):
  streams={'carState':[],'carControl':[],'controlsState':[],'carOutput':[],'liveParameters':[],'selfdriveState':[]}
  for t in range(0,1_000_000_001,50_000_000):
   values={'carState':{'steeringPressed':pressed,'steeringAngleDeg':angle,'vEgo':10},'carControl':{'latActive':active},'controlsState':{'lateralControlState':{'angleState' if angle_control else 'torqueState':{}},'activeLaneLine':True,'desiredCurvature':.03},'carOutput':{'actuatorsOutput':{'torque':torque}},'liveParameters':{'roll':0},'selfdriveState':{'alertHudVisual':'steerRequired','alertSize':'small'}}
   for k,v in values.items():streams[k].append((t,True,v))
  replay=SteeringReplay(streams)
  for t in range(0,1_000_000_001,50_000_000):result=replay.at(t)
  return result
 def test_driver_priority(self):
  s=self.state(pressed=True);self.assertEqual(s['color'],[255,255,255]);self.assertEqual(s['state'],'driver');self.assertEqual(s['angle'],30)
 def test_torque_color_scale_lane_alert(self):
  s=self.state();self.assertGreater(s['color'][0],250);self.assertGreater(s['scale'],1.49);self.assertTrue(s['lane']);self.assertTrue(s['critical'])
 def test_inactive(self):self.assertEqual(self.state(active=False)['color'],[230,230,230])
 def test_angle_controller(self):self.assertGreater(self.state(angle_control=True)['scale'],1.49)
 def test_no_future_stale_invalid(self):
  rows=[(100,True,{'pressed':True}),(200,False,{})]
  self.assertIsNone(sample(rows,[100,200],99));self.assertIsNone(sample(rows,[100,200],200));self.assertIsNone(sample(rows,[100,200],150_000_100))
 def test_missing_and_nonfinite(self):
  self.assertEqual(SteeringReplay({}).at(0)['state'],'unknown');self.assertIsNone(self.state(angle=math.nan)['angle']);self.assertIsNone(self.state(torque=math.nan)['torque'])
 def test_actual_capnp_decode(self):
  import decoder,zstandard,json
  messages=[]
  for name,values in [('carState',{'vEgo':10,'steeringPressed':True,'steeringAngleDeg':23}),('carControl',{'latActive':True}),('controlsState',{'activeLaneLine':True}),('carOutput',{'actuatorsOutput':{'torque':.8}}),('modelV2',{'frameId':1,'timestampEof':1_010_000_000,'position':{'x':[0,10,20],'y':[0,1,-2]},'laneLines':[],'laneLineProbs':[],'roadEdges':[],'roadEdgeStds':[]})]:
   e=decoder.log.Event.new_message();e.logMonoTime=1_000_000_000;e.valid=True;e.init(name);setattr(e,name,values);messages.append(e.to_bytes())
  with tempfile.TemporaryDirectory() as d:
   p=Path(d)/'rlog.zst';p.write_bytes(zstandard.ZstdCompressor().compress(b''.join(messages)))
   dest,data=decoder.prepare(p);self.assertEqual(data['frames'][0]['position'],[[0,0],[10,1],[20,-2]]);s=data['frames'][0]['steering'];self.assertEqual(s['state'],'driver');self.assertEqual(s['angle'],23);self.assertEqual(s['color'],[255,255,255]);json.loads((dest/'data.json').read_text())
if __name__=='__main__':unittest.main()
