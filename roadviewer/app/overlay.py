"""Project calibrated model coordinates into normalized narrow-camera pixels.
Camera parameters/conventions: commaai/openpilot common/transformations/camera.py.
Model path/target height convention: selfdrive/ui/onroad/model_renderer.py.
"""
import bisect,functools,math

def points3(line):
 return list(zip(line.get('x',[]),line.get('y',[]),line.get('z',[])))

def sample_line(points,distance):
 for a,b in zip(points,points[1:]):
  if len(a)!=3 or len(b)!=3 or not all(math.isfinite(v) for v in (*a,*b)):continue
  if a[0]<=distance<=b[0] and b[0]>a[0]:
   ratio=(distance-a[0])/(b[0]-a[0])
   return (distance,a[1]+(b[1]-a[1])*ratio,a[2]+(b[2]-a[2])*ratio)
 return None

def restore_ccnc_targets(targets,model,valid=True):
 if targets is None:return None
 lanes=model.get('laneLines',[]);curves=[points3(l) for l in lanes[1:3]] if valid else []
 restored=[]
 for target in targets:
  x=target['x']/0.8;correction=None
  # FF is normally encoded relative to model Position; side slots use lane curvature.
  path=sample_line(points3(model.get('position',{})),x) if valid and target['slot']=='FF' else None
  if path is not None:correction=path[1]
  if correction is None and len(curves)==2:
   samples=[(sample_line(c,0),sample_line(c,x)) for c in curves]
   if all(a is not None and b is not None for a,b in samples):correction=sum(b[1]-a[1] for a,b in samples)/2
  y=target['y']+(correction or 0)
  restored.append({**target,'displayX':target['x'],'displayY':target['y'],'x':round(x,3),'y':round(y,3),'yRel':round(-y,3),'curveRestored':correction is not None})
 return restored

def edge_confidence(std):
 return 1/(1+max(0,std)) if isinstance(std,(int,float)) and math.isfinite(std) else 0

def camera_config(device,sensor):
 if device=='neo' and sensor=='unknown':return (1164,874,910.)
 if sensor in ('ar0231','ox03c10') or (device in ('tici','pc') and sensor=='unknown'):return (1928,1208,2648.)
 if sensor=='os04c10' and device in ('tici','tizi','mici'):return (1344,760,1141.5)
 return None

@functools.lru_cache(maxsize=64)
def rotation(rpy):
 r,p,a=rpy
 cr,sr,cp,sp,ca,sa=math.cos(r),math.sin(r),math.cos(p),math.sin(p),math.cos(a),math.sin(a)
 # Rz(yaw) Ry(pitch) Rx(roll), then device -> view [y,z,x].
 return (ca*cp,ca*sp*sr-sa*cr,ca*sp*cr+sa*sr),(sa*cp,sa*sp*sr+ca*cr,sa*sp*cr-ca*sr),(-sp,cp*sr,cp*cr)

def projection_coordinates(point,rpy,config):
 if len(point)!=3:return None
 x,y,z=point
 if not (math.isfinite(x) and math.isfinite(y) and math.isfinite(z)):return None
 # The rotation depends only on the calibration; computing it once per value, not per point, keeps results identical.
 (a1,a2,a3),(b1,b2,b3),(c1,c2,c3)=rotation(tuple(rpy))
 depth=a1*x+a2*y+a3*z
 horizontal=b1*x+b2*y+b3*z
 vertical=c1*x+c2*y+c3*z
 w,h,f=config
 return [.5*depth+f/w*horizontal,.5*depth+f/h*vertical,depth]

def project_point(point,rpy,config):
 projected=projection_coordinates(point,rpy,config)
 if projected is None or projected[2]<=.1:return None
 u,v=(projected[i]/projected[2] for i in (0,1))
 return [round(u,6),round(v,6)] if abs(u)<10 and abs(v)<10 else None

class OverlayProjector:
 def __init__(self,streams):
  self.device_id=next((row.get('dongleId') for _,valid,row in streams.get('initData',[]) if valid and row.get('dongleId')),None)
  self.rows={k:sorted(streams.get(k,[]),key=lambda row:row[0]) for k in ('liveCalibration','deviceState','roadCameraState')}
  self.times={k:[r[0] for r in rows] for k,rows in self.rows.items()}
 def at(self,kind,stamp,max_age=None):
  rows=self.rows[kind];index=bisect.bisect_right(self.times[kind],stamp)-1
  # Segment boundaries can precede the first low-frequency metadata message.
  # Only fill the leading gap; never skip invalid records or fill internal gaps.
  if index<0:
   if not rows or rows[0][0]-stamp>2_000_000_000:return None
   index=0
  time,valid,value=rows[index]
  return value if valid and (max_age is None or stamp-time<=max_age) else None
 def camera_info(self,stamp):
  cal=self.at('liveCalibration',stamp,10_000_000_000) or {}
  device=(self.at('deviceState',stamp) or {}).get('deviceType','unknown')
  sensor=(self.at('roadCameraState',stamp) or {}).get('sensor','unknown')
  rpy=cal.get('rpyCalib',[])
  if len(rpy)!=3 or not all(math.isfinite(v) for v in rpy):rpy=None
  heights=cal.get('height',[])
  measured=bool(heights and math.isfinite(heights[0]) and .3<heights[0]<3)
  return {'device':device,'deviceId':self.device_id,'sensor':sensor,'calibrationStatus':cal.get('calStatus','unknown'),
          'rpy':rpy,'height':heights[0] if measured else 1.22,'heightDefault':not measured}
 def project(self,stamp,model,frame):
  info=frame.get('cameraInfo') or self.camera_info(stamp)
  if info['calibrationStatus'] not in ('calibrated','recalibrating') or info['rpy'] is None:return None
  config=camera_config(info['device'],info['sensor'])
  if config is None:return None
  # Source geometry only. No per-frame screen points, walls, ribbons or boxes.
  return {'geometry':{'basis':[projection_coordinates(axis,info['rpy'],config) for axis in ((1,0,0),(0,1,0),(0,0,1))],
                      'height':info['height'],'lanes':[points3(l) for l in model.get('laneLines',[])],
                      'edges':[points3(l) for l in model.get('roadEdges',[])],
                      'position':points3(model.get('position',{}))}}
