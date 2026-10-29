"""Current capability meanings stay separate; no model or provider calls."""
from copy import deepcopy
import unittest
from galaxy_agentos.conversation_tool_feedback import _summary_feedback

class SummaryFeedbackTests(unittest.TestCase):
    def test_connected_implementation_is_not_lost_when_grants_are_missing(self):
        fact={"systemSupport":"connected","permissionAllowed":False,"delegated":False,"available":False}
        source={"managementCapabilities":{"role":{"read":fact},"prompt":{"update":fact}},"checkedAt":0}
        before=deepcopy(source)
        result=_summary_feedback(source)
        self.assertEqual(source,before)
        self.assertEqual({key:result[key] for key in source},before)
        text=result["summaryFeedback"]["capabilityFacts"]["岗位工作提示词"]["修改"]
        self.assertEqual(text,"功能已接通；权限未分配；尚未委派；当前不可办理")
        self.assertEqual(result["summaryFeedback"]["observedAt"],"1970-01-01T08:00:00+08:00")

    def test_each_status_uses_its_original_field_without_guessing(self):
        combinations=[
          ({"systemSupport":"not-connected","permissionAllowed":True,"delegated":True,"available":False},"功能尚未接通；权限已分配；已委派；当前不可办理"),
          ({"systemSupport":"connected","permissionAllowed":True,"delegated":False,"available":False},"功能已接通；权限已分配；尚未委派；当前不可办理"),
          ({"systemSupport":"connected","permissionAllowed":True,"delegated":True,"available":True},"功能已接通；权限已分配；已委派；当前可办理"),
          ({"systemSupport":"human-only","permissionAllowed":True,"delegated":True,"available":False},"仅由人工办理；权限已分配；已委派；当前不可办理"),
          ({},"功能接通状态未核实；权限未核实；委派未核实；当前可用性未核实"),
        ]
        for fact,expected in combinations:
            with self.subTest(fact=fact):
                value=_summary_feedback({"managementCapabilities":{"ordinaryStrategy":{"publish":fact},"delegation":{"enabled":False}}})
                self.assertEqual(value["summaryFeedback"]["capabilityFacts"]["日常策略"]["发布"],expected)
                self.assertNotIn("observedAt",value["summaryFeedback"])

    def test_failures_and_missing_contract_do_not_create_capabilities_or_time(self):
        for source in ({"state":"unavailable"},{"availability":"unavailable","managementCapabilities":{}},{"error":"unavailable"},{}):
            self.assertIs(_summary_feedback(source),source)
        for invalid in (True,"2026-10-29",None,float("nan")):
            value=_summary_feedback({"managementCapabilities":{},"checkedAt":invalid})
            self.assertNotIn("observedAt",value["summaryFeedback"])

if __name__=="__main__":unittest.main()
