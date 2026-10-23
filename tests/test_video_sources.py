"""Synthetic HEVC sources exercise real codec conversion and per-camera clocks."""
import gzip
import json
import sys
import tempfile
import unittest
from unittest.mock import patch
from pathlib import Path
sys.path.insert(0, '/app')
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'roadviewer/app'))
import av
import zstandard
import decoder
from hevc_video import prepare_video,VideoProgress
from video_sources import validate_hevc
from video_packets import Pictures, inspect_mp4


class Reporter:
 def update(self, *args, **kwargs): pass


class NoDecode:
 """Normal preparation must never ask libav for decoded pixels."""
 def __init__(self, container):self.container=container
 def __getattr__(self, key):
  if key=='decode':raise AssertionError('Pixel decoding is forbidden during preparation')
  return getattr(self.container,key)
 def __enter__(self):return self
 def __exit__(self,*args):self.container.close()


def no_decode_open(original):
 def open(*args,**kwargs):
  container=original(*args,**kwargs)
  return NoDecode(container) if isinstance(container,av.container.InputContainer) else container
 return open


def hevc(path, count=8):
 with av.open(str(path), 'w', format='hevc') as output:
  stream=output.add_stream('libx265', rate=20)
  stream.width=160;stream.height=96;stream.pix_fmt='yuv420p'
  stream.options={'preset':'ultrafast','x265-params':'pools=1:frame-threads=1:bframes=0:log-level=error'}
  for i in range(count):
   frame=av.VideoFrame(160,96,'yuv420p')
   for plane in frame.planes:plane.update(bytes([i])*plane.buffer_size)
   for packet in stream.encode(frame):output.mux(packet)
  for packet in stream.encode():output.mux(packet)


