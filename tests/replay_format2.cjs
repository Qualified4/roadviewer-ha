const fs=require('fs'),assert=require('node:assert/strict'),{execFileSync}=require('child_process');
// Replay format 2 (compact.py REPLAY_V): app.js expandReplayData restores what compact_data left out, the same way as
// compact.expand_frames (used by tools reading data.json.gz). Both expansions of one stored file must agree.
const py=`
import json,sys
sys.path.insert(0,'roadviewer/app')
from compact import compact_data,expand_frames
GRID=[0.0,0.1875,0.75]
def geometry_frame(lanes_2d=True):
 lanes=[[(x,-1.7+i,0.01*i) for x in GRID] for i in range(2)];edges=[[(x,-3.5,0.0) for x in GRID]];position=[(0.0,0.0,0.0),(4.0,0.123456,0.02),(9.0,0.4,0.05)]
 flat=lambda line:[[round(x,3),round(y,3)] for x,y,*_ in line]
 frame={'t':0,'overlay':{'geometry':{'basis':[[1,0,0],[0,1,0],[0,0,1]],'height':1.22,'lanes':lanes,'edges':edges,'position':position}},'edges':[flat(l) for l in edges],'position':flat(position)}
 if lanes_2d:frame['lanes']=[flat(l) for l in lanes]
 return frame
frames=[geometry_frame(),geometry_frame(lanes_2d=False)]
frames[0]['overlay']['geometry']['edges'][0]=[(0.0,-3.5,0.0),(2.0,-3.5,0.0),(5.0,-3.4,0.0)];frames[0]['edges']=[[[0.0,-3.5],[2.0,-3.5],[5.0,-3.4]]]
stored=compact_data({'frames':frames})
print(json.dumps({'stored':stored,'expanded':expand_frames(json.loads(json.dumps(stored)))}))`;
const {stored,expanded}=JSON.parse(execFileSync(process.env.RV_PYTHON||'python3',['-c',py],{encoding:'utf8'}));
assert.equal(stored.replayV,2);assert(!('lanes' in stored.frames[0]),'stored without top-down lanes');
const src=fs.readFileSync('roadviewer/app/web/app.js','utf8');
const {expandFlat}=new Function(src.slice(src.indexOf('const flatLine='),src.indexOf('function expandReplayData('))+';return {expandFlat}')();
let worst=0;
const same=(a,b,path)=>{if(Array.isArray(b)){assert(Array.isArray(a)&&a.length===b.length,path+' shape');b.forEach((v,i)=>same(a[i],v,path+'.'+i))}else if(typeof b==='number')worst=Math.max(worst,Math.abs(a-b));else assert.equal(a,b,path)};
stored.frames.forEach((frame,i)=>{
 expandFlat(frame,frame.overlay.geometry,stored.laneX);
 for(const key of ['lanes','edges','position']){assert.equal(key in frame,key in expanded.frames[i],`${i}.${key} presence`);if(key in frame)same(frame[key],expanded.frames[i][key],`${i}.${key}`)}
 for(const key of ['lanes','edges','position'])same(frame.overlay.geometry[key],expanded.frames[i].overlay.geometry[key],`${i}.geometry.${key}`);
});
assert(worst<=6e-4,'top-down points within rounding: '+worst);
console.log('PASS: replay format 2 expands in the browser as in compact.expand_frames (grid points, derived and absent top-down lines, off-grid lines)');
