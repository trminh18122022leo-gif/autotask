import sys
import unittest
from pathlib import Path
sys.path.insert(0,str(Path(__file__).parents[1]/'desktop'))
from policy import check_action,is_high_risk,is_protected

class PolicyTests(unittest.TestCase):
 def test_sensitive_controls(self):
  self.assertTrue(is_high_risk('Nộp bài'))
  self.assertTrue(is_high_risk('Submit form'))
  self.assertTrue(is_protected('Password'))
  self.assertTrue(is_protected('Mã xác thực'))
 def test_visual_target_bounds(self):
  check_action({'kind':'click_visual','bbox':[.25,.3,.35,.4],'label':'Settings','confidence':.95})
  for bbox in ([0,0,1,1],[.5,.5,.4,.6],[0,0,.01,1],[-.1,0,.1,.1]):
   with self.assertRaises(ValueError):check_action({'kind':'click_visual','bbox':bbox,'label':'Settings','confidence':.95})
 def test_reject_low_confidence(self):
  with self.assertRaises(ValueError):check_action({'kind':'click_visual','bbox':[.1,.1,.2,.2],'label':'Next','confidence':.4})
 def test_reject_arbitrary_shortcuts(self):
  with self.assertRaises(ValueError):check_action({'kind':'press','key':'alt+f4'})
 def test_reject_shell(self):
  with self.assertRaises(ValueError):check_action({'kind':'shell','command':'calc'})
if __name__=='__main__':unittest.main()
