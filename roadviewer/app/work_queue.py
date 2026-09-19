"""FIFO work admission with a live limit; existing jobs are never interrupted."""
import threading
from concurrent.futures import ThreadPoolExecutor

class ProcessingQueue:
 def __init__(self,worker,limit=1):
  self.worker=worker;self.limit=limit
  self.executor=ThreadPoolExecutor(max_workers=4)
  self.condition=threading.Condition(threading.RLock())
  self.pending=[];self.active=set();self.closing=False
 def submit(self,id):
  with self.condition:
   if self.closing:raise RuntimeError('Queue is shutting down')
   if id not in self.pending:self.pending.append(id)
   self._drain()
 def discard(self,id):
  with self.condition:
   if id in self.pending:self.pending.remove(id)
 def set_limit(self,limit):
  if type(limit) is not int or limit not in (1,2,3,4):raise ValueError('Expected 1 to 4')
  with self.condition:self.limit=limit;self._drain()
 def _drain(self):
  while len(self.active)<self.limit:
   index=next((i for i,id in enumerate(self.pending) if id not in self.active),None)
   if index is None:break
   id=self.pending.pop(index);self.active.add(id)
   self.executor.submit(self._run,id)
 def _run(self,id):
  try:self.worker(id)
  finally:
   with self.condition:
    self.active.remove(id);self._drain();self.condition.notify_all()
 def shutdown(self,wait=True):
  # Drain accepted work before shutting down the underlying executor.
  with self.condition:
   self.closing=True
   self.condition.wait_for(lambda:not self.pending and not self.active)
  self.executor.shutdown(wait=wait)
