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
  if len(curves)==2:
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
  rpy=info['rpy'];height=info['height']
  config=camera_config(info['device'],info['sensor'])
  if config is None:return None
  def line(value,offset=0):
   return [project_point((x,y,z+offset),rpy,config) for x,y,z in points3(value)]
  def band(value,confidence):
   points=points3(value);sides=[[],[]]
   confidence=max(0,min(1,confidence)) if math.isfinite(confidence) else 0
   for i,(x,y,z) in enumerate(points):
    a=points[max(0,i-1)];b=points[min(len(points)-1,i+1)]
    dx,dy=b[0]-a[0],b[1]-a[1];length=math.hypot(dx,dy)
    nx,ny=(-dy/length,dx/length) if length else (0,1)
    for side,sign in enumerate((-1,1)):sides[side].append(project_point((x+nx*.15*confidence*sign,y+ny*.15*confidence*sign,z),rpy,config))
   return sides
  lane_bands=[band(l,(frame.get('lp') or model.get('laneLineProbs',[]))[i] if i<len(frame.get('lp') or model.get('laneLineProbs',[])) else 0) for i,l in enumerate(model.get('laneLines',[]))]
  edge_bands=[band(l,edge_confidence((frame.get('es') or model.get('roadEdgeStds',[]))[i]) if i<len(frame.get('es') or model.get('roadEdgeStds',[])) else 0) for i,l in enumerate(model.get('roadEdges',[]))]
  blindspot_paths=[]
  for lane in model.get('laneLines',[])[1:3]:
   points=points3(lane);samples=[]
   if len(points)>1 and all(math.isfinite(p[0]) for p in points):
    start=max(0,points[0][0]);end=min(40,points[-1][0])
    if end>start:
     distances=[start]+[float(x) for x in range(2,40,2) if start<x<end]+[end]
     samples=[sample_line(points,x) for x in distances]
   blindspot_paths.append([projection_coordinates(p,rpy,config) if p else None for p in samples])
  path=points3(model.get('position',{}))
  def ground_z(x):
   if not path:return height
   for a,b in zip(path,path[1:]):
    if a[0]<=x<=b[0] and b[0]>a[0]:return a[2]+(b[2]-a[2])*(x-a[0])/(b[0]-a[0])+height
   return min(path,key=lambda p:abs(p[0]-x))[2]+height
  # Camera-space center and lateral direction let the browser vary path width without re-analysis.
  path_projection=[];path_sides=[]
  for i,(x,y,z) in enumerate(path):
   a=path[max(0,i-1)];b=path[min(len(path)-1,i+1)];dx,dy=b[0]-a[0],b[1]-a[1];length=math.hypot(dx,dy)
   nx,ny=(-dy/length,dx/length) if length else (0,1)
   path_projection.append(projection_coordinates((x,y,z+height),rpy,config))
   path_sides.append(projection_coordinates((nx,ny,0),rpy,config))
  target_line=[];road=frame.get('ccncRoad') or {};distance=road.get('distance',0)
  if road.get('target') in (1,3) and 0<distance<204.6:
   for lane in model.get('laneLines',[])[1:3]:
    points=points3(lane);point=None
    for a,b in zip(points,points[1:]):
     if a[0]<=distance<=b[0] and b[0]>a[0]:
      ratio=(distance-a[0])/(b[0]-a[0]);point=project_point((distance,a[1]+ratio*(b[1]-a[1]),a[2]+ratio*(b[2]-a[2])),rpy,config);break
    target_line.append(point)
  # Project the road center and a unit cross-road vector so width remains adjustable.
  target_sections=[]
  if len(target_line)==2 and all(target_line):
   lanes=[points3(lane) for lane in model.get('laneLines',[])[1:3]]
   for i in range(17):
    points=[sample_line(lane,distance-i*.5) for lane in lanes]
    if not all(points) or points[0][0]<=0:break
    a,b=points;width=math.dist(a,b)
    if width<.1:break
    center=tuple((v+w)/2 for v,w in zip(a,b));side=tuple((w-v)/width for v,w in zip(a,b))
    section=[projection_coordinates(center,rpy,config),projection_coordinates(side,rpy,config)]
    if not all(project_point(tuple(v+sign*.9*w for v,w in zip(center,side)),rpy,config) for sign in (-1,1)):break
    target_sections.append(section)
  if target_sections:
   center,side=target_sections[0]
   target_line=[]
   for sign in (-1,1):
    point=[v+sign*.9*w for v,w in zip(center,side)]
    target_line.append([round(point[j]/point[2],6) for j in (0,1)])
  markers=[]
  groups=[('model',frame.get('leads',[])),('selected',[frame['selected']] if frame.get('selected') else []),('radar',frame.get('radarTargets',[])),('raw',frame.get('liveTracks',[])),('ccnc',frame.get('ccncTargets') or [])]
  for kind,targets in groups:
   for i,target in enumerate(targets):
    x,y=target['x'],target['y']
    point=project_point((x,y,ground_z(x)),rpy,config) if x>0 else None
    if point:
     marker={'kind':kind,'index':i,'point':point,'projection':projection_coordinates((x,y,ground_z(x)),rpy,config)}
     if kind=='ccnc':
      # Rear-bottom midpoint is the target. Nominal passenger-car dimensions, not measured size.
      marker['box']=[projection_coordinates((x+dx,y+dy,ground_z(x+dx)-up),rpy,config)
                     for up in (0,1.5) for dx in (0,4.5) for dy in (-.9,.9)]
     markers.append(marker)
  lane_depths=[[p[2] if p else None for p in (projection_coordinates(point,rpy,config) for point in points3(lane))] for lane in model.get('laneLines',[])[1:3]]
  return {'laneBands':lane_bands,'edgeBands':edge_bands,'blindspotPaths':blindspot_paths,'laneDepths':lane_depths,'pathProjection':path_projection,'pathSides':path_sides,'targetLine':target_line,'targetSections':target_sections,'heightDirection':projection_coordinates((0,0,-1),rpy,config),'lanes':[line(l) for l in model.get('laneLines',[])],'edges':[line(l) for l in model.get('roadEdges',[])],'path':line(model.get('position',{}),height),'markers':markers}
