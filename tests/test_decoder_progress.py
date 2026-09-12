import io,json,sys,tempfile,unittest
from pathlib import Path
from unittest.mock import patch
sys.path.insert(0,'/app')
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'roadviewer/app'))
import av,zstandard,decoder
from progress import Reporter

class DecoderProgressTests(unittest.TestCase):
 def test_real_video_and_log_progress(self):
  with tempfile.TemporaryDirectory() as root:
   root=Path(root);video=root/'qcamera.ts'
   with av.open(str(video),'w',format='mpegts') as out:
    stream=out.add_stream('libx264',rate=20);stream.width=160;stream.height=96;stream.pix_fmt='yuv420p'
    for i in range(20):
     frame=av.VideoFrame(160,96,'yuv420p')
     for plane in frame.planes:plane.update(bytes(plane.buffer_size))
     for packet in stream.encode(frame):out.mux(packet)
    for packet in stream.encode():out.mux(packet)
   with av.open(str(video)) as inp:pts=[float(frame.pts*frame.time_base) for frame in inp.decode(video=0)]
   messages=[]
   for i,pts_value in enumerate(pts):
    stamp=round((pts_value+10)*1e9)
    for name,values in [('modelV2',dict(frameId=i,timestampEof=stamp,laneLines=[],laneLineProbs=[],roadEdges=[],roadEdgeStds=[])),('qRoadEncodeIdx',dict(frameId=i,segmentId=i,timestampEof=stamp))]:
     e=decoder.log.Event.new_message();e.logMonoTime=stamp;e.valid=True;e.init(name);setattr(e,name,values);messages.append(e.to_bytes())
   src=root/'rlog.zst';src.write_bytes(zstandard.ZstdCompressor().compress(b''.join(messages)))
   output=io.StringIO();counter=iter(range(10000));reporter=Reporter(output,clock=lambda:next(counter))
   with patch.object(decoder,'Reporter',return_value=reporter):dest,data=decoder.prepare(src)
   events=[json.loads(line) for line in output.getvalue().splitlines()]
   self.assertEqual([e for e in events if e['stage']=='log_analysis'][-1]['frames'],20)
   self.assertEqual([e for e in events if e['stage']=='video_convert'][-1]['percent'],100)
   self.assertTrue(any(e['stage']=='video_verify' for e in events))
   self.assertEqual(events[-1]['stage'],'saving')
   self.assertEqual(data['video']['frames'],20)
   self.assertTrue((dest/'camera.mp4').is_file())

if __name__=='__main__':unittest.main()
