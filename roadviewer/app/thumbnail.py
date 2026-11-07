"""A small JPEG of one camera frame for the log list (prepared/thumbnail.jpg).

The one documented exception to "conversion never decodes pixels" (see NoDecode in tests/test_video_sources.py):
it decodes the first frames of ONE source, the smallest playable one (qcamera preferred), and is bounded."""
from fractions import Fraction
import av

WIDTH=320
MAX_PACKETS=120 # About 6 s at 20 fps; a broken file stops here instead of decoding on.

def frame_near(path,second=1.0):
 # The first decodable frame at or after `second`, else the first decodable one. Forward only (no seek:
 # .ts and remuxed files seek unreliably); undecodable packets are skipped, within MAX_PACKETS.
 first=None
 with av.open(str(path)) as container:
  stream=container.streams.video[0];stream.thread_type='AUTO'
  try:
   for count,packet in enumerate(container.demux(stream)):
    if count>=MAX_PACKETS:break
    try:frames=packet.decode()
    except av.FFmpegError:continue
    for frame in frames:
     if first is None:first=frame;start=frame.time or 0
     if (frame.time or 0)-start>=second:return frame
  except av.FFmpegError:
   # A file cut short (the first bytes of an archived video, backfill.py) ends here: keep what decoded.
   if first is None:raise
 return first

def encode_jpeg(frame,width=WIDTH):
 height=max(2,round(frame.height*width/frame.width/2)*2)
 image=frame.reformat(width=width,height=height,format='yuvj420p');image.pts=0
 encoder=av.CodecContext.create('mjpeg','w')
 encoder.width,encoder.height,encoder.pix_fmt,encoder.time_base=width,height,'yuvj420p',Fraction(1,25)
 encoder.options={'qmin':'4','qmax':'4'} # About JPEG quality 70-75.
 return b''.join(bytes(packet) for packet in [*encoder.encode(image),*encoder.encode(None)])

def make_thumbnail(sources):
 """JPEG bytes from the first source that decodes, or None."""
 for source in sources:
  if source is None or not source.is_file():continue
  try:frame=frame_near(source)
  except (av.FFmpegError,OSError,IndexError):continue
  if frame is None:continue
  data=encode_jpeg(frame)
  if data.startswith(b'\xff\xd8'):return data
 return None

def write_thumbnail(dest,data):
 target=dest/'thumbnail.jpg';temp=dest/'thumbnail.jpg.tmp'
 temp.write_bytes(data);temp.replace(target)
 return target

def save_thumbnail(dest,sources):
 """Writes dest/thumbnail.jpg from the first source that decodes; returns its path or None."""
 data=make_thumbnail(sources)
 return write_thumbnail(dest,data) if data else None
