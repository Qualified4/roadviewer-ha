"""Replay the mici HudRenderer wheel using timestamped, valid log samples."""
import bisect, math, colorsys

def finite(value):
 return isinstance(value,(int,float)) and not isinstance(value,bool) and math.isfinite(value)

def sample(rows,times,stamp,max_age=150_000_000):
 # Never show an intervention before its recorded timestamp.
 i=bisect.bisect_right(times,stamp)-1
 if i<0:return None
 time,valid,value=rows[i]
 return value if valid and 0<=stamp-time<max_age else None

class SteeringReplay:
 def __init__(self,streams):
  self.streams={k:sorted(v,key=lambda r:r[0]) for k,v in streams.items()}
  self.times={k:[r[0] for r in v] for k,v in self.streams.items()}
  self.torque=0.;self.previous=None
 def at(self,stamp):
  def get(k,age=150_000_000):return sample(self.streams.get(k,[]),self.times.get(k,[]),stamp,age)
  cs=get('carState');cc=get('carControl');ctl=get('controlsState');out=get('carOutput');sd=get('selfdriveState')
  angle=cs.get('steeringAngleDeg') if cs else None
  pressed=cs.get('steeringPressed') if cs else None
  active=cc.get('latActive') if cc else None
  torque=None
  if ctl and 'angleState' in ctl.get('lateralControlState',{}):
   lp=get('liveParameters',2_000_000_000);cp=get('carParams',float('inf'))
   if active is False:torque=0.
   elif cs and lp and active is True:
    speed=cs.get('vEgo');roll=lp.get('roll');desired=ctl.get('desiredCurvature');maximum=cp.get('maxLateralAccel',3.) if cp else 3.
    if all(finite(v) for v in (speed,roll,desired,maximum)) and maximum>0:
     # actual + (desired - actual), matching HudRenderer's angle-controller path.
     compensation=roll*9.81*max(0.,min(1.,(speed-5.)/10.))
     torque=max(-1.,min(1.,(desired*speed**2-compensation)/maximum))
  elif ctl and out:
   value=out.get('actuatorsOutput',{}).get('torque')
   if finite(value):torque=-value
  dt=(stamp-self.previous)/1e9 if self.previous is not None else .05
  if torque is None:self.torque=0.
  else:
   if dt<=0 or dt>.15:self.torque=0.;dt=.05
   self.torque+=max(0.,dt)/(.1+max(0.,dt))*(torque-self.torque)
  self.previous=stamp
  magnitude=abs(self.torque) if torque is not None else None
  scale=1.+max(0.,min(.5,(magnitude or 0.)-.5))
  blend=max(0.,min(1.,((magnitude or 0.)-.75)*4.))
  if pressed is True:color=[255,255,255];state='driver'
  elif pressed is None or active is None:color=[148,165,184];state='unknown'
  elif active:
   h0=colorsys.rgb_to_hsv(0.,1.,0.)[0];h1=colorsys.rgb_to_hsv(1.,115/255,0.)[0]
   color=[int(c*255) for c in colorsys.hsv_to_rgb(h0+blend*(h1-h0),1.,1.)];state='active'
  else:color=[230,230,230];state='inactive'
  return {'angle':angle if finite(angle) else None,'pressed':pressed,'active':active,'torque':magnitude,'scale':scale,'color':color,'state':state,'lane':bool(ctl and ctl.get('activeLaneLine')),'critical':bool(sd and sd.get('alertHudVisual')=='steerRequired' and sd.get('alertSize') not in (None,'none'))}
