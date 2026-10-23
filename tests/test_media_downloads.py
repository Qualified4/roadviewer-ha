"""Real retained MP4 -> original camera streams, including ZIP and deletion races."""
import io,json,os,sys,tempfile,unittest,zipfile,hashlib
from pathlib import Path
from unittest.mock import patch
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'roadviewer/app'))
os.environ.setdefault('RV_DATA',tempfile.mkdtemp(prefix='rv-media-tests-'))
sys.path.insert(0,'/app')
import av,server
from hevc_video import prepare_video
from test_video_sources import hevc,Reporter


def pixels(data):
 with av.open(io.BytesIO(data)) as inp:
  result=[]
  for frame in inp.decode(video=0):
   digest=hashlib.sha256()
   for plane in frame.planes:
    raw=bytes(plane)
    for y in range(plane.height):digest.update(raw[y*plane.line_size:y*plane.line_size+plane.width])
   result.append(digest.hexdigest())
  return result


class MediaDownloadsTests(unittest.TestCase):
 def test_retained_cameras_export_losslessly_and_zip_survives_removal(self):
  with tempfile.TemporaryDirectory() as temp,patch.object(server,'ROOT',Path(temp)):
   p=Path(temp)/('a'*32);p.mkdir();prefix='0000041b--c6f39793a8--1--'
   indices=[dict(segmentId=i,timestampEof=10_000_000_000+i*50_000_000) for i in range(8)]
   expected={};raw_payloads={}
   for name in ('fcamera','ecamera'):
    raw=p/(name+'.hevc');hevc(raw);raw_payloads[name+'.hevc']=raw.read_bytes();expected[name]=pixels(raw_payloads[name+'.hevc'])
    prepare_video(raw,p/(name+'.mp4'),indices,10,Reporter());raw.unlink()
   ts=p/'qcamera.ts'
   with av.open(str(ts),'w',format='mpegts') as out:
    stream=out.add_stream('libx264',rate=20);stream.width=160;stream.height=96;stream.pix_fmt='yuv420p'
    for i in range(8):
     frame=av.VideoFrame(160,96,'yuv420p')
     for plane in frame.planes:plane.update(bytes([i])*plane.buffer_size)
     for packet in stream.encode(frame):out.mux(packet)
    for packet in stream.encode():out.mux(packet)
   raw_payloads['qcamera.ts']=ts.read_bytes();expected['qcamera']=pixels(raw_payloads['qcamera.ts'])
   with av.open(str(ts)) as inp,av.open(str(p/'camera.mp4'),'w') as out:
    stream=inp.streams.video[0];target=out.add_stream_from_template(stream)
    for packet in inp.demux(stream):
     if packet.dts is not None:packet.stream=target;out.mux(packet)
   ts.unlink();(p/'rlog.zst').write_bytes(b'original log')
   server.save_meta(p,dict(id=p.name,name=prefix[:-2],status='ready',video_codecs={'front':'hevc','wide':'hevc','qcamera':'h264'},video_origins={'qcamera':20},files={kind:prefix+kind for kind in server.UPLOAD_KINDS},content_hashes={kind:dict(size=len(data),mtime_ns=0,sha256=hashlib.sha256(data).hexdigest()) for kind,data in raw_payloads.items()}))
   client=server.app.test_client();peer={'REMOTE_ADDR':'172.30.32.2'}
   for source,name,ext in [('front','fcamera','hevc'),('wide','ecamera','hevc'),('qcamera','qcamera','ts')]:
    response=client.get(f'/api/logs/{p.name}/download?source={source}&format=original',environ_overrides=peer)
    self.assertEqual(response.status_code,200);self.assertEqual(pixels(response.data),expected[name]);response.close()
    self.assertIn(prefix+name+'.'+ext,response.headers['Content-Disposition'])
    if source=='qcamera':
     with av.open(str(p/'camera.mp4')) as original,av.open(io.BytesIO(response.data)) as restored:
      a=next(original.decode(video=0));b=next(restored.decode(video=0))
      self.assertAlmostEqual(float(b.pts*b.time_base)-float(a.pts*a.time_base),20,places=4)
   with patch.object(server,'cleanup_uploads'):
    log=client.get('/api/logs',environ_overrides=peer).json['logs'][0]
   payload=[(io.BytesIO(b'original log'),prefix+'rlog.zst')]+[(io.BytesIO(data),prefix+kind) for kind,data in raw_payloads.items()]
   response=client.post('/api/upload',data={'files':payload},headers={'X-RoadViewer-Request':'1'},environ_overrides=peer)
   self.assertEqual(response.status_code,201);self.assertEqual(len(response.json['duplicates']),1);self.assertEqual(response.json['updated'],[])
   self.assertFalse(any((p/kind).exists() for kind in raw_payloads))
   self.assertEqual(len(log['download_options']),3)
   self.assertTrue(all(row['mp4'] and row['original'] for row in log['download_options']))
   response=client.get(f'/api/logs/download.zip?ids={p.name}&parts=rlog,front,wide,qcamera&format=original',environ_overrides=peer)
   # The response owns source descriptors, so removing files cannot truncate its archive.
   for file in p.glob('*.mp4'):file.unlink()
   with zipfile.ZipFile(io.BytesIO(response.data)) as archive:
    self.assertEqual(len(archive.namelist()),4)
    self.assertEqual(archive.read(prefix+'rlog.zst'),b'original log')
    for name,ext in [('fcamera','hevc'),('ecamera','hevc'),('qcamera','ts')]:self.assertEqual(pixels(archive.read(prefix+name+'.'+ext)),expected[name])
   response.close()
   for query in ('format=bad','source=bad'):
    self.assertEqual(client.get(f'/api/logs/{p.name}/download?{query}',environ_overrides=peer).status_code,400)


if __name__=='__main__':unittest.main()
