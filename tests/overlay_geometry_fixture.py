"""Compare runtime geometry against the last shipped Python projection formulas."""
import json,sys
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'roadviewer/app'))
from overlay import OverlayProjector,rotation,projection_coordinates
from overlay_reference import OverlayProjector as Reference
from compact import compact_data

rows=[]
for rpy in ([0,0,0],[.1,.2,-.1],[-.2,-.1,.3]):
 for slope in (-.3,0,.3):
  streams={'liveCalibration':[(0,True,{'calStatus':'calibrated','rpyCalib':rpy,'height':[1.2]})], 'deviceState':[(0,True,{'deviceType':'tici'})]}
  xs=[0,5,10,15,20,33,60]
  lanes=[{'x':xs,'y':[offset+slope*x for x in xs],'z':[1.2+.002*x for x in xs]} for offset in (-5.4,-1.8,1.8,5.4)]
  model={'position':{'x':xs,'y':[slope*x for x in xs],'z':[.002*x for x in xs]},'laneLines':lanes,'roadEdges':[lanes[0],lanes[-1]]}
  frame={'lp':[.2,.7,1,0],'es':[0,2],'leads':[{'x':10,'y':1}], 'liveTracks':[{'x':20,'y':-2,'yRel':2}],
         'ccncTargets':[{'slot':slot,'x':10,'y':slope*10+y} for slot,y in [('LF',-3),('FF',0),('RF',3)]],
         'ccncRoad':{'target':1,'distance':15}}
  expected=Reference(streams).project(0,model,{**frame,'lp':[min(.75,p) for p in frame['lp']]});expected.pop('laneDepths',None)
  frame['overlay']=OverlayProjector(streams).project(0,model,frame)
  compact_data({'frames':[frame]})
  wide_info={'device':'mici','wideSensor':'os04c10','calibrationStatus':'calibrated','rpy':rpy,'wideRpy':[.04,-.03,.08]}
  a,b=rotation(tuple(wide_info['wideRpy'])),rotation(tuple(rpy))
  wide_basis=[]
  for axis in range(3):
   device=[b[i][axis] for i in range(3)]
   point=[sum(v*w for v,w in zip(row,device)) for row in a]
   wide_basis.append(projection_coordinates(point,[0,0,0],(1344,760,425.25)))
  rows.append({'frame':frame,'expected':expected,'wideInfo':wide_info,'wideBasis':wide_basis})
print(json.dumps(rows,separators=(',',':')))
