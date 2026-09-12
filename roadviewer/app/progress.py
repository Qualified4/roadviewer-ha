"""Throttled progress over a private pipe; no progress files or extra scans."""
import json
import os
import threading
import time


class Reporter:
 def __init__(self, stream=None, clock=time.monotonic):
  self.stream=stream
  if stream is None and os.environ.get('RV_PROGRESS_FD'):
   self.stream=os.fdopen(int(os.environ['RV_PROGRESS_FD']),'w',buffering=1)
  self.clock=clock
  self.stage=None
  self.last=0

 def update(self, stage, frames=None, percent=None, force=False):
  if self.stream is None:return
  now=self.clock()
  if stage==self.stage and not force and now-self.last<1:return
  self.stage=stage;self.last=now
  event={'stage':stage}
  if frames is not None:event['frames']=max(0,int(frames))
  if percent is not None:event['percent']=max(0,min(100,int(percent)))
  try:
   self.stream.write(json.dumps(event)+'\n');self.stream.flush()
  except (OSError,ValueError):
   self.stream=None # Display failures must never interrupt conversion.


class ProgressChannel:
 def __init__(self, callback):
  self.callback=callback
  self.reader,self.writer=os.pipe()
  self.thread=None

 def __enter__(self):return self

 def options(self):
  return {'pass_fds':(self.writer,), 'env':dict(os.environ,RV_PROGRESS_FD=str(self.writer))}

 def start(self):
  os.close(self.writer);self.writer=None
  self.thread=threading.Thread(target=self.consume,daemon=True)
  self.thread.start()

 def consume(self):
  with os.fdopen(self.reader) as source:
   for line in source:
    try:
     event=json.loads(line)
     if isinstance(event,dict) and event.get('stage') in ('log_read','log_analysis','video_read','video_convert','video_verify','saving'):
      self.callback(event)
    except (ValueError,TypeError):pass

 def __exit__(self,*args):
  if self.writer is not None:os.close(self.writer)
  if self.thread is None:os.close(self.reader)
  else:self.thread.join(timeout=1)
