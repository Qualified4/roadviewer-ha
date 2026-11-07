"""The wall-clock start of a segment (epoch seconds), from the clocks its log recorded.

Sources, best first: a GPS fix ('gps'); the system clock as clocks.wallTimeNanos reports it ('clock'); initData
('device'). initData is a copy of the route's start record in every segment, written when the route began, often
before the system clock was synced (devices without a GPS fix then show a time weeks old), so it is the last resort,
and its logMonoTime is the route's, not the segment's: the segment's first logMonoTime ignores it.
logMonoTime is continuous within a route (one boot), so an offset (wall - logMonoTime/1e9) from one segment dates
every segment of its route (server.route_starts): gps_offset from any GPS segment, else clock_offset from the
route's latest segment (by then the clock has long been synced)."""
from pathlib import Path
import struct,time

EARLIEST=1420070400.0 # 2015-01-01: a device clock before this was never set.
SCAN_BYTES=2*1024*1024 # Compressed bytes read from the start of an rlog.zst.
SCAN_RAW=12*1024*1024  # Decompressed bytes scanned at most (GPS may come a few seconds in).
START_V=3  # summary.json start_v: GPS, then clocks, then initData; first_mono without initData; clock_offset.
FIELDS=('started_at','start_source','first_mono','gps_offset','clock_offset','start_v')

def plausible(seconds,now=None):
 return isinstance(seconds,(int,float)) and EARLIEST<=seconds<=(time.time() if now is None else now)+86400

def pick(first_mono,init=None,clocks=None,gps=None,now=None):
 """(start, source) or (None, None). Each source is (logMonoTime, wall seconds) or None, in order of preference:
 the first valid GPS fix ('gps'), then the latest clocks.wallTimeNanos read ('clock'), then initData ('device').
 The wall time is moved back to the segment's first logMonoTime; implausible values (before 2015, more than a
 day ahead) are skipped."""
 for source,name in ((gps,'gps'),(clocks,'clock'),(init,'device')):
  if not source:continue
  mono,wall=source
  if not plausible(wall,now):continue
  start=wall-(mono-first_mono)/1e9
  if plausible(start,now):return round(start,3),name
 return None,None

def pick_start(first_mono,init=None,clocks=None,gps=None,now=None):return pick(first_mono,init,clocks,gps,now)[0]

class Starts:
 """Collects the candidates while a log is read (decoder.prepare and scan below)."""
 def __init__(self):self.first=self.init_mono=None;self.last=0;self.init=self.clocks=self.gps=None
 def add(self,e,kind):
  mono=e.logMonoTime
  if kind=='initData':
   # The route's start record, copied into each segment: its time is the route's, not this segment's.
   if self.init_mono is None:self.init_mono=mono
   wall=e.initData.wallTimeNanos
   if wall and self.init is None:self.init=(mono,wall/1e9)
   return
  if self.first is None or mono<self.first:self.first=mono
  if mono>self.last:self.last=mono
  if kind=='clocks':
   # The latest reading: the further in, the likelier the clock has been synced.
   wall=e.clocks.wallTimeNanos
   if wall and plausible(wall/1e9):self.clocks=(mono,wall/1e9)
  elif kind in ('gpsLocationExternal','gpsLocation') and self.gps is None and e.valid:
   fix=getattr(e,kind)
   if fix.hasFix and fix.unixTimestampMillis>0 and plausible(fix.unixTimestampMillis/1e3):
    self.gps=(mono,fix.unixTimestampMillis/1e3)
 def done(self):
  # A GPS fix settles it. Without one, stop 2 s into the segment once the clock has been read: a receiver with a fix
  # reports several times a second, so a fix that has not shown up by then is not coming in this segment's prefix.
  return self.gps is not None or self.clocks is not None and self.first is not None and self.last-self.first>2_000_000_000
 def start(self,now=None):return self.fields(now)['started_at']
 def fields(self,now=None):
  """What summary.json stores (FIELDS); started_at None when no clock is usable."""
  first=self.first if self.first is not None else self.init_mono
  start,source=(None,None) if first is None else pick(first,self.init,self.clocks,self.gps,now)
  gps=round(self.gps[1]-self.gps[0]/1e9,6) if source=='gps' else None
  clock=round(self.clocks[1]-self.clocks[0]/1e9,6) if self.clocks else None
  return {'started_at':start,'start_source':source,'first_mono':first,'gps_offset':gps,'clock_offset':clock,'start_v':START_V}

_schema=[]
def schema():
 # Loaded on first use only: the server needs it just to fill in logs converted before started_at existed.
 if not _schema:
  import capnp
  _schema.append(capnp.load(str(Path(__file__).resolve().parent.parent/'schema/cereal/log.capnp')))
 return _schema[0]

def complete(raw):
 # Byte length of the whole framed messages at the start of raw (the last one may be cut off).
 offset=0
 while offset+4<=len(raw):
  segments=struct.unpack_from('<I',raw,offset)[0]+1
  header=((segments+2)//2)*8
  if segments>512 or offset+header>len(raw):break
  end=offset+header+sum(struct.unpack_from('<'+str(segments)+'I',raw,offset+4))*8
  if end>len(raw):break
  offset=end
 return offset

def decompress_prefix(compressed,limit=SCAN_RAW):
 # The start of a zstd stream from its first bytes only (a cut-off stream is fine); at most `limit` bytes out.
 import zstandard
 stream=zstandard.ZstdDecompressor().decompressobj();chunks=[];size=0
 for i in range(0,len(compressed),65536):
  block=stream.decompress(compressed[i:i+65536])
  chunks.append(block);size+=len(block)
  if size>=limit:break
 return b''.join(chunks)[:limit]

def scan_bytes(compressed,messages=None,limit=SCAN_RAW,now=None):
 """The start fields (Starts.fields) from the first bytes of an rlog.zst (a local read, a NAS read or a ranged
 Drive download). The whole decompressed prefix (at most `limit` bytes, `messages` messages when given) is read
 until a GPS fix is found. Data that is not zstd raises zstandard.ZstdError."""
 import capnp
 raw=decompress_prefix(compressed,limit)
 raw=raw[:complete(raw)];starts=Starts()
 try:
  for number,e in enumerate(schema().Event.read_multiple_bytes(raw)):
   if messages is not None and number>=messages:break
   try:kind=e.which()
   except capnp.KjException:continue # An event newer than the schema.
   starts.add(e,kind)
   if starts.done():break
 except capnp.KjException:pass
 return starts.fields(now)

def scan(path,messages=None,limit=SCAN_RAW,now=None):
 """Reads only the first SCAN_BYTES of a local rlog.zst. OSError propagates (the read may work later)."""
 with open(path,'rb') as source:compressed=source.read(SCAN_BYTES)
 return scan_bytes(compressed,messages,limit,now)
