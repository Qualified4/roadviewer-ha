"""Frozen 0.4.4 projection oracle for browser geometry regression tests."""
from overlay import *
from overlay import OverlayProjector as BaseProjector

class OverlayProjector(BaseProjector):
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
  box_lanes=[points3(lane) for lane in model.get('laneLines',[])[1:3]]
  groups=[('model',frame.get('leads',[])),('selected',[frame['selected']] if frame.get('selected') else []),('radar',frame.get('radarTargets',[])),('raw',frame.get('liveTracks',[])),('ccnc',frame.get('ccncTargets') or [])]
  for kind,targets in groups:
   for i,target in enumerate(targets):
    x,y=target['x'],target['y']
    point=project_point((x,y,ground_z(x)),rpy,config) if x>0 else None
    if point:
     marker={'kind':kind,'index':i,'point':point,'projection':projection_coordinates((x,y,ground_z(x)),rpy,config)}
     if kind=='ccnc':
      # Follow the lane-center direction over the next 5m, without extrapolation.
      forward_x,forward_y=1.,0.
      if len(box_lanes)==2:
       samples=[(sample_line(lane,x),sample_line(lane,x+5)) for lane in box_lanes]
       if all(a is not None and b is not None for a,b in samples):
        lateral=sum(b[1]-a[1] for a,b in samples)/2
        length=math.hypot(5,lateral);forward_x,forward_y=5/length,lateral/length
      # Rotate around the rear-bottom midpoint, preserving nominal width/length.
      # The 1.5m projection basis is rescaled to the chosen height in the browser.
      marker['box']=[projection_coordinates((x+dx*forward_x-dy*forward_y,y+dx*forward_y+dy*forward_x,ground_z(x+dx*forward_x)-up),rpy,config)
                     for up in (0,1.5) for dx in (0,4.5) for dy in (-.9,.9)]
     markers.append(marker)
  lane_depths=[[p[2] if p else None for p in (projection_coordinates(point,rpy,config) for point in points3(lane))] for lane in model.get('laneLines',[])[1:3]]
  return {'laneBands':lane_bands,'edgeBands':edge_bands,'blindspotPaths':blindspot_paths,'laneDepths':lane_depths,'pathProjection':path_projection,'pathSides':path_sides,'targetLine':target_line,'targetSections':target_sections,'heightDirection':projection_coordinates((0,0,-1),rpy,config),'lanes':[line(l) for l in model.get('laneLines',[])],'edges':[line(l) for l in model.get('roadEdges',[])],'path':line(model.get('position',{}),height),'markers':markers}
