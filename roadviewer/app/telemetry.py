"""Keep vehicle samples on their original log clock, independent of model frames."""
import math

# name: (nested field path, multiplier); None means a boolean, 'state' an enum.
FIELDS={
 'carState':{
  'speed':('vEgo',3.6),'clusterSpeed':('vEgoCluster',3.6),'cruiseSpeed':('cruiseState.speed',3.6),
  'acceleration':('aEgo',1),'gas':('gas',100),'brake':('brake',100),
  'steeringAngle':('steeringAngleDeg',1),'steeringRate':('steeringRateDeg',1),
  'driverTorque':('steeringTorque',1),'epsTorque':('steeringTorqueEps',1),'rpm':('engineRpm',1),
  'cruiseEnabled':('cruiseState.enabled',None),'cruiseAvailable':('cruiseState.available',None),
  **{key:(key,None) for key in ('gasPressed','brakePressed','regenBraking','steeringPressed','standstill','parkingBrake','brakeHoldActive')},
 },
 'carControl':{
  'targetAcceleration':('actuators.accel',1),'plannedAcceleration':('actuators.aTarget',1),'jerk':('actuators.jerk',1),
  'targetAngle':('actuators.steeringAngleDeg',1),'commandTorque':('actuators.torque',1),'commandCurvature':('actuators.curvature',1),
  'longState':('actuators.longControlState','state'),'enabled':('enabled',None),'latActive':('latActive',None),'longActive':('longActive',None),
 },
 'carOutput':{
  'outputTorque':('actuatorsOutput.torque',1),'outputAngle':('actuatorsOutput.steeringAngleDeg',1),'outputCurvature':('actuatorsOutput.curvature',1),
  'outputAcceleration':('actuatorsOutput.accel',1),'outputGas':('actuatorsOutput.gas',100),'outputBrake':('actuatorsOutput.brake',100),
 },
 'controlsState':{
  'actualCurvature':('curvature',1),'desiredCurvature':('desiredCurvature',1),'longState':('longControlState','state'),
  'actualLateralAccel':('lateralControlState.torqueState.actualLateralAccel',1),'desiredLateralAccel':('lateralControlState.torqueState.desiredLateralAccel',1),
 },
}
LONG_STATES={'off':0,'pid':1,'stopping':2,'starting':3}

def nested(record,path):
 for part in path.split('.'):record=record.get(part) if isinstance(record,dict) else None
 return record

def number(value,factor=1):
 if type(value) not in (int,float) or not math.isfinite(value):return None
 result=value*factor
 return round(result,6) if math.isfinite(result) else None

def extract_telemetry(streams,origin,duration):
 result={}
 for topic,fields in FIELDS.items():
  times=[];values={key:[] for key in fields}
  if topic=='controlsState':values['desiredAngle']=[]
  if topic=='carControl':values.update(accelRequested=[],decelRequested=[])
  rows=streams.get(topic,[])
  # Older logs wrote final actuator values inside carControl.
  if topic=='carOutput' and not rows:
   rows=[(stamp,valid,{'actuatorsOutput':record['actuatorsOutputDEPRECATED']}) for stamp,valid,record in streams.get('carControl',[]) if isinstance(record.get('actuatorsOutputDEPRECATED'),dict)]
  for stamp,valid,record in sorted(rows,key=lambda row:row[0]):
   time=round(stamp/1e9-origin,6)
   if time<-.15 or time>duration+.15:continue
   times.append(time)
   for key,(path,factor) in fields.items():
    value=nested(record,path) if valid else None
    if factor is None:value=value if type(value) is bool else None
    elif factor=='state':value=LONG_STATES.get(value) if isinstance(value,str) else None
    else:value=number(value,factor)
    if topic=='carControl':
     if key in ('targetAcceleration','plannedAcceleration','jerk') and record.get('longActive') is not True:value=None
     # Torque controllers also record their target angle. Do not gate it on carParams.
     if key in ('targetAngle','commandTorque','commandCurvature') and record.get('latActive') is not True:value=None
    if topic=='controlsState' and key in ('actualLateralAccel','desiredLateralAccel') and nested(record,'lateralControlState.torqueState.active') is not True:value=None
    values[key].append(value)
   if topic=='carControl':
    active=record.get('longActive') if valid else None;accel=number(nested(record,'actuators.accel')) if valid else None
    for key,positive in [('accelRequested',True),('decelRequested',False)]:
     value=False if active is False else (accel>0 if positive else accel<0) if active is True and accel is not None else None
     values[key].append(value)
   if topic=='controlsState':
    angle=None
    for name in ('angleState','pidState'):
     state=nested(record,'lateralControlState.'+name)
     if valid and isinstance(state,dict) and state.get('active') is True:angle=number(state.get('steeringAngleDesiredDeg'));break
    values['desiredAngle'].append(angle)
  if 'longState' in values:
   for name,code in LONG_STATES.items():values['long_'+name]=[value==code if value is not None else None for value in values['longState']]
  result[topic]={'times':times,'values':values}
 return {'duration':duration,'maxGap':.15,'streams':result}