class VideoSourcesTests(unittest.TestCase):
 def test_multi_camera_progress_is_monotonic(self):
  events=[]
  class Capture:
   def update(self,stage,**fields):events.append((stage,fields))
  progress=VideoProgress(Capture(),3)
  for i in range(3):
   progress.index=i
   for stage in ('video_read','video_convert','video_verify'):
    for percent in (0,50,100):progress.update(stage,percent=percent)
  self.assertEqual({stage for stage,_ in events},{'video_read','video_convert','video_verify'})
  values=[fields['video_percent'] for _,fields in events];self.assertEqual(values,sorted(values))
  self.assertEqual([fields['video_percent'] for stage,fields in events[:9] if stage=='video_convert'],[0,0,0])
  self.assertEqual([fields['percent'] for _,fields in events[:3]],[0,50,100])
  self.assertAlmostEqual(values[0],0);self.assertAlmostEqual(values[-1],100)

 def test_hevc_clock_gaps_and_retained_mp4(self):
  with tempfile.TemporaryDirectory() as temp:
   root=Path(temp);source=root/'fcamera.hevc';output=root/'fcamera.mp4';hevc(source)
   validate_hevc(source)
   times=[0,.05,.1,.15,.25,.3,.35,.4]
   indices=[{'segmentId':i,'timestampEof':10_000_000_000+round(t*1e9)} for i,t in enumerate(times)]
   with patch.object(av,'open',side_effect=no_decode_open(av.open)):
    info=prepare_video(source,output,indices,9,Reporter())
   self.assertAlmostEqual(info['start'],1);self.assertEqual(info['frames'],8)
   with av.open(str(output)) as video:
    self.assertEqual(video.streams.video[0].codec_context.name,'hevc')
    stamps=[float(frame.pts*frame.time_base) for frame in video.decode(video=0)]
   for actual,expected in zip(stamps,times):self.assertAlmostEqual(actual,expected,places=5)
   self.assertEqual(prepare_video(output,root/'unused.mp4',indices,9,Reporter()),info)
   self.assertFalse((root/'unused.mp4').exists())
   with self.assertRaises(ValueError):prepare_video(source,root/'bad.mp4',indices[:-1],9,Reporter())
   self.assertFalse((root/'bad.mp4').exists())
   indices[2]['segmentId']=9
   with self.assertRaises(ValueError):prepare_video(source,root/'bad.mp4',indices,9,Reporter())

 def test_compressed_picture_corruption_and_clock_changes_are_rejected(self):
  with tempfile.TemporaryDirectory() as temp:
   root=Path(temp);source=root/'fcamera.hevc';output=root/'good.mp4';hevc(source)
   times=[i*.05 for i in range(8)]
   indices=[dict(segmentId=i,timestampEof=10_000_000_000+round(t*1e9)) for i,t in enumerate(times)]
   prepare_video(source,output,indices,10,Reporter())
   with av.open(str(source)) as inp:
    pictures=Pictures(inp.streams.video[0],annex_b=True)
    for packet in inp.demux(video=0):
     if packet.size:pictures.add(packet)
    signature=pictures.finish()
   # Same packet count, lengths, headers and timestamps, but one changed picture byte.
   with av.open(str(output)) as inp,av.open(str(root/'corrupt.mp4'),'w') as out:
    stream=inp.streams.video[0];target=out.add_stream_from_template(stream,opaque=True)
    for i,packet in enumerate(inp.demux(stream)):
     if not packet.size:continue
     data=bytearray(packet)
     if i==3:data[-5]^=1
     changed=av.Packet(bytes(data));changed.pts=packet.pts;changed.dts=packet.dts;changed.time_base=packet.time_base;changed.duration=packet.duration;changed.stream=target;out.mux(changed)
   with self.assertRaisesRegex(ValueError,'원본과 다릅니다'):
    inspect_mp4(root/'corrupt.mp4',times,Reporter(),signature)
   wrong=times.copy();wrong[4]+=.01
   with self.assertRaisesRegex(ValueError,'시간이 로그와'):
    inspect_mp4(output,wrong,Reporter(),signature)

 def test_decoder_prefers_front_and_keeps_all_camera_offsets(self):
  with tempfile.TemporaryDirectory() as temp:
   root=Path(temp);hevc(root/'fcamera.hevc');hevc(root/'ecamera.hevc')
   messages=[]
   for i in range(8):
    for kind,start in [('modelV2',10.),('roadEncodeIdx',10.1),('wideRoadEncodeIdx',9.9)]:
     stamp=round((start+i*.05)*1e9)
     event=decoder.log.Event.new_message();event.logMonoTime=stamp;event.valid=True;event.init(kind)
     values={'frameId':i,'timestampEof':stamp}
     if kind=='modelV2':values.update(laneLines=[],laneLineProbs=[],roadEdges=[],roadEdgeStds=[])
     else:values['segmentId']=i
     setattr(event,kind,values);messages.append(event.to_bytes())
   source=root/'rlog.zst';source.write_bytes(zstandard.ZstdCompressor().compress(b''.join(messages)))
   dest,data=decoder.prepare(source)
   self.assertEqual(data['defaultVideo'],'front');self.assertEqual(set(data['videos']),{'front','wide'})
   self.assertAlmostEqual(data['videos']['front']['start'],.2)
   self.assertAlmostEqual(data['videos']['wide']['start'],0)
   self.assertAlmostEqual(data['logStart'],.1)
   self.assertEqual(data['video'],data['videos']['front'])
   saved=json.loads(gzip.decompress((dest/'data.json.gz').read_bytes()))
   self.assertEqual(saved['videos'],data['videos'])
   self.assertEqual(json.loads((dest/'summary.json').read_text())['videos'],data['videos'])
   # A broken optional source cannot take down the log or the other video.
   (root/'fcamera.hevc').write_bytes(b'broken')
   _,data=decoder.prepare(source)
   self.assertEqual(data['defaultVideo'],'wide');self.assertIsNone(data['videos'].get('front'))
   self.assertTrue(any('fcamera.hevc' in warning for warning in data['warnings']))

if __name__=='__main__':unittest.main()
