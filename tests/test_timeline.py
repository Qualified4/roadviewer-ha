import sys,unittest
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'roadviewer/app'))
from timeline import align_timeline
class TimelineTests(unittest.TestCase):
 def check(self,end,video,expected,log_start,video_start=None):
  frames=[{'t':0},{'t':end}]
  result=align_timeline(frames,video)
  self.assertEqual(result['duration'],expected);self.assertEqual(result['logStart'],log_start)
  self.assertEqual(result['logEnd'],end+log_start)
  if video:self.assertEqual(video['start'],video_start)
 def test_longer_video(self):self.check(41,{'start':0,'duration':60},60,0,0)
 def test_longer_log(self):self.check(60,{'start':0,'duration':41},60,0,0)
 def test_video_before_log(self):self.check(41,{'start':-19,'duration':60},60,19,0)
 def test_video_after_log(self):self.check(60,{'start':19,'duration':60},79,0,19)
 def test_log_only(self):self.check(60,None,60,0)
 def test_gap(self):self.check(5,{'start':10,'duration':2},12,0,10)
if __name__=='__main__':unittest.main()
