"""Keep vehicle samples on their original log clock, independent of model frames."""
import math

# name: (nested field path, multiplier); bools stay bools, missing/invalid values stay null.
FIELDS={
 'carState':{
  'speed':('vEgo',3.6),'clusterSpeed':('vEgoCluster',3.6),'cruiseSpeed':('cruiseState.speed',3.6),
  'acceleration':('aEgo',1),'gas':('gas',100),'brake':('brake',100),
  'steeringAngle':('steeringAngleDeg',1),'steeringRate':('steeringRateDeg',1),
  'driverTorque':('steeringTorque',1),'epsTorque':('steeringTorqueEps',1),'rpm':('engineRpm',1),
  **{key:(key,None) for key in ('gasPressed','brakePressed','regenBraking','steeringPressed','standstill','parkingBrake','brakeHoldActive')},
 },
 'carControl':{'targetAcceleration':('actuators.accel',1),'targetAngle':('actuators.steeringAngleDeg',1),'commandTorque':('actuators.torque',1),
               'latActive':('latActive',None),'longActive':('longActive',None)},
 'carOutput':{'outputTorque':('actuatorsOutput.torque',1)},
}

def extract_telemetry(streams,origin,duration):
 result={}
 params=sorted(streams.get('carParams',[]),key=lambda row:row[0]);param_index=-1;steer_type=None
 for topic,fields in FIELDS.items():
  times=[];values={key:[] for key in fields}
  for stamp,valid,record in sorted(streams.get(topic,[]),key=lambda row:row[0]):
   # Include one sample interval either side of the displayed timeline.
   time=round(stamp/1e9-origin,6)
   if time<-.15 or time>duration+.15:continue
   if topic=='carControl':
    while param_index+1<len(params) and params[param_index+1][0]<=stamp:
     param_index+=1;steer_type=params[param_index][2].get('steerControlType') if params[param_index][1] else None
   times.append(time)
   for key,(path,factor) in fields.items():
    value=record if valid else None
    for part in path.split('.'):value=value.get(part) if isinstance(value,dict) else None
    if factor is None:value=value if type(value) is bool else None
    else:value=round(value*factor,6) if type(value) in (int,float) and math.isfinite(value) else None
    if key=='targetAcceleration' and record.get('longActive') is not True:value=None
    if key in ('targetAngle','commandTorque'):
     if record.get('latActive') is not True or steer_type!=('angle' if key=='targetAngle' else 'torque'):value=None
    values[key].append(value)
  result[topic]={'times':times,'values':values}
 return {'duration':duration,'maxGap':.15,'streams':result}
