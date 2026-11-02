import unittest
from types import SimpleNamespace
from unittest.mock import patch

from galaxy_agentos.duty_completion import with_duty_completion


class Gateway:
    def __init__(self, completion):
        self.completion = completion
    def duty_authorize(self, _user, *, operation):
        return {"task": {"completion": self.completion}}


class DutyDecisionTests(unittest.TestCase):
    def decide(self, completion, progress):
        with patch("galaxy_agentos.duty_completion.with_task_loop") as loop:
            with_duty_completion(object(), Gateway(completion), progress, 30)
        return loop.call_args.kwargs["decide"]

    def test_natural_completion_and_stale_progress(self):
        old = {"goalSatisfied": False, "remainingWork": [{"kind": "read", "description": "read"}]}
        decide = self.decide({"disposition": "completed", "modelAssessment": old}, [])
        run = SimpleNamespace(user_id="autonomy:test", metadata={})
        self.assertEqual(decide(run).state, "completed")
        progress = [old]
        decide = self.decide({"disposition": "completed", "modelAssessment": None}, progress)
        self.assertEqual(decide(run).state, "completed")
        self.assertEqual(progress, [])

    def test_fresh_optional_progress_continues_once(self):
        assessment = {"goalSatisfied": False, "remainingWork": [{"kind": "read", "description": "核查"}]}
        progress = [assessment]
        decide = self.decide({"disposition": "completed", "modelAssessment": assessment}, progress)
        run = SimpleNamespace(user_id="autonomy:test", metadata={})
        result = decide(run)
        self.assertEqual((result.state, result.remaining), ("continue", ("核查",)))
        self.assertEqual(decide(run).state, "completed")

    def test_failed_business_fact_does_not_block_fresh_remaining_work(self):
        assessment = {"goalSatisfied": False, "remainingWork": [{"kind": "action", "description": "采用其他获准方法"}]}
        decide = self.decide({"disposition": "completed", "businessState": "failed", "modelAssessment": assessment,
            "pendingHuman": False, "pendingWrite": False}, [assessment])
        self.assertEqual(decide(SimpleNamespace(user_id="autonomy:test", metadata={})).state, "continue")

    def test_actual_business_states_override_progress(self):
        for disposition, state in (("unknown", "waiting-result"), ("waiting-human", "waiting-human"), ("failed", "failed"), ("continue", "waiting-result")):
            decide = self.decide({"disposition": disposition, "reasonCode": "original-state"}, [])
            result = decide(SimpleNamespace(user_id="autonomy:test", metadata={}))
            self.assertEqual((result.state, result.reason), (state, "original-state"))

