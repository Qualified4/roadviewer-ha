import gzip,io,json,shutil,sys,tempfile,unittest
from pathlib import Path
from unittest.mock import patch
sys.path.insert(0,'/app')
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'roadviewer/app'))
import av,zstandard,decoder
from progress import Reporter

class DecoderProgressTests(unittest.TestCase):
 def test_ccnc_decode_and_freshness(self):
  bits=(3<<112)|(250<<117)|(35<<128)|(4<<64)|(123<<69)|(123<<80)|(5<<136)|(350<<141)|(42<<152)
  payload=bits.to_bytes(32,'little');targets=decoder.ccnc_targets(payload)
  self.assertEqual([t['slot'] for t in targets],['LF','FF','RF'])
  self.assertEqual([t['x'] for t in targets],[25,12.3,35])
  self.assertEqual([t['yRel'] for t in targets],[3.5,-.5,-4.2])
  self.assertEqual([t['y'] for t in targets],[-3.5,.5,4.2])
  self.assertEqual(decoder.ccnc_targets(bytes(32)),[])
  self.assertEqual(decoder.ccnc_targets(bytes(16)),[])
  self.assertEqual(decoder.ccnc_targets(((3<<64)|(2046<<69)).to_bytes(32,'little')),[])
  rows=[(100_000_000,True,targets),(300_000_000,False,targets),(400_000_000,True,[])]
  times=[r[0] for r in rows]
  self.assertIsNone(decoder.ccnc_at(rows,times,99_000_000))
  self.assertEqual(decoder.ccnc_at(rows,times,100_000_000),targets)
  self.assertIsNone(decoder.ccnc_at(rows,times,250_000_000))
  self.assertIsNone(decoder.ccnc_at(rows,times,300_000_000))
  self.assertEqual(decoder.ccnc_at(rows,times,400_000_000),[])

 def test_ccnc_road_bits(self):
  bits=(2<<57)|(1<<66)|(250<<69)|(3<<105)|(12<<109)|(1<<120)
  road=decoder.ccnc_road(bits.to_bytes(32,'little'))
  self.assertEqual(road,{'target':1,'distance':25.,'highlight':3,'left':1,'right':0,'blinkerLeft':True,'blinkerRight':False})
  self.assertNotIn('highlightDistance',road)
  self.assertFalse(decoder.ccnc_road(bytes(32))['target'])
  self.assertIsNone(decoder.ccnc_road(bytes(16)))

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
   e=decoder.log.Event.new_message();e.logMonoTime=0;e.valid=True;e.init('initData');e.initData.dongleId='test-device-id'
   messages=[e.to_bytes()]
   for i,pts_value in enumerate(pts):
    stamp=round((pts_value+10)*1e9)
    for name,values in [('modelV2',dict(frameId=i,timestampEof=stamp,laneLines=[],laneLineProbs=[],roadEdges=[],roadEdgeStds=[])),('qRoadEncodeIdx',dict(frameId=i,segmentId=i,timestampEof=stamp))]:
     e=decoder.log.Event.new_message();e.logMonoTime=stamp;e.valid=True;e.init(name);setattr(e,name,values);messages.append(e.to_bytes())
   for i in range(100):
    e=decoder.log.Event.new_message();e.logMonoTime=round((pts[0]+10+i*.01)*1e9);e.valid=True;e.init('carState');e.carState.leftBlindspot=i<20;e.carState.rightBlindspot=i>=20;e.carState.leftBlinker=True;e.carState.vEgo=20;e.carState.aEgo=-1.5;e.carState.engineRpm=1800;e.carState.gas=.25;e.carState.steeringPressed=i==31;messages.append(e.to_bytes())
   for name,values in [('carControl',{'latActive':True,'longActive':True,'actuators':{'steeringAngleDeg':7,'accel':-1.5,'aTarget':-1.2,'jerk':-.3,'longControlState':'stopping'}}),('carOutput',{'actuatorsOutput':{'gas':.25,'brake':.5,'accel':-1}}),('controlsState',{'lateralControlState':{'torqueState':{'active':True,'actualLateralAccel':.8,'desiredLateralAccel':1.2}}})]:
    e=decoder.log.Event.new_message();e.logMonoTime=round((pts[0]+10)*1e9);e.valid=True;e.init(name);setattr(e,name,values);messages.append(e.to_bytes())
   stamp=round((pts[0]+10)*1e9)
   e=decoder.log.Event.new_message();e.logMonoTime=stamp;e.valid=True;e.init('carParams');e.carParams.brand='hyundai';messages.append(e.to_bytes())
   e=decoder.log.Event.new_message();e.logMonoTime=stamp;e.valid=True
   e.init('sendcan',1);e.sendcan[0].address=0x162;e.sendcan[0].src=0;e.sendcan[0].dat=((4<<64)|(200<<69)).to_bytes(32,'little');messages.append(e.to_bytes())
   e=decoder.log.Event.new_message();e.logMonoTime=stamp;e.valid=True;e.init('sendcan',1);e.sendcan[0].address=0x161;e.sendcan[0].src=0;e.sendcan[0].dat=((1<<66)|(150<<69)|(1<<120)).to_bytes(32,'little');messages.append(e.to_bytes())
   src=root/'rlog.zst';src.write_bytes(zstandard.ZstdCompressor().compress(b''.join(messages)))
   output=io.StringIO();counter=iter(range(10000));reporter=Reporter(output,clock=lambda:next(counter))
   with patch.object(decoder,'Reporter',return_value=reporter):dest,data=decoder.prepare(src,'Route / segment')
   saved=json.loads(gzip.decompress((dest/'data.json.gz').read_bytes()))
   self.assertFalse((dest/'data.json').exists())
   # Camera information is stored once and referenced by index from each frame.
   self.assertEqual(saved['cameraInfos'][data['frames'][0]['cameraInfo']]['deviceId'],'test-device-id')
   self.assertEqual(saved['frames'][0]['ccncTargets'][0]['slot'],'FF')
   self.assertEqual(saved['frames'][0]['ccncTargets'][0]['x'],25)
   self.assertEqual(saved['frames'][0]['ccncTargets'][0]['displayX'],20)
   self.assertIsNone(saved['frames'][-1]['ccncTargets'])
   self.assertEqual(saved['frames'][0]['roadSignals'],{'blinkerLeft':True,'blinkerRight':False,'blindspotLeft':True,'blindspotRight':False,'acceleration':-1.5})
   self.assertTrue(saved['frames'][-1]['roadSignals']['blindspotRight'])
   self.assertEqual(saved['frames'][0]['ccncRoad']['distance'],15)
   self.assertEqual(saved['frames'][0]['ccncRoad']['left'],1)
   self.assertIsNone(saved['frames'][-1]['ccncRoad'])
   self.assertEqual(saved['route'],'Route / segment');self.assertNotIn('path',saved)
   self.assertEqual(json.loads((dest/'summary.json').read_text())['model_frames'],20)
   self.assertEqual(saved['cameraInfos'][0]['calibrationStatus'],'unknown')
   self.assertTrue(saved['cameraInfos'][0]['heightDefault'])
   events=[json.loads(line) for line in output.getvalue().splitlines()]
   self.assertEqual([e for e in events if e['stage']=='log_analysis'][-1]['frames'],20)
   self.assertEqual([e for e in events if e['stage']=='video_convert'][-1]['percent'],100)
   self.assertTrue(any(e['stage']=='video_verify' for e in events))
   self.assertEqual(events[-1]['stage'],'saving')
   self.assertEqual(data['video']['frames'],20)
   self.assertTrue((dest/'camera.mp4').is_file())
   telemetry=json.loads(gzip.decompress((dest/'telemetry.json.gz').read_bytes()))
   state=telemetry['streams']['carState']
   self.assertEqual(len(state['times']),100)
   self.assertAlmostEqual(state['times'][0],data['logStart'],places=5)
   self.assertEqual(state['values']['speed'][0],72)
   self.assertEqual(state['values']['rpm'][0],1800);self.assertEqual(state['values']['gas'][0],25)
   control=telemetry['streams']['carControl']['values'];out=telemetry['streams']['carOutput']['values']
   self.assertEqual(control['targetAngle'],[7]);self.assertEqual(control['decelRequested'],[True]);self.assertEqual(control['long_stopping'],[True])
   self.assertEqual(out['outputGas'],[25]);self.assertEqual(out['outputBrake'],[50])
   self.assertEqual(telemetry['streams']['controlsState']['values']['desiredLateralAccel'],[1.2])
   self.assertEqual(sum(value is True for value in state['values']['steeringPressed']),1)
   self.assertEqual(state['values']['steeringPressed'][31],True)
   (dest/'summary.json').unlink()
   with patch.object(decoder,'Reporter',return_value=reporter):decoder.prepare(src,'Route / segment')
   self.assertEqual(json.loads((dest/'summary.json').read_text())['model_frames'],20)
   (dest/'camera.mp4').replace(root/'camera.mp4');video.unlink();shutil.rmtree(dest)
   before=(root/'camera.mp4').read_bytes()
   with patch.object(decoder,'Reporter',return_value=reporter):dest,reused=decoder.prepare(src,'Route / segment')
   self.assertEqual((root/'camera.mp4').read_bytes(),before);self.assertFalse((dest/'camera.mp4').exists())
   self.assertEqual(reused['video']['frames'],data['video']['frames'])
   self.assertAlmostEqual(reused['video']['start'],data['video']['start'],places=6)
   self.assertAlmostEqual(reused['video']['duration'],data['video']['duration'],places=6)
   self.assertEqual([f['t'] for f in reused['frames']],[f['t'] for f in data['frames']])


if __name__=='__main__':unittest.main()
