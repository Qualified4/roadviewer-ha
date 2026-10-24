import gzip,sys,unittest,math,tempfile
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
 def test_ccnc_rear_bits_and_message_freshness(self):
  from decoder import ccnc_rear_targets,ccnc_at
  payload=bytearray(32)
  payload[20]=2<<3;payload[21]=80;payload[22]=35 # LR: 8m behind, 3.5m left.
  bits=int.from_bytes(payload,'little')|(4<<192)|(160<<197)|(42<<205)
  rows=ccnc_rear_targets(bits.to_bytes(32,'little'))
  self.assertEqual(rows,[dict(slot='LR',detect=2,x=-8,yRel=3.5,y=-3.5),dict(slot='RR',detect=4,x=-16,yRel=-4.2,y=4.2)])
  self.assertEqual(ccnc_rear_targets(bytes(32)),[]);self.assertEqual(ccnc_rear_targets(b''),[])
  self.assertEqual(ccnc_at([(100,True,rows)],[100],100),rows)
  self.assertIsNone(ccnc_at([(100,True,rows)],[100],99));self.assertIsNone(ccnc_at([(100,True,rows)],[100],150_000_100))
  self.assertIsNone(ccnc_at([(100,False,rows)],[100],100))

 def test_actual_capnp_decode(self):
  import decoder,zstandard,json
  messages=[]
  for name,values in [('liveCalibration',{'calStatus':'calibrated','rpyCalib':[0,0,0],'height':[1.2]}),('deviceState',{'deviceType':'tici'}),('roadCameraState',{'sensor':'ar0231'}),('carParams',{'brand':'hyundai'}),('carState',{'vEgo':10,'steeringPressed':True,'steeringAngleDeg':23}),('carControl',{'latActive':True}),('controlsState',{'activeLaneLine':True}),('carOutput',{'actuatorsOutput':{'torque':.8}}),('modelV2',{'frameId':1,'timestampEof':1_010_000_000,'position':{'x':[0,10,20],'y':[0,1,-2],'z':[0,0,0]},'laneLines':[],'laneLineProbs':[],'roadEdges':[],'roadEdgeStds':[]})]:
   e=decoder.log.Event.new_message();e.logMonoTime=1_000_000_000;e.valid=True;e.init(name);setattr(e,name,values);messages.append(e.to_bytes())
  e=decoder.log.Event.new_message();e.logMonoTime=1_000_000_000;e.valid=True;e.init('sendcan',1)
  payload=bytearray(32);payload[20]=2<<3;payload[21]=80;payload[22]=35
  e.sendcan[0].address=0x162;e.sendcan[0].src=0;e.sendcan[0].dat=bytes(payload);messages.append(e.to_bytes())
  with tempfile.TemporaryDirectory() as d:
   p=Path(d)/'rlog.zst';p.write_bytes(zstandard.ZstdCompressor().compress(b''.join(messages)))
   dest,data=decoder.prepare(p);self.assertEqual(data['frames'][0]['position'],[[0,0],[10,1],[20,-2]]);self.assertIsNotNone(data['frames'][0]['overlay']);self.assertEqual(len(data['frames'][0]['overlay']['geometry']['position']),3);s=data['frames'][0]['steering'];self.assertEqual(s['state'],'driver');self.assertEqual(s['angle'],23);self.assertEqual(s['color'],[255,255,255]);stored=json.loads(gzip.decompress((dest/'data.json.gz').read_bytes()))
   self.assertEqual(stored['frames'][0]['ccncRearTargets'][0]['slot'],'LR');self.assertEqual(stored['frames'][0]['ccncRearTargets'][0]['x'],-8)
   self.assertEqual(stored['frames'][0]['ccncTargets'],[])
   self.assertFalse(any(m.get('kind')=='ccnc' for m in stored['frames'][0]['overlay'].get('markers',[])))
if __name__=='__main__':unittest.main()
