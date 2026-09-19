import math,sys,unittest
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'roadviewer/app'))
from telemetry import extract_telemetry

class TelemetryTests(unittest.TestCase):
 def test_clock_units_brief_intervention_invalid_and_missing(self):
  origin=10
  rows=[(10_010_000_000,True,{'vEgo':10,'gas':.2,'steeringPressed':True}),
        (10_000_000_000,True,{'vEgo':0,'gas':0,'steeringPressed':False}),
        (10_020_000_000,True,{'vEgo':math.nan,'steeringPressed':False}),
        (10_030_000_000,False,{'vEgo':99,'steeringPressed':True}),
        (11_000_000_000,True,{'vEgo':15})]
  result=extract_telemetry({'carState':rows},origin,2)
  stream=result['streams']['carState'];self.assertEqual(stream['times'],[0,.01,.02,.03,1])
  self.assertEqual(stream['values']['speed'],[0,36,None,None,54])
  self.assertEqual(stream['values']['gas'][:2],[0,20])
  self.assertEqual(stream['values']['steeringPressed'],[False,True,False,None,None])
  self.assertEqual(stream['values']['brake'],[None]*5)
  self.assertEqual(result['streams']['carControl']['times'],[])
 def test_targets_only_with_applicable_active_controller(self):
  control={'latActive':True,'longActive':True,'actuators':{'steeringAngleDeg':10,'torque':.4,'accel':1.2}}
  streams={'carParams':[(0,True,{'steerControlType':'angle'}),(20_000_000,True,{'steerControlType':'torque'})],
           'carControl':[(0,True,control),(10_000_000,True,{**control,'latActive':False,'longActive':False}),(20_000_000,True,control)]}
  values=extract_telemetry(streams,0,1)['streams']['carControl']['values']
  self.assertEqual(values['targetAngle'],[10,None,None]);self.assertEqual(values['commandTorque'],[None,None,.4]);self.assertEqual(values['targetAcceleration'],[1.2,None,1.2])
  self.assertEqual(extract_telemetry({'carControl':[(0,True,control)]},0,1)['streams']['carControl']['values']['targetAngle'],[None])
 def test_video_offset_and_boundary_samples(self):
  result=extract_telemetry({'carState':[(10_000_000_000,True,{'vEgo':10}),(12_000_000_000,True,{'vEgo':20})]},9.5,1)
  self.assertEqual(result['streams']['carState']['times'],[.5])

if __name__=='__main__':unittest.main()
