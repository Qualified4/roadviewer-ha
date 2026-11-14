"""A small JPEG of one camera frame for the log list (prepared/thumbnail.jpg, its score in thumbnail.json).

The one documented exception to "conversion never decodes pixels" (see NoDecode in tests/test_video_sources.py):
it decodes the first seconds of ONE source, the smallest playable one (qcamera preferred), and is bounded.

At a drive's start the camera's auto exposure is still settling and many drives are at dusk or night: the frame at
1 s is often black. So the best-exposed of the frames at 1..5 s is kept, and its brightness levelled (Y only)."""
import json,math
from collections import namedtuple
from fractions import Fraction
import av
import thumbnail_meta

WIDTH=320
SECONDS=(1,2,3,4,5)  # Candidate frames, seconds after the first decoded one.
MAX_PACKETS=140 # About 7 s at 20 fps (5 s plus a late keyframe); a broken file stops here instead of decoding on.
Thumbnail=namedtuple('Thumbnail','jpeg score second')

def small(frame,width=WIDTH):
 height=max(2,round(frame.height*width/frame.width/2)*2)
 return frame.reformat(width=width,height=height,format='yuvj420p')

def candidates(path,seconds=SECONDS):
 # {second: small frame} for the first decodable frame at or after each second, else {0: the first decodable one}.
 # Forward only (no seek: .ts and remuxed files seek unreliably); undecodable packets are skipped, within
 # MAX_PACKETS. Each is scaled down at once so only a few small pictures are kept.
 out={};first=None
 with av.open(str(path)) as container:
  stream=container.streams.video[0];stream.thread_type='AUTO'
  try:
   for count,packet in enumerate(container.demux(stream)):
    if count>=MAX_PACKETS or len(out)==len(seconds):break
    try:frames=packet.decode()
    except av.FFmpegError:continue
    for frame in frames:
     if first is None:first=frame;start=frame.time or 0
     t=(frame.time or 0)-start
     for second in seconds:
      if second not in out and t>=second:out[second]=small(frame)
  except av.FFmpegError:
   # A file cut short (the first bytes of an archived video, backfill.py) ends here: keep what decoded.
   if first is None:raise
 if not out and first is not None:out[0]=small(first)
 return out

def stats(image):
 """(mean, standard deviation, 1st and 99th percentile) of the luma, from every other row and column."""
 plane=image.planes[0];raw=bytes(plane);hist=[0]*256
 for row in range(0,image.height,2):
  for value in raw[row*plane.line_size:row*plane.line_size+image.width:2]:hist[value]+=1
 n=sum(hist);mean=sum(i*c for i,c in enumerate(hist))/n
 std=math.sqrt(sum(c*(i-mean)**2 for i,c in enumerate(hist))/n)
 low=high=None;acc=0
 for i,c in enumerate(hist):
  acc+=c
  if low is None and acc>=n*.01:low=i
  if high is None and acc>=n*.99:high=i
 return mean,std,low,high

def score(mean,std,*_):
 # Contrast, cut down for a frame that is mostly dark (mean under 60) or washed out (over 190).
 return std*min(1,mean/60)*min(1,max(0,250-mean)/60)

def level(image,mean,std,low,high):
 # Stretches the 1-99 % range to the full scale (at most 3x), then lifts a still dark picture with a gamma
 # towards a mean of 110. Luma only, so colours are not shifted; a 256-entry table, no numpy in the container.
 gain=min(3,235/max(1,high-low))
 lut=[min(255,max(0,round((v-low)*gain))) for v in range(256)]
 stretched=min(255,max(1,(mean-low)*gain))
 gamma=1 if stretched>=100 else max(.6,math.log(110/255)/math.log(stretched/255))
 plane=image.planes[0];plane.update(bytes(plane).translate(bytes(min(255,round(255*(v/255)**gamma)) for v in lut)))
 return image

def encode_jpeg(frame,width=WIDTH):
 image=small(frame,width);image.pts=0
 encoder=av.CodecContext.create('mjpeg','w')
 encoder.width,encoder.height,encoder.pix_fmt,encoder.time_base=image.width,image.height,'yuvj420p',Fraction(1,25)
 encoder.options={'qmin':'4','qmax':'4'} # About JPEG quality 70-75.
 return b''.join(bytes(packet) for packet in [*encoder.encode(image),*encoder.encode(None)])

def make_thumbnail(sources):
 """Thumbnail(jpeg, score, second) from the first source that decodes, or None."""
 for source in sources:
  if source is None or not source.is_file():continue
  try:
   found=candidates(source)
   if not found:continue
   # Ties keep the earliest frame (an all-black start scores 0 everywhere).
   measured={second:stats(image) for second,image in found.items()}
   second=max(measured,key=lambda s:score(*measured[s]))
   data=encode_jpeg(level(found[second],*measured[second]))
  except (av.FFmpegError,OSError,IndexError):continue
  if data.startswith(b'\xff\xd8'):return Thumbnail(data,round(score(*measured[second]),2),second)
 return None

def write_thumbnail(dest,thumb):
 # The picture first, then its info: a stop in between leaves an old-looking thumbnail, which is made again.
 target=dest/'thumbnail.jpg';temp=dest/'thumbnail.jpg.tmp'
 temp.write_bytes(thumb.jpeg);temp.replace(target)
 info=dest/thumbnail_meta.NAME;temp=dest/(thumbnail_meta.NAME+'.tmp')
 temp.write_text(json.dumps({'version':thumbnail_meta.VERSION,'score':thumb.score}));temp.replace(info)
 return target

def save_thumbnail(dest,sources):
 """Writes dest/thumbnail.jpg and its info from the first source that decodes; returns its path or None."""
 thumb=make_thumbnail(sources)
 return write_thumbnail(dest,thumb) if thumb else None
