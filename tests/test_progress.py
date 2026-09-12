import io,json,os,subprocess,sys,unittest
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'roadviewer/app'))
from progress import Reporter,ProgressChannel

class ProgressTests(unittest.TestCase):
 def test_throttle_and_stage_transition(self):
  output=io.StringIO();now=[0]
  r=Reporter(output,clock=lambda:now[0])
  r.update('log_analysis',frames=0)
  for i in range(1,1000):r.update('log_analysis',frames=i)
  now[0]=1;r.update('log_analysis',frames=1000)
  r.update('log_analysis',frames=1001,force=True)
  r.update('video_convert',percent=0)
  events=[json.loads(line) for line in output.getvalue().splitlines()]
  self.assertEqual([e.get('frames') for e in events],[0,1000,1001,None])
 def test_broken_display_does_not_break_conversion(self):
  class Broken:
   def write(self,value):raise BrokenPipeError()
  r=Reporter(Broken());r.update('log_analysis',frames=4);r.update('saving')
 def test_pipe_keeps_stdout_and_stderr_separate(self):
  events=[]
  script="import os,json; f=os.fdopen(int(os.environ['RV_PROGRESS_FD']),'w'); f.write(json.dumps({'stage':'log_analysis','frames':42})+'\\n'); f.flush(); print('x'*100000)"
  with ProgressChannel(events.append) as channel:
   p=subprocess.Popen([sys.executable,'-c',script],stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,**channel.options())
   channel.start();stdout,stderr=p.communicate(timeout=10)
  self.assertEqual(p.returncode,0,stderr);self.assertGreater(len(stdout),100000)
  self.assertEqual(events,[{'stage':'log_analysis','frames':42}])
 def test_killed_child_closes_progress_reader(self):
  with ProgressChannel(lambda e:None) as channel:
   p=subprocess.Popen([sys.executable,'-c','import time;time.sleep(30)'],**channel.options())
   channel.start();p.kill();p.wait(timeout=5)
  self.assertFalse(channel.thread.is_alive())

if __name__=='__main__':unittest.main()
