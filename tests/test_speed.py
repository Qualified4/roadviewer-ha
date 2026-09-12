import math,sys,unittest
sys.path.insert(0,'/app')
from decoder import speed_at
class SpeedTest(unittest.TestCase):
 def test_conversion_and_nearest_time(self):
  states=[(1000000000,True,10.),(1100000000,True,20.)]
  self.assertEqual(speed_at(states,[s[0] for s in states],1080000000),72.)
 def test_missing_invalid_stale_nonfinite(self):
  self.assertIsNone(speed_at([],[],0))
  for valid,speed,stamp in [(False,10.,0),(True,math.nan,0),(True,10.,150000000)]:
   self.assertIsNone(speed_at([(0,valid,speed)],[0],stamp))
 def test_zero_is_valid(self):
  self.assertEqual(speed_at([(0,True,0.)],[0],0),0.)
if __name__=='__main__':unittest.main()
