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
  self.assertEqual(values['targetAngle'],[10,None,10]);self.assertEqual(values['commandTorque'],[.4,None,.4]);self.assertEqual(values['targetAcceleration'],[1.2,None,1.2])
  self.assertEqual(extract_telemetry({'carControl':[(0,True,control)]},0,1)['streams']['carControl']['values']['targetAngle'],[10])
 def test_auto_commands_are_separate_from_driver_pedals(self):
  active={'longActive':True,'latActive':True,'actuators':{'accel':-1.5,'aTarget':-1.2,'jerk':-.3,'longControlState':'stopping','steeringAngleDeg':7}}
  rows=[(0,True,active),(10_000_000,True,{**active,'longActive':False}),(20_000_000,False,active),(30_000_000,True,{'longActive':True,'actuators':{'accel':2,'longControlState':'starting'}})]
  streams=extract_telemetry({'carControl':rows,'carState':[(0,True,{'gas':0,'brake':0,'gasPressed':False,'brakePressed':False,'engineRpm':1800})],'carOutput':[(0,True,{'actuatorsOutput':{'gas':.25,'brake':.4,'accel':-1.1}})]},0,1)['streams']
  control=streams['carControl']['values'];state=streams['carState']['values'];out=streams['carOutput']['values']
  self.assertEqual(control['decelRequested'],[True,False,None,False]);self.assertEqual(control['accelRequested'],[False,False,None,True])
  self.assertEqual(control['plannedAcceleration'],[-1.2,None,None,None]);self.assertEqual(control['jerk'],[-.3,None,None,None])
  self.assertEqual(control['long_stopping'],[True,True,None,False]);self.assertEqual(control['long_starting'],[False,False,None,True])
  self.assertEqual(state['gasPressed'],[False]);self.assertEqual(state['brake'],[0]);self.assertEqual(state['rpm'],[1800])
  self.assertEqual(out['outputGas'],[25]);self.assertEqual(out['outputBrake'],[40]);self.assertEqual(out['outputAcceleration'],[-1.1])
 def test_controller_targets_legacy_output_and_missing_values(self):
  controls=[(0,True,{'longControlState':'off','lateralControlState':{'angleState':{'active':True,'steeringAngleDesiredDeg':12}}}),
   (10_000_000,True,{'lateralControlState':{'torqueState':{'active':True,'actualLateralAccel':.8,'desiredLateralAccel':1.2}}}),
   (20_000_000,False,{'longControlState':'off'})]
  legacy=[(0,True,{'actuatorsOutputDEPRECATED':{'gas':.1,'brake':.2,'steeringAngleDeg':9}})]
  result=extract_telemetry({'controlsState':controls,'carControl':legacy,'carState':[(0,True,{'engineRpm':0}),(10_000_000,True,{}),(20_000_000,False,{'engineRpm':1800}),(30_000_000,True,{'engineRpm':float('inf')})]},0,1)['streams']
  self.assertEqual(result['controlsState']['values']['desiredAngle'],[12,None,None])
  self.assertEqual(result['controlsState']['values']['desiredLateralAccel'],[None,1.2,None]);self.assertEqual(result['controlsState']['values']['long_off'],[True,None,None])
  self.assertEqual(result['carOutput']['values']['outputGas'],[10]);self.assertEqual(result['carOutput']['values']['outputAngle'],[9])
  self.assertEqual(result['carState']['values']['rpm'],[0,None,None,None])
  modern=extract_telemetry({'carControl':legacy,'carOutput':[(0,False,{'actuatorsOutput':{'gas':.3}})]},0,1)
  self.assertEqual(modern['streams']['carOutput']['values']['outputGas'],[None])
 def test_video_offset_and_boundary_samples(self):
  result=extract_telemetry({'carState':[(10_000_000_000,True,{'vEgo':10}),(12_000_000_000,True,{'vEgo':20})]},9.5,1)
  self.assertEqual(result['streams']['carState']['times'],[.5])

if __name__=='__main__':unittest.main()
