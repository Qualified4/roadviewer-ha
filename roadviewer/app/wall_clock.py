"""The wall-clock start of a segment (epoch seconds), from the clocks its log recorded."""
from pathlib import Path
import struct,time

EARLIEST=1420070400.0 # 2015-01-01: a device clock before this was never set.
SCAN_MESSAGES=2000;SCAN_BYTES=2*1024*1024 # Messages read, and bytes read both compressed and decompressed.

def plausible(seconds,now=None):
 return isinstance(seconds,(int,float)) and EARLIEST<=seconds<=(time.time() if now is None else now)+86400

def pick_start(first_mono,init=None,clocks=None,gps=None,now=None):
 """Each source is (logMonoTime, wall seconds) or None, in order of preference: initData.wallTimeNanos, the first
 clocks.wallTimeNanos, the first valid GPS fix. The wall time is moved back to the segment's first logMonoTime;
 implausible values (before 2015, more than a day ahead) are skipped."""
 for source in (init,clocks,gps):
  if not source:continue
  mono,wall=source
  if not plausible(wall,now):continue
  start=wall-(mono-first_mono)/1e9
  if plausible(start,now):return round(start,3)
 return None

class Starts:
 """Collects the candidates while a log is read (decoder.prepare and scan below)."""
 def __init__(self):self.first=None;self.init=self.clocks=self.gps=None
 def add(self,e,kind):
  mono=e.logMonoTime
  if self.first is None or mono<self.first:self.first=mono
  if kind=='initData' and self.init is None:
   wall=e.initData.wallTimeNanos
   if wall:self.init=(mono,wall/1e9)
  elif kind=='clocks' and self.clocks is None:
   wall=e.clocks.wallTimeNanos
   if wall:self.clocks=(mono,wall/1e9)
  elif kind in ('gpsLocationExternal','gpsLocation') and self.gps is None and e.valid:
   fix=getattr(e,kind)
   if fix.hasFix and fix.unixTimestampMillis>0:self.gps=(mono,fix.unixTimestampMillis/1e3)
 def done(self):return self.init is not None and plausible(self.init[1]) or self.clocks is not None
 def start(self,now=None):return None if self.first is None else pick_start(self.first,self.init,self.clocks,self.gps,now)

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

def decompress_prefix(compressed,limit=SCAN_BYTES):
 # The start of a zstd stream from its first bytes only (a cut-off stream is fine); at most `limit` bytes out.
 import zstandard
 stream=zstandard.ZstdDecompressor().decompressobj();chunks=[];size=0
 for i in range(0,len(compressed),65536):
  block=stream.decompress(compressed[i:i+65536])
  chunks.append(block);size+=len(block)
  if size>=limit:break
 return b''.join(chunks)[:limit]

def scan_bytes(compressed,messages=SCAN_MESSAGES,limit=SCAN_BYTES,now=None):
 """The start from the first bytes of an rlog.zst (a local read, a NAS read or a ranged Drive download).
 A log whose start cannot be found returns None; data that is not zstd raises zstandard.ZstdError."""
 import capnp
 raw=decompress_prefix(compressed,limit)
 raw=raw[:complete(raw)];starts=Starts()
 try:
  for number,e in enumerate(schema().Event.read_multiple_bytes(raw)):
   if number>=messages:break
   try:kind=e.which()
   except capnp.KjException:continue # An event newer than the schema.
   starts.add(e,kind)
   if starts.done():break
 except capnp.KjException:pass
 return starts.start(now)

def scan(path,messages=SCAN_MESSAGES,limit=SCAN_BYTES,now=None):
 """Reads only the first SCAN_BYTES of a local rlog.zst. OSError propagates (the read may work later)."""
 with open(path,'rb') as source:compressed=source.read(SCAN_BYTES)
 return scan_bytes(compressed,messages,limit,now)
